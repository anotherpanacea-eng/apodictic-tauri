#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashTree, sha256File } from "./lib/canonical-tree-hash.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const probeRoot = path.join(repoRoot, "src-tauri", "target", "packaging-probes");
const baseConfigPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const lockPath = path.join(repoRoot, "gemini-web.lock");
const tauriCliPath = path.join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");

const PROBE_NAME = "UNSIGNED-NON-DISTRIBUTABLE-PACKAGING-PROBE";
const GATE_RECORD = "fleet-coordination/handoffs/CODE-MAC-APODICTIC-M0-INVENTORY-2026-07-21.md";

const RECEIPT_FIELDS = Object.freeze([
  "schema_version",
  "probe_name",
  "source_commit",
  "payload_tag",
  "payload_commit",
  "lock_sha256",
  "host_os_version",
  "host_arch",
  "target_triple",
  "rustc_version",
  "cargo_version",
  "node_version",
  "tauri_cli_version",
  "bundle_identifier",
  "bundle_version",
  "minimum_system_version",
  "app_arches",
  "sidecar_arches",
  "bundle_tree_sha256",
  "distribution_ready",
  "developer_id_signed",
  "notarization_proven",
  "sbom_complete",
  "notices_complete",
  "m0_status",
  "canonical_gate_record",
]);

const STRING_FIELDS = Object.freeze([
  "probe_name",
  "source_commit",
  "payload_tag",
  "payload_commit",
  "lock_sha256",
  "host_os_version",
  "host_arch",
  "target_triple",
  "rustc_version",
  "cargo_version",
  "node_version",
  "tauri_cli_version",
  "bundle_identifier",
  "bundle_version",
  "minimum_system_version",
  "bundle_tree_sha256",
  "m0_status",
  "canonical_gate_record",
]);

const BOOLEAN_FIELDS = Object.freeze([
  "distribution_ready",
  "developer_id_signed",
  "notarization_proven",
  "sbom_complete",
  "notices_complete",
]);

function fail(message) {
  throw new Error(message);
}

function command(commandPath, args, options = {}) {
  const result = spawnSync(commandPath, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) fail(`${path.basename(commandPath)} could not run: ${result.error.message}`);
  if (result.signal) fail(`${path.basename(commandPath)} terminated by signal ${result.signal}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${path.basename(commandPath)} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function output(commandPath, args) {
  const value = command(commandPath, args).stdout.trim();
  if (!value || value.includes("\n") || value.includes("\r")) {
    fail(`${path.basename(commandPath)} did not return one non-empty line`);
  }
  return value;
}

function readJsonObject(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a JSON object`);
  return value;
}

function requireRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a real regular file`);
}

function requireDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory`);
}

function isStrictlyWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function expectedHostTarget(platform = process.platform, architecture = process.arch) {
  if (platform === "darwin" && architecture === "arm64") {
    return { targetTriple: "aarch64-apple-darwin", machArch: "arm64" };
  }
  if (platform === "darwin" && architecture === "x64") {
    return { targetTriple: "x86_64-apple-darwin", machArch: "x86_64" };
  }
  fail(`unsupported packaging-probe host ${platform}/${architecture}`);
}

function validateLock(lock, targetTriple) {
  const hashPattern = /^[0-9a-f]{64}$/;
  for (const field of ["tag", "commit", "dist_sha256", "plugin_sha256"]) {
    if (typeof lock[field] !== "string" || !lock[field]) fail(`gemini-web.lock has invalid ${field}`);
  }
  if (lock.status !== "pinned") fail("gemini-web.lock is not pinned");
  if (!/^[0-9a-f]{40}$/.test(lock.commit)) fail("gemini-web.lock contains a malformed commit");
  if (!hashPattern.test(lock.dist_sha256) || !hashPattern.test(lock.plugin_sha256)) {
    fail("gemini-web.lock contains a malformed tree hash");
  }
  if (!Array.isArray(lock.sidecars) || lock.sidecars.length === 0) {
    fail("gemini-web.lock has no sidecars");
  }
  const seenTargets = new Set();
  for (const entry of lock.sidecars) {
    if (!entry || typeof entry.target !== "string" || !entry.target || !hashPattern.test(entry.sha256 || "")) {
      fail("gemini-web.lock contains a malformed sidecar entry");
    }
    if (seenTargets.has(entry.target)) fail(`gemini-web.lock repeats sidecar target ${entry.target}`);
    seenTargets.add(entry.target);
  }
  const matches = lock.sidecars.filter((entry) => entry.target === targetTriple);
  if (matches.length !== 1 || !hashPattern.test(matches[0]?.sha256 || "")) {
    fail(`gemini-web.lock must contain one valid sidecar for ${targetTriple}`);
  }
  return matches[0];
}

function plistValue(infoPlist, key) {
  return output("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist]);
}

function exactArchitectures(binary, expectedArchitecture, label) {
  const arches = output("/usr/bin/lipo", ["-archs", binary]).split(/\s+/).filter(Boolean);
  if (arches.length !== 1 || arches[0] !== expectedArchitecture) {
    fail(`${label} architectures ${JSON.stringify(arches)} do not equal ${expectedArchitecture}`);
  }
  return arches;
}

function verifyUnsignedOrAdHoc(appPath) {
  const result = command("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { allowFailure: true });
  const diagnostics = result.stderr || "";
  if (/^Authority=/m.test(diagnostics)) fail("bundle exposes a signing Authority");

  const teamIdentifiers = [...diagnostics.matchAll(/^TeamIdentifier=(.*)$/gm)].map((match) => match[1].trim());
  if (teamIdentifiers.some((identifier) => identifier !== "not set")) {
    fail(`bundle exposes a TeamIdentifier: ${teamIdentifiers.join(", ")}`);
  }

  const reportsUnsigned = /code object is not signed at all/i.test(diagnostics);
  const reportsAdHoc = /^Signature=adhoc$/m.test(diagnostics) || /\badhoc\b/i.test(diagnostics) || /\blinker-signed\b/i.test(diagnostics);
  if (!reportsUnsigned && !reportsAdHoc) {
    fail("codesign did not report an unsigned, ad-hoc, or linker-signed bundle");
  }
}

function containsAbsolutePosixPath(value) {
  return /(^|[^A-Za-z0-9._~-])\/(?!\/)[^\s"']+/.test(value);
}

function walkReceiptValues(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkReceiptValues(item, visit);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) walkReceiptValues(item, visit);
  }
}

export function validateReceipt(receipt, sensitive = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("receipt must be an object");
  const keys = Object.keys(receipt);
  if (keys.length !== RECEIPT_FIELDS.length || RECEIPT_FIELDS.some((key) => !keys.includes(key))) {
    fail("receipt fields do not match the closed schema");
  }
  if (receipt.schema_version !== 1) fail("receipt schema_version must be 1");
  for (const field of STRING_FIELDS) {
    if (typeof receipt[field] !== "string" || receipt[field].length === 0) fail(`receipt ${field} must be a non-empty string`);
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof receipt[field] !== "boolean") fail(`receipt ${field} must be boolean`);
  }
  for (const field of ["app_arches", "sidecar_arches"]) {
    if (!Array.isArray(receipt[field]) || receipt[field].length !== 1 || receipt[field].some((item) => typeof item !== "string" || !item)) {
      fail(`receipt ${field} must be a one-item string array`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(receipt.source_commit) || !/^[0-9a-f]{40}$/.test(receipt.payload_commit)) {
    fail("receipt contains a malformed commit");
  }
  for (const field of ["lock_sha256", "bundle_tree_sha256"]) {
    if (!/^[0-9a-f]{64}$/.test(receipt[field])) fail(`receipt ${field} must be a SHA-256 digest`);
  }
  const receiptTarget = receipt.target_triple === "aarch64-apple-darwin"
    ? { host: "arm64", binary: "arm64" }
    : receipt.target_triple === "x86_64-apple-darwin"
      ? { host: "x86_64", binary: "x86_64" }
      : null;
  if (!receiptTarget || receipt.host_arch !== receiptTarget.host
      || receipt.app_arches[0] !== receiptTarget.binary || receipt.sidecar_arches[0] !== receiptTarget.binary) {
    fail("receipt target and architecture fields are inconsistent");
  }
  if (receipt.bundle_identifier !== "com.anotherpanacea.apodictic" || receipt.minimum_system_version !== "14.0") {
    fail("receipt bundle identity or minimum system version is invalid");
  }

  const fixed = {
    probe_name: PROBE_NAME,
    distribution_ready: false,
    developer_id_signed: false,
    notarization_proven: false,
    sbom_complete: false,
    notices_complete: false,
    m0_status: "NO-GO",
    canonical_gate_record: GATE_RECORD,
  };
  for (const [field, expected] of Object.entries(fixed)) {
    if (receipt[field] !== expected) fail(`receipt ${field} has the wrong fixed value`);
  }

  const forbiddenStrings = [sensitive.repoPath, sensitive.homePath].filter(Boolean);
  walkReceiptValues(receipt, (value) => {
    if (typeof value !== "string") return;
    for (const forbidden of forbiddenStrings) {
      if (value.includes(forbidden)) fail("receipt contains a machine-private string");
    }
    if (containsAbsolutePosixPath(value)) fail("receipt contains an absolute POSIX path");
  });
  return receipt;
}

function writeReceiptAtomically(receiptPath, receipt) {
  if (fs.existsSync(receiptPath)) fail("receipt already exists");
  const temporaryPath = path.join(path.dirname(receiptPath), `.packaging-probe-receipt.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, receiptPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

export function verifyBundleAndWriteReceipt(appArgument, targetTriple, receiptArgument) {
  const expected = expectedHostTarget();
  if (targetTriple !== expected.targetTriple) fail(`target ${targetTriple} does not match this host`);
  if (path.basename(receiptArgument) !== "packaging-probe-receipt.json") fail("unexpected receipt filename");

  requireDirectory(probeRoot, "packaging-probe target root");
  const resolvedRoot = fs.realpathSync(probeRoot);
  const receiptPath = path.resolve(receiptArgument);
  const runDirectory = path.dirname(receiptPath);
  requireDirectory(runDirectory, "packaging-probe run directory");
  const resolvedRun = fs.realpathSync(runDirectory);
  if (!isStrictlyWithin(resolvedRoot, resolvedRun)) fail("run directory escapes the packaging-probe target root");
  if (fs.existsSync(receiptPath)) fail("receipt already exists");

  requireDirectory(appArgument, "produced app");
  const appPath = fs.realpathSync(appArgument);
  if (!isStrictlyWithin(resolvedRun, appPath)) fail("produced app escapes its packaging-probe run directory");

  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const appBinary = path.join(appPath, "Contents", "MacOS", "apodictic-tauri");
  const sidecarBinary = path.join(appPath, "Contents", "MacOS", "app-sidecar");
  const distDirectory = path.join(appPath, "Contents", "Resources", "dist");
  const pluginDirectory = path.join(appPath, "Contents", "Resources", "apodictic-plugin");
  requireRegularFile(infoPlist, "bundle Info.plist");
  requireRegularFile(appBinary, "bundle app executable");
  requireRegularFile(sidecarBinary, "bundle sidecar");
  requireDirectory(distDirectory, "bundle dist resource");
  requireDirectory(pluginDirectory, "bundle plugin resource");

  const baseConfig = readJsonObject(baseConfigPath, "base Tauri config");
  if (typeof baseConfig.version !== "string" || !baseConfig.version) fail("base Tauri config has no version");
  const lock = readJsonObject(lockPath, "gemini-web.lock");
  const lockedSidecar = validateLock(lock, targetTriple);

  const bundleIdentifier = plistValue(infoPlist, "CFBundleIdentifier");
  const shortVersion = plistValue(infoPlist, "CFBundleShortVersionString");
  const bundleVersion = plistValue(infoPlist, "CFBundleVersion");
  const minimumSystemVersion = plistValue(infoPlist, "LSMinimumSystemVersion");
  if (bundleIdentifier !== "com.anotherpanacea.apodictic") fail(`wrong bundle identifier ${bundleIdentifier}`);
  if (shortVersion !== baseConfig.version || bundleVersion !== baseConfig.version) fail("bundle versions do not match the base Tauri version");
  if (minimumSystemVersion !== "14.0") fail(`wrong minimum system version ${minimumSystemVersion}`);

  const appArches = exactArchitectures(appBinary, expected.machArch, "app executable");
  const sidecarArches = exactArchitectures(sidecarBinary, expected.machArch, "sidecar");
  if (sha256File(sidecarBinary) !== lockedSidecar.sha256) fail("bundled sidecar hash does not match gemini-web.lock");
  if (hashTree(distDirectory) !== lock.dist_sha256) fail("bundled dist hash does not match gemini-web.lock");
  if (hashTree(pluginDirectory) !== lock.plugin_sha256) fail("bundled plugin hash does not match gemini-web.lock");
  verifyUnsignedOrAdHoc(appPath);

  requireRegularFile(tauriCliPath, "repository Tauri CLI");
  const receipt = {
    schema_version: 1,
    probe_name: PROBE_NAME,
    source_commit: output("/usr/bin/git", ["rev-parse", "HEAD"]),
    payload_tag: lock.tag,
    payload_commit: lock.commit,
    lock_sha256: sha256File(lockPath),
    host_os_version: output("/usr/bin/sw_vers", ["-productVersion"]),
    host_arch: expected.machArch,
    target_triple: targetTriple,
    rustc_version: output("rustc", ["--version"]),
    cargo_version: output("cargo", ["--version"]),
    node_version: process.version,
    tauri_cli_version: output(process.execPath, [tauriCliPath, "--version"]),
    bundle_identifier: bundleIdentifier,
    bundle_version: bundleVersion,
    minimum_system_version: minimumSystemVersion,
    app_arches: appArches,
    sidecar_arches: sidecarArches,
    bundle_tree_sha256: hashTree(appPath),
    distribution_ready: false,
    developer_id_signed: false,
    notarization_proven: false,
    sbom_complete: false,
    notices_complete: false,
    m0_status: "NO-GO",
    canonical_gate_record: GATE_RECORD,
  };
  validateReceipt(receipt, {
    repoPath: repoRoot,
    homePath: os.homedir(),
  });
  writeReceiptAtomically(receiptPath, receipt);
  return receipt;
}

function main() {
  if (process.argv.length !== 5) {
    console.error("Usage: verify-macos-packaging-probe.mjs <app-path> <host-target> <receipt-path>");
    process.exit(2);
  }
  try {
    verifyBundleAndWriteReceipt(process.argv[2], process.argv[3], process.argv[4]);
    console.log("✓ packaging-probe bundle contract verified; code-safe receipt written atomically");
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
