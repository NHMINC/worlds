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

/**
 * Old picks collapse onto the two remaining rings: equatorial
 * for a world, ecliptic for the star. Hover and polar retired —
 * the drone is the close look, and one ring per body class
 * keeps expectations exact.
 */
export function coerceOrbitKind(kind: string): WorldOrbitKind {
  return kind === 'ecliptic' ? 'ecliptic' : 'equatorial';
}

/**
 * Yaw from prograde toward the body so the near limb sits
 * `fill` across a `fovDeg` field. Horizon is acos(R/d) off
 * prograde; the look sits `fov*(½−fill)` past that limb. At
 * fill = ½ the limb is exactly on the frame's centre line —
 * fed the HORIZONTAL field, that is the side-on ride: the
 * body confined to the left half of the screen.
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
  return coerceOrbitKind(kind) === 'ecliptic' ? 'Ecliptic' : 'Equatorial';
}

/** Horizontal field (degrees) of a vertical-fov frame — the side-on ride measures against this. */
export function sideFovDeg(fovDeg: number, aspect: number): number {
  const v = (fovDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(v * 0.5) * Math.max(1e-6, aspect)) * 180) / Math.PI;
}

function gasFloor(body: BodySpec): number {
  return body.kind === 'gas' ? UNIVERSE.WORLD_ORBIT_GAS_FLOOR : 0;
}

/**
 * Closest legal camera (km from centre). The body's size is
 * surface PLUS its atmosphere: the air term is the drawn sky
 * shell's own top (AIR_SHELL_H scale heights, scaleH in planet
 * radii), so no park or fence ever sits inside the visible air.
 */
export function viewSkinKm(R: number, body?: BodySpec): number {
  const r = Math.max(R, 1);
  let extra = r * 0.002;
  if (body) {
    extra = Math.max(extra, gasFloor(body) * r);
    const ext = airExtinction(body.physics);
    if (ext) extra = Math.max(extra, UNIVERSE.AIR_SHELL_H * ext.scaleH * r);
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
export function fillHalfAngle(fovDeg: number, aspect: number, fill = UNIVERSE.ARRIVE_FILL): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const a = Math.max(1e-6, aspect);
  const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * a);
  return 0.5 * fill * Math.min(vFov, hFov);
}

/** Distance (same unit as R) at which a ball of radius R fills that film. */
export function fillViewRadius(R: number, fovDeg: number, aspect: number, fill = UNIVERSE.ARRIVE_FILL): number {
  return R / Math.max(1e-8, Math.tan(fillHalfAngle(fovDeg, aspect, fill)));
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
  void coerceOrbitKind(kind);
  return limbViewRadiusKm(Math.max(body.radius, 1), body);
}

export function orbitRadiusKpc(body: BodySpec, kind: string): number {
  return orbitRadiusKm(body, kind) / UNIVERSE.KPC_KM;
}

/** The decreed ride gear: RIDE_GEAR × Kepler, capped at
 *  RIDE_OMEGA_MAX but never below the true rate. */
function rideGear(omega: number): number {
  return Math.max(omega, Math.min(omega * UNIVERSE.RIDE_GEAR, UNIVERSE.RIDE_OMEGA_MAX));
}

/** Ride mean-motion ω (rad / universe-second) at that ring —
 *  true Kepler through the decreed RIDE_GEAR. */
export function orbitOmega(body: BodySpec, kind: string): number {
  const aM = orbitRadiusKm(body, kind) * 1000;
  const Rm = Math.max(body.radius, 1) * 1000;
  const M = body.physics.densityRel * UNIVERSE.RHO_EARTH * (4 / 3) * Math.PI * Rm * Rm * Rm;
  const mu = UNIVERSE.G_SI * Math.max(M, 1);
  return rideGear(Math.sqrt(mu / (aM * aM * aM)));
}

/**
 * Unbound speed at radius r: √2 × circular (ω r), catalog kpc / s.
 * Leave-orbit floors this by ARRIVE_K × the place fence.
 */
export function escapeSpeedKpcS(omega: number, rKpc: number): number {
  return Math.SQRT2 * Math.abs(omega) * Math.max(rKpc, 0);
}

/**
 * The star film's working radius: the photosphere, floored at
 * STAR_FILM_R_MIN for compact remnants — a 30 km black hole
 * scales the whole wall/graze/park stack below one catalog
 * float64 ULP at 8 kpc, and the ordering law drowns in noise.
 */
export function starFilmRKm(radiusKm: number): number {
  return Math.max(radiusKm, UNIVERSE.RSUN_KM * UNIVERSE.STAR_FILM_R_MIN, 1);
}

/**
 * A star's view skin is its drawn corona (STAR_CORONA_R
 * photosphere radii): films, hard walls, and transfer grazes
 * all stay outside the fire. Ordering law for a star course —
 * wall (this) < graze (×1.02) < park (×1.05) — so the router
 * can always tangent past the ball and still reach the ring.
 */
export function starSkinKm(radiusKm: number): number {
  return starFilmRKm(radiusKm) * UNIVERSE.STAR_CORONA_R;
}

/** Transfer graze around the photosphere — just off the wall. */
export function starGrazeKm(radiusKm: number): number {
  return starSkinKm(radiusKm) * 1.02;
}

/**
 * Host-star ecliptic: the corner film, floored outside the
 * corona. The world flat-horizon cap (ORBIT_VIEW_H_KM over the
 * skin) must not apply — 10,000 km over a photosphere parked
 * the ship inside the fire (a giant's cap even fell below the
 * skin floor and returned a graze). Kepler ω from GM☉ · mass
 * at that radius.
 */
export function starOrbitRadiusKpc(star: { radius: number }): number {
  const R = starFilmRKm(star.radius);
  const want = R / Math.max(1e-8, Math.sin(orbitLimbCornerAlpha()));
  return Math.max(starSkinKm(R) * 1.05, want) / UNIVERSE.KPC_KM;
}

export function starOrbitOmega(star: { mass: number }, aKpc: number): number {
  const aM = Math.max(aKpc, 1e-18) * UNIVERSE.KPC_KM * 1000;
  const mu = UNIVERSE.GM_SUN * Math.max(star.mass, 0.08);
  return rideGear(Math.sqrt(mu / (aM * aM * aM)));
}
