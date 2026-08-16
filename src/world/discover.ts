/**
 * First look: we do not mint a system. We search nearby solar-circle
 * hosts for a star whose planets already include a habitable world.
 * The galaxy is not a list; this is a query. An empty save opens the
 * explorer on that star; set course writes the first visit.
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

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t!;
  }
  return a;
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
 * Pick a solar-circle host that already has a living world.
 * The galaxy is shared; the first campsite is the traveler's.
 */
export function discoverHabitable(
  galaxySeed = UNIVERSE.CANONICAL_SEED,
  rng: () => number = Math.random,
): Discovery {
  const hosts = shuffle(solarCircleHosts(galaxySeed, 7000), rng);
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
