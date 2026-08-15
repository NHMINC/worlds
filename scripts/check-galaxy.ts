/* Galaxy + stellar-clock sanity: the catalog is a law, not a list.
 * Same seed must reprint the same sky; arms must out-density the gaps;
 * metallicity must fall with radius; dead massive stars must be remnants;
 * the zoo (O through T, WD, NS, pulsar, BH, H II, PN, SNR) must appear
 * when we draw enough objects. Run: npx tsx scripts/check-galaxy.ts */
import { UNIVERSE } from '../src/world/physics';
import {
  objectAt, objectsNear, homeStar, density, inSpiralArm, chemistry,
  catalogSize, slotsInCell, cellCount, sampleDust, packId,
} from '../src/world/galaxy';
import { imfMass, msLifetime, evolve, classifyStar } from '../src/world/stellar';
import { systemAt } from '../src/world/systemgen';
import { discoverHabitable } from '../src/world/discover';
import { mulberry32, xmur3 } from '../src/world/rng';
import { photoApparentPx, shineDisplay, starKind, visualRadiusKpc } from '../src/render/galaxyStar';
import type { GalaxyObject } from '../src/world/galaxy';
import type { StellarState } from '../src/world/stellar';

let fail = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    fail++;
    console.error('  FAIL:', msg);
  }
};

const seed = UNIVERSE.CANONICAL_SEED;
const other = 'vale-brook-1';

// Determinism — pick an occupied slot, not a random empty one.
let probe = -1;
for (let cell = 0; cell < 400 && probe < 0; cell++) {
  const n = slotsInCell(seed, cell);
  if (n > 0) probe = packId(cell, 0);
}
check(probe >= 0, 'could not find any occupied slot to probe');
const a = objectAt(seed, probe);
const b = objectAt(seed, probe);
const c = objectAt(other, probe);
check(!!a && !!b && a.star.massZams === b.star.massZams && a.star.phase === b.star.phase, 'same seed, same object');
check(!!a && (!c || a.star.massZams !== c.star.massZams || a.pos.theta !== c.pos.theta), 'different seeds must diverge');

// IMF: many more M dwarfs than O stars; a brown-dwarf tail below 0.08.
let nM = 0, nO = 0, nBd = 0;
for (let i = 0; i < 4000; i++) {
  const m = imfMass((i + 0.5) / 4000);
  if (m < UNIVERSE.IMF_MIN) nBd++;
  if (m < 0.5) nM++;
  if (m > 16) nO++;
}
check(nM > nO * 20, `IMF not bottom-heavy: M=${nM} O=${nO}`);
check(nBd > 40, `IMF missing brown-dwarf tail: BD=${nBd}`);

// Clock: a 20 Msun star is dead by 0.02 Gyr; a 0.8 Msun star lives > 10 Gyr.
check(msLifetime(20) < 0.05, `20 Msun MS life ${msLifetime(20)} Gyr too long`);
check(msLifetime(0.8) > 10, `0.8 Msun MS life ${msLifetime(0.8)} Gyr too short`);
const dead = evolve({ massZams: 20, ageGyr: 1, feh: 0, carbon: 1 });
check(dead.phase === 'neutron_star' || dead.phase === 'pulsar' || dead.phase === 'black_hole', `20 Msun @ 1 Gyr is ${dead.phase}`);
const sun = evolve({ massZams: 1, ageGyr: 4.6, feh: 0, carbon: 1 });
check(sun.phase === 'main_sequence' && sun.mk === 'G', `Sun analog is ${classifyStar(sun)}`);
const wd = evolve({ massZams: 2, ageGyr: 12, feh: 0, carbon: 1 });
check(wd.phase === 'white_dwarf', `2 Msun @ 12 Gyr is ${wd.phase}`);
const freshWd = evolve({ massZams: 2, ageGyr: msLifetime(2) * 1.16, feh: 0, carbon: 1.1 });
check(freshWd.phase === 'white_dwarf' && freshWd.nebula === 'planetary', `fresh post-MS 2 Msun: ${freshWd.phase}/${freshWd.nebula}`);
const bh = evolve({ massZams: 40, ageGyr: 1, feh: 0, carbon: 1 });
check(bh.phase === 'black_hole', `40 Msun @ 1 Gyr is ${bh.phase}`);
const youngNs = evolve({ massZams: 15, ageGyr: msLifetime(15) * 1.2, feh: 0, carbon: 1 });
check(youngNs.phase === 'pulsar' && youngNs.nebula === 'snr', `fresh 15 Msun remnant: ${classifyStar(youngNs)}`);
const hii = evolve({ massZams: 18, ageGyr: 0.002, feh: 0, carbon: 1, inArm: true });
check(hii.nebula === 'hii' && (hii.mk === 'O' || hii.mk === 'B'), `young massive in arm: ${classifyStar(hii)}`);
const bd = evolve({ massZams: 0.04, ageGyr: 5, feh: 0, carbon: 1 });
check(bd.phase === 'brown_dwarf' && (bd.mk === 'L' || bd.mk === 'T' || bd.mk === 'M'), `brown dwarf is ${classifyStar(bd)}`);
const da = evolve({ massZams: 2, ageGyr: 3, feh: 0, carbon: 0.8 });
check(da.phase === 'white_dwarf' && da.wdType != null, `WD class missing: ${classifyStar(da)}`);

// Chemistry: inner thin disk more metal-rich than outer.
const zin = chemistry('thin', 2, 2, 0.5);
const zout = chemistry('thin', 12, 2, 0.5);
check(zin.feh > zout.feh + 0.15, `thin-disk [Fe/H] does not fall with R: ${zin.feh} vs ${zout.feh}`);
const zhalo = chemistry('halo', 8, 12, 0.5);
check(zhalo.feh < -1, `halo is not metal-poor: ${zhalo.feh}`);

// Arms denser than interarm at the same R.
const R = 7;
let armD = 0, gapD = 0, nArm = 0, nGap = 0;
for (let i = 0; i < 120; i++) {
  const th = (i / 120) * Math.PI * 2;
  const d = density({ R, theta: th, z: 0 });
  if (inSpiralArm(R, th)) {
    armD += d;
    nArm++;
  } else {
    gapD += d;
    nGap++;
  }
}
const armMean = armD / Math.max(1, nArm);
const gapMean = gapD / Math.max(1, nGap);
check(armMean > gapMean * 1.15, `arms not overdense: ${armMean.toFixed(3)} vs ${gapMean.toFixed(3)}`);

// Census — sample cells. Never walk the address space.
const counts: Record<string, number> = {};
let occupied = 0;
let sampled = 0;
const cells = cellCount();
for (let i = 0; i < 5000; i++) {
  sampled++;
  const cell = (i * 9973 + 19) % cells;
  const n = slotsInCell(seed, cell);
  if (n <= 0) continue;
  const o = objectAt(seed, packId(cell, (i * 13) % n));
  if (!o) continue;
  occupied++;
  const label = classifyStar(o.star).replace(/\+.*/, '');
  const letter = /^[OBAFGKMLT]/.test(label) ? label[0] : label.replace(/[0-9].*/, '');
  counts[letter] = (counts[letter] ?? 0) + 1;
}
const kinds = Object.keys(counts).sort();
console.log(`\ncatalog ${seed}: ${occupied}/${sampled} occupied (cell sample)`);
console.log('  classes:', kinds.map((k) => `${k}=${counts[k]}`).join('  '));
check(occupied > 80, `catalog too empty: ${occupied}`);
check((counts['G'] ?? 0) + (counts['K'] ?? 0) + (counts['F'] ?? 0) > 0, 'no FGK stars');
check((counts['M'] ?? 0) + (counts['L'] ?? 0) + (counts['T'] ?? 0) > 5, 'no cool dwarfs');

let remnants = 0;
for (let i = 0; i < 400; i++) {
  const cell = (i * 48611 + 3) % cells;
  const n = slotsInCell(seed, cell);
  if (n < 4) continue;
  const o = objectAt(seed, packId(cell, n - 1));
  if (!o) continue;
  if (
    o.star.phase === 'white_dwarf' ||
    o.star.phase === 'neutron_star' ||
    o.star.phase === 'pulsar' ||
    o.star.phase === 'black_hole'
  ) {
    remnants++;
  }
}
check(remnants > 0, 'massive tail has no remnants');

let slotSum = 0;
let cellSeen = 0;
const popStep = 47;
for (let cell = 0; cell < cells; cell += popStep) {
  slotSum += slotsInCell(seed, cell);
  cellSeen++;
}
const popEst = slotSum * (cells / cellSeen);
check(popEst > 7e8, `population too small to be procedural: ${popEst.toExponential(2)}`);
check(popEst < 4e9, `population exploded: ${popEst.toExponential(2)}`);
check(catalogSize() > 1e9, `address space too small: ${catalogSize()}`);
console.log(`  population ~ ${popEst.toExponential(2)}  address space ${catalogSize().toExponential(2)}`);

let fat = -1;
let fatN = 0;
for (let cell = 0; cell < 80; cell++) {
  const n = slotsInCell(seed, cell);
  if (n > fatN) {
    fatN = n;
    fat = cell;
  }
}
if (fat >= 0 && fatN > 8) {
  const lo = objectAt(seed, packId(fat, 0));
  const hi = objectAt(seed, packId(fat, fatN - 1));
  check(!!lo && !!hi && hi.star.massZams > lo.star.massZams * 3, `IMF not stratified in cell ${fat}: ${lo?.star.massZams} vs ${hi?.star.massZams}`);
}

const home = homeStar(seed);
console.log(
  '  home:',
  home
    ? `${classifyStar(home.star)} pop=${home.pop} R=${home.pos.R.toFixed(2)} [Fe/H]=${home.star.feh.toFixed(2)} L=${home.star.luminosity.toFixed(2)}`
    : 'NONE',
);
check(!!home && (home.star.mk === 'G' || home.star.mk === 'K' || home.star.mk === 'F'), 'home star is not a FGK dwarf');
check(!!home && home.star.phase === 'main_sequence', 'home star is not on the main sequence');

const near = objectsNear(seed, home?.pos ?? { R: 8, theta: 0, z: 0 }, 1.2, { uMin: 0.86, limit: 40 });
check(near.length > 3, `neighbourhood empty: ${near.length}`);
check(
  near.some((o) => o.star.luminosity >= 0.2 || o.star.nebula !== 'none' || (o.star.mk === 'G' || o.star.mk === 'K' || o.star.mk === 'F')),
  'neighbourhood is only dead remnants',
);

if (home) {
  const sysA = systemAt(seed, home.id);
  const sysB = systemAt(seed, home.id);
  check(sysA.star.luminosity === sysB.star.luminosity && sysA.bodies.length === sysB.bodies.length, 'systemAt not deterministic');
  check(Math.abs(sysA.star.luminosity - home.star.luminosity) < 1e-9 || home.star.luminosity === 0, `systemAt L ${sysA.star.luminosity} ≠ catalog ${home.star.luminosity}`);
  check(sysA.seed === `${seed}:${home.id}`, `systemAt seed ${sysA.seed}`);
}
check(near.every((o) => objectAt(seed, o.id)?.star.massZams === o.star.massZams), 'near ≠ objectAt');

// Empty slots stay empty — look in the outer disk, not the nucleus.
let empty = 0;
for (let cell = cells - 1; cell >= cells - 8000 && empty < 4; cell--) {
  const n = slotsInCell(seed, cell);
  if (n < UNIVERSE.GALAXY_MAX_SLOT) {
    check(objectAt(seed, packId(cell, n)) === null, `slot ${n} in cell ${cell} should be empty`);
    empty++;
  }
}
check(empty > 0, 'no empty slots found in outer cells');

const dust = sampleDust(8000, seed);
let dArm = 0;
let dGap = 0;
for (const s of dust) {
  const R = Math.hypot(s.x, s.z);
  const th = Math.atan2(s.z, s.x);
  if (inSpiralArm(R, th)) dArm++;
  else dGap++;
}
check(dust.length > 2000, `dust sample too thin: ${dust.length}`);
check(dArm > dGap * 1.05, `dust does not prefer arms: arm=${dArm} gap=${dGap}`);

function asObj(star: StellarState): GalaxyObject {
  return { id: 1, pos: { R: 8, theta: 0, z: 0 }, pop: 'thin', inArm: true, star };
}
const sunDisc = visualRadiusKpc(asObj(sun));
const wdDisc = visualRadiusKpc(asObj(wd));
const bhDisc = visualRadiusKpc(asObj(bh));
check(wdDisc < sunDisc, `WD disc ${wdDisc} should be smaller than the Sun ${sunDisc}`);
check(sunDisc > 0.03 && sunDisc < 0.16, `Sun analog disc ${sunDisc} is not a photosphere`);
check(bhDisc > wdDisc, `BH visual ${bhDisc} should beat a WD pin`);
check(starKind(asObj(bh)) === 5, `BH kind ${starKind(asObj(bh))}`);
check(starKind(asObj(freshWd)) === 6, `planetary nebula should draw as a shell, got ${starKind(asObj(freshWd))}`);
{
  const dim = shineDisplay(5, 150);
  const mid = shineDisplay(80, 150);
  const hot = shineDisplay(400, 150);
  const obeam = shineDisplay(8000, 150);
  check(hot > dim * 2.2, `400 Lsun (${hot.toFixed(2)}) must outshine 5 Lsun (${dim.toFixed(2)})`);
  check(mid > dim * 1.5 && hot > mid * 1.15, `L rank collapsed: 5=${dim.toFixed(2)} 80=${mid.toFixed(2)} 400=${hot.toFixed(2)}`);
  check(obeam > hot * 1.15, `O star (${obeam.toFixed(2)}) must outshine 400 Lsun (${hot.toFixed(2)})`);
  const near = shineDisplay(20, 80);
  const far = shineDisplay(20, 240);
  check(near > far * 1.25, `same L at 80 kpc (${near.toFixed(2)}) must beat 240 kpc (${far.toFixed(2)})`);
  const pxPer = 1288;
  const rim = photoApparentPx(1, 40, pxPer);
  const midPx = photoApparentPx(1, 8, pxPer);
  const close = photoApparentPx(1, 2, pxPer);
  check(rim <= 6, `rim photosphere ${rim.toFixed(1)}px is a disc, not a pin`);
  check(midPx > rim * 2.5, `magnifier must grow on approach: rim ${rim.toFixed(1)} mid ${midPx.toFixed(1)}`);
  check(close > midPx * 1.8, `close photosphere ${close.toFixed(1)} must beat mid ${midPx.toFixed(1)}`);
}

// (The sampled "grain" starfield is gone: it drew tens of thousands of
// non-addressable points — a painted starfield by the charter's own
// words. The only stars the explorer draws are catalog rows.)

// The near-query is a LAW of the cells, not of the window: panning a
// hair must keep most of the sky (no re-rolled star field), and no
// single cell may own a visible clump of the sample.
{
  const p = { R: UNIVERSE.R_SUN, theta: 1.0, z: 0 };
  const a = objectsNear(seed, p, 2.0, { uMin: 0.97, limit: 800 });
  const b = objectsNear(seed, { ...p, theta: p.theta + 0.15 / p.R }, 2.0, { uMin: 0.97, limit: 800 });
  check(a.length > 100, `near-query too sparse (${a.length})`);
  const ids = new Set(a.map((o) => o.id));
  const shared = b.filter((o) => ids.has(o.id)).length;
  check(shared / Math.max(1, b.length) > 0.55, `pan stability ${shared}/${b.length}`);
  const perCell = new Map<number, number>();
  for (const o of a) {
    const c = Math.floor(o.id / UNIVERSE.GALAXY_MAX_SLOT);
    perCell.set(c, (perCell.get(c) ?? 0) + 1);
  }
  const maxShare = Math.max(...perCell.values()) / Math.max(1, a.length);
  check(maxShare < 0.05, `one cell owns ${(maxShare * 100).toFixed(1)}% of the sample`);
}

const start = discoverHabitable(seed, mulberry32(xmur3('first-camp')()));
check(start.spec.bodies.some((b) => b.kind === 'rocky' && b.physics.life), `discoverHabitable found no living world (${start.starId})`);
console.log(`  first camp: ${classifyStar(start.obj.star)} #${start.starId} body ${start.bodyId}`);

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECKS FAILED`);
process.exit(fail === 0 ? 0 : 1);
