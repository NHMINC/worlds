/* Galaxy + stellar-clock sanity: the catalog is a law, not a list.
 * Same seed must reprint the same sky; arms must out-density the gaps;
 * metallicity must fall with radius; dead massive stars must be remnants;
 * the zoo (O through T, WD, NS, pulsar, BH, H II, PN, SNR) must appear
 * when we draw enough objects. Run: npx tsx scripts/check-galaxy.ts */
import { UNIVERSE } from '../src/world/physics';
import {
  objectAt, objectsNear, homeStar, density, inSpiralArm, chemistry,
  catalogSize, slotsInCell, cellCount, sampleDust, packId,
  midplaneZ, thinScaleHeight, spheroidScaleHeight, diskScaleHeight,
  slotBirthRaw, cellCenter, galToCart,
} from '../src/world/galaxy';
import { imfMass, msLifetime, evolve, classifyStar, teffToRgb } from '../src/world/stellar';
import { systemAt } from '../src/world/systemgen';
import { discoverHabitable } from '../src/world/discover';
import { mulberry32, xmur3 } from '../src/world/rng';
import {
  aimLocks,
  harvestChroma,
  harvestGlowPx,
  harvestPinWeight,
  harvestPsf,
  harvestShine,
  harvestStarPx,
  harvestSuperExtra,
  HARVEST_L_REF,
  HARVEST_PIN_CANVAS,
  HARVEST_PIN_CORE,
  HARVEST_SHINE_DIST_P,
  HARVEST_SHINE_DIST_REF,
  HARVEST_SHINE_GAIN,
  HARVEST_SHINE_L_P,
  HARVEST_SUPER_L,
  shineDisplay,
  starKind,
  visualRadiusKpc,
} from '../src/render/galaxyStar';
import { overviewDistanceKpc, overviewHalfAngle } from '../src/render/galaxyView';
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
check(armMean > gapMean * 1.08, `arms not overdense: ${armMean.toFixed(3)} vs ${gapMean.toFixed(3)}`);
check(gapMean > 0.02, `inter-arm emptied (ribbons, not a disc): ${gapMean.toFixed(3)}`);

// Axle: the inner polar column at high |z| must be empty. A peanut
// does not reach 2 kpc; a halo that still occupies those cells is a needle.
{
  let axleSlots = 0;
  let axleCells = 0;
  const nth = UNIVERSE.GALAXY_NTH;
  const nz = UNIVERSE.GALAXY_NZ;
  for (let it = 0; it < nth; it += 17) {
    for (const iz of [0, 1, nz - 2, nz - 1]) {
      const cell = 0 * nth * nz + it * nz + iz;
      axleSlots += slotsInCell(seed, cell);
      axleCells++;
    }
  }
  check(axleSlots / Math.max(1, axleCells) < 0.4, `axle through the core: ${axleSlots} slots in ${axleCells} high-|z| inner cells`);
}

// Axle (positions): ir=0 births fill the nuclear disk, not a 50-pc
// cylinder and not the peanut. Tightness is the density cusp.
{
  const nth = UNIVERSE.GALAXY_NTH;
  const nz = UNIVERSE.GALAXY_NZ;
  const iz = Math.floor(nz / 2);
  let n = 0;
  let pinned = 0;
  let sumR = 0;
  let sumX = 0;
  let sumZ = 0;
  let sumX2 = 0;
  let sumZ2 = 0;
  for (let it = 0; it < nth; it += 9) {
    const cell = 0 * nth * nz + it * nz + iz;
    const filled = slotsInCell(seed, cell);
    if (filled <= 0) continue;
    const take = Math.min(3, filled);
    for (let s = 0; s < take; s++) {
      const slot = Math.floor(((s + 0.5) * filled) / take);
      const b = slotBirthRaw(seed, cell, slot, filled);
      const c = galToCart(b.pos);
      n++;
      sumR += b.pos.R;
      sumX += c.x;
      sumZ += c.z;
      sumX2 += c.x * c.x;
      sumZ2 += c.z * c.z;
      if (Math.abs(b.pos.R - 0.05) < 1e-9) pinned++;
    }
  }
  const meanR = sumR / Math.max(1, n);
  const stdX = Math.sqrt(Math.max(0, sumX2 / n - (sumX / n) ** 2));
  const stdZ = Math.sqrt(Math.max(0, sumZ2 / n - (sumZ / n) ** 2));
  const axis = Math.max(stdX, stdZ) / Math.max(1e-6, Math.min(stdX, stdZ));
  check(pinned === 0, `inner births pinned to the 0.05 kpc axle: ${pinned}/${n}`);
  check(meanR > 0.10 && meanR < 0.40,
    `ir=0 births must sit in the nuclear disk, not a needle or the peanut: mean R=${meanR.toFixed(3)} (${n} samples)`);
  check(stdX > 0.08 && stdZ > 0.08, `ir=0 births collapsed to a line: σx=${stdX.toFixed(3)} σz=${stdZ.toFixed(3)}`);
  check(axis < 1.8, `ir=0 births prefer one axis: σx=${stdX.toFixed(3)} σz=${stdZ.toFixed(3)}`);
}

// Vertical law: the sheet is not a brick. Outer zd flares; the
// midplane warps and corrugates so edge-on is an irregular ribbon.
{
  check(thinScaleHeight(14) > thinScaleHeight(4) * 1.5,
    `outer disk must flare: zd(14)=${thinScaleHeight(14).toFixed(2)} zd(4)=${thinScaleHeight(4).toFixed(2)}`);
  check(spheroidScaleHeight(0.3) > thinScaleHeight(0.3) * 1.5,
    `core spheroid must out-scale the thin sheet: ${spheroidScaleHeight(0.3).toFixed(2)} vs ${thinScaleHeight(0.3).toFixed(2)}`);
  check(diskScaleHeight(0.4) > diskScaleHeight(5) * 1.4,
    `core birth scale must be a bump, not a line: ${diskScaleHeight(0.4).toFixed(2)} vs ${diskScaleHeight(5).toFixed(2)}`);
  check(spheroidScaleHeight(6) < thinScaleHeight(6),
    'spheroid must die before the thin flare takes over');
  const up = midplaneZ(15, Math.PI / 2 + UNIVERSE.GALAXY_WARP_PHI);
  const dn = midplaneZ(15, -Math.PI / 2 + UNIVERSE.GALAXY_WARP_PHI);
  check(Math.abs(up - dn) > 0.35, `outer warp too flat: ${up.toFixed(2)} vs ${dn.toFixed(2)}`);
  check(Math.abs(midplaneZ(1.2, 0.4)) < 0.12, `inner midplane must stay flat, got ${midplaneZ(1.2, 0.4).toFixed(2)}`);
  const corr = [0, 1, 2, 3, 4, 5].map((i) => midplaneZ(8, i).toFixed(2));
  check(new Set(corr).size >= 4, `corrugation collapsed to a single height: ${corr.join(',')}`);
  const nth = UNIVERSE.GALAXY_NTH;
  const nz = UNIVERSE.GALAXY_NZ;
  const nr = UNIVERSE.GALAXY_NR;
  const coreCell = Math.floor(0.04 * nr) * nth * nz + 3 * nz + Math.floor(nz / 2);
  const midCell = Math.floor(0.32 * nr) * nth * nz + 3 * nz + Math.floor(nz / 2);
  const outerCell = Math.floor(0.88 * nr) * nth * nz + 3 * nz + Math.floor(nz / 2);
  const nCore = slotsInCell(seed, coreCell);
  const nMid = slotsInCell(seed, midCell);
  const nOut = slotsInCell(seed, outerCell);
  const spanOf = (cell: number, n: number) => {
    const zs: number[] = [];
    for (let s = 0; s < Math.min(16, Math.max(1, n)); s++) zs.push(slotBirthRaw(seed, cell, s, Math.max(1, n)).pos.z);
    return Math.max(...zs) - Math.min(...zs);
  };
  if (nCore > 0 && nMid > 0) {
    const coreSpan = spanOf(coreCell, nCore);
    const midSpan = spanOf(midCell, nMid);
    check(coreSpan > midSpan * 1.25,
      `core birth z must bump above the thin sheet: ${coreSpan.toFixed(2)} vs ${midSpan.toFixed(2)}`);
  }
  if (nMid > 0 && nOut > 0) {
    const midSpan = spanOf(midCell, nMid);
    const outSpan = spanOf(outerCell, nOut);
    check(outSpan > midSpan * 1.15,
      `outer birth z must spread more than mid-disk: ${outSpan.toFixed(2)} vs ${midSpan.toFixed(2)}`);
  }
  const mid = cellCenter(outerCell);
  const born = slotBirthRaw(seed, outerCell, 0, Math.max(1, nOut));
  check(Math.abs(born.pos.z - mid.z) > 0.05 || Math.abs(midplaneZ(mid.R, mid.theta)) < 0.05,
    'outer birth z must pick up the local midplane');
}

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
  check(HARVEST_L_REF === 300, `harvest shine zero-point must stay 300 Lsun, got ${HARVEST_L_REF}`);
  check(UNIVERSE.GALAXY_SILHOUETTE_M < 5 && UNIVERSE.GALAXY_SILHOUETTE_L < 300,
    `harvest floor must be deeper than 5 Msun / 300 Lsun (M=${UNIVERSE.GALAXY_SILHOUETTE_M} L=${UNIVERSE.GALAXY_SILHOUETTE_L})`);
  if (UNIVERSE.GALAXY_HARVEST_ALL) {
    check(UNIVERSE.GALAXY_HARVEST_ALL_CAP === 1_000_000,
      `all-sky bottle must be one million (cap=${UNIVERSE.GALAXY_HARVEST_ALL_CAP})`);
    check(UNIVERSE.GALAXY_HARVEST_ALL_I_MIN === 0,
      `photograph must not floor I (I_MIN=${UNIVERSE.GALAXY_HARVEST_ALL_I_MIN})`);
    check(UNIVERSE.GALAXY_HARVEST_ALL_L === 16,
      `photograph floor must be the faint K-giant (L=${UNIVERSE.GALAXY_HARVEST_ALL_L})`);
  } else {
    check(UNIVERSE.GALAXY_HARVEST_SHAPE_F === 1e-4,
      `shape sample must stay 1e-4 of occupancy (f=${UNIVERSE.GALAXY_HARVEST_SHAPE_F})`);
    check(UNIVERSE.GALAXY_HARVEST_SHAPE_M === 1,
      `shape band must start at 1 Msun (M=${UNIVERSE.GALAXY_HARVEST_SHAPE_M})`);
  }
  check(harvestStarPx(1) === HARVEST_PIN_CANVAS && harvestStarPx(3) === HARVEST_PIN_CANVAS,
    `harvest floor is the ${HARVEST_PIN_CANVAS}px Gaussian canvas, got ${harvestStarPx(1)} / ${harvestStarPx(3)}`);
  check(harvestPinWeight(0, 0) === 1, `floor core must be 1, got ${harvestPinWeight(0, 0)}`);
  const pinR1 = harvestPinWeight(1, 0);
  check(pinR1 > 0.35 && pinR1 < 0.55,
    `floor at 1 device-px must be a mid halo (core=${HARVEST_PIN_CORE}), got ${pinR1.toFixed(2)}`);
  check(harvestPinWeight(2.6, 0) < 0.01, `floor halo must die by 2.6 px, got ${harvestPinWeight(2.6, 0)}`);
  const pin = harvestGlowPx(HARVEST_L_REF, 1);
  const midL = harvestGlowPx(1000, 1);
  const hotL = harvestGlowPx(3e4, 1);
  const giant = harvestGlowPx(1e6, 1);
  check(pin === HARVEST_PIN_CANVAS && midL === HARVEST_PIN_CANVAS,
    `floor and mid-L sit on the Gaussian canvas, got ${pin.toFixed(2)} / ${midL.toFixed(2)}`);
  check(hotL > pin, `glow room must grow once wings need more than the stamp: ${pin.toFixed(1)} / ${hotL.toFixed(1)}`);
  check(giant > hotL * 1.4, `hypergiant must outgrow an O (no bright-end cap): ${giant.toFixed(1)} vs ${hotL.toFixed(1)}`);
  const shineFloor = harvestShine(HARVEST_L_REF, 8);
  const shineO = harvestShine(8000, 8);
  check(shineO > shineFloor * 2.5, `O shine ${shineO.toFixed(2)} must beat floor ${shineFloor.toFixed(2)}`);
  check(harvestShine(400, 2) > harvestShine(400, 12) * 1.15, 'same L must dim with distance');
  const wide = overviewHalfAngle(50, 16 / 9, 'edge');
  const short = overviewHalfAngle(50, 16 / 9, 'face');
  check(wide > short, 'edge-on must frame to the width on a wide screen');
  const dEdge = overviewDistanceKpc(UNIVERSE.GALAXY_R_MAX, wide);
  const dOld = UNIVERSE.GALAXY_R_MAX / Math.tan(((50 * Math.PI) / 180) * 0.35);
  check(dEdge < dOld * 0.7, `edge-on must sit closer than the old vertical frame: ${dEdge.toFixed(1)} vs ${dOld.toFixed(1)}`);
  check(overviewDistanceKpc(UNIVERSE.GALAXY_R_MAX, short) > dEdge,
    'face-on sits farther than edge-on on a wide screen');
  const coreShine = (L: number, d: number) =>
    HARVEST_SHINE_GAIN *
    Math.pow(Math.max(L, 1e-4) / HARVEST_L_REF, HARVEST_SHINE_L_P) *
    Math.pow(HARVEST_SHINE_DIST_REF / Math.max(d, 0.4), HARVEST_SHINE_DIST_P);
  check(harvestSuperExtra(8000) === 0 && harvestSuperExtra(HARVEST_SUPER_L) === 0,
    'super-sun extra must be zero at and below the cut');
  check(Math.abs(harvestShine(8000, 8) - coreShine(8000, 8)) < 1e-12,
    'ordinary O harvest shine must be unchanged');
  check(Math.abs(harvestShine(HARVEST_L_REF, 8) - coreShine(HARVEST_L_REF, 8)) < 1e-12,
    'harvest-floor shine must be unchanged');
  check(harvestShine(1e6, 8) > coreShine(1e6, 8) * 2.5,
    `super-sun must get extra I: ${harvestShine(1e6, 8).toFixed(1)} vs core ${coreShine(1e6, 8).toFixed(1)}`);
  check(harvestGlowPx(1e6, 1) > harvestGlowPx(8000, 1) * 3,
    `super-sun glow must outgrow an O: ${harvestGlowPx(1e6, 1).toFixed(1)} vs ${harvestGlowPx(8000, 1).toFixed(1)}`);
  const floorCore = harvestPsf(shineFloor, 0);
  const floorWing = harvestPsf(shineFloor, 2.4);
  const oCore = harvestPsf(shineO, 0);
  const oWing = harvestPsf(shineO, 2.4);
  check(floorWing < 0.02, `floor PSF must die as a pin, wing ${floorWing.toFixed(3)}`);
  check(oWing > floorWing * 4, `O wings must outshine the floor ${oWing.toFixed(3)} vs ${floorWing.toFixed(3)}`);
  check(oCore / Math.max(harvestPsf(shineO, 1.2), 1e-6) > 8, `PSF must be a point, not a flat disc (${oCore.toFixed(2)} / mid)`);
  check(floorCore > floorWing * 20, `floor core must dominate its wings`);
  const oHue = harvestChroma(teffToRgb(28000));
  const mHue = harvestChroma(teffToRgb(3400));
  const gHue = harvestChroma(teffToRgb(5800));
  check(oHue[2] > oHue[0] + 0.08, `O chroma must read blue ${oHue}`);
  check(mHue[0] > mHue[2] + 0.25, `M chroma must read orange ${mHue}`);
  check(oHue[2] - oHue[0] > gHue[2] - gHue[0], 'O must be cooler-white than G');
  check(aimLocks(1, 20), 'solar analog at 20 kpc must lock the reticle');
  check(aimLocks(1, 0.35), 'focus park must lock');
  check(!aimLocks(0.01, 40), 'faint M at 40 kpc must stay a speck');
  check(!aimLocks(1, 40), 'solar analog at 40 kpc is not yet a visit');
}

{
  // Warp crosses the disk diameter in CROSS_S seconds.
  const crossS = (2 * UNIVERSE.GALAXY_R_MAX) / UNIVERSE.GALAXY_WARP;
  check(Math.abs(crossS - UNIVERSE.GALAXY_WARP_CROSS_S) < 0.05, `warp crosses in ${crossS.toFixed(1)} s, not ${UNIVERSE.GALAXY_WARP_CROSS_S}`);
  // Dust is a filter: blue must die first or a rift edge goes cold
  // instead of warm. The cap must be high enough that a clump stack
  // can extinguish — the old <5 floor kept the core “glorious.”
  const [dR, dG, dB] = UNIVERSE.GALAXY_DUST_RGB;
  check(dB > dG && dG > dR, `DUST_RGB ${dR},${dG},${dB} does not kill blue first`);
  check(UNIVERSE.GALAXY_EXTINCT_MAX >= 6, `clump columns must be allowed to go dark, cap=${UNIVERSE.GALAXY_EXTINCT_MAX}`);
  check(UNIVERSE.GALAXY_EXTINCT_MAX <= 16, `cap ${UNIVERSE.GALAXY_EXTINCT_MAX} is a saturate, not a free integral`);
  // One law, both layers: the local march must sample the short
  // in-bubble column at least as densely as the backdrop samples
  // the disk, or a star would brighten by crossing the boundary.
  const localSpacing = UNIVERSE.GALAXY_REGION_R / UNIVERSE.GALAXY_EXTINCT_STEPS_LOCAL;
  const farSpacing = (UNIVERSE.GALAXY_R_MAX * 2) / UNIVERSE.GALAXY_EXTINCT_STEPS;
  check(localSpacing <= farSpacing, `local extinction taps coarser than backdrop (${localSpacing.toFixed(2)} vs ${farSpacing.toFixed(2)} kpc)`);
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
