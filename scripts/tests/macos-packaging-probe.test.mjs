import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  childEnvironment,
  verifyTrackedSourceClean,
} from "../run-macos-packaging-probe.mjs";
import {
  expectedHostTarget,
  verifyBundleAndConstructReceipt,
} from "../verify-macos-packaging-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const macOnly = process.platform === "darwin" ? false : "requires the real macOS bundle inspection tools";

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

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`tracked source hidden by ${flag} cannot bind a receipt to HEAD`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "packaging-source-proof-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    git(directory, ["init", "-b", "main"]); git(directory, ["config", "user.name", "Test"]); git(directory, ["config", "user.email", "test@example.invalid"]);
    const source = path.join(directory, "source.txt"); const receipt = path.join(directory, "receipt.json");
    fs.writeFileSync(source, "reviewed\n"); git(directory, ["add", "source.txt"]); git(directory, ["commit", "-m", "reviewed"]);
    git(directory, ["update-index", flag, "source.txt"]); fs.writeFileSync(source, "different bytes\n");
    assert.equal(git(directory, ["status", "--porcelain=v1", "--untracked-files=no"]), "");
    assert.throws(() => verifyTrackedSourceClean(directory), /index flag|differ/);
    assert.equal(fs.existsSync(receipt), false);
  });
}

function macBundleFixture(t) {
  const host = expectedHostTarget();
  const probeRoot = path.join(repoRoot, "src-tauri", "target", "packaging-probes");
  fs.mkdirSync(probeRoot, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(probeRoot, "fixture-"));
  t.after(() => fs.rmSync(runDirectory, { recursive: true, force: true }));
  const app = path.join(runDirectory, "Copied.app"); const contents = path.join(app, "Contents");
  const macos = path.join(contents, "MacOS"); const resources = path.join(contents, "Resources");
  fs.mkdirSync(macos, { recursive: true }); fs.mkdirSync(resources, { recursive: true });
  const staged = path.join(repoRoot, "vendor", "gemini-web");
  fs.cpSync(path.join(staged, "dist"), path.join(resources, "dist"), { recursive: true, errorOnExist: true });
  fs.cpSync(path.join(staged, "apodictic-plugin"), path.join(resources, "apodictic-plugin"), { recursive: true, errorOnExist: true });
  const stagedSidecar = path.join(staged, "binaries", `app-sidecar-${host.targetTriple}`);
  for (const name of ["apodictic-tauri", "app-sidecar"]) { const target = path.join(macos, name); fs.copyFileSync(stagedSidecar, target); fs.chmodSync(target, 0o755); }
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8")).version;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleExecutable</key><string>apodictic-tauri</string>\n<key>CFBundleIdentifier</key><string>com.anotherpanacea.apodictic</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n<key>CFBundleVersion</key><string>${version}</string>\n<key>LSMinimumSystemVersion</key><string>14.0</string>\n</dict></plist>\n`;
  fs.writeFileSync(path.join(contents, "Info.plist"), plist);
  return { app, host, receipt: path.join(runDirectory, "packaging-probe-receipt.json"), runDirectory };
}

test("copied staged bundle satisfies the real macOS verifier", { skip: macOnly }, (t) => {
  const fixture = macBundleFixture(t);
  const receipt = verifyBundleAndConstructReceipt(fixture.app, fixture.host.targetTriple, "a".repeat(40), fixture.runDirectory, process.env);
  assert.equal(receipt.distribution_ready, false); assert.equal(receipt.m0_status, "NO-GO"); assert.equal(fs.existsSync(fixture.receipt), false);
});

for (const [name, mutate, expected] of [
  ["changed dist byte", (fixture) => fs.writeFileSync(path.join(fixture.app, "Contents", "Resources", "dist", "tamper.txt"), "tamper"), /dist hash/],
  ["wrong minimum OS", (fixture) => { const plist = path.join(fixture.app, "Contents", "Info.plist"); fs.writeFileSync(plist, fs.readFileSync(plist, "utf8").replace("14.0", "13.0")); }, /minimum system version/],
  ["missing sidecar", (fixture) => fs.rmSync(path.join(fixture.app, "Contents", "MacOS", "app-sidecar")), /sidecar is missing/],
]) test(`copied bundle refuses ${name} without a receipt`, { skip: macOnly }, (t) => {
  const fixture = macBundleFixture(t); mutate(fixture);
  assert.throws(() => verifyBundleAndConstructReceipt(fixture.app, fixture.host.targetTriple, "a".repeat(40), fixture.runDirectory, process.env), expected);
  assert.equal(fs.existsSync(fixture.receipt), false);
});

test("copied bundle refuses the wrong target without a receipt", { skip: macOnly }, (t) => {
  const fixture = macBundleFixture(t); const wrong = fixture.host.targetTriple === "aarch64-apple-darwin" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
  assert.throws(() => verifyBundleAndConstructReceipt(fixture.app, wrong, "a".repeat(40), fixture.runDirectory, process.env), /does not match this host/);
  assert.equal(fs.existsSync(fixture.receipt), false);
});
