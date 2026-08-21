/**
 * First look: we do not mint a system. We search nearby solar-circle
 * hosts for a star whose planets already include a habitable world.
 * The galaxy is not a list; this is a query. An empty save with no
 * camp opens the explorer on that star. Entering a host writes the
 * camp; the next boot restores that body.
 * The walk is the host list as the mass model emitted it — no shuffle.
 */
import { UNIVERSE } from './physics';
import { solarCircleHosts, type GalaxyObject } from './galaxy';
import { homeBodyId, systemAt, type SystemSpec } from './systemgen';

export interface Discovery {
  starId: number;
  spec: SystemSpec;
  bodyId: string;
  obj: GalaxyObject;
}

function livingBody(spec: SystemSpec): string | null {
  for (const b of spec.bodies) {
    if (b.kind === 'rocky' && b.physics.life) return b.id;
  }
  return null;
}

function wetBody(spec: SystemSpec): string | null {
  for (const b of spec.bodies) {
    if (b.kind !== 'rocky') continue;
    if (b.physics.hydrosphere.substance === 'water' && b.physics.hydrosphere.state === 'liquid') {
      return b.id;
    }
  }
  return null;
}

/**
 * First living solar-circle host, then first wet world, then the
 * first host. Same seed, same campsite — no roll.
 */
export function discoverHabitable(galaxySeed = UNIVERSE.CANONICAL_SEED): Discovery {
  const hosts = solarCircleHosts(galaxySeed, 7000);
  const limit = Math.min(hosts.length, 400);
  for (let i = 0; i < limit; i++) {
    const obj = hosts[i]!;
    const spec = systemAt(galaxySeed, obj.id);
    const bodyId = livingBody(spec);
    if (bodyId) return { starId: obj.id, spec, bodyId, obj };
  }
  for (let i = 0; i < limit; i++) {
    const obj = hosts[i]!;
    const spec = systemAt(galaxySeed, obj.id);
    const bodyId = wetBody(spec);
    if (bodyId) return { starId: obj.id, spec, bodyId, obj };
  }
  const obj = hosts[0];
  if (!obj) throw new Error('no solar-circle host — cannot discover a start');
  const spec = systemAt(galaxySeed, obj.id);
  return { starId: obj.id, spec, bodyId: homeBodyId(spec), obj };
}
