/* Fresh boot + the sector-map galaxy explorer. Clears IndexedDB, loads
 * the app, opens the map, dives into an arc, taps a star, sets course.
 * Run: node scripts/smoke-galaxy.mjs (dev server on :5173). */
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
  let bodyCount = 0;
  try {
    bodyCount = e?.['bodies']?.size ?? 0;
  } catch {
    bodyCount = -1;
  }
  return {
    hasEngine: Boolean(e),
    bodyCount,
    toolbar: Boolean(document.querySelector('.toolbar, .tb-btn')),
  };
});
console.log('BOOT', JSON.stringify(boot));

const galaxyBtn = page.locator('button[title="Galaxy — the shared catalog"]');
if (await galaxyBtn.count()) {
  await galaxyBtn.click();
  await page.waitForTimeout(4000);
  const gx = await page.evaluate(() => ({
    explorer: Boolean(document.querySelector('.galaxy-explorer')),
    title: document.querySelector('.galaxy-title')?.textContent ?? null,
    sub: document.querySelector('.galaxy-sub')?.textContent ?? null,
    mode: window.__galaxyView?.currentMode?.() ?? null,
  }));
  console.log('MAP', JSON.stringify(gx));
  await page.screenshot({ path: 'previews/galaxy-1-map.png' });
  if (gx.mode !== 'map') errors.push(`expected map mode, got ${gx.mode}`);

  await page.waitForFunction(() => Boolean(window.__galaxyView?.home), { timeout: 8000 });

  // Tap the home marker: enters home's arc with the star selected.
  const ring = await page.evaluate(() => {
    const v = window.__galaxyView;
    return v.projectClient(v.home);
  });
  console.log('HOME MARKER', JSON.stringify(ring));
  if (ring) {
    await page.mouse.click(ring.x, ring.y);
    await page.waitForTimeout(2500);
  }
  const arc = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    sector: window.__galaxyView?.currentSector?.() ?? null,
    stars: window.__galaxyView?.beaconCount?.() ?? 0,
    dossier: document.querySelector('.gd-class')?.textContent ?? null,
    crumb: Boolean(document.querySelector('.gx-crumb')),
  }));
  console.log('ARC', JSON.stringify(arc));
  await page.screenshot({ path: 'previews/galaxy-2-arc.png' });
  if (arc.mode !== 'arc') errors.push('tapping home marker did not enter its arc');
  if (!arc.stars || arc.stars < 100) errors.push(`arc loaded only ${arc.stars} stars`);
  if (!arc.dossier) errors.push('home marker tap did not open a dossier');

  // Approach: park next to the selected star; photospheres must mesh.
  const approached = await page.evaluate(() => {
    const v = window.__galaxyView;
    const o = v.approachNearest?.();
    return o ? { id: o.id, phase: o.star.phase } : null;
  });
  console.log('APPROACH', JSON.stringify(approached));
  await page.waitForTimeout(800);
  const close = await page.evaluate(() => {
    const v = window.__galaxyView;
    const discs = v.resolvedStars?.() ?? [];
    const target = discs.find((o) => o.id === v.selectedObject?.()?.id) ?? discs[0];
    const first = target ? v.projectClient(target) : null;
    return { n: discs.length, first, radius: v.radius ?? null };
  });
  console.log('DISCS', JSON.stringify(close));
  await page.screenshot({ path: 'previews/galaxy-3-discs.png' });
  if (!close.n) errors.push('no photospheres inside the arc');

  // Back out to the map via the breadcrumb, then re-enter by tapping a tile.
  await page.click('.gx-crumb');
  await page.waitForTimeout(1200);
  const backOut = await page.evaluate(() => window.__galaxyView?.currentMode?.() ?? null);
  console.log('BACK', JSON.stringify({ mode: backOut }));
  if (backOut !== 'map') errors.push('breadcrumb did not return to the map');
  await page.waitForTimeout(1800);
  await page.mouse.click(560, 330);
  await page.waitForTimeout(2000);
  const arc2 = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    sector: window.__galaxyView?.currentSector?.()?.name ?? null,
    stars: window.__galaxyView?.beaconCount?.() ?? 0,
  }));
  console.log('ARC 2', JSON.stringify(arc2));
  await page.screenshot({ path: 'previews/galaxy-4-arc2.png' });
  if (arc2.mode !== 'arc') errors.push('tapping a tile did not enter an arc');

  // Set course from a disc: tap it and the explorer should close.
  const goBack = await page.evaluate(() => {
    const v = window.__galaxyView;
    v.setPreset('home');
    return true;
  });
  console.log('HOME PRESET', goBack);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__galaxyView?.approachNearest?.());
  await page.waitForTimeout(800);
  const tapPos = await page.evaluate(() => {
    const v = window.__galaxyView;
    const discs = v.resolvedStars?.() ?? [];
    const target = discs.find((o) => o.id === v.selectedObject?.()?.id) ?? discs[0];
    return target ? v.projectClient(target) : null;
  });
  const tap = tapPos && tapPos.x > 40 && tapPos.x < 1240 && tapPos.y > 40 && tapPos.y < 760
    ? tapPos
    : { x: 640, y: 400 };
  await page.mouse.click(tap.x, tap.y);
  try {
    await page.waitForFunction(() => !document.querySelector('.galaxy-explorer'), { timeout: 20000 });
  } catch {
    console.error('FAIL: tapping a rendered star did not set course');
    errors.push('rendered star tap did not set course');
  }
  const afterGo = await page.evaluate(() => ({
    explorer: Boolean(document.querySelector('.galaxy-explorer')),
    title: document.querySelector('.tb-world')?.textContent ?? '',
  }));
  console.log('AFTER DISC TAP', JSON.stringify(afterGo));
  await page.screenshot({ path: 'previews/galaxy-5-tap.png' });
} else {
  console.error('NO GALAXY BUTTON');
  errors.push('no galaxy button');
}

const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await phone.waitForTimeout(2500);
await phone.click('button[title="Galaxy — the shared catalog"]');
await phone.waitForTimeout(1500);
const phoneUi = await phone.evaluate(() => ({
  homeChip: Boolean([...document.querySelectorAll('button.gx-chip')].find((b) => b.textContent === 'Home')),
}));
console.log('PHONE', JSON.stringify(phoneUi));
await phone.screenshot({ path: 'previews/galaxy-6-phone.png' });
if (!phoneUi.homeChip) {
  console.error('FAIL: Home chip hidden on a phone-sized viewport');
  errors.push('home chip hidden on phone');
}
await phone.close();

console.log('ERRORS', errors.length ? errors.join('\n---\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
