#!/usr/bin/env node
// Writes the latest.json that installed apps read through tauri-plugin-updater. Each platform
// entry points at a release asset and carries the contents of that asset's updater .sig, which
// the app checks against the public key in tauri.conf.json before installing.
//
// Usage: node scripts/write-update-manifest.mjs --version 0.1.0-alpha.4 --assets release-assets \
//          --base-url https://github.com/<repo>/releases/download/desktop-v0.1.0-alpha.4 --out latest.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_ASSETS = {
  "darwin-aarch64": (version) => `APODICTIC-${version}-macos-aarch64.app.tar.gz`,
  "darwin-x86_64": (version) => `APODICTIC-${version}-macos-x86_64.app.tar.gz`,
  "windows-x86_64": (version) => `APODICTIC-${version}-windows-x86_64-setup.exe`,
};

export function buildUpdateManifest({ version, assetsDir, baseUrl, pubDate = new Date().toISOString() }) {
  const platforms = {};
  for (const [platform, assetName] of Object.entries(PLATFORM_ASSETS)) {
    const name = assetName(version);
    if (!fs.existsSync(path.join(assetsDir, name))) throw new Error(`missing update asset ${name}`);
    const sigPath = path.join(assetsDir, `${name}.sig`);
    if (!fs.existsSync(sigPath)) throw new Error(`missing updater signature ${name}.sig`);
    const signature = fs.readFileSync(sigPath, "utf8").trim();
    if (!signature) throw new Error(`empty updater signature ${name}.sig`);
    platforms[platform] = { signature, url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}` };
  }
  return {
    version,
    notes: `APODICTIC desktop ${version}`,
    pub_date: pubDate,
    platforms,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (flag) => {
    const index = process.argv.indexOf(flag);
    if (index === -1 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
    return process.argv[index + 1];
  };
  const manifest = buildUpdateManifest({ version: arg("--version"), assetsDir: arg("--assets"), baseUrl: arg("--base-url") });
  fs.writeFileSync(arg("--out"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`latest.json -> ${manifest.version} (${Object.keys(manifest.platforms).join(", ")})`);
}
