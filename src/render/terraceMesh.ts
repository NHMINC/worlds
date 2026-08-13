import * as THREE from 'three';
import type { GeoGrid } from '../world/geodesic';
import { LEVEL_COUNT } from '../world/toygen';
import { LEVEL_GRADIENT, SNOW_COLOR, WATER_DEEP, WATER_SURFACE, type RGB } from '../world/toyPalette';
import { UNIVERSE } from '../world/physics';
import { AIR_SCATTER_GLSL, AIR_UNIFORMS_GLSL } from './scattering';

/**
 * The blending skin over the voxel columns (Godus-style):
 *
 * The DATA is one integer level per hex column on the coarse geodesic grid.
 * The RENDERED surface is a finer icosphere lattice whose vertices blend the
 * surrounding columns' levels into a continuous field, then a terrace-shaping
 * function flattens the field toward each integer level — plateaus with
 * rounded ramps between them. The rounding radius is the dial between hard
 * Minecraft steps and soft Godus hills.
 *
 * A uniform Gaussian either melts the planet (wide sigma) or prints the hex
 * lattice (narrow sigma). skinLevel() instead jittered-Voronoi-blends with a
 * noise-driven width: craggy patches keep terrace steps, soft patches roll,
 * and the honeycomb never quite appears because cell centers don't sit on
 * the regular grid. On top of that, the sample point is domain-warped
 * (warpPoint) so data boundaries — shorelines, contours — meander across
 * many columns: winding beaches instead of cell-sized edges.
 *
 * Ring colors are resolved per-pixel in the fragment shader from the
 * continuous (unshaped) level, so the onion contours stay crisp flowing
 * curves at any zoom regardless of triangle density.
 */

export interface TerraceOptions {
  /** Water-surface level (float). Anchors GL radius 1 at the waterline. */
  waterLevel: number;
  /** GL radius per level step. */
  step: number;
  /** Ramp half-width in level units (0.05 hard steps .. 0.5 smooth hills). */
  rounding: number;
}

/** Plateau-with-rounded-ramps shaping: continuous, flat near integers. */
export function terrace(x: number, rounding: number): number {
  const base = Math.round(x);
  const f = x - base;
  const flat = 0.5 - rounding;
  const a = Math.abs(f);
  if (a <= flat) return base;
  const t = (a - flat) / rounding;
  const s = t * t * (3 - 2 * t);
  return base + Math.sign(f) * 0.5 * s;
}

/** Tight blend (terrace steps survive) as a fraction of column spacing. */
const SKIN_SIGMA_MIN = 0.2;
/** Soft blend — the old full-smooth width. */
const SKIN_SIGMA_MAX = 0.55;
/** Tangent jitter of each column center, as a fraction of spacing. */
const SKIN_JITTER = 0.3;
/** Noise feature size in column-spacings: patches of crag vs roll. */
const SKIN_PATCH = 14;
/** Cross-column relief: base wavelength in column-spacings. */
const RELIEF_LEN = 6;
/** Cross-column relief: total swing in level units. Kept to a whisper —
 * real structure now comes from the generator's landform passes; this only
 * roughs up contour lines so they never read as machined. */
const RELIEF_AMP = 0.4;

function hash3(ix: number, iy: number, iz: number): number {
  let n = Math.imul(ix, 127) + Math.imul(iy, 311) + Math.imul(iz, 74);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const n000 = hash3(ix, iy, iz);
  const n100 = hash3(ix + 1, iy, iz);
  const n010 = hash3(ix, iy + 1, iz);
  const n110 = hash3(ix + 1, iy + 1, iz);
  const n001 = hash3(ix, iy, iz + 1);
  const n101 = hash3(ix + 1, iy, iz + 1);
  const n011 = hash3(ix, iy + 1, iz + 1);
  const n111 = hash3(ix + 1, iy + 1, iz + 1);
  const n00 = n000 + (n100 - n000) * ux;
  const n10 = n010 + (n110 - n010) * ux;
  const n01 = n001 + (n101 - n001) * ux;
  const n11 = n011 + (n111 - n011) * ux;
  const n0 = n00 + (n10 - n00) * uy;
  const n1 = n01 + (n11 - n01) * uy;
  return n0 + (n1 - n0) * uz;
}

function cellHash(c: number, salt: number): number {
  let h = Math.imul(c + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Typical contour wander in column-spacings: how far shapes stray. */
const WARP_AMP = 1.0;
/** Warp feature size in column-spacings: the length of capes and coves. */
const WARP_LEN = 9;

const warped: [number, number, number] = [0, 0, 0];

/**
 * Domain warp: the point at which the block data is SAMPLED, displaced by a
 * smooth vector noise field. Every boundary in the data — shorelines,
 * terrace contours, plateau edges — is dragged along the field and becomes
 * a long meandering curve spanning many columns, while the data stays one
 * integer per column. Exported so picking can apply the same warp and a
 * click lands on the column whose ground you see.
 *
 * Returns a shared scratch tuple; consume it before the next call.
 */
export function warpPoint(
  grid: GeoGrid,
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] {
  const sp = grid.cellSpacing();
  const f = 1 / (WARP_LEN * sp);
  const fx = x * f;
  const fy = y * f;
  const fz = z * f;
  // Fractal, three octaves per axis: a continental swing (~3x WARP_LEN)
  // bends whole coastlines, the mid octave draws capes and coves, the short
  // one keeps the wander from reading as a single smooth wave. Multiple
  // scales matter: a single-frequency warp still shows its own wavelength
  // as a repeating pattern from a distance.
  let wx = 2.0 * (vnoise(fx * 0.31 + 27.4, fy * 0.31 + 19.8, fz * 0.31 + 6.2) - 0.5);
  let wy = 2.0 * (vnoise(fx * 0.31 + 3.6, fy * 0.31 + 33.1, fz * 0.31 + 25.7) - 0.5);
  let wz = 2.0 * (vnoise(fx * 0.31 + 12.9, fy * 0.31 + 8.5, fz * 0.31 + 41.3) - 0.5);
  wx += vnoise(fx + 13.2, fy + 7.7, fz + 3.9) - 0.5;
  wy += vnoise(fx + 1.3, fy + 11.8, fz + 9.4) - 0.5;
  wz += vnoise(fx + 5.1, fy + 2.6, fz + 14.7) - 0.5;
  wx += 0.5 * (vnoise(fx * 2.3 + 23.7, fy * 2.3 + 17.1, fz * 2.3 + 8.8) - 0.5);
  wy += 0.5 * (vnoise(fx * 2.3 + 9.9, fy * 2.3 + 27.4, fz * 2.3 + 19.2) - 0.5);
  wz += 0.5 * (vnoise(fx * 2.3 + 15.5, fy * 2.3 + 4.4, fz * 2.3 + 31.6) - 0.5);
  const amp = 2 * WARP_AMP * sp;
  const px = x + wx * amp;
  const py = y + wy * amp;
  const pz = z + wz * amp;
  const l = Math.hypot(px, py, pz) || 1;
  warped[0] = px / l;
  warped[1] = py / l;
  warped[2] = pz / l;
  return warped;
}

/** Dot of (x,y,z) with a column's jittered unit center. */
function jitteredDot(
  centers: Float32Array,
  c: number,
  x: number,
  y: number,
  z: number,
  amp: number,
): number {
  const cx = centers[c * 3];
  const cy = centers[c * 3 + 1];
  const cz = centers[c * 3 + 2];
  let e1x = -cy;
  let e1y = cx;
  let e1z = 0;
  const e1l = Math.hypot(e1x, e1y, e1z);
  if (e1l < 1e-8) {
    e1x = 1;
    e1y = 0;
    e1z = 0;
  } else {
    e1x /= e1l;
    e1y /= e1l;
    e1z /= e1l;
  }
  const e2x = cy * e1z - cz * e1y;
  const e2y = cz * e1x - cx * e1z;
  const e2z = cx * e1y - cy * e1x;
  const j1 = (cellHash(c, 1) * 2 - 1) * amp;
  const j2 = (cellHash(c, 2) * 2 - 1) * amp;
  let jx = cx + e1x * j1 + e2x * j2;
  let jy = cy + e1y * j1 + e2y * j2;
  let jz = cz + e1z * j1 + e2z * j2;
  const jl = Math.hypot(jx, jy, jz) || 1;
  return (jx * x + jy * y + jz * z) / jl;
}

/**
 * Continuous (unshaped) level at a unit-sphere point. The same law the
 * terrace mesh and the surface-hover camera both walk, so the eye sits on
 * the skin. The sample point is domain-warped first, so data boundaries
 * meander across many columns; jittered column centers break the hex
 * lattice; a slow noise field picks a blend width per patch so some ground
 * stays stepped and some rolls; and a fractal relief field is laid over the
 * blended level so structure exists at every scale, not just cell scale.
 */
/** Cell that anchored the last skinLevel blend — lets TerraceJob sample
 * per-cell side data (basin fetch) without a second nearestCell lookup. */
let skinAnchorCell = 0;

export function skinLevel(grid: GeoGrid, levels: Uint8Array, x: number, y: number, z: number): number {
  const [px, py, pz] = warpPoint(grid, x, y, z);
  const sp = grid.cellSpacing();
  const f = 1 / (SKIN_PATCH * sp);
  const n = vnoise(px * f + 2.1, py * f + 5.8, pz * f + 1.4);
  // Contrast the noise into patches: crag, roll, and a short blend between.
  const t = Math.min(1, Math.max(0, (n - 0.28) / 0.44));
  const u = t * t * (3 - 2 * t);
  const sigma = sp * (SKIN_SIGMA_MIN + (SKIN_SIGMA_MAX - SKIN_SIGMA_MIN) * u);
  const inv2s2 = 1 / (2 * sigma * sigma);
  const jAmp = SKIN_JITTER * sp;
  const c0 = grid.nearestCell(px, py, pz);
  skinAnchorCell = c0;
  let sum = 0;
  let wsum = 0;
  const deg = grid.degree(c0);
  for (let k = -1; k < deg; k++) {
    const c = k < 0 ? c0 : grid.neighbors[c0 * 6 + k];
    const d2 = Math.max(0, 2 * (1 - jitteredDot(grid.centers, c, px, py, pz, jAmp)));
    const w = Math.exp(-d2 * inv2s2);
    sum += w * levels[c];
    wsum += w;
  }
  // Cross-column relief: fractional levels of fbm over the blended field,
  // three octaves from broad swells (~3x RELIEF_LEN) down to ~2 columns.
  // One hex column no longer maps to one bump — relief spans cells and
  // scales, so no single feature size survives at distance. The terrace
  // shaping re-quantizes it into moved contours and occasional extra steps.
  const rf = 1 / (RELIEF_LEN * sp);
  const r1 = vnoise(px * rf * 0.33 + 31.7, py * rf * 0.33 + 12.3, pz * rf * 0.33 + 24.9) - 0.5;
  const r2 = vnoise(px * rf + 8.4, py * rf + 29.1, pz * rf + 16.6) - 0.5;
  const r3 = vnoise(px * rf * 2.7 + 21.2, py * rf * 2.7 + 6.8, pz * rf * 2.7 + 34.3) - 0.5;
  const relief = RELIEF_AMP * (0.9 * r1 + 0.7 * r2 + 0.4 * r3);
  const lvl = sum / wsum + relief;
  return Math.min(LEVEL_COUNT - 1, Math.max(0, lvl));
}

/**
 * Resumable terrace-skin build: the vertex pass (the expensive part — one
 * nearestCell lookup plus a jittered blend per lattice vertex) is chunked so
 * the engine can spread a build over frames while the ship flies. Call
 * step(budgetMs) until it returns true, then finish() for the geometry.
 */
export class TerraceJob {
  private readonly dataGrid: GeoGrid;
  private readonly renderGrid: GeoGrid;
  private readonly levels: Uint8Array;
  private readonly opts: TerraceOptions;
  /** Per-data-cell basin fetch (0..255, toygen.basinFetch); omit for full swell. */
  private readonly fetch: Uint8Array | null;
  private readonly positions: Float32Array;
  private readonly aLevel: Float32Array;
  private readonly aFetch: Float32Array;
  private i = 0;

  constructor(
    dataGrid: GeoGrid,
    renderGrid: GeoGrid,
    levels: Uint8Array,
    opts: TerraceOptions,
    fetch?: Uint8Array,
  ) {
    this.dataGrid = dataGrid;
    this.renderGrid = renderGrid;
    this.levels = levels;
    this.opts = opts;
    this.fetch = fetch ?? null;
    this.positions = new Float32Array(renderGrid.count * 3);
    this.aLevel = new Float32Array(renderGrid.count);
    this.aFetch = new Float32Array(renderGrid.count);
  }

  /** Run vertex work until the budget is spent; true when the pass is done. */
  step(budgetMs: number): boolean {
    const { dataGrid, renderGrid, levels, opts } = this;
    const n = renderGrid.count;
    const deadline = performance.now() + budgetMs;
    while (this.i < n) {
      const end = Math.min(n, this.i + 512);
      for (let i = this.i; i < end; i++) {
        const x = renderGrid.centers[i * 3];
        const y = renderGrid.centers[i * 3 + 1];
        const z = renderGrid.centers[i * 3 + 2];
        const lvl = skinLevel(dataGrid, levels, x, y, z);
        this.aLevel[i] = lvl;
        // Basins are separated by land, so nearest-cell sampling is enough —
        // and the anchor cell from the blend above is exactly that.
        this.aFetch[i] = this.fetch ? this.fetch[skinAnchorCell] / 255 : 1;
        const r = 1 + (terrace(lvl, opts.rounding) - opts.waterLevel) * opts.step;
        this.positions[i * 3] = x * r;
        this.positions[i * 3 + 1] = y * r;
        this.positions[i * 3 + 2] = z * r;
      }
      this.i = end;
      if (performance.now() >= deadline) break;
    }
    return this.i >= n;
  }

  /** Assemble the geometry (triangulation + normals; fast, done in one go). */
  finish(): THREE.BufferGeometry {
    const renderGrid = this.renderGrid;
    const n = renderGrid.count;
    // Triangulation: every triple of mutually adjacent lattice cells is one
    // triangle; the lowest id of the three emits it (each exactly once).
    // Neighbors are sorted CCW from outside, so (id, n_k, n_k+1) winds CCW.
    const tris: number[] = [];
    for (let id = 0; id < n; id++) {
      const deg = renderGrid.degree(id);
      for (let k = 0; k < deg; k++) {
        const n1 = renderGrid.neighbors[id * 6 + k];
        const n2 = renderGrid.neighbors[id * 6 + ((k + 1) % deg)];
        if (id < n1 && id < n2) tris.push(id, n1, n2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLevel', new THREE.BufferAttribute(this.aLevel, 1));
    geo.setAttribute('aFetch', new THREE.BufferAttribute(this.aFetch, 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1));
    geo.computeVertexNormals();
    return geo;
  }
}

/** One-shot build (synchronous), for when a hitch is acceptable. */
export function buildTerraceGeometry(
  dataGrid: GeoGrid,
  renderGrid: GeoGrid,
  levels: Uint8Array,
  opts: TerraceOptions,
  fetch?: Uint8Array,
): THREE.BufferGeometry {
  const job = new TerraceJob(dataGrid, renderGrid, levels, opts, fetch);
  job.step(Infinity);
  return job.finish();
}

// ---------------------------------------------------------------- materials

const TERRAIN_VERT = /* glsl */ `
attribute float aLevel;
attribute float aFetch;
varying float vLevel;
varying float vFetch;
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vLevel = aLevel;
  vFetch = aFetch;
  vNormal = normal;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TERRAIN_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uGrad;   // LEVEL_COUNT x 1 ring gradient
uniform float uLevels;
uniform vec3 uSnow;
uniform float uWaterLevel;
uniform float uTime;
uniform vec3 uLightDir;
uniform float uWarpFreq;
// ONE temperature law (mirror of toygen.insolationAt): local temperature is
// time-averaged insolation. Spinners get a latitude gradient; worlds locked
// to their star get a substellar gradient — eyeball worlds emerge here with
// no special case. The snow line and scorch tint follow the local value.
uniform float uTempBase;   // body temp dial, 0..1
uniform float uTempSpan;   // insolation span (spin state decides)
uniform float uTempMode;   // 0 spinner, 1 locked-to-star
uniform float uSurfStrength; // shoreline foam strength (chemistry decides)
uniform float uWaveEnergy;   // 0..1 swell energy (physics.seaState)
uniform float uWaveTempo;    // wave-clock rate ~ sqrt(g)
uniform float uWaveGain;     // cosmetic volume knob (UNIVERSE.WAVE_GAIN)
uniform float uSnowAmount; // 0..1 deposition capacity (reservoir x cycle)
uniform float uSnowTempBase; // temp dial re-centered on the volatile's freeze point
uniform float uSeasonGain; // seasonal anomaly gain (UNIVERSE.SEASON_GAIN)
uniform float uMirrorClip; // >0 during the water-reflection pass: sea sphere radius
uniform float uWriteCol;   // 1 during the water-column capture: pack distance in alpha
// The one scattering law (scattering.ts): this shader owns the air along
// rays that strike terrain. uCamPos is in the body's local unit-radius
// frame (same as the water shader).
uniform vec3 uCamPos;
${AIR_UNIFORMS_GLSL}
varying float vLevel;
varying float vFetch;
varying vec3 vNormal;
varying vec3 vPos;
${AIR_SCATTER_GLSL}

vec3 gradAt(float band) {
  float u = (clamp(band, 0.0, uLevels - 1.0) + 0.5) / uLevels;
  return texture2D(uGrad, vec2(u, 0.5)).rgb;
}

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

void main() {
  // Mirror pass only (engine reflection camera): a reflection contains
  // nothing from beneath its mirror, so clip the terrain below the sea
  // sphere — otherwise the underwater beach slope occludes the coast and
  // the water reflects seabed instead of land.
  if (uMirrorClip > 0.0 && length(vPos) < uMirrorClip) discard;

  // Ring bands from the continuous level: band L owns [L-0.5, L+0.5), so
  // ring contours sit exactly on the terrace ramps. A whisper of sub-cell
  // noise wobbles the contour lines so they read as hand-drawn curves
  // rather than the render lattice's straight triangle edges.
  float wob = (vnoise(vPos * uWarpFreq) - 0.5)
            + 0.5 * (vnoise(vPos * uWarpFreq * 2.3 + vec3(7.1, 3.9, 5.2)) - 0.5);
  float li = vLevel + 0.09 * wob + 0.5;
  float band = floor(li);
  float f = li - band;
  float w = max(fwidth(li) * 0.9, 1e-4);
  vec3 c = gradAt(band);
  c = mix(c, gradAt(band + 1.0), smoothstep(1.0 - w, 1.0, f));

  // Local temperature from the insolation law, plus the seasonal anomaly:
  // sin(latitude) x sin(sun declination). uLightDir is the live sun
  // direction in the body frame, so its z IS the declination — seasons
  // scale with axial tilt and vanish for untilted or locked worlds.
  vec3 dir = normalize(vPos);
  float insol = uTempMode > 0.5
    ? dir.x
    : (sqrt(max(0.0, 1.0 - dir.z * dir.z)) - 0.785) * 1.6;
  insol += uSeasonGain * dir.z * uLightDir.z;
  float tLoc = clamp(uTempBase + uTempSpan * insol, 0.0, 1.0);

  // Scorched ground: where the local temperature runs very hot, land above
  // the waterline bakes toward sun-bleached sand (the dayside of an eyeball
  // world earns its desert).
  float arid = smoothstep(0.74, 0.98, tLoc) * step(uWaterLevel, vLevel);
  float lum = dot(c, vec3(0.333));
  c = mix(c, vec3(lum) * vec3(1.14, 0.99, 0.7), 0.5 * arid);

  // Snow is fallen weather, not paint: uSnowAmount (reservoir x cycle from
  // the physics) gates whether anything can settle at all, and a weak cycle
  // lifts the line so frost clings only to the coldest spots. WHERE it
  // settles is the local temperature law (same as toygen.snowLineFor),
  // measured from the WORKING volatile's freeze point (uSnowTempBase) so
  // methane frost caps peaks over liquid-methane lowlands just as water
  // snow does over seas. ANCHORED at the freeze point (0.285 on this dial,
  // the same isotherm that hardens the sea): where the ocean freezes over,
  // the snow line meets the waterline — coastal land whitens beside its sea
  // ice, never bare rock against a frozen shore. The line wobbles with the
  // noise for organic cap edges; the hot-end term clears any peak.
  float tSnow = clamp(uSnowTempBase + uTempSpan * insol, 0.0, 1.0);
  float ts = clamp((tSnow - 0.285) / 0.715, 0.0, 1.0);
  float snowLv = uWaterLevel + 0.5 + 25.1 * ts - 7.4 * ts * ts
               + 40.0 * max(0.0, ts - 0.75) + 8.0 * (1.0 - uSnowAmount);
  float ws = max(fwidth(vLevel) * 1.2, 1e-4);
  float canSnow = smoothstep(0.1, 0.2, uSnowAmount);
  c = mix(c, uSnow, smoothstep(-ws, ws, vLevel + 0.35 * wob - snowLv) * canSnow);

  // Surf: stylized shallow-water (WKB) waves. The swell is a phase field
  // phi = K·sqrt(depth) + omega·t — shallow-water speed is sqrt(g·d), so
  // crests march SHOREWARD as t grows and their spacing shrinks like
  // sqrt(depth): waves feel the bottom, slow, and bunch against the coast.
  // Green's law grows them as depth shrinks (A ~ d^-1/4) and they break
  // where A exceeds ~0.6·depth — an emergent breaker line roughly parallel
  // to the shore, further out the bigger the swell. Inside it: rolling
  // white water. At the line: swash that rushes up the beach and drains
  // back slow. Steep coasts reflect a weak outgoing train (a near-standing
  // shimmer under cliffs); gentle ones absorb it and run up long. All
  // fwidth calls sit OUTSIDE branches (derivatives in branches are garbage
  // at the waterline). Frozen shores stay still; windless worlds glass over.
  float depth = uWaterLevel - vLevel;
  float pxl = max(fwidth(depth), 1e-5);
  float frozen = 1.0 - smoothstep(0.245, 0.315, tSnow);
  float surfGate = uSurfStrength * (1.0 - frozen);
  float off = vnoise(vPos * uWarpFreq * 0.35 + vec3(1.7, 8.3, 5.9));
  float pxPos = fwidth(vPos.x) + fwidth(vPos.y) + fwidth(vPos.z);
  float att = 1.0 - smoothstep(0.3, 1.2, pxPos * uWarpFreq);
  float lap = mix(0.5, vnoise(vPos * uWarpFreq * 1.6 + vec3(uTime * 0.25, uTime * -0.18, 3.1)), att);
  // Swell energy: the body's sea state (wind + tide) scaled by basin
  // fetch — floored, not zeroed: a pond still laps baby ripples at its
  // rim, while the ocean shore takes the full sea.
  float energy = uWaveEnergy * mix(0.3, 1.0, vFetch);

  // Terrain slope in levels-per-column: the ratio of derivatives cancels
  // the screen, so it is a stable terrain property. TRUE beaches (coastal
  // plains) run well under half a level per column, so the wash gate
  // starts closing there — by one level per column the shore is a bank,
  // not a beach, and steeper still is cliff.
  float slopeCell = pxl / max(pxPos, 1e-6) * (2.2 / uWarpFreq);
  float cliff = smoothstep(0.4, 1.8, slopeCell);
  // Two shores, split by that angle: low slopes are BEACHES and take the
  // wash; steep ones are WALLS and take the splash; the band between just
  // sees the wash lose its reach.
  float beach = 1.0 - smoothstep(0.35, 1.1, slopeCell);
  float wall = smoothstep(1.1, 2.2, slopeCell);

  // Horizontal reach: the wash is DISTANCE-limited, not just height-
  // limited. height/slope estimates how many columns of ground lie between
  // here and the waterline, and everything wet on land dies within a
  // couple of columns — a flat plain where one level spans a kilometer no
  // longer drowns whole fields. (The slope floor turns this into an extra-
  // tight height gate on true flats, where local slope says nothing.)
  float ashore = max(-depth, 0.0);
  float reachW = mix(0.7, 2.2, beach);
  float reachGate = 1.0 - smoothstep(0.45 * reachW, reachW, ashore / max(slopeCell, 0.22));

  // The waterline band: never thinner than ~6 px, but CAPPED at two levels
  // so zooming out cannot smear it across whole shelves — and its LAND side
  // is squeezed harder still (the sea wets its edge, not the countryside),
  // hardest of all against cliff faces, which only wear a thin wet stripe.
  float swashW = min(max(1.2, 6.0 * pxl), 2.0);
  float landSq = mix(1.8, 4.5, cliff);
  float line = 1.0 - smoothstep(0.0, swashW, depth < 0.0 ? -landSq * depth : depth);
  line *= depth < 0.0 ? reachGate : 1.0;

  // No worldwide metronome — but the desync must be BOUNDED. A spatially
  // varying FREQUENCY multiplied by absolute time is a moiré machine: the
  // phase gradient between two coasts grows without limit, and after a few
  // minutes the field wrinkles into dense contour-hugging rings across the
  // whole ocean (this exact bug shipped twice). So one omega per body;
  // coasts fall out of lockstep through a static offset field (off, slant)
  // plus this slowly MORPHING drift — half a cycle at most, forever.
  float drift = 0.5 * vnoise(vPos * uWarpFreq * 0.18 + vec3(9.1, 4.4, 6.7) + uTime * 0.009);
  float slant = 0.25 * (vnoise(vPos * uWarpFreq * 0.9 + vec3(2.9, 7.2, 11.4)) - 0.5);
  float omega = uWaveTempo * 0.055;

  float dPos = max(depth, 0.0);
  float A = energy * 0.8 / pow(max(dPos, 0.25), 0.25);   // Green's law
  float brk = smoothstep(0.0, 0.5, A - 0.6 * dPos);      // breaker criterion

  float wetSide = step(0.0, depth);
  float ph = fract(2.2 * sqrt(dPos) + off + slant + drift + uTime * omega);
  float crest = smoothstep(0.62, 0.82, ph) * (1.0 - smoothstep(0.90, 1.0, ph));
  // Reflection: same dispersion, time reversed, weak — strongest off cliffs.
  float phO = fract(2.2 * sqrt(dPos) + 0.37 + 0.7 * off + drift - uTime * omega);
  float crestO = smoothstep(0.66, 0.85, phO) * (1.0 - smoothstep(0.93, 1.0, phO));
  float seaFoam = wetSide * att * min(A, 1.0)
                * (crest * (0.18 + 0.82 * brk) + crestO * mix(0.05, 0.4, cliff) * brk);

  // Swash: at depth 0 the phase is pure omega·t, so the runup pulse fires
  // exactly when a crest lands — timing is continuous with the sea for
  // free. The phase lags with height so the tongue visibly RUNS up the
  // beach; fast rush, slow drain, fizzing (churn grain) as it goes. The
  // runup is measured in LEVELS, never screen space (a screen-sized runup
  // washes whole plains at far zoom), and is cut hard barely one level
  // above the waterline: the swash zone is the FIRST beach terrace, and
  // the sea does not climb hills. Weak gravity stretches the reach a
  // little — the same swell stands taller on a light moon.
  float runup = (0.15 + 0.65 * beach) * (0.3 + 0.7 * energy)
              * mix(1.5, 0.85, smoothstep(0.4, 1.1, uWaveTempo));
  float phS = fract(off + slant + drift + uTime * omega - 0.88 - 0.4 * ashore / max(runup, 0.05));
  float rush = smoothstep(0.0, 0.16, phS) * (1.0 - smoothstep(0.22, 0.85, phS));
  float churn = vnoise(vPos * uWarpFreq * 5.2 + vec3(uTime * 0.65, -uTime * 0.5, 4.4))
              * vnoise(vPos * uWarpFreq * 8.1 + vec3(-uTime * 0.45, uTime * 0.6, 9.3));
  float grain = smoothstep(0.24, 0.48, churn);
  float wash = beach * rush * exp(-ashore / max(runup, 0.05))
             * (1.0 - smoothstep(0.5, 1.1, ashore)) * reachGate
             * (0.5 + 0.5 * grain);

  // Splash: what a wall gets instead of a wash. A short, bright, grainy
  // burst pinned to the waterline, fired as each crest strikes — sharp
  // attack, quick fade, no travel. Ordinary seas fleck; heavy moon-tide
  // seas (past the 0.9 wind ceiling) throw real spray.
  float phX = fract(off + slant + drift + uTime * omega - 0.9);
  float burst = smoothstep(0.0, 0.06, phX) * (1.0 - smoothstep(0.1, 0.4, phX));
  float splash = wall * burst * (1.0 - smoothstep(0.0, 0.45, ashore))
               * (0.35 + 0.65 * smoothstep(0.85, 1.0, energy))
               * (0.4 + 0.6 * grain);

  // Compose: the wet line itself (even a near-still sea darkens its edge),
  // the shoaling/breaking trains, and the land foam — all through the
  // cosmic volume knob.
  float landFoam = (1.0 - wetSide) * (wash + splash) * att * energy;
  float foam = line * (0.16 + 0.14 * lap) * (0.2 + 0.8 * energy);
  foam += 0.9 * seaFoam;
  foam += 0.7 * landFoam;
  foam = clamp(foam * surfGate * uWaveGain, 0.0, 0.92);

  // Terrace risers self-shade slightly so rings read as tiny cliffs.
  vec3 n = normalize(vNormal);
  vec3 up = normalize(vPos);
  float slope = 1.0 - clamp(dot(n, up), 0.0, 1.0);
  c *= 1.0 - 0.22 * smoothstep(0.12, 0.45, slope);

  // Cel light: three calm bands on the day side, then across the terminator
  // the land falls to a cool moonlit blue instead of black — the sun is a
  // real body in the sky now, and the day sweeps around the world.
  float d = dot(n, uLightDir);
  float q = 0.68 + 0.14 * smoothstep(0.02, 0.14, d) + 0.18 * smoothstep(0.45, 0.58, d);
  float day = smoothstep(-0.14, 0.10, d);
  vec3 night = c * vec3(0.24, 0.30, 0.46);
  vec3 col = mix(night, c * q, day);

  // The air along this ray: per-channel extinction of the ground plus the
  // sunlight the path scatters toward the camera. Blue-hazed distance by
  // day, warm twilight, and clean night blacks all come from the integral.
  vec3 tau = vec3(0.0);
  if (uAirSigma > 0.0) {
    vec3 air = airScatter(uCamPos, vPos, uLightDir, tau);
    col = col * exp(-tau) + air;
  }

  // Torch: a headlamp riding the camera, faded in by the engine when
  // ambient daylight dies (night, or air too thick for the sun to reach
  // the ground). Lights the TRUE albedo — its whole point is showing what
  // the dark is hiding — and its light crosses the air twice (out and
  // back), so thick murk swallows the beam a short way ahead, exactly
  // like fog.
  if (uTorch > 0.0) {
    vec3 tv = vPos - uCamPos;
    float dT = length(tv);
    vec3 td = tv / max(dT, 1e-6);
    float cone = smoothstep(0.78, 0.965, dot(td, uTorchDir));
    float fall = 1.0 / (1.0 + 300.0 * dT * dT);
    float catchT = max(dot(n, -td), 0.0);
    // Murk cannot kill the beam outright: photons scatter, they don't
    // vanish, and in near-conservative air they random-walk forward with
    // the same diffusion survival the sky uses. Thin air keeps the crisp
    // e^-2tau beam; hothouse soup turns it into a close lantern glow.
    vec3 Tb = max(exp(-2.0 * tau),
      exp(-2.0 * tau * sqrt(3.0 * max(vec3(0.0), 1.0 - uAirAlb))) / (1.0 + dot(tau, vec3(0.5))));
    vec3 tl = uTorch * vec3(1.0, 0.96, 0.88) * c * (cone * fall * catchT) * Tb;
    // Soft knee: a wall at arm's length glows bright, it does not clip the
    // display to white (the eye holding the torch is exposed for the beam).
    col += tl / (1.0 + dot(tl, vec3(0.333)));
    // The air between eye and ground scatters the beam back (scattering.ts):
    // hazy nights show the cone itself, clean ones only the pool.
    col += torchGlow(uCamPos, vPos);
  }

  // Foam sits on top of the air (haze must not crush the shoreline by day)
  // but is LIT like everything else: white chalk under the sun, falling to
  // the same moonlit blue as the land at night — foam reflects, it does not
  // glow (no bioluminescence assumed).
  vec3 foamC = vec3(0.97, 1.0, 1.0) * mix(vec3(0.24, 0.30, 0.46), vec3(q), day);
  col = mix(col, foamC, foam);
  // Column capture: the water shader refracts THIS color through the sea
  // (Beer–Lambert on the packed distance), so shallows show the bottom
  // without the sea becoming a window onto the framebuffer.
  if (uWriteCol > 0.5) {
    gl_FragColor = vec4(col, distance(uCamPos, vPos));
    return;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface TerrainMaterialOptions {
  /** LEVEL_COUNT-stop strata ramp (paletteFor(physics)); home ramp default. */
  gradient?: RGB[];
  /** Body temp dial (0..1) — the base of the local temperature field. */
  tempBase?: number;
  /** Insolation span; UNIVERSE.TEMP_SPAN_* by spin state. */
  tempSpan?: number;
  /** True when the body keeps one face to its star (eyeball law). */
  lockedToStar?: boolean;
  /** Shoreline foam strength from ocean chemistry. */
  surfStrength?: number;
  /** 0..1 swell energy (physics.seaState — wind + tide). */
  waveEnergy?: number;
  /** Wave-clock rate ~ sqrt(g) (physics.seaState). */
  waveTempo?: number;
  /** 0..1 snow deposition capacity (reservoir × precipitation cycle). */
  snowAmount?: number;
  /** Temp dial re-centered on the working volatile's freeze point. */
  snowTempBase?: number;
  /** The air (physics.airExtinction); omit for airless worlds. */
  air?: {
    sigma: number;
    scaleH: number;
    curve: number;
    weights: RGB;
    albedo: RGB;
    aeroTau: number;
    aeroW: RGB;
  };
}

export function makeTerrainMaterial(opts: TerrainMaterialOptions = {}): THREE.ShaderMaterial {
  const gradient = opts.gradient ?? LEVEL_GRADIENT;
  const data = new Uint8Array(LEVEL_COUNT * 4);
  gradient.forEach((c, i) => {
    data[i * 4] = Math.round(c[0] * 255);
    data[i * 4 + 1] = Math.round(c[1] * 255);
    data[i * 4 + 2] = Math.round(c[2] * 255);
    data[i * 4 + 3] = 255;
  });
  const tex = new THREE.DataTexture(data, LEVEL_COUNT, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;

  return new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: {
      uGrad: { value: tex },
      uLevels: { value: LEVEL_COUNT },
      uSnow: { value: new THREE.Vector3(...SNOW_COLOR) },
      uWaterLevel: { value: 13.4 },
      uTime: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 0, 1) },
      uWarpFreq: { value: 40 },
      uTempBase: { value: opts.tempBase ?? 0.5 },
      uTempSpan: { value: opts.tempSpan ?? 0.35 },
      uTempMode: { value: opts.lockedToStar ? 1 : 0 },
      uSurfStrength: { value: opts.surfStrength ?? 1 },
      uWaveEnergy: { value: opts.waveEnergy ?? 0.85 },
      uWaveTempo: { value: opts.waveTempo ?? 1 },
      uWaveGain: { value: UNIVERSE.WAVE_GAIN },
      uSnowAmount: { value: opts.snowAmount ?? 1 },
      uSnowTempBase: { value: opts.snowTempBase ?? opts.tempBase ?? 0.5 },
      uSeasonGain: { value: UNIVERSE.SEASON_GAIN },
      uMirrorClip: { value: 0 },
      uWriteCol: { value: 0 },
      uCamPos: { value: new THREE.Vector3(0, 0, 3) },
      uTorch: { value: 0 },
      uTorchDir: { value: new THREE.Vector3(0, 0, -1) },
      uAirW: { value: new THREE.Vector3(...(opts.air?.weights ?? [1, 1, 1])) },
      uAirSigma: { value: opts.air?.sigma ?? 0 },
      uAirH: { value: opts.air?.scaleH ?? 0.05 },
      uSunLum: { value: UNIVERSE.SUN_LUM },
      uAirNight: { value: new THREE.Vector3(...UNIVERSE.NIGHT_AIR) },
      uAirCurv: { value: opts.air?.curve ?? 1 },
      uAirAlb: { value: new THREE.Vector3(...(opts.air?.albedo ?? [1, 1, 1])) },
      uAeroTau: { value: opts.air?.aeroTau ?? 0 },
      uAeroW: { value: new THREE.Vector3(...(opts.air?.aeroW ?? [1, 1, 1])) },
    },
  });
}

// Sea ice floats with FREEBOARD: frozen regions of the water sphere are
// lifted above the liquid waterline, so the sheet reads as a raised shelf
// and its edge becomes a new shore. The vertex law mirrors the fragment
// freeze law (smooth ramp — the crisp plate edge is fragment work).
const WATER_VERT = /* glsl */ `
uniform float uTempBase;
uniform float uTempSpan;
uniform float uTempMode;
uniform float uSeasonGain;
uniform float uIceFloor;
uniform float uFreeboard;
uniform vec3 uLightDir;
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vNormal = normal;
  vPos = position;
  float insol = uTempMode > 0.5
    ? normal.x
    : (sqrt(max(0.0, 1.0 - normal.z * normal.z)) - 0.785) * 1.6;
  insol += uSeasonGain * normal.z * uLightDir.z;
  float tLoc = clamp(uTempBase + uTempSpan * insol, 0.0, 1.0);
  float lift = max(uIceFloor, 1.0 - smoothstep(0.245, 0.315, tLoc));
  vec3 p = position * (1.0 + uFreeboard * lift);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

/**
 * Cel-shaded water. Three stylized ingredients, all from drifting 3D value
 * noise anchored to the sphere (no textures, no tiling, no orientation):
 *  - the fresnel depth gradient is quantized into a few flat bands whose
 *    boundaries wobble and swim with the noise, so the sea reads as moving
 *    tone bands rather than a smooth static gradient;
 *  - hard-edged ripple highlights — two noise fields multiplied and cut at a
 *    threshold, giving sparse wobbly bright patches that drift and morph
 *    (the classic toon-water glint pattern);
 *  - a crisp, hard-edged sun glint whose outline dances with the waves.
 * Fine ripples hand over to a planetary-scale field at far zoom so the sea
 * keeps moving from any distance without aliasing into shimmer.
 */
const WATER_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSurf;
uniform vec3 uDeep;
uniform vec3 uLightDir;
uniform float uTime;
uniform float uWaveFreq;
// Camera position in the body's local (unit-radius) frame: bodies now sit
// scaled and positioned around a sun, so the builtin world-space
// cameraPosition no longer matches object space.
uniform vec3 uCamPos;
// Chemistry and climate (see physics.ts): clarity scales translucency, and
// the insolation temperature law freezes the fill where it runs cold —
// polar ice on spinners, nightside ice on locked worlds, whole frozen
// sheets on iceballs. uTempBase is the FREEZE-SHIFTED dial (measured from
// the working volatile's freeze point, physics.snowTemp01), so water seas
// and methane seas harden by the same law; uIceColor carries the sheet's
// chemistry (glacier blue, dry-ice white, tholin-blushed methane...).
uniform float uClarity;
// Sea state (physics.seaState): energy stills or stirs every moving field —
// an airless world's sea is a MIRROR — and tempo (~sqrt g) sets their pace.
uniform float uWaveEnergy;
uniform float uWaveTempo;
uniform float uWaveGain;
uniform float uTempBase;
uniform float uTempSpan;
uniform float uTempMode;
uniform vec3 uIceColor;
uniform float uIceFloor; // 1 when melt is impossible (no pressure: ice only sublimates)
uniform float uSeasonGain;
// Mirror-world capture: the engine renders the terrain from the camera's
// reflection point beneath the water surface (engine.ts cube camera), so
// the same Fresnel that mirrors the sky can mirror the LAND standing over
// the shore. Alpha 0 where no terrain was hit — the analytic sky shows.
uniform samplerCube uEnv;
uniform float uEnvOn;
uniform mat3 uL2W;   // body-local -> world, for the cube lookup
uniform vec3 uReflC; // the mirrored eye point, body-local
// Water-column capture: terrain COLOR in rgb, body-local DISTANCE in
// alpha (0 = no ground). The water shader refracts the bottom through
// the sea by Beer–Lambert on that distance — shallows show sand, a long
// column is just water — instead of punching a hole in the framebuffer.
uniform sampler2D uColT;
uniform float uColOn;
uniform vec2 uScr;       // drawing-buffer size, for gl_FragCoord lookup
uniform float uDistScale; // kept for orbit/scale; distance is already local
uniform float uMurk;      // extinction per local unit, from clarity + step
uniform float uStep;      // terrace step (local units per level) — surf zone
// The one scattering law (scattering.ts) — same integral as the terrain.
${AIR_UNIFORMS_GLSL}
varying vec3 vNormal;
varying vec3 vPos;
${AIR_SCATTER_GLSL}

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

void main() {
  vec3 n0 = normalize(vNormal);
  vec3 t1 = normalize(cross(n0, abs(n0.y) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0)));
  vec3 t2 = cross(n0, t1);

  float t = uTime * uWaveTempo;
  vec3 p = vPos * uWaveFreq;
  // A dead-calm sea keeps a whisper of motion (thermal slosh); wind and
  // tide bring the rest, through the cosmic volume knob.
  float sea = mix(0.12, 1.0, uWaveEnergy) * uWaveGain;

  // LOD: fine ripples fade out as their noise cells approach pixel size and
  // the planetary-scale field takes over, so the sea moves at every zoom.
  float px = fwidth(p.x) + fwidth(p.y) + fwidth(p.z);
  float att = 1.0 - smoothstep(0.3, 1.2, px);

  // Fine ripple pair (close zoom) and planetary pair (far zoom).
  float n1 = vnoise(p * 0.55 + vec3(t * 0.30, t * 0.22, -t * 0.16));
  float n2 = vnoise(p * 0.85 + vec3(-t * 0.20, 4.7 + t * 0.13, t * 0.26));
  vec3 q = vPos * (uWaveFreq * 0.10);
  float m1 = vnoise(q + vec3(t * 0.12, t * 0.09, -t * 0.07));
  float m2 = vnoise(q * 1.6 + vec3(-t * 0.08, 3.1, t * 0.11));

  // Cel depth bands: quantize the fresnel gradient into flat tones, with the
  // ripple noise wobbling the band boundaries so they visibly swim.
  vec3 view = normalize(uCamPos - vPos);
  float facing = clamp(dot(n0, view), 0.0, 1.0);
  float dW = distance(uCamPos, vPos);
  float g = pow(facing, 1.2)
          + (0.10 * (m1 - 0.5)
          +  0.10 * att * (n1 - 0.5)) * sea;
  float steps = 4.0;
  float gs = clamp(g, 0.0, 1.0) * steps;
  float fw = max(fwidth(gs), 1e-3);
  float gq = clamp((floor(gs) + smoothstep(1.0 - fw, 1.0, fract(gs))) / steps, 0.0, 1.0);
  vec3 c = mix(uDeep, uSurf, gq);

  // The freeze law: local temperature from insolation (with the same
  // seasonal anomaly as the terrain — sea ice advances and retreats with
  // the tilt-driven seasons). The threshold sits at the volatile's freeze
  // point, which on the shifted dial is always 0.285 (physics.snowTemp01).
  float insol = uTempMode > 0.5
    ? n0.x
    : (sqrt(max(0.0, 1.0 - n0.z * n0.z)) - 0.785) * 1.6;
  insol += uSeasonGain * n0.z * uLightDir.z;
  float tLoc = clamp(uTempBase + uTempSpan * insol, 0.0, 1.0);

  // Sea ice is PLATES, not a fade: a STATIC noise field (frozen sheets do
  // not drift) wobbles the freeze isotherm into organic shelf edges, then a
  // hard cut makes the boundary a shoreline. sig > 0 means frozen.
  float sIce = vnoise(vPos * (uWaveFreq * 0.22) + vec3(7.3, 2.1, 5.6));
  float sig = (0.285 - tLoc) * 12.0 + 0.9 * (sIce - 0.5);
  if (uIceFloor > 0.5) sig = 1.0;
  float wIce = max(fwidth(sig) * 1.2, 0.04);
  float ice = smoothstep(-wIce, wIce, sig);

  // Hard-edged ripple highlights: two drifting fields multiplied, then cut at
  // a threshold — sparse wobbly patches that morph as they drift.
  float rip = n1 * n2;
  float ww = max(fwidth(rip) * 1.2, 0.015);
  float hi = smoothstep(0.34 - ww, 0.34 + ww, rip) * att;
  float ripF = m1 * m2;
  float wwF = max(fwidth(ripF) * 1.2, 0.015);
  float hiF = smoothstep(0.36 - wwF, 0.36 + wwF, ripF) * (1.0 - 0.5 * att);
  c = mix(c, vec3(0.82, 1.0, 1.0), 0.35 * sea * clamp(hi + hiF, 0.0, 1.0) * (1.0 - ice));

  // Frozen sheet: matte, near-opaque, colored by its chemistry, faintly
  // banded by STATIC noise (a frozen sheet holds still) so shelves read as
  // plates rather than paint. The shelf edge wall picks up a shadow line —
  // the freeboard made visible — and open water laps a bright foam fringe
  // against it: the ice edge is a shore.
  float sBand = vnoise(vPos * (uWaveFreq * 0.10) + vec3(3.7, 8.2, 1.4));
  vec3 iceC = uIceColor * (0.92 + 0.08 * sBand);
  iceC *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, 0.35, sig));      // shelf wall shading
  c = mix(c, iceC, ice);
  float lap = smoothstep(-0.45, -0.08, sig) * (1.0 - ice);      // water side of the edge
  lap *= 0.55 + 0.45 * n1;                                      // waves slosh against the shelf
  c = mix(c, vec3(0.93, 0.98, 1.0), 0.5 * lap);

  // Stylized sun glint: a crisp-edged patch (not a soft sheen) whose outline
  // dances because the normal rides the same waves.
  // Glint outline: waves dance it — a still sea throws one clean disc.
  vec3 nS = normalize(n0
    + (0.10 * ((n1 - 0.5) * t1 + (n2 - 0.5) * t2) * att
    +  0.09 * ((m1 - 0.5) * t1 + (m2 - 0.5) * t2)) * sea);

  // Refraction: the bottom, seen through the column. Not a hole in the
  // framebuffer (that made the sea vanish against the sky, and drowned
  // hills draw the horizon) — a color mix whose transmission dies with
  // optical depth. Snell's law bends the path (n ≈ 1.33) and the waves
  // wobble the lookup, so shallows shimmer over sand and open ocean is
  // just water.
  float colW = 8.0;   // levels of water along the ray; deep until we measure
  float botHit = 0.0;
  if (uColOn > 0.5) {
    vec2 uv = gl_FragCoord.xy / uScr
            + 0.035 * facing * vec2(nS.x - n0.x, nS.z - n0.z);
    vec4 bot = texture2D(uColT, clamp(uv, 0.0, 1.0));
    vec3 rdW = (vPos - uCamPos) / max(dW, 1e-9);
    float b = dot(uCamPos, rdW);
    float disc = max(b * b - dot(uCamPos, uCamPos) + 1.0, 0.0);
    float colChord = max((-b + sqrt(disc)) - dW, 0.0);
    float col = bot.a > 0.0 ? min(colChord, max(bot.a - dW, 0.0)) : colChord;
    colW = col / max(uStep, 1e-6);
    botHit = step(1e-5, bot.a);
    float cosT = sqrt(max(1.0 - (1.0 - facing * facing) / 1.77, 0.0));
    float absorb = 1.0 - exp(-uMurk * col * facing / max(cosT, 1e-3));
    // Even a thin film is water, not glass: the bottom is always at least
    // half the sea's own color, so bathymetry reads as *under* the liquid
    // rather than as dry land seen through a window.
    if (bot.a > 0.0) {
      vec3 through = mix(bot.rgb, c, 0.55);
      c = mix(c, mix(through, c, absorb), 1.0 - ice);
    }
  }

  vec3 h = normalize(uLightDir + view);
  float sd = clamp(dot(nS, h), 0.0, 1.0);
  float sw = max(fwidth(sd) * 1.5, 0.01);
  float glint = smoothstep(0.935 - sw, 0.935 + sw, sd);
  float halo = pow(sd, 24.0);

  // Day/night: night water sinks to a deep moonlit blue, and the sun glint
  // only lives on the day side (and never on ice).
  vec3 alb = c; // true color, for the torch: darkness hides it, light returns it
  float dayW = smoothstep(-0.14, 0.10, dot(n0, uLightDir));
  c = mix(c * vec3(0.26, 0.32, 0.50), c, dayW);
  c += vec3(1.0, 0.98, 0.9) * (0.30 * glint + 0.10 * halo) * dayW * (1.0 - ice);

  // Fresnel reflection: at grazing incidence the sea is a MIRROR (Schlick
  // reflectance walks toward 1). The reflected ray first asks the
  // mirror-world capture whether LAND stands there, and where it hit
  // nothing, falls back to the horizon sky. A little of the water's own
  // body always remains — a perfect mirror at the limb dissolved the sea
  // into the sky. Water underfoot barely reflects (F0 = 0.02).
  if (uAirSigma > 0.0 || uEnvOn > 0.5) {
    float F = 0.02 + 0.82 * pow(1.0 - facing, 5.0);
    if (F > 0.03) {
      vec3 rd = reflect(-view, normalize(mix(n0, nS, 0.6)));
      vec3 skyR = vec3(0.0);
      if (uAirSigma > 0.0) {
        vec3 rtau;
        skyR = airScatter(vPos, vPos + rd * 1.5, uLightDir, rtau);
      }
      float Fw = F;
      if (uEnvOn > 0.5) {
        // A sphere's mirror has two asymptotic regimes. NEAR the eye it is
        // locally flat, and the flat-mirror construction is exact: the
        // mirrored eye C, this water point P and the reflected target are
        // collinear, so the capture (shot from C) is sampled along C->P.
        // FAR from the eye the curvature has rotated P's normal away and
        // C->P is a lie — it dives along the tangent and drags whatever
        // island the capture holds across the horizon water as smeared
        // phantom mountains. Out there the true reflected ray from P is
        // the honest direction: it tilts up with the sphere and lands on
        // sky. Blend the two by distance against the horizon distance
        // (sqrt(2h), the scale on which "locally flat" dies), and in the
        // far regime also require the fetch to stand well above P's
        // horizon plane — a convex mirror only images content above it.
        vec3 mdFlat = normalize(vPos - uReflC);
        vec3 rdT = reflect(-view, normalize(mix(n0, nS, 0.35)));
        float hEye = max(length(uCamPos) - 1.0, 1e-4);
        float dh = sqrt(2.2 * hEye);
        float far = smoothstep(0.15 * dh, 0.45 * dh, dW);
        vec3 md = normalize(mix(mdFlat, rdT, far)) + 0.12 * (1.0 - far) * (nS - n0);
        vec4 land = textureCube(uEnv, uL2W * md);
        float la = land.a
          * mix(1.0, smoothstep(0.02, 0.09, dot(md, normalize(vPos))), far);
        skyR = mix(skyR, land.rgb, la);
        // Perceptual floor for the LAND image only: real water is dark,
        // so its reflections read strongly; our cel sea is bright, and
        // honest Schlick drowns the coast in the depth bands. Fades with
        // steepness so water underfoot keeps its translucency; the
        // open-sky band stays pure Fresnel, so the horizon law is
        // untouched.
        Fw = max(F, 0.32 * la * sqrt(1.0 - facing));
      }
      c = mix(c, skyR, Fw * (1.0 - ice));
    }
  }

  // Shoreline surf lives on the SEA now: the opaque water surface hid the
  // terrain's foam (which was painted on the seabed and the first beach
  // terrace). Same WKB law as the ground shader — crests bunch as depth
  // shrinks, break, and a wet line hugs the coast — gated to real shallows
  // (a seabed on this ray, a short column, not the grazing horizon chord).
  if (uColOn > 0.5 && ice < 0.5) {
    float shallow = botHit * (1.0 - smoothstep(0.4, 2.4, colW))
                  * smoothstep(0.10, 0.32, facing);
    if (shallow > 0.02) {
      float energy = mix(0.12, 1.0, uWaveEnergy) * uWaveGain;
      float dPos = max(colW, 0.0);
      float A = energy * 0.8 / pow(max(dPos, 0.25), 0.25);
      float brk = smoothstep(0.0, 0.5, A - 0.6 * dPos);
      float omega = uWaveTempo * 0.055;
      float off = vnoise(vPos * uWaveFreq * 0.35 + vec3(1.7, 8.3, 5.9));
      float ph = fract(2.2 * sqrt(dPos) + off + uTime * omega);
      float crest = smoothstep(0.62, 0.82, ph) * (1.0 - smoothstep(0.90, 1.0, ph));
      float line = 1.0 - smoothstep(0.0, 0.85, dPos);
      float foam = shallow * energy
                 * (line * 0.22 + crest * (0.20 + 0.75 * brk) * min(A, 1.0));
      vec3 foamC = vec3(0.97, 1.0, 1.0) * mix(vec3(0.24, 0.30, 0.46), vec3(1.0), dayW);
      c = mix(c, foamC, clamp(foam, 0.0, 0.85));
    }
  }

  // On the ground the sea is a SURFACE: alpha is 1, and the bottom is
  // already in the color via refraction. Looking through the framebuffer
  // made liquid vanish. From orbit the jewel stays translucent.
  float alpha;
  if (uColOn > 0.5) {
    alpha = 1.0;
  } else {
    alpha = clamp(0.5 + 0.34 * (1.0 - facing) + 0.06 * (m1 - 0.5), 0.0, 0.92);
    alpha = clamp(alpha * (1.15 - 0.45 * uClarity), 0.0, 0.94);
    alpha = mix(1.0, alpha, smoothstep(0.0, 0.35, facing));
  }
  alpha = mix(alpha, 0.97, ice);

  // The air along this ray, same law as the terrain: per-channel
  // extinction of the sea plus sunlit in-scatter, and a heavy column
  // covers whatever lies beneath (alpha rises with optical depth).
  vec3 seaC = c;
  vec3 tau = vec3(0.0);
  if (uAirSigma > 0.0) {
    vec3 air = airScatter(uCamPos, vPos, uLightDir, tau);
    c = c * exp(-tau) + air;
    // A sea is a surface with albedo, not a column of air: even a long
    // path keeps a little of the water's own color, or the limb dissolves
    // into the sky and the horizon line vanishes.
    c = mix(c, seaC, 0.4 * (1.0 - 0.45 * facing));
    alpha = mix(alpha, 1.0, 1.0 - exp(-dot(tau, vec3(1.0 / 3.0))));
  }

  // Torch: same beam as the terrain's (see there), on the water's true
  // color.
  if (uTorch > 0.0) {
    vec3 tv = vPos - uCamPos;
    float dT = length(tv);
    vec3 td = tv / max(dT, 1e-6);
    float cone = smoothstep(0.78, 0.965, dot(td, uTorchDir));
    float fall = 1.0 / (1.0 + 300.0 * dT * dT);
    float catchT = max(dot(n0, -td), 0.0);
    vec3 Tb = max(exp(-2.0 * tau),
      exp(-2.0 * tau * sqrt(3.0 * max(vec3(0.0), 1.0 - uAirAlb))) / (1.0 + dot(tau, vec3(0.5))));
    vec3 tl = uTorch * vec3(1.0, 0.96, 0.88) * alb * (cone * fall * catchT) * Tb;
    c += tl / (1.0 + dot(tl, vec3(0.333)));
    c += torchGlow(uCamPos, vPos);
  }
  gl_FragColor = vec4(c, alpha);
}
`;

export interface WaterMaterialOptions {
  surf?: RGB;
  deep?: RGB;
  /** 0 murky .. 1 glassy (physics.hydrosphere.clarity). */
  clarity?: number;
  /** FREEZE-SHIFTED temp dial (physics.snowTemp01 + player climate delta). */
  tempBase?: number;
  tempSpan?: number;
  lockedToStar?: boolean;
  /** Frozen-sheet color from chemistry (physics.hydrosphere.ice). */
  iceColor?: RGB;
  /** True when melt is impossible (airless sheets sublimate, never pool). */
  neverMelts?: boolean;
  /** 0..1 swell energy (physics.seaState — wind + tide). */
  waveEnergy?: number;
  /** Wave-clock rate ~ sqrt(g) (physics.seaState). */
  waveTempo?: number;
  /** The air (physics.airExtinction); omit for airless worlds. */
  air?: {
    sigma: number;
    scaleH: number;
    curve: number;
    weights: RGB;
    albedo: RGB;
    aeroTau: number;
    aeroW: RGB;
  };
}

export function makeWaterMaterial(opts: WaterMaterialOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uSurf: { value: new THREE.Vector3(...(opts.surf ?? WATER_SURFACE)) },
      uDeep: { value: new THREE.Vector3(...(opts.deep ?? WATER_DEEP)) },
      uLightDir: { value: new THREE.Vector3(0, 0, 1) },
      uTime: { value: 0 },
      uWaveFreq: { value: 170 },
      uCamPos: { value: new THREE.Vector3(0, 0, 3) },
      uClarity: { value: opts.clarity ?? 0.75 },
      uWaveEnergy: { value: opts.waveEnergy ?? 0.85 },
      uWaveTempo: { value: opts.waveTempo ?? 1 },
      uWaveGain: { value: UNIVERSE.WAVE_GAIN },
      uTempBase: { value: opts.tempBase ?? 0.5 },
      uTempSpan: { value: opts.tempSpan ?? 0.35 },
      uTempMode: { value: opts.lockedToStar ? 1 : 0 },
      uIceColor: { value: new THREE.Vector3(...(opts.iceColor ?? [0.88, 0.92, 0.97])) },
      uIceFloor: { value: opts.neverMelts ? 1 : 0 },
      uFreeboard: { value: 0.006 },
      uSeasonGain: { value: UNIVERSE.SEASON_GAIN },
      uTorch: { value: 0 },
      uTorchDir: { value: new THREE.Vector3(0, 0, -1) },
      uAirW: { value: new THREE.Vector3(...(opts.air?.weights ?? [1, 1, 1])) },
      uAirSigma: { value: opts.air?.sigma ?? 0 },
      uAirH: { value: opts.air?.scaleH ?? 0.05 },
      uSunLum: { value: UNIVERSE.SUN_LUM },
      uAirNight: { value: new THREE.Vector3(...UNIVERSE.NIGHT_AIR) },
      uAirCurv: { value: opts.air?.curve ?? 1 },
      uAirAlb: { value: new THREE.Vector3(...(opts.air?.albedo ?? [1, 1, 1])) },
      uAeroTau: { value: opts.air?.aeroTau ?? 0 },
      uAeroW: { value: new THREE.Vector3(...(opts.air?.aeroW ?? [1, 1, 1])) },
      uEnv: { value: null },
      uEnvOn: { value: 0 },
      uL2W: { value: new THREE.Matrix3() },
      uReflC: { value: new THREE.Vector3() },
      uColT: { value: null },
      uColOn: { value: 0 },
      uScr: { value: new THREE.Vector2(1, 1) },
      uDistScale: { value: 1 },
      uMurk: { value: 300 },
      uStep: { value: 0.003 },
    },
    transparent: true,
    // The sea is a surface, not a decal: it writes depth so the sky shell
    // (and anything else behind the limb) depth-tests against it. Without
    // this, ocean pixels have no depth, the sky keeps those rays, and the
    // horizon glow paints the water out wherever no land stood behind it.
    depthWrite: true,
    // Win the z-fight with terrace skin that blends/relieves just across
    // the waterline — otherwise those vertices poke through the sphere and
    // the SEABED, not the sea, draws the horizon.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
