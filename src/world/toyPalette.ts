import { LEVEL_COUNT } from './toygen';

/**
 * The onion gradient: one color per level, bedrock to peak, Caribbean and
 * bright. Authored as anchor stops and interpolated to LEVEL_COUNT entries
 * so neighboring levels shift gradually.
 */

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** [level, color] anchors; levels between anchors interpolate. */
const ANCHORS: Array<[number, string]> = [
  [0, '#33294a'],  // bedrock: deep violet-plum
  [3, '#4a4062'],  // plum grey
  [6, '#6b6377'],  // cool stone
  [8, '#93755d'],  // warm stone into dirt
  [10, '#c9a06b'], // terracotta sand
  [12, '#ecd9a0'], // wet sand (default waterline sits here)
  [13, '#f6ecb8'], // dry beach, brightest sand
  [14, '#bfe084'], // young grass
  [16, '#7ed36e'], // bright caribbean green
  [18, '#4cbd63'], // lush green
  [20, '#33a45a'], // palm green
  [22, '#2c8a52'], // deep palm
  [23, '#6f975f'], // highland olive
  [25, '#9b9179'], // dry upland
  [27, '#b5b0a8'], // grey rock
  [29, '#f0efeb'], // pale peak
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

/** LEVEL_COUNT sRGB colors, [0,1] channels, bedrock first. */
export const LEVEL_GRADIENT: RGB[] = buildGradient();

export const SNOW_COLOR: RGB = hexToRgb('#f8fbff');

/** Water sphere tints: looking straight down vs. toward the limb. */
export const WATER_SURFACE: RGB = hexToRgb('#52dcd4');
export const WATER_DEEP: RGB = hexToRgb('#1e7fb8');

/** Scene clear color (deep blue-slate space, never black — but dark enough
 * now for the starfield to read). */
export const SPACE_COLOR = '#0c1424';
