/**
 * Shared nebula / dust envelope law. Clock or ISM → kind, then a
 * sphere on the virtual source. The same function feeds the distant
 * backdrop and the local sample, so the object you see far away is
 * the one you fly into.
 *
 * v1 is a camera-facing disc (the cheap sphere silhouette). World
 * size is kpc. A later volume or mesh upgrades this evaluator —
 * not the catalog.
 */
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
const BROWN: [number, number, number] = [0.48, 0.32, 0.18];

/**
 * Sphere on a virtual source. Stars return a tight photosphere;
 * nebulae and dust return a modest ball the shaders draw at 50%
 * alpha. Colour is the kind; radius hashes a little so neighbours
 * are not clones.
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
  if (kind === KIND_DUST) {
    return {
      kind,
      radiusKpc: 0.055 + 0.04 * h0,
      flatten: 0,
      axes: [1, 1],
      clump: 1,
      seed: h0,
      rgb: BROWN,
    };
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

/**
 * Fragment laws. Nebulae stay the cheap sphere (filled disc, soft
 * limb). Dust is a short raymarch through ONE absolute sub-grid ISM
 * field — domain-warped fBm flattened toward the disk plane, so
 * filaments lie in the plane and neighbouring clumps are windows
 * onto the same cloudscape (complexes join up instead of reading as
 * private bubbles). Density integrates to Beer-Lambert opacity:
 * wisps barely tint, cores obscure. Star-forming clumps get a warm
 * lit rim where density falls toward the (hashed) local OB light —
 * the Pillars look, from the nursery law, not a painted glow.
 */
export const SHAPE_GLSL = /* glsl */ `
float skyMask(float kind, vec2 uv, float seed) {
  float r = length(uv);
  return smoothstep(1.0, 0.72, r + 0.0 * (kind + seed));
}

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
`;
