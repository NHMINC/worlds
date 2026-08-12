/* Snow-cap census (run with tsx): generate many systems, build the ACTUAL
 * terrain of every liquid-hydrosphere world with the engine's own pipeline,
 * and check whether any land pokes above its local snow line. Liquid worlds
 * that can never show a cap are listed with the reason, so we can tell
 * physically-correct bare peaks (too warm, cycle too thin) from law bugs. */
import { generateSystem, lockedToStar } from '../src/world/systemgen';
import {
  createToyGenerator, insolationAt, localTemp01, snowLineFor, waterLevelFor, MAX_LEVEL,
} from '../src/world/toygen';
import { frequencyForSize, getGrid } from '../src/world/geodesic';
import { UNIVERSE } from '../src/world/physics';

const SYSTEMS = 120;

let liquidWorlds = 0;
let withCaps = 0;
const bare: Array<{
  id: string;
  why: string;
  snow: number;
  temp01: number;
  wl: number;
  maxLv: number;
  minLine: number;
  pressure: number;
}> = [];

for (let s = 0; s < SYSTEMS; s++) {
  const sys = generateSystem(`survey-${s}`);
  for (const b of sys.bodies) {
    if (b.kind !== 'rocky') continue;
    const p = b.physics;
    const locked = lockedToStar(b);
    const span = locked ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
    // Audit every world that shows open liquid ANYWHERE the shaders render
    // it: mean-liquid worlds, plus ice-state worlds whose warmest point
    // melts through the sheet (the Snowball-with-a-ring / Inovos V class).
    const freeze01 =
      (UNIVERSE.WATER_WIN[0] - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD);
    const warmest01 = p.snowTemp01 + span * (locked ? 1.0 : (1 - 0.785) * 1.6);
    const meltBand =
      p.hydrosphere.state === 'ice' &&
      p.atmosphere.pressure > UNIVERSE.LIQUID_MIN_P &&
      warmest01 > freeze01;
    if (p.hydrosphere.state !== 'liquid' && !meltBand) continue;
    liquidWorlds++;

    const shift = p.snowTemp01 - p.temp01;
    const wl = waterLevelFor(b.seaLevel);
    const grid = getGrid(frequencyForSize(b.size));
    const gen = createToyGenerator(b.seed);

    let maxLv = 0;
    let minLine = Infinity;
    let caps = false;
    for (let i = 0; i < grid.count; i++) {
      const x = grid.centers[i * 3];
      const y = grid.centers[i * 3 + 1];
      const z = grid.centers[i * 3 + 2];
      const lv = gen.levelAt(x, y, z);
      if (lv > maxLv) maxLv = lv;
      if (lv <= wl) continue; // underwater: sea ice is the water shader's job
      const t = localTemp01(b.temp, span, insolationAt(x, y, z, locked));
      const line = snowLineFor(t + shift, wl, p.snow);
      if (line < minLine) minLine = line;
      if (lv >= line) caps = true;
    }

    if (caps) {
      withCaps++;
      continue;
    }
    const why =
      p.snow < 0.15
        ? p.atmosphere.pressure < UNIVERSE.SNOW_CYCLE_P
          ? 'cycle too thin (low pressure)'
          : 'reservoir starved'
        : minLine === Infinity
          ? 'no land at all'
          : minLine > maxLv
            ? minLine > MAX_LEVEL
              ? 'too warm anywhere (line above 30)'
              : 'line above this world\'s peaks'
            : 'UNEXPLAINED';
    bare.push({
      id: `survey-${s} ${b.id}`,
      why,
      snow: p.snow,
      temp01: p.temp01,
      wl,
      maxLv,
      minLine: Number.isFinite(minLine) ? minLine : -1,
      pressure: p.atmosphere.pressure,
    });
  }
}

console.log(`liquid worlds: ${liquidWorlds}, with visible snow caps: ${withCaps} (${Math.round((100 * withCaps) / liquidWorlds)}%)`);
const byWhy = new Map<string, number>();
for (const w of bare) byWhy.set(w.why, (byWhy.get(w.why) ?? 0) + 1);
for (const [why, n] of [...byWhy.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  bare: ${why}: ${n}`);
}
console.log('\nsample bare worlds:');
for (const w of bare.slice(0, 25)) {
  console.log(
    `  ${w.id.padEnd(16)} ${w.why.padEnd(34)} snow=${w.snow.toFixed(2)} temp01=${w.temp01.toFixed(2)}` +
      ` P=${w.pressure.toFixed(2)} wl=${w.wl.toFixed(1)} maxLv=${w.maxLv} minLine=${w.minLine.toFixed(1)}`,
  );
}
