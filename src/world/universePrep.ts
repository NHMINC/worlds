/**
 * One mint of the shared sky. The whole-disk backdrop is a pure
 * function of the seed; we walk it once per page load and keep it.
 * The explorer attaches the GPU mesh — it does not walk the disk.
 * Cosmic-engineer rebuilds remint or rebake under the live UNIVERSE
 * without bringing the HTML splash back. Progress is the walk:
 * rings visited / rings in the disk, then the dust bake.
 */
import { UNIVERSE } from './physics';
import {
  buildSilhouetteCloud,
  forgetDustVolume,
  forgetSilhouette,
  installSilhouetteCloud,
  rebakeDustCache,
  silhouetteCloud,
  type StarCloud,
} from './sectors';

export type UniverseProgress = {
  kind: 'harvest' | 'dust';
  /** 0..1 of the whole job (harvest then fog). */
  frac: number;
  label: string;
};

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

type ProgressMsg = {
  type: 'progress';
  seed: string;
  done: number;
  total: number;
};

type WorkerMsg = ReadyMsg | ProgressMsg;

type ProgressFn = (p: UniverseProgress) => void;

let inflight: Promise<StarCloud> | null = null;
let splashHidden = false;
const listeners = new Set<ProgressFn>();

/** Subscribe to harvest / dust-bake progress. Returns an unsubscribe. */
export function onUniverseProgress(fn: ProgressFn): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emitProgress(p: UniverseProgress): void {
  for (const fn of listeners) fn(p);
  paintSplash(p);
}

function paintSplash(p: UniverseProgress): void {
  const boot = document.getElementById('universe-boot');
  if (!boot) return;
  const copy = document.getElementById('universe-boot-copy');
  const bar = document.getElementById('universe-boot-bar');
  if (copy) copy.textContent = p.label;
  // Native <progress>.value — Pages CSP is style-src 'self', so
  // element.style.width on a fill never paints.
  if (bar instanceof HTMLProgressElement) bar.value = Math.round(p.frac * 100);
}

function emitHarvest(done: number, total: number): void {
  const t = Math.max(1, total);
  emitProgress({
    kind: 'harvest',
    frac: 0.9 * (done / t),
    label: 'Walking the disk…',
  });
}

function emitDust(frac: number): void {
  emitProgress({
    kind: 'dust',
    frac: 0.9 + 0.1 * Math.max(0, Math.min(1, frac)),
    label: 'Baking the fog…',
  });
}

/** Remove the HTML splash once. Survives React Strict Mode remounts. */
export function hideUniverseSplash(): void {
  if (splashHidden) return;
  splashHidden = true;
  document.getElementById('universe-boot')?.remove();
}

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

/**
 * Harvest laws the worker must copy onto its own UNIVERSE.
 * Keep in sync with REBUILD_KNOBS scope === 'harvest'.
 */
function harvestWorkerKnobs(): Record<string, number> {
  return {
    GALAXY_SILHOUETTE_L: UNIVERSE.GALAXY_SILHOUETTE_L,
    GALAXY_SILHOUETTE_M: UNIVERSE.GALAXY_SILHOUETTE_M,
    GALAXY_SILHOUETTE_NEB_GAIN: UNIVERSE.GALAXY_SILHOUETTE_NEB_GAIN,
  };
}

function mintInWorker(seed: string): Promise<StarCloud> {
  return new Promise<StarCloud>((resolve) => {
    const finish = (cloud: StarCloud) => {
      inflight = null;
      resolve(cloud);
    };
    const knobs = harvestWorkerKnobs();
    emitHarvest(0, 1);
    try {
      const w = new Worker(new URL('./silhouette.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerMsg>) => {
        const m = e.data;
        if (m.type === 'progress') {
          if (m.seed === seed) emitHarvest(m.done, m.total);
          return;
        }
        if (m.type !== 'ready' || m.seed !== seed) return;
        const cloud = cloudFromMsg(m);
        emitDust(0);
        installSilhouetteCloud(seed, cloud, emitDust);
        w.terminate();
        finish(cloud);
      };
      w.onerror = () => {
        w.terminate();
        finish(
          buildSilhouetteCloud(seed, emitHarvest),
        );
      };
      w.postMessage({ type: 'mint', seed, knobs });
    } catch {
      finish(buildSilhouetteCloud(seed, emitHarvest));
    }
  });
}

/** Cached harvest, or a worker mint. Safe to call from boot and the explorer. */
export function prepareUniverse(seed = UNIVERSE.CANONICAL_SEED): Promise<StarCloud> {
  const hit = silhouetteCloud(seed);
  if (hit) return Promise.resolve(hit);
  if (inflight) return inflight;
  inflight = mintInWorker(seed);
  return inflight;
}

/**
 * Forget the harvest and remint under the current UNIVERSE.
 * Does not show the HTML splash — the explorer owns that wait.
 */
export async function remintUniverse(seed = UNIVERSE.CANONICAL_SEED): Promise<StarCloud> {
  if (inflight) await inflight;
  forgetSilhouette();
  forgetDustVolume();
  inflight = mintInWorker(seed);
  return inflight;
}

/** Rebake death-smear fog. Stars stay; the explorer swaps the 3D texture. */
export function rebakeUniverseDust(seed = UNIVERSE.CANONICAL_SEED): void {
  emitProgress({ kind: 'dust', frac: 0, label: 'Baking the fog…' });
  rebakeDustCache(seed, (frac) => {
    emitProgress({ kind: 'dust', frac, label: 'Baking the fog…' });
  });
}

// Start the once-per-load harvest as soon as the module is imported,
// so Strict Mode remounts and the galaxy map share one worker.
void prepareUniverse();
