# Rust shell dependency ledger (CAM-14 slice 1)

- Scope: the Rust crates in `src-tauri/` only.
- Date: 2026-10-08
- Repo head: `f0bf2b6d78a0cb93c76120b32e1d00b6f73fb8e9` (origin/main at branch point)
- Targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`. These are the
  `tauri build --target` values in `.github/workflows/release-alpha.yml`, and they match the sidecar
  targets in `docs/architecture.md`.
- Tools: cargo/rustc 1.94.1, cargo-deny 0.20.2, cargo-about 0.9.2, cargo-cyclonedx 0.5.9.
  RustSec advisory-db at `550efd3d587a29b2e2c2b21b17a440da4fede999` (2026-10-08).
- Out of scope: the Brysbaert resource's redistribution permission is a data-resource question, not a
  crate. The Node sidecar and frontend payload are also out of scope here.
- Status: findings only. No waiver has been granted, and distribution remains M0 NO-GO.

## Commands run

All commands were run from `src-tauri/`. `Cargo.lock` was not changed.

```sh
cargo deny --locked --color never check licenses advisories bans sources   # exit 5 (advisories and licenses fail); rerun to see the raw output
cargo deny --locked --format json check advisories licenses                 # same findings, structured
cargo about generate --locked about.hbs -o ../docs/distribution/THIRD-PARTY-NOTICES-rust.md
SOURCE_DATE_EPOCH=<head commit time> cargo cyclonedx --format json --spec-version 1.5 \
  --no-build-deps --target <T> --override-filename sbom-<T>                  # then moved to docs/distribution/
# The local absolute path in the root bom-ref was rewritten to `path+file:src-tauri`.
cargo tree --locked --offline --target <T> -e normal,no-proc-macro --prefix none -f '{p}'   # shipped set per target
cargo tree --locked --offline --target <T> -e normal,build --prefix none -f '{p}'           # compile-time reach
cargo tree --locked --offline --target all -e normal,build,dev --prefix none -f '{p}'       # any platform
cargo metadata --locked --format-version 1                                  # license fields
cargo search --limit 1 <crate>                                              # newest published version
```

Latest stable versions and yanked status for all 749 registry entries came from the crates.io sparse
index (`https://index.crates.io/`). `cargo search` reports prereleases, such as tauri 3.0.0-alpha,
so the "latest stable" column uses the index.

The first cargo-deny run did not report the yanked `core2`, because the local index cache was stale.
After the cache refreshed, a rerun reported `warning[yanked]` for core2 and nothing else changed.
The findings below are from that rerun. The sparse-index check also finds core2 0.4.0 as the only
yanked entry in the lockfile.

## Direct crates

The direct crates are the 14 entries in `[dependencies]` plus one build dependency. None of them
ships an Apache-2.0 `NOTICE` file. No crate in the shipped set ships a `NOTICE` file. `rand` and
11 other shipped crates include an informational `COPYRIGHT` file. Advisories listed here are on the
crate itself. Advisories in a crate's dependencies are listed in the next section.

| Crate | Resolved | License | Notice obligation | Advisories | Maintenance (latest stable) | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| serde_json | 1.0.149 | MIT OR Apache-2.0 | license text only | none | current line (1.0.151) | ok | |
| serde | 1.0.228 | MIT OR Apache-2.0 | license text only | none | current line (1.0.229) | ok | |
| log | 0.4.29 | MIT OR Apache-2.0 | license text only | none | current line (0.4.34) | ok | |
| tauri | 2.10.3 | Apache-2.0 OR MIT | license text only | none | 2.12.1 | ok | Clean license. It brings in quick-xml, unic-\*, option-ext and webview2-com-sys (see next section). |
| tauri-plugin-log | 2.8.0 | Apache-2.0 OR MIT | license text only | none | 2.10.0 | ok | |
| tauri-plugin-stronghold | 2.3.1 | Apache-2.0 OR MIT | license text only | none | 2.4.0 | waiver candidate | It depends on iota_stronghold 2.1.0, which has had no release since 2024-05-13. iota_stronghold brings in bincode (unmaintained) and libsodium (notice gap). |
| tauri-plugin-shell | 2.3.5 | Apache-2.0 OR MIT | license text only | none | 2.4.1 | ok | |
| tauri-plugin-updater | 2.12.0 | Apache-2.0 OR MIT | license text only | none | 2.13.2 | ok | It brings in reqwest 0.13.2, rustls and ring. The ring license texts are rendered through cargo-about's `ring` workaround. |
| tauri-plugin-dialog | 2.7.3 | Apache-2.0 OR MIT | license text only | none | 2.8.1 | ok | |
| keyring | 2.3.3 | MIT OR Apache-2.0 | license text only | none | 4.2.0 | waiver candidate | It is two major versions behind (2.3.3 is the last 2.x release), but it has no advisory. |
| reqwest | 0.11.27 | MIT OR Apache-2.0 | license text only | none on crate | 0.13.5 (0.11.27 is the last 0.11) | unresolved | This old major line is the only path to h2 0.3.27 (a vulnerability with no 0.3.x fix) and rustls-pemfile 1.0.4 (unmaintained). It also duplicates the updater's reqwest 0.13.2 and hyper/http 1.x. |
| rand | 0.8.5 | MIT OR Apache-2.0 | license text only | RUSTSEC-2026-0097 (unsound) | 0.10.3; 0.8.8 is in-line | unresolved | 0.8.6 and later is patched. A lockfile-only update clears it (see the trial below). |
| base64 | 0.22.1 | MIT OR Apache-2.0 | license text only | none | 0.23.1 | ok | |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | license text only | none | 0.11.0 | ok | |
| tauri-build (build-dep) | 2.5.6 | Apache-2.0 OR MIT | none, not shipped | none | 2.7.1 | ok | It runs only at build time and ships nothing. Through tauri-utils/kuchikiki it brings in the MPL-2.0 css crates and fxhash, all at compile time only. |

## Flagged transitive crates

The "flagged by" column records the source of each row. `deny` means the row came from
`cargo deny check`. `about` means it came from cargo-about. `manual` means it came from
inspecting the packaged crate contents. A crate in the "compile-time only" bucket does not end up in
any shipped binary.

| Crate | Resolved | Bucket / targets | License | Notice obligation | Advisories | Maintenance (latest stable) | Flagged by | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| h2 | 0.3.27 | shipped, all 3 | MIT | license text | RUSTSEC-2026-0258 (vuln, low) | 0.4.20; no 0.3.x fix | deny | unresolved | Via hyper 0.14 ← reqwest 0.11. Moving reqwest to 0.12 or later removes it. |
| quick-xml | 0.38.4 | shipped, macOS only | MIT | license text | RUSTSEC-2026-0194, RUSTSEC-2026-0195 (vuln, DoS) | 0.42.0 | deny | unresolved | Via plist 1.8.0 ← tauri (macOS). plist 1.10.0 and later needs quick-xml ^0.41, which is patched. tauri requires `plist ^1`, so a lockfile-only update clears this. |
| rand | 0.8.5 | shipped, all 3 | MIT OR Apache-2.0 | license text | RUSTSEC-2026-0097 (unsound) | 0.8.8 in-line | deny | unresolved | It is both a direct crate and a dependency of the Stronghold crates. See the direct table. |
| webview2-com-sys | 0.38.2 | shipped, Windows only | MIT (crate field) | Microsoft WebView2 loader terms not captured | none | 0.39.1 | manual | unresolved | The crate vendors `WebView2LoaderStatic.lib`, `WebView2Loader.dll` and `.dll.lib` from Microsoft, and its build script links them. The crate contains no license file covering those binaries, so the notices list only MIT. |
| libsodium-sys-stable | 1.23.2 | shipped, all 3 | MIT OR Apache-2.0 (crate field) | libsodium ISC notice not captured | none | 1.24.0 | manual | unresolved | It compiles the vendored `LATEST.tar.gz` (libsodium, ISC, © Frank Denis) and links it statically. The ISC text from inside that tarball is not in the generated notices. |
| option-ext | 0.2.0 | shipped, all 3 | MPL-2.0 | MPL-2.0 text and a pointer to the source | none | current (0.2.0) | deny (rejected) | waiver candidate | Via dirs-sys 0.5 ← dirs 6 ← tauri, wry. This is weak (file-level) copyleft on an unmodified crate. It is not in the deny allow list. |
| bincode | 1.3.3 | shipped, all 3 | MIT | license text | RUSTSEC-2025-0141 (unmaintained) | 3.0.0 | deny | waiver candidate | Via iota_stronghold 2.1.0, which is the latest iota_stronghold release. The advisory says upstream considers 1.3.3 complete, and no upgrade is possible inside Stronghold. |
| iota_stronghold | 2.1.0 | shipped, all 3 | Apache-2.0 | license text | none | 2.1.0; last release 2024-05-13 | manual | waiver candidate | Dormant upstream that carries bincode. The repo's keychain → Stronghold → DEK chain depends on it. |
| rustls-pemfile | 1.0.4 | shipped, all 3 | Apache-2.0 OR ISC OR MIT | license text | RUSTSEC-2025-0134 (unmaintained) | 2.2.0 | deny | waiver candidate | Via reqwest 0.11 only. It goes away when reqwest is upgraded. |
| unic-char-property | 0.9.0 | shipped, all 3 | MIT/Apache-2.0 | license text (no packaged license file) | RUSTSEC-2025-0081 (unmaintained) | 0.9.0 | deny | waiver candidate | Via urlpattern 0.3 ← tauri-utils 2.8.3. tauri-utils 2.10 and later uses urlpattern 0.6, which drops all unic-\* crates (lockfile-only, see the trial below). |
| unic-char-range | 0.9.0 | shipped, all 3 | MIT/Apache-2.0 | same | RUSTSEC-2025-0075 (unmaintained) | 0.9.0 | deny | waiver candidate | Same as unic-char-property. |
| unic-common | 0.9.0 | shipped, all 3 | MIT/Apache-2.0 | same | RUSTSEC-2025-0080 (unmaintained) | 0.9.0 | deny | waiver candidate | Same as unic-char-property. |
| unic-ucd-ident | 0.9.0 | shipped, all 3 | MIT/Apache-2.0 | same | RUSTSEC-2025-0100 (unmaintained) | 0.9.0 | deny | waiver candidate | Same as unic-char-property. |
| unic-ucd-version | 0.9.0 | shipped, all 3 | MIT/Apache-2.0 | same | RUSTSEC-2025-0098 (unmaintained) | 0.9.0 | deny | waiver candidate | Same as unic-char-property. |
| ring | 0.17.14 | shipped, all 3 | Apache-2.0 AND ISC | BoringSSL/OpenSSL-derived texts | none | current | manual | ok | It contains C and assembly code. cargo-about's `ring` workaround renders its license files into the notices. |
| cssparser | 0.29.6 | compile-time only | MPL-2.0 | none (not distributed) | none | — | deny (rejected), about | ok | Via kuchikiki ← tauri-utils, on the tauri-build/tauri-codegen path only. |
| cssparser-macros | 0.6.1 | compile-time only | MPL-2.0 | none | none | — | deny (rejected), about | ok | Same path as cssparser. |
| dtoa-short | 0.3.5 | compile-time only | MPL-2.0 | none | none | — | deny (rejected), about | ok | Same path as cssparser. |
| selectors | 0.24.0 | compile-time only | MPL-2.0 | none | none | — | deny (rejected), about | ok | Same path as cssparser. |
| fxhash | 0.2.1 | compile-time only | Apache-2.0/MIT | none | RUSTSEC-2025-0057 (unmaintained) | — | deny | ok | Via selectors, at compile time. |
| paste | 1.0.15 | compile-time only (proc-macro) | MIT OR Apache-2.0 | none | RUSTSEC-2024-0436 (unmaintained) | — | deny | ok | A proc-macro of stronghold_engine. |
| core2 | 0.4.0 | compile-time only | Apache-2.0 OR MIT | none | RUSTSEC-2026-0105 (unmaintained); yanked | all versions yanked | deny | ok | Via libflate, a build-dep of libsodium-sys-stable. The lockfile still builds, but a fresh resolve would fail. |
| 43 crates with more than one version | — | mixed | — | — | — | — | deny (bans, warn) | ok | Notable: reqwest 0.11.27 + 0.13.2, hyper 0.14 + 1.9, http 0.2 + 1.4 and h2/http-body/sync_wrapper pairs, all from keeping reqwest 0.11 next to the updater's 0.13. Also rand 0.7/0.8, getrandom ×4 and windows-sys ×5. These are size and audit cost, not a license issue. |
| apodictic-tauri (workspace) | 0.1.0 | workspace crate | `license = ""` | — | — | — | deny (unlicensed), about (warn), cyclonedx (warn) | unresolved | The app's own license is empty, and the public repo has no LICENSE file. |

Notes on the notices and the SBOM:

- `THIRD-PARTY-NOTICES-rust.md` lists 431 crates. That covers all 354 shipped crates, plus 75
  compile-time-only crates and 2 other-platform-only crates (objc2-core-graphics, objc2-quartz-core).
  The extras appear because cargo-about uses `cargo metadata`, which unifies features and includes
  proc-macros. Listing extra crates is harmless. It has the two gaps flagged above (libsodium ISC and
  the WebView2 loader).
- 28 shipped crates have no license file in the published package. Examples are the unic-\*, objc2-\*
  and stronghold crates, iota-crypto, webview2-com and webview2-com-sys. For these, cargo-about used
  fallback text, so copyright lines may be generic. It reported no failures.
- There is one SBOM per target: `sbom-rust-shell-<target>.cdx.json` (CycloneDX 1.5) for each of the
  three targets. Because cargo-cyclonedx also uses unified features, the component counts are
  427/428/421, compared with 315/315/307 shipped. No shipped crate is missing from them.

## Conservation fold

Each `Cargo.lock` entry is counted once, keyed by name and version, and placed in the first bucket
it matches, in this order.

1. **Workspace crate.** apodictic-tauri 0.1.0.
2. **Shipped.** The union over the three targets of `cargo tree --target T -e normal,no-proc-macro`.
   These are normal edges only, with proc-macros and their subtrees removed, using cargo's feature
   resolver.
3. **Compile-time only.** The union over the three targets of `cargo tree --target T -e normal,build`,
   minus the shipped set. This covers build-deps, proc-macros and their dependencies.
4. **Other-platform only.** Crates in `cargo tree --target all -e normal,build,dev` that are not in
   buckets 1–3. This covers Linux/GTK, Android, iOS and similar.
5. **Lockfile only.** Crates in `Cargo.lock` (and in `cargo metadata`'s resolve) that cargo's feature
   resolver activates on no platform. Examples are chrono, rkyv, schemars and tray-icon.

| Bucket | Count |
| --- | ---: |
| Shipped on at least one target | 354 |
| — ok | 337 |
| — waiver candidate | 11 (keyring, tauri-plugin-stronghold, iota_stronghold, option-ext, bincode, rustls-pemfile, 5 × unic-\*) |
| — unresolved | 6 (reqwest 0.11.27, rand 0.8.5, h2, quick-xml, webview2-com-sys, libsodium-sys-stable) |
| Excluded: compile-time only | 117 |
| Excluded: other-platform only | 230 |
| Excluded: lockfile only (never activated) | 48 |
| Excluded: workspace crate | 1 |
| **Total `[[package]]` entries in Cargo.lock** | **750** |

The total closes: 354 + 117 + 230 + 48 + 1 = 750, and 337 + 11 + 6 = 354. Of the 354 shipped crates,
the per-target counts are 315 (aarch64-apple-darwin), 315 (x86_64-apple-darwin) and 307 (Windows).
268 crates ship on all three targets, 47 on macOS only and 39 on Windows only (268 + 47 + 39 = 354).
The two macOS targets ship identical sets. No entry is unaccounted for. The workspace crate is
excluded from the count, but its empty license is still an open item below.

**Lockfile-only trial (scratch copy, not committed).** On a copy of `src-tauri/`, running
`cargo update -p rand@0.8.5 -p plist -p tauri-utils` moved rand to 0.8.8, plist to 1.10.0 and
quick-xml to 0.41.0. It also moved tauri-utils to 2.10.1 and urlpattern to 0.6.0, and removed all
five unic-\* crates. After that update, cargo-deny no longer reports RUSTSEC-2026-0097, -0194, -0195,
-0081, -0075, -0080, -0100 or -0098. h2, rustls-pemfile and bincode remain, along with the
compile-time-only fxhash, paste and core2. The trial was not built or tested.

## Owner decisions needed

1. **App license.** `src-tauri/Cargo.toml` has `license = ""`, and the public repo has no LICENSE
   file. What license does the APODICTIC desktop shell ship under?
2. **Lockfile refresh.** Do you approve a custody grant to apply the lockfile-only update above (rand,
   plist, tauri-utils)? It clears 8 advisories on shipped crates. It still needs a build and test
   pass.
3. **reqwest 0.11.** Should the direct dependency move to reqwest 0.12 or 0.13 (Cargo.toml plus code)?
   That removes h2 0.3.27 (RUSTSEC-2026-0258, low) and rustls-pemfile (unmaintained). The other option
   is to waive h2 for the alpha.
4. **option-ext (MPL-2.0, all targets).** Do you accept MPL-2.0 for this unmodified crate, with its
   license text and a source pointer in the notices? If yes, it can be added to `deny.toml` as an
   exception for option-ext only.
5. **Stronghold.** iota_stronghold has had no release since 2024-05 and carries bincode 1.3.3
   (unmaintained). Do you waive both for now, or open a replacement question for the keychain →
   Stronghold → DEK chain?
6. **keyring 2.3.3.** The latest release is 4.2.0, and 2.3.3 has no advisory. Do you waive this as an
   old major version, or schedule the upgrade?
7. **libsodium notice.** libsodium is statically linked through libsodium-sys-stable. How should its
   ISC notice be carried: a cargo-about `clarify` entry, or a hand-maintained addendum?
8. **WebView2 loader (Windows).** webview2-com-sys links Microsoft's vendored WebView2 loader. Will
   you obtain the Microsoft WebView2 SDK terms and decide how the Windows notice handles them?
