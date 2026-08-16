/**
 * The galaxy forms off-thread. One message runs the formation sim for
 * a seed, streaming live snapshots (the boot movie) while it runs,
 * then bakes and posts the GalaxyField plus a handful of keyframes —
 * the replay a warm cache plays instead of re-running 13 Gyr.
 */
import { UNIVERSE } from '../physics';
import { runFormation, FORM, FORMATION_VERSION } from './sim';
import { bakeField, type GalaxyField } from './field';
import { catalogDomain, fieldTransferables } from './registry';

/** Movie cadence (sim steps) and subsample size. */
const SNAP_EVERY = 20;
const SNAP_PTS = 24_000;
/** Keyframes kept for the cached replay. */
const KEY_EVERY = 80;
const KEY_PTS = 9000;

export type FormationSnapMsg = {
  type: 'snap';
  frac: number;
  tMyr: number;
  /** [x, y, k] triplets; k < 0 = gas, else stellar age in Myr. */
  pts: Float32Array;
};

export type FormationDoneMsg = {
  type: 'done';
  seed: string;
  version: number;
  field: GalaxyField;
  keyframes: Float32Array[];
  ms: number;
};

const post = self as unknown as {
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

function snapshot(
  count: number,
  step: number,
  px: Float64Array,
  py: Float64Array,
  star: Uint8Array,
  tBirth: Float32Array,
): Float32Array {
  const n = px.length;
  const stride = Math.max(1, Math.floor(n / count));
  const m = Math.floor(n / stride);
  const pts = new Float32Array(m * 3);
  const t = step * FORM.DT;
  for (let j = 0; j < m; j++) {
    const i = j * stride;
    pts[j * 3] = px[i];
    pts[j * 3 + 1] = py[i];
    pts[j * 3 + 2] = star[i] ? Math.max(0, t - tBirth[i]) : -1;
  }
  return pts;
}

self.onmessage = (e: MessageEvent<{ type: 'form'; seed: string }>): void => {
  if (e.data.type !== 'form') return;
  const seed = e.data.seed;
  const t0 = performance.now();
  const keyframes: Float32Array[] = [];
  const result = runFormation(seed, {
    snapEvery: SNAP_EVERY,
    onSnapshot: (step, px, py, star, tBirth) => {
      const pts = snapshot(SNAP_PTS, step, px, py, star, tBirth);
      if (step % KEY_EVERY === 0) keyframes.push(snapshot(KEY_PTS, step, px, py, star, tBirth));
      post.postMessage(
        { type: 'snap', frac: step / FORM.STEPS, tMyr: step * FORM.DT, pts } satisfies FormationSnapMsg,
        [pts.buffer],
      );
    },
  });
  keyframes.push(snapshot(KEY_PTS, FORM.STEPS, result.px, result.py, result.star, result.tBirth));
  const field = bakeField(
    seed,
    FORMATION_VERSION,
    result,
    UNIVERSE.GALAXY_AGE_GYR,
    UNIVERSE.GALAXY_POPULATION,
    UNIVERSE.GALAXY_N_K,
    catalogDomain(),
  );
  post.postMessage(
    {
      type: 'done',
      seed,
      version: FORMATION_VERSION,
      field,
      keyframes,
      ms: performance.now() - t0,
    },
    [...fieldTransferables(field), ...keyframes.map((k) => k.buffer)],
  );
};
