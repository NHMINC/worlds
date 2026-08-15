/**
 * The galaxy explorer: a saucer chart plus a regional dive.
 *
 * MAP mode shows the saucer — a static mesh coloured by the density
 * law (galaxySectors.ts) — plus markers for home, the current system,
 * visited systems, and ~100 deterministic systems of interest. No
 * stars are drawn on the map. The map camera orbits the origin.
 *
 * REGION mode is a magnification sphere in catalog space. The
 * camera sits at the centre — it does not fly around inside the
 * ball. Look-drag slides the heading. Warp (↑ / Warp button) latches
 * acceleration; ↓ / Stop brakes at the same rate. The vertex shader
 * follows the centre; a worker mints and drops the rim. Space is
 * magnified (VIEW_R / REGION_R); star size is not. Distant stars
 * are 1px pinpricks; closer ones grow. Behind the ball a
 * magnitude-limited backdrop (stars, typed nebulae, dusty cell
 * centres) sketches the rest of the disk. Same shape law as the
 * local sample; magnifier places them. The breadcrumb returns to
 * the map.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, homeStar, objectAt, type GalaxyObject } from '../world/galaxy';
import { createSectorMap, type SectorMap } from './galaxySectors';
import {
  AIM_MIN_ANG,
  GLOW_DIM,
  GLOW_K,
  GLOW_P,
  POINT_FLUX_EPS,
  POINT_MAX_PX,
  POINT_NEAR_BOOST,
  glowRadiusKpc,
} from './galaxyStar';
import { classifyStar } from '../world/stellar';
import { systemAt } from '../world/systemgen';
import {
  systemsOfInterest,
  buildRegionCloud,
  buildSilhouetteCloud,
  installSilhouetteCloud,
  silhouetteCloud,
  advanceRegionCloud,
  regionName,
  sketchMatches,
  MK_LETTER,
  BIT_REMNANT,
  BIT_DUST,
  KIND_DUST,
  type StarCloud,
} from '../world/sectors';
import { SHAPE_GLSL } from '../world/skyShape';

/** Map-orbit radius range (kpc). */
const MAP_R_MIN = 9;
const MAP_R_MAX = 46;
const MAP_R_HOME = 34;
/** Slide the catalog centre after it has moved this far (catalog kpc). */
const MAG_SLIDE = 0.01;
/** A jump bigger than this remints instead of walking the rim. */
const MAG_REBUILD = 0.45;
/** Latched warp in the magnified frame (view kpc / s). Accel = brake. */
const THRUST_MAX = 0.36;
const THRUST_RATE = 0.42;
/** Zoom is direct and gentle; one motion crosses at most this factor. */
const ZOOM_WHEEL_SENS = 0.0008;
const ZOOM_PINCH_POW = 0.7;
const ZOOM_GESTURE_SPAN = 2.6;

export type GalaxyMode = 'map' | 'region';
export type GalaxyFilter = 'all' | 'hot' | 'sunlike' | 'cool' | 'remnant' | 'nebula' | 'halo' | 'arm';
export type GalaxyPreset = 'face' | 'edge' | 'home' | 'arm';

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

const STAR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aVis;
  attribute float aLum;
  attribute float aKind;
  attribute float aSize;
  attribute float aSeed;
  uniform vec3 uCenter;
  uniform float uScale;
  uniform float uPixel;
  uniform float uPxPerRad;
  uniform float uGlowK;
  uniform float uGlowP;
  uniform float uGlowMin;
  uniform float uGlowDim;
  uniform float uMaxPx;
  uniform float uNearBoost;
  uniform float uFluxEps;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  void main() {
    vec3 view = (position - uCenter) * uScale;
    vec4 mv = modelViewMatrix * vec4(view, 1.0);
    float d = max(length(mv.xyz), 0.001);
    vKind = aKind;
    vSeed = aSeed;
    vColor = aColor;
    if (aKind > 0.5) {
      // aSize is the envelope radius in catalog kpc; the magnifier
      // scales space, so true angle = aSize * uScale / view distance.
      float ang = max(aSize, 0.005) * uScale / d;
      gl_PointSize = clamp(2.0 * ang * uPxPerRad, 3.0, 512.0);
      vVis = aVis;
      vCenterView = mv.xyz;
      vRadiusView = max(aSize, 0.005) * uScale;
      vCenterCat = position;
      vPx = gl_PointSize;
    } else {
      float L = max(aLum, 1e-4);
      float rMin = aLum < 0.05 ? uGlowDim : uGlowMin;
      float r = max(rMin, uGlowK * pow(L, uGlowP));
      r = min(r, 0.012);
      float ang = r / d;
      float px = 2.0 * ang * uPxPerRad;
      gl_PointSize = clamp(max(uPixel, px), 1.0, uMaxPx);
      float flux = L / (d * d + uFluxEps);
      float punch = 1.0 + uNearBoost * flux / (1.0 + 0.18 * flux);
      vVis = min(aVis * punch, 8.0);
      vCenterView = vec3(0.0);
      vRadiusView = 0.0;
      vCenterCat = vec3(0.0);
      vPx = 0.0;
    }
    gl_Position = projectionMatrix * mv;
  }
`;

/** Catalog diameter × magnifier, with slack — far-disk stars must stay in the frustum. */
function regionCamFar(): number {
  const mag = UNIVERSE.GALAXY_REGION_VIEW_R / Math.max(1e-6, UNIVERSE.GALAXY_REGION_R);
  return UNIVERSE.GALAXY_R_MAX * 2 * mag * 4;
}

const SILHOUETTE_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aVis;
  attribute float aLum;
  attribute float aKind;
  attribute float aSize;
  attribute float aSeed;
  uniform vec3 uCenter;
  uniform float uScale;
  uniform float uPixel;
  uniform float uPxPerRad;
  uniform float uRegionR;
  uniform float uStarPx;
  uniform float uNebulaPx;
  uniform float uDustPx;
  uniform float uSuper;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  void main() {
    vColor = aColor;
    vKind = aKind;
    vSeed = aSeed;
    vCenterView = vec3(0.0);
    vRadiusView = 0.0;
    vCenterCat = vec3(0.0);
    vPx = 0.0;
    float dCat = length(position - uCenter);
    if (dCat < uRegionR) {
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
      // the magnifier boundary.
      float d = max(length(mv.xyz), 0.001);
      float ang = max(aSize, 0.005) * uScale / d;
      float floorPx = (aKind > 3.5 ? uDustPx : uNebulaPx) * uPixel;
      gl_PointSize = clamp(2.0 * ang * uPxPerRad, floorPx, 512.0);
      vVis = aVis;
      vCenterView = mv.xyz;
      vRadiusView = max(aSize, 0.005) * uScale;
      vCenterCat = position;
      vPx = gl_PointSize;
    } else {
      float boost = 1.0 + uSuper * smoothstep(8.0, 180.0, aLum);
      gl_PointSize = uStarPx * uPixel * boost;
      vVis = 1.0;
    }
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  ${SHAPE_GLSL}
  // 0 = photosphere stars, 1 = emission nebulae (additive), 2 = dust (obscures).
  uniform float uPass;
  uniform float uNebGain;
  uniform float uScale;
  uniform mat3 uCamRotInv;
  uniform float uDustSteps;
  uniform float uDustMinPx;
  uniform float uDustAlphaMax;
  uniform float uDustTauK;
  uniform float uDustFreq;
  uniform float uDustRim;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  void main() {
    if (uPass < 0.5 && vKind > 0.5) discard;
    if (uPass > 0.5 && uPass < 1.5 && (vKind < 0.5 || vKind > 3.5)) discard;
    if (uPass > 1.5 && vKind < 3.5) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (vKind < 0.5) {
      if (r2 > 0.85 && r2 < 1.95) discard;
      float limb = 1.0 - 0.22 * min(r2, 1.0);
      gl_FragColor = vec4(vColor * limb, vVis);
      return;
    }
    if (vKind > 3.5) {
      // Dust: a short march through the shared sub-grid ISM field.
      if (vPx < uDustMinPx) {
        // Too small to resolve structure: a soft mote, weighted by density.
        float mask = smoothstep(1.0, 0.55, length(p));
        float a = uDustAlphaMax * mask * (0.15 + 0.7 * vVis);
        if (a < 0.012) discard;
        gl_FragColor = vec4(vColor, a);
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
      // Steps scale with on-screen size: small sprites cannot show
      // structure, so they do not pay for it.
      float steps = clamp(floor(vPx / 24.0) + 2.0, 2.0, uDustSteps);
      float tau = 0.0;
      vec3 meanRel = vec3(0.0);
      float wSum = 0.0;
      for (int i = 0; i < 16; i++) {
        if (float(i) >= steps - 0.5) break;
        float t = mix(t0, t1, (float(i) + 0.5) / steps);
        vec3 relCat = (uCamRotInv * (rd * t - vCenterView)) / uScale;
        float rho = dustRho(vCenterCat + relCat, relCat, radiusCat, vVis, uDustFreq);
        tau += rho;
        meanRel += relCat * rho;
        wSum += rho;
      }
      float segCat = (t1 - t0) / uScale;
      tau *= uDustTauK * segCat / steps;
      if (tau < 0.012) discard;
      float trans = exp(-tau);
      // Extinction: the thick core silhouettes; thin edges keep grain colour.
      vec3 col = vColor * (0.22 + 0.78 * clamp(trans * 1.5, 0.0, 1.0));
      if (wSum > 1e-4) {
        // Single-scatter rim: density falling toward the local OB light
        // means that face is bathed in nursery UV — the Pillars edge.
        vec3 mp = vCenterCat + meanRel / wSum;
        vec3 L = normalize(vec3(
          dustHash(vec3(vSeed * 91.3, 7.0, 1.0)) - 0.5,
          0.35 * (dustHash(vec3(vSeed * 13.7, 2.0, 5.0)) - 0.5),
          dustHash(vec3(vSeed * 29.1, 3.0, 9.0)) - 0.5) + 1e-4);
        float here = dustField(mp, uDustFreq);
        float lit = dustField(mp + L * 0.4 * radiusCat, uDustFreq);
        float rim = clamp((here - lit) * uDustRim * vVis, 0.0, 1.0);
        col += vec3(1.0, 0.93, 0.8) * rim * (1.0 - trans) * 0.85;
      }
      gl_FragColor = vec4(col, min(uDustAlphaMax, 1.0 - trans));
      return;
    }
    // Emission nebulae: self-luminous shells. Brightness is emission
    // measure — rho² integrated along the ray — normalized to surface
    // brightness so rings and filaments come from geometry.
    if (vPx < uDustMinPx) {
      float mask = smoothstep(1.0, 0.5, length(p));
      float a = vVis * 0.4 * mask;
      if (a < 0.01) discard;
      gl_FragColor = vec4(vColor, a);
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
    // Line saturation: the hottest rims bleach toward white.
    col = mix(col, vec3(1.0), min(0.4, 0.18 * em));
    gl_FragColor = vec4(col, min(em, 1.0));
  }
`;

// Markers: fixed-pixel round sprites, always readable over the map.
const MARK_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uPixel;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixel;
    gl_Position = projectionMatrix * mv;
  }
`;

const MARK_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ring = smoothstep(1.0, 0.72, r) * smoothstep(0.28, 0.55, r);
    float core = 1.0 - smoothstep(0.0, 0.3, r);
    float a = max(ring, core * 0.9);
    if (a < 0.05) discard;
    gl_FragColor = vec4(vColor, a);
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
  /** True in region mode (stars are tappable there). */
  pickable: boolean;
  /** Loaded region stars (0 on the map). */
  resolved: number;
  /** Stars grown past the reticle lock angle — no cap. */
  grown: number;
  /** Region label, e.g. "8.2 kpc · 57°" — null on the map. */
  sector: string | null;
  /** Exact occupied-slot population of the open region (0 on the map). */
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

interface MarkerSet {
  pts: THREE.Points;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  objs: GalaxyObject[];
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

  private mode: GalaxyMode = 'map';
  private regionLabel: string | null = null;
  private sectorPop = 0;
  private sectors: SectorMap;
  private lastSightAt = 0;
  private focusObj: GalaxyObject | null = null;
  private focusHud: GalaxyFocus | null = null;
  private grownCount = 0;
  private briefMemo = new Map<number, { name: string; planets: number; moons: number; life: boolean }>();

  private starPts: THREE.Points | null = null;
  private starGeo: THREE.BufferGeometry | null = null;
  private starMat: THREE.ShaderMaterial | null = null;
  private starEmisPts: THREE.Points | null = null;
  private starEmisMat: THREE.ShaderMaterial | null = null;
  private starDustPts: THREE.Points | null = null;
  private starDustMat: THREE.ShaderMaterial | null = null;
  private starVis: THREE.BufferAttribute | null = null;
  private silPts: THREE.Points | null = null;
  private silGeo: THREE.BufferGeometry | null = null;
  private silMat: THREE.ShaderMaterial | null = null;
  private silEmisPts: THREE.Points | null = null;
  private silEmisMat: THREE.ShaderMaterial | null = null;
  private silDustPts: THREE.Points | null = null;
  private silDustMat: THREE.ShaderMaterial | null = null;
  private silWorker: Worker | null = null;
  /** Catalog positions (the vertex shader applies the magnifier). */
  private cloud: StarCloud | null = null;
  private borderWorker: Worker | null = null;
  private borderGen = 0;
  private borderBusy = false;

  private visitedMk: MarkerSet | null = null;
  private interestMk: MarkerSet | null = null;
  private camRot3 = new THREE.Matrix3();

  private homeRing: THREE.Mesh;
  private hereRing: THREE.Mesh;
  private pickRing: THREE.Mesh;
  private hereObj: GalaxyObject | null = null;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  private theta = 0.25;
  private phi = 0.16;
  private radius = 40;
  private tgtTheta = 0.25;
  private tgtPhi = 0.16;
  private tgtRadius = 40;
  private look = new THREE.Vector3();
  private tgtLook = new THREE.Vector3();

  /** Camera stays at the origin in region mode. Unused on the map. */
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
  private gestureR = 0;
  private lastZoomAt = 0;
  private thrustOn = false;
  private thrustSpeed = 0;
  private idle = 0;
  private lastT = performance.now();

  private filter: GalaxyFilter = 'all';
  private selected: GalaxyObject | null = null;
  private censusMemo: Record<string, number> = {};

  constructor(canvas: HTMLCanvasElement, seed: string, callbacks: Callbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.seed = seed;
    this.home = homeStar(seed);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(new THREE.Color('#070b14'), 1);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.02, 400);

    this.sectors = createSectorMap();
    this.scene.add(this.sectors.group);

    this.homeRing = this.makeRing(0x9ec4ff, 0.28);
    this.hereRing = this.makeRing(0x7fa88b, 0.22);
    this.pickRing = this.makeRing(0xf4e4c1, 0.18);
    this.scene.add(this.homeRing, this.hereRing, this.pickRing);
    if (this.home) {
      const c = galToCart(this.home.pos);
      this.homeRing.position.set(c.x, c.y, c.z);
      this.homeRing.visible = true;
    } else {
      this.homeRing.visible = false;
    }
    this.hereRing.visible = false;
    this.pickRing.visible = false;

    // Systems of interest: deterministic wonders, built after first
    // paint so boot never blocks on 5k objectAt calls.
    window.setTimeout(() => {
      if (this.disposed) return;
      this.interestMk = this.makeMarkers(systemsOfInterest(this.seed, 100), [0.95, 0.85, 0.55], 9);
      this.scene.add(this.interestMk.pts);
    }, 60);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.bootBorderWorker();
    this.bootSilhouetteWorker();

    this.setPreset('face');
    this.theta = this.tgtTheta;
    this.phi = this.tgtPhi;
    this.radius = this.tgtRadius;
    this.applyCam();
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

  private makeMarkers(objs: GalaxyObject[], rgb: [number, number, number], sizePx: number): MarkerSet {
    const n = Math.max(1, objs.length);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    for (let i = 0; i < objs.length; i++) {
      const c = galToCart(objs[i].pos);
      pos[i * 3] = c.x;
      pos[i * 3 + 1] = c.y;
      pos[i * 3 + 2] = c.z;
      col[i * 3] = rgb[0];
      col[i * 3 + 1] = rgb[1];
      col[i * 3 + 2] = rgb[2];
      size[i] = sizePx;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    if (objs.length === 0) geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      uniforms: { uPixel: { value: this.renderer.getPixelRatio() } },
      transparent: true,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return { pts, geo, mat, objs };
  }

  setHere(id: number | null): void {
    const o = id != null ? objectAt(this.seed, id) : null;
    this.hereObj = o;
    if (!o) {
      this.hereRing.visible = false;
      return;
    }
    const c = galToCart(o.pos);
    this.hereRing.position.set(c.x, c.y, c.z);
    this.hereRing.visible = true;
  }

  setVisited(ids: number[]): void {
    if (this.visitedMk) {
      this.scene.remove(this.visitedMk.pts);
      this.visitedMk.geo.dispose();
      this.visitedMk.mat.dispose();
    }
    const objs = ids
      .map((id) => objectAt(this.seed, id))
      .filter((o): o is GalaxyObject => o != null);
    this.visitedMk = this.makeMarkers(objs, [0.55, 0.85, 0.62], 8);
    this.visitedMk.pts.visible = this.mode === 'map';
    this.scene.add(this.visitedMk.pts);
  }

  // ------------------------------------------------------------- region mode

  /** VIEW_R / REGION_R — same stars, larger flight ball. */
  private magScale(): number {
    return UNIVERSE.GALAXY_REGION_VIEW_R / Math.max(1e-6, UNIVERSE.GALAXY_REGION_R);
  }

  /** Catalog cartesian → magnified frame (camera at the origin). */
  private toView(x: number, y: number, z: number): { x: number; y: number; z: number } {
    if (this.mode !== 'region') return { x, y, z };
    const s = this.magScale();
    return {
      x: (x - this.arcCenter.x) * s,
      y: (y - this.arcCenter.y) * s,
      z: (z - this.arcCenter.z) * s,
    };
  }

  private viewCart(obj: GalaxyObject): { x: number; y: number; z: number } {
    const c = galToCart(obj.pos);
    return this.toView(c.x, c.y, c.z);
  }

  /**
   * Open the magnification sphere around a world point. `select` is
   * pinned when the dive is a star (home, marker); a saucer tap
   * leaves it null. Flying slides this ball through the catalog.
   */
  enterRegion(x: number, y: number, z: number, select: GalaxyObject | null = null): void {
    this.disposeArcStars();
    this.mode = 'region';
    this.arcCenter.set(x, y, z);
    this.mintAt.set(x, y, z);
    const cloud = buildRegionCloud(this.seed, x, y, z, UNIVERSE.GALAXY_REGION_R);
    this.cloud = cloud;
    this.sectorPop = cloud.n;
    this.regionLabel = regionName(x, y, z);
    this.lastEnterMs = cloud.ms;
    this.objects = [];
    this.buildArcStars();
    this.buildSilhouetteStars();
    this.censusMemo = {};
    this.resetThrust();
    this.borderGen++;
    this.borderBusy = false;
    this.syncWorkerCloud();

    this.arcPos.set(0, 0, 0);
    const glen = Math.hypot(x, z);
    const ox = glen > 1e-4 ? x / glen : 1;
    const oz = glen > 1e-4 ? z / glen : 0;
    this.aimAt(ox, 0, oz);
    this.idle = 0;
    this.camera.near = 0.001;
    this.camera.far = regionCamFar();
    this.camera.updateProjectionMatrix();
    this.sectors.group.visible = false;
    if (this.visitedMk) this.visitedMk.pts.visible = false;
    if (this.interestMk) this.interestMk.pts.visible = false;
    this.select(select);
    this.applyCam();
    this.updateSight(true);
  }

  /** Back to the saucer. The region's stars are dropped; the map is static. */
  exitRegion(): void {
    if (this.mode !== 'region') return;
    this.mode = 'map';
    this.disposeArcStars();
    this.objects = [];
    this.cloud = null;
    this.sectorPop = 0;
    this.regionLabel = null;
    this.focusObj = null;
    this.focusHud = null;
    this.censusMemo = {};
    this.grownCount = 0;
    this.resetThrust();
    this.borderGen++;
    this.borderBusy = false;
    this.borderWorker?.postMessage({ type: 'clear' });
    this.sectors.group.visible = true;
    if (this.visitedMk) this.visitedMk.pts.visible = true;
    if (this.interestMk) this.interestMk.pts.visible = true;
    this.select(null);
    this.tgtLook.set(0, 0, 0);
    this.tgtTheta = this.arcYaw;
    this.tgtPhi = 0.9;
    this.theta = this.tgtTheta;
    this.phi = this.tgtPhi;
    this.tgtRadius = MAP_R_HOME;
    this.gestureR = this.tgtRadius;
    this.camera.near = 0.02;
    this.camera.far = 400;
    this.camera.updateProjectionMatrix();
    // The saucer is a chart again; the last dive is not a tile.
  }

  private disposeLocalStars(): void {
    if (this.starDustPts) {
      this.scene.remove(this.starDustPts);
      this.starDustMat?.dispose();
      this.starDustPts = null;
      this.starDustMat = null;
    }
    if (this.starEmisPts) {
      this.scene.remove(this.starEmisPts);
      this.starEmisMat?.dispose();
      this.starEmisPts = null;
      this.starEmisMat = null;
    }
    if (this.starPts) {
      this.scene.remove(this.starPts);
      this.starGeo?.dispose();
      this.starMat?.dispose();
      this.starPts = null;
      this.starGeo = null;
      this.starMat = null;
      this.starVis = null;
    }
  }

  private disposeSilhouette(): void {
    if (this.silDustPts) {
      this.scene.remove(this.silDustPts);
      this.silDustMat?.dispose();
      this.silDustPts = null;
      this.silDustMat = null;
    }
    if (this.silEmisPts) {
      this.scene.remove(this.silEmisPts);
      this.silEmisMat?.dispose();
      this.silEmisPts = null;
      this.silEmisMat = null;
    }
    if (this.silPts) {
      this.scene.remove(this.silPts);
      this.silGeo?.dispose();
      this.silMat?.dispose();
      this.silPts = null;
      this.silGeo = null;
      this.silMat = null;
    }
  }

  private disposeArcStars(): void {
    this.disposeLocalStars();
    this.disposeSilhouette();
  }

  private bindCloudAttrs(geo: THREE.BufferGeometry, cloud: StarCloud | null, vis: Float32Array): THREE.BufferAttribute {
    const pos = cloud ? cloud.pos : new Float32Array(3);
    const col = cloud ? cloud.col : new Float32Array(3);
    const posAttr = new THREE.BufferAttribute(pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const visAttr = new THREE.BufferAttribute(vis, 1);
    visAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVis', visAttr);
    geo.setAttribute('aLum', new THREE.BufferAttribute(cloud ? cloud.lum : new Float32Array(1), 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(cloud ? cloud.kind : new Uint8Array(1), 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud ? cloud.size : new Float32Array(1), 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud ? cloud.pulse : new Float32Array(1), 1));
    geo.setDrawRange(0, cloud?.n ?? 0);
    return visAttr;
  }

  private localGlowUniforms(): Record<string, THREE.IUniform> {
    return {
      uCenter: { value: new THREE.Vector3() },
      uScale: { value: 1 },
      uPixel: { value: this.renderer.getPixelRatio() },
      uPxPerRad: { value: this.pxPerRad() },
      uGlowK: { value: GLOW_K },
      uGlowP: { value: GLOW_P },
      uGlowMin: { value: 0.0007 },
      uGlowDim: { value: GLOW_DIM },
      uMaxPx: { value: POINT_MAX_PX },
      uNearBoost: { value: POINT_NEAR_BOOST },
      uFluxEps: { value: POINT_FLUX_EPS },
      uPass: { value: 0 },
      ...this.dustUniforms(),
    };
  }

  /** The cloud-march knobs, shared by every material that compiles STAR_FRAG. */
  private dustUniforms(): Record<string, THREE.IUniform> {
    return {
      uCamRotInv: { value: new THREE.Matrix3() },
      uNebGain: { value: UNIVERSE.NEB_EMISSION },
      uDustSteps: { value: UNIVERSE.DUST_MARCH_STEPS },
      uDustMinPx: { value: UNIVERSE.DUST_MINPX },
      uDustAlphaMax: { value: UNIVERSE.DUST_ALPHA_MAX },
      uDustTauK: { value: UNIVERSE.DUST_TAU },
      uDustFreq: { value: UNIVERSE.DUST_FREQ },
      uDustRim: { value: UNIVERSE.DUST_RIM },
    };
  }

  /**
   * Three passes per layer, one shared fragment: stars add light,
   * emission nebulae add light, dust (drawn LAST) obscures both.
   */
  private makeCloudMaterial(
    vertexShader: string,
    uniforms: Record<string, THREE.IUniform>,
    pass: number,
  ): THREE.ShaderMaterial {
    uniforms.uPass = { value: pass };
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: STAR_FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: pass === 2 ? THREE.NormalBlending : THREE.AdditiveBlending,
      toneMapped: false,
    });
  }

  private buildArcStars(): void {
    const cloud = this.cloud;
    const vis = new Float32Array(cloud ? cloud.gain.length : 1);
    if (cloud) {
      for (let i = 0; i < cloud.n; i++) vis[i] = cloud.gain[i];
    }
    const geo = new THREE.BufferGeometry();
    const visAttr = this.bindCloudAttrs(geo, cloud, vis);
    const mat = this.makeCloudMaterial(STAR_VERT, this.localGlowUniforms(), 0);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 0;
    this.scene.add(pts);
    this.starPts = pts;
    this.starGeo = geo;
    this.starMat = mat;
    this.starVis = visAttr;
    const emisMat = this.makeCloudMaterial(STAR_VERT, this.localGlowUniforms(), 1);
    const emisPts = new THREE.Points(geo, emisMat);
    emisPts.frustumCulled = false;
    emisPts.renderOrder = 1;
    this.scene.add(emisPts);
    this.starEmisPts = emisPts;
    this.starEmisMat = emisMat;
    const dustMat = this.makeCloudMaterial(STAR_VERT, this.localGlowUniforms(), 2);
    const dustPts = new THREE.Points(geo, dustMat);
    dustPts.frustumCulled = false;
    dustPts.renderOrder = 3;
    this.scene.add(dustPts);
    this.starDustPts = dustPts;
    this.starDustMat = dustMat;
    this.pushMagUniforms();
    this.applyStarVis();
  }

  private silUniforms(): Record<string, THREE.IUniform> {
    return {
      uCenter: { value: new THREE.Vector3() },
      uScale: { value: 1 },
      uPixel: { value: this.renderer.getPixelRatio() },
      uPxPerRad: { value: this.pxPerRad() },
      uRegionR: { value: UNIVERSE.GALAXY_REGION_R },
      uStarPx: { value: UNIVERSE.SILHOUETTE_STAR_PX },
      uNebulaPx: { value: UNIVERSE.SILHOUETTE_NEBULA_PX },
      uDustPx: { value: UNIVERSE.SILHOUETTE_DUST_PX },
      uSuper: { value: UNIVERSE.SILHOUETTE_SUPER_GAIN },
      ...this.dustUniforms(),
    };
  }

  private buildSilhouetteStars(): void {
    const cloud = silhouetteCloud(this.seed) ?? buildSilhouetteCloud(this.seed);
    if (!cloud || cloud.n <= 0) return;
    this.disposeSilhouette();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    geo.setAttribute('aVis', new THREE.BufferAttribute(cloud.gain, 1));
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
    const emisMat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 1);
    const emisPts = new THREE.Points(geo, emisMat);
    emisPts.frustumCulled = false;
    emisPts.renderOrder = -1;
    this.scene.add(emisPts);
    this.silEmisPts = emisPts;
    this.silEmisMat = emisMat;
    const dustMat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 2);
    const dustPts = new THREE.Points(geo, dustMat);
    dustPts.frustumCulled = false;
    dustPts.renderOrder = 2;
    this.scene.add(dustPts);
    this.silDustPts = dustPts;
    this.silDustMat = dustMat;
    this.pushMagUniforms();
  }

  private cloudMats(): THREE.ShaderMaterial[] {
    const out: THREE.ShaderMaterial[] = [];
    for (const m of [this.starMat, this.starEmisMat, this.starDustMat, this.silMat, this.silEmisMat, this.silDustMat]) {
      if (m) out.push(m);
    }
    return out;
  }

  /** Catalog positions stay on the GPU; only the magnifier uniforms move. */
  private pushMagUniforms(): void {
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    const s = this.magScale();
    for (const mat of this.cloudMats()) {
      mat.uniforms.uCenter.value.set(cx, cy, cz);
      mat.uniforms.uScale.value = s;
    }
  }

  /**
   * Membership changed: reuse the point mesh. Remesh only when the
   * cloud grew past the current buffers.
   */
  private syncArcStars(): void {
    const cloud = this.cloud;
    if (!cloud) return;
    if (!this.starGeo || !this.starMat || !this.starVis) {
      this.disposeLocalStars();
      this.buildArcStars();
      return;
    }
    const posAttr = this.starGeo.getAttribute('position') as THREE.BufferAttribute;
    if (posAttr.array !== cloud.pos) {
      const vis = new Float32Array(cloud.gain.length);
      this.starVis = this.bindCloudAttrs(this.starGeo, cloud, vis);
    } else {
      posAttr.needsUpdate = true;
      (this.starGeo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
      const lum = this.starGeo.getAttribute('aLum') as THREE.BufferAttribute | undefined;
      if (lum) lum.needsUpdate = true;
      const kind = this.starGeo.getAttribute('aKind') as THREE.BufferAttribute | undefined;
      if (kind) kind.needsUpdate = true;
      const size = this.starGeo.getAttribute('aSize') as THREE.BufferAttribute | undefined;
      if (size) size.needsUpdate = true;
      const seed = this.starGeo.getAttribute('aSeed') as THREE.BufferAttribute | undefined;
      if (seed) seed.needsUpdate = true;
    }
    this.starGeo.setDrawRange(0, cloud.n);
    this.applyStarVis();
  }

  // --------------------------------------------------------------- state

  setFilter(f: GalaxyFilter): void {
    this.filter = f;
    this.censusMemo = {};
    this.applyStarVis();
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

  /** Class census of the open region (cheap MK from the birth clock). */
  census(): Record<string, number> {
    if (Object.keys(this.censusMemo).length > 0) return this.censusMemo;
    const c: Record<string, number> = {};
    const cloud = this.cloud;
    if (!cloud) {
      this.censusMemo = c;
      return c;
    }
    for (let i = 0; i < cloud.n; i++) {
      if ((cloud.bits[i] & BIT_DUST) !== 0 || cloud.kind[i] === KIND_DUST) continue;
      if (!sketchMatches(cloud.bits[i], this.filter)) continue;
      const letter = MK_LETTER[cloud.mk[i]] ?? 'WD';
      c[letter] = (c[letter] ?? 0) + 1;
    }
    this.censusMemo = c;
    return c;
  }

  beaconCount(): number {
    return this.cloud?.n ?? this.objects.length;
  }

  /** The arc's loaded survey — every row is a tappable catalog id. */
  surveyStars(): GalaxyObject[] {
    return this.objects;
  }

  /** Stars grown past the reticle lock — no cap. Smoke / HUD. */
  grownStars(): number {
    return this.grownCount;
  }

  /** True if every loaded point sits inside the region ball. */
  cloudFitsRegion(): boolean {
    const cloud = this.cloud;
    if (!cloud || cloud.n <= 0) return false;
    const r = UNIVERSE.GALAXY_REGION_R + 1e-5;
    const r2 = r * r;
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    for (let i = 0; i < cloud.n; i++) {
      const dx = cloud.pos[i * 3] - cx;
      const dy = cloud.pos[i * 3 + 1] - cy;
      const dz = cloud.pos[i * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > r2) return false;
    }
    return true;
  }

  setPreset(p: GalaxyPreset): void {
    if (p === 'home') {
      const obj = this.hereObj ?? this.home;
      if (obj) this.focus(obj);
      return;
    }
    this.exitRegion();
    if (p === 'face') {
      this.tgtTheta = 0.25;
      this.tgtPhi = 0.16;
      this.tgtRadius = 40;
    } else if (p === 'edge') {
      this.tgtTheta = 0.15;
      this.tgtPhi = 1.42;
      this.tgtRadius = 36;
    } else {
      this.tgtTheta = 1.15;
      this.tgtPhi = 0.55;
      this.tgtRadius = 22;
      const c = galToCart({ R: UNIVERSE.GALAXY_RD * 2.2, theta: 1.1, z: 0 });
      this.tgtLook.set(c.x, c.y, c.z);
      this.idle = 0;
      return;
    }
    this.tgtLook.set(0, 0, 0);
    this.idle = 0;
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
    const off = 0.028 / this.magScale();
    this.arcCenter.set(
      cat.x - this.arcFwd.x * off,
      cat.y - this.arcFwd.y * off,
      cat.z - this.arcFwd.z * off,
    );
    this.mintAt.copy(this.arcCenter);
    this.borderGen++;
    this.borderBusy = false;
    this.syncWorkerCloud();
    this.pushMagUniforms();
    if (this.selected) {
      const c = this.viewCart(this.selected);
      this.pickRing.position.set(c.x, c.y, c.z);
    }
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

  /** Apparent angle (rad) of a cloud star — smoke proves points grow. */
  pointApparent(id: number): number {
    const cloud = this.cloud;
    if (!cloud) return 0;
    for (let i = 0; i < cloud.n; i++) {
      if (cloud.ids[i] !== id) continue;
      const v = this.toView(cloud.pos[i * 3], cloud.pos[i * 3 + 1], cloud.pos[i * 3 + 2]);
      const dist = Math.hypot(v.x, v.y, v.z);
      const dim = (cloud.bits[i] & BIT_REMNANT) !== 0 || cloud.lum[i] < 0.05;
      return glowRadiusKpc(cloud.lum[i], dim) / Math.max(1e-5, dist);
    }
    const o = objectAt(this.seed, id);
    if (!o) return 0;
    const c = this.viewCart(o);
    const dist = Math.hypot(c.x, c.y, c.z);
    return glowRadiusKpc(o.star.luminosity, o.star.luminosity < 0.05) / Math.max(1e-5, dist);
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
    const s = this.magScale();
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    const cat = cloud.pos;
    for (let i = 0; i < cloud.n; i += step) {
      if ((cloud.bits[i] & BIT_DUST) !== 0 || cloud.kind[i] === KIND_DUST) continue;
      if (!sketchMatches(cloud.bits[i], this.filter)) continue;
      const i3 = i * 3;
      const x = (cat[i3] - cx) * s;
      const y = (cat[i3 + 1] - cy) * s;
      const z = (cat[i3 + 2] - cz) * s;
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
    this.borderWorker?.terminate();
    this.borderWorker = null;
    this.silWorker?.terminate();
    this.silWorker = null;
    this.disposeArcStars();
    for (const mk of [this.visitedMk, this.interestMk]) {
      if (!mk) continue;
      mk.geo.dispose();
      mk.mat.dispose();
    }
    this.sectors.dispose();
    this.homeRing.geometry.dispose();
    (this.homeRing.material as THREE.Material).dispose();
    this.hereRing.geometry.dispose();
    (this.hereRing.material as THREE.Material).dispose();
    this.pickRing.geometry.dispose();
    (this.pickRing.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private resetThrust(): void {
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }

  /** Latch warp on (accel to cap) or off (brake to stop). A tap, not a hold. */
  setWarp(on: boolean): void {
    if (this.mode !== 'region') return;
    this.thrustOn = on;
    this.idle = 0;
  }

  warping(): boolean {
    return this.thrustOn;
  }

  private select(obj: GalaxyObject | null): void {
    this.selected = obj;
    if (obj) {
      const c = this.viewCart(obj);
      this.pickRing.position.set(c.x, c.y, c.z);
      this.pickRing.visible = true;
    } else {
      this.pickRing.visible = false;
    }
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
    if (this.mode === 'region') {
      this.orientArc();
      this.camera.position.set(0, 0, 0);
      this.camera.up.copy(this.arcUp);
      this.arcLook.copy(this.arcFwd);
      this.camera.lookAt(this.arcLook);
      this.radius = 0;
      this.theta = this.arcYaw;
      this.phi = Math.PI / 2 - this.arcPitch;
      this.look.copy(this.arcLook);
      this.pushMagUniforms();
      return;
    }
    const r = this.radius;
    const x = this.look.x + r * Math.sin(this.phi) * Math.cos(this.theta);
    const y = this.look.y + r * Math.cos(this.phi);
    const z = this.look.z + r * Math.sin(this.phi) * Math.sin(this.theta);
    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
  }

  private minR(): number {
    return MAP_R_MIN;
  }

  private maxR(): number {
    return MAP_R_MAX;
  }

  /**
   * Cruise speed. Cap is small and fixed so extra space between
   * stars is felt as more zoom, not a faster ship. Slow further
   * only when a star is already close (examine, don't overshoot).
   * Star size is not scaled with the viewing ball.
   */
  private arcPace(): number {
    const cloud = this.cloud;
    let minD = 8;
    if (cloud) {
      const step = Math.max(1, Math.floor(cloud.n / 6000));
      const s = this.magScale();
      const cx = this.arcCenter.x;
      const cy = this.arcCenter.y;
      const cz = this.arcCenter.z;
      const cat = cloud.pos;
      for (let i = 0; i < cloud.n; i += step) {
        const i3 = i * 3;
        const d = Math.hypot((cat[i3] - cx) * s, (cat[i3 + 1] - cy) * s, (cat[i3 + 2] - cz) * s);
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
   * Gestures are in the magnified frame. The camera stays at the
   * origin; the sphere centre moves by dView / scale. The GPU holds
   * catalog positions — the vertex shader applies the magnifier.
   * Membership is a shell walk once the centre has moved MAG_SLIDE,
   * run on a worker so the frame only updates the magnifier uniforms.
   */
  private moveBubble(vx: number, vy: number, vz: number, force = false): void {
    if (this.mode !== 'region' || !this.cloud) return;
    const s = this.magScale();
    this.arcCenter.x += vx / s;
    this.arcCenter.y += vy / s;
    this.arcCenter.z += vz / s;
    const d = this.arcCenter.distanceTo(this.mintAt);
    if (force || d > MAG_REBUILD) {
      this.applyMembership(buildRegionCloud(this.seed, this.arcCenter.x, this.arcCenter.y, this.arcCenter.z), true);
      this.mintAt.copy(this.arcCenter);
      this.syncWorkerCloud();
    } else if (d >= MAG_SLIDE) {
      this.requestBorder();
    }
    this.pushMagUniforms();
    if (this.selected) {
      const c = this.viewCart(this.selected);
      this.pickRing.position.set(c.x, c.y, c.z);
    }
  }

  private bootSilhouetteWorker(): void {
    try {
      this.silWorker = new Worker(new URL('../world/silhouette.worker.ts', import.meta.url), { type: 'module' });
      this.silWorker.onmessage = (e: MessageEvent) => {
        const m = e.data as {
          type: string;
          seed: string;
          n: number;
          ids: Float64Array;
          pos: Float32Array;
          col: Float32Array;
          size: Float32Array;
          pulse: Float32Array;
          gain: Float32Array;
          bits: Uint8Array;
          mk: Uint8Array;
          lum: Float32Array;
          kind: Uint8Array;
          ms: number;
        };
        if (m.type !== 'ready' || m.seed !== this.seed) return;
        installSilhouetteCloud(m.seed, {
          n: m.n,
          ids: m.ids,
          pos: m.pos,
          col: m.col,
          size: m.size,
          pulse: m.pulse,
          gain: m.gain,
          bits: m.bits,
          mk: m.mk,
          lum: m.lum,
          kind: m.kind,
          ms: m.ms,
        });
        if (this.mode === 'region' && !this.silPts) this.buildSilhouetteStars();
      };
      this.silWorker.onerror = () => {
        this.silWorker?.terminate();
        this.silWorker = null;
        if (this.disposed) return;
        buildSilhouetteCloud(this.seed);
        if (this.mode === 'region' && !this.silPts) this.buildSilhouetteStars();
      };
      this.silWorker.postMessage({ type: 'mint', seed: this.seed });
    } catch {
      this.silWorker = null;
      window.setTimeout(() => {
        if (this.disposed) return;
        buildSilhouetteCloud(this.seed);
        if (this.mode === 'region' && !this.silPts) this.buildSilhouetteStars();
      }, 0);
    }
  }

  private bootBorderWorker(): void {
    try {
      this.borderWorker = new Worker(new URL('../world/regionCloud.worker.ts', import.meta.url), { type: 'module' });
      this.borderWorker.onmessage = this.onBorderMessage;
      this.borderWorker.onerror = () => {
        this.borderWorker?.terminate();
        this.borderWorker = null;
        this.borderBusy = false;
      };
    } catch {
      this.borderWorker = null;
    }
  }

  private syncWorkerCloud(): void {
    const c = this.cloud;
    const w = this.borderWorker;
    if (!c || !w) return;
    const ids = c.ids.slice(0, c.n);
    const pos = c.pos.slice(0, c.n * 3);
    const col = c.col.slice(0, c.n * 3);
    const size = c.size.slice(0, c.n);
    const pulse = c.pulse.slice(0, c.n);
    const gain = c.gain.slice(0, c.n);
    const bits = c.bits.slice(0, c.n);
    const mk = c.mk.slice(0, c.n);
    const lum = c.lum.slice(0, c.n);
    const kind = c.kind.slice(0, c.n);
    w.postMessage(
      { type: 'set', seed: this.seed, n: c.n, ids, pos, col, size, pulse, gain, bits, mk, lum, kind },
      [ids.buffer, pos.buffer, col.buffer, size.buffer, pulse.buffer, gain.buffer, bits.buffer, mk.buffer, lum.buffer, kind.buffer],
    );
  }

  private requestBorder(): void {
    if (!this.cloud) return;
    if (!this.borderWorker) {
      this.applyMembership(
        advanceRegionCloud(
          this.seed,
          this.cloud,
          this.mintAt.x,
          this.mintAt.y,
          this.mintAt.z,
          this.arcCenter.x,
          this.arcCenter.y,
          this.arcCenter.z,
        ),
        false,
      );
      this.mintAt.copy(this.arcCenter);
      return;
    }
    if (this.borderBusy) return;
    this.borderBusy = true;
    this.borderWorker.postMessage({
      type: 'advance',
      gen: this.borderGen,
      x0: this.mintAt.x,
      y0: this.mintAt.y,
      z0: this.mintAt.z,
      x1: this.arcCenter.x,
      y1: this.arcCenter.y,
      z1: this.arcCenter.z,
    });
  }

  private onBorderMessage = (e: MessageEvent): void => {
    const m = e.data as {
      type: string;
      gen: number;
      n: number;
      ids: Float64Array;
      pos: Float32Array;
      col: Float32Array;
      size: Float32Array;
      pulse: Float32Array;
      gain: Float32Array;
      bits: Uint8Array;
      mk: Uint8Array;
      lum: Float32Array;
      kind: Uint8Array;
      x: number;
      y: number;
      z: number;
    };
    if (m.type !== 'cloud' || m.gen !== this.borderGen || this.mode !== 'region') return;
    this.borderBusy = false;
    this.applyMembership(
      {
        n: m.n,
        ids: m.ids,
        pos: m.pos,
        col: m.col,
        size: m.size,
        pulse: m.pulse,
        gain: m.gain,
        bits: m.bits,
        mk: m.mk,
        lum: m.lum,
        kind: m.kind,
        ms: 0,
      },
      false,
    );
    this.mintAt.set(m.x, m.y, m.z);
    if (this.arcCenter.distanceTo(this.mintAt) > MAG_REBUILD) {
      this.applyMembership(buildRegionCloud(this.seed, this.arcCenter.x, this.arcCenter.y, this.arcCenter.z), true);
      this.mintAt.copy(this.arcCenter);
      this.syncWorkerCloud();
    } else if (this.arcCenter.distanceTo(this.mintAt) >= MAG_SLIDE) {
      this.requestBorder();
    }
  };

  private applyMembership(cloud: StarCloud, remesh: boolean): void {
    this.cloud = cloud;
    this.sectorPop = cloud.n;
    this.regionLabel = regionName(this.arcCenter.x, this.arcCenter.y, this.arcCenter.z);
    this.censusMemo = {};
    if (remesh) {
      this.disposeLocalStars();
      this.buildArcStars();
    } else {
      this.syncArcStars();
    }
  }

  /**
   * Map: scale the orbit radius toward what is already framed.
   * Region: zoom does not fly — latched warp does.
   */
  private zoom(factor: number): void {
    const now = performance.now();
    this.idle = 0;
    if (this.mode === 'region') return;
    if (now - this.lastZoomAt > 600) this.gestureR = this.tgtRadius;
    this.lastZoomAt = now;
    const lo = Math.max(this.minR(), this.gestureR / ZOOM_GESTURE_SPAN);
    const hi = Math.min(this.maxR(), this.gestureR * ZOOM_GESTURE_SPAN);
    this.tgtRadius = Math.max(lo, Math.min(hi, this.tgtRadius * factor));
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

  private markerAt(cx: number, cy: number): GalaxyObject | null {
    let best: GalaxyObject | null = null;
    let bestD = 26;
    const pools: GalaxyObject[] = [];
    if (this.hereObj) pools.push(this.hereObj);
    if (this.home) pools.push(this.home);
    if (this.visitedMk) pools.push(...this.visitedMk.objs);
    if (this.interestMk) pools.push(...this.interestMk.objs);
    for (const o of pools) {
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
    if (this.mode === 'map') {
      // Markers first — a visited world or a wonder beats its tile.
      const mk = this.markerAt(cx, cy);
      if (mk) {
        this.focus(mk);
        return;
      }
      const hit = this.sectors.pick(this.raycaster);
      if (hit) this.enterRegion(hit.x, 0, hit.z);
      return;
    }
    const picked = this.pickCloud(cx, cy);
    if (picked) this.select(picked);
  }

  private pickCloud(cx: number, cy: number): GalaxyObject | null {
    const cloud = this.cloud;
    if (!cloud) return null;
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const rect = this.canvas.getBoundingClientRect();
    const s = this.magScale();
    const ox = this.arcCenter.x;
    const oy = this.arcCenter.y;
    const oz = this.arcCenter.z;
    const cat = cloud.pos;
    const bits = cloud.bits;
    const ids = cloud.ids;
    const lum = cloud.lum;
    const pxPer = this.pxPerRad() / Math.max(1, this.renderer.getPixelRatio());
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < cloud.n; i++) {
      if ((bits[i] & BIT_DUST) !== 0) continue;
      if (!sketchMatches(bits[i], this.filter)) continue;
      const i3 = i * 3;
      const x = (cat[i3] - ox) * s;
      const y = (cat[i3 + 1] - oy) * s;
      const z = (cat[i3 + 2] - oz) * s;
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
        bestI = i;
      }
    }
    if (bestI < 0) return null;
    return objectAt(this.seed, ids[bestI]);
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
      this.gestureR = this.tgtRadius;
      this.lastZoomAt = performance.now();
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.pinch0 > 0 && this.mode !== 'region') {
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

  /** Latched warp: ↑ / Warp accel, ↓ / Stop brake, same rate. */
  private cruise(dt: number): void {
    if (this.mode !== 'region') {
      this.thrustOn = false;
      this.thrustSpeed = 0;
      return;
    }
    if (this.thrustOn) this.thrustSpeed = Math.min(THRUST_MAX, this.thrustSpeed + THRUST_RATE * dt);
    else this.thrustSpeed = Math.max(0, this.thrustSpeed - THRUST_RATE * dt);
    if (this.thrustSpeed <= 1e-5) {
      this.thrustSpeed = 0;
      return;
    }
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
   * Filter the cloud and lock the centre reticle onto a grown point.
   * Every star may grow; there is no mesh roster.
   */
  private updateSight(force = false): void {
    if (this.mode !== 'region') return;
    const now = performance.now();
    if (!force && now - this.lastSightAt < 50) return;
    this.lastSightAt = now;
    this.aimReticle();
  }

  /** Centre reticle vs grown cloud points. A hit can be flown to now. */
  private aimReticle(): void {
    if (this.mode !== 'region') {
      this.focusObj = null;
      this.focusHud = null;
      this.grownCount = 0;
      return;
    }
    const cloud = this.cloud;
    if (!cloud) {
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
    const s = this.magScale();
    const ox = this.arcCenter.x;
    const oy = this.arcCenter.y;
    const oz = this.arcCenter.z;
    const cat = cloud.pos;
    const lum = cloud.lum;
    const bits = cloud.bits;
    const ids = cloud.ids;
    let grown = 0;
    let bestI = -1;
    let bestOff = 1;
    let bestDist = 0;
    let bestDim = false;
    for (let i = 0; i < cloud.n; i++) {
      if ((bits[i] & BIT_DUST) !== 0) continue;
      if (!sketchMatches(bits[i], this.filter)) continue;
      const i3 = i * 3;
      const dx = (cat[i3] - ox) * s - cx;
      const dy = (cat[i3 + 1] - oy) * s - cy;
      const dz = (cat[i3 + 2] - oz) * s - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-12) continue;
      const dist = Math.sqrt(d2);
      const dim = (bits[i] & BIT_REMNANT) !== 0 || lum[i] < 0.05;
      const ang = glowRadiusKpc(lum[i], dim) / dist;
      if (ang >= AIM_MIN_ANG) grown++;
      else continue;
      const inv = 1 / dist;
      const dot = dx * inv * lx + dy * inv * ly + dz * inv * lz;
      if (dot < cosCone) continue;
      const off = 1 - dot;
      if (off < bestOff) {
        bestOff = off;
        bestI = i;
        bestDist = dist;
        bestDim = dim;
      }
    }
    this.grownCount = grown;
    if (bestI < 0) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    if (this.focusObj?.id === ids[bestI] && this.focusHud) {
      this.focusHud.dist = bestDist;
      this.focusHud.dark = bestDim;
      return;
    }
    const hit = objectAt(this.seed, ids[bestI]);
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
    const { bits, gain, n } = this.cloud;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      if ((bits[i] & BIT_DUST) !== 0) {
        arr[i] = gain[i];
        continue;
      }
      arr[i] = sketchMatches(bits[i], this.filter) ? gain[i] : gain[i] * 0.08;
    }
    this.starVis.needsUpdate = true;
  }

  // --------------------------------------------------------------- frame

  private frame = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.idle += dt;
    if (this.mode === 'region') {
      this.cruise(dt);
      this.steerArc(dt);
      this.applyCam();
      this.updateSight();
      this.aimReticle();
    } else {
      if (!this.dragging && this.idle > 3) this.tgtTheta += dt * 0.04;
      this.theta += (this.tgtTheta - this.theta) * (1 - Math.exp(-dt * 4.2));
      this.phi += (this.tgtPhi - this.phi) * (1 - Math.exp(-dt * 4.2));
      this.radius += (this.tgtRadius - this.radius) * (1 - Math.exp(-dt * 3.6));
      this.look.lerp(this.tgtLook, 1 - Math.exp(-dt * 3.2));
      this.applyCam();
    }

    const t = now * 0.001;
    const px = this.renderer.getPixelRatio();
    const pxPer = this.pxPerRad();
    // View→catalog rotation so the cloud march samples a camera-stable field.
    this.camera.updateMatrixWorld();
    this.camRot3.setFromMatrix4(this.camera.matrixWorld);
    for (const mat of this.cloudMats()) {
      mat.uniforms.uPixel.value = px;
      mat.uniforms.uPxPerRad.value = pxPer;
      (mat.uniforms.uCamRotInv.value as THREE.Matrix3).copy(this.camRot3);
    }

    const cam = this.camera.position;
    const ringFor = (mesh: THREE.Mesh, lo: number, hi: number, k: number) => {
      const d = cam.distanceTo(mesh.position);
      mesh.scale.setScalar(Math.max(lo, Math.min(hi, d * k)));
    };
    if (this.mode === 'region') {
      ringFor(this.pickRing, 0.00035, 0.03, 0.045);
      ringFor(this.homeRing, 0.00035, 0.03, 0.045);
      ringFor(this.hereRing, 0.00035, 0.03, 0.04);
    } else {
      const ringS = Math.max(0.02, this.radius * 0.03);
      this.pickRing.scale.setScalar(ringS);
      this.homeRing.scale.setScalar(ringS);
      this.hereRing.scale.setScalar(ringS * 0.85);
    }
    this.pickRing.rotation.z = t * 0.35;
    this.homeRing.rotation.z = -t * 0.12;
    this.hereRing.rotation.z = t * 0.2;

    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame?.({
      mode: this.mode,
      theta: this.theta,
      phi: this.phi,
      radius: this.radius,
      pickable: this.mode === 'region',
      resolved: this.cloud?.n ?? 0,
      grown: this.grownCount,
      sector: this.regionLabel,
      population: this.sectorPop,
      focus: this.mode === 'region' ? this.focusHud : null,
      warp: this.mode === 'region' && this.thrustOn,
      backdrop: this.mode === 'region' ? (this.silPts ? (silhouetteCloud(this.seed)?.n ?? 0) : 0) : 0,
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}
