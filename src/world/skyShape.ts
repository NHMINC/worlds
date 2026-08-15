/**
 * Shared nebula / dust shape law. Clock or ISM → kind, then the
 * address hashes instance traits. The same function feeds the distant
 * backdrop and the local sample, so the object you see far away is
 * the one you fly into.
 *
 * v1 is a camera-facing billboard whose fragment is a cheap SDF
 * (filled clump / ring / bipolar / slab). World size is kpc. A later
 * volume or mesh upgrades this evaluator — not the catalog.
 */
import { UNIVERSE } from './physics';
import type { NebulaKind } from './stellar';

export const KIND_STAR = 0;
export const KIND_HII = 1;
export const KIND_PN = 2;
export const KIND_SNR = 3;
export const KIND_DUST = 4;

export type SkyKind = 0 | 1 | 2 | 3 | 4;

export interface SkyShape {
  kind: SkyKind;
  /** Billboard half-extent in catalog kpc. */
  radiusKpc: number;
  /** 0 = round, 1 = flattened to the disk. */
  flatten: number;
  /** In-plane stretch (x, y in the sprite). */
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

/**
 * Characteristics of the envelope around a virtual source.
 * Stars return a tight photosphere disc; nebulae and dust return
 * typed extents the shaders march as an SDF.
 */
export function shapeAt(kind: SkyKind, id: number): SkyShape {
  const h0 = shapeHash(id, 1);
  const h1 = shapeHash(id, 2);
  const h2 = shapeHash(id, 3);
  const h3 = shapeHash(id, 4);
  if (kind === KIND_HII) {
    return {
      kind,
      radiusKpc: 0.1 + 0.14 * h0,
      flatten: 0.55 + 0.25 * h1,
      axes: [0.75 + 0.5 * h2, 0.55 + 0.35 * h3],
      clump: 3 + Math.floor(h1 * 4),
      seed: h0,
      rgb: [1.0, 0.32 + 0.12 * h2, 0.42 + 0.1 * h3],
    };
  }
  if (kind === KIND_PN) {
    const bipolar = h0 > 0.5;
    return {
      kind,
      radiusKpc: 0.045 + 0.055 * h1,
      flatten: bipolar ? 0.35 : 0.12,
      axes: bipolar ? [0.55 + 0.25 * h2, 1.05 + 0.25 * h3] : [1, 1],
      clump: bipolar ? 2 : 1,
      seed: h0,
      rgb: [0.4 + 0.15 * h2, 0.95, 0.7 + 0.15 * h3],
    };
  }
  if (kind === KIND_SNR) {
    return {
      kind,
      radiusKpc: 0.07 + 0.1 * h0,
      flatten: 0.2 + 0.15 * h1,
      axes: [0.85 + 0.3 * h2, 0.85 + 0.3 * h3],
      clump: 2 + Math.floor(h1 * 3),
      seed: h0,
      rgb: [1.0, 0.62 + 0.2 * h2, 0.38 + 0.12 * h3],
    };
  }
  if (kind === KIND_DUST) {
    const dust = UNIVERSE.GALAXY_DUST_RGB;
    const inv = 1 / Math.max(dust[0], dust[1], dust[2]);
    return {
      kind,
      radiusKpc: 0.16 + 0.22 * h0,
      flatten: 0.72 + 0.2 * h1,
      axes: [1.1 + 0.6 * h2, 0.35 + 0.25 * h3],
      clump: 2,
      seed: h0,
      rgb: [0.42 * dust[2] * inv, 0.32 * dust[1] * inv, 0.22 * dust[0] * inv],
    };
  }
  return {
    kind: KIND_STAR,
    radiusKpc: 0.008,
    flatten: 0,
    axes: [1, 1],
    clump: 1,
    seed: h0,
    rgb: [1, 1, 1],
  };
}

/**
 * Fragment SDF for a kinded billboard. `uv` is gl_PointCoord in −1..1.
 * Returns 0..1 coverage. Stars are a soft disc; the rest are typed.
 */
export const SHAPE_GLSL = /* glsl */ `
float skyHash(float n) {
  return fract(sin(n) * 43758.5453123);
}
float skyMask(float kind, vec2 uv, float seed) {
  float r = length(uv);
  if (kind < 0.5) {
    return smoothstep(1.0, 0.32, r);
  }
  if (kind < 1.5) {
    float n = skyHash(dot(uv, vec2(3.1, 5.7)) + seed * 17.0);
    float rad = 0.62 + 0.38 * n;
    float clump = smoothstep(rad, rad * 0.28, r);
    float flatten = 1.0 - 0.5 * uv.y * uv.y;
    return clump * flatten;
  }
  if (kind < 2.5) {
    float bipolar = step(0.5, seed);
    if (bipolar > 0.5) {
      float waist = exp(-uv.x * uv.x * 7.5) * smoothstep(1.05, 0.12, abs(uv.y));
      return waist * (1.0 - smoothstep(0.18, 0.0, r));
    }
    return smoothstep(0.16, 0.0, abs(r - 0.64));
  }
  if (kind < 3.5) {
    float shell = smoothstep(0.13, 0.0, abs(r - 0.72));
    float fil = smoothstep(0.35, 0.88, skyHash(dot(uv, vec2(8.2, 3.4)) + seed * 9.0));
    fil *= smoothstep(1.0, 0.45, r);
    return max(shell, fil * 0.55);
  }
  float slab = smoothstep(1.0, 0.18, abs(uv.y) * 2.35) * smoothstep(1.05, 0.3, abs(uv.x));
  float wrinkle = 0.65 + 0.35 * skyHash(dot(uv, vec2(5.1, 7.3)) + seed * 11.0);
  return slab * wrinkle;
}
`;
