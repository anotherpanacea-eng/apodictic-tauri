#!/usr/bin/env node
/**
 * sync-gemini-web.mjs — vendor APODICTIC-Gemini's desktop payload into vendor/gemini-web/.
 *
 * This is the CONSUMER half of the fleet's pull/lock/drift-gate pattern (mirrors, in shape,
 * APODICTIC-Gemini's scripts/sync-plugin.mjs — but a different TRANSPORT, see below).
 *
 * Why not "just mirror sync-plugin.mjs": that script pulls a git TARBALL of a tag and vendors
 * committed source. The desktop payload's two biggest inputs — the built `dist/` and the pkg'd
 * `app-sidecar` binaries — are gitignored BUILD ARTIFACTS, absent from the tree at any tag. So
 * this script pulls a GitHub *release asset* (the producer's `desktop-payload-<ver>.tar.gz`),
 * not a tarball.
 *
 * Producer contract (APODICTIC-Gemini release, created in migration Increment 2 — see
 * docs/architecture.md §5; NOT yet shipped as of repo founding):
 *   A `v*` release uploads:
 *     - desktop-payload-<web_version>.tar.gz   — tarball of { dist/, binaries/app-sidecar-<target>…, apodictic-plugin/ }
 *     - payload-manifest.json                  — { web_version, plugin_version, commit,
 *                                                   dist_sha256, plugin_sha256,
 *                                                   sidecars: [{ target, sha256 }] }
 *
 * Usage:
 *   node scripts/sync-gemini-web.mjs           # vendor the latest Gemini release payload, write the lock
 *   node scripts/sync-gemini-web.mjs v0.3.0    # vendor a specific tag
 *   node scripts/sync-gemini-web.mjs --pinned  # re-vendor the tag already recorded in the lock
 *   node scripts/sync-gemini-web.mjs --check   # drift gate: lock behind latest? vendored hashes != lock? -> exit 1
 *
 * Env:
 *   GEMINI_SYNC_TOKEN / GH_TOKEN / GITHUB_TOKEN — REQUIRED for network ops: APODICTIC-Gemini is
 *     PRIVATE, so the default current-repo GITHUB_TOKEN cannot read its release assets. Use a PAT
 *     or GitHub-App token with cross-repo read on anotherpanacea-eng/APODICTIC-Gemini.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashTree, legacyHashTree, manifestTreeHashSchema, requireV2TreeHashLock, sha256File } from "./lib/canonical-tree-hash.mjs";

const REPO = "anotherpanacea-eng/APODICTIC-Gemini";
const API = "https://api.github.com";
const PAYLOAD_ASSET_PREFIX = "desktop-payload-";
const MANIFEST_ASSET = "payload-manifest.json";
const LEGACY_RELEASE = Object.freeze({ tag: "v0.2.1", commit: "268341b69020a6c7973d5584199c580ecc19c663" });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(repoRoot, "vendor", "gemini-web");
const LOCK = path.join(repoRoot, "gemini-web.lock");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const PINNED = args.includes("--pinned");
const unknownFlags = args.filter((arg) => arg.startsWith("--") && !["--check", "--pinned"].includes(arg));
const positionalTags = args.filter((arg) => !arg.startsWith("--"));
const explicitTag = positionalTags[0];

if (unknownFlags.length || positionalTags.length > 1 || (CHECK && (PINNED || explicitTag)) || (PINNED && explicitTag)) {
  console.error(
    "✗ Invalid arguments. Use one of: no arguments, one explicit tag, --pinned, or --check."
  );
  process.exit(2);
}

function token() {
  return process.env.GEMINI_SYNC_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

function readLock() {
  if (!fs.existsSync(LOCK)) return null;
  return JSON.parse(fs.readFileSync(LOCK, "utf8"));
}

async function gh(urlPath) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "apodictic-tauri-sync" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API}${urlPath}`, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status} for ${urlPath}` +
        (res.status === 404 ? ` — private repo without a token, or no such release.` : "")
    );
  }
  return res.json();
}

/**
 * Verify the vendored payload against the lock by RECOMPUTING hashes from the bytes on disk
 * (dist/ + apodictic-plugin/ via hashTree, each sidecar via sha256File) — not by trusting the
 * manifest's self-reported values (S3). Offline; returns a list of problems.
 */
function verifyVendoredAgainstLock(lock) {
  const problems = [];
  try { requireV2TreeHashLock(lock); } catch { problems.push("lock lacks the collision-unambiguous tree hash schema — re-run `npm run sync:web`."); }
  const distDir = path.join(VENDOR, "dist");
  const binDir = path.join(VENDOR, "binaries");
  const pluginDir = path.join(VENDOR, "apodictic-plugin");

  if (!fs.existsSync(distDir)) {
    problems.push("vendor/gemini-web/dist/ missing — re-run `npm run sync:web`.");
  } else {
    const got = hashTree(distDir);
    if (got !== lock.dist_sha256) problems.push(`dist tree hash drift: ${got} != lock ${lock.dist_sha256}`);
  }

  if (!fs.existsSync(pluginDir)) {
    problems.push("vendor/gemini-web/apodictic-plugin/ missing — re-run `npm run sync:web`.");
  } else {
    const got = hashTree(pluginDir);
    if (got !== lock.plugin_sha256) problems.push(`plugin tree hash drift: ${got} != lock ${lock.plugin_sha256}`);
  }

  for (const { target, sha256 } of lock.sidecars || []) {
    const bin = path.join(binDir, `app-sidecar-${target}`);
    if (!fs.existsSync(bin)) {
      problems.push(`sidecar missing for target ${target} (${bin})`);
      continue;
    }
    const got = sha256File(bin);
    if (got !== sha256) problems.push(`sidecar hash drift for ${target}: ${got} != lock ${sha256}`);
  }
  if (!(lock.sidecars || []).length) problems.push("lock records no sidecars — re-run `npm run sync:web`.");
  return problems;
}

async function selectedRelease() {
  if (explicitTag) return gh(`/repos/${REPO}/releases/tags/${explicitTag}`);
  if (PINNED) {
    const lock = readLock();
    if (!lock?.tag) throw new Error("gemini-web.lock has no pinned tag");
    return gh(`/repos/${REPO}/releases/tags/${encodeURIComponent(lock.tag)}`);
  }
  return gh(`/repos/${REPO}/releases/latest`);
}

/**
 * Resolve a tag to its real commit SHA (S2). A release's `target_commitish` is frequently a
 * branch name ("main"), not a SHA, so it can't be trusted for re-pointed-tag detection the way
 * sync-plugin.mjs's explicit resolveCommit() does. Dereferences annotated tags to the commit.
 */
async function resolveCommit(tag) {
  const ref = await gh(`/repos/${REPO}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.object?.type === "tag") {
    const t = await gh(`/repos/${REPO}/git/tags/${ref.object.sha}`);
    return t.object?.sha || ref.object.sha;
  }
  return ref.object?.sha;
}

/**
 * Download a release's desktop-payload assets into destDir and extract the tar there. Returns
 * { payloadAsset, manifest }. Shared by doSync (destDir = VENDOR) and doCheck (destDir = a temp dir).
 * Throws if the release carries no desktop payload.
 */
async function downloadAndExtractPayload(rel, destDir) {
  const assets = rel.assets || [];
  const payloadAsset = assets.find((a) => a.name.startsWith(PAYLOAD_ASSET_PREFIX));
  const manifestAsset = assets.find((a) => a.name === MANIFEST_ASSET);
  if (!payloadAsset || !manifestAsset) {
    throw new Error(
      `release ${rel.tag_name} has no desktop payload (need '${PAYLOAD_ASSET_PREFIX}*' + '${MANIFEST_ASSET}') — ` +
        `the producer pipeline (APODICTIC-Gemini, migration Increment 2) has not shipped one. See docs/architecture.md §5.`
    );
  }
  fs.mkdirSync(destDir, { recursive: true });
  const dl = async (asset, dest) => {
    const res = await fetch(asset.url, {
      headers: { Accept: "application/octet-stream", Authorization: `Bearer ${token()}`, "User-Agent": "apodictic-tauri-sync" },
    });
    if (!res.ok) throw new Error(`download ${asset.name}: ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  };
  const archivePath = path.join(destDir, payloadAsset.name);
  await dl(payloadAsset, archivePath);
  await dl(manifestAsset, path.join(destDir, "payload-manifest.json"));
  execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
  fs.rmSync(archivePath, { force: true });
  return { payloadAsset, manifest: JSON.parse(fs.readFileSync(path.join(destDir, "payload-manifest.json"), "utf8")) };
}

/** Recompute the payload's hashes FROM THE BYTES on disk (dist/plugin tree hashes + each sidecar). */
function computePayloadHashes(dir) {
  const sidecars = [];
  const binDir = path.join(dir, "binaries");
  if (fs.existsSync(binDir)) {
    for (const f of fs.readdirSync(binDir).sort()) {
      if (f.startsWith("app-sidecar-")) sidecars.push({ target: f.replace(/^app-sidecar-/, ""), sha256: sha256File(path.join(binDir, f)) });
    }
  }
  return {
    dist_sha256: hashTree(path.join(dir, "dist")),
    plugin_sha256: hashTree(path.join(dir, "apodictic-plugin")),
    legacy_dist_sha256: legacyHashTree(path.join(dir, "dist")),
    legacy_plugin_sha256: legacyHashTree(path.join(dir, "apodictic-plugin")),
    sidecars,
  };
}

/** Compare hashes recomputed from real payload BYTES to the committed lock. */
function compareComputedToLock(lock, computed) {
  const problems = [];
  if (computed.dist_sha256 !== lock.dist_sha256)
    problems.push(`dist tree hash: lock ${lock.dist_sha256} != published payload ${computed.dist_sha256}`);
  if (computed.plugin_sha256 !== lock.plugin_sha256)
    problems.push(`plugin tree hash: lock ${lock.plugin_sha256} != published payload ${computed.plugin_sha256}`);
  const got = new Map(computed.sidecars.map((s) => [s.target, s.sha256]));
  for (const { target, sha256 } of lock.sidecars || []) {
    if (got.get(target) !== sha256)
      problems.push(`sidecar ${target}: lock ${sha256} != published payload ${got.get(target) ?? "(absent)"}`);
  }
  return problems;
}

async function doCheck() {
  const lock = readLock();
  if (!lock) {
    console.error("✗ gemini-web.lock missing.");
    process.exit(1);
  }
  // Bootstrap state: the producer pipeline (Increment 2) hasn't shipped a payload yet.
  // Nothing to verify; keep CI green and report the state. Flips to real gating once status=pinned.
  if (lock.status === "bootstrap") {
    console.log(
      "• gemini-web.lock is in BOOTSTRAP state — APODICTIC-Gemini has not yet published a desktop\n" +
        "  payload (migration Increment 2). Drift gate is a no-op until the lock is pinned. (OK)"
    );
    process.exit(0);
  }
  try { requireV2TreeHashLock(lock); } catch (error) { console.error(`✗ ${error.message}.`); process.exit(1); }

  // CONTENT verification. The vendored payload is gitignored / pulled on demand (large binaries),
  // so a fresh checkout (PR-time CI) has it ABSENT. We must still verify — NOT silently pass (Codex
  // P1, 2026-06-19, re-review): a clean checkout that exits 0 without verifying is false assurance.
  const payloadPresent =
    fs.existsSync(path.join(VENDOR, "dist")) || fs.existsSync(path.join(VENDOR, "binaries"));
  const problems = [];
  let verifiedVia;

  if (payloadPresent) {
    // Strongest: recompute the on-disk bytes and match them to the lock.
    problems.push(...verifyVendoredAgainstLock(lock));
    verifiedVia = "local payload bytes";
  } else if (token()) {
    // Clean checkout: verify the committed lock against the actual PUBLISHED PAYLOAD BYTES — download
    // the payload, extract to a temp dir, recompute the tree/sidecar hashes from the bytes, and compare
    // to the lock. NOT a manifest comparison: the manifest is a producer-asserted description of the
    // payload, so a re-published/tampered release could carry a manifest that still agrees with the lock
    // while the payload itself differs. Hashing the bytes is the only real integrity check (Codex P1,
    // 2026-06-19). apodictic-tauri CI provides GEMINI_SYNC_TOKEN, so CI always takes this path.
    let tmp;
    try {
      const rel = await gh(`/repos/${REPO}/releases/tags/${encodeURIComponent(lock.tag)}`);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-web-verify-"));
      await downloadAndExtractPayload(rel, tmp);
      problems.push(...compareComputedToLock(lock, computePayloadHashes(tmp)));
      verifiedVia = "published payload bytes";
    } catch (e) {
      problems.push(`could not verify the lock against the published payload: ${e.message}`);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    // No local payload AND no token → genuinely unverifiable. FAIL rather than falsely pass.
    console.error(
      "✗ cannot verify the pinned lock: no vendored payload present and no token.\n" +
        "  Run `npm run sync:web` (pulls + verifies) or set GEMINI_SYNC_TOKEN to verify against the release."
    );
    process.exit(1);
  }

  // FRESHNESS + re-pointed-tag (token-only): is the lock behind latest, or has the tag moved?
  if (token()) {
    try {
      const rel = await gh(`/repos/${REPO}/releases/latest`);
      if (rel.tag_name !== lock.tag)
        problems.push(`lock behind latest release: lock ${lock.tag} vs latest ${rel.tag_name}`);
      const tagCommit = await resolveCommit(lock.tag);
      if (tagCommit && lock.commit && lock.commit !== tagCommit)
        problems.push(`tag ${lock.tag} re-pointed: lock commit ${lock.commit} != tag ${tagCommit}`);
    } catch (e) {
      console.warn(`! freshness check skipped: ${e.message}`);
    }
  }

  if (problems.length) {
    console.error("✗ drift detected:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log(`✓ gemini-web.lock verified against ${verifiedVia} (${lock.tag}).`);
}

async function doSync() {
  if (!token()) {
    console.error(
      "✗ A token is required to sync (APODICTIC-Gemini is private). Set GEMINI_SYNC_TOKEN / GH_TOKEN."
    );
    process.exit(1);
  }
  const rel = await selectedRelease();
  // Clear only the gitignored payload contents, NOT the whole dir — vendor/gemini-web/README.md is
  // a committed file (explains the dir); a wholesale rmSync(VENDOR) would delete it on every sync.
  for (const p of ["dist", "binaries", "apodictic-plugin", "payload-manifest.json"]) {
    fs.rmSync(path.join(VENDOR, p), { recursive: true, force: true });
  }
  let payloadAsset, manifest;
  try {
    ({ payloadAsset, manifest } = await downloadAndExtractPayload(rel, VENDOR));
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }

  // Recompute hashes from the extracted bytes and verify them against the manifest's claims
  // (catches corruption/tampering in transit). The lock records the COMPUTED values.
  const computed = computePayloadHashes(VENDOR);
  const got = new Map(computed.sidecars.map((s) => [s.target, s.sha256]));
  const transit = [];
  const tagCommit = await resolveCommit(rel.tag_name);
  const allowLegacy = rel.tag_name === LEGACY_RELEASE.tag && tagCommit === LEGACY_RELEASE.commit;
  const manifestV2 = manifestTreeHashSchema(manifest.tree_hash_schema, { allowLegacy }) === "apodictic-tree-sha256-v2";
  const downloadedDist = manifestV2 ? computed.dist_sha256 : computed.legacy_dist_sha256;
  const downloadedPlugin = manifestV2 ? computed.plugin_sha256 : computed.legacy_plugin_sha256;
  if (manifest.dist_sha256 && manifest.dist_sha256 !== downloadedDist)
    transit.push(`dist: manifest ${manifest.dist_sha256} != downloaded ${downloadedDist}`);
  if (manifest.plugin_sha256 && manifest.plugin_sha256 !== downloadedPlugin)
    transit.push(`plugin: manifest ${manifest.plugin_sha256} != downloaded ${downloadedPlugin}`);
  for (const { target, sha256: claimed } of manifest.sidecars || []) {
    if (!got.has(target)) transit.push(`sidecar ${target}: missing from payload`);
    else if (claimed && claimed !== got.get(target))
      transit.push(`sidecar ${target}: manifest ${claimed} != downloaded ${got.get(target)}`);
  }
  // Bind the payload to the release tag's commit (Codex P1, 2026-06-19): the producer stamps
  // manifest.commit with the commit it built from; require it to equal the tag's resolved commit,
  // or the payload wasn't built from this tag (a release asset can be uploaded from any build).
  if (!manifest.commit) {
    transit.push("payload-manifest.json has no `commit` — cannot bind the payload to the tag.");
  } else if (tagCommit && manifest.commit !== tagCommit) {
    transit.push(`payload built from commit ${manifest.commit} but tag ${rel.tag_name} resolves to ${tagCommit}`);
  }

  if (transit.length) {
    console.error("✗ payload integrity check failed:\n  - " + transit.join("\n  - "));
    process.exit(1);
  }

  const lock = {
    repo: REPO,
    tag: rel.tag_name,
    commit: tagCommit,
    web_version: manifest.web_version,
    plugin_version: manifest.plugin_version, // inherited from Gemini's apodictic-plugin.lock; recorded, not re-pinned
    payload_asset: payloadAsset.name,
    tree_hash_schema: "apodictic-tree-sha256-v2",
    dist_sha256: computed.dist_sha256,
    plugin_sha256: computed.plugin_sha256,
    sidecars: computed.sidecars,
    status: "pinned",
    source: `https://github.com/${REPO}/releases/tag/${rel.tag_name}`,
  };
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");

  const problems = verifyVendoredAgainstLock(lock);
  if (problems.length) {
    console.error("✗ post-sync verification failed:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log(`✓ vendored APODICTIC-Gemini desktop payload ${rel.tag_name} (web ${manifest.web_version}).`);
}

(CHECK ? doCheck() : doSync()).catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
