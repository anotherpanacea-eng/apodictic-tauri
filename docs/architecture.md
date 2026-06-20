# Spec — apodictic-tauri: architecture & extraction

**Status:** DECISION-COMPLETE for the extraction + vendor boundary; provider/local-LLM is a phased roadmap.
**Date:** 2026-06-19. **Author:** Opus (Code-Mac).
**Spec review:** independent subagent, 2026-06-19 — initial verdict NEEDS-REVISION (3 blocking: B1 release-asset
vs tarball transport, B2 Gemini has no release pipeline + Windows-sidecar gap, B3 dev-mode contradiction);
all folded into §3/§5/§9 as decided design. Re-derived verdict: **CLEAR-TO-BUILD** for Increment 1.
**Repo:** [`anotherpanacea-eng/apodictic-tauri`](https://github.com/anotherpanacea-eng/apodictic-tauri) (private).
**Authoritative copy:** this in-repo file (`docs/architecture.md`) is authoritative; the fleet hub
(`Cowork/repo-fleet/specs/apodictic-tauri-architecture.md`) carries a pointer (per the fleet "authoritative
spec in-repo, pointer in hub" pattern).

---

## 0. One-paragraph summary

Extract the existing, working Tauri desktop build out of `APODICTIC-Gemini` into its own fleet repo,
`apodictic-tauri`, so the desktop shell can develop independently of the web app. The desktop app is **one
client on top of a shared engine**, not the product. `APODICTIC-Gemini` stays the web/API core and becomes
the **producer** of a versioned *desktop payload* (built frontend + Node sidecar binaries + the
apodictic-plugin); `apodictic-tauri` is a **consumer** that vendors that payload behind a lock + drift gate
— the same pull/lock/drift-gate pattern as `APODICTIC-Gemini → apodictic` and `SETEC → consumers`. The
Tauri repo owns only the Rust shell, OS-keychain/Stronghold security, sidecar lifecycle, local-file/privacy
surface, and the signed updater. The provider abstraction (incl. local-LLM backends) lives in the **shared
engine (the sidecar/server)**, never in the Tauri command layer.

---

## 1. Current state (grounded, as of `APODICTIC-Gemini` HEAD 2026-06-19)

There is already a real, coupled Tauri 2 build living inside `APODICTIC-Gemini`. This is an **extraction**,
not a greenfield scaffold.

- **Rust shell** (`src-tauri/`): `productName` APODICTIC, identifier `com.anotherpanacea.apodictic`, v0.1.0.
  `src/lib.rs` does meaningful work:
  - OS-Keychain-backed secrets (`keyring` crate): a 32-byte Stronghold vault key + a
    `CREDENTIAL_ENCRYPTION_KEY` DEK, generated on first run and stored in the OS keychain.
  - `tauri-plugin-stronghold` for encrypted secret storage, password bridged from the keychain.
  - **Spawns a Node sidecar** (`app-sidecar`, an `externalBin`) with env `APP_DATA_PATH`,
    `PUBLIC_RESOURCES_PATH`, `CREDENTIAL_ENCRYPTION_KEY`; **health-gates** on `http://127.0.0.1:3001/api/health`
    (≤30s) then **redirects the webview** to `http://127.0.0.1:3001`. Dev mode relies on the Vite server at :3000.
  - `get_vault_password` + `open_browser` bridge commands.
- **Build coupling** (`tauri.conf.json` + `package.json`): `frontendDist: ../dist`,
  `beforeBuildCommand: npm run build`, `beforeDevCommand: npm run dev`,
  `externalBin: binaries/app-sidecar` (per target: `aarch64-apple-darwin`, `x86_64-apple-darwin`,
  `x86_64-pc-windows-msvc`), `resources: { ../public/apodictic-plugin, ../dist }`. The sidecar is built from
  Gemini's `server/` via `scripts/build-sidecar.mjs` (esbuild + `@yao-pkg/pkg`, node22). Docs in
  `docs/windows-desktop.md`.
- **The sidecar IS the Express server** (`server/index.ts`), already Tauri-aware (`server/core/paths.ts`
  reads `APP_DATA_PATH`/`PUBLIC_RESOURCES_PATH`).

**Implication:** moving `src-tauri/` alone does not separate the app — its three build inputs (`dist/`, the
sidecar from `server/`, `public/apodictic-plugin/`) all originate in Gemini. The clean cut is a **versioned
desktop payload published by Gemini and vendored by the Tauri repo.**

---

## 2. Target architecture (layers; who owns what)

```
                deterministic substrate          (no model — schemas, validators, exporters,
                  (in apodictic, vendored          SETEC Layer A variance/AI-prose). Fully local.
                   into Gemini today)
                          │
            ┌─────────────┴──────────────┐
            │   shared engine / runner    │   ← APODICTIC-Gemini owns this (server/ = the sidecar)
            │   + model-provider iface    │     • model orchestration  • provider abstraction
            └─────────────┬──────────────┘     • findings + evidence anchoring  (the Firewall)
                          │
        ┌─────────────────┴──────────────────┐
        │                                     │
   apodictic-web                        apodictic-tauri          ← THIS repo (desktop shell only)
   (browser UI, in Gemini)              • Rust shell + webview
                                        • OS keychain / Stronghold
                                        • sidecar lifecycle + health gate
                                        • local file / project access
                                        • privacy / per-send consent gate
                                        • signed updater
                                        vendors Gemini's built payload.
```

**Invariant (the whole point of the split):** the rules, schemas, validators, output formats, and model
orchestration live **below both clients**. Tauri must stay *replaceable* — if any analysis logic ends up in
the Rust/JS command layer, the split has failed. Test: "could a second desktop shell be swapped in without
touching the engine?" Must remain *yes*.

### Ownership table

| Concern | Owner | Notes |
|---|---|---|
| Schemas, validators, passes/audits | `apodictic` | unchanged; vendored into Gemini today |
| Web frontend (React/Vite) source | `APODICTIC-Gemini` | unchanged |
| Server / sidecar source (`server/`) | `APODICTIC-Gemini` | this is the shared runner/API; **stays** |
| Model-provider interface + local-LLM adapters | `APODICTIC-Gemini` (`server/`) | **NOT** the Tauri shell |
| **Desktop-payload publish** (dist + sidecar bins + plugin) | `APODICTIC-Gemini` | **new producer step** |
| Rust shell, keychain/Stronghold, sidecar lifecycle, updater, local-file/consent | `apodictic-tauri` | extracted from Gemini |
| Vendoring + lock + drift gate of the payload | `apodictic-tauri` | mirrors Gemini→apodictic |

---

## 3. The vendor/consumer boundary (decided — revised post spec-review B1/S1/S2/S3)

Same *shape* as the existing fleet pattern (lock + `--check` drift gate + scheduled bump-PR workflow), but
**a different transport**, and this difference is the crux. `APODICTIC-Gemini`'s `sync-plugin.mjs` pulls a
**git tarball of a tag** and vendors *committed source* (`public/apodictic-plugin/` is git-tracked). The
desktop payload's two biggest inputs — `dist/` and `src-tauri/binaries/` — are **gitignored build
artifacts** (not in the tree at any tag), so a tarball pull cannot retrieve them. **The consumer must pull
GitHub _release assets_** (`/releases/.../assets`), not a tarball. Do **not** literally mirror
`sync-plugin.mjs`; it has no release-asset path.

- **Producer (`APODICTIC-Gemini`):** a tagged release builds and uploads a **desktop-payload archive** as a
  release asset (e.g. `desktop-payload-<version>.tar.zst`) containing: `dist/` (built frontend) +
  per-target `app-sidecar` binaries + `apodictic-plugin/`, plus `payload-manifest.json`
  (`{ web_version, plugin_version, per-target sidecar entries with sha256, dist_sha256, plugin_sha256 }`).
  **This producer pipeline does not exist yet — see §5 Increment 2.**
- **Consumer (`apodictic-tauri`):**
  - `gemini-web.lock` — `{ repo, tag, commit, web_version, plugin_version, payload_asset,
    dist_sha256, plugin_sha256, sidecars: [{ target, sha256 }], status, source }`. **Per-component
    hashes, no separate archive `payload_sha256`** (reconciled w/ the implementation, S4):
    `dist_sha256`/`plugin_sha256` are **canonical tree hashes** — files in sorted POSIX-relative-path
    order, each contributing `path\0<bytes>\0` to a single sha256 (`hashTree` in
    `scripts/sync-gemini-web.mjs`; the producer's `payload-manifest.json` MUST match). Per-target
    sidecar hashes (S2) so a single missing/corrupt arch is detectable. `--check` **recomputes** these
    from the bytes on disk (it does not trust the manifest's self-reported values — S3). `commit` is
    the **resolved tag SHA** (not `target_commitish`, which is often a branch name).
  - `plugin_version` in the payload **inherits** Gemini's own `apodictic-plugin.lock` pin — Gemini is the
    single source of truth for which plugin version ships; the Tauri lock records it for visibility but does
    not independently re-pin it (S2, avoid a double source of truth).
  - `scripts/sync-gemini-web.mjs` — resolves the latest (or named) Gemini **release**, downloads the
    payload asset into `vendor/gemini-web/`, verifies every hash against `payload-manifest.json`, records
    `gemini-web.lock`; `--check` exits non-zero if the lock is behind the latest release **or** any vendored
    hash ≠ the lock (the **drift gate**). Compares the resolved **commit**, not just the tag (preserves
    `sync-plugin.mjs:154-159`'s re-pointed-tag protection).
  - `.github/workflows/sync-gemini-web.yml` — scheduled weekly + `workflow_dispatch`; runs the sync and
    opens a bump PR. **Auth (S5):** Gemini is **private**, so the default `secrets.GITHUB_TOKEN` (current-repo
    scope only) **cannot** read its release assets — this workflow needs a **PAT or GitHub App token** with
    cross-repo read on `APODICTIC-Gemini`, stored as a repo secret. This is a real difference from
    `sync-apodictic-plugin.yml` (which reads the *public* apodictic repo).
  - `tauri.conf.json` re-points: `frontendDist → vendor/gemini-web/dist`,
    `externalBin → vendor/gemini-web/binaries/app-sidecar`,
    `resources → { vendor/gemini-web/apodictic-plugin, vendor/gemini-web/dist }`. **Drop
    `beforeBuildCommand`** (no Gemini source to build); `frontendDist` resolving to the vendored `dist/` is
    **mandatory** for `tauri build` — there is no fallback build path. **Dev-mode (`beforeDevCommand`/`devUrl`)
    is resolved in §9-C below, promoted to decided design.**

**Runtime note (S1):** in a *packaged* build the shell redirects the webview to the sidecar at `:3001`
(`lib.rs:142`) and the **sidecar** serves the SPA via `express.static` from `PUBLIC_RESOURCES_PATH/dist`
(`server/index.ts:203,210`). So `dist/` is served *through* the sidecar's resource dir at runtime;
`frontendDist` is still required for bundling + the brief pre-redirect window. Vendor `dist/` **once** and
point both `frontendDist` and the `resources` plugin/dist entry at the same vendored copy — don't
double-bundle.

**Sidecar vendoring (decided — was §9-A):** vendor Gemini's **pre-built** per-target sidecar binaries
(Gemini already builds them via `build-sidecar.mjs`). Caveat (S3): on macOS the sidecar binary is **signed +
notarized downstream at `tauri build` time in _this_ repo**, so the shipped bytes ≠ the vendored bytes; the
per-component/per-target hashes therefore attest the **unsigned input** only, and a verification checkbox
is needed that Gatekeeper accepts a notarized outer app spawning the separately-signed `externalBin`
(§7, §8). Vendoring server *source* + building the sidecar in Tauri CI is rejected — it re-introduces the
build dependency the split is meant to remove.

---

## 4. Provider model + local-LLM (forward roadmap — not in the extraction increment)

Per the reviewed GPT advice + the fleet corrections. **The provider abstraction lives in the shared engine
(`server/`), not in `apodictic-tauri`.** Both web and desktop get local-LLM support, or the divergence
problem returns.

**Four tiers (not three):**
1. **Deterministic substrate** — zero model, fully local, shippable today (SETEC Layer A variance/AI-prose,
   validators, exporters, continuity arithmetic, structure maps). The strongest privacy tier; lead with it.
2. **Local LLM** — OpenAI-compatible endpoint first (one adapter covers Ollama / LM Studio / llama.cpp);
   detect user-installed runtimes (**Option A**, not bundling a runtime — **Option B**).
3. **Hybrid (sweet spot)** — local finds, user escalates chosen **finding-packets** to cloud. The escalation
   unit already exists: an apodictic **finding** (`F-<ORIGIN>-<NN>` + evidence spans).
4. **Cloud frontier** — **Anthropic-native adapter** (fleet default = most-capable Claude) for deep
   developmental judgment.

**Reuse, don't build:**
- Provider capability descriptor (`supports_json_schema`, `max_context_tokens`, `privacy_mode`, …) — a
  **separate** registry from apodictic's audit/surface capabilities; don't conflate.
- "Weak provider on a high-stakes pass → abstain / downgrade confidence" = the SETEC/ArgScope
  `calibration_status` ladder + abstention gates (voicewright `narrative.py` precedent).
- Per-model eval before claiming parity = `validation_harness` + fixtures; each local model is a calibration target.
- **"LLM proposes, validator disposes"** is *already* apodictic's Firewall — the 48 validators run on
  artifacts, provider-agnostic, so local-model output hits the same gate. Add a schema-repair/retry loop at
  the local-provider boundary; a validator-rejected local result abstains or escalates, never silently passes.

**Privacy product claim:** *"APODICTIC runs private first-pass analysis locally, then escalates only the
evidence packets you choose to a stronger model"* — not "runs locally and is just as good."

---

## 5. Migration plan (safe sequencing)

Order matters: **never break Gemini's desktop build before the new repo builds.**

- **Increment 0 — Spec + spec review.** This doc. (docs-only, no PR.)
- **Increment 1 — Stand up `apodictic-tauri` skeleton (additive, non-destructive).**
  Clone; fleet files (`AGENTS.md`, `CLAUDE.md`, `README.md`, `.gitignore`, CI, in-repo `docs/architecture.md`);
  vendor scaffolding (`gemini-web.lock` placeholder, `scripts/sync-gemini-web.mjs`, drift gate,
  `sync-gemini-web.yml`, `vendor/gemini-web/` layout). No Gemini changes.
- **Increment 2 — Gemini producer pipeline (additive, but larger than it sounds — B2).** Gemini has **no
  release pipeline today** (its only workflow is the *consumer* `sync-apodictic-plugin.yml`); this increment
  **creates Gemini's first `v*` tagged-release workflow** that builds `dist`, builds the sidecars, assembles
  the payload archive + `payload-manifest.json`, and uploads it as a release asset. **Windows constraint:**
  the Windows sidecar has **never been built and cannot be cross-compiled** (`windows-desktop.md:50`, only
  the two macOS arches exist on disk), so a complete tri-target payload needs a **Windows CI runner that
  does not exist yet**. **Decision: v1 payload is macOS-only** (`aarch64`+`x86_64-apple-darwin`); Windows is
  gated behind standing up a Windows runner (tracked, not blocking the macOS path). Gemini's existing local
  desktop build keeps working throughout. *Code change → Codex gate.*
- **Increment 3 — Extract the shell into `apodictic-tauri`.** Copy `src-tauri/` (rename the Cargo crate off
  the generic `app` — N2) + desktop scripts + `windows-desktop.md`; re-point `tauri.conf.json` at
  `vendor/gemini-web/`; vendor a real (macOS) payload; **prove a local macOS `tauri build`** (the proof is
  macOS-only per the Windows constraint above — S4). Re-verify the keychain→Stronghold→DEK chain survives
  (§8) and that `capabilities/default.json` still authorizes the shell usage `lib.rs`/the sidecar actually
  make (N4 — the allowlist currently looks thinner than the code's shell use). *Code change → review + CI.*
- **Increment 4 — Gemini removal (destructive, LAST).** Remove `src-tauri/`, `desktop:*` scripts, Tauri
  deps, `windows-desktop.md` from Gemini once the Tauri repo builds. *Code change → Codex gate; do NOT merge
  until Tauri proves out + operator says so.*

**This turn delivers Increment 0 + Increment 1** (and as much of the scaffolding as is verifiable without a
Rust/Tauri toolchain). Increments 2–4 follow as their own gated PRs.

---

## 6. Fleet-repo setup (`apodictic-tauri` becomes fleet member #5)

- **Role:** consumer · private · Rust + TS. Fleet grows from four repos to five.
- **`AGENTS.md`** — the fleet workflow standard (spec→review→write→review→fix→merge; **merge commits, never
  squash**; Codex 5.5 is the PR review step, don't merge out from under it; version bumps at merge), plus a
  cross-repo context block naming its dependency contract: *consumes `APODICTIC-Gemini` desktop payload via
  `gemini-web.lock`, drift-gated by `sync-gemini-web.mjs --check`; don't hand-edit the lock or vendored
  payload — run the sync script.* Note `protect-public-only` ⇒ this private repo needs no branch protection.
- **`CLAUDE.md`** — thin pointer to `AGENTS.md` (fleet convention).
- **`README.md`** — what the app is, how to dev/build, the vendor relationship.
- **CI** — Rust build/clippy + the `sync-gemini-web.mjs --check` drift gate + `tauri build` smoke (where a
  runner is available). Mirror the green-on-Linux posture; gate `tauri build` to the matrix that can run it.

---

## 7. Signing / notarization / updater (new release-eng ground)

No other fleet repo ships a signed desktop binary — this is genuinely new and is the real new cost GPT
flagged. Plan early:
- **macOS:** Apple Developer ID app + installer signing + notarization (hardened runtime). Needs the
  operator's Developer ID cert in CI secrets.
- **Windows:** Authenticode cert (the existing `windows-desktop.md` already notes this).
- **Updater:** Tauri's updater requires **signed** update artifacts + an update manifest endpoint + a
  signing keypair. Decide the endpoint (GitHub Releases-backed is simplest for a private app) before
  shipping v1. Until then, manual install/update is acceptable.

---

## 8. Security & privacy notes (carry forward, don't regress in extraction)

- The keychain → Stronghold DEK chain and the sidecar `CREDENTIAL_ENCRYPTION_KEY` flow must survive the
  extraction byte-for-byte (these are the local-credential security guarantees). Re-verify on first build.
- The Tauri capability allowlist (`src-tauri/capabilities/default.json`) is the permission boundary — review
  it on extraction; keep it minimal.
- The privacy/consent gate (manuscript text only leaves the machine on explicit per-send action) is a
  **product** guarantee enforced at the model-API boundary in the engine, surfaced in the Tauri UI. Local
  storage + local project state are owned by the shell.

---

## 9. Decisions

**Decided (post spec-review):**
- **A. Sidecar vendoring** → pre-built per-target binaries, macOS-only for v1. Settled in §3.
- **C. Dev-mode source** → `desktop:dev` keeps `devUrl: http://localhost:3000` and the developer runs
  Gemini's `npm run dev` **separately** (the Tauri repo has no Gemini source to build, and `lib.rs` debug
  mode already skips the sidecar and expects Vite at :3000 — `lib.rs:43-46`). **`beforeDevCommand` is
  dropped**, and the README/AGENTS must state the "run Gemini dev server first" prerequisite explicitly so
  `tauri dev` isn't pointed at a dead `:3000`. The vendored payload is for `tauri build` only. This resolves
  the §3-vs-§9 contradiction the spec review (B3) flagged.

**Still open (for the operator — do not block the extraction):**
- **B. Updater endpoint + signing identities:** GitHub-Releases-backed updater vs. self-hosted; provide the
  Apple Developer ID (+ later Windows Authenticode) certs when ready. *Blocks a shippable signed v1, not the
  extraction or the macOS dev/build.*
- **E. Windows target:** stand up a Windows CI runner to build/sign the Windows sidecar + installer. *Gated;
  v1 payload is macOS-only until then (§5 Increment 2).*
- **D. SETEC local path:** the apodictic-plugin is already bundled. A local SETEC path (for the deterministic
  substrate tier offline) is future, via the provider/substrate tiering — out of scope for the extraction.

---

## 10. Tracking

- Fleet board: `repo-fleet/TODO.md` → "Deferred product follow-ups" Tauri entry (updated 2026-06-19) +
  this spec. Promote to the active section when Increment 2 starts.
- Build increments are PRs through the fleet gate; **docs-only changes need no PR.** Don't merge without
  operator instruction (Codex gate).
