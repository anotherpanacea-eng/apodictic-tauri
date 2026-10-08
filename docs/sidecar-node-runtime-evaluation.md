# Desktop sidecar packaging: decision memo

Date: 2026-10-08. Read against `origin/main` of `apodictic-tauri` (0dcc13f) and `APODICTIC-Gemini` (38c4632).

## Recommendation

Replace the `@yao-pkg/pkg` sidecar with the official Node.js runtime binary, shipped as the Tauri `externalBin`, plus the existing esbuild CJS bundle shipped as a Tauri resource. The Rust shell passes the bundle path as the first argument. Keep everything else (payload transport, lock, drift gate, health gate, keychain chain) as it is.

Do it before the first signed release: signing is where pkg costs the most, and the payload format change is cheapest while you are the only user.

Do not port the engine to Rust. Do not move to Bun or Deno. Revisit Node SEA once you are on Node 26 or later and the feature has settled.

## What exists today

- `APODICTIC-Gemini/scripts/build-sidecar.mjs:72-104` bundles `server/index.ts` with esbuild into one CJS file, then runs `@yao-pkg/pkg` 6.21.0 against `node22-*` base binaries, one per target.
- `APODICTIC-Gemini/.github/workflows/release-desktop-payload.yml` builds the Windows sidecar on `windows-latest` and the two macOS sidecars on `macos-latest`, then assembles the payload on the Mac job.
- `apodictic-tauri/src-tauri/src/lib.rs:88-98` spawns `app-sidecar` with four environment variables and no arguments. `tauri.conf.json` lists it under `bundle.externalBin`.
- `apodictic-tauri/gemini-web.lock` pins a per-target SHA-256 for each sidecar binary.

The server has no native addons. `better-sqlite3` is listed in `package.json` but nothing imports it (`server/db/index.ts:25`); SQLite goes through Node's built-in `node:sqlite` via `createRequire` (`server/db/index.ts:408-414`). The only third-party runtime imports are `express`, `express-rate-limit`, `helmet`, `dotenv` and `@google/genai`, all pure JavaScript. Crypto is `node:crypto` AES-256-GCM. The server also spawns external programs (Claude/Codex CLIs, `llama-server`) through `child_process`. So every option below is viable, and the choice comes down to maintenance and signing.

## Option 1: keep `@yao-pkg/pkg`

It works today, and the release pipeline already runtime-verifies each binary on its own OS. The costs are:

- **Single-maintainer fork of an abandoned tool.** Each new Node major depends on the fork publishing patched base binaries through `@yao-pkg/pkg-fetch`. The Node binary you ship is built by a third party.
- **Signing.** Tauri re-signs `externalBin` files on macOS (unverified for your config; the probe spec has not exercised Developer ID yet). pkg binaries carry an appended payload, and they have a long history of breaking or needing special handling under `codesign` and notarization (unverified for 6.21.0). Any Node-based sidecar under the hardened runtime also needs the JIT entitlements V8 uses. You will hit that with every option, but pkg adds a second unknown on top of it.
- **Windows reputation.** Executables built with pkg are a frequently reported source of antivirus false positives (unverified for your binaries). The official `node.exe` is Authenticode-signed by the OpenJS Foundation.
- **Cross-building.** The Windows build already runs on a Windows runner, so this is not a current blocker. pkg bytecode compilation generally requires running the target binary (unverified), which is why the release workflow builds per OS.
- **Size** is about one Node runtime per target in every option.

## Option 2: Node Single Executable Applications

SEA is Node's built-in way to package an app as one executable. Since Node 25.5, `node --build-sea` builds the binary without `postject`. Newer docs add a `mainFormat: "module"` setting for ESM entry points. Both details come from web search (unverified here); the copies I saw still labelled the feature as in active development.

Your CJS bundle should be compatible. Inside a SEA, `require` only loads built-in modules. The bundle has no external requires apart from `node:sqlite`, which is a built-in reached through `createRequire(__filename)`. I could not run that path in this sandbox because the npm registry was blocked, so it needs a smoke test. The bundle has to stay fully inlined. The `openapi/*.yaml` routes (`server/index.ts:173-213`) read files beside `__dirname`; those files are already absent from the pkg build, so nothing new breaks.

What it costs you: on Node 22 or 24 you still inject with `postject`. On macOS you must strip the Node signature, inject, then re-sign, and Tauri signs again at bundle time. On Windows the injected exe loses the OpenJS signature, so it is unsigned until you buy Authenticode. You also stay pinned to one-binary-per-target builds on each OS. SEA removes the third-party fork but keeps the "modified Node binary" problem that makes signing fragile.

## Option 3: official Node binary plus bundle (recommended)

Ship `node` (or `node.exe`) from nodejs.org, renamed to `app-sidecar-<triple>`, plus `server/index.cjs` as a Tauri resource. Rust adds `.args([<resource_dir>/server/index.cjs])`.

Why it is the easiest to keep running on both machines:

- **No packager.** The build becomes: download a pinned Node release, check it against the official `SHASUMS256.txt`, copy it, and run the existing esbuild step. Nothing modifies the binary.
- **Cross-target from one machine.** All three runtimes are plain downloads and the bundle is platform-neutral, so either your Mac or your PC can produce the full payload. Per-OS runtime verification still happens in `release-alpha.yml`, which already runs `verify-sidecar-runtime.mjs` on both macOS and Windows.
- **Signing is the normal case.** The Node binary is an ordinary signed Mach-O or PE file. On macOS Tauri re-signs it like any other `externalBin`. On Windows it keeps the OpenJS Authenticode signature.
- **Upgrades are a version string.** Moving to Node 24 or later is a one-line change, with no wait on a fork.
- **Auditable lock.** The sidecar hash in `gemini-web.lock` will equal a hash the Node project publishes, so anyone can check it independently.

Costs: one more payload tree (`server/`) to hash and lock, a coordinated producer and consumer format change, and a Rust change to pass the script path. Because the sidecar becomes a general-purpose Node, the Rust shell should blank `NODE_OPTIONS` so a user-level environment variable cannot inject code. pkg and SEA binaries respond to that variable as well (unverified), so this also closes an existing gap.

## Option 4: move engine work into Rust

The server is about 12,200 lines of TypeScript. It holds Express routing and auth, OAuth, BYOK credential storage (AES-GCM in SQLite), provider adapters for Anthropic, OpenAI and Gemini over HTTPS, CLI and `llama-server` process management, the actions service (`server/actions/service.ts`, 2,930 lines) and an MCP endpoint. None of it is CPU-bound. Wall-clock time goes to LLM network calls. The web app runs the same code, so any port means two implementations to keep in agreement. A port would also break the architecture invariant in `apodictic-tauri/docs/architecture.md` §2, which keeps analysis logic out of the shell. Nothing here is worth porting. The Rust shell already owns the parts that belong there: keychain, process lifecycle, health gate and updater.

## Option 5: Bun or Deno compile

Both cross-compile all targets from one host, which is attractive. Both run a different runtime from the Node server that the web build and the Vitest suite exercise. `node:sqlite` support and `child_process` details would need checking on each (unverified). You would be testing two runtimes to ship one engine. Rejected.

## Owner questions

1. Node major for the desktop runtime: keep 22 (matches CI and Cloud Run; maintenance ends April 2027) or move to 24 LTS now (quieter `node:sqlite`, longer support)?
2. Should the producer build all three targets on one Mac runner (saves Actions minutes) while Windows runtime proof stays in `apodictic-tauri`'s release and CI jobs? Or keep the Windows producer job purely as a verifier?
3. Are you willing to ship the format change as a new Gemini minor tag, so the current `v0.3.4` pin keeps working until the bump PR?

Sources for the SEA details: [Node.js SEA docs v26.3.0](https://nodejs.org/api/single-executable-applications.html), [Node.js SEA docs v26.0.0 nightly](https://nodejs.org/download/nightly/v26.0.0-nightly2026022776215dc993/docs/api/single-executable-applications.html).
