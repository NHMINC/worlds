/* Landing smoke test: land on the home world, look around, glide with the
 * keys, verify the surface pose survives a reload, then take off.
 * Run: node scripts/smoke-land.mjs (dev server must be on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

// Fresh system: smoke-0's home is a living world.
await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill('smoke-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4000);
await page.screenshot({ path: 'previews/land-0-orbit.png' });

// Land at the point under the screen center.
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500); // blend + tier build
console.log('mode after land:', await page.evaluate(() => window.__engine.getView().mode));
await page.screenshot({ path: 'previews/land-1-landed.png' });

// Glide forward for a bit.
await page.keyboard.down('KeyW');
await page.waitForTimeout(2000);
await page.keyboard.up('KeyW');
await page.waitForTimeout(400);
await page.screenshot({ path: 'previews/land-2-glide.png' });

// Drag to look around (turn ~90° right and pitch up a little).
const c = page.locator('canvas');
await c.hover({ position: { x: 640, y: 400 } });
await page.mouse.down();
await page.mouse.move(1140, 360, { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: 'previews/land-3-look.png' });

// Scroll down for altitude, up close to the ground.
await c.hover({ position: { x: 640, y: 400 } });
await page.mouse.wheel(0, -900);
await page.waitForTimeout(1200);
await page.screenshot({ path: 'previews/land-4-low.png' });

// The pose autosaves once settled; reload and confirm we wake up landed.
await page.waitForTimeout(1500);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(5000);
console.log('mode after reload:', await page.evaluate(() => window.__engine.getView().mode));
await page.screenshot({ path: 'previews/land-5-reload.png' });

// Take off: back to orbit.
await page.click('button[title="Take off — rise back into orbit"]');
await page.waitForTimeout(3500);
console.log('mode after takeoff:', await page.evaluate(() => window.__engine.getView().mode));
await page.screenshot({ path: 'previews/land-6-takeoff.png' });

await browser.close();
