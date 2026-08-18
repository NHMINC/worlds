/**
 * Whole-disk harvest (the magnitude-limited survey).
 * The main thread keeps the map / dive moving; this worker mints
 * the backdrop once per seed. Rebuilds post the harvest knobs —
 * this UNIVERSE copy is not the main thread's. Progress is rings
 * walked, posted so the splash / explorer can fill a bar.
 */
import { UNIVERSE } from './physics';
import { mintSilhouetteCloud } from './sectors';

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

self.onmessage = (e: MessageEvent<{ type: 'mint'; seed: string; knobs?: Record<string, number> }>): void => {
  if (e.data.type !== 'mint') return;
  applyKnobs(e.data.knobs);
  const seed = e.data.seed;
  const cloud = mintSilhouetteCloud(seed, (done, total) => {
    post.postMessage({ type: 'progress', seed, done, total });
  });
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
  post.postMessage(
    {
      type: 'ready',
      seed,
      n,
      ids,
      pos,
      col,
      size,
      pulse,
      gain,
      bits,
      mk,
      lum,
      kind,
      ms: cloud.ms,
    },
    [ids.buffer, pos.buffer, col.buffer, size.buffer, pulse.buffer, gain.buffer, bits.buffer, mk.buffer, lum.buffer, kind.buffer],
  );
};
