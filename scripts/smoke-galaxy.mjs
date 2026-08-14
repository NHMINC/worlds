/* Fresh boot + galaxy explorer. Clears IndexedDB, loads the app, opens
 * the catalog, zooms toward home. Run: node scripts/smoke-galaxy.mjs
 * (dev server on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.error('PAGE ERROR:', e.message);
});
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    errors.push(msg.text());
    console.error('CONSOLE:', msg.text());
  }
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('hex-world-builder');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  localStorage.removeItem('wb_last_system');
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);

const boot = await page.evaluate(() => {
  const e = window.__engine;
  const bodies = e ? [...e.bodies?.keys?.() ?? e['bodies']?.keys?.() ?? []] : [];
  let bodyCount = 0;
  try {
    bodyCount = e?.['bodies']?.size ?? 0;
  } catch {
    bodyCount = -1;
  }
  return {
    hasEngine: Boolean(e),
    bodyCount,
    title: document.querySelector('.tb-world')?.textContent ?? document.querySelector('.toolbar')?.innerText?.slice(0, 80) ?? '',
    toolbar: Boolean(document.querySelector('.toolbar, .tb-btn')),
    galaxyHud: Boolean(document.querySelector('.galaxy-explorer')),
  };
});
console.log('BOOT', JSON.stringify(boot));
await page.screenshot({ path: 'previews/galaxy-0-boot.png' });

const galaxyBtn = page.locator('button[title="Galaxy — the shared catalog"]');
if (await galaxyBtn.count()) {
  await galaxyBtn.click();
  await page.waitForTimeout(4000);
  const gx = await page.evaluate(() => ({
    explorer: Boolean(document.querySelector('.galaxy-explorer')),
    loading: document.querySelector('.galaxy-loading')?.textContent ?? null,
    title: document.querySelector('.galaxy-title')?.textContent ?? null,
    sub: document.querySelector('.galaxy-sub')?.textContent ?? null,
    canvas: document.querySelector('.galaxy-stage canvas')?.width ?? 0,
  }));
  console.log('GALAXY', JSON.stringify(gx));
  await page.screenshot({ path: 'previews/galaxy-1-face.png' });

  const home = page.locator('button.gx-chip', { hasText: 'Home' });
  if (await home.count()) {
    await home.click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: 'previews/galaxy-2-home.png' });
  }
  const face = page.locator('button.gx-chip', { hasText: 'Face-on' });
  if (await face.count()) await face.click();
  await page.waitForTimeout(500);
} else {
  console.error('NO GALAXY BUTTON');
}

console.log('ERRORS', errors.length ? errors.join('\n---\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
