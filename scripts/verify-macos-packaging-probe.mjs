import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashTree, sha256File } from "./lib/canonical-tree-hash.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const probeRoot = path.join(repoRoot, "src-tauri", "target", "packaging-probes");
const baseConfigPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const lockPath = path.join(repoRoot, "gemini-web.lock");

const PROBE_NAME = "UNSIGNED-NON-DISTRIBUTABLE-PACKAGING-PROBE";

function fail(message) {
  throw new Error(message);
}

function command(commandPath, args, environment, options = {}) {
  const result = spawnSync(commandPath, args, {
    cwd: repoRoot,
    env: environment,
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

function output(commandPath, args, environment) {
  const value = command(commandPath, args, environment).stdout.trim();
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

function plistValue(infoPlist, key, environment) {
  return output("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist], environment);
}

function exactArchitectures(binary, expectedArchitecture, label, environment) {
  const arches = output("/usr/bin/lipo", ["-archs", binary], environment).split(/\s+/).filter(Boolean);
  if (arches.length !== 1 || arches[0] !== expectedArchitecture) {
    fail(`${label} architectures ${JSON.stringify(arches)} do not equal ${expectedArchitecture}`);
  }
}

function verifyUnsignedOrAdHoc(appPath, environment) {
  const result = command("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], environment, { allowFailure: true });
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

export function verifyBundleAndConstructReceipt(appArgument, targetTriple, sourceCommit, runArgument, environment) {
  const expected = expectedHostTarget();
  if (targetTriple !== expected.targetTriple) fail(`target ${targetTriple} does not match this host`);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail("source commit is malformed");

  requireDirectory(probeRoot, "packaging-probe target root");
  const resolvedRoot = fs.realpathSync(probeRoot);
  requireDirectory(runArgument, "packaging-probe run directory");
  const resolvedRun = fs.realpathSync(runArgument);
  if (!isStrictlyWithin(resolvedRoot, resolvedRun)) fail("run directory escapes the packaging-probe target root");

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

  const bundleIdentifier = plistValue(infoPlist, "CFBundleIdentifier", environment);
  const shortVersion = plistValue(infoPlist, "CFBundleShortVersionString", environment);
  const bundleVersion = plistValue(infoPlist, "CFBundleVersion", environment);
  const minimumSystemVersion = plistValue(infoPlist, "LSMinimumSystemVersion", environment);
  if (bundleIdentifier !== "com.anotherpanacea.apodictic") fail(`wrong bundle identifier ${bundleIdentifier}`);
  if (shortVersion !== baseConfig.version || bundleVersion !== baseConfig.version) fail("bundle versions do not match the base Tauri version");
  if (minimumSystemVersion !== "14.0") fail(`wrong minimum system version ${minimumSystemVersion}`);

  exactArchitectures(appBinary, expected.machArch, "app executable", environment);
  exactArchitectures(sidecarBinary, expected.machArch, "sidecar", environment);
  if (sha256File(sidecarBinary) !== lockedSidecar.sha256) fail("bundled sidecar hash does not match gemini-web.lock");
  if (hashTree(distDirectory) !== lock.dist_sha256) fail("bundled dist hash does not match gemini-web.lock");
  if (hashTree(pluginDirectory) !== lock.plugin_sha256) fail("bundled plugin hash does not match gemini-web.lock");
  verifyUnsignedOrAdHoc(appPath, environment);

  return {
    schema_version: 1,
    probe_name: PROBE_NAME,
    source_commit: sourceCommit,
    payload_tag: lock.tag,
    payload_commit: lock.commit,
    host_os_version: output("/usr/bin/sw_vers", ["-productVersion"], environment),
    target_triple: targetTriple,
    bundle_version: bundleVersion,
    minimum_system_version: minimumSystemVersion,
    distribution_ready: false,
    developer_id_signed: false,
    m0_status: "NO-GO",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  console.error("✗ packaging-probe verifier is internal; invoke npm run packaging:probe");
  process.exit(2);
}
