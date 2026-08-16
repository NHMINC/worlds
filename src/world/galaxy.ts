/**
 * The shared galaxy: the formed POINT CLOUD plus an implicit stellar
 * catalog. Nothing is stored. Each evolved star particle is a parent
 * and stands for ~starW real stars. A star is (seed, parent, slot) →
 * that parent's position plus a small tent jitter, the parent's
 * population / age / chemistry, then stellar.evolve. The address *is*
 * the star. Occupancy is starW per parent — that *is* the population.
 *
 * Within a parent the IMF is stratified: slot 0 is the low-mass end,
 * slot n−1 is the high-mass end. Zooming in is “include more slots,”
 * not “load a bigger array.”
 *
 * Gas / ISM / extinction stay a smooth grid: a medium, not a point
 * set. Dust still addresses that polar lattice.
 */
import { mulberry32, xmur3 } from './rng';
import { UNIVERSE } from './physics';
import { evolve, imfMass, msLifetime, msLuminosity, msRadius, teffFromLR, type StellarState } from './stellar';
import { parentsNear, parentsNearAnnulus, ringAt, sampleField } from './formation/registry';
import { FIELD, fieldDensityParts, fieldGridAt } from './formation/field';

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

function rngFor(seed: string, ...parts: Array<string | number>): () => number {
  return mulberry32(xmur3(`galaxy:${seed}:${parts.join(':')}`)());
}

function u01(seed: string, ...parts: Array<string | number>): number {
  return rngFor(seed, ...parts)();
}

/**
 * The spheroid of the formed field is one kinematic family (hot,
 * non-circular births). We split it at this radius for POP LABELS
 * only — inner spheroid reads as "bulge", outer as "halo" — the
 * density itself is one profile.
 */
const SPHEROID_BULGE_R = 3.0;

/**
 * Arm test: an arm is a composite structure — the stellar crest AND
 * the gas lane the dissipative ISM piles up alongside it (offset
 * downstream, as in real spirals). The run leaves ~5× gas contrast
 * against ~1.2× stellar, so the flag is a union of the two local
 * overdensities, each against its own ring mean. No spiral formula
 * to disagree with the sky.
 */
export function inSpiralArm(R: number, theta: number): boolean {
  const { field, fits } = sampleField();
  const x = R * Math.cos(theta);
  const y = R * Math.sin(theta);
  const gas = fieldGridAt(field, field.sigGas, x, y);
  const gMean = ringAt(fits.gasSigMean, fits.ringDr, R);
  const sig = fieldGridAt(field, field.sigThin, x, y) + fieldGridAt(field, field.sigThick, x, y);
  const sMean = ringAt(fits.diskSigMean, fits.ringDr, R);
  return (gMean > 1e-9 && gas > 1.3 * gMean) || (sMean > 1e-9 && sig > 1.15 * sMean);
}

/**
 * Component densities at a point (occupancy units — × GALAXY_N_K =
 * stars/kpc³), sampled from the formed field. 'bar' is retired as a
 * component: the bar the run grew lives inside the thin grid where it
 * kinematically belongs.
 */
export function densityParts(p: GalPos): Record<Population, number> {
  const { field } = sampleField();
  const x = p.R * Math.cos(p.theta);
  const y = p.R * Math.sin(p.theta);
  const parts = fieldDensityParts(field, x, y, p.z);
  const r = Math.hypot(p.R, p.z);
  const inner = r < SPHEROID_BULGE_R;
  return {
    thin: parts.thin,
    thick: parts.thick,
    bulge: inner ? parts.spheroid : 0,
    bar: 0,
    halo: inner ? 0 : parts.spheroid,
  };
}

export function density(p: GalPos): number {
  const d = densityParts(p);
  return d.thin + d.thick + d.bulge + d.bar + d.halo;
}

/** Lattice hash for the ISM noise, in [-1, 1]. Pure of the corner. */
function ismCorner(seed: string, ix: number, iy: number, iz: number): number {
  return 2 * u01(seed, 'ism', ix, iy, iz) - 1;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Trilinearly interpolated value noise in [-1, 1] — coherent, not a per-cell coin. */
function ismNoise(seed: string, x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(ismCorner(seed, ix, iy, iz), ismCorner(seed, ix + 1, iy, iz), fx);
  const c10 = lerp(ismCorner(seed, ix, iy + 1, iz), ismCorner(seed, ix + 1, iy + 1, iz), fx);
  const c01 = lerp(ismCorner(seed, ix, iy, iz + 1), ismCorner(seed, ix + 1, iy, iz + 1), fx);
  const c11 = lerp(ismCorner(seed, ix, iy + 1, iz + 1), ismCorner(seed, ix + 1, iy + 1, iz + 1), fx);
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
}

/**
 * The formed gas disk, normalized so the densest complex is ~1. The
 * sim left its gas where dissipation and the bar put it — arms and
 * rings in the ISM are inherited, not painted on with a cosine.
 */
function gasBase(p: GalPos): number {
  const { field, fits } = sampleField();
  const x = p.R * Math.cos(p.theta);
  const y = p.R * Math.sin(p.theta);
  const parts = fieldDensityParts(field, x, y, p.z);
  return Math.min(1, parts.gas / fits.gasMidPeak);
}

let ismMemoSeed = '';
const ismMemo = new Map<number, number>();

/**
 * The molecular-cloud field, normalized to ~[0, 1]: gas disk × arm
 * overdensity × log-normal of INTERPOLATED turbulence, so complexes
 * are coherent over ~1/TURB_FREQ kpc — many catalog cells, no
 * lattice. One field, three consumers: dust clump occupancy, the
 * star-formation age law, and the H II (nursery) condition.
 */
export function ismNorm(seed: string, cell: number): number {
  if (seed !== ismMemoSeed) {
    ismMemo.clear();
    ismMemoSeed = seed;
  }
  const hit = ismMemo.get(cell);
  if (hit !== undefined) return hit;
  const p = polarCellCenter(cell);
  const base = gasBase(p);
  let v = 0;
  if (base > 1e-5) {
    const c = galToCart(p);
    const f = UNIVERSE.GALAXY_TURB_FREQ;
    const s =
      (ismNoise(seed, c.x * f, c.y * f, c.z * f) +
        0.5 * ismNoise(seed, c.x * f * 2.3 + 31.7, c.y * f * 2.3, c.z * f * 2.3)) /
      1.5;
    // gasBase is already normalized to ~1 at the densest complex.
    const ceil = Math.exp(UNIVERSE.GALAXY_TURB_SIGMA);
    v = Math.min(1, (base * Math.exp(UNIVERSE.GALAXY_TURB_SIGMA * s)) / ceil);
  }
  if (ismMemo.size > 400_000) ismMemo.clear();
  ismMemo.set(cell, v);
  return v;
}

/**
 * Dust clumps are a POPULATION, not a per-cell overlay: expected
 * count = field × volume × GALAXY_DUST_N_K, floor + coin — the same
 * occupancy law as slotsInCell. Sparse gas mints nothing.
 */
export function dustClumpsInCell(seed: string, cell: number): number {
  const v = ismNorm(seed, cell);
  if (v <= 0) return 0;
  const expect = v * cellVolume(cell) * UNIVERSE.GALAXY_DUST_N_K;
  const whole = Math.floor(expect);
  const extra = u01(seed, 'dustOcc', cell) < expect - whole ? 1 : 0;
  return Math.min(UNIVERSE.GALAXY_DUST_MAX, whole + extra);
}

export interface DustPhysics {
  /** Normalized ISM field 0..1 — mean density of the clump. */
  field: number;
  feh: number;
  carbon: number;
  /** Fraction of grains wearing ice mantles (cold + dense + shielded). */
  iceFrac: number;
  /** Fraction of carbonaceous (sooty) grains: C/O-rich gas condenses carbon. */
  carbonFrac: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * What a dust clump is MADE of — a pure function of the address, no
 * storage. Density from the ISM field; metallicity and C/O from the
 * same chemistry law stars drink; temperature falls with radius and
 * dense cores are shielded, so cold outer clumps grow ice mantles
 * while C/O-rich inner gas condenses sooty carbon.
 */
export function dustPhysics(seed: string, cell: number): DustPhysics {
  const field = ismNorm(seed, cell);
  const p = polarCellCenter(cell);
  const scatter = u01(seed, 'dustChem', cell);
  const { feh, carbon } = chemistry('thin', p.R, 0.5, scatter);
  // Radiation temperature proxy: hot inner disk, cooled by shielding.
  // Warmth follows the STELLAR disk's fitted length — dust is heated
  // by starlight, and the leftover gas disk the run keeps is flat.
  const warm = Math.exp(-p.R / (sampleField().fits.diskRd * 1.4)) * (1 - 0.55 * field);
  const iceFrac = clamp01(1.4 * (UNIVERSE.DUST_ICE_WARM - warm));
  const carbonFrac = clamp01((carbon - 1.2) * 0.9);
  return { field, feh, carbon, iceFrac, carbonFrac };
}

/** Clump position: polar cell centre + the same tent stars use. */
export function dustBirthCart(seed: string, cell: number, k: number): { x: number; y: number; z: number } {
  const rng = rngFor(seed, 'dustPos', cell, k);
  return polarBirthCart(rng, cell);
}

/** Spheroid profile lookup (bulge + halo share one formed profile). */
function sphProfileAt(arr: Float32Array, sphDr: number, r: number): number {
  const b = Math.min(arr.length - 1, Math.max(0, Math.floor(r / sphDr)));
  return arr[b];
}

/**
 * Chemistry from the RUN, not a formula: the disk gradient is the
 * mass-weighted [Fe/H] the enrichment law actually left at that
 * radius; the spheroid's is the hot-birth profile (metal-rich where
 * the bulge formed fast, poor in the slow outer halo). The thin disk
 * keeps a small youth tilt (later births drink a richer box) and the
 * thick disk sits one enrichment era below its ring. C/O climbs with
 * Z and with thin-disk youth (AGB return).
 */
export function chemistry(
  pop: Population,
  R: number,
  ageGyr: number,
  scatter: number,
  cell?: number,
): { feh: number; carbon: number } {
  const { field, fits } = sampleField();
  const young = 1 - ageGyr / UNIVERSE.GALAXY_AGE_GYR;
  let feh = 0;
  if (cell != null && cell >= 0 && cell < field.pN) {
    feh = field.pFeh[cell];
  } else {
    const diskBase = ringAt(fits.fehDisk, fits.ringDr, R);
    if (pop === 'thin') feh = diskBase + 0.18 * young;
    else if (pop === 'thick') feh = diskBase - 0.35;
    else feh = sphProfileAt(field.sphFeh, field.sphDr, R);
  }
  feh += (scatter - 0.5) * (pop === 'halo' ? 0.7 : 0.25);
  const zRel = Math.pow(10, feh);
  const carbon = 0.55 + 0.45 * Math.min(2.2, zRel) + 0.35 * Math.max(0, young) * (pop === 'thin' ? 1 : 0.2);
  return { feh, carbon };
}

/**
 * Birth-age window (Gyr of age today) for a population at radius R —
 * anchored on the run's own mean-age maps. Inside-out growth, the old
 * thick disk and the ancient spheroid are what the sim produced, so
 * the windows follow it instead of restating it.
 */
export function ageWindow(pop: Population, R: number): [number, number] {
  const T = UNIVERSE.GALAXY_AGE_GYR;
  const { field, fits } = sampleField();
  if (pop === 'thin') {
    const mean = ringAt(fits.ageDisk, fits.ringDr, R);
    return [0.02, Math.min(T - 0.2, Math.max(1.5, 2 * mean))];
  }
  if (pop === 'thick') {
    const mean = ringAt(fits.ageDisk, fits.ringDr, R);
    return [Math.min(T - 1, Math.max(4, mean + 1.5)), T];
  }
  const sphMean = sphProfileAt(field.sphAge, field.sphDr, R);
  if (pop === 'halo') return [Math.min(T - 0.2, Math.max(6, sphMean)), T];
  return [Math.min(T - 0.5, Math.max(3, sphMean - 1.5)), T];
}

export function cellCount(): number {
  return sampleField().field.pN;
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

/** Tent half-width (kpc) — one number, shared by stars and dust. */
export function scatterKernelKpc(): number {
  return FIELD.JITTER;
}

/** Farthest a slot may sit from its parent (membership slack). */
export function slotScatterKpc(): number {
  return FIELD.JITTER * Math.sqrt(3);
}

/** Tent draw in [-w, w] (triangular, zero-mean). */
const tent = (rng: () => number, w: number): number => (rng() + rng() - 1) * w;

/** Star placement: parent + tent. That is the whole law. */
function birthCart(rng: () => number, cell: number): { x: number; y: number; z: number } {
  const { field } = sampleField();
  const w = FIELD.JITTER;
  return {
    x: field.pAX[cell] + tent(rng, w),
    y: field.pAY[cell] + tent(rng, w),
    z: field.pAZ[cell] + tent(rng, w),
  };
}

/** Dust placement: polar lattice centre + the same tent. */
function polarBirthCart(rng: () => number, cell: number): { x: number; y: number; z: number } {
  const mid = polarCellCenter(cell);
  const w = FIELD.JITTER;
  return {
    x: mid.R * Math.cos(mid.theta) + tent(rng, w),
    y: mid.z + tent(rng, w),
    z: mid.R * Math.sin(mid.theta) + tent(rng, w),
  };
}

/** Parents whose jitter cubes may meet a Cartesian ball. */
export function cellsOverlappingBall(x: number, y: number, z: number, r: number): number[] {
  return parentsNear(x, y, z, r);
}

/** Parents whose jitter cubes may meet a Cartesian spherical shell. */
export function cellsOverlappingAnnulus(
  x: number,
  y: number,
  z: number,
  rLo: number,
  rHi: number,
): number[] {
  return parentsNearAnnulus(x, y, z, rLo, rHi);
}

/** Polar ISM cells whose cubes may meet a Cartesian ball. Dust only. */
export function polarCellsOverlappingBall(x: number, y: number, z: number, r: number): number[] {
  return polarCellsOverlappingAnnulus(x, y, z, 0, r);
}

export function polarCellsOverlappingAnnulus(
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
        const mid = polarCellCenter(cell);
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

/** Parent position (no jitter) as galactocentric coords. */
export function cellCenter(cell: number): GalPos {
  const { field } = sampleField();
  if (cell < 0 || cell >= field.pN) return { R: 0, theta: 0, z: 0 };
  return cartToGal(field.pAX[cell], field.pAY[cell], field.pAZ[cell]);
}

/** Polar ISM lattice centre — dust / extinction addressing only. */
export function polarCellCenter(cell: number): GalPos {
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

function polarCellVolume(ir: number): number {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const R0 = (ir / nr) * rMax;
  const R1 = ((ir + 1) / nr) * rMax;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / nz;
  return 0.5 * (R1 * R1 - R0 * R0) * (TAU / nth) * dz;
}

function polarCellOf(p: GalPos): number {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const ir = Math.max(0, Math.min(nr - 1, Math.floor((p.R / rMax) * nr)));
  const th = (((p.theta % TAU) + TAU) % TAU) / TAU;
  const it = Math.max(0, Math.min(nth - 1, Math.floor(th * nth)));
  const iz = Math.max(0, Math.min(nz - 1, Math.floor(((p.z / zMax + 1) / 2) * nz)));
  return ir * nth * nz + it * nz + iz;
}

function cellVolume(cell: number): number {
  const ir = Math.floor(cell / (UNIVERSE.GALAXY_NZ * UNIVERSE.GALAXY_NTH));
  return polarCellVolume(ir);
}

/** How many slots this parent holds. starW is the law. */
let slotMemoSeed = '';
const slotMemo = new Map<number, number>();

export function slotsInCell(seed: string, cell: number): number {
  if (seed !== slotMemoSeed) {
    slotMemo.clear();
    slotMemoSeed = seed;
  }
  const hit = slotMemo.get(cell);
  if (hit !== undefined) return hit;
  const { field } = sampleField();
  if (cell < 0 || cell >= field.pN) {
    slotMemo.set(cell, 0);
    return 0;
  }
  const expect = field.starW;
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
  const { feh, carbon } = chemistry(b.pop, b.pos.R, b.ageGyr, b.rng(), cell);
  const star = evolve({
    massZams: b.massZams,
    ageGyr: b.ageGyr,
    feh,
    carbon,
    // The H II condition is the nursery (dense cloud), not the arm cosine.
    inArm: b.inCloud,
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
  /** Inside a dense molecular cloud (the nursery / H II condition). */
  inCloud: boolean;
  ageGyr: number;
  massZams: number;
  cell: number;
  rng: () => number;
}

/** Birth position only — same first six rng draws as `slotBirthRaw`. */
export function slotBirthCart(seed: string, cell: number, slot: number): { x: number; y: number; z: number } {
  return birthCart(rngFor(seed, cell, slot), cell);
}

function popOfParent(kind: number, R: number, z: number): Population {
  if (kind === 0) return 'thin';
  if (kind === 1) return 'thick';
  return Math.hypot(R, z) < SPHEROID_BULGE_R ? 'bulge' : 'halo';
}

export function slotBirthRaw(seed: string, cell: number, slot: number, filled: number): SlotBirth {
  const rng = rngFor(seed, cell, slot);
  const { field } = sampleField();
  const c = birthCart(rng, cell);
  const pos: GalPos = cartToGal(c.x, c.y, c.z);
  const pop = popOfParent(field.pKind[cell], pos.R, pos.z);
  const mean = field.pAge[cell];
  const T = UNIVERSE.GALAXY_AGE_GYR;
  const ageLo = Math.max(0.02, mean * 0.15);
  const ageHi = Math.min(T, Math.max(ageLo + 0.5, mean * 1.35));
  const arm = inSpiralArm(pos.R, pos.theta);
  const ism = ismNorm(seed, polarCellOf(pos));
  let uAge = rng();
  if (pop === 'thin') uAge = Math.pow(uAge, 1 + UNIVERSE.GALAXY_SFR_GAIN * ism);
  const ageGyr = ageLo + uAge * Math.max(0.01, ageHi - ageLo);
  const jitter = u01(seed, 'imfJ', cell, slot);
  const uImf = Math.min(0.999999, (slot + jitter) / Math.max(1, filled));
  const massZams = imfMass(uImf);
  return { pos, pop, inArm: arm, inCloud: ism >= UNIVERSE.GALAXY_CLOUD_HII, ageGyr, massZams, cell, rng };
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

/** Walk nearby parents; return occupied objects (capped). */
export function objectsNear(
  seed: string,
  p: GalPos,
  dR: number,
  limitOrOpts: number | NearQuery = 80,
): GalaxyObject[] {
  const opts: NearQuery = typeof limitOrOpts === 'number' ? { limit: limitOrOpts } : limitOrOpts;
  const limit = opts.limit ?? 80;
  const uMin = Math.max(0, Math.min(0.999, opts.uMin ?? 0));
  const out: GalaxyObject[] = [];
  const seen = new Set<number>();
  const perCell = uMin > 0.9 ? 4 : uMin > 0.5 ? 10 : 28;
  const c = galToCart(p);
  const near = cellsOverlappingBall(c.x, c.y, c.z, dR);
  const CELL_BUDGET = 6000;
  const rawThr = Math.min(1, CELL_BUDGET / Math.max(1, near.length));
  const thr = rawThr >= 1 ? 1 : Math.pow(2, Math.round(Math.log2(rawThr)));
  const { field } = sampleField();
  const kept: Array<{ cell: number; d2: number }> = [];
  for (let i = 0; i < near.length; i++) {
    const cell = near[i];
    if (cellHash01(cell) >= thr) continue;
    const dx = field.pAX[cell] - c.x;
    const dy = field.pAY[cell] - c.y;
    const dz = field.pAZ[cell] - c.z;
    kept.push({ cell, d2: dx * dx + dy * dy + dz * dz });
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
  const { field } = sampleField();
  const rSun = UNIVERSE.R_SUN;
  const az0 = u01(seed, 'home-az') * TAU;
  const cand: Array<{ cell: number; d: number }> = [];
  for (let cell = 0; cell < field.pN; cell++) {
    if (field.pKind[cell] === 2) continue;
    const x = field.pAX[cell];
    const z = field.pAZ[cell];
    const y = field.pAY[cell];
    const R = Math.hypot(x, z);
    if (Math.abs(R - rSun) > 1.6 || Math.abs(y) > 0.55) continue;
    const dth = Math.min(Math.abs(Math.atan2(z, x) - az0), TAU);
    cand.push({ cell, d: Math.abs(R - rSun) + Math.abs(y) * 0.6 + Math.min(dth, TAU - dth) * 0.3 });
  }
  cand.sort((a, b) => a.d - b.d);
  let best = -1;
  let bestScore = -1e9;
  const take = Math.min(48, cand.length);
  for (let i = 0; i < take; i++) {
    const cell = cand[i].cell;
    const n = slotsInCell(seed, cell);
    const [s0, s1] = slotRangeForMass(n, 0.55, 1.3);
    const step = Math.max(1, Math.floor((s1 - s0) / 12));
    for (let s = s0; s < s1; s += step) {
      const o = objectAt(seed, packId(cell, s));
      if (!o) continue;
      const st = o.star;
      if (st.phase !== 'main_sequence') continue;
      if (st.mk !== 'G' && st.mk !== 'K' && st.mk !== 'F') continue;
      if (st.lumClass !== 'V' && st.lumClass !== 'VI') continue;
      if (o.pop === 'halo') continue;
      const dth = Math.abs(o.pos.theta - az0);
      const score =
        (st.mk === 'G' ? 4 : st.mk === 'K' ? 2.5 : 1) +
        (o.pop === 'thin' ? 1.2 : 0) +
        (1 - Math.abs(st.feh)) +
        (st.nebula === 'none' ? 0.3 : 0) -
        Math.abs(o.pos.R - rSun) * 0.15 -
        Math.abs(o.pos.z) * 0.4 -
        Math.min(dth, TAU - dth) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = o.id;
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
  const { field } = sampleField();
  const rSun = UNIVERSE.R_SUN;
  const out: GalaxyObject[] = [];
  for (let cell = 0; cell < field.pN && out.length < max; cell++) {
    if (field.pKind[cell] === 2) continue;
    const R = Math.hypot(field.pAX[cell], field.pAZ[cell]);
    if (Math.abs(R - rSun) > 1.4 || Math.abs(field.pAY[cell]) > 0.5) continue;
    const n = slotsInCell(seed, cell);
    const [s0, s1] = slotRangeForMass(n, 0.55, 1.35);
    const step = Math.max(1, Math.floor((s1 - s0) / 16));
    for (let s = s0; s < s1 && out.length < max; s += step) {
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
 * Importance-sample the GAS disk — dust rides the gas, not the stars.
 * The lanes, rings and arm segments the run left in its ISM are why a
 * face-on view reads as a spiral, not a painted texture.
 */
export function sampleDust(count: number, seed = UNIVERSE.CANONICAL_SEED): DensitySample[] {
  const rng = rngFor(seed, 'dust', count);
  const { field, fits } = sampleField();
  const rMax = UNIVERSE.GALAXY_R_MAX;
  const out: DensitySample[] = [];
  let tries = 0;
  const maxTries = count * 400;
  while (out.length < count && tries < maxTries) {
    tries++;
    const R = rMax * Math.sqrt(rng());
    const theta = rng() * TAU;
    const x = R * Math.cos(theta);
    const y = R * Math.sin(theta);
    // Accept on the local midplane gas density, then draw z from the
    // sheet's own sech² column — the same law fieldDensityParts uses.
    const h = Math.max(FIELD.H_MIN, fieldGridAt(field, field.hThin, x, y));
    const hg = Math.max(FIELD.H_MIN, h * 0.5);
    const mid = fieldGridAt(field, field.sigGas, x, y) / (2 * hg);
    const d = mid / fits.gasMidPeak;
    if (rng() > Math.min(1, d)) continue;
    const u = Math.min(0.999, Math.max(0.001, rng()));
    const z = hg * Math.atanh(2 * u - 1);
    const pos = { R, theta, z };
    const c = galToCart(pos);
    out.push({ x: c.x, y: c.y, z: c.z, d, pop: dominantPop(densityParts(pos)) });
  }
  return out;
}
