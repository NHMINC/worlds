/**
 * Gas-to-galaxy formation: the procedural magic.
 *
 * The galaxy is not laid out — it HAPPENS. The seed draws a small set
 * of formation genes (halo speed, spin, cooling time, star-formation
 * efficiency, cloud size, baryon mass). A rotating gas cloud collapses
 * in a static dark halo (the decreed dark-matter shortcut, same family
 * as "orbits are stable by fiat"); gas dissipates into a cold disk;
 * stars form where the gas is dense (Schmidt law) and inherit the
 * enriched metallicity of their birth cell (closed-box yield); the
 * cold self-gravitating disk then goes bar- and spiral-unstable ON ITS
 * OWN. Bulge, thick disk, bar, arms, the metallicity gradient and the
 * age structure are outcomes of the run, not terms in a formula.
 *
 * Numerics: 2D particle-mesh N-body (galaxies are thin; the vertical
 * structure is derived after the fact from each region's measured
 * velocity dispersion — a self-gravitating sech² sheet). CIC deposit,
 * isolated FFT Poisson solve, leapfrog kicks. Every transcendental
 * goes through detmath so the same seed mints bit-identical galaxies
 * on every engine. Runs once per (seed, FORMATION_VERSION); the baked
 * field is what the catalog samples.
 *
 * Toy compressions (visible and named, like TIME_SCALE): SIM_GYR of
 * dynamical time stand in for GALAXY_AGE_GYR of cosmic time — ages
 * are mapped linearly when the field is baked.
 */
import { mulberry32, xmur3 } from '../rng';
import { dcos, dexp, dgauss, dlog, dsin, DTAU } from './detmath';
import { PoissonSolver } from './fft';

/** Bump when the sim's laws change: every address in the sky moves. */
export const FORMATION_VERSION = 3;

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
  onSnapshot?: (step: number, px: Float64Array, py: Float64Array, star: Uint8Array, tBirth: Float32Array) => void;
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
  /** Positions (kpc), velocities (km/s). */
  px: Float64Array;
  py: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
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
  N: 100_000,
  MESH: 128,
  /** Half-width of the dynamics box (kpc). */
  BOX: 22,
  DT: 3,
  STEPS: 2600,
  /** Plummer softening (kpc) — also the resolution floor. */
  SOFT: 0.8,
  /** Solve gravity every this many steps (forces reused between). */
  GRAV_EVERY: 2,
  /** Star formation pass cadence (steps). */
  SF_EVERY: 4,
  /** GΣ threshold for star formation ((km/s)²/kpc ≈ 15 Msun/pc²). */
  SF_THRESH: 70,
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

/** Static halo acceleration: logarithmic potential, flat outer curve. */
function haloAx(x: number, y: number, v2: number, rc2: number): number {
  return (-v2 * x) / (x * x + y * y + rc2);
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
  const vx = new Float64Array(N);
  const vy = new Float64Array(N);
  const star = new Uint8Array(N);
  const tBirth = new Float32Array(N);
  const metal = new Float32Array(N);
  const gm = genes.gmBaryon / N;

  const v2 = genes.vHalo * genes.vHalo;
  const rc2 = genes.rcHalo * genes.rcHalo;

  // --- initial conditions: a rotating gas cloud at marginal stability ---
  // The radial draw is Gamma(2, cloudR/2) — i.e. an exponential disk
  // with scale θ = cloudR/2, so Σ(r), the enclosed mass and the local
  // circular speed are all closed form. Support must be honest from
  // t = 0: under-supported ICs plunge, and an unresolvable plunge
  // shreds angular momentum.
  const theta = genes.cloudR / 2;
  const vcInit = (r: number): number => {
    const xg = r / theta;
    const encl = 1 - dexp(-xg) * (1 + xg);
    return Math.sqrt((v2 * r * r) / (r * r + rc2) + (genes.gmBaryon * encl) / Math.max(r, 0.3));
  };
  for (let i = 0; i < N; i++) {
    let r = 0;
    do {
      r = -theta * (dlog(rng() + 1e-12) + dlog(rng() + 1e-12));
    } while (r > BOX * 0.72);
    const th = DTAU * rng();
    const c = dcos(th);
    const s = dsin(th);
    px[i] = r * c;
    py[i] = r * s;
    const vc = vcInit(r);
    // Toomre-regulated dispersion: σ = Q·π·GΣ/κ with the analytic
    // exponential Σ and κ² = 2Ω²(1 + dlnv/dlnr) from the same curve.
    const rr = Math.max(r, 0.4);
    const gSig = (genes.gmBaryon * dexp(-rr / theta)) / (2 * Math.PI * theta * theta);
    const vcHi = vcInit(rr * 1.05);
    const dlnv = (dlog(Math.max(1, vcHi)) - dlog(Math.max(1, vcInit(rr)))) / dlog(1.05);
    const om = vcInit(rr) / rr;
    const kappa = Math.sqrt(Math.max(0.5, 2 * om * om * (1 + dlnv)));
    const sig = Math.min(0.55 * vc + 8, Math.max(12, (FORM.Q_INIT * Math.PI * gSig) / kappa));
    // Asymmetric drift: pressure already carries part of the support,
    // so a hot disk must rotate slower or it is over-supported and
    // breathes — a global slosh that ends in violent relaxation.
    const vSup = Math.sqrt(Math.max(0, vc * vc - 2 * sig * sig));
    // Turbulent cloud: per-parcel spin scatter puts a low-J tail in
    // the gas — that tail sinks and builds the center.
    const vphi = genes.spin * vSup * (1 + 0.12 * dgauss(rng));
    vx[i] = -vphi * s + sig * dgauss(rng);
    vy[i] = vphi * c + sig * dgauss(rng);
    metal[i] = FORM.Z0;
  }

  // --- grids ---
  const massG = new Float64Array(M * M);
  const phi = new Float64Array(M * M);
  const fx = new Float64Array(M * M);
  const fy = new Float64Array(M * M);
  const gasM = new Float64Array(M * M);
  const gasPx = new Float64Array(M * M);
  const gasPy = new Float64Array(M * M);
  const gasV2 = new Float64Array(M * M);
  const gasE = new Float64Array(M * M);
  const dZ = new Float64Array(M * M);
  const heat = new Float64Array(M * M);
  let nStarTot = 0;
  const solver = new PoissonSolver(M, dx, FORM.SOFT);

  const cellOf = (x: number, y: number): number => {
    const ci = Math.floor((x + BOX) / dx);
    const cj = Math.floor((y + BOX) / dx);
    if (ci < 0 || ci >= M || cj < 0 || cj >= M) return -1;
    return cj * M + ci;
  };

  const coolK = dexp(-DT / genes.coolTau);
  const invDx = 1 / dx;
  const cellArea = dx * dx;
  // SF probability per pass: rate × sqrt(Σ/thresh) × dt, capped.
  const sfDt = DT * FORM.SF_EVERY;

  for (let step = 0; step < STEPS; step++) {
    // ---- gravity: CIC deposit + FFT solve (every GRAV_EVERY steps) ----
    if (step % FORM.GRAV_EVERY === 0) {
      massG.fill(0);
      for (let i = 0; i < N; i++) {
        const gx = (px[i] + BOX) * invDx - 0.5;
        const gy = (py[i] + BOX) * invDx - 0.5;
        const i0 = Math.floor(gx);
        const j0 = Math.floor(gy);
        const tx = gx - i0;
        const ty = gy - j0;
        if (i0 < 0 || i0 >= M - 1 || j0 < 0 || j0 >= M - 1) continue;
        const b = j0 * M + i0;
        massG[b] += gm * (1 - tx) * (1 - ty);
        massG[b + 1] += gm * tx * (1 - ty);
        massG[b + M] += gm * (1 - tx) * ty;
        massG[b + M + 1] += gm * tx * ty;
      }
      solver.solve(massG, phi);
      // Force = −∇Φ, central differences (edges: one-sided → zero).
      fx.fill(0);
      fy.fill(0);
      const h2 = 0.5 * invDx;
      for (let j = 1; j < M - 1; j++) {
        for (let i = 1; i < M - 1; i++) {
          const k = j * M + i;
          fx[k] = -(phi[k + 1] - phi[k - 1]) * h2;
          fy[k] = -(phi[k + M] - phi[k - M]) * h2;
        }
      }
    }

    // ---- kick + drift ----
    for (let i = 0; i < N; i++) {
      const gx = (px[i] + BOX) * invDx - 0.5;
      const gy = (py[i] + BOX) * invDx - 0.5;
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      let ax = 0;
      let ay = 0;
      if (i0 >= 0 && i0 < M - 1 && j0 >= 0 && j0 < M - 1) {
        const tx = gx - i0;
        const ty = gy - j0;
        const b = j0 * M + i0;
        ax =
          fx[b] * (1 - tx) * (1 - ty) +
          fx[b + 1] * tx * (1 - ty) +
          fx[b + M] * (1 - tx) * ty +
          fx[b + M + 1] * tx * ty;
        ay =
          fy[b] * (1 - tx) * (1 - ty) +
          fy[b + 1] * tx * (1 - ty) +
          fy[b + M] * (1 - tx) * ty +
          fy[b + M + 1] * tx * ty;
      }
      ax += haloAx(px[i], py[i], v2, rc2);
      ay += haloAx(py[i], px[i], v2, rc2);
      vx[i] += ax * DT * KV;
      vy[i] += ay * DT * KV;
      px[i] += vx[i] * DT * KV;
      py[i] += vy[i] * DT * KV;
    }

    // ---- gas cooling, in POLAR components ----
    // Dissipation damps motion relative to the local mean FLOW. A
    // Cartesian cell-mean cannot see rotation tighter than one cell:
    // opposite sides of a compact rotating core average to zero and
    // "cooling" silently destroys the galaxy's angular momentum (a
    // real bug — Lz/N fell 884 → 25 and the core exploded). In polar
    // components the estimator is unbiased: the cell's best rigid
    // rotation is ω̄ = Σ r·vφ / Σ r², a fixed point of the damping at
    // ANY resolution. Radial flow damps toward the cell mean v_r.
    gasM.fill(0);
    gasPx.fill(0); // Σ v_r
    gasPy.fill(0); // Σ r·vφ (angular momentum)
    gasV2.fill(0); // Σ r²   (moment of inertia)
    gasE.fill(0); // Σ (v_r² + vφ²) for the dispersion estimate
    for (let i = 0; i < N; i++) {
      if (star[i]) continue;
      const k = cellOf(px[i], py[i]);
      if (k < 0) continue;
      const r = Math.max(1e-6, Math.hypot(px[i], py[i]));
      const ux = px[i] / r;
      const uy = py[i] / r;
      const vr = vx[i] * ux + vy[i] * uy;
      const vt = -vx[i] * uy + vy[i] * ux;
      gasM[k] += 1;
      gasPx[k] += vr;
      gasPy[k] += vt * r;
      gasV2[k] += r * r;
      gasE[k] += vr * vr + vt * vt;
    }
    for (let i = 0; i < N; i++) {
      if (star[i]) continue;
      const k = cellOf(px[i], py[i]);
      if (k < 0 || gasM[k] < 2) continue;
      const r = Math.max(1e-6, Math.hypot(px[i], py[i]));
      const ux = px[i] / r;
      const uy = py[i] / r;
      const vr = vx[i] * ux + vy[i] * uy;
      const vt = -vx[i] * uy + vy[i] * ux;
      const vrMean = gasPx[k] / gasM[k];
      const omega = gasPy[k] / Math.max(1e-9, gasV2[k]);
      const vtMean = omega * r;
      let dvr = vr - vrMean;
      let dvt = vt - vtMean;
      // Shear allowance: differential rotation across one cell reads
      // as ~ω·dx of false dispersion. Damping THAT is not cooling —
      // it is a huge turbulent viscosity that drains the whole disk
      // into a nuclear blob (observed: 60% of stars at R < 1 kpc).
      // A settled shearing disk must register as cold and be left
      // alone; only genuine random motion above the floor dissipates.
      const shearAllow = omega * dx;
      const gate2 = FORM.SIGMA_FLOOR * FORM.SIGMA_FLOOR + 2 * shearAllow * shearAllow;
      if (dvr * dvr + dvt * dvt > gate2) {
        dvr *= coolK;
        dvt *= coolK;
      }
      let nvr = vrMean + dvr;
      let nvt = vtMean + dvt;
      // Supernova reheating from last pass's births in this cell —
      // heat[] accumulates variance, the kick is its square root.
      const h = heat[k];
      if (h > 0) {
        const kick = Math.sqrt(h);
        nvr += kick * dgauss(rng);
        nvt += kick * dgauss(rng);
      }
      vx[i] = nvr * ux - nvt * uy;
      vy[i] = nvr * uy + nvt * ux;
    }
    heat.fill(0);

    // ---- star formation + enrichment (Schmidt law on the gas grid) ----
    if (step % FORM.SF_EVERY === FORM.SF_EVERY - 1) {
      // Apply last pass's enrichment, then mint stars against fresh Σ.
      for (let i = 0; i < N; i++) {
        if (star[i]) continue;
        const k = cellOf(px[i], py[i]);
        if (k >= 0 && dZ[k] > 0) metal[i] = Math.min(0.06, metal[i] + dZ[k]);
      }
      dZ.fill(0);
      const t = step * DT;
      // Wind retention: the assembled stellar fraction (see YIELD).
      const fRet = nStarTot / N;
      for (let i = 0; i < N; i++) {
        if (star[i]) continue;
        const k = cellOf(px[i], py[i]);
        if (k < 0) continue;
        const sigmaG = (gasM[k] * gm) / cellArea;
        if (sigmaG < FORM.SF_THRESH) continue;
        // Cold efficiency: polar cell dispersion (unbiased by rotation
        // — see the cooling law). Smooth — hot infall forms stars
        // slowly (the spheroid), cold settled disk at full Schmidt
        // rate (the thin disk).
        const mInv = 1 / gasM[k];
        const vrM = gasPx[k] * mInv;
        const omega = gasPy[k] / Math.max(1e-9, gasV2[k]);
        const shear2 = 2 * omega * omega * dx * dx;
        const disp2 = Math.max(
          0,
          gasE[k] * mInv - vrM * vrM - omega * omega * gasV2[k] * mInv - shear2,
        );
        const cold2 = 2 * FORM.SF_COLD * FORM.SF_COLD;
        const fLin = cold2 / (cold2 + disp2);
        // Squared: heated cells must actually shut off, or feedback
        // cannot regulate and the gas burns in one global burst.
        const fCold = fLin * fLin;
        const p = Math.min(
          FORM.SF_PMAX,
          FORM.SF_RATE * genes.sfEff * sfDt * fCold * Math.sqrt(sigmaG / FORM.SF_THRESH),
        );
        if (rng() < p) {
          star[i] = 1;
          tBirth[i] = t;
          nStarTot++;
          if (gasM[k] > 1) {
            // Retained yield to the cell's remaining gas, and the
            // supernovae of this stellar generation reheat it (energy
            // per formed mass, shared over the cell's gas → variance).
            dZ[k] += (FORM.YIELD * fRet) / gasM[k];
            heat[k] += (FORM.FB_KICK * FORM.FB_KICK) / gasM[k];
          }
        }
      }
    }

    if (opts.onProgress && step % 64 === 0) opts.onProgress(step / STEPS);
    if (opts.onSnapshot && opts.snapEvery && step % opts.snapEvery === 0) {
      opts.onSnapshot(step, px, py, star, tBirth);
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
        ke += vx[i] * vx[i] + vy[i] * vy[i];
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

  // ---- measured rotation curve (azimuthal average of the last force grid) ----
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
      // Radial self-gravity force, bilinear off the grid.
      const gx = (x + BOX) * invDx - 0.5;
      const gy = (y + BOX) * invDx - 0.5;
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      let fxx = 0;
      let fyy = 0;
      if (i0 >= 0 && i0 < M - 1 && j0 >= 0 && j0 < M - 1) {
        const tx = gx - i0;
        const ty = gy - j0;
        const bb = j0 * M + i0;
        fxx =
          fx[bb] * (1 - tx) * (1 - ty) +
          fx[bb + 1] * tx * (1 - ty) +
          fx[bb + M] * (1 - tx) * ty +
          fx[bb + M + 1] * tx * ty;
        fyy =
          fy[bb] * (1 - tx) * (1 - ty) +
          fy[bb + 1] * tx * (1 - ty) +
          fy[bb + M] * (1 - tx) * ty +
          fy[bb + M + 1] * tx * ty;
      }
      const fr = -(fxx * x + fyy * y) / Math.max(r, 1e-6);
      sum += Math.max(0, fr * r) ;
    }
    const halo = (v2 * r * r) / (r * r + rc2);
    vcirc[b] = Math.sqrt(sum / NA + halo);
  }

  return {
    genes,
    n: N,
    px,
    py,
    vx,
    vy,
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
