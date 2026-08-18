/**
 * One mint of the shared sky. The whole-disk backdrop is a pure
 * function of the seed; we walk it once per page load and keep it.
 * The explorer attaches the GPU mesh — it does not walk the disk.
 * Cosmic-engineer rebuilds remint or rebake under the live UNIVERSE
 * without bringing the HTML splash back.
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

let inflight: Promise<StarCloud> | null = null;
let splashHidden = false;

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
    try {
      const w = new Worker(new URL('./silhouette.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<ReadyMsg>) => {
        const m = e.data;
        if (m.type !== 'ready' || m.seed !== seed) return;
        const cloud = cloudFromMsg(m);
        installSilhouetteCloud(seed, cloud);
        w.terminate();
        finish(cloud);
      };
      w.onerror = () => {
        w.terminate();
        finish(buildSilhouetteCloud(seed));
      };
      w.postMessage({ type: 'mint', seed, knobs });
    } catch {
      finish(buildSilhouetteCloud(seed));
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
  rebakeDustCache(seed);
}

// Start the once-per-load harvest as soon as the module is imported,
// so Strict Mode remounts and the galaxy map share one worker.
void prepareUniverse();
