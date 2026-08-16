/**
 * The galaxy explorer is one catalog bubble. Inside it every
 * occupied slot is drawn and visitable; outside, only the
 * magnitude-limited backdrop. View is 1:1 with the catalog —
 * the camera sits at the bubble centre. Look-drag slides the
 * heading. Warp latches a fixed cruise; Stop brakes. Face-on /
 * Edge-on slide the bubble far enough that the whole disk fits
 * the screen; Back restores the pose from before that overview;
 * Home parks on the loaded star (else the canonical home) and
 * pins that pose as Back. Dust is never drawn — it is sightline
 * extinction.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, homeStar, objectAt, type GalaxyObject } from '../world/galaxy';
import {
  aimLocks,
  GLOW_DIM,
  GLOW_K,
  GLOW_P,
  POINT_FLUX_EPS,
  POINT_MAX_PX,
  POINT_NEAR_BOOST,
  PHOTO_K,
  PHOTO_MAX,
  PHOTO_MIN,
  PHOTO_P,
  SHINE_DIST_P,
  SHINE_DIST_REF,
  SHINE_L_GAIN,
  SHINE_L_P,
  SHINE_SAT,
  glowRadiusKpc,
} from './galaxyStar';
import { classifyStar } from '../world/stellar';
import { systemAt } from '../world/systemgen';
import {
  buildRegionCloud,
  silhouetteCloud,
  advanceRegionCloud,
  regionName,
  sketchMatches,
  MK_LETTER,
  BIT_REMNANT,
  BIT_DUST,
  BIT_NEBULA,
  KIND_DUST,
  type StarCloud,
} from '../world/sectors';
import { SHAPE_GLSL } from '../world/skyShape';
import { prepareUniverse } from '../world/universePrep';

/** Bake a number into GLSL as a float literal (GLSL ES has no int→float). */
const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * Dust is not drawn; it is subtraction — ONE law for both layers.
 * Column density along a sightline: the thin gas sheet × the same
 * turbulence complexes the clump-occupancy law samples. The sheet's
 * z-scale is ZD (razor thin), so bulge rows above the plane shine
 * over the lane — the Sombrero geometry emerges instead of being
 * painted. `steps` is baked per shader: the backdrop marches the
 * whole disk (GALAXY_EXTINCT_STEPS); the local column is at most
 * REGION_R, so EXTINCT_STEPS_LOCAL taps sample it more densely for
 * a fraction of the cost. Requires SHAPE_GLSL (dustField) above.
 */
const extinctGlsl = (steps: number) => /* glsl */ `
  uniform float uExtinctK;
  uniform float uExtinctMax;
  uniform vec3 uDustRgb;
  float extinctRho(vec3 p) {
    float R = length(p.xz);
    float ez = exp(min(abs(p.y) / ${glslFloat(UNIVERSE.GALAXY_ZD_GAS)}, 12.0));
    float sech = 2.0 / (ez + 1.0 / ez);
    float gas = exp(-R / ${glslFloat(UNIVERSE.GALAXY_RD * UNIVERSE.GALAXY_RD_GAS)}) * sech * sech;
    // 0.3 is the rift threshold: only above-average turbulence
    // holds enough dust to matter along a whole column.
    return gas * max(0.0, dustField(p, ${glslFloat(UNIVERSE.GALAXY_TURB_FREQ)}) - 0.3);
  }
  // Transmittance exp(−τ · DUST_RGB) from the bubble centre to a
  // row — blue dies first, so rift-edge rows redden before they
  // vanish. Brightness must ride vVis (the star fragment
  // renormalizes colour to peak); colour carries the chroma shift.
  vec3 extinctT(vec3 from, vec3 to) {
    float dCat = length(to - from);
    float dt = dCat / ${glslFloat(steps)};
    vec3 dir = (to - from) / max(dCat, 1e-4);
    float tau = 0.0;
    for (int i = 0; i < ${steps}; i++) {
      tau += extinctRho(from + dir * ((float(i) + 0.5) * dt));
    }
    tau = min(tau * uExtinctK * dt, uExtinctMax);
    return exp(-tau * uDustRgb);
  }
`;

/** Slide the catalog centre after it has moved this far (catalog kpc). */
const MAG_SLIDE = 0.002;
/** A jump bigger than this remints instead of walking the rim. */
const MAG_REBUILD = 0.03;
/** Latched warp. Speed is catalog kpc / s — see UNIVERSE.GALAXY_WARP. */
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

const STAR_VERT = /* glsl */ `
  ${SHAPE_GLSL}
  ${extinctGlsl(UNIVERSE.GALAXY_EXTINCT_STEPS_LOCAL)}
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
  uniform float uGlowK;
  uniform float uGlowP;
  uniform float uGlowMin;
  uniform float uGlowDim;
  uniform float uMaxPx;
  uniform float uNearBoost;
  uniform float uFluxEps;
  uniform float uPhotoK;
  uniform float uPhotoP;
  uniform float uPhotoMin;
  uniform float uPhotoMax;
  uniform float uShineLGain;
  uniform float uShineLP;
  uniform float uShineDistRef;
  uniform float uShineDistP;
  uniform float uShineSat;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  void main() {
    // Cull for the pass HERE: the shared fragment discards the wrong
    // kinds anyway, but a discarded sprite still rasterizes its whole
    // quad. Toward the core that tripled the overdraw for nothing.
    // Dust rows (kind > 3.5) are census-only — never drawn.
    if ((uPass < 0.5 && aKind > 0.5) ||
        (uPass > 0.5 && (aKind < 0.5 || aKind > 3.5))) {
      vVis = 0.0;
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 view = (position - uCenter) * uScale;
    vec4 mv = modelViewMatrix * vec4(view, 1.0);
    float d = max(length(mv.xyz), 0.001);
    vKind = aKind;
    vSeed = aSeed;
    vColor = aColor;
    if (aKind > 0.5) {
      // aSize is the envelope radius in catalog kpc. View is 1:1,
      // so true angle = aSize * uScale / view distance (uScale = 1).
      float ang = max(aSize, 0.005) * uScale / d;
      gl_PointSize = clamp(2.0 * ang * uPxPerRad, 3.0, 512.0);
      vVis = aVis;
      vCenterView = mv.xyz;
      vRadiusView = max(aSize, 0.005) * uScale;
      vCenterCat = position;
      vPx = gl_PointSize;
    } else {
      // Glow pin (GLOW_K). max(1px, 2 r/d) — a point at the rim;
      // a disc only when the bubble is on top of it. Flux L/d²,
      // colour teff. View is catalog kpc (1:1).
      float L = max(aLum, 1e-4);
      float r = max(L < 0.05 ? uGlowDim : uPhotoMin, uPhotoK * pow(L, uPhotoP));
      r = min(r, uPhotoMax);
      float ang = r / d;
      gl_PointSize = clamp(max(uPixel, 2.0 * ang * uPxPerRad), 1.0, uMaxPx);
      float flux = L / (d * d + uFluxEps);
      float punch = 1.0 + uNearBoost * flux / (1.0 + 0.18 * flux);
      float lum = dot(aColor, vec3(0.2126, 0.7152, 0.0722));
      vColor = clamp(mix(vec3(lum), aColor, uShineSat), 0.0, 1.0);
      vVis = min(aVis * punch, 8.0);
      vCenterView = vec3(0.0);
      vRadiusView = 0.0;
      vCenterCat = vec3(0.0);
      vPx = gl_PointSize;
    }
    // Same dust law as the backdrop, over the short in-bubble
    // column — a star does not brighten by crossing the bubble
    // boundary, and local rifts line up with the backdrop's.
    vec3 ext = extinctT(uCenter, position);
    float extLum = dot(ext, vec3(0.2126, 0.7152, 0.0722));
    vVis *= extLum;
    vColor *= ext / max(extLum, 1e-3);
    gl_Position = projectionMatrix * mv;
  }
`;

/** Disk diameter with slack — Face-on sits several R_MAX out. */
function regionCamFar(): number {
  return UNIVERSE.GALAXY_R_MAX * 8;
}

const SILHOUETTE_VERT = /* glsl */ `
  ${SHAPE_GLSL}
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
  uniform float uStarPx;
  uniform float uNebulaPx;
  uniform float uSuper;
  uniform float uFluxEps;
  uniform float uShineLGain;
  uniform float uShineLP;
  uniform float uShineDistRef;
  uniform float uShineDistP;
  uniform float uShineSat;
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
    // Cull wrong-kind sprites for the pass here — a fragment discard
    // still rasterizes the whole quad, tripling core overdraw. Dust
    // rows (kind > 3.5) are census-only and never pass either gate.
    if (dCat < uRegionR ||
        (uPass < 0.5 && aKind > 0.5) ||
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
      // Same point law as the local layer: one CSS pixel, L^P
      // intensity, teff colour. No glow sprite.
      float d = max(length(mv.xyz), 0.001);
      float L = max(aLum, 1e-4);
      vVis = aVis * uShineLGain * pow(L, uShineLP) * pow(uShineDistRef / d, uShineDistP);
      float lum = dot(aColor, vec3(0.2126, 0.7152, 0.0722));
      vColor = clamp(mix(vec3(lum), aColor, uShineSat), 0.0, 1.0);
      gl_PointSize = max(1.0, uPixel);
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
    if (uPass > 0.5 && (vKind < 0.5 || vKind > 3.5)) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    if (vKind < 0.5) {
      float I = max(vVis, 0.0);
      float peak = max(max(vColor.r, vColor.g), vColor.b);
      vec3 chroma = vColor / max(peak, 1e-4);
      if (vPx > 4.0) {
        // Only a disc once the pin has actually grown. Below this
        // the sprite is still a point of light.
        float r = length(p);
        if (r > 1.0) discard;
        float limb = 1.0 - 0.22 * r * r;
        float bright = I / (1.0 + 0.22 * I);
        gl_FragColor = vec4(chroma * limb * bright, 1.0);
        return;
      }
      float bright = I / (1.0 + I);
      if (bright < 0.008) discard;
      gl_FragColor = vec4(chroma * bright, 1.0);
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
      // Premultiplied for the screen blend — dest + src·(1-dest).
      // Stacks saturate; they do not add to a white bar.
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
  /** Exact occupied-slot population of the open region. */
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

  private starPts: THREE.Points | null = null;
  private starGeo: THREE.BufferGeometry | null = null;
  private starMat: THREE.ShaderMaterial | null = null;
  private starEmisPts: THREE.Points | null = null;
  private starEmisMat: THREE.ShaderMaterial | null = null;
  private starVis: THREE.BufferAttribute | null = null;
  private silPts: THREE.Points | null = null;
  private silGeo: THREE.BufferGeometry | null = null;
  private silMat: THREE.ShaderMaterial | null = null;
  private silEmisPts: THREE.Points | null = null;
  private silEmisMat: THREE.ShaderMaterial | null = null;
  /** Catalog positions (the vertex shader subtracts uCenter). */
  private cloud: StarCloud | null = null;
  private borderWorker: Worker | null = null;
  private borderGen = 0;
  private borderBusy = false;

  private camRot3 = new THREE.Matrix3();

  private pickRing: THREE.Mesh;
  private hereObj: GalaxyObject | null = null;

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
  private censusMemo: Record<string, number> = {};

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
    this.renderer.setClearColor(new THREE.Color('#070b14'), 1);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.001, regionCamFar());

    this.pickRing = this.makeRing(0xf4e4c1, 0.18);
    this.scene.add(this.pickRing);

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
  }

  setVisited(_ids: number[]): void {}

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
   * Open the catalog bubble around a world point. `select` is
   * pinned when the dive is a star. Flying slides this ball through
   * the catalog.
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
    // Backdrop is once-per-seed. Attach if the cache is already warm.
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
    this.select(select);
    this.applyCam();
    this.updateSight(true);
  }

  private disposeLocalStars(): void {
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
      uGlowMin: { value: PHOTO_MIN },
      uGlowDim: { value: GLOW_DIM },
      uMaxPx: { value: POINT_MAX_PX },
      uNearBoost: { value: POINT_NEAR_BOOST },
      uFluxEps: { value: POINT_FLUX_EPS },
      uPhotoK: { value: PHOTO_K },
      uPhotoP: { value: PHOTO_P },
      uPhotoMin: { value: PHOTO_MIN },
      uPhotoMax: { value: PHOTO_MAX },
      uPass: { value: 0 },
      ...this.shineUniforms(),
      ...this.dustUniforms(),
      ...this.extinctUniforms(),
    };
  }

  /** Point-source shine — L and distance. Shared by both layers. */
  private shineUniforms(): Record<string, THREE.IUniform> {
    return {
      uShineLGain: { value: SHINE_L_GAIN },
      uShineLP: { value: SHINE_L_P },
      uShineDistRef: { value: SHINE_DIST_REF },
      uShineDistP: { value: SHINE_DIST_P },
      uShineSat: { value: SHINE_SAT },
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
    return {
      uExtinctK: { value: UNIVERSE.GALAXY_EXTINCT_K },
      uExtinctMax: { value: UNIVERSE.GALAXY_EXTINCT_MAX },
      uDustRgb: { value: new THREE.Vector3(...UNIVERSE.GALAXY_DUST_RGB) },
    };
  }

  /**
   * Two passes per layer, one shared fragment: stars add light,
   * emission nebulae SCREEN (dest + src·(1-dest) — they glow but
   * cannot stack to a white bar). Dust has no pass: both vertex
   * shaders fold sightline extinction into every row.
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
      blendSrc: nebula ? THREE.OneMinusDstColorFactor : THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
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
    // In-bubble NEBULA envelopes stay OFF for now: nearby shells
    // rasterize hundreds of px each and every fragment marches the
    // turbulence field — a measured majority of the core-facing frame
    // (and the on-bubble nebulae had their own artefacts). The catalog
    // still mints them (HUD census, picking data stay honest); only the
    // draw pass is disabled. Re-enable by uncommenting once the march
    // budget scales with angular size. Dust needs no pass in either
    // layer: STAR_VERT folds the same sightline extinction into every
    // local row that SILHOUETTE_VERT applies to the backdrop.
    // const emisMat = this.makeCloudMaterial(STAR_VERT, this.localGlowUniforms(), 1);
    // const emisPts = new THREE.Points(geo, emisMat);
    // emisPts.frustumCulled = false;
    // emisPts.renderOrder = 1;
    // this.scene.add(emisPts);
    // this.starEmisPts = emisPts;
    // this.starEmisMat = emisMat;
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
      uSuper: { value: UNIVERSE.SILHOUETTE_SUPER_GAIN },
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
    // No dust pass: dust is not visible, it filters. The rows stay
    // minted (census, grain-tint check, future local layer) and the
    // per-pass kind gates cull them; the sightline extinction march
    // in SILHOUETTE_VERT is how dust reaches the eye.
    this.pushMagUniforms();
  }

  private cloudMats(): THREE.ShaderMaterial[] {
    const out: THREE.ShaderMaterial[] = [];
    for (const m of [this.starMat, this.starEmisMat, this.silMat, this.silEmisMat]) {
      if (m) out.push(m);
    }
    return out;
  }

  /** Catalog positions stay on the GPU; only the bubble centre moves. */
  private pushMagUniforms(): void {
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    for (const mat of this.cloudMats()) {
      mat.uniforms.uCenter.value.set(cx, cy, cz);
      mat.uniforms.uScale.value = 1;
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

  /** Local catalog stars close enough to lock the reticle. Smoke / HUD. */
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
   * Sit far enough that the disk diameter fits ~70% of the vertical
   * FOV. Catalog kpc — view is 1:1.
   */
  private overviewDistance(): number {
    const r = UNIVERSE.GALAXY_R_MAX;
    const half = ((this.camera.fov * Math.PI) / 180) * 0.35;
    return r / Math.max(1e-4, Math.tan(half));
  }

  private goOverview(kind: 'face' | 'edge'): void {
    this.rememberBack();
    this.overview = true;
    const d = this.overviewDistance();
    if (kind === 'face') {
      this.enterRegion(0, d, 0, null);
      this.aimAt(0, -1, 0);
    } else {
      // A few degrees above the plane so the dust sheet does not eat the disk.
      const elev = 0.14;
      const c = Math.cos(elev);
      const s = Math.sin(elev);
      this.enterRegion(d * c, d * s, 0, null);
      this.aimAt(-c, -s, 0);
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
    const off = UNIVERSE.GALAXY_REGION_R * 0.4;
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
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    const cat = cloud.pos;
    for (let i = 0; i < cloud.n; i += step) {
      if ((cloud.bits[i] & BIT_DUST) !== 0 || cloud.kind[i] === KIND_DUST) continue;
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
    this.borderWorker?.terminate();
    this.borderWorker = null;
    this.disposeArcStars();
    this.pickRing.geometry.dispose();
    (this.pickRing.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private resetThrust(): void {
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }

  /** Latch warp on (fixed cruise) or off (stop). A tap, not a hold. */
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
   * bubble centre slides. The GPU holds catalog positions — the
   * vertex shader subtracts uCenter. Membership is a shell walk
   * once the centre has moved MAG_SLIDE, run on a worker so the
   * frame only updates the centre uniform.
   */
  private moveBubble(vx: number, vy: number, vz: number, force = false): void {
    if (this.mode !== 'region' || !this.cloud) return;
    this.arcCenter.x += vx;
    this.arcCenter.y += vy;
    this.arcCenter.z += vz;
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

  /** Backdrop is minted once at app boot; attach the mesh if the cache is warm. */
  private attachSilhouette(): void {
    const go = (): void => {
      if (this.disposed) return;
      if (this.mode === 'region' && !this.silPts) this.buildSilhouetteStars();
    };
    if (silhouetteCloud(this.seed)) {
      go();
      return;
    }
    void prepareUniverse(this.seed).then(go);
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

  private pickCloud(cx: number, cy: number): GalaxyObject | null {
    const cloud = this.cloud;
    if (!cloud) return null;
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const rect = this.canvas.getBoundingClientRect();
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
      if ((bits[i] & BIT_DUST) !== 0 || (bits[i] & BIT_NEBULA) !== 0) {
        arr[i] = gain[i];
        continue;
      }
      // Stars: aVis is a filter. Intensity is L / d² in the shader.
      arr[i] = sketchMatches(bits[i], this.filter) ? 1 : 0.08;
    }
    this.starVis.needsUpdate = true;
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
      mat.uniforms.uPixel.value = px;
      mat.uniforms.uPxPerRad.value = pxPer;
      (mat.uniforms.uCamRotInv.value as THREE.Matrix3).copy(this.camRot3);
    }

    const cam = this.camera.position;
    const ringFor = (mesh: THREE.Mesh, lo: number, hi: number, k: number) => {
      const d = cam.distanceTo(mesh.position);
      mesh.scale.setScalar(Math.max(lo, Math.min(hi, d * k)));
    };
    ringFor(this.pickRing, 0.00035, 0.03, 0.045);
    this.pickRing.rotation.z = t * 0.35;

    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame?.({
      mode: this.mode,
      theta: this.theta,
      phi: this.phi,
      radius: UNIVERSE.GALAXY_REGION_R,
      pickable: true,
      resolved: this.cloud?.n ?? 0,
      grown: this.grownCount,
      sector: this.regionLabel,
      population: this.sectorPop,
      focus: this.focusHud,
      warp: this.thrustOn,
      backdrop: this.silPts ? (silhouetteCloud(this.seed)?.n ?? 0) : 0,
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}
