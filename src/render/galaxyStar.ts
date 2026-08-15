/**
 * Two layers, two laws. Inside the magnifier a star is a photosphere:
 * size is r / d so it grows as the bubble slides onto it, brightness
 * is L / d², colour is teff. Outside the bubble the luminous tail
 * stays one CSS pixel — a magnitude-limited field, not a second
 * set of growing bodies. objectAt is still O(1) on tap.
 */
import * as THREE from 'three';
import type { GalaxyObject } from '../world/galaxy';

/**
 * Toy core radius (kpc). Real R☉ is metres against kiloparsecs —
 * unusable. Apparent size is r / distance, same as a real body.
 * Used for aiming / picking, not for painting a disc on the sky.
 */
export const GLOW_K = 0.0024;
export const GLOW_P = 0.16;
/** Dim / remnant floor — a black hole still has a body you can aim at. */
export const GLOW_DIM = 0.0016;
/** Hardware sprite cap (px). Not a limit on how many stars may shine. */
export const POINT_MAX_PX = 56;
/**
 * Magnifier photosphere (kpc). Bigger than the picking pin so a
 * star grows while there is still 40 kpc of approach left. The
 * backdrop does not use this — it stays a pixel.
 */
export const PHOTO_K = 0.052;
export const PHOTO_P = 0.18;
export const PHOTO_MIN = 0.022;
export const PHOTO_MAX = 0.16;
/**
 * Photograph: I = GAIN · L^P · (DREF / d)^DIST_P.
 * Steep in L so the luminous tail is not one white.
 * Display brightness is I/(1+I) — hue survives.
 */
export const SHINE_L_GAIN = 0.08;
export const SHINE_L_P = 0.62;
export const SHINE_DIST_REF = 40;
export const SHINE_DIST_P = 0.45;
/** Photograph saturation: how far teff RGB is pushed off white. */
export const SHINE_SAT = 1.55;
/** Inverse-square floor so a star on top of the camera does not blow the shader. */
export const POINT_FLUX_EPS = 0.0006;
/** Near-field brightness punch: flux = L / (d² + ε). */
export const POINT_NEAR_BOOST = 0.55;
/** Reticle locks a star once it subtends this — grown, not a 1px speck. */
export const AIM_MIN_ANG = 0.0022;

export function glowRadiusKpc(L: number, dim = false): number {
  const r = GLOW_K * Math.pow(Math.max(L, 1e-4), GLOW_P);
  return Math.max(dim ? GLOW_DIM : 0.0007, Math.min(0.012, r));
}

/** Paint radius inside the magnifier. Grows with L; picking stays on glowRadiusKpc. */
export function photoRadiusKpc(L: number, dim = false): number {
  const r = PHOTO_K * Math.pow(Math.max(L, 1e-4), PHOTO_P);
  return Math.max(dim ? GLOW_DIM : PHOTO_MIN, Math.min(PHOTO_MAX, r));
}

export function apparentAngle(rWorld: number, dist: number): number {
  return rWorld / Math.max(1e-5, dist);
}

export function pointApparentPx(L: number, dist: number, pxPerRad: number, dim = false): number {
  const ang = apparentAngle(glowRadiusKpc(L, dim), dist);
  return Math.min(POINT_MAX_PX, Math.max(1, 2 * ang * pxPerRad));
}

/** Magnifier paint size (px) at a view-space distance. */
export function photoApparentPx(L: number, dist: number, pxPerRad: number, dim = false): number {
  const ang = apparentAngle(photoRadiusKpc(L, dim), dist);
  return Math.min(POINT_MAX_PX, Math.max(1, 2 * ang * pxPerRad));
}

/** Linear intensity from L and view distance. Same formula the star vertex uses. */
export function shineFromLumDist(L: number, d: number): number {
  return (
    SHINE_L_GAIN *
    Math.pow(Math.max(L, 1e-4), SHINE_L_P) *
    Math.pow(SHINE_DIST_REF / Math.max(d, 1), SHINE_DIST_P)
  );
}

/** What the fragment actually paints: I / (1 + I). */
export function shineDisplay(L: number, d: number): number {
  const I = shineFromLumDist(L, d);
  return I / (1 + I);
}

const KIND = {
  photo: 0,
  giant: 1,
  wd: 2,
  ns: 3,
  pulsar: 4,
  bh: 5,
  nebula: 6,
  wr: 7,
} as const;

/**
 * Apparent disc in the map (kpc). Real R☉ is metres against
 * kiloparsecs — unusable. Scale from present-day L, R, and phase
 * so a giant is a giant and a white dwarf is a pin.
 */
export function visualRadiusKpc(o: GalaxyObject): number {
  const s = o.star;
  const L = Math.max(s.luminosity, 1e-4);
  const R = Math.max(s.radius, 0.01);
  if (s.nebula === 'planetary' || s.nebula === 'snr' || s.nebula === 'hii') {
    return THREE.MathUtils.clamp(0.22 * Math.pow(L, 0.16), 0.16, 0.42);
  }
  switch (s.phase) {
    case 'black_hole':
      return 0.09;
    case 'neutron_star':
      return 0.04;
    case 'pulsar':
      return 0.055;
    case 'white_dwarf':
      return THREE.MathUtils.clamp(0.032 * Math.pow(R, 0.2), 0.028, 0.05);
    case 'wolf_rayet':
      return THREE.MathUtils.clamp(0.08 * Math.pow(L, 0.1), 0.06, 0.16);
    default:
      break;
  }
  const giant = s.phase === 'giant' || s.phase === 'supergiant' || s.phase === 'carbon_star';
  const fromL = 0.048 * Math.pow(L, 0.18);
  const fromR = 0.03 * Math.pow(R, 0.28);
  const r = Math.max(fromL, fromR);
  return THREE.MathUtils.clamp(r * (giant ? 1.8 : 1), giant ? 0.08 : 0.055, giant ? 0.32 : 0.16);
}

export function starKind(o: GalaxyObject): number {
  const s = o.star;
  if (s.nebula !== 'none') return KIND.nebula;
  if (s.phase === 'black_hole') return KIND.bh;
  if (s.phase === 'pulsar') return KIND.pulsar;
  if (s.phase === 'neutron_star') return KIND.ns;
  if (s.phase === 'white_dwarf') return KIND.wd;
  if (s.phase === 'wolf_rayet') return KIND.wr;
  if (s.phase === 'giant' || s.phase === 'supergiant' || s.phase === 'carbon_star') return KIND.giant;
  return KIND.photo;
}
