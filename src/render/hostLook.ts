/**
 * Host-pass look: aim at a body core. Center picks the body
 * closest to the camera — distance, not angular size, not a
 * latched id from a prior frame. galaxyView supplies the
 * eye→body vectors (precision law); this file only chooses.
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
