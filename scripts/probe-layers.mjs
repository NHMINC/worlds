/* Layer isolation: show ONE layer per screenshot to find which draws
 * the polar needle. Run: node scripts/probe-layers.mjs */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await page.click('button[title="Galaxy — the shared catalog"]');
await page.waitForTimeout(2500);
await page.waitForFunction(() => Boolean(window.__galaxyView?.home), { timeout: 8000 });
await page.evaluate(() => {
  const v = window.__galaxyView;
  v.setPreset('home');
});
await page.waitForTimeout(3000);
// Freeze the camera so every shot frames the same sky.
await page.evaluate(() => {
  const v = window.__galaxyView;
  v.tgtRadius = 14;
  v.radius = 14;
});
await page.waitForTimeout(600);

for (const [name, expr] of [
  ['only-field', 'v.fieldMesh.visible = true'],
  ['only-beacons', 'v.starPts.visible = true; v.nebPts.visible = true'],
  ['only-discs', 'v.discs.group.visible = true'],
  ['only-rings', 'v.homeRing.visible = true; v.hereRing.visible = true; v.pickRing.visible = true'],
]) {
  await page.evaluate((code) => {
    const v = window.__galaxyView;
    v.starPts.visible = false;
    v.nebPts.visible = false;
    v.fieldMesh.visible = false;
    v.discs.group.visible = false;
    v.homeRing.visible = false;
    v.hereRing.visible = false;
    v.pickRing.visible = false;
    // eslint-disable-next-line no-eval
    eval(code);
  }, expr);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `previews/probe-${name}.png` });
  console.log('probe', name);
}
await browser.close();
