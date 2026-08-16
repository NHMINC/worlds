/**
 * Two layers, two laws. Inside the catalog bubble a star starts as
 * one CSS pixel at the rim and grows as 1/d when the camera closes.
 * Paint radius is a fraction of GALAXY_REGION_R so the rim stays a
 * pin if the ball changes. Brightness L/d², colour teff. Backdrop
 * stays 1px.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import type { GalaxyObject } from '../world/galaxy';

/**
 * Toy paint-pin radius (catalog kpc; view is 1:1). Real R☉ is
 * metres against kiloparsecs — unusable. Size is max(1px, 2 r/d).
 * GLOW_K = REGION_R / 2000 so 2 r / R × ~1000 px/rad ≈ 1 at the
 * rim — a pin on entry, a disc only when the bubble is on top.
 * This is the photograph, not the visit lock — see AIM_R_K.
 */
export const GLOW_K = UNIVERSE.GALAXY_REGION_R / 2000;
export const GLOW_P = 0.16;
/** Dim / remnant floor for the paint pin. Below GLOW_K so remnants stay pins at the rim. */
export const GLOW_DIM = GLOW_K * 0.67;
/** Hardware sprite cap (px). Not a limit on how many stars may shine. */
export const POINT_MAX_PX = 56;
/** Paint radius — same body as the glow pin. */
export const PHOTO_K = GLOW_K;
export const PHOTO_P = GLOW_P;
export const PHOTO_MIN = GLOW_K * 0.28;
export const PHOTO_MAX = UNIVERSE.GALAXY_REGION_R * 0.05;
/**
 * Visit-lock body (catalog kpc). Independent of the 1px paint pin.
 * A local catalog star locks when aimR / d ≥ AIM_MIN_ANG — close
 * enough to set course, not "grown into a disc". Silhouette
 * backdrop rows are not in the cloud and never lock. Dust is
 * an ISM address, not a star.
 */
export const AIM_R_K = UNIVERSE.GALAXY_REGION_R * 0.0015;
export const AIM_R_P = GLOW_P;
export const AIM_R_MIN = UNIVERSE.GALAXY_REGION_R * 0.0008;
export const AIM_R_MAX = UNIVERSE.GALAXY_REGION_R * 0.004;
/**
 * Photograph: I = GAIN · L^P · (DREF / d)^DIST_P.
 * Steep in L so the luminous tail is not one white.
 * Display brightness is I/(1+I) — hue survives.
 */
export const SHINE_L_GAIN = 0.14;
export const SHINE_L_P = 0.62;
export const SHINE_DIST_REF = 40;
export const SHINE_DIST_P = 0.45;
/** Photograph saturation: how far teff RGB is pushed off white. */
export const SHINE_SAT = 1.55;
/** Inverse-square floor so a star on top of the camera does not blow the shader. */
export const POINT_FLUX_EPS = 0.0006;
/** Near-field brightness punch: flux = L / (d² + ε). */
export const POINT_NEAR_BOOST = 0.55;
/** Reticle locks once the visit body subtends this. Not the paint pin. */
export const AIM_MIN_ANG = 0.0022;

export function glowRadiusKpc(L: number, dim = false): number {
  const r = GLOW_K * Math.pow(Math.max(L, 1e-4), GLOW_P);
  return Math.max(dim ? GLOW_DIM : PHOTO_MIN, Math.min(PHOTO_MAX, r));
}

/** Paint radius. Same body as glowRadiusKpc — one pin. */
export function photoRadiusKpc(L: number, dim = false): number {
  return glowRadiusKpc(L, dim);
}

/** Visit presence for the centre reticle. Larger than the paint pin. */
export function aimRadiusKpc(L: number, _dim = false): number {
  const r = AIM_R_K * Math.pow(Math.max(L, 1e-4), AIM_R_P);
  return Math.max(AIM_R_MIN, Math.min(AIM_R_MAX, r));
}

/** True when a local catalog star is close enough to lock the reticle. */
export function aimLocks(L: number, dist: number, dim = false): boolean {
  return aimRadiusKpc(L, dim) / Math.max(1e-5, dist) >= AIM_MIN_ANG;
}

export function apparentAngle(rWorld: number, dist: number): number {
  return rWorld / Math.max(1e-5, dist);
}

export function pointApparentPx(L: number, dist: number, pxPerRad: number, dim = false): number {
  const ang = apparentAngle(glowRadiusKpc(L, dim), dist);
  return Math.min(POINT_MAX_PX, Math.max(1, 2 * ang * pxPerRad));
}

/** Paint size (px) at a catalog distance. */
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
