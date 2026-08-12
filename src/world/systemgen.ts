import { mulberry32, xmur3 } from './rng';

/**
 * The star system generator: one root seed deterministically unfolds into a
 * star, 4-15 planets, and their moons, obeying tiny-world physics — inner
 * planets are hot, dry, fast, and possibly tidally locked; the habitable band
 * is generously stocked with water worlds (a deliberate rule of the tiny
 * worlds universe); the outer disk is mostly gas giants with an icy dwarf
 * chance at the rim. Every rocky body's terrain seed is a hash of the system
 * seed and its slot, so the whole universe is addressable: (systemSeed,
 * bodyId, cell) names a permanent piece of ground.
 *
 * This module is part of the versioned generation contract: any change to
 * its output for a given seed requires bumping CURRENT_GEN_VERSION and
 * keeping the old behavior available for systems pinned to it.
 */

export const CURRENT_GEN_VERSION = 7;

export type RGB = [number, number, number];

export type BodyKind = 'rocky' | 'gas';

export interface GasSpec {
  /** Band color stops, pole to pole-ish, pastel. */
  colors: RGB[];
  /** Latitude frequency of the bands. */
  bandFreq: number;
  /** Storm oval: latitude (radians from equator) and seeded phase. */
  stormLat: number;
  stormPhase: number;
  ring: boolean;
  ringTilt: number;
  ringColor: RGB;
}

export interface BodySpec {
  /** Stable address: 'p3' for planets, 'p3m1' for moons. Never changes. */
  id: string;
  name: string;
  kind: BodyKind;
  /** Terrain seed (rocky bodies): hash of system seed + slot. */
  seed: string;
  /** GL radius (water surface for rocky bodies). The home scale is ~1. */
  radius: number;
  /** Orbit around the parent (sun for planets, planet for moons). */
  orbitRadius: number;
  orbitPeriod: number;
  orbitPhase: number;
  /** Sidereal day, seconds. Equals orbitPeriod when tidally locked. */
  spinPeriod: number;
  tidallyLocked: boolean;
  /** null = orbits the sun; else a planet id. */
  parent: string | null;
  /** Rocky only: toy-world dials (physics-derived defaults). */
  size?: number;
  temp?: number;
  seaLevel?: number;
  /** Gas only. */
  gas?: GasSpec;
  /** Tier-0 sphere color (seeded mean of the surface). */
  meanColor: RGB;
}

export interface StarSpec {
  name: string;
  radius: number;
  /** Photosphere and halo tint. */
  color: string;
  /** Light color for lit siblings. */
  lightColor: string;
}

export interface SystemSpec {
  seed: string;
  star: StarSpec;
  /** All bodies, planets in orbit order, each planet's moons right after it. */
  bodies: BodySpec[];
}

// ---------------------------------------------------------------- helpers

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** hsl → rgb, all in [0,1]; for seeded pastel palettes. */
function hsl(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];
const MOON_SUFFIX = ['a', 'b', 'c', 'd'];

const NAME_A = ['Ka', 'Sera', 'Tor', 'Ael', 'Mira', 'Or', 'Va', 'Nyx', 'Cal', 'Zephy', 'Bel', 'Dra', 'Elo', 'Fen', 'Ino', 'Lu', 'Oshi', 'Thal'];
const NAME_B = ['ra', 'lin', 'dor', 'mia', 'vos', 'the', 'ri', 'sa', 'no', 'lia', 'run', 'dis', 'wen', 'mar'];
const NAME_C = ['', '', '', 's', 'n', 'th', 'x', 'm'];

function starName(rng: () => number): string {
  const pick = (arr: string[]) => arr[Math.floor(rng() * arr.length)];
  return pick(NAME_A) + pick(NAME_B) + pick(NAME_C);
}

/** Weighted planet count: accretion always delivers 4-15, usually 7-9. */
function planetCount(rng: () => number): number {
  const weights = [2, 4, 7, 10, 12, 12, 10, 7, 5, 3, 2, 1]; // counts 4..15
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return 4 + i;
  }
  return 8;
}

/** Approximate surface mean color for the tier-0 ball, from the dials. */
function rockyMeanColor(temp: number, sea: number): RGB {
  const sand: RGB = [0.85, 0.74, 0.52];
  const green: RGB = [0.4, 0.74, 0.44];
  const ice: RGB = [0.88, 0.92, 0.96];
  let land: RGB;
  if (temp < 0.25) land = mix(ice, green, temp / 0.25);
  else if (temp > 0.75) land = mix(green, sand, (temp - 0.75) / 0.25);
  else land = green;
  const water: RGB = [0.18, 0.55, 0.72];
  const waterFrac = clamp01((sea - 0.05) * 1.6) * 0.6;
  return mix(land, water, waterFrac);
}

// ---------------------------------------------------------------- generator

export function generateSystem(seed: string): SystemSpec {
  const rng = mulberry32(xmur3(`system:${seed}`)());

  // --- the star ---
  const starRoll = rng();
  const star: StarSpec =
    starRoll < 0.5
      ? { name: starName(rng), radius: 4.6 + rng() * 1.2, color: '#fff1c4', lightColor: '#fff4dc' } // G, warm
      : starRoll < 0.82
        ? { name: starName(rng), radius: 4.0 + rng() * 1.0, color: '#ffd9a0', lightColor: '#ffe2b8' } // K, orange
        : { name: starName(rng), radius: 5.2 + rng() * 1.4, color: '#f4f6ff', lightColor: '#eef2ff' }; // F, bright

  // --- orbital skeleton: geometric accretion spacing, Kepler periods ---
  const N = planetCount(rng);
  const A0 = 16;
  const A_MAX = 210;
  const k = Math.min(1.8, Math.max(1.22, Math.pow(A_MAX / A0, 1 / Math.max(1, N - 1))));

  const bodies: BodySpec[] = [];
  const scorchCount = N >= 8 ? 2 : 1;

  // First pass: decide each planet's kind so we can guarantee a gas giant.
  const kinds: Array<'scorched' | 'temperate' | 'dry' | 'gas' | 'ice'> = [];
  for (let i = 0; i < N; i++) {
    const s = N > 1 ? i / (N - 1) : 0;
    if (i < scorchCount) kinds.push('scorched');
    else if (s <= 0.55) kinds.push(rng() < 0.8 ? 'temperate' : 'dry'); // habitable bias
    else kinds.push(rng() < 0.65 ? 'gas' : 'ice');
  }
  if (N >= 5 && !kinds.includes('gas')) kinds[N - 2] = 'gas';
  // The rim, if rocky, is an icy dwarf.
  if (kinds[N - 1] !== 'gas') kinds[N - 1] = 'ice';

  for (let i = 0; i < N; i++) {
    const zone = kinds[i];
    const s = N > 1 ? i / (N - 1) : 0;
    const id = `p${i}`;
    const bodySeed = `${seed}:${id}`;
    const a = A0 * Math.pow(k, i) * (0.96 + rng() * 0.08);
    const period = 240 * Math.pow(a / A0, 1.5);
    const phase = rng() * 2 * Math.PI;
    const name = `${star.name} ${ROMAN[i]}`;

    if (zone === 'gas') {
      const radius = 2.0 + rng() * 1.7;
      const hue = rng();
      const bandCount = 5 + Math.floor(rng() * 4);
      const colors: RGB[] = [];
      for (let b = 0; b < bandCount; b++) {
        const drift = (rng() - 0.5) * 0.09;
        const light = b % 2 === 0 ? 0.74 + rng() * 0.08 : 0.58 + rng() * 0.08;
        colors.push(hsl((hue + drift + 1) % 1, 0.38 + rng() * 0.18, light));
      }
      const gas: GasSpec = {
        colors,
        bandFreq: 2.2 + rng() * 1.6,
        stormLat: (rng() - 0.5) * 1.0,
        stormPhase: rng() * 2 * Math.PI,
        ring: rng() < 0.45,
        ringTilt: 0.9 + rng() * 0.5,
        ringColor: hsl((hue + 0.08) % 1, 0.3, 0.78),
      };
      bodies.push({
        id, name, kind: 'gas', seed: bodySeed, radius,
        orbitRadius: a, orbitPeriod: period, orbitPhase: phase,
        spinPeriod: 40 + rng() * 50, tidallyLocked: false, parent: null,
        gas, meanColor: colors[0],
      });
    } else {
      // Rocky: climate defaults fall out of the orbit (with seeded jitter).
      let temp: number;
      let sea: number;
      let size: number;
      if (zone === 'scorched') {
        temp = 0.92 + rng() * 0.08;
        sea = rng() * 0.1;
        size = 25 + Math.round(rng() * 30);
      } else if (zone === 'temperate') {
        const hab = clamp01((s - scorchCount / Math.max(1, N - 1)) / Math.max(0.08, 0.55 - scorchCount / Math.max(1, N - 1)));
        temp = clamp01(0.75 - 0.5 * hab + (rng() - 0.5) * 0.16);
        sea = 0.4 + rng() * 0.2;
        size = 45 + Math.round(rng() * 55);
      } else if (zone === 'dry') {
        temp = clamp01(0.6 - 0.3 * s + (rng() - 0.5) * 0.2);
        sea = 0.05 + rng() * 0.13;
        size = 35 + Math.round(rng() * 40);
      } else {
        // ice
        temp = 0.02 + rng() * 0.14;
        sea = 0.35 + rng() * 0.15;
        size = 20 + Math.round(rng() * 20);
      }
      const radius = 0.5 + 0.62 * (size / 100);
      const locked = zone === 'scorched';
      bodies.push({
        id, name, kind: 'rocky', seed: bodySeed, radius,
        orbitRadius: a, orbitPeriod: period, orbitPhase: phase,
        spinPeriod: locked ? period : 90 + rng() * 110, tidallyLocked: locked, parent: null,
        size, temp, seaLevel: sea, meanColor: rockyMeanColor(temp, sea),
      });
    }

    // --- moons, by toy astrophysics: the star's tides forbid them close in,
    // gas giants collect the most, everything is tidally locked to its parent.
    const parent = bodies[bodies.length - 1];
    let moonCount = 0;
    if (zone === 'scorched') moonCount = 0;
    else if (zone === 'gas') moonCount = 1 + Math.floor(rng() * Math.min(3.5, parent.radius));
    else if (zone === 'temperate' || zone === 'dry') moonCount = rng() < 0.45 ? 1 : 0;
    else {
      const r = rng();
      moonCount = r < 0.4 ? 1 : r < 0.55 ? 2 : 0;
    }
    for (let j = 0; j < moonCount; j++) {
      const mid = `${id}m${j}`;
      const msize = 15 + Math.round(rng() * 15);
      const mradius = Math.max(0.16, parent.radius * (0.22 + rng() * 0.18));
      // Cold out in space, colder for outer parents; wet enough for icy seas.
      const baseTemp = zone === 'gas' || zone === 'ice' ? 0.05 + rng() * 0.2 : Math.max(0.02, (parent.temp ?? 0.4) - 0.1 - rng() * 0.15);
      const msea = zone === 'dry' ? 0.05 + rng() * 0.15 : 0.3 + rng() * 0.2;
      const morb = parent.radius * (2.8 + 2.2 * j) + rng() * parent.radius;
      const mper = 40 + 50 * j + rng() * 30;
      bodies.push({
        id: mid,
        name: `${name}${MOON_SUFFIX[j] ?? j}`,
        kind: 'rocky',
        seed: `${seed}:${mid}`,
        radius: mradius,
        orbitRadius: morb,
        orbitPeriod: mper,
        orbitPhase: rng() * 2 * Math.PI,
        spinPeriod: mper, // every real moon: locked
        tidallyLocked: true,
        parent: id,
        size: msize,
        temp: baseTemp,
        seaLevel: msea,
        meanColor: rockyMeanColor(baseTemp, msea),
      });
    }
  }

  return { seed, star, bodies };
}

/** The "home" body a fresh system opens on: the most habitable planet. */
export function homeBodyId(spec: SystemSpec): string {
  let best: BodySpec | null = null;
  let bestScore = -Infinity;
  for (const b of spec.bodies) {
    if (b.kind !== 'rocky' || b.parent) continue;
    const t = b.temp ?? 0.5;
    const sea = b.seaLevel ?? 0;
    const score = 1 - Math.abs(t - 0.45) * 2 + (sea > 0.3 ? 0.5 : 0) - (sea < 0.15 ? 0.4 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return (best ?? spec.bodies[0]).id;
}

export function bodyById(spec: SystemSpec, id: string): BodySpec | undefined {
  return spec.bodies.find((b) => b.id === id);
}
