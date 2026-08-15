/**
 * The galaxy explorer: a two-level SECTOR MAP.
 *
 * MAP mode shows the saucer — a static mesh of annular-sector tiles
 * coloured by the density law (galaxySectors.ts) — plus markers for
 * home, the current system, visited systems, and ~100 deterministic
 * systems of interest. No stars are drawn on the map. The map camera
 * orbits the origin.
 *
 * ARC mode is one tapped "thick arc": every occupied slot is a point
 * (cheap birth, no evolve — the id is still the star). The camera is
 * free flight through that frozen cloud: look, strafe, dolly. There is
 * no orbit lock on the sector centre or the selection. Photosphere
 * discs mesh and grow with 1/distance up to STAR_ANG_MAX. A compact
 * sight HUD names the most-centred star; dark ones get a reticle.
 * Tap mints the full catalog row. Set course is the dossier button.
 *
 * Nothing in either mode queries or rebuilds the catalog per camera
 * move — the blink / cluster / stutter / re-roll failure class of the
 * old free-flight explorer is structurally impossible here.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, homeStar, objectAt, type GalaxyObject } from '../world/galaxy';
import { createSectorMap, type SectorMap } from './galaxySectors';
import {
  createStarDiscs,
  glowRadiusKpc,
  GLOW_DIM,
  GLOW_K,
  GLOW_P,
  RESOLVE_MAX,
  STAR_ANG_MAX,
  STAR_DISC_ANG,
  type StarDiscs,
} from './galaxyStar';
import { classifyStar } from '../world/stellar';
import { systemAt } from '../world/systemgen';
import {
  sectorCenter,
  sectorName,
  sectorOfPos,
  sectorSpan,
  systemsOfInterest,
  buildArcCloud,
  sketchMatches,
  MK_LETTER,
  BIT_REMNANT,
  type ArcCloud,
  type SectorId,
} from '../world/sectors';

/** Map-orbit radius range (kpc). */
const MAP_R_MIN = 9;
const MAP_R_MAX = 46;
const MAP_R_HOME = 34;
/** Arc-orbit radius, in units of the arc's own span. */
const ARC_R_FRAME = 1.7;
const ARC_R_EXIT = 4.2;
/** Sight cone for the centred-star HUD (cos 12°). */
const FOCUS_COS = 0.978;
/** Show the nameplate once the sighted star is this close (kpc). */
const FOCUS_HUD_DIST = 0.55;
/** Zoom is direct and gentle; one motion crosses at most this factor. */
const ZOOM_WHEEL_SENS = 0.0008;
const ZOOM_PINCH_POW = 0.7;
const ZOOM_GESTURE_SPAN = 2.6;

export type GalaxyMode = 'map' | 'arc';
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
  attribute float aLum;
  attribute float aPulse;
  attribute float aVis;
  uniform float uTime;
  uniform float uPxPerRad;
  varying vec3 vColor;
  varying float vPulse;
  void main() {
    vColor = aColor;
    float pulse = aPulse > 0.5 ? 0.55 + 0.45 * sin(uTime * 18.0 + position.x * 7.0) : 1.0;
    vPulse = pulse * aVis;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(0.003, -mv.z);
    float L = max(aLum, 1e-4);
    float rWorld = ${GLOW_K.toFixed(4)} * pow(L, ${GLOW_P.toFixed(2)});
    if (aLum < 0.05) rWorld = max(rWorld, ${GLOW_DIM.toFixed(4)});
    float ang = min(rWorld / dist, ${STAR_ANG_MAX.toFixed(3)});
    gl_PointSize = clamp(2.0 * ang * uPxPerRad, 1.0, 16.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vPulse;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 4.2);
    float halo = exp(-r2 * 1.15) * 0.35;
    float a = (core + halo) * vPulse;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor * (0.65 + 0.55 * core), a);
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
  /** True in arc mode (stars are tappable there). */
  pickable: boolean;
  /** Loaded arc stars (0 on the map). */
  resolved: number;
  discs: number;
  /** Arc label, e.g. "S37·R12" — null on the map. */
  sector: string | null;
  /** Exact occupied-slot population of the open arc (0 on the map). */
  population: number;
  /** Most-centred star in the sight, when close enough. */
  focus: GalaxyFocus | null;
}

export interface SectorSelection {
  id: SectorId;
  name: string;
  population: number;
}

interface Callbacks {
  onSelect: (obj: GalaxyObject | null) => void;
  /** Tap a photosphere disc — set course to that star. */
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
  /** Stars loaded for the open arc (empty on the map). */
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
  private sectorSel: SectorId | null = null;
  private sectorPop = 0;
  private sectors: SectorMap;
  private discs: StarDiscs;
  private discIds = new Set<number>();
  private lastSightAt = 0;
  private focusObj: GalaxyObject | null = null;
  private focusHud: GalaxyFocus | null = null;
  private focusHoldId = -1;
  private focusHoldScore = 0;
  private briefMemo = new Map<number, { name: string; planets: number; moons: number; life: boolean }>();

  private starPts: THREE.Points | null = null;
  private starGeo: THREE.BufferGeometry | null = null;
  private starMat: THREE.ShaderMaterial | null = null;
  private starVis: THREE.BufferAttribute | null = null;
  private cloud: ArcCloud | null = null;

  private visitedMk: MarkerSet | null = null;
  private interestMk: MarkerSet | null = null;

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

  /** Arc free-flight pose (world kpc). Unused on the map. */
  private arcPos = new THREE.Vector3();
  private arcYaw = 0;
  private arcPitch = -0.6;
  private arcCenter = new THREE.Vector3();
  private arcFwd = new THREE.Vector3();
  private arcRight = new THREE.Vector3();
  private arcUp = new THREE.Vector3();
  private arcLook = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private keys = new Set<string>();
  private panBtn = 0;
  private pinchMidX = 0;
  private pinchMidY = 0;
  private enteredAt = 0;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private gestureR = 0;
  private lastZoomAt = 0;
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

    this.discs = createStarDiscs();
    this.discs.group.visible = false;
    this.scene.add(this.discs.group);

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
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

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

  // ------------------------------------------------------------- arc mode

  /** Open one thick arc: draw every occupied slot, dive the camera. */
  enterArc(id: SectorId, select: GalaxyObject | null = null): void {
    this.disposeArcStars();
    this.mode = 'arc';
    this.sectorSel = id;
    this.sectors.setSelected(id);
    const cloud = buildArcCloud(this.seed, id);
    this.cloud = cloud;
    this.sectorPop = cloud.n;
    this.lastEnterMs = cloud.ms;
    this.objects = [];
    this.buildArcStars();
    this.censusMemo = {};

    const c = galToCart(sectorCenter(id));
    const span = sectorSpan(id);
    this.arcCenter.set(c.x, c.y, c.z);
    const r = span * ARC_R_FRAME;
    const phi = 0.9;
    const th = this.tgtTheta;
    this.arcPos.set(
      c.x + r * Math.sin(phi) * Math.cos(th),
      c.y + r * Math.cos(phi),
      c.z + r * Math.sin(phi) * Math.sin(th),
    );
    const aim = select ? galToCart(select.pos) : c;
    this.aimAt(aim.x, aim.y, aim.z);
    this.enteredAt = performance.now();
    this.idle = 0;
    this.camera.near = 0.001;
    this.camera.updateProjectionMatrix();
    this.discs.group.visible = true;
    this.sectors.group.visible = false;
    if (this.visitedMk) this.visitedMk.pts.visible = false;
    if (this.interestMk) this.interestMk.pts.visible = false;
    this.select(select);
    this.applyCam();
    this.updateSight(true);
  }

  /** Back to the saucer. The arc's stars are dropped; the map is static. */
  exitArc(): void {
    if (this.mode !== 'arc') return;
    this.mode = 'map';
    this.disposeArcStars();
    this.objects = [];
    this.cloud = null;
    this.sectorPop = 0;
    this.focusObj = null;
    this.focusHud = null;
    this.focusHoldId = -1;
    this.focusHoldScore = 0;
    this.censusMemo = {};
    this.discs.setStars([], this.camera.position);
    this.discs.group.visible = false;
    this.discIds.clear();
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
    this.camera.updateProjectionMatrix();
    // Keep the last arc highlighted as a breadcrumb on the map.
  }

  private disposeArcStars(): void {
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

  private buildArcStars(): void {
    const cloud = this.cloud;
    const n = Math.max(1, cloud?.n ?? 0);
    const pos = cloud ? cloud.pos : new Float32Array(3);
    const col = cloud ? cloud.col : new Float32Array(3);
    const lum = cloud ? cloud.lum : new Float32Array(1);
    const pulse = cloud ? cloud.pulse : new Float32Array(1);
    const vis = new Float32Array(n);
    if (cloud) {
      for (let i = 0; i < cloud.n; i++) vis[i] = cloud.gain[i];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aLum', new THREE.BufferAttribute(lum, 1));
    geo.setAttribute('aPulse', new THREE.BufferAttribute(pulse, 1));
    const visAttr = new THREE.BufferAttribute(vis, 1);
    geo.setAttribute('aVis', visAttr);
    if (!cloud || cloud.n === 0) geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: { value: 0 }, uPxPerRad: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    this.starPts = pts;
    this.starGeo = geo;
    this.starMat = mat;
    this.starVis = visAttr;
  }

  // --------------------------------------------------------------- state

  setFilter(f: GalaxyFilter): void {
    this.filter = f;
    this.censusMemo = {};
    if (this.mode === 'arc') this.updateSight(true);
    else this.applyStarVis();
  }

  dismiss(): void {
    this.select(null);
  }

  canPick(): boolean {
    return this.mode === 'arc';
  }

  currentMode(): GalaxyMode {
    return this.mode;
  }

  currentSector(): SectorSelection | null {
    if (!this.sectorSel) return null;
    return { id: this.sectorSel, name: sectorName(this.sectorSel), population: this.sectorPop };
  }

  selectedObject(): GalaxyObject | null {
    return this.selected;
  }

  /** Class census of the open arc (cheap MK from the birth clock). */
  census(): Record<string, number> {
    if (Object.keys(this.censusMemo).length > 0) return this.censusMemo;
    const c: Record<string, number> = {};
    const cloud = this.cloud;
    if (!cloud) {
      this.censusMemo = c;
      return c;
    }
    for (let i = 0; i < cloud.n; i++) {
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

  /** Photospheres currently meshed — the stars that left the point LOD. */
  resolvedStars(): GalaxyObject[] {
    return this.discs.list();
  }

  setPreset(p: GalaxyPreset): void {
    if (p === 'home') {
      const obj = this.hereObj ?? this.home;
      if (obj) this.focus(obj);
      return;
    }
    this.exitArc();
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

  /** Open the arc containing a star and select it. */
  focus(obj: GalaxyObject): void {
    this.enterArc(sectorOfPos(obj.pos), obj);
  }

  /**
   * Jump next to a pinned star (selected, here, or home) inside its
   * arc, close enough that its photosphere can mesh. Smoke / tests.
   */
  approachNearest(): GalaxyObject | null {
    const best = this.selected ?? this.hereObj ?? this.home;
    if (!best) return null;
    this.focus(best);
    const c = galToCart(best.pos);
    this.arcPos.set(c.x + 0.028, c.y + 0.018, c.z + 0.012);
    this.aimAt(c.x, c.y, c.z);
    this.applyCam();
    this.updateSight(true);
    return best;
  }

  focusedObject(): GalaxyObject | null {
    return this.focusObj;
  }

  /** Resize meshed discs to the live camera — smoke / tests. */
  syncArc(): void {
    if (this.mode === 'arc') this.discs.syncCamera(this.camera);
  }

  /** Apparent angle (rad) of a meshed disc — smoke proves stars grow. */
  discApparent(id: number): number {
    const r = this.discs.radiusOf(id);
    if (r <= 0) return 0;
    const o = objectAt(this.seed, id);
    if (!o) return 0;
    const c = galToCart(o.pos);
    const dist = Math.hypot(c.x - this.arcPos.x, c.y - this.arcPos.y, c.z - this.arcPos.z);
    return r / Math.max(1e-5, dist);
  }

  /**
   * An on-screen cloud star that is not a disc — smoke proves the
   * full field is tappable, not just the brightest 28.
   */
  probePointStar(): { id: number; x: number; y: number } | null {
    const cloud = this.cloud;
    if (!cloud) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const step = Math.max(1, Math.floor(cloud.n / 4000));
    for (let i = 0; i < cloud.n; i += step) {
      if (this.discIds.has(cloud.ids[i])) continue;
      if (!sketchMatches(cloud.bits[i], this.filter)) continue;
      const x = cloud.pos[i * 3];
      const y = cloud.pos[i * 3 + 1];
      const z = cloud.pos[i * 3 + 2];
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
   * Rotate the look in place. Smoke uses this to prove overview discs
   * do not appear just because the camera turned.
   */
  orbitBy(dTheta: number, dPhi = 0): void {
    if (this.mode === 'arc') {
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

  /** Translate along the current look. Smoke / WASD. */
  flyAlong(kpc: number): void {
    if (this.mode !== 'arc') return;
    this.orientArc();
    this.arcPos.addScaledVector(this.arcFwd, kpc);
    this.applyCam();
    this.maybeExitArc();
  }

  /** Translate along camera right. Smoke: proves we are not on a radial lock. */
  flyStrafe(kpc: number): void {
    if (this.mode !== 'arc') return;
    this.orientArc();
    this.arcPos.addScaledVector(this.arcRight, kpc);
    this.applyCam();
    this.maybeExitArc();
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
    this.disposeArcStars();
    for (const mk of [this.visitedMk, this.interestMk]) {
      if (!mk) continue;
      mk.geo.dispose();
      mk.mat.dispose();
    }
    this.sectors.dispose();
    this.discs.dispose();
    this.homeRing.geometry.dispose();
    (this.homeRing.material as THREE.Material).dispose();
    this.hereRing.geometry.dispose();
    (this.hereRing.material as THREE.Material).dispose();
    this.pickRing.geometry.dispose();
    (this.pickRing.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private select(obj: GalaxyObject | null): void {
    this.selected = obj;
    if (obj) {
      const c = galToCart(obj.pos);
      this.pickRing.position.set(c.x, c.y, c.z);
      this.pickRing.visible = true;
    } else {
      this.pickRing.visible = false;
    }
    this.callbacks.onSelect(obj);
  }

  // ------------------------------------------------------------- camera

  private aimAt(x: number, y: number, z: number): void {
    const dx = x - this.arcPos.x;
    const dy = y - this.arcPos.y;
    const dz = z - this.arcPos.z;
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

  private applyCam(): void {
    if (this.mode === 'arc') {
      this.orientArc();
      this.camera.position.copy(this.arcPos);
      this.camera.up.copy(this.arcUp);
      this.arcLook.copy(this.arcPos).add(this.arcFwd);
      this.camera.lookAt(this.arcLook);
      this.radius = this.arcPos.distanceTo(this.arcCenter);
      this.theta = this.arcYaw;
      this.phi = Math.PI / 2 - this.arcPitch;
      this.look.copy(this.arcLook);
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

  /** Cruise speed from nearest sampled star (and the arc centre). */
  private arcPace(): number {
    const cloud = this.cloud;
    const cx = this.arcPos.x;
    const cy = this.arcPos.y;
    const cz = this.arcPos.z;
    let minD = this.arcPos.distanceTo(this.arcCenter);
    if (cloud) {
      const step = Math.max(1, Math.floor(cloud.n / 6000));
      const pos = cloud.pos;
      for (let i = 0; i < cloud.n; i += step) {
        const d = Math.hypot(pos[i * 3] - cx, pos[i * 3 + 1] - cy, pos[i * 3 + 2] - cz);
        if (d < minD) minD = d;
      }
    }
    if (this.selected) {
      const c = galToCart(this.selected.pos);
      minD = Math.min(minD, Math.hypot(c.x - cx, c.y - cy, c.z - cz));
    }
    return THREE.MathUtils.clamp(0.42 * minD, 0.005, 0.65);
  }

  private maybeExitArc(): void {
    if (this.mode !== 'arc' || !this.sectorSel) return;
    if (performance.now() - this.enteredAt < 250) return;
    if (this.arcPos.distanceTo(this.arcCenter) > sectorSpan(this.sectorSel) * ARC_R_EXIT) {
      this.exitArc();
    }
  }

  /**
   * Map: scale the orbit radius toward what is already framed.
   * Arc: dolly along the look — no lock point.
   */
  private zoom(factor: number): void {
    const now = performance.now();
    this.idle = 0;
    if (this.mode === 'arc') {
      this.orientArc();
      const pace = this.arcPace();
      this.arcPos.addScaledVector(this.arcFwd, -Math.log(Math.max(1e-4, factor)) * pace * 2.2);
      this.applyCam();
      this.maybeExitArc();
      this.lastZoomAt = now;
      return;
    }
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
    const c = galToCart(obj.pos);
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
      const arc = this.sectors.pick(this.raycaster);
      if (arc) this.enterArc(arc);
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
    const pos = cloud.pos;
    const bits = cloud.bits;
    const ids = cloud.ids;
    let bestI = -1;
    let bestD = 22;
    for (let i = 0; i < cloud.n; i++) {
      if (!sketchMatches(bits[i], this.filter)) continue;
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
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
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI < 0) return null;
    return objectAt(this.seed, ids[bestI]);
  }

  // ------------------------------------------------------------- input

  private onDown = (e: PointerEvent): void => {
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
      this.pinchMidX = (pts[0].x + pts[1].x) * 0.5;
      this.pinchMidY = (pts[0].y + pts[1].y) * 0.5;
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
      const mx = (pts[0].x + pts[1].x) * 0.5;
      const my = (pts[0].y + pts[1].y) * 0.5;
      if (this.pinch0 > 0) {
        const ratio = d / Math.max(1e-3, this.pinch0);
        this.zoom(Math.pow(1 / Math.max(0.2, ratio), ZOOM_PINCH_POW));
      }
      if (this.mode === 'arc') {
        this.strafePixels(mx - this.pinchMidX, my - this.pinchMidY);
      }
      this.pinch0 = d;
      this.pinchMidX = mx;
      this.pinchMidY = my;
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
    const strafe = this.mode === 'arc' && (this.panBtn === 1 || this.panBtn === 2 || e.shiftKey);
    if (strafe) {
      this.strafePixels(dx, dy);
      return;
    }
    if (this.mode === 'arc') {
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
    if (this.mode !== 'arc') return;
    this.orientArc();
    const dist = Math.max(0.02, this.arcPace() * 8);
    const worldH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5);
    const wpp = worldH / Math.max(1, this.canvas.clientHeight);
    this.arcPos.addScaledVector(this.arcRight, -dx * wpp);
    this.arcPos.addScaledVector(this.arcUp, dy * wpp);
    this.applyCam();
    this.maybeExitArc();
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
    const fly =
      e.code === 'KeyW' ||
      e.code === 'KeyA' ||
      e.code === 'KeyS' ||
      e.code === 'KeyD' ||
      e.code === 'KeyQ' ||
      e.code === 'KeyE' ||
      e.code === 'Space' ||
      e.code === 'KeyC' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight';
    if (fly && this.mode === 'arc') e.preventDefault();
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private steerArc(dt: number): void {
    let mx = 0;
    let my = 0;
    let mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1;
    if (this.keys.has('KeyQ') || this.keys.has('KeyC')) my -= 1;
    if (mx === 0 && my === 0 && mz === 0) return;
    this.orientArc();
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
    const pace = this.arcPace() * boost;
    this.arcPos.addScaledVector(this.arcRight, mx * pace * dt);
    this.arcPos.addScaledVector(this.arcUp, my * pace * dt);
    this.arcPos.addScaledVector(this.arcFwd, mz * pace * dt);
    this.maybeExitArc();
    this.idle = 0;
  }

  // --------------------------------------------------------------- discs

  /**
   * Mesh photospheres that have grown past a point sprite, and lock the
   * sight onto the most-centred star. One walk of the frozen cloud.
   */
  private updateSight(force = false): void {
    if (this.mode !== 'arc') return;
    const now = performance.now();
    if (!force && now - this.lastSightAt < 50) return;
    this.lastSightAt = now;
    const cloud = this.cloud;
    const near: GalaxyObject[] = [];
    const seen = new Set<number>();
    const take = (o: GalaxyObject | null): void => {
      if (!o || seen.has(o.id) || near.length >= RESOLVE_MAX) return;
      if (!matchesFilter(o, this.filter) && o !== this.selected && o !== this.focusObj) return;
      seen.add(o.id);
      near.push(o);
    };

    this.orientArc();
    const cx = this.arcPos.x;
    const cy = this.arcPos.y;
    const cz = this.arcPos.z;
    const fx = this.arcFwd.x;
    const fy = this.arcFwd.y;
    const fz = this.arcFwd.z;
    const discBest: Array<{ id: number; app: number }> = [];
    const considerDisc = (sid: number, app: number) => {
      if (discBest.length < RESOLVE_MAX) {
        discBest.push({ id: sid, app });
        if (discBest.length === RESOLVE_MAX) discBest.sort((a, b) => a.app - b.app);
        return;
      }
      if (app <= discBest[0].app) return;
      discBest[0] = { id: sid, app };
      discBest.sort((a, b) => a.app - b.app);
    };

    let sightId = -1;
    let sightScore = -1;
    let sightDist = 0;
    let sightDark = false;
    if (cloud) {
      const pos = cloud.pos;
      const lum = cloud.lum;
      const bits = cloud.bits;
      const ids = cloud.ids;
      for (let i = 0; i < cloud.n; i++) {
        if (!sketchMatches(bits[i], this.filter)) continue;
        const dx = pos[i * 3] - cx;
        const dy = pos[i * 3 + 1] - cy;
        const dz = pos[i * 3 + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-12) continue;
        const dist = Math.sqrt(d2);
        const dim = (bits[i] & BIT_REMNANT) !== 0 || lum[i] < 0.05;
        const rWorld = glowRadiusKpc(lum[i], dim);
        const ang = rWorld / dist;
        if (ang >= STAR_DISC_ANG) considerDisc(ids[i], ang);
        const along = (dx * fx + dy * fy + dz * fz) / dist;
        if (along < FOCUS_COS || dist > 1.4) continue;
        const off = 1 - along;
        const score = ang / (0.002 + off * 8);
        if (score > sightScore) {
          sightScore = score;
          sightId = ids[i];
          sightDist = dist;
          sightDark = dim;
        }
      }
    }

    if (
      this.focusHoldId >= 0 &&
      sightId >= 0 &&
      sightId !== this.focusHoldId &&
      sightScore < this.focusHoldScore * 1.25
    ) {
      sightId = this.focusHoldId;
      const held = objectAt(this.seed, sightId);
      if (held) {
        const c = galToCart(held.pos);
        sightDist = Math.hypot(c.x - cx, c.y - cy, c.z - cz);
        sightDark =
          held.star.phase === 'white_dwarf' ||
          held.star.phase === 'neutron_star' ||
          held.star.phase === 'pulsar' ||
          held.star.phase === 'black_hole' ||
          held.star.luminosity < 0.05;
      }
    }

    if (this.selected) {
      const c = galToCart(this.selected.pos);
      const dist = Math.hypot(c.x - cx, c.y - cy, c.z - cz);
      const dim =
        this.selected.star.phase === 'white_dwarf' ||
        this.selected.star.phase === 'neutron_star' ||
        this.selected.star.phase === 'pulsar' ||
        this.selected.star.phase === 'black_hole' ||
        this.selected.star.luminosity < 0.05;
      if (glowRadiusKpc(this.selected.star.luminosity, dim) / Math.max(1e-4, dist) >= STAR_DISC_ANG) {
        take(this.selected);
      }
    }
    discBest.sort((a, b) => b.app - a.app);
    for (const b of discBest) {
      if (near.length >= RESOLVE_MAX) break;
      take(objectAt(this.seed, b.id));
    }
    if (sightId >= 0) take(objectAt(this.seed, sightId));

    this.objects = near;
    this.discs.setStars(near, this.camera.position);
    this.discs.syncCamera(this.camera);
    this.discIds.clear();
    for (const o of near) this.discIds.add(o.id);
    this.applyStarVis();
    this.setFocus(sightId, sightDist, sightDark, sightScore);
  }

  private setFocus(id: number, dist: number, dark: boolean, score: number): void {
    if (id < 0 || dist > FOCUS_HUD_DIST * 1.6) {
      this.focusObj = null;
      this.focusHud = null;
      this.focusHoldId = -1;
      this.focusHoldScore = 0;
      return;
    }
    const obj = objectAt(this.seed, id);
    if (!obj) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    this.focusHoldId = id;
    this.focusHoldScore = score;
    this.focusObj = obj;
    const close = dist <= FOCUS_HUD_DIST || dark;
    if (!close) {
      this.focusHud = null;
      return;
    }
    const brief = this.briefFor(obj);
    const proj = this.projectClient(obj);
    const rect = this.canvas.getBoundingClientRect();
    const st = obj.star;
    const dim =
      dark ||
      st.phase === 'white_dwarf' ||
      st.phase === 'neutron_star' ||
      st.phase === 'pulsar' ||
      st.phase === 'black_hole' ||
      st.luminosity < 0.05;
    this.focusHud = {
      id: obj.id,
      name: brief.name,
      cls: classifyStar(st),
      phase: st.phase.replace(/_/g, ' '),
      planets: brief.planets,
      moons: brief.moons,
      life: brief.life,
      dark: dim,
      x: proj ? proj.x - rect.left : rect.width * 0.5,
      y: proj ? proj.y - rect.top : rect.height * 0.5,
      dist,
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

  /** Points under a disc hide; filter-mismatched points dim. */
  private applyStarVis(): void {
    if (!this.starVis || !this.cloud) return;
    const arr = this.starVis.array as Float32Array;
    const { ids, bits, gain, n } = this.cloud;
    for (let i = 0; i < n; i++) {
      if (this.discIds.has(ids[i])) arr[i] = 0;
      else arr[i] = sketchMatches(bits[i], this.filter) ? gain[i] : gain[i] * 0.08;
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
    if (this.mode === 'arc') {
      this.steerArc(dt);
      this.applyCam();
      this.updateSight();
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
    if (this.starMat) {
      this.starMat.uniforms.uTime.value = t;
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      this.starMat.uniforms.uPxPerRad.value =
        (this.canvas.clientHeight * px) / Math.max(1e-4, 2 * Math.tan(fov * 0.5));
    }
    if (this.mode === 'arc') this.discs.syncCamera(this.camera);

    const cam = this.camera.position;
    const ringFor = (mesh: THREE.Mesh, lo: number, hi: number, k: number) => {
      const d = cam.distanceTo(mesh.position);
      mesh.scale.setScalar(Math.max(lo, Math.min(hi, d * k)));
    };
    if (this.mode === 'arc') {
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
      pickable: this.mode === 'arc',
      resolved: this.cloud?.n ?? 0,
      discs: this.discIds.size,
      sector: this.sectorSel ? sectorName(this.sectorSel) : null,
      population: this.sectorPop,
      focus: this.mode === 'arc' ? this.focusHud : null,
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}
