/**
 * One mint of the shared sky. The whole-disk backdrop is a pure
 * function of the seed; we walk it once per page load and keep it.
 * The explorer attaches the GPU mesh — it does not walk the disk.
 */
import { UNIVERSE } from './physics';
import {
  buildSilhouetteCloud,
  installSilhouetteCloud,
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

/** Cached harvest, or a worker mint. Safe to call from boot and the explorer. */
export function prepareUniverse(seed = UNIVERSE.CANONICAL_SEED): Promise<StarCloud> {
  const hit = silhouetteCloud(seed);
  if (hit) return Promise.resolve(hit);
  if (inflight) return inflight;
  inflight = new Promise<StarCloud>((resolve) => {
    const finish = (cloud: StarCloud) => {
      inflight = null;
      resolve(cloud);
    };
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
      w.postMessage({ type: 'mint', seed });
    } catch {
      finish(buildSilhouetteCloud(seed));
    }
  });
  return inflight;
}
