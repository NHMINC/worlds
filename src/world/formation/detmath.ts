/**
 * Deterministic transcendentals for the formation sim.
 *
 * IEEE-754 guarantees exactly rounded +, −, ×, ÷ and sqrt on every
 * JavaScript engine, but Math.sin / cos / exp / log / pow are
 * implementation-defined — V8, JavaScriptCore and SpiderMonkey differ
 * in the last bits, and a chaotic N-body integrator amplifies a 1-ulp
 * disagreement into a different galaxy. The catalog is SHARED, so the
 * sim may only use these fixed polynomials (built from IEEE ops) and
 * never Math.* transcendentals. Accuracy ~1e-9 — far below the sim's
 * own noise floor; identical bits everywhere is the law that matters.
 */

const PI = 3.141592653589793;
const TWO_OVER_PI = 0.6366197723675814;
// Cody–Waite split of π/2: HI is the closest double, LO the residual.
const PIO2_HI = 1.5707963267948966;
const PIO2_LO = 6.123233995736766e-17;
const LOG2E = 1.4426950408889634;
const LN2_HI = 0.6931471805598953;
const LN2_LO = 5.497923018708371e-14;

export const DPI = PI;
export const DTAU = 6.283185307179586;

/** 2^k exactly, via repeated squaring of the exact double 2. */
function pow2(k: number): number {
  let e = k < 0 ? -k : k;
  let base = 2;
  let p = 1;
  while (e > 0) {
    if (e & 1) p *= base;
    base *= base;
    e >>= 1;
  }
  return k < 0 ? 1 / p : p;
}

function sinPoly(r: number): number {
  const r2 = r * r;
  return (
    r *
    (1 +
      r2 *
        (-0.16666666666666666 +
          r2 *
            (0.008333333333333333 +
              r2 * (-0.0001984126984126984 + r2 * (2.7557319223985893e-6 + r2 * -2.505210838544172e-8)))))
  );
}

function cosPoly(r: number): number {
  const r2 = r * r;
  return (
    1 +
    r2 *
      (-0.5 +
        r2 *
          (0.041666666666666664 +
            r2 * (-0.001388888888888889 + r2 * (0.0000248015873015873 + r2 * -2.755731922398589e-7))))
  );
}

/** Deterministic sine. Valid for |x| ≲ 1e6 (single-word range reduction). */
export function dsin(x: number): number {
  const n = Math.floor(x * TWO_OVER_PI + 0.5);
  const r = x - n * PIO2_HI - n * PIO2_LO;
  const q = ((n % 4) + 4) % 4;
  if (q === 0) return sinPoly(r);
  if (q === 1) return cosPoly(r);
  if (q === 2) return -sinPoly(r);
  return -cosPoly(r);
}

/** Deterministic cosine. */
export function dcos(x: number): number {
  return dsin(x + PIO2_HI);
}

/** Deterministic exp. Clamped to avoid overflow surprises. */
export function dexp(x: number): number {
  if (x > 700) x = 700;
  if (x < -700) return 0;
  const k = Math.floor(x * LOG2E + 0.5);
  const r = x - k * LN2_HI - k * LN2_LO;
  const r2 = r * r;
  const p =
    1 +
    r *
      (1 +
        r *
          (0.5 +
            r *
              (0.16666666666666666 +
                r *
                  (0.041666666666666664 +
                    r * (0.008333333333333333 + r * (0.001388888888888889 + r * 0.0001984126984126984)))))) +
    r2 * r2 * r2 * r2 * 2.48015873015873e-5;
  return p * pow2(k);
}

const F64 = new DataView(new ArrayBuffer(8));

/** Deterministic natural log for x > 0. */
export function dlog(x: number): number {
  if (!(x > 0)) return -Infinity;
  F64.setFloat64(0, x);
  let e = ((F64.getUint32(0) >>> 20) & 0x7ff) - 1023;
  // Subnormals: scale up exactly and retry the exponent read.
  if (e === -1023) {
    x *= 9007199254740992; // 2^53, exact
    F64.setFloat64(0, x);
    e = ((F64.getUint32(0) >>> 20) & 0x7ff) - 1023 - 53;
  }
  let m = x * pow2(-e); // exact: [1, 2)
  if (m > 1.4142135623730951) {
    m *= 0.5;
    e += 1;
  }
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  const lnM =
    2 *
    s *
    (1 +
      s2 *
        (0.3333333333333333 +
          s2 * (0.2 + s2 * (0.14285714285714285 + s2 * (0.1111111111111111 + s2 * 0.09090909090909091)))));
  return lnM + e * LN2_HI + e * LN2_LO;
}

/** Deterministic base-10 log. */
export function dlog10(x: number): number {
  return dlog(x) * 0.4342944819032518;
}

/** Deterministic x^y for x > 0. */
export function dpow(x: number, y: number): number {
  return dexp(y * dlog(x));
}

/**
 * Deterministic standard normal via Box–Muller. Consumes exactly two
 * rng draws per call — call order is part of the galaxy's identity.
 */
export function dgauss(rng: () => number): number {
  const u1 = rng() + 1.1102230246251565e-16; // never exactly 0
  const u2 = rng();
  return Math.sqrt(-2 * dlog(u1)) * dcos(DTAU * u2);
}
