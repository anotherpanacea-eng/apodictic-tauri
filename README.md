# apodictic-tauri

The **desktop shell** for the APODICTIC Development Editor — a [Tauri 2](https://tauri.app)
(Rust shell + web frontend) build that wraps the `APODICTIC-Gemini` web app for local,
private, file-system-aware use.

## What this repo is (and is not)

This repo is **one client on top of a shared engine**, not the product. The editorial
intelligence — schemas, validators, passes, audits, model orchestration — lives **below**
this shell, in `apodictic` (the framework) and `APODICTIC-Gemini` (the web/API core +
sidecar). This repo owns only:

- the Tauri **Rust shell** (`src-tauri/`) and webview,
- OS-keychain-backed secret storage (Stronghold vault + credential-encryption DEK),
- the **sidecar lifecycle** (spawn the bundled Node server, health-gate, redirect the webview),
- local file / project access and the **privacy / per-send consent** surface,
- the **signed updater** and desktop packaging/signing.

If analysis logic ever lands in the Rust/JS command layer, the architecture has failed.
The test: *could a second desktop shell be swapped in without touching the engine?* Must stay **yes**.

## Vendor relationship (consumer)

This repo is a **consumer** of `APODICTIC-Gemini`. Gemini publishes a versioned **desktop
payload** (built `dist/` + per-target `app-sidecar` binaries + the apodictic-plugin) as a
release asset; this repo vendors it behind a lock + drift gate, mirroring the fleet's
`APODICTIC-Gemini → apodictic` pull/lock/drift-gate pattern.

- `gemini-web.lock` — committed; pins the consumed Gemini release + per-target payload hashes.
- `scripts/sync-gemini-web.mjs [--check]` — pulls the payload into `vendor/gemini-web/` and
  verifies hashes; `--check` is the CI **drift gate**. **Don't hand-edit the lock or the
  vendored payload — run the sync script.**
- The vendored payload bytes are **gitignored** (large binaries); only the lock is committed.

## Develop & build

> **Dev prerequisite:** in dev mode the Rust shell expects the Gemini Vite dev server at
> `http://localhost:3000` (it skips the bundled sidecar in debug builds). Run Gemini's
> `npm run dev` **separately** before `npm run desktop:dev` — this repo has no Gemini source
> to build.

```bash
# Dev (requires a running APODICTIC-Gemini dev server on :3000):
npm install
npm run desktop:dev

# Release build (macOS; pulls + verifies the vendored payload first):
npm run sync:web          # pull the pinned Gemini desktop payload into vendor/gemini-web/
npm run desktop:build     # tauri build against the vendored payload
```

**v1 is macOS-only** (the Windows sidecar cannot be cross-compiled and needs a Windows CI
runner — gated; see `docs/architecture.md` §5/§9-E).

## Fleet

`apodictic-tauri` is fleet member #5 — **consumer · private · Rust + TS**. The fleet workflow
standard (spec → review → write → review → fix → merge; merge commits, never squash; Codex 5.5
is the PR review step) lives in [`AGENTS.md`](AGENTS.md). Full architecture + migration plan:
[`docs/architecture.md`](docs/architecture.md).
