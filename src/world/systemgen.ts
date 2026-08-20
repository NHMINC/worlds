import { mulberry32, xmur3 } from './rng';
import {
  UNIVERSE, classify, gasColor, gasPhysics, hazeSpec, rockyPhysics, type BodyPhysics,
} from './physics';
import { objectAt, type GalaxyObject } from './galaxy';
import { rgbToHex, teffToRgb, type StellarState } from './stellar';

/**
 * The star system generator: one root seed deterministically unfolds into a
 * star, 4-15 planets, and their moons, all obeying the bottle universe's
 * physics (see physics.ts and its charter). Orbits are AU, radii km.
 * The generator lays down the
 * orbital skeleton — geometric accretion spacing, Kepler periods, seeded
 * eccentricity and inclination, a tidal-locking law — and the physics module
 * derives everything else (gravity, atmosphere, oceans, palettes) from each
 * body's elemental inventory. Archetypes are outputs, never inputs.
 *
 * Every rocky body's terrain seed is a hash of the system seed and its slot,
 * so the whole universe is addressable: (systemSeed, bodyId, cell) names a
 * permanent piece of ground.
 *
 * This module is part of the versioned generation contract: any change to
 * its output for a given seed requires bumping CURRENT_GEN_VERSION and
 * keeping the old behavior available for systems pinned to it.
 */

export const CURRENT_GEN_VERSION = 16;

export type RGB = [number, number, number];

export type BodyKind = 'rocky' | 'gas';

export interface GasSpec {
  /** Disk color from chemistry (physics.gasColor). No weather yet. */
  color: RGB;
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
  /** Radius in km (water surface for rocky bodies). Earth is R_HOME. */
  radius: number;
  /** Orbit around the parent: AU for planets, km for moons. */
  orbitRadius: number;
  orbitPeriod: number;
  orbitPhase: number;
  /** Keplerian elements: eccentricity, inclination, node, arg of periapsis.
   * Moons are circular (tidal circularization) in the parent's equator. */
  ecc: number;
  inc: number;
  node: number;
  peri: number;
  /** Axial tilt (radians) and the ecliptic azimuth its axis leans toward.
   * Locked bodies are tide-damped to zero. */
  obliquity: number;
  axialAz: number;
  /** Sidereal day, seconds. Equals orbitPeriod when tidally locked. */
  spinPeriod: number;
  tidallyLocked: boolean;
  /** null = orbits the sun; else a planet id. */
  parent: string | null;
  /** Physics-derived body model (both kinds). */
  physics: BodyPhysics;
  /** Rocky only: toy-world dials (physics-derived defaults). */
  size?: number;
  temp?: number;
  seaLevel?: number;
  /** Gas only. */
  gas?: GasSpec;
  /** Tier-0 sphere color (seeded mean of the surface, or the haze deck). */
  meanColor: RGB;
}

export interface StarSpec {
  name: string;
  /** Photosphere radius in km. */
  radius: number;
  /** Mass in solar units — Kepler periods. */
  mass: number;
  /** Photosphere and halo tint. */
  color: string;
  /** Light color for lit siblings. */
  lightColor: string;
  /** Luminosity (rel sun) and metallicity (rel solar): the disk's chemistry. */
  luminosity: number;
  metallicity: number;
  /** Disk C/O ratio relative to solar: > 1 deals carbon worlds. */
  carbon: number;
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

/** Seeded obliquity: most worlds lean a little, a rare one lies sideways. */
function rollObliquity(rng: () => number): number {
  const r = rng();
  if (r < 0.15) return rng() * 0.035; // near-upright
  if (r < 0.95) return (2 + rng() * 26) * (Math.PI / 180); // 2-28°
  return (50 + rng() * 48) * (Math.PI / 180); // the Uranus oddball
}

// ---------------------------------------------------------------- orbits

/** Inner / outer accretion rim, AU. Geometric spacing fills the ladder. */
const A0 = 0.35;
const A_MAX = 30;
const FROST_AU = 2.7;

function keplerPlanetSec(aAu: number, massSun: number): number {
  return UNIVERSE.SEC_YEAR * Math.pow(Math.max(0.02, aAu), 1.5) / Math.sqrt(Math.max(0.08, massSun));
}

function bodyMassKg(radiusKm: number, densityRel: number): number {
  const r = radiusKm * 1000;
  return densityRel * UNIVERSE.RHO_EARTH * (4 / 3) * Math.PI * r * r * r;
}

function keplerMoonSec(aKm: number, parentMassKg: number): number {
  const a = Math.max(1e3, aKm) * 1000;
  const mu = UNIVERSE.G_SI * Math.max(1e18, parentMassKg);
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}

/** In-plane Kepler pose (AU for planets, km for moons). One law, two viewers. */
export function keplerPlane(
  orbitRadius: number,
  orbitPeriod: number,
  orbitPhase: number,
  ecc: number,
  t: number,
): { xo: number; yo: number } {
  const P = Math.max(1e-6, orbitPeriod);
  if (ecc > 0) {
    const M = orbitPhase + (2 * Math.PI * t) / P;
    let E = M + ecc * Math.sin(M);
    for (let i = 0; i < 3; i++) {
      E -= (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
    }
    return {
      xo: orbitRadius * (Math.cos(E) - ecc),
      yo: orbitRadius * Math.sqrt(1 - ecc * ecc) * Math.sin(E),
    };
  }
  const oa = orbitPhase + (2 * Math.PI * t) / P;
  return { xo: Math.cos(oa) * orbitRadius, yo: Math.sin(oa) * orbitRadius };
}

// ---------------------------------------------------------------- generator

/** Private-bottle star dice. Stream must stay bit-identical for a given seed. */
function rollBottleStar(rng: () => number): StarSpec {
  const starRoll = rng();
  const Z = 0.45 + Math.pow(rng(), 1.6) * 1.9;
  const CO = 0.5 + Math.pow(rng(), 2.5) * 1.2;
  const R = UNIVERSE.RSUN_KM;
  if (starRoll < 0.44) {
    return { name: starName(rng), radius: R * (0.95 + rng() * 0.12), mass: 1, color: '#fff1c4', lightColor: '#fff4dc', luminosity: 0.9 + rng() * 0.3, metallicity: Z, carbon: CO };
  }
  if (starRoll < 0.72) {
    return { name: starName(rng), radius: R * (0.78 + rng() * 0.1), mass: 0.7, color: '#ffd9a0', lightColor: '#ffe2b8', luminosity: 0.42 + rng() * 0.2, metallicity: Z, carbon: CO };
  }
  if (starRoll < 0.88) {
    return { name: starName(rng), radius: R * (0.48 + rng() * 0.12), mass: 0.4, color: '#ffb28a', lightColor: '#ffc9a4', luminosity: 0.07 + rng() * 0.09, metallicity: Z, carbon: CO };
  }
  return { name: starName(rng), radius: R * (1.15 + rng() * 0.2), mass: 1.3, color: '#f4f6ff', lightColor: '#eef2ff', luminosity: 1.7 + rng() * 0.7, metallicity: Z, carbon: CO };
}

/** Catalog star → bottle StarSpec. L, Z, C/O come from evolve(), not dice. */
export function starSpecFromState(st: StellarState, rng: () => number): StarSpec {
  const rgb = st.phase === 'black_hole' ? [0.12, 0.1, 0.16] as [number, number, number]
    : st.phase === 'pulsar' || st.phase === 'neutron_star' ? [0.72, 0.82, 1] as [number, number, number]
    : teffToRgb(st.teff);
  const hex = rgbToHex(rgb);
  const light = rgbToHex([
    Math.min(1, rgb[0] * 1.05 + 0.08),
    Math.min(1, rgb[1] * 1.04 + 0.06),
    Math.min(1, rgb[2] * 1.02 + 0.04),
  ]);
  const Rsun = Math.max(1e-6, st.radius) * UNIVERSE.RSUN_KM;
  return {
    name: starName(rng),
    radius: Rsun,
    mass: Math.max(0.08, st.mass),
    color: hex,
    lightColor: light,
    luminosity: Math.max(1e-8, st.luminosity),
    metallicity: Math.pow(10, st.feh),
    carbon: st.carbon,
  };
}

export function generateSystem(seed: string): SystemSpec {
  const rng = mulberry32(xmur3(`system:${seed}`)());
  // G/K/M/F dice is the private bottle. Canonical play uses systemAt.
  return assembleSystem(seed, rng, rollBottleStar(rng));
}

/**
 * Discover a system: the star is the catalog object; the planets unfold
 * from (galaxySeed, starId) the way a bottle unfolds from a seed.
 */
export function systemAt(galaxySeed: string, starId: number): SystemSpec {
  const obj = objectAt(galaxySeed, starId);
  if (!obj) throw new Error(`empty catalog slot ${starId}`);
  const seed = `${galaxySeed}:${starId}`;
  const rng = mulberry32(xmur3(`system:${seed}`)());
  return assembleSystem(seed, rng, starSpecFromState(obj.star, rng));
}

export function systemAtObject(obj: GalaxyObject, galaxySeed = UNIVERSE.CANONICAL_SEED): SystemSpec {
  return systemAt(galaxySeed, obj.id);
}

function assembleSystem(seed: string, rng: () => number, star: StarSpec): SystemSpec {
  const L = star.luminosity;
  const Z = star.metallicity;
  const CO = star.carbon;

  // --- orbital skeleton: geometric accretion spacing, Kepler periods ---
  const N = planetCount(rng);
  const k = Math.min(1.8, Math.max(1.22, Math.pow(A_MAX / A0, 1 / Math.max(1, N - 1))));

  // First pass: gas giants form where the disk is cold enough for ice cores
  // (beyond the water frost line) and there is nebular gas to capture.
  const orbits: number[] = [];
  const isGas: boolean[] = [];
  for (let i = 0; i < N; i++) {
    const a = A0 * Math.pow(k, i) * (0.96 + rng() * 0.08);
    orbits.push(a);
    const diskT = UNIVERSE.DISK_C * Math.pow(L, 0.25) * Math.pow(a, -UNIVERSE.DISK_P);
    const beyondFrost = diskT < UNIVERSE.FROST_H2O;
    // Capture odds peak just past the frost line and taper at the rim.
    const pGas = beyondFrost ? 0.72 - 0.3 * clamp01((a - FROST_AU) / (A_MAX - FROST_AU)) : 0;
    isGas.push(rng() < pGas);
  }
  // Accretion in this universe always leaves at least one giant when the
  // disk reaches past the frost line.
  if (N >= 5 && !isGas.includes(true)) {
    for (let i = N - 2; i >= 0; i--) {
      const diskT = UNIVERSE.DISK_C * Math.pow(L, 0.25) * Math.pow(orbits[i], -UNIVERSE.DISK_P);
      if (diskT < UNIVERSE.FROST_H2O) {
        isGas[i] = true;
        break;
      }
    }
  }

  // --- migration (Type II): a giant still embedded in the gas disk
  // surrenders angular momentum and spirals inward — final orbit log-spaced
  // between the disk's inner edge and the birth orbit, depth biased inward.
  // The spiral sweeps the corridor it crosses: embryos it passes are
  // scattered or eaten (mass wins every contest). This is where hot
  // Jupiters, warm giants and orphaned outer zones come from — the
  // architecture stops being a Sol clone.
  const aFinal = orbits.slice();
  const innerEdge = A0 * 0.8;
  for (let i = 0; i < N; i++) {
    const roll = rng();
    const depth = rng(); // both drawn unconditionally: stream discipline
    if (!isGas[i] || roll >= UNIVERSE.MIGRATE_P) continue;
    aFinal[i] = innerEdge * Math.pow(orbits[i] / innerEdge, Math.pow(depth, 1.4));
  }
  // Casualties: each migrated giant scatters the corridor it crossed, from
  // just outside its final orbit up to its birth orbit. Some crossed bodies
  // ride the resonances and survive the passage (the Trappist lesson).
  // Undisturbed neighbors never harm each other — their ladder was born
  // stable — and a giant that is already dead sweeps nothing.
  const luck = Array.from({ length: N }, () => rng()); // unconditional draws
  const dead = new Array<boolean>(N).fill(false);
  for (let g = 0; g < N; g++) {
    if (!isGas[g] || aFinal[g] === orbits[g] || dead[g]) continue;
    for (let j = 0; j < N; j++) {
      if (j === g || dead[j]) continue;
      // The giant's cleared neighborhood spares nothing; the swept corridor
      // beyond it can be survived on a lucky resonance.
      const clearing = aFinal[j] > aFinal[g] / 1.25 && aFinal[j] < aFinal[g] * 1.25;
      const corridor = aFinal[j] >= aFinal[g] * 1.25 && aFinal[j] < orbits[g] * 0.95;
      if (clearing || (corridor && luck[j] >= 0.3)) dead[j] = true;
    }
  }
  const kept = Array.from({ length: N }, (_, i) => i)
    .filter((i) => !dead[i])
    .sort((x, y) => aFinal[x] - aFinal[y]);
  const finalOrbits = kept.map((i) => aFinal[i]);
  const finalGas = kept.map((i) => isGas[i]);
  // The interesting-universe decree extends to migration: a scattering
  // giant flings at least one embryo outward instead of eating it, so no
  // sweep leaves a system with no rocky planet at all — the outermost
  // casualty re-accretes beyond the farthest survivor.
  if (!finalGas.includes(false)) {
    finalOrbits.push(finalOrbits[finalOrbits.length - 1] * 1.45);
    finalGas.push(false);
  }
  const M = finalOrbits.length;

  const bodies: BodySpec[] = [];
  let prevApoapsis = 0;

  for (let i = 0; i < M; i++) {
    const id = `p${i}`;
    const bodySeed = `${seed}:${id}`;
    // Stability by fiat: an orbit that would sit inside its inner
    // neighbor's apoapsis is nudged outward (accretion never leaves
    // overlapping rings; migration and ladder jitter occasionally would).
    let a = finalOrbits[i];
    if (a < prevApoapsis * 1.05) a = prevApoapsis * 1.06;
    const period = keplerPlanetSec(a, star.mass);
    const phase = rng() * 2 * Math.PI;
    const name = `${star.name} ${ROMAN[i]}`;

    // Keplerian elements: mild seeded eccentricity, clamped so no orbit can
    // ever cross its inner neighbor (periapsis clears the previous apoapsis).
    let ecc = Math.pow(rng(), 2) * 0.15;
    const eccMax = 1 - (prevApoapsis * 1.05) / a;
    ecc = Math.max(0, Math.min(ecc, eccMax));
    prevApoapsis = a * (1 + ecc);
    const inc = (1 + rng() * 5) * (Math.PI / 180);
    const node = rng() * 2 * Math.PI;
    const peri = rng() * 2 * Math.PI;

    // Tidal locking: torque ~ 1/a^6, so the law is a radius with a narrow
    // coin-flip band just outside it. (Torque tracks stellar mass ~ L^0.25.)
    const aLock = UNIVERSE.LOCK_A * Math.pow(L, 0.25);
    const locked = a < aLock || (a < aLock * UNIVERSE.LOCK_COIN && rng() < 0.5);
    const obliquity = locked ? 0 : rollObliquity(rng);
    const axialAz = rng() * 2 * Math.PI;

    if (finalGas[i]) {
      const radius = UNIVERSE.REARTH_KM * (3.9 + rng() * 7.2);
      const physics = gasPhysics({ seed: bodySeed, a, radiusGL: radius, L, Z, CO });
      const gas = gasBands(rng, physics);
      bodies.push({
        id, name, kind: 'gas', seed: bodySeed, radius,
        orbitRadius: a, orbitPeriod: period, orbitPhase: phase,
        ecc, inc, node, peri,
        obliquity, axialAz,
        spinPeriod: 3.6e4 + rng() * 2.9e4, tidallyLocked: false, parent: null,
        physics, gas, meanColor: gas.color,
      });
    } else {
      const size = 25 + Math.round(rng() * 75);
      const radius = UNIVERSE.REARTH_KM * (0.446 + 0.554 * (size / 100));
      const physics = rockyPhysics({ seed: bodySeed, a, radiusGL: radius, L, Z, CO, lockedToStar: locked });
      const haze = hazeSpec(physics);
      bodies.push({
        id, name, kind: 'rocky', seed: bodySeed, radius,
        orbitRadius: a, orbitPeriod: period, orbitPhase: phase,
        ecc, inc, node, peri,
        obliquity, axialAz,
        spinPeriod: locked ? period : UNIVERSE.SEC_DAY * (0.45 + rng() * 1.8), tidallyLocked: locked, parent: null,
        physics,
        size, temp: physics.temp01, seaLevel: physics.sea01,
        // A translucent shroud only tints the distant ball as much as its
        // opacity earns; an opaque deck owns the color outright.
        meanColor: haze
          ? mix(rockyMeanColor(physics.temp01, physics.sea01), haze.color, haze.opacity)
          : rockyMeanColor(physics.temp01, physics.sea01),
      });
    }

    // --- moons, by toy astrophysics: the star's tides forbid them close in,
    // gas giants collect the most, everything is tidally locked to its parent.
    const parent = bodies[bodies.length - 1];
    let moonCount = 0;
    if (locked) moonCount = 0;
    else if (finalGas[i]) moonCount = 1 + Math.floor(rng() * Math.min(3.5, parent.radius * 0.25));
    else {
      const r = rng();
      moonCount = r < 0.4 ? 1 : r < 0.52 ? 2 : 0;
    }
    for (let j = 0; j < moonCount; j++) {
      const mid = `${id}m${j}`;
      const mseed = `${seed}:${mid}`;
      const msize = 15 + Math.round(rng() * 15);
      // Moon masses span Luna to Titan, bottom-heavy (accretion makes many
      // small moons for every large one): only the biggest stay geologically
      // alive enough to outgas an atmosphere (see UNIVERSE.OUTGAS_R).
      const mdraw = rng();
      const mradius = Math.max(UNIVERSE.REARTH_KM * 0.14, parent.radius * (0.09 + mdraw * mdraw * 0.19));
      const morb = parent.radius * (2.8 + 2.2 * j) + rng() * parent.radius;
      const mper = keplerMoonSec(morb, bodyMassKg(parent.radius, parent.physics.densityRel));
      // Same feeding zone as the parent: the moon's chemistry is the
      // parent's orbit's chemistry, and its own (small) gravity decides the
      // rest — big cold moons keep air, small ones go bare.
      // Locked to the parent, not the star: they still cycle through
      // daylight, so their temperature field is a spinner's.
      const mphysics = rockyPhysics({ seed: mseed, a, radiusGL: mradius, L, Z, CO, lockedToStar: false });
      const mhaze = hazeSpec(mphysics);
      bodies.push({
        id: mid,
        name: `${name}${MOON_SUFFIX[j] ?? j}`,
        kind: 'rocky',
        seed: mseed,
        radius: mradius,
        orbitRadius: morb,
        orbitPeriod: mper,
        orbitPhase: rng() * 2 * Math.PI,
        ecc: 0, // tidal circularization
        inc: 0, // parent-equatorial (the engine applies the parent's tilt)
        node: 0,
        peri: 0,
        obliquity: 0,
        axialAz: 0,
        spinPeriod: mper, // every real moon: locked
        tidallyLocked: true,
        parent: id,
        physics: mphysics,
        size: msize,
        temp: mphysics.temp01,
        seaLevel: mphysics.sea01,
        meanColor: mhaze
          ? mix(rockyMeanColor(mphysics.temp01, mphysics.sea01), mhaze.color, mhaze.opacity)
          : rockyMeanColor(mphysics.temp01, mphysics.sea01),
      });
    }
  }

  return { seed, star, bodies };
}

/**
 * Gas giant band palette from trace chemistry: methane absorbs red (blues,
 * far out), ammonia clouds run cream-tan (the warmer gas region) — the same
 * inventory the physics derived, read as color.
 */
function gasBands(rng: () => number, physics: BodyPhysics): GasSpec {
  const color = gasColor(physics);
  // Historical weather-shader entropy: bands, storms and hue jitter used
  // to draw from this stream. Keep the draws so moon counts and moon
  // seeds downstream stay put until weather is a real law.
  const ch4 = physics.atmosphere.mix.CH4 ?? 0;
  const nh3 = physics.atmosphere.mix.NH3 ?? 0;
  if (ch4 + nh3 <= 1e-5) rng();
  rng();
  const bandCount = 5 + Math.floor(rng() * 4);
  for (let b = 0; b < bandCount; b++) {
    rng();
    rng();
  }
  rng();
  rng();
  rng();
  return {
    color,
    ring: rng() < 0.45,
    ringTilt: 0.9 + rng() * 0.5,
    ringColor: mix(color, [1, 1, 1], 0.45),
  };
}

/** The "home" body a fresh system opens on: the most habitable rocky body.
 * Moons qualify too — in a migration-scarred system the best address can be
 * a Titan riding a giant. */
export function homeBodyId(spec: SystemSpec): string {
  let best: BodySpec | null = null;
  let bestScore = -Infinity;
  for (const b of spec.bodies) {
    if (b.kind !== 'rocky') continue;
    const p = b.physics;
    let score = 1 - Math.abs(p.temp01 - 0.45) * 2;
    if (p.life) score += 100; // a living world is always home
    if (p.hydrosphere.substance === 'water' && p.hydrosphere.state === 'liquid') score += 0.6;
    if (p.sea01 < 0.15) score -= 0.4;
    if (b.parent) score -= 0.3; // planets beat moons on a tie
    if (p.atmosphere.pressure > UNIVERSE.HAZE_P) score -= 200; // never a hidden home
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

/** Whether this body keeps a face to the STAR (the eyeball condition):
 * locked moons face their planet, so they still cycle through daylight. */
export function lockedToStar(b: BodySpec): boolean {
  return b.tidallyLocked && !b.parent;
}

/**
 * The body's physics with the player's climate dial applied: the same
 * generation pipeline re-run with the surface temperature overridden, so
 * seas freeze, snow cycles seal, life dies and classifications shift by
 * law, not by label. Returns the generated physics untouched when there is
 * no override (or the dial sits at the natural value).
 */
export function effectivePhysics(
  spec: SystemSpec,
  body: BodySpec,
  tempOverride01?: number,
): BodyPhysics {
  if (
    body.kind !== 'rocky' ||
    tempOverride01 === undefined ||
    tempOverride01 === body.physics.temp01
  ) {
    return body.physics;
  }
  const parent = body.parent ? spec.bodies.find((b) => b.id === body.parent) : undefined;
  return rockyPhysics({
    seed: body.seed,
    a: parent ? parent.orbitRadius : body.orbitRadius,
    radiusGL: body.radius,
    L: spec.star.luminosity,
    Z: spec.star.metallicity,
    CO: spec.star.carbon,
    lockedToStar: lockedToStar(body),
    tempOverride01,
  });
}

export { classify };
