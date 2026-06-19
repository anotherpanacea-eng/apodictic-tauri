# vendor/gemini-web/

This directory holds the **vendored APODICTIC-Gemini desktop payload** — the built web `dist/`,
the per-target `app-sidecar` binaries, the bundled `apodictic-plugin/`, and `payload-manifest.json`.

**It is populated by `scripts/sync-gemini-web.mjs`, not by hand.** The payload bytes are
**gitignored** (large pkg'd binaries + built assets); only `../gemini-web.lock` is committed and is
the source of truth. `tauri build` resolves `frontendDist` / `externalBin` / `resources` from here,
so run `npm run sync:web` before building.

Until APODICTIC-Gemini ships a desktop-payload release asset (migration Increment 2 — see
`docs/architecture.md` §5), the lock is in `bootstrap` state and this directory stays empty except
for this README.
