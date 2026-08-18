/**
 * Hashing for the bottle — not a dice bag.
 *
 * Universe construction is `f(seed, address)`. Prefer a stateless
 * hash (`hashHex`, `xmur3` once, `hash(seed, i, salt)`). Do not use
 * `Math.random`, `crypto`, or a walking `mulberry32` stream for the
 * catalog, a system, terrain, dust, or the cosmic photograph.
 * `mulberry32` remains only for leftover generators that already
 * drink a stream; do not add new draws. `randomSeedString` / `uuid`
 * are player/listen labels, not the sky.
 */
/** Hash a string to a sequence of 32-bit seeds (xmur3). */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** Fast deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless integer hash of a hex coordinate, in [0, 1). */
export function hashHex(level: number, q: number, r: number, salt: number): number {
  let h = salt | 0;
  h = Math.imul(h ^ level, 0x9e3779b1);
  h = Math.imul(h ^ q, 0x85ebca6b);
  h = Math.imul(h ^ r, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export function randomSeedString(): string {
  const words = [
    'amber', 'brook', 'cinder', 'dawn', 'ember', 'fern', 'gale', 'haze',
    'iris', 'juniper', 'kelp', 'lumen', 'moss', 'nimbus', 'opal', 'pine',
    'quartz', 'reed', 'sage', 'tide', 'umber', 'vale', 'willow', 'zephyr',
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 1000)}`;
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
