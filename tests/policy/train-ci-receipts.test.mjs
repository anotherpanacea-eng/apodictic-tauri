import assert from "node:assert/strict";
import test from "node:test";
import { collectLive, validateEvidence } from "../../scripts/check-train-ci-receipts.mjs";
import { canonical } from "../../scripts/train-policy-common.mjs";

const base = "1".repeat(40); const head = "2".repeat(40); const merge = "3".repeat(40);
const repository = "anotherpanacea-eng/apodictic-tauri";
function receipt(run = "100", attempt = "1") {
  return canonical({ base_sha: base, head_sha: head, job: "validate", repository, run_attempt: attempt, run_id: run, schema: "apodictic-tauri-pr-merge-binding/1", synthetic_merge_sha: merge });
}
function evidence({ train = true, fork = false, labels = [], runs } = {}) {
  const pr = 7;
  const defaultRun = { id: "100", attempt: "1", event: "pull_request", path: ".github/workflows/ci.yml@refs/pull/7/merge", head_sha: head, display_title: `apodictic-tauri-ci pr=7 action=ready_for_review train=${train} ci-ready-event=false`, status: "completed", conclusion: "success", jobs: [{ name: "validate", status: "completed", conclusion: "success", log: `line\npr-merge-binding: ${receipt()}\n` }] };
  return { schema: "apodictic-tauri-train-ci-evidence/1", repository, pr, base_ref: "main", base_sha: base, head_sha: head, current: { draft: false, head_repo: fork ? "fork/repo" : repository, head_ref: train ? "train/weekly" : "feature", labels: train ? labels : ["CI-READY", ...labels], merged: false, state: "open", base_ref: "main", base_sha: base, head_sha: head }, runs: runs ?? [defaultRun] };
}

test("train and same-repository standalone clear only on exact singleton receipts", () => {
  const train = validateEvidence(evidence()); assert.equal(train.authorization, "train"); assert.equal(train.synthetic_merge_sha, merge);
  const standalone = validateEvidence(evidence({ train: false })); assert.equal(standalone.authorization, "standalone");
  assert.deepEqual(Object.keys(standalone).sort(), ["authorization", "base_ref", "base_sha", "head_sha", "job_count", "pr", "repository", "run_attempt", "run_id", "schema", "synthetic_merge_sha", "workflow_path"]);
  assert.throws(() => validateEvidence(evidence({ train: false, fork: true })), /authorized/);
});

test("train label and unrelated standalone label noise must be completed skipped and logless", () => {
  const noise = { id: "101", attempt: "1", event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head, display_title: "apodictic-tauri-ci pr=7 action=labeled train=true ci-ready-event=true", status: "completed", conclusion: "skipped", jobs: [{ name: "validate", status: "completed", conclusion: "skipped", log: "" }] };
  const clear = evidence().runs[0];
  assert.equal(validateEvidence(evidence({ runs: [clear, noise] })).run_id, "100");
  const bad = structuredClone(noise); bad.jobs[0].log = "unexpected";
  assert.throws(() => validateEvidence(evidence({ runs: [clear, bad] })), /logless/);
  const standaloneNoise = { ...noise, display_title: "apodictic-tauri-ci pr=7 action=labeled train=false ci-ready-event=false" };
  assert.equal(validateEvidence(evidence({ train: false, runs: [evidence({ train: false }).runs[0], standaloneNoise] })).authorization, "standalone");
});

test("closed, draft, stale authorization, wrong path, extra job, and mixed receipt refuse", () => {
  for (const change of [
    (e) => { e.current.state = "closed"; },
    (e) => { e.current.draft = true; },
    (e) => { e.current.head_ref = "feature"; e.current.labels = []; },
    (e) => { e.runs[0].path = ".github/workflows/other.yml"; },
    (e) => { e.runs[0].jobs.push({ name: "extra", status: "completed", conclusion: "success", log: "" }); },
    (e) => { e.runs[0].jobs[0].log = `pr-merge-binding: ${receipt("999")}\n`; },
  ]) {
    const item = evidence(); change(item); assert.throws(() => validateEvidence(item));
  }
});

test("malformed train-prefix refs match workflow activity but cannot clear", () => {
  const item = evidence(); item.current.head_ref = "train/a/b";
  assert.throws(() => validateEvidence(item), /bounded/);
});

test("duplicate ids, duplicate JSON receipt members, and newest failed clearance refuse", () => {
  const item = evidence(); item.runs.push(structuredClone(item.runs[0])); assert.throws(() => validateEvidence(item), /duplicate run id/);
  const duplicate = evidence(); duplicate.runs[0].jobs[0].log = `pr-merge-binding: {"schema":"apodictic-tauri-pr-merge-binding/1","schema":"x"}\n`;
  assert.throws(() => validateEvidence(duplicate), /duplicate/);
  const failed = evidence(); const newest = structuredClone(failed.runs[0]); newest.id = "101"; newest.status = "completed"; newest.conclusion = "failure"; failed.runs.push(newest);
  assert.throws(() => validateEvidence(failed), /newest/);
});

test("live collection proves skipped noise is step-free instead of inventing a log", () => {
  const pull = { base: { ref: "main", sha: base }, draft: false, head: { ref: "train/weekly", sha: head, repo: { full_name: repository } }, labels: [], merged: false, state: "open" };
  const clear = { id: 100, run_attempt: 1, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head, display_title: "apodictic-tauri-ci pr=7 action=ready_for_review train=true ci-ready-event=false", status: "completed", conclusion: "success" };
  const noise = { ...clear, id: 101, display_title: "apodictic-tauri-ci pr=7 action=labeled train=true ci-ready-event=true", conclusion: "skipped" };
  let noiseSteps = [];
  const runner = {
    json(args) {
      const command = args.join(" ");
      if (command.includes("/pulls/7")) return pull;
      if (command.includes("actions/workflows/ci.yml/runs")) return { workflow_runs: [clear, noise] };
      if (command.includes("/runs/100/attempts/1/jobs")) return { jobs: [{ id: 900, name: "validate", status: "completed", conclusion: "success" }] };
      if (command.includes("/runs/101/attempts/1/jobs")) return { jobs: [{ id: 901, name: "validate", status: "completed", conclusion: "skipped", steps: noiseSteps }] };
      throw new Error(`unexpected command ${command}`);
    },
    run(args) {
      return `pr-merge-binding: ${receipt()}\n`;
    },
  };
  const collected = collectLive(repository, 7, base, head, runner);
  assert.equal(collected.runs.find((item) => item.id === "101").jobs[0].log, "");
  assert.equal(validateEvidence(collected).run_id, "100");
  noiseSteps = [{ name: "unexpected", status: "completed", conclusion: "success" }];
  assert.throws(() => collectLive(repository, 7, base, head, runner), /step-free/);
});
