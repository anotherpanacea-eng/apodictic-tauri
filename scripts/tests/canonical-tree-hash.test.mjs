import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashTree, legacyHashTree, manifestTreeHashSchema, requireV2TreeHashLock, sha256File } from "../lib/canonical-tree-hash.mjs";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-tree-hash-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("canonical v2 tree hash uses sorted length-prefixed paths and bytes", (t) => {
  const directory = temporaryDirectory(t);
  fs.mkdirSync(path.join(directory, "nested"));
  fs.mkdirSync(path.join(directory, "prefix"));
  fs.writeFileSync(path.join(directory, "z.txt"), "last");
  fs.writeFileSync(path.join(directory, "nested", "a.txt"), "first");
  fs.writeFileSync(path.join(directory, "prefix", "inside.txt"), "inside");
  fs.writeFileSync(path.join(directory, "prefix.file"), "outside");

  const length = (value) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes; };
  const entries = [["nested/a.txt", "first"], ["prefix.file", "outside"], ["prefix/inside.txt", "inside"], ["z.txt", "last"]];
  const digest = createHash("sha256").update("apodictic-tree-sha256-v2\0").update(length(entries.length));
  for (const [name, value] of entries) digest.update(length(Buffer.byteLength(name))).update(name).update(length(Buffer.byteLength(value))).update(value);
  const expected = digest.digest("hex");
  assert.equal(hashTree(directory), expected);
  assert.equal(sha256File(path.join(directory, "z.txt")), createHash("sha256").update("last").digest("hex"));
});

test("v2 framing separates the legacy NUL boundary collision", (t) => {
  const root = temporaryDirectory(t); const left = path.join(root, "left"); const right = path.join(root, "right");
  fs.mkdirSync(left); fs.mkdirSync(right);
  fs.writeFileSync(path.join(left, "a"), "x"); fs.writeFileSync(path.join(left, "b"), "y");
  fs.writeFileSync(path.join(right, "a"), Buffer.from("x\0b\0y"));
  assert.equal(legacyHashTree(left), legacyHashTree(right));
  assert.notEqual(hashTree(left), hashTree(right));
});

test("manifest schema accepts only absent legacy or exact v2", () => {
  assert.equal(manifestTreeHashSchema(undefined, { allowLegacy: true }), "legacy-nul-delimited-v1");
  assert.equal(manifestTreeHashSchema("apodictic-tree-sha256-v2"), "apodictic-tree-sha256-v2");
  for (const value of [undefined, null, "", "future-v3", 2]) assert.throws(() => manifestTreeHashSchema(value), /unsupported/);
  assert.equal(requireV2TreeHashLock({ tree_hash_schema: "apodictic-tree-sha256-v2" }).tree_hash_schema, "apodictic-tree-sha256-v2");
  for (const lock of [{}, { tree_hash_schema: null }, { tree_hash_schema: "future-v3" }]) assert.throws(() => requireV2TreeHashLock(lock), /lacks/);
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
