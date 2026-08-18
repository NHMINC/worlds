/**
 * One mint of the shared sky. The whole-disk backdrop is a pure
 * function of the seed; we walk it once per page load and keep it.
 * The explorer attaches the GPU mesh — it does not walk the disk.
 * Cosmic-engineer rebuilds remint or rebake under the live UNIVERSE
 * without bringing the HTML splash back. First boot walks stars
 * and nebulae together; later nebula knobs rebake nebulae only.
 */
import { UNIVERSE } from './physics';
import {
  forgetDustVolume,
  forgetNebulae,
  forgetSilhouette,
  harvestDustVolume,
  installNebulaCloud,
  installSilhouetteCloud,
  mintNebulaCloud,
  mintSilhouetteCloud,
  mintSkyClouds,
  nebulaCloud,
  rebakeDustCache,
  silhouetteCloud,
  type StarCloud,
} from './sectors';

export type UniverseProgress = {
  kind: 'harvest' | 'nebula' | 'dust';
  /** 0..1 of the whole job (or of a solo rebake). */
  frac: number;
  label: string;
};

type CloudPayload = {
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

type ReadyMsg = {
  type: 'ready';
  seed: string;
  stars: CloudPayload | null;
  nebulae: CloudPayload | null;
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
let nebulaInflight: Promise<StarCloud> | null = null;
let splashHidden = false;
const listeners = new Set<ProgressFn>();

/** Subscribe to harvest / nebula / dust-bake progress. Returns an unsubscribe. */
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

function emitHarvest(done: number, total: number, span = 0.9): void {
  const t = Math.max(1, total);
  emitProgress({
    kind: 'harvest',
    frac: span * (done / t),
    label: 'Walking the disk…',
  });
}

function emitNebulaWalk(done: number, total: number): void {
  const t = Math.max(1, total);
  emitProgress({
    kind: 'nebula',
    frac: done / t,
    label: 'Collecting nebulae…',
  });
}

function emitDust(frac: number, origin = 0.9, span = 0.1): void {
  emitProgress({
    kind: 'dust',
    frac: origin + span * Math.max(0, Math.min(1, frac)),
    label: 'Baking the fog…',
  });
}

/** Remove the HTML splash once. Survives React Strict Mode remounts. */
export function hideUniverseSplash(): void {
  if (splashHidden) return;
  splashHidden = true;
  document.getElementById('universe-boot')?.remove();
}

function cloudFromPayload(m: CloudPayload): StarCloud {
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

/** Harvest laws the worker must copy onto its own UNIVERSE. */
function harvestWorkerKnobs(): Record<string, number> {
  return {
    GALAXY_SILHOUETTE_L: UNIVERSE.GALAXY_SILHOUETTE_L,
    GALAXY_SILHOUETTE_M: UNIVERSE.GALAXY_SILHOUETTE_M,
  };
}

/** Nebula laws the worker must copy onto its own UNIVERSE. */
function nebulaWorkerKnobs(): Record<string, number> {
  return {
    GALAXY_NEBULA_M: UNIVERSE.GALAXY_NEBULA_M,
    GALAXY_SILHOUETTE_NEB_GAIN: UNIVERSE.GALAXY_SILHOUETTE_NEB_GAIN,
    HII_GYR: UNIVERSE.HII_GYR,
    PN_GYR: UNIVERSE.PN_GYR,
    SNR_GYR: UNIVERSE.SNR_GYR,
  };
}

function runCatalogWorker(
  seed: string,
  opts: { stars: boolean; nebulae: boolean; knobs: Record<string, number> },
  onRing: (done: number, total: number) => void,
): Promise<{ stars: StarCloud | null; nebulae: StarCloud | null }> {
  return new Promise((resolve) => {
    const fallback = () => {
      if (opts.stars && opts.nebulae) {
        const both = mintSkyClouds(seed, onRing);
        resolve(both);
        return;
      }
      resolve({
        stars: opts.stars ? mintSilhouetteCloud(seed, onRing) : null,
        nebulae: opts.nebulae ? mintNebulaCloud(seed, onRing) : null,
      });
    };
    try {
      const w = new Worker(new URL('./silhouette.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerMsg>) => {
        const m = e.data;
        if (m.type === 'progress') {
          if (m.seed === seed) onRing(m.done, m.total);
          return;
        }
        if (m.type !== 'ready' || m.seed !== seed) return;
        w.terminate();
        resolve({
          stars: m.stars ? cloudFromPayload(m.stars) : null,
          nebulae: m.nebulae ? cloudFromPayload(m.nebulae) : null,
        });
      };
      w.onerror = () => {
        w.terminate();
        fallback();
      };
      w.postMessage({
        type: 'mint',
        seed,
        knobs: opts.knobs,
        stars: opts.stars,
        nebulae: opts.nebulae,
      });
    } catch {
      fallback();
    }
  });
}

function bakeDustIfNeeded(seed: string): void {
  if (harvestDustVolume(seed)) return;
  emitDust(0);
  rebakeDustCache(seed, (frac) => emitDust(frac));
}

function mintInWorker(seed: string): Promise<StarCloud> {
  const needNeb = !nebulaCloud(seed);
  const needDust = !harvestDustVolume(seed);
  const span = needDust ? 0.9 : 1;
  emitHarvest(0, 1, span);
  const knobs = needNeb ? { ...harvestWorkerKnobs(), ...nebulaWorkerKnobs() } : harvestWorkerKnobs();
  return runCatalogWorker(seed, { stars: true, nebulae: needNeb, knobs }, (done, total) => {
    emitHarvest(done, total, span);
  }).then(({ stars, nebulae }) => {
    if (nebulae) installNebulaCloud(seed, nebulae);
    if (!stars) throw new Error('star harvest worker returned no catalog');
    installSilhouetteCloud(seed, stars);
    bakeDustIfNeeded(seed);
    return stars;
  });
}

function mintNebulaeInWorker(seed: string): Promise<StarCloud> {
  emitNebulaWalk(0, 1);
  return runCatalogWorker(
    seed,
    { stars: false, nebulae: true, knobs: nebulaWorkerKnobs() },
    emitNebulaWalk,
  ).then(({ nebulae }) => {
    if (!nebulae) throw new Error('nebula worker returned no catalog');
    installNebulaCloud(seed, nebulae);
    return nebulae;
  });
}

/** Cached harvest, or a worker mint. Safe to call from boot and the explorer. */
export function prepareUniverse(seed = UNIVERSE.CANONICAL_SEED): Promise<StarCloud> {
  const hit = silhouetteCloud(seed);
  if (hit && nebulaCloud(seed) && harvestDustVolume(seed)) return Promise.resolve(hit);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (hit) {
        if (!nebulaCloud(seed)) {
          if (nebulaInflight) await nebulaInflight;
          else {
            nebulaInflight = mintNebulaeInWorker(seed).finally(() => {
              nebulaInflight = null;
            });
            await nebulaInflight;
          }
        }
        bakeDustIfNeeded(seed);
        return hit;
      }
      return await mintInWorker(seed);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Forget the star harvest and remint under the current UNIVERSE.
 * Nebulae and dust stay — they have their own rebake.
 * Does not show the HTML splash — the explorer owns that wait.
 */
export async function remintUniverse(seed = UNIVERSE.CANONICAL_SEED): Promise<StarCloud> {
  if (inflight) await inflight;
  forgetSilhouette();
  inflight = mintInWorker(seed).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Rebake the nebula catalog. Stars and fog stay. */
export async function rebakeUniverseNebulae(seed = UNIVERSE.CANONICAL_SEED): Promise<StarCloud> {
  if (nebulaInflight) return nebulaInflight;
  forgetNebulae();
  nebulaInflight = mintNebulaeInWorker(seed).finally(() => {
    nebulaInflight = null;
  });
  return nebulaInflight;
}

/** Rebake death-smear fog. Stars and nebulae stay; the explorer swaps the 3D texture. */
export function rebakeUniverseDust(seed = UNIVERSE.CANONICAL_SEED): void {
  emitProgress({ kind: 'dust', frac: 0, label: 'Baking the fog…' });
  forgetDustVolume();
  rebakeDustCache(seed, (frac) => {
    emitProgress({ kind: 'dust', frac, label: 'Baking the fog…' });
  });
}

// Start the once-per-load harvest as soon as the module is imported,
// so Strict Mode remounts and the galaxy map share one worker.
void prepareUniverse();
