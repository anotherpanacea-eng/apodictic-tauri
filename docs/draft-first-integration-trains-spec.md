# Draft-first integration trains

**Status:** Built

**Tracking:** [Issue #10](https://github.com/anotherpanacea-eng/apodictic-tauri/issues/10)

## Goal

Make `apodictic-tauri` use the fleet's draft-first, periodic integration-train mode without
GitHub Pro branch protection, rulesets, Merge Queue, or duplicate hosted work. Ordinary and
automated changes remain unarmed draft pull requests. A fresh same-repository `train/` branch
combines reviewed exact heads, receives one macOS validation job, and is the only PR landed for
the batch.

This changes repository delivery policy only. It does not move analysis into the shell, change
the keychain/Stronghold chain or capability allowlist, publish a desktop artifact, weaken the
Gemini payload boundary, or add a release workflow.

## Current state and cost problem

At the frozen base, one draft PR (#9) is open. The existing CI correctly skips draft PRs but
repeats its full macOS job after merge because it also triggers on pushes to `main`. The weekly
payload sync uses a moving `create-pull-request@v6`, creates ready PRs by default, and has no
independent readback that its fixed branch remains draft and lacks `ci-ready`. The private repo
has neither a ruleset nor classic branch protection.

The useful spending unit is one full validation of the frozen integration boundary. Running the
same macOS payload/Rust job per constituent and again after landing is unnecessary cost.

## Authorization and cost topology

`.github/workflows/ci.yml` becomes pull-request-only. Its event inventory is exactly `opened`,
`synchronize`, `reopened`, `ready_for_review`, `converted_to_draft`, `labeled`, `unlabeled`, and
`closed`. It contains one job named `validate`, on `macos-latest`, with a 15-minute timeout and no
matrix, reusable-job fan-out, service, container, aggregation job, or `continue-on-error`.

The job is authorized only when the PR is non-draft and either:

1. the head repository is this repository, the branch is a bounded canonical `train/<name>`, and
   the activity is one of the four arming activities; or
2. the head repository is this repository, the PR is not a train, is not fixed branch
   `chore/sync-gemini-web`, currently has `ci-ready`, and either receives an arming activity or
   that exact label is added.

Forks cannot authorize hosted CI at all: every fork event remains a skipped zero-step record, so
untrusted code never receives the private payload credential and never burns a doomed macOS job.
Case comparisons match GitHub expression semantics. Every other event creates at most a skipped
zero-step record with no runner. Canonical concurrency cancels obsolete clearance on synchronize,
draft conversion, close, or exact same-repository standalone-label removal, while unrelated label
noise uses a run-unique group and cannot cancel valid work. Run names expose only bounded activity
identity used by the live verifier.

There is no push trigger. A tested landing therefore produces no second CI run.

## Preserved validation surface

The singleton job retains the existing macOS validation surface in one place:

1. shallow checkout and Node 22 setup;
2. exact synthetic-merge binding before dependency installation;
3. `npm ci` and the closed policy-test list;
4. stable Rust toolchain with Clippy plus the existing bounded Rust cache;
5. authenticated pinned Gemini payload sync;
6. proof that sync did not rewrite the committed lock;
7. the payload drift gate;
8. packaging-probe behavior and tamper tests;
9. locked Cargo tests, Clippy with warnings denied, and locked build; and
10. vendored sidecar runtime verification.

The packaging tests are intentionally part of this job after payload staging: PR #9's real macOS
fixture needs the pinned dist/plugin/sidecar bytes and canonical `/usr/bin` inspection tools. No
second macOS job is added.

The merge-binding helper is shallow-safe. It requires a clean checkout, exact `github.sha`, exactly
two commit parents in base/head order, canonical repository/job/run identity, and prints one
canonical receipt bound to the GitHub synthetic merge SHA.

## Ordinary and automated drafts

The PR template makes ordinary drafts and train evidence explicit. The `ci-ready` label is created
with description `Explicitly authorize hosted CI for a non-train standalone PR` before rollout and
read back exactly; creation itself arms nothing.

The weekly sync retains its schedule, manual ref input, authenticated payload update, and lock
metadata. It moves to Node 22 and pins `peter-evans/create-pull-request` v7 at full commit
`22a9089034f40e5a961c8808d113e2c98fb63676`, with `draft: always-true`. The checked-in upstream
contract fixture records the relevant action blob and draft semantics.

A standard-library helper runs before and after the updater with `GH_TOKEN`. It resolves the fixed
same-repository/main-based sync PR exactly, refuses ambiguity or API failure, removes any case form
of `ci-ready`, converts a ready PR to draft, re-resolves, and proves the result. Zero matching PRs
is a bounded no-op. This readback is independent of whether token-created PR mutations emit Actions
events.

## Train inventory and review gate

For each batch, fetch and freeze exact `origin/main`, re-query all open PRs, and explicitly record
included and excluded heads. Create a fresh same-repository bounded `train/` branch at that base.
Merge each admitted head with `--no-ff`; do not squash or cherry-pick. Record an external JSON
inventory with exact base, train head, PR number, head repository/ref/SHA, merge commit, clean or
conflict-resolution mode, and bounded resolution explanation. A train-only commit is allowed only
when explicitly inventoried and independently reviewed before freeze.

The offline verifier rejects shallow/promisor/replace/graft/alternate-object ambiguity; a moved
base; malformed, duplicate, reordered, missing, or extra commits; duplicate case-folded branch
identities; CI skip text; and clean merges whose tree differs from Git's exact automatic result.
Conflict merges must have complete reviewed materialization and no unrelated edits.

Before promotion and landing, three exact-head receipts—generic, fleet-posture, and CI—must appear
as standalone comments in the dedicated PR-body field. The parser ignores fenced, inline,
indented, adjacent-section, and HTML-template decoys and refuses malformed visible envelopes.
Change requests, unresolved review threads, or unbounded thread pagination refuse.

## Live clearance and no-Pro landing

The live receipt verifier re-queries the current PR and all pull-request CI runs for the frozen
head. It permits exactly one newest successful non-noise run with exactly one `validate` job and one
canonical merge-binding receipt. It proves draft/head/base/label authorization is still current.
Every label-noise/draft record must be completed, skipped, and expose an exact empty step list.

Landing authenticates Git through the absolute `gh auth git-credential` helper inside a fresh
controlled bare repository. Ambient Git config, credential helpers, replacement objects, grafts,
alternates, and URL rewrites are removed or refused. The landing fetches the exact base and GitHub
synthetic merge, proves parent order/tree semantics, rechecks live clearance and reviews, and pushes
the exact synthetic object to `main` with `--force-with-lease=refs/heads/main:<BASE>`.

After CAS it proves every admitted constituent head is contained, waits boundedly for indirect PR
closure, deletes only unchanged same-repository branches with exact expected-head leases, preserves
forks/advanced identities, proves no unexpected PR appeared, and polls to disprove a post-main CI
run. Any post-CAS verification failure emits a machine-readable incomplete landing receipt so the
already-landed state cannot be mistaken for a pre-CAS refusal.

## Verification and acceptance

- Workflow parsing uses the explicit dev-only `yaml` dependency; policy/landing tools use Node
  standard library only.
- The closed policy suite covers authorization/concurrency, exact workflow inventory and topology,
  merge binding, sync enforcement, inventory topology/conflicts, live receipts/noise, review decoys,
  credential-gated transport, standalone and train CAS, convergence, and leased cleanup.
- PR #9 is repaired and independently approved before admission. The policy PR is independently
  reviewed. Their exact heads are combined in one disposable train.
- The train is opened draft, promoted exactly once, completes one singleton macOS validation, and
  lands through the live receipt/CAS tool.
- After landing: both constituents and the train are merged/closed, their unchanged branches are
  deleted, the governing issues close, zero open PRs remain, `main` equals the synthetic merge, and
  no push-to-main CI run exists.
