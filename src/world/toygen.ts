import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import { mulberry32, xmur3 } from './rng';

/**
 * Toy onion-world generator. The whole model is one integer per hex column:
 * its level, 0 (bedrock) .. 29 (peak). Color comes purely from the level via
 * the palette gradient; snow and water are altitude thresholds applied at
 * render time, not materials.
 */

// Generation versioning lives at the system level now (systemgen.ts):
// this module is part of that pinned contract — changing its output for a
// given seed requires bumping systemgen's CURRENT_GEN_VERSION.

/** Levels 0..29, bedrock to peak. */
export const LEVEL_COUNT = 30;
export const MAX_LEVEL = LEVEL_COUNT - 1;

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
  0.5, 1.2, 2.5, 3.5, 4.5, 5.5, 6.0, 6.0, // 0-7   deep basins
  5.5, 5.5, 5.5, 5.5,                     // 8-11  shelf rising through sand
  5.5, 5.5,                               // 12-13 waterline: lagoon + beach
  5.0, 4.5, 4.0, 3.5, 3.0,                // 14-18 bright grass
  2.4, 2.0, 1.6, 1.3,                     // 19-22 palm highlands
  1.0, 0.85, 0.7, 0.6, 0.5,               // 23-27 rocky uplands
  0.35, 0.25,                             // 28-29 peaks
];

/**
 * Sea dial (0.35 land .. 0.65 sea, 0.5 default) to water level. The default
 * sits just above the sand band so beaches appear naturally; raising it
 * simply floods greener rings.
 */
export function waterLevelFor(seaLevel: number): number {
  return 12.4 + (seaLevel - 0.5) * 20;
}

/**
 * Temp dial (0 icy .. 1 hot) to snow-line level: tops at or above this level
 * are snow-draped. Icy pulls snow right down to the waterline, temperate
 * frosts the rocky uplands, hot leaves bare peaks.
 */
export function snowLineFor(temp: number, waterLevel: number): number {
  const t = Math.min(1, Math.max(0, temp));
  // Quadratic through (0, waterline), (0.5, upland rock), (1, above peak).
  return waterLevel + 0.5 + 25.1 * t - 7.4 * t * t;
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
  private raw(x: number, y: number, z: number): number {
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

  /** Integer level 0..29 for a unit direction. */
  levelAt(x: number, y: number, z: number): number {
    const v = this.raw(x, y, z);
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
}

export function createToyGenerator(seed: string): ToyGenerator {
  return new ToyGenerator(seed);
}
