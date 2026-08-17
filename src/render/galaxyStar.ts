/**
 * The explorer sky is the luminous harvest. A star is a point:
 * one CSS-pixel core wearing Teff colour, plus the eye's PSF.
 * Magnitude lifts the wings of that PSF (a Gaussian core and a
 * Lorentzian tail, the same glare shape as the in-system sun).
 * The sprite is only room for those wings — it is not a disc.
 * Dust is never drawn. r/d grow is a later close-survey law.
 */
import * as THREE from 'three';
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
/**
 * Photograph zero-point (L☉). Stays at the original late-B floor
 * so deepening SILHOUETTE_L adds fainter pins instead of
 * re-exposing every star already in the sky.
 */
export const HARVEST_L_REF = 300;
/**
 * Eye PSF in CSS pixels — not sprite UVs. A Gaussian core
 * (exp(−r² · CORE)) plus a Lorentzian tail TAIL/(A + B r²).
 * Same shape as the in-system glare. Magnitude scales I; it
 * does not stretch a filled circle.
 */
export const HARVEST_PSF_CORE = 18;
export const HARVEST_PSF_TAIL = 0.22;
export const HARVEST_PSF_A = 0.07;
export const HARVEST_PSF_B = 3.2;
export const HARVEST_PSF_THRESH = 0.018;
/**
 * Fly-distance shine: I = GAIN · (L/LREF)^P · (DREF / d)^DIST_P.
 * Steep in L so an O outshines the harvest floor. Shallow in d
 * so approaching does not inflate a disc.
 */
export const HARVEST_SHINE_GAIN = 0.28;
export const HARVEST_SHINE_L_P = 0.55;
export const HARVEST_SHINE_DIST_REF = 8;
export const HARVEST_SHINE_DIST_P = 0.22;
/**
 * Super-sun tail only. Extra I is identically zero at and below
 * SUPER_L, so the rest of the harvest photograph is unchanged.
 * Leftover luminosity (L / SUPER_L − 1) rides the same distance
 * law and the same PSF — more wing, not a new disc or a new if.
 */
export const HARVEST_SUPER_L = 50_000;
export const HARVEST_SUPER_GAIN = 4;
export const HARVEST_SUPER_P = 1;
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
  const core = Math.exp(-rCss * rCss * HARVEST_PSF_CORE);
  const tail = HARVEST_PSF_TAIL / (HARVEST_PSF_A + HARVEST_PSF_B * rCss * rCss);
  return Math.max(0, I) * (0.95 * core + tail);
}

/** CSS-px radius where the Lorentzian wing drops through the visibility floor. */
export function harvestPsfRadiusCss(I: number): number {
  const num = (HARVEST_PSF_TAIL * Math.max(I, 0)) / HARVEST_PSF_THRESH - HARVEST_PSF_A;
  return Math.sqrt(Math.max(0, num / HARVEST_PSF_B));
}

/** Sprite size (device px): room for visible wings. Not a filled disc. */
export function harvestGlowPx(L: number, pixelRatio = 1): number {
  const I = harvestShine(L, HARVEST_SHINE_DIST_REF);
  const css = Math.max(1, 1 + 2 * harvestPsfRadiusCss(I));
  return Math.max(harvestStarPx(pixelRatio), css * pixelRatio);
}

/** Leftover luminosity above SUPER_L. Zero for every other harvest star. */
export function harvestSuperExtra(L: number): number {
  const x = Math.max(L, 1e-4) / HARVEST_SUPER_L;
  if (x <= 1) return 0;
  return HARVEST_SUPER_GAIN * (Math.pow(x, HARVEST_SUPER_P) - 1);
}

/** Fly-distance intensity. Same formula the harvest vertex uses. */
export function harvestShine(L: number, d: number): number {
  const dist = Math.pow(
    HARVEST_SHINE_DIST_REF / Math.max(d, 0.4),
    HARVEST_SHINE_DIST_P,
  );
  const base =
    HARVEST_SHINE_GAIN *
    Math.pow(Math.max(L, 1e-4) / HARVEST_L_REF, HARVEST_SHINE_L_P);
  return (base + harvestSuperExtra(L)) * dist;
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
