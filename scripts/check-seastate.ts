/* Sea-state sanity sweep: generate a few systems and check the new wave
 * drivers across world types — airless worlds must be mirror-still, wind
 * rises with pressure, tempo with gravity, tide only on moon-bearing
 * spinners — plus basinFetch: ponds near zero, oceans near one.
 * Run: npx tsx scripts/check-seastate.ts */
import { generateSystem } from '../src/world/systemgen';
import { UNIVERSE, seaState, tidalForcing, classify, waveSlope } from '../src/world/physics';
import { generateLevels, basinFetch, waterLevelFor } from '../src/world/toygen';
import { frequencyForSize, getGrid } from '../src/world/geodesic';

let fail = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    fail++;
    console.error('  FAIL:', msg);
  }
};

for (const seed of ['smoke-0', 'smoke-1', 'waves-2']) {
  const sys = generateSystem(seed);
  console.log(`\n=== ${seed} ===`);
  for (const b of sys.bodies) {
    if (b.kind !== 'rocky') continue;
    const p = b.physics;
    const moons = sys.bodies
      .filter((m) => m.parent === b.id)
      .map((m) => ({ densityRel: m.physics.densityRel, radiusGL: m.radius, orbitGL: m.orbitRadius }));
    const tide = b.tidallyLocked ? 0 : tidalForcing(moons);
    const s = seaState(p, tide);
    console.log(
      `${b.id.padEnd(6)} ${classify(p, false).padEnd(22)} P=${p.atmosphere.pressure.toFixed(2).padStart(6)} g=${p.gravity.toFixed(2)} moons=${moons.length}` +
      ` -> energy=${s.energy.toFixed(2)} tempo=${s.tempo.toFixed(2)} tide=${s.tide.toFixed(2)}`,
    );
    if (p.atmosphere.pressure < 0.02 && tide === 0) check(s.energy === 0, `${b.id} airless but energy ${s.energy}`);
    if (p.atmosphere.pressure > 0.5) check(s.energy > 0.5, `${b.id} thick air but energy ${s.energy}`);
    check(s.tempo > 0 && s.tempo < 1.8, `${b.id} tempo out of range ${s.tempo}`);
    if (b.parent !== null) check(moons.length === 0 || tide === 0 || !b.tidallyLocked, `${b.id} locked moon with tide`);
  }
}

// Fetch pass on one liquid world: basins must span the range.
const sys = generateSystem('smoke-0');
const home = sys.bodies.find((b) => b.kind === 'rocky' && b.physics.hydrosphere.state === 'liquid')
  ?? sys.bodies.find((b) => b.kind === 'rocky')!;
const grid = getGrid(frequencyForSize(home.size));
const levels = generateLevels(home.seed, grid);
const wl = waterLevelFor(home.seaLevel ?? 0.5);
const t0 = performance.now();
const fetch = basinFetch(grid, levels, wl);
const ms = performance.now() - t0;
const top = Math.floor(wl);
let wet = 0, land = 0, wetF = 0, minWet = 255, maxWet = 0, shoreLand = 0;
for (let i = 0; i < grid.count; i++) {
  if (levels[i] <= top) {
    wet++;
    wetF += fetch[i];
    if (fetch[i] < minWet) minWet = fetch[i];
    if (fetch[i] > maxWet) maxWet = fetch[i];
  } else {
    land++;
    if (fetch[i] > 0) shoreLand++;
  }
}
console.log(`\nfetch(${home.id}): ${grid.count} cells, ${wet} wet in ${ms.toFixed(1)}ms`);
console.log(`  wet fetch mean=${(wetF / Math.max(1, wet) / 255).toFixed(2)} min=${(minWet / 255).toFixed(2)} max=${(maxWet / 255).toFixed(2)}; land cells carrying fetch: ${shoreLand}/${land}`);
check(wet === 0 || maxWet > 200, 'no basin reaches high fetch');
check(shoreLand > 0, 'no shore land inherited fetch');
check(ms < 100, `basinFetch too slow: ${ms.toFixed(1)}ms`);

// Cox–Munk slope law: airless seas are the calm mirror; wind opens the path;
// across-path is tighter (the Earth glitter streak).
const calm = waveSlope(0);
const blow = waveSlope(1);
console.log(
  `\nslope: calm along=${calm.along.toFixed(3)} across=${calm.across.toFixed(3)}` +
  `  wind along=${blow.along.toFixed(3)} across=${blow.across.toFixed(3)}`,
);
check(calm.along === UNIVERSE.WAVE_SLOPE_CALM, 'calm slope is not WAVE_SLOPE_CALM');
check(blow.along === UNIVERSE.WAVE_SLOPE_WIND, 'wind slope is not WAVE_SLOPE_WIND');
check(calm.across < calm.along, 'calm glitter is not elongated');
check(blow.across < blow.along, 'wind glitter is not elongated');
check(blow.along > calm.along * 4, 'wind does not open the path');
check(waveSlope(-1).along === calm.along, 'energy < 0 not clamped');
check(waveSlope(2).along === blow.along, 'energy > 1 not clamped');

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECKS FAILED`);
process.exit(fail === 0 ? 0 : 1);
