/**
 * Cosmic-engineer knobs.
 *
 * Live: already GPU uniforms. A slide is the next frame.
 * Rebuild: star remint, nebula walk, or dust bake. The slider
 * is a draft; Rebuild applies UNIVERSE, Cancel discards.
 */
import { UNIVERSE } from '../world/physics';
import {
  HARVEST_SHINE_DIST_P,
  HARVEST_SHINE_GAIN,
  HARVEST_SHINE_SAT,
  HARVEST_SUPER_GAIN,
} from '../render/galaxyStar';

export type EngineerGroupId = 'cosmic' | 'dust' | 'harvest' | 'starlight' | 'nebulae';

export const ENGINEER_GROUPS: Array<{ id: EngineerGroupId; label: string }> = [
  { id: 'cosmic', label: 'Cosmic background' },
  { id: 'dust', label: 'Galactic dust' },
  { id: 'harvest', label: 'Harvest survey' },
  { id: 'starlight', label: 'Starlight' },
  { id: 'nebulae', label: 'Nebulae' },
];

export type LiveKnob = {
  id: string;
  label: string;
  group: EngineerGroupId;
  /** Short clause shown in the dropdown option. */
  hint: string;
  /** Full law, shown once the setting is selected. */
  about: string;
  uniform: string;
  min: number;
  max: number;
  step: number;
  /** Shipped law, captured at module load. */
  def?: number;
  read: () => number;
  write?: (v: number) => void;
};

export type RebuildScope = 'harvest' | 'nebula' | 'dust';

export type RebuildKnob = {
  id: string;
  label: string;
  group: EngineerGroupId;
  hint: string;
  about: string;
  scope: RebuildScope;
  key: string;
  min: number;
  max: number;
  step: number;
  /** Shipped law, captured at module load. */
  def?: number;
  read: () => number;
  write: (v: number) => void;
};

function writeNum(key: string, v: number): void {
  const u = UNIVERSE as unknown as Record<string, unknown>;
  if (typeof u[key] === 'number') u[key] = v;
}

export const LIVE_KNOBS: LiveKnob[] = [
  {
    id: 'void',
    label: 'Void colour',
    group: 'cosmic',
    hint: 'rainbow hue, then intensity',
    about: 'The decreed night behind everything. Pick a hue on the wheel, then how hard that tint is lit. 0 is black; 1 is a readable coloured night. The smudges sit on this. Next frame.',
    uniform: 'uVoidRgb',
    min: 0,
    max: 1,
    step: 0.01,
    read: () => UNIVERSE.COSMIC_INT,
    write: (v) => {
      UNIVERSE.COSMIC_INT = v;
    },
  },
  {
    id: 'cosmicGlow',
    label: 'Smudge brightness',
    group: 'cosmic',
    hint: 'how bright the galaxy smudges are',
    about: 'Gain on the whole smudge set. Each smudge already has its own shine — this lifts or drops them together. Does not touch the background stars. Next frame.',
    uniform: 'uCosmicGain',
    min: 0,
    max: 4,
    step: 0.02,
    read: () => UNIVERSE.COSMIC_GAIN,
    write: (v) => {
      UNIVERSE.COSMIC_GAIN = v;
    },
  },
  {
    id: 'cosmicSize',
    label: 'Smudge size',
    group: 'cosmic',
    hint: 'how large each distant galaxy is',
    about: 'Set-wide angular scale. Each distant galaxy already has its own size, inclination, and position angle. Small keeps them as specks; large opens the disks. Next frame.',
    uniform: 'uCosmicSize',
    min: 0.08,
    max: 2.2,
    step: 0.02,
    read: () => UNIVERSE.COSMIC_SIZE,
    write: (v) => {
      UNIVERSE.COSMIC_SIZE = v;
    },
  },
  {
    id: 'cosmicWeb',
    label: 'Clustering',
    group: 'cosmic',
    hint: 'how hard smudges pile into a web',
    about: 'Power on the large-scale web. Higher empties the voids and tightens the piles. Replaces the smudge photograph — next frame.',
    uniform: 'uCosmicCluster',
    min: 0.4,
    max: 4,
    step: 0.05,
    read: () => UNIVERSE.COSMIC_CLUSTER,
    write: (v) => {
      UNIVERSE.COSMIC_CLUSTER = v;
    },
  },
  {
    id: 'cosmicSmudgeN',
    label: 'Smudge count',
    group: 'cosmic',
    hint: 'how many galaxy smudges are on',
    about: 'How many smudges are drawn, 0 to 1000. The full budget is already on the GPU — a slide is the next frame. Each smudge keeps its own shine.',
    uniform: 'uSmudgeN',
    min: 0,
    max: UNIVERSE.COSMIC_SMUDGE_N_MAX,
    step: 1,
    read: () => UNIVERSE.COSMIC_SMUDGE_N,
    write: (v) => {
      UNIVERSE.COSMIC_SMUDGE_N = Math.round(v);
    },
  },
  {
    id: 'cosmicStars',
    label: 'Background-star brightness',
    group: 'cosmic',
    hint: 'how bright the far pins are',
    about: 'Gain on the whole background-star set. Each pin already has its own shine — this lifts or drops them together. Does not touch the smudges. Next frame.',
    uniform: 'uStarGain',
    min: 0,
    max: 4,
    step: 0.02,
    read: () => UNIVERSE.COSMIC_STAR_GAIN,
    write: (v) => {
      UNIVERSE.COSMIC_STAR_GAIN = v;
    },
  },
  {
    id: 'cosmicStarN',
    label: 'Background-star count',
    group: 'cosmic',
    hint: 'how many far pins are on',
    about: 'How many background stars are drawn, 0 to 100000. The full budget is already on the GPU — a slide is the next frame. Each pin keeps its own shine.',
    uniform: 'uStarN',
    min: 0,
    max: UNIVERSE.COSMIC_STAR_N_MAX,
    step: 100,
    read: () => UNIVERSE.COSMIC_STAR_N,
    write: (v) => {
      UNIVERSE.COSMIC_STAR_N = Math.round(v);
    },
  },
  {
    id: 'extinctK',
    label: 'Dust extinction',
    group: 'dust',
    hint: 'how hard the fog filters starlight',
    about: 'Beer–Lambert multiplier on the baked death-smear fog. Higher and stars behind a pocket go darker. Next frame.',
    uniform: 'uExtinctK',
    min: 0,
    max: 16,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_EXTINCT_K,
    write: (v) => {
      UNIVERSE.GALAXY_EXTINCT_K = v;
    },
  },
  {
    id: 'extinctMax',
    label: 'Extinction cap',
    group: 'dust',
    hint: 'darkest a sightline is allowed to go',
    about: 'Optical-depth ceiling. A stack of pockets can extinguish, but not past this. Next frame.',
    uniform: 'uExtinctMax',
    min: 0.5,
    max: 24,
    step: 0.1,
    read: () => UNIVERSE.GALAXY_EXTINCT_MAX,
    write: (v) => {
      UNIVERSE.GALAXY_EXTINCT_MAX = v;
    },
  },
  {
    id: 'nebula',
    label: 'Nebula glow',
    group: 'nebulae',
    hint: 'photograph stretch on H II, PN, SNR',
    about: 'Emission-measure gain on catalog nebulae. They screen-blend — they glow, they do not add to a white bar. Next frame.',
    uniform: 'uNebGain',
    min: 0,
    max: 4,
    step: 0.02,
    read: () => UNIVERSE.NEB_EMISSION * UNIVERSE.SILHOUETTE_NEB_BOOST,
    write: (v) => {
      UNIVERSE.NEB_EMISSION = v / Math.max(1e-6, UNIVERSE.SILHOUETTE_NEB_BOOST);
    },
  },
  {
    id: 'shine',
    label: 'Star shine',
    group: 'starlight',
    hint: 'harvest-star brightness',
    about: 'Intensity gain on the harvest PSF. Brighter pins; the catalogue does not change. Next frame.',
    uniform: 'uShineLGain',
    min: 0.05,
    max: 2.5,
    step: 0.01,
    read: () => HARVEST_SHINE_GAIN,
  },
  {
    id: 'shineDist',
    label: 'Shine vs distance',
    group: 'starlight',
    hint: 'how fast shine falls with range',
    about: 'Distance falloff on shine. 0 is flat; 1 leans toward inverse-square. Next frame.',
    uniform: 'uShineDistP',
    min: 0,
    max: 1,
    step: 0.01,
    read: () => HARVEST_SHINE_DIST_P,
  },
  {
    id: 'colour',
    label: 'Star colour',
    group: 'starlight',
    hint: 'how much photosphere hue survives',
    about: 'Saturation of photosphere colour in the glow. High keeps hue; low bleaches the photocentre. Next frame.',
    uniform: 'uShineSat',
    min: 0.4,
    max: 5,
    step: 0.05,
    read: () => HARVEST_SHINE_SAT,
  },
  {
    id: 'super',
    label: 'Super-sun glow',
    group: 'starlight',
    hint: 'extra glare on the rare brightest stars',
    about: 'Leftover-luminosity glare above the super-sun floor. Fainter harvest rows are unchanged. Next frame.',
    uniform: 'uSuperGain',
    min: 0,
    max: 16,
    step: 0.1,
    read: () => HARVEST_SUPER_GAIN,
  },
];

export function liveKnob(id: string): LiveKnob | undefined {
  return LIVE_KNOBS.find((k) => k.id === id);
}

export const REBUILD_KNOBS: RebuildKnob[] = [
  {
    id: 'silL',
    label: 'Survey floor L',
    group: 'harvest',
    hint: 'luminosity cut for who is in the sky',
    about: 'Present-day luminosity floor (L☉). The walk follows the MS invert of this (L = 1.4 M^3.5) so 20 L☉ actually opens fainter slots — it is not only a filter on the 3.89 M☉ tail. Higher = fewer, brighter pins. Needs remint.',
    scope: 'harvest',
    key: 'GALAXY_SILHOUETTE_L',
    min: 20,
    max: 4000,
    step: 1,
    read: () => UNIVERSE.GALAXY_SILHOUETTE_L,
    write: (v) => writeNum('GALAXY_SILHOUETTE_L', v),
  },
  {
    id: 'silM',
    label: 'Survey mass floor',
    group: 'harvest',
    hint: 'IMF gate that keeps the harvest walk cheap',
    about: 'IMF mass floor (M☉). The walk uses the deeper of this and the L-equivalent mass. Lower this to pick up faint giants below the MS invert of Survey floor L. Needs remint.',
    scope: 'harvest',
    key: 'GALAXY_SILHOUETTE_M',
    min: 1.5,
    max: 12,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_SILHOUETTE_M,
    write: (v) => writeNum('GALAXY_SILHOUETTE_M', v),
  },
  {
    id: 'silNeb',
    label: 'Nebula showpiece',
    group: 'nebulae',
    hint: 'how faded a shell can be and still show',
    about: 'Minimum emission-gain for a PN or SNR to join the nebula catalog. Lower keeps faded shells; higher keeps showpieces. H II always stays. Needs nebula rebake — stars stay.',
    scope: 'nebula',
    key: 'GALAXY_SILHOUETTE_NEB_GAIN',
    min: 0.05,
    max: 1,
    step: 0.005,
    read: () => UNIVERSE.GALAXY_SILHOUETTE_NEB_GAIN,
    write: (v) => writeNum('GALAXY_SILHOUETTE_NEB_GAIN', v),
  },
  {
    id: 'nebM',
    label: 'Nebula mass floor',
    group: 'nebulae',
    hint: 'IMF gate for the PN / SNR walk',
    about: 'IMF mass floor (M☉) for planetary nebulae and remnants. H II (massive, in a cloud) is always walked. Lower finds more leftover shells. Needs nebula rebake — stars stay.',
    scope: 'nebula',
    key: 'GALAXY_NEBULA_M',
    min: 0.8,
    max: 12,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_NEBULA_M,
    write: (v) => writeNum('GALAXY_NEBULA_M', v),
  },
  {
    id: 'hiiGyr',
    label: 'H II window',
    group: 'nebulae',
    hint: 'how long a nursery stays lit (Gyr)',
    about: 'Toy-stretched H II lifetime. Longer keeps more natal clouds around young O/B stars. Needs nebula rebake — stars stay.',
    scope: 'nebula',
    key: 'HII_GYR',
    min: 0.002,
    max: 0.08,
    step: 0.001,
    read: () => UNIVERSE.HII_GYR,
    write: (v) => writeNum('HII_GYR', v),
  },
  {
    id: 'pnGyr',
    label: 'PN window',
    group: 'nebulae',
    hint: 'how long a planetary shell stays findable (Gyr)',
    about: 'Toy-stretched planetary-nebula window after the giant dies. Longer keeps more faded PNe. Needs nebula rebake — stars stay.',
    scope: 'nebula',
    key: 'PN_GYR',
    min: 0.005,
    max: 0.2,
    step: 0.001,
    read: () => UNIVERSE.PN_GYR,
    write: (v) => writeNum('PN_GYR', v),
  },
  {
    id: 'snrGyr',
    label: 'SNR window',
    group: 'nebulae',
    hint: 'how long a remnant stays findable (Gyr)',
    about: 'Toy-stretched supernova-remnant window. Longer keeps more leftover lace. Needs nebula rebake — stars stay.',
    scope: 'nebula',
    key: 'SNR_GYR',
    min: 0.005,
    max: 0.25,
    step: 0.001,
    read: () => UNIVERSE.SNR_GYR,
    write: (v) => writeNum('SNR_GYR', v),
  },
  {
    id: 'dustK',
    label: 'Death budget',
    group: 'dust',
    hint: 'how many dusty deaths bake into the fog',
    about: 'Photograph budget for death smears. Occupancy × this / N_K ≈ filament count. Too low and the fog is empty. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_EVENT_K',
    min: 20,
    max: 2000,
    step: 5,
    read: () => UNIVERSE.GALAXY_DUST_EVENT_K,
    write: (v) => writeNum('GALAXY_DUST_EVENT_K', v),
  },
  {
    id: 'dustM',
    label: 'Dusty death mass',
    group: 'dust',
    hint: 'IMF floor for a smear (AGB + SN)',
    about: 'IMF floor (M☉) for a dusty death. Lower includes more leftover ash; higher keeps only massive deaths. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_M',
    min: 0.8,
    max: 8,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_M,
    write: (v) => writeNum('GALAXY_DUST_M', v),
  },
  {
    id: 'smearGyr',
    label: 'Smear lifetime',
    group: 'dust',
    hint: 'how long a filament stays distinct',
    about: 'How long a smear stays distinct before it has mixed away. Older death, longer swirl. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_SMEAR_GYR',
    min: 0.05,
    max: 2.5,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_DUST_SMEAR_GYR,
    write: (v) => writeNum('GALAXY_DUST_SMEAR_GYR', v),
  },
  {
    id: 'expR',
    label: 'Explosion reach',
    group: 'dust',
    hint: 'size of one death (kpc)',
    about: 'Explosion reach in kpc. One event is a thin filament, not a blackout. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_EXP_R',
    min: 0.03,
    max: 0.8,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_DUST_EXP_R,
    write: (v) => writeNum('GALAXY_DUST_EXP_R', v),
  },
  {
    id: 'rays',
    label: 'Filament rays',
    group: 'dust',
    hint: 'strands per explosion',
    about: 'Filament count per death. More rays, messier pocket. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_RAYS',
    min: 1,
    max: 16,
    step: 1,
    read: () => UNIVERSE.GALAXY_DUST_RAYS,
    write: (v) => writeNum('GALAXY_DUST_RAYS', Math.round(v)),
  },
  {
    id: 'loft',
    label: 'Ejecta loft',
    group: 'dust',
    hint: 'how far ash leaves the disc',
    about: 'How far ejecta can leave the disc. Edge-on this is the mottled strip, not a pancake. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_LOFT',
    min: 0.1,
    max: 2.5,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_LOFT,
    write: (v) => writeNum('GALAXY_DUST_LOFT', v),
  },
  {
    id: 'smearRho',
    label: 'Pocket density',
    group: 'dust',
    hint: 'opacity of one filament',
    about: 'Per-voxel add of one filament. One pocket is a veil; stacked pockets go darker. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_SMEAR_RHO',
    min: 0.02,
    max: 1.2,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_DUST_SMEAR_RHO,
    write: (v) => writeNum('GALAXY_DUST_SMEAR_RHO', v),
  },
  {
    id: 'vCirc',
    label: 'Shear speed',
    group: 'dust',
    hint: 'how fast rotation drags a smear into an arc',
    about: 'Circular speed (kpc/Gyr) for Ω = V/R. Faster shear, longer trailing arcs. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_V_CIRC',
    min: 50,
    max: 400,
    step: 5,
    read: () => UNIVERSE.GALAXY_DUST_V_CIRC,
    write: (v) => writeNum('GALAXY_DUST_V_CIRC', v),
  },
];

export function rebuildKnob(id: string): RebuildKnob | undefined {
  return REBUILD_KNOBS.find((k) => k.id === id);
}

export type EngineerChoice = {
  id: string;
  label: string;
  hint: string;
  remint: boolean;
};

export function knobsInGroup(group: EngineerGroupId): EngineerChoice[] {
  const live = LIVE_KNOBS.filter((k) => k.group === group).map((k) => ({
    id: k.id,
    label: k.label,
    hint: k.hint,
    remint: false,
  }));
  const remint = REBUILD_KNOBS.filter((k) => k.group === group).map((k) => ({
    id: k.id,
    label: k.label,
    hint: k.hint,
    remint: true,
  }));
  return [...live, ...remint];
}

for (const k of LIVE_KNOBS) k.def = k.read();
for (const k of REBUILD_KNOBS) k.def = k.read();

/** Shipped void hue, captured at module load with the other defaults. */
export const VOID_HUE_DEF = UNIVERSE.COSMIC_HUE;

export function atVoidDefault(hue: number, intensity: number): boolean {
  const voidKnob = LIVE_KNOBS.find((k) => k.id === 'void');
  const hueOk = Math.abs(((hue - VOID_HUE_DEF + 1.5) % 1) - 0.5) <= 0.005;
  return hueOk && Boolean(voidKnob && atDefault(voidKnob, intensity));
}

export function knobDefault(k: { def?: number; read: () => number }): number {
  return k.def ?? k.read();
}

export function atDefault(k: { def?: number; read: () => number; step: number }, value: number): boolean {
  return Math.abs(value - knobDefault(k)) <= k.step * 0.25;
}
