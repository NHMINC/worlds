/**
 * Whole-disk catalog walks. Stars and nebulae are separate
 * catalogs; first boot can mint both in one pass so slot-birth
 * is paid once. Rebuilds post the knobs — this UNIVERSE copy is
 * not the main thread's. Progress is rings walked.
 */
import { UNIVERSE } from './physics';
import { mintSkyClouds, mintSilhouetteCloud, mintNebulaCloud } from './sectors';
import type { StarCloud } from './sectors';

const post = self as unknown as {
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

function applyKnobs(knobs: Record<string, number> | undefined): void {
  if (!knobs) return;
  const u = UNIVERSE as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(knobs)) {
    if (typeof u[k] === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      u[k] = v;
    }
  }
}

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

function packCloud(cloud: StarCloud): { payload: CloudPayload; transfer: Transferable[] } {
  const n = cloud.n;
  const ids = cloud.ids.slice(0, n);
  const pos = cloud.pos.slice(0, n * 3);
  const col = cloud.col.slice(0, n * 3);
  const size = cloud.size.slice(0, n);
  const pulse = cloud.pulse.slice(0, n);
  const gain = cloud.gain.slice(0, n);
  const bits = cloud.bits.slice(0, n);
  const mk = cloud.mk.slice(0, n);
  const lum = cloud.lum.slice(0, n);
  const kind = cloud.kind.slice(0, n);
  return {
    payload: { n, ids, pos, col, size, pulse, gain, bits, mk, lum, kind, ms: cloud.ms },
    transfer: [
      ids.buffer,
      pos.buffer,
      col.buffer,
      size.buffer,
      pulse.buffer,
      gain.buffer,
      bits.buffer,
      mk.buffer,
      lum.buffer,
      kind.buffer,
    ],
  };
}

self.onmessage = (
  e: MessageEvent<{
    type: 'mint';
    seed: string;
    knobs?: Record<string, number>;
    stars?: boolean;
    nebulae?: boolean;
  }>,
): void => {
  if (e.data.type !== 'mint') return;
  applyKnobs(e.data.knobs);
  const seed = e.data.seed;
  const wantStars = e.data.stars !== false;
  const wantNebulae = e.data.nebulae === true;
  const onRing = (done: number, total: number) => {
    post.postMessage({ type: 'progress', seed, done, total });
  };
  let stars: StarCloud | null = null;
  let nebulae: StarCloud | null = null;
  if (wantStars && wantNebulae) {
    const both = mintSkyClouds(seed, onRing);
    stars = both.stars;
    nebulae = both.nebulae;
  } else if (wantNebulae) {
    nebulae = mintNebulaCloud(seed, onRing);
  } else {
    stars = mintSilhouetteCloud(seed, onRing);
  }
  const starPack = stars ? packCloud(stars) : null;
  const nebPack = nebulae ? packCloud(nebulae) : null;
  post.postMessage(
    {
      type: 'ready',
      seed,
      stars: starPack?.payload ?? null,
      nebulae: nebPack?.payload ?? null,
    },
    [...(starPack?.transfer ?? []), ...(nebPack?.transfer ?? [])],
  );
};
