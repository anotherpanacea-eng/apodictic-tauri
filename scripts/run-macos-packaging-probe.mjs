#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectedHostTarget,
  verifyBundleAndConstructReceipt,
} from "./verify-macos-packaging-probe.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const outputRoot = path.join(repoRoot, "src-tauri", "target", "packaging-probes");
const overlayPath = path.join(repoRoot, "src-tauri", "tauri.packaging-probe.conf.json");
const syncScript = path.join(repoRoot, "scripts", "sync-gemini-web.mjs");
const sidecarVerifier = path.join(repoRoot, "scripts", "verify-sidecar-runtime.mjs");
const lockPath = path.join(repoRoot, "gemini-web.lock");

const CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "SDKROOT",
  "DEVELOPER_DIR",
  "CI",
]);

function fail(message) {
  throw new Error(message);
}

export function childEnvironment(targetDirectory, environment = process.env) {
  const filtered = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(environment, name)) filtered[name] = environment[name];
  }
  filtered.CARGO_TARGET_DIR = targetDirectory;
  return filtered;
}

function run(commandPath, args, env, options = {}) {
  const result = spawnSync(commandPath, args, {
    cwd: options.cwd ?? repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) fail(`${path.basename(commandPath)} could not run: ${result.error.message}`);
  if (result.signal) fail(`${path.basename(commandPath)} terminated by signal ${result.signal}`);
  if (result.status !== 0) fail(`${options.label || path.basename(commandPath)} failed`);
  return options.capture ? (result.stdout || "") : "";
}

export function verifyTrackedSourceClean(directory = repoRoot, env = process.env) {
  const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
  const options = { capture: true, cwd: directory, label: "tracked worktree check" };
  const flags = run(git, ["ls-files", "-v", "-z"], env, options).split("\0").filter(Boolean);
  for (const entry of flags) {
    if (!entry.startsWith("H ")) fail(`tracked source has a hidden or nonstandard index flag: ${entry.slice(0, 1)}`);
  }
  run(git, ["diff-index", "--cached", "--quiet", "HEAD", "--"], env, { cwd: directory, label: "HEAD/index check" });
  const staged = run(git, ["ls-files", "--stage", "-z"], env, options).split("\0").filter(Boolean);
  for (const entry of staged) {
    const separator = entry.indexOf("\t");
    const metadata = entry.slice(0, separator).split(" "); const file = entry.slice(separator + 1);
    if (separator < 0 || metadata.length !== 3 || metadata[2] !== "0") fail("tracked source index is malformed or unmerged");
    const actual = run(git, ["hash-object", `--path=${file}`, "--", file], env, options).trim();
    if (actual !== metadata[1]) fail(`tracked source bytes differ from HEAD/index: ${file}`);
  }
}

function currentHead(env) {
  const head = run("/usr/bin/git", ["rev-parse", "HEAD"], env, {
    capture: true,
    label: "source commit check",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) fail("source commit check returned a malformed commit");
  return head;
}

function writeReceipt(receiptPath, receipt) {
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function ensureRealDirectory(directory, create) {
  if (!fs.existsSync(directory)) {
    if (!create) fail(`required directory is missing: ${path.relative(repoRoot, directory)}`);
    fs.mkdirSync(directory);
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`unsafe output ancestor: ${path.relative(repoRoot, directory) || "."}`);
  }
}

function prepareRunDirectory() {
  const parsed = path.parse(outputRoot);
  const ancestors = [parsed.root];
  let current = parsed.root;
  for (const component of outputRoot.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    ancestors.push(current);
  }
  const creatable = new Set([path.join(repoRoot, "src-tauri", "target"), outputRoot]);
  for (const ancestor of ancestors) {
    ensureRealDirectory(ancestor, creatable.has(ancestor));
  }
  const resolvedRoot = fs.realpathSync(outputRoot);
  const runDirectory = fs.mkdtempSync(path.join(resolvedRoot, "probe-"));
  ensureRealDirectory(runDirectory, false);
  const resolvedRun = fs.realpathSync(runDirectory);
  const relative = path.relative(resolvedRoot, resolvedRun);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("fresh run directory escapes the packaging-probe target root");
  }
  return { resolvedRoot, resolvedRun };
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

function requireStagedPayload(targetTriple) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const sidecars = Array.isArray(lock.sidecars) ? lock.sidecars.filter((entry) => entry?.target === targetTriple) : [];
  if (sidecars.length !== 1 || typeof sidecars[0].sha256 !== "string") {
    fail(`gemini-web.lock lacks one host sidecar for ${targetTriple}`);
  }
  requireRegularFile(
    path.join(repoRoot, "vendor", "gemini-web", "binaries", `app-sidecar-${targetTriple}`),
    `staged ${targetTriple} sidecar`,
  );
  for (const [relativePath, label] of [
    [path.join("vendor", "gemini-web", "dist"), "staged dist"],
    [path.join("vendor", "gemini-web", "apodictic-plugin"), "staged plugin"],
  ]) {
    const directory = path.join(repoRoot, relativePath);
    let stat;
    try {
      stat = fs.lstatSync(directory);
    } catch {
      fail(`${label} is missing`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory`);
  }
}

function resolveTauriCli() {
  const packageRoot = fs.realpathSync(path.join(repoRoot, "node_modules", "@tauri-apps", "cli"));
  const cliPath = fs.realpathSync(path.join(repoRoot, "node_modules", ".bin", "tauri"));
  const relative = path.relative(packageRoot, cliPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("repository Tauri CLI resolves outside @tauri-apps/cli");
  }
  requireRegularFile(cliPath, "repository Tauri CLI");
  return cliPath;
}

function main() {
  if (process.argv.length !== 2) fail("packaging probe accepts no arguments");
  if (process.env.INTERNAL_PACKAGING_PROBE !== "1") fail("set INTERNAL_PACKAGING_PROBE=1 to invoke the packaging probe explicitly");

  const host = expectedHostTarget();
  const { resolvedRoot, resolvedRun } = prepareRunDirectory();
  const env = childEnvironment(resolvedRun);
  verifyTrackedSourceClean(repoRoot, env);
  const sourceCommit = currentHead(env);

  requireStagedPayload(host.targetTriple);
  requireRegularFile(overlayPath, "packaging-probe Tauri overlay");
  const receiptPath = path.join(resolvedRun, "packaging-probe-receipt.json");
  if (fs.existsSync(receiptPath)) fail("fresh run directory already contains a receipt");

  console.log(`Packaging probe target: ${host.targetTriple}`);
  run(process.execPath, [syncScript, "--check"], env, { label: "offline payload drift gate" });
  run(process.execPath, [sidecarVerifier], env, { label: "sidecar runtime verifier" });

  const tauriCli = resolveTauriCli();
  run(process.execPath, [
    tauriCli,
    "build",
    "--ci",
    "--no-sign",
    "--bundles",
    "app",
    "--target",
    host.targetTriple,
    "--config",
    overlayPath,
  ], env, { label: "Tauri packaging probe build" });

  const appCandidate = path.join(resolvedRun, host.targetTriple, "release", "bundle", "macos", "APODICTIC.app");
  const appPath = fs.realpathSync(appCandidate);
  for (const parent of [resolvedRoot, resolvedRun]) {
    const relative = path.relative(parent, appPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail("produced app escapes the quarantined packaging-probe output");
    }
  }
  const receipt = verifyBundleAndConstructReceipt(
    appPath,
    host.targetTriple,
    sourceCommit,
    resolvedRun,
    env,
  );
  if (currentHead(env) !== sourceCommit) fail("source commit changed while the packaging probe was running");
  verifyTrackedSourceClean(repoRoot, env);
  writeReceipt(receiptPath, receipt);

  console.log("✓ UNSIGNED-NON-DISTRIBUTABLE-PACKAGING-PROBE complete");
  console.log(`The app and receipt remain only under ignored local target output: ${path.relative(repoRoot, resolvedRun)}`);
  console.log("No artifact was published or distributed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
