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
  if (!arc.stars || arc.stars < 80_000) errors.push(`arc loaded only ${arc.stars} stars (want the whole population)`);
  if (!arc.dossier) errors.push('home marker tap did not open a dossier');

  const survey = await page.evaluate(() => {
    const v = window.__galaxyView;
    v.applyCam?.();
    return {
      n: v.beaconCount?.() ?? 0,
      ms: v.lastEnterMs ?? null,
      point: v.probePointStar?.() ?? null,
      discsAtOverview: v.resolvedStars?.()?.length ?? 0,
    };
  });
  console.log('CLOUD', JSON.stringify(survey));
  if (survey.n < 80_000) errors.push(`cloud ${survey.n} is not the full arc`);
  if (survey.discsAtOverview > 0) errors.push(`overview meshed ${survey.discsAtOverview} highlight discs — brightness should be the IMF, not a sample`);

  // A point star (not one of the 28 discs) must open the dossier, not set course.
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
    errors.push('no on-screen survey star outside the disc roster');
  }

  // Overview: turning in place must not mint highlight discs. The field
  // is the IMF; photospheres appear when you fly close.
  const roster0 = await page.evaluate(() =>
    (window.__galaxyView?.resolvedStars?.() ?? []).map((o) => o.id).join(','),
  );
  await page.evaluate(() => window.__galaxyView?.orbitBy?.(1.35, -0.4));
  await page.waitForTimeout(400);
  const roster1 = await page.evaluate(() =>
    (window.__galaxyView?.resolvedStars?.() ?? []).map((o) => o.id).join(','),
  );
  console.log('ROSTER', JSON.stringify({ before: roster0, after: roster1 }));
  if (roster0 !== roster1) errors.push('overview photospheres appeared after looking around');
  if (roster0) errors.push('overview still has highlight discs');
  await page.screenshot({ path: 'previews/galaxy-2b-orbit.png' });

  const strafe = await page.evaluate(() => {
    const v = window.__galaxyView;
    const c = v.arcCenter;
    const p0 = v.camera.position.clone();
    v.flyStrafe?.(0.45);
    const p1 = v.camera.position;
    const ax = p0.x - c.x, ay = p0.y - c.y, az = p0.z - c.z;
    const bx = p1.x - c.x, by = p1.y - c.y, bz = p1.z - c.z;
    const na = Math.hypot(ax, ay, az);
    const nb = Math.hypot(bx, by, bz);
    const dot = (ax * bx + ay * by + az * bz) / Math.max(1e-9, na * nb);
    return {
      moved: Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z),
      cos: dot,
    };
  });
  console.log('STRAFE', JSON.stringify(strafe));
  if (!strafe || strafe.moved < 0.2) errors.push('strafe did not fly off the orbit lock');
  if (strafe && strafe.cos > 0.995) errors.push('strafe stayed on a radial from the arc centre (orbit lock still on)');

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

  // Set course is the dossier button — a star tap only selects.
  const goBack = await page.evaluate(() => {
    const v = window.__galaxyView;
    v.setPreset('home');
    return true;
  });
  console.log('HOME PRESET', goBack);
  await page.waitForTimeout(1500);
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
