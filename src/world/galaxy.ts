/**
 * The shared galaxy: an SBbc (grand-design barred spiral) as a density
 * field plus an implicit stellar catalog. Nothing is stored. A star is
 * (seed, cell, slot) → position, population, IMF quantile, birth time,
 * chemistry, then stellar.evolve. The address *is* the star. We do not
 * keep a list of 7k samples; occupancy is the population.
 *
 * Within a cell the IMF is stratified: slot 0 is the low-mass end,
 * slot n−1 is the high-mass end. Zooming in is “include more slots,”
 * not “load a bigger array.”
 *
 * Lin–Shu arms are a cosine overdensity on a logarithmic spiral; the bar
 * is a Ferrers ellipsoid; the halo is a potential-shaped envelope. We do
 * not integrate N-body for 10 Gyr — that is the decreed shortcut, same
 * family as “orbits are stable by fiat.”
 */
import { mulberry32, xmur3 } from './rng';
import { UNIVERSE } from './physics';
import { evolve, imfMass, msLifetime, msLuminosity, msRadius, teffFromLR, type StellarState } from './stellar';

export type Population = 'thin' | 'thick' | 'halo' | 'bulge' | 'bar';

export interface GalPos {
  /** Galactocentric radius (kpc). */
  R: number;
  /** Azimuth (rad). */
  theta: number;
  /** Height above the midplane (kpc). */
  z: number;
}

export interface GalaxyObject {
  id: number;
  pos: GalPos;
  pop: Population;
  inArm: boolean;
  star: StellarState;
}

const TAU = Math.PI * 2;
const sech2 = (x: number) => {
  const e = Math.exp(x);
  const s = 2 / (e + 1 / e);
  return s * s;
};

function rngFor(seed: string, ...parts: Array<string | number>): () => number {
  return mulberry32(xmur3(`galaxy:${seed}:${parts.join(':')}`)());
}

function u01(seed: string, ...parts: Array<string | number>): number {
  return rngFor(seed, ...parts)();
}

/** Logarithmic-spiral phase. 0 = arm crest. */
export function armPhase(R: number, theta: number): number {
  const { GALAXY_ARM_M: m, GALAXY_PITCH: pitch, GALAXY_RD: rd } = UNIVERSE;
  const cot = 1 / Math.max(0.05, Math.tan(pitch));
  return m * theta - m * cot * Math.log(Math.max(R, 0.15) / rd);
}

export function inSpiralArm(R: number, theta: number): boolean {
  const c = Math.cos(armPhase(R, theta));
  return c > 0.25;
}

/**
 * Component densities at a point (relative, not physical Msun/pc³).
 * The catalog only needs shape and contrast.
 */
export function densityParts(p: GalPos): Record<Population, number> {
  const U = UNIVERSE;
  const r = Math.hypot(p.R, p.z);
  const thin =
    Math.exp(-p.R / U.GALAXY_RD) *
    sech2(p.z / U.GALAXY_ZD) *
    (1 + U.GALAXY_ARM_A * Math.cos(armPhase(p.R, p.theta)));
  const thick = 0.14 * Math.exp(-p.R / U.GALAXY_RD_THICK) * sech2(p.z / U.GALAXY_Z_THICK);
  const bulge = 4.2 * Math.exp(-3.5 * (r / U.GALAXY_RE_BULGE));
  const x = p.R * Math.cos(p.theta);
  const y = p.R * Math.sin(p.theta);
  const rb2 =
    (x * x) / (U.GALAXY_BAR_A * U.GALAXY_BAR_A) +
    (y * y) / (U.GALAXY_BAR_B * U.GALAXY_BAR_B) +
    (p.z * p.z) / (U.GALAXY_BAR_C * U.GALAXY_BAR_C);
  const bar = rb2 < 1 ? 3.4 * Math.pow(1 - rb2, 1.8) : 0;
  const halo = 0.03 / Math.pow(1 + r / U.GALAXY_HALO_A, 3.2);
  return {
    thin: Math.max(0, thin),
    thick: Math.max(0, thick),
    bulge: Math.max(0, bulge),
    bar: Math.max(0, bar),
    halo: Math.max(0, halo),
  };
}

export function density(p: GalPos): number {
  const d = densityParts(p);
  return d.thin + d.thick + d.bulge + d.bar + d.halo;
}

function pickPop(d: Record<Population, number>, u: number): Population {
  const keys: Population[] = ['thin', 'thick', 'bulge', 'bar', 'halo'];
  let t = 0;
  for (const k of keys) t += d[k];
  if (t <= 0) return 'halo';
  let acc = 0;
  const cut = u * t;
  for (const k of keys) {
    acc += d[k];
    if (cut <= acc) return k;
  }
  return 'thin';
}

/**
 * Inside-out, leaky-box chemistry. Inner disk formed earlier and is
 * metal-richer; halo is old and poor; bulge is old and rich. C/O climbs
 * with Z and with thin-disk youth (AGB return).
 */
export function chemistry(
  pop: Population,
  R: number,
  ageGyr: number,
  scatter: number,
): { feh: number; carbon: number } {
  const rd = UNIVERSE.GALAXY_RD;
  const young = 1 - ageGyr / UNIVERSE.GALAXY_AGE_GYR;
  let feh = 0;
  if (pop === 'thin') feh = 0.18 - 0.07 * (R / rd) + 0.22 * young;
  else if (pop === 'thick') feh = -0.55 - 0.03 * (R / rd);
  else if (pop === 'halo') feh = -1.55 + 0.15 * (R / (rd * 4));
  else if (pop === 'bulge') feh = 0.25 - 0.4 * Math.max(0, ageGyr - 8) / 5;
  else feh = 0.05 - 0.04 * (R / rd);
  feh += (scatter - 0.5) * (pop === 'halo' ? 0.7 : 0.25);
  const zRel = Math.pow(10, feh);
  const carbon = 0.55 + 0.45 * Math.min(2.2, zRel) + 0.35 * Math.max(0, young) * (pop === 'thin' ? 1 : 0.2);
  return { feh, carbon };
}

/** Birth-age window (Gyr of age today) for a population at radius R. */
export function ageWindow(pop: Population, R: number): [number, number] {
  const T = UNIVERSE.GALAXY_AGE_GYR;
  if (pop === 'thin') {
    const start = 0.35 * (R / UNIVERSE.GALAXY_R_MAX) * T;
    return [0.02, T - start];
  }
  if (pop === 'thick') return [6.5, 11.5];
  if (pop === 'halo') return [10, T];
  if (pop === 'bulge') return [7.5, T];
  return [6, T];
}

export function cellCount(): number {
  return UNIVERSE.GALAXY_NR * UNIVERSE.GALAXY_NTH * UNIVERSE.GALAXY_NZ;
}

export function catalogSize(): number {
  return cellCount() * UNIVERSE.GALAXY_MAX_SLOT;
}

export function splitId(id: number): { cell: number; slot: number } {
  const max = UNIVERSE.GALAXY_MAX_SLOT;
  return { cell: Math.floor(id / max), slot: id % max };
}

export function packId(cell: number, slot: number): number {
  return cell * UNIVERSE.GALAXY_MAX_SLOT + slot;
}

/** Half-diagonal of the slot scatter cube (kpc). A star may sit this far from its cell centre. */
export function slotScatterKpc(): number {
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / UNIVERSE.GALAXY_NZ;
  return 0.5 * dz * Math.sqrt(3);
}

/**
 * Catalog cells whose scatter cubes may meet a Cartesian ball
 * (disk in XZ, Y is height). Occupants are still filtered by
 * |p − centre| ≤ r. When the ball covers the origin we take every
 * spoke of the inner rings — a θ-wedge would miss the far side.
 */
export function cellsOverlappingBall(x: number, y: number, z: number, r: number): number[] {
  return cellsOverlappingAnnulus(x, y, z, 0, r);
}

/**
 * Catalog cells whose scatter cubes may meet a Cartesian spherical
 * shell rLo..rHi (inclusive). rLo = 0 is the filled ball.
 */
export function cellsOverlappingAnnulus(
  x: number,
  y: number,
  z: number,
  rLo: number,
  rHi: number,
): number[] {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const p = cartToGal(x, y, z);
  const slack = slotScatterKpc() + 0.02;
  const reach = rHi + slack;
  const inner = Math.max(0, rLo - slack);
  const ir0 = Math.max(0, Math.floor(((p.R - reach) / rMax) * nr));
  const ir1 = Math.min(nr - 1, Math.floor(((p.R + reach) / rMax) * nr));
  const coversCore = p.R <= reach;
  const dTh = coversCore ? Math.PI : reach / Math.max(0.35, p.R);
  const itc = Math.floor(((((p.theta % TAU) + TAU) % TAU) / TAU) * nth);
  const dit = coversCore ? Math.ceil(nth / 2) : Math.max(1, Math.ceil((dTh / TAU) * nth));
  const iz0 = Math.max(0, Math.floor((((p.z - reach) / zMax + 1) / 2) * nz));
  const iz1 = Math.min(nz - 1, Math.floor((((p.z + reach) / zMax + 1) / 2) * nz));
  const reach2 = reach * reach;
  const inner2 = inner * inner;
  const out: number[] = [];
  for (let ir = ir0; ir <= ir1; ir++) {
    for (let dt = -dit; dt <= dit; dt++) {
      const it = (itc + dt + nth * 16) % nth;
      for (let iz = iz0; iz <= iz1; iz++) {
        const cell = ir * nth * nz + it * nz + iz;
        const mid = cellCenter(cell);
        const mx = mid.R * Math.cos(mid.theta) - x;
        const my = mid.z - y;
        const mz = mid.R * Math.sin(mid.theta) - z;
        const d2 = mx * mx + my * my + mz * mz;
        if (d2 <= reach2 && d2 >= inner2) out.push(cell);
      }
    }
  }
  return out;
}

/** Inverse of imfMass — u in [0,1) for a given ZAMS mass. */
export function imfQuantile(mass: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) * 0.5;
    if (imfMass(mid) < mass) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Slot span inside a cell whose stratified IMF masses fall in [mLo, mHi].
 * High slots are massive (u → 1).
 */
export function slotRangeForMass(n: number, mLo: number, mHi: number): [number, number] {
  if (n <= 0) return [0, 0];
  const u0 = imfQuantile(mLo);
  const u1 = imfQuantile(mHi);
  const a = Math.max(0, Math.floor(Math.min(u0, u1) * n));
  const b = Math.min(n, Math.ceil(Math.max(u0, u1) * n));
  return [a, b];
}

export function cellCenter(cell: number): GalPos {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const iz = cell % nz;
  const it = Math.floor(cell / nz) % nth;
  const ir = Math.floor(cell / (nz * nth));
  const R = ((ir + 0.5) / nr) * rMax;
  const theta = ((it + 0.5) / nth) * TAU;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const z = ((iz + 0.5) / nz - 0.5) * 2 * zMax;
  return { R, theta, z };
}

function cellVolume(cell: number): number {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const ir = Math.floor(cell / (nz * nth));
  const R0 = (ir / nr) * rMax;
  const R1 = ((ir + 1) / nr) * rMax;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / nz;
  const dtheta = TAU / nth;
  return 0.5 * (R1 * R1 - R0 * R0) * dtheta * dz;
}

/** How many slots in this cell are occupied. Density is the law. */
let slotMemoSeed = '';
const slotMemo = new Map<number, number>();

export function slotsInCell(seed: string, cell: number): number {
  if (seed !== slotMemoSeed) {
    slotMemo.clear();
    slotMemoSeed = seed;
  }
  const hit = slotMemo.get(cell);
  if (hit !== undefined) return hit;
  const c = cellCenter(cell);
  const expect = density(c) * cellVolume(cell) * UNIVERSE.GALAXY_N_K;
  if (expect <= 0) {
    slotMemo.set(cell, 0);
    return 0;
  }
  const whole = Math.floor(expect);
  const extra = u01(seed, 'occ', cell) < expect - whole ? 1 : 0;
  const n = Math.min(UNIVERSE.GALAXY_MAX_SLOT, whole + extra);
  slotMemo.set(cell, n);
  return n;
}

/**
 * The object at a catalog id, or null if that slot is empty.
 * Pure and O(1). This is the whole galaxy.
 *
 * Memoized: pure means cacheable, and the explorer re-asks for the
 * same neighbourhood on every camera bin — without the memo each
 * rebuild re-ran evolve() thousands of times and hitched the frame.
 */
const objMemo = new Map<string, GalaxyObject | null>();

export function objectAt(seed: string, id: number): GalaxyObject | null {
  const memoKey = `${seed}:${id}`;
  const hit = objMemo.get(memoKey);
  if (hit !== undefined) return hit;
  const o = objectAtRaw(seed, id);
  if (objMemo.size > 130_000) objMemo.clear();
  objMemo.set(memoKey, o);
  return o;
}

function objectAtRaw(seed: string, id: number): GalaxyObject | null {
  const { cell, slot } = splitId(id);
  if (cell < 0 || cell >= cellCount() || slot < 0) return null;
  const filled = slotsInCell(seed, cell);
  if (slot >= filled) return null;
  const b = slotBirthRaw(seed, cell, slot, filled);
  const { feh, carbon } = chemistry(b.pop, b.pos.R, b.ageGyr, b.rng());
  const star = evolve({
    massZams: b.massZams,
    ageGyr: b.ageGyr,
    feh,
    carbon,
    inArm: b.inArm,
  });
  return { id, pos: b.pos, pop: b.pop, inArm: b.inArm, star };
}

/**
 * The birth of a slot: position, population, age, ZAMS mass — everything
 * `objectAt` uses before `evolve`. Cheap enough to run for every occupied
 * slot in an arc. The rng stream is left at the chemistry draw so
 * `objectAt` continues identically.
 */
export interface SlotBirth {
  pos: GalPos;
  pop: Population;
  inArm: boolean;
  ageGyr: number;
  massZams: number;
  rng: () => number;
}

/** Birth position only — same first three rng draws as `slotBirthRaw`. */
export function slotBirthCart(seed: string, cell: number, slot: number): { x: number; y: number; z: number } {
  const rng = rngFor(seed, cell, slot);
  const mid = cellCenter(cell);
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / UNIVERSE.GALAXY_NZ;
  const R = Math.max(0.05, mid.R + (rng() - 0.5) * dz);
  const theta = mid.theta + ((rng() - 0.5) * dz) / Math.max(0.4, mid.R);
  const z = mid.z + (rng() - 0.5) * dz;
  return { x: R * Math.cos(theta), y: z, z: R * Math.sin(theta) };
}

export function slotBirthRaw(seed: string, cell: number, slot: number, filled: number): SlotBirth {
  const rng = rngFor(seed, cell, slot);
  const mid = cellCenter(cell);
  const { GALAXY_NZ: nz } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / nz;
  // Scatter ISOTROPICALLY over the largest bin dimension. The cell is an
  // address bin, not a physical box: cells are needles (fine in R and θ,
  // 0.4 kpc tall), and confining slots to their own needle printed the
  // lattice as vertical chains of stars. One cube of side dz for all
  // three axes dissolves the grid; occupancy still carries the density
  // law, and a star's id (cell, slot) never moves.
  const pos: GalPos = {
    R: Math.max(0.05, mid.R + (rng() - 0.5) * dz),
    theta: mid.theta + ((rng() - 0.5) * dz) / Math.max(0.4, mid.R),
    z: mid.z + (rng() - 0.5) * dz,
  };
  const parts = densityParts(pos);
  const pop = pickPop(parts, rng());
  const [ageLo, ageHi] = ageWindow(pop, pos.R);
  const arm = inSpiralArm(pos.R, pos.theta);
  let uAge = rng();
  if (pop === 'thin' && arm) uAge = Math.pow(uAge, 2.2);
  const ageGyr = ageLo + uAge * Math.max(0.01, ageHi - ageLo);
  const jitter = u01(seed, 'imfJ', cell, slot);
  const uImf = Math.min(0.999999, (slot + jitter) / Math.max(1, filled));
  const massZams = imfMass(uImf);
  return { pos, pop, inArm: arm, ageGyr, massZams, rng };
}

export function isSlotAlive(massZams: number, ageGyr: number): boolean {
  return ageGyr < msLifetime(massZams);
}

export function slotMsLum(massZams: number): number {
  return msLuminosity(massZams);
}

export function slotMsTeff(massZams: number): number {
  return teffFromLR(msLuminosity(massZams), msRadius(massZams));
}

export interface NearQuery {
  /** Max objects to return. */
  limit?: number;
  /**
   * How deep into the faint IMF to go. 0.9 = currently luminous + nebulae
   * (the massive *dead* tail is not bright). 0 = include FGK and cool
   * dwarfs. Present-day light, not ZAMS mass.
   */
  uMin?: number;
}

/** Absolute per-cell coin: pure of the cell id, uncorrelated with the
 * lattice. The keep-sets it produces are nested as the threshold falls. */
function cellHash01(cell: number): number {
  let h = cell | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function pushNear(out: GalaxyObject[], seen: Set<number>, o: GalaxyObject | null, limit: number): boolean {
  if (!o || seen.has(o.id) || out.length >= limit) return out.length >= limit;
  seen.add(o.id);
  out.push(o);
  return out.length >= limit;
}

/** Walk a neighbourhood of cells; return occupied objects (capped). */
export function objectsNear(
  seed: string,
  p: GalPos,
  dR: number,
  limitOrOpts: number | NearQuery = 80,
): GalaxyObject[] {
  const opts: NearQuery = typeof limitOrOpts === 'number' ? { limit: limitOrOpts } : limitOrOpts;
  const limit = opts.limit ?? 80;
  const uMin = Math.max(0, Math.min(0.999, opts.uMin ?? 0));
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const ir0 = Math.max(0, Math.floor(((p.R - dR) / rMax) * nr));
  const ir1 = Math.min(nr - 1, Math.floor(((p.R + dR) / rMax) * nr));
  const dTh = dR / Math.max(0.4, p.R);
  const itc = Math.floor(((((p.theta % TAU) + TAU) % TAU) / TAU) * nth);
  const dit = Math.max(1, Math.ceil((dTh / TAU) * nth));
  const izc = Math.floor(((p.z / zMax + 1) / 2) * nz);
  const diz = Math.max(1, Math.ceil((dR / Math.max(0.2, 2 * zMax)) * nz));
  const out: GalaxyObject[] = [];
  const seen = new Set<number>();
  const perCell = uMin > 0.9 ? 4 : uMin > 0.5 ? 10 : 28;
  // The sample must be a LAW of the cells, not of the query window.
  // A window-relative walk returned a different subset after every
  // small pan — stars flashed in, were replaced, and each visited
  // cell dumped its whole per-cell budget while its neighbours gave
  // nothing (clumps of "crap" with voids between). Instead: keep a
  // cell iff an absolute hash of its id clears the budget threshold.
  // The keep-set is pan-stable (a cell's coin never re-flips) and
  // nested in zoom (lower thresholds keep subsets), and hash order is
  // uncorrelated with position, so coverage stays even. Kept cells
  // are then visited nearest-first, so the limit truncates at the far
  // fringe — where the view fade already sits — and a flyby is stars
  // drifting in at the edge, not a re-rolled sky.
  const nRings = Math.max(1, ir1 - ir0 + 1);
  const nThW = 2 * dit + 1;
  const izLo = Math.max(0, izc - diz);
  const izHi = Math.min(nz - 1, izc + diz);
  const totalCells = nRings * nThW * Math.max(1, izHi - izLo + 1);
  const CELL_BUDGET = 6000;
  // Quantized to powers of two: the raw ratio drifts with every small
  // window reshape, re-rolling the keep-set's fringe. Power-of-2 bins
  // change rarely, and when they do the sets stay nested.
  const rawThr = Math.min(1, CELL_BUDGET / Math.max(1, totalCells));
  const thr = rawThr >= 1 ? 1 : Math.pow(2, Math.round(Math.log2(rawThr)));
  // A wide detection bubble covers millions of cells — too many even to
  // hash-test. Coarsen the walk on an ABSOLUTE lattice (indices ≡ 0 mod
  // stride, never window-relative, so panning cannot re-roll it) and
  // compensate the keep probability, leaving the expected kept count —
  // and the nested-subset property — intact.
  let sR = 1;
  let sT = 1;
  let sZ = 1;
  const nZW = Math.max(1, izHi - izLo + 1);
  for (let g = 0; g < 10 && (nRings / sR) * (nThW / sT) * (nZW / sZ) > 300_000; g++) {
    if (nRings / sR >= nThW / sT && nRings / sR >= nZW / sZ) sR *= 2;
    else if (nThW / sT >= nZW / sZ) sT *= 2;
    else sZ *= 2;
  }
  const thrEff = Math.min(1, thr * sR * sT * sZ);
  const px = p.R * Math.cos(p.theta);
  const py = p.R * Math.sin(p.theta);
  const kept: Array<{ cell: number; d2: number }> = [];
  for (let ir = ir0; ir <= ir1; ir++) {
    if (ir % sR !== 0 && sR > 1) continue;
    const R = ((ir + 0.5) / nr) * rMax;
    for (let dt = -dit; dt <= dit; dt++) {
      const it = (itc + dt + nth * 8) % nth;
      if (it % sT !== 0 && sT > 1) continue;
      const th = ((it + 0.5) / nth) * TAU;
      const cx = R * Math.cos(th) - px;
      const cy = R * Math.sin(th) - py;
      for (let iz = izLo; iz <= izHi; iz++) {
        if (iz % sZ !== 0 && sZ > 1) continue;
        const cell = ir * nth * nz + it * nz + iz;
        if (cellHash01(cell) >= thrEff) continue;
        const cz = ((iz + 0.5) / nz - 0.5) * 2 * zMax - p.z;
        kept.push({ cell, d2: cx * cx + cy * cy + cz * cz });
      }
    }
  }
  kept.sort((a, b) => a.d2 - b.d2);
  // Spread the limit across the WHOLE window: if the kept cells would
  // overfill it, each contributes fewer stars (down to its single
  // brightest) so the sample spans every kpc of the view instead of
  // exhausting the limit on the nearest hundred cells — that both
  // clumped the sky and re-rolled most of it on every pan.
  const perCap = Math.max(1, Math.min(perCell, Math.ceil(limit / Math.max(1, kept.length))));
  for (let j = 0; j < kept.length && out.length < limit; j++) {
    {
      {
        const cell = kept[j].cell;
        const n = slotsInCell(seed, cell);
        if (n <= 0) continue;
        let taken = 0;
        const sHi = Math.floor(n * 0.7);
        for (let s = n - 1; s >= sHi && taken < perCap && out.length < limit; s--) {
          const o = objectAt(seed, packId(cell, s));
          if (!o) continue;
          const remnant =
            o.star.phase === 'white_dwarf' ||
            o.star.phase === 'neutron_star' ||
            o.star.phase === 'pulsar' ||
            o.star.phase === 'black_hole';
          const lit =
            o.star.nebula !== 'none' ||
            o.star.phase === 'wolf_rayet' ||
            (!remnant && o.star.luminosity >= 0.45);
          if (!lit) continue;
          if (pushNear(out, seen, o, limit)) return out;
          taken++;
        }
        if (uMin <= 0.93) {
          const [a, b] = slotRangeForMass(n, 0.55, 1.35);
          for (let s = a; s < b && taken < perCap * 2 && out.length < limit; s++) {
            const o = objectAt(seed, packId(cell, s));
            if (!o) continue;
            const st = o.star;
            if (st.phase !== 'main_sequence') continue;
            if (st.mk !== 'F' && st.mk !== 'G' && st.mk !== 'K') continue;
            if (pushNear(out, seen, o, limit)) return out;
            taken++;
          }
        }
        if (uMin <= 0.35) {
          const step = Math.max(1, Math.floor(n / 24));
          for (let s = 0; s < n && taken < perCap * 3 && out.length < limit; s += step) {
            if (pushNear(out, seen, objectAt(seed, packId(cell, s)), limit)) return out;
            taken++;
          }
        }
      }
    }
  }
  return out;
}

/**
 * A thin-disk G/K dwarf near the solar circle — the galactic cousin of
 * homeBodyId. Scan is init-only; the id is then a constant of the seed.
 */
const homeMemo = new Map<string, number>();

export function homeStarId(seed = UNIVERSE.CANONICAL_SEED): number {
  const hit = homeMemo.get(seed);
  if (hit != null) return hit;
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax, R_SUN: rSun } = UNIVERSE;
  const irSun = Math.round((rSun / rMax) * nr);
  const izMid = Math.floor(nz / 2);
  const it0 = Math.floor(u01(seed, 'home-az') * nth);
  let best = -1;
  let bestScore = -1e9;
  for (let dir = 0; dir <= 3; dir++) {
    for (const sign of dir === 0 ? [0] : [-1, 1]) {
      const ir = irSun + sign * dir;
      if (ir < 2 || ir >= nr - 1) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const iz = izMid + dz;
        if (iz < 0 || iz >= nz) continue;
        for (let w = 0; w <= 10; w++) {
          for (const sw of w === 0 ? [0] : [-1, 1]) {
            const it = (it0 + sw * w + nth) % nth;
            const cell = ir * nth * nz + it * nz + iz;
            const n = slotsInCell(seed, cell);
            const [s0, s1] = slotRangeForMass(n, 0.55, 1.3);
            for (let s = s0; s < s1; s++) {
              const o = objectAt(seed, packId(cell, s));
              if (!o) continue;
              const st = o.star;
              if (st.phase !== 'main_sequence') continue;
              if (st.mk !== 'G' && st.mk !== 'K' && st.mk !== 'F') continue;
              if (st.lumClass !== 'V' && st.lumClass !== 'VI') continue;
              if (o.pop === 'halo') continue;
              const score =
                (st.mk === 'G' ? 4 : st.mk === 'K' ? 2.5 : 1) +
                (o.pop === 'thin' ? 1.2 : 0) +
                (1 - Math.abs(st.feh)) +
                (st.nebula === 'none' ? 0.3 : 0) -
                Math.abs(o.pos.R - rSun) * 0.15 -
                Math.abs(o.pos.z) * 0.4;
              if (score > bestScore) {
                bestScore = score;
                best = o.id;
              }
            }
          }
        }
      }
    }
  }
  if (best < 0) throw new Error(`no FGK dwarf near the solar circle for seed ${seed}`);
  homeMemo.set(seed, best);
  return best;
}

/** Convenience: the canonical galaxy's home star. */
export function homeStar(seed = UNIVERSE.CANONICAL_SEED): GalaxyObject | null {
  return objectAt(seed, homeStarId(seed));
}

/**
 * FGK dwarfs near the solar circle (the home point) — a query, not a
 * catalog dump. First landing may sample thousands here. Never walks
 * the whole grid.
 */
export function solarCircleHosts(seed: string, max = 7000): GalaxyObject[] {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax, R_SUN: rSun } = UNIVERSE;
  const irSun = Math.round((rSun / rMax) * nr);
  const izMid = Math.floor(nz / 2);
  const it0 = Math.floor(u01(seed, 'hosts-az') * nth);
  const out: GalaxyObject[] = [];
  for (let w = 0; w < nth && out.length < max; w++) {
    const it = (it0 + w * 11) % nth;
    for (let dir = 0; dir <= 2 && out.length < max; dir++) {
      for (const sign of dir === 0 ? [0] : [-1, 1]) {
        const ir = irSun + sign * dir;
        if (ir < 2 || ir >= nr - 1) continue;
        for (let dz = -1; dz <= 1 && out.length < max; dz++) {
          const iz = izMid + dz;
          if (iz < 0 || iz >= nz) continue;
          const cell = ir * nth * nz + it * nz + iz;
          const n = slotsInCell(seed, cell);
          const [s0, s1] = slotRangeForMass(n, 0.55, 1.35);
          for (let s = s0; s < s1 && out.length < max; s++) {
            const o = objectAt(seed, packId(cell, s));
            if (!o) continue;
            const st = o.star;
            if (st.phase !== 'main_sequence') continue;
            if (st.mk !== 'F' && st.mk !== 'G' && st.mk !== 'K') continue;
            if (st.lumClass !== 'V' && st.lumClass !== 'VI') continue;
            if (o.pop === 'halo') continue;
            out.push(o);
          }
        }
      }
    }
  }
  return out;
}

/** Galactocentric cylindrical → Cartesian (disk in XZ, Y is height). */
export function galToCart(p: GalPos): { x: number; y: number; z: number } {
  return {
    x: p.R * Math.cos(p.theta),
    y: p.z,
    z: p.R * Math.sin(p.theta),
  };
}

export function cartToGal(x: number, y: number, z: number): GalPos {
  return { R: Math.hypot(x, z), theta: Math.atan2(z, x), z: y };
}

/**
 * A catalog row bright enough to draw as a pickable point. Hubble
 * photographs are young light and remnants, not the M-dwarf oatmeal
 * the IMF actually produces. The rest of the population is the GPU
 * field — the integral, not a point list.
 */
export function isBeacon(o: GalaxyObject): boolean {
  const st = o.star;
  if (st.nebula !== 'none') return true;
  if (
    st.phase === 'white_dwarf' ||
    st.phase === 'neutron_star' ||
    st.phase === 'pulsar' ||
    st.phase === 'black_hole' ||
    st.phase === 'giant' ||
    st.phase === 'supergiant' ||
    st.phase === 'wolf_rayet' ||
    st.phase === 'carbon_star' ||
    st.phase === 'subgiant'
  ) {
    return true;
  }
  if (st.mk === 'O' || st.mk === 'B' || st.mk === 'A' || st.mk === 'F') return true;
  return st.luminosity >= 0.8;
}

export interface DensitySample {
  x: number;
  y: number;
  z: number;
  d: number;
  pop: Population;
}

function dominantPop(parts: Record<Population, number>): Population {
  let pop: Population = 'thin';
  let best = parts.thin;
  const keys: Population[] = ['thick', 'bulge', 'bar', 'halo'];
  for (const k of keys) {
    if (parts[k] > best) {
      best = parts[k];
      pop = k;
    }
  }
  return pop;
}

/**
 * Importance-sample the mass model. Arms, bar and bulge get more
 * particles because they are denser — that is why a face-on view
 * reads as a grand-design spiral, not a painted texture.
 */
export function sampleDust(count: number, seed = UNIVERSE.CANONICAL_SEED): DensitySample[] {
  const rng = rngFor(seed, 'dust', count);
  const rMax = UNIVERSE.GALAXY_R_MAX;
  const zd = UNIVERSE.GALAXY_ZD;
  const out: DensitySample[] = [];
  // Saturate the core so the disk/arms still win draws (d ~ 0.1–0.7).
  const dScale = 2.4;
  let tries = 0;
  const maxTries = count * 80;
  while (out.length < count && tries < maxTries) {
    tries++;
    const R = rMax * Math.sqrt(rng());
    const theta = rng() * TAU;
    const u = Math.min(0.999, Math.max(0.001, rng()));
    const z = 0.5 * zd * Math.log(u / (1 - u));
    if (Math.abs(z) > UNIVERSE.GALAXY_Z_THICK * 3) continue;
    const pos = { R, theta, z };
    const parts = densityParts(pos);
    const d = parts.thin + parts.thick + parts.bulge + parts.bar + parts.halo;
    if (rng() > Math.min(1, d / dScale)) continue;
    const c = galToCart(pos);
    out.push({ x: c.x, y: c.y, z: c.z, d, pop: dominantPop(parts) });
  }
  return out;
}
