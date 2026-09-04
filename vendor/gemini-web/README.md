# vendor/gemini-web/

This directory holds the **vendored APODICTIC-Gemini desktop payload** — the built web `dist/`,
the per-target `app-sidecar` binaries, the bundled `apodictic-plugin/`, and `payload-manifest.json`.

**It is populated by `scripts/sync-gemini-web.mjs`, not by hand.** The payload bytes are
**gitignored** (large pkg'd binaries + built assets); only `../gemini-web.lock` is committed and is
the source of truth. `tauri build` resolves `frontendDist` / `externalBin` / `resources` from here,
so run `npm run sync:web` before building.

APODICTIC-Gemini now ships versioned desktop-payload release assets. The committed lock must remain
`pinned` with the collision-unambiguous v2 tree-hash schema; bootstrap and unknown states fail closed.
The ignored payload bytes are populated on demand by the sync tool.
