import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashTree, sha256File } from "../lib/canonical-tree-hash.mjs";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-tree-hash-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("canonical tree hash uses sorted POSIX paths and NUL-delimited bytes", (t) => {
  const directory = temporaryDirectory(t);
  fs.mkdirSync(path.join(directory, "nested"));
  fs.mkdirSync(path.join(directory, "prefix"));
  fs.writeFileSync(path.join(directory, "z.txt"), "last");
  fs.writeFileSync(path.join(directory, "nested", "a.txt"), "first");
  fs.writeFileSync(path.join(directory, "prefix", "inside.txt"), "inside");
  fs.writeFileSync(path.join(directory, "prefix.file"), "outside");

  const expected = createHash("sha256")
    .update("nested/a.txt\0")
    .update("first")
    .update("\0")
    .update("prefix.file\0")
    .update("outside")
    .update("\0")
    .update("prefix/inside.txt\0")
    .update("inside")
    .update("\0")
    .update("z.txt\0")
    .update("last")
    .update("\0")
    .digest("hex");
  assert.equal(hashTree(directory), expected);
  assert.equal(sha256File(path.join(directory, "z.txt")), createHash("sha256").update("last").digest("hex"));
});

test("canonical tree hash retains null for a missing root", (t) => {
  const directory = temporaryDirectory(t);
  assert.equal(hashTree(path.join(directory, "missing")), null);
});

test("canonical tree hash rejects symbolic links", (t) => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, "source"), "bytes");
  fs.symlinkSync("source", path.join(directory, "link"));
  assert.throws(() => hashTree(directory), /rejects symbolic link/);
  assert.throws(() => sha256File(path.join(directory, "link")), /regular file/);
});
