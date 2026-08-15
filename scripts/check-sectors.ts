/* Sector-map invariants (run with tsx). The map is a PROJECTION of the
 * catalog grid: the arc partition must be exact, ring boundaries must
 * equalise mass far better than uniform spacing, samples must be
 * deterministic real addresses, and interest picks must reprint. */
import { UNIVERSE } from '../src/world/physics';
import { cellCount, objectAt, splitId } from '../src/world/galaxy';
import { saucerHeight } from '../src/render/galaxySectors';
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
} from '../src/world/sectors';

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
  for (const cell of [0, 12345, 999_999, cellCount() - 1]) {
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

  // Equal-mass rings: populations of arcs across rings stay comparable.
  const pops: number[] = [];
  for (let ring = 0; ring < UNIVERSE.GALAXY_SECTOR_RINGS; ring += 8) {
    pops.push(sectorPopulation(seed, { ring, sector: 17 }));
  }
  const ratio = Math.max(...pops) / Math.max(1, Math.min(...pops));
  check(ratio < 40, `arc populations vary ${ratio.toFixed(0)}x across rings (azimuth structure allows some)`);
}

// --- systems of interest: deterministic, spectacular, spread out ---
{
  const a = systemsOfInterest(seed, 100);
  const b3 = systemsOfInterest(seed, 100);
  check(a.length === 100, `interest count ${a.length}`);
  check(a.every((o, i) => o.id === b3[i].id), 'interest picks not deterministic');
  const exotic = a.filter((o) => o.star.nebula !== 'none' || ['black_hole', 'pulsar', 'neutron_star', 'wolf_rayet', 'supergiant'].includes(o.star.phase));
  check(exotic.length >= 20, `only ${exotic.length} exotic picks in 100`);
  const arcs = new Set(a.map((o) => sectorName(sectorOfPos(o.pos))));
  check(arcs.size >= 50, `interest picks bunch into ${arcs.size} arcs`);
}

// --- saucer dome: zero slope at the centre (no cone / golden spike) ---
{
  const h0 = saucerHeight(0);
  const hEps = saucerHeight(0.05);
  const slope = (h0 - hEps) / 0.05;
  check(Math.abs(slope) < 0.2, `bulge slope at R=0 is ${slope.toFixed(3)} (must be ~0, not a cone)`);
  check(saucerHeight(4) < h0, 'dome must fall with R');
  check(h0 > 2.2 * UNIVERSE.GALAXY_ZD, 'dome must sit above the disk slab');
}

if (fail) {
  console.error(`check-sectors: ${fail} failure(s)`);
  process.exit(1);
}
const b = ringBounds();
console.log('check-sectors: ok');
console.log(`  rings: inner span ${b[1] - b[0]} catalog rings, outer span ${b[b.length - 1] - b[b.length - 2]}`);
console.log(`  arcs: ${UNIVERSE.GALAXY_SECTORS * UNIVERSE.GALAXY_SECTOR_RINGS} (${UNIVERSE.GALAXY_SECTORS}×${UNIVERSE.GALAXY_SECTOR_RINGS})`);
