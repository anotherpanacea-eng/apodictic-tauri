# Agent workflow — apodictic-tauri

APODICTIC's desktop shell is solo-maintained (`anotherpanacea-eng`) but multi-agent: Claude,
Codex, and other sessions all contribute. This document records the internal workflow they
follow. It governs the maintainer's own agent sessions.

## Fleet / cross-repo context

This repo is one of **six** maintained together (all `github.com/anotherpanacea-eng`):
`setec-voiceprint` (producer · public · Python), `apodictic` (consumer + producer · public ·
Python), `setec-voicewright` (consumer · private · Python), `APODICTIC-Gemini` (consumer ·
private · TS web app), `apodictic-tauri` (consumer · private · Rust + TS — **this repo**), and
`wandering-inn-reader` (independent reader application).

**This repo's dependency contract:**
- **Consumes** `APODICTIC-Gemini`'s versioned **desktop payload** (built `dist/` + per-target
  `app-sidecar` binaries + the apodictic-plugin), published as a release asset. Pinned in
  `gemini-web.lock`, drift-gated offline by `scripts/sync-gemini-web.mjs --check`. The weekly
  `.github/workflows/sync-gemini-web.yml` auto-PRs the version bump. **Don't hand-edit the lock
  or the vendored payload under `vendor/gemini-web/` — run `scripts/sync-gemini-web.mjs`.**
- The vendored payload bytes are **gitignored** (large binaries); only `gemini-web.lock` is
  committed. The lock + the producer's `payload-manifest.json` hashes are the reproducibility anchor.
- **Auth note:** `APODICTIC-Gemini` is **private**, so the sync workflow needs a PAT/GitHub-App
  token with cross-repo read on it (the default `GITHUB_TOKEN` is current-repo-scoped and will
  not read a sibling private repo's release assets).

**This repo is a *surface*, not the engine.** The editorial rules/schemas/validators/passes and
the model-provider abstraction (incl. local-LLM backends) live **below** this shell, in
`apodictic` + `APODICTIC-Gemini`'s `server/`. Never put analysis logic in the Rust/JS command
layer — keep the shell replaceable.

**Shared workflow:** spec→review→write→review→fix→periodic integration train; landing preserves
merge structure and adds no bytes. Codex is a standing review lane; do not merge out from under it.

**Protect-public-only:** this is a **private** repo, so no branch protection is configured (the
fleet only protects the public repos). The Codex review gate is still observed by convention.

**Cloud-reachable coordination hub** (added 2026-07-19):
[`anotherpanacea-eng/fleet-coordination`](https://github.com/anotherpanacea-eng/fleet-coordination)
carries the fleet's code-safe cross-machine layer — task handoff packets
(`handoffs/`), the live code-safe status board (`STATUS.md`), the portable
fleet briefing (`PROJECT-SUMMARY.md`), and the sanitized build/review
preflight. Unlike the Dropbox hub, **cloud threads can read it** — check its
`STATUS.md` and `handoffs/` before flagging missing cross-repo context. Hard
data boundary (CI-enforced leak gate): branch/commit refs, aggregates, and
whole-artifact hashes only — never corpus prose, per-unit identifiers,
private machine paths, or keys.

**Fuller cross-repo context** (backlog, topology, the architecture spec, deep lessons) lives in
the maintainer's local `Cowork/repo-fleet/` hub — **not reachable from cloud containers** (which
hold only this one git repo). The architecture + migration plan also lives in-repo at
[`docs/architecture.md`](docs/architecture.md). If you're a cloud session and need cross-repo
context beyond this section, flag it rather than guessing.

## The flow

```
spec  →  review  →  write  →  review  →  fix  →  merge
            ▲                    ▲
         reviewer             reviewer
```

1. **Spec.** What the change should do. Strategic work lives in `docs/architecture.md`;
   non-trivial ad-hoc work gets a GitHub Issue; trivial work can be a chat brief.
2. **Spec review.** A second agent surfaces gaps, dependency issues, or scope creep before
   writing starts.
3. **Write.** One agent implements.
4. **Code review.** The other agent reads the diff and flags issues.
5. **Fix.** The writing agent applies fixes.
6. **Merge.** Via PR + merge commit.

### Review practices

The spec/code reviews earn their keep when the reviewer does more than read for plausibility —
run the real gate, distrust count-shaped or "it builds" claims, and check the seams the change
actually touches (here: the vendor boundary, the sidecar lifecycle, the keychain/Stronghold
chain, and the Tauri capability allowlist). The spec-review gate for this repo's own founding
caught three blocking transport/sequencing issues before any code was written — keep that bar.

## Test value convention

Every test must justify its maintenance cost by protecting at least one of:
observable behavior, a public or consumer contract, a reproduced bug, a
safety/security property, or a stable architectural prohibition. Coverage,
test count, and "this is how the source is written" are not sufficient reasons.

Use this litmus test: **if behavior and contracts stay unchanged, could a
reasonable refactor make the test fail?** If yes, the test is probably asserting
implementation rather than behavior. Usually delete or rewrite tests that pin
source/AST shape, hashes of implementation files, symbol location, exact internal
inventories, workflow or documentation text, oversized internal snapshots, or a
mock/monkeypatch seam that production would not otherwise need. Prefer black-box,
metamorphic, adversarial, and bug-regression tests. Do not keep two tests that
protect the same failure at different fidelity unless each catches a distinct
regression class.

Static inspection is justified only when it enforces a stable **negative** property
that is impractical to observe dynamically--for example anti-Goodhart separation,
held-out isolation, no forbidden dependency/network path, a security boundary, or
canonical/generated parity. Such a test must name the prohibited coupling and
should not pin incidental lines, helper names, or file layout. Frozen fixtures are
appropriate for genuinely external compatibility contracts, not internal
refactoring receipts.

When deleting a test, inspect the production code for seams, wrappers, indirection,
or exported helpers that existed only to satisfy it; simplify those in the same
change when safe. Preserve or replace behavior coverage before deletion. In the PR,
state why each deleted class was low-value and report the behavioral checks that
remain.

**Monthly sweep.** Once per month, audit the suite for source-reading tests, exact
inventories/hashes, duplicate coverage, large brittle snapshots, and test-only
production seams. Classify candidates as KEEP / REWRITE / DELETE with a one-line
justification; there is no deletion quota. Make changes in a per-repo branch, run
the relevant behavioral checks, and open a draft PR. Never merge sweep findings
without review; after the required reviews and green checks, follow this repo's
normal merge policy.

## Vendor / consumer machinery

- `scripts/sync-gemini-web.mjs` pulls the pinned Gemini desktop-payload **release asset** (not a
  git tarball — the payload is uncommitted build artifacts), verifies every hash against the
  producer's `payload-manifest.json`, writes `vendor/gemini-web/`, and records `gemini-web.lock`.
- `scripts/sync-gemini-web.mjs --check` is the **drift gate**. It always re-computes the vendored
  `dist/` + `apodictic-plugin/` tree hashes and each sidecar hash and fails if they ≠ the lock
  (offline byte-integrity). **Only when a token is present** (not PR-time CI) does it also check the
  lock is behind the latest release — comparing the resolved **commit SHA**, not just the tag, to
  catch a re-pointed tag. "Behind latest" freshness is otherwise the weekly sync workflow's job (it
  opens the bump PR). The producer has shipped; the lock must be `pinned` with the v2 tree-hash schema.
  Bootstrap or any other status fails closed.
- Run `sync:web` before `desktop:build` — `frontendDist`/`externalBin`/`resources` resolve to
  `vendor/gemini-web/`, and there is no fallback build-from-source path.

## PRs and integration trains

- Ordinary and automated work opens as an unarmed draft. Do not add `ci-ready` during normal cadence.
- Periodically freeze exact reviewed heads into a fresh same-repository `train/<bounded-name>` branch
  based on exact `origin/main`. Merge constituents with `--no-ff` and keep an external closed inventory.
- Version/changelog work, when needed, is an explicitly inventoried and reviewed train-only commit
  made before freeze. The landing adds no bytes.
- Promote the frozen train exactly once. It spends one full CI job per train; constituent drafts and
  label noise consume no runner. `ci-ready` is reserved for a deliberate same-repository standalone
  exception; forks never authorize hosted CI.
- Land only a live green receipt bound to exact base, head, singleton job, run attempt, and GitHub
  synthetic merge. Push `main` with an exact expected-head lease, prove containment/closure, and delete
  only unchanged same-repository branches under their own leases.
- GitHub Pro rulesets, branch protection, Merge Queue, squash, and ad-hoc direct pushes are not part of
  this private-repository protocol. Safety comes from exact receipts, independent reviews, and CAS.
- The exact-head generic, fleet-posture, and CI review lanes must all approve before promotion/landing.

### Branch naming

- `feat/<surface>` new features · `fix/<short-description>` fixes ·
  `chore/<short-description>` / `docs/<short-description>` ancillary ·
  `codex/<short-description>` Codex-authored proposals.

## CI

`.github/workflows/ci.yml` is pull-request-only and has one bounded `macos-latest` validation job.
It preserves payload sync/drift, packaging-policy, Rust test/clippy/build, and sidecar gates. Only a
promoted same-repository train or explicit same-repository non-sync `ci-ready` standalone can run it;
fork events remain zero-step, and there is no
duplicate push-to-main run. `.github/workflows/sync-gemini-web.yml` opens or updates the weekly payload
bump PR as a draft and independently proves it remains draft and unarmed.
There is no `@claude` comment workflow here; it was removed on 2026-10-04 after a month with no
real invocations. Ask for Claude review from a Claude Code session instead.

## Security (do not regress)

The OS-keychain → Stronghold vault-key + `CREDENTIAL_ENCRYPTION_KEY` DEK chain (`src-tauri/src/
lib.rs`) is the local-credential guarantee — re-verify it survives any change. Keep
`src-tauri/capabilities/default.json` (the permission boundary) minimal and in step with the
shell's actual shell/keychain usage.

## Co-authorship

Commits authored end-to-end by one agent carry that agent's trailer; pair-authored commits carry
both.

## When this document is wrong

Update it. It's a working document, not a contract.
