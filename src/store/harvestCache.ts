/**
 * Packed harvest photograph. Not the galaxy — objectAt is the galaxy.
 * This is the walk's product so a second load (or a hard-refresh)
 * does not re-read every address. Keyed by the Pages build id
 * (`VITE_BUILD_ID` = github.sha) plus seed + survey floors. A new
 * deploy misses and remints; same build keeps the pack.
 */
import { db, type HarvestCacheRecord } from './db';
import type { StarCloud } from '../world/sectors';

/** Same id the service worker URL drinks. Empty / missing → `dev`. */
export function skyBuildId(): string {
  const id = import.meta.env.VITE_BUILD_ID;
  return typeof id === 'string' && id.length > 0 ? id : 'dev';
}

function asF64(v: ArrayLike<number> | ArrayBuffer): Float64Array {
  if (v instanceof Float64Array) return v;
  if (v instanceof ArrayBuffer) return new Float64Array(v);
  return Float64Array.from(v);
}

function asF32(v: ArrayLike<number> | ArrayBuffer): Float32Array {
  if (v instanceof Float32Array) return v;
  if (v instanceof ArrayBuffer) return new Float32Array(v);
  return Float32Array.from(v);
}

function asU8(v: ArrayLike<number> | ArrayBuffer): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return Uint8Array.from(v);
}

function knob(knobs: Record<string, number>, k: string, d: number): number {
  const v = knobs[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export function harvestCacheKey(
  kind: 'stars' | 'nebulae',
  seed: string,
  knobs: Record<string, number>,
): string {
  const build = skyBuildId();
  if (kind === 'stars') {
    return [build, seed, 's', knob(knobs, 'GALAXY_SAMPLE_N', 0)].join('|');
  }
  return [
    build,
    seed,
    'n',
    knob(knobs, 'GALAXY_NEBULA_M', 0),
    knob(knobs, 'GALAXY_SILHOUETTE_NEB_GAIN', 0),
    knob(knobs, 'HII_GYR', 0),
    knob(knobs, 'PN_GYR', 0),
    knob(knobs, 'SNR_GYR', 0),
  ].join('|');
}

function fromRecord(row: HarvestCacheRecord): StarCloud {
  const n = row.n;
  return {
    n,
    ids: asF64(row.ids).slice(0, n),
    pos: asF32(row.pos).slice(0, n * 3),
    col: asF32(row.col).slice(0, n * 3),
    size: asF32(row.size).slice(0, n),
    pulse: asF32(row.pulse).slice(0, n),
    gain: asF32(row.gain).slice(0, n),
    bits: asU8(row.bits).slice(0, n),
    mk: asU8(row.mk).slice(0, n),
    lum: asF32(row.lum).slice(0, n),
    kind: asU8(row.kindRow).slice(0, n),
    ms: row.ms,
  };
}

export async function loadHarvestCache(
  kind: 'stars' | 'nebulae',
  seed: string,
  knobs: Record<string, number>,
): Promise<StarCloud | null> {
  try {
    const row = await db.harvest.get(harvestCacheKey(kind, seed, knobs));
    if (row && row.seed === seed && row.kind === kind && row.n > 0) return fromRecord(row);
    // New build id or new floors: drop leftover packs for this seed.
    await forgetHarvestCache(seed);
    return null;
  } catch {
    return null;
  }
}

export async function saveHarvestCache(
  kind: 'stars' | 'nebulae',
  seed: string,
  knobs: Record<string, number>,
  cloud: StarCloud,
): Promise<void> {
  const n = cloud.n;
  const row: HarvestCacheRecord = {
    key: harvestCacheKey(kind, seed, knobs),
    seed,
    kind,
    n,
    ids: cloud.ids.slice(0, n),
    pos: cloud.pos.slice(0, n * 3),
    col: cloud.col.slice(0, n * 3),
    size: cloud.size.slice(0, n),
    pulse: cloud.pulse.slice(0, n),
    gain: cloud.gain.slice(0, n),
    bits: cloud.bits.slice(0, n),
    mk: cloud.mk.slice(0, n),
    lum: cloud.lum.slice(0, n),
    kindRow: cloud.kind.slice(0, n),
    ms: cloud.ms,
  };
  try {
    await db.harvest.put(row);
  } catch {
    // Private mode / quota — the walk still happened.
  }
}

export async function forgetHarvestCache(
  seed: string,
  kind?: 'stars' | 'nebulae',
): Promise<void> {
  try {
    const rows = await db.harvest.where('seed').equals(seed).toArray();
    const keys = rows.filter((r) => !kind || r.kind === kind).map((r) => r.key);
    if (keys.length) await db.harvest.bulkDelete(keys);
  } catch {
    // ignore
  }
}
