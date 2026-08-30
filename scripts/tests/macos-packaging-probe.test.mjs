import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  childEnvironment,
} from "../run-macos-packaging-probe.mjs";
import {
  expectedHostTarget,
} from "../verify-macos-packaging-probe.mjs";

test("child environment contains only the frozen allowlist and probe target", () => {
  const filtered = childEnvironment("probe-target", {
    PATH: "/bin",
    HOME: "/safe-home",
    LANG: "en_US.UTF-8",
    UNLISTED: "drop-me",
    GEMINI_SYNC_TOKEN: "",
    GH_TOKEN: "drop-me-too",
    GITHUB_TOKEN: "drop-me-too",
    APPLE_SIGNING_IDENTITY: "drop-me-too",
  });
  assert.deepEqual(filtered, {
    PATH: "/bin",
    HOME: "/safe-home",
    LANG: "en_US.UTF-8",
    CARGO_TARGET_DIR: "probe-target",
  });
});

test("host mapping is exact and rejects unsupported combinations", () => {
  assert.deepEqual(expectedHostTarget("darwin", "arm64"), {
    targetTriple: "aarch64-apple-darwin",
    machArch: "arm64",
  });
  assert.deepEqual(expectedHostTarget("darwin", "x64"), {
    targetTriple: "x86_64-apple-darwin",
    machArch: "x86_64",
  });
  assert.throws(() => expectedHostTarget("linux", "x64"), /unsupported packaging-probe host/);
});

test("direct verifier invocation cannot issue a receipt", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "packaging-verifier-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const copiedFixture = path.join(directory, "Copied.app");
  const receiptPath = path.join(directory, "packaging-probe-receipt.json");
  fs.mkdirSync(path.join(copiedFixture, "Contents"), { recursive: true });

  const verifierPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "verify-macos-packaging-probe.mjs");
  const result = spawnSync(process.execPath, [verifierPath, copiedFixture, "aarch64-apple-darwin", receiptPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /verifier is internal/);
  assert.equal(fs.existsSync(receiptPath), false);
});
