import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import { mulberry32, xmur3 } from './rng';
import { ELEMENTS, type BodyPhysics, type Composition, type Element } from './physics';
import { BEDROCK_LEVEL, MAX_LEVEL } from './toygen';

/**
 * Per-hex, per-layer geology: elementsAt(direction, layer) is a pure
 * deterministic function — nothing is stored until somebody digs. Each hex
 * prism is a stack of 30 addressable segments (layer 1 at bedrock's doorstep
 * up to layer 30 at the peak), each with real contents:
 *
 *  - the CRUST partition of the body's elemental inventory is the baseline
 *    (same single source of truth as the atmosphere and ocean);
 *  - seeded 3D vein noise concentrates ores into lodes that snake through
 *    the rock in three dimensions;
 *  - depth modulates: metals sink toward bedrock (they came from the core's
 *    neighborhood), salts and sediments collect around the waterline, and
 *    living worlds lace their topsoil with organics.
 *
 * Layer 0 is bedrock: unalterable, unminable, reported as such.
 */

export interface ElementShare {
  element: Element;
  /** Mass share of this segment, 0..1. */
  share: number;
}

/** Elements that form veins rather than spreading evenly. */
const VEIN_ELEMENTS: ReadonlyArray<Element> = ['Fe', 'Ni', 'Ti', 'U', 'S'];

export class Geology {
  private readonly crust: Composition;
  private readonly life: boolean;
  private readonly waterLevel: number;
  private readonly veins: Partial<Record<Element, NoiseFunction3D>>;

  constructor(bodySeed: string, physics: BodyPhysics, waterLevel: number) {
    this.crust = physics.crust;
    this.life = physics.life;
    this.waterLevel = waterLevel;
    const hash = xmur3(`${bodySeed}:geology`);
    this.veins = {};
    for (const e of VEIN_ELEMENTS) {
      this.veins[e] = createNoise3D(mulberry32(hash()));
    }
  }

  /**
   * Composition of one hex segment: unit direction (x, y, z) of the column,
   * layer 1..30. Layer 0 (bedrock) returns an empty list — impenetrable.
   * Sorted by share, descending; minor traces (< 0.5%) are folded away.
   */
  at(x: number, y: number, z: number, layer: number): ElementShare[] {
    if (layer <= BEDROCK_LEVEL || layer > MAX_LEVEL) return [];
    const depth = 1 - layer / MAX_LEVEL; // 0 peak .. ~1 bedrock

    const out: Array<{ element: Element; w: number }> = [];
    for (const e of ELEMENTS) {
      let w = this.crust[e];
      if (w <= 0) continue;

      // Vein noise: ridged, so lodes come as sheets and snakes, richer with
      // depth. The layer coordinate stretches the field vertically so a
      // lode has thickness.
      const vein = this.veins[e];
      if (vein) {
        const r = 1 - Math.abs(vein(x * 5.5, y * 5.5, z * 5.5 + layer * 0.35));
        const lode = Math.pow(r, 5) * 7; // sparse, rich when hit
        w *= 0.35 + lode + 1.9 * depth * depth;
      }

      // Salts and sediments collect around the waterline (old shorelines,
      // evaporites).
      if (e === 'Na' || e === 'Cl' || e === 'K') {
        const d = (layer - this.waterLevel) / 3;
        w *= 1 + 4 * Math.exp(-d * d);
      }

      // Living worlds lace the topsoil with organic carbon.
      if (e === 'C' && this.life && layer > this.waterLevel) {
        const top = Math.max(0, 1 - (MAX_LEVEL - layer) / 6);
        w *= 1 + 6 * top;
      }

      out.push({ element: e, w });
    }

    let total = 0;
    for (const o of out) total += o.w;
    if (total <= 0) return [];
    return out
      .map((o) => ({ element: o.element, share: o.w / total }))
      .filter((o) => o.share >= 0.005)
      .sort((a, b) => b.share - a.share);
  }
}

const geologyCache = new Map<string, Geology>();

/** Shared per-body geology (pure function of seed + physics, cached). */
export function geologyFor(bodySeed: string, physics: BodyPhysics, waterLevel: number): Geology {
  const key = `${bodySeed}:${waterLevel.toFixed(2)}`;
  let g = geologyCache.get(key);
  if (!g) {
    g = new Geology(bodySeed, physics, waterLevel);
    geologyCache.set(key, g);
    if (geologyCache.size > 24) {
      const first = geologyCache.keys().next().value;
      if (first) geologyCache.delete(first);
    }
  }
  return g;
}
