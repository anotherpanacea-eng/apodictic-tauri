## Summary

<!-- What changed. Cite the Issue (`Closes #N`) or the goal this implements. -->

## Why

<!--
The problem solved or capability added. For Issue-driven work, the Issue's
acceptance criteria are the contract the reviewer checks this diff against.
-->

## Validation

<!--
Proof a reviewer can read against the diff:
- `npm run test:packaging-probe` → behavioral/tamper gates pass on macOS
- `cargo test --locked` / `cargo clippy --all-targets --locked -- -D warnings` → clean
- `cargo build --locked` and `node scripts/verify-sidecar-runtime.mjs` → pass
- Vendor-affecting changes preserve the pinned payload and v2 lock contract
- `git diff --check` clean
-->

<!-- See CLAUDE.md → "Agent workflow" for the full conventions. -->

## Integration-train evidence

<!--
Ordinary work stays draft and unarmed; write "Not applicable — constituent
draft" below. A train must complete every field before promotion.
-->

- **Included:**
- **Explicitly excluded:**
- **Frozen BASE / HEAD:**
- **Ordered inventory or canonical receipt:**
- **Conflict resolutions:**
- **Train-only fixes:**
- **Local validation receipts:**
- **Exact-head generic / fleet-posture / CI reviews:**
  <!-- One compact apodictic-exact-head-review JSON comment per lane, all bound
  to Frozen HEAD; schema apodictic-tauri-exact-head-review/1; lanes generic,
  fleet-posture, ci; verdict approved. -->
- **Promotion and exact-base CAS landing protocol:**

## Standalone exception

<!--
Normally "Not applicable." A deliberately standalone same-repository PR must record current
`ci-ready` authorization and use the same live receipt and exact-base CAS gate.
-->
