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
 *   node scripts/sync-gemini-web.mjs --check   # drift gate: lock behind latest? vendored hashes != lock? -> exit 1
 *
 * Env:
 *   GEMINI_SYNC_TOKEN / GH_TOKEN / GITHUB_TOKEN — REQUIRED for network ops: APODICTIC-Gemini is
 *     PRIVATE, so the default current-repo GITHUB_TOKEN cannot read its release assets. Use a PAT
 *     or GitHub-App token with cross-repo read on anotherpanacea-eng/APODICTIC-Gemini.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "anotherpanacea-eng/APODICTIC-Gemini";
const API = "https://api.github.com";
const PAYLOAD_ASSET_PREFIX = "desktop-payload-";
const MANIFEST_ASSET = "payload-manifest.json";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(repoRoot, "vendor", "gemini-web");
const LOCK = path.join(repoRoot, "gemini-web.lock");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const explicitTag = args.find((a) => !a.startsWith("--"));

function token() {
  return process.env.GEMINI_SYNC_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

function readLock() {
  if (!fs.existsSync(LOCK)) return null;
  return JSON.parse(fs.readFileSync(LOCK, "utf8"));
}

function sha256File(p) {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * Canonical tree hash (the producer-consumer contract for dist/ and apodictic-plugin/).
 * Walk files in sorted POSIX-relative-path order; hash `path\0<filebytes>\0` for each. The
 * producer's payload-manifest.json MUST compute dist_sha256/plugin_sha256 the same way. This is
 * a REAL recompute over the bytes on disk (not trusting the manifest's self-reported hash — S3).
 */
function hashTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else files.push([r, abs]);
    }
  })(dir, "");
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash("sha256");
  for (const [r, abs] of files) {
    h.update(r);
    h.update("\0");
    h.update(fs.readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
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

async function latestRelease() {
  if (explicitTag) return gh(`/repos/${REPO}/releases/tags/${explicitTag}`);
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

  // 1) Offline: vendored bytes must match the lock.
  const problems = verifyVendoredAgainstLock(lock);

  // 2) Online (only if a token is available): is the lock behind the latest release?
  if (token()) {
    try {
      const rel = await latestRelease();
      if (rel.tag_name !== lock.tag) {
        problems.push(`lock behind latest release: lock ${lock.tag} vs latest ${rel.tag_name}`);
      } else {
        // re-pointed-tag protection (cf. sync-plugin.mjs:154-159): compare the RESOLVED commit SHA.
        const relCommit = await resolveCommit(rel.tag_name);
        if (relCommit && lock.commit && relCommit !== lock.commit) {
          problems.push(`tag ${lock.tag} re-pointed: release commit ${relCommit} != lock ${lock.commit}`);
        }
      }
    } catch (e) {
      console.warn(`! remote freshness check skipped: ${e.message}`);
    }
  } else {
    // Offline (e.g. PR-time CI without a token): bytes-match-lock is verified above; "behind latest"
    // freshness is the weekly sync workflow's job, which opens the bump PR.
    console.warn("! no token — offline byte-verify only; freshness is the weekly sync workflow's job.");
  }

  if (problems.length) {
    console.error("✗ drift detected:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log(`✓ vendor/gemini-web/ matches gemini-web.lock (${lock.tag}).`);
}

async function doSync() {
  if (!token()) {
    console.error(
      "✗ A token is required to sync (APODICTIC-Gemini is private). Set GEMINI_SYNC_TOKEN / GH_TOKEN."
    );
    process.exit(1);
  }
  const rel = await latestRelease();
  const assets = rel.assets || [];
  const payloadAsset = assets.find((a) => a.name.startsWith(PAYLOAD_ASSET_PREFIX));
  const manifestAsset = assets.find((a) => a.name === MANIFEST_ASSET);
  if (!payloadAsset || !manifestAsset) {
    console.error(
      `✗ Release ${rel.tag_name} has no desktop payload (need '${PAYLOAD_ASSET_PREFIX}*' + '${MANIFEST_ASSET}').\n` +
        `  The producer pipeline (APODICTIC-Gemini, migration Increment 2) has not shipped a payload yet.\n` +
        `  See docs/architecture.md §5.`
    );
    process.exit(1);
  }

  fs.rmSync(VENDOR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR, { recursive: true });

  const dl = async (asset, dest) => {
    const res = await fetch(asset.url, {
      headers: { Accept: "application/octet-stream", Authorization: `Bearer ${token()}`, "User-Agent": "apodictic-tauri-sync" },
    });
    if (!res.ok) throw new Error(`download ${asset.name}: ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  };

  const archivePath = path.join(VENDOR, payloadAsset.name);
  await dl(payloadAsset, archivePath);
  await dl(manifestAsset, path.join(VENDOR, "payload-manifest.json"));

  // Extract via system tar (no npm dep). Producer ships .tar.gz.
  execFileSync("tar", ["-xzf", archivePath, "-C", VENDOR], { stdio: "inherit" });
  fs.rmSync(archivePath, { force: true });

  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, "payload-manifest.json"), "utf8"));

  // Recompute hashes from the extracted bytes and verify them against the manifest's claims
  // (catches corruption/tampering in transit). The lock records the COMPUTED values.
  const distHash = hashTree(path.join(VENDOR, "dist"));
  const pluginHash = hashTree(path.join(VENDOR, "apodictic-plugin"));
  const transit = [];
  if (manifest.dist_sha256 && manifest.dist_sha256 !== distHash)
    transit.push(`dist: manifest ${manifest.dist_sha256} != downloaded ${distHash}`);
  if (manifest.plugin_sha256 && manifest.plugin_sha256 !== pluginHash)
    transit.push(`plugin: manifest ${manifest.plugin_sha256} != downloaded ${pluginHash}`);
  const sidecars = [];
  for (const { target } of manifest.sidecars || []) {
    const bin = path.join(VENDOR, "binaries", `app-sidecar-${target}`);
    const claimed = (manifest.sidecars.find((s) => s.target === target) || {}).sha256;
    if (!fs.existsSync(bin)) {
      transit.push(`sidecar ${target}: missing from payload`);
      continue;
    }
    const got = sha256File(bin);
    if (claimed && claimed !== got) transit.push(`sidecar ${target}: manifest ${claimed} != downloaded ${got}`);
    sidecars.push({ target, sha256: got });
  }
  if (transit.length) {
    console.error("✗ payload integrity check failed (manifest vs downloaded bytes):\n  - " + transit.join("\n  - "));
    process.exit(1);
  }

  const lock = {
    repo: REPO,
    tag: rel.tag_name,
    commit: await resolveCommit(rel.tag_name),
    web_version: manifest.web_version,
    plugin_version: manifest.plugin_version, // inherited from Gemini's apodictic-plugin.lock; recorded, not re-pinned
    payload_asset: payloadAsset.name,
    dist_sha256: distHash,
    plugin_sha256: pluginHash,
    sidecars,
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
