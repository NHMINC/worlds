/**
 * Isolated cooling-halo formation (Katz & Gunn / Fall & Efstathiou, toy).
 *
 * A static dark halo is already there. Baryons start as a hot, rotating,
 * pressure-supported corona. Each gas particle carries specific internal
 * energy. It radiates (a short cooling curve), loses pressure support,
 * and settles where its specific angular momentum matches the halo —
 * a thin spinning disk. Stars form only in cold, dense gas. The first
 * stars form in the dense centre (the bulge); later stars form in the
 * settled disk. No lift, no painted Hubble type.
 *
 * Variety is the genes (halo, spin, cooling time, baryon mass, SF
 * efficiency) plus the stellar clock. Low spin / fast cooling → compact
 * disk, heavier bulge. High spin / slow cooling → extended thin disk.
 *
 * Numerics: 3D PM gravity + mesh pressure (the same CIC grid), leapfrog,
 * detmath so every engine reprints the same galaxy. 10 000 particles.
 */
import { mulberry32, xmur3 } from '../rng';
import { dcos, dexp, dgauss, dsin, DTAU } from './detmath';
import { PoissonSolver3D } from './fft';

/** Bump when the sim's laws change: every address in the sky moves. */
export const FORMATION_VERSION = 7;

/** km/s → kpc/Myr. */
const KV = 1 / 977.79222;

/** k_B / m_H in (km/s)² / K. IEEE-exact constant. */
const KB_MH = 0.008314462618;
/** Mean molecular weight (ionized primordial). */
const MU = 0.6;
const GAMMA = 5 / 3;
const GM1 = GAMMA - 1;

/** T (K) from specific internal energy u ((km/s)²). */
const uToT = (u: number): number => (GM1 * MU * u) / KB_MH;
/** u from T. */
const tToU = (T: number): number => (KB_MH * T) / (GM1 * MU);

export interface FormationGenes {
  /** Halo circular speed (km/s). */
  vHalo: number;
  /** Halo core radius (kpc). */
  rcHalo: number;
  /** Rotation vs pressure: v_φ / v_c of the corona (not cosmological λ). */
  spin: number;
  /** Cooling time at mean corona density and T_vir (Myr). */
  coolTau: number;
  /** Star-formation efficiency multiplier. */
  sfEff: number;
  /** G × baryon mass, (km/s)²·kpc. */
  gmBaryon: number;
}

export interface FormationOpts {
  n?: number;
  mesh?: number;
  dt?: number;
  steps?: number;
  onProgress?: (frac: number) => void;
  snapEvery?: number;
  onSnapshot?: (
    step: number,
    px: Float64Array,
    py: Float64Array,
    pz: Float64Array,
    star: Uint8Array,
    tBirth: Float32Array,
  ) => void;
  onDebug?: (
    step: number,
    lz: number,
    ke: number,
    rMean: number,
    starFrac: number,
    blobFrac: number,
    gasBlobFrac: number,
  ) => void;
}

export interface FormationResult {
  genes: FormationGenes;
  n: number;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  star: Uint8Array;
  tBirth: Float32Array;
  metal: Float32Array;
  gm: number;
  tTotal: number;
  vcirc: Float64Array;
  vcDr: number;
  ms: number;
}

export const FORM = {
  N: 10_000,
  MESH: 32,
  BOX: 22,
  DT: 2.5,
  STEPS: 2400,
  SOFT: 0.7,
  GRAV_EVERY: 2,
  SF_EVERY: 4,
  /** Hydrogen cooling floor (K). Below this, gas stays a warm ISM. */
  T_FLOOR: 1e4,
  /** Stars form only colder than this (K). */
  T_SF: 2.5e4,
  /** Density contrast over the mean corona for the Schmidt gate.
   *  The temperature floor already keeps the hot corona sterile;
   *  this only has to pick the cooled sheet over empty cells. */
  SF_OVER: 3,
  SF_RATE: 0.00022,
  SF_PMAX: 0.06,
  /** Feedback: specific energy added to the birth cell's remaining gas. */
  FB_U: 160,
  YIELD: 0.028,
  Z0: 1e-4,
  /** Corona truncated at this fraction of the box. */
  R_VIR: 0.7,
} as const;

export function formationGenes(seed: string): FormationGenes {
  const rng = mulberry32(xmur3(`formation:genes:${seed}`)());
  return {
    vHalo: 150 + 45 * rng(),
    rcHalo: 2.8 + 2.2 * rng(),
    // Low spin → compact, bulge-heavier. High spin → extended thin disk.
    // Toy box is ~R_vir, not 200 kpc, so spin must be high or the
    // cooled disk sits at ~2 kpc. Range: compact+bulge → extended thin.
    spin: 0.70 + 0.22 * rng(),
    coolTau: 80 + 200 * rng(),
    sfEff: 0.7 + 0.7 * rng(),
    gmBaryon: (2.2 + 1.4 * rng()) * 1e5,
  };
}

function haloA(comp: number, r2: number, v2: number, rc2: number): number {
  return (-v2 * comp) / (r2 + rc2);
}

/** Hernquist radius from enclosed-mass fraction u ∈ (0, 1). */
function hernquistR(u: number, a: number, rMax: number): number {
  const sMax = rMax / (rMax + a);
  const s = Math.sqrt(Math.min(0.999, Math.max(1e-8, u))) * sMax;
  return (a * s) / Math.max(1e-8, 1 - s);
}

export function runFormation(seed: string, opts: FormationOpts = {}): FormationResult {
  const t0 = performance.now();
  const N = opts.n ?? FORM.N;
  const M = opts.mesh ?? FORM.MESH;
  const DT = opts.dt ?? FORM.DT;
  const STEPS = opts.steps ?? FORM.STEPS;
  const BOX = FORM.BOX;
  const dx = (2 * BOX) / M;
  const dV = dx * dx * dx;
  const genes = formationGenes(seed);
  const rng = mulberry32(xmur3(`formation:run:${seed}`)());

  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pz = new Float64Array(N);
  const vx = new Float64Array(N);
  const vy = new Float64Array(N);
  const vz = new Float64Array(N);
  const uu = new Float64Array(N);
  const rhoP = new Float64Array(N);
  const star = new Uint8Array(N);
  const tBirth = new Float32Array(N);
  const metal = new Float32Array(N);
  const gm = genes.gmBaryon / N;

  const v2 = genes.vHalo * genes.vHalo;
  const rc2 = genes.rcHalo * genes.rcHalo;
  const rVir = BOX * FORM.R_VIR;
  const uFloor = tToU(FORM.T_FLOOR);
  const uSf = tToU(FORM.T_SF);
  const tVir = 3.6e5 * (genes.vHalo / 100) * (genes.vHalo / 100);
  const uVir = tToU(tVir);
  const rhoChar = genes.gmBaryon / ((4 / 3) * Math.PI * rVir * rVir * rVir);
  const rhoSf = FORM.SF_OVER * rhoChar;

  // --- hot rotating Hernquist corona, roughly hydrostatic ---
  for (let i = 0; i < N; i++) {
    const r = hernquistR(rng(), genes.rcHalo * 1.8, rVir);
    const mu = 2 * rng() - 1;
    const th = DTAU * rng();
    const s = Math.sqrt(Math.max(0, 1 - mu * mu));
    const c = dcos(th);
    const sn = dsin(th);
    px[i] = r * s * c * 1.5;
    py[i] = r * s * sn * 1.5;
    pz[i] = r * mu * 0.45;
    const R = Math.max(1e-6, Math.hypot(px[i], py[i]));
    const vc = Math.sqrt((v2 * R * R) / (R * R + rc2));
    const vphi = genes.spin * vc;
    const ux = px[i] / R;
    const uy = py[i] / R;
    // Pressure holds the corona up; a little turbulence seeds the disk.
    const turb = 0.08 * genes.vHalo;
    vx[i] = -vphi * uy + turb * dgauss(rng);
    vy[i] = vphi * ux + turb * dgauss(rng);
    vz[i] = turb * dgauss(rng);
    // Bound: cooler than virial so the corona does not boil off the mesh.
    uu[i] = 0.45 * uVir;
    metal[i] = FORM.Z0;
  }

  const n3 = M * M * M;
  const M2 = M * M;
  const massG = new Float64Array(n3);
  const energyG = new Float64Array(n3);
  const phi = new Float64Array(n3);
  const fx = new Float64Array(n3);
  const fy = new Float64Array(n3);
  const fz = new Float64Array(n3);
  const pax = new Float64Array(n3);
  const pay = new Float64Array(n3);
  const paz = new Float64Array(n3);
  const press = new Float64Array(n3);
  const heatU = new Float64Array(n3);
  const dZ = new Float64Array(n3);
  const gasN = new Float64Array(n3);
  let nStarTot = 0;
  const solver = new PoissonSolver3D(M, dx, FORM.SOFT);
  const invDx = 1 / dx;
  const h2 = 0.5 * invDx;

  const cellOf = (x: number, y: number, z: number): number => {
    const ci = Math.floor((x + BOX) / dx);
    const cj = Math.floor((y + BOX) / dx);
    const ck = Math.floor((z + BOX) / dx);
    if (ci < 0 || ci >= M || cj < 0 || cj >= M || ck < 0 || ck >= M) return -1;
    return ck * M2 + cj * M + ci;
  };

  const cicOk = (x: number, y: number, z: number): boolean => {
    const gx = (x + BOX) * invDx - 0.5;
    const gy = (y + BOX) * invDx - 0.5;
    const gz = (z + BOX) * invDx - 0.5;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const k0 = Math.floor(gz);
    return i0 >= 0 && i0 < M - 1 && j0 >= 0 && j0 < M - 1 && k0 >= 0 && k0 < M - 1;
  };

  const deposit = (arr: Float64Array, x: number, y: number, z: number, w: number): void => {
    const gx = (x + BOX) * invDx - 0.5;
    const gy = (y + BOX) * invDx - 0.5;
    const gz = (z + BOX) * invDx - 0.5;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const k0 = Math.floor(gz);
    if (i0 < 0 || i0 >= M - 1 || j0 < 0 || j0 >= M - 1 || k0 < 0 || k0 >= M - 1) return;
    const tx = gx - i0;
    const ty = gy - j0;
    const tz = gz - k0;
    const b0 = k0 * M2 + j0 * M + i0;
    arr[b0] += w * (1 - tx) * (1 - ty) * (1 - tz);
    arr[b0 + 1] += w * tx * (1 - ty) * (1 - tz);
    arr[b0 + M] += w * (1 - tx) * ty * (1 - tz);
    arr[b0 + M + 1] += w * tx * ty * (1 - tz);
    arr[b0 + M2] += w * (1 - tx) * (1 - ty) * tz;
    arr[b0 + M2 + 1] += w * tx * (1 - ty) * tz;
    arr[b0 + M2 + M] += w * (1 - tx) * ty * tz;
    arr[b0 + M2 + M + 1] += w * tx * ty * tz;
  };

  const sample = (arr: Float64Array, x: number, y: number, z: number): number => {
    const gx = (x + BOX) * invDx - 0.5;
    const gy = (y + BOX) * invDx - 0.5;
    const gz = (z + BOX) * invDx - 0.5;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const k0 = Math.floor(gz);
    if (i0 < 0 || i0 >= M - 1 || j0 < 0 || j0 >= M - 1 || k0 < 0 || k0 >= M - 1) return 0;
    const tx = gx - i0;
    const ty = gy - j0;
    const tz = gz - k0;
    const b0 = k0 * M2 + j0 * M + i0;
    return (
      arr[b0] * (1 - tx) * (1 - ty) * (1 - tz) +
      arr[b0 + 1] * tx * (1 - ty) * (1 - tz) +
      arr[b0 + M] * (1 - tx) * ty * (1 - tz) +
      arr[b0 + M + 1] * tx * ty * (1 - tz) +
      arr[b0 + M2] * (1 - tx) * (1 - ty) * tz +
      arr[b0 + M2 + 1] * tx * (1 - ty) * tz +
      arr[b0 + M2 + M] * (1 - tx) * ty * tz +
      arr[b0 + M2 + M + 1] * tx * ty * tz
    );
  };

  /** Toy cooling curve: peak near 1.5e5 K, almost off below T_FLOOR. */
  const tCool = (T: number, rho: number): number => {
    const x = T / 1.5e5;
    const lam = T <= FORM.T_FLOOR ? 0.03 : 2 / (x + 1 / Math.max(x, 0.05));
    return (genes.coolTau * (rhoChar / Math.max(rho, 1e-9)) * (T / Math.max(tVir, 1e4))) / Math.max(lam, 0.03);
  };

  for (let step = 0; step < STEPS; step++) {
    if (step % FORM.GRAV_EVERY === 0) {
      massG.fill(0);
      energyG.fill(0);
      for (let i = 0; i < N; i++) {
        deposit(massG, px[i], py[i], pz[i], gm);
        if (!star[i]) deposit(energyG, px[i], py[i], pz[i], gm * uu[i]);
      }
      solver.solve(massG, phi);
      fx.fill(0);
      fy.fill(0);
      fz.fill(0);
      pax.fill(0);
      pay.fill(0);
      paz.fill(0);
      press.fill(0);
      for (let k = 1; k < M - 1; k++) {
        for (let j = 1; j < M - 1; j++) {
          for (let i = 1; i < M - 1; i++) {
            const t = k * M2 + j * M + i;
            fx[t] = -(phi[t + 1] - phi[t - 1]) * h2;
            fy[t] = -(phi[t + M] - phi[t - M]) * h2;
            fz[t] = -(phi[t + M2] - phi[t - M2]) * h2;
            const rho = massG[t] / dV;
            if (rho < 1e-12) {
              press[t] = 0;
              continue;
            }
            press[t] = GM1 * rho * (energyG[t] / massG[t]);
          }
        }
      }
      for (let k = 1; k < M - 1; k++) {
        for (let j = 1; j < M - 1; j++) {
          for (let i = 1; i < M - 1; i++) {
            const t = k * M2 + j * M + i;
            const rho = massG[t] / dV;
            if (rho < 0.08 * rhoChar) continue;
            pax[t] = -((press[t + 1] - press[t - 1]) * h2) / rho;
            pay[t] = -((press[t + M] - press[t - M]) * h2) / rho;
            paz[t] = -((press[t + M2] - press[t - M2]) * h2) / rho;
          }
        }
      }
    }

    for (let i = 0; i < N; i++) {
      if (!cicOk(px[i], py[i], pz[i])) {
        const r2 = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
        vx[i] += haloA(px[i], r2, v2, rc2) * DT * KV;
        vy[i] += haloA(py[i], r2, v2, rc2) * DT * KV;
        vz[i] += haloA(pz[i], r2, v2, rc2) * DT * KV;
        px[i] += vx[i] * DT * KV;
        py[i] += vy[i] * DT * KV;
        pz[i] += vz[i] * DT * KV;
        continue;
      }
      let ax = sample(fx, px[i], py[i], pz[i]);
      let ay = sample(fy, px[i], py[i], pz[i]);
      let az = sample(fz, px[i], py[i], pz[i]);
      if (!star[i]) {
        ax += sample(pax, px[i], py[i], pz[i]);
        ay += sample(pay, px[i], py[i], pz[i]);
        az += sample(paz, px[i], py[i], pz[i]);
      }
      const r2 = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
      ax += haloA(px[i], r2, v2, rc2);
      ay += haloA(py[i], r2, v2, rc2);
      az += haloA(pz[i], r2, v2, rc2);
      vx[i] += ax * DT * KV;
      vy[i] += ay * DT * KV;
      vz[i] += az * DT * KV;
      px[i] += vx[i] * DT * KV;
      py[i] += vy[i] * DT * KV;
      pz[i] += vz[i] * DT * KV;
    }

    // Density for cooling / SF, then radiate, then feedback heat.
    for (let i = 0; i < N; i++) {
      if (star[i]) continue;
      const rho = Math.max(1e-9, sample(massG, px[i], py[i], pz[i]) / dV);
      rhoP[i] = rho;
      const T = uToT(uu[i]);
      const tc = tCool(T, rho);
      uu[i] *= dexp(-DT / Math.max(tc, DT * 0.25));
      if (uu[i] < uFloor) uu[i] = uFloor;
      if (uu[i] > uVir * 2) uu[i] = uVir * 2;
    }
    for (let i = 0; i < N; i++) {
      if (star[i]) continue;
      const k = cellOf(px[i], py[i], pz[i]);
      if (k < 0) continue;
      if (heatU[k] > 0) uu[i] += heatU[k];
      if (dZ[k] > 0) metal[i] = Math.min(0.06, metal[i] + dZ[k]);
    }
    heatU.fill(0);
    dZ.fill(0);

    if (step % FORM.SF_EVERY === FORM.SF_EVERY - 1) {
      gasN.fill(0);
      for (let i = 0; i < N; i++) {
        if (star[i]) continue;
        const k = cellOf(px[i], py[i], pz[i]);
        if (k >= 0) gasN[k] += 1;
      }
      const t = step * DT;
      const fRet = nStarTot / N;
      const sfDt = DT * FORM.SF_EVERY;
      for (let i = 0; i < N; i++) {
        if (star[i]) continue;
        if (uu[i] > uSf) continue;
        const rho = rhoP[i];
        if (rho < rhoSf) continue;
        const p = Math.min(FORM.SF_PMAX, FORM.SF_RATE * genes.sfEff * sfDt * Math.sqrt(rho / rhoSf));
        if (rng() >= p) continue;
        star[i] = 1;
        tBirth[i] = t;
        nStarTot++;
        const k = cellOf(px[i], py[i], pz[i]);
        if (k >= 0 && gasN[k] > 1) {
          dZ[k] += (FORM.YIELD * fRet) / gasN[k];
          heatU[k] += FORM.FB_U / gasN[k];
        }
      }
    }

    if (opts.onProgress && step % 64 === 0) opts.onProgress(step / STEPS);
    if (opts.onSnapshot && opts.snapEvery && step % opts.snapEvery === 0) {
      opts.onSnapshot(step, px, py, pz, star, tBirth);
    }
    if (opts.onDebug && step % 100 === 0) {
      let lz = 0;
      let ke = 0;
      let rs = 0;
      let ns = 0;
      let blob = 0;
      let gBlob = 0;
      let gN = 0;
      for (let i = 0; i < N; i++) {
        lz += px[i] * vy[i] - py[i] * vx[i];
        ke += vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
        const R = Math.hypot(px[i], py[i]);
        rs += R;
        if (star[i]) {
          ns++;
          if (R < 1.25) blob++;
        } else {
          gN++;
          if (R < 1.25) gBlob++;
        }
      }
      opts.onDebug(step, lz / N, Math.sqrt(ke / N), rs / N, ns / N, blob / Math.max(1, ns), gBlob / Math.max(1, gN));
    }
  }

  const VC_DR = 0.25;
  const nvc = Math.floor(BOX / VC_DR);
  const vcirc = new Float64Array(nvc);
  for (let b = 0; b < nvc; b++) {
    const r = (b + 0.5) * VC_DR;
    let sum = 0;
    const NA = 24;
    for (let a = 0; a < NA; a++) {
      const th = (DTAU * a) / NA;
      const x = r * dcos(th);
      const y = r * dsin(th);
      const fxx = sample(fx, x, y, 0);
      const fyy = sample(fy, x, y, 0);
      const fr = -(fxx * x + fyy * y) / Math.max(r, 1e-6);
      sum += Math.max(0, fr * r);
    }
    vcirc[b] = Math.sqrt(sum / NA + (v2 * r * r) / (r * r + rc2));
  }

  return {
    genes,
    n: N,
    px,
    py,
    pz,
    vx,
    vy,
    vz,
    star,
    tBirth,
    metal,
    gm,
    tTotal: STEPS * DT,
    vcirc,
    vcDr: VC_DR,
    ms: performance.now() - t0,
  };
}
