/* Enter a region and count lit pixels in a Playwright screenshot.
 * WebGL readPixels is empty without preserveDrawingBuffer — the
 * presented frame is what the owner sees. */
import { chromium } from 'playwright-core';
import { inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

function pngLit(buf, thresh = 70) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a png');
  let offset = 8;
  let w = 0;
  let h = 0;
  let color = 6;
  const idats = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      color = data[9];
    } else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let src = 0;
  let lit = 0;
  let maxL = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[src++];
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      let v = raw[src++];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[dst - stride + x] : 0;
      const c = y && x >= bpp ? out[dst - stride + x - bpp] : 0;
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      out[dst + x] = v;
    }
    for (let x = 0; x < w; x++) {
      const i = dst + x * bpp;
      const L = out[i] + out[i + 1] + out[i + 2];
      if (L > thresh) lit++;
      if (L > maxL) maxL = L;
    }
  }
  return { w, h, lit, maxL };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.error('PAGE', e.message);
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('hex-world-builder');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('button[title="Galaxy — the shared catalog"]');
await page.locator('button[title="Galaxy — the shared catalog"]').click();
await page.waitForFunction(() => Boolean(window.__galaxyView?.home), { timeout: 12000 });
await page.waitForTimeout(800);

async function sample(label, path) {
  await page.waitForTimeout(500);
  const meta = await page.evaluate(() => {
    const v = window.__galaxyView;
    return {
      mode: v.currentMode?.(),
      n: v.beaconCount?.(),
      grown: v.grownStars?.(),
      inBall: v.cloudFitsRegion?.(),
    };
  });
  const png = await page.locator('.galaxy-stage').screenshot();
  writeFileSync(path, png);
  const pix = pngLit(png);
  const row = { ...meta, ...pix };
  console.log(label, JSON.stringify(row));
  return row;
}

await page.evaluate(() => window.__galaxyView?.setPreset?.('home'));
const home = await sample('HOME', 'previews/region-pixels-home.png');
if (home.mode !== 'region') errors.push(`home mode ${home.mode}`);
if (!home.n || home.n < 1000) errors.push(`home n ${home.n}`);
if (home.lit < 400) errors.push(`home only ${home.lit} lit pixels (maxL=${home.maxL})`);

await page.click('.gx-crumb');
await page.waitForTimeout(800);
await page.mouse.click(560, 330);
const tap = await sample('TAP', 'previews/region-pixels-tap.png');
if (tap.mode !== 'region') errors.push(`tap mode ${tap.mode}`);
if (!tap.n || tap.n < 500) errors.push(`tap n ${tap.n}`);
if (tap.lit < 200) errors.push(`tap only ${tap.lit} lit pixels (maxL=${tap.maxL})`);

console.log('ERRORS', errors.length ? errors.join('\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
