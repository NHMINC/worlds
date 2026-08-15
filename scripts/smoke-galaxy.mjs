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

  // Oblique (~79°) — the bulge must be a dome, not a golden cone.
  await page.evaluate(() => window.__galaxyView?.setPreset?.('edge'));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'previews/galaxy-1b-oblique.png' });
  await page.evaluate(() => window.__galaxyView?.setPreset?.('face'));
  await page.waitForTimeout(800);

  // Tap the home marker: enters home's arc with the star selected.
  const ring = await page.evaluate(() => {
    const v = window.__galaxyView;
    return v.projectClient(v.home);
  });
  console.log('HOME MARKER', JSON.stringify(ring));
  if (ring) {
    await page.mouse.click(ring.x, ring.y);
    await page.waitForFunction(() => (window.__galaxyView?.beaconCount?.() ?? 0) > 8_000, { timeout: 25000 });
    await page.waitForTimeout(400);
  }
  const arc = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    region: window.__galaxyView?.currentRegion?.() ?? null,
    stars: window.__galaxyView?.beaconCount?.() ?? 0,
    inBall: window.__galaxyView?.cloudFitsRegion?.() ?? false,
    dossier: document.querySelector('.gd-class')?.textContent ?? null,
    crumb: Boolean(document.querySelector('.gx-crumb')),
  }));
  console.log('REGION', JSON.stringify(arc));
  await page.screenshot({ path: 'previews/galaxy-2-arc.png' });
  if (arc.mode !== 'region') errors.push('tapping home marker did not enter its region');
  if (!arc.stars || arc.stars < 8_000) errors.push(`region loaded only ${arc.stars} stars`);
  if (!arc.inBall) errors.push('region cloud has stars outside the ball');
  if (!arc.dossier) errors.push('home marker tap did not open a dossier');

  const survey = await page.evaluate(() => {
    const v = window.__galaxyView;
    v.applyCam?.();
    return {
      n: v.beaconCount?.() ?? 0,
      ms: v.lastEnterMs ?? null,
      point: v.probePointStar?.() ?? null,
      grownAtOverview: v.grownStars?.() ?? 0,
    };
  });
  console.log('CLOUD', JSON.stringify(survey));
  if (survey.n < 8_000) errors.push(`cloud ${survey.n} is not the region`);

  // A point star must open the dossier, not set course.
  if (survey.point) {
    await page.mouse.click(survey.point.x, survey.point.y);
    await page.waitForTimeout(600);
    const pointTap = await page.evaluate(() => ({
      explorer: Boolean(document.querySelector('.galaxy-explorer')),
      id: window.__galaxyView?.selectedObject?.()?.id ?? null,
    }));
    console.log('POINT TAP', JSON.stringify(pointTap));
    if (!pointTap.explorer) errors.push('tapping a survey star set course instead of selecting');
    if (pointTap.id !== survey.point.id) errors.push('tapping a survey star did not select it');
  } else {
    errors.push('no on-screen survey star to tap');
  }

  // Overview: turning in place keeps the same frozen cloud.
  await page.evaluate(() => window.__galaxyView?.orbitBy?.(1.35, -0.4));
  await page.waitForTimeout(400);
  const afterLook = await page.evaluate(() => ({
    n: window.__galaxyView?.beaconCount?.() ?? 0,
    mode: window.__galaxyView?.currentMode?.() ?? null,
  }));
  console.log('LOOK', JSON.stringify(afterLook));
  if (afterLook.n !== survey.n) errors.push('looking around rebuilt the cloud');
  await page.screenshot({ path: 'previews/galaxy-2b-orbit.png' });

  const strafe = await page.evaluate(() => {
    const v = window.__galaxyView;
    const c0 = v.arcCenter.clone();
    const p0 = v.camera.position.clone();
    v.flyStrafe?.(0.45);
    const c1 = v.arcCenter;
    const p1 = v.camera.position;
    return {
      camMoved: Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z),
      bubbleMoved: Math.hypot(c1.x - c0.x, c1.y - c0.y, c1.z - c0.z),
      camAtOrigin: Math.hypot(p1.x, p1.y, p1.z),
    };
  });
  console.log('STRAFE', JSON.stringify(strafe));
  if (!strafe || strafe.bubbleMoved < 0.02) errors.push('strafe did not slide the magnification sphere');
  if (strafe && strafe.camAtOrigin > 1e-4) errors.push('camera left the bubble centre');

  // Approach: park next to the selected star; its point must grow.
  const approached = await page.evaluate(() => {
    const v = window.__galaxyView;
    const o = v.approachNearest?.();
    return o ? { id: o.id, phase: o.star.phase } : null;
  });
  console.log('APPROACH', JSON.stringify(approached));
  await page.waitForSelector('.gx-plate', { timeout: 8000 });
  const close = await page.evaluate(() => {
    const v = window.__galaxyView;
    const id = v.selectedObject?.()?.id ?? v.focusedObject?.()?.id;
    const first = v.selectedObject?.() ? v.projectClient(v.selectedObject()) : null;
    return {
      grown: v.grownStars?.() ?? 0,
      ang: id != null ? v.pointApparent?.(id) ?? 0 : 0,
      first,
      radius: v.radius ?? null,
    };
  });
  console.log('CLOSE', JSON.stringify(close));
  await page.screenshot({ path: 'previews/galaxy-3-discs.png' });
  if (!close.ang) errors.push('approached star has no apparent size');
  if (close.grown < 1) errors.push('no grown points after approaching a star');

  const grow = await page.evaluate(() => {
    const v = window.__galaxyView;
    const id = v.selectedObject?.()?.id ?? v.focusedObject?.()?.id;
    if (id == null) return null;
    const a0 = v.pointApparent?.(id) ?? 0;
    v.flyAlong?.(0.01);
    v.syncArc?.();
    const a1 = v.pointApparent?.(id) ?? 0;
    return { id, a0, a1, grown: v.grownStars?.() ?? 0 };
  });
  await page.waitForTimeout(200);
  const plate = await page.locator('.gx-plate').count();
  console.log('GROW', JSON.stringify({ ...grow, plate }));
  if (!grow || grow.a0 <= 0) errors.push('approached star has no growing point');
  if (grow && grow.a1 <= grow.a0 * 1.02) errors.push(`star did not grow on approach ${grow.a0} → ${grow.a1}`);
  if (!plate) errors.push('no compact sight HUD after approaching a star');

  // Back out to the map via the breadcrumb, then re-enter by tapping the saucer.
  await page.click('.gx-crumb');
  await page.waitForTimeout(1200);
  const backOut = await page.evaluate(() => window.__galaxyView?.currentMode?.() ?? null);
  console.log('BACK', JSON.stringify({ mode: backOut }));
  if (backOut !== 'map') errors.push('breadcrumb did not return to the map');
  await page.waitForTimeout(1800);
  await page.mouse.click(560, 330);
  await page.waitForFunction(() => (window.__galaxyView?.beaconCount?.() ?? 0) > 1_000, { timeout: 30000 });
  await page.waitForTimeout(400);
  const arc2 = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    region: window.__galaxyView?.currentRegion?.()?.name ?? null,
    stars: window.__galaxyView?.beaconCount?.() ?? 0,
    inBall: window.__galaxyView?.cloudFitsRegion?.() ?? false,
  }));
  console.log('REGION 2', JSON.stringify(arc2));
  await page.screenshot({ path: 'previews/galaxy-4-arc2.png' });
  if (arc2.mode !== 'region') errors.push('tapping the saucer did not enter a region');
  if (arc2.stars < 1_000) errors.push(`saucer tap loaded only ${arc2.stars} stars`);
  if (!arc2.inBall) errors.push('saucer-tap cloud has stars outside the ball');

  // Latched warp: one tap accelerates, Stop brakes (same path as ↑ / ↓).
  const beforeCruise = await page.evaluate(() => window.__galaxyView?.currentRegion?.() ?? null);
  const warpBtn = page.locator('button.gx-warp');
  if (await warpBtn.count()) {
    await warpBtn.click();
  } else {
    await page.evaluate(() => window.__galaxyView?.setWarp?.(true));
  }
  await page.waitForTimeout(2000);
  const afterCruise = await page.evaluate(() => {
    window.__galaxyView?.setWarp?.(false);
    return window.__galaxyView?.currentRegion?.() ?? null;
  });
  const cruiseD = beforeCruise && afterCruise
    ? Math.hypot(afterCruise.x - beforeCruise.x, afterCruise.y - beforeCruise.y, afterCruise.z - beforeCruise.z)
    : 0;
  console.log('WARP', JSON.stringify({ before: beforeCruise, after: afterCruise, d: cruiseD }));
  // Headless SwiftShader throttles rAF hard under the dust raymarch, so
  // assert the bubble MOVED (latch engaged), not a real-GPU pace.
  if (cruiseD < 0.0002) errors.push(`warp did not slide the bubble (${cruiseD})`);

  // Set course is the dossier button — a star tap only selects.
  const goBack = await page.evaluate(() => {
    const v = window.__galaxyView;
    v.setPreset('home');
    return true;
  });
  console.log('HOME PRESET', goBack);
  await page.waitForFunction(() => (window.__galaxyView?.currentMode?.() === 'region') && (window.__galaxyView?.beaconCount?.() ?? 0) > 8_000, { timeout: 25000 });
  await page.evaluate(() => window.__galaxyView?.approachNearest?.());
  await page.waitForTimeout(800);
  const goBtn = page.locator('button.gd-go');
  if (await goBtn.count()) {
    await goBtn.click();
  } else {
    errors.push('Set course button missing after selecting a star');
  }
  try {
    await page.waitForFunction(() => !document.querySelector('.galaxy-explorer'), { timeout: 20000 });
  } catch {
    console.error('FAIL: Set course did not leave the explorer');
    errors.push('Set course did not leave the explorer');
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
await phone.waitForSelector('button[title="Galaxy — the shared catalog"]');
await phone.waitForTimeout(2500);
await phone.locator('button[title="Galaxy — the shared catalog"]').click({ force: true });
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
