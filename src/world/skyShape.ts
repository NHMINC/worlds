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
 * Fragment mask. Stars and envelopes are the same cheap sphere:
 * a filled disc with a soft limb. Kind only picks the colour
 * on the CPU.
 */
export const SHAPE_GLSL = /* glsl */ `
float skyMask(float kind, vec2 uv, float seed) {
  float r = length(uv);
  return smoothstep(1.0, 0.72, r + 0.0 * (kind + seed));
}
`;
