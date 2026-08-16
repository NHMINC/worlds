/* Fresh boot + the galaxy explorer. Clears IndexedDB, loads the app,
 * waits for the universe mint, lands in the region on a living host,
 * checks Face-on / Edge-on / Back / Home, taps a star, sets course.
 * Run: node scripts/smoke-galaxy.mjs (dev server on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// SwiftShader rasterizes the cloud march on the CPU; a single busy
// frame can take tens of seconds. Real GPUs do not.
page.setDefaultTimeout(120000);
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
await page.waitForSelector('.universe-boot, .galaxy-explorer', { timeout: 30000 });
await page.waitForFunction(() => {
  const splash = document.getElementById('universe-boot');
  const gx = document.querySelector('.galaxy-explorer');
  return !splash && Boolean(gx) && !gx.classList.contains('is-dormant');
}, { timeout: 90000 });
await page.waitForTimeout(800);

const boot = await page.evaluate(() => {
  const e = window.__engine;
  let bodyCount = 0;
  try {
    bodyCount = e?.['bodies']?.size ?? 0;
  } catch {
    bodyCount = -1;
  }
  const gx = document.querySelector('.galaxy-explorer');
  return {
    hasEngine: Boolean(e),
    bodyCount,
    preparing: Boolean(document.getElementById('universe-boot')),
    explorer: Boolean(gx) && !gx.classList.contains('is-dormant'),
  };
});
console.log('BOOT', JSON.stringify(boot));
if (!boot.explorer) errors.push('empty save did not open the galaxy');
if (boot.preparing) errors.push('preparing overlay still up after reveal');

{
  const gx = await page.evaluate(() => ({
    explorer: Boolean(document.querySelector('.galaxy-explorer')),
    title: document.querySelector('.galaxy-title')?.textContent ?? null,
    sub: document.querySelector('.galaxy-sub')?.textContent ?? null,
    mode: window.__galaxyView?.currentMode?.() ?? null,
    selected: window.__galaxyView?.selectedObject?.()?.id ?? null,
    here: window.__galaxyView?.here?.()?.id ?? null,
    home: window.__galaxyView?.home?.id ?? null,
  }));
  console.log('OPEN', JSON.stringify(gx));
  await page.screenshot({ path: 'previews/galaxy-1-region.png' });
  if (gx.mode !== 'region') errors.push(`expected region mode on open, got ${gx.mode}`);
  const expectId = gx.here ?? gx.home;
  if (expectId != null && gx.selected !== expectId) {
    errors.push(`opened on ${gx.selected}, not here/home ${expectId}`);
  }

  await page.waitForFunction(() => (window.__galaxyView?.beaconCount?.() ?? 0) > 8_000, { timeout: 25000 });
  await page.waitForFunction(() => Boolean(window.__galaxyView?.home), { timeout: 8000 });

  const arc = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    region: window.__galaxyView?.currentRegion?.() ?? null,
    stars: window.__galaxyView?.beaconCount?.() ?? 0,
    inBall: window.__galaxyView?.cloudFitsRegion?.() ?? false,
    dossier: document.querySelector('.gd-class')?.textContent ?? null,
  }));
  console.log('REGION', JSON.stringify(arc));
  await page.screenshot({ path: 'previews/galaxy-2-arc.png' });
  if (arc.mode !== 'region') errors.push('empty boot did not open the region');
  if (!arc.stars || arc.stars < 8_000) errors.push(`region loaded only ${arc.stars} stars`);
  if (!arc.inBall) errors.push('region cloud has stars outside the ball');
  if (!arc.dossier) errors.push('open did not select the loaded star');

  const beforeOverview = await page.evaluate(() => window.__galaxyView?.currentRegion?.() ?? null);
  await page.evaluate(() => window.__galaxyView?.setPreset?.('face'));
  await page.waitForTimeout(1200);
  const face = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    region: window.__galaxyView?.currentRegion?.() ?? null,
  }));
  const faceR = face.region ? Math.hypot(face.region.x, face.region.y, face.region.z) : 0;
  console.log('FACE', JSON.stringify({ ...face, r: faceR }));
  await page.screenshot({ path: 'previews/galaxy-1-face.png' });
  if (face.mode !== 'region') errors.push('Face-on left the region');
  if (faceR < 20) errors.push(`Face-on bubble not far enough (${faceR})`);

  await page.evaluate(() => window.__galaxyView?.setPreset?.('edge'));
  await page.waitForTimeout(1200);
  const edge = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    region: window.__galaxyView?.currentRegion?.() ?? null,
  }));
  const edgeR = edge.region ? Math.hypot(edge.region.x, edge.region.y, edge.region.z) : 0;
  console.log('EDGE', JSON.stringify({ ...edge, r: edgeR }));
  await page.screenshot({ path: 'previews/galaxy-1b-edge.png' });
  if (edge.mode !== 'region') errors.push('Edge-on left the region');
  if (edgeR < 20) errors.push(`Edge-on bubble not far enough (${edgeR})`);

  await page.evaluate(() => window.__galaxyView?.setPreset?.('back'));
  await page.waitForFunction(() => (window.__galaxyView?.beaconCount?.() ?? 0) > 8_000, { timeout: 25000 });
  const back = await page.evaluate(() => window.__galaxyView?.currentRegion?.() ?? null);
  const backD = beforeOverview && back
    ? Math.hypot(back.x - beforeOverview.x, back.y - beforeOverview.y, back.z - beforeOverview.z)
    : 99;
  console.log('BACK', JSON.stringify({ back, d: backD }));
  if (backD > 0.2) errors.push(`Back did not restore the pre-overview pose (${backD})`);

  await page.evaluate(() => window.__galaxyView?.setPreset?.('home'));
  await page.waitForFunction(() => (window.__galaxyView?.beaconCount?.() ?? 0) > 8_000, { timeout: 25000 });
  const homeDive = await page.evaluate(() => ({
    mode: window.__galaxyView?.currentMode?.() ?? null,
    selected: window.__galaxyView?.selectedObject?.()?.id ?? null,
    here: window.__galaxyView?.here?.()?.id ?? null,
    home: window.__galaxyView?.home?.id ?? null,
    dossier: document.querySelector('.gd-class')?.textContent ?? null,
  }));
  console.log('HOME', JSON.stringify(homeDive));
  if (homeDive.mode !== 'region') errors.push('Home left the region');
  const homeExpect = homeDive.here ?? homeDive.home;
  if (homeExpect != null && homeDive.selected !== homeExpect) {
    errors.push(`Home selected ${homeDive.selected}, not ${homeExpect}`);
  }
  if (!homeDive.dossier) errors.push('Home did not open a dossier');

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
    const pointTap = await page.evaluate(() => {
      const gx = document.querySelector('.galaxy-explorer');
      return {
        explorer: Boolean(gx) && !gx.classList.contains('is-dormant'),
        id: window.__galaxyView?.selectedObject?.()?.id ?? null,
      };
    });
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
  if (!strafe || strafe.bubbleMoved < 0.02) errors.push('strafe did not slide the catalog bubble');
  if (strafe && strafe.camAtOrigin > 1e-4) errors.push('camera left the bubble centre');

  // Approach: park next to the selected star; its point must grow.
  const approached = await page.evaluate(() => {
    const v = window.__galaxyView;
    const o = v.approachNearest?.();
    return o ? { id: o.id, phase: o.star.phase } : null;
  });
  console.log('APPROACH', JSON.stringify(approached));
  await page.waitForSelector('.gx-plate', { timeout: 60000 });
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
    await page.waitForFunction(() => {
      const gx = document.querySelector('.galaxy-explorer');
      return Boolean(gx?.classList.contains('is-dormant'));
    }, { timeout: 20000 });
  } catch {
    console.error('FAIL: Set course did not leave the explorer');
    errors.push('Set course did not leave the explorer');
  }
  const afterGo = await page.evaluate(() => {
    const gx = document.querySelector('.galaxy-explorer');
    return {
      explorer: Boolean(gx) && !gx.classList.contains('is-dormant'),
      kept: Boolean(gx),
      splash: Boolean(document.getElementById('universe-boot')),
      title: document.querySelector('.tb-world')?.textContent ?? '',
    };
  });
  console.log('AFTER DISC TAP', JSON.stringify(afterGo));
  await page.screenshot({ path: 'previews/galaxy-5-tap.png' });
  if (afterGo.explorer) errors.push('Set course left the explorer visible');
  if (!afterGo.kept) errors.push('Set course unmounted the explorer');
  if (afterGo.splash) errors.push('Set course revived the boot splash');
}

const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await phone.waitForFunction(() => !document.getElementById('universe-boot'), { timeout: 90000 });
const phoneGalaxy = phone.locator('button[title="Galaxy — the shared catalog"]');
if (await phoneGalaxy.count()) {
  await phoneGalaxy.click({ force: true });
} else {
  await phone.waitForFunction(() => {
    const gx = document.querySelector('.galaxy-explorer');
    return Boolean(gx) && !gx.classList.contains('is-dormant');
  }, { timeout: 90000 });
}
await phone.waitForTimeout(1500);
const phoneUi = await phone.evaluate(() => {
  const gx = document.querySelector('.galaxy-explorer');
  return {
    homeChip: Boolean([...document.querySelectorAll('button.gx-chip')].find((b) => b.textContent === 'Home')),
    splash: Boolean(document.getElementById('universe-boot')),
    explorer: Boolean(gx) && !gx.classList.contains('is-dormant'),
  };
});
console.log('PHONE', JSON.stringify(phoneUi));
await phone.screenshot({ path: 'previews/galaxy-6-phone.png' });
if (!phoneUi.homeChip) {
  console.error('FAIL: Home chip hidden on a phone-sized viewport');
  errors.push('home chip hidden on phone');
}
if (phoneUi.splash) errors.push('opening the galaxy map showed the boot splash again');
if (!phoneUi.explorer) errors.push('phone galaxy map did not reveal the kept explorer');
await phone.close();

console.log('ERRORS', errors.length ? errors.join('\n---\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
