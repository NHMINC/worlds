import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import { mulberry32, xmur3 } from './rng';
import type { GeoGrid } from './geodesic';

/**
 * Toy onion-world generator. The whole model is one integer per hex column:
 * its level, 0 (bare bedrock) .. 30 (peak). Level 0 is the unalterable
 * bedrock floor — a column dug to 0 shows bedrock and can go no deeper;
 * levels 1-30 are the world's 30 usable/minable material layers. Color comes
 * purely from the level via the palette gradient; snow and water are
 * altitude thresholds applied at render time, not materials.
 *
 * Noise alone reads as fabric — same feature size everywhere, no feature
 * relating to any other. generateLevels() therefore follows the noise with
 * two cheap PROCESS passes that stamp the statistical signatures of a
 * history onto the columns (not hand-placed shapes — one causal rule each,
 * applied everywhere, seed-deterministic):
 *
 *  - HYDROLOGY. Rain falls on every column, runs downhill (after a
 *    depression fill so every drop can reach the sea) and carves where it
 *    concentrates: dendritic valley networks that wind through many cells,
 *    deepening as tributaries join. Mouths that cut below the waterline
 *    flood into estuaries and inland seas for free, because water is just a
 *    level.
 *
 *  - COASTAL PLAINS. Sediment collects where land meets sea: lowlands near
 *    the shore relax toward the beach terrace, graded gently upward going
 *    inland, gated by a slow noise so some coasts stay cliffy. Long winding
 *    beaches instead of one-cell rims.
 */

// Generation versioning lives at the system level now (systemgen.ts):
// this module is part of that pinned contract — changing its output for a
// given seed requires bumping systemgen's CURRENT_GEN_VERSION.

/** Surface states 0..30: bedrock floor + 30 alterable layers. */
export const LEVEL_COUNT = 31;
export const MAX_LEVEL = LEVEL_COUNT - 1;
/** The unalterable floor: you can dig TO it, never through it. */
export const BEDROCK_LEVEL = 0;

/** Physical fiction: a hex column is ~300 m across, a layer ~60 m thick. */
export const HEX_WIDTH_M = 300;
export const METERS_PER_LEVEL = 60;

/**
 * Target share of the surface at each level — the toy hypsometry. Every
 * world is normalized to (a seeded wobble of) this curve, which guarantees
 * deep basins, a generous sand band around the waterline, rolling green
 * mid-levels, and a few columns reaching the top so there is always
 * something to snow-cap. Normalized at build time; relative weights only.
 */
const TARGET_SHARE = [
  0.2,                                    // 0     bare bedrock: rare abyssal floor
  0.5, 1.2, 2.5, 3.5, 4.5, 5.5, 6.0, 6.0, // 1-8   deep basins
  5.5, 5.5, 5.5, 5.5,                     // 9-12  shelf rising through sand
  5.5, 5.5,                               // 13-14 waterline: lagoon + beach
  5.0, 4.5, 4.0, 3.5, 3.0,                // 15-19 bright grass
  2.4, 2.0, 1.6, 1.3,                     // 20-23 palm highlands
  1.0, 0.85, 0.7, 0.6, 0.5,               // 24-28 rocky uplands
  0.35, 0.25,                             // 29-30 peaks
];

/**
 * Sea dial (0.35 land .. 0.65 sea, 0.5 default) to water level. The default
 * sits just above the sand band so beaches appear naturally; raising it
 * simply floods greener rings.
 */
export function waterLevelFor(seaLevel: number): number {
  return 13.4 + (seaLevel - 0.5) * 20;
}

/**
 * Temp dial (0 icy .. 1 hot) to snow-line level: tops at or above this level
 * are snow-draped. Icy pulls snow right down to the waterline, temperate
 * frosts the rocky uplands, hot leaves bare peaks.
 */
/** The volatile's freeze point on the freeze-anchored snow dial:
 * (WATER_WIN[0] − T_COLD) / (T_HOT − T_COLD). The sea-ice law in the water
 * shader hardens the sea below this value; the snow line must MEET the
 * waterline here so land and sea freeze in agreement. */
export const FREEZE_DIAL = 0.285;

/**
 * Altitude above which snow settles, or Infinity when it cannot settle at
 * all. `snow` is the body's 0..1 deposition capacity from the physics
 * (reservoir × precipitation cycle): a weak cycle pushes the line up so
 * frost survives only at the coldest spots, and below a threshold nothing
 * ever falls. ANCHORED to the volatile's freeze point: at FREEZE_DIAL the
 * line sits at the waterline (where the sea freezes over, coastal land
 * whitens too — one isotherm, two surfaces), and it climbs as the local
 * temperature exceeds it. Mirrored in GLSL in terraceMesh.ts; keep in sync.
 */
export function snowLineFor(temp: number, waterLevel: number, snow = 1): number {
  if (snow < 0.15) return Number.POSITIVE_INFINITY;
  // Renormalize so 0 = freeze point, 1 = dial top.
  const t = Math.min(1, Math.max(0, (temp - FREEZE_DIAL) / (1 - FREEZE_DIAL)));
  // Quadratic through (freeze, waterline), (mid, upland rock), plus a
  // hot-end term that lifts the line clear of ANY peak: scorched worlds and
  // eyeball daysides must never wear snow, whatever their sea level.
  return (
    waterLevel + 0.5 + 25.1 * t - 7.4 * t * t + 40 * Math.max(0, t - 0.75) + 8 * (1 - snow)
  );
}

export class ToyGenerator {
  private readonly base: NoiseFunction3D;
  private readonly detail: NoiseFunction3D;
  private readonly ridgeN: NoiseFunction3D;
  private readonly maskN: NoiseFunction3D;
  /** Seed personality. */
  private readonly contFreq: number;
  private readonly ridgeFreq: number;
  private readonly ridgeAmp: number;
  private readonly detailAmp: number;
  /** Raw-value cut points between levels (length LEVEL_COUNT - 1), ascending. */
  private readonly cuts: Float64Array;

  constructor(seed: string) {
    const hash = xmur3(seed);
    const rng = mulberry32(hash());
    this.base = createNoise3D(mulberry32(hash()));
    this.detail = createNoise3D(mulberry32(hash()));
    this.ridgeN = createNoise3D(mulberry32(hash()));
    this.maskN = createNoise3D(mulberry32(hash()));
    this.contFreq = 1.1 + rng() * 0.9;
    this.ridgeFreq = 2.2 + rng() * 1.6;
    this.ridgeAmp = 0.45 + rng() * 0.55;
    this.detailAmp = 0.3 + rng() * 0.3;

    // Seeded wobble on the target hypsometry so worlds differ in character
    // (more ocean, broader highlands...) while keeping the guarantees.
    const share = TARGET_SHARE.map((s) => s * (0.7 + rng() * 0.6));

    // Percentile-normalize: sample the raw field over the sphere, sort, and
    // read the cut points straight off the target cumulative distribution.
    const K = 4096;
    const samples = new Float64Array(K);
    for (let i = 0; i < K; i++) {
      const z = 2 * rng() - 1;
      const a = 2 * Math.PI * rng();
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      samples[i] = this.raw(r * Math.cos(a), r * Math.sin(a), z);
    }
    samples.sort();
    const total = share.reduce((a, b) => a + b, 0);
    this.cuts = new Float64Array(LEVEL_COUNT - 1);
    let acc = 0;
    for (let l = 0; l < LEVEL_COUNT - 1; l++) {
      acc += share[l] / total;
      this.cuts[l] = samples[Math.min(K - 1, Math.floor(acc * K))];
    }
  }

  /** Unnormalized elevation field: continents + ridged ranges + detail. */
  raw(x: number, y: number, z: number): number {
    const fc = this.contFreq;
    let e = this.base(x * fc, y * fc, z * fc);
    e += 0.5 * this.base(x * fc * 2.1 + 7.3, y * fc * 2.1 + 1.9, z * fc * 2.1 + 4.2);
    e += this.detailAmp * this.detail(x * fc * 4.3, y * fc * 4.3, z * fc * 4.3);
    e += 0.5 * this.detailAmp * this.detail(x * fc * 8.9 + 11.1, y * fc * 8.9 + 3.7, z * fc * 8.9 + 6.4);
    // Ridged mountain chains, gated by a slow mask so they come in ranges.
    const fr = this.ridgeFreq;
    const r = 1 - Math.abs(this.ridgeN(x * fr, y * fr, z * fr));
    const mask = Math.max(0, this.maskN(x * 0.9 + 3.1, y * 0.9 + 8.7, z * 0.9 + 2.3));
    e += this.ridgeAmp * r * r * mask;
    return e;
  }

  /** Integer level 0..30 for a raw field value. */
  levelFor(v: number): number {
    // Binary search the cut points (cuts[l] is the top of level l).
    let lo = 0;
    let hi = LEVEL_COUNT - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v < this.cuts[mid]) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** Integer level 0..30 for a unit direction. */
  levelAt(x: number, y: number, z: number): number {
    return this.levelFor(this.raw(x, y, z));
  }
}

export function createToyGenerator(seed: string): ToyGenerator {
  return new ToyGenerator(seed);
}

// ---------------------------------------------------------------- landforms

/** Ocean at the default waterline (13.4): columns at or below this level. */
const OCEAN_TOP = Math.floor(waterLevelFor(0.5));

const HYDRO = {
  /** Drainage area (fraction of all columns) where a river starts to carve. */
  RIVER_THRESH: 0.0012,
  /** Levels carved per e-fold of drainage beyond the threshold. */
  CARVE_K: 1.15,
  /** Deepest river cut, in levels. */
  MAX_CARVE: 4,
  /** Coastal plain reach, in rings of columns from the shore. */
  PLAIN_RINGS: 5,
  /** Plains relax toward this level (the first dry terrace). */
  BEACH_LEVEL: OCEAN_TOP + 1,
  /** Land above this level is never plained flat (cliff coasts stay). */
  PLAIN_CEILING: 22,
};

/** Min-heap of cell ids keyed by an external score array. */
function heapPush(heap: number[], key: Float64Array, v: number): void {
  heap.push(v);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (key[heap[p]] <= key[heap[i]]) break;
    const t = heap[p];
    heap[p] = heap[i];
    heap[i] = t;
    i = p;
  }
}

function heapPop(heap: number[], key: Float64Array): number {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && key[heap[l]] < key[heap[m]]) m = l;
      if (r < heap.length && key[heap[r]] < key[heap[m]]) m = r;
      if (m === i) break;
      const t = heap[m];
      heap[m] = heap[i];
      heap[i] = t;
      i = m;
    }
  }
  return top;
}

/**
 * Hydrology: rain on every column runs downhill and carves where it
 * concentrates. Flow is routed on the CONTINUOUS field (no flats to break
 * ties on), after a priority-flood depression fill seeded from the ocean so
 * every drop has a monotone path to the sea. Carve depth grows with the
 * log of drainage area — tributaries nick, trunks cut gorges — and mouths
 * that dip below the waterline become estuaries by themselves.
 */
function carveRivers(grid: GeoGrid, levels: Uint8Array, raw: Float64Array): void {
  const n = grid.count;
  const EPS = 1e-7;

  // Priority-flood fill (Barnes et al.): pop the lowest frontier cell,
  // raise unseen neighbors to at least its height plus a nudge.
  const filled = new Float64Array(n);
  const seen = new Uint8Array(n);
  const heap: number[] = [];
  for (let i = 0; i < n; i++) {
    if (levels[i] <= OCEAN_TOP) {
      filled[i] = raw[i];
      seen[i] = 1;
      heapPush(heap, filled, i);
    }
  }
  if (heap.length === 0) return; // no ocean, no drainage (all-land iceball)
  while (heap.length > 0) {
    const u = heapPop(heap, filled);
    const deg = grid.degree(u);
    for (let k = 0; k < deg; k++) {
      const v = grid.neighbors[u * 6 + k];
      if (seen[v]) continue;
      seen[v] = 1;
      filled[v] = Math.max(raw[v], filled[u] + EPS);
      heapPush(heap, filled, v);
    }
  }

  // Steepest descent on the filled surface; every land cell has one.
  const down = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (levels[i] <= OCEAN_TOP) continue;
    let best = -1;
    let bestF = filled[i];
    const deg = grid.degree(i);
    for (let k = 0; k < deg; k++) {
      const v = grid.neighbors[i * 6 + k];
      if (filled[v] < bestF) {
        bestF = filled[v];
        best = v;
      }
    }
    down[i] = best;
  }

  // Accumulate drainage from high to low, then carve.
  const order = Array.from({ length: n }, (_, i) => i)
    .filter((i) => down[i] >= 0)
    .sort((a, b) => filled[b] - filled[a]);
  const acc = new Float64Array(n).fill(1);
  for (const u of order) acc[down[u]] += acc[u];
  const thresh = Math.max(8, n * HYDRO.RIVER_THRESH);
  for (const u of order) {
    if (acc[u] <= thresh) continue;
    const depth = Math.min(HYDRO.MAX_CARVE, HYDRO.CARVE_K * Math.log(acc[u] / thresh));
    const carved = levels[u] - Math.round(depth);
    levels[u] = Math.max(1, carved);
  }
}

/**
 * Coastal plains: lowlands within a few rings of the shore relax toward the
 * beach terrace, graded one level up per two rings inland. A slow noise
 * gates the effect so some coasts stay cliffy. Only ever LOWERS a column,
 * so river cuts crossing a plain survive as channels.
 */
function spreadCoastalPlains(grid: GeoGrid, levels: Uint8Array, seed: string): void {
  const n = grid.count;
  const gate = createNoise3D(mulberry32(xmur3(`${seed}:coast`)()));

  // Ring distance from the shore, land side only.
  const dist = new Int16Array(n).fill(-1);
  let ring: number[] = [];
  for (let i = 0; i < n; i++) {
    if (levels[i] <= OCEAN_TOP) continue;
    const deg = grid.degree(i);
    for (let k = 0; k < deg; k++) {
      if (levels[grid.neighbors[i * 6 + k]] <= OCEAN_TOP) {
        dist[i] = 0;
        ring.push(i);
        break;
      }
    }
  }
  for (let d = 0; d < HYDRO.PLAIN_RINGS && ring.length > 0; d++) {
    const next: number[] = [];
    for (const u of ring) {
      const deg = grid.degree(u);
      for (let k = 0; k < deg; k++) {
        const v = grid.neighbors[u * 6 + k];
        if (dist[v] >= 0 || levels[v] <= OCEAN_TOP) continue;
        dist[v] = d + 1;
        next.push(v);
      }
    }
    ring = next;
  }

  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d < 0 || levels[i] > HYDRO.PLAIN_CEILING) continue;
    const g = gate(grid.centers[i * 3] * 1.4, grid.centers[i * 3 + 1] * 1.4, grid.centers[i * 3 + 2] * 1.4);
    const s = Math.min(1, Math.max(0, g * 1.6 + 0.5));
    if (s <= 0) continue;
    const pull = s * (1 - d / (HYDRO.PLAIN_RINGS + 1));
    const target = HYDRO.BEACH_LEVEL + (d >> 1);
    const flattened = Math.round(levels[i] + (target - levels[i]) * pull);
    if (flattened < levels[i]) levels[i] = flattened;
  }
}

/**
 * The full level field for a body: noise, quantized to the hypsometry,
 * then the two process passes. Deterministic in (seed, grid).
 */
export function generateLevels(seed: string, grid: GeoGrid): Uint8Array {
  const gen = new ToyGenerator(seed);
  const n = grid.count;
  const levels = new Uint8Array(n);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] = gen.raw(grid.centers[i * 3], grid.centers[i * 3 + 1], grid.centers[i * 3 + 2]);
    levels[i] = gen.levelFor(raw[i]);
  }
  carveRivers(grid, levels, raw);
  spreadCoastalPlains(grid, levels, seed);
  return levels;
}

/**
 * Basin fetch: waves need open water to grow, so each connected underwater
 * region is flood-filled, sized, and mapped onto a 0..255 swell capacity —
 * ponds stay glassy, inland seas take a modest chop, oceans the full sea
 * state. Land near a shore inherits its sea's fetch (two rings, max) so the
 * swash knows how hard to run up the beach. Runs on the FINAL level field
 * (player edits included), never changes levels — no gen-version cost.
 */
export function basinFetch(grid: GeoGrid, levels: Uint8Array, waterLevel: number): Uint8Array {
  const n = grid.count;
  const top = Math.floor(waterLevel);
  const basin = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (levels[i] > top || basin[i] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    basin[i] = id;
    stack.push(i);
    while (stack.length > 0) {
      const u = stack.pop()!;
      size++;
      const deg = grid.degree(u);
      for (let k = 0; k < deg; k++) {
        const v = grid.neighbors[u * 6 + k];
        if (basin[v] < 0 && levels[v] <= top) {
          basin[v] = id;
          stack.push(v);
        }
      }
    }
    sizes.push(size);
  }
  // Area → fetch: a log ramp that saturates on true oceans (~7% of the
  // sphere). A 25-column pond sits near zero; a hemispheric sea near one.
  const full = Math.max(64, n * 0.07);
  const f01 = (area: number) => Math.min(1, Math.log(1 + area / 24) / Math.log(1 + full / 24));
  const fetch = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (basin[i] >= 0) fetch[i] = Math.round(255 * f01(sizes[basin[i]]));
  }
  for (let pass = 0; pass < 2; pass++) {
    const prev = fetch.slice();
    for (let i = 0; i < n; i++) {
      if (basin[i] >= 0) continue;
      let best = prev[i];
      const deg = grid.degree(i);
      for (let k = 0; k < deg; k++) {
        const f = prev[grid.neighbors[i * 6 + k]];
        if (f > best) best = f;
      }
      fetch[i] = best;
    }
  }
  return fetch;
}

/**
 * ONE temperature law: the local surface temperature is time-averaged
 * insolation. Free spinners average over their day, so temperature falls
 * with latitude (equator hot, poles cold). Worlds locked to their star
 * average nothing: temperature falls with angular distance from the fixed
 * substellar point (+X in the body frame) — eyeball worlds emerge, no
 * special case. Mirrored in GLSL in terraceMesh.ts; keep the two in sync.
 */
export function insolationAt(x: number, _y: number, z: number, lockedToStar: boolean): number {
  if (lockedToStar) return x; // cos(angle from substellar), -1..1
  const cosLat = Math.sqrt(Math.max(0, 1 - z * z));
  return (cosLat - 0.785) * 1.6; // zero-mean over the sphere, ~-1.26..0.34
}

/** Local temperature dial from the body dial + the insolation field. */
export function localTemp01(base: number, span: number, insol: number): number {
  return Math.min(1, Math.max(0, base + span * insol));
}
