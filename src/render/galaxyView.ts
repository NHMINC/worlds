/**
 * The galaxy explorer is three catalogs plus the decreed
 * cosmic shell: the star harvest, nebulae, dust-as-extinction,
 * and a
 * distant void of inclined galaxies and star-like pins. The camera sits at the
 * viewpoint centre (1:1 catalog kpc). “Here” is a focus highlight
 * parked in front of the camera; other samples can mark points
 * of interest. The faint 95% is a later survey. Warp is a latched
 * cruise; Face-on / Edge-on slide far enough that the disk fits;
 * Home parks on the loaded star; Back restores the previous pose.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, homeStar, objectAt, type GalaxyObject } from '../world/galaxy';
import {
  aimLocks,
  harvestGlowPx,
  HARVEST_L_REF,
  HARVEST_PIN_CANVAS,
  HARVEST_PIN_CORE,
  HARVEST_PSF_A,
  HARVEST_PSF_B,
  HARVEST_PSF_CORE,
  HARVEST_PSF_TAIL,
  HARVEST_PSF_THRESH,
  HARVEST_SHINE_DIST_P,
  HARVEST_SHINE_DIST_REF,
  HARVEST_SHINE_GAIN,
  HARVEST_SHINE_L_P,
  HARVEST_SHINE_SAT,
  HARVEST_SUPER_GAIN,
  HARVEST_SUPER_L,
  HARVEST_SUPER_P,
  POINT_FLUX_EPS,
  glowRadiusKpc,
} from './galaxyStar';
import { classifyStar } from '../world/stellar';
import { systemAt } from '../world/systemgen';
import {
  silhouetteCloud,
  nebulaCloud,
  harvestDustVolume,
  regionName,
  sketchMatches,
  BIT_REMNANT,
  type StarCloud,
} from '../world/sectors';
import { SHAPE_GLSL } from '../world/skyShape';
import { prepareUniverse } from '../world/universePrep';
import {
  COSMIC_STAR_PIN,
  COSMIC_STAR_PIN_CORE,
  dustFilterFrag,
  cosmicSmudgeFrag,
  cosmicSmudgeVert,
  cosmicStarFrag,
  cosmicStarVert,
  cosmicVert,
  cosmicVoidRgb,
  mintCosmicSmudges,
  mintCosmicStars,
} from './cosmicBg';
/** Bake a number into GLSL as a float literal (GLSL ES has no int→float). */
const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * Dust is not drawn; it is subtraction. The bake stores the raw
 * midplane clump photograph (`ismAt.photo`) in a 3D volume; the
 * march carves it live (floor + hardness). Starlight columns are
 * Beer–Lambert with a core wall (extinctT); the far photograph
 * dies under the veil law (extinctLook). Empty space stays clear.
 * `steps` is baked per shader.
 */
const extinctGlsl = (steps: number) => /* glsl */ `
  uniform float uExtinctK;
  uniform float uExtinctMax;
  uniform float uExtinctCut;
  uniform float uExtinctHard;
  uniform float uExtinctWall;
  uniform float uDustDebug;
  uniform vec3 uDustRgb;
  uniform sampler3D uDustVol;
  uniform vec3 uDustOrigin;
  uniform vec3 uDustInvSize;
  // Raw photograph field (the bake stores ismAt.photo uncarved).
  float extinctRhoRaw(vec3 p) {
    vec3 uv = (p - uDustOrigin) * uDustInvSize;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.z < 0.0 ||
        uv.x > 1.0 || uv.y > 1.0 || uv.z > 1.0) return 0.0;
    // WebGL2 / GLSL3: Three rewrites texture2D → texture, not texture3D.
    // texture3D fails to compile and the whole harvest Points program dies.
    // Linear 3D tap. Isolated voxels used to read as diamonds
    // (the tent kernel); the bake splats a Gaussian so the
    // isosurface follows the sheet, not the lattice.
    return texture(uDustVol, uv).r;
  }
  // The cloud carve: floor + hardness (the old bake-time dense
  // cut and streak) applied per tap, so both are live knobs.
  float extinctRho(vec3 p) {
    float t = max(extinctRhoRaw(p) - uExtinctCut, 0.0);
    return pow(t, max(uExtinctHard, 0.15));
  }
  // Peak in this step so a thin wall cannot hide between taps
  // when the chord is long (edge-on, or camera far above).
  float extinctRhoPeak(vec3 p, vec3 dir, float dt) {
    float r = extinctRho(p);
    float h = max(dt, 0.04) * 0.33;
    r = max(r, extinctRho(p - dir * h));
    r = max(r, extinctRho(p + dir * h));
    return r;
  }
  // Skin is Beer–Lambert (blue dies first). A hard r≥wall clip
  // printed the Cartesian lattice as 45° diamonds. The core still
  // goes lightless; the edge is a ramp, not a faceted isosurface.
  float extinctTau(vec3 from, vec3 to) {
    float dCat = length(to - from);
    float dt = dCat / ${glslFloat(steps)};
    vec3 dir = (to - from) / max(dCat, 1e-4);
    float tau = 0.0;
    float wall = uExtinctWall;
    float kdt = uExtinctK * dt;
    float coreFill = uExtinctMax / max(kdt, 1e-4);
    for (int i = 0; i < ${steps}; i++) {
      float r = extinctRhoPeak(from + dir * ((float(i) + 0.5) * dt), dir, dt);
      if (wall > 1e-4) {
        float core = smoothstep(wall * 0.62, wall, r);
        tau += mix(r, max(r, coreFill), core);
      } else {
        tau += r;
      }
    }
    return min(tau * kdt, uExtinctMax);
  }
  vec3 extinctT(vec3 from, vec3 to) {
    return exp(-extinctTau(from, to) * uDustRgb);
  }
  vec2 extinctSpan(vec3 from, vec3 dir) {
    vec3 d = dir;
    if (abs(d.x) < 1e-8) d.x = 1e-8;
    if (abs(d.y) < 1e-8) d.y = 1e-8;
    if (abs(d.z) < 1e-8) d.z = 1e-8;
    vec3 b0 = uDustOrigin;
    vec3 b1 = uDustOrigin + 1.0 / max(uDustInvSize, vec3(1e-6));
    vec3 tA = (b0 - from) / d;
    vec3 tB = (b1 - from) / d;
    vec3 tmin = min(tA, tB);
    vec3 tmax = max(tA, tB);
    float enter = max(max(tmin.x, tmin.y), tmin.z);
    float leave = min(min(tmax.x, tmax.y), tmax.z);
    if (leave < 0.0 || enter > leave) return vec2(1.0, -1.0);
    return vec2(enter, leave);
  }
  // The VEIL: one decreed optical law for the far photograph.
  // Honest Beer–Lambert through the toy-thin sheet is glass
  // face-on (T ≈ 0.96 through a ribbon body — the sheet is
  // ~0.15 kpc), so transmission alone can never silhouette the
  // clouds; and an eye EMBEDDED in a cloud must lose the sky in
  // every direction (forward scatter erases distant point
  // sources). Both are the same statement: the far photograph
  // dies where the sightline TOUCHES the sheet — at the eye or
  // at any tap. The ramp rides the RAW field around the carve
  // floor (the fade band sits below the floor, exactly where you
  // can stand), so the rim is a fade, not a pop. Beer–Lambert
  // still tints the fade. Harvest stars keep their honest
  // camera→star column (extinctT) — from inside the fog you
  // still see what is close.
  vec3 extinctLook(vec3 from, vec3 dir) {
    float lo = max(uExtinctCut, 1e-3);
    float v0 = lo * 0.55;
    float v1 = lo * 1.1;
    float peak = extinctRhoRaw(from);
    if (peak >= v1) return vec3(0.0);
    vec2 span = extinctSpan(from, dir);
    if (span.x > span.y) return vec3(1.0 - smoothstep(v0, v1, peak));
    float t0 = max(span.x, 0.0);
    float dCat = span.y - t0;
    if (dCat < 1e-4) return vec3(1.0 - smoothstep(v0, v1, peak));
    float dt = dCat / ${glslFloat(steps)};
    float h = max(dt, 0.04) * 0.33;
    float kdt = uExtinctK * dt;
    float tau = 0.0;
    for (int i = 0; i < ${steps}; i++) {
      vec3 p = from + dir * (t0 + (float(i) + 0.5) * dt);
      // Peak of three raw taps so a thin wall cannot hide between
      // taps when the chord is long (edge-on, camera far above).
      float raw = extinctRhoRaw(p);
      raw = max(raw, extinctRhoRaw(p - dir * h));
      raw = max(raw, extinctRhoRaw(p + dir * h));
      peak = max(peak, raw);
      if (peak >= v1) return vec3(0.0);
      tau += pow(max(raw - uExtinctCut, 0.0), max(uExtinctHard, 0.15));
    }
    float veil = 1.0 - smoothstep(v0, v1, peak);
    return veil * exp(-min(tau * kdt, uExtinctMax) * uDustRgb);
  }
`;

/** Look test: `?dust=green` / `?fog=green` (or the live knob)
 *  paints a shaded lime skin on the ISM-field ribbons
 *  on the sky — not the catalog pins. */
function dustDebugOn(): boolean {
  if (typeof location === 'undefined') return false;
  return /[?&](?:dust|fog|fox)=green/.test(location.search);
}

/** Park “here” this far ahead of the camera (catalog kpc). */
const FOCUS_PARK = 0.35;
const ZOOM_WHEEL_SENS = 0.0008;
const ZOOM_PINCH_POW = 0.7;

export type GalaxyMode = 'region';
export type GalaxyFilter = 'all' | 'hot' | 'sunlike' | 'cool' | 'remnant' | 'nebula' | 'halo' | 'arm';
export type GalaxyPreset = 'face' | 'edge' | 'home' | 'back';

interface BubblePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function matchesFilter(o: GalaxyObject, f: GalaxyFilter): boolean {
  const st = o.star;
  if (f === 'all') return true;
  if (f === 'hot') return st.mk === 'O' || st.mk === 'B' || st.mk === 'A' || st.phase === 'wolf_rayet';
  if (f === 'sunlike') {
    return (st.mk === 'F' || st.mk === 'G' || st.mk === 'K') && (st.lumClass === 'V' || st.lumClass === 'VI');
  }
  if (f === 'cool') return st.mk === 'M' || st.mk === 'L' || st.mk === 'T' || st.phase === 'brown_dwarf';
  if (f === 'remnant') {
    return st.phase === 'white_dwarf' || st.phase === 'neutron_star' || st.phase === 'pulsar' || st.phase === 'black_hole';
  }
  if (f === 'nebula') return st.nebula !== 'none';
  if (f === 'halo') return o.pop === 'halo';
  return o.inArm;
}


/** Disk diameter with slack — Face-on sits several R_MAX out. */
function regionCamFar(): number {
  return Math.max(UNIVERSE.GALAXY_R_MAX * 8, UNIVERSE.GALAXY_WARP_LIM * 1.5);
}

/**
 * Half-angle (rad) that should hold the disk radius. Edge-on is a
 * horizontal needle — use the width. Face-on is a circle — use the
 * shorter axis so it fits.
 */
export function overviewHalfAngle(fovDeg: number, aspect: number, kind: 'face' | 'edge'): number {
  const vHalf = ((fovDeg * Math.PI) / 180) * 0.5;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(1e-4, aspect));
  return kind === 'edge' ? hHalf : Math.min(vHalf, hHalf);
}

/** Sit this far (kpc) so radius `r` fills `fill` of that half-angle. */
export function overviewDistanceKpc(r: number, halfAngle: number, fill = 0.92): number {
  return r / Math.max(1e-4, Math.tan(Math.max(1e-4, halfAngle) * fill));
}

const SILHOUETTE_VERT = /* glsl */ `
  ${extinctGlsl(UNIVERSE.GALAXY_EXTINCT_STEPS)}
  attribute vec3 aColor;
  attribute float aVis;
  attribute float aLum;
  attribute float aKind;
  attribute float aSize;
  attribute float aSeed;
  uniform float uPass;
  uniform vec3 uCenter;
  uniform float uScale;
  uniform float uPixel;
  uniform float uPxPerRad;
  uniform float uRegionR;
  uniform float uNebulaPx;
  uniform float uFluxEps;
  uniform float uLRef;
  uniform float uPsfCore;
  uniform float uPsfTail;
  uniform float uPsfA;
  uniform float uPsfB;
  uniform float uPsfThresh;
  uniform float uShineLGain;
  uniform float uShineLP;
  uniform float uShineDistRef;
  uniform float uShineDistP;
  uniform float uShineSat;
  uniform float uSuperL;
  uniform float uSuperGain;
  uniform float uSuperP;
  uniform float uPinCanvas;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  varying float vStamp;

  void main() {
    vColor = aColor;
    vKind = aKind;
    vSeed = aSeed;
    vCenterView = vec3(0.0);
    vRadiusView = 0.0;
    vCenterCat = vec3(0.0);
    vPx = 0.0;
    vStamp = 0.0;
    // Cull wrong-kind sprites for the pass here — a fragment discard
    // still rasterizes the whole quad, tripling core overdraw. Dust
    // is not harvested (kind > 3.5 never passes either gate).
    // No membership ball: the harvest is the whole sky.
    if ((uPass < 0.5 && aKind > 0.5) ||
        (uPass > 0.5 && (aKind < 0.5 || aKind > 3.5))) {
      vVis = 0.0;
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 view = (position - uCenter) * uScale;
    vec4 mv = modelViewMatrix * vec4(view, 1.0);
    if (aKind > 0.5) {
      // Same angular law as the local layer: radiusKpc / distance,
      // with a pixel floor so far sources stay findable. No pop at
      // the bubble boundary.
      float d = max(length(mv.xyz), 0.001);
      float ang = max(aSize, 0.005) * uScale / d;
      float floorPx = uNebulaPx * uPixel;
      gl_PointSize = clamp(2.0 * ang * uPxPerRad, floorPx, 512.0);
      vVis = aVis;
      vCenterView = mv.xyz;
      vRadiusView = max(aSize, 0.005) * uScale;
      vCenterCat = position;
      vPx = gl_PointSize;
    } else {
      // Point + eye PSF. Sprite size is room for visible wings,
      // not a disc radius. Colour is Teff, pushed off grey.
      float d = max(length(mv.xyz), 0.001);
      float L = max(aLum, 1e-4);
      float distF = pow(uShineDistRef / max(d, 0.4), uShineDistP);
      float base = uShineLGain * pow(L / max(uLRef, 1.0), uShineLP);
      float superX = L / max(uSuperL, 1.0);
      float extra = superX > 1.0
        ? uSuperGain * (pow(superX, uSuperP) - 1.0)
        : 0.0;
      float shine = (base + extra) * distF;
      float num = uPsfTail * shine / max(uPsfThresh, 1e-5) - uPsfA;
      float rCss = sqrt(max(0.0, num / max(uPsfB, 1e-5)));
      float css = max(1.0, 1.0 + 2.0 * rCss);
      float wingPx = css * uPixel;
      // Floor pin: soft device-pixel Gaussian. A thin plus still
      // blinked — GL_POINTS hops the covered set by 1px. Wings
      // that already need more room keep the CSS PSF.
      if (wingPx <= uPinCanvas) {
        gl_PointSize = uPinCanvas;
        vStamp = 1.0;
      } else {
        gl_PointSize = max(uPixel, wingPx);
      }
      float lum = dot(aColor, vec3(0.2126, 0.7152, 0.0722));
      vColor = clamp(mix(vec3(lum), aColor, uShineSat), 0.0, 1.0);
      vVis = shine;
      vPx = gl_PointSize;
    }
    // Extinction: march the column from the bubble to this row.
    vec3 ext = extinctT(uCenter, position);
    float extLum = dot(ext, vec3(0.2126, 0.7152, 0.0722));
    vVis *= extLum;
    vColor *= ext / max(extLum, 1e-3);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  ${SHAPE_GLSL}
  // 0 = photosphere stars, 1 = emission nebulae (screen blend).
  // Dust has no pass: it is sightline extinction in the vertex stage.
  uniform float uPass;
  uniform float uNebGain;
  uniform float uScale;
  uniform float uPixel;
  uniform mat3 uCamRotInv;
  uniform float uDustSteps;
  uniform float uDustMinPx;
  uniform float uDustFreq;
  uniform float uPsfCore;
  uniform float uPsfTail;
  uniform float uPsfA;
  uniform float uPsfB;
  uniform float uPinCore;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  varying float vStamp;
  void main() {
    if (uPass < 0.5 && vKind > 0.5) discard;
    if (uPass > 0.5 && (vKind < 0.5 || vKind > 3.5)) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    if (vKind < 0.5) {
      // Same device-pixel Gaussian as harvestPinWeight. A 1px hop
      // only exchanges faint halo — not a disc, not a plus.
      if (vStamp > 0.5) {
        vec2 d = (gl_PointCoord - 0.5) * vPx;
        float w = exp(-dot(d, d) * uPinCore);
        float I = max(vVis, 0.0) * w;
        if (I < 0.008) discard;
        gl_FragColor = vec4(vColor * I, 1.0);
        return;
      }
      float edge = length(p);
      if (edge > 1.0) discard;
      float I = max(vVis, 0.0);
      // PSF lives in CSS pixels, not sprite UVs. Stretching a
      // gaussian to fill the quad was the white-disc photograph.
      float rCss = (edge * vPx * 0.5) / max(uPixel, 1.0);
      float core = exp(-rCss * rCss * uPsfCore);
      float tail = uPsfTail / (uPsfA + uPsfB * rCss * rCss);
      float window = 1.0 - edge * edge;
      window *= window;
      float profile = I * (0.95 * core + tail) * window;
      if (profile < 0.008) discard;
      // Wings keep Teff. Only the photocentre of a very bright
      // row bleaches — the way a plate overexposes a point.
      float bleach = smoothstep(1.4, 3.2, I) * core;
      vec3 c = mix(vColor, vec3(1.0), bleach) * profile;
      gl_FragColor = vec4(c, 1.0);
      return;
    }
    // Emission nebulae: self-luminous shells. Brightness is emission
    // measure — rho² integrated along the ray — normalized to surface
    // brightness so rings and filaments come from geometry.
    if (vPx < uDustMinPx * uPixel) {
      float mask = smoothstep(1.0, 0.5, length(p));
      // Same photograph knob as the marched path — unresolved
      // shells used to ignore it and stack the midplane to white.
      float a = vVis * uNebGain * 0.12 * mask;
      if (a < 0.01) discard;
      gl_FragColor = vec4(vColor * a, 1.0);
      return;
    }
    vec3 fragView = vCenterView + vec3(p.x, -p.y, 0.0) * vRadiusView;
    vec3 rd = normalize(fragView);
    float b = dot(rd, vCenterView);
    float cc = dot(vCenterView, vCenterView) - vRadiusView * vRadiusView;
    float h = b * b - cc;
    if (h <= 0.0) discard;
    h = sqrt(h);
    float t0 = max(b - h, 0.001);
    float t1 = b + h;
    if (t1 <= t0) discard;
    float radiusCat = vRadiusView / uScale;
    float steps = clamp(floor(vPx / 24.0) + 2.0, 2.0, uDustSteps);
    float em = 0.0;
    vec3 meanRel = vec3(0.0);
    float wSum = 0.0;
    for (int i = 0; i < 16; i++) {
      if (float(i) >= steps - 0.5) break;
      float t = mix(t0, t1, (float(i) + 0.5) / steps);
      vec3 relCat = (uCamRotInv * (rd * t - vCenterView)) / uScale;
      float rho = nebRho(vKind, vCenterCat + relCat, relCat, radiusCat, vVis, uDustFreq, vSeed);
      float w = rho * rho;
      em += w;
      meanRel += relCat * w;
      wSum += w;
    }
    float segCat = (t1 - t0) / uScale;
    em *= uNebGain * vVis * segCat / (steps * max(radiusCat, 1e-4));
    if (em < 0.012 || wSum < 1e-5) discard;
    // The palette is a line spectrum, placed by IONIZATION
    // STRATIFICATION: excitation is highest near the hot source and
    // in young (hard-spectrum) events, falling outward — [O III]
    // teal cores, H-alpha pink bodies, [S II] deep-red cool edges.
    // One nebula wears the whole mix; age slides the balance.
    vec3 mrel = meanRel / wSum;
    float rMean = length(mrel) / max(radiusCat, 1e-4);
    float hard = clamp(vVis, 0.0, 1.0);
    float e = hard * (1.6 - 1.1 * rMean);
    if (vKind > 2.5) {
      // Shock strands: neighbouring filaments ride different shock
      // speeds — the Veil's interleaved red and teal lacework. The
      // lace survives ageing; the overall balance still reddens.
      e += 0.12 + 0.6 * nebField(vCenterCat + mrel * 2.6 + 91.0, uDustFreq * 1.6);
    }
    vec3 lineSII = vec3(0.9, 0.18, 0.12);
    vec3 lineHa = vec3(1.0, 0.4, 0.36);
    vec3 lineOIII = vec3(0.3, 0.95, 0.8);
    vec3 line = mix(lineSII, lineHa, smoothstep(0.1, 0.5, e));
    line = mix(line, lineOIII, smoothstep(0.55, 0.95, e));
    // Chemistry keeps a voice: the host tint leans the line blend.
    vec3 col = mix(line, vColor, 0.25);
    float glow = em / (1.0 + em);
    gl_FragColor = vec4(col * glow, 1.0);
  }
`;

export interface GalaxyFocus {
  id: number;
  name: string;
  cls: string;
  phase: string;
  planets: number;
  moons: number;
  life: boolean;
  dark: boolean;
  /** Stage-local pixels. */
  x: number;
  y: number;
  dist: number;
}

export interface GalaxyFrame {
  mode: GalaxyMode;
  theta: number;
  phi: number;
  radius: number;
  pickable: boolean;
  /** Loaded region stars. */
  resolved: number;
  /** Local catalog stars close enough to lock the reticle — no cap. */
  grown: number;
  /** Region label, e.g. "8.2 kpc · 57°". */
  sector: string | null;
  /** GPU rows shown (star harvest + nebula catalog). */
  population: number;
  /** Most-centred star in the sight, when close enough. */
  focus: GalaxyFocus | null;
  /** True while warp is latched on (Stop). */
  warp: boolean;
  /** Luminous-tail backdrop points currently on the GPU (0 if not minted). */
  backdrop: number;
}

export interface RegionSelection {
  name: string;
  population: number;
  x: number;
  y: number;
  z: number;
}

interface Callbacks {
  onSelect: (obj: GalaxyObject | null) => void;
  /** Set course from the sight plate. */
  onGo?: (obj: GalaxyObject) => void;
  onFrame?: (f: GalaxyFrame) => void;
}

export class GalaxyView {
  /** Stars loaded for the open region (empty on the map). */
  objects: GalaxyObject[] = [];
  readonly home: GalaxyObject | null;
  lastEnterMs = 0;
  private seed: string;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private callbacks: Callbacks;
  private disposed = false;
  private raf = 0;
  private active = true;

  private mode: GalaxyMode = 'region';
  private regionLabel: string | null = null;
  private sectorPop = 0;
  private overview = false;
  private backPose: BubblePose | null = null;
  private lastSightAt = 0;
  private focusObj: GalaxyObject | null = null;
  private focusHud: GalaxyFocus | null = null;
  private grownCount = 0;
  private briefMemo = new Map<number, { name: string; planets: number; moons: number; life: boolean }>();

  private starVis: THREE.BufferAttribute | null = null;
  private nebVis: THREE.BufferAttribute | null = null;
  private silPts: THREE.Points | null = null;
  private silGeo: THREE.BufferGeometry | null = null;
  private silMat: THREE.ShaderMaterial | null = null;
  private silEmisPts: THREE.Points | null = null;
  private silEmisGeo: THREE.BufferGeometry | null = null;
  private silEmisMat: THREE.ShaderMaterial | null = null;
  private silDustTex: THREE.Data3DTexture | null = null;
  /** The dust filter quad: multiplies the background (void clear +
   *  pins + smudges — everything beyond the dust box) by one
   *  per-pixel march. Not a skybox; the background is scene
   *  content and this is the one law that filters it. */
  private cosmicPts: THREE.Mesh | null = null;
  private cosmicGeo: THREE.BufferGeometry | null = null;
  private cosmicMat: THREE.ShaderMaterial | null = null;
  private voidClear = new THREE.Color(0, 0, 0);
  private cosmicStarPts: THREE.Points | null = null;
  private cosmicStarGeo: THREE.BufferGeometry | null = null;
  private cosmicStarMat: THREE.ShaderMaterial | null = null;
  private cosmicSmudgePts: THREE.Points | null = null;
  private cosmicSmudgeGeo: THREE.BufferGeometry | null = null;
  private cosmicSmudgeMat: THREE.ShaderMaterial | null = null;
  /** HDR photograph: layers add, then one Reinhard knee. */
  private photoRt: THREE.WebGLRenderTarget | null = null;
  private photoMat: THREE.ShaderMaterial | null = null;
  private photoQuad: THREE.Mesh | null = null;
  private photoScene = new THREE.Scene();
  private photoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Star harvest positions (the vertex shader subtracts uCenter). */
  private cloud: StarCloud | null = null;
  /** Nebula catalog — own mesh, rebakes without reminting stars. */
  private nebulae: StarCloud | null = null;

  private camRot3 = new THREE.Matrix3();

  private pickRing: THREE.Mesh;
  private hereRing: THREE.Mesh;
  private hereObj: GalaxyObject | null = null;
  private visitedIds: number[] = [];

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  private theta = 0.25;
  private phi = 0.16;
  private tgtTheta = 0.25;
  private tgtPhi = 0.16;

  /** Camera stays at the origin; the bubble centre moves. */
  private arcPos = new THREE.Vector3();
  private arcYaw = 0;
  private arcPitch = -0.6;
  /** Magnification-sphere centre in catalog cartesian (kpc). */
  private arcCenter = new THREE.Vector3();
  /** Last centre we minted / advanced to. */
  private mintAt = new THREE.Vector3();
  private arcFwd = new THREE.Vector3();
  private arcRight = new THREE.Vector3();
  private arcUp = new THREE.Vector3();
  private arcLook = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private keys = new Set<string>();
  private panBtn = 0;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private thrustOn = false;
  private thrustSpeed = 0;
  private idle = 0;
  private lastT = performance.now();

  private filter: GalaxyFilter = 'all';
  private selected: GalaxyObject | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    seed: string,
    callbacks: Callbacks,
    hereStarId: number | null = null,
  ) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.seed = seed;
    this.home = homeStar(seed);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // Black, not the void tint. The cosmic quad paints the night.
    // An unfiltered clear was the void shining through dust holes.
    this.renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.001, regionCamFar());

    this.pickRing = this.makeRing(0xf4e4c1, 0.18);
    this.hereRing = this.makeRing(0x7ec8e3, 0.22);
    this.scene.add(this.pickRing);
    this.scene.add(this.hereRing);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.attachSilhouette();

    this.setHere(hereStarId);
    this.openAtHere();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------- markers

  private makeRing(color: number, inner: number): THREE.Mesh {
    const g = new THREE.RingGeometry(inner, inner * 1.55, 48);
    const m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = Math.PI / 2;
    mesh.visible = false;
    return mesh;
  }

  /** Loaded system, if it is a catalog row. */
  here(): GalaxyObject | null {
    return this.hereObj;
  }

  setHere(id: number | null): void {
    this.hereObj = id != null ? objectAt(this.seed, id) : null;
    this.placeHighlights();
  }

  setVisited(ids: number[]): void {
    this.visitedIds = ids;
  }

  // ------------------------------------------------------------- region mode

  /** Catalog cartesian → camera frame (origin at the bubble centre). */
  private toView(x: number, y: number, z: number): { x: number; y: number; z: number } {
    if (this.mode !== 'region') return { x, y, z };
    return {
      x: x - this.arcCenter.x,
      y: y - this.arcCenter.y,
      z: z - this.arcCenter.z,
    };
  }

  private viewCart(obj: GalaxyObject): { x: number; y: number; z: number } {
    const c = galToCart(obj.pos);
    return this.toView(c.x, c.y, c.z);
  }

  /**
   * Park the viewpoint at a catalog point. The sky is the once-per-
   * load harvest — we do not remint a neighbourhood. `select` is
   * pinned when the dive is a star.
   */
  enterRegion(x: number, y: number, z: number, select: GalaxyObject | null = null): void {
    this.mode = 'region';
    this.arcCenter.set(x, y, z);
    this.mintAt.set(x, y, z);
    this.bindSky();
    this.regionLabel = regionName(x, y, z);
    this.objects = [];
    this.resetThrust();

    this.arcPos.set(0, 0, 0);
    const glen = Math.hypot(x, z);
    const ox = glen > 1e-4 ? x / glen : 1;
    const oz = glen > 1e-4 ? z / glen : 0;
    this.aimAt(ox, 0, oz);
    this.idle = 0;
    this.camera.near = 0.001;
    this.camera.far = regionCamFar();
    this.camera.updateProjectionMatrix();
    this.select(select);
    this.applyCam();
    this.updateSight(true);
  }

  private shownCount(): number {
    return (this.cloud?.n ?? 0) + (this.nebulae?.n ?? 0);
  }

  /** Attach stars / nebulae / dust if those caches are warm. */
  private bindSky(): void {
    const stars = silhouetteCloud(this.seed);
    const neb = nebulaCloud(this.seed);
    if (stars) {
      this.cloud = stars;
      if (!this.silPts) this.buildSilhouetteStars();
      else this.pushMagUniforms();
    }
    if (neb) {
      this.nebulae = neb;
      if (!this.silEmisPts) this.buildNebulae();
      else this.pushMagUniforms();
    }
    this.sectorPop = this.shownCount();
    this.lastEnterMs = Math.max(this.cloud?.ms ?? 0, this.nebulae?.ms ?? 0, this.lastEnterMs);
    if (!this.cosmicPts) this.buildCosmic();
    else this.pushMagUniforms();
  }

  private disposeStars(): void {
    if (this.silPts) {
      this.scene.remove(this.silPts);
      this.silGeo?.dispose();
      this.silMat?.dispose();
      this.silPts = null;
      this.silGeo = null;
      this.silMat = null;
      this.starVis = null;
    }
  }

  private disposeNebulae(): void {
    if (this.silEmisPts) {
      this.scene.remove(this.silEmisPts);
      this.silEmisGeo?.dispose();
      this.silEmisMat?.dispose();
      this.silEmisPts = null;
      this.silEmisGeo = null;
      this.silEmisMat = null;
      this.nebVis = null;
    }
  }

  private disposeCosmic(): void {
    if (this.cosmicPts) {
      this.scene.remove(this.cosmicPts);
      this.cosmicGeo?.dispose();
      this.cosmicMat?.dispose();
      this.cosmicPts = null;
      this.cosmicGeo = null;
      this.cosmicMat = null;
    }
    if (this.cosmicStarPts) {
      this.scene.remove(this.cosmicStarPts);
      this.cosmicStarGeo?.dispose();
      this.cosmicStarMat?.dispose();
      this.cosmicStarPts = null;
      this.cosmicStarGeo = null;
      this.cosmicStarMat = null;
    }
    if (this.cosmicSmudgePts) {
      this.scene.remove(this.cosmicSmudgePts);
      this.cosmicSmudgeGeo?.dispose();
      this.cosmicSmudgeMat?.dispose();
      this.cosmicSmudgePts = null;
      this.cosmicSmudgeGeo = null;
      this.cosmicSmudgeMat = null;
    }
  }

  private disposeSilhouette(): void {
    this.disposeStars();
    this.disposeNebulae();
    this.silDustTex?.dispose();
    this.silDustTex = null;
  }

  private disposeArcStars(): void {
    this.disposeSilhouette();
  }

  private shineUniforms(): Record<string, THREE.IUniform> {
    return {
      uLRef: { value: HARVEST_L_REF },
      uPsfCore: { value: HARVEST_PSF_CORE },
      uPsfTail: { value: HARVEST_PSF_TAIL },
      uPsfA: { value: HARVEST_PSF_A },
      uPsfB: { value: HARVEST_PSF_B },
      uPsfThresh: { value: HARVEST_PSF_THRESH },
      uShineLGain: { value: HARVEST_SHINE_GAIN },
      uShineLP: { value: HARVEST_SHINE_L_P },
      uShineDistRef: { value: HARVEST_SHINE_DIST_REF },
      uShineDistP: { value: HARVEST_SHINE_DIST_P },
      uShineSat: { value: HARVEST_SHINE_SAT },
      uSuperL: { value: HARVEST_SUPER_L },
      uSuperGain: { value: HARVEST_SUPER_GAIN },
      uSuperP: { value: HARVEST_SUPER_P },
      uPinCanvas: { value: HARVEST_PIN_CANVAS },
      uPinCore: { value: HARVEST_PIN_CORE },
      uFluxEps: { value: POINT_FLUX_EPS },
    };
  }

  /** The nebula-march knobs, shared by every material that compiles STAR_FRAG. */
  private dustUniforms(): Record<string, THREE.IUniform> {
    return {
      uCamRotInv: { value: new THREE.Matrix3() },
      uNebGain: { value: UNIVERSE.NEB_EMISSION },
      uDustSteps: { value: UNIVERSE.DUST_MARCH_STEPS },
      uDustMinPx: { value: UNIVERSE.DUST_MINPX },
      uDustFreq: { value: UNIVERSE.DUST_FREQ },
    };
  }

  /** Extinction knobs — the shared dust law (extinctGlsl) in both vertex shaders. */
  private extinctUniforms(): Record<string, THREE.IUniform> {
    const tex = this.ensureDustTexture();
    const vol = harvestDustVolume(this.seed);
    const origin = vol?.origin ?? [-1, -1, -1];
    const size = vol?.size ?? [2, 2, 2];
    return {
      uExtinctK: { value: UNIVERSE.GALAXY_EXTINCT_K },
      uExtinctMax: { value: UNIVERSE.GALAXY_EXTINCT_MAX },
      uExtinctCut: { value: UNIVERSE.GALAXY_EXTINCT_CUT },
      uExtinctHard: { value: UNIVERSE.GALAXY_EXTINCT_HARD },
      uExtinctWall: { value: UNIVERSE.GALAXY_EXTINCT_WALL },
      uDustDebug: { value: dustDebugOn() ? 1 : UNIVERSE.GALAXY_DUST_DEBUG },
      uDustRgb: { value: new THREE.Vector3(...UNIVERSE.GALAXY_DUST_RGB) },
      uDustVol: { value: tex },
      uDustOrigin: { value: new THREE.Vector3(origin[0], origin[1], origin[2]) },
      uDustInvSize: { value: new THREE.Vector3(1 / size[0], 1 / size[1], 1 / size[2]) },
    };
  }

  /** Upload the baked ISM fog. Empty 1³ if the harvest is not in yet. */
  private ensureDustTexture(): THREE.Data3DTexture {
    const vol = harvestDustVolume(this.seed);
    if (this.silDustTex) {
      if (vol && this.silDustTex.image.width <= 1 && vol.nx > 1) {
        this.silDustTex.dispose();
        this.silDustTex = null;
      } else {
        return this.silDustTex;
      }
    }
    const tex = vol
      ? new THREE.Data3DTexture(vol.data, vol.nx, vol.ny, vol.nz)
      : new THREE.Data3DTexture(new Float32Array(1), 1, 1, 1);
    tex.format = THREE.RedFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.silDustTex = tex;
    return tex;
  }

  /**
   * Two passes per layer, one shared fragment: stars add light
   * into the HDR photograph; emission nebulae SCREEN so shells
   * do not stack to a white bar among themselves. One Reinhard
   * knee after the composite is the accumulation cap. Dust has
   * no pass: both vertex shaders fold sightline extinction in.
   */
  private makeCloudMaterial(
    vertexShader: string,
    uniforms: Record<string, THREE.IUniform>,
    pass: number,
  ): THREE.ShaderMaterial {
    uniforms.uPass = { value: pass };
    const nebula = pass === 1;
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: STAR_FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: nebula ? THREE.CustomBlending : THREE.AdditiveBlending,
      blendSrc: nebula ? THREE.OneMinusDstColorFactor : THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    });
  }

  private silUniforms(): Record<string, THREE.IUniform> {
    return {
      uCenter: { value: new THREE.Vector3() },
      uScale: { value: 1 },
      uPixel: { value: this.renderer.getPixelRatio() },
      uPxPerRad: { value: this.pxPerRad() },
      uRegionR: { value: UNIVERSE.GALAXY_REGION_R },
      uNebulaPx: { value: UNIVERSE.SILHOUETTE_NEBULA_PX },
      ...this.shineUniforms(),
      ...this.dustUniforms(),
      ...this.extinctUniforms(),
      // Fewer, fuller: the backdrop keeps only showpieces, so its
      // shells get more exposure than the local layer would.
      uNebGain: { value: UNIVERSE.NEB_EMISSION * UNIVERSE.SILHOUETTE_NEB_BOOST },
    };
  }

  private buildSilhouetteStars(): void {
    const cloud = silhouetteCloud(this.seed);
    if (!cloud || cloud.n <= 0) return;
    this.disposeStars();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    const vis = cloud.gain.slice();
    const visAttr = new THREE.BufferAttribute(vis, 1);
    visAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVis', visAttr);
    this.starVis = visAttr;
    geo.setAttribute('aLum', new THREE.BufferAttribute(cloud.lum, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(cloud.kind, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.pulse, 1));
    geo.setDrawRange(0, cloud.n);
    const mat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 0);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -2;
    this.scene.add(pts);
    this.silPts = pts;
    this.silGeo = geo;
    this.silMat = mat;
    this.pushMagUniforms();
  }

  private buildNebulae(): void {
    const cloud = nebulaCloud(this.seed);
    if (!cloud || cloud.n <= 0) return;
    this.disposeNebulae();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    const vis = cloud.gain.slice();
    const visAttr = new THREE.BufferAttribute(vis, 1);
    visAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVis', visAttr);
    this.nebVis = visAttr;
    geo.setAttribute('aLum', new THREE.BufferAttribute(cloud.lum, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(cloud.kind, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.pulse, 1));
    geo.setDrawRange(0, cloud.n);
    const emisMat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 1);
    const emisPts = new THREE.Points(geo, emisMat);
    emisPts.frustumCulled = false;
    emisPts.renderOrder = -1;
    this.scene.add(emisPts);
    this.silEmisPts = emisPts;
    this.silEmisGeo = geo;
    this.silEmisMat = emisMat;
    this.pushMagUniforms();
  }

  private cloudMats(): THREE.ShaderMaterial[] {
    const out: THREE.ShaderMaterial[] = [];
    for (const m of [this.silMat, this.silEmisMat, this.cosmicMat, this.cosmicStarMat, this.cosmicSmudgeMat]) {
      if (m) out.push(m);
    }
    return out;
  }

  /** The void is the scene's clear colour — the zero level of the
   *  photograph. Pins and smudges add onto it; the dust filter
   *  multiplies all of it. */
  setVoidColor(hue: number, intensity: number): void {
    const rgb = cosmicVoidRgb(hue, intensity);
    this.voidClear.setRGB(rgb[0], rgb[1], rgb[2]);
    const u = this.cosmicMat?.uniforms.uVoidRgb;
    if (u) (u.value as THREE.Vector3).set(rgb[0], rgb[1], rgb[2]);
  }

  /** Dust filters; it never emits. The quad multiplies the frame
   *  (dst × T) — except the lime look-test, which paints opaque. */
  private applyFilterBlend(mat: THREE.ShaderMaterial): void {
    const debug = ((mat.uniforms.uDustDebug?.value as number) ?? 0) >= 0.5;
    if (debug) {
      mat.blending = THREE.NoBlending;
    } else {
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.DstColorFactor;
      mat.blendDst = THREE.ZeroFactor;
    }
  }

  private buildCosmic(): void {
    if (this.cosmicPts) return;
    const geo = new THREE.PlaneGeometry(2, 2);
    const voidRgb = cosmicVoidRgb(UNIVERSE.COSMIC_HUE, UNIVERSE.COSMIC_INT);
    this.voidClear.setRGB(voidRgb[0], voidRgb[1], voidRgb[2]);
    const mat = new THREE.ShaderMaterial({
      vertexShader: cosmicVert(),
      fragmentShader: dustFilterFrag(extinctGlsl(UNIVERSE.GALAXY_EXTINCT_STEPS), UNIVERSE.GALAXY_EXTINCT_STEPS),
      uniforms: {
        uVoidRgb: { value: new THREE.Vector3(voidRgb[0], voidRgb[1], voidRgb[2]) },
        uCenter: { value: new THREE.Vector3() },
        uCamRotInv: { value: new THREE.Matrix3() },
        uInvProj: { value: new THREE.Matrix4() },
        ...this.extinctUniforms(),
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.applyFilterBlend(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    // After the background sprites (−8 / −7), before everything
    // inside the galaxy: the filter only touches light from beyond.
    mesh.renderOrder = -6;
    this.scene.add(mesh);
    this.cosmicPts = mesh;
    this.cosmicGeo = geo;
    this.cosmicMat = mat;
    this.buildCosmicSmudges();
    this.buildCosmicStars();
    this.pushMagUniforms();
  }

  private cosmicCount(kind: 'star' | 'smudge'): number {
    if (kind === 'star') {
      return Math.max(0, Math.min(UNIVERSE.COSMIC_STAR_N_MAX, Math.round(UNIVERSE.COSMIC_STAR_N)));
    }
    return Math.max(0, Math.min(UNIVERSE.COSMIC_SMUDGE_N_MAX, Math.round(UNIVERSE.COSMIC_SMUDGE_N)));
  }

  private buildCosmicSmudges(): void {
    if (this.cosmicSmudgePts) return;
    const cloud = mintCosmicSmudges(this.seed, UNIVERSE.COSMIC_SMUDGE_N_MAX, UNIVERSE.COSMIC_CLUSTER);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    geo.setAttribute('aShine', new THREE.BufferAttribute(cloud.shine, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aAspect', new THREE.BufferAttribute(cloud.aspect, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(cloud.angle, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.seed, 1));
    geo.setAttribute('aCrisp', new THREE.BufferAttribute(cloud.crisp, 1));
    geo.setDrawRange(0, this.cosmicCount('smudge'));
    const mat = new THREE.ShaderMaterial({
      vertexShader: cosmicSmudgeVert(),
      fragmentShader: cosmicSmudgeFrag(),
      uniforms: {
        uCosmicGain: { value: UNIVERSE.COSMIC_GAIN },
        uCosmicSize: { value: UNIVERSE.COSMIC_SIZE },
        uPxPerRad: { value: this.pxPerRad() },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -7;
    this.scene.add(pts);
    this.cosmicSmudgePts = pts;
    this.cosmicSmudgeGeo = geo;
    this.cosmicSmudgeMat = mat;
  }

  private remintCosmicSmudges(): void {
    if (!this.cosmicSmudgeGeo) {
      this.buildCosmicSmudges();
      return;
    }
    const cloud = mintCosmicSmudges(this.seed, UNIVERSE.COSMIC_SMUDGE_N_MAX, UNIVERSE.COSMIC_CLUSTER);
    const geo = this.cosmicSmudgeGeo;
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    geo.setAttribute('aShine', new THREE.BufferAttribute(cloud.shine, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aAspect', new THREE.BufferAttribute(cloud.aspect, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(cloud.angle, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.seed, 1));
    geo.setAttribute('aCrisp', new THREE.BufferAttribute(cloud.crisp, 1));
    geo.setDrawRange(0, this.cosmicCount('smudge'));
  }

  private buildCosmicStars(): void {
    if (this.cosmicStarPts) return;
    const cloud = mintCosmicStars(this.seed, UNIVERSE.COSMIC_STAR_N_MAX);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    geo.setAttribute('aShine', new THREE.BufferAttribute(cloud.shine, 1));
    geo.setDrawRange(0, this.cosmicCount('star'));
    const mat = new THREE.ShaderMaterial({
      vertexShader: cosmicStarVert(),
      fragmentShader: cosmicStarFrag(),
      uniforms: {
        uStarGain: { value: UNIVERSE.COSMIC_STAR_GAIN },
        uPinCanvas: { value: COSMIC_STAR_PIN },
        uPinCore: { value: COSMIC_STAR_PIN_CORE },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -8;
    this.scene.add(pts);
    this.cosmicStarPts = pts;
    this.cosmicStarGeo = geo;
    this.cosmicStarMat = mat;
  }

  /** HDR target + blit. Layers add here; the knee is the last step. */
  private ensurePhoto(w: number, h: number): void {
    const rw = Math.max(1, Math.round(w));
    const rh = Math.max(1, Math.round(h));
    if (rw < 8 || rh < 8) return;
    if (this.photoRt && this.photoRt.width === rw && this.photoRt.height === rh) return;
    this.photoRt?.dispose();
    this.photoRt = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.photoRt.texture.colorSpace = THREE.NoColorSpace;
    if (!this.photoMat) {
      this.photoMat = new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uPhoto;
          uniform float uPhotoKnee;
          varying vec2 vUv;
          void main() {
            vec3 c = texture2D(uPhoto, vUv).rgb;
            float L = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
            c *= 1.0 / (1.0 + L / max(uPhotoKnee, 1e-4));
            gl_FragColor = vec4(c, 1.0);
          }
        `,
        uniforms: {
          uPhoto: { value: this.photoRt.texture },
          uPhotoKnee: { value: UNIVERSE.GALAXY_PHOTO_KNEE },
        },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.photoMat);
      quad.frustumCulled = false;
      this.photoScene.add(quad);
      this.photoQuad = quad;
    } else {
      this.photoMat.uniforms.uPhoto.value = this.photoRt.texture;
    }
  }

  private disposePhoto(): void {
    if (this.photoQuad) {
      this.photoScene.remove(this.photoQuad);
      this.photoQuad.geometry.dispose();
      this.photoQuad = null;
    }
    this.photoMat?.dispose();
    this.photoMat = null;
    this.photoRt?.dispose();
    this.photoRt = null;
  }

  /** Live cosmic-engineer write. One uniform, next frame. */
  setLiveUniform(name: string, value: number): void {
    if (name === 'uVoidRgb') {
      this.setVoidColor(UNIVERSE.COSMIC_HUE, value);
      return;
    }
    if (name === 'uStarN') {
      UNIVERSE.COSMIC_STAR_N = value;
      this.cosmicStarGeo?.setDrawRange(0, this.cosmicCount('star'));
      return;
    }
    if (name === 'uSmudgeN') {
      UNIVERSE.COSMIC_SMUDGE_N = value;
      this.cosmicSmudgeGeo?.setDrawRange(0, this.cosmicCount('smudge'));
      return;
    }
    if (name === 'uCosmicCluster') {
      for (const mat of this.cloudMats()) {
        const u = mat.uniforms[name];
        if (u) u.value = value;
      }
      this.remintCosmicSmudges();
      return;
    }
    if (name === 'uDustDebug') {
      value = value >= 0.5 ? 1 : 0;
      const u = this.cosmicMat?.uniforms.uDustDebug;
      if (u) u.value = value;
      if (this.cosmicMat) this.applyFilterBlend(this.cosmicMat);
    }
    if (name === 'uPhotoKnee') {
      UNIVERSE.GALAXY_PHOTO_KNEE = value;
      if (this.photoMat?.uniforms.uPhotoKnee) this.photoMat.uniforms.uPhotoKnee.value = value;
      return;
    }
    for (const mat of this.cloudMats()) {
      const u = mat.uniforms[name];
      if (u) u.value = value;
    }
  }

  liveUniform(name: string): number | null {
    if (name === 'uStarN') return this.cosmicCount('star');
    if (name === 'uSmudgeN') return this.cosmicCount('smudge');
    const u =
      this.silMat?.uniforms[name] ??
      this.silEmisMat?.uniforms[name] ??
      this.cosmicMat?.uniforms[name] ??
      this.cosmicStarMat?.uniforms[name] ??
      this.cosmicSmudgeMat?.uniforms[name] ??
      this.photoMat?.uniforms[name];
    return typeof u?.value === 'number' ? u.value : null;
  }

  /** After a star remint — drop the star mesh only. Nebulae and fog stay. */
  replaceSky(): void {
    this.disposeStars();
    const cloud = silhouetteCloud(this.seed);
    this.cloud = cloud;
    this.sectorPop = this.shownCount();
    this.lastEnterMs = cloud?.ms ?? this.lastEnterMs;
    this.buildSilhouetteStars();
    this.applyStarVis();
    if (this.mode === 'region') this.updateSight(true);
  }

  /** After a nebula rebake — drop the nebula mesh only. Stars and fog stay. */
  replaceNebulae(): void {
    this.disposeNebulae();
    const neb = nebulaCloud(this.seed);
    this.nebulae = neb;
    this.sectorPop = this.shownCount();
    this.lastEnterMs = neb?.ms ?? this.lastEnterMs;
    this.buildNebulae();
    this.applyNebVis();
    if (this.mode === 'region') this.updateSight(true);
  }

  /** After a dust rebake — swap the 3D texture on the existing sky. */
  replaceDust(): void {
    this.silDustTex?.dispose();
    this.silDustTex = null;
    const tex = this.ensureDustTexture();
    const vol = harvestDustVolume(this.seed);
    const origin = vol?.origin ?? [-1, -1, -1];
    const size = vol?.size ?? [2, 2, 2];
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uDustVol) mat.uniforms.uDustVol.value = tex;
      if (mat.uniforms.uDustOrigin) {
        (mat.uniforms.uDustOrigin.value as THREE.Vector3).set(origin[0], origin[1], origin[2]);
      }
      if (mat.uniforms.uDustInvSize) {
        (mat.uniforms.uDustInvSize.value as THREE.Vector3).set(1 / size[0], 1 / size[1], 1 / size[2]);
      }
    }
  }

  /** Catalog positions stay on the GPU; only the bubble centre moves. */
  private pushMagUniforms(): void {
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uCenter) mat.uniforms.uCenter.value.set(cx, cy, cz);
      if (mat.uniforms.uScale) mat.uniforms.uScale.value = 1;
    }
  }


  // --------------------------------------------------------------- state

  setFilter(f: GalaxyFilter): void {
    this.filter = f;
    this.applyStarVis();
    this.applyNebVis();
    if (this.mode === 'region') this.updateSight(true);
  }

  dismiss(): void {
    this.select(null);
  }

  canPick(): boolean {
    return this.mode === 'region';
  }

  currentMode(): GalaxyMode {
    return this.mode;
  }

  currentRegion(): RegionSelection | null {
    if (!this.regionLabel) return null;
    return {
      name: this.regionLabel,
      population: this.sectorPop,
      x: this.arcCenter.x,
      y: this.arcCenter.y,
      z: this.arcCenter.z,
    };
  }

  selectedObject(): GalaxyObject | null {
    return this.selected;
  }

  beaconCount(): number {
    const n = this.shownCount();
    return n > 0 ? n : this.objects.length;
  }

  /** The arc's loaded survey — every row is a tappable catalog id. */
  surveyStars(): GalaxyObject[] {
    return this.objects;
  }

  /** Local catalog stars close enough to lock the reticle. Smoke / HUD. */
  grownStars(): number {
    return this.grownCount;
  }

  /** True when the luminous harvest is on the GPU. */
  cloudFitsRegion(): boolean {
    return Boolean(this.cloud && this.cloud.n > 0 && this.silPts);
  }

  /**
   * Open the region on the loaded star (else home) and park it
   * just ahead of the centre reticle. That pose is the Back bookmark.
   */
  openAtHere(): void {
    const obj = this.hereObj ?? this.home;
    if (!obj) {
      this.goOverview('face');
      return;
    }
    this.focus(obj);
    this.approachNearest();
    this.pinBack();
  }

  setPreset(p: GalaxyPreset): void {
    if (p === 'home') {
      const obj = this.hereObj ?? this.home;
      if (!obj) return;
      this.focus(obj);
      this.approachNearest();
      this.pinBack();
      return;
    }
    if (p === 'back') {
      this.restoreBack();
      return;
    }
    this.goOverview(p);
  }

  private snapshotPose(): BubblePose {
    return {
      x: this.arcCenter.x,
      y: this.arcCenter.y,
      z: this.arcCenter.z,
      yaw: this.arcYaw,
      pitch: this.arcPitch,
    };
  }

  /** Remember the current pose unless we are already in an overview. */
  private rememberBack(): void {
    if (this.overview) return;
    this.backPose = this.snapshotPose();
  }

  /** Home (and first look) pin Back to this pose. */
  private pinBack(): void {
    this.overview = false;
    this.backPose = this.snapshotPose();
  }

  /**
   * Sit so the disk diameter fills the screen. Edge-on uses the
   * width (a needle); face-on uses the shorter axis (a circle).
   */
  private overviewDistance(kind: 'face' | 'edge'): number {
    return overviewDistanceKpc(
      UNIVERSE.GALAXY_R_MAX,
      overviewHalfAngle(this.camera.fov, this.camera.aspect, kind),
    );
  }

  private goOverview(kind: 'face' | 'edge'): void {
    this.rememberBack();
    this.overview = true;
    const d = this.overviewDistance(kind);
    if (kind === 'face') {
      this.enterRegion(0, d, 0, null);
      this.aimAt(0, -1, 0);
    } else {
      // In the plane. A lift put the camera above the dust sheet,
      // so the lane became a floor and the top stayed puffy.
      this.enterRegion(d, 0, 0, null);
      this.aimAt(-1, 0, 0);
    }
    this.applyCam();
    this.updateSight(true);
  }

  private restoreBack(): void {
    const p = this.backPose;
    if (!p) {
      this.openAtHere();
      return;
    }
    this.overview = false;
    this.enterRegion(p.x, p.y, p.z, null);
    this.arcYaw = p.yaw;
    this.arcPitch = p.pitch;
    this.applyCam();
    this.updateSight(true);
  }

  /** Open the region around a star and select it. */
  focus(obj: GalaxyObject): void {
    const c = galToCart(obj.pos);
    this.enterRegion(c.x, c.y, c.z, obj);
  }

  /**
   * Slide the bubble so a pinned star sits just ahead of the camera
   * (still at the centre). Smoke / tests.
   */
  approachNearest(): GalaxyObject | null {
    const best = this.selected ?? this.hereObj ?? this.home;
    if (!best) return null;
    if (this.mode !== 'region') this.focus(best);
    const cat = galToCart(best.pos);
    this.orientArc();
    const off = FOCUS_PARK;
    this.arcCenter.set(
      cat.x - this.arcFwd.x * off,
      cat.y - this.arcFwd.y * off,
      cat.z - this.arcFwd.z * off,
    );
    this.mintAt.copy(this.arcCenter);
    this.pushMagUniforms();
    this.placeHighlights();
    const v = this.viewCart(best);
    this.aimAt(v.x, v.y, v.z);
    this.applyCam();
    this.updateSight(true);
    return best;
  }

  focusedObject(): GalaxyObject | null {
    return this.focusObj;
  }

  /** Refresh sight uniforms — smoke / tests. */
  syncArc(): void {
    if (this.mode === 'region') this.updateSight(true);
  }

  /** Harvest glow size (device px). f(L), not 1/d — smoke proves approach does not inflate it. */
  pointApparent(id: number): number {
    const cloud = this.cloud;
    const px = this.renderer.getPixelRatio();
    if (!cloud) return 0;
    for (let i = 0; i < cloud.n; i++) {
      if (cloud.ids[i] === id) return harvestGlowPx(cloud.lum[i], px);
    }
    const o = objectAt(this.seed, id);
    return o ? harvestGlowPx(o.star.luminosity, px) : 0;
  }

  /**
   * An on-screen cloud star — smoke proves the full field is tappable.
   */
  probePointStar(): { id: number; x: number; y: number } | null {
    const cloud = this.cloud;
    if (!cloud) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const step = Math.max(1, Math.floor(cloud.n / 4000));
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    const cat = cloud.pos;
    for (let i = 0; i < cloud.n; i += step) {
      if (!sketchMatches(cloud.bits[i], this.filter)) continue;
      const i3 = i * 3;
      const x = cat[i3] - cx;
      const y = cat[i3 + 1] - cy;
      const z = cat[i3 + 2] - cz;
      const mx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const my = e[1] * x + e[5] * y + e[9] * z + e[13];
      const mz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const mw = e[3] * x + e[7] * y + e[11] * z + e[15];
      const cw = p[3] * mx + p[7] * my + p[11] * mz + p[15] * mw;
      if (cw <= 1e-6) continue;
      const nx = (p[0] * mx + p[4] * my + p[8] * mz + p[12] * mw) / cw;
      const ny = (p[1] * mx + p[5] * my + p[9] * mz + p[13] * mw) / cw;
      if (nx * nx + ny * ny > 0.55) continue;
      const sx = rect.left + (nx * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-ny * 0.5 + 0.5) * rect.height;
      if (sx < 280 || sx > 1000 || sy < 120 || sy > 520) continue;
      return { id: cloud.ids[i], x: sx, y: sy };
    }
    return null;
  }

  /**
   * Rotate the look in place. Smoke uses this to prove free look.
   */
  orbitBy(dTheta: number, dPhi = 0): void {
    if (this.mode === 'region') {
      this.arcYaw += dTheta;
      this.arcPitch = THREE.MathUtils.clamp(this.arcPitch - dPhi, -1.45, 1.45);
      this.applyCam();
      this.idle = 0;
      return;
    }
    this.tgtTheta += dTheta;
    this.tgtPhi = THREE.MathUtils.clamp(this.tgtPhi + dPhi, 0.08, 1.45);
    this.idle = 0;
  }

  /** Slide the bubble along the look. Smoke / WASD. */
  flyAlong(kpc: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    this.moveBubble(this.arcFwd.x * kpc, this.arcFwd.y * kpc, this.arcFwd.z * kpc);
    this.applyCam();
  }

  /** Slide the bubble along camera right. */
  flyStrafe(kpc: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    this.moveBubble(this.arcRight.x * kpc, this.arcRight.y * kpc, this.arcRight.z * kpc);
    this.applyCam();
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.ensurePhoto(w * pr, h * pr);
  }

  /** Pause the loop while the explorer is hidden so the planet can run. */
  setActive(on: boolean): void {
    if (this.disposed || on === this.active) return;
    this.active = on;
    if (on) {
      this.lastT = performance.now();
      if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setWarp(false);
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.disposeArcStars();
    this.disposeCosmic();
    this.disposePhoto();
    this.pickRing.geometry.dispose();
    (this.pickRing.material as THREE.Material).dispose();
    this.hereRing.geometry.dispose();
    (this.hereRing.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private resetThrust(): void {
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }

  private bubbleR(): number {
    return Math.hypot(this.arcCenter.x, this.arcCenter.y, this.arcCenter.z);
  }

  /** Warp may run inside the fence, or past it only while flying inward. */
  private warpMayRun(): boolean {
    const r = this.bubbleR();
    const lim = UNIVERSE.GALAXY_WARP_LIM;
    if (r < lim) return true;
    this.orientArc();
    if (r < 1e-6) return true;
    return this.arcFwd.dot(this.arcCenter) < 0;
  }

  /** Latch warp on (fixed cruise) or off (stop). A tap, not a hold. */
  setWarp(on: boolean): void {
    if (this.mode !== 'region') return;
    this.thrustOn = on && this.warpMayRun();
    this.idle = 0;
  }

  warping(): boolean {
    return this.thrustOn;
  }

  private select(obj: GalaxyObject | null): void {
    this.selected = obj;
    this.placeHighlights();
    this.callbacks.onSelect(obj);
  }

  // ------------------------------------------------------------- camera

  private aimAt(x: number, y: number, z: number): void {
    const dx = x;
    const dy = y;
    const dz = z;
    const len = Math.max(1e-8, Math.hypot(dx, dy, dz));
    this.arcPitch = Math.asin(THREE.MathUtils.clamp(dy / len, -1, 1));
    this.arcYaw = Math.atan2(dx, dz);
  }

  private orientArc(): void {
    const cp = Math.cos(this.arcPitch);
    this.arcFwd.set(cp * Math.sin(this.arcYaw), Math.sin(this.arcPitch), cp * Math.cos(this.arcYaw));
    this.arcRight.crossVectors(this.arcFwd, this.worldUp);
    if (this.arcRight.lengthSq() < 1e-10) this.arcRight.set(1, 0, 0);
    else this.arcRight.normalize();
    this.arcUp.crossVectors(this.arcRight, this.arcFwd).normalize();
  }

  private pxPerRad(): number {
    const h = this.canvas.clientHeight || 800;
    const fov = (this.camera.fov * Math.PI) / 180;
    return (0.5 * h * this.renderer.getPixelRatio()) / Math.tan(fov * 0.5);
  }

  private applyCam(): void {
    this.orientArc();
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(this.arcUp);
    this.arcLook.copy(this.arcFwd);
    this.camera.lookAt(this.arcLook);
    this.theta = this.arcYaw;
    this.phi = Math.PI / 2 - this.arcPitch;
    this.pushMagUniforms();
  }

  /**
   * Cruise speed. Cap is small and fixed so extra space between
   * stars is felt as more zoom, not a faster ship. Slow further
   * only when a star is already close (examine, don't overshoot).
   */
  private arcPace(): number {
    const cloud = this.cloud;
    let minD = 8;
    if (cloud) {
      const step = Math.max(1, Math.floor(cloud.n / 6000));
      const cx = this.arcCenter.x;
      const cy = this.arcCenter.y;
      const cz = this.arcCenter.z;
      const cat = cloud.pos;
      for (let i = 0; i < cloud.n; i += step) {
        const i3 = i * 3;
        const d = Math.hypot(cat[i3] - cx, cat[i3 + 1] - cy, cat[i3 + 2] - cz);
        if (d > 1e-4 && d < minD) minD = d;
      }
    }
    if (this.selected) {
      const c = this.viewCart(this.selected);
      const d = Math.hypot(c.x, c.y, c.z);
      if (d > 1e-4) minD = Math.min(minD, d);
    }
    return THREE.MathUtils.clamp(0.42 * minD, 0.004, 0.025);
  }

  /**
   * Gestures are catalog kpc. The camera stays at the origin; the
   * viewpoint slides. The GPU holds the harvest — the vertex shader
   * subtracts uCenter. No membership walk.
   */
  private moveBubble(vx: number, vy: number, vz: number, _force = false): void {
    if (this.mode !== 'region') return;
    this.arcCenter.x += vx;
    this.arcCenter.y += vy;
    this.arcCenter.z += vz;
    this.mintAt.copy(this.arcCenter);
    this.regionLabel = regionName(this.arcCenter.x, this.arcCenter.y, this.arcCenter.z);
    this.pushMagUniforms();
    this.placeHighlights();
  }

  /** Harvest is minted once at app boot; wait for stars + nebulae + dust. */
  private attachSilhouette(): void {
    void prepareUniverse(this.seed).then(() => {
      if (this.disposed) return;
      this.bindSky();
    });
  }

  /** Here and the current pick sit in camera space as focus rings. */
  private placeHighlights(): void {
    const here = this.hereObj ?? this.home;
    if (here) {
      const c = this.viewCart(here);
      this.hereRing.position.set(c.x, c.y, c.z);
      this.hereRing.visible = true;
    } else {
      this.hereRing.visible = false;
    }
    if (this.selected) {
      const c = this.viewCart(this.selected);
      this.pickRing.position.set(c.x, c.y, c.z);
      this.pickRing.visible = true;
    } else {
      this.pickRing.visible = false;
    }
  }

  /**
   * Pinch / wheel slides the ball along the look (the camera stays
   * at the centre; the bubble moves).
   */
  private zoom(factor: number): void {
    this.idle = 0;
    this.orientArc();
    const dir = factor < 1 ? 1 : -1;
    const step = this.arcPace() * 14 * Math.abs(Math.log(Math.max(1e-3, factor))) * dir;
    this.moveBubble(this.arcFwd.x * step, this.arcFwd.y * step, this.arcFwd.z * step);
    this.applyCam();
  }

  // ------------------------------------------------------------- picking

  /** Client-pixel position of a catalog object, or null if off-screen. */
  projectClient(obj: GalaxyObject): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const c = this.viewCart(obj);
    const v = new THREE.Vector3(c.x, c.y, c.z).project(this.camera);
    if (v.z < -1.2 || v.z > 1.2) return null;
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  private setRay(cx: number, cy: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((cx - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((cy - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private pick(cx: number, cy: number): void {
    this.setRay(cx, cy);
    const picked = this.pickCloud(cx, cy);
    if (picked) this.select(picked);
  }

  /** Here and visited samples — always pickable, even if faint. */
  private pickPoi(cx: number, cy: number): GalaxyObject | null {
    const pois: GalaxyObject[] = [];
    const here = this.hereObj ?? this.home;
    if (here) pois.push(here);
    for (const id of this.visitedIds) {
      if (here && id === here.id) continue;
      const o = objectAt(this.seed, id);
      if (o) pois.push(o);
    }
    let best: GalaxyObject | null = null;
    let bestD = 28;
    for (const o of pois) {
      const p = this.projectClient(o);
      if (!p) continue;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  private pickCloud(cx: number, cy: number): GalaxyObject | null {
    const poi = this.pickPoi(cx, cy);
    if (poi) return poi;
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const rect = this.canvas.getBoundingClientRect();
    const ox = this.arcCenter.x;
    const oy = this.arcCenter.y;
    const oz = this.arcCenter.z;
    const pxPer = this.pxPerRad() / Math.max(1, this.renderer.getPixelRatio());
    let bestId = -1;
    let bestD = Infinity;
    for (const cloud of [this.cloud, this.nebulae]) {
      if (!cloud) continue;
      const cat = cloud.pos;
      const bits = cloud.bits;
      const ids = cloud.ids;
      const lum = cloud.lum;
      for (let i = 0; i < cloud.n; i++) {
        if (!sketchMatches(bits[i], this.filter)) continue;
        const i3 = i * 3;
        const x = cat[i3] - ox;
        const y = cat[i3 + 1] - oy;
        const z = cat[i3 + 2] - oz;
        const mx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const my = e[1] * x + e[5] * y + e[9] * z + e[13];
        const mz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const mw = e[3] * x + e[7] * y + e[11] * z + e[15];
        const cw = p[3] * mx + p[7] * my + p[11] * mz + p[15] * mw;
        if (cw <= 1e-6) continue;
        const nx = (p[0] * mx + p[4] * my + p[8] * mz + p[12] * mw) / cw;
        const ny = (p[1] * mx + p[5] * my + p[9] * mz + p[13] * mw) / cw;
        if (nx < -1.15 || nx > 1.15 || ny < -1.15 || ny > 1.15) continue;
        const sx = rect.left + (nx * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-ny * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - cx, sy - cy);
        const viewD = Math.max(1e-4, Math.hypot(mx, my, mz));
        const dim = (bits[i] & BIT_REMNANT) !== 0 || lum[i] < 0.05;
        const hitR = Math.max(22, 0.55 * 2 * glowRadiusKpc(lum[i], dim) * pxPer / viewD);
        if (d <= hitR && d < bestD) {
          bestD = d;
          bestId = ids[i];
        }
      }
    }
    if (bestId < 0) return null;
    return objectAt(this.seed, bestId);
  }

  // ------------------------------------------------------------- input

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events may carry an unknown pointerId; capture is optional.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.panBtn = e.button;
    if (this.pointers.size === 1) {
      // A fresh single-finger touch is the ONLY way back into rotation
      // after a pinch (see onUp).
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved = 0;
      this.idle = 0;
    } else if (this.pointers.size === 2) {
      this.dragging = false;
      const pts = [...this.pointers.values()];
      this.pinch0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.pinch0 > 0) {
        const ratio = d / Math.max(1e-3, this.pinch0);
        this.zoom(Math.pow(1 / Math.max(0.2, ratio), ZOOM_PINCH_POW));
      }
      this.pinch0 = d;
      this.moved += 4;
      this.idle = 0;
      return;
    }
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved += Math.hypot(dx, dy);
    this.idle = 0;
    const strafe = this.mode === 'region' && (this.panBtn === 1 || this.panBtn === 2 || e.shiftKey);
    if (strafe) {
      this.strafePixels(dx, dy);
      return;
    }
    if (this.mode === 'region') {
      this.arcYaw -= dx * 0.005;
      this.arcPitch = THREE.MathUtils.clamp(this.arcPitch - dy * 0.005, -1.45, 1.45);
      this.applyCam();
      return;
    }
    this.tgtTheta -= dx * 0.005;
    this.tgtPhi = Math.max(0.08, Math.min(1.52, this.tgtPhi - dy * 0.005));
    this.theta = this.tgtTheta;
    this.phi = this.tgtPhi;
  };

  private strafePixels(dx: number, dy: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    const dist = Math.max(0.02, this.arcPace() * 8);
    const worldH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5);
    const wpp = worldH / Math.max(1, this.canvas.clientHeight);
    this.moveBubble(this.arcRight.x * -dx * wpp + this.arcUp.x * dy * wpp, this.arcRight.y * -dx * wpp + this.arcUp.y * dy * wpp, this.arcRight.z * -dx * wpp + this.arcUp.z * dy * wpp);
    this.applyCam();
  }

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch0 = 0;
    if (this.pointers.size === 0) {
      if (this.dragging && this.moved < 22) this.pick(e.clientX, e.clientY);
      this.dragging = false;
    } else {
      // One pinch finger lifted: the survivor is NOT a drag. Rotation
      // resumes only with a fresh single-finger touch.
      this.dragging = false;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * ZOOM_WHEEL_SENS));
    this.idle = 0;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (this.mode === 'region' && !e.repeat) {
      if (e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        this.setWarp(true);
        return;
      }
      if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        e.preventDefault();
        this.setWarp(false);
        return;
      }
    }
    const fly =
      e.code === 'KeyA' ||
      e.code === 'KeyD' ||
      e.code === 'KeyQ' ||
      e.code === 'KeyE' ||
      e.code === 'Space' ||
      e.code === 'KeyC' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight';
    if (fly && this.mode === 'region') e.preventDefault();
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  /** Latched warp: ↑ / Warp is a fixed catalog rate; ↓ / Stop is stop. */
  private cruise(dt: number): void {
    if (this.mode !== 'region') {
      this.thrustOn = false;
      this.thrustSpeed = 0;
      return;
    }
    if (this.thrustOn && !this.warpMayRun()) this.thrustOn = false;
    this.thrustSpeed = this.thrustOn ? UNIVERSE.GALAXY_WARP : 0;
    if (this.thrustSpeed <= 0) return;
    this.orientArc();
    const step = this.thrustSpeed * dt;
    this.moveBubble(this.arcFwd.x * step, this.arcFwd.y * step, this.arcFwd.z * step);
  }

  private steerArc(dt: number): void {
    let mx = 0;
    let my = 0;
    let mz = 0;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1;
    if (this.keys.has('KeyQ') || this.keys.has('KeyC')) my -= 1;
    if (mx === 0 && my === 0 && mz === 0) return;
    this.orientArc();
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
    const pace = this.arcPace() * boost;
    this.moveBubble(
      (this.arcRight.x * mx + this.arcUp.x * my + this.arcFwd.x * mz) * pace * dt,
      (this.arcRight.y * mx + this.arcUp.y * my + this.arcFwd.y * mz) * pace * dt,
      (this.arcRight.z * mx + this.arcUp.z * my + this.arcFwd.z * mz) * pace * dt,
    );
    this.idle = 0;
  }

  // --------------------------------------------------------------- sight

  /**
   * Filter the local catalog cloud and lock the centre reticle onto
   * a visitable star. Silhouette backdrop rows are not in this cloud.
   */
  private updateSight(force = false): void {
    if (this.mode !== 'region') return;
    const now = performance.now();
    if (!force && now - this.lastSightAt < 50) return;
    this.lastSightAt = now;
    this.aimReticle();
  }

  /**
   * Centre reticle vs local catalog points. Lock uses the visit body
   * (aimRadiusKpc), not the 1px paint pin — a star that flies through
   * the pip is real and set-course-able even while it is still a point.
   * Dust is an ISM address; the magnitude-limited backdrop is not here.
   */
  private aimReticle(): void {
    if (this.mode !== 'region') {
      this.focusObj = null;
      this.focusHud = null;
      this.grownCount = 0;
      return;
    }
    if (!this.cloud && !this.nebulae) {
      this.focusObj = null;
      this.focusHud = null;
      this.grownCount = 0;
      return;
    }
    this.orientArc();
    const lx = this.arcFwd.x;
    const ly = this.arcFwd.y;
    const lz = this.arcFwd.z;
    const cx = 0;
    const cy = 0;
    const cz = 0;
    const cosCone = Math.cos(0.028);
    const ox = this.arcCenter.x;
    const oy = this.arcCenter.y;
    const oz = this.arcCenter.z;
    let grown = 0;
    let bestId = -1;
    let bestOff = 1;
    let bestDist = 0;
    let bestDim = false;
    for (const cloud of [this.cloud, this.nebulae]) {
      if (!cloud) continue;
      const cat = cloud.pos;
      const lum = cloud.lum;
      const bits = cloud.bits;
      const ids = cloud.ids;
      for (let i = 0; i < cloud.n; i++) {
        if (!sketchMatches(bits[i], this.filter)) continue;
        const i3 = i * 3;
        const dx = cat[i3] - ox - cx;
        const dy = cat[i3 + 1] - oy - cy;
        const dz = cat[i3 + 2] - oz - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-12) continue;
        const dist = Math.sqrt(d2);
        const dim = (bits[i] & BIT_REMNANT) !== 0 || lum[i] < 0.05;
        if (!aimLocks(lum[i], dist, dim)) continue;
        grown++;
        const inv = 1 / dist;
        const dot = dx * inv * lx + dy * inv * ly + dz * inv * lz;
        if (dot < cosCone) continue;
        const off = 1 - dot;
        if (off < bestOff) {
          bestOff = off;
          bestId = ids[i];
          bestDist = dist;
          bestDim = dim;
        }
      }
    }
    this.grownCount = grown;
    if (bestId < 0) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    if (this.focusObj?.id === bestId && this.focusHud) {
      this.focusHud.dist = bestDist;
      this.focusHud.dark = bestDim;
      return;
    }
    const hit = objectAt(this.seed, bestId);
    if (!hit) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    this.focusObj = hit;
    const brief = this.briefFor(hit);
    const st = hit.star;
    this.focusHud = {
      id: hit.id,
      name: brief.name,
      cls: classifyStar(st),
      phase: st.phase.replace(/_/g, ' '),
      planets: brief.planets,
      moons: brief.moons,
      life: brief.life,
      dark: bestDim,
      x: 0.5,
      y: 0.5,
      dist: bestDist,
    };
  }

  private briefFor(obj: GalaxyObject): { name: string; planets: number; moons: number; life: boolean } {
    const hit = this.briefMemo.get(obj.id);
    if (hit) return hit;
    if (this.briefMemo.size > 48) this.briefMemo.clear();
    try {
      const spec = systemAt(this.seed, obj.id);
      let planets = 0;
      let moons = 0;
      let life = false;
      for (const b of spec.bodies) {
        if (b.parent) moons++;
        else planets++;
        if (b.physics.life) life = true;
      }
      const row = { name: spec.star.name, planets, moons, life };
      this.briefMemo.set(obj.id, row);
      return row;
    } catch {
      const row = { name: classifyStar(obj.star), planets: 0, moons: 0, life: false };
      this.briefMemo.set(obj.id, row);
      return row;
    }
  }

  /** Filter dims non-matching points; every star stays a point. */
  private applyStarVis(): void {
    if (!this.starVis || !this.cloud) return;
    const arr = this.starVis.array as Float32Array;
    const { bits, n } = this.cloud;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      arr[i] = sketchMatches(bits[i], this.filter) ? 1 : 0.08;
    }
    this.starVis.needsUpdate = true;
  }

  /** Filter dims non-matching shells; gain stays the emission measure. */
  private applyNebVis(): void {
    if (!this.nebVis || !this.nebulae) return;
    const arr = this.nebVis.array as Float32Array;
    const { bits, gain, n } = this.nebulae;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      arr[i] = sketchMatches(bits[i], this.filter) ? gain[i] : gain[i] * 0.08;
    }
    this.nebVis.needsUpdate = true;
  }

  // --------------------------------------------------------------- frame

  private frame = (): void => {
    if (this.disposed || !this.active) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.idle += dt;
    this.cruise(dt);
    this.steerArc(dt);
    this.applyCam();
    this.updateSight();
    this.aimReticle();

    const t = now * 0.001;
    const px = this.renderer.getPixelRatio();
    const pxPer = this.pxPerRad();
    // View→catalog rotation so the cloud march samples a camera-stable field.
    this.camera.updateMatrixWorld();
    this.camRot3.setFromMatrix4(this.camera.matrixWorld);
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uPixel) mat.uniforms.uPixel.value = px;
      if (mat.uniforms.uPxPerRad) mat.uniforms.uPxPerRad.value = pxPer;
      if (mat.uniforms.uCamRotInv) {
        (mat.uniforms.uCamRotInv.value as THREE.Matrix3).copy(this.camRot3);
      }
      if (mat.uniforms.uInvProj) {
        (mat.uniforms.uInvProj.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
      }
    }

    const cam = this.camera.position;
    const ringFor = (mesh: THREE.Mesh, lo: number, hi: number, k: number) => {
      const d = cam.distanceTo(mesh.position);
      mesh.scale.setScalar(Math.max(lo, Math.min(hi, d * k)));
    };
    ringFor(this.pickRing, 0.00035, 0.03, 0.045);
    ringFor(this.hereRing, 0.0005, 0.045, 0.06);
    this.pickRing.rotation.z = t * 0.35;
    this.hereRing.rotation.z = t * -0.22;

    const pr = this.renderer.getPixelRatio();
    const el = this.renderer.domElement;
    const rw = el.width || el.clientWidth * pr;
    const rh = el.height || el.clientHeight * pr;
    this.ensurePhoto(rw, rh);
    // One scene, one pass: the void is the clear colour, background
    // sprites add onto it, the dust filter quad multiplies all of
    // it per pixel, then the galaxy draws in front. The knee is last.
    if (this.photoRt) {
      this.renderer.setRenderTarget(this.photoRt);
      this.renderer.setClearColor(this.voidClear, 1);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.photoScene, this.photoCam);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(this.voidClear, 1);
      this.renderer.render(this.scene, this.camera);
    }
    this.callbacks.onFrame?.({
      mode: this.mode,
      theta: this.theta,
      phi: this.phi,
      radius: Math.hypot(this.arcCenter.x, this.arcCenter.z),
      pickable: true,
      resolved: this.shownCount(),
      grown: this.grownCount,
      sector: this.regionLabel,
      population: this.sectorPop,
      focus: this.focusHud,
      warp: this.thrustOn,
      backdrop: this.shownCount(),
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}
