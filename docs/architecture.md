# Spec — apodictic-tauri: architecture & extraction

**Status:** extraction and payload consumer implemented in source; native build/security and distribution qualification remain separate gates. Provider/local-LLM remains a phased roadmap.
**Date:** 2026-06-19. **Author:** Opus (Code-Mac).
**Spec review:** independent subagent, 2026-06-19 — initial verdict NEEDS-REVISION (3 blocking: B1 release-asset
vs tarball transport, B2 Gemini has no release pipeline + Windows-sidecar gap, B3 dev-mode contradiction);
all folded into §3/§5/§9 as decided design. Re-derived verdict: **CLEAR-TO-BUILD** for Increment 1.
**Repo:** [`anotherpanacea-eng/apodictic-tauri`](https://github.com/anotherpanacea-eng/apodictic-tauri) (private).
**Authoritative copy:** this in-repo file (`docs/architecture.md`) is authoritative; the fleet hub
(`Cowork/repo-fleet/specs/apodictic-tauri-architecture.md`) carries a pointer (per the fleet "authoritative
spec in-repo, pointer in hub" pattern).

## Current source snapshot — reconciled 2026-10-04

This reconciliation checks Tauri main `0dcc13f185867eb4d17e413a9762469eebb3789f`
and Gemini main `38c463264ddc7748110eea3d92e589496424a934`. The June 19
baseline and design rationale below remain historical evidence; they are not a
fresh runtime report. No native build, keychain operation, installer, updater
installation, provider call or release dispatch was performed for this update.

The extracted shell and consumer are implemented. `gemini-web.lock` is pinned to
Gemini `v0.3.4`, commit `38c5cc054ea8a90207287faba2524bc825555393`, with the v2
tree-hash schema and Apple Silicon, Intel Mac and Windows sidecar inputs.
Gemini's `release-desktop-payload.yml` has native Windows and macOS build/runtime
verification steps; configured steps do not prove a particular run passed.
Gemini's `src-tauri/` removal landed in `d0b4abd67dc1d094c42b083d8f2032e7f6cdcd1d`.
Retained sidecar builders and frontend Tauri adapters support the producer and
shared frontend, and are not an unfinished shell extraction.

The Tauri alpha workflow has macOS and Windows assembly paths. The updater's
GitHub release endpoint and public key are configured, and Rust implements a
check followed by user consent before installation. Native packaging/security,
signing identity/custody and actual update-install qualification remain separate.
The [macOS packaging probe](macos-packaging-probe-spec.md) still emits **M0 NO-GO**
and grants no distribution clearance. Current contributor process is governed by
[AGENTS.md](../AGENTS.md), including docs PRs and draft-first integration trains.

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

## 1. Historical baseline (grounded at Gemini HEAD 2026-06-19)

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
  (`{ web_version, plugin_version, tree_hash_schema, per-target sidecar entries with sha256,
  dist_sha256, plugin_sha256 }`).
  The producer pipeline has shipped; current consumers are pinned to its release assets.
- **Consumer (`apodictic-tauri`):**
  - `gemini-web.lock` — `{ repo, tag, commit, web_version, plugin_version, payload_asset,
    tree_hash_schema, dist_sha256, plugin_sha256, sidecars: [{ target, sha256 }], status, source }`. **Per-component
    hashes, no separate archive `payload_sha256`** (reconciled w/ the implementation, S4):
    `dist_sha256`/`plugin_sha256` are **canonical v2 tree hashes** — a domain tag and entry count,
    followed by sorted byte-length-prefixed UTF-8 paths and byte-length-prefixed contents. The
    producer's `payload-manifest.json` MUST declare `apodictic-tree-sha256-v2` and match. The sole
    compatibility exception is the schema-less, already-published Gemini `v0.2.1` payload at commit
    `268341b69020a6c7973d5584199c580ecc19c663`; its legacy manifest is checked only during authenticated
    migration sync and never supplies the committed exact-byte proof. Per-target
    sidecar hashes (S2) so a single missing/corrupt arch is detectable. `--check` **recomputes** these
    from the bytes on disk (it does not trust the manifest's self-reported values — S3). `commit` is
    the **resolved tag SHA** (not `target_commitish`, which is often a branch name).
  - `plugin_version` in the payload **inherits** Gemini's own `apodictic-plugin.lock` pin — Gemini is the
    single source of truth for which plugin version ships; the Tauri lock records it for visibility but does
    not independently re-pin it (S2, avoid a double source of truth).
  - `scripts/sync-gemini-web.mjs` — resolves the latest (or named) Gemini **release**, downloads the
    payload asset into `vendor/gemini-web/`, verifies every hash against `payload-manifest.json`, records
    `gemini-web.lock`; `--check` exits non-zero if the lock is behind the latest release **or** any vendored
    hash ≠ the lock (the **drift gate**). Since the producer has shipped, every non-`pinned` lock
    status fails closed; the historical bootstrap no-op is retired. Compares the resolved **commit**, not just the tag (preserves
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
(Gemini builds them via `build-sidecar.mjs`; the current lock includes all three targets). Historical production caveat (S3): signing/notarization can change the sidecar bytes downstream, so the lock attests vendored inputs, not final signed bundles. Acceptance of a notarized outer app spawning a separately signed `externalBin` requires its own proof (§7, §8). The current alpha workflow does not establish that qualification. Vendoring server *source* + building the sidecar in Tauri CI is rejected — it re-introduces the
build dependency the split is meant to remove.

---

## 4. Provider model + local-LLM (forward roadmap — not in the extraction increment)

The curated Hugging Face/local-model native boundary is now specified separately in
`docs/hugging-face-native-install-boundary-spec.md`, paired with the Gemini sidecar's
artifact-acquisition spec. It refines the roadmap without changing this ownership rule:
Hugging Face transport and model/provider semantics stay in the sidecar; Tauri owns only the
managed root, keychain chain, and trusted runtime process boundary.

Apple Intelligence follows a second, non-Hugging-Face path in
`docs/apple-intelligence-native-bridge-spike-spec.md`: the shell owns the signed Foundation
Models bridge while the Gemini sidecar owns provider semantics, validation, receipts, and
calibration. It is a public/synthetic feasibility spike until the exact OS/SDK/privacy gates
clear.

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

## 5. Migration status (reconciled 2026-10-04)

The original June 19 plan sequenced skeleton, producer, extraction, then destructive
Gemini removal. Current source has advanced through those code changes:

| Original increment | Current source disposition | Remaining evidence or boundary |
|---|---|---|
| 0 — Spec/review | Historical reviewed extraction design retained here. | This reconciliation has independent scope and build review; it grants no release operation. |
| 1 — Skeleton/consumer | Landed shell, vendor synchronizer, lock and drift checks; the lock is pinned, not bootstrap. | A lock records input identities, not proof that a local machine has staged or run them. |
| 2 — Gemini producer | `release-desktop-payload.yml` builds frontend and native Windows/macOS sidecars, verifies runtime contracts and assembles release assets. | A successful exact-run receipt is separate from configured workflow steps. |
| 3 — Shell extraction | Tauri owns `src-tauri/`; its config uses vendored frontend/sidecar/resources and separate Gemini dev server. | Local macOS build proof, keychain/Stronghold/DEK and capability requalification are not established by this documentation. |
| 4 — Gemini removal | Already landed in Gemini `d0b4abd67dc1d094c42b083d8f2032e7f6cdcd1d`; current Gemini has no `src-tauri/`. | Retained sidecar build scripts and frontend Tauri adapters are deliberate shared-engine/producer support. No further removal is authorized. |

The Windows runner gap from the historical plan is closed in source: the producer
uses `windows-latest`, and Tauri's `release-alpha.yml` has a Windows NSIS job.
The alpha workflow publishes only from `main`; a branch dispatch builds without
publication. This is a description of configured behavior, not a dispatch request.
Windows Authenticode and Mac Developer ID/notarization remain separate signing
qualifications. The updater signatures serve a different purpose (§7).

Forward native-provider work remains scoped by
[the curated local-model boundary](hugging-face-native-install-boundary-spec.md)
and [the Apple Intelligence spike](apple-intelligence-native-bridge-spike-spec.md).
Their own preconditions and synthetic/public-data restrictions still apply.

---

## 6. Fleet-repo ownership and delivery

The June 19 setup made Tauri fleet member #5; the current fleet has six repositories.
Tauri remains a private Rust/TS consumer of Gemini desktop payloads, with an in-repo
architecture contract and a pointer in the local hub. `AGENTS.md` governs contributors;
`CLAUDE.md` points to it. The shell owns native lifecycle and credentials, while
provider/editorial semantics remain in Gemini/apodictic.

The current [draft-first integration contract](draft-first-integration-trains-spec.md)
is built. Ordinary drafts stay unarmed; the singleton macOS validation job runs only
for an eligible promoted same-repository train or explicit standalone exception.
Weekly sync keeps automated payload bumps draft. This reconciles the original
setup's per-change workflow description; source configuration is not a fresh CI receipt.

---

## 7. Signing, notarization and updater status

The updater endpoint choice is configured in `src-tauri/tauri.conf.json`: GitHub's
`desktop-updater` release provides `latest.json`, with a committed updater public
key. Rust's `check_for_update` checks the feed and asks for consent before stopping
the sidecar, downloading/installing the update and restarting. Configuration and
source implementation do not qualify an actual installed-app update or signing-key
custody; no private key was inspected for this reconciliation.

`.github/workflows/release-alpha.yml` uses the updater signing secrets for update
archives/signatures and publishes the feed after a successful main-branch build.
The macOS alpha path uses ad-hoc signing (`APPLE_SIGNING_IDENTITY=-`); the Windows
NSIS path is without Authenticode. These updater signatures are distinct from
Apple Developer ID, notarization and Windows code-signing identities.

The existing M0 record and [packaging probe contract](macos-packaging-probe-spec.md)
keep distribution qualification separate: licenses/redistribution, notices/SBOM,
security/CSP/local authority, clean installation, signing and updater custody must
not be treated as cleared merely because a workflow or public key exists. This
snapshot establishes no new distribution or installation pass.

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
- **A. Sidecar vendoring** → pre-built per-target binaries; the current pin includes two macOS targets and Windows x86_64. The original macOS-only bootstrap boundary is historical (§5).
- **C. Dev-mode source** → `desktop:dev` keeps `devUrl: http://localhost:3000` and the developer runs
  Gemini's `npm run dev` **separately** (the Tauri repo has no Gemini source to build, and `lib.rs` debug
  mode already skips the sidecar and expects Vite at :3000). **`beforeDevCommand` is
  dropped**, and the README/AGENTS must state the "run Gemini dev server first" prerequisite explicitly so
  `tauri dev` isn't pointed at a dead `:3000`. The vendored payload is for `tauri build` only. This resolves
  the §3-vs-§9 contradiction the spec review (B3) flagged.

**Current dispositions (source configuration versus qualification):**
- **B. Updater endpoint:** GitHub release endpoint and public key are configured (§7). Actual update-install qualification, key custody, Apple Developer ID/notarization and Windows Authenticode remain separate; their availability was not inspected here.
- **E. Windows target:** native producer/runtime-verification steps and an unsigned NSIS alpha workflow are implemented. This source snapshot proves no actual Windows build/install run; Authenticode qualification remains separate.
- **D. SETEC local path:** the apodictic-plugin is already bundled. A local SETEC path (for the deterministic
  substrate tier offline) is future, via the provider/substrate tiering — out of scope for the extraction.

---

## 10. Tracking and contributor process

The live Fleet issues and issue-self-checkout worker govern current ownership;
dated hub board snapshots are context. This reconciliation is tracked by
[Fleet #390](https://github.com/anotherpanacea-eng/fleet-coordination/issues/390).
Keychain repair (#230) and unused-workflow removal (#383) have separate owners and
are not part of this documentation change.

Follow [AGENTS.md](../AGENTS.md): every change, including docs, uses a PR with
independent review. Ordinary constituents stay draft and CI-unarmed; exact reviewed
heads enter a periodic integration train. Promotion/landing requires the separate
generic, Fleet and CI lanes with exact receipts. This document authorizes no
workflow dispatch, hosted minutes, release, native-provider run or merge.
