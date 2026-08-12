import * as THREE from 'three';
import type { GeoGrid } from '../world/geodesic';
import { LEVEL_COUNT } from '../world/toygen';
import { LEVEL_GRADIENT, SNOW_COLOR, WATER_DEEP, WATER_SURFACE, type RGB } from '../world/toyPalette';
import { UNIVERSE } from '../world/physics';

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
function terrace(x: number, rounding: number): number {
  const base = Math.round(x);
  const f = x - base;
  const flat = 0.5 - rounding;
  const a = Math.abs(f);
  if (a <= flat) return base;
  const t = (a - flat) / rounding;
  const s = t * t * (3 - 2 * t);
  return base + Math.sign(f) * 0.5 * s;
}

/**
 * Resumable terrace-skin build: the vertex pass (the expensive part — one
 * nearestCell lookup plus a Gaussian blend per lattice vertex) is chunked so
 * the engine can spread a build over frames while the ship flies. Call
 * step(budgetMs) until it returns true, then finish() for the geometry.
 */
export class TerraceJob {
  private readonly dataGrid: GeoGrid;
  private readonly renderGrid: GeoGrid;
  private readonly levels: Uint8Array;
  private readonly opts: TerraceOptions;
  private readonly positions: Float32Array;
  private readonly aLevel: Float32Array;
  private readonly inv2s2: number;
  private i = 0;

  constructor(dataGrid: GeoGrid, renderGrid: GeoGrid, levels: Uint8Array, opts: TerraceOptions) {
    this.dataGrid = dataGrid;
    this.renderGrid = renderGrid;
    this.levels = levels;
    this.opts = opts;
    this.positions = new Float32Array(renderGrid.count * 3);
    this.aLevel = new Float32Array(renderGrid.count);
    // Gaussian blend of the nearest column and its ring: wide enough that the
    // skin is smooth across column borders, narrow enough that single-column
    // features survive as bumps.
    const sigma = 0.55 * dataGrid.cellSpacing();
    this.inv2s2 = 1 / (2 * sigma * sigma);
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
        const c0 = dataGrid.nearestCell(x, y, z);
        let sum = 0;
        let wsum = 0;
        const deg = dataGrid.degree(c0);
        for (let k = -1; k < deg; k++) {
          const c = k < 0 ? c0 : dataGrid.neighbors[c0 * 6 + k];
          const dot =
            dataGrid.centers[c * 3] * x +
            dataGrid.centers[c * 3 + 1] * y +
            dataGrid.centers[c * 3 + 2] * z;
          // Chord² ≈ angular distance² for small angles.
          const d2 = Math.max(0, 2 * (1 - dot));
          const w = Math.exp(-d2 * this.inv2s2);
          sum += w * levels[c];
          wsum += w;
        }
        const lvl = sum / wsum;
        this.aLevel[i] = lvl;
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
): THREE.BufferGeometry {
  const job = new TerraceJob(dataGrid, renderGrid, levels, opts);
  job.step(Infinity);
  return job.finish();
}

// ---------------------------------------------------------------- materials

const TERRAIN_VERT = /* glsl */ `
attribute float aLevel;
varying float vLevel;
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vLevel = aLevel;
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
uniform float uSnowAmount; // 0..1 deposition capacity (reservoir x cycle)
uniform float uSnowTempBase; // temp dial re-centered on the volatile's freeze point
uniform float uSeasonGain; // seasonal anomaly gain (UNIVERSE.SEASON_GAIN)
// Aerial perspective (physics.airExtinction): the air is densest at the
// ground, thinning as exp(-h/uAirH), and swallows light along the view
// path (Beer–Lambert) — distant terrain fades into the lit air color at a
// rate set by pressure and chemistry. uCamPos is in the body's local
// unit-radius frame (same as the water shader).
uniform vec3 uCamPos;
uniform vec3 uAirColor;
uniform float uAirSigma; // surface extinction per radius of path; 0 = no air
uniform float uAirH;     // density scale height, planet radii
varying float vLevel;
varying vec3 vNormal;
varying vec3 vPos;

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

  // Surf (the hero of the water): drawn on the seafloor and read through
  // the translucent sea. Standard stylized-water trick (Wind Waker,
  // Monument Valley): foam as a function of distance-to-shore — our depth
  // field gives that directly. A crisp lapping fringe at the waterline,
  // plus slow wave fronts rolling toward the beach: each front is a bright
  // crest with a soft trailing wash, wobbled by noise and desynced between
  // beaches so the whole planet never pulses in lockstep.
  float depth = uWaterLevel - vLevel;
  if (depth > 0.0 && depth < 1.8) {
    // Screen-space floor: surf features never collapse below ~2 px, so the
    // coasts stay alive even when zoomed well out.
    float pxl = fwidth(depth);

    float lap = vnoise(vPos * uWarpFreq * 1.6 + vec3(uTime * 0.35, uTime * -0.25, 3.1));
    float reach = max(0.1 + 0.18 * lap, 2.0 * pxl);
    float foam = (1.0 - smoothstep(reach * 0.25, reach, depth)) * 0.8;

    float off = vnoise(vPos * uWarpFreq * 0.35 + vec3(1.7, 8.3, 5.9));
    float ph = fract(depth + 0.22 * wob + off + uTime * 0.09);
    float wph = max(0.0, 2.0 * pxl);
    float crest = smoothstep(0.72 - wph, 0.9, ph) * (1.0 - smoothstep(0.94, 1.0, ph));
    float wash = smoothstep(0.45, 0.72, ph) * (1.0 - smoothstep(0.72, 0.95, ph));
    float strength = 1.0 - smoothstep(0.9, 1.6, depth);
    foam += (0.95 * crest + 0.3 * wash) * strength;

    // Frozen shores keep no surf (same freeze-point-anchored law as the
    // sea-ice shader: the shifted dial hits 0.285 at the freeze point).
    float frozen = 1.0 - smoothstep(0.245, 0.315, tSnow);
    c = mix(c, vec3(0.97, 1.0, 1.0), clamp(foam * uSurfStrength * (1.0 - frozen), 0.0, 0.9));
  }

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

  // Aerial perspective: integrate the exponential density profile along the
  // camera→fragment path and extinguish by Beer–Lambert. The fade is toward
  // the LIT air color — distant land dissolves into bright sky by day and
  // into darkness by night (air doesn't glow on its own).
  if (uAirSigma > 0.0) {
    float tau = 0.0;
    for (int i = 0; i < 8; i++) {
      vec3 sp = mix(uCamPos, vPos, (float(i) + 0.5) * 0.125);
      tau += exp(-max(length(sp) - 1.0, 0.0) / uAirH);
    }
    tau *= uAirSigma * distance(uCamPos, vPos) * 0.125;
    float airDay = clamp(dot(dir, uLightDir), 0.0, 1.0);
    vec3 airC = uAirColor * (0.10 + 0.90 * airDay);
    col = mix(col, airC, 1.0 - exp(-tau));
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
  /** 0..1 snow deposition capacity (reservoir × precipitation cycle). */
  snowAmount?: number;
  /** Temp dial re-centered on the working volatile's freeze point. */
  snowTempBase?: number;
  /** Aerial perspective (physics.airExtinction); omit for airless worlds. */
  air?: { sigma: number; scaleH: number; color: RGB };
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
      uSnowAmount: { value: opts.snowAmount ?? 1 },
      uSnowTempBase: { value: opts.snowTempBase ?? opts.tempBase ?? 0.5 },
      uSeasonGain: { value: UNIVERSE.SEASON_GAIN },
      uCamPos: { value: new THREE.Vector3(0, 0, 3) },
      uAirColor: { value: new THREE.Vector3(...(opts.air?.color ?? [0.6, 0.75, 0.9])) },
      uAirSigma: { value: opts.air?.sigma ?? 0 },
      uAirH: { value: opts.air?.scaleH ?? 0.05 },
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
uniform float uTempBase;
uniform float uTempSpan;
uniform float uTempMode;
uniform vec3 uIceColor;
uniform float uIceFloor; // 1 when melt is impossible (no pressure: ice only sublimates)
uniform float uSeasonGain;
// Aerial perspective (physics.airExtinction) — same law as the terrain.
uniform vec3 uAirColor;
uniform float uAirSigma;
uniform float uAirH;
varying vec3 vNormal;
varying vec3 vPos;

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

  float t = uTime;
  vec3 p = vPos * uWaveFreq;

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
  float g = pow(facing, 1.2)
          + 0.10 * (m1 - 0.5)
          + 0.10 * att * (n1 - 0.5);
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
  c = mix(c, vec3(0.82, 1.0, 1.0), 0.35 * clamp(hi + hiF, 0.0, 1.0) * (1.0 - ice));

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
  vec3 nS = normalize(n0
    + 0.10 * ((n1 - 0.5) * t1 + (n2 - 0.5) * t2) * att
    + 0.09 * ((m1 - 0.5) * t1 + (m2 - 0.5) * t2));
  vec3 h = normalize(uLightDir + view);
  float sd = clamp(dot(nS, h), 0.0, 1.0);
  float sw = max(fwidth(sd) * 1.5, 0.01);
  float glint = smoothstep(0.935 - sw, 0.935 + sw, sd);
  float halo = pow(sd, 24.0);

  // Day/night: night water sinks to a deep moonlit blue, and the sun glint
  // only lives on the day side (and never on ice).
  float dayW = smoothstep(-0.14, 0.10, dot(n0, uLightDir));
  c = mix(c * vec3(0.26, 0.32, 0.50), c, dayW);
  c += vec3(1.0, 0.98, 0.9) * (0.30 * glint + 0.10 * halo) * dayW * (1.0 - ice);

  // Clarity from chemistry: glassy seas (methane, pure water) stay
  // translucent; salt-clouded ones read milkier.
  float alpha = clamp(0.5 + 0.34 * (1.0 - facing) + 0.06 * (m1 - 0.5), 0.0, 0.92);
  alpha = clamp(alpha * (1.15 - 0.45 * uClarity), 0.0, 0.94);
  alpha = mix(alpha, 0.97, ice);

  // Aerial perspective, same integral as the terrain: distant water fades
  // into lit air, and a heavy fog covers whatever lies beneath (alpha rises
  // with optical depth).
  if (uAirSigma > 0.0) {
    float tau = 0.0;
    for (int i = 0; i < 8; i++) {
      vec3 sp = mix(uCamPos, vPos, (float(i) + 0.5) * 0.125);
      tau += exp(-max(length(sp) - 1.0, 0.0) / uAirH);
    }
    tau *= uAirSigma * distance(uCamPos, vPos) * 0.125;
    float fog = 1.0 - exp(-tau);
    float airDay = clamp(dot(n0, uLightDir), 0.0, 1.0);
    c = mix(c, uAirColor * (0.10 + 0.90 * airDay), fog);
    alpha = mix(alpha, 1.0, fog);
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
  /** Aerial perspective (physics.airExtinction); omit for airless worlds. */
  air?: { sigma: number; scaleH: number; color: RGB };
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
      uTempBase: { value: opts.tempBase ?? 0.5 },
      uTempSpan: { value: opts.tempSpan ?? 0.35 },
      uTempMode: { value: opts.lockedToStar ? 1 : 0 },
      uIceColor: { value: new THREE.Vector3(...(opts.iceColor ?? [0.88, 0.92, 0.97])) },
      uIceFloor: { value: opts.neverMelts ? 1 : 0 },
      uFreeboard: { value: 0.006 },
      uSeasonGain: { value: UNIVERSE.SEASON_GAIN },
      uAirColor: { value: new THREE.Vector3(...(opts.air?.color ?? [0.6, 0.75, 0.9])) },
      uAirSigma: { value: opts.air?.sigma ?? 0 },
      uAirH: { value: opts.air?.scaleH ?? 0.05 },
    },
    transparent: true,
    depthWrite: false,
  });
}
