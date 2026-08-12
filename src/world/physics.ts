import { mulberry32, xmur3 } from './rng';

/**
 * The physics engine of the bottle universe.
 *
 * THE CHARTER: this universe runs entirely on physics, with deliberate tweaks
 * to mass, distance and time so it fits in a bottle. We set parameters and
 * laws; we never hand-roll outcomes. When a world looks wrong, fix the law,
 * not the world. Every toy-scaling constant lives in the UNIVERSE block
 * below — never as per-case fudges scattered through the code.
 *
 * Archetypes are OUTPUTS, never inputs: there is no world-type switch here.
 * Iceballs, hothouses, methane worlds, airless rocks and living paradises
 * are attractor regions of one causal chain:
 *
 *   star metallicity → disk chemistry at the orbit (condensation sequence)
 *   → one elemental inventory per body → bulk density → gravity
 *   → Jeans escape (which gases the world can hold) → surface pressure
 *   → greenhouse → surface temperature → hydrosphere phase (water/methane)
 *   → solutes, palette, life.
 *
 * Simplifications decreed by the god-engineers (documented, not hidden):
 * every body has a metallic core with a spin-aligned magnetic dipole (a
 * compass works everywhere and points to spin-north); orbits are stable by
 * fiat; interiors, plate tectonics and weather are out of scope.
 */

// ------------------------------------------------------------------ constants

/** All toy scalings of the bottle universe, in one visible place. */
export const UNIVERSE = {
  /** Gravity law: g = G_TOY · density(rel Earth) · radius(rel home world). */
  G_TOY: 1.35,
  /** Reference GL radius of a size-100 rocky world (radiusRel = 1). */
  R_HOME: 4.48,

  /** Stellar flux: T_eq = T_HAB · L^0.25 · sqrt(A_HAB / a). */
  T_HAB: 278,
  A_HAB: 90,

  /** Accretion disk temperature: T_disk = DISK_C · L^0.25 · a^-DISK_P (K). */
  DISK_C: 2670,
  DISK_P: 0.55,

  /** Condensation temperatures (K), toy-compressed. */
  FROST_H2O: 170,
  FROST_NH3: 115,
  FROST_CO2: 90,
  FROST_CH4: 70,

  /**
   * Jeans escape: a gas of molecular weight mu is retained when
   * mu ≥ ESCAPE_K · T_eq / (g · radiusRel) — escape velocity physics:
   * small hot worlds can't hold light gases.
   */
  ESCAPE_K: 0.0113,

  /**
   * Stellar wind stripping: an atmosphere survives long-term only when the
   * escape parameter g·radiusRel beats WIND_K · (T_eq/300)² — hot little
   * worlds near the star are sandblasted bare (the Mercury path).
   */
  WIND_K: 0.35,

  /** Devolatilization: rock that condensed hot lost its C and N; retention
   * ramps in as the disk cools below DEVOL_T over DEVOL_SPAN kelvin. */
  DEVOL_T: 420,
  DEVOL_SPAN: 160,

  /** Surface pressure: P(atm) = PRESSURE_K · retained gas mass fraction · g. */
  PRESSURE_K: 75,

  /**
   * Runaway greenhouse: warm worlds with a real CO2 atmosphere lose their
   * water to photodissociation and bake their carbon out (the Venus path).
   */
  RUNAWAY_T: 305,
  RUNAWAY_MIN_P: 0.1,
  RUNAWAY_MULT: 40,

  /** Greenhouse lift: T_surf = T_eq · (1 + GH_K · P_gh^GH_P). */
  GH_K: 0.185,
  GH_P: 0.31,

  /** Liquid phase windows (K). Methane's is toy-widened: the bottle is small. */
  WATER_WIN: [258, 395] as const,
  METHANE_WIN: [78, 135] as const,
  /** Ice persistence ceilings (K): below these, CO2 and N2 sit on the
   * surface as unmoving frozen sheets (they skip the liquid phase at low
   * pressure — dry ice sublimes, it never pools). */
  CO2_ICE_T: 150,
  N2_ICE_T: 70,
  /** Minimum pressure to keep a liquid surface from sublimating away. */
  LIQUID_MIN_P: 0.06,
  /** Above this surface temperature the water inventory is lost to space. */
  BOIL_OFF_T: 420,

  /**
   * The "interesting universe" bias, a decreed delivery rule: comets stock
   * the temperate band with extra water (peak mass fraction added at the
   * habitable temperature).
   */
  HAB_WATER: 0.05,

  /** Life odds where liquid water, warmth and pressure align. */
  LIFE_ODDS: 0.8,
  LIFE_T: [250, 335] as const,
  LIFE_P: [0.25, 5] as const,

  /** Tidal locking: planets inside LOCK_A · sqrt(L) are locked; a band
   * outside that is a seeded coin flip (torque falls off as 1/a^6, so the
   * transition is narrow). */
  LOCK_A: 46,
  LOCK_COIN: 1.35,

  /** Dial mapping: temp01 = (T_surf − T_COLD) / (T_HOT − T_COLD). */
  T_COLD: 213,
  T_HOT: 371,

  /** Surface temperature field spans (dial units): time-averaged insolation
   * gives spinners a latitude gradient and star-locked worlds a substellar
   * ("eyeball") gradient. One law, spin state as input. */
  TEMP_SPAN_SPIN: 0.35,
  TEMP_SPAN_LOCKED: 0.55,

  /**
   * Seasons: the local temperature adds a seasonal anomaly
   * SEASON_GAIN · sin(latitude) · sin(sun declination). The declination in
   * the body frame is read straight off the live sun direction, so seasons
   * scale with axial tilt and vanish for untilted or locked worlds — snow
   * lines breathe and sea ice migrates with no special case. (No thermal
   * lag: this toy climate responds instantly.)
   */
  SEASON_GAIN: 1.2,

  /** Atmospheres thicker than this hide the surface under a haze deck. */
  HAZE_P: 6,

  /**
   * Aerial perspective: air is densest at the ground and thins as
   * exp(-h/H), H = kT/(mg). AIR_H is the reference world's scale height
   * (1 g, 288 K, mu 29 air) as a fraction of its radius — toy-compressed
   * like everything else; every other sky derives from it. AIR_SIGMA is
   * the reference surface extinction per radius of path (Beer–Lambert):
   * how fast an Earthlike column swallows the light crossing it.
   */
  AIR_H: 0.05,
  AIR_SIGMA: 0.9,

  /**
   * Precipitation cycle: snow is fallen weather, not paint. It needs a
   * volatile reservoir to evaporate from AND an atmosphere thick enough to
   * lift, carry and drop it — the cycle ramps to full strength at this
   * pressure (atm). Mars teaches the lesson: cold peaks, near-vacuum, no
   * snow caps.
   */
  SNOW_CYCLE_P: 0.2,

  /**
   * Type-II migration: odds that a giant, still embedded in a gassy disk,
   * surrenders angular momentum and spirals inward. The spiral sweeps the
   * corridor it crosses — architectures stop being Sol clones (hot
   * Jupiters, warm giants, orphaned outer zones).
   */
  MIGRATE_P: 0.24,

  /**
   * Outgassing: volatiles reach a surface only where radiogenic heat still
   * drives geology, and that heat budget scales with size. The ramp (in
   * radiusRel) splits the moons — Titan-size keeps a working atmosphere,
   * Callisto-size stays sealed, Luna-size is bare — and thins the smallest
   * planets (the Mars lesson: small worlds cool off and fall quiet).
   */
  OUTGAS_R: [0.42, 0.7] as const,
};

// ------------------------------------------------------------------ types

export const ELEMENTS = [
  'H', 'He', 'C', 'N', 'O', 'Na', 'Mg', 'Si', 'S', 'Cl', 'K', 'Ca', 'Ti', 'Fe', 'Ni', 'U',
] as const;
export type Element = (typeof ELEMENTS)[number];
/** Mass fractions over ELEMENTS, summing to ~1. */
export type Composition = Record<Element, number>;

export type Gas = 'H2' | 'He' | 'N2' | 'O2' | 'CO2' | 'CH4' | 'H2O' | 'NH3';
const GAS_MU: Record<Gas, number> = {
  H2: 2, He: 4, H2O: 18, CH4: 16, NH3: 17, N2: 28, O2: 32, CO2: 44,
};

export type RGB = [number, number, number];

export interface AtmosphereSpec {
  /** Surface pressure, atm. < 0.01 reads as airless. */
  pressure: number;
  /** Mole-ish mix of retained gases, normalized. */
  mix: Partial<Record<Gas, number>>;
}

/** The volatiles that can fill basins, as liquid or unmoving ice. */
export type Volatile = 'water' | 'methane' | 'co2' | 'nitrogen';

export interface HydrosphereSpec {
  /** What fills the basins — 'none' leaves bare rock hollows. */
  substance: Volatile | 'none';
  /**
   * Phase at MEAN surface conditions: the rock is static, the volatile is
   * the weather. The local temperature field still freezes or melts it
   * regionally in the shaders (polar caps, nightside ice, summer melt).
   */
  state: 'liquid' | 'ice' | 'none';
  /** Sea colors for the liquid phase (the liquid + its solutes). */
  surf: RGB;
  deep: RGB;
  /** Frozen-sheet color: substance chemistry + irradiation + crust dust. */
  ice: RGB;
  /** 0 murky .. 1 glassy: scales translucency. */
  clarity: number;
  /** Shoreline surf/foam strength (methane is glassy and quiet). */
  foam: number;
}

export interface BodyPhysics {
  kind: 'rocky' | 'gas';
  /** Radius relative to the home world (R_HOME GL units). */
  radiusRel: number;
  /** Bulk density relative to Earth. */
  densityRel: number;
  /** Surface gravity in g. Derived, never set. */
  gravity: number;
  /** System metallicity (rel solar) — inherited from the star. */
  metallicity: number;
  /** Equilibrium and greenhouse-adjusted surface temperature (K). */
  TeqK: number;
  TsurfK: number;
  atmosphere: AtmosphereSpec;
  hydrosphere: HydrosphereSpec;
  /** Bulk elemental inventory (mass fractions). */
  inventory: Composition;
  /** Solid-surface partition of the inventory (what mining finds). */
  crust: Composition;
  /** Habitability emerged and life took hold (O2 signature, organics). */
  life: boolean;
  /**
   * 0..1 snow/frost deposition capacity — open-liquid reservoir ×
   * precipitation cycle. 0 on airless, bone-dry AND freeze-locked worlds
   * (a sealed frozen reservoir cannot evaporate, so nothing falls on the
   * peaks); liquid methane worlds deposit methane frost from their own
   * seas. WHERE it settles is the temperature field's business; whether it
   * CAN settle at all is decided here.
   */
  snow: number;
  /**
   * Temperature dial for the snow-line law, measured relative to the
   * WORKING volatile's freeze point (unclamped). For water it equals
   * temp01; for methane seas it re-centers so frost caps peaks of a world
   * whose lowlands are comfortably liquid. One law, freeze point as input.
   */
  snowTemp01: number;
  /** Terrain dial mappings, derived from the physics. */
  temp01: number;
  sea01: number;
}

// ------------------------------------------------------------------ helpers

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function zeroComposition(): Composition {
  const c = {} as Composition;
  for (const e of ELEMENTS) c[e] = 0;
  return c;
}

function addMix(into: Composition, parts: Partial<Composition>, weight: number): void {
  for (const [e, f] of Object.entries(parts) as Array<[Element, number]>) {
    into[e] += f * weight;
  }
}

function normalize(c: Composition): Composition {
  let sum = 0;
  for (const e of ELEMENTS) sum += c[e];
  if (sum <= 0) return c;
  for (const e of ELEMENTS) c[e] /= sum;
  return c;
}

/** Metal phase (the core-formers; also seeds surface veins). */
const METAL: Partial<Composition> = { Fe: 0.9, Ni: 0.09, U: 0.01 };
/** Silicate rock phase (refractories only; volatiles ride separately). */
const ROCK: Partial<Composition> = {
  O: 0.442, Si: 0.243, Mg: 0.145, Ca: 0.062, S: 0.047, Na: 0.029,
  K: 0.014, Ti: 0.009, Cl: 0.005,
};
/** Volatiles bound in rock — burned off where the disk condensed hot. */
const ROCK_VOLATILES: Partial<Composition> = { C: 0.026, N: 0.008 };
/** Ice phases (condensation products). */
const ICE_H2O: Partial<Composition> = { H: 0.112, O: 0.888 };
const ICE_CO2: Partial<Composition> = { C: 0.273, O: 0.727 };
const ICE_CH4: Partial<Composition> = { C: 0.749, H: 0.251 };
const ICE_NH3: Partial<Composition> = { N: 0.823, H: 0.177 };
/** Gas giant bulk. */
const GAS_BULK: Partial<Composition> = { H: 0.735, He: 0.24, C: 0.01, N: 0.008, O: 0.007 };

/** Disk temperature at orbit a for stellar luminosity L. */
export function diskTempAt(a: number, L: number): number {
  return UNIVERSE.DISK_C * Math.pow(L, 0.25) * Math.pow(a, -UNIVERSE.DISK_P);
}

/** Equilibrium temperature at orbit a for stellar luminosity L. */
export function equilibriumTemp(a: number, L: number): number {
  return UNIVERSE.T_HAB * Math.pow(L, 0.25) * Math.sqrt(UNIVERSE.A_HAB / a);
}

/** Smooth 0..1 "has condensed" ramp as the disk cools below a frost temp. */
function frosted(diskT: number, frostT: number): number {
  return clamp01((frostT - diskT) / (frostT * 0.35));
}

// ------------------------------------------------------------------ inventory

/**
 * Elemental inventory of a solid body from the condensation sequence at its
 * feeding zone: refractories everywhere, ices beyond their frost lines,
 * comet-delivered water in the temperate band (the decreed bias).
 */
function solidInventory(
  rng: () => number,
  diskT: number,
  Teq: number,
  Z: number,
  co: number,
): { inv: Composition; iceFrac: number; waterMass: number } {
  const inv = zeroComposition();

  // Metal fraction scales with metallicity; rock is the remainder of the
  // refractory budget.
  const metal = 0.22 * Math.pow(Z, 0.7) * (0.85 + rng() * 0.3);

  // Ices claim a growing share of the solid mass as the disk cools.
  const fW = frosted(diskT, UNIVERSE.FROST_H2O);
  const fN = frosted(diskT, UNIVERSE.FROST_NH3);
  const fC2 = frosted(diskT, UNIVERSE.FROST_CO2);
  const fC1 = frosted(diskT, UNIVERSE.FROST_CH4);
  // The disk's C/O ratio partitions the volatile budget: in a carbon-rich
  // nebula the oxygen is locked up in CO gas, so water ice starves while
  // carbon ices and carbides feast (solar co = 1 is exact identity).
  const oxyFree = clamp01(1.55 - 0.55 * co);
  let iceW = 0.42 * fW * (0.7 + rng() * 0.6) * oxyFree;
  const iceN = 0.05 * fN * (0.6 + rng() * 0.8);
  const iceC2 = 0.08 * fC2 * (0.6 + rng() * 0.8) * co;
  const iceC1 = 0.07 * fC1 * (0.6 + rng() * 0.8) * co;

  // Comet delivery into the temperate band: water where it matters most
  // (comets are children of the same disk, so they starve with it).
  const habBump = Math.exp(-Math.pow((Teq - 285) / 45, 2));
  iceW += UNIVERSE.HAB_WATER * habBump * (0.6 + rng() * 0.8) * oxyFree;

  // Past co = 1 the condensation sequence flips: carbides and graphite
  // condense as refractories — dark carbon crusts instead of silicates.
  const graphiteJitter = rng(); // drawn unconditionally: stream discipline
  const graphite = 0.55 * Math.max(0, co - 1) * (0.7 + graphiteJitter * 0.6);

  const iceTotal = iceW + iceN + iceC2 + iceC1;
  const rock = Math.max(0.05, 1 - metal - iceTotal) * (1 - clamp01(graphite));

  addMix(inv, METAL, metal);
  addMix(inv, ROCK, rock);
  addMix(inv, { C: 1 }, (metal + rock + iceTotal) * clamp01(graphite));
  // Devolatilization law: rock keeps its bound C and N only where the disk
  // condensed cool — the innermost worlds are volatile-starved.
  const devol = clamp01((UNIVERSE.DEVOL_T - diskT) / UNIVERSE.DEVOL_SPAN);
  addMix(inv, ROCK_VOLATILES, rock * devol * Math.min(1.5, co));
  addMix(inv, ICE_H2O, iceW);
  addMix(inv, ICE_NH3, iceN);
  addMix(inv, ICE_CO2, iceC2);
  addMix(inv, ICE_CH4, iceC1);
  normalize(inv);

  const total = metal + rock + iceTotal;
  return { inv, iceFrac: iceTotal / total, waterMass: iceW / total };
}

/** Bulk density (rel Earth) from the phase mix. */
function bulkDensity(metalFrac: number, iceFrac: number): number {
  const rockFrac = Math.max(0, 1 - metalFrac - iceFrac);
  return (metalFrac * 7.9 + rockFrac * 3.95 + iceFrac * 1.2) / 5.51;
}

// ------------------------------------------------------------------ rocky body

export interface RockyInputs {
  seed: string;
  /** Orbit of the planet (moons: the parent's orbit — same feeding zone). */
  a: number;
  /** GL radius of the body. */
  radiusGL: number;
  /** Stellar luminosity (rel sun) and metallicity (rel solar). */
  L: number;
  Z: number;
  /** Keeps a face to the STAR (systemgen's torque law decides). The snow
   * law needs it: the warmest point of the temperature field is the
   * substellar point on a locked world, the equator on a spinner. */
  lockedToStar?: boolean;
  /** Disk C/O ratio relative to solar (the star deals it; default 1). */
  CO?: number;
  /** Terraforming: player-dialed surface temperature on the T_COLD..T_HOT
   * dial scale, UNCLAMPED (below 0 = deep cryo, above 1 = past boil-off).
   * Overrides Tsurf and re-runs every downstream law — hydrosphere phase,
   * snow cycle, life, classification. Boil-off history is judged at the
   * natural temperature (cooling a Venus stays dry). */
  tempOverride01?: number;
}

export function rockyPhysics(inp: RockyInputs): BodyPhysics {
  const rng = mulberry32(xmur3(`${inp.seed}:phys`)());
  const diskT = diskTempAt(inp.a, inp.L);
  const Teq = equilibriumTemp(inp.a, inp.L);

  // --- inventory & gravity: chemistry first, gravity derived ---
  const { inv, iceFrac, waterMass } = solidInventory(rng, diskT, Teq, inp.Z, inp.CO ?? 1);
  const metalFrac = inv.Fe + inv.Ni + inv.U;
  const densityRel = bulkDensity(metalFrac, iceFrac);
  const radiusRel = inp.radiusGL / UNIVERSE.R_HOME;
  const gravity = UNIVERSE.G_TOY * densityRel * radiusRel;

  // --- atmosphere: what the disk delivered, filtered by Jeans escape ---
  // Outgassing law: buried volatiles reach the surface only where the body
  // is big enough for radiogenic heat to keep geology alive. Planets always
  // qualify; moons split into Titans (air) and sealed ice balls (bare).
  const [og0, og1] = UNIVERSE.OUTGAS_R;
  const outgas = clamp01((radiusRel - og0) / (og1 - og0));
  // Available gas sources (mass fractions of the body).
  const cold = clamp01((UNIVERSE.FROST_H2O - Teq) / 60);
  const avail: Partial<Record<Gas, number>> = {
    N2: inv.N * 0.85 * outgas,
    CO2: inv.C * (0.35 + 0.45 * clamp01((Teq - 220) / 120)) * outgas,
    CH4: inv.C * 0.45 * cold * outgas,
    H2O: waterMass * 0.02 * outgas,
  };

  // Escape: mu_min falls out of escape-velocity physics, and the stellar
  // wind sandblasts hot little worlds bare regardless of molecular weight.
  const gR = gravity * radiusRel;
  const muMin = (UNIVERSE.ESCAPE_K * Teq) / Math.max(1e-4, gR);
  const windNeed = UNIVERSE.WIND_K * Math.pow(Teq / 300, 2);
  const windKeep = clamp01((gR / windNeed - 0.8) / 0.4);
  const retained: Partial<Record<Gas, number>> = {};
  let gasMass = 0;
  for (const [g, m] of Object.entries(avail) as Array<[Gas, number]>) {
    const keep = clamp01((GAS_MU[g] / muMin - 1.0) / 0.5) * windKeep;
    if (m * keep > 1e-6) {
      retained[g] = m * keep;
      gasMass += m * keep;
    }
  }

  let pressure = UNIVERSE.PRESSURE_K * gasMass * gravity;

  // Runaway greenhouse (the Venus path): warm enough to lose water, with a
  // real CO2 atmosphere, the carbonate sink fails and the full carbon
  // budget bakes out as CO2.
  const runaway =
    Teq > UNIVERSE.RUNAWAY_T && (retained.CO2 ?? 0) > 1e-5 && pressure > UNIVERSE.RUNAWAY_MIN_P;
  if (runaway) pressure *= UNIVERSE.RUNAWAY_MULT * (0.7 + rng() * 0.6);

  // Greenhouse lift from the greenhouse-active partial pressures.
  const mixSum = Object.values(retained).reduce((x, y) => x + y, 0) || 1;
  const pCO2 = (pressure * (retained.CO2 ?? 0)) / mixSum;
  const pCH4 = (pressure * (retained.CH4 ?? 0)) / mixSum;
  const pH2O = (pressure * (retained.H2O ?? 0)) / mixSum;
  const pGH = pCO2 + 12 * pCH4 + 5 * pH2O;
  let Tsurf = Teq * (1 + (pGH > 0 ? UNIVERSE.GH_K * Math.pow(pGH, UNIVERSE.GH_P) : 0));

  // --- hydrosphere: phase windows decide what can pool in the basins.
  // Where water is frozen rock-hard but methane sits in its liquid window,
  // the seas are methane over water-ice bedrock — Titan emerges. ---
  // Boil-off is HISTORY, judged at the natural temperature before any
  // terraforming: water lost to space never comes back by cooling a Venus.
  const boiledOff = Tsurf > UNIVERSE.BOIL_OFF_T || runaway;

  // The terraform dial is a lawful input, not a paint bucket: it overrides
  // the surface temperature, and every downstream law re-runs — seas freeze
  // or melt, the snow cycle seals or opens, life appears or dies, and the
  // classification follows. Same pipeline, one changed quantity. The dial
  // is deliberately UNCLAMPED: values below 0 and above 1 reach past the
  // display range into deep-cryo (nitrogen sheets) and past boil-off (dead
  // scorched basins) — the visuals saturate, the chemistry keeps going.
  if (inp.tempOverride01 !== undefined) {
    Tsurf = Math.max(
      3,
      UNIVERSE.T_COLD + inp.tempOverride01 * (UNIVERSE.T_HOT - UNIVERSE.T_COLD),
    );
  }
  const hasWater = waterMass > 0.015 && !boiledOff;
  const waterLiquid =
    hasWater &&
    Tsurf > UNIVERSE.WATER_WIN[0] &&
    Tsurf < UNIVERSE.WATER_WIN[1] &&
    pressure > UNIVERSE.LIQUID_MIN_P;
  const methaneLiquid =
    inv.C > 0.02 &&
    cold > 0.4 &&
    Tsurf > UNIVERSE.METHANE_WIN[0] &&
    Tsurf < UNIVERSE.METHANE_WIN[1] &&
    pressure > UNIVERSE.LIQUID_MIN_P;

  let substance: HydrosphereSpec['substance'] = 'none';
  let state: HydrosphereSpec['state'] = 'none';
  if (waterLiquid) {
    substance = 'water';
    state = 'liquid';
  } else if (methaneLiquid) {
    substance = 'methane';
    state = 'liquid';
  } else {
    // Nothing pools as liquid: basins fill with an unmoving frozen sheet.
    // Which ice? The MOST VOLATILE species that has frozen — it condensed
    // last, so it blankets the earlier, harder ices (Pluto wears nitrogen
    // ice over its water-ice bedrock, never the other way round; deeply
    // frozen water ice is effectively rock).
    const iceCandidates: Array<[Volatile, number, number]> = [
      ['nitrogen', UNIVERSE.N2_ICE_T, inv.N * 0.9],
      ['methane', UNIVERSE.METHANE_WIN[0], inv.C * 0.45 * cold],
      ['co2', UNIVERSE.CO2_ICE_T, inv.C * 0.5],
      ['water', UNIVERSE.WATER_WIN[0], hasWater ? waterMass : 0],
    ];
    for (const [name, freezeT, mass] of iceCandidates) {
      if (Tsurf < freezeT && mass > 0.012) {
        substance = name;
        state = 'ice';
        break;
      }
    }
  }

  // --- life: a physical condition, then a (biased) seeded roll. The roll
  // is drawn UNCONDITIONALLY so the rng stream never depends on a branch:
  // re-running the pipeline with a temperature override must reproduce
  // every other seeded quantity exactly. ---
  const habitable =
    substance === 'water' &&
    state === 'liquid' &&
    Tsurf > UNIVERSE.LIFE_T[0] &&
    Tsurf < UNIVERSE.LIFE_T[1] &&
    pressure > UNIVERSE.LIFE_P[0] &&
    pressure < UNIVERSE.LIFE_P[1];
  const lifeRoll = rng();
  const life = habitable && lifeRoll < UNIVERSE.LIFE_ODDS;

  // Life leaves its signature: O2, and a whisper of biogenic methane.
  if (life) {
    const o2 = gasMass * 0.26;
    retained.O2 = o2;
    retained.CH4 = (retained.CH4 ?? 0) + gasMass * 0.01;
    gasMass += o2;
    pressure = UNIVERSE.PRESSURE_K * gasMass * gravity;
  }

  // Normalize the mix for display/scattering.
  const mix: Partial<Record<Gas, number>> = {};
  const total = Object.values(retained).reduce((x, y) => x + y, 0);
  if (total > 0) {
    for (const [g, m] of Object.entries(retained) as Array<[Gas, number]>) {
      mix[g] = m / total;
    }
  }

  // --- dials: terrain reads temperature and sea level from the physics.
  // Frozen sheets fill the basins just like their liquid would — the same
  // inventory, unmoving. ---
  const temp01 = clamp01((Tsurf - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD));
  const drySeaJitter = rng(); // drawn unconditionally: branch-independent stream
  let sea01: number;
  if (substance === 'water') {
    sea01 =
      state === 'liquid'
        ? clamp(0.3 + 1.6 * waterMass, 0.3, 0.62)
        : clamp(0.28 + 1.4 * waterMass, 0.28, 0.58);
  } else if (substance === 'methane') sea01 = clamp(0.24 + 3 * inv.C, 0.24, 0.5);
  else if (substance === 'co2') sea01 = clamp(0.2 + 2.2 * inv.C, 0.2, 0.45);
  else if (substance === 'nitrogen') sea01 = clamp(0.18 + 9 * inv.N, 0.18, 0.4);
  else sea01 = 0.02 + drySeaJitter * 0.08;

  // Snow/freeze dial measured from the working volatile's freeze point.
  // With the water window this is algebraically identical to temp01
  // (unclamped). The sea-ice law in the shaders anchors to the same dial.
  const FREEZE_REF: Record<Volatile, number> = {
    water: UNIVERSE.WATER_WIN[0],
    methane: UNIVERSE.METHANE_WIN[0],
    co2: UNIVERSE.CO2_ICE_T,
    nitrogen: UNIVERSE.N2_ICE_T,
  };
  const freezeRef = substance === 'none' ? UNIVERSE.WATER_WIN[0] : FREEZE_REF[substance];
  const snowTemp01 =
    (Tsurf - freezeRef + (UNIVERSE.WATER_WIN[0] - UNIVERSE.T_COLD)) /
    (UNIVERSE.T_HOT - UNIVERSE.T_COLD);

  // --- cryosphere: snow only falls where something can evaporate and an
  // atmosphere can carry it back up a mountainside. Evaporation needs OPEN
  // LIQUID, and "open" is a question for the temperature FIELD, not the
  // mean: a world whose mean sits below freezing can still melt a broad
  // equatorial band (Snowball Earth kept an open ring and kept snowing),
  // so we test the WARMEST point of the same insolation law the shaders
  // render — equator for spinners, substellar point for locked worlds.
  // Only when even that point stays frozen is the reservoir truly sealed:
  // vapor pressure collapses, precipitation stops, and old summit snow is
  // wind-scoured into the lowland cold traps (the Dry Valleys / Mars
  // lesson). Any exposed sea saturates the reservoir — evaporation reads
  // the open surface, not the total volatile budget — so capacity is the
  // melt fraction times the cycle strength (zero below the airless
  // threshold). ---
  const cycle = clamp01((pressure - 0.02) / (UNIVERSE.SNOW_CYCLE_P - 0.02));
  const span = inp.lockedToStar ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
  const insolMax = inp.lockedToStar ? 1.0 : (1 - 0.785) * 1.6; // toygen.insolationAt peaks
  const freeze01 =
    (UNIVERSE.WATER_WIN[0] - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD);
  const warmest01 = snowTemp01 + span * insolMax;
  // The ramp is steep on purpose: it exists only for continuity right at
  // the isotherm crossing. A few kelvin of melt already exposes a working
  // sea, and any working sea saturates the reservoir.
  const openLiquid =
    state === 'liquid'
      ? 1
      : state === 'ice' && pressure > UNIVERSE.LIQUID_MIN_P
        ? clamp01((warmest01 - freeze01) / 0.02)
        : 0;
  const snow = openLiquid * cycle;

  // --- crust: the solid partition (inventory minus air and sea) ---
  const crust = { ...inv };
  crust.N = Math.max(0, crust.N - (retained.N2 ?? 0) * 0.9);
  if (substance === 'water') {
    crust.H = Math.max(0, crust.H - waterMass * 0.09);
    crust.O = Math.max(0, crust.O - waterMass * 0.78);
  }
  if (life) crust.C += 0.012; // organics settle into the topsoil
  normalize(crust);

  return {
    kind: 'rocky',
    radiusRel,
    densityRel,
    gravity,
    metallicity: inp.Z,
    TeqK: Teq,
    TsurfK: Tsurf,
    atmosphere: { pressure, mix },
    hydrosphere: hydrosphereColors(substance, state, crust, Teq, temp01, life),
    inventory: inv,
    crust,
    life,
    snow,
    snowTemp01,
    temp01,
    sea01,
  };
}

// ------------------------------------------------------------------ gas giant

export interface GasInputs {
  seed: string;
  a: number;
  radiusGL: number;
  L: number;
  Z: number;
  /** Disk C/O ratio relative to solar (default 1). */
  CO?: number;
}

export function gasPhysics(inp: GasInputs): BodyPhysics {
  const rng = mulberry32(xmur3(`${inp.seed}:phys`)());
  const diskT = diskTempAt(inp.a, inp.L);
  const Teq = equilibriumTemp(inp.a, inp.L);

  const inv = zeroComposition();
  addMix(inv, GAS_BULK, 1);
  // Trace chemistry by disk temperature: ammonia clouds in the warmer gas
  // region, methane blues far out — the same condensation law as the rocks.
  // A carbon-rich disk deepens the methane hand.
  const traceCH4 =
    0.012 * frosted(diskT, UNIVERSE.FROST_CH4 * 1.8) * (0.7 + rng() * 0.6) * (inp.CO ?? 1);
  const traceNH3 = 0.01 * frosted(diskT, UNIVERSE.FROST_NH3 * 1.4) * (0.7 + rng() * 0.6);
  addMix(inv, ICE_CH4, traceCH4);
  addMix(inv, ICE_NH3, traceNH3);
  normalize(inv);

  const radiusRel = inp.radiusGL / UNIVERSE.R_HOME;
  const densityRel = 0.24 + 0.1 * rng();
  const gravity = UNIVERSE.G_TOY * densityRel * radiusRel;

  const mix: Partial<Record<Gas, number>> = {
    H2: 0.86,
    He: 0.12,
    CH4: traceCH4 * 1.3,
    NH3: traceNH3 * 1.2,
  };

  return {
    kind: 'gas',
    radiusRel,
    densityRel,
    gravity,
    metallicity: inp.Z,
    TeqK: Teq,
    TsurfK: Teq,
    atmosphere: { pressure: 1000, mix },
    hydrosphere: {
      substance: 'none',
      state: 'none',
      surf: [0, 0, 0],
      deep: [0, 0, 0],
      ice: [0, 0, 0],
      clarity: 0,
      foam: 0,
    },
    inventory: inv,
    crust: zeroComposition(),
    life: false,
    snow: 0,
    snowTemp01: clamp01((Teq - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD)),
    temp01: clamp01((Teq - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD)),
    sea01: 0,
  };
}

// ------------------------------------------------------------------ colors from chemistry

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Frozen-sheet color from real ice optics, then aged by chemistry:
 * - water ice absorbs red -> thick sheets read blue-white (glacier blue);
 * - CO2 ice (dry ice) is brilliant scattering white (Mars's seasonal caps);
 * - fresh CH4 ice is pale cream, but radiation cooks exposed CH4/N2 ice
 *   into tholins — the pink-brown blush of Pluto and Makemake. More carbon
 *   and more stellar UV, redder the sheet;
 * - N2 ice is milky cream (Sputnik Planitia's glaciers);
 * - and crust dust stains every sheet toward the local rock.
 */
function iceColorFor(substance: Volatile, crust: Composition, Teq: number): RGB {
  let c: RGB =
    substance === 'water'
      ? [0.78, 0.87, 0.96]
      : substance === 'co2'
        ? [0.96, 0.97, 0.99]
        : substance === 'methane'
          ? [0.9, 0.86, 0.74]
          : [0.93, 0.92, 0.87];
  if (substance === 'methane' || substance === 'nitrogen') {
    const dose = clamp01(crust.C * 9) * (0.35 + 0.65 * clamp01(Teq / 90));
    c = mixRGB(c, [0.71, 0.49, 0.4], 0.6 * dose);
  }
  const dust = clamp01((crust.Fe - 0.08) / 0.3);
  return mixRGB(c, [0.6, 0.5, 0.44], 0.3 * dust);
}

/** Sea color, clarity, surf and ice tint from the substance + its solutes. */
function hydrosphereColors(
  substance: HydrosphereSpec['substance'],
  state: HydrosphereSpec['state'],
  crust: Composition,
  Teq: number,
  temp01: number,
  life: boolean,
): HydrosphereSpec {
  const ice = substance === 'none' ? ([0.88, 0.92, 0.97] as RGB) : iceColorFor(substance, crust, Teq);
  if (substance === 'methane') {
    // Liquid methane: dark amber, glassy, almost still.
    return {
      substance,
      state,
      surf: [0.55, 0.4, 0.18],
      deep: [0.16, 0.1, 0.04],
      ice,
      clarity: 0.9,
      foam: 0.25,
    };
  }
  if (substance === 'co2' || substance === 'nitrogen') {
    // Cryogenic sheets: any pressurized partial melt reads as pale glassy
    // slush (colorless liquids over bright ice), never tropical water.
    return {
      substance,
      state,
      surf: [0.78, 0.84, 0.88],
      deep: [0.45, 0.54, 0.62],
      ice,
      clarity: 0.85,
      foam: 0,
    };
  }
  if (substance === 'none') {
    // Bare hollows: liquid colors are the water defaults (they only show
    // if a player floods the world by hand).
    return {
      substance,
      state,
      surf: [0.32, 0.86, 0.83],
      deep: [0.12, 0.5, 0.72],
      ice,
      clarity: 0.7,
      foam: 1,
    };
  }
  // Water: start from the home palette, then let chemistry tint it.
  let surf: RGB = [0.32, 0.86, 0.83]; // #52dcd4
  let deep: RGB = [0.12, 0.5, 0.72]; // #1e7fb8
  // Iron-stained seas shift teal-green.
  const fe = clamp01((crust.Fe - 0.1) / 0.2);
  surf = mixRGB(surf, [0.35, 0.78, 0.55], fe * 0.55);
  deep = mixRGB(deep, [0.1, 0.45, 0.4], fe * 0.55);
  // Life richens the blue-green.
  if (life) {
    surf = mixRGB(surf, [0.28, 0.88, 0.76], 0.4);
    deep = mixRGB(deep, [0.1, 0.5, 0.78], 0.4);
  }
  // Cold seas run steel-blue.
  const chill = clamp01((0.35 - temp01) / 0.35);
  surf = mixRGB(surf, [0.55, 0.72, 0.82], chill * 0.5);
  deep = mixRGB(deep, [0.2, 0.36, 0.55], chill * 0.5);
  // Salts cloud the water a touch.
  const salt = clamp01((crust.Na + crust.Cl) / 0.04);
  const clarity = 0.85 - 0.3 * salt;
  return { substance, state, surf, deep, ice, clarity, foam: 1 };
}

/** Rayleigh-ish rim tint from the gas mix: what this sky scatters. */
export function rayleighTint(atmo: AtmosphereSpec): RGB {
  const GAS_TINT: Record<Gas, RGB> = {
    N2: [0.5, 0.72, 1.0],
    O2: [0.52, 0.76, 1.0],
    CO2: [0.78, 0.82, 0.88],
    CH4: [1.0, 0.62, 0.32],
    H2O: [0.75, 0.85, 0.95],
    NH3: [0.9, 0.82, 0.66],
    H2: [0.8, 0.78, 0.95],
    He: [0.85, 0.85, 0.95],
  };
  let out: RGB = [0, 0, 0];
  let sum = 0;
  for (const [g, f] of Object.entries(atmo.mix) as Array<[Gas, number]>) {
    // Haze-formers (CH4, NH3) punch above their molar weight in color.
    const w = f * (g === 'CH4' || g === 'NH3' ? 6 : 1);
    out = [out[0] + GAS_TINT[g][0] * w, out[1] + GAS_TINT[g][1] * w, out[2] + GAS_TINT[g][2] * w];
    sum += w;
  }
  if (sum <= 0) return [0.56, 0.76, 0.94];
  return [out[0] / sum, out[1] / sum, out[2] / sum];
}

/**
 * The gas shroud of a rocky world: color from chemistry, opacity from
 * optical depth — column density times photochemical smog (CH4/NH3 build
 * organic haze far more efficiently than clear gases). NO patterns: clouds
 * and weather are a later law. Continuous by design: an Earth-thin sky is
 * invisible, Titan wears a translucent orange veil, a hothouse is a wall.
 * Returns null when the air is too thin to see at all.
 */
export function hazeSpec(p: BodyPhysics): { color: RGB; opacity: number } | null {
  if (p.kind !== 'rocky') return null;
  const organics = (p.atmosphere.mix.CH4 ?? 0) + (p.atmosphere.mix.NH3 ?? 0);
  const tau = (p.atmosphere.pressure / UNIVERSE.HAZE_P) * (1 + 5 * organics);
  const opacity = clamp01(1 - Math.exp(-(tau - 0.45) * 1.6));
  if (opacity < 0.12) return null;
  const tint = rayleighTint(p.atmosphere);
  // Hot CO2 decks bleach toward cream (sulfuric cloud tops); cold organic
  // haze keeps its color.
  const hot = clamp01((p.TsurfK - 380) / 250);
  const color = mixRGB(
    [tint[0] * 0.85 + 0.15, tint[1] * 0.85 + 0.15, tint[2] * 0.85 + 0.15],
    [0.93, 0.88, 0.72],
    hot,
  );
  return { color, opacity };
}

/**
 * Aerial perspective — the atmosphere is dense near the surface and thin
 * at altitude, so light from distant things is absorbed and scattered
 * along the way (Beer–Lambert through an exponential profile). Scale
 * height falls out of kT/(mg): hot thin-gas skies sit tall, cold heavy
 * ones hug the ground. Extinction strength follows column density (P/g)
 * with the same photochemical-smog multiplier the haze deck uses — an
 * Earth-thin sky softens the far horizon, a Titan veil shortens it, a
 * hothouse is a wall, an airless rock shows razor-sharp forever. Returns
 * null when the air is too thin to matter. sigma is per planet radius of
 * path at the surface; scaleH is in planet radii.
 */
export function airExtinction(
  p: BodyPhysics,
): { sigma: number; scaleH: number; tint: RGB } | null {
  if (p.kind !== 'rocky') return null;
  const P = p.atmosphere.pressure;
  if (P < 0.01) return null;
  let mu = 0;
  let fsum = 0;
  for (const [g, f] of Object.entries(p.atmosphere.mix) as Array<[Gas, number]>) {
    mu += GAS_MU[g] * f;
    fsum += f;
  }
  mu = fsum > 0 ? mu / fsum : 29;
  const grav = Math.max(0.05, p.gravity);
  const scaleH = (UNIVERSE.AIR_H * (p.TsurfK / 288) * (29 / mu)) / grav;
  const organics = (p.atmosphere.mix.CH4 ?? 0) + (p.atmosphere.mix.NH3 ?? 0);
  const sigma = UNIVERSE.AIR_SIGMA * (P / grav) * (1 + 5 * organics);
  if (sigma < 0.05) return null;
  // Same hot-bleach law as the haze deck, so sky and fade agree.
  const hot = clamp01((p.TsurfK - 380) / 250);
  const tint = mixRGB(rayleighTint(p.atmosphere), [0.93, 0.88, 0.72], hot);
  return { sigma, scaleH, tint };
}

// ------------------------------------------------------------------ classification

/**
 * NAMES what emerged — description, never prescription. Used by the roster,
 * the inspector and the test suite; generation never reads it.
 */
export function classify(p: BodyPhysics, lockedToStar: boolean): string {
  if (p.kind === 'gas') {
    // Migration delivers giants to the inner system: irradiation grades them.
    if (p.TeqK > 460) return 'scorched giant';
    if (p.TeqK > 290) return 'warm giant';
    return 'gas giant';
  }
  if (p.life) return 'living world';
  if (p.atmosphere.pressure > 8 && p.TsurfK > 430) return 'hothouse';
  const h = p.hydrosphere;
  if (h.substance === 'methane' && h.state === 'liquid') return 'methane world';
  if (lockedToStar && h.substance === 'water') return 'eyeball world';
  if (h.state === 'ice') {
    if (h.substance === 'water') return 'iceball';
    if (h.substance === 'co2') return 'dry-ice world';
    if (h.substance === 'nitrogen') return 'nitrogen iceball';
    return 'frozen methane world';
  }
  // Carbide-and-graphite crusts (carbon-rich disks) trump the water labels.
  if (p.crust.C > 0.15) return 'carbon world';
  if (p.atmosphere.pressure < 0.02) return lockedToStar ? 'scorched rock' : 'airless rock';
  if (p.sea01 < 0.16) return 'desert world';
  if (h.substance === 'water' && h.state === 'liquid' && p.sea01 > 0.55) return 'ocean world';
  return 'temperate world';
}

/** Short physics summary line for rosters and the inspector. */
export function describeBody(p: BodyPhysics): string {
  if (p.kind === 'gas') return `${p.gravity.toFixed(1)}g · H/He`;
  const g = `${p.gravity.toFixed(2)}g`;
  const pr =
    p.atmosphere.pressure < 0.02
      ? 'no atm'
      : `${p.atmosphere.pressure < 10 ? p.atmosphere.pressure.toFixed(1) : Math.round(p.atmosphere.pressure)} atm`;
  const t = `${Math.round(p.TsurfK - 273)}°C`;
  return `${g} · ${pr} · ${t}`;
}

/** Dominant gases as a short readable string, e.g. "N2 77% · O2 21%". */
export function describeAtmosphere(a: AtmosphereSpec): string {
  if (a.pressure < 0.02) return 'none';
  const parts = (Object.entries(a.mix) as Array<[Gas, number]>)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .filter(([, f]) => f > 0.01)
    .map(([g, f]) => `${g} ${Math.round(f * 100)}%`);
  return parts.join(' · ') || 'trace';
}
