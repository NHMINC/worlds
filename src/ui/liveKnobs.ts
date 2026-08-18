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
    uniform: 'uShineLGain',
    min: 0.05,
    max: 2.5,
    step: 0.01,
    read: () => HARVEST_SHINE_GAIN,
  },
  {
    id: 'shineDist',
    label: 'Shine vs distance',
    uniform: 'uShineDistP',
    min: 0,
    max: 1,
    step: 0.01,
    read: () => HARVEST_SHINE_DIST_P,
  },
  {
    id: 'colour',
    label: 'Star colour',
    uniform: 'uShineSat',
    min: 0.4,
    max: 5,
    step: 0.05,
    read: () => HARVEST_SHINE_SAT,
  },
  {
    id: 'super',
    label: 'Super-sun glow',
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
