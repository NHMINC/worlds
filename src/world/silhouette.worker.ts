/**
 * Whole-disk luminous tail. The main thread keeps the boot movie
 * moving; this worker mints the backdrop once per seed, streaming
 * position/colour batches so the buildout is watchable.
 *
 * The formed GalaxyField rides in on the mint message — the worker
 * must sample the same galaxy the main thread formed, not re-run
 * 13 Gyr for itself.
 */
import { buildSilhouetteCloud } from './sectors';
import { installGalaxyField } from './formation/registry';
import type { GalaxyField } from './formation/field';

const post = self as unknown as {
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

self.onmessage = (e: MessageEvent<{ type: 'mint'; seed: string; field: GalaxyField }>): void => {
  if (e.data.type !== 'mint') return;
  installGalaxyField(e.data.field);
  const cloud = buildSilhouetteCloud(e.data.seed, (c, from, to, frac) => {
    const pos = c.pos.slice(from * 3, to * 3);
    const col = c.col.slice(from * 3, to * 3);
    post.postMessage({ type: 'batch', frac, from, to, pos, col }, [pos.buffer, col.buffer]);
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
      seed: e.data.seed,
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
