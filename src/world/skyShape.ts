/**
 * Shared nebula envelope law. Clock → kind, then a sphere on the
 * virtual source. The same function feeds the distant backdrop and
 * the local sample, so the object you see far away is the one you
 * fly into. (Dust is not a kind: the fog is the baked ISM field.)
 *
 * v1 is a camera-facing disc (the cheap sphere silhouette). World
 * size is kpc. A later volume or mesh upgrades this evaluator —
 * not the catalog.
 */
import { UNIVERSE } from './physics';
import type { NebulaKind } from './stellar';

export const KIND_STAR = 0;
export const KIND_HII = 1;
export const KIND_PN = 2;
export const KIND_SNR = 3;

export type SkyKind = 0 | 1 | 2 | 3;

export interface SkyShape {
  kind: SkyKind;
  /** Billboard half-extent in catalog kpc. */
  radiusKpc: number;
  /** 0 = round, 1 = flattened to the disk. Unused on the sphere. */
  flatten: number;
  /** In-plane stretch. Unused on the sphere. */
  axes: [number, number];
  clump: number;
  seed: number;
  rgb: [number, number, number];
}

/** Address hash in [0, 1). Same family as the catalog coins. */
export function shapeHash(id: number, salt: number): number {
  let h = (id | 0) ^ Math.imul(salt | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function kindFromNebula(nebula: NebulaKind): SkyKind {
  if (nebula === 'hii') return KIND_HII;
  if (nebula === 'planetary') return KIND_PN;
  if (nebula === 'snr') return KIND_SNR;
  return KIND_STAR;
}

const WHITE: [number, number, number] = [1, 1, 1];
const CYAN: [number, number, number] = [0.35, 0.95, 0.95];
const RED: [number, number, number] = [1, 0.26, 0.2];

/**
 * Sphere on a virtual source. Stars return a tight photosphere;
 * nebulae return a modest ball the shaders draw at 50% alpha.
 * Colour is the kind; radius hashes a little so neighbours are
 * not clones.
 */
export function shapeAt(kind: SkyKind, id: number): SkyShape {
  const h0 = shapeHash(id, 1);
  const r = 0.028 + 0.022 * h0;
  if (kind === KIND_PN) {
    return { kind, radiusKpc: r, flatten: 0, axes: [1, 1], clump: 1, seed: h0, rgb: CYAN };
  }
  if (kind === KIND_SNR) {
    return { kind, radiusKpc: r * 1.3, flatten: 0, axes: [1, 1], clump: 1, seed: h0, rgb: RED };
  }
  if (kind === KIND_HII) {
    return { kind, radiusKpc: r * 1.1, flatten: 0, axes: [1, 1], clump: 1, seed: h0, rgb: WHITE };
  }
  return {
    kind: KIND_STAR,
    radiusKpc: 0.008,
    flatten: 0,
    axes: [1, 1],
    clump: 1,
    seed: h0,
    rgb: WHITE,
  };
}

export interface EmissionLook {
  radiusKpc: number;
  /** Surface-brightness fade: young events blaze, old ones ghost. */
  gain: number;
  rgb: [number, number, number];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The event law: an emission nebula's size, brightness, and hue from
 * what caused it. PN and SNR are expanding shells — radius grows over
 * the toy window (SNR Sedov-ish, t^0.4) while a fixed line luminosity
 * spreads over the growing surface, so surface brightness fades.
 * H II is Strömgren-ish: the ionized bubble scales with the host's
 * luminosity. Hue leans on the host chemistry: carbon-rich PNe warm
 * away from [O III] teal; metal-poor SNR shocks run pale.
 */
export function emissionLook(
  kind: SkyKind,
  id: number,
  ev: { deadFor: number; ageGyr: number; luminosity: number; carbon: number; feh: number },
): EmissionLook {
  const h = shapeHash(id, 5);
  if (kind === KIND_PN) {
    const frac = clamp01(ev.deadFor / UNIVERSE.PN_GYR);
    const radius = UNIVERSE.PN_R_MAX * (0.18 + 0.82 * frac) * (0.8 + 0.4 * h);
    const gain = 0.15 + 0.85 * Math.pow(1 - frac, 1.2);
    const warm = clamp01((ev.carbon - 1.1) * 0.8);
    return { radiusKpc: radius, gain, rgb: mixRgb(CYAN, [0.95, 0.78, 0.5], 0.5 * warm) };
  }
  if (kind === KIND_SNR) {
    const frac = clamp01(ev.deadFor / UNIVERSE.SNR_GYR);
    const radius = UNIVERSE.SNR_R_MAX * Math.max(0.12, Math.pow(frac, 0.4)) * (0.8 + 0.4 * h);
    const gain = 0.1 + 0.9 * Math.pow(1 - frac, 1.4);
    const pale = clamp01(-ev.feh) * 0.5;
    return { radiusKpc: radius, gain, rgb: mixRgb(RED, [1, 0.82, 0.78], pale) };
  }
  // H II: the ionized bubble around a young luminous star.
  const frac = clamp01(ev.ageGyr / UNIVERSE.HII_GYR);
  const radius = Math.max(0.03, Math.min(0.3, UNIVERSE.HII_R_K * Math.cbrt(Math.max(1, ev.luminosity))));
  const gain = 0.45 + 0.55 * (1 - frac);
  return { radiusKpc: radius, gain, rgb: mixRgb([1, 0.42, 0.36], [1, 0.66, 0.62], 0.28) };
}

/**
 * Fragment laws — every envelope is a short raymarch now.
 *
 * Dust marches ONE absolute sub-grid ISM field — domain-warped fBm
 * flattened toward the disk plane, so filaments lie in the plane and
 * neighbouring clumps are windows onto the same cloudscape. Density
 * integrates to Beer-Lambert opacity: wisps barely tint, cores
 * obscure, star-forming clumps get a warm lit rim (the Pillars look).
 *
 * Emission nebulae are self-luminous shells shaped by their event:
 * PN a clumpy (sometimes bipolar) ejected envelope, SNR a thinner
 * blast shell shredded into filaments, H II the natal cloud lit from
 * inside (the SAME dustField the dust draws, carved by an ionization
 * falloff). Brightness is EMISSION MEASURE — rho² integrated along
 * the ray — so limb-brightened rings and bright filament crossings
 * come from geometry, not paint.
 */
export const SHAPE_GLSL = /* glsl */ `
float dustHash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

float dustVnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = dustHash(i);
  float n100 = dustHash(i + vec3(1.0, 0.0, 0.0));
  float n010 = dustHash(i + vec3(0.0, 1.0, 0.0));
  float n110 = dustHash(i + vec3(1.0, 1.0, 0.0));
  float n001 = dustHash(i + vec3(0.0, 0.0, 1.0));
  float n101 = dustHash(i + vec3(1.0, 0.0, 1.0));
  float n011 = dustHash(i + vec3(0.0, 1.0, 1.0));
  float n111 = dustHash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z) * 2.0 - 1.0;
}

/** Absolute sub-grid ISM field in [-1,1] at a catalog point (kpc). */
float dustField(vec3 qCat, float freq) {
  // Filaments lie in the disk: compress the vertical axis.
  vec3 s = vec3(qCat.x, qCat.y * 2.4, qCat.z);
  // Domain warp makes wisps and pillars instead of blobs.
  float wx = dustVnoise(s * freq * 0.37 + 19.1);
  float wz = dustVnoise(s * freq * 0.37 + 71.7);
  s += vec3(wx, 0.0, wz) * (2.6 / freq);
  float a = dustVnoise(s * freq);
  a += 0.5 * dustVnoise(s * freq * 2.17 + 39.7);
  return a / 1.5;
}

/** Local cloud density: the shared field windowed by the clump envelope. */
float dustRho(vec3 qCat, vec3 relCat, float radiusCat, float meanD, float freq) {
  float r = length(relCat) / max(radiusCat, 1e-5);
  float env = max(0.0, 1.0 - r * r);
  // Dense clumps keep more of the log-normal field above threshold.
  float cut = 0.62 - 0.72 * meanD;
  return max(0.0, dustField(qCat, freq) - cut) * env;
}

/** Gaussian shell in normalized radius — an expanding envelope. */
float nebShell(float r, float mid, float w) {
  float x = (r - mid) / max(w, 1e-3);
  return exp(-x * x);
}

/** Cheaper 2-octave field (no domain warp) for shell texture. */
float nebField(vec3 q, float freq) {
  float a = dustVnoise(q * freq);
  a += 0.5 * dustVnoise(q * freq * 2.17 + 39.7);
  return a / 1.5;
}

/**
 * Emission density by kind. relCat is the offset from the host
 * (catalog kpc), qCat the absolute point (the shared ISM anchor).
 */
float nebRho(float kind, vec3 qCat, vec3 relCat, float radiusCat, float meanD, float freq, float seed) {
  float r = length(relCat) / max(radiusCat, 1e-5);
  if (r > 1.0) return 0.0;
  if (kind > 2.5) {
    // SNR: a thin blast shell shredded into filaments (shock corrugation).
    float shell = nebShell(r, 0.82, 0.07 + 0.04 * fract(seed * 5.17));
    float f = nebField(qCat * 1.9 + 31.0, freq * 2.4);
    float fil = pow(max(0.0, f + 0.3), 1.6);
    return shell * fil * 1.6;
  }
  if (kind > 1.5) {
    // PN: the ejected envelope — clumpy shell, hash picks bipolar lobes.
    float shell = nebShell(r, 0.7, 0.1 + 0.08 * fract(seed * 7.31));
    float knots = 0.6 + 0.8 * nebField(qCat * 3.1 + 57.0, freq * 3.2);
    float rho = shell * max(0.12, knots);
    if (seed > 0.5) {
      vec3 ax = normalize(vec3(fract(seed * 13.7) - 0.5, fract(seed * 29.3) - 0.5, fract(seed * 53.1) - 0.5) + 1e-3);
      float c = abs(dot(relCat, ax)) / max(length(relCat), 1e-5);
      // Density pinched at the waist: lobes emerge along the axis.
      rho *= 0.22 + 0.78 * c * c;
    }
    return rho;
  }
  // H II: the natal cloud lit from inside — the SAME field dust draws,
  // carved by the ionization falloff from the newborn star.
  float cloud = max(0.0, dustField(qCat, freq) - (0.5 - 0.55 * meanD));
  float ion = 1.0 / (1.0 + 7.0 * r * r);
  return cloud * ion * 2.2 * (1.0 - 0.6 * r * r);
}
`;
