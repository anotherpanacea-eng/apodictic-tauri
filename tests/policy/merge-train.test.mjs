import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyTrain } from "../../scripts/check-merge-train.mjs";

function run(repo, args, ok = true) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (ok) assert.equal(result.status, 0, result.stderr); return result;
}
function git(repo, args) { return run(repo, args).stdout.trim(); }
function commit(repo, name, content, message = `add ${name}`) {
  fs.writeFileSync(path.join(repo, name), content); git(repo, ["add", name]); git(repo, ["commit", "-m", message]); return git(repo, ["rev-parse", "HEAD"]);
}
function cleanTrain() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-train-"));
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.invalid"]);
  const base = commit(repo, "base.txt", "base\n"); git(repo, ["update-ref", "refs/remotes/origin/main", base]);
  git(repo, ["switch", "-c", "feature"]); const head = commit(repo, "feature.txt", "feature\n");
  git(repo, ["switch", "-c", "train/weekly", base]); git(repo, ["merge", "--no-ff", head, "-m", "merge constituent"]); const merge = git(repo, ["rev-parse", "HEAD"]);
  const inventory = { schema: "apodictic-tauri-merge-train/1", base, base_ref: "refs/remotes/origin/main", head: merge, steps: [{ kind: "constituent", pr: 1, head_repo: "anotherpanacea-eng/apodictic-tauri", head_ref: "feature", head, merge, tree_mode: "clean", resolution: null }] };
  return { repo, base, head, merge, inventory, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

test("closed clean train passes with exact topology and tree", () => {
  const f = cleanTrain(); try {
    const receipt = verifyTrain(f.repo, f.inventory);
    assert.equal(receipt.constituent_count, 1); assert.equal(receipt.conflict_resolution_count, 0); assert.equal(receipt.train_commit_count, 0);
  } finally { f.cleanup(); }
});

test("schema, keys, ids, base movement, empty/only-train inventory, and skip text refuse", () => {
  for (const mutate of [
    (f) => { f.inventory.extra = true; },
    (f) => { f.inventory.schema = "wrong"; },
    (f) => { f.inventory.head = f.merge.toUpperCase(); },
    (f) => { git(f.repo, ["update-ref", "refs/remotes/origin/main", f.head]); },
    (f) => { f.inventory.steps = []; },
  ]) { const f = cleanTrain(); try { mutate(f); assert.throws(() => verifyTrain(f.repo, f.inventory)); } finally { f.cleanup(); } }
  const only = cleanTrain(); try {
    git(only.repo, ["reset", "--hard", only.base]); const trainCommit = commit(only.repo, "train.txt", "x\n");
    only.inventory.head = trainCommit; only.inventory.steps = [{ kind: "train", label: "only", commit: trainCommit }];
    assert.throws(() => verifyTrain(only.repo, only.inventory), /constituent/);
  } finally { only.cleanup(); }
  const skip = cleanTrain(); try {
    git(skip.repo, ["commit", "--amend", "-m", "merge constituent [skip ci]"]); skip.inventory.head = git(skip.repo, ["rev-parse", "HEAD"]); skip.inventory.steps[0].merge = skip.inventory.head;
    assert.throws(() => verifyTrain(skip.repo, skip.inventory), /skip/);
  } finally { skip.cleanup(); }
});

test("clean merge cannot smuggle an arbitrary tree edit", () => {
  const f = cleanTrain(); try {
    git(f.repo, ["reset", "--hard", f.base]); run(f.repo, ["merge", "--no-ff", f.head, "--no-commit"]);
    fs.writeFileSync(path.join(f.repo, "hidden.txt"), "hidden\n"); git(f.repo, ["add", "hidden.txt"]); git(f.repo, ["commit", "-m", "smuggled"]);
    f.inventory.head = git(f.repo, ["rev-parse", "HEAD"]); f.inventory.steps[0].merge = f.inventory.head;
    assert.throws(() => verifyTrain(f.repo, f.inventory), /exact clean merge/);
  } finally { f.cleanup(); }
});

test("two constituents cannot claim the same case-folded repository branch", () => {
  const f = cleanTrain(); try {
    git(f.repo, ["switch", "-c", "second", f.merge]); const second = commit(f.repo, "second.txt", "second\n");
    git(f.repo, ["switch", "train/weekly"]); git(f.repo, ["merge", "--no-ff", second, "-m", "merge second"]); const secondMerge = git(f.repo, ["rev-parse", "HEAD"]);
    f.inventory.head = secondMerge; f.inventory.steps.push({ kind: "constituent", pr: 2, head_repo: "ANOTHERPANACEA-ENG/apodictic-tauri", head_ref: "FEATURE", head: second, merge: secondMerge, tree_mode: "clean", resolution: null });
    assert.throws(() => verifyTrain(f.repo, f.inventory), /branch identity/);
  } finally { f.cleanup(); }
});

function conflictTrain(mode = "modify") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-conflict-"));
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.invalid"]);
  const base = commit(repo, "conflict.txt", "base\n"); commit(repo, "stable.txt", "stable\n");
  if (mode === "custom-marker") commit(repo, ".gitattributes", "conflict.txt conflict-marker-size=11\n", "custom marker width");
  const actualBase = git(repo, ["rev-parse", "HEAD"]); git(repo, ["update-ref", "refs/remotes/origin/main", actualBase]);
  git(repo, ["switch", "-c", "feature"]); if (mode === "delete") { fs.rmSync(path.join(repo, "conflict.txt")); git(repo, ["add", "-u"]); git(repo, ["commit", "-m", "delete"]); } else commit(repo, "conflict.txt", "feature\n", "feature");
  const head = git(repo, ["rev-parse", "HEAD"]); git(repo, ["switch", "-c", "train/conflict", actualBase]); const local = commit(repo, "conflict.txt", "train\n", "train-only adjustment");
  run(repo, ["merge", "--no-ff", head, "--no-commit"], false);
  return { repo, base: actualBase, head, local, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
function conflictInventory(f, merge) {
  return { schema: "apodictic-tauri-merge-train/1", base: f.base, base_ref: "refs/remotes/origin/main", head: merge, steps: [
    { kind: "train", label: "reviewed integration adjustment", commit: f.local },
    { kind: "constituent", pr: 2, head_repo: "anotherpanacea-eng/apodictic-tauri", head_ref: "feature", head: f.head, merge, tree_mode: "conflict-resolution", resolution: "selected reviewed resolution" },
  ] };
}

test("reviewed conflict passes but markers and unrelated edits refuse", () => {
  const good = conflictTrain(); try {
    fs.writeFileSync(path.join(good.repo, "conflict.txt"), "resolved\n"); git(good.repo, ["add", "conflict.txt"]); git(good.repo, ["commit", "-m", "resolve"]);
    assert.equal(verifyTrain(good.repo, conflictInventory(good, git(good.repo, ["rev-parse", "HEAD"]))).conflict_resolution_count, 1);
  } finally { good.cleanup(); }
  const marked = conflictTrain(); try {
    fs.writeFileSync(path.join(marked.repo, "conflict.txt"), "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n"); git(marked.repo, ["add", "conflict.txt"]); git(marked.repo, ["commit", "-m", "bad markers"]);
    assert.throws(() => verifyTrain(marked.repo, conflictInventory(marked, git(marked.repo, ["rev-parse", "HEAD"]))), /marker/);
  } finally { marked.cleanup(); }
  const smuggle = conflictTrain(); try {
    fs.writeFileSync(path.join(smuggle.repo, "conflict.txt"), "resolved\n"); fs.writeFileSync(path.join(smuggle.repo, "stable.txt"), "smuggled\n"); git(smuggle.repo, ["add", "."]); git(smuggle.repo, ["commit", "-m", "smuggle"]);
    assert.throws(() => verifyTrain(smuggle.repo, conflictInventory(smuggle, git(smuggle.repo, ["rev-parse", "HEAD"]))), /non-conflict/);
  } finally { smuggle.cleanup(); }
});

test("custom-width complete marker triplets refuse", () => {
  const marked = conflictTrain("custom-marker"); try {
    fs.writeFileSync(path.join(marked.repo, "conflict.txt"), "<<<<<<<<<<< ours\nleft\n===========\nright\n>>>>>>>>>>> theirs\n");
    git(marked.repo, ["add", "conflict.txt"]); git(marked.repo, ["commit", "-m", "bad custom markers"]);
    assert.throws(() => verifyTrain(marked.repo, conflictInventory(marked, git(marked.repo, ["rev-parse", "HEAD"]))), /marker/);
  } finally { marked.cleanup(); }
});

test("Git's unmaterialized automatic conflict entry refuses", () => {
  const f = conflictTrain(); try {
    const automatic = spawnSync("git", ["-C", f.repo, "merge-tree", "--write-tree", f.local, f.head], { encoding: "utf8" });
    assert.equal(automatic.status, 1);
    const automaticTree = automatic.stdout.split(/\r?\n/, 1)[0];
    const merge = git(f.repo, ["commit-tree", automaticTree, "-p", f.local, "-p", f.head, "-m", "unmaterialized"]);
    git(f.repo, ["reset", "--hard", merge]);
    assert.throws(() => verifyTrain(f.repo, conflictInventory(f, merge)), /unmaterialized/);
  } finally { f.cleanup(); }
});

test("modify/delete selecting deletion is a materialized resolution", () => {
  const f = conflictTrain("delete"); try {
    git(f.repo, ["rm", "conflict.txt"]); git(f.repo, ["commit", "-m", "resolve deletion"]); const merge = git(f.repo, ["rev-parse", "HEAD"]);
    assert.equal(verifyTrain(f.repo, conflictInventory(f, merge)).conflict_resolution_count, 1);
  } finally { f.cleanup(); }
});

test("replacement refs, grafts, and alternates refuse", () => {
  const replacement = cleanTrain(); try { git(replacement.repo, ["replace", replacement.merge, replacement.base]); assert.throws(() => verifyTrain(replacement.repo, replacement.inventory), /replacement/); } finally { replacement.cleanup(); }
  const graft = cleanTrain(); try { let p = git(graft.repo, ["rev-parse", "--git-path", "info/grafts"]); if (!path.isAbsolute(p)) p = path.join(graft.repo, p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${graft.merge} ${graft.base}\n`); assert.throws(() => verifyTrain(graft.repo, graft.inventory), /grafts/); } finally { graft.cleanup(); }
  const alternate = cleanTrain(); try { let p = git(alternate.repo, ["rev-parse", "--git-path", "objects/info/alternates"]); if (!path.isAbsolute(p)) p = path.join(alternate.repo, p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${path.join(alternate.repo, ".git", "objects")}\n`); assert.throws(() => verifyTrain(alternate.repo, alternate.inventory), /alternates/); } finally { alternate.cleanup(); }
});
