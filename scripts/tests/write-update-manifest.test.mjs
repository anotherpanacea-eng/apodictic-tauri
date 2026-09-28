import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildUpdateManifest, PLATFORM_ASSETS } from "../write-update-manifest.mjs";

const version = "0.1.0-alpha.4";
const baseUrl = "https://github.com/anotherpanacea-eng/apodictic-tauri/releases/download/desktop-v0.1.0-alpha.4";

function assets(t, { skipSig } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "update-manifest-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [platform, name] of Object.entries(PLATFORM_ASSETS)) {
    fs.writeFileSync(path.join(directory, name(version)), "bundle\n");
    if (platform !== skipSig) fs.writeFileSync(path.join(directory, `${name(version)}.sig`), `sig-${platform}\n`);
  }
  return directory;
}

// Shape per tauri-plugin-updater's static JSON format: version, pub_date and one
// { signature, url } entry per `<os>-<arch>` key the app looks up at runtime.
test("each platform gets its release asset URL and signature", (t) => {
  const manifest = buildUpdateManifest({ version, assetsDir: assets(t), baseUrl, pubDate: "2026-09-28T00:00:00.000Z" });
  assert.equal(manifest.version, version);
  assert.equal(manifest.pub_date, "2026-09-28T00:00:00.000Z");
  assert.deepEqual(manifest.platforms, {
    "darwin-aarch64": { signature: "sig-darwin-aarch64", url: `${baseUrl}/APODICTIC-${version}-macos-aarch64.app.tar.gz` },
    "darwin-x86_64": { signature: "sig-darwin-x86_64", url: `${baseUrl}/APODICTIC-${version}-macos-x86_64.app.tar.gz` },
    "windows-x86_64": { signature: "sig-windows-x86_64", url: `${baseUrl}/APODICTIC-${version}-windows-x86_64-setup.exe` },
  });
});

test("a missing signature stops the release instead of shipping an unverifiable update", (t) => {
  assert.throws(
    () => buildUpdateManifest({ version, assetsDir: assets(t, { skipSig: "windows-x86_64" }), baseUrl }),
    /missing updater signature APODICTIC-0\.1\.0-alpha\.4-windows-x86_64-setup\.exe\.sig/,
  );
});
