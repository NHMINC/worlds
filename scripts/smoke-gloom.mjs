/* Hothouse ground gloom: land on a deep-atmosphere world at noon. Single
 * scatter alone renders this near-black; the diffusion floor should give
 * dim, shadowless, chemistry-tinted gloom that brightens with altitude.
 * Usage: node scripts/smoke-gloom.mjs [seed] [bodyId] */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const seed = process.argv[2] ?? 'dusk-3';
const bodyId = process.argv[3] ?? 'p2';
mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill(seed);
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);
await page.evaluate((id) => window.__engine.travelTo(id), bodyId);
await page.waitForTimeout(6000);

await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);

async function shot(eyeH, pitch, file) {
  await page.evaluate(({ eyeH, pitch }) => {
    const e = window.__engine;
    const rt = e['bodies'].get(e['orbitBodyId']);
    const qInv = rt.spinQ.clone().conjugate();
    const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
    e['sDir'].copy(sunL); // substellar point: local noon
    e['sYaw'] = 1.2;
    e['sPitch'] = pitch;
    e['sEyeH'] = e['sEyeHTarget'] = eyeH;
  }, { eyeH, pitch });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `previews/${file}` });
}

await shot(0.012, 0.05, 'gloom-1-ground.png');
await shot(0.012, 1.2, 'gloom-2-ground-up.png');
await shot(0.2, 0.1, 'gloom-3-high.png');
await browser.close();
