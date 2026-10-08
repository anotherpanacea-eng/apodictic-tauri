# Spec: desktop sidecar as official Node runtime plus server bundle

**Status:** DRAFT. Owner decisions D1 to D3 recorded 2026-10-08 (§7); awaiting independent spec review. Not built.
**Date:** 2026-10-08.
**Repos:** `APODICTIC-Gemini` (producer, Increment 1) and `apodictic-tauri` (consumer, Increment 2).
**Grounded against:** `apodictic-tauri` `origin/main` 0dcc13f; `APODICTIC-Gemini` `origin/main` 38c4632.
**Companion memo:** [`sidecar-node-runtime-evaluation.md`](sidecar-node-runtime-evaluation.md) (option comparison and rationale).

---

## 0. One-paragraph summary

Stop packaging the desktop sidecar with `@yao-pkg/pkg`. The producer instead ships the
unmodified official Node.js binary for each target, renamed to the existing
`app-sidecar-<triple>` filename, plus the esbuild CJS server bundle as a new payload tree
`server/index.cjs`. The Tauri shell bundles `server/` as a resource and spawns
`app-sidecar <resource_dir>/server/index.cjs`. The payload transport, lock and drift-gate model,
health gate, keychain to Stronghold to DEK chain, and environment contract stay as they are. The
payload manifest gains a layout marker so the consumer refuses a mismatched format instead of
guessing.

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
  `:204-216` compares to the lock; `:297` clears payload paths; `:341-354` writes
  `gemini-web.lock`.
- **Consumer shell.** `apodictic-tauri/src-tauri/src/lib.rs:80-98` resolves `resource_dir`,
  fetches the DEK and spawns `sidecar("app-sidecar")` with `APP_DATA_PATH`,
  `PUBLIC_RESOURCES_PATH`, `APODICTIC_RUNTIME_MODE`, `CREDENTIAL_ENCRYPTION_KEY` and no arguments.
  `src-tauri/tauri.conf.json` bundles `externalBin: ../vendor/gemini-web/binaries/app-sidecar`
  and resources `dist` and `apodictic-plugin`.
- **Runtime verifiers (repo-specific).** `scripts/verify-sidecar-runtime.mjs` exists in both
  repos and spawns the binary twice with no arguments. The producer additionally requires
  `dist/index.html`, sets `FRONTEND_DIST_PATH`, and checks local static responses; the consumer
  copy does not currently contain those checks. They are not byte-identical at these heads.
- **Packaging probe.** `apodictic-tauri/scripts/verify-macos-packaging-probe.mjs:165-189` checks
  `Contents/MacOS/app-sidecar` architecture and hash and the `dist`/`apodictic-plugin` tree hashes.
  Copied-bundle tests live in `scripts/tests/macos-packaging-probe.test.mjs:113-130`.
- **Consumer release.** `apodictic-tauri/.github/workflows/release-alpha.yml:64-71,115-122`
  syncs the pinned payload and runs the runtime verifier on macOS and Windows before
  `tauri build`.
- **Ignored payload paths.** `apodictic-tauri/.gitignore` lists `vendor/gemini-web/dist/`,
  `binaries/`, `apodictic-plugin/` and `payload-manifest.json`.

## 2. Design

### 2.1 Payload layout `node-runtime-bundle-v1`

```
dist/                                   unchanged
apodictic-plugin/                       unchanged
binaries/app-sidecar-<triple>[.exe]     official Node binary, byte-identical to nodejs.org
server/index.cjs                        esbuild CJS bundle (new tree)
```

`payload-manifest.json` gains:

- `sidecar_layout: "node-runtime-bundle-v1"`
- `node_version: "<x.y.z>"`
- `server_sha256`: canonical `apodictic-tree-sha256-v2` hash of `server/`

`gemini-web.lock` records the same three fields. The consumer recomputes `server_sha256`
from bytes; `sidecar_layout` and `node_version` are validated producer declarations, not
values derived by hashing. Require the exact layout marker and a full `24.x.y` release version
(D1), and compare the host runtime's `--version` to that declaration in the runtime verifier.
Other targets' versions are supported by the producer's reviewed download pin and binary hashes;
do not claim that the consumer executed a foreign-target runtime.
`scripts/lib/canonical-tree-hash.mjs` is unchanged in both repos.

### 2.2 Node runtime pin (producer)

A committed file `APODICTIC-Gemini/scripts/lib/node-runtime.json` holds the Node version and, per
target, the nodejs.org dist path and its SHA-256 copied from that release's `SHASUMS256.txt`:

| Target | Source file | Extracted |
|---|---|---|
| `aarch64-apple-darwin` | `node-v<V>-darwin-arm64.tar.gz` | `bin/node` |
| `x86_64-apple-darwin` | `node-v<V>-darwin-x64.tar.gz` | `bin/node` |
| `x86_64-pc-windows-msvc.exe` | `win-x64/node.exe` | the file itself |
| `x86_64-unknown-linux-gnu` | `node-v<V>-linux-x64.tar.gz` | `bin/node` (CI only) |

The build downloads every requested file into temporary staging, verifies all download hashes,
then extracts the exact versioned `bin/node` member with `tar` (Windows uses the standalone
`node.exe`). Preserve executable permissions for Unix binaries. Only after every requested
download verifies does it write the bundle and runtimes to `sidecar-bin/`; a download/hash failure must not
replace an existing output. Any host can assemble every target without executing foreign binaries.

For Unix targets the published checksum is the **archive** hash, not the extracted binary hash.
`sidecars[].sha256` is computed from the extracted binary and separately checked through staging,
sync and bundling. Only the Windows standalone binary's hash directly equals its published
`win-x64/node.exe` checksum. Node upgrades replace the version, download paths and all download
hashes together; they are not a one-line pin update.

Ship the full `LICENSE` file from that exact Node release, including its bundled third-party
notices, under `server/notices/node-LICENSE.txt`. For standalone Windows downloads fetch the
same release's license as well. Retain applicable notices for the esbuild-inlined npm packages
under `server/notices/`; esbuild's legal-comment output alone is not a complete notice inventory.
This directory travels inside the existing hashed `server/` resource tree. See the official
[Node license](https://github.com/nodejs/node/blob/v24.10.0/LICENSE) and
[checksum list](https://nodejs.org/dist/v24.10.0/SHASUMS256.txt) for examples, not the final pin.

### 2.3 Spawn contract (consumer)

`start_sidecar` resolves `<resource_dir>/server/index.cjs` and fails with a startup error if it
is missing or is not a regular file. Resource-directory resolution must return an error rather
than using the existing `./public` fallback for this executable script. It passes the absolute
path as one argument (including when it contains spaces) and adds `NODE_OPTIONS=""` to the existing
four environment variables, so a user-level `NODE_OPTIONS` cannot preload code into the engine.
The health gate, port, redirect and kill-on-update paths are unchanged. The process name stays
`app-sidecar`.

### 2.4 Unchanged on purpose

The esbuild options, the server source, the environment contract, the health payload, the lock
transport and authentication, the keychain chain, the capability allowlist and the updater stay
as they are. No analysis logic moves into Rust.

## 3. Increments

### Increment 1: producer (`APODICTIC-Gemini`, one PR, then a new minor tag)

Touches:

- `scripts/build-sidecar.mjs`: keep the esbuild step but write `sidecar-bin/server/index.cjs`;
  replace `runLockedPkg` and the pkg loop with the download, verify and copy flow from §2.2;
  update the header comment.
- `scripts/lib/node-runtime.json` (new): version plus per-target path and SHA-256.
- `scripts/build-desktop-payload.mjs`: require `sidecar-bin/server/index.cjs`; stage `server/`;
  add `sidecar_layout`, `node_version`, `server_sha256` to the manifest; add `server` to the tar
  list at `:198`; extend the staged-versus-source hash check at `:186-193` to `server/`.
- `scripts/verify-sidecar-runtime.mjs`: resolve the bundle beside the binary
  (`sidecar-bin/server/index.cjs` or `vendor/gemini-web/server/index.cjs`) and pass it as the
  spawn argument in both spawns; verify host `--version` against the declared pin first.
  Preserve its existing static-response checks. The producer switches in Increment 1;
  the repo-specific legacy consumer verifier remains unchanged until Increment 2.
- `.github/workflows/release-desktop-payload.yml`: the Windows job keeps building and verifying,
  now via the downloaded runtime (no step change beyond D2).
- `package.json` / `package-lock.json`: drop `@yao-pkg/pkg` and `better-sqlite3`; regenerate the
  lockfile. Remove `--external:better-sqlite3` from `build-sidecar.mjs:81`.
- `AGENTS.md` (`:192-194`, `:243-244`): replace "pkg'd sidecars" wording.

Consumes: `server/index.ts`, the locked esbuild dependencies and the reviewed Node 24 download
pin. Produces: `sidecar-bin/server/{index.cjs,notices/}`, per-target `app-sidecar-*`, and the
release tar plus manifest with the three new fields from §2.1. Increment 2 consumes this exact
layout; the existing consumer continues reading its older pinned release meanwhile.

Release: tag a new Gemini minor version. The consumer stays pinned to `v0.3.4` until Increment 2.

### Increment 2: consumer (`apodictic-tauri`, one PR that includes the lock bump)

Touches:

- `scripts/sync-gemini-web.mjs`: require `manifest.sidecar_layout === "node-runtime-bundle-v1"`
  on sync; add `server` to the clear list (`:297`); hash `server/` in `computePayloadHashes`
  (`:186-201`), `verifyVendoredAgainstLock` (`:94-126`) and `compareComputedToLock`
  (`:204-216`); check the manifest's `server_sha256` in transit; write `sidecar_layout`,
  `node_version` and `server_sha256` to the lock (`:341-354`); `--check` fails when the lock
  lacks them.
- `gemini-web.lock`: regenerated by `npm run sync:web <new tag>`, never by hand.
- `src-tauri/tauri.conf.json`: add `"../vendor/gemini-web/server": "server"` to
  `bundle.resources`.
- `src-tauri/src/lib.rs` (`start_sidecar`, `:76-98`): resolve the script path, fail closed when
  absent, `.args([script])`, `.env("NODE_OPTIONS", "")`. Add a unit test only if the path
  resolution is factored into a pure function that protects the fail-closed behavior.
- `scripts/verify-sidecar-runtime.mjs`: update both spawns and host-version verification as
  in Increment 1, preserving this repo's existing verifier paths and behavior.
- `scripts/verify-macos-packaging-probe.mjs` (`:165-189`): require
  `Contents/Resources/server` and compare its tree hash to the lock's `server_sha256`.
- `scripts/tests/macos-packaging-probe.test.mjs`: fixture stages `server/`; add a
  "changed server byte" case that fails without a receipt.
- `.gitignore`: add `vendor/gemini-web/server/`.
- `vendor/gemini-web/README.md`, `AGENTS.md`, `README.md`, `docs/architecture.md` §3: describe
  the new layout and drop "pkg'd binaries" wording.

Consumes: the Increment 1 tagged payload and manifest. Produces: the generated lock, vendored
`server/` tree and a shell that supplies its absolute entrypoint path. The server resource hash
includes the notice files. Runtime verification covers only the executing host target; Intel
and Apple Silicon macOS qualification each requires that corresponding host.

### Increment 3: dropped by D2

The owner chose to keep the Windows producer job (D2), so this increment is not built. The text
below is kept as the option it would have been.


`APODICTIC-Gemini/.github/workflows/release-desktop-payload.yml`: build all targets on the macOS
job, and either delete the Windows job or keep it as a verify-only job that downloads the
assembled payload. Windows runtime proof remains in `apodictic-tauri` `release-alpha.yml:121-122`.

## 4. Acceptance tests

1. Producer: `node scripts/build-sidecar.mjs all` on one macOS host, and again on one Windows
   host, yields four `app-sidecar-*` files identical to the binary from each verified download
   (archive hashes are checked before extraction), plus an identical `server/index.cjs` on both
   hosts and complete Node/npm notice files in the payload. Unix binaries remain executable.
2. Producer: a tampered pin (one hex digit changed) makes the build exit non-zero before any file
   is written to `sidecar-bin/`.
3. Producer CI: `npm run desktop:build:sidecar:host` and `node scripts/verify-sidecar-runtime.mjs`
   pass on `ubuntu-latest` (local, loopback-only, invalid mode fails closed).
4. Producer: the payload tar contains `server/index.cjs`; the manifest has the three new fields
   and `server_sha256` matches a recomputation.
5. Consumer: `npm run sync:web <tag>` writes the new lock fields; `npm run sync:web:check` passes;
   changing one byte of `vendor/gemini-web/server/index.cjs` makes `--check` fail.
6. Consumer: syncing a release whose manifest lacks `sidecar_layout` fails with a clear message.
7. Consumer: `node scripts/verify-sidecar-runtime.mjs` passes on macOS and on Windows against the
   vendored payload (both are already steps in `release-alpha.yml`), including exact host
   `--version` agreement. The current macOS runner verifies only its own architecture, so run on
   both Intel and Apple Silicon before claiming all three shipped targets are runtime-qualified.
8. Consumer: `npm run packaging:probe` on a Mac produces a receipt; the copied-bundle test suite
   (`npm run test:packaging-probe`) includes and passes the new server-drift case.
9. Manual, owner, both machines: install the alpha on Mac and PC, add a BYOK key, run one
   analysis, close and reopen, and confirm the stored credential still decrypts (proves the DEK
   path and the SQLite file at `APP_DATA_PATH` survived the runtime swap).
10. Manual: with `NODE_OPTIONS=--require /tmp/x.js` set in the user's shell, the packaged app
    starts and `/tmp/x.js` is not executed.
11. Consumer startup: missing/non-file entrypoint and resource-resolution failure stop before
    spawn; an installed path containing spaces runs correctly. Closing and updating the app
    stop the same child process; no new shell or intermediate launcher owns its lifecycle.

## 5. Rollback

Revert the Increment 2 PR. That restores the `v0.3.4` lock, the old sync script and the old spawn
call, and the old payload remains published. Increment 1 can stay merged because no consumer
reads the new tag until Increment 2. If Increment 1 itself must be undone, revert it; the
`@yao-pkg/pkg` path returns with its lockfile entries.

## 6. Out of scope

- Developer ID signing, notarization and hardened-runtime entitlements. Note for that future spec:
  any Node-based sidecar under the hardened runtime needs V8's JIT entitlements
  (`com.apple.security.cs.allow-jit`, likely also `allow-unsigned-executable-memory`; unverified),
  applied to `app-sidecar`.
  Download/payload hashes describe bytes before signing. If Tauri signs the macOS sidecar,
  its resulting bytes can change; signing qualification must verify the resulting code signature
  and must not compare that signed artifact directly to the original Node/payload hash. The
  current packaging probe's raw sidecar-hash comparison therefore needs native qualification
  with official Node before acceptance test 8 can be claimed. This spec does not claim signed
  distribution readiness.
- Authenticode signing of the installer.
- Moving off Node 24 (D1); Node SEA; Bun or Deno; porting server code to Rust.
- Shipping npm, corepack or any Node tooling beside the single `node` binary.
- Apple Silicon and Intel universal binaries.
- Changes to the `openapi/*.yaml` routes, which already find no files in the packaged build.

## 7. Owner decisions (recorded 2026-10-08)

- **D1. Node major: 24 LTS.** `node-runtime.json` pins a Node 24 LTS release. The esbuild
  `target` stays `node22` so the shared server bundle still runs on the web app's Node 22 runtime
  (web CI and Cloud Run) until that side moves; acceptance tests 3 and 7 run under the pinned 24.
  Check `node:sqlite` loads without a flag under the pinned release in those tests.
- **D2. Windows producer job: keep.** It keeps building and verifying on Windows, now from the
  downloaded runtime. Increment 3 is dropped.
- **D3. Tag: approved.** Increment 1 ships as a new Gemini minor tag; the consumer stays pinned to
  `v0.3.4` until Increment 2 bumps the lock.

## 8. Verification status of this spec

The drafting sandbox could not reach npm. During review, the producer at `38c4632` was copied
to disposable scratch, its locked packages installed, and its unchanged esbuild options used
to produce `server/index.cjs`. The frontend built with `npm run build`. A copy of the existing
producer verifier, adapted only to pass that script path to its two spawns, passed against
stock Windows Node `v24.16.0`: local health, static-response security checks, loopback-only
exposure and invalid-mode refusal. This is a bundle compatibility smoke test; the new pin,
download/notice assembly, payload sync, native Tauri packaging, macOS architectures, signing,
credential reopen and updater behavior remain acceptance work for the implementation.
