# CLAUDE.md

This repo's agent workflow, conventions, and architecture live in **[`AGENTS.md`](AGENTS.md)**
— the canonical, tool-agnostic source (Claude Code, Codex, and others all read from it). This
file exists only so Claude Code's auto-load points you there.

Read `AGENTS.md` first. In particular:

- **`AGENTS.md` § Test value convention** — tests must protect behavior,
  contracts, reproduced bugs, or stable safety boundaries; do not preserve
  implementation-mirroring tests or production seams built only for tests.
- **`AGENTS.md` § Fleet / cross-repo context** — this repo is a *consumer* desktop shell, not the
  engine. Never put analysis logic in the Rust/JS command layer.
- **`AGENTS.md` § Vendor / consumer machinery** — `gemini-web.lock` + `scripts/sync-gemini-web.mjs
  --check` is the drift gate; **don't hand-edit the lock or the vendored payload — run the sync
  script.**
- **`AGENTS.md` § Security** — the keychain → Stronghold → DEK chain must not regress.
- Architecture + migration plan: **[`docs/architecture.md`](docs/architecture.md)**.

Update `AGENTS.md`, not this file, when the workflow changes.
