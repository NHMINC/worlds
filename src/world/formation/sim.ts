/**
 * Gas-to-galaxy formation: the procedural magic.
 *
 * The galaxy is not laid out — it HAPPENS. The seed draws a small set
 * of formation genes (halo speed, spin, cooling time, star-formation
 * efficiency, cloud size, baryon mass). A rotating 3D gas cloud
 * collapses in a static dark halo (the decreed dark-matter shortcut,
 * same family as "orbits are stable by fiat"); gas dissipates into a
 * cold disk; stars form where the gas is dense (Schmidt law) and
 * inherit the enriched metallicity of their birth cell (closed-box
 * yield); the cold self-gravitating disk then goes bar- and
 * spiral-unstable ON ITS OWN. Bulge, thick disk, bar, arms, the
 * metallicity gradient and the age structure are outcomes of the run,
 * not terms in a formula.
 *
 * Numerics: 3D particle-mesh N-body. Ten thousand particles. CIC
 * deposit, isolated FFT Poisson solve, leapfrog kicks. Height is
 * earned — cooling flattens the cloud; there is no after-the-fact
 * lift onto a sheet or a sphere (that painted a cylinder). Every
 * transcendental goes through detmath so the same seed mints
 * bit-identical galaxies on every engine. Runs once per
 * (seed, FORMATION_VERSION); the baked field is what the catalog
 * samples.
 *
 * Toy compressions (visible and named, like TIME_SCALE): SIM_GYR of
 * dynamical time stand in for GALAXY_AGE_GYR of cosmic time — ages
 * are mapped linearly when the field is baked.
 */
import { mulberry32, xmur3 } from '../rng';
import { dcos, dexp, dgauss, dlog, dsin, DTAU } from './detmath';
import { PoissonSolver3D } from './fft';

/** Bump when the sim's laws change: every address in the sky moves. */
export const FORMATION_VERSION = 6;

/** km/s → kpc/Myr. */
const KV = 1 / 977.79222;
/** G in (km/s)²·kpc / (1e10 Msun) — masses below carry G folded in. */

export interface FormationGenes {
  /** Halo circular speed (km/s) — the dark backbone. */
  vHalo: number;
  /** Halo core radius (kpc). */
  rcHalo: number;
  /** Initial rotation, as a fraction of local circular speed. */
  spin: number;
  /** Gas dissipation e-folding time (Myr). */
  coolTau: number;
  /** Star-formation efficiency multiplier. */
  sfEff: number;
  /** Initial cloud scale length (kpc). */
  cloudR: number;
  /** G × baryon mass, (km/s)²·kpc. */
  gmBaryon: number;
}

export interface FormationOpts {
  /** Particle count. */
  n?: number;
  /** Dynamics mesh (power of two). */
  mesh?: number;
  /** Timestep (Myr). */
  dt?: number;
  /** Number of steps. */
  steps?: number;
  onProgress?: (frac: number) => void;
  /**
   * Live view of the run (read-only borrow of the state arrays) every
   * `snapEvery` steps — the boot movie. Pure observation: no rng, no
   * writes, so determinism is untouched.
   */
  snapEvery?: number;
  onSnapshot?: (
    step: number,
    px: Float64Array,
    py: Float64Array,
    pz: Float64Array,
    star: Uint8Array,
    tBirth: Float32Array,
  ) => void;
  /** Conservation probe: called every 100 steps with bulk diagnostics. */
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
  /** Positions (kpc), velocities (km/s). z is height. */
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  /** 0 = gas, 1 = star. */
  star: Uint8Array;
  /** Birth time (Myr since sim start); 0 for gas. */
  tBirth: Float32Array;
  /** Metal mass fraction (absolute Z). */
  metal: Float32Array;
  /** G-folded particle mass ((km/s)²·kpc). */
  gm: number;
  /** Total sim span (Myr). */
  tTotal: number;
  /** Measured circular-speed curve, km/s per VC_DR kpc bin. */
  vcirc: Float64Array;
  vcDr: number;
  ms: number;
}

/** Simulation constants — laws of the formation era, not per-seed dials. */
export const FORM = {
  N: 10_000,
  MESH: 32,
  /** Half-width of the dynamics box (kpc). */
  BOX: 22,
  DT: 3,
  STEPS: 2600,
  /** Plummer softening (kpc) — also the resolution floor. */
  SOFT: 1.2,
  /** Solve gravity every this many steps (forces reused between). */
  GRAV_EVERY: 2,
  /** Star formation pass cadence (steps). */
  SF_EVERY: 4,
  /** Gρ threshold for star formation ((km/s)²/kpc²). Volume, not a
   * projected cylinder — the 2D surface-density gate could not see
   * height, so a dense column looked the same as a filled tube. */
  SF_THRESH: 40,
  /** Base SF probability per Myr at threshold density. FAST response:
   * regulation must outrun cooling (τ ~ 100 Myr) or the disk drops
   * below Q = 1 and fragments wholesale. The long-term consumption
   * rate is NOT this constant — it is the self-regulated equilibrium
   * where feedback heating balances dissipation (Ostriker–Shetty). */
  SF_RATE: 0.0005,
  /** Cold-gas efficiency scale (km/s): star formation goes as
   * σ_cold² / (σ² + σ_cold²) of the cell's shear-corrected dispersion.
   * Cold settled disk → full rate; the hot collapse forms stars ~50×
   * slower — and those rare hot births ARE the spheroid (bulge+halo),
   * not a label. One smooth law, no binary gate. */
  SF_COLD: 15,
  /** Supernova feedback: each birth reheats its cell's remaining gas
   * with this much velocity kick (km/s), shared over the cell's gas
   * mass. Self-regulation — dense pockets stall themselves instead of
   * converting whole; the center cannot run away; the disk hovers at
   * marginal stability, which is exactly where spiral arms live. */
  FB_KICK: 180,
  /** Per-pass conversion cap (probability). */
  SF_PMAX: 0.05,
  /** Metal yield per stellar generation. Retention is NOT total:
   * supernova ejecta escape the shallow, puffy, un-assembled early
   * cloud as a galactic wind; once the baryons have settled into
   * stars and a dense disk the ejecta are trapped. The retained
   * fraction is the assembled stellar fraction — no extra constant —
   * so the halo (born first) EMERGES metal-poor and the disk keeps
   * enriching, without a population label. */
  YIELD: 0.028,
  /** Primordial metallicity. */
  Z0: 1e-4,
  /** Gas velocity-dispersion floor (km/s) — thermal pressure stand-in. */
  SIGMA_FLOOR: 7,
  /** Initial Toomre Q of the cloud. Below ~1 the whole cold disk
   * fragments at once into giant clumps that sink and merge into a
   * monster nucleus (observed: half the galaxy at R < 1 kpc in one
   * 0.5-Gyr event). Marginal stability is the physical starting
   * point; cooling then lowers Q slowly and SF + feedback regulate. */
  Q_INIT: 1.5,
} as const;

/** Draw the formation genes. The seed IS the galaxy's history. */
export function formationGenes(seed: string): FormationGenes {
  const rng = mulberry32(xmur3(`formation:genes:${seed}`)());
  // A bar needs the inner disk to dominate its own gravity — a heavy
  // compact halo suppresses it (Ostriker–Peebles). The halo range is
  // set so baryons rule inside ~2 scale lengths, like real spirals.
  return {
    vHalo: 145 + 40 * rng(),
    rcHalo: 3.5 + 2.5 * rng(),
    spin: 0.85 + 0.2 * rng(),
    coolTau: 55 + 90 * rng(),
    sfEff: 0.75 + 0.6 * rng(),
    cloudR: 5.5 + 3.5 * rng(),
    gmBaryon: (2.4 + 1.2 * rng()) * 1e5,
  };
}

/** Static halo acceleration: spherical logarithmic potential. */
function haloA(comp: number, r2: number, v2: number, rc2: number): number {
  return (-v2 * comp) / (r2 + rc2);
}

export function runFormation(seed: string, opts: FormationOpts = {}): FormationResult {
  const t0 = performance.now();
  const N = opts.n ?? FORM.N;
  const M = opts.mesh ?? FORM.MESH;
  const DT = opts.dt ?? FORM.DT;
  const STEPS = opts.steps ?? FORM.STEPS;
  const BOX = FORM.BOX;
  const dx = (2 * BOX) / M;
  const genes = formationGenes(seed);
  const rng = mulberry32(xmur3(`formation:run:${seed}`)());

  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pz = new Float64Array(N);
  const vx = new Float64Array(N);
  const vy = new Float64Array(N);
  const vz = new Float64Array(N);
  const star = new Uint8Array(N);
  const tBirth = new Float32Array(N);
  const metal = new Float32Array(N);
  const gm = genes.gmBaryon / N;

  const v2 = genes.vHalo * genes.vHalo;
  const rc2 = genes.rcHalo * genes.rcHalo;

  // --- initial conditions: a rotating 3D gas cloud ---
  // Spherical exponential (Gamma-3 in radius) so the first frame is a
  // ball, not a stamped disk. Spin about z; cooling flattens it.
  const theta = genes.cloudR / 2;
  const vcInit = (r: number): number => {
    const xg = r / theta;
    const encl = 1 - dexp(-xg) * (1 + xg + 0.5 * xg * xg);
    return Math.sqrt((v2 * r * r) / (r * r + rc2) + (genes.gmBaryon * encl) / Math.max(r, 0.3));
  };
  for (let i = 0; i < N; i++) {
    let r3 = 0;
    do {
      r3 = -theta * (dlog(rng() + 1e-12) + dlog(rng() + 1e-12) + dlog(rng() + 1e-12));
    } while (r3 > BOX * 0.72);
    const u = 2 * rng() - 1;
    const th = DTAU * rng();
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const c = dcos(th);
    const sn = dsin(th);
    px[i] = r3 * s * c;
    py[i] = r3 * s * sn;
    pz[i] = r3 * u;
    const R = Math.max(1e-6, Math.hypot(px[i], py[i]));
    const vc = vcInit(Math.max(r3, 0.4));
    const rr = Math.max(R, 0.4);
    const gSig = (genes.gmBaryon * dexp(-rr / theta)) / (2 * Math.PI * theta * theta);
    const vcHi = vcInit(rr * 1.05);
    const dlnv = (dlog(Math.max(1, vcHi)) - dlog(Math.max(1, vcInit(rr)))) / dlog(1.05);
    const om = vcInit(rr) / rr;
    const kappa = Math.sqrt(Math.max(0.5, 2 * om * om * (1 + dlnv)));
    const sig = Math.min(0.55 * vc + 8, Math.max(12, (FORM.Q_INIT * Math.PI * gSig) / kappa));
    const vSup = Math.sqrt(Math.max(0, vc * vc - 2 * sig * sig));
    const vphi = genes.spin * vSup * (1 + 0.12 * dgauss(rng));
    const ux = px[i] / R;
    const uy = py[i] / R;
    vx[i] = -vphi * uy + sig * dgauss(rng);
    vy[i] = vphi * ux + sig * dgauss(rng);
    vz[i] = sig * dgauss(rng);
    metal[i] = FORM.Z0;
  }

  // --- grids ---
  const n3 = M * M * M;
  const massG = new Float64Array(n3);
  const phi = new Float64Array(n3);
  const fx = new Float64Array(n3);
  const fy = new Float64Array(n3);
  const fz = new Float64Array(n3);
  const gasM = new Float64Array(n3);
  const gasVr = new Float64Array(n3);
  const gasLz = new Float64Array(n3);
  const gasR2 = new Float64Array(n3);
  const gasVz = new Float64Array(n3);
  const gasE = new Float64Array(n3);
  const dZ = new Float64Array(n3);
  const heat = new Float64Array(n3);
  let nStarTot = 0;
  const solver = new PoissonSolver3D(M, dx, FORM.SOFT);
  const M2 = M * M;

  const cellOf = (x: number, y: number, z: number): number => {
    const ci = Math.floor((x + BOX) / dx);
    const cj = Math.floor((y + BOX) / dx);
    const ck = Math.floor((z + BOX) / dx);
    if (ci < 0 || ci >= M || cj < 0 || cj >= M || ck < 0 || ck >= M) return -1;
    return ck * M2 + cj * M + ci;
  };

  const coolK = dexp(-DT / genes.coolTau);
  const invDx = 1 / dx;
  const cellVol = dx * dx * dx;
  const sfDt = DT * FORM.SF_EVERY;

  for (let step = 0; step < STEPS; step++) {
    // ---- gravity: CIC deposit + FFT solve (every GRAV_EVERY steps) ----
    if (step % FORM.GRAV_EVERY === 0) {
      massG.fill(0);
      for (let i = 0; i < N; i++) {
        const gx = (px[i] + BOX) * invDx - 0.5;
        const gy = (py[i] + BOX) * invDx - 0.5;
        const gz = (pz[i] + BOX) * invDx - 0.5;
        const i0 = Math.floor(gx);
        const j0 = Math.floor(gy);
        const k0 = Math.floor(gz);
        if (i0 < 0 || i0 >= M - 1 || j0 < 0 || j0 >= M - 1 || k0 < 0 || k0 >= M - 1) continue;
        const tx = gx - i0;
        const ty = gy - j0;
        const tz = gz - k0;
        const b0 = k0 * M2 + j0 * M + i0;
        const w000 = (1 - tx) * (1 - ty) * (1 - tz);
        const w100 = tx * (1 - ty) * (1 - tz);
        const w010 = (1 - tx) * ty * (1 - tz);
        const w110 = tx * ty * (1 - tz);
        const w001 = (1 - tx) * (1 - ty) * tz;
        const w101 = tx * (1 - ty) * tz;
        const w011 = (1 - tx) * ty * tz;
        const w111 = tx * ty * tz;
        massG[b0] += gm * w000;
        massG[b0 + 1] += gm * w100;
        massG[b0 + M] += gm * w010;
        massG[b0 + M + 1] += gm * w110;
        massG[b0 + M2] += gm * w001;
        massG[b0 + M2 + 1] += gm * w101;
        massG[b0 + M2 + M] += gm * w011;
        massG[b0 + M2 + M + 1] += gm * w111;
      }
      solver.solve(massG, phi);
      fx.fill(0);
      fy.fill(0);
      fz.fill(0);
      const h2 = 0.5 * invDx;
      for (let k = 1; k < M - 1; k++) {
        for (let j = 1; j < M - 1; j++) {
          for (let i = 1; i < M - 1; i++) {
            const t = k * M2 + j * M + i;
            fx[t] = -(phi[t + 1] - phi[t - 1]) * h2;
            fy[t] = -(phi[t + M] - phi[t - M]) * h2;
            fz[t] = -(phi[t + M2] - phi[t - M2]) * h2;
          }
        }
      }
    }

    // ---- kick + drift ----
    for (let i = 0; i < N; i++) {
      const gx = (px[i] + BOX) * invDx - 0.5;
      const gy = (py[i] + BOX) * invDx - 0.5;
      const gz = (pz[i] + BOX) * invDx - 0.5;
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      const k0 = Math.floor(gz);
      let ax = 0;
      let ay = 0;
      let az = 0;
      if (i0 >= 0 && i0 < M - 1 && j0 >= 0 && j0 < M - 1 && k0 >= 0 && k0 < M - 1) {
        const tx = gx - i0;
        const ty = gy - j0;
        const tz = gz - k0;
        const b0 = k0 * M2 + j0 * M + i0;
        const w000 = (1 - tx) * (1 - ty) * (1 - tz);
        const w100 = tx * (1 - ty) * (1 - tz);
        const w010 = (1 - tx) * ty * (1 - tz);
        const w110 = tx * ty * (1 - tz);
        const w001 = (1 - tx) * (1 - ty) * tz;
        const w101 = tx * (1 - ty) * tz;
        const w011 = (1 - tx) * ty * tz;
        const w111 = tx * ty * tz;
        ax =
          fx[b0] * w000 +
          fx[b0 + 1] * w100 +
          fx[b0 + M] * w010 +
          fx[b0 + M + 1] * w110 +
          fx[b0 + M2] * w001 +
          fx[b0 + M2 + 1] * w101 +
          fx[b0 + M2 + M] * w011 +
          fx[b0 + M2 + M + 1] * w111;
        ay =
          fy[b0] * w000 +
          fy[b0 + 1] * w100 +
          fy[b0 + M] * w010 +
          fy[b0 + M + 1] * w110 +
          fy[b0 + M2] * w001 +
          fy[b0 + M2 + 1] * w101 +
          fy[b0 + M2 + M] * w011 +
          fy[b0 + M2 + M + 1] * w111;
        az =
          fz[b0] * w000 +
          fz[b0 + 1] * w100 +
          fz[b0 + M] * w010 +
          fz[b0 + M + 1] * w110 +
          fz[b0 + M2] * w001 +
          fz[b0 + M2 + 1] * w101 +
          fz[b0 + M2 + M] * w011 +
          fz[b0 + M2 + M + 1] * w111;
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

    // ---- gas cooling, in CYLINDRICAL components ----
    // Dissipation damps motion relative to the local mean FLOW. A
    // Cartesian cell-mean cannot see rotation tighter than one cell:
    // opposite sides of a compact rotating core average to zero and
    // "cooling" silently destroys the galaxy's angular momentum (a
    // real bug — Lz/N fell 884 → 25 and the core exploded). In polar
    // components the estimator is unbiased: the cell's best rigid
    // rotation is ω̄ = Σ R·vφ / Σ R², a fixed point of the damping at
    // ANY resolution. Radial and vertical flow damp toward the cell
    // means; that is how a ball becomes a disk.
    gasM.fill(0);
    gasVr.fill(0);
    gasLz.fill(0);
    gasR2.fill(0);
    gasVz.fill(0);
    gasE.fill(0);
    for (let i = 0; i < N; i++) {
      if (star[i]) continue;
      const k = cellOf(px[i], py[i], pz[i]);
      if (k < 0) continue;
      const R = Math.max(1e-6, Math.hypot(px[i], py[i]));
      const ux = px[i] / R;
      const uy = py[i] / R;
      const vr = vx[i] * ux + vy[i] * uy;
      const vt = -vx[i] * uy + vy[i] * ux;
      gasM[k] += 1;
      gasVr[k] += vr;
      gasLz[k] += vt * R;
      gasR2[k] += R * R;
      gasVz[k] += vz[i];
      gasE[k] += vr * vr + vt * vt + vz[i] * vz[i];
    }
    for (let i = 0; i < N; i++) {
      if (star[i]) continue;
      const k = cellOf(px[i], py[i], pz[i]);
      if (k < 0 || gasM[k] < 2) continue;
      const R = Math.max(1e-6, Math.hypot(px[i], py[i]));
      const ux = px[i] / R;
      const uy = py[i] / R;
      const vr = vx[i] * ux + vy[i] * uy;
      const vt = -vx[i] * uy + vy[i] * ux;
      const vrMean = gasVr[k] / gasM[k];
      const omega = gasLz[k] / Math.max(1e-9, gasR2[k]);
      const vtMean = omega * R;
      const vzMean = gasVz[k] / gasM[k];
      let dvr = vr - vrMean;
      let dvt = vt - vtMean;
      let dvz = vz[i] - vzMean;
      const shearAllow = omega * dx;
      const gate2 = FORM.SIGMA_FLOOR * FORM.SIGMA_FLOOR + 2 * shearAllow * shearAllow;
      if (dvr * dvr + dvt * dvt + dvz * dvz > gate2) {
        dvr *= coolK;
        dvt *= coolK;
        dvz *= coolK;
      }
      let nvr = vrMean + dvr;
      let nvt = vtMean + dvt;
      let nvz = vzMean + dvz;
      const h = heat[k];
      if (h > 0) {
        const kick = Math.sqrt(h);
        nvr += kick * dgauss(rng);
        nvt += kick * dgauss(rng);
        nvz += kick * dgauss(rng);
      }
      vx[i] = nvr * ux - nvt * uy;
      vy[i] = nvr * uy + nvt * ux;
      vz[i] = nvz;
    }
    heat.fill(0);

    // ---- star formation + enrichment (Schmidt law on the gas grid) ----
    if (step % FORM.SF_EVERY === FORM.SF_EVERY - 1) {
      for (let i = 0; i < N; i++) {
        if (star[i]) continue;
        const k = cellOf(px[i], py[i], pz[i]);
        if (k >= 0 && dZ[k] > 0) metal[i] = Math.min(0.06, metal[i] + dZ[k]);
      }
      dZ.fill(0);
      const t = step * DT;
      const fRet = nStarTot / N;
      for (let i = 0; i < N; i++) {
        if (star[i]) continue;
        const k = cellOf(px[i], py[i], pz[i]);
        if (k < 0) continue;
        const rhoG = (gasM[k] * gm) / cellVol;
        if (rhoG < FORM.SF_THRESH) continue;
        const mInv = 1 / gasM[k];
        const vrM = gasVr[k] * mInv;
        const omega = gasLz[k] / Math.max(1e-9, gasR2[k]);
        const vzM = gasVz[k] * mInv;
        const shear2 = 2 * omega * omega * dx * dx;
        const disp2 = Math.max(
          0,
          gasE[k] * mInv - vrM * vrM - omega * omega * gasR2[k] * mInv - vzM * vzM - shear2,
        );
        const cold2 = 2 * FORM.SF_COLD * FORM.SF_COLD;
        const fLin = cold2 / (cold2 + disp2);
        const fCold = fLin * fLin;
        const p = Math.min(
          FORM.SF_PMAX,
          FORM.SF_RATE * genes.sfEff * sfDt * fCold * Math.sqrt(rhoG / FORM.SF_THRESH),
        );
        if (rng() < p) {
          star[i] = 1;
          tBirth[i] = t;
          nStarTot++;
          if (gasM[k] > 1) {
            dZ[k] += (FORM.YIELD * fRet) / gasM[k];
            heat[k] += (FORM.FB_KICK * FORM.FB_KICK) / gasM[k];
          }
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
      let gasBlob = 0;
      let gasN = 0;
      for (let i = 0; i < N; i++) {
        lz += px[i] * vy[i] - py[i] * vx[i];
        ke += vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
        const r = Math.hypot(px[i], py[i]);
        rs += r;
        if (star[i]) {
          ns++;
          if (r < 1.25) blob++;
        } else {
          gasN++;
          if (r < 1.25) gasBlob++;
        }
      }
      opts.onDebug(step, lz / N, Math.sqrt(ke / N), rs / N, ns / N, blob / Math.max(1, ns), gasBlob / Math.max(1, gasN));
    }
  }

  // ---- measured rotation curve (midplane azimuthal average) ----
  const VC_DR = 0.25;
  const nvc = Math.floor(BOX / VC_DR);
  const vcirc = new Float64Array(nvc);
  for (let b = 0; b < nvc; b++) {
    const r = (b + 0.5) * VC_DR;
    let sum = 0;
    const NA = 32;
    for (let a = 0; a < NA; a++) {
      const th = (DTAU * a) / NA;
      const x = r * dcos(th);
      const y = r * dsin(th);
      const gx = (x + BOX) * invDx - 0.5;
      const gy = (y + BOX) * invDx - 0.5;
      const gz = BOX * invDx - 0.5;
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      const k0 = Math.floor(gz);
      let fxx = 0;
      let fyy = 0;
      if (i0 >= 0 && i0 < M - 1 && j0 >= 0 && j0 < M - 1 && k0 >= 0 && k0 < M - 1) {
        const tx = gx - i0;
        const ty = gy - j0;
        const tz = gz - k0;
        const bb = k0 * M2 + j0 * M + i0;
        const w000 = (1 - tx) * (1 - ty) * (1 - tz);
        const w100 = tx * (1 - ty) * (1 - tz);
        const w010 = (1 - tx) * ty * (1 - tz);
        const w110 = tx * ty * (1 - tz);
        const w001 = (1 - tx) * (1 - ty) * tz;
        const w101 = tx * (1 - ty) * tz;
        const w011 = (1 - tx) * ty * tz;
        const w111 = tx * ty * tz;
        fxx =
          fx[bb] * w000 +
          fx[bb + 1] * w100 +
          fx[bb + M] * w010 +
          fx[bb + M + 1] * w110 +
          fx[bb + M2] * w001 +
          fx[bb + M2 + 1] * w101 +
          fx[bb + M2 + M] * w011 +
          fx[bb + M2 + M + 1] * w111;
        fyy =
          fy[bb] * w000 +
          fy[bb + 1] * w100 +
          fy[bb + M] * w010 +
          fy[bb + M + 1] * w110 +
          fy[bb + M2] * w001 +
          fy[bb + M2 + 1] * w101 +
          fy[bb + M2 + M] * w011 +
          fy[bb + M2 + M + 1] * w111;
      }
      const fr = -(fxx * x + fyy * y) / Math.max(r, 1e-6);
      sum += Math.max(0, fr * r);
    }
    const halo = (v2 * r * r) / (r * r + rc2);
    vcirc[b] = Math.sqrt(sum / NA + halo);
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
