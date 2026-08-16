/**
 * One mint of the shared sky, in causal order:
 *
 *   1. FORM — the seed runs the gas-to-galaxy sim (worker), streaming
 *      live snapshots: the boot movie. A warm cache skips the run and
 *      hands back the stored keyframes for a fast replay instead.
 *   2. FIELD — the baked GalaxyField is installed (the catalog law now
 *      has a galaxy to sample) and cached in IndexedDB.
 *   3. CATALOG — the whole-disk backdrop is minted (worker), streaming
 *      position/colour batches: the buildout.
 *
 * The explorer attaches the finished GPU mesh — it does not walk the
 * disk, and it never re-forms the galaxy.
 */
import { UNIVERSE } from './physics';
import {
  buildSilhouetteCloud,
  installSilhouetteCloud,
  silhouetteCloud,
  type StarCloud,
} from './sectors';
import {
  activeGalaxyField,
  ensureGalaxyField,
  installGalaxyField,
  FORMATION_VERSION,
  type GalaxyField,
} from './formation/registry';
import type { FormationDoneMsg, FormationSnapMsg } from './formation/formation.worker';
import { db } from '../store/db';

export interface PrepHooks {
  /** A live formation frame ([x, y, ageMyr|-1] triplets) at sim fraction `frac`. */
  onFormationSnap?: (pts: Float32Array, frac: number, tMyr: number) => void;
  /** Warm cache: the stored keyframes, for a fast replay instead of a live run. */
  onFormationReplay?: (keyframes: Float32Array[]) => void;
  /** The galaxy has formed; the catalog law is live. */
  onFieldReady?: (field: GalaxyField) => void;
  /** A slice of the backdrop mint (catalog positions and colours). */
  onCatalogBatch?: (pos: Float32Array, col: Float32Array, frac: number) => void;
}

type ReadyMsg = {
  type: 'ready';
  seed: string;
  n: number;
  ids: Float64Array;
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  pulse: Float32Array;
  gain: Float32Array;
  bits: Uint8Array;
  mk: Uint8Array;
  lum: Float32Array;
  kind: Uint8Array;
  ms: number;
};

type BatchMsg = { type: 'batch'; frac: number; from: number; to: number; pos: Float32Array; col: Float32Array };

let inflight: Promise<StarCloud> | null = null;

function cloudFromMsg(m: ReadyMsg): StarCloud {
  return {
    n: m.n,
    ids: m.ids,
    pos: m.pos,
    col: m.col,
    size: m.size,
    pulse: m.pulse,
    gain: m.gain,
    bits: m.bits,
    mk: m.mk,
    lum: m.lum,
    kind: m.kind,
    ms: m.ms,
  };
}

function fieldKey(seed: string): string {
  return `${seed}:${FORMATION_VERSION}`;
}

/** Stage 1+2: a formed, installed field — cache, worker run, or sync fallback. */
async function prepareField(seed: string, hooks?: PrepHooks): Promise<GalaxyField> {
  const active = activeGalaxyField();
  if (active && active.seed === seed && active.version === FORMATION_VERSION) return active;
  let cached: { field: GalaxyField; keyframes: Float32Array[] } | undefined;
  try {
    cached = await db.fields.get(fieldKey(seed));
  } catch {
    cached = undefined;
  }
  if (cached) {
    installGalaxyField(cached.field);
    hooks?.onFormationReplay?.(cached.keyframes);
    hooks?.onFieldReady?.(cached.field);
    return cached.field;
  }
  const field = await new Promise<GalaxyField>((resolve) => {
    try {
      const w = new Worker(new URL('./formation/formation.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<FormationSnapMsg | FormationDoneMsg>) => {
        const m = e.data;
        if (m.type === 'snap') {
          hooks?.onFormationSnap?.(m.pts, m.frac, m.tMyr);
          return;
        }
        if (m.type !== 'done' || m.seed !== seed) return;
        installGalaxyField(m.field);
        void db.fields
          .put({ key: fieldKey(seed), field: m.field, keyframes: m.keyframes, savedAt: Date.now() })
          .catch(() => undefined);
        w.terminate();
        resolve(m.field);
      };
      w.onerror = () => {
        w.terminate();
        resolve(ensureGalaxyField(seed));
      };
      w.postMessage({ type: 'form', seed });
    } catch {
      resolve(ensureGalaxyField(seed));
    }
  });
  hooks?.onFieldReady?.(field);
  return field;
}

/** Cached harvest, or the full form → bake → mint pipeline. Safe to call from boot and the explorer. */
export function prepareUniverse(seed = UNIVERSE.CANONICAL_SEED, hooks?: PrepHooks): Promise<StarCloud> {
  const hit = silhouetteCloud(seed);
  if (hit) return Promise.resolve(hit);
  if (inflight) return inflight;
  inflight = (async () => {
    const field = await prepareField(seed, hooks);
    const cloud = await new Promise<StarCloud>((resolve) => {
      try {
        const w = new Worker(new URL('./silhouette.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<ReadyMsg | BatchMsg>) => {
          const m = e.data;
          if (m.type === 'batch') {
            hooks?.onCatalogBatch?.(m.pos, m.col, m.frac);
            return;
          }
          if (m.type !== 'ready' || m.seed !== seed) return;
          const c = cloudFromMsg(m);
          installSilhouetteCloud(seed, c);
          w.terminate();
          resolve(c);
        };
        w.onerror = () => {
          w.terminate();
          resolve(buildSilhouetteCloud(seed));
        };
        // Structured clone (no transfer): the main thread keeps its field.
        w.postMessage({ type: 'mint', seed, field });
      } catch {
        resolve(buildSilhouetteCloud(seed));
      }
    });
    inflight = null;
    return cloud;
  })();
  return inflight;
}
