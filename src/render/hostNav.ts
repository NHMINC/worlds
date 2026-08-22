/**
 * HUD labels derived from course + place.
 *
 *   lock       — a live berth: exit / leave / cruise / insert / capture
 *   orbit      — on the dest ring. Autopilot off.
 *   proximity  — left a ring with no dest (free roam)
 *   null       — free cruise
 *
 * Place laws (host sphere, world fence) are separate. The
 * course object is the source of truth; this file only names
 * the mode for the plate.
 */
import type { WorldOrbitKind } from '../world/worldOrbit';

export type HostNavMode = 'lock' | 'orbit' | 'proximity' | null;

/** What lock is trying to achieve. */
export type HostLockTarget =
  | { kind: 'body'; bodyId: string; orbit: WorldOrbitKind }
  | { kind: 'star'; starId: number };

export function navModeLabel(mode: HostNavMode): string {
  switch (mode) {
    case 'lock':
      return 'Lock-on';
    case 'orbit':
      return 'In orbit';
    case 'proximity':
      return 'Free roam';
    default:
      return '';
  }
}
