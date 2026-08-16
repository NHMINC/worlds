/**
 * Radix-2 complex FFT with deterministic twiddles (detmath sin/cos).
 * Interleaved Float64Array [re, im, re, im, ...]. Power-of-two sizes.
 * Used by the isolated Poisson solver: the disk's self-gravity is a
 * convolution of surface density with a softened 1/r kernel, done in
 * Fourier space on a zero-padded grid (no periodic images).
 */
import { dcos, dsin, DPI } from './detmath';

export interface FftPlan {
  n: number;
  /** Bit-reversal permutation. */
  rev: Uint32Array;
  /** Twiddle factors per stage, packed [cos, sin, ...]. */
  tw: Float64Array;
}

export function makePlan(n: number): FftPlan {
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  // Twiddles for all stages concatenated: stage m uses m/2 factors.
  let total = 0;
  for (let m = 2; m <= n; m <<= 1) total += m >> 1;
  const tw = new Float64Array(total * 2);
  let o = 0;
  for (let m = 2; m <= n; m <<= 1) {
    const half = m >> 1;
    for (let j = 0; j < half; j++) {
      const a = (-2 * DPI * j) / m;
      tw[o++] = dcos(a);
      tw[o++] = dsin(a);
    }
  }
  return { n, rev, tw };
}

/** In-place complex FFT. dir = -1 forward, +1 inverse (unscaled). */
export function fft(plan: FftPlan, a: Float64Array, off: number, stride: number, dir: number): void {
  const { n, rev, tw } = plan;
  for (let i = 0; i < n; i++) {
    const r = rev[i];
    if (r > i) {
      const ia = off + i * stride;
      const ib = off + r * stride;
      let t = a[ia];
      a[ia] = a[ib];
      a[ib] = t;
      t = a[ia + 1];
      a[ia + 1] = a[ib + 1];
      a[ib + 1] = t;
    }
  }
  let o = 0;
  for (let m = 2; m <= n; m <<= 1) {
    const half = m >> 1;
    for (let k = 0; k < n; k += m) {
      for (let j = 0; j < half; j++) {
        const wr = tw[(o + j) * 2];
        const wi = dir * tw[(o + j) * 2 + 1];
        const ia = off + (k + j) * stride;
        const ib = off + (k + j + half) * stride;
        const br = a[ib] * wr - a[ib + 1] * wi;
        const bi = a[ib] * wi + a[ib + 1] * wr;
        a[ib] = a[ia] - br;
        a[ib + 1] = a[ia + 1] - bi;
        a[ia] += br;
        a[ia + 1] += bi;
      }
    }
    o += half;
  }
}

/** 2D in-place complex FFT on an n×n interleaved grid. */
export function fft2d(plan: FftPlan, a: Float64Array, dir: number): void {
  const n = plan.n;
  for (let row = 0; row < n; row++) fft(plan, a, row * n * 2, 2, dir);
  for (let col = 0; col < n; col++) fft(plan, a, col * 2, n * 2, dir);
}

/** 3D in-place complex FFT on an n×n×n interleaved grid (x fastest). */
export function fft3d(plan: FftPlan, a: Float64Array, dir: number): void {
  const n = plan.n;
  const n2 = n * n;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) fft(plan, a, (z * n2 + y * n) * 2, 2, dir);
  }
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) fft(plan, a, (z * n2 + x) * 2, n * 2, dir);
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) fft(plan, a, (y * n + x) * 2, n2 * 2, dir);
  }
}

/**
 * Isolated Poisson solver for a thin disk: Φ = (G·mass) ⊛ −1/√(r²+ε²).
 * Mesh m×m of G-folded cell masses (units (km/s)²·kpc); zero-padded to
 * p=2m so periodic images cannot reach the physical region. Returns Φ
 * on the m×m mesh, (km/s)².
 */
export class PoissonSolver {
  private readonly m: number;
  private readonly p: number;
  private readonly plan: FftPlan;
  private readonly kernel: Float64Array;
  private readonly work: Float64Array;

  constructor(m: number, dx: number, soft: number) {
    this.m = m;
    this.p = m * 2;
    this.plan = makePlan(this.p);
    const p = this.p;
    this.work = new Float64Array(p * p * 2);
    // Softened point-mass kernel, wrapped so distance is to the nearest
    // image inside the padded box (standard isolated-BC construction).
    this.kernel = new Float64Array(p * p * 2);
    for (let j = 0; j < p; j++) {
      const dj = j <= p / 2 ? j : j - p;
      for (let i = 0; i < p; i++) {
        const di = i <= p / 2 ? i : i - p;
        const r2 = (di * di + dj * dj) * dx * dx + soft * soft;
        this.kernel[(j * p + i) * 2] = -1 / Math.sqrt(r2);
      }
    }
    fft2d(this.plan, this.kernel, -1);
  }

  /** massG: m×m G-folded masses. phi: m×m output. */
  solve(massG: Float64Array, phi: Float64Array): void {
    const { m, p, work, kernel, plan } = this;
    work.fill(0);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        work[(j * p + i) * 2] = massG[j * m + i];
      }
    }
    fft2d(plan, work, -1);
    for (let k = 0; k < p * p; k++) {
      const re = work[k * 2];
      const im = work[k * 2 + 1];
      const kr = kernel[k * 2];
      const ki = kernel[k * 2 + 1];
      work[k * 2] = re * kr - im * ki;
      work[k * 2 + 1] = re * ki + im * kr;
    }
    fft2d(plan, work, 1);
    const inv = 1 / (p * p);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        phi[j * m + i] = work[(j * p + i) * 2] * inv;
      }
    }
  }
}

/**
 * Isolated Poisson solver in 3D: Φ = (G·mass) ⊛ −1/√(r²+ε²).
 * Same Plummer kernel as the disk solver; the third axis is real.
 * Mesh m³ of G-folded cell masses, zero-padded to p=2m.
 */
export class PoissonSolver3D {
  private readonly m: number;
  private readonly p: number;
  private readonly plan: FftPlan;
  private readonly kernel: Float64Array;
  private readonly work: Float64Array;

  constructor(m: number, dx: number, soft: number) {
    this.m = m;
    this.p = m * 2;
    this.plan = makePlan(this.p);
    const p = this.p;
    this.work = new Float64Array(p * p * p * 2);
    this.kernel = new Float64Array(p * p * p * 2);
    const p2 = p * p;
    for (let k = 0; k < p; k++) {
      const dk = k <= p / 2 ? k : k - p;
      for (let j = 0; j < p; j++) {
        const dj = j <= p / 2 ? j : j - p;
        for (let i = 0; i < p; i++) {
          const di = i <= p / 2 ? i : i - p;
          const r2 = (di * di + dj * dj + dk * dk) * dx * dx + soft * soft;
          this.kernel[(k * p2 + j * p + i) * 2] = -1 / Math.sqrt(r2);
        }
      }
    }
    fft3d(this.plan, this.kernel, -1);
  }

  /** massG: m³ G-folded masses. phi: m³ output. */
  solve(massG: Float64Array, phi: Float64Array): void {
    const { m, p, work, kernel, plan } = this;
    work.fill(0);
    const m2 = m * m;
    const p2 = p * p;
    for (let k = 0; k < m; k++) {
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          work[(k * p2 + j * p + i) * 2] = massG[k * m2 + j * m + i];
        }
      }
    }
    fft3d(plan, work, -1);
    const n = p * p * p;
    for (let t = 0; t < n; t++) {
      const re = work[t * 2];
      const im = work[t * 2 + 1];
      const kr = kernel[t * 2];
      const ki = kernel[t * 2 + 1];
      work[t * 2] = re * kr - im * ki;
      work[t * 2 + 1] = re * ki + im * kr;
    }
    fft3d(plan, work, 1);
    const inv = 1 / n;
    for (let k = 0; k < m; k++) {
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          phi[k * m2 + j * m + i] = work[(k * p2 + j * p + i) * 2] * inv;
        }
      }
    }
  }
}
