/**
 * The shared galaxy: a Milky Way mass model as a density field plus an
 * implicit stellar catalog. Nothing is stored. A star is (seed, cell,
 * slot) → position, population, IMF quantile, birth time, chemistry,
 * then stellar.evolve. The address *is* the star. Occupancy is
 * density × volume × GALAXY_N_K.
 *
 * Birth positions scatter around the cell so the polar lattice never
 * prints as rings or an axle: an in-plane Gaussian (nuclear-tight
 * in the core) plus a sech² draw on the local scale height
 * (spheroid inside the box/peanut, flared disk outside), centered
 * on the midplane — not the catalog z-brick. Within a cell the IMF is stratified:
 * slot 0 is the low-mass end, slot n−1 is the high-mass end.
 *
 * Arms are a midplane overdensity only. The bar / boxy bulge / X-peanut
 * are ellipsoidal. We do not integrate N-body for 10 Gyr — that is the
 * decreed shortcut, same family as “orbits are stable by fiat.”
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

function logSpiralPhase(R: number, theta: number, m: number, pitch: number): number {
  const cot = 1 / Math.max(0.05, Math.tan(pitch));
  return m * theta - m * cot * Math.log(Math.max(R, 0.15) / UNIVERSE.GALAXY_RD);
}

/** Four-arm MW stellar phase. 0 = crest. */
export function armPhase(R: number, theta: number): number {
  return logSpiralPhase(R, theta, UNIVERSE.GALAXY_ARM_M, UNIVERSE.GALAXY_PITCH);
}

function armPhase2(R: number, theta: number): number {
  return logSpiralPhase(R, theta, UNIVERSE.GALAXY_ARM_M2, UNIVERSE.GALAXY_PITCH2);
}

/** Stellar midplane arm factor — mild. Does not touch z. */
function stellarArm(R: number, theta: number): number {
  const U = UNIVERSE;
  return 1 + U.GALAXY_ARM_A * Math.cos(armPhase(R, theta)) + U.GALAXY_ARM_A2 * Math.cos(armPhase2(R, theta));
}

/** Gas / dust / H II arm factor — stronger, still in-plane. */
function gasArm(R: number, theta: number): number {
  return 1 + UNIVERSE.GALAXY_GAS_ARM_A * Math.cos(armPhase(R, theta));
}

export function inSpiralArm(R: number, theta: number): boolean {
  return Math.cos(armPhase(R, theta)) > 0.2 || Math.cos(armPhase2(R, theta)) > 0.45;
}

/** Broken exponential surface (Lian+2024): flat 3.5–7.5, then Rd. */
function diskSigma(R: number): number {
  const U = UNIVERSE;
  const blend = 1 / (1 + Math.exp((R - U.GALAXY_R_BREAK) / U.GALAXY_R_BREAK_W));
  return blend * Math.exp(-R / U.GALAXY_RD_INNER) + (1 - blend) * Math.exp(-R / U.GALAXY_RD);
}

/** Thin-disk scale height (kpc). Flares outside FLARE_R. */
export function thinScaleHeight(R: number): number {
  const U = UNIVERSE;
  const x = Math.max(0, R - U.GALAXY_FLARE_R);
  return U.GALAXY_ZD * (1 + U.GALAXY_FLARE_K * Math.pow(x, U.GALAXY_FLARE_P));
}

/**
 * Inner spheroid scale height (kpc). Box + peanut + nucleus — the
 * mass model's vertical envelope near the centre. This is why a
 * dense core becomes a bump edge-on, not a brighter line.
 */
export function spheroidScaleHeight(R: number): number {
  const U = UNIVERSE;
  const box = U.GALAXY_BOX_C * Math.exp(-0.5 * (R / U.GALAXY_BOX_A) ** 2);
  const peanut = U.GALAXY_PEANUT_Z * Math.exp(-0.5 * (R / U.GALAXY_PEANUT_R) ** 2);
  const nuc = U.GALAXY_NUC_ZD * Math.exp(-R / U.GALAXY_NUC_RD);
  return Math.max(box, peanut, nuc);
}

/** Birth vertical scale: inner spheroid or flared thin sheet, whichever is taller. */
export function diskScaleHeight(R: number): number {
  return Math.max(thinScaleHeight(R), spheroidScaleHeight(R));
}

/**
 * Local midplane height (kpc). Outer warp (S-curve edge-on) plus
 * corrugation (the plane is not a polished sheet). Analytic — one
 * law, no seed. Inner R stays flat so the axle stays empty.
 */
export function midplaneZ(R: number, theta: number): number {
  const U = UNIVERSE;
  const span = Math.max(1e-3, U.GALAXY_R_MAX - U.GALAXY_WARP_R);
  const w = Math.max(0, (R - U.GALAXY_WARP_R) / span);
  const warp = U.GALAXY_WARP_Z * w * w * Math.sin(theta - U.GALAXY_WARP_PHI);
  const t = Math.min(1, R / 3.5);
  const corr =
    U.GALAXY_CORRUGATE *
    t *
    (0.55 * Math.sin(2 * theta + 0.38 * R) +
      0.32 * Math.sin(3 * theta - 0.62 * R) +
      0.22 * Math.sin(theta + 0.85 * R));
  return warp + corr;
}

/**
 * Component densities at a point (relative, not physical Msun/pc³).
 * Occupancy uses the sum; a cell is how many stars that region is owed.
 */
export function densityParts(p: GalPos): Record<Population, number> {
  const U = UNIVERSE;
  const r = Math.hypot(p.R, p.z);
  const x = p.R * Math.cos(p.theta);
  const y = p.R * Math.sin(p.theta);
  const thin = U.GALAXY_THIN_AMP * diskSigma(p.R) * sech2(p.z / U.GALAXY_ZD) * stellarArm(p.R, p.theta);
  const thick = 0.13 * Math.exp(-p.R / U.GALAXY_RD_THICK) * sech2(p.z / U.GALAXY_Z_THICK);
  const rb2 =
    (x * x) / (U.GALAXY_BAR_A * U.GALAXY_BAR_A) +
    (y * y) / (U.GALAXY_BAR_B * U.GALAXY_BAR_B) +
    (p.z * p.z) / (U.GALAXY_BAR_C * U.GALAXY_BAR_C);
  const bar = rb2 < 1 ? U.GALAXY_BAR_AMP * Math.pow(1 - rb2, 1.6) : 0;
  const box =
    U.GALAXY_BOX_AMP *
    Math.exp(
      -0.5 *
        ((x * x) / (U.GALAXY_BOX_A * U.GALAXY_BOX_A) +
          (y * y) / (U.GALAXY_BOX_B * U.GALAXY_BOX_B) +
          (p.z * p.z) / (U.GALAXY_BOX_C * U.GALAXY_BOX_C)),
    );
  const k = U.GALAXY_PEANUT_Z / U.GALAXY_PEANUT_R;
  const xa = Math.min(Math.abs(x), 2.2);
  const ridge = Math.exp(
    -0.5 * ((x * x) / (1.45 * 1.45) + (y * y) / (0.42 * 0.42)),
  );
  const peanut =
    U.GALAXY_PEANUT_AMP *
    ridge *
    (Math.exp(-0.5 * ((p.z - k * xa) / 0.2) ** 2) + Math.exp(-0.5 * ((p.z + k * xa) / 0.2) ** 2));
  const nuc = U.GALAXY_NUC_AMP * Math.exp(-p.R / U.GALAXY_NUC_RD) * sech2(p.z / U.GALAXY_NUC_ZD);
  const bulge = box + peanut + nuc;
  const halo = U.GALAXY_HALO_AMP / Math.pow(1 + r / U.GALAXY_HALO_A, 3.5);
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

/** Lattice hash for the ISM noise, in [-1, 1]. Pure of the corner. */
let ismCornerSeed = '';
const ismCornerMemo = new Map<number, number>();

function ismCorner(seed: string, ix: number, iy: number, iz: number): number {
  if (seed !== ismCornerSeed) {
    ismCornerMemo.clear();
    ismCornerSeed = seed;
  }
  const key = ((ix + 512) << 20) | ((iy + 512) << 10) | (iz + 512);
  const hit = ismCornerMemo.get(key);
  if (hit !== undefined) return hit;
  const v = 2 * u01(seed, 'ism', ix, iy, iz) - 1;
  ismCornerMemo.set(key, v);
  return v;
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
 * Molecular sheet: bar-swept cavity × exponential decline × arm,
 * height relative to the warped / corrugated midplane. The hole
 * empties the axle (not a painted ring). Occupancy / SFR / H II
 * drink this; stellar density does not.
 */
function gasBase(p: GalPos): number {
  const U = UNIVERSE;
  const holeR = U.GALAXY_DUST_HOLE;
  const holeP = U.GALAXY_DUST_HOLE_P;
  const hole = holeR <= 0 ? 1 : 1 - Math.exp(-((p.R / holeR) ** holeP));
  const radial = hole * Math.exp(-p.R / (U.GALAXY_RD * U.GALAXY_RD_GAS));
  const zMid = midplaneZ(p.R, p.theta);
  return radial * sech2((p.z - zMid) / U.GALAXY_ZD_GAS) * gasArm(p.R, p.theta);
}

/**
 * Two-octave interpolated turbulence in ~[-1, 1]. Sampled in a
 * spiral-sheared frame so eddies are filaments (along-arm long,
 * across-arm short), not round blobs. Phase is embedded on a
 * circle so θ = 0 and θ = 2π agree — no polar seam.
 */
function ismTurbulence(seed: string, x: number, y: number, z: number): number {
  const f = UNIVERSE.GALAXY_TURB_FREQ;
  const S = UNIVERSE.GALAXY_TURB_SHEAR;
  const R = Math.max(0.15, Math.hypot(x, z));
  const a = armPhase(R, Math.atan2(z, x));
  // Along-arm = radius (changes slowly as you ride the spiral).
  // Across-arm = spiral phase on a circle (no θ-seam). Shear
  // widens that circle so filaments are narrow compared to
  // their length.
  const along = (R * f) / S;
  const vert = y * f;
  const w = f * S;
  return (
    (ismNoise(seed, along, vert, w * Math.cos(a)) +
      0.5 * ismNoise(seed, along * 2.3 + 31.7, vert * 2.3, w * Math.sin(a) * 2.3)) /
    1.5
  );
}

/**
 * Occupancy / SFR / H II ceil. The axle-era (1+A)·e^σ — so the
 * hole empties the core without rejuvenating the whole disk.
 * Photograph ceil is `gasCeil` (post-hole crest).
 */
function occCeil(): number {
  return (1 + UNIVERSE.GALAXY_GAS_ARM_A) * Math.exp(UNIVERSE.GALAXY_TURB_SIGMA);
}

/**
 * Crest of hole × decline × arm (z on the midplane). The dust
 * bake maps this peak × e^σ to 1 so ribbons write after the hole.
 */
let gasCeilMemo = { key: '', v: 0 };

function gasCeil(): number {
  const U = UNIVERSE;
  const key = `${U.GALAXY_DUST_HOLE}|${U.GALAXY_DUST_HOLE_P}|${U.GALAXY_RD}|${U.GALAXY_RD_GAS}|${U.GALAXY_GAS_ARM_A}|${U.GALAXY_TURB_SIGMA}|${U.GALAXY_R_MAX}`;
  if (gasCeilMemo.key === key) return gasCeilMemo.v;
  let peak = 1e-6;
  for (let i = 0; i <= 80; i++) {
    const R = (i / 80) * U.GALAXY_R_MAX;
    const hole = U.GALAXY_DUST_HOLE <= 0 ? 1 : 1 - Math.exp(-((R / U.GALAXY_DUST_HOLE) ** U.GALAXY_DUST_HOLE_P));
    peak = Math.max(
      peak,
      hole * Math.exp(-R / (U.GALAXY_RD * U.GALAXY_RD_GAS)) * (1 + U.GALAXY_GAS_ARM_A),
    );
  }
  const v = peak * Math.exp(U.GALAXY_TURB_SIGMA);
  gasCeilMemo = { key, v };
  return v;
}

/**
 * Continuous ISM at a catalog point (disk in XZ, Y is height).
 * `field` is occupancy / SFR / H II (occCeil). `photo` is the
 * dense-tail photograph (gasCeil). Same gas, two normalizations.
 */
export function ismAt(
  seed: string,
  x: number,
  y: number,
  z: number,
): { base: number; field: number; photo: number; turb: number } {
  const p = cartToGal(x, y, z);
  const base = gasBase(p);
  if (base <= 1e-5) return { base: 0, field: 0, photo: 0, turb: 0 };
  const turb = ismTurbulence(seed, x, y, z);
  const raw = base * Math.exp(UNIVERSE.GALAXY_TURB_SIGMA * turb);
  return {
    base,
    field: Math.min(1, raw / occCeil()),
    photo: Math.min(1, raw / gasCeil()),
    turb,
  };
}

/** Snap occupancy to the warped midplane when the cell overlaps the sheet. */
function sheetPos(mid: GalPos): GalPos {
  const half = (2 * UNIVERSE.GALAXY_Z_THICK * 4) / UNIVERSE.GALAXY_NZ / 2;
  const zMid = midplaneZ(mid.R, mid.theta);
  if (Math.abs(mid.z - zMid) <= half) return { R: mid.R, theta: mid.theta, z: zMid };
  return mid;
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
  const p = sheetPos(cellCenter(cell));
  const base = gasBase(p);
  let v = 0;
  if (base > 1e-5) {
    const c = galToCart(p);
    const s = ismTurbulence(seed, c.x, c.y, c.z);
    v = Math.min(1, (base * Math.exp(UNIVERSE.GALAXY_TURB_SIGMA * s)) / occCeil());
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
  const p = cellCenter(cell);
  const scatter = u01(seed, 'dustChem', cell);
  const { feh, carbon } = chemistry('thin', p.R, 0.5, scatter);
  // Radiation temperature proxy: hot inner disk, cooled by shielding.
  const warm = Math.exp(-p.R / (UNIVERSE.GALAXY_RD * 2)) * (1 - 0.55 * field);
  const iceFrac = clamp01(1.4 * (UNIVERSE.DUST_ICE_WARM - warm));
  const carbonFrac = clamp01((carbon - 1.2) * 0.9);
  return { field, feh, carbon, iceFrac, carbonFrac };
}

/**
 * In-plane Gaussian σ (kpc). Scatter only hides the polar lattice.
 * Tightness is occupancy: the nuclear cusp (NUC_RD) and the box already
 * live in the density field. Using the peanut *height* as an in-plane
 * σ washed that cusp into a kpc fog — the axle is the missing 50-pc
 * clamp, not a licence to smear across the bulge.
 *
 * Disk floor = polar bin diagonal (rings blur). Core floor = nuclear
 * disk, so 576 θ-bins at ir=0 share a blob, not a point, and not the
 * peanut.
 */
function inPlaneSigmaKpc(R: number): number {
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / UNIVERSE.GALAXY_NZ;
  const dR = UNIVERSE.GALAXY_R_MAX / UNIVERSE.GALAXY_NR;
  const cell = Math.max((0.5 * dz) / Math.sqrt(3), dR * Math.sqrt(2));
  const nuclear = UNIVERSE.GALAXY_NUC_RD * Math.exp(-R / UNIVERSE.GALAXY_NUC_RD);
  return Math.max(cell, nuclear);
}

/** Cap the Gaussian so query slack stays finite (3σ holds ~99%). */
const IN_PLANE_SIGMA_CAP = 3;

/**
 * Cartesian in-plane offset from the cell centre. Same two rng draws
 * the old R/θ box used — later draws (pop, age) do not move.
 */
function inPlaneBirth(mid: GalPos, uR: number, uTh: number): { R: number; theta: number } {
  const sigma = inPlaneSigmaKpc(mid.R);
  const mag = sigma * Math.min(IN_PLANE_SIGMA_CAP, Math.sqrt(-2 * Math.log(Math.max(1e-12, uR))));
  const ang = TAU * uTh;
  const x = mid.R * Math.cos(mid.theta) + mag * Math.cos(ang);
  const z = mid.R * Math.sin(mid.theta) + mag * Math.sin(ang);
  const R = Math.hypot(x, z);
  return { R, theta: R > 1e-8 ? Math.atan2(z, x) : mid.theta };
}

/**
 * Birth height. The cell is a quota, not a brick: z is drawn from
 * the local sech² scale (spheroid in the core, flared disk outside)
 * around the midplane. Adding the lattice z was the flat-top slab
 * and the left/right S — warp became a tilted box, not a sheet.
 */
function birthZ(_midZ: number, R: number, theta: number, u: number): number {
  const u01 = Math.min(0.999, Math.max(0.001, u));
  const h = diskScaleHeight(R);
  const z = UNIVERSE.GALAXY_STAR_MID * midplaneZ(R, theta) + 0.55 * h * Math.log(u01 / (1 - u01));
  const cap = UNIVERSE.GALAXY_Z_THICK * 4;
  return Math.max(-cap, Math.min(cap, z));
}

/** Clump position: the same scatter stars use. No lattice. */
export function dustBirthCart(seed: string, cell: number, k: number): { x: number; y: number; z: number } {
  const rng = rngFor(seed, 'dustPos', cell, k);
  const mid = cellCenter(cell);
  const { R, theta } = inPlaneBirth(mid, rng(), rng());
  const z = birthZ(mid.z, R, theta, rng());
  return { x: R * Math.cos(theta), y: z, z: R * Math.sin(theta) };
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

/** Half-reach of the slot scatter (kpc). A star may sit this far from its cell centre. */
export function slotScatterKpc(): number {
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const plane = IN_PLANE_SIGMA_CAP * inPlaneSigmaKpc(0);
  return Math.max(zMax, plane);
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
  rng: () => number;
}

/** Birth position only — same first three rng draws as `slotBirthRaw`. */
export function slotBirthCart(seed: string, cell: number, slot: number): { x: number; y: number; z: number } {
  const rng = rngFor(seed, cell, slot);
  const mid = cellCenter(cell);
  const { R, theta } = inPlaneBirth(mid, rng(), rng());
  const z = birthZ(mid.z, R, theta, rng());
  return { x: R * Math.cos(theta), y: z, z: R * Math.sin(theta) };
}

/**
 * ZAMS mass only. Independent `imfJ` stream — the same draw
 * `slotBirthRaw` uses. The harvest can reject a dead address
 * before it pays the birth stream.
 */
export function slotZams(seed: string, cell: number, slot: number, filled: number): number {
  const jitter = u01(seed, 'imfJ', cell, slot);
  return imfMass(Math.min(0.999999, (slot + jitter) / Math.max(1, filled)));
}

/**
 * Clock of a slot without the sech² height. Same draws as
 * `slotBirthRaw` up to the chemistry rng. Harvest rejects
 * skip `finishSlotBirth`; `objectAt` always finishes.
 */
export interface SlotClock {
  mid: GalPos;
  R: number;
  theta: number;
  uZ: number;
  pop: Population;
  inArm: boolean;
  inCloud: boolean;
  ageGyr: number;
  massZams: number;
  rng: () => number;
}

export function slotBirthClock(seed: string, cell: number, slot: number, filled: number): SlotClock {
  const rng = rngFor(seed, cell, slot);
  const mid = cellCenter(cell);
  const { GALAXY_NZ: nz } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / nz;
  // The cell is a quota, not a brick. In-plane scatter is a Gaussian
  // around the centre — nuclear-tight in the core — so the polar
  // lattice never prints as rings or an axle. Vertical scatter is a
  // sech² draw on the local scale (spheroid bump, flared disk),
  // not the z-bin. Occupancy still carries the density law; a
  // star's id (cell, slot) never moves.
  const { R, theta } = inPlaneBirth(mid, rng(), rng());
  const uZ = rng();
  // Pop drinks the un-puffed height so warp/flare move the photograph
  // without re-rolling the clock.
  const parts = densityParts({ R, theta, z: mid.z + (uZ - 0.5) * dz });
  const pop = pickPop(parts, rng());
  const [ageLo, ageHi] = ageWindow(pop, R);
  const arm = inSpiralArm(R, theta);
  const ism = ismNorm(seed, cell);
  // Schmidt–Kennicutt-lite: star formation follows the gas. The denser
  // the cloud, the more recent the births — nurseries emerge instead of
  // a binary "in arm" flag. Same rng draw count: ids never move.
  let uAge = rng();
  if (pop === 'thin') uAge = Math.pow(uAge, 1 + UNIVERSE.GALAXY_SFR_GAIN * ism);
  const ageGyr = ageLo + uAge * Math.max(0.01, ageHi - ageLo);
  return {
    mid,
    R,
    theta,
    uZ,
    pop,
    inArm: arm,
    inCloud: ism >= UNIVERSE.GALAXY_CLOUD_HII,
    ageGyr,
    massZams: slotZams(seed, cell, slot, filled),
    rng,
  };
}

/** Apply the sech² height. Same `pos` `slotBirthRaw` always returned. */
export function finishSlotBirth(c: SlotClock): SlotBirth {
  return {
    pos: { R: c.R, theta: c.theta, z: birthZ(c.mid.z, c.R, c.theta, c.uZ) },
    pop: c.pop,
    inArm: c.inArm,
    inCloud: c.inCloud,
    ageGyr: c.ageGyr,
    massZams: c.massZams,
    rng: c.rng,
  };
}

export function slotBirthRaw(seed: string, cell: number, slot: number, filled: number): SlotBirth {
  return finishSlotBirth(slotBirthClock(seed, cell, slot, filled));
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
    const zd = thinScaleHeight(R);
    const z = midplaneZ(R, theta) + 0.5 * zd * Math.log(u / (1 - u));
    if (Math.abs(z) > UNIVERSE.GALAXY_Z_THICK * 4) continue;
    const pos = { R, theta, z };
    const parts = densityParts(pos);
    const d = parts.thin + parts.thick + parts.bulge + parts.bar + parts.halo;
    if (rng() > Math.min(1, d / dScale)) continue;
    const c = galToCart(pos);
    out.push({ x: c.x, y: c.y, z: c.z, d, pop: dominantPop(parts) });
  }
  return out;
}
