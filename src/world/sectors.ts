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
  cellsOverlappingBall,
  density,
  galToCart,
  isSlotAlive,
  slotBirthCart,
  objectAt,
  packId,
  slotBirthRaw,
  slotMsLum,
  slotMsTeff,
  slotRangeForMass,
  slotsInCell,
  type GalPos,
  type GalaxyObject,
} from './galaxy';
import { mkFromTeff, teffToRgb } from './stellar';

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

/** GPU point cloud of every occupied slot in a query volume. No evolve(). */
export interface StarCloud {
  n: number;
  /** Catalog ids. Float64 — a packed id exceeds 2³² at the outer disk. */
  ids: Float64Array;
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  pulse: Float32Array;
  /** Inherent brightness 0..1 (faint M dwarfs stay pinpricks). */
  gain: Float32Array;
  /** Filter bits: remnant, hot, sunlike, cool, halo, arm. */
  bits: Uint8Array;
  /** MK letter index 0=WD/other, 1=O .. 8=M, 9=L, 10=T. */
  mk: Uint8Array;
  /** Cheap MS luminosity (alive) or a dim remnant pin. Apparent mag uses this. */
  lum: Float32Array;
  ms: number;
}

/** @deprecated use StarCloud — the play verb is a region, not an arc. */
export type ArcCloud = StarCloud;

const MK_IX: Record<string, number> = { O: 1, B: 2, A: 3, F: 4, G: 5, K: 6, M: 7, L: 8, T: 9 };

export const MK_LETTER = ['WD', 'O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T'] as const;

export const BIT_REMNANT = 1;
export const BIT_HOT = 2;
export const BIT_SUNLIKE = 4;
export const BIT_COOL = 8;
export const BIT_HALO = 16;
export const BIT_ARM = 32;

export type GalaxyFilterName =
  | 'all'
  | 'hot'
  | 'sunlike'
  | 'cool'
  | 'remnant'
  | 'nebula'
  | 'halo'
  | 'arm';

export function sketchMatches(bits: number, f: GalaxyFilterName): boolean {
  if (f === 'all') return true;
  if (f === 'hot') return (bits & BIT_HOT) !== 0;
  if (f === 'sunlike') return (bits & BIT_SUNLIKE) !== 0;
  if (f === 'cool') return (bits & BIT_COOL) !== 0;
  if (f === 'remnant') return (bits & BIT_REMNANT) !== 0;
  if (f === 'nebula') return false;
  if (f === 'halo') return (bits & BIT_HALO) !== 0;
  return (bits & BIT_ARM) !== 0;
}

function allocCloud(n: number): Omit<StarCloud, 'n' | 'ms'> {
  return {
    ids: new Float64Array(n),
    pos: new Float32Array(n * 3),
    col: new Float32Array(n * 3),
    size: new Float32Array(n),
    pulse: new Float32Array(n),
    gain: new Float32Array(n),
    bits: new Uint8Array(n),
    mk: new Uint8Array(n),
    lum: new Float32Array(n),
  };
}

function writeBirth(seed: string, cell: number, slot: number, filled: number, i: number, c: Omit<StarCloud, 'n' | 'ms'>): void {
  const b = slotBirthRaw(seed, cell, slot, filled);
  const cart = galToCart(b.pos);
  const alive = isSlotAlive(b.massZams, b.ageGyr);
  const L = alive ? slotMsLum(b.massZams) : 0.004;
  const teff = alive ? slotMsTeff(b.massZams) : 9000;
  const rgb = alive ? teffToRgb(teff) : ([0.62, 0.7, 0.88] as [number, number, number]);
  c.ids[i] = packId(cell, slot);
  c.pos[i * 3] = cart.x;
  c.pos[i * 3 + 1] = cart.y;
  c.pos[i * 3 + 2] = cart.z;
  c.col[i * 3] = rgb[0];
  c.col[i * 3 + 1] = rgb[1];
  c.col[i * 3 + 2] = rgb[2];
  c.size[i] = L < 0.05 ? 1.15 : 1.45 + Math.min(5.2, Math.log10(1 + L) * 2.0);
  c.gain[i] = 0.22 + 0.78 * (L / (L + 0.25));
  c.pulse[i] = 0;
  let bit = 0;
  if (!alive) bit |= BIT_REMNANT;
  else if (b.massZams > 1.4) bit |= BIT_HOT;
  else if (b.massZams >= 0.7 && b.massZams <= 1.15) bit |= BIT_SUNLIKE;
  else bit |= BIT_COOL;
  if (b.pop === 'halo') bit |= BIT_HALO;
  if (b.inArm) bit |= BIT_ARM;
  c.bits[i] = bit;
  c.mk[i] = alive ? (MK_IX[mkFromTeff(teff)] ?? 0) : 0;
  c.lum[i] = L;
}

function finishCloud(c: Omit<StarCloud, 'n' | 'ms'>, n: number, t0: number): StarCloud {
  if (n === c.ids.length) return { n, ...c, ms: performance.now() - t0 };
  return {
    n,
    ids: c.ids.slice(0, n),
    pos: c.pos.slice(0, n * 3),
    col: c.col.slice(0, n * 3),
    size: c.size.slice(0, n),
    pulse: c.pulse.slice(0, n),
    gain: c.gain.slice(0, n),
    bits: c.bits.slice(0, n),
    mk: c.mk.slice(0, n),
    lum: c.lum.slice(0, n),
    ms: performance.now() - t0,
  };
}

/**
 * One point per occupied slot in an arc tile. Kept for the saucer
 * tessellation checks — play uses `buildRegionCloud`.
 */
export function buildArcCloud(seed: string, id: SectorId): StarCloud {
  const t0 = performance.now();
  const cells = sectorCells(id);
  let n = 0;
  const filledOf = new Int32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const f = slotsInCell(seed, cells[i]);
    filledOf[i] = f;
    n += f;
  }
  const c = allocCloud(n);
  let i = 0;
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const filled = filledOf[ci];
    for (let slot = 0; slot < filled; slot++) writeBirth(seed, cell, slot, filled, i++, c);
  }
  return finishCloud(c, n, t0);
}

/** Human label for a region centre: "14.2 kpc · 46°". */
export function regionName(x: number, _y: number, z: number): string {
  const R = Math.hypot(x, z);
  const deg = (((Math.atan2(z, x) * 180) / Math.PI) + 360) % 360;
  return `${R.toFixed(1)} kpc · ${deg.toFixed(0)}°`;
}

/** IMF floor for a cell at distance d from the tap. 0 = every slot. */
export function regionImfFloor(d: number): number {
  const full = UNIVERSE.GALAXY_REGION_FULL_R;
  const ramp = UNIVERSE.GALAXY_REGION_U_RAMP;
  const t = Math.max(0, Math.min(1, (d - full) / Math.max(1e-4, ramp)));
  return t * UNIVERSE.GALAXY_REGION_U_FAR;
}

/**
 * Occupied slots inside a Cartesian ball. Near the tap the IMF is
 * complete. Farther cells keep only their massive tail — the same
 * zoom law as the catalog — so a multi-kpc volume has gaps you can
 * fly instead of a glowing marble. Cheap birth, no evolve.
 */
export function buildRegionCloud(seed: string, x: number, y: number, z: number, r = UNIVERSE.GALAXY_REGION_R): StarCloud {
  const t0 = performance.now();
  const cells = cellsOverlappingBall(x, y, z, r);
  const filledOf = new Int32Array(cells.length);
  const slot0 = new Int32Array(cells.length);
  let cap = 0;
  for (let i = 0; i < cells.length; i++) {
    const f = slotsInCell(seed, cells[i]);
    filledOf[i] = f;
    if (f <= 0) continue;
    const mid = cellCenter(cells[i]);
    const d = Math.hypot(
      mid.R * Math.cos(mid.theta) - x,
      mid.z - y,
      mid.R * Math.sin(mid.theta) - z,
    );
    const s0 = Math.floor(regionImfFloor(d) * f);
    slot0[i] = s0;
    cap += f - s0;
  }
  const c = allocCloud(cap);
  const r2 = r * r;
  let n = 0;
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const filled = filledOf[ci];
    for (let slot = slot0[ci]; slot < filled; slot++) {
      const p = slotBirthCart(seed, cell, slot);
      const dx = p.x - x;
      const dy = p.y - y;
      const dz = p.z - z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      writeBirth(seed, cell, slot, filled, n++, c);
    }
  }
  return finishCloud(c, n, t0);
}

/**
 * The brightest ~n REAL stars of an arc — a magnitude-limited survey.
 * Unique catalog ids, ranked by present-day light. The harvest is the
 * LIVING field (K/G/F that still burn at disk ages) plus a short
 * giant/hot tail and one massive-tip slot per cell (O/B while they
 * live, nebulae when they die). A quadratic walk of 0.8–2.4 M☉ is a
 * graveyard in an old population and must not fill the sky with WD
 * speckle. Every entry is a real catalog id you can set course to.
 */
export function sectorSample(seed: string, id: SectorId, n = UNIVERSE.GALAXY_SECTOR_STARS): GalaxyObject[] {
  const cells = sectorCells(id);
  const seen = new Set<number>();
  const out: GalaxyObject[] = [];
  const add = (cell: number, slot: number, filled: number): void => {
    if (slot < 0 || slot >= filled) return;
    const sid = packId(cell, slot);
    if (seen.has(sid)) return;
    const o = objectAt(seed, sid);
    if (!o) return;
    seen.add(sid);
    out.push(o);
  };
  const spread = (cell: number, filled: number, mLo: number, mHi: number, want: number): void => {
    const [bLo, bHi] = slotRangeForMass(filled, mLo, mHi);
    const bandN = Math.max(0, bHi - bLo);
    const take = Math.min(want, bandN);
    for (let j = 0; j < take; j++) {
      const slot = bLo + Math.floor(((j + 0.5) / take) * bandN);
      add(cell, Math.min(slot, bHi - 1), filled);
    }
  };
  // Overfill so the luminosity cut is global, not first-come.
  const livingTake = Math.max(4, Math.ceil((n * 3) / Math.max(1, cells.length)));
  for (const cell of cells) {
    const filled = slotsInCell(seed, cell);
    if (filled <= 0) continue;
    add(cell, filled - 1, filled);
    spread(cell, filled, 0.55, 1.05, livingTake);
    spread(cell, filled, 1.05, 3.0, 2);
  }
  out.sort((a, b) => starGlow(b) - starGlow(a));
  return out.slice(0, n);
}

/**
 * Display ranking: a magnitude-limited SKY ranks photospheres and
 * nebulae. Toy WD luminosities are stretched (the cooling clock is
 * compressed like TIME_SCALE); left raw they outshine K dwarfs and
 * the field reads as speckle. Bare remnants stay in the harvest and
 * the Remnants filter, but they do not fill the cut. Pulsars keep a
 * small findability nudge.
 */
function starGlow(o: GalaxyObject): number {
  const st = o.star;
  if (st.nebula !== 'none') return 15 + st.luminosity;
  if (st.phase === 'white_dwarf' || st.phase === 'neutron_star' || st.phase === 'black_hole') {
    return 0.02 * Math.max(st.luminosity, 1e-4);
  }
  if (st.phase === 'pulsar') return Math.max(0.8, st.luminosity);
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
  const perBin = new Map<string, number>();
  for (const p of picks) {
    if (out.length >= n) break;
    // Spread the wonder across the disk, not along old arc tiles.
    const key = `${Math.floor(p.o.pos.R / 1.6)}:${Math.floor(((((p.o.pos.theta % TAU) + TAU) % TAU) / TAU) * 24)}`;
    const used = perBin.get(key) ?? 0;
    if (used >= 2) continue;
    perBin.set(key, used + 1);
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
