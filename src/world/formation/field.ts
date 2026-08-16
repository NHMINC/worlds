/**
 * Bake the formation run into a GalaxyField: the pointwise density /
 * age / chemistry law the catalog samples. The sim is 2D (galaxies
 * are thin); the third dimension is derived per region from measured
 * kinematics — a self-gravitating isothermal sheet has ρ(z) =
 * Σ/(2h)·sech²(z/h) with h = σ_z²/(πGΣ), and σ_z is a fixed fraction
 * of the measured planar dispersion. Stars on hot / non-circular
 * orbits are the spheroid (bulge + halo): they get a spherical
 * profile from their own radial distribution. Populations are
 * KINEMATIC OUTCOMES here, not input labels.
 *
 * Ages: SIM_GYR of dynamical time stand in for GALAXY_AGE_GYR of
 * cosmic time (a named toy compression, like TIME_SCALE). The baked
 * ageGyr fields are already in galaxy-clock units.
 */
import type { FormationResult } from './sim';
import { dlog10 } from './detmath';

export interface GalaxyField {
  seed: string;
  version: number;
  /** Output grid is out×out over [-box, box] kpc. */
  out: number;
  box: number;
  /** Disk surface densities (relative units; see norm). */
  sigThin: Float32Array;
  sigThick: Float32Array;
  /** Thin-disk scale height (kpc); thick uses ×H_THICK_RATIO. */
  hThin: Float32Array;
  /** Mass-weighted mean [Fe/H] and age (Gyr) per cell. */
  feh: Float32Array;
  ageGyr: Float32Array;
  /** Fraction of the cell's stars younger than YOUNG_GYR. */
  youngFrac: Float32Array;
  /** Gas surface density (relative) and gas [Fe/H]. */
  sigGas: Float32Array;
  fehGas: Float32Array;
  /** Spheroid: spherical density profile bins (relative / kpc³). */
  sphRho: Float32Array;
  sphFeh: Float32Array;
  sphAge: Float32Array;
  sphDr: number;
  /** Rotation curve (km/s). */
  vcirc: Float32Array;
  vcDr: number;
  /** Normalization: density units are stars per kpc³ / GALAXY_N_K. */
  norm: number;
  hash: number;
  ms: number;
}

export const FIELD = {
  OUT: 256,
  /** σ_z / σ_planar for the sheet law. */
  SIGMA_Z_RATIO: 0.6,
  /** h clamp (kpc): resolution floor to a thick-disk ceiling. */
  H_MIN: 0.12,
  H_MAX: 1.6,
  H_THICK_RATIO: 2.6,
  /** Circularity split: spheroid below, thick between, thin above. */
  C_SPHEROID: 0.5,
  C_THIN: 0.8,
  /** "Young" for the nursery fraction (galaxy-clock Gyr). */
  YOUNG_GYR: 1.0,
  SPH_BINS: 96,
  SPH_RMAX: 24,
} as const;

const FEH_SUN = 0.0134;

function fnv(h: number, x: number): number {
  // FNV-1a over the float's bits.
  F32[0] = x;
  h ^= U32[0];
  return Math.imul(h, 16777619) >>> 0;
}
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/**
 * Bake. `ageSpanGyr` maps sim time onto the galaxy clock; `popTarget`
 * sets the density normalization so ∫ρ dV × GALAXY_N_K ≈ population.
 */
export function bakeField(
  seed: string,
  version: number,
  r: FormationResult,
  ageSpanGyr: number,
  popTarget: number,
  nK: number,
): GalaxyField {
  const t0 = performance.now();
  const OUT = FIELD.OUT;
  const box = 22;
  const dx = (2 * box) / OUT;
  const n2 = OUT * OUT;

  // Per-particle circularity: vφ / vc(r).
  const nvc = r.vcirc.length;
  const vcAt = (rad: number): number => {
    const b = Math.min(nvc - 1, Math.max(0, Math.floor(rad / r.vcDr)));
    return Math.max(20, r.vcirc[b]);
  };

  // --- accumulate disk grids (CIC) and spheroid bins ---
  const mThin = new Float64Array(n2);
  const mThick = new Float64Array(n2);
  const sVx = new Float64Array(n2);
  const sVy = new Float64Array(n2);
  const sV2 = new Float64Array(n2);
  const mAll = new Float64Array(n2);
  const sFeh = new Float64Array(n2);
  const sAge = new Float64Array(n2);
  const sYoung = new Float64Array(n2);
  const mGas = new Float64Array(n2);
  const sFehGas = new Float64Array(n2);
  const sphM = new Float64Array(FIELD.SPH_BINS);
  const sphFehS = new Float64Array(FIELD.SPH_BINS);
  const sphAgeS = new Float64Array(FIELD.SPH_BINS);
  const sphDr = FIELD.SPH_RMAX / FIELD.SPH_BINS;

  const ageOf = (i: number): number => ((r.tTotal - r.tBirth[i]) / r.tTotal) * ageSpanGyr;
  const fehOf = (i: number): number => dlog10(Math.max(1e-6, r.metal[i]) / FEH_SUN);

  let nStars = 0;
  let nSph = 0;
  for (let i = 0; i < r.n; i++) {
    const x = r.px[i];
    const y = r.py[i];
    const rad = Math.hypot(x, y);
    const gx = (x + box) / dx - 0.5;
    const gy = (y + box) / dx - 0.5;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const inGrid = i0 >= 0 && i0 < OUT - 1 && j0 >= 0 && j0 < OUT - 1;

    if (!r.star[i]) {
      if (!inGrid) continue;
      const tx = gx - i0;
      const ty = gy - j0;
      const b = j0 * OUT + i0;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const feh = fehOf(i);
      mGas[b] += w00;
      mGas[b + 1] += w10;
      mGas[b + OUT] += w01;
      mGas[b + OUT + 1] += w11;
      sFehGas[b] += feh * w00;
      sFehGas[b + 1] += feh * w10;
      sFehGas[b + OUT] += feh * w01;
      sFehGas[b + OUT + 1] += feh * w11;
      continue;
    }

    nStars++;
    const vphi = (x * r.vy[i] - y * r.vx[i]) / Math.max(rad, 1e-6);
    const c = vphi / vcAt(rad);
    const age = ageOf(i);
    const feh = fehOf(i);

    if (c < FIELD.C_SPHEROID) {
      // Spheroid: spherical shells from the particle's own radius.
      nSph++;
      const b = Math.min(FIELD.SPH_BINS - 1, Math.floor(rad / sphDr));
      sphM[b] += 1;
      sphFehS[b] += feh;
      sphAgeS[b] += age;
      continue;
    }
    if (!inGrid) continue;
    const tx = gx - i0;
    const ty = gy - j0;
    const b = j0 * OUT + i0;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    const tgt = c >= FIELD.C_THIN ? mThin : mThick;
    tgt[b] += w00;
    tgt[b + 1] += w10;
    tgt[b + OUT] += w01;
    tgt[b + OUT + 1] += w11;
    mAll[b] += w00;
    mAll[b + 1] += w10;
    mAll[b + OUT] += w01;
    mAll[b + OUT + 1] += w11;
    sVx[b] += r.vx[i] * w00;
    sVx[b + 1] += r.vx[i] * w10;
    sVx[b + OUT] += r.vx[i] * w01;
    sVx[b + OUT + 1] += r.vx[i] * w11;
    sVy[b] += r.vy[i] * w00;
    sVy[b + 1] += r.vy[i] * w10;
    sVy[b + OUT] += r.vy[i] * w01;
    sVy[b + OUT + 1] += r.vy[i] * w11;
    const v2 = r.vx[i] * r.vx[i] + r.vy[i] * r.vy[i];
    sV2[b] += v2 * w00;
    sV2[b + 1] += v2 * w10;
    sV2[b + OUT] += v2 * w01;
    sV2[b + OUT + 1] += v2 * w11;
    sFeh[b] += feh * w00;
    sFeh[b + 1] += feh * w10;
    sFeh[b + OUT] += feh * w01;
    sFeh[b + OUT + 1] += feh * w11;
    sAge[b] += age * w00;
    sAge[b + 1] += age * w10;
    sAge[b + OUT] += age * w01;
    sAge[b + OUT + 1] += age * w11;
    const young = age < FIELD.YOUNG_GYR ? 1 : 0;
    sYoung[b] += young * w00;
    sYoung[b + 1] += young * w10;
    sYoung[b + OUT] += young * w01;
    sYoung[b + OUT + 1] += young * w11;
  }

  // --- normalize: field density × nK integrates to popTarget ---
  // Count integral: disk mass in particles × (1 per particle) spread
  // over kpc²; spheroid likewise over kpc³. Convert to "occupancy
  // density" by one global scale s so that Σ counts × s × nK = pop.
  const totalParticles = nStars;
  const perStar = popTarget / Math.max(1, totalParticles) / nK;
  const cellArea = dx * dx;

  const sigThin = new Float32Array(n2);
  const sigThick = new Float32Array(n2);
  const hThin = new Float32Array(n2);
  const feh = new Float32Array(n2);
  const ageGyr = new Float32Array(n2);
  const youngFrac = new Float32Array(n2);
  const sigGas = new Float32Array(n2);
  const fehGas = new Float32Array(n2);

  for (let k = 0; k < n2; k++) {
    // Surface density in "stars per kpc² × perStar".
    sigThin[k] = (mThin[k] / cellArea) * perStar;
    sigThick[k] = (mThick[k] / cellArea) * perStar;
    sigGas[k] = (mGas[k] / cellArea) * perStar;
    const m = mAll[k];
    if (m > 3) {
      const mvx = sVx[k] / m;
      const mvy = sVy[k] / m;
      const disp2 = Math.max(4, sV2[k] / m - mvx * mvx - mvy * mvy);
      const sigZ2 = disp2 * 0.5 * FIELD.SIGMA_Z_RATIO * FIELD.SIGMA_Z_RATIO;
      // h = σz²/(πGΣ): G-folded surface density of ALL local mass.
      const gSig = ((m + mGas[k]) * r.gm) / cellArea;
      const h = sigZ2 / Math.max(1, Math.PI * gSig);
      hThin[k] = Math.min(FIELD.H_MAX, Math.max(FIELD.H_MIN, h));
      feh[k] = sFeh[k] / m;
      ageGyr[k] = sAge[k] / m;
      youngFrac[k] = sYoung[k] / m;
    } else {
      hThin[k] = 0.3;
      feh[k] = -1;
      ageGyr[k] = ageSpanGyr * 0.7;
      youngFrac[k] = 0;
    }
    fehGas[k] = mGas[k] > 3 ? sFehGas[k] / mGas[k] : -1;
  }

  const sphRho = new Float32Array(FIELD.SPH_BINS);
  const sphFeh = new Float32Array(FIELD.SPH_BINS);
  const sphAge = new Float32Array(FIELD.SPH_BINS);
  for (let b = 0; b < FIELD.SPH_BINS; b++) {
    const r0 = b * sphDr;
    const r1 = r0 + sphDr;
    const vol = (4 / 3) * Math.PI * (r1 ** 3 - r0 ** 3);
    sphRho[b] = (sphM[b] / vol) * perStar;
    sphFeh[b] = sphM[b] > 0 ? sphFehS[b] / sphM[b] : -1.4;
    sphAge[b] = sphM[b] > 0 ? sphAgeS[b] / sphM[b] : ageSpanGyr * 0.85;
  }

  const vcirc = new Float32Array(r.vcirc.length);
  for (let i = 0; i < vcirc.length; i++) vcirc[i] = r.vcirc[i];

  let hash = 2166136261 >>> 0;
  for (let k = 0; k < n2; k += 7) hash = fnv(hash, sigThin[k]);
  for (let k = 0; k < n2; k += 7) hash = fnv(hash, hThin[k]);
  for (let b = 0; b < FIELD.SPH_BINS; b++) hash = fnv(hash, sphRho[b]);

  return {
    seed,
    version,
    out: OUT,
    box,
    sigThin,
    sigThick,
    hThin,
    feh,
    ageGyr,
    youngFrac,
    sigGas,
    fehGas,
    sphRho,
    sphFeh,
    sphAge,
    sphDr,
    vcirc,
    vcDr: r.vcDr,
    norm: perStar,
    hash,
    ms: performance.now() - t0,
  };
}

function bilinear(a: Float32Array, out: number, gx: number, gy: number): number {
  const i0 = Math.max(0, Math.min(out - 2, Math.floor(gx)));
  const j0 = Math.max(0, Math.min(out - 2, Math.floor(gy)));
  const tx = Math.max(0, Math.min(1, gx - i0));
  const ty = Math.max(0, Math.min(1, gy - j0));
  const b = j0 * out + i0;
  return (
    a[b] * (1 - tx) * (1 - ty) + a[b + 1] * tx * (1 - ty) + a[b + out] * (1 - tx) * ty + a[b + out + 1] * tx * ty
  );
}

const sech2 = (x: number): number => {
  if (x > 20 || x < -20) return 0;
  const e = Math.exp(x);
  const s = 2 / (e + 1 / e);
  return s * s;
};

export interface FieldParts {
  thin: number;
  thick: number;
  spheroid: number;
  gas: number;
}

/** Volume density parts at a galactocentric point (x, y in-plane kpc, z height). */
export function fieldDensityParts(f: GalaxyField, x: number, y: number, z: number): FieldParts {
  const gx = (x + f.box) / ((2 * f.box) / f.out) - 0.5;
  const gy = (y + f.box) / ((2 * f.box) / f.out) - 0.5;
  const inGrid = gx > -1 && gx < f.out && gy > -1 && gy < f.out;
  let thin = 0;
  let thick = 0;
  let gas = 0;
  if (inGrid) {
    const h = Math.max(FIELD.H_MIN, bilinear(f.hThin, f.out, gx, gy));
    const hk = h * FIELD.H_THICK_RATIO;
    thin = (bilinear(f.sigThin, f.out, gx, gy) / (2 * h)) * sech2(z / h);
    thick = (bilinear(f.sigThick, f.out, gx, gy) / (2 * hk)) * sech2(z / hk);
    // Gas sheet: thinner than the stars (dissipation), floor at H_MIN.
    const hg = Math.max(FIELD.H_MIN, h * 0.5);
    gas = (bilinear(f.sigGas, f.out, gx, gy) / (2 * hg)) * sech2(z / hg);
  }
  const rad = Math.sqrt(x * x + y * y + z * z);
  const b = Math.min(FIELD.SPH_BINS - 1, Math.floor(rad / f.sphDr));
  const spheroid = f.sphRho[b];
  return { thin, thick, spheroid, gas };
}

/** Total stellar volume density (occupancy units — × GALAXY_N_K = stars/kpc³). */
export function fieldDensity(f: GalaxyField, x: number, y: number, z: number): number {
  const p = fieldDensityParts(f, x, y, z);
  return p.thin + p.thick + p.spheroid;
}
