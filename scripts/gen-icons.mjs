// Generates the PNG app icons (PWA + apple-touch) without any image deps:
// draws a hexagon into an RGBA buffer and encodes a PNG by hand via zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(out, { recursive: true });

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (v) => [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
const BG = hex('#0e1116');
const RING = hex('#7fa88b');
const INNER = hex('#57805e');
const SQRT3 = Math.sqrt(3);

// Pointy-top hexagon membership test.
function inHex(dx, dy, s) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  return ax <= (s * SQRT3) / 2 && ay <= s - ax / SQRT3;
}

function draw(size, fullBleed) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const ring = size * 0.36;
  const ringW = size * 0.05;
  const inner = size * 0.185;
  const corner = fullBleed ? 0 : size * 0.21;
  const SS = 3; // supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // Rounded-square background (or full bleed for maskable).
          const qx = Math.max(Math.abs(px - c) - (c - corner), 0);
          const qy = Math.max(Math.abs(py - c) - (c - corner), 0);
          const inBg = fullBleed || Math.hypot(qx, qy) <= corner;
          if (!inBg) continue;
          const dx = px - c;
          const dy = py - c;
          let col = BG;
          if (inHex(dx, dy, inner)) col = INNER;
          else if (inHex(dx, dy, ring) && !inHex(dx, dy, ring - ringW)) col = RING;
          r += col[0];
          g += col[1];
          b += col[2];
          a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

for (const [name, size, fullBleed] of [
  ['pwa-192.png', 192, false],
  ['pwa-512.png', 512, false],
  ['pwa-512-maskable.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]) {
  writeFileSync(join(out, name), encodePNG(size, draw(size, fullBleed)));
  console.log('wrote', name);
}
