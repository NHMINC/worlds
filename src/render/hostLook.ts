/**
 * Host-pass look: pick the body closest to a point — distance,
 * not angular size. Launch locks the body nearest the ship;
 * stay-out uses the drone eye. Target lock is a latched id
 * and does not hop. galaxyView supplies the distances; this
 * file only chooses.
 */
import type { HostBodyRT } from './hostSystem';

/** Body whose centre is nearest the eye. Null if the host is empty. */
export function nearestBody(
  bodies: readonly HostBodyRT[],
  distOf: (rt: HostBodyRT) => number,
): HostBodyRT | null {
  let best: HostBodyRT | null = null;
  let bestD = Infinity;
  for (const rt of bodies) {
    const d = distOf(rt);
    if (!(d < bestD)) continue;
    bestD = d;
    best = rt;
  }
  return best;
}
