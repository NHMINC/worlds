import { db } from './db';
import { UNIVERSE } from '../world/physics';
import { objectAt } from '../world/galaxy';
import type {
  LastPlace,
  SessionCourse,
  SessionDrone,
  SessionOrbit,
  SessionRide,
  SessionSnap,
  SessionVec,
} from '../world/types';

export const SESSION_ID = 'live';
export const SESSION_VERSION = 1 as const;

const ORBITS = new Set<SessionOrbit>([
  'leo',
  'station',
  'meo',
  'geo',
  'polar',
  'hover',
  'ecliptic',
]);

export function sessionBytes(snap: SessionSnap): number {
  return new TextEncoder().encode(JSON.stringify(snap)).length;
}

export async function getSession(): Promise<SessionSnap | null> {
  const row = await db.session.get(SESSION_ID);
  const snap = row?.snap ?? null;
  return snap && isSessionSnap(snap) ? snap : null;
}

export async function putSession(snap: SessionSnap): Promise<void> {
  await db.session.put({ id: SESSION_ID, snap, updatedAt: Date.now() });
}

/** Camp row derived from the live pose — visits still key on the star. */
export function sessionToPlace(s: SessionSnap): LastPlace | null {
  if (s.starId == null) return null;
  return {
    galaxySeed: s.galaxySeed,
    starId: s.starId,
    bodyId: s.bodyId,
    orbit: s.orbit ?? s.riding?.kind ?? s.landKind,
    landed: s.landed,
    dir: s.landed ? s.surfDir : (s.riding?.local ?? null),
    h: null,
  };
}

export function sessionAlive(s: SessionSnap, seed = UNIVERSE.CANONICAL_SEED): boolean {
  if (!isSessionSnap(s)) return false;
  if (s.starId == null) return true;
  return objectAt(s.galaxySeed || seed, s.starId) != null;
}

function isVec(v: unknown): v is SessionVec {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === 'number' &&
    Number.isFinite(v[0]) &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[1]) &&
    typeof v[2] === 'number' &&
    Number.isFinite(v[2])
  );
}

function isOrbit(v: unknown): v is SessionOrbit {
  return typeof v === 'string' && ORBITS.has(v as SessionOrbit);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRide(v: unknown): v is SessionRide {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return false;
  const r = v as SessionRide;
  if (r.bodyId != null && (typeof r.bodyId !== 'string' || r.bodyId.length > 16)) return false;
  return (
    isOrbit(r.kind) &&
    typeof r.hang === 'boolean' &&
    isFiniteNum(r.r) &&
    isFiniteNum(r.theta0) &&
    isFiniteNum(r.omega) &&
    isVec(r.e1) &&
    isVec(r.e2) &&
    isVec(r.local)
  );
}

function isCourse(v: unknown): v is SessionCourse {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return false;
  const c = v as SessionCourse;
  if (typeof c.starId !== 'number' || !Number.isInteger(c.starId) || c.starId < 0) return false;
  if (c.bodyId != null && (typeof c.bodyId !== 'string' || c.bodyId.length > 16)) return false;
  return isOrbit(c.orbit);
}

function isDrone(v: unknown): v is SessionDrone {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return false;
  const d = v as SessionDrone;
  if (d.lockId != null && (typeof d.lockId !== 'string' || d.lockId.length > 16)) return false;
  if (d.phase != null && d.phase !== 'launch' && d.phase !== 'home') return false;
  if (d.launchLeg !== 'lift' && d.launchLeg !== 'pull') return false;
  return (
    isVec(d.eye) &&
    isVec(d.fwd) &&
    isVec(d.up) &&
    typeof d.lock === 'boolean' &&
    isVec(d.rel) &&
    isVec(d.liftEye) &&
    isVec(d.parkedEye) &&
    isVec(d.parkedFwd) &&
    isVec(d.parkedUp) &&
    isFiniteNum(d.rideT)
  );
}

export function isSessionSnap(v: unknown): v is SessionSnap {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return false;
  const s = v as SessionSnap;
  if (s.v !== SESSION_VERSION) return false;
  if (typeof s.galaxySeed !== 'string' || s.galaxySeed.length > 200) return false;
  if (!isVec(s.at) || !isVec(s.fwd) || !isVec(s.up)) return false;
  if (typeof s.thrustOn !== 'boolean' || typeof s.astern !== 'boolean') return false;
  if (s.coast != null && !isVec(s.coast)) return false;
  if (s.departing != null) {
    if (!isFiniteNum(s.departing.v) || !isFiniteNum(s.departing.vEsc) || !isVec(s.departing.dir)) {
      return false;
    }
  }
  if (s.starId != null && (typeof s.starId !== 'number' || !Number.isInteger(s.starId) || s.starId < 0)) {
    return false;
  }
  if (s.bodyId != null && (typeof s.bodyId !== 'string' || s.bodyId.length > 16)) return false;
  if (s.worldId != null && (typeof s.worldId !== 'string' || s.worldId.length > 16)) return false;
  if (s.orbit != null && !isOrbit(s.orbit)) return false;
  if (typeof s.landed !== 'boolean') return false;
  if (s.riding != null && !isRide(s.riding)) return false;
  if (s.capturing != null) {
    if (s.capturing.bodyId != null && (typeof s.capturing.bodyId !== 'string' || s.capturing.bodyId.length > 16)) {
      return false;
    }
    if (!isOrbit(s.capturing.kind) || !isVec(s.capturing.dir)) return false;
  }
  if (s.pendingOrbit != null) {
    if (s.pendingOrbit.bodyId != null && (typeof s.pendingOrbit.bodyId !== 'string' || s.pendingOrbit.bodyId.length > 16)) {
      return false;
    }
    if (!isOrbit(s.pendingOrbit.kind)) return false;
  }
  if (typeof s.pendingArriveOrbit !== 'boolean' || !isFiniteNum(s.insertBlend)) return false;
  if (s.surfDir != null && !isVec(s.surfDir)) return false;
  if (!isFiniteNum(s.sYaw) || !isFiniteNum(s.sPitch) || !isFiniteNum(s.sEyeH)) return false;
  if (s.landKind != null && !isOrbit(s.landKind)) return false;
  if (s.course != null && !isCourse(s.course)) return false;
  if (typeof s.courseLive !== 'boolean' || typeof s.proximity !== 'boolean') return false;
  if (s.drone != null && !isDrone(s.drone)) return false;
  return true;
}
