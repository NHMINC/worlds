import { db } from './db';
import { objectAt } from '../world/galaxy';
import { CURRENT_GEN_VERSION } from '../world/systemgen';
import { classifyStar } from '../world/stellar';
import { UNIVERSE } from '../world/physics';
import { uuid } from '../world/rng';
import type { LastPlace, SystemMeta } from '../world/types';

/** A visit is a catalog address, not a minted bottle. */
export function visitAlive(s: SystemMeta): boolean {
  if (s.starId == null) return false;
  return objectAt(s.galaxySeed ?? UNIVERSE.CANONICAL_SEED, s.starId) != null;
}

export async function listVisits(): Promise<SystemMeta[]> {
  const raw = await db.systems.orderBy('updatedAt').reverse().toArray();
  return raw.filter(visitAlive);
}

export async function visitByStar(
  starId: number,
  galaxySeed = UNIVERSE.CANONICAL_SEED,
): Promise<SystemMeta | undefined> {
  const all = await db.systems.toArray();
  return all.find((s) => s.starId === starId && (s.galaxySeed ?? UNIVERSE.CANONICAL_SEED) === galaxySeed);
}

/**
 * Arrive at a host writes (or touches) the visit row. Overlays
 * stay sparse on that id; the sky is still `objectAt`.
 */
export async function upsertVisit(p: LastPlace): Promise<SystemMeta | null> {
  const galaxySeed = p.galaxySeed || UNIVERSE.CANONICAL_SEED;
  const obj = objectAt(galaxySeed, p.starId);
  if (!obj) return null;
  const existing = await visitByStar(p.starId, galaxySeed);
  const now = Date.now();
  if (existing) {
    await db.systems.update(existing.id, { updatedAt: now, galaxySeed, starId: p.starId });
    return { ...existing, updatedAt: now, galaxySeed, starId: p.starId };
  }
  const row: SystemMeta = {
    id: uuid(),
    name: classifyStar(obj.star),
    seed: `${galaxySeed}:${p.starId}`,
    genVersion: CURRENT_GEN_VERSION,
    createdAt: now,
    updatedAt: now,
    starId: p.starId,
    galaxySeed,
  };
  await db.systems.add(row);
  return row;
}
