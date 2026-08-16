/**
 * The active GalaxyField: which formed galaxy the catalog is sampling.
 *
 * The catalog law (`galaxy.ts`) is pointwise and synchronous; the field
 * it samples is minted once per (seed, FORMATION_VERSION) — by the boot
 * worker in the app (then installed here), or synchronously by scripts.
 * One field is active at a time: one page, one universe.
 *
 * Install also bakes the FITS — azimuthally averaged radial profiles
 * (chemistry, age, ring means for the arm test, cell-skip ceilings) and
 * the smooth exponential the GPU extinction integral uses. Those are
 * derived views of the same field, not a second law.
 */
import { UNIVERSE } from '../physics';
import { runFormation, FORMATION_VERSION } from './sim';
import { bakeField, fieldDensityParts, FIELD, type GalaxyField } from './field';

export interface FieldFits {
  /** Radial bin width (kpc) of every profile below. */
  ringDr: number;
  /** Ring mean of the disk surface density (thin + thick). */
  diskSigMean: Float32Array;
  /** Ring mean of the gas surface density (the arm tracer). */
  gasSigMean: Float32Array;
  /** Mass-weighted disk [Fe/H], mean age (Gyr), young fraction per ring. */
  fehDisk: Float32Array;
  ageDisk: Float32Array;
  youngDisk: Float32Array;
  /** Ring MAX of thin-disk midplane volume density (cell-skip ceiling). */
  thinPeak: Float32Array;
  /** Ring MAX of the thin scale height (ceiling sech² uses the fattest). */
  hPeak: Float32Array;
  /** Ring MAX of gas midplane volume density (dust ceiling). */
  gasPeak: Float32Array;
  /** Densest TYPICAL complex (p99.5 of midplane gas) — normalizes the
   * ISM field to ~1. A percentile, not the max: the softened nuclear
   * ring is a ~50× outlier that would otherwise zero the whole ISM. */
  gasMidPeak: number;
  /** Exponential fit of the gas disk for the GPU extinction sheet. */
  gasRd: number;
  gasZd: number;
  /** Exponential fit of the STELLAR disk — the radiation-field scale
   * (dust warmth follows starlight; the leftover gas disk is flat). */
  diskRd: number;
}

/** Uniform spatial hash of parents. Cube = 1 kpc — coarse on purpose. */
export interface ParentIndex {
  cube: number;
  grid: Map<number, number[]>;
}

interface ActiveField {
  field: GalaxyField;
  fits: FieldFits;
  parents: ParentIndex;
}

const PARENT_CUBE = 1;

function packCube(ix: number, iy: number, iz: number): number {
  return ((ix + 512) << 20) | ((iy + 512) << 10) | (iz + 512);
}

function buildParentIndex(f: GalaxyField): ParentIndex {
  const cube = PARENT_CUBE;
  const grid = new Map<number, number[]>();
  for (let j = 0; j < f.pN; j++) {
    const ix = Math.floor(f.pAX[j] / cube);
    const iy = Math.floor(f.pAY[j] / cube);
    const iz = Math.floor(f.pAZ[j] / cube);
    const k = packCube(ix, iy, iz);
    const b = grid.get(k);
    if (b) b.push(j);
    else grid.set(k, [j]);
  }
  return { cube, grid };
}

/** Parent indices whose jitter cube may meet the ball (catalog cartesian). */
export function parentsOverlappingBall(
  field: GalaxyField,
  index: ParentIndex,
  x: number,
  y: number,
  z: number,
  r: number,
): number[] {
  return parentsOverlappingAnnulus(field, index, x, y, z, 0, r);
}

/** Parent indices whose jitter cube may meet the spherical shell rLo..rHi. */
export function parentsOverlappingAnnulus(
  field: GalaxyField,
  index: ParentIndex,
  x: number,
  y: number,
  z: number,
  rLo: number,
  rHi: number,
): number[] {
  const slack = FIELD.JITTER * 3 + 0.02;
  const reach = rHi + slack;
  const inner = Math.max(0, rLo - slack);
  const cube = index.cube;
  const ix0 = Math.floor((x - reach) / cube);
  const ix1 = Math.floor((x + reach) / cube);
  const iy0 = Math.floor((y - reach) / cube);
  const iy1 = Math.floor((y + reach) / cube);
  const iz0 = Math.floor((z - reach) / cube);
  const iz1 = Math.floor((z + reach) / cube);
  const reach2 = reach * reach;
  const inner2 = inner * inner;
  const out: number[] = [];
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const bucket = index.grid.get(packCube(ix, iy, iz));
        if (!bucket) continue;
        for (let n = 0; n < bucket.length; n++) {
          const j = bucket[n];
          const dx = field.pAX[j] - x;
          const dy = field.pAY[j] - y;
          const dz = field.pAZ[j] - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 <= reach2 && d2 >= inner2) out.push(j);
        }
      }
    }
  }
  return out;
}

let active: ActiveField | null = null;

const RING_N = 96;

/**
 * The catalog's addressable cylinder (R ≤ rMax, |z| ≤ zMax) — the same
 * slab sectors.ts tessellates. bakeField renormalizes the population
 * integral over THIS volume so occupancy × N_K = GALAXY_POPULATION.
 */
export function catalogDomain(): { rMax: number; zMax: number } {
  return { rMax: UNIVERSE.GALAXY_R_MAX, zMax: UNIVERSE.GALAXY_Z_THICK * 4 };
}

function bakeFits(f: GalaxyField): FieldFits {
  const out = f.out;
  const dxCell = (2 * f.box) / out;
  const ringDr = f.box / RING_N;
  const wSum = new Float64Array(RING_N);
  const fehS = new Float64Array(RING_N);
  const ageS = new Float64Array(RING_N);
  const youngS = new Float64Array(RING_N);
  const sigS = new Float64Array(RING_N);
  const cellN = new Float64Array(RING_N);
  const thinPeak = new Float32Array(RING_N);
  const hPeak = new Float32Array(RING_N);
  const gasPeak = new Float32Array(RING_N);
  const gasS = new Float64Array(RING_N);
  const gasMids: number[] = [];
  let gasWsum = 0;
  let gasHsum = 0;
  for (let j = 0; j < out; j++) {
    const y = -f.box + (j + 0.5) * dxCell;
    for (let i = 0; i < out; i++) {
      const x = -f.box + (i + 0.5) * dxCell;
      const b = Math.min(RING_N - 1, Math.floor(Math.hypot(x, y) / ringDr));
      const k = j * out + i;
      const sig = f.sigThin[k] + f.sigThick[k];
      const h = Math.max(FIELD.H_MIN, f.hThin[k]);
      const hg = Math.max(FIELD.H_MIN, h * 0.5);
      cellN[b]++;
      sigS[b] += sig;
      gasS[b] += f.sigGas[k];
      if (sig > 0) {
        wSum[b] += sig;
        fehS[b] += f.feh[k] * sig;
        ageS[b] += f.ageGyr[k] * sig;
        youngS[b] += f.youngFrac[k] * sig;
      }
      const thinMid = f.sigThin[k] / (2 * h);
      if (thinMid > thinPeak[b]) thinPeak[b] = thinMid;
      if (h > hPeak[b]) hPeak[b] = h;
      const gasMid = f.sigGas[k] / (2 * hg);
      if (gasMid > gasPeak[b]) gasPeak[b] = gasMid;
      if (gasMid > 0) gasMids.push(gasMid);
      gasWsum += f.sigGas[k];
      gasHsum += f.sigGas[k] * hg;
    }
  }
  const diskSigMean = new Float32Array(RING_N);
  const gasSigMean = new Float32Array(RING_N);
  const fehDisk = new Float32Array(RING_N);
  const ageDisk = new Float32Array(RING_N);
  const youngDisk = new Float32Array(RING_N);
  const T = UNIVERSE.GALAXY_AGE_GYR;
  let lastFeh = 0;
  let lastAge = 0.55 * T;
  for (let b = 0; b < RING_N; b++) {
    diskSigMean[b] = cellN[b] > 0 ? sigS[b] / cellN[b] : 0;
    gasSigMean[b] = cellN[b] > 0 ? gasS[b] / cellN[b] : 0;
    if (wSum[b] > 1e-9) {
      lastFeh = fehS[b] / wSum[b];
      lastAge = ageS[b] / wSum[b];
      youngDisk[b] = youngS[b] / wSum[b];
    }
    fehDisk[b] = lastFeh;
    ageDisk[b] = lastAge;
  }
  // Least-squares exponentials over the body of the disk (skip the
  // hollow centre and the empty rim): one for the gas sheet, one for
  // the stellar disk (the radiation-field scale).
  const expFit = (valAt: (b: number) => number): number => {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let nFit = 0;
    for (let b = 0; b < RING_N; b++) {
      const R = (b + 0.5) * ringDr;
      const v = valAt(b);
      if (R < 1.5 || R > 15 || v <= 1e-9) continue;
      const ly = Math.log(v);
      sx += R;
      sy += ly;
      sxx += R * R;
      sxy += R * ly;
      nFit++;
    }
    const slope = nFit > 4 ? (nFit * sxy - sx * sy) / Math.max(1e-9, nFit * sxx - sx * sx) : -1 / 5;
    return Math.min(9, Math.max(2, -1 / Math.min(-1e-3, slope)));
  };
  const gasRd = expFit((b) => gasS[b] / Math.max(1, cellN[b]));
  const diskRd = expFit((b) => sigS[b] / Math.max(1, cellN[b]));
  const gasZd = Math.min(0.6, Math.max(FIELD.H_MIN, gasHsum / Math.max(1e-9, gasWsum)));
  gasMids.sort((a, b) => a - b);
  const gasMidPeak = gasMids.length > 0 ? gasMids[Math.floor(0.995 * (gasMids.length - 1))] : 0;
  return {
    ringDr,
    diskSigMean,
    gasSigMean,
    fehDisk,
    ageDisk,
    youngDisk,
    thinPeak,
    hPeak,
    gasPeak,
    gasMidPeak: Math.max(1e-9, gasMidPeak),
    gasRd,
    gasZd,
    diskRd,
  };
}

/** Adopt a field minted elsewhere (boot worker, IndexedDB cache). */
export function installGalaxyField(field: GalaxyField): void {
  active = { field, fits: bakeFits(field), parents: buildParentIndex(field) };
}

export function activeGalaxyField(): GalaxyField | null {
  return active?.field ?? null;
}

/**
 * The field for a seed — synchronously. The app installs the
 * worker-minted field at boot, so this is a lookup; scripts (and any
 * cold path) pay the formation run once. Blocking is the honest cost:
 * there is no catalog before the galaxy has formed.
 */
export function ensureGalaxyField(seed: string): GalaxyField {
  if (active && active.field.seed === seed && active.field.version === FORMATION_VERSION) {
    return active.field;
  }
  const r = runFormation(seed);
  const field = bakeField(
    seed,
    FORMATION_VERSION,
    r,
    UNIVERSE.GALAXY_AGE_GYR,
    UNIVERSE.GALAXY_POPULATION,
    UNIVERSE.GALAXY_N_K,
    catalogDomain(),
  );
  installGalaxyField(field);
  return field;
}

/** The active field + fits, forming the galaxy on demand. */
export function fieldFor(seed: string): ActiveField {
  ensureGalaxyField(seed);
  return active!;
}

/** Parents whose jitter may meet a catalog-cartesian ball. */
export function parentsNear(x: number, y: number, z: number, r: number): number[] {
  const { field, parents } = sampleField();
  return parentsOverlappingBall(field, parents, x, y, z, r);
}

/** Parents whose jitter may meet a catalog-cartesian shell. */
export function parentsNearAnnulus(
  x: number,
  y: number,
  z: number,
  rLo: number,
  rHi: number,
): number[] {
  const { field, parents } = sampleField();
  return parentsOverlappingAnnulus(field, parents, x, y, z, rLo, rHi);
}

/**
 * The field for unseeded samplers (densityParts and friends take a
 * position, not a seed). Every seeded entry point ensures its own
 * field first, so this is the active one; a cold start falls back to
 * the canonical galaxy.
 */
export function sampleField(): ActiveField {
  return active ?? fieldFor(UNIVERSE.CANONICAL_SEED);
}

/** Ring profile lookup (clamped). */
export function ringAt(profile: Float32Array, ringDr: number, R: number): number {
  const b = Math.min(profile.length - 1, Math.max(0, Math.floor(R / ringDr)));
  return profile[b];
}

/** Transfer list for posting a field between threads. */
export function fieldTransferables(f: GalaxyField): Transferable[] {
  return [
    f.sigThin.buffer,
    f.sigThick.buffer,
    f.hThin.buffer,
    f.feh.buffer,
    f.ageGyr.buffer,
    f.youngFrac.buffer,
    f.sigGas.buffer,
    f.fehGas.buffer,
    f.sphRho.buffer,
    f.sphFeh.buffer,
    f.sphAge.buffer,
    f.vcirc.buffer,
    f.pAX.buffer,
    f.pAY.buffer,
    f.pAZ.buffer,
    f.pKind.buffer,
    f.pAge.buffer,
    f.pFeh.buffer,
  ];
}

/** Structured-clone-safe copy (keep the local field after a transfer). */
export function cloneField(f: GalaxyField): GalaxyField {
  return {
    ...f,
    sigThin: f.sigThin.slice(),
    sigThick: f.sigThick.slice(),
    hThin: f.hThin.slice(),
    feh: f.feh.slice(),
    ageGyr: f.ageGyr.slice(),
    youngFrac: f.youngFrac.slice(),
    sigGas: f.sigGas.slice(),
    fehGas: f.fehGas.slice(),
    sphRho: f.sphRho.slice(),
    sphFeh: f.sphFeh.slice(),
    sphAge: f.sphAge.slice(),
    vcirc: f.vcirc.slice(),
    pAX: f.pAX.slice(),
    pAY: f.pAY.slice(),
    pAZ: f.pAZ.slice(),
    pKind: f.pKind.slice(),
    pAge: f.pAge.slice(),
    pFeh: f.pFeh.slice(),
  };
}

export { fieldDensityParts, FIELD, FORMATION_VERSION };
export type { GalaxyField };
