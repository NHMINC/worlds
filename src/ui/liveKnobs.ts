/**
 * Cosmic-engineer knobs.
 *
 * Live: already GPU uniforms. A slide is the next frame.
 * Rebuild: star remint, nebula walk, or dust bake. The slider
 * is a draft; Rebuild applies UNIVERSE, Cancel discards.
 */
import { UNIVERSE } from '../world/physics';
import {
  HARVEST_DENS_GAIN,
  HARVEST_HUE_FLOOR,
  HARVEST_SHINE_DIST_P,
  HARVEST_SHINE_GAIN,
  HARVEST_SHINE_L_P,
  HARVEST_WHITE_K,
} from '../render/galaxyStar';

export type EngineerGroupId =
  | 'cosmic'
  | 'dust'
  | 'harvest'
  | 'starlight'
  | 'approach'
  | 'nebulae';

export const ENGINEER_GROUPS: Array<{ id: EngineerGroupId; label: string }> = [
  { id: 'cosmic', label: 'Cosmic background' },
  { id: 'dust', label: 'Galactic dust' },
  { id: 'harvest', label: 'Harvest survey' },
  { id: 'starlight', label: 'Starlight' },
  { id: 'approach', label: 'Approach' },
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
    about: 'The one opacity slider. 0 is clear; the reddened skin and the per-cloud opacity sum both grade with it, reaching full darkness at 6. Does not grow the ribbons. Next frame.',
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
    hint: 'what counts as a cloud',
    about: 'Field below this is not a cloud. The bake stores the raw photograph, so this carves it live — lower = more, softer clouds; higher = fewer, darker patches. Also anchors the per-cloud fade: opacity ramps from this floor up to Abyss density. Next frame.',
    uniform: 'uExtinctCut',
    min: 0.01,
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
    about: 'Power on the field above the floor. Higher hardens the core and thins the edge — opaque without growing the ribbon. Next frame.',
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
    id: 'extinctAbyss',
    label: 'Abyss density',
    group: 'dust',
    hint: 'density where dust counts as abyss-grade',
    about: 'Cloud opacity is a column: density ramps from the dust floor to this, integrated along the sightline — a typical cloud is a translucent reddened veil (~1 magnitude), a dense cloud goes lightless in about one diameter, and overlaps stack toward black. Lower makes more abysses; higher makes all dust hazier. Stars and the cosmic background obey the same column. Next frame.',
    uniform: 'uExtinctAbyss',
    min: 0.08,
    max: 1,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_EXTINCT_ABYSS,
    write: (v) => {
      UNIVERSE.GALAXY_EXTINCT_ABYSS = v;
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
    id: 'timeLapse',
    label: 'Time lapse',
    group: 'starlight',
    hint: 'observer rate: 0 is 1:1, 6 is a million×',
    about: 'Wall seconds → system seconds as 10^this. 0 is a real day and a real year. Raise it to watch seasons, orbits, and the sea on the same closed-form clock — pose, night, season, and waves are f(spec, t), not a simulation step. Next frame.',
    uniform: 'uTimeLapse',
    min: 0,
    max: 6,
    step: 0.05,
    read: () => Math.log10(Math.max(1, UNIVERSE.TIME_SCALE)),
    write: (v) => {
      UNIVERSE.TIME_SCALE = 10 ** v;
    },
  },
  {
    id: 'shine',
    label: 'Star shine',
    group: 'starlight',
    hint: 'magnitude zero-point of the photograph',
    about: 'Intensity gain on the harvest PSF — the exposure. Low keeps the survey floor nearly invisible so magnitude runs smoothly up to the luminous tail; high pins more of the population at full brightness. The catalogue does not change. Next frame.',
    uniform: 'uShineLGain',
    min: 0.01,
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
    id: 'densGlow',
    label: 'Density glow',
    group: 'starlight',
    hint: 'ambassador light: dense regions glow',
    about: 'Each sampled star stands in for thousands of unsampled neighbours; this scales its light with the local star density — the stand-in for the unresolved sum a real photograph integrates. High and the core runs the overexposure law into white-gold; 0 paints every row as itself alone. Next frame.',
    uniform: 'uDensGain',
    min: 0,
    max: 20,
    step: 0.1,
    read: () => HARVEST_DENS_GAIN,
  },
  {
    id: 'hueFloor',
    label: 'Colour floor',
    group: 'starlight',
    hint: 'warm colours start at yellow-gold',
    about: 'Integrated old-population light blends to gold, never a lone dwarf\'s brown — warm rows floor their green/blue at yellow-gold. 1 is the shipped blend; 0 restores individual star colours (browns return). Next frame.',
    uniform: 'uHueFloor',
    min: 0,
    max: 1.2,
    step: 0.01,
    read: () => HARVEST_HUE_FLOOR,
  },
  {
    id: 'whiteBal',
    label: 'White balance',
    group: 'starlight',
    hint: 'which star temperature reads pure white (kK)',
    about: 'The photograph\'s white point in thousands of Kelvin — the camera law, one divide in linear light. 6.6 is the raw blackbody locus (everything cooler paints orange). The warm end needs a long throw: hot stars shift fast, but M dwarfs only reach yellow near 4.5 and white near 3.0. Next frame.',
    uniform: 'uWhiteK',
    min: 3,
    max: 8,
    step: 0.05,
    read: () => HARVEST_WHITE_K,
  },
  {
    id: 'starMag',
    label: 'Magnitude contrast',
    group: 'starlight',
    hint: 'how much luminosity separates the stars',
    about: 'Power on luminosity in the photograph. Low compresses everything toward one brightness (the blue tail vanishes into the crowd); high lets an O star genuinely outshine the floor — and the hue-preserving plateau keeps that extra light blue. Next frame.',
    uniform: 'uShineLP',
    min: 0.3,
    max: 1,
    step: 0.01,
    read: () => HARVEST_SHINE_L_P,
  },
  {
    id: 'arriveRange',
    label: 'Sphere of influence',
    group: 'approach',
    hint: 'how far the host bubble reaches (ly)',
    about: 'Fixed fence around the host star — speed limit, sticky lock, furnace, and galaxy dim all use this radius. Not object-size: a supergiant and an M dwarf share the same bubble. 0.01 ly is ~630 AU; the slider runs 0.001–0.01 ly (~63–630 AU). Even the floor still swallows every system in the bottle (planets inside 30 AU). Next frame.',
    uniform: 'uArriveRange',
    min: 0.001,
    max: 0.01,
    step: 0.0005,
    read: () => UNIVERSE.ARRIVE_RANGE_LY,
    write: (v) => {
      UNIVERSE.ARRIVE_RANGE_LY = v;
    },
  },
  {
    id: 'arriveBrake',
    label: 'Approach brake',
    group: 'approach',
    hint: 'how far out full warp begins to fall (ly)',
    about: 'Ahead only. Full disk warp outside this radius. Inside it, speed is half of disk warp, held until one frame would reach the sphere, then half again — the longest stretch at each gear, the fewest frames to the fence. The floor is the sphere speed limit. Astern does not use this. 50 ly is the law. Next frame.',
    uniform: 'uArriveBrake',
    min: 10,
    max: 100,
    step: 5,
    read: () => UNIVERSE.ARRIVE_BRAKE_LY,
    write: (v) => {
      UNIVERSE.ARRIVE_BRAKE_LY = v;
    },
  },
  {
    id: 'arriveSky',
    label: 'Galaxy dim',
    group: 'approach',
    hint: 'how bright the survey stays at the star',
    about: 'Place law inside any sphere of influence: 1 at the fence, this floor at the centre, linear in catalog distance. Camera, ship, planet, pin — same sample. Lock, helm gear, and look-around do not enter. The 50 ly gears do not dim. 0.08 is a dark-sky Earth night, a bit clearer. 0 is pitch black. The host furnace is not multiplied. Next frame.',
    uniform: 'uArriveSky',
    min: 0,
    max: 0.4,
    step: 0.005,
    read: () => UNIVERSE.ARRIVE_SKY_GAIN,
    write: (v) => {
      UNIVERSE.ARRIVE_SKY_GAIN = v;
    },
  },
  {
    id: 'arriveWarp',
    label: 'Approach warp',
    group: 'approach',
    hint: 'speed inside the sphere, as a fraction of disk warp',
    about: 'Extra cap inside the host bubble (warp, WASD, strafe, zoom), on top of Close crawl × distance. The half-warp gears stop at this floor when they reach the fence. Next frame.',
    uniform: 'uArriveWarp',
    min: 0.0002,
    max: 0.02,
    step: 0.0002,
    read: () => UNIVERSE.ARRIVE_WARP,
    write: (v) => {
      UNIVERSE.ARRIVE_WARP = v;
    },
  },
  {
    id: 'arriveK',
    label: 'Close crawl',
    group: 'approach',
    hint: 'v ≤ this × distance on the last stretch',
    about: 'Inside the sphere (and the floor of the half-warp gears at the fence), v ≤ this × catalog distance so the disk-growth stretch lasts seconds. Higher arrives faster. Next frame.',
    uniform: 'uArriveK',
    min: 0.3,
    max: 4,
    step: 0.05,
    read: () => UNIVERSE.ARRIVE_K,
    write: (v) => {
      UNIVERSE.ARRIVE_K = v;
    },
  },
  {
    id: 'arriveFill',
    label: 'Park fill',
    group: 'approach',
    hint: 'how much of the view the disk covers at Stop',
    about: 'On a locked course, warp latches Stop when the photosphere — or a coursed world disk — covers this fraction of the shorter field (width in portrait, height in landscape). Size law, not the sphere. Next frame.',
    uniform: 'uArriveFill',
    min: 0.08,
    max: 0.5,
    step: 0.01,
    read: () => UNIVERSE.ARRIVE_FILL,
    write: (v) => {
      UNIVERSE.ARRIVE_FILL = v;
    },
  },
  {
    id: 'arriveHold',
    label: 'Heading hold',
    group: 'approach',
    hint: 'how fast the nose eases onto the course (1/s)',
    about: 'Set course eases the nose onto the star or world at this rate and keeps it there while flying. A look drag hands the stick back. Next frame.',
    uniform: 'uArriveHold',
    min: 0.5,
    max: 8,
    step: 0.1,
    read: () => UNIVERSE.ARRIVE_HOLD,
    write: (v) => {
      UNIVERSE.ARRIVE_HOLD = v;
    },
  },
  {
    id: 'aimRange',
    label: 'Reticle range',
    group: 'approach',
    hint: 'how far the sight plate will name a star (kpc)',
    about: 'The plate only locks a star inside this neighbourhood — not the far disk. Inside a host, worlds are always in range. Set course to another star still needs you to leave the host sphere. Next frame.',
    uniform: 'uAimRange',
    min: 0.2,
    max: 4,
    step: 0.05,
    read: () => UNIVERSE.AIM_RANGE_KPC,
    write: (v) => {
      UNIVERSE.AIM_RANGE_KPC = v;
    },
  },
  {
    id: 'worldRange',
    label: 'World sphere',
    group: 'approach',
    hint: 'how far the world fence reaches (AU)',
    about: 'Fixed fence around a coursed world inside the host bubble — speed limit and sticky lock. Not object-size: park is the fill law. 0.02 AU is a few million km. Next frame.',
    uniform: 'uWorldRange',
    min: 0.005,
    max: 0.1,
    step: 0.005,
    read: () => UNIVERSE.WORLD_RANGE_AU,
    write: (v) => {
      UNIVERSE.WORLD_RANGE_AU = v;
    },
  },
  {
    id: 'worldBrake',
    label: 'World brake',
    group: 'approach',
    hint: 'how far out the world gears begin (AU)',
    about: 'Ahead only, and only on a world course. Outside this radius, cruise is Close crawl × distance to the world (capped by Approach warp). Inside it, half of that until a frame would hit the world fence, then half again. Astern does not use this. Next frame.',
    uniform: 'uWorldBrake',
    min: 0.2,
    max: 15,
    step: 0.2,
    read: () => UNIVERSE.WORLD_BRAKE_AU,
    write: (v) => {
      UNIVERSE.WORLD_BRAKE_AU = v;
    },
  },
  {
    id: 'warpCross',
    label: 'Disk warp',
    group: 'approach',
    hint: 'seconds rim-to-rim across the disk',
    about: 'Latched warp: diameter of the disk in this many seconds. Lower is a faster cruise between the stars. Inside a host sphere, Approach warp still owns the speed. Next frame.',
    uniform: 'uWarpCross',
    min: 20,
    max: 180,
    step: 1,
    read: () => UNIVERSE.GALAXY_WARP_CROSS_S,
    write: (v) => {
      UNIVERSE.GALAXY_WARP_CROSS_S = v;
    },
  },
];

export function liveKnob(id: string): LiveKnob | undefined {
  return LIVE_KNOBS.find((k) => k.id === id);
}

export const REBUILD_KNOBS: RebuildKnob[] = [
  {
    id: 'sampleN',
    label: 'Sample size',
    group: 'harvest',
    hint: 'how many stars the harvest draws from the galaxy',
    about: 'The harvest budget, split equally across the spectral-class mass strata (a truly uniform draw is ~85% red dwarfs), plus zoo strata that guarantee the showpieces: the gold giant branch, black holes, pulsars, the living massive tail. Each stratum samples uniformly across the galaxy, so regions keep their character — O/B in the arms, gold giants pooled in the old core. Bigger samples take a proportionally longer remint. Needs remint.',
    scope: 'harvest',
    key: 'GALAXY_SAMPLE_N',
    min: 100_000,
    max: 1_000_000,
    step: 10_000,
    read: () => UNIVERSE.GALAXY_SAMPLE_N,
    write: (v) => writeNum('GALAXY_SAMPLE_N', Math.round(v)),
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
    id: 'zdDust',
    label: 'Sheet thickness',
    group: 'dust',
    hint: 'how tall the optical dust sheet is',
    about: 'Vertical scale of the dust photograph, on the geometric midplane. Thin keeps the classic edge-on slit. Occupancy / SFR stay on their own sheet. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_ZD_DUST',
    min: 0.04,
    max: 0.4,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_ZD_DUST,
    write: (v) => writeNum('GALAXY_ZD_DUST', v),
  },
  {
    id: 'dustGrip',
    label: 'Disk grip',
    group: 'dust',
    hint: '1 = flat slit; loosen and ribbons climb out',
    about: 'How tightly the dust photograph hugs the midplane. At 1 the sheet is the classic thin slit and clouds lie flat. Loosen it and the scale height opens while the turbulence goes isotropic — the same ribbons grow longer and project above and below the disc. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_GRIP',
    min: 0.05,
    max: 1,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_DUST_GRIP,
    write: (v) => writeNum('GALAXY_DUST_GRIP', v),
  },
  {
    id: 'dustJitter',
    label: 'Layer jitter',
    group: 'dust',
    hint: 'how far cloud centres wander off the slice',
    about: 'Corrugation of the dust sheet: a seeded field a few clouds wide lifts and sinks the local centre, in units of the scale height, so each cloud carries its own altitude. 0 pins every centre to one plane — flying through the disc meets a perfect layer boundary. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_JITTER',
    min: 0,
    max: 3,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_JITTER,
    write: (v) => writeNum('GALAXY_DUST_JITTER', v),
  },
  {
    id: 'dustMid',
    label: 'Midplane warp',
    group: 'dust',
    hint: '0 = flat slit; 1 = follow the stellar warp',
    about: 'How much the optical sheet follows the warped / corrugated midplane. 0 is the classic side-on view — clumps scatter about z = 0 and average to a slit. 1 is the old snake. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_MID',
    min: 0,
    max: 1,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_MID,
    write: (v) => writeNum('GALAXY_DUST_MID', v),
  },
  {
    id: 'dustSigma',
    label: 'Clumping',
    group: 'dust',
    hint: 'how strongly turbulence bunches the dust',
    about: 'Log-normal σ on the photograph noise. Higher and the sheet breaks into denser, more separate clouds. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_SIGMA',
    min: 0,
    max: 3,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_SIGMA,
    write: (v) => writeNum('GALAXY_DUST_SIGMA', v),
  },
  {
    id: 'dustFreq',
    label: 'Cloud size',
    group: 'dust',
    hint: 'how big each ribbon is',
    about: 'The size law: cycles per kpc of the largest photograph clumps. Higher shrinks every cloud; lower grows them. How many there are is Cloud cover — the two are independent. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_FREQ',
    min: 0.4,
    max: 8,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_FREQ,
    write: (v) => writeNum('GALAXY_DUST_FREQ', v),
  },
  {
    id: 'dustCover',
    label: 'Cloud cover',
    group: 'dust',
    hint: 'how many clouds there are',
    about: 'The number law: lifts or sinks the whole turbulence distribution with the summits pinned, so more or fewer crests clear the cloud floor. Size (Cloud size) and the darkness of the densest clouds (Abyss density) stay put. 1 is the shipped sky. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_COVER',
    min: 0.4,
    max: 2,
    step: 0.02,
    read: () => UNIVERSE.GALAXY_DUST_COVER,
    write: (v) => writeNum('GALAXY_DUST_COVER', v),
  },
  {
    id: 'dustSwirl',
    label: 'Swirl',
    group: 'dust',
    hint: 'how hard the clouds curl and churn',
    about: 'Domain warp on the photograph — a slow noise field bends the clump noise, so eddies curl at every angle. 0 is still fluff; higher is a more turbulent ocean. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_SWIRL',
    min: 0,
    max: 3,
    step: 0.05,
    read: () => UNIVERSE.GALAXY_DUST_SWIRL,
    write: (v) => writeNum('GALAXY_DUST_SWIRL', v),
  },
  {
    id: 'dustDetail',
    label: 'Wisp',
    group: 'dust',
    hint: 'fine detail riding the big fluff',
    about: 'Octave persistence of the fractal. Low is soft cotton; high keeps sharp lacework on every cloud. Needs rebake.',
    scope: 'dust',
    key: 'GALAXY_DUST_DETAIL',
    min: 0.3,
    max: 0.85,
    step: 0.01,
    read: () => UNIVERSE.GALAXY_DUST_DETAIL,
    write: (v) => writeNum('GALAXY_DUST_DETAIL', v),
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

export function knobDefault(k: { def?: number; read: () => number }): number {
  return k.def ?? k.read();
}

export function atDefault(k: { def?: number; read: () => number; step: number }, value: number): boolean {
  return Math.abs(value - knobDefault(k)) <= k.step * 0.25;
}
