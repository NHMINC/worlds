/**
 * First landing: we do not mint a system. We search the catalog for a
 * star whose planets already include a habitable world, and we go there.
 */
import { UNIVERSE } from './physics';
import { collectCatalog, type GalaxyObject } from './galaxy';
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
    const t = a[i];
    a[i] = a[j]!;
    a[j] = t!;
  }
  return a;
}

function isHabitableHost(o: GalaxyObject): boolean {
  const st = o.star;
  if (st.phase !== 'main_sequence') return false;
  if (st.mk !== 'F' && st.mk !== 'G' && st.mk !== 'K') return false;
  if (st.lumClass !== 'V' && st.lumClass !== 'VI') return false;
  if (o.pop === 'halo') return false;
  return true;
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
 * Pick a random catalog star that already has a living world.
 * The galaxy is shared; the first campsite is the traveler's.
 */
export function discoverHabitable(
  galaxySeed = UNIVERSE.CANONICAL_SEED,
  rng: () => number = Math.random,
): Discovery {
  const cat = collectCatalog(galaxySeed);
  const hosts = shuffle(cat.filter(isHabitableHost), rng);
  const limit = Math.min(hosts.length, 90);
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
  const obj = hosts[0] ?? cat.find((o) => o.star.phase === 'main_sequence') ?? cat[0];
  if (!obj) throw new Error('catalog is empty — cannot discover a start');
  const spec = systemAt(galaxySeed, obj.id);
  return { starId: obj.id, spec, bodyId: homeBodyId(spec), obj };
}
