/**
 * Host-pass autopilot modes. Exclusive — one at a time.
 *
 *   lock       — calculated trajectory into a chosen orbit
 *                (body ring, or star ecliptic). Graze-safe
 *                insertion that yaws onto prograde before the
 *                shell, then a capture settle onto the rail.
 *                Turns off the moment the ring is held.
 *   orbit      — on the ring. Autopilot off. Default look is
 *                body-locked (nadir down, prograde forward —
 *                the sphere fills the lower half); a look
 *                drag frees the stick until release. The
 *                reticle is only the view-centre pip.
 *   proximity  — left orbit by warp (free roam). Reports
 *                nearest body only; no heading hold, no
 *                guidance, no re-lock until the player picks
 *                a course. Speed is not capped by the body
 *                you just left — only an active course is.
 *   null       — free cruise (no lock, not on a ring, not
 *                post-break).
 *
 * Place laws (host sphere, world fence) are separate from this.
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
