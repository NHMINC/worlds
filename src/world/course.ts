/**
 * One berth, derived legs. The ship names a destination
 * (star + optional world ring). Legs are computed from
 * here → dest, not stored as a playlist.
 *
 *   ExitRing → LeaveSoi → Cruise → EnterSoi → Insert → Capture → InOrbit
 *
 * Same functions if dest is this host (skip leave + cruise)
 * or this world's other ring (skip SOI leave). Drag aborts
 * the whole route. Stop kills thrust only.
 *
 * No Three camera. Never imports drone.ts.
 */
import type { WorldOrbitKind } from './worldOrbit';

export type CourseNav = 'lock' | 'orbit' | 'proximity' | null;

export type Berth = {
  starId: number;
  /** null + ecliptic = host-star limb-film ring. */
  bodyId: string | null;
  orbit: WorldOrbitKind;
};

export type CourseLeg =
  | 'exitRing'
  | 'leaveSoi'
  | 'cruise'
  | 'enterSoi'
  | 'insert'
  | 'capture'
  | 'inOrbit';

/** Place snapshot GalaxyView feeds each tick. */
export type PlaceSnap = {
  hostId: number | null;
  riding: { starId: number; bodyId: string | null; orbit: WorldOrbitKind } | null;
  capturing: boolean;
  insertBlend: number;
  /** Current host arriveDist, if any. */
  hostArriveDist: number | null;
  arriveRange: number;
};

export class Course {
  dest: Berth | null = null;
  /** True until drag abort or capture finishes. Stop does not clear this. */
  live = false;

  begin(dest: Berth): void {
    this.dest = dest;
    this.live = true;
  }

  /** Look / pinch / roll — drop the route. Thrust is the caller's job. */
  abort(): void {
    this.dest = null;
    this.live = false;
  }

  /** Ring held — autopilot off. Dest is done. */
  arrive(): void {
    this.dest = null;
    this.live = false;
  }

  sameBerth(starId: number, bodyId: string | null, orbit: WorldOrbitKind): boolean {
    const d = this.dest;
    return Boolean(d && d.starId === starId && d.bodyId === bodyId && d.orbit === orbit);
  }

  leg(place: PlaceSnap): CourseLeg | null {
    const d = this.dest;
    if (!d || !this.live) return null;
    if (
      place.riding &&
      place.riding.starId === d.starId &&
      place.riding.bodyId === d.bodyId &&
      place.riding.orbit === d.orbit
    ) {
      return 'inOrbit';
    }
    if (place.capturing) return 'capture';
    const inDest = place.hostId === d.starId;
    if (place.riding) return 'exitRing';
    if (!inDest && place.hostId != null) {
      const dist = place.hostArriveDist;
      if (dist != null && dist <= place.arriveRange) return 'leaveSoi';
    }
    if (!inDest) return 'cruise';
    if (place.insertBlend > 1e-4) return 'insert';
    return 'enterSoi';
  }

  navMode(place: PlaceSnap, proximity: boolean): CourseNav {
    if (place.riding) return 'orbit';
    if (this.leg(place)) return 'lock';
    if (proximity) return 'proximity';
    return null;
  }
}

export function berthOf(
  starId: number,
  bodyId: string | null,
  orbit: WorldOrbitKind,
): Berth {
  return { starId, bodyId, orbit };
}
