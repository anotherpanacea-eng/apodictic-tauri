import assert from "node:assert/strict";
import test from "node:test";
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
