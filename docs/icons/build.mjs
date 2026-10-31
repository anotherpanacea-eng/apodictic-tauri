// Rebuilds src-tauri/icons and the favicon set from the hand-pixeled grids
// (sprites.json, used at 16/32/48 px) and the vector master (mark.svg, used
// at 64 px and above). Run: node docs/icons/build.mjs  (see README.md for the Playwright setup).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const iconsDir = join(root, 'src-tauri', 'icons');
const favDir = join(here, 'favicon');
mkdirSync(favDir, { recursive: true });

const sprites = JSON.parse(readFileSync(join(here, 'sprites.json'), 'utf8'));
const svg = readFileSync(join(here, 'mark.svg'), 'utf8');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Nearest-neighbour: each grid pixel becomes scale x scale output pixels.
function gridPng(n, scale = 1) {
  const rows = sprites.grids[String(n)];
  if (!rows || rows.length !== n || rows.some((r) => r.length !== n)) throw new Error(`grid ${n} is not ${n}x${n}`);
  const size = n * scale;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const hex = sprites.palette[rows[Math.floor(y / scale)][Math.floor(x / scale)]];
    if (hex === undefined) throw new Error(`unknown colour key in grid ${n}`);
    if (!hex) continue;
    const i = (y * size + x) * 4;
    rgba[i] = parseInt(hex.slice(1, 3), 16); rgba[i + 1] = parseInt(hex.slice(3, 5), 16);
    rgba[i + 2] = parseInt(hex.slice(5, 7), 16); rgba[i + 3] = 255;
  }
  return encodePng(size, rgba);
}

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
async function vectorPng(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const png = (size) => (sprites.grids[String(size)] ? gridPng(size) : vectorPng(size));
const out = {};
for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) out[s] = await png(s);

function ico(sizes) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  const dir = []; const bodies = []; let offset = 6 + 16 * sizes.length;
  for (const s of sizes) {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(out[s].length, 8); e.writeUInt32LE(offset, 12);
    offset += out[s].length; dir.push(e); bodies.push(out[s]);
  }
  return Buffer.concat([head, ...dir, ...bodies]);
}
function icns() {
  const types = [['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]];
  const parts = types.map(([t, s]) => {
    const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(out[s].length + 8, 4);
    return Buffer.concat([h, out[s]]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

const write = (dir, name, buf) => writeFileSync(join(dir, name), buf);
write(iconsDir, '32x32.png', out[32]);
write(iconsDir, '128x128.png', out[128]);
write(iconsDir, '128x128@2x.png', out[256]);
write(iconsDir, 'icon.png', out[512]);
for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) write(iconsDir, `Square${s}x${s}Logo.png`, await vectorPng(s));
write(iconsDir, 'StoreLogo.png', await vectorPng(50));
write(iconsDir, 'icon.ico', ico([16, 32, 48, 256]));
write(iconsDir, 'icon.icns', icns());

write(here, 'master-1024.png', out[1024]);
for (const s of [16, 32, 48]) write(here, `pixel-${s}@8x.png`, gridPng(s, 8));
write(favDir, 'favicon.ico', ico([16, 32, 48]));
write(favDir, 'favicon-16.png', out[16]);
write(favDir, 'favicon-32.png', out[32]);
write(favDir, 'apple-touch-icon.png', await vectorPng(180));
write(favDir, 'favicon.svg', Buffer.from(svg));
await browser.close();
console.log('icons rebuilt');
