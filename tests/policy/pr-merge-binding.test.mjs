import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyBinding } from "../../scripts/check-pr-merge-binding.mjs";

function command(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-binding-"));
  command(repo, ["init", "-b", "main"]); command(repo, ["config", "user.name", "Test"]); command(repo, ["config", "user.email", "test@example.invalid"]); command(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); command(repo, ["add", "."]); command(repo, ["commit", "-m", "base"]);
  const base = command(repo, ["rev-parse", "HEAD"]); command(repo, ["switch", "-c", "feature"]);
  fs.writeFileSync(path.join(repo, "head.txt"), "head\n"); command(repo, ["add", "."]); command(repo, ["commit", "-m", "head"]);
  const head = command(repo, ["rev-parse", "HEAD"]); command(repo, ["switch", "main"]); command(repo, ["merge", "--no-ff", head, "-m", "synthetic"]);
  const merge = command(repo, ["rev-parse", "HEAD"]);
  return { repo, base, head, merge, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
const input = (f) => ({ repository: "anotherpanacea-eng/apodictic-tauri", base: f.base, head: f.head, githubSha: f.merge, job: "validate", runId: "123", runAttempt: "1" });

test("exact shallow-safe merge headers produce the closed receipt", () => {
  const f = fixture(); try {
    const receipt = verifyBinding(f.repo, input(f));
    assert.deepEqual(Object.keys(receipt).sort(), ["base_sha", "head_sha", "job", "repository", "run_attempt", "run_id", "schema", "synthetic_merge_sha"]);
    assert.equal(receipt.synthetic_merge_sha, f.merge);
  } finally { f.cleanup(); }
});

test("identity, parent order, job, bounds, and dirt fail closed", () => {
  const f = fixture(); try {
    assert.throws(() => verifyBinding(f.repo, { ...input(f), base: f.head }), /parent/);
    assert.throws(() => verifyBinding(f.repo, { ...input(f), githubSha: f.merge.toUpperCase() }), /lowercase/);
    assert.throws(() => verifyBinding(f.repo, { ...input(f), job: "build" }), /validate/);
    assert.throws(() => verifyBinding(f.repo, { ...input(f), runId: "01" }), /bounded/);
    assert.throws(() => verifyBinding(f.repo, { ...input(f), runAttempt: "1000000" }), /bounded/);
    fs.writeFileSync(path.join(f.repo, "dirty.txt"), "dirty\n");
    assert.throws(() => verifyBinding(f.repo, input(f)), /not clean/);
  } finally { f.cleanup(); }
});

test("parent objects may be absent when HEAD commit headers are present", () => {
  const f = fixture(); const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-shallow-binding-"));
  try {
    fs.rmSync(shallow, { recursive: true, force: true });
    const uri = `file:///${f.repo.replaceAll("\\", "/")}`;
    const clone = spawnSync("git", ["clone", "--depth", "1", "--branch", "main", uri, shallow], { encoding: "utf8" });
    assert.equal(clone.status, 0, clone.stderr);
    command(shallow, ["config", "core.autocrlf", "false"]); command(shallow, ["reset", "--hard", "HEAD"]);
    const missing = spawnSync("git", ["-C", shallow, "cat-file", "-e", `${f.base}^{commit}`]);
    assert.notEqual(missing.status, 0);
    const receipt = verifyBinding(shallow, input(f));
    assert.equal(receipt.head_sha, f.head);
  } finally { f.cleanup(); fs.rmSync(shallow, { recursive: true, force: true }); }
});
