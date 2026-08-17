/**
 * Border monitor for the magnification sphere. The main thread
 * keeps flying (uniforms only); this worker slides membership
 * (enterers first, then leavers).
 */
import { advanceRegionCloud } from './sectors';
import type { StarCloud } from './sectors';

type SetMsg = {
  type: 'set';
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
};

type AdvanceMsg = {
  type: 'advance';
  gen: number;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
};

type InMsg = SetMsg | AdvanceMsg | { type: 'clear' };

let seed = '';
let cloud: StarCloud | null = null;

const post = self as unknown as {
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const m = e.data;
  if (m.type === 'clear') {
    cloud = null;
    return;
  }
  if (m.type === 'set') {
    seed = m.seed;
    cloud = {
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
      ms: 0,
    };
    return;
  }
  if (m.type !== 'advance' || !cloud) return;
  const next = advanceRegionCloud(seed, cloud, m.x0, m.y0, m.z0, m.x1, m.y1, m.z1);
  cloud = next;
  const n = next.n;
  const ids = next.ids.slice(0, n);
  const pos = next.pos.slice(0, n * 3);
  const col = next.col.slice(0, n * 3);
  const size = next.size.slice(0, n);
  const pulse = next.pulse.slice(0, n);
  const gain = next.gain.slice(0, n);
  const bits = next.bits.slice(0, n);
  const mk = next.mk.slice(0, n);
  const lum = next.lum.slice(0, n);
  const kind = next.kind.slice(0, n);
  post.postMessage(
    {
      type: 'cloud',
      gen: m.gen,
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
      x: m.x1,
      y: m.y1,
      z: m.z1,
    },
    [ids.buffer, pos.buffer, col.buffer, size.buffer, pulse.buffer, gain.buffer, bits.buffer, mk.buffer, lum.buffer, kind.buffer],
  );
};
