/**
 * One mint of the shared sky. The whole-disk backdrop is a pure
 * function of the seed. The walk is objectAt in bulk — same
 * addresses, spokes in parallel, dead cells skipped by the clock.
 * A packed copy lives in IndexedDB so a second load does not
 * re-read the disk. The explorer attaches the GPU mesh; it does
 * not walk. Cosmic-engineer rebuilds remint or rebake under the
 * live UNIVERSE without bringing the HTML splash back. First boot
 * walks stars and nebulae together; later nebula knobs rebake
 * nebulae only.
 */
import { UNIVERSE } from './physics';
import {
  forgetDustVolume,
  forgetNebulae,
  forgetSilhouette,
  harvestDustVolume,
  harvestThetaShards,
  installNebulaCloud,
  installSilhouetteCloud,
  mergeStarClouds,
  mintNebulaCloud,
  mintSilhouetteCloud,
  mintSkyClouds,
  nebulaCloud,
  rebakeDustCache,
  silhouetteCloud,
  type HarvestSpan,
  type StarCloud,
} from './sectors';
import {
  forgetHarvestCache,
  loadHarvestCache,
  saveHarvestCache,
} from '../store/harvestCache';

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
    GALAXY_SAMPLE_N: UNIVERSE.GALAXY_SAMPLE_N,
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

function mintSync(
  seed: string,
  opts: { stars: boolean; nebulae: boolean; knobs: Record<string, number> },
  onRing: (done: number, total: number) => void,
  span?: HarvestSpan,
): { stars: StarCloud | null; nebulae: StarCloud | null } {
  if (opts.stars && opts.nebulae) return mintSkyClouds(seed, onRing, span);
  return {
    stars: opts.stars ? mintSilhouetteCloud(seed, onRing, span) : null,
    nebulae: opts.nebulae ? mintNebulaCloud(seed, onRing, span) : null,
  };
}

function workerCount(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 1;
  return Math.max(1, Math.min(8, hc));
}

function runOneWorker(
  seed: string,
  opts: { stars: boolean; nebulae: boolean; knobs: Record<string, number> },
  span: HarvestSpan | undefined,
  onRing: (done: number, total: number) => void,
): Promise<{ stars: StarCloud | null; nebulae: StarCloud | null }> {
  return new Promise((resolve) => {
    const fallback = () => resolve(mintSync(seed, opts, onRing, span));
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
        ir0: span?.ir0,
        ir1: span?.ir1,
        it0: span?.it0,
        it1: span?.it1,
      });
    } catch {
      fallback();
    }
  });
}

function runCatalogWorker(
  seed: string,
  opts: { stars: boolean; nebulae: boolean; knobs: Record<string, number> },
  onRing: (done: number, total: number) => void,
): Promise<{ stars: StarCloud | null; nebulae: StarCloud | null }> {
  const shards = harvestThetaShards(workerCount());
  if (shards.length <= 1) return runOneWorker(seed, opts, undefined, onRing);
  const doneAt = shards.map(() => 0);
  const sizes = shards.map(([a, b]) => Math.max(1, b - a));
  const total = sizes.reduce((s, n) => s + n, 0);
  const tick = () => {
    let done = 0;
    for (const d of doneAt) done += d;
    onRing(done, total);
  };
  return Promise.all(
    shards.map(([it0, it1], i) =>
      runOneWorker(seed, opts, { it0, it1 }, (done, shardTotal) => {
        const t = Math.max(1, shardTotal);
        doneAt[i] = Math.round((sizes[i] * done) / t);
        tick();
      }),
    ),
  ).then((parts) => {
    const stars = opts.stars
      ? mergeStarClouds(parts.map((p) => p.stars).filter((c): c is StarCloud => !!c))
      : null;
    const nebulae = opts.nebulae
      ? mergeStarClouds(parts.map((p) => p.nebulae).filter((c): c is StarCloud => !!c))
      : null;
    return { stars, nebulae };
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
  }).then(async ({ stars, nebulae }) => {
    if (nebulae) {
      installNebulaCloud(seed, nebulae);
      void saveHarvestCache('nebulae', seed, nebulaWorkerKnobs(), nebulae);
    }
    if (!stars) throw new Error('star harvest worker returned no catalog');
    installSilhouetteCloud(seed, stars);
    void saveHarvestCache('stars', seed, harvestWorkerKnobs(), stars);
    bakeDustIfNeeded(seed);
    return stars;
  });
}

function mintNebulaeInWorker(seed: string): Promise<StarCloud> {
  emitNebulaWalk(0, 1);
  const knobs = nebulaWorkerKnobs();
  return runCatalogWorker(seed, { stars: false, nebulae: true, knobs }, emitNebulaWalk).then(
    async ({ nebulae }) => {
      if (!nebulae) throw new Error('nebula worker returned no catalog');
      installNebulaCloud(seed, nebulae);
      void saveHarvestCache('nebulae', seed, knobs, nebulae);
      return nebulae;
    },
  );
}

async function loadPackedSky(seed: string): Promise<StarCloud | null> {
  const starKnobs = harvestWorkerKnobs();
  const stars = await loadHarvestCache('stars', seed, starKnobs);
  if (!stars) return null;
  installSilhouetteCloud(seed, stars);
  if (!nebulaCloud(seed)) {
    const neb = await loadHarvestCache('nebulae', seed, nebulaWorkerKnobs());
    if (neb) installNebulaCloud(seed, neb);
  }
  return stars;
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
      emitProgress({ kind: 'harvest', frac: 0, label: 'Loading the sky…' });
      const packed = await loadPackedSky(seed);
      if (packed) {
        emitHarvest(1, 1, harvestDustVolume(seed) ? 1 : 0.9);
        if (!nebulaCloud(seed)) {
          nebulaInflight = mintNebulaeInWorker(seed).finally(() => {
            nebulaInflight = null;
          });
          await nebulaInflight;
        }
        bakeDustIfNeeded(seed);
        return packed;
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
  await forgetHarvestCache(seed, 'stars');
  inflight = mintInWorker(seed).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Rebake the nebula catalog. Stars and fog stay. */
export async function rebakeUniverseNebulae(seed = UNIVERSE.CANONICAL_SEED): Promise<StarCloud> {
  if (nebulaInflight) return nebulaInflight;
  forgetNebulae();
  await forgetHarvestCache(seed, 'nebulae');
  nebulaInflight = mintNebulaeInWorker(seed).finally(() => {
    nebulaInflight = null;
  });
  return nebulaInflight;
}

/** Rebake ISM-ribbon fog. Stars and nebulae stay; the explorer swaps the 3D texture. */
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
