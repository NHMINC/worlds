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

/** Movie cadence (sim steps). Every particle is drawn — N is 10k. */
const SNAP_EVERY = 12;
/** Keyframes kept for the cached replay. */
const KEY_EVERY = 48;

export type FormationSnapMsg = {
  type: 'snap';
  frac: number;
  tMyr: number;
  /** [x, y, z, k] quads; k < 0 = gas, else stellar age in Myr. */
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
  step: number,
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  star: Uint8Array,
  tBirth: Float32Array,
): Float32Array {
  const n = px.length;
  const pts = new Float32Array(n * 4);
  const t = step * FORM.DT;
  for (let i = 0; i < n; i++) {
    pts[i * 4] = px[i];
    pts[i * 4 + 1] = py[i];
    pts[i * 4 + 2] = pz[i];
    pts[i * 4 + 3] = star[i] ? Math.max(0, t - tBirth[i]) : -1;
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
    onSnapshot: (step, px, py, pz, star, tBirth) => {
      const pts = snapshot(step, px, py, pz, star, tBirth);
      if (step % KEY_EVERY === 0) keyframes.push(snapshot(step, px, py, pz, star, tBirth));
      post.postMessage(
        { type: 'snap', frac: step / FORM.STEPS, tMyr: step * FORM.DT, pts } satisfies FormationSnapMsg,
        [pts.buffer],
      );
    },
  });
  keyframes.push(snapshot(FORM.STEPS, result.px, result.py, result.pz, result.star, result.tBirth));
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
