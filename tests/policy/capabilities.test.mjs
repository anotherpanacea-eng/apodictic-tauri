import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const capability = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "capabilities", "default.json"), "utf8"));
const shell = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");

// In a release build the shell redirects the window to the sidecar's page. Tauri treats that page
// as a remote origin, so the vault only works if the capability names exactly that origin
// (reproduced: "Command plugin:stronghold|initialize not allowed by ACL" on desktop 0.1.0-alpha.2).
test("the vault capability covers the page the shell loads, and nothing wider", () => {
  const redirect = shell.match(/window\.location\.replace\('([^']+)'\)/);
  assert.ok(redirect, "shell redirect to the sidecar page not found");
  const origin = new URL(redirect[1]).origin;
  assert.equal(origin, "http://127.0.0.1:3001");
  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.remote, { urls: [`${origin}/*`] });
  assert.deepEqual(capability.permissions, ["core:default", "stronghold:default", "stronghold:allow-remove-store-record"]);
});

// Installed apps verify every update against this key; a placeholder would make every update fail.
test("the updater checks the release feed with a real minisign public key", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const updater = config.plugins.updater;
  assert.deepEqual(updater.endpoints, [
    "https://github.com/anotherpanacea-eng/apodictic-tauri/releases/download/desktop-updater/latest.json",
  ]);
  assert.match(Buffer.from(updater.pubkey, "base64").toString("utf8"), /^untrusted comment: minisign public key/);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
});
