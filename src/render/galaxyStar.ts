/**
 * The explorer sky is the luminous harvest. A star is a point:
 * one CSS-pixel core wearing Teff colour, plus the eye's PSF.
 * Magnitude lifts the wings of that PSF (a Gaussian core and a
 * Lorentzian tail, the same glare shape as the in-system sun).
 * The sprite is only room for those wings — it is not a disc.
 * Dust is never drawn. r/d grow is a later close-survey law.
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
export const HARVEST_SHINE_SAT = 2.7;
/** Harvest glow / shine are referenced to the luminous-tail floor. */
export const HARVEST_L_REF = UNIVERSE.GALAXY_SILHOUETTE_L;
/**
 * Eye PSF in CSS pixels — not sprite UVs. A Gaussian core
 * plus off-axis wings. The core peak is I, not I plus a
 * Lorentzian spike: that 4× boost clipped every harvest pin
 * to the same white pixel.
 */
export const HARVEST_PSF_CORE = 18;
/** Wing amplitude · I^P, away from the core. */
export const HARVEST_PSF_WING_K = 0.28;
export const HARVEST_PSF_WING_P = 1.25;
/** Wing scale² (CSS px²). */
export const HARVEST_PSF_SIG2 = 1.6;
export const HARVEST_PSF_THRESH = 0.045;
/**
 * Apparent magnitude. Flux is L / (d² + ε); display is
 * max(MIN, FLOOR + GAIN · (flux / fluxRef)^P). MIN is 2× the
 * reference pin so the field reads; stars already above it
 * are unchanged.
 */
export const HARVEST_SHINE_GAIN = 0.065;
/** Lift on the rank curve — +50% of the reference gain. */
export const HARVEST_SHINE_FLOOR = HARVEST_SHINE_GAIN * 0.5;
/** Visible floor. 2× the reference pin; does not lift giants. */
export const HARVEST_SHINE_MIN = 2 * (HARVEST_SHINE_FLOOR + HARVEST_SHINE_GAIN);
export const HARVEST_SHINE_P = 0.55;
export const HARVEST_SHINE_DIST_REF = 8;
export const HARVEST_FLUX_EPS = 0.16;
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

/** PSF intensity at a CSS-pixel radius. Same formula the harvest fragment uses. */
export function harvestPsf(I: number, rCss: number): number {
  const i = Math.max(I, 0);
  const core = Math.exp(-rCss * rCss * HARVEST_PSF_CORE);
  const wing = (HARVEST_PSF_WING_K * Math.pow(i, HARVEST_PSF_WING_P)) / (1 + (rCss * rCss) / HARVEST_PSF_SIG2);
  return i * core + wing * (1 - core);
}

/** CSS-px radius where the wings drop through the visibility floor. */
export function harvestPsfRadiusCss(I: number): number {
  const peak = HARVEST_PSF_WING_K * Math.pow(Math.max(I, 0), HARVEST_PSF_WING_P);
  if (peak <= HARVEST_PSF_THRESH) return 0;
  return Math.sqrt(HARVEST_PSF_SIG2 * (peak / HARVEST_PSF_THRESH - 1));
}

/** Sprite size (device px): room for visible wings. No bright-end cap. */
export function harvestGlowPx(L: number, pixelRatio = 1): number {
  const I = harvestShine(L, HARVEST_SHINE_DIST_REF);
  const css = Math.max(1, 1 + 2 * harvestPsfRadiusCss(I));
  return Math.max(harvestStarPx(pixelRatio), css * pixelRatio);
}

/** Apparent-magnitude intensity. Same formula the harvest vertex uses. */
export function harvestShine(L: number, d: number): number {
  const flux = Math.max(L, 1e-4) / (d * d + HARVEST_FLUX_EPS);
  const fluxRef = HARVEST_L_REF / (HARVEST_SHINE_DIST_REF * HARVEST_SHINE_DIST_REF + HARVEST_FLUX_EPS);
  return Math.max(
    HARVEST_SHINE_MIN,
    HARVEST_SHINE_FLOOR +
      HARVEST_SHINE_GAIN * Math.pow(flux / Math.max(fluxRef, 1e-12), HARVEST_SHINE_P),
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
