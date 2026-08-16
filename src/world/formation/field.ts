/**
 * Bake the formation run into a GalaxyField.
 *
 * THE EVOLVED STAR PARTICLES ARE THE GALAXY. Each one is a parent:
 * it stands for ~starW real stars, and the catalog sits those stars
 * next to it (an isotropic Gaussian so they fill the area — a
 * product-of-tents cube printed the PM mesh in the nucleus). Grids
 * survive only for what is a medium —
 * gas / ISM / extinction — and for ring-profile fits.
 *
 * The sim is a 3D cooling halo. Parents keep the positions the run
 * earned. Disk / thick / spheroid labels still come from circularity,
 * for the ISM grids only.
 *
 * Ages: SIM_GYR of dynamical time stand in for GALAXY_AGE_GYR of
 * cosmic time (a named toy compression, like TIME_SCALE). The baked
 * ageGyr fields are already in galaxy-clock units.
 */
import { FORM, type FormationResult } from './sim';
import { dexp, dlog10 } from './detmath';

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

  /**
   * Star-particle parents — the catalog. Catalog cartesian (x, z
   * in-plane; y height). pKind 0 thin / 1 thick / 2 spheroid.
   * starW = real stars per parent (renormalized onto the catalog
   * cylinder so nParents × starW = GALAXY_POPULATION).
   */
  pN: number;
  pAX: Float32Array;
  pAY: Float32Array;
  pAZ: Float32Array;
  pKind: Uint8Array;
  pAge: Float32Array;
  pFeh: Float32Array;
  starW: number;

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
  /**
   * Catalog jitter σ (kpc), isotropic Gaussian. FORM.SOFT × 0.4 —
   * the run cannot resolve inside the softening, so the cloud around
   * a parent is that wide. A product-of-tents cube aligned with the
   * PM mesh (SOFT ~ mesh) printed a lattice in the nucleus.
   */
    JITTER: 0.22,
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

/** exp-based tanh (no Math.tanh — keep the op set small and portable). */
const tanhE = (x: number): number => (x > 20 ? 1 : 1 - 2 / (dexp(2 * x) + 1));

/**
 * Bake. `ageSpanGyr` maps sim time onto the galaxy clock; `popTarget`
 * sets the density normalization so ∫ρ dV × GALAXY_N_K ≈ population.
 * When `domain` (the catalog's cylinder: R ≤ rMax, |z| ≤ zMax) is
 * given, the integral is taken over THAT volume — occupancy is the
 * population by decree, so mass the catalog cannot address (outer
 * disk, high halo) must not silently deflate it.
 */
export function bakeField(
  seed: string,
  version: number,
  r: FormationResult,
  ageSpanGyr: number,
  popTarget: number,
  nK: number,
  domain?: { rMax: number; zMax: number },
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
    const z = r.pz[i];
    const rad = Math.hypot(x, y);
    const rad3 = Math.hypot(x, y, z);
    const gx = (x + box) / dx - 0.5;
    const gy = (y + box) / dx - 0.5;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const inGrid = i0 >= 0 && i0 < OUT - 1 && j0 >= 0 && j0 < OUT - 1;

    if (!r.star[i]) {
      // Gas is a medium. Ten thousand particles cannot CIC a sheet —
      // each leftover parcel is a softening-width blob, the same
      // resolution floor the run already declared.
      const feh = fehOf(i);
      const sig = FORM.SOFT;
      const radPix = Math.max(1, Math.ceil((3 * sig) / dx));
      const inv2s2 = 1 / (2 * sig * sig);
      let wSum = 0;
      for (let dj = -radPix; dj <= radPix; dj++) {
        for (let di = -radPix; di <= radPix; di++) {
          const ii = i0 + di;
          const jj = j0 + dj;
          if (ii < 0 || ii >= OUT || jj < 0 || jj >= OUT) continue;
          const rx = (ii + 0.5) * dx - box - x;
          const ry = (jj + 0.5) * dx - box - y;
          wSum += dexp(-(rx * rx + ry * ry) * inv2s2);
        }
      }
      if (wSum <= 0) continue;
      const inv = 1 / wSum;
      for (let dj = -radPix; dj <= radPix; dj++) {
        for (let di = -radPix; di <= radPix; di++) {
          const ii = i0 + di;
          const jj = j0 + dj;
          if (ii < 0 || ii >= OUT || jj < 0 || jj >= OUT) continue;
          const rx = (ii + 0.5) * dx - box - x;
          const ry = (jj + 0.5) * dx - box - y;
          const w = dexp(-(rx * rx + ry * ry) * inv2s2) * inv;
          const b = jj * OUT + ii;
          mGas[b] += w;
          sFehGas[b] += feh * w;
        }
      }
      continue;
    }

    nStars++;
    const vphi = (x * r.vy[i] - y * r.vx[i]) / Math.max(rad, 1e-6);
    const c = vphi / vcAt(rad);
    const age = ageOf(i);
    const feh = fehOf(i);

    if (c < FIELD.C_SPHEROID) {
      // Spheroid: spherical shells. Each particle deposits as a 3D
      // Gaussian blob of the force-softening width, not a delta — the
      // run cannot have made structure sharper than FORM.SOFT, so a
      // delta-binned cusp would be numerics, not physics. The shell
      // mass of a 3D blob centred at radius s has the closed form
      // w(r) ∝ (r/s)·[e^−(r−s)²/2σ² − e^−(r+s)²/2σ²]; weights are
      // normalized per particle, so mass is conserved and the centre
      // stays at FINITE density (a 1D-in-radius kernel would divide
      // slice mass by vanishing shell volumes and re-mint the cusp).
      nSph++;
      const sig = FORM.SOFT * 0.5;
      const s = Math.max(1e-3, rad3);
      const b0 = Math.max(0, Math.floor((rad3 - 3 * sig) / sphDr));
      const b1 = Math.min(FIELD.SPH_BINS - 1, Math.floor((rad3 + 3 * sig + sphDr) / sphDr));
      const inv2s2 = 1 / (2 * sig * sig);
      let wSum = 0;
      let wAt = 0;
      for (let b = b0; b <= b1; b++) {
        const rb = (b + 0.5) * sphDr;
        const dm = rb - s;
        const dp = rb + s;
        const w = (rb / s) * (dexp(-dm * dm * inv2s2) - dexp(-dp * dp * inv2s2));
        wSum += w;
      }
      if (wSum <= 0) {
        const b = Math.min(FIELD.SPH_BINS - 1, Math.floor(rad3 / sphDr));
        sphM[b] += 1;
        sphFehS[b] += feh;
        sphAgeS[b] += age;
        continue;
      }
      for (let b = b0; b <= b1; b++) {
        const rb = (b + 0.5) * sphDr;
        const dm = rb - s;
        const dp = rb + s;
        wAt = ((rb / s) * (dexp(-dm * dm * inv2s2) - dexp(-dp * dp * inv2s2))) / wSum;
        sphM[b] += wAt;
        sphFehS[b] += feh * wAt;
        sphAgeS[b] += age * wAt;
      }
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
    } else {
      hThin[k] = 0.3;
    }
    // Chemistry/age are mass-weighted means of whatever mass IS here —
    // a sparse rim cell's few stars are its truth, not a placeholder.
    if (m > 0) {
      feh[k] = sFeh[k] / m;
      ageGyr[k] = sAge[k] / m;
      youngFrac[k] = sYoung[k] / m;
    } else {
      feh[k] = -1;
      ageGyr[k] = ageSpanGyr * 0.7;
      youngFrac[k] = 0;
    }
    fehGas[k] = mGas[k] > 0 ? sFehGas[k] / mGas[k] : -1;
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

  // (The resolution floor lives in the deposit above: every spheroid
  // particle is a softening-width blob, so the profile is smooth
  // through the centre — no cusp, no flat-core cliff.)

  // --- renormalize onto the catalog domain ---
  // Occupancy is the population BY DECREE. Mass the catalog cannot
  // address (outer disk beyond rMax, halo above zMax, sech² tails)
  // must not deflate it, so integrate the baked stellar density over
  // the catalog's own cylinder and scale the whole field so
  // ∫ρ dV × nK = popTarget exactly.
  let normScale = 1;
  if (domain) {
    const { rMax, zMax } = domain;
    let integral = 0;
    // Disk columns: ∫sech²(z/h)dz over |z|≤zMax is 2h·tanh(zMax/h),
    // so each grid cell contributes Σ·area·tanh(zMax/h).
    for (let k = 0; k < n2; k++) {
      const gi = k % OUT;
      const gj = (k - gi) / OUT;
      const x = (gi + 0.5) * dx - box;
      const y = (gj + 0.5) * dx - box;
      if (x * x + y * y > rMax * rMax) continue;
      const h = Math.max(FIELD.H_MIN, hThin[k]);
      const hk = h * FIELD.H_THICK_RATIO;
      integral += cellArea * (sigThin[k] * tanhE(zMax / h) + sigThick[k] * tanhE(zMax / hk));
    }
    // Spheroid: numeric cylinder integral of the spherical shells.
    const NR = 160;
    const NZ = 72;
    const dR = rMax / NR;
    const dzc = zMax / NZ;
    for (let iR = 0; iR < NR; iR++) {
      const R = (iR + 0.5) * dR;
      for (let iz = 0; iz < NZ; iz++) {
        const zc = (iz + 0.5) * dzc;
        const rad = Math.sqrt(R * R + zc * zc);
        const b = Math.min(FIELD.SPH_BINS - 1, Math.floor(rad / sphDr));
        integral += sphRho[b] * 2 * Math.PI * R * dR * 2 * dzc;
      }
    }
    normScale = popTarget / nK / Math.max(1e-9, integral);
    for (let k = 0; k < n2; k++) {
      sigThin[k] *= normScale;
      sigThick[k] *= normScale;
      sigGas[k] *= normScale;
    }
    for (let b = 0; b < FIELD.SPH_BINS; b++) sphRho[b] *= normScale;
  }

  const vcirc = new Float32Array(r.vcirc.length);
  for (let i = 0; i < vcirc.length; i++) vcirc[i] = r.vcirc[i];

  // --- star particles: the catalog's parents ---
  // The run already placed them in 3D. Catalog frame is (x, height, y).
  // No |z| clip: a hard ceiling was the cylinder. starW soaks whoever
  // stays inside cylindrical R ≤ rMax.
  const rMax = domain?.rMax ?? box;
  const ax: number[] = [];
  const ay: number[] = [];
  const az: number[] = [];
  const kinds: number[] = [];
  const ages: number[] = [];
  const fehs: number[] = [];
  for (let i = 0; i < r.n; i++) {
    if (!r.star[i]) continue;
    const x = r.px[i];
    const y = r.py[i];
    const rad = Math.hypot(x, y);
    if (rad > rMax) continue;
    const vphi = (x * r.vy[i] - y * r.vx[i]) / Math.max(rad, 1e-6);
    const circ = vphi / vcAt(rad);
    const knd = circ < FIELD.C_SPHEROID ? 2 : circ >= FIELD.C_THIN ? 0 : 1;
    ax.push(x);
    ay.push(r.pz[i]);
    az.push(y);
    kinds.push(knd);
    ages.push(ageOf(i));
    fehs.push(fehOf(i));
  }
  const pN = ax.length;
  const pAX = new Float32Array(ax);
  const pAY = new Float32Array(ay);
  const pAZ = new Float32Array(az);
  const pKind = new Uint8Array(kinds);
  const pAge = new Float32Array(ages);
  const pFeh = new Float32Array(fehs);
  const starW = popTarget / Math.max(1, pN);

  let hash = 2166136261 >>> 0;
  for (let k = 0; k < n2; k += 7) hash = fnv(hash, sigThin[k]);
  for (let k = 0; k < n2; k += 7) hash = fnv(hash, hThin[k]);
  for (let b = 0; b < FIELD.SPH_BINS; b++) hash = fnv(hash, sphRho[b]);
  for (let j = 0; j < pN; j += 11) hash = fnv(hash, pAX[j] + pAY[j] + pAZ[j]);

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
    norm: perStar * normScale,
    pN,
    pAX,
    pAY,
    pAZ,
    pKind,
    pAge,
    pFeh,
    starW,
    hash,
    ms: performance.now() - t0,
  };
}

/** Bilinear sample of a field grid at in-plane (x, y) kpc. */
export function fieldGridAt(f: GalaxyField, a: Float32Array, x: number, y: number): number {
  const dx = (2 * f.box) / f.out;
  const gx = (x + f.box) / dx - 0.5;
  const gy = (y + f.box) / dx - 0.5;
  if (gx <= -1 || gx >= f.out || gy <= -1 || gy >= f.out) return 0;
  return bilinear(a, f.out, gx, gy);
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
