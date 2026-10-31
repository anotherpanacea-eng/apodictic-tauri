# App icon

The APODICTIC mark (logo "A" on a cream disc, gold underline arc, navy tile) in the logo palette: navy `#17324D`, cream `#F4EBDD`, gold `#C68A2D`.

- `sprites.json`: hand-pixeled grids for 16, 32 and 48 px. One character per pixel (`N` navy, `C` cream, `G` gold, `.` transparent). Edit these by hand; they are the small sizes, not downscales.
- `mark.svg`: the vector master, used at 64 px and above. `master-1024.png` is its 1024 px render.
- `pixel-*@8x.png`: 8x nearest-neighbour previews of the grids, for review.
- `favicon/`: `favicon.ico` (16/32/48), `favicon-16.png`, `favicon-32.png`, `favicon.svg` and a 180 px `apple-touch-icon.png`, ready for the download page.

`node docs/icons/build.mjs` rebuilds `src-tauri/icons` (PNG sizes, `icon.ico` with 16/32/48 from the grids plus 256, `icon.icns` with 16/32 from the grids plus 128 to 1024) and everything above. It needs Playwright for the vector renders.
