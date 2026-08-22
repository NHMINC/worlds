import { db } from './db';
import { UNIVERSE } from '../world/physics';
import type { LastPlace, SavedCamera, SystemMeta } from '../world/types';

export const CAMP_ID = 'camp';

const ORBITS = new Set<LastPlace['orbit']>([
  'leo',
  'station',
  'meo',
  'geo',
  'polar',
  'hover',
  'ecliptic',
]);

export function placeKey(p: LastPlace): string {
  return `${p.starId}|${p.bodyId ?? ''}|${p.orbit ?? ''}|${p.landed ? 1 : 0}`;
}

export async function getPlace(): Promise<LastPlace | null> {
  const row = await db.place.get(CAMP_ID);
  return row?.place ?? null;
}

export async function putPlace(place: LastPlace): Promise<void> {
  await db.place.put({ id: CAMP_ID, place, updatedAt: Date.now() });
}

/** Older visit rows: a star, and a body if the isolated cam named one. */
export function placeFromVisit(s: SystemMeta): LastPlace | null {
  if (s.starId == null) return null;
  const cam = s.cam;
  const base: LastPlace = {
    galaxySeed: s.galaxySeed ?? UNIVERSE.CANONICAL_SEED,
    starId: s.starId,
    bodyId: null,
    orbit: null,
    landed: false,
    dir: null,
    h: null,
  };
  if (!cam) return base;
  return placeFromCamera(base, cam);
}

function placeFromCamera(base: LastPlace, cam: SavedCamera): LastPlace {
  if (cam.mode === 'surface') {
    return { ...base, bodyId: cam.bodyId, landed: true, dir: cam.dir, orbit: null };
  }
  if (cam.mode === 'orbit') {
    return {
      ...base,
      bodyId: cam.bodyId,
      orbit: cam.style === 'geo' ? 'geo' : 'station',
      landed: false,
    };
  }
  return base;
}

export function isLastPlace(v: unknown): v is LastPlace {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return false;
  const p = v as LastPlace;
  if (typeof p.galaxySeed !== 'string' || p.galaxySeed.length > 200) return false;
  if (typeof p.starId !== 'number' || !Number.isInteger(p.starId) || p.starId < 0) return false;
  if (p.bodyId != null && (typeof p.bodyId !== 'string' || p.bodyId.length > 16)) return false;
  if (p.orbit != null && !ORBITS.has(p.orbit)) return false;
  if (typeof p.landed !== 'boolean') return false;
  if (p.dir != null) {
    if (!Array.isArray(p.dir) || p.dir.length !== 3) return false;
    if (p.dir.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false;
  }
  if (p.h != null && (typeof p.h !== 'number' || !Number.isFinite(p.h))) return false;
  return true;
}
