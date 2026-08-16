/**
 * Membership for the magnification sphere. The animation thread
 * only updates magnifier uniforms; this worker remints the 2 kpc
 * ball at the new centre. Birth scatter is a large fraction of
 * REGION_R, so a rim walk is the same ball — remint is the law
 * (same ids as buildRegionCloud) without freezing the frame.
 */
import { buildRegionCloud } from './sectors';
import type { StarCloud } from './sectors';

type RebuildMsg = {
  type: 'rebuild';
  seed: string;
  gen: number;
  x: number;
  y: number;
  z: number;
};

type InMsg = RebuildMsg | { type: 'clear' };

const post = self as unknown as {
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

function postCloud(gen: number, cloud: StarCloud, x: number, y: number, z: number): void {
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
      type: 'cloud',
      gen,
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
      x,
      y,
      z,
    },
    [ids.buffer, pos.buffer, col.buffer, size.buffer, pulse.buffer, gain.buffer, bits.buffer, mk.buffer, lum.buffer, kind.buffer],
  );
}

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const m = e.data;
  if (m.type === 'clear') return;
  if (m.type !== 'rebuild') return;
  postCloud(m.gen, buildRegionCloud(m.seed, m.x, m.y, m.z), m.x, m.y, m.z);
};
