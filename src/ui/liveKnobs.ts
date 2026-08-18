/**
 * Cosmic-engineer knobs.
 *
 * Live: already GPU uniforms. A slide is the next frame.
 * Rebuild: harvest mint or dust bake. The slider is a draft;
 * Rebuild applies UNIVERSE and remints, Cancel discards.
 */
import { UNIVERSE } from '../world/physics';
import {
  HARVEST_SHINE_DIST_P,
  HARVEST_SHINE_GAIN,
  HARVEST_SHINE_SAT,
  HARVEST_SUPER_GAIN,
} from '../render/galaxyStar';

export type LiveKnob = {
  id: string;
  label: string;
  /** Short clause shown in the dropdown option. */
  hint: string;
  /** Full law, shown once the setting is selected. */
  about: string;
  uniform: string;
  min: number;
  max: number;
  step: number;
  read: () => number;
  write?: (v: number) => void;
};

export type RebuildScope = 'harvest' | 'dust';

export type RebuildKnob = {
  id: string;
  label: string;
  hint: string;
  about: string;
  scope: RebuildScope;
  key: string;
  min: number;
  max: number;
  step: number;
  read: () => number;
  write: (v: number) => void;
};

function writeNum(key: string, v: number): void {
  const u = UNIVERSE as unknown as Record<string, unknown>;
  if (typeof u[key] === 'number') u[key] = v;
}

export const LIVE_KNOBS: LiveKnob[] = [
  {
    id: 'extinctK',
    label: 'Dust extinction',
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
    hint: 'photograph stretch on H II, PN, SNR',
    about: 'Emission-measure gain on harvest nebulae. They screen-blend — they glow, they do not add to a white bar. Next frame.',
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
    hint: 'luminosity cut for who is in the sky',
    about: 'Present-day luminosity floor (L☉). Living stars below this stay out of the harvest. Higher = fewer, brighter pins. Needs remint.',
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
    hint: 'IMF gate that keeps the harvest walk cheap',
    about: 'IMF mass floor (M☉) for the harvest walk. Sit it with the L floor so the walk and the light agree. Needs remint.',
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
    label: 'Nebula harvest',
    hint: 'how faded a shell can be and still show',
    about: 'Minimum emission-gain for a nebula to join the harvest. Lower keeps faded shells; higher keeps showpieces. Needs remint.',
    scope: 'harvest',
    key: 'GALAXY_SILHOUETTE_NEB_GAIN',
    min: 0.05,
    max: 1,
    step: 0.005,
    read: () => UNIVERSE.GALAXY_SILHOUETTE_NEB_GAIN,
    write: (v) => writeNum('GALAXY_SILHOUETTE_NEB_GAIN', v),
  },
  {
    id: 'dustK',
    label: 'Death budget',
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
