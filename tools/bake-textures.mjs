// Bakes the browser build's procedural terrazzo floor (js/render.js
// _floorTexture: two octaves of tileable value noise plus sparse chips,
// authored at 256 px and sampled in 256-px units) into assets/terrazzo-<N>.png
// for the three sizes the presets use (128 Low/plain, 256, 512 Ultra). The
// per-pixel loop is ~20× slower in the engine's interpreter, so it runs here
// once; the code is render.js's, unchanged. Run `node tools/bake-textures.mjs`.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, W) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const h = (p, q) => hash2(((p % W) + W) % W, ((q % W) + W) % W);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v - 0.5;
}
function terrazzo(N) {
  const u = 256 / N;
  const px = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const n1 = vnoise(x * u / 32, y * u / 32, 8), n2 = vnoise(x * u / 8, y * u / 8, 32);
    let v = 0.86 + n1 * 0.08 + n2 * 0.04;
    const chip = hash2(Math.floor(x * u), Math.floor(y * u));
    if (chip > 0.985) v += 0.12; else if (chip < 0.012) v -= 0.1;
    px[y * N + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return px;
}
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(N, grey) {
  const raw = Buffer.alloc(N * (N * 3 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 3 + 1)] = 0;
    for (let x = 0; x < N; x++) { const v = grey[y * N + x], o = y * (N * 3 + 1) + 1 + x * 3; raw[o] = raw[o + 1] = raw[o + 2] = v; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
for (const N of [128, 256, 512]) {
  writeFileSync(new URL(`../assets/terrazzo-${N}.png`, import.meta.url), png(N, terrazzo(N)));
  console.log(`assets/terrazzo-${N}.png`);
}
