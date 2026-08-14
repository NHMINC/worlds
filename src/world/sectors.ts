/**
 * The sector map: the explorer's projection of the catalog grid.
 *
 * The galaxy is divided into GALAXY_SECTORS pizza slices and
 * GALAXY_SECTOR_RINGS annuli. One (ring, sector) intersection — a
 * "thick arc" — is an EXACT block of catalog cells (a contiguous span
 * of catalog rings × a contiguous span of spokes × every z bin), so the
 * address system is untouched: every star id keeps meaning what it
 * always meant.
 *
 * Ring boundaries are placed by EQUAL ENCLOSED MASS: the cumulative
 * radial mass profile of the same density law everything else uses is
 * inverted so each annulus holds ~the same number of stars. Inner arcs
 * are physically thin, outer arcs wide — the saucer equalises itself.
 *
 * Everything here is pure functions of (seed, ring, sector). Nothing is
 * stored; the map is mathematics.
 */
import { UNIVERSE } from './physics';
import {
  cellCenter,
  density,
  objectAt,
  packId,
  slotRangeForMass,
  slotsInCell,
  type GalPos,
  type GalaxyObject,
} from './galaxy';

const TAU = Math.PI * 2;

export interface SectorId {
  /** Annulus index, 0 (centre) .. GALAXY_SECTOR_RINGS-1 (rim). */
  ring: number;
  /** Pizza-slice index, 0 .. GALAXY_SECTORS-1, from azimuth 0. */
  sector: number;
}

/** Human name: sectors are letters+number (S37), rings count outward. */
export function sectorName(id: SectorId): string {
  return `S${id.sector + 1}·R${id.ring + 1}`;
}

// ------------------------------------------------------------- ring law

/**
 * Mass of each CATALOG ring (relative units): the same density ×
 * volume product slotsInCell uses, azimuth- and z-averaged. Computed
 * once — pure of the constants, independent of seed.
 */
let ringMassMemo: number[] | null = null;

export function catalogRingMasses(): number[] {
  if (ringMassMemo) return ringMassMemo;
  const { GALAXY_NR: nr, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const out = new Array<number>(nr).fill(0);
  const NTH_SAMP = 24;
  for (let ir = 0; ir < nr; ir++) {
    const R = ((ir + 0.5) / nr) * rMax;
    const R0 = (ir / nr) * rMax;
    const R1 = ((ir + 1) / nr) * rMax;
    // Annulus volume for this catalog ring (all θ, full z slab).
    const vol = Math.PI * (R1 * R1 - R0 * R0) * 2 * zMax;
    let mean = 0;
    for (let s = 0; s < NTH_SAMP; s++) {
      const theta = ((s + 0.5) / NTH_SAMP) * TAU;
      for (let zi = 0; zi < nz; zi += 3) {
        const z = ((zi + 0.5) / nz - 0.5) * 2 * zMax;
        mean += density({ R, theta, z });
      }
    }
    mean /= NTH_SAMP * Math.ceil(nz / 3);
    out[ir] = mean * vol;
  }
  ringMassMemo = out;
  return out;
}

/**
 * Sector-ring boundaries as CATALOG ring indices: RINGS+1 ascending
 * values from 0 to GALAXY_NR. Greedy equal-mass walk — each sector
 * ring closes once it holds its share of the cumulative mass (or one
 * catalog ring, whichever is larger: an indivisible dense core ring
 * may exceed the share on its own).
 */
let ringBoundsMemo: number[] | null = null;

export function ringBounds(): number[] {
  if (ringBoundsMemo) return ringBoundsMemo;
  const { GALAXY_NR: nr, GALAXY_SECTOR_RINGS: rings } = UNIVERSE;
  const mass = catalogRingMasses();
  const total = mass.reduce((a, b) => a + b, 0);
  const bounds: number[] = [0];
  let acc = 0;
  let spent = 0;
  for (let ir = 0; ir < nr; ir++) {
    acc += mass[ir];
    const ringsLeft = rings - (bounds.length - 1);
    const massLeft = total - spent;
    const share = massLeft / Math.max(1, ringsLeft);
    // Close this sector ring when it has its share — but never leave
    // fewer catalog rings than sector rings still to cut.
    if (
      bounds.length <= rings - 1 &&
      acc >= share &&
      nr - (ir + 1) >= rings - bounds.length
    ) {
      bounds.push(ir + 1);
      spent += acc;
      acc = 0;
    }
  }
  while (bounds.length < rings) bounds.push(nr - (rings - bounds.length));
  bounds.push(nr);
  ringBoundsMemo = bounds;
  return bounds;
}

/** Outer radius (kpc) of each sector-ring boundary — RINGS+1 values. */
export function ringRadii(): number[] {
  const { GALAXY_NR: nr, GALAXY_R_MAX: rMax } = UNIVERSE;
  return ringBounds().map((ir) => (ir / nr) * rMax);
}

// ------------------------------------------------------------ addressing

/** Catalog spoke span [it0, it1) of a sector slice. Exact partition. */
export function spokeBounds(sector: number): [number, number] {
  const { GALAXY_NTH: nth, GALAXY_SECTORS: S } = UNIVERSE;
  return [Math.floor((sector * nth) / S), Math.floor(((sector + 1) * nth) / S)];
}

export function sectorOfPos(p: GalPos): SectorId {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_SECTORS: S, GALAXY_R_MAX: rMax } = UNIVERSE;
  const ir = Math.max(0, Math.min(nr - 1, Math.floor((p.R / rMax) * nr)));
  const bounds = ringBounds();
  let ring = 0;
  while (ring < bounds.length - 2 && ir >= bounds[ring + 1]) ring++;
  const thN = (((p.theta % TAU) + TAU) % TAU) / TAU;
  const it = Math.min(nth - 1, Math.floor(thN * nth));
  // Exact inverse of spokeBounds: floor partitions disagree with the
  // naive floor(it·S/nth) wherever nth/S is fractional, so walk to the
  // bracket that actually contains this spoke.
  let sector = Math.min(S - 1, Math.floor((it * S) / nth));
  while (sector < S - 1 && it >= Math.floor(((sector + 1) * nth) / S)) sector++;
  while (sector > 0 && it < Math.floor((sector * nth) / S)) sector--;
  return { ring, sector };
}

export function sectorOfCell(cell: number): SectorId {
  return sectorOfPos(cellCenter(cell));
}

/** Every catalog cell inside one arc (ring span × spoke span × all z). */
export function sectorCells(id: SectorId): number[] {
  const { GALAXY_NTH: nth, GALAXY_NZ: nz } = UNIVERSE;
  const bounds = ringBounds();
  const [it0, it1] = spokeBounds(id.sector);
  const out: number[] = [];
  for (let ir = bounds[id.ring]; ir < bounds[id.ring + 1]; ir++) {
    for (let it = it0; it < it1; it++) {
      for (let iz = 0; iz < nz; iz++) {
        out.push(ir * nth * nz + it * nz + iz);
      }
    }
  }
  return out;
}

/** Arc centre (mid radius, mid azimuth, midplane) for cameras and labels. */
export function sectorCenter(id: SectorId): GalPos {
  const { GALAXY_NTH: nth } = UNIVERSE;
  const radii = ringRadii();
  const [it0, it1] = spokeBounds(id.sector);
  const theta = (((it0 + it1) / 2) / nth) * TAU;
  return { R: (radii[id.ring] + radii[id.ring + 1]) / 2, theta, z: 0 };
}

/** Rough bounding radius of the arc (for camera framing). */
export function sectorSpan(id: SectorId): number {
  const radii = ringRadii();
  const r0 = radii[id.ring];
  const r1 = radii[id.ring + 1];
  const arc = ((r0 + r1) / 2) * (TAU / UNIVERSE.GALAXY_SECTORS);
  return Math.max(r1 - r0, arc, UNIVERSE.GALAXY_Z_THICK * 2) * 0.75;
}

// -------------------------------------------------------------- content

/** Exact occupied-slot count of an arc: the law, not an estimate. */
export function sectorPopulation(seed: string, id: SectorId): number {
  let n = 0;
  for (const cell of sectorCells(id)) n += slotsInCell(seed, cell);
  return n;
}

/**
 * The brightest ~n REAL stars of an arc — a magnitude-limited survey.
 * Deterministic: high slots are the massive end of each cell's
 * stratified IMF, so we harvest each cell's top slots, rank everything
 * by present-day luminosity, and keep n. Every entry is a real
 * catalog id you can set course to.
 */
export function sectorSample(seed: string, id: SectorId, n = UNIVERSE.GALAXY_SECTOR_STARS): GalaxyObject[] {
  const cells = sectorCells(id);
  const out: GalaxyObject[] = [];
  // Enough per-cell depth to overfill n, so the global cut is by
  // luminosity rather than by which cell was visited first. Two bands
  // per cell: a small massive-tip take (remnants, O/B while they live,
  // supergiants) and the TURNOFF band (~0.9–2.4 M☉) walked from its
  // massive end — where the luminous LIVING stars are: giants,
  // subgiants, hot dwarfs. In an old population everything far above
  // the turnoff is dead, so a wide band surveys a graveyard.
  const perCell = Math.max(3, Math.ceil((n * 4) / Math.max(1, cells.length)));
  const tipTake = 1;
  for (const cell of cells) {
    const filled = slotsInCell(seed, cell);
    if (filled <= 0) continue;
    for (let k = 0; k < Math.min(tipTake, filled); k++) {
      const o = objectAt(seed, packId(cell, filled - 1 - k));
      if (o) out.push(o);
    }
    // Draws bias QUADRATICALLY toward the band's low-mass end: above
    // the turnoff the band is dead (white dwarfs), at the turnoff it
    // is giants and subgiants, below it the living F/G/K field. The
    // massive end still gets a look — that is where young cells keep
    // their A/B stars — the luminosity cut sorts the rest.
    const [bLo, bHi] = slotRangeForMass(filled, 0.82, 2.4);
    const bandN = Math.max(0, bHi - bLo);
    const bandTake = Math.min(perCell - tipTake, bandN);
    for (let j = 0; j < bandTake; j++) {
      const u = (j + 0.5) / bandTake;
      const s = bLo + Math.floor(u * u * bandN);
      const o = objectAt(seed, packId(cell, Math.min(s, bHi - 1)));
      if (o) out.push(o);
    }
  }
  out.sort((a, b) => starGlow(b) - starGlow(a));
  return out.slice(0, n);
}

/**
 * Display ranking: a magnitude-limited survey ranks by LIGHT. Nebulae
 * genuinely outshine stars. Pulsars and black holes keep a small
 * findability nudge (both are rare and have their own filter); plain
 * neutron stars sink or swim on their real luminosity, or the sky
 * reads as a graveyard.
 */
function starGlow(o: GalaxyObject): number {
  const st = o.star;
  if (st.nebula !== 'none') return 15 + st.luminosity;
  if (st.phase === 'black_hole') return 1.2;
  if (st.phase === 'pulsar') return Math.max(1.2, st.luminosity);
  return st.luminosity;
}

/**
 * ~n systems of interest, galaxy-wide and deterministic: an absolute-
 * lattice walk of the catalog (never camera-relative) harvesting each
 * visited cell's top slot, scored for spectacle — remnants, nebulae,
 * Wolf–Rayets, supergiants, then raw luminosity. Markers for the map;
 * every one is a real address.
 */
export function systemsOfInterest(seed: string, n = 100): GalaxyObject[] {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz } = UNIVERSE;
  const izMid = Math.floor(nz / 2);
  const picks: Array<{ o: GalaxyObject; score: number }> = [];
  // ~4600 cells sampled on a fixed lattice around the midplane.
  for (let ir = 2; ir < nr; ir += 5) {
    for (let it = 0; it < nth; it += 12) {
      for (const iz of [izMid - 3, izMid, izMid + 3]) {
        const cell = ir * nth * nz + it * nz + iz;
        const filled = slotsInCell(seed, cell);
        if (filled <= 0) continue;
        const o = objectAt(seed, packId(cell, filled - 1));
        if (!o) continue;
        picks.push({ o, score: interestScore(o) });
      }
    }
  }
  picks.sort((a, b) => b.score - a.score);
  const out: GalaxyObject[] = [];
  const perSector = new Map<string, number>();
  for (const p of picks) {
    if (out.length >= n) break;
    // Spread the wonder: at most two picks per arc.
    const key = sectorName(sectorOfPos(p.o.pos));
    const used = perSector.get(key) ?? 0;
    if (used >= 2) continue;
    perSector.set(key, used + 1);
    out.push(p.o);
  }
  return out;
}

function interestScore(o: GalaxyObject): number {
  const st = o.star;
  let s = Math.log10(1 + Math.max(0, st.luminosity));
  if (st.nebula !== 'none') s += 8;
  if (st.phase === 'black_hole') s += 9;
  if (st.phase === 'pulsar') s += 8;
  if (st.phase === 'neutron_star') s += 6;
  if (st.phase === 'wolf_rayet') s += 7;
  if (st.phase === 'supergiant') s += 5;
  if (st.phase === 'carbon_star') s += 4;
  return s;
}
