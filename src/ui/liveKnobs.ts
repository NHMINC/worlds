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
    about: 'Gain on the whole smudge set. Each galaxy already has its own shine and crispness — this lifts or drops them together. Does not touch the background stars. Next frame.',
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
    about: 'How many smudges are drawn, 0 to 1000. Address i is already on the sphere — a slide shows the first N, still a full sky. Each smudge keeps its own shine.',
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
    about: 'Gain on the whole background-star set. Each pin already has its own shine (most dim, a few nearby) — this lifts or drops them together. Does not touch the smudges. Next frame.',
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
    about: 'How many background stars are drawn, 0 to 100000. Address i is already on the sphere — a slide shows the first N, still a full sky. Each pin keeps its own shine.',
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
    hint: 'overall opacity of the fog',
    about: 'Beer–Lambert gain on the reddened skin — the rim that is not yet a wall. Does not grow the ribbons. Next frame.',
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
    id: 'extinctCut',
    label: 'Dust floor',
    group: 'dust',
    hint: 'drop thin haze; cores stay',
    about: 'Density below this is empty. Raise it and the soft halo around a ribbon vanishes — the fog keeps its shape instead of spreading. Pair with Dust extinction to keep the cores black. Next frame.',
    uniform: 'uExtinctCut',
    min: 0,
    max: 0.7,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_EXTINCT_CUT,
    write: (v) => {
      UNIVERSE.GALAXY_EXTINCT_CUT = v;
    },
  },
  {
    id: 'extinctHard',
    label: 'Dust hardness',
    group: 'dust',
    hint: 'how sharp the ribbon edges are',
    about: 'Power on remaining density. 1 is the bake (soft falloff). Higher hardens the core and thins the edge — opaque without growing the ribbon. Next frame.',
    uniform: 'uExtinctHard',
    min: 0.4,
    max: 4,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_EXTINCT_HARD,
    write: (v) => {
      UNIVERSE.GALAXY_EXTINCT_HARD = v;
    },
  },
  {
    id: 'extinctWall',
    label: 'Dust wall',
    group: 'dust',
    hint: 'cores go black; only the rim reddens',
    about: 'Density at or above this is a wall — no starlight through the ribbon. Below it is a thin reddened skin (blue dies first). 0 is the old veil: every column is fog. The “sometimes” is whether a sightline hits a filament, not a coin flip per cloud. Next frame.',
    uniform: 'uExtinctWall',
    min: 0,
    max: 1,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_EXTINCT_WALL,
    write: (v) => {
      UNIVERSE.GALAXY_EXTINCT_WALL = v;
    },
  },
  {
    id: 'extinctMax',
    label: 'Extinction cap',
    group: 'dust',
    hint: 'darkest a sightline is allowed to go',
    about: 'Optical-depth ceiling. A stack of ribbons can extinguish, but not past this. Next frame.',
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
    id: 'dustDebug',
    label: 'Paint fog green',
    group: 'dust',
    hint: 'look-test of the baked fog',
    about: 'Look test, not a colour of the universe. 0 is the real law — dust is extinction, never drawn. 1 paints a bright lime skin on the last baked ribbons so you can size and shape them. Change a ribbon knob and Rebuild, then the lime is the new bake. Stars stay themselves. Next frame.',
    uniform: 'uDustDebug',
    min: 0,
    max: 1,
    step: 1,
    read: () => UNIVERSE.GALAXY_DUST_DEBUG,
    write: (v) => {
      UNIVERSE.GALAXY_DUST_DEBUG = v >= 0.5 ? 1 : 0;
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
    max: 5,
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
    about: 'Present-day luminosity floor (L☉). Applied after the mass cut: higher drops the dimmer members of that IMF tail; lower keeps them. To open fainter spectral types, lower Survey mass floor. Needs remint.',
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
    about: 'IMF mass floor (M☉). The harvest only walks and shows slots at or above this mass. Higher = fewer, heavier pins; lower = more of the IMF. Survey floor L then cuts on present-day light. Needs remint.',
    scope: 'harvest',
    key: 'GALAXY_SILHOUETTE_M',
    min: 1.5,
    max: 12,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_SILHOUETTE_M,
    write: (v) => writeNum('GALAXY_SILHOUETTE_M', v),
  },
  {
    id: 'silGiantM',
    label: 'Giant-branch mass',
    group: 'harvest',
    hint: 'IMF floor for the old yellow giant walk',
    about: 'Old-clock RGB / AGB. The hot survey never walks this mass — a ~1 M☉ star is a remnant before the bulge is old. Lower opens more of that slice (the Hubble bump). Needs remint.',
    scope: 'harvest',
    key: 'GALAXY_SILHOUETTE_GIANT_M',
    min: 0.7,
    max: 2,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_SILHOUETTE_GIANT_M,
    write: (v) => writeNum('GALAXY_SILHOUETTE_GIANT_M', v),
  },
  {
    id: 'silGiantL',
    label: 'Giant-branch floor L',
    group: 'harvest',
    hint: 'luminosity keep for those giants',
    about: 'Present-day L☉ keep on the giant / subgiant clock. Low-mass RGB is ~16–56 L☉ — they fail Survey floor L. Lower keeps more of the yellow bump. Needs remint.',
    scope: 'harvest',
    key: 'GALAXY_SILHOUETTE_GIANT_L',
    min: 8,
    max: 200,
    step: 1,
    read: () => UNIVERSE.GALAXY_SILHOUETTE_GIANT_L,
    write: (v) => writeNum('GALAXY_SILHOUETTE_GIANT_L', v),
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
    id: 'dustHole',
    label: 'Inner hole',
    group: 'dust',
    hint: 'how empty the axle is (kpc)',
    about: 'Bar-swept cavity in the molecular sheet. Ribbons start outside this radius — they are not piled on the axle. 0 closes the hole. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_HOLE',
    min: 0,
    max: 6,
    step: 0.1,
    read: () => UNIVERSE.GALAXY_DUST_HOLE,
    write: (v) => writeNum('GALAXY_DUST_HOLE', v),
  },
  {
    id: 'dustHoleP',
    label: 'Hole sharpness',
    group: 'dust',
    hint: 'how sharp the cavity wall is',
    about: 'Power on the hole. Higher and the cavity cuts off more suddenly. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_HOLE_P',
    min: 1,
    max: 4,
    step: 0.1,
    read: () => UNIVERSE.GALAXY_DUST_HOLE_P,
    write: (v) => writeNum('GALAXY_DUST_HOLE_P', v),
  },
  {
    id: 'rdGas',
    label: 'Gas scale length',
    group: 'dust',
    hint: 'how fast ribbons fade outward',
    about: 'Exponential scale of the molecular sheet, in stellar Rd units. Smaller keeps more ribbon in the inner disc. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_RD_GAS',
    min: 0.8,
    max: 3,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_RD_GAS,
    write: (v) => writeNum('GALAXY_RD_GAS', v),
  },
  {
    id: 'zdGas',
    label: 'Sheet thickness',
    group: 'dust',
    hint: 'how tall the molecular sheet is',
    about: 'Vertical scale of the gas, relative to the warped midplane. Edge-on this is the mottled stripe, not a ruler through z = 0. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_ZD_GAS',
    min: 0.04,
    max: 0.4,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_ZD_GAS,
    write: (v) => writeNum('GALAXY_ZD_GAS', v),
  },
  {
    id: 'gasArmA',
    label: 'Arm contrast',
    group: 'dust',
    hint: 'how much gas prefers the spiral arms',
    about: 'Arm overdensity on the molecular sheet. Higher and the ribbons follow the log-spirals more tightly. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_GAS_ARM_A',
    min: 0,
    max: 4,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_GAS_ARM_A,
    write: (v) => writeNum('GALAXY_GAS_ARM_A', v),
  },
  {
    id: 'denseCut',
    label: 'Ribbon floor',
    group: 'dust',
    hint: 'field threshold for a dark thread',
    about: 'ismAt below this does not write. Raise it and you get fewer, darker threads — the disc stays mostly starry. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_DENSE_CUT',
    min: 0,
    max: 1,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_DUST_DENSE_CUT,
    write: (v) => writeNum('GALAXY_DUST_DENSE_CUT', v),
  },
  {
    id: 'dustStreak',
    label: 'Ribbon contrast',
    group: 'dust',
    hint: 'how thin the filaments are',
    about: 'Power on the dense-tail excess. Higher thins the filaments. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_STREAK',
    min: 0.4,
    max: 3,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_STREAK,
    write: (v) => writeNum('GALAXY_DUST_STREAK', v),
  },
  {
    id: 'turbSigma',
    label: 'Clumping',
    group: 'dust',
    hint: 'how strongly turbulence bunches the gas',
    about: 'Log-normal σ on the interpolated ISM noise. Higher and the sheet breaks into denser complexes. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_TURB_SIGMA',
    min: 0,
    max: 3,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_TURB_SIGMA,
    write: (v) => writeNum('GALAXY_TURB_SIGMA', v),
  },
  {
    id: 'turbShear',
    label: 'Filament shear',
    group: 'dust',
    hint: 'along-arm vs across-arm eddy aspect',
    about: 'Stretches the turbulence along the spiral. 1 is round fluff; higher is filaments. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_TURB_SHEAR',
    min: 0.2,
    max: 6,
    step: 0.1,
    read: () => UNIVERSE.GALAXY_TURB_SHEAR,
    write: (v) => writeNum('GALAXY_TURB_SHEAR', v),
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
