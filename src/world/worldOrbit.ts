/**
 * Host-pass orbits. The chart names a plane, not an altitude.
 * Polar / equatorial / ecliptic share one inertial film: the
 * limb sits on the midline and the horizon runs from a level
 * line (huge body) to a curve that almost touches the lower
 * corners (smaller worlds). Hover faces the ball at a fixed
 * area fill. Distance is an output of that picture plus a
 * skin floor — not a menu of LEO / MEO / GEO.
 */
import { UNIVERSE, airExtinction } from './physics';
import type { BodySpec } from './systemgen';

export type WorldOrbitKind = 'equatorial' | 'polar' | 'hover' | 'ecliptic';

/** Names that still arrive from old camps / sessions. */
export type LegacyOrbitKind = 'leo' | 'station' | 'meo' | 'geo';

export interface WorldOrbitOption {
  kind: Exclude<WorldOrbitKind, 'ecliptic'>;
  label: string;
  hint: string;
}

/** Old altitude picks collapse onto the new roster. */
export function coerceOrbitKind(kind: string): WorldOrbitKind {
  if (kind === 'polar') return 'polar';
  if (kind === 'hover' || kind === 'geo') return 'hover';
  if (kind === 'ecliptic') return 'ecliptic';
  return 'equatorial';
}

/** Hang over one face (spinning frame). */
export function isHangOrbit(kind: string): boolean {
  return coerceOrbitKind(kind) === 'hover';
}

/** Inertial rings: helm pitched to the limb, locked to the body. */
export function isLimbOrbit(kind: string): boolean {
  const k = coerceOrbitKind(kind);
  return k === 'equatorial' || k === 'polar' || k === 'ecliptic';
}

/**
 * Pitch from prograde toward the body so the forward limb
 * fills `fill` of the bottom of a `fovDeg` frame. Horizon is
 * acos(R/d) below prograde; the look sits `fov*(½−fill)`
 * above that limb. At fill = ½ the look is the upper tangent.
 */
export function orbitLimbPitch(R: number, d: number, fovDeg: number, fill: number): number {
  const ratio = Math.min(0.999999, Math.max(0, R / Math.max(d, 1e-18)));
  const horizon = Math.acos(ratio);
  const fov = (fovDeg * Math.PI) / 180;
  const limbFromLook = fov * (0.5 - fill);
  return Math.min(Math.PI * 0.49, Math.max(0, horizon - limbFromLook));
}

/**
 * Angular radius whose silhouette, with the top limb on the
 * look centre, passes through the inset lower corners of the
 * decreed film. tan(α) = inset·tan(v/2)·(aspect²+1)/2.
 */
export function orbitLimbCornerAlpha(): number {
  const half = ((UNIVERSE.CAM_FOV * Math.PI) / 180) * 0.5;
  const T = Math.tan(half);
  const k = UNIVERSE.ORBIT_LIMB_CORNER;
  const A = k * UNIVERSE.CAM_ASPECT * T;
  const B = k * T;
  return Math.atan((A * A + B * B) / (2 * B));
}

export function orbitLabel(kind: string): string {
  switch (coerceOrbitKind(kind)) {
    case 'equatorial':
      return 'Equatorial';
    case 'polar':
      return 'Polar';
    case 'hover':
      return 'Hover';
    case 'ecliptic':
      return 'Ecliptic';
  }
}

/** Chart modal roster. A star has no pick — Lock-on is ecliptic. */
export function orbitOptions(_body: BodySpec): WorldOrbitOption[] {
  return [
    {
      kind: 'equatorial',
      label: 'Equatorial',
      hint: 'Inertial, in the spin equator — body below.',
    },
    {
      kind: 'polar',
      label: 'Polar',
      hint: 'Inertial, over the poles — body below.',
    },
    {
      kind: 'hover',
      label: 'Hover',
      hint: 'Hang over the arrival face. The disk fills the frame.',
    },
  ];
}

function gasFloor(body: BodySpec): number {
  return body.kind === 'gas' ? UNIVERSE.WORLD_ORBIT_GAS_FLOOR : 0;
}

/**
 * Closest legal camera (km from centre). Air / gas / a thin
 * skin — not the 10 000 km graze used on transfers.
 */
export function viewSkinKm(R: number, body?: BodySpec): number {
  const r = Math.max(R, 1);
  let extra = r * 0.002;
  if (body) {
    extra = Math.max(extra, gasFloor(body) * r);
    const ext = airExtinction(body.physics);
    if (ext) extra = Math.max(extra, 2.2 * ext.scaleH);
  }
  return r + extra;
}

/**
 * Inertial park (km from centre). The film wants the corner
 * curve; a huge body hits ORBIT_VIEW_H_KM first and the
 * horizon flattens; a pebble hits the skin and stays small.
 */
export function limbViewRadiusKm(R: number, body?: BodySpec): number {
  const r = Math.max(R, 1);
  const a = orbitLimbCornerAlpha();
  const want = r / Math.max(1e-8, Math.sin(a));
  const lo = viewSkinKm(r, body);
  const hi = r + UNIVERSE.ORBIT_VIEW_H_KM;
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, want));
}

/**
 * Hover park: face-on disk covers ORBIT_HOVER_AREA of the
 * decreed film. Same picture on every body.
 */
export function hoverViewRadiusKm(R: number, body?: BodySpec): number {
  const r = Math.max(R, 1);
  const half = ((UNIVERSE.CAM_FOV * Math.PI) / 180) * 0.5;
  const T = Math.tan(half);
  const k = Math.sqrt((4 * UNIVERSE.CAM_ASPECT * UNIVERSE.ORBIT_HOVER_AREA) / Math.PI);
  const tanA = T * k;
  const a = Math.atan(tanA);
  const want = r / Math.max(1e-8, Math.sin(a));
  return Math.max(viewSkinKm(r, body), want);
}

/** Body radius + absolute transfer / graze floor (km from centre). */
export function clearRadiusKm(body: { radius: number }): number {
  return Math.max(body.radius, 1) + UNIVERSE.WORLD_ORBIT_CLEAR_KM;
}

/**
 * Free-fly / drone park film: half-angle at which a disk covers
 * ARRIVE_FILL of the shorter field — min of vertical and
 * horizontal FOV, so portrait uses the width and the ball never
 * eats the screen. Named rings use the limb / hover films; this
 * is the third picture, for a stop with no ring named.
 */
export function fillHalfAngle(fovDeg: number, aspect: number): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const a = Math.max(1e-6, aspect);
  const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * a);
  return 0.5 * UNIVERSE.ARRIVE_FILL * Math.min(vFov, hFov);
}

/** Distance (same unit as R) at which a ball of radius R fills that film. */
export function fillViewRadius(R: number, fovDeg: number, aspect: number): number {
  return R / Math.max(1e-8, Math.tan(fillHalfAngle(fovDeg, aspect)));
}

/**
 * Hard camera wall (km from centre). The film park sits
 * outside this skin — the 10 000 km graze is a transfer
 * floor, not a park. SOI_TRACK_MIN is a drone cage, not
 * this wall (it sat outside the star film).
 */
export function shellFloorKm(body: { radius: number } & Partial<BodySpec>): number {
  return viewSkinKm(Math.max(body.radius, 1), 'physics' in body ? (body as BodySpec) : undefined);
}

export function orbitRadiusKm(body: BodySpec, kind: string): number {
  const k = coerceOrbitKind(kind);
  const R = Math.max(body.radius, 1);
  if (k === 'hover') return hoverViewRadiusKm(R, body);
  return limbViewRadiusKm(R, body);
}

export function orbitRadiusKpc(body: BodySpec, kind: string): number {
  return orbitRadiusKm(body, kind) / UNIVERSE.KPC_KM;
}

/** Mean-motion ω (rad / universe-second) at that ring. */
export function orbitOmega(body: BodySpec, kind: string): number {
  const aM = orbitRadiusKm(body, kind) * 1000;
  const Rm = Math.max(body.radius, 1) * 1000;
  const M = body.physics.densityRel * UNIVERSE.RHO_EARTH * (4 / 3) * Math.PI * Rm * Rm * Rm;
  const mu = UNIVERSE.G_SI * Math.max(M, 1);
  return Math.sqrt(mu / (aM * aM * aM));
}

/**
 * Unbound speed at radius r: √2 × circular (ω r), catalog kpc / s.
 * Leave-orbit floors this by ARRIVE_K × the place fence.
 */
export function escapeSpeedKpcS(omega: number, rKpc: number): number {
  return Math.SQRT2 * Math.abs(omega) * Math.max(rKpc, 0);
}

/**
 * Host-star ecliptic: the corner film, floored outside the
 * corona. The world flat-horizon cap (ORBIT_VIEW_H_KM over the
 * skin) must not apply — 10,000 km over a photosphere parked
 * the ship inside the fire (a giant's cap even fell below the
 * skin floor and returned a graze). A star's view skin is its
 * drawn corona (STAR_CORONA_R photosphere radii); the ring sits
 * just outside it. Kepler ω from GM☉ · mass at that radius.
 */
export function starOrbitRadiusKpc(star: { radius: number }): number {
  const R = Math.max(star.radius, 1);
  const want = R / Math.max(1e-8, Math.sin(orbitLimbCornerAlpha()));
  return Math.max(R * UNIVERSE.STAR_CORONA_R * 1.05, want) / UNIVERSE.KPC_KM;
}

export function starOrbitOmega(star: { mass: number }, aKpc: number): number {
  const aM = Math.max(aKpc, 1e-18) * UNIVERSE.KPC_KM * 1000;
  const mu = UNIVERSE.GM_SUN * Math.max(star.mass, 0.08);
  return Math.sqrt(mu / (aM * aM * aM));
}
