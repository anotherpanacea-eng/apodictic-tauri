import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertCanonicalRemote, classifyCleanup, classifyConstituentState, classifyPostLandingPull,
  cleanupBranch, convergePostLandingPull, createControlledBare, landReviewed, transportGit,
  validateLandingAuthorization, validateLiveLandingPull, validateReviewGate,
  verifySynthetic,
} from "../../scripts/land-reviewed-pr.mjs";
import { REMOTE_URL, canonical } from "../../scripts/train-policy-common.mjs";

function run(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function makeRepository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-landing-source-"));
  run(repo, ["init", "-b", "main"]);
  run(repo, ["config", "user.name", "Test"]); run(repo, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "common.txt"), "common\n"); run(repo, ["add", "."]); run(repo, ["commit", "-m", "base"]);
  return repo;
}
function commitFile(repo, name, content, message) {
  fs.writeFileSync(path.join(repo, name), content); run(repo, ["add", name]); run(repo, ["commit", "-m", message]);
  return run(repo, ["rev-parse", "HEAD"]);
}
function refs(repo, base, synthetic) {
  run(repo, ["update-ref", "refs/landing/base", base]);
  run(repo, ["update-ref", "refs/landing/synthetic", synthetic]);
}

test("canonical remote accepts only the fixed HTTPS identity", () => {
  assert.equal(assertCanonicalRemote(REMOTE_URL), REMOTE_URL);
  for (const value of [
    "git@github.com:anotherpanacea-eng/apodictic-tauri.git",
    `${REMOTE_URL}?token=x`, `${REMOTE_URL}#fragment`,
    "https://github.com/AnotherPanacea-eng/apodictic-tauri.git",
  ]) assert.throws(() => assertCanonicalRemote(value), /canonical/);
});

test("controlled bare repository ignores ambient Git injection and has only required config", () => {
  const prior = Object.fromEntries(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "credential.helper";
  process.env.GIT_CONFIG_VALUE_0 = "hostile-helper";
  const directory = createControlledBare();
  try {
    const keys = run(directory, ["config", "--local", "--name-only", "--get-regexp", ".*"]).split(/\r?\n/);
    assert.ok(!keys.some((key) => /credential|include|insteadof/i.test(key)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("production transport resets ambient helpers and selects only absolute gh for GitHub", () => {
  const prior = Object.fromEntries(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "credential.helper"; process.env.GIT_CONFIG_VALUE_0 = "hostile-token-helper";
  const directory = createControlledBare(); const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-fake-gh-"));
  const source = makeRepository(); const remote = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-transport-remote-"));
  const helperLog = path.join(helperRoot, "calls.jsonl"); const helperScript = path.join(helperRoot, "fake-gh.mjs"); const helper = path.join(helperRoot, "fake-gh");
  try {
    fs.writeFileSync(helperScript, `import fs from "node:fs";\nlet input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>input+=c); process.stdin.on("end",()=>{const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(helperLog)},JSON.stringify({args,input})+"\\n"); if(args.at(-1)==="get") process.stdout.write("username=fixture\\npassword=fixture-secret\\n");});\n`);
    fs.writeFileSync(helper, `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${helperScript.replaceAll("\\", "/")}" "$@"\n`); fs.chmodSync(helper, 0o755);
    const scoped = transportGit(directory, helper, ["config", "--get-urlmatch", "credential.helper", "https://github.com/anotherpanacea-eng/apodictic-tauri.git"]);
    assert.equal(scoped.trim(), `!"${helper.replaceAll("\\", "/")}" auth git-credential`);
    assert.equal(transportGit(directory, helper, ["config", "--get-all", "credential.helper"]), "\n");
    const credentialOutput = transportGit(directory, helper, ["credential", "approve"], { input: "protocol=https\nhost=github.com\nusername=fixture\npassword=fixture-secret\n\n" });
    assert.equal(credentialOutput, "");
    const filled = transportGit(directory, helper, ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n" });
    assert.match(filled, /username=fixture/); assert.match(filled, /password=fixture-secret/);
    let calls = fs.readFileSync(helperLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.args.at(-1)), ["store", "get"]); assert.match(calls[0].input, /password=fixture-secret/);
    run(remote, ["init", "--bare"]); run(source, ["remote", "add", "fixture", remote]);
    const base = run(source, ["rev-parse", "HEAD"]); run(source, ["push", "fixture", base + ":refs/heads/main"]);
    const remoteHelper = path.join(helperRoot, "git-remote-https");
    fs.writeFileSync(remoteHelper, `#!/bin/sh\ncredential="$(printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill)" || exit 41\ncase "$credential" in *"username=fixture"*"password=fixture-secret"*) ;; *) exit 42 ;; esac\nIFS= read -r command\n[ "$command" = capabilities ] || exit 43\nprintf 'connect\\n\\n'\nIFS= read -r command\n[ "$command" = 'connect git-upload-pack' ] || exit 44\nprintf '\\n'\nexec git-upload-pack "${remote.replaceAll("\\", "/")}"\n`); fs.chmodSync(remoteHelper, 0o755);
    transportGit(directory, helper, ["fetch", "--no-tags", REMOTE_URL, "refs/heads/main:refs/landing/base"], { gitExecPath: helperRoot });
    calls = fs.readFileSync(helperLog, "utf8").trim().split(/\r?\n/).map(JSON.parse); assert.equal(calls.at(-1).args.at(-1), "get");
    const next = commitFile(source, "transport.txt", "next\n", "next");
    transportGit(directory, helper, ["fetch", "--no-tags", remote, "refs/heads/main:refs/landing/old"]);
    run(directory, ["fetch", "--no-tags", source, next + ":refs/landing/next"]);
    transportGit(directory, helper, ["push", "--force-with-lease=refs/heads/main:" + base, remote, next + ":refs/heads/main"]);
    assert.equal(run(remote, ["rev-parse", "refs/heads/main"]), next);
    assert.ok(!scoped.includes("token")); assert.ok(!scoped.includes("hostile"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(helperRoot, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("train synthetic binding requires exact parents and exact train-head tree", () => {
  const repo = makeRepository();
  try {
    const base = run(repo, ["rev-parse", "HEAD"]);
    run(repo, ["switch", "-c", "feature"]); const constituent = commitFile(repo, "feature.txt", "feature\n", "feature");
    run(repo, ["switch", "-c", "train/weekly", base]); run(repo, ["merge", "--no-ff", constituent, "-m", "train merge"]);
    const head = run(repo, ["rev-parse", "HEAD"]);
    const synthetic = run(repo, ["commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "synthetic"]);
    refs(repo, base, synthetic);
    assert.equal(verifySynthetic(repo, { base, head, synthetic, authorization: "train" }), synthetic);
    assert.throws(() => verifySynthetic(repo, { base, head: constituent, synthetic, authorization: "train" }), /parents/);
    const wrongTree = run(repo, ["commit-tree", `${base}^{tree}`, "-p", base, "-p", head, "-m", "wrong tree"]);
    run(repo, ["update-ref", "refs/landing/synthetic", wrongTree]);
    assert.throws(() => verifySynthetic(repo, { base, head, synthetic: wrongTree, authorization: "train" }), /tree/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("stale-based standalone synthetic merge preserves both divergent sides", () => {
  const repo = makeRepository();
  try {
    const fork = run(repo, ["rev-parse", "HEAD"]);
    run(repo, ["switch", "-c", "standalone"]); const head = commitFile(repo, "head-only.txt", "head\n", "head side");
    run(repo, ["switch", "main"]); const base = commitFile(repo, "base-only.txt", "base\n", "base side");
    run(repo, ["merge", "--no-ff", head, "-m", "synthetic"]); const synthetic = run(repo, ["rev-parse", "HEAD"]);
    assert.notEqual(fork, base); refs(repo, base, synthetic);
    assert.equal(verifySynthetic(repo, { base, head, synthetic, authorization: "standalone" }), synthetic);
    assert.ok(run(repo, ["ls-tree", "-r", "--name-only", synthetic]).includes("base-only.txt"));
    assert.ok(run(repo, ["ls-tree", "-r", "--name-only", synthetic]).includes("head-only.txt"));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("standalone authorization is explicit, current, and inventory-free", () => {
  const repository = "anotherpanacea-eng/apodictic-tauri";
  assert.equal(validateLandingAuthorization({ authorization: "standalone", headRepo: repository, headRef: "feature", labels: ["ci-ready"], inventoryPath: null }), "standalone");
  assert.equal(validateLandingAuthorization({ authorization: "standalone", headRepo: "someone/fork", headRef: "feature", labels: ["CI-READY"], inventoryPath: null }), "standalone");
  assert.equal(validateLandingAuthorization({ authorization: "train", headRepo: repository, headRef: "train/weekly", labels: [], inventoryPath: "inventory.json" }), "train");
  for (const input of [
    { authorization: "standalone", headRepo: repository, headRef: "feature", labels: [], inventoryPath: null },
    { authorization: "standalone", headRepo: repository, headRef: "chore/sync-gemini-web", labels: ["ci-ready"], inventoryPath: null },
    { authorization: "standalone", headRepo: repository, headRef: "feature", labels: ["ci-ready"], inventoryPath: "stale.json" },
    { authorization: "train", headRepo: repository, headRef: "feature", labels: [], inventoryPath: "inventory.json" },
  ]) assert.throws(() => validateLandingAuthorization(input), /authorization|identity/);
  const base = "1".repeat(40); const head = "2".repeat(40);
  const clearance = { base_sha: base, head_sha: head };
  const live = { state: "open", merged: false, draft: false, base: { ref: "main", sha: base }, head: { sha: head } };
  assert.equal(validateLiveLandingPull(live, clearance), live);
  assert.throws(() => validateLiveLandingPull({ ...live, base: { ref: "main", sha: "3".repeat(40) } }, clearance), /identity/);
});

test("synthetic verification refuses replacement, graft, and alternate object views", () => {
  for (const attack of ["replace", "graft", "alternate"]) {
    const repo = makeRepository();
    try {
      const base = run(repo, ["rev-parse", "HEAD"]); run(repo, ["switch", "-c", "head"]); const head = commitFile(repo, "h.txt", "h\n", "h");
      const synthetic = run(repo, ["commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "synthetic"]); refs(repo, base, synthetic);
      if (attack === "replace") run(repo, ["replace", synthetic, base]);
      if (attack === "graft") { let item = run(repo, ["rev-parse", "--git-path", "info/grafts"]); if (!path.isAbsolute(item)) item = path.join(repo, item); fs.mkdirSync(path.dirname(item), { recursive: true }); fs.writeFileSync(item, `${synthetic} ${base}\n`); }
      if (attack === "alternate") { let item = run(repo, ["rev-parse", "--git-path", "objects/info/alternates"]); if (!path.isAbsolute(item)) item = path.join(repo, item); fs.mkdirSync(path.dirname(item), { recursive: true }); fs.writeFileSync(item, `${path.join(repo, ".git", "objects")}\n`); }
      assert.throws(() => verifySynthetic(repo, { base, head, synthetic, authorization: "train" }), /replacement|grafts|alternates/);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  }
});

test("cleanup classification is ownership- and exact-head-safe", () => {
  const repository = "anotherpanacea-eng/apodictic-tauri";
  const expectedSha = "1".repeat(40); const advanced = "2".repeat(40);
  assert.equal(classifyCleanup({ repository, headRepo: repository, headRef: "train/x", expectedSha, remoteSha: expectedSha }).delete, true);
  assert.equal(classifyCleanup({ repository, headRepo: repository, headRef: "feature", expectedSha, remoteSha: advanced }).item.reason, "advanced");
  assert.equal(classifyCleanup({ repository, headRepo: repository, headRef: "feature", expectedSha, remoteSha: null }).item.reason, "already-absent");
  assert.equal(classifyCleanup({ repository, headRepo: "someone/fork", headRef: "feature", expectedSha, remoteSha: expectedSha }).item.reason, "fork");
});

test("constituent cleanup eligibility requires unchanged open main-based PR state", () => {
  const repository = "anotherpanacea-eng/apodictic-tauri";
  const baseSha = "1".repeat(40); const head = "2".repeat(40);
  const step = { head_repo: repository, head_ref: "feature", head };
  const pull = { state: "open", merged: false, base: { ref: "main", sha: baseSha }, head: { repo: { full_name: repository }, ref: "feature", sha: head } };
  assert.deepEqual(classifyConstituentState({ repository, baseSha, step, pull }), { unchanged: true, preserveReason: null });
  for (const changed of [
    { ...pull, state: "closed" },
    { ...pull, merged: true },
    { ...pull, base: { ref: "release", sha: baseSha } },
    { ...pull, base: { ref: "main", sha: "3".repeat(40) } },
    { ...pull, head: { ...pull.head, sha: "4".repeat(40) } },
  ]) assert.deepEqual(classifyConstituentState({ repository, baseSha, step, pull: changed }), { unchanged: false, preserveReason: "advanced" });
  const forkStep = { ...step, head_repo: "someone/fork" };
  const forkPull = { ...pull, head: { ...pull.head, repo: { full_name: "someone/fork" } } };
  assert.deepEqual(classifyConstituentState({ repository, baseSha, step: forkStep, pull: forkPull }), { unchanged: true, preserveReason: "fork" });
});

test("post-landing branch cleanup waits for exact indirect merge closure", () => {
  const repository = "anotherpanacea-eng/apodictic-tauri";
  const headSha = "2".repeat(40); const headRepo = repository; const headRef = "feature";
  const identity = { head: { repo: { full_name: headRepo }, ref: headRef, sha: headSha } };
  assert.equal(classifyPostLandingPull({ repository, headRepo, headRef, headSha, pull: { ...identity, state: "closed", merged: true } }), null);
  assert.equal(classifyPostLandingPull({ repository, headRepo, headRef, headSha, pull: { ...identity, state: "open", merged: false } }), "delete-refused");
  assert.equal(classifyPostLandingPull({ repository, headRepo, headRef, headSha, pull: { ...identity, state: "closed", merged: false } }), "delete-refused");
  assert.equal(classifyPostLandingPull({ repository, headRepo, headRef, headSha, pull: null }), "advanced");
  assert.equal(classifyPostLandingPull({ repository, headRepo: "someone/fork", headRef, headSha, pull: { ...identity, state: "closed", merged: true } }), "fork");
  let reads = 0; let waits = 0;
  const item = { pr: 1, head_repo: headRepo, head_ref: headRef, head_sha: headSha };
  const apiJson = () => ({ ...identity, state: ++reads < 3 ? "open" : "closed", merged: reads >= 3 });
  assert.equal(convergePostLandingPull({ apiJson, item, wait: () => { waits += 1; } }), null);
  assert.equal(reads, 3); assert.equal(waits, 2);
  assert.equal(convergePostLandingPull({ apiJson: () => { throw new Error("lag"); }, item, wait: () => {}, attempts: 2 }), "delete-refused");
});

test("review gate requires three unique exact-head receipts and resolved bounded threads", () => {
  const head = "a".repeat(40);
  const line = (lane, sha = head) => `<!-- apodictic-exact-head-review ${canonical({ schema: "apodictic-tauri-exact-head-review/1", lane, head_sha: sha, verdict: "approved" })} -->`;
  const field = "- **Exact-head generic / fleet-posture / CI reviews:**";
  const body = [field, line("generic"), line("fleet-posture"), line("ci"), "- **Promotion and exact-base CAS landing protocol:**"].join("\n");
  const clear = { body, head, reviewDecision: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } };
  assert.deepEqual(validateReviewGate(clear).lanes, ["ci", "fleet-posture", "generic"]);
  assert.throws(() => validateReviewGate({ ...clear, body: "" }), /missing/);
  assert.throws(() => validateReviewGate({ ...clear, body: [field, line("generic")].join("\n") }), /missing/);
  assert.throws(() => validateReviewGate({ ...clear, body: [field, line("generic"), line("fleet-posture"), line("ci", "b".repeat(40))].join("\n"), reviewDecision: "REVIEW_REQUIRED" }), /stale/);
  assert.throws(() => validateReviewGate({ ...clear, body: [field, line("generic"), line("fleet-posture"), line("ci"), "<!-- apodictic-exact-head-review NOT-JSON -->"].join("\n") }), /malformed/);
  for (const fence of ["```", "````", "~~~"]) {
    const decoy = [field, `${fence}text`, line("generic"), line("fleet-posture"), line("ci"), fence].join("\n");
    assert.throws(() => validateReviewGate({ ...clear, body: decoy }), /missing/);
  }
  for (const spaces of [4, 6]) {
    const indented = [field, "", ...["generic", "fleet-posture", "ci"].map((lane) => `${" ".repeat(spaces)}${line(lane)}`)].join("\n");
    assert.throws(() => validateReviewGate({ ...clear, body: indented }), /missing/);
  }
  assert.throws(() => validateReviewGate({ ...clear, body: [field, `\`${line("generic")}\``, line("fleet-posture"), line("ci")].join("\n") }), /missing/);
  assert.throws(() => validateReviewGate({ ...clear, body: [field, `prefix \`example\` ${line("generic")} trailing`, line("fleet-posture"), line("ci")].join("\n") }), /malformed/);
  const adjacent = ["## Example", line("generic"), line("fleet-posture"), line("ci"), field].join("\n");
  assert.throws(() => validateReviewGate({ ...clear, body: adjacent }), /missing/);
  assert.throws(() => validateReviewGate({ ...clear, body: [field, `${line("generic")} trailing`, line("fleet-posture"), line("ci")].join("\n") }), /malformed/);
  const template = fs.readFileSync(path.join(path.resolve(import.meta.dirname, "../.."), ".github", "pull_request_template.md"), "utf8");
  const templateBody = template.replace(field, [field, line("generic"), line("fleet-posture"), line("ci")].join("\n"));
  assert.deepEqual(validateReviewGate({ ...clear, body: templateBody }).lanes, ["ci", "fleet-posture", "generic"]);
  assert.throws(() => validateReviewGate({ ...clear, reviewDecision: "CHANGES_REQUESTED" }), /requested changes/);
  assert.throws(() => validateReviewGate({ ...clear, reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } } }), /unresolved/);
  assert.throws(() => validateReviewGate({ ...clear, reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } }), /unresolved/);
});

test("explicit main and cleanup leases reject races and accept exact old objects", () => {
  const source = makeRepository(); const remote = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-landing-remote-"));
  try {
    run(remote, ["init", "--bare"]); run(source, ["remote", "add", "fixture", remote]);
    const base = run(source, ["rev-parse", "HEAD"]); run(source, ["push", "fixture", base + ":refs/heads/main", base + ":refs/heads/feature"]);
    const next = commitFile(source, "next.txt", "next\n", "next");
    let result = spawnSync("git", ["-C", source, "push", "--force-with-lease=refs/heads/main:" + "0".repeat(40), "fixture", next + ":refs/heads/main"], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.equal(run(remote, ["rev-parse", "refs/heads/main"]), base);
    run(source, ["push", "--force-with-lease=refs/heads/main:" + base, "fixture", next + ":refs/heads/main"]);
    result = spawnSync("git", ["-C", source, "push", "--force-with-lease=refs/heads/feature:" + next, "fixture", ":refs/heads/feature"], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.equal(run(remote, ["rev-parse", "refs/heads/feature"]), base);
    run(source, ["push", "--force-with-lease=refs/heads/feature:" + base, "fixture", ":refs/heads/feature"]);
    const missing = spawnSync("git", ["-C", remote, "show-ref", "--verify", "refs/heads/feature"], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
  } finally { fs.rmSync(source, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); }
});

test("landReviewed performs receipt-bound train CAS, containment, closure, and leased cleanup", () => {
  const repo = makeRepository(); const remote = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-e2e-remote-"));
  const inventoryPath = path.join(os.tmpdir(), `tauri-inventory-${process.pid}-${Date.now()}.json`);
  try {
    run(remote, ["init", "--bare"]);
    run(repo, ["remote", "add", "origin", REMOTE_URL]); run(repo, ["remote", "add", "fixture", remote]);
    run(repo, ["config", "credential.helper", "hostile-helper"]);
    run(repo, ["config", "url.https://unused.invalid/.insteadOf", "unused:"]);
    const base = run(repo, ["rev-parse", "HEAD"]); run(repo, ["update-ref", "refs/remotes/origin/main", base]);
    run(repo, ["switch", "-c", "feature"]); const constituent = commitFile(repo, "feature.txt", "feature\n", "feature");
    run(repo, ["switch", "-c", "train/weekly", base]); run(repo, ["merge", "--no-ff", constituent, "-m", "merge constituent"]);
    const head = run(repo, ["rev-parse", "HEAD"]); const synthetic = run(repo, ["commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "synthetic"]);
    run(repo, ["push", "fixture", base + ":refs/heads/main", constituent + ":refs/heads/feature", head + ":refs/heads/train/weekly", synthetic + ":refs/pull/7/merge"]);
    const inventory = { schema: "apodictic-tauri-merge-train/1", base, base_ref: "refs/remotes/origin/main", head, steps: [{ kind: "constituent", pr: 1, head_repo: "anotherpanacea-eng/apodictic-tauri", head_ref: "feature", head: constituent, merge: head, tree_mode: "clean", resolution: null }] };
    fs.writeFileSync(inventoryPath, JSON.stringify(inventory));
    const clearance = { schema: "apodictic-tauri-train-ci-clearance/1", authorization: "train", repository: "anotherpanacea-eng/apodictic-tauri", pr: 7, base_ref: "main", base_sha: base, head_sha: head, workflow_path: ".github/workflows/ci.yml", run_id: "100", run_attempt: "1", job_count: 1, synthetic_merge_sha: synthetic };
    const binding = canonical({ base_sha: base, head_sha: head, job: "validate", repository: clearance.repository, run_attempt: "1", run_id: "100", schema: "apodictic-tauri-pr-merge-binding/1", synthetic_merge_sha: synthetic });
    const evidence = { schema: "apodictic-tauri-train-ci-evidence/1", repository: clearance.repository, pr: 7, base_ref: "main", base_sha: base, head_sha: head, current: { draft: false, head_repo: clearance.repository, head_ref: "train/weekly", labels: [], merged: false, state: "open", base_ref: "main", base_sha: base, head_sha: head }, runs: [{ id: "100", attempt: "1", event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head, display_title: "apodictic-tauri-ci pr=7 action=ready_for_review train=true ci-ready-event=false", status: "completed", conclusion: "success", jobs: [{ name: "validate", status: "completed", conclusion: "success", log: `pr-merge-binding: ${binding}\n` }] }] };
    let landed = false;
    const pull = (number) => number === 7
      ? { number, state: landed ? "closed" : "open", merged: landed, draft: false, base: { ref: "main", sha: base }, head: { ref: "train/weekly", sha: head, repo: { full_name: clearance.repository } }, labels: [] }
      : { number, state: landed ? "closed" : "open", merged: landed, draft: true, base: { ref: "main", sha: base }, head: { ref: "feature", sha: constituent, repo: { full_name: clearance.repository } }, labels: [] };
    const apiJson = (args) => {
      const endpoint = args[1];
      if (endpoint.endsWith("/pulls/7")) return pull(7);
      if (endpoint.endsWith("/pulls/1")) return pull(1);
      if (endpoint.includes("pulls?state=open")) return landed ? [] : [{ number: 1 }, { number: 7 }];
      if (endpoint.includes("actions/workflows/ci.yml/runs?event=push")) return { workflow_runs: [] };
      throw new Error(`unexpected API ${endpoint}`);
    };
    const controlledGit = (directory, args) => {
      const mapped = args.map((item) => item === REMOTE_URL ? remote : item);
      const output = run(directory, mapped);
      if (args[0] === "push" && args.at(-1).endsWith(":refs/heads/main")) landed = true;
      return output;
    };
    const readRef = (directory, ref) => {
      const result = spawnSync("git", ["-C", directory, "ls-remote", "--heads", remote, `refs/heads/${ref}`], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); const value = result.stdout.trim(); return value ? value.split(/\s+/, 1)[0] : null;
    };
    const result = landReviewed({ clearance, inventoryPath, repo, gh: process.execPath, dependencies: {
      ghJson: apiJson, collectLive: () => evidence, assertReviewGate: () => {}, createControlledBare,
      transportGit: controlledGit, liveRef: readRef, wait: () => {},
      cleanupBranch: (directory, repository, headRepo, headRef, expectedSha) => cleanupBranch(directory, process.execPath, repository, headRepo, headRef, expectedSha, {
        liveRef: (target, _gh, ref) => readRef(target, ref),
        transportGit: (target, _gh, args) => controlledGit(target, args),
      }),
    } });
    assert.equal(result.main_sha, synthetic); assert.equal(result.deleted_branches.length, 2); assert.deepEqual(result.preserved_branches, []);
    assert.equal(run(remote, ["rev-parse", "refs/heads/main"]), synthetic);
    for (const ref of ["feature", "train/weekly"]) assert.notEqual(spawnSync("git", ["-C", remote, "show-ref", "--verify", `refs/heads/${ref}`]).status, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); fs.rmSync(inventoryPath, { force: true });
  }
});

test("landReviewed performs stale-based standalone CAS and leased cleanup", () => {
  const repo = makeRepository(); const remote = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-standalone-remote-"));
  try {
    run(remote, ["init", "--bare"]); run(repo, ["remote", "add", "origin", REMOTE_URL]); run(repo, ["remote", "add", "fixture", remote]);
    const fork = run(repo, ["rev-parse", "HEAD"]); run(repo, ["switch", "-c", "feature"]); const head = commitFile(repo, "head-only.txt", "head\n", "head side");
    run(repo, ["switch", "main"]); const base = commitFile(repo, "base-only.txt", "base\n", "base side");
    run(repo, ["merge", "--no-ff", head, "-m", "synthetic"]); const synthetic = run(repo, ["rev-parse", "HEAD"]); assert.notEqual(fork, base);
    run(repo, ["update-ref", "refs/remotes/origin/main", base]);
    run(repo, ["push", "fixture", base + ":refs/heads/main", head + ":refs/heads/feature", synthetic + ":refs/pull/8/merge"]);
    const clearance = { schema: "apodictic-tauri-train-ci-clearance/1", authorization: "standalone", repository: "anotherpanacea-eng/apodictic-tauri", pr: 8, base_ref: "main", base_sha: base, head_sha: head, workflow_path: ".github/workflows/ci.yml", run_id: "101", run_attempt: "1", job_count: 1, synthetic_merge_sha: synthetic };
    const binding = canonical({ base_sha: base, head_sha: head, job: "validate", repository: clearance.repository, run_attempt: "1", run_id: "101", schema: "apodictic-tauri-pr-merge-binding/1", synthetic_merge_sha: synthetic });
    const evidence = { schema: "apodictic-tauri-train-ci-evidence/1", repository: clearance.repository, pr: 8, base_ref: "main", base_sha: base, head_sha: head, current: { draft: false, head_repo: clearance.repository, head_ref: "feature", labels: ["ci-ready"], merged: false, state: "open", base_ref: "main", base_sha: base, head_sha: head }, runs: [{ id: "101", attempt: "1", event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head, display_title: "apodictic-tauri-ci pr=8 action=labeled train=false ci-ready-event=true", status: "completed", conclusion: "success", jobs: [{ name: "validate", status: "completed", conclusion: "success", log: `pr-merge-binding: ${binding}\n` }] }] };
    let landed = false;
    const apiJson = (args) => {
      const endpoint = args[1];
      if (endpoint.endsWith("/pulls/8")) return { number: 8, state: landed ? "closed" : "open", merged: landed, draft: false, base: { ref: "main", sha: base }, head: { ref: "feature", sha: head, repo: { full_name: clearance.repository } }, labels: [{ name: "ci-ready" }] };
      if (endpoint.includes("pulls?state=open")) return landed ? [] : [{ number: 8 }];
      if (endpoint.includes("actions/workflows/ci.yml/runs?event=push")) return { workflow_runs: [] };
      throw new Error(`unexpected API ${endpoint}`);
    };
    const controlledGit = (directory, args) => { const output = run(directory, args.map((item) => item === REMOTE_URL ? remote : item)); if (args[0] === "push" && args.at(-1).endsWith(":refs/heads/main")) landed = true; return output; };
    const readRef = (directory, ref) => { const result = spawnSync("git", ["-C", directory, "ls-remote", "--heads", remote, `refs/heads/${ref}`], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim()?.split(/\s+/, 1)[0] ?? null; };
    const cleanup = (directory, repository, headRepo, headRef, expectedSha) => cleanupBranch(directory, process.execPath, repository, headRepo, headRef, expectedSha, { liveRef: (target, _gh, ref) => readRef(target, ref), transportGit: (target, _gh, args) => controlledGit(target, args) });
    const dependencies = { ghJson: apiJson, collectLive: () => evidence, assertReviewGate: () => {}, createControlledBare, transportGit: controlledGit, liveRef: readRef, cleanupBranch: cleanup, wait: () => {} };
    const result = landReviewed({ clearance, repo, gh: process.execPath, dependencies });
    assert.equal(result.authorization, "standalone"); assert.equal(result.main_sha, synthetic); assert.equal(result.deleted_branches.length, 1);
    assert.equal(run(remote, ["rev-parse", "refs/heads/main"]), synthetic);
    assert.ok(run(repo, ["ls-tree", "-r", "--name-only", synthetic]).includes("base-only.txt")); assert.ok(run(repo, ["ls-tree", "-r", "--name-only", synthetic]).includes("head-only.txt"));
    assert.notEqual(spawnSync("git", ["-C", remote, "show-ref", "--verify", "refs/heads/feature"]).status, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); }
});
