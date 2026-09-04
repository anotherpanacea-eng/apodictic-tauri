import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { EVENTS, WORKFLOW_POLICY, classifyPullRequest, concurrencyGroup } from "../../scripts/ci-policy.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const workflowDir = path.join(root, ".github", "workflows");
const load = (name) => parse(fs.readFileSync(path.join(workflowDir, name), "utf8"));
const compact = (value) => value.replace(/\s+/g, " ").trim();

test("authorization table matches draft/train/standalone policy and case semantics", () => {
  const base = { repository: "anotherpanacea-eng/apodictic-tauri", pr: 7, runId: "99", draft: false, action: "opened", labels: [] };
  assert.equal(classifyPullRequest({ ...base, headRepo: base.repository, headRef: "train/WEEKLY" }).authorized, true);
  for (const malformed of ["train/", "train/a/b", `train/${"a".repeat(64)}`]) {
    const state = classifyPullRequest({ ...base, headRepo: base.repository, headRef: malformed });
    assert.equal(state.train, true); assert.equal(state.billable, true); assert.equal(state.authorized, false);
  }
  assert.equal(classifyPullRequest({ ...base, draft: true, headRepo: base.repository, headRef: "train/weekly" }).authorized, false);
  assert.equal(classifyPullRequest({ ...base, headRepo: "fork/repo", headRef: "train/weekly" }).authorized, false);
  for (const action of EVENTS) {
    const fork = classifyPullRequest({ ...base, action, headRepo: "fork/repo", headRef: "feature", labels: ["CI-READY"], eventLabel: "ci-ready" });
    assert.equal(fork.billable, false); assert.equal(fork.authorized, false);
  }
  assert.equal(classifyPullRequest({ ...base, headRepo: base.repository, headRef: "feature", labels: ["CI-READY"] }).authorized, true);
  assert.equal(classifyPullRequest({ ...base, headRepo: base.repository, headRef: "Chore/Sync-Gemini-Web", labels: ["ci-ready"] }).authorized, false);
  for (const action of EVENTS) {
    const state = classifyPullRequest({ ...base, action, headRepo: base.repository, headRef: "feature", labels: ["ci-ready"], eventLabel: "ci-ready" });
    assert.equal(state.authorized, ["opened", "synchronize", "reopened", "ready_for_review", "labeled"].includes(action));
  }
});

test("concurrency revokes canonically and isolates all label noise", () => {
  const base = { repository: "anotherpanacea-eng/apodictic-tauri", pr: 9, runId: "123", draft: false, headRepo: "anotherpanacea-eng/apodictic-tauri", headRef: "feature", labels: [] };
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft", "closed"]) {
    assert.match(concurrencyGroup({ ...base, action }), /-clearance$/);
  }
  for (const action of ["labeled", "unlabeled"]) {
    assert.match(concurrencyGroup({ ...base, action, eventLabel: "CI-READY" }), /-clearance$/);
    assert.match(concurrencyGroup({ ...base, action, eventLabel: "other" }), /-123$/);
    assert.match(concurrencyGroup({ ...base, action, headRef: "train/weekly", eventLabel: "ci-ready" }), /-123$/);
    assert.match(concurrencyGroup({ ...base, action, headRepo: "fork/repo", eventLabel: "ci-ready" }), /-123$/);
  }
});

test("workflow inventory and stable cost topology are closed", () => {
  const names = fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/i.test(name)).sort();
  assert.deepEqual(names, ["ci.yml", "sync-gemini-web.yml"]);
  const ci = load("ci.yml");
  for (const workflow of [ci, load("sync-gemini-web.yml")]) {
    for (const candidate of Object.values(workflow.jobs)) {
      for (const forbidden of ["strategy", "services", "container", "continue-on-error"]) assert.equal(candidate[forbidden], undefined);
      for (const step of candidate.steps) assert.equal(step["continue-on-error"], undefined);
    }
  }
  assert.deepEqual(Object.keys(ci.on), ["pull_request"]);
  assert.deepEqual(ci.on.pull_request.types, EVENTS);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(ci.jobs), ["validate"]);
  const job = ci.jobs.validate;
  assert.equal(compact(ci["run-name"]), compact(WORKFLOW_POLICY.runName));
  assert.equal(compact(ci.concurrency.group), compact(WORKFLOW_POLICY.concurrencyGroup));
  assert.equal(compact(job.if), compact(WORKFLOW_POLICY.jobIf));
  assert.equal(job["timeout-minutes"], 15);
  assert.equal(job["runs-on"], "macos-latest");
  assert.equal(job.name, undefined);
  assert.equal(job.uses, undefined);
  const steps = job.steps;
  const setup = steps.findIndex((step) => step.uses === "actions/setup-node@v4");
  const checkout = steps.findIndex((step) => step.uses === "actions/checkout@v4");
  const bind = steps.findIndex((step) => step.name === "Bind billed job to the exact pull-request merge");
  const install = steps.findIndex((step) => step.run === "npm ci");
  const policy = steps.findIndex((step) => step.name === "Draft-first train policy tests");
  assert.ok(checkout >= 0 && setup > checkout && bind > setup && install > bind && policy > install);
  assert.equal(steps[checkout].with?.["fetch-depth"], undefined);
  assert.equal(steps[setup].with["node-version"], "22");
  const required = [
    "npm ci", "node scripts/sync-gemini-web.mjs --pinned", "git diff --exit-code -- gemini-web.lock",
    "node scripts/sync-gemini-web.mjs --check", "npm run test:packaging-probe", "cargo test --locked",
    "cargo clippy --all-targets --locked -- -D warnings", "cargo build --locked",
    "node scripts/verify-sidecar-runtime.mjs",
  ];
  const runs = steps.flatMap((step) => typeof step.run === "string" ? [step.run] : []);
  for (const command of required) assert.equal(runs.filter((run) => run.trim() === command).length, 1, command);
  assert.ok(steps.findIndex((step) => step.run === "node scripts/sync-gemini-web.mjs --pinned") < steps.findIndex((step) => step.run === "npm run test:packaging-probe"));
  assert.ok(steps.findIndex((step) => step.run === "cargo build --locked") < steps.findIndex((step) => step.run === "node scripts/verify-sidecar-runtime.mjs"));
  for (const file of ["ci-policy", "merge-train", "pr-merge-binding", "sync-pr-draft", "train-ci-receipts", "landing"]) {
    assert.match(steps[policy].run, new RegExp(`tests/policy/${file}\\.test\\.mjs`));
  }
});

test("auxiliary workflows retain their bounded topology", () => {
  const sync = load("sync-gemini-web.yml");
  assert.deepEqual(Object.keys(sync.jobs), ["sync"]);
  assert.deepEqual(Object.keys(sync.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(sync.on.schedule, [{ cron: "0 15 * * 1" }]);
  assert.deepEqual(Object.keys(sync.on.workflow_dispatch), ["inputs"]);
  assert.deepEqual(Object.keys(sync.on.workflow_dispatch.inputs), ["ref"]);
  const setup = sync.jobs.sync.steps.find((step) => step.uses === "actions/setup-node@v4");
  assert.equal(setup.with["node-version"], 22);
  const actionIndex = sync.jobs.sync.steps.findIndex((step) => String(step.uses ?? "").startsWith("peter-evans/create-pull-request@"));
  assert.equal(sync.jobs.sync.steps[actionIndex].uses, "peter-evans/create-pull-request@22a9089034f40e5a961c8808d113e2c98fb63676");
  assert.equal(sync.jobs.sync.steps[actionIndex].with.draft, "always-true");
  assert.match(sync.jobs.sync.steps[actionIndex - 1].run, /ensure-sync-pr-draft/);
  assert.match(sync.jobs.sync.steps[actionIndex + 1].run, /ensure-sync-pr-draft/);
  assert.equal(sync.jobs.sync.steps[actionIndex - 1].env.GH_TOKEN, "${{ github.token }}");
  assert.equal(sync.jobs.sync.steps[actionIndex + 1].env.GH_TOKEN, "${{ github.token }}");
});

test("external action contract and operator policy are explicit", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "create-pull-request-v7-action-contract.json"), "utf8"));
  assert.equal(contract.commit, "22a9089034f40e5a961c8808d113e2c98fb63676");
  assert.equal(contract.git_blob_sha, "9d28570cb5eeba6ff4850b6ea9a4bbe21bdbe46f");
  assert.ok(contract.draft_input.accepted_values.includes("always-true"));
  assert.equal(contract.draft_input.always_true_behavior, "on create and update");
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  for (const stale of ["docs-only change lands as a direct merge", "Default to PR-per-change", "Direct push to `main` is fine", "two full CI jobs per train", "version bumps at merge"]) assert.equal(agents.includes(stale), false, stale);
  for (const current of ["periodic integration train", "one full CI job per train", "landing adds no bytes", "exact expected-head lease"]) assert.equal(agents.includes(current), true, current);
});
