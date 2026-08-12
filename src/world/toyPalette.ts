import { LEVEL_COUNT, MAX_LEVEL } from './toygen';
import type { BodyPhysics } from './physics';

/**
 * The onion gradient: one color per level, bedrock to peak. The base ramp is
 * the home paradise (Caribbean and bright); paletteFor() then derives every
 * other world's ramp CONTINUOUSLY from its physics — crust chemistry tints
 * the rock, life decides whether the green band exists at all, heat bleaches
 * and warms. No world-type lookup anywhere: the paradise look is simply what
 * the function returns in one region of parameter space.
 */

export type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** [level, color] anchors; levels between anchors interpolate.
 * Level 0 is the unalterable bedrock floor; 1-30 are the usable layers. */
const ANCHORS: Array<[number, string]> = [
  [0, '#241c3b'],  // bedrock: near-black violet (the unalterable floor)
  [1, '#33294a'],  // deep violet-plum
  [4, '#4a4062'],  // plum grey
  [7, '#6b6377'],  // cool stone
  [9, '#93755d'],  // warm stone into dirt
  [11, '#c9a06b'], // terracotta sand
  [13, '#ecd9a0'], // wet sand (default waterline sits here)
  [14, '#f6ecb8'], // dry beach, brightest sand
  [15, '#bfe084'], // young grass
  [17, '#7ed36e'], // bright caribbean green
  [19, '#4cbd63'], // lush green
  [21, '#33a45a'], // palm green
  [23, '#2c8a52'], // deep palm
  [24, '#6f975f'], // highland olive
  [26, '#9b9179'], // dry upland
  [28, '#b5b0a8'], // grey rock
  [30, '#f0efeb'], // pale peak
];

function buildGradient(): RGB[] {
  const out: RGB[] = [];
  for (let l = 0; l < LEVEL_COUNT; l++) {
    let i = 0;
    while (i < ANCHORS.length - 1 && ANCHORS[i + 1][0] < l) i++;
    const [l0, c0] = ANCHORS[Math.min(i, ANCHORS.length - 1)];
    const [l1, c1] = ANCHORS[Math.min(i + 1, ANCHORS.length - 1)];
    const t = l1 > l0 ? Math.min(1, Math.max(0, (l - l0) / (l1 - l0))) : 0;
    out.push(mix(hexToRgb(c0), hexToRgb(c1), t));
  }
  return out;
}

/** LEVEL_COUNT sRGB colors, [0,1] channels, bedrock first (the home ramp). */
export const LEVEL_GRADIENT: RGB[] = buildGradient();

/** Crust tint from the element vector: what this world's rock looks like. */
function crustTint(p: BodyPhysics): RGB {
  let c: RGB = [0.56, 0.53, 0.5]; // neutral silicate grey
  const fe = clamp01((p.crust.Fe - 0.08) / 0.22);
  c = mix(c, [0.72, 0.42, 0.28], fe * 0.85); // iron oxides redden
  const s = clamp01((p.crust.S - 0.03) / 0.06);
  c = mix(c, [0.78, 0.68, 0.34], s * 0.5); // sulfur yellows
  const dark = clamp01((p.crust.C - 0.03) / 0.08);
  c = mix(c, [0.34, 0.32, 0.3], dark * 0.6); // carbon darkens
  const iceIsh = clamp01((p.crust.H - 0.01) / 0.05);
  c = mix(c, [0.72, 0.78, 0.86], iceIsh * 0.8); // ices whiten & cool
  return c;
}

/**
 * The 31-stop strata ramp for a body, derived continuously from its physics.
 * Undefined physics (or the perfect paradise) returns the home ramp.
 */
export function paletteFor(p?: BodyPhysics): RGB[] {
  if (!p || p.kind !== 'rocky') return LEVEL_GRADIENT;

  // Vegetation exists only where life does, and fades with climate stress.
  const veg = p.life ? clamp01(1 - Math.abs(p.temp01 - 0.45) * 2.1) : 0;
  const heat = clamp01((p.temp01 - 0.7) / 0.3);
  const chill = clamp01((0.28 - p.temp01) / 0.28);
  const crust = crustTint(p);

  return LEVEL_GRADIENT.map((base, l) => {
    const h = l / MAX_LEVEL;
    // The barren version of this level: a luminance ramp wearing the crust's
    // own tint (dark depths to pale heights), bedrock kept dark and violet.
    const lum = 0.2 + 0.85 * Math.pow(h, 0.9);
    let barren: RGB = [crust[0] * lum, crust[1] * lum, crust[2] * lum];
    if (l === 0) barren = base; // bedrock is bedrock everywhere

    // How much of the living ramp survives: underwater and sand bands keep
    // most of their character (wet rock and sediment look alike everywhere);
    // the green bands exist only with vegetation.
    const sandTop = 14 / MAX_LEVEL;
    const keep = h < sandTop ? 0.45 + 0.55 * veg : veg;
    let c = mix(barren, base, keep);

    // Heat bleaches and warms; deep cold blues the rock.
    if (heat > 0) c = mix(c, [c[0] * 1.08 + 0.06, c[1] * 0.98 + 0.02, c[2] * 0.82], heat * 0.55);
    if (chill > 0) c = mix(c, [c[0] * 0.9, c[1] * 0.96 + 0.02, c[2] * 1.04 + 0.05], chill * 0.45);

    return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])] as RGB;
  });
}

export const SNOW_COLOR: RGB = hexToRgb('#f8fbff');

/** Water sphere tints for the home paradise (bodies override from physics). */
export const WATER_SURFACE: RGB = hexToRgb('#52dcd4');
export const WATER_DEEP: RGB = hexToRgb('#1e7fb8');

/** Scene clear color (deep blue-slate space, never black — but dark enough
 * now for the starfield to read). */
export const SPACE_COLOR = '#0c1424';
