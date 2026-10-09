# Spec: desktop sidecar as official Node runtime plus server bundle

**Status:** DRAFT. Owner decisions recorded 2026-10-08 (§7); revised the same day after independent
spec review (overbuild trim). Not built.
**Date:** 2026-10-08.
**Repos:** `APODICTIC-Gemini` (producer, Increment 1) and `apodictic-tauri` (consumer, Increment 2).
**Grounded against:** `apodictic-tauri` `origin/main` f0bf2b6; `APODICTIC-Gemini` `origin/main` 38c4632.

---

## 0. One-paragraph summary

Stop packaging the desktop sidecar with `@yao-pkg/pkg`. The producer instead ships the
unmodified official Node.js binary for each target, renamed to the existing
`app-sidecar-<triple>` filename, plus the esbuild CJS server bundle as a new payload tree
`server/index.cjs`. The Tauri shell bundles `server/` as a resource and spawns
`app-sidecar <resource_dir>/server/index.cjs`. The payload transport, lock and drift-gate model,
health gate, keychain to Stronghold to DEK chain, and environment contract stay as they are; the
lock gains one tree hash for `server/`.

## 1. Current state (grounded)

- **Producer build.** `APODICTIC-Gemini/scripts/build-sidecar.mjs:72-83` bundles
  `server/index.ts` into `dist-server/index.js` (CJS, `target: node22`).
  `build-sidecar.mjs:36-41,87-104` runs `@yao-pkg/pkg` (`package.json` devDependency `6.21.0`,
  entrypoint `build-sidecar.mjs:33`) per target and renames the output into `sidecar-bin/`.
- **No native addons.** `server/db/index.ts:401-414` loads the built-in `node:sqlite` through
  `createRequire`. `better-sqlite3` is declared but unused (`server/db/index.ts:25`) and is only
  marked external (`build-sidecar.mjs:81`). The server's third-party runtime imports are
  `express`, `express-rate-limit`, `helmet`, `dotenv` and `@google/genai`.
- **Payload assembly.** `APODICTIC-Gemini/scripts/build-desktop-payload.mjs:40` lists three sidecar
  targets; `:139-142` requires them; `:160-168` stages `dist/`, `apodictic-plugin/` and
  `binaries/`; `:177-185` writes the manifest; `:198` tars the three trees.
- **Producer workflow.** `APODICTIC-Gemini/.github/workflows/release-desktop-payload.yml:28-53`
  builds and verifies the Windows sidecar on `windows-latest`; `:55-110` builds the macOS
  sidecars, downloads the Windows exe, assembles and publishes.
- **Producer CI.** `APODICTIC-Gemini/.github/workflows/ci.yml:38,96-100` builds the host
  (Linux) sidecar on `ubuntu-latest` and runs `scripts/verify-sidecar-runtime.mjs`.
- **Consumer sync and lock.** `apodictic-tauri/scripts/sync-gemini-web.mjs:94-126` verifies
  `dist/`, `apodictic-plugin/` and each `binaries/app-sidecar-*`; `:186-201` recomputes hashes;
  `:204-216` compares to the lock; `:297` lists the payload paths it clears; `:341-355` writes
  `gemini-web.lock`.
- **Consumer shell.** `apodictic-tauri/src-tauri/src/lib.rs:70-102` (`start_sidecar`) resolves
  `resource_dir` (falling back to `./public`), fetches the DEK and spawns `sidecar("app-sidecar")`
  with `APP_DATA_PATH`, `PUBLIC_RESOURCES_PATH`, `APODICTIC_RUNTIME_MODE`,
  `CREDENTIAL_ENCRYPTION_KEY` and no arguments. `src-tauri/tauri.conf.json` bundles
  `externalBin: ../vendor/gemini-web/binaries/app-sidecar` and resources `dist` and
  `apodictic-plugin`.
- **Runtime verifiers (repo-specific).** `scripts/verify-sidecar-runtime.mjs` exists in both
  repos and spawns the binary twice with no arguments. The producer additionally requires
  `dist/index.html`, sets `FRONTEND_DIST_PATH`, and checks local static responses; the consumer
  copy does not. They are not byte-identical.
- **Packaging probe.** `apodictic-tauri/scripts/verify-macos-packaging-probe.mjs:165-191` checks
  `Contents/MacOS/app-sidecar` architecture and hash and the `dist`/`apodictic-plugin` tree hashes.
  The copied-bundle fixture and tamper cases live in `scripts/tests/macos-packaging-probe.test.mjs:104-135`.
- **Consumer release.** `apodictic-tauri/.github/workflows/release-alpha.yml:64-71,115-122`
  syncs the pinned payload and runs the runtime verifier on macOS and Windows before
  `tauri build`.
- **Ignored payload paths.** `apodictic-tauri/.gitignore:15-18` lists `vendor/gemini-web/dist/`,
  `binaries/`, `apodictic-plugin/` and `payload-manifest.json`.

## 2. Design

### 2.1 Payload layout

```
dist/                                   unchanged
apodictic-plugin/                       unchanged
binaries/app-sidecar-<triple>[.exe]     official Node binary, byte-identical to nodejs.org
server/index.cjs                        esbuild CJS bundle (new tree)
server/notices/                         third-party notices (§2.2)
```

`payload-manifest.json` and `gemini-web.lock` gain `server_sha256`, the canonical
`apodictic-tree-sha256-v2` hash of `server/`, beside `dist_sha256` and `plugin_sha256`. The
consumer recomputes it from bytes like the other two. `scripts/lib/canonical-tree-hash.mjs` is
unchanged in both repos.

### 2.2 Node runtime pin and notices (producer)

A committed file `APODICTIC-Gemini/scripts/lib/node-runtime.json` holds the Node version and, per
target, the nodejs.org dist path and its SHA-256 copied from that release's `SHASUMS256.txt`:

| Target | Source file | Extracted |
|---|---|---|
| `aarch64-apple-darwin` | `node-v<V>-darwin-arm64.tar.gz` | `bin/node` |
| `x86_64-apple-darwin` | `node-v<V>-darwin-x64.tar.gz` | `bin/node` |
| `x86_64-pc-windows-msvc.exe` | `win-x64/node.exe` | the file itself |
| `x86_64-unknown-linux-gnu` | `node-v<V>-linux-x64.tar.gz` | `bin/node` (CI only) |

The build downloads each requested file, verifies its SHA-256 against the pin and exits non-zero
on a mismatch, then extracts the versioned `bin/node` member with `tar` (Windows uses the
standalone `node.exe`) into `sidecar-bin/`, preserving the Unix executable bit. Nothing is
executed, so any host can assemble every target. For Unix targets the pinned hash is the
archive's; `sidecars[].sha256` is computed from the extracted binary as today. A Node upgrade
replaces the version, paths and hashes together.

`server/notices/` holds the sidecar notices already produced by CAM-14 slice 3
(`APODICTIC-Gemini` draft #61, `docs/distribution-sidecar/THIRD-PARTY-NOTICES-sidecar.md`) and the
`LICENSE` from the pinned Node release as `node-LICENSE.txt` (D4). Both travel inside the hashed
`server/` tree.

### 2.3 Spawn contract (consumer)

`start_sidecar` passes one argument, `pub_resources_dir.join("server").join("index.cjs")`, to the
existing `sidecar("app-sidecar")` command. It also sets `NODE_OPTIONS=""` so a user's shell
setting does not change the sidecar's flags. A missing script fails at the existing health gate.
The health gate, port, redirect and kill-on-update paths are unchanged, and the process name
stays `app-sidecar`.

### 2.4 Unchanged on purpose

The esbuild options, the server source, the environment contract, the health payload, the lock
transport and authentication, the keychain chain, the capability allowlist and the updater stay
as they are. No analysis logic moves into Rust.

## 3. Increments

### Increment 1: producer (`APODICTIC-Gemini`, one PR, then a new minor tag)

Touches:

- `scripts/build-sidecar.mjs`: keep the esbuild step but write `sidecar-bin/server/index.cjs`;
  replace `runLockedPkg` and the pkg loop with the download, verify and extract flow from §2.2;
  copy the notices into `sidecar-bin/server/notices/`; update the header comment.
- `scripts/lib/node-runtime.json` (new): version plus per-target path and SHA-256.
- `scripts/build-desktop-payload.mjs`: require `sidecar-bin/server/index.cjs`; stage `server/`;
  add `server_sha256` to the manifest; add `server` to the tar list at `:198`; extend the
  staged-versus-source hash check at `:186-193` to `server/`.
- `scripts/verify-sidecar-runtime.mjs`: resolve the bundle beside the binary
  (`sidecar-bin/server/index.cjs`) and pass it as the spawn argument in both spawns, keeping the
  existing static-response checks.
- `.github/workflows/release-desktop-payload.yml`: no step change (D2); the Windows job now builds
  and verifies from the downloaded runtime.
- `package.json` / `package-lock.json`: drop `@yao-pkg/pkg`; regenerate the lockfile. Removing
  `better-sqlite3` and its inert `--external` at `build-sidecar.mjs:81` is optional cleanup (D5).
- `AGENTS.md:243`: replace "pkg'd sidecars" wording.

Release: tag a new Gemini minor version (D3). The consumer stays pinned to `v0.3.4` until
Increment 2.

### Increment 2: consumer (`apodictic-tauri`, one PR that includes the lock bump)

Touches:

- `scripts/sync-gemini-web.mjs`: add `server` to the clear list (`:297`); hash `server/` in
  `computePayloadHashes` (`:186-201`), `verifyVendoredAgainstLock` (`:94-126`) and
  `compareComputedToLock` (`:204-216`); check the manifest's `server_sha256` in transit; write
  `server_sha256` to the lock (`:341-355`).
- `gemini-web.lock`: regenerated by `npm run sync:web <new tag>`, never by hand.
- `src-tauri/tauri.conf.json`: add `"../vendor/gemini-web/server": "server"` to
  `bundle.resources`.
- `src-tauri/src/lib.rs` (`start_sidecar`, `:70-102`): `.args([script])` and
  `.env("NODE_OPTIONS", "")` per §2.3.
- `scripts/verify-sidecar-runtime.mjs`: pass `vendor/gemini-web/server/index.cjs` in both spawns,
  preserving this repo's existing verifier paths and behavior.
- `scripts/verify-macos-packaging-probe.mjs` (`:165-191`): require `Contents/Resources/server`
  and compare its tree hash to the lock's `server_sha256`.
- `scripts/tests/macos-packaging-probe.test.mjs` (`:104-135`): fixture stages `server/`; add a
  "changed server byte" case that fails without a receipt.
- `.gitignore`: add `vendor/gemini-web/server/`.
- `vendor/gemini-web/README.md`, `AGENTS.md`, `README.md`, `docs/architecture.md` §3: describe
  the new layout and drop "pkg'd binaries" wording.

## 4. Acceptance tests

1. Producer: `node scripts/build-sidecar.mjs all` on macOS, and again on Windows, yields four
   `app-sidecar-*` files identical to the binary from each verified download, plus
   `server/index.cjs` and `server/notices/`. Unix binaries remain executable.
2. Producer: a tampered pin (one hex digit changed) makes the build exit non-zero.
3. Producer CI: `npm run desktop:build:sidecar:host` and `node scripts/verify-sidecar-runtime.mjs`
   pass on `ubuntu-latest` (local, loopback-only, invalid mode fails closed).
4. Producer: the payload tar contains `server/index.cjs`; the manifest's `server_sha256` matches a
   recomputation.
5. Consumer: `npm run sync:web <tag>` writes `server_sha256` to the lock; `npm run sync:web:check`
   passes; changing one byte of `vendor/gemini-web/server/index.cjs` makes `--check` fail.
6. Consumer: `node scripts/verify-sidecar-runtime.mjs` passes on macOS and on Windows against the
   vendored payload (both are already steps in `release-alpha.yml`). Each run qualifies only its
   host target; claiming both macOS architectures requires running on Intel and Apple Silicon.
7. Consumer: `npm run packaging:probe` on a Mac produces a receipt; the copied-bundle test suite
   (`npm run test:packaging-probe`) includes and passes the new server-drift case.
8. Manual, owner, both machines: install the alpha on Mac and PC (the Windows install under
   `C:\Program Files\`, so the script path contains spaces), add a BYOK key, run one analysis,
   close and reopen, and confirm the stored credential still decrypts (proves the DEK path and
   the SQLite file at `APP_DATA_PATH` survived the runtime swap).

## 5. Alternatives considered

- **Keep `@yao-pkg/pkg`.** A single-maintainer fork that ships Node binaries it patches itself;
  its appended payload is a known trouble spot for `codesign`/notarization and antivirus
  heuristics (unverified for these binaries).
- **Node SEA.** Removes the fork but still injects into the Node binary, so macOS must re-sign and
  Windows loses the OpenJS Authenticode signature; `node --build-sea` needs Node 25.5+. Revisit
  on Node 26 or later.
- **Bun or Deno compile.** Cross-compiles nicely but runs a different runtime from the web build
  and Vitest suite; `node:sqlite` and `child_process` parity is unverified. Rejected.
- **Port the server to Rust.** About 12,200 lines of I/O-bound TypeScript shared with the web
  app, and it would break the `docs/architecture.md` §2 rule that keeps analysis logic out of the
  shell. Rejected.

## 6. Out of scope

- Developer ID signing, notarization and hardened runtime (a Node sidecar needs V8's JIT
  entitlements). Signing may change sidecar bytes, so signed artifacts are checked by signature.
- Authenticode signing of the installer.
- Moving off Node 24 (D1); Node SEA; Bun or Deno; porting server code to Rust.
- Shipping npm, corepack or any Node tooling beside the single `node` binary.
- Apple Silicon and Intel universal binaries.
- Changes to the `openapi/*.yaml` routes, which already find no files in the packaged build.

## 7. Owner decisions (recorded 2026-10-08)

- **D1. Node major: 24 LTS.** `node-runtime.json` pins a Node 24 LTS release. The esbuild
  `target` stays `node22` so the shared server bundle still runs on the web app's Node 22 runtime
  (web CI and Cloud Run) until that side moves; acceptance tests 3 and 6 run under the pinned 24.
  Check `node:sqlite` loads without a flag under the pinned release in those tests.
- **D2. Windows producer job: keep.** It keeps building and verifying on Windows, now from the
  downloaded runtime.
- **D3. Tag: approved.** Increment 1 ships as a new Gemini minor tag; the consumer stays pinned to
  `v0.3.4` until Increment 2 bumps the lock.
- **D4. Node runtime notice: planned on this path.** The Node `LICENSE` ships with the sidecar
  notices from CAM-14 slice 3 (§2.2).
- **D5. `better-sqlite3`: waived for the alpha.** It stays installed; removing it is optional
  cleanup, not part of this spec's acceptance.

## 8. Verification status of this spec

During review the producer at `38c4632` was copied to disposable scratch, its locked packages
installed, and its unchanged esbuild options used to produce `server/index.cjs`. A copy of the
producer verifier, changed only to pass that script path to its two spawns, passed against stock
Windows Node `v24.16.0` (local health, static-response checks, loopback-only exposure,
invalid-mode refusal). This is a bundle compatibility smoke test; everything in §4 remains
implementation acceptance work.
