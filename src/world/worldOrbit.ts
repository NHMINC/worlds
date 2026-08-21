/**
 * Host-pass orbits. The chart names a ring; the viewpoint
 * rides that ring. Heights and ω come from the body
 * (radius, density, spin, air) — not a preset per class.
 * Every named ring is floored by WORLD_ORBIT_CLEAR_KM above
 * the surface so a small moon never parks inside its ball.
 */
import { UNIVERSE, airExtinction } from './physics';
import type { BodySpec } from './systemgen';

export type WorldOrbitKind = 'leo' | 'station' | 'meo' | 'geo' | 'polar' | 'hover';

export interface WorldOrbitOption {
  kind: WorldOrbitKind;
  label: string;
  hint: string;
}

/** Hang over one face (spinning frame). The rest are inertial. */
export function isHangOrbit(kind: WorldOrbitKind): boolean {
  return kind === 'geo' || kind === 'hover';
}

export function orbitLabel(kind: WorldOrbitKind): string {
  switch (kind) {
    case 'leo':
      return 'LEO';
    case 'station':
      return 'GEO low / Station';
    case 'meo':
      return 'MEO';
    case 'geo':
      return 'GEO';
    case 'polar':
      return 'Polar';
    case 'hover':
      return 'Hover';
  }
}

/** Chart modal roster. GEO's hint changes when the world is locked. */
export function orbitOptions(body: BodySpec): WorldOrbitOption[] {
  const locked = body.tidallyLocked;
  return [
    { kind: 'leo', label: 'LEO', hint: 'Low circular — skim the air.' },
    {
      kind: 'station',
      label: 'GEO low / Station',
      hint: 'Low inertial — station-keeping; the world turns under you.',
    },
    { kind: 'meo', label: 'MEO', hint: 'Medium circular, between LEO and GEO.' },
    {
      kind: 'geo',
      label: 'GEO',
      hint: locked
        ? 'Hang over one face — same as hover; this world is tidally locked.'
        : 'Hang over one spot at the Kepler altitude for this spin.',
    },
    { kind: 'polar', label: 'Polar', hint: 'Low inertial; the plane contains the pole.' },
    { kind: 'hover', label: 'Hover', hint: 'Hang over the arrival face, low.' },
  ];
}

function gasFloor(body: BodySpec): number {
  return body.kind === 'gas' ? UNIVERSE.WORLD_ORBIT_GAS_FLOOR : 0;
}

function leoHeightRel(body: BodySpec): number {
  const ext = airExtinction(body.physics);
  const air = ext ? 2.2 * ext.scaleH : 0;
  return Math.max(UNIVERSE.WORLD_ORBIT_LEO, air, gasFloor(body));
}

function stationHeightRel(body: BodySpec): number {
  const ext = airExtinction(body.physics);
  const air = ext ? 2.8 * ext.scaleH : 0;
  return Math.max(leoHeightRel(body) * 1.15, air, gasFloor(body));
}

/**
 * Synchronous altitude for this spin. Slow rotators clamp;
 * a locked world has no useful GEO — that pick is hover.
 */
export function geoHeightRel(body: BodySpec): number {
  if (body.tidallyLocked) return hoverHeightRel(body);
  const T = body.spinPeriod;
  if (!(T > 0) || !Number.isFinite(T)) return UNIVERSE.WORLD_ORBIT_GEO_MAX;
  const Rm = Math.max(body.radius, 1) * 1000;
  const M = body.physics.densityRel * UNIVERSE.RHO_EARTH * (4 / 3) * Math.PI * Rm * Rm * Rm;
  const a = Math.cbrt((UNIVERSE.G_SI * M * T * T) / (4 * Math.PI * Math.PI));
  const hRel = a / Rm - 1;
  if (!Number.isFinite(hRel)) return UNIVERSE.WORLD_ORBIT_GEO_MAX;
  return Math.min(UNIVERSE.WORLD_ORBIT_GEO_MAX, Math.max(leoHeightRel(body), hRel));
}

function hoverHeightRel(body: BodySpec): number {
  return Math.max(UNIVERSE.WORLD_ORBIT_HOVER, gasFloor(body));
}

/** Altitude in body radii above the surface (before the clear floor). */
export function orbitHeightRel(body: BodySpec, kind: WorldOrbitKind): number {
  const leo = leoHeightRel(body);
  switch (kind) {
    case 'leo':
    case 'polar':
      return leo;
    case 'station':
      return stationHeightRel(body);
    case 'hover':
      return hoverHeightRel(body);
    case 'geo':
      return geoHeightRel(body);
    case 'meo': {
      const geo = geoHeightRel(body);
      const mix = leo + (geo - leo) * UNIVERSE.WORLD_ORBIT_MEO_FRAC;
      return Math.max(UNIVERSE.WORLD_ORBIT_MEO, mix);
    }
  }
}

/** Body radius + absolute clear floor (km from centre). */
export function clearRadiusKm(body: { radius: number }): number {
  return Math.max(body.radius, 1) + UNIVERSE.WORLD_ORBIT_CLEAR_KM;
}

/** Lowest legal camera shell about a body (km from centre). */
export function shellFloorKm(body: { radius: number }): number {
  const R = Math.max(body.radius, 1);
  return Math.max(clearRadiusKm(body), R * (1 + UNIVERSE.SOI_TRACK_MIN));
}

export function orbitRadiusKm(body: BodySpec, kind: WorldOrbitKind): number {
  const R = Math.max(body.radius, 1);
  return Math.max(clearRadiusKm(body), (1 + orbitHeightRel(body, kind)) * R);
}

export function orbitRadiusKpc(body: BodySpec, kind: WorldOrbitKind): number {
  return orbitRadiusKm(body, kind) / UNIVERSE.KPC_KM;
}

/** Mean-motion ω (rad / universe-second) at that ring. */
export function orbitOmega(body: BodySpec, kind: WorldOrbitKind): number {
  const aM = orbitRadiusKm(body, kind) * 1000;
  const Rm = Math.max(body.radius, 1) * 1000;
  const M = body.physics.densityRel * UNIVERSE.RHO_EARTH * (4 / 3) * Math.PI * Rm * Rm * Rm;
  const mu = UNIVERSE.G_SI * Math.max(M, 1);
  return Math.sqrt(mu / (aM * aM * aM));
}
