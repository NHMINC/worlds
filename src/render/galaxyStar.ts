/**
 * The explorer sky is the luminous harvest. A star is one CSS
 * pixel at every fly distance, wearing its Teff colour. A soft
 * glow around the pin is the eye's PSF on luminosity — size is
 * f(L), not 1/d. Dust is never drawn. r/d grow is a later
 * close-survey law — not this photograph.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import type { GalaxyObject } from '../world/galaxy';

/**
 * Toy close-survey paint radius (catalog kpc). Real R☉ is metres
 * against kiloparsecs — unusable. Harvest GPU size is
 * harvestStarPx — always one CSS pixel. These knobs stay for a
 * later faint-survey disc; they must not be wired to the harvest.
 */
export const GLOW_K = 0.0024;
export const GLOW_P = 0.16;
/** Dim / remnant floor for the paint pin. */
export const GLOW_DIM = 0.0016;
/** Hardware sprite cap (px). Not a limit on how many stars may shine. */
export const POINT_MAX_PX = 56;
export const PHOTO_K = GLOW_K;
export const PHOTO_P = GLOW_P;
export const PHOTO_MIN = 0.0007;
export const PHOTO_MAX = 0.012;
/**
 * Visit-lock body (catalog kpc). Independent of the 1px paint pin.
 * A luminous-harvest star locks when aimR / d ≥ AIM_MIN_ANG.
 * Dust is an ISM address, not a star.
 */
export const AIM_R_K = 0.052;
export const AIM_R_P = GLOW_P;
export const AIM_R_MIN = 0.012;
export const AIM_R_MAX = 0.22;
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
/**
 * Harvest photograph: push Teff further off grey so a 1px pin
 * still reads O-blue / M-orange. The old SHINE_SAT was a backdrop
 * number; fly pins need more chroma.
 */
export const HARVEST_SHINE_SAT = 2.55;
/** Harvest glow / shine are referenced to the luminous-tail floor. */
export const HARVEST_L_REF = UNIVERSE.GALAXY_SILHOUETTE_L;
/**
 * Magnitude bloom (CSS px beyond the pin). Size is
 * 1 + K · max(0, (L/LREF)^P − 1), capped. A harvest-floor star
 * stays a pin; an O / supergiant grows a halo. Not 1/d.
 */
export const HARVEST_GLOW_K = 4.5;
export const HARVEST_GLOW_P = 0.4;
export const HARVEST_GLOW_MAX = 18;
/**
 * Fly-distance shine: I = GAIN · (L/LREF)^P · (DREF / d)^DIST_P.
 * The old SHINE_* law saturates by ~3 kpc (I/(1+I) ≈ 1 for every
 * harvest row). This one still ranks L at fly distances.
 */
export const HARVEST_SHINE_GAIN = 0.55;
export const HARVEST_SHINE_L_P = 0.42;
export const HARVEST_SHINE_DIST_REF = 8;
export const HARVEST_SHINE_DIST_P = 0.28;
/** Inverse-square floor so a star on top of the camera does not blow the shader. */
export const POINT_FLUX_EPS = 0.0006;
/** Near-field brightness punch: flux = L / (d² + ε). Unused on harvest pins. */
export const POINT_NEAR_BOOST = 0.55;
/** Reticle locks once the visit body subtends this. Not the paint pin. */
export const AIM_MIN_ANG = 0.0022;

export function glowRadiusKpc(L: number, dim = false): number {
  const r = GLOW_K * Math.pow(Math.max(L, 1e-4), GLOW_P);
  return Math.max(dim ? GLOW_DIM : PHOTO_MIN, Math.min(PHOTO_MAX, r));
}

/** Harvest paint size (device px): one CSS pixel, at every distance. */
export function harvestStarPx(pixelRatio = 1): number {
  return Math.max(1, pixelRatio);
}

/** Magnitude bloom (device px). f(L) only — approaching does not inflate it. */
export function harvestGlowPx(L: number, pixelRatio = 1): number {
  const mag = Math.pow(Math.max(L, 1e-4) / HARVEST_L_REF, HARVEST_GLOW_P);
  const css = Math.min(HARVEST_GLOW_MAX, 1 + HARVEST_GLOW_K * Math.max(0, mag - 1));
  return Math.max(harvestStarPx(pixelRatio), css * pixelRatio);
}

/** Fly-distance intensity. Same formula the harvest vertex uses. */
export function harvestShine(L: number, d: number): number {
  return (
    HARVEST_SHINE_GAIN *
    Math.pow(Math.max(L, 1e-4) / HARVEST_L_REF, HARVEST_SHINE_L_P) *
    Math.pow(HARVEST_SHINE_DIST_REF / Math.max(d, 0.4), HARVEST_SHINE_DIST_P)
  );
}

/** Teff RGB pushed off grey. Same mix the harvest vertex uses. */
export function harvestChroma(rgb: [number, number, number]): [number, number, number] {
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const sat = HARVEST_SHINE_SAT;
  const ch = (c: number) => Math.min(1, Math.max(0, lum + sat * (c - lum)));
  return [ch(rgb[0]), ch(rgb[1]), ch(rgb[2])];
}

/** Unused close-survey radius. Harvest GPU size is harvestStarPx. */
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

/** Close-survey size (px). Harvest stars use harvestStarPx, not this. */
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
