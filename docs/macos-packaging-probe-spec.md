# macOS packaging probe — specification

Status: **BUILD-READY** — implementation-review simplification folded in

## Problem and boundary

The current desktop shell can assemble a local macOS app, but that build is ad hoc and Tauri's
generated bundle still declares its default macOS 10.13 floor. We need a repeatable proof that one
Mac can package the exact pinned payload with the intended macOS 14 metadata.

This is not a release candidate. Distribution remains M0 NO-GO because application/dependency
licenses, the Brysbaert resource's redistribution permission, notices/SBOM/CVE/EOL evidence,
signing/notarization, updater custody, M2 local authority, restrictive CSP, and clean-install gates
remain unresolved. The canonical gate record is
`fleet-coordination/handoffs/CODE-MAC-APODICTIC-M0-INVENTORY-2026-07-21.md`.

## Goal

Add an explicitly invoked, credential-filtered, host-architecture macOS packaging probe. It consumes
already-staged payload bytes, verifies them offline, builds one unsigned `.app` under a unique
ignored target directory, proves the packaged payload still matches `gemini-web.lock`, and writes
a small code-safe receipt beside the quarantined output. The probe contains no transfer or
publication operation.

## Acceptance criteria

1. `npm run packaging:probe` runs only on macOS and only with
   `INTERNAL_PACKAGING_PROBE=1`. It maps the host to exactly `aarch64-apple-darwin/arm64` or
   `x86_64-apple-darwin/x86_64` and rejects every other host.
2. The probe requires a clean tracked worktree and creates a fresh random directory below
   ignored `src-tauri/target/packaging-probes/`. It sets `CARGO_TARGET_DIR` to that directory,
   rejects any pre-existing receipt there, and writes the receipt only after success.
   It `lstat`s each existing output ancestor, rejects symlinks/non-directories, resolves the target
   root, run directory, and produced app, and proves the latter two stay beneath the resolved root.
3. Child processes receive only `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`,
   `LC_ALL`, `CARGO_HOME`, `RUSTUP_HOME`, `SDKROOT`, `DEVELOPER_DIR`, `CI`, and the
   probe-owned `CARGO_TARGET_DIR`. Undefined allowlisted variables are omitted, so credential and
   sync-token variables are not forwarded. This environment filtering is not a filesystem sandbox.
4. The probe requires already-staged `vendor/gemini-web` bytes and runs
   `scripts/sync-gemini-web.mjs --check` without a token. It never fetches, updates, retags, or
   replaces the payload or lock, and fails if bytes are absent, drifted, or lack the host target.
5. The existing sidecar runtime verifier runs before packaging. It remains isolated behind its
   temporary home, synthetic DEK, and temporary app-data path.
6. A committed probe-only Tauri overlay sets only:
   `bundle.targets = ["app"]` and `bundle.macOS.minimumSystemVersion = "14.0"`.
   The base Tauri release configuration is unchanged. The build command is fixed:
   `tauri build --ci --no-sign --bundles app --target <host-triple> --config <probe-overlay>`.
   No DMG, PKG, updater artifact, cross-architecture bundle, signing identity, or arbitrary build
   argument is accepted.
7. Bundle verification checks exact observable predicates:
   - `Contents/Info.plist` has `CFBundleIdentifier = com.anotherpanacea.apodictic`,
     `CFBundleShortVersionString` and `CFBundleVersion` equal to the base
     `tauri.conf.json` version, and `LSMinimumSystemVersion = 14.0`;
   - `Contents/MacOS/apodictic-tauri` and `Contents/MacOS/app-sidecar` each contain exactly
     the host Mach-O architecture according to `lipo -archs`;
   - `Contents/Resources/dist` and `Contents/Resources/apodictic-plugin` exist;
   - the bundled sidecar SHA-256 and canonical dist/plugin tree hashes exactly match the host
     sidecar, `dist_sha256`, and `plugin_sha256` entries in `gemini-web.lock`;
   - `/usr/bin/codesign -dv --verbose=4` (whose diagnostics are read from stderr) exposes no
     `Authority=` line, reports an unsigned/ad-hoc/linker-signed signature, and reports
     TeamIdentifier either absent or exactly `not set`.
8. The canonical tree-hash implementation is extracted once from `sync-gemini-web.mjs` into a
   shared internal module and used by both the drift gate and bundle verifier. The lock upgrades to
   the domain-separated `apodictic-tree-sha256-v2` contract: SHA-256 over the entry count followed
   by sorted, byte-length-prefixed UTF-8 paths and byte-length-prefixed file contents. This framing
   is unambiguous even when file bytes contain NULs. A legacy manifest from an already-published
   payload may be checked with the old delimiter encoding only during authenticated sync; the
   committed lock and every exact-byte drift/probe claim require v2. Directories containing
   symlinks or non-regular files fail.
9. The receipt is a small fixed JSON object with `schema_version: 1` and exactly these fields:
    `probe_name`, `source_commit`, `payload_tag`, `payload_commit`, `host_os_version`,
    `target_triple`, `bundle_version`, `minimum_system_version`, `distribution_ready`,
    `developer_id_signed`, and `m0_status`.
    Required fixed values are `probe_name = UNSIGNED-NON-DISTRIBUTABLE-PACKAGING-PROBE`,
    `distribution_ready = false`, `developer_id_signed = false`, and `m0_status = NO-GO`.
10. No workflow, cache, upload, release, copy-to-shared-path, or publication command is added. The
    bundle and receipt remain under ignored target output; the script prints that exact fact.
11. Verification includes the existing payload/Rust/clippy/build/sidecar gates, one successful clean
    host probe, and checked-in macOS copied-bundle tests showing that a changed dist byte, wrong minimum
    OS, wrong expected target, and missing sidecar each fail without producing a receipt. It also
    includes the legacy two-files-versus-one-file NUL collision and hidden tracked changes under both
    assume-unchanged and skip-worktree. Direct execution of the internal verifier fails without a receipt.
12. Documentation calls the result a **packaging probe**, never an installer, release candidate,
    beta, distributable, signed build, or download, and states that no artifact was published or
    distributed.

## Implementation ownership

`scripts/run-macos-packaging-probe.mjs` is the single orchestrator and receipt writer. It accepts no
user arguments, captures the clean source commit before building, and requires the same HEAD plus a
clean tracked tree after verification before writing the receipt. `scripts/verify-macos-packaging-probe.mjs`
is an internal module that returns verified receipt facts to the orchestrator and refuses direct
execution. Both invoke argument arrays, never a shell. macOS
inspection uses canonical `/usr/bin` tools; Node uses `process.execPath`; the Tauri CLI resolves to
the real path of the repository-installed package under `node_modules`.

`src-tauri/tauri.packaging-probe.conf.json` is merged only for this probe. It is evidence of the
proposed macOS floor, not the permanent release setting. The ordinary release configuration,
moving CI Rust toolchain, Cargo MSRV, workflows, signing posture, and updater posture do not change.
The receipt records the host macOS version but makes no reproducible-build claim.

The threat model is accidental credential inheritance, stale/substituted build output, and accidental
publication from repository machinery. It does not claim to resist a malicious local account,
compromised compiler/package cache, hostile operating system, or independent filesystem watcher.

## Out of scope and closed gates

- DMG/PKG creation; retaining outside ignored local target output; uploading, publishing, sharing,
  installing, opening, or Gatekeeper-testing the app.
- GitHub Actions packaging/release work or use of any sync/signing/provider credential.
- Cross-compilation or support claims for both architectures.
- Permanent macOS-floor or hardened-runtime configuration.
- Developer ID, notarization, stapling, entitlements, updater, SBOM/notices, license/redistribution
  decisions, vulnerability waivers, and the Brysbaert inclusion/exclusion decision.
- M2 local identity, M3 validator runtime, M4/M5 providers, M6 model installation, M7 hosted-surface
  removal, M8 Google teardown, DNS, or hosted-data disposition.

## Allowed claim and promotion rule

The receipt proves only that the recorded clean source and pinned payload assembled into an
unsigned/ad-hoc host-architecture app on this builder, the packaged payload hashes still matched the
lock, the existing M1 sidecar check passed, and no artifact was published or distributed.

It does not reduce an M0/M7/M8 gate. Moving application bytes off the builder or calling an output
distributable requires a new reviewed spec after redistribution, notices/SBOM, signing/notarization,
release custody, M2, and CSP are independently cleared.
