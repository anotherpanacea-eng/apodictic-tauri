import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { ensureSyncPrDraft } from "../../scripts/ensure-sync-pr-draft.mjs";

const repository = "anotherpanacea-eng/apodictic-tauri";
function pull(overrides = {}) {
  return { number: 12, draft: false, base: { ref: "main" }, head: { ref: "chore/sync-gemini-web", repo: { full_name: repository } }, labels: [{ name: "CI-Ready" }], ...overrides };
}
function fake(initial) {
  let current = initial; const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] !== "gh") throw new Error("unexpected executable");
    if (args[1] === "api" && args[2] !== "-X") return JSON.stringify(current);
    if (args.includes("DELETE")) {
      current = current.map((item) => ({ ...item, labels: item.labels.filter((label) => label.name.toLowerCase() !== "ci-ready") }));
      return "";
    }
    if (args[1] === "pr" && args[2] === "ready") {
      current = current.map((item) => ({ ...item, draft: true })); return "";
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  return { calls, runner, set(value) { current = value; } };
}

test("ready mixed-case-labeled sync PR is disarmed and read back", () => {
  const state = fake([pull()]);
  const receipt = ensureSyncPrDraft(repository, state.runner);
  assert.deepEqual(receipt.actions, ["remove-ci-ready", "convert-to-draft", "verified"]);
  assert.deepEqual(receipt.removed_labels, ["CI-Ready"]);
  assert.equal(receipt.draft, true);
  assert.equal(state.calls.filter((args) => args.includes("DELETE")).length, 1);
  assert.equal(state.calls.filter((args) => args[1] === "pr").length, 1);
});

test("already safe sync PR mutates nothing but still verifies", () => {
  const state = fake([pull({ draft: true, labels: [] })]);
  assert.deepEqual(ensureSyncPrDraft(repository, state.runner).actions, ["verified"]);
  assert.equal(state.calls.length, 2);
});

test("zero matches is an explicit null no-op", () => {
  const receipt = ensureSyncPrDraft(repository, fake([]).runner);
  assert.deepEqual(receipt, { actions: [], base_ref: "main", draft: null, head_ref: null, head_repo: null, pr: null, removed_labels: [], repository, schema: "apodictic-tauri-sync-draft/1" });
});

test("ambiguity, API failure, and identity disappearance refuse", () => {
  assert.throws(() => ensureSyncPrDraft(repository, fake([pull(), pull({ number: 13 })]).runner), /multiple/);
  assert.throws(() => ensureSyncPrDraft(repository, () => { throw new Error("offline"); }), /resolve/);
  let queries = 0;
  const state = fake([pull({ draft: true, labels: [] })]);
  const disappearing = (args) => {
    if (args[1] === "api" && args[2] !== "-X" && ++queries === 2) return "[]";
    return state.runner(args);
  };
  assert.throws(() => ensureSyncPrDraft(repository, disappearing), /changed identity/);
});

test("lookalike identities are ignored", () => {
  const receipt = ensureSyncPrDraft(repository, fake([pull({ head: { ref: "other", repo: { full_name: repository } } })]).runner);
  assert.equal(receipt.pr, null);
});

function readPinnedRelease(lock) {
  const workflow = parse(fs.readFileSync(new URL("../../.github/workflows/sync-gemini-web.yml", import.meta.url), "utf8"));
  const run = workflow.jobs.sync.steps.find((step) => step.id === "lock").run;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-sync-lock-"));
  try {
    fs.writeFileSync(path.join(cwd, "gemini-web.lock"), JSON.stringify(lock));
    const output = path.join(cwd, "output.txt");
    fs.writeFileSync(output, "");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", run], { cwd, env: { ...process.env, GITHUB_OUTPUT: output.replaceAll("\\", "/") }, encoding: "utf8" });
    return { ...result, output: fs.readFileSync(output, "utf8") };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// Regression: require() of the extensionless JSON lock failed in the scheduled sync.
test("sync lock step emits the pinned release fields", () => {
  const result = readPinnedRelease({ tag: "v0.3.4", web_version: "0.3.4" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "tag=v0.3.4\nweb=0.3.4\n");
});

test("sync lock step fails without output on a blank or multiline field", () => {
  for (const lock of [{ tag: "", web_version: "0.3.4" }, { tag: "v0.3.4", web_version: "0.3.4\ninjected=1" }]) {
    const result = readPinnedRelease(lock);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, "");
  }
});
