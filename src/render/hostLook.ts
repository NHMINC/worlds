/**
 * Host-pass look: pick the body closest to a point — distance,
 * not angular size, not a latched id from a prior frame.
 * The drone's Center lock uses this on the drone eye (star
 * wins if it is nearer). galaxyView supplies the distances;
 * this file only chooses.
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
