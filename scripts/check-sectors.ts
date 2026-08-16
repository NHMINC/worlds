/* Sector-map invariants (run with tsx). The map is a PROJECTION of the
 * catalog grid: the arc partition must be exact, ring boundaries must
 * equalise mass far better than uniform spacing, samples must be
 * deterministic real addresses, and interest picks must reprint. */
import { UNIVERSE } from '../src/world/physics';
import { cellCount, cellCenter, dustPhysics, galToCart, ismNorm, objectAt, polarCellCenter, polarCellOf, splitId, slotBirthCart, slotBirthRaw, slotsInCell } from '../src/world/galaxy';
import {
  catalogRingMasses,
  ringBounds,
  ringRadii,
  sectorCells,
  sectorCenter,
  sectorName,
  sectorOfCell,
  sectorOfPos,
  sectorPopulation,
  sectorSample,
  spokeBounds,
  systemsOfInterest,
  buildArcCloud,
  buildRegionCloud,
  buildSilhouetteCloud,
  advanceRegionCloud,
  regionImfFloor,
  KIND_DUST,
  KIND_STAR,
  BIT_DUST,
  BIT_NEBULA,
  isDustId,
  cellFromDustId,
} from '../src/world/sectors';
import { emissionLook, shapeAt, KIND_HII, KIND_PN, KIND_SNR } from '../src/world/skyShape';
import { sampleField } from '../src/world/formation/registry';

const seed = UNIVERSE.CANONICAL_SEED;
let fail = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    fail++;
  }
};

// --- ring boundaries: monotonic, exact cover, equal-mass ---
{
  const b = ringBounds();
  check(b.length === UNIVERSE.GALAXY_SECTOR_RINGS + 1, `ring bounds length ${b.length}`);
  check(b[0] === 0 && b[b.length - 1] === UNIVERSE.GALAXY_NR, `bounds must cover 0..NR`);
  for (let i = 1; i < b.length; i++) check(b[i] > b[i - 1], `bounds not strictly ascending at ${i}`);

  const mass = catalogRingMasses();
  const ringMass = (i: number) => {
    let m = 0;
    for (let ir = b[i]; ir < b[i + 1]; ir++) m += mass[ir];
    return m;
  };
  const masses = Array.from({ length: UNIVERSE.GALAXY_SECTOR_RINGS }, (_, i) => ringMass(i));
  const mean = masses.reduce((a, x) => a + x, 0) / masses.length;
  for (let i = 0; i < masses.length; i++) {
    const single = b[i + 1] - b[i] === 1;
    check(masses[i] <= mean * 2.5 || single, `ring ${i} holds ${(masses[i] / mean).toFixed(1)}x mean mass and is divisible`);
  }
  // Equal-mass must beat uniform spacing decisively on spread.
  const uniform: number[] = [];
  const per = UNIVERSE.GALAXY_NR / UNIVERSE.GALAXY_SECTOR_RINGS;
  for (let i = 0; i < UNIVERSE.GALAXY_SECTOR_RINGS; i++) {
    let m = 0;
    for (let ir = Math.floor(i * per); ir < Math.floor((i + 1) * per); ir++) m += mass[ir];
    uniform.push(m);
  }
  const spread = (xs: number[]) => Math.max(...xs) / Math.max(1e-9, Math.min(...xs));
  check(spread(masses) < spread(uniform) / 3, `equal-mass spread ${spread(masses).toFixed(1)} vs uniform ${spread(uniform).toFixed(1)}`);

  const radii = ringRadii();
  check(radii[radii.length - 1] === UNIVERSE.GALAXY_R_MAX, `outer radius must be R_MAX`);
}

// --- the arc partition is exact: every cell in exactly one arc ---
{
  let covered = 0;
  const seen = new Set<number>();
  for (let ring = 0; ring < UNIVERSE.GALAXY_SECTOR_RINGS; ring++) {
    for (let sector = 0; sector < UNIVERSE.GALAXY_SECTORS; sector++) {
      for (const cell of sectorCells({ ring, sector })) {
        check(!seen.has(cell), `cell ${cell} in two arcs`);
        seen.add(cell);
        covered++;
      }
    }
  }
  check(covered === cellCount(), `partition covers ${covered} of ${cellCount()} cells`);
}

// --- addressing round-trips ---
{
  for (const cell of [0, 12345, Math.floor(cellCount() / 2), cellCount() - 1]) {
    const id = sectorOfCell(cell);
    check(sectorCells(id).includes(cell), `cell ${cell} not inside its own arc ${sectorName(id)}`);
  }
  const c = sectorCenter({ ring: 12, sector: 37 });
  const back = sectorOfPos(c);
  check(back.ring === 12 && back.sector === 37, `centre of S38·R13 maps to ${sectorName(back)}`);
  const [it0, it1] = spokeBounds(UNIVERSE.GALAXY_SECTORS - 1);
  check(it1 === UNIVERSE.GALAXY_NTH && it0 < it1, `last spoke span ${it0}..${it1}`);
}

// --- arc content: deterministic, real, bright-first ---
{
  const id = sectorOfPos({ R: UNIVERSE.R_SUN, theta: 1.0, z: 0 });
  const a = sectorSample(seed, id, 400);
  const b2 = sectorSample(seed, id, 400);
  check(a.length === 400, `sample size ${a.length}`);
  check(a.every((o, i) => o.id === b2[i].id), 'sample not deterministic');
  for (const o of a.slice(0, 40)) {
    const again = objectAt(seed, o.id);
    check(!!again && again.id === o.id, `id ${o.id} does not round-trip`);
    const home = sectorOfPos(o.pos);
    // Position scatter may lean a hair over the arc edge; the CELL must
    // belong to the arc.
    const cellHome = sectorOfCell(splitId(o.id).cell);
    check(cellHome.ring === id.ring && cellHome.sector === id.sector, `star ${o.id} cell outside its arc (${sectorName(home)})`);
  }
  const pop = sectorPopulation(seed, id);
  check(pop > a.length, `population ${pop} smaller than sample`);

  const cloud = buildArcCloud(seed, id);
  check(cloud.n === pop, `cloud ${cloud.n} != population ${pop}`);
  check(cloud.n > 50_000, `arc cloud too small ${cloud.n}`);
  check(cloud.lum.length === cloud.n, `cloud lum ${cloud.lum.length}`);
  console.log(`  home-like arc cloud: ${cloud.n} slots in ${cloud.ms.toFixed(0)} ms`);

  // Birth pose must be the same row objectAt evolves.
  {
    const o = objectAt(seed, a[0].id);
    const { cell, slot } = splitId(a[0].id);
    const filled = slotsInCell(seed, cell);
    const b = slotBirthRaw(seed, cell, slot, filled);
    check(!!o && o.pos.R === b.pos.R && o.pos.theta === b.pos.theta && o.pos.z === b.pos.z, 'slotBirth pose != objectAt pose');
    check(!!o && o.star.massZams === b.massZams, 'slotBirth mass != objectAt mass');
  }

  const full = sectorSample(seed, id, UNIVERSE.GALAXY_SECTOR_STARS);
  check(full.length === UNIVERSE.GALAXY_SECTOR_STARS, `full survey ${full.length}`);
  check(new Set(full.map((o) => o.id)).size === full.length, 'survey has duplicate ids');
  const remnantPh = new Set(['white_dwarf', 'neutron_star', 'pulsar', 'black_hole']);
  const corpses = full.filter((o) => remnantPh.has(o.star.phase) && o.star.nebula === 'none');
  check(
    corpses.length < full.length * 0.25,
    `survey is a graveyard: ${corpses.length}/${full.length} bare remnants`,
  );

  // Equal-mass rings: populations of arcs across rings stay comparable.
  const pops: number[] = [];
  for (let ring = 0; ring < UNIVERSE.GALAXY_SECTOR_RINGS; ring += 8) {
    pops.push(sectorPopulation(seed, { ring, sector: 17 }));
  }
  const ratio = Math.max(...pops) / Math.max(1, Math.min(...pops));
  check(ratio < 40, `arc populations vary ${ratio.toFixed(0)}x across rings (azimuth structure allows some)`);
}

// --- region ball: fixed R, every occupant, pose matches objectAt ---
{
  const r = UNIVERSE.GALAXY_REGION_R;
  check(UNIVERSE.GALAXY_REGION_VIEW_R > r, `view ball ${UNIVERSE.GALAXY_REGION_VIEW_R} must outspan mint ${r}`);
  check(regionImfFloor(0) === 0, 'tap neighbourhood must keep every slot');
  check(regionImfFloor(UNIVERSE.GALAXY_REGION_FULL_R) === 0, 'full-R edge must still be complete');
  check(Math.abs(regionImfFloor(UNIVERSE.GALAXY_REGION_FULL_R + UNIVERSE.GALAXY_REGION_U_RAMP) - UNIVERSE.GALAXY_REGION_U_FAR) < 1e-9, 'ramp must reach U_FAR');
  const rim = galToCart({ R: 14, theta: 0.4, z: 0 });
  const a = buildRegionCloud(seed, rim.x, rim.y, rim.z, r);
  const b4 = buildRegionCloud(seed, rim.x, rim.y, rim.z, r);
  check(a.n === b4.n && a.n > 0, `region cloud not deterministic ${a.n} vs ${b4.n}`);
  check(a.ids[0] === b4.ids[0], 'region first id drifted');
  check(a.n > 8_000 && a.n < 800_000, `outer-disk region ${a.n} is not a flyable sky`);
  check(a.pos.length >= a.n * 3 && a.lum.length >= a.n && a.gain.length >= a.n, `region buffers shorter than n=${a.n}`);
  let maxD = 0;
  for (let i = 0; i < a.n; i++) {
    const d = Math.hypot(a.pos[i * 3] - rim.x, a.pos[i * 3 + 1] - rim.y, a.pos[i * 3 + 2] - rim.z);
    if (d > maxD) maxD = d;
  }
  check(maxD <= r + 1e-6, `region point ${maxD} outside ball ${r}`);
  const { cell, slot } = splitId(a.ids[0]);
  const filled = slotsInCell(seed, cell);
  const birth = slotBirthRaw(seed, cell, slot, filled);
  const cart = slotBirthCart(seed, cell, slot);
  check(Math.abs(cart.x - a.pos[0]) < 1e-5 && Math.abs(cart.y - a.pos[1]) < 1e-5, 'slotBirthCart != cloud pos');
  const o = objectAt(seed, a.ids[0]);
  check(!!o && o.pos.R === birth.pos.R && o.pos.theta === birth.pos.theta, 'region row pose != objectAt');
  const homeC = galToCart({ R: UNIVERSE.R_SUN, theta: 1.0, z: 0 });
  const homeCloud = buildRegionCloud(seed, homeC.x, homeC.y, homeC.z, r);
  check(homeCloud.n > a.n, `home region ${homeCloud.n} should outnumber the rim ${a.n}`);
  console.log(`  outer region: ${a.n} slots in ${a.ms.toFixed(0)} ms; home-like ${homeCloud.n} in ${homeCloud.ms.toFixed(0)} ms`);
  const nudged = { x: rim.x + 0.08, y: rim.y, z: rim.z };
  const slid = advanceRegionCloud(seed, a, rim.x, rim.y, rim.z, nudged.x, nudged.y, nudged.z, r);
  const fresh = buildRegionCloud(seed, nudged.x, nudged.y, nudged.z, r);
  const slidIds = new Set(Array.from(slid.ids.subarray(0, slid.n)));
  const freshIds = new Set(Array.from(fresh.ids.subarray(0, fresh.n)));
  check(slidIds.size === freshIds.size, `slide n ${slidIds.size} != remint ${freshIds.size}`);
  let miss = 0;
  for (const id of freshIds) if (!slidIds.has(id)) miss++;
  check(miss === 0, `slide missed ${miss} stars a remint has`);
  check(slid.n !== a.n, 'sliding the sphere did not change membership');
  console.log(`  slide ${slid.ms.toFixed(1)} ms vs remint ${fresh.ms.toFixed(0)} ms`);
}

// --- luminous backdrop: clock + dust, real ids, not a dwarf cloud ---
{
  const a = buildSilhouetteCloud(seed);
  const b5 = buildSilhouetteCloud(seed);
  check(a === b5, 'silhouette must be cached per seed');
  check(a.n === b5.n && a.ids[0] === b5.ids[0], 'silhouette not deterministic');
  check(a.kind.length >= a.n, 'silhouette missing kind');
  check(a.n > 20_000 && a.n < 220_000, `silhouette ${a.n} is not a bright tail`);
  let stars = 0;
  let nebulae = 0;
  let dust = 0;
  let dustOffLattice = 0;
  let minStarL = Infinity;
  const dustSeen = new Set<number>();
  const homeC = galToCart({ R: UNIVERSE.R_SUN, theta: 1.0, z: 0 });
  const r = UNIVERSE.GALAXY_REGION_R;
  let inside = 0;
  for (let i = 0; i < a.n; i++) {
    const d = Math.hypot(a.pos[i * 3] - homeC.x, a.pos[i * 3 + 1] - homeC.y, a.pos[i * 3 + 2] - homeC.z);
    if (d < r) inside++;
    if (a.kind[i] === KIND_DUST || (a.bits[i] & BIT_DUST) !== 0) {
      dust++;
      const id = a.ids[i];
      check(isDustId(id), `dust row ${id} is not an ISM id`);
      check(!dustSeen.has(id), `dust id ${id} duplicated`);
      dustSeen.add(id);
      check(!objectAt(seed, id), `dust id ${id} claims to be a living star`);
      // A population scatters; a lattice pins to cell centres.
      const mid = galToCart(polarCellCenter(cellFromDustId(id)));
      const off = Math.hypot(a.pos[i * 3] - mid.x, a.pos[i * 3 + 1] - mid.y, a.pos[i * 3 + 2] - mid.z);
      if (off > 0.02) dustOffLattice++;
      continue;
    }
    if (a.bits[i] & BIT_NEBULA) nebulae++;
    else stars++;
    if (a.kind[i] === KIND_STAR && a.lum[i] < minStarL) minStarL = a.lum[i];
  }
  check(inside < a.n * 0.15, `silhouette dumps ${inside}/${a.n} into the home sample ball`);
  check(inside < a.n, 'silhouette must reach past the sample ball');
  // L ≥ 300 keeps ~79k of the ~83k stars the M=5 floor clocks — most
  // of the luminous tail, still nowhere near the full disk.
  check(stars > 60_000 && stars < 110_000, `silhouette stars ${stars} is not the luminous tail`);
  check(nebulae > 20 && nebulae < 50_000, `silhouette nebulae ${nebulae} is not the prominent set`);
  // Dust is census-only (never drawn; extinction is the visible law),
  // so the full clump population rides along — tens of thousands.
  check(dust > 60_000 && dust < 150_000, `dust count ${dust} is not the full clump census`);
  check(dustOffLattice > dust * 0.9, `dust pinned to the lattice: only ${dustOffLattice}/${dust} scattered`);
  check(minStarL >= UNIVERSE.GALAXY_SILHOUETTE_L, `silhouette star dim L=${minStarL}`);
  check(stars + nebulae < 110_000, `silhouette star/nebula rows ${stars + nebulae} still a dwarf cloud`);
  const s0 = shapeAt(KIND_HII, 99);
  const s1 = shapeAt(KIND_HII, 99);
  check(s0.radiusKpc === s1.radiusKpc && s0.seed === s1.seed, 'shapeAt not deterministic');
  const pn = shapeAt(KIND_PN, 1).rgb;
  const snr = shapeAt(KIND_SNR, 1).rgb;
  const hii = shapeAt(KIND_HII, 1).rgb;
  check(pn[1] > 0.7 && pn[2] > 0.7 && pn[0] < pn[1], 'PN must be cyan');
  check(snr[0] > 0.9 && snr[1] < 0.5 && snr[2] < 0.5, 'SNR must be red');
  check(hii[0] > 0.9 && hii[1] > 0.9 && hii[2] > 0.9, 'H II must be white');
  let checked = 0;
  for (let i = 0; i < a.n && checked < 8; i++) {
    if (a.kind[i] === KIND_DUST) continue;
    const id = a.ids[i];
    const o = objectAt(seed, id);
    check(!!o && o.id === id, `silhouette id ${id} is not a catalog row`);
    const { cell, slot } = splitId(id);
    const cart = slotBirthCart(seed, cell, slot);
    check(Math.abs(cart.x - a.pos[i * 3]) < 1e-5 && Math.abs(cart.y - a.pos[i * 3 + 1]) < 1e-5, 'silhouette pose != slotBirthCart');
    if (a.bits[i] & BIT_NEBULA) check(!!o && o.star.nebula !== 'none', `nebula bit on ${id} but objectAt nebula is none`);
    checked++;
  }
  // Visit handshake: a backdrop star must be a local keeper when the ball sits on it.
  let host = -1;
  for (let i = 0; i < a.n; i++) {
    if (a.kind[i] === KIND_STAR && a.lum[i] >= 8) {
      host = i;
      break;
    }
  }
  check(host >= 0, 'no luminous backdrop star for the visit handshake');
  if (host >= 0) {
    const id = a.ids[host];
    const local = buildRegionCloud(seed, a.pos[host * 3], a.pos[host * 3 + 1], a.pos[host * 3 + 2], r);
    let found = false;
    for (let i = 0; i < local.n; i++) {
      if (local.ids[i] === id) {
        found = true;
        break;
      }
    }
    check(found, `backdrop star ${id} vanished when the 2 kpc ball reached it`);
    console.log(`  visit handshake: id ${id} kept in local ${local.n}`);
  }
  console.log(`  silhouette: ${a.n} (${stars} stars, ${nebulae} nebulae, ${dust} dust) in ${a.ms.toFixed(0)} ms`);
}

// --- emission event laws: expansion, fading, hue from the clock ---
{
  const base = { ageGyr: 0.001, luminosity: 100, carbon: 1.0, feh: 0 };
  const pnY = emissionLook(KIND_PN, 7, { ...base, deadFor: 0.002 });
  const pnY2 = emissionLook(KIND_PN, 7, { ...base, deadFor: 0.002 });
  check(pnY.radiusKpc === pnY2.radiusKpc && pnY.gain === pnY2.gain, 'emissionLook not deterministic');
  const pnO = emissionLook(KIND_PN, 7, { ...base, deadFor: UNIVERSE.PN_GYR * 0.95 });
  check(pnO.radiusKpc > pnY.radiusKpc * 1.5, 'PN shell must expand with age');
  check(pnY.gain > pnO.gain * 1.5, 'young PN must outshine old');
  const snY = emissionLook(KIND_SNR, 7, { ...base, deadFor: UNIVERSE.SNR_GYR * 0.05 });
  const snO = emissionLook(KIND_SNR, 7, { ...base, deadFor: UNIVERSE.SNR_GYR * 0.95 });
  check(snO.radiusKpc > snY.radiusKpc * 1.5, 'SNR blast must expand (Sedov)');
  check(snY.gain > snO.gain * 1.5, 'young SNR must blaze, old must ghost');
  const hiiDim = emissionLook(KIND_HII, 7, { ...base, deadFor: 0, luminosity: 300 });
  const hiiBright = emissionLook(KIND_HII, 7, { ...base, deadFor: 0, luminosity: 200000 });
  check(hiiBright.radiusKpc > hiiDim.radiusKpc, 'H II bubble must grow with host luminosity');
  const pnC = emissionLook(KIND_PN, 7, { ...base, deadFor: 0.002, carbon: 2.1 });
  check(pnC.rgb[0] > pnY.rgb[0] + 0.05, 'carbon-rich PN must warm away from teal');
  console.log(`  emission laws: PN r ${pnY.radiusKpc.toFixed(3)} -> ${pnO.radiusKpc.toFixed(3)}, SNR gain ${snY.gain.toFixed(2)} -> ${snO.gain.toFixed(2)}`);
}

// --- dust composition: chemistry and temperature, not one brown ---
{
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const izMid = Math.floor(nz / 2);
  const ringAt = (R: number) => Math.max(0, Math.min(nr - 1, Math.floor((R / rMax) * nr)));
  const meanIce = (R: number) => {
    let s = 0;
    let n = 0;
    const ir = ringAt(R);
    for (let it = 0; it < nth; it += 6) {
      const cell = ir * nth * nz + it * nz + izMid;
      const ph = dustPhysics(seed, cell);
      s += ph.iceFrac;
      n++;
    }
    return s / Math.max(1, n);
  };
  const cellIn = ringAt(3) * nth * nz + 11 * nz + izMid;
  const a1 = dustPhysics(seed, cellIn);
  const a2 = dustPhysics(seed, cellIn);
  check(a1.field === a2.field && a1.iceFrac === a2.iceFrac && a1.carbonFrac === a2.carbonFrac, 'dustPhysics not deterministic');
  check(a1.carbonFrac >= 0 && a1.carbonFrac <= 1 && a1.iceFrac >= 0 && a1.iceFrac <= 1, 'dust fractions out of range');
  const iceIn = meanIce(3);
  const iceOut = meanIce(13);
  check(iceOut > iceIn + 0.05, `ice must grow with cold radius: inner ${iceIn.toFixed(2)} vs outer ${iceOut.toFixed(2)}`);
  // Grain colours vary across the disk — no single painted brown.
  const cloud = buildSilhouetteCloud(seed);
  const tints = new Set<string>();
  for (let i = 0; i < cloud.n; i++) {
    if (cloud.kind[i] !== KIND_DUST) continue;
    tints.add(
      `${Math.round(cloud.col[i * 3] * 24)}:${Math.round(cloud.col[i * 3 + 1] * 24)}:${Math.round(cloud.col[i * 3 + 2] * 24)}`,
    );
    if (tints.size > 40) break;
  }
  // The full clump census spans the whole disk, so silicate / soot /
  // ice chemistry should show a broad spread of grain tints again.
  check(tints.size >= 8, `dust wears ${tints.size} tints — composition is not reaching the grains`);
  console.log(`  dust chemistry: ice ${iceIn.toFixed(2)} -> ${iceOut.toFixed(2)} with radius; ${tints.size}+ grain tints`);
}

// --- nursery law: dense gas births young stars (causal, not painted) ---
{
  const { field } = sampleField();
  type Row = { ism: number; young: number };
  const rows: Row[] = [];
  for (let cell = 0; cell < field.pN; cell++) {
    if (field.pKind[cell] !== 0) continue;
    const R = Math.hypot(field.pAX[cell], field.pAZ[cell]);
    if (Math.abs(R - UNIVERSE.R_SUN) > 1.8) continue;
    const filled = slotsInCell(seed, cell);
    if (filled < 12) continue;
    const ism = ismNorm(seed, polarCellOf(cellCenter(cell)));
    let young = 0;
    const probe = 10;
    for (let j = 0; j < probe; j++) {
      const slot = Math.floor(((j + 0.5) / probe) * filled);
      const b = slotBirthRaw(seed, cell, slot, filled);
      if (b.pop === 'thin' && b.ageGyr < 1.5) young++;
    }
    rows.push({ ism, young: young / probe });
  }
  rows.sort((x, y) => x.ism - y.ism);
  const tenth = Math.max(1, Math.floor(rows.length / 10));
  const bot = rows.slice(0, tenth);
  const top = rows.slice(rows.length - tenth);
  const mean = (xs: Row[]) => xs.reduce((s, x) => s + x.young, 0) / Math.max(1, xs.length);
  const botY = mean(bot);
  const topY = mean(top);
  check(rows.length > 60, `nursery probe too small (${rows.length} cells)`);
  check(topY > botY * 1.5 + 0.01, `nursery law not causal: young frac top ${topY.toFixed(3)} vs bottom ${botY.toFixed(3)}`);
  console.log(`  nursery: young frac ${botY.toFixed(3)} (thin gas) -> ${topY.toFixed(3)} (dense gas) over ${rows.length} cells`);
}

// --- systems of interest: deterministic, spectacular, spread out ---
{
  const a = systemsOfInterest(seed, 100);
  const b3 = systemsOfInterest(seed, 100);
  check(a.length === 100, `interest count ${a.length}`);
  check(a.every((o, i) => o.id === b3[i].id), 'interest picks not deterministic');
  const exotic = a.filter((o) => o.star.nebula !== 'none' || ['black_hole', 'pulsar', 'neutron_star', 'wolf_rayet', 'supergiant'].includes(o.star.phase));
  check(exotic.length >= 20, `only ${exotic.length} exotic picks in 100`);
  const bins = new Set(a.map((o) => `${Math.floor(o.pos.R / 1.6)}:${Math.floor(o.pos.theta * 4)}`));
  check(bins.size >= 40, `interest picks bunch into ${bins.size} bins`);
}

// (The saucer chart is retired; its dome-height law went with it.)

if (fail) {
  console.error(`check-sectors: ${fail} failure(s)`);
  process.exit(1);
}
const b = ringBounds();
console.log('check-sectors: ok');
console.log(`  rings: inner span ${b[1] - b[0]} catalog rings, outer span ${b[b.length - 1] - b[b.length - 2]}`);
console.log(`  arcs: ${UNIVERSE.GALAXY_SECTORS * UNIVERSE.GALAXY_SECTOR_RINGS} (${UNIVERSE.GALAXY_SECTORS}×${UNIVERSE.GALAXY_SECTOR_RINGS})`);
