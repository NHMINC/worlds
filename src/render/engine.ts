import * as THREE from 'three';
import { frequencyForSize, getGrid, type GeoGrid } from '../world/geodesic';
import { createToyGenerator, MAX_LEVEL, snowLineFor, waterLevelFor } from '../world/toygen';
import { SPACE_COLOR } from '../world/toyPalette';
import { TerraceJob, makeTerrainMaterial, makeWaterMaterial } from './terraceMesh';
import { makeGasGiant } from './gasGiant';
import type { BodySpec, SystemSpec } from '../world/systemgen';
import { homeBodyId } from '../world/systemgen';
import type { BiomeId, SavedCamera } from '../world/types';

export type Tool = 'pan' | 'label' | 'object';
export type RigMode = 'orbit' | 'flight';

/** Rough physical fiction: one GL unit ≈ 8 km (a size-100 world radius). */
export const KM_PER_UNIT = 8;

export interface FlightHud {
  /** Nearest body (or the tapped target when one is set). */
  bodyId: string;
  bodyName: string;
  distanceKm: number;
  /** Close enough that "enter orbit" is available. */
  canOrbit: boolean;
  speedKmS: number;
}

export interface ViewState {
  mode: RigMode;
  /** Orbit: the body being orbited. Flight: the nearest body. */
  bodyId: string;
  bodyName: string;
  /** 0 whole-body framed .. 1 fully zoomed in (orbit mode; 0 in flight). */
  zNorm: number;
  width: number;
  height: number;
  flight: FlightHud | null;
}

export interface Mood {
  group: 'water' | 'green' | 'dry' | 'cold' | 'rock' | 'space';
  /** 0 at whole-world zoom, 1 fully zoomed in. */
  density: number;
}

/** A cell projected to screen space for the labels overlay. */
export interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
  /** Fades toward 0 as the point rolls over the body's limb. */
  alpha: number;
}

export interface EngineCallbacks {
  onFrame(view: ViewState): void;
  onTap(tool: Tool, bodyId: string, cell: number): void;
  onCameraSettled(cam: SavedCamera): void;
  /**
   * Fired after applyEdits merges terrain overrides, with the body's full
   * override set (absolute levels) ready to persist.
   */
  onTerrainEdited(bodyId: string, overrides: Map<number, number>): void;
}

/** Per-body player state fed into loadSystem. */
export interface BodyOverrides {
  temp?: number;
  seaLevel?: number;
  /** Absolute level overrides: effectiveLevel = override ?? generated. */
  terrain?: Map<number, number>;
}

/** Vertical field of view, degrees. */
const FOV = 42;
const TAP_SLOP_PX = 7;

/**
 * Terrace ramp half-width in level units: the hard-steps ↔ soft-hills dial.
 */
const TERRACE_ROUNDING = 0.3;

/** LOD ranges (world units to the body's surface) and budgets. */
const TIER1_DIST = 45;
const TIER2_DIST = 7;
const MAX_TIER2 = 2;
const MAX_TIER1 = 5;
const BUILD_BUDGET_MS = 6;

/** Flight tuning. */
const CAPTURE_DIST = 8; // dSurf within which orbit capture is offered
const FLIGHT_STEER = 0.0032; // rad per pixel
const BLEND_SEC = 1.3;

/** Starfield radius; camera far plane must exceed it. */
const STARS_R = 340;
const CAM_FAR = 700;

function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function smoothstep(lo: number, hi: number, x: number): number {
  return smoothstep01((x - lo) / (hi - lo));
}

/** GL radius per onion level, capped (same fiction as the single-world era). */
function stepFor(grid: GeoGrid): number {
  return Math.min(grid.cellSpacing() / 5, 0.012);
}

/** Soft radial glow for the sun sprite. */
function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255, 246, 220, 1)');
  grad.addColorStop(0.22, 'rgba(255, 228, 170, 0.55)');
  grad.addColorStop(0.55, 'rgba(255, 196, 130, 0.16)');
  grad.addColorStop(1, 'rgba(255, 196, 130, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

const ATMO_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vNormal = normalize(position);
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ATMO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;   // body-local
uniform vec3 uLightDir; // body-local
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vec3 view = normalize(uCamPos - vPos);
  float rim = 1.0 - abs(dot(vNormal, view));
  float a = pow(smoothstep(0.42, 1.0, rim), 2.2);
  float sun = 0.18 + 0.82 * smoothstep(-0.35, 0.55, dot(vNormal, uLightDir));
  gl_FragColor = vec4(vec3(0.56, 0.76, 0.94) * a * sun, a * sun);
}
`;

function makeAtmoMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ATMO_VERT,
    fragmentShader: ATMO_FRAG,
    uniforms: {
      uCamPos: { value: new THREE.Vector3(0, 0, 3) },
      uLightDir: { value: new THREE.Vector3(1, 0, 0) },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

interface PointerInfo {
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface TierAssets {
  root: THREE.Group;
  terrainMat: THREE.ShaderMaterial;
  waterMat: THREE.ShaderMaterial;
  atmoMat?: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
}

interface BuildTask {
  bodyId: string;
  tier: 1 | 2;
  job: TerraceJob;
}

/** Runtime state per body: spec + scene nodes + lazily built LOD tiers. */
interface BodyRT {
  spec: BodySpec;
  group: THREE.Group;
  tier0: THREE.Object3D;
  gasMat: THREE.ShaderMaterial | null;
  orbitLine: THREE.Object3D | null;
  /** Rocky-world data (lazy): grid, merged levels, dials. */
  grid: GeoGrid | null;
  levels: Uint8Array | null;
  waterLevel: number;
  snowLine: number;
  step: number;
  peakH: number;
  tier1: TierAssets | null;
  tier2: TierAssets | null;
  /** World pose this frame. */
  pos: THREE.Vector3;
  spinQ: THREE.Quaternion;
  lastNear: number;
}

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private callbacks: EngineCallbacks;
  private canvas: HTMLCanvasElement;

  private system: SystemSpec | null = null;
  private bodies = new Map<string, BodyRT>();
  private overrides = new Map<string, BodyOverrides>();
  private systemRoot = new THREE.Group();
  private sunGroup = new THREE.Group();
  private buildQueue: BuildTask[] = [];

  /** Wall-clock system time: orbits keep turning between sessions. */
  private readonly epoch = Date.now() / 1000 - performance.now() / 1000;

  private width = 1;
  private height = 1;

  // ---- orbit rig (poses live in the current body's spinning frame) ----
  private mode: RigMode = 'orbit';
  private orbitBodyId = '';
  private orient = new THREE.Quaternion();
  private h = 2;
  private hTarget = 2;
  private zoomAnchor: { sx: number; sy: number; dir: THREE.Vector3 } | null = null;
  private angVel = new THREE.Vector3();
  private northAnim: { from: THREE.Quaternion; to: THREE.Quaternion; t: number } | null = null;

  // ---- flight rig (world space) ----
  private fPos = new THREE.Vector3(0, 0, 30);
  private fQuat = new THREE.Quaternion();
  private throttle = 0;
  private speed = 0;
  private flightTarget: string | null = null;
  private keys = new Set<string>();

  /** Capture/depart blend: interpolates camera to a live orbit pose. */
  private blend: { t: number; fromPos: THREE.Vector3; fromQuat: THREE.Quaternion } | null = null;

  private tool: Tool = 'pan';
  private pointers = new Map<number, PointerInfo>();
  private pinch: { dist: number; dir: THREE.Vector3 } | null = null;
  private grabDir: THREE.Vector3 | null = null;
  private lastMoveAt = 0;

  private lastFrame = 0;
  private cameraDirtySince = 0;
  private disposed = false;

  private raycaster = new THREE.Raycaster();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpV3 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(new THREE.Color(SPACE_COLOR), 1);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, CAM_FAR);

    this.buildStars();
    this.scene.add(this.systemRoot);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- static scene

  private buildStars(): void {
    const makeStars = (count: number, size: number, bright: number): THREE.Points => {
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const z = 2 * Math.random() - 1;
        const a = 2 * Math.PI * Math.random();
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        pos[i * 3] = STARS_R * r * Math.cos(a);
        pos[i * 3 + 1] = STARS_R * r * Math.sin(a);
        pos[i * 3 + 2] = STARS_R * z;
        const b = bright * (0.45 + 0.55 * Math.random());
        const warm = Math.random() * 0.25;
        col[i * 3] = b;
        col[i * 3 + 1] = b * (1 - warm * 0.3);
        col[i * 3 + 2] = b * (1 - warm);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size,
          sizeAttenuation: false,
          vertexColors: true,
          transparent: true,
          depthWrite: false,
        }),
      );
    };
    this.scene.add(makeStars(900, 1.6, 0.6), makeStars(140, 2.8, 1));
    // Faint cool fill so tier-0 balls' night sides stay readable.
    this.scene.add(new THREE.AmbientLight(0x30384a, 0.6));
  }

  // ---------------------------------------------------------------- system load

  loadSystem(
    spec: SystemSpec,
    state: { cam?: SavedCamera; overrides?: Map<string, BodyOverrides> },
  ): void {
    // Tear down the previous system.
    for (const rt of this.bodies.values()) this.disposeBody(rt);
    this.bodies.clear();
    this.systemRoot.clear();
    this.sunGroup.clear();
    this.buildQueue = [];
    this.system = spec;
    this.overrides = state.overrides ?? new Map();

    // The sun.
    const sunGlobe = new THREE.Mesh(
      new THREE.SphereGeometry(1, 40, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(spec.star.color) }),
    );
    sunGlobe.scale.setScalar(spec.star.radius);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.scale.setScalar(spec.star.radius * 7);
    const sunLight = new THREE.PointLight(new THREE.Color(spec.star.lightColor), 2.5, 0, 0);
    this.sunGroup.add(sunGlobe, halo, sunLight);
    this.systemRoot.add(this.sunGroup);

    // Bodies: tier-0 spheres for everyone, gas shader balls for the giants,
    // faint orbit rings for orientation.
    for (const b of spec.bodies) {
      const group = new THREE.Group();
      group.scale.setScalar(b.radius);
      let tier0: THREE.Object3D;
      let gasMat: THREE.ShaderMaterial | null = null;
      if (b.kind === 'gas') {
        const gg = makeGasGiant(b.gas!);
        tier0 = gg.group;
        gasMat = gg.material;
      } else {
        tier0 = new THREE.Mesh(
          new THREE.SphereGeometry(1, 28, 18),
          new THREE.MeshLambertMaterial({ color: new THREE.Color(...b.meanColor) }),
        );
      }
      group.add(tier0);
      this.systemRoot.add(group);

      let orbitLine: THREE.Object3D | null = null;
      const segs = 128;
      const pts = new Float32Array(segs * 3);
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * 2 * Math.PI;
        pts[i * 3] = Math.cos(a) * b.orbitRadius;
        pts[i * 3 + 1] = Math.sin(a) * b.orbitRadius;
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      orbitLine = new THREE.LineLoop(
        lineGeo,
        new THREE.LineBasicMaterial({
          color: 0x8fa8cc,
          transparent: true,
          opacity: b.parent ? 0.08 : 0.11,
          depthWrite: false,
        }),
      );
      this.systemRoot.add(orbitLine);

      this.bodies.set(b.id, {
        spec: b,
        group,
        tier0,
        gasMat,
        orbitLine,
        grid: null,
        levels: null,
        waterLevel: 12.4,
        snowLine: 24,
        step: 0.012,
        peakH: 0.2,
        tier1: null,
        tier2: null,
        pos: new THREE.Vector3(),
        spinQ: new THREE.Quaternion(),
        lastNear: 0,
      });
    }
    this.updateBodyPoses(this.epoch + performance.now() / 1000);

    // Restore the camera, or open in orbit around the home world.
    const cam = state.cam;
    if (cam?.mode === 'flight') {
      this.mode = 'flight';
      this.fPos.fromArray(cam.pos);
      this.fQuat.fromArray(cam.q).normalize();
      this.throttle = 0;
      this.speed = 0;
    } else if (cam?.mode === 'orbit' && this.bodies.has(cam.bodyId)) {
      this.mode = 'orbit';
      this.orbitBodyId = cam.bodyId;
      this.orient.fromArray(cam.q).normalize();
      this.prepareBodyData(this.bodies.get(cam.bodyId)!);
      this.h = this.hTarget = this.clampH(cam.d - 1);
    } else {
      this.mode = 'orbit';
      this.orbitBodyId = homeBodyId(spec);
      this.orient.copy(this.defaultOrient());
      this.prepareBodyData(this.bodies.get(this.orbitBodyId)!);
      this.h = this.hTarget = this.hPlanet();
    }
    this.angVel.set(0, 0, 0);
    this.zoomAnchor = null;
    this.northAnim = null;
    this.blend = null;
    this.flightTarget = null;
  }

  /** Re-key overrides after external changes (dials, terrain) and rebuild. */
  setOverrides(bodyId: string, o: BodyOverrides, terrainChanged = false): void {
    this.overrides.set(bodyId, o);
    const rt = this.bodies.get(bodyId);
    if (!rt || rt.spec.kind !== 'rocky') return;
    const { temp, sea } = this.effective(bodyId);
    // Temperature only moves the snow line — a uniform, not geometry.
    if (!terrainChanged && rt.levels && waterLevelFor(sea) === rt.waterLevel) {
      rt.snowLine = snowLineFor(temp, rt.waterLevel);
      for (const assets of [rt.tier1, rt.tier2]) {
        if (assets) assets.terrainMat.uniforms.uSnowLine.value = rt.snowLine;
      }
      return;
    }
    // Geometry change: rebuild, keeping the current mesh visible until the
    // replacement lands (attachTier swaps in place).
    const had2 = rt.tier2 !== null;
    const had1 = rt.tier1 !== null;
    rt.grid = null;
    rt.levels = null;
    this.prepareBodyData(rt);
    if (had1) this.ensureTier(rt, 1, true);
    if (had2) this.ensureTier(rt, 2, true);
  }

  /**
   * Addressable-universe write path: absolute level overrides for cells on a
   * body, applied over the generated terrain and rebuilt asynchronously.
   */
  applyEdits(bodyId: string, edits: Array<{ cell: number; level: number }>): void {
    const o = this.overrides.get(bodyId) ?? {};
    const terrain = o.terrain ?? new Map<number, number>();
    for (const e of edits) terrain.set(e.cell, Math.max(0, Math.min(MAX_LEVEL, e.level)));
    o.terrain = terrain;
    this.setOverrides(bodyId, o, true);
    this.callbacks.onTerrainEdited(bodyId, terrain);
  }

  // ---------------------------------------------------------------- body data & tiers

  private effective(bodyId: string): { temp: number; sea: number } {
    const rt = this.bodies.get(bodyId);
    const o = this.overrides.get(bodyId);
    return {
      temp: o?.temp ?? rt?.spec.temp ?? 0.5,
      sea: o?.seaLevel ?? rt?.spec.seaLevel ?? 0.5,
    };
  }

  /** Build the merged (generated + overridden) level field and dials. */
  private prepareBodyData(rt: BodyRT): void {
    if (rt.spec.kind !== 'rocky' || rt.levels) return;
    const f = frequencyForSize(rt.spec.size);
    rt.grid = getGrid(f);
    const gen = createToyGenerator(rt.spec.seed);
    const levels = new Uint8Array(rt.grid.count);
    for (let i = 0; i < rt.grid.count; i++) {
      levels[i] = gen.levelAt(
        rt.grid.centers[i * 3],
        rt.grid.centers[i * 3 + 1],
        rt.grid.centers[i * 3 + 2],
      );
    }
    const terrain = this.overrides.get(rt.spec.id)?.terrain;
    if (terrain) {
      for (const [cell, level] of terrain) {
        if (cell >= 0 && cell < levels.length) levels[cell] = level;
      }
    }
    rt.levels = levels;
    const { temp, sea } = this.effective(rt.spec.id);
    rt.waterLevel = waterLevelFor(sea);
    rt.snowLine = snowLineFor(temp, rt.waterLevel);
    rt.step = stepFor(rt.grid);
    rt.peakH = (MAX_LEVEL - rt.waterLevel) * rt.step;
  }

  /** Queue a tier build if missing (or force a rebuild of a live tier). */
  private ensureTier(rt: BodyRT, tier: 1 | 2, force = false): void {
    if (rt.spec.kind !== 'rocky') return;
    if (!force && ((tier === 1 && rt.tier1) || (tier === 2 && rt.tier2))) return;
    const queued = this.buildQueue.findIndex((t) => t.bodyId === rt.spec.id && t.tier === tier);
    if (queued >= 0) {
      if (!force) return;
      this.buildQueue.splice(queued, 1);
    }
    this.prepareBodyData(rt);
    const f = frequencyForSize(rt.spec.size);
    const renderGrid = tier === 2 ? getGrid(Math.min(128, f * 4)) : getGrid(f);
    const job = new TerraceJob(rt.grid!, renderGrid, rt.levels!, {
      waterLevel: rt.waterLevel,
      step: rt.step,
      rounding: TERRACE_ROUNDING,
    });
    this.buildQueue.push({ bodyId: rt.spec.id, tier, job });
  }

  /** Spend the frame's build budget on the front of the queue. */
  private processBuilds(): void {
    const task = this.buildQueue[0];
    if (!task) return;
    const rt = this.bodies.get(task.bodyId);
    if (!rt) {
      this.buildQueue.shift();
      return;
    }
    if (task.job.step(BUILD_BUDGET_MS)) {
      this.buildQueue.shift();
      this.attachTier(rt, task.tier, task.job.finish());
    }
  }

  /** Wire a finished terrace geometry into the body's group as a LOD tier. */
  private attachTier(rt: BodyRT, tier: 1 | 2, geometry: THREE.BufferGeometry): void {
    const root = new THREE.Group();
    const terrainMat = makeTerrainMaterial();
    terrainMat.uniforms.uSnowLine.value = rt.snowLine;
    terrainMat.uniforms.uWaterLevel.value = rt.waterLevel;
    terrainMat.uniforms.uWarpFreq.value = 2.2 / rt.grid!.cellSpacing();
    const terrain = new THREE.Mesh(geometry, terrainMat);
    terrain.renderOrder = 0;
    root.add(terrain);

    const waterMat = makeWaterMaterial();
    waterMat.uniforms.uWaveFreq.value = 9 / rt.grid!.cellSpacing();
    const water = new THREE.Mesh(
      new THREE.SphereGeometry(1, tier === 2 ? 96 : 48, tier === 2 ? 64 : 32),
      waterMat,
    );
    water.renderOrder = 5;
    root.add(water);

    let atmoMat: THREE.ShaderMaterial | undefined;
    if (tier === 2) {
      atmoMat = makeAtmoMaterial();
      const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.26, 64, 40), atmoMat);
      atmo.renderOrder = 10;
      root.add(atmo);
    }

    rt.group.add(root);
    const assets: TierAssets = { root, terrainMat, waterMat, atmoMat, geometry };
    if (tier === 2) {
      this.dropTier(rt, 2);
      rt.tier2 = assets;
    } else {
      this.dropTier(rt, 1);
      rt.tier1 = assets;
    }
    this.refreshTierVisibility(rt);
  }

  private dropTier(rt: BodyRT, tier: 1 | 2): void {
    const assets = tier === 2 ? rt.tier2 : rt.tier1;
    if (!assets) return;
    rt.group.remove(assets.root);
    assets.geometry.dispose();
    assets.terrainMat.dispose();
    assets.waterMat.dispose();
    assets.atmoMat?.dispose();
    for (const child of assets.root.children) {
      if (child instanceof THREE.Mesh && child.geometry !== assets.geometry) child.geometry.dispose();
    }
    if (tier === 2) rt.tier2 = null;
    else rt.tier1 = null;
    this.refreshTierVisibility(rt);
  }

  /** Highest built tier wins; the flat ball backs everything. */
  private refreshTierVisibility(rt: BodyRT): void {
    if (rt.tier2) {
      rt.tier2.root.visible = true;
      if (rt.tier1) rt.tier1.root.visible = false;
      rt.tier0.visible = false;
    } else if (rt.tier1) {
      rt.tier1.root.visible = true;
      rt.tier0.visible = false;
    } else {
      rt.tier0.visible = true;
    }
  }

  /** Promote/demote tiers by proximity, with small caps and LRU eviction. */
  private updateLod(camPos: THREE.Vector3, now: number): void {
    let tier2Count = 0;
    let tier1Count = 0;
    for (const rt of this.bodies.values()) {
      if (rt.spec.kind !== 'rocky') continue;
      const dSurf = camPos.distanceTo(rt.pos) - rt.spec.radius;
      const wantTier2 =
        (this.mode === 'orbit' && rt.spec.id === this.orbitBodyId) || dSurf < TIER2_DIST;
      const wantTier1 = dSurf < TIER1_DIST;
      if (wantTier1 || wantTier2) rt.lastNear = now;
      if (wantTier2) {
        this.ensureTier(rt, 2);
      } else if (rt.tier2 && dSurf > TIER2_DIST * 2.2 && rt.spec.id !== this.orbitBodyId) {
        this.dropTier(rt, 2);
      }
      if (wantTier1) {
        this.ensureTier(rt, 1);
      } else if (rt.tier1 && dSurf > TIER1_DIST * 1.6) {
        this.dropTier(rt, 1);
      }
      if (rt.tier2) tier2Count++;
      if (rt.tier1) tier1Count++;
    }
    // Caps: evict the least recently near.
    if (tier2Count > MAX_TIER2 || tier1Count > MAX_TIER1) {
      const rts = [...this.bodies.values()]
        .filter((r) => r.spec.kind === 'rocky')
        .sort((a, b) => a.lastNear - b.lastNear);
      for (const rt of rts) {
        if (tier2Count > MAX_TIER2 && rt.tier2 && rt.spec.id !== this.orbitBodyId) {
          this.dropTier(rt, 2);
          tier2Count--;
        }
        if (tier1Count > MAX_TIER1 && rt.tier1 && rt.spec.id !== this.orbitBodyId) {
          this.dropTier(rt, 1);
          tier1Count--;
        }
      }
    }
  }

  private disposeBody(rt: BodyRT): void {
    this.dropTier(rt, 1);
    this.dropTier(rt, 2);
    rt.gasMat?.dispose();
  }

  // ---------------------------------------------------------------- orbital mechanics

  /** Position and spin every body for system time t (seconds). */
  private updateBodyPoses(t: number): void {
    if (!this.system) return;
    for (const rt of this.bodies.values()) {
      const b = rt.spec;
      const oa = b.orbitPhase + (2 * Math.PI * t) / b.orbitPeriod;
      const ox = Math.cos(oa) * b.orbitRadius;
      const oy = Math.sin(oa) * b.orbitRadius;
      if (b.parent) {
        const parent = this.bodies.get(b.parent)!;
        rt.pos.set(parent.pos.x + ox, parent.pos.y + oy, parent.pos.z);
        rt.orbitLine?.position.copy(parent.pos);
      } else {
        rt.pos.set(ox, oy, 0);
      }
      // Tidally locked bodies keep one face toward the parent; free bodies
      // spin on their own clock.
      const spin = b.tidallyLocked ? oa + Math.PI : (2 * Math.PI * t) / b.spinPeriod;
      rt.spinQ.setFromAxisAngle(this.tmpV.set(0, 0, 1), spin);
      rt.group.position.copy(rt.pos);
      rt.group.quaternion.copy(rt.spinQ);
    }
  }

  private currentBody(): BodyRT | null {
    return this.bodies.get(this.orbitBodyId) ?? null;
  }

  /** Default view: equator at longitude 0, north up. */
  private defaultOrient(): THREE.Quaternion {
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    );
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  // ---------------------------------------------------------------- zoom bounds (orbit)

  /** Height (body-local units) framing the whole globe with margin. */
  private hPlanet(): number {
    const halfY = (FOV * Math.PI) / 360;
    const halfX = Math.atan(Math.tan(halfY) * (this.width / this.height));
    const half = Math.min(halfX, halfY);
    return 1.18 / Math.sin(half) - 1;
  }

  /** Orbit zoom-out limit; wheeling past it departs into flight. */
  private hMax(): number {
    return this.hPlanet() * 4;
  }

  private hMin(): number {
    const rt = this.currentBody();
    if (!rt) return 0.3;
    if (rt.spec.kind === 'gas') return 1.4;
    return Math.max(3.2 * (rt.grid?.cellSpacing() ?? 0.05), rt.peakH + 0.05);
  }

  private clampH(h: number): number {
    return Math.min(this.hMax(), Math.max(this.hMin(), h));
  }

  /** Body-local units (surface arc) per screen pixel at the sub-camera point. */
  private worldPerPx(): number {
    return (2 * this.h * Math.tan((FOV * Math.PI) / 360)) / this.height;
  }

  setTool(tool: Tool): void {
    this.tool = tool;
  }

  getView(): ViewState {
    const rt = this.mode === 'orbit' ? this.currentBody() : this.nearestBody();
    const name = rt?.spec.name ?? '';
    let zNorm = 0;
    if (this.mode === 'orbit') {
      const hi = this.hPlanet();
      const lo = this.hMin();
      zNorm = Math.min(1, Math.max(0, Math.log(hi / this.h) / Math.log(hi / lo)));
    }
    let flight: FlightHud | null = null;
    if (this.mode === 'flight') {
      const target = this.flightTarget ? this.bodies.get(this.flightTarget) ?? null : null;
      const shown = target ?? rt;
      if (shown) {
        const dSurf = Math.max(0, this.fPos.distanceTo(shown.pos) - shown.spec.radius);
        flight = {
          bodyId: shown.spec.id,
          bodyName: shown.spec.name,
          distanceKm: dSurf * KM_PER_UNIT,
          canOrbit: dSurf < Math.max(CAPTURE_DIST, shown.spec.radius * 4),
          speedKmS: Math.abs(this.speed) * KM_PER_UNIT,
        };
      }
    }
    return {
      mode: this.mode,
      bodyId: rt?.spec.id ?? '',
      bodyName: name,
      zNorm,
      width: this.width,
      height: this.height,
      flight,
    };
  }

  // ---------------------------------------------------------------- terrain queries

  private biomeOfLevel(rt: BodyRT, level: number): BiomeId {
    const w = rt.waterLevel;
    if (level >= rt.snowLine) return 'snow';
    if (level < w - 6) return 'deep';
    if (level < w - 2) return 'ocean';
    if (level < w) return 'shallow';
    if (level < w + 1.6) return 'beach';
    if (level < 19) return 'grassland';
    if (level < 23) return 'forest';
    return 'mountain';
  }

  biomeAt(bodyId: string, cell: number): BiomeId {
    const rt = this.bodies.get(bodyId);
    if (!rt || !rt.levels) return 'grassland';
    return this.biomeOfLevel(rt, rt.levels[cell]);
  }

  /** Body roster for UI (names, kinds); source of truth is the spec. */
  bodyName(bodyId: string): string {
    return this.bodies.get(bodyId)?.spec.name ?? '';
  }

  getMood(): Mood {
    const view = this.getView();
    if (this.mode === 'flight') return { group: 'space', density: 0 };
    const rt = this.currentBody();
    if (!rt || rt.spec.kind !== 'rocky' || !rt.levels || !rt.grid) {
      return { group: rt?.spec.kind === 'gas' ? 'space' : 'green', density: view.zNorm };
    }
    const c = this.tmpV.set(0, 0, 1).applyQuaternion(this.orient);
    const d = 1 + this.h;
    const horizon = Math.acos(Math.min(1, 1 / d));
    const rho = Math.min(horizon, this.h * Math.tan((FOV * Math.PI) / 360) * 1.2);
    const u = this.tmpV2.set(0, 0, 1).cross(c);
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(c, u);
    const groups: Record<Exclude<Mood['group'], 'space'>, number> = {
      water: 0, green: 0, dry: 0, cold: 0, rock: 0,
    };
    const K = 48;
    for (let i = 0; i < K; i++) {
      const r = rho * Math.sqrt((i + 0.5) / K);
      const phi = i * 2.399963;
      const sr = Math.sin(r);
      const px = c.x * Math.cos(r) + sr * (u.x * Math.cos(phi) + v.x * Math.sin(phi));
      const py = c.y * Math.cos(r) + sr * (u.y * Math.cos(phi) + v.y * Math.sin(phi));
      const pz = c.z * Math.cos(r) + sr * (u.z * Math.cos(phi) + v.z * Math.sin(phi));
      const level = rt.levels[rt.grid.nearestCell(px, py, pz)];
      if (level >= rt.snowLine) groups.cold++;
      else if (level < rt.waterLevel) groups.water++;
      else if (level < rt.waterLevel + 1.6) groups.dry++;
      else if (level >= 23) groups.rock++;
      else groups.green++;
    }
    let best: Mood['group'] = 'green';
    let bestN = -1;
    for (const [g, n] of Object.entries(groups) as Array<[Mood['group'], number]>) {
      if (n > bestN) {
        best = g;
        bestN = n;
      }
    }
    return { group: best, density: view.zNorm };
  }

  // ---------------------------------------------------------------- view controls

  viewLetterbox(): void {
    if (this.mode !== 'orbit') return;
    this.hTarget = this.hPlanet();
    this.zoomAnchor = null;
    this.angVel.set(0, 0, 0);
  }

  viewFitHeight(): void {
    if (this.mode !== 'orbit') return;
    const halfY = (FOV * Math.PI) / 360;
    this.hTarget = this.clampH(1 / Math.sin(halfY) - 1);
    this.zoomAnchor = null;
    this.angVel.set(0, 0, 0);
  }

  resetNorth(): void {
    if (this.mode !== 'orbit') return;
    const c = new THREE.Vector3(0, 0, 1).applyQuaternion(this.orient);
    let up = new THREE.Vector3(0, 0, 1).addScaledVector(c, -c.z);
    if (up.lengthSq() < 1e-6) up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.orient);
    up.normalize();
    const x = new THREE.Vector3().crossVectors(up, c);
    const m = new THREE.Matrix4().makeBasis(x, up, c);
    const to = new THREE.Quaternion().setFromRotationMatrix(m);
    this.northAnim = { from: this.orient.clone(), to, t: 0 };
    this.angVel.set(0, 0, 0);
  }

  // ---------------------------------------------------------------- mode transitions

  /** Leave orbit: become a ship at the current camera pose, engines idle. */
  depart(): void {
    if (this.mode !== 'orbit' || this.blend) return;
    this.updateCamera();
    this.fPos.copy(this.camera.position);
    this.fQuat.copy(this.camera.quaternion);
    this.throttle = 0;
    this.speed = 0;
    this.mode = 'flight';
    this.flightTarget = null;
    this.cameraDirtySince = performance.now();
  }

  /**
   * Capture into orbit around a body (nearest in range when unspecified):
   * the flight pose blends into a live orbit pose over ~a second.
   */
  enterOrbit(bodyId?: string): void {
    if (this.mode !== 'flight' || this.blend) return;
    let rt = bodyId ? this.bodies.get(bodyId) : null;
    if (!rt) {
      rt = this.nearestBody();
      if (!rt) return;
      const dSurf = this.fPos.distanceTo(rt.pos) - rt.spec.radius;
      if (dSurf > Math.max(CAPTURE_DIST, rt.spec.radius * 4)) return;
    }
    this.orbitBodyId = rt.spec.id;
    this.prepareBodyData(rt);

    // Orbit pose from the arrival direction, in the body's spinning frame.
    const rel = this.tmpV.copy(this.fPos).sub(rt.pos).divideScalar(rt.spec.radius);
    const d = rel.length();
    const qInv = this.tmpQ.copy(rt.spinQ).conjugate();
    const dirLocal = this.tmpV2.copy(rel).applyQuaternion(qInv).normalize();
    let up = new THREE.Vector3(0, 0, 1).addScaledVector(dirLocal, -dirLocal.z);
    if (up.lengthSq() < 1e-6) up = new THREE.Vector3(0, 1, 0);
    up.normalize();
    const x = new THREE.Vector3().crossVectors(up, dirLocal);
    this.orient.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, dirLocal));
    this.h = this.hTarget = this.clampH(d - 1);

    this.blend = {
      t: 0,
      fromPos: this.fPos.clone(),
      fromQuat: this.fQuat.clone(),
    };
    this.mode = 'orbit';
    this.angVel.set(0, 0, 0);
    this.zoomAnchor = null;
    this.flightTarget = null;
    this.cameraDirtySince = performance.now();
  }

  private nearestBody(): BodyRT | null {
    let best: BodyRT | null = null;
    let bestD = Infinity;
    for (const rt of this.bodies.values()) {
      const d = this.fPos.distanceTo(rt.pos) - rt.spec.radius;
      if (d < bestD) {
        bestD = d;
        best = rt;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- camera

  /** Orbit camera pose in world space, derived from the body-local rig. */
  private orbitCamPose(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const rt = this.currentBody()!;
    const local = this.tmpV.set(0, 0, 1 + this.h).applyQuaternion(this.orient);
    outPos.copy(local).applyQuaternion(rt.spinQ).multiplyScalar(rt.spec.radius).add(rt.pos);
    const up = this.tmpV2.set(0, 1, 0).applyQuaternion(this.orient).applyQuaternion(rt.spinQ);
    const m = new THREE.Matrix4().lookAt(outPos, rt.pos, up);
    outQuat.setFromRotationMatrix(m);
  }

  private updateCamera(): void {
    if (this.mode === 'orbit' && this.currentBody()) {
      const rt = this.currentBody()!;
      this.orbitCamPose(this.tmpV3, this.tmpQ2);
      if (this.blend) {
        const e = smoothstep01(this.blend.t);
        this.camera.position.lerpVectors(this.blend.fromPos, this.tmpV3, e);
        this.camera.quaternion.slerpQuaternions(this.blend.fromQuat, this.tmpQ2, e);
      } else {
        this.camera.position.copy(this.tmpV3);
        this.camera.quaternion.copy(this.tmpQ2);
      }
      this.camera.near = Math.min(2, Math.max(0.0004, this.h * 0.2 * rt.spec.radius));
    } else {
      this.camera.position.copy(this.fPos);
      this.camera.quaternion.copy(this.fQuat);
      const near = this.nearestBody();
      const dSurf = near ? Math.max(0.02, this.fPos.distanceTo(near.pos) - near.spec.radius) : 5;
      this.camera.near = Math.min(2, Math.max(0.001, dSurf * 0.2));
    }
    this.camera.fov = FOV;
    this.camera.aspect = this.width / this.height;
    this.camera.far = CAM_FAR;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    if (this.mode === 'orbit' && this.currentBody()) {
      this.h = this.clampH(this.h);
      this.hTarget = this.clampH(this.hTarget);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const rt of this.bodies.values()) this.disposeBody(rt);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- picking

  /**
   * Camera ray under a screen pixel, transformed into the current body's
   * spinning unit-radius frame — all the trackball math lives there.
   */
  private localRay(sx: number, sy: number, oOut: THREE.Vector3, dOut: THREE.Vector3): void {
    this.raycaster.setFromCamera(
      new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1),
      this.camera,
    );
    const rt = this.currentBody()!;
    const qInv = this.tmpQ.copy(rt.spinQ).conjugate();
    oOut.copy(this.raycaster.ray.origin).sub(rt.pos).applyQuaternion(qInv).divideScalar(rt.spec.radius);
    dOut.copy(this.raycaster.ray.direction).applyQuaternion(qInv).normalize();
  }

  /**
   * Direction of the unit-sphere point under a pixel (body-local). Falls back
   * to the ray's nearest point to the core so drags stay smooth past the limb.
   */
  private hitSphere(sx: number, sy: number, out: THREE.Vector3): boolean {
    const o = this.tmpV3;
    const u = new THREE.Vector3();
    this.localRay(sx, sy, o, u);
    const b = o.dot(u);
    const disc = b * b - (o.dot(o) - 1);
    if (disc >= 0) {
      const t = -b - Math.sqrt(disc);
      out.copy(o).addScaledVector(u, t).normalize();
      return true;
    }
    out.copy(o).addScaledVector(u, -b).normalize();
    return false;
  }

  /** Data cell under a pixel on the current orbit body, or −1. */
  pickCell(sx: number, sy: number): number {
    const rt = this.currentBody();
    if (this.mode !== 'orbit' || !rt?.grid) return -1;
    this.updateCamera();
    const hit = this.hitSphere(sx, sy, this.tmpV);
    if (!hit) return -1;
    return rt.grid.nearestCell(this.tmpV.x, this.tmpV.y, this.tmpV.z);
  }

  /** Body under a pixel in flight mode (generous sphere pick), or null. */
  private pickBody(sx: number, sy: number): BodyRT | null {
    this.raycaster.setFromCamera(
      new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1),
      this.camera,
    );
    const o = this.raycaster.ray.origin;
    const u = this.raycaster.ray.direction;
    let best: BodyRT | null = null;
    let bestT = Infinity;
    for (const rt of this.bodies.values()) {
      const r = rt.spec.radius * 1.4;
      const oc = this.tmpV.copy(o).sub(rt.pos);
      const b = oc.dot(u);
      const disc = b * b - (oc.dot(oc) - r * r);
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t > 0 && t < bestT) {
        bestT = t;
        best = rt;
      }
    }
    return best;
  }

  /** Project a data cell of a body to screen space for the labels overlay. */
  projectCell(bodyId: string, cell: number): ProjectedPoint {
    const rt = this.bodies.get(bodyId);
    if (!rt?.grid || this.mode !== 'orbit' || bodyId !== this.orbitBodyId) {
      return { x: 0, y: 0, visible: false, alpha: 0 };
    }
    const cx = rt.grid.centers[cell * 3];
    const cy = rt.grid.centers[cell * 3 + 1];
    const cz = rt.grid.centers[cell * 3 + 2];
    const d = 1 + this.h;
    // Facing test in the body-local frame.
    const qInv = this.tmpQ.copy(rt.spinQ).conjugate();
    const camL = this.tmpV2.copy(this.camera.position).sub(rt.pos).applyQuaternion(qInv).normalize();
    const facing = cx * camL.x + cy * camL.y + cz * camL.z;
    const horizon = 1 / d;
    if (facing < horizon) return { x: 0, y: 0, visible: false, alpha: 0 };
    const world = this.tmpV
      .set(cx, cy, cz)
      .applyQuaternion(rt.spinQ)
      .multiplyScalar(rt.spec.radius)
      .add(rt.pos)
      .project(this.camera);
    const x = (world.x * 0.5 + 0.5) * this.width;
    const y = (-world.y * 0.5 + 0.5) * this.height;
    const visible = x > -160 && x < this.width + 160 && y > -80 && y < this.height + 80;
    const alpha = smoothstep(horizon, horizon + 0.12 * (1 - horizon), facing);
    return { x, y, visible, alpha };
  }

  // ---------------------------------------------------------------- input

  /** Rotate the rig so the surface point under (sx, sy) becomes `target`. */
  private rotateGrabTo(sx: number, sy: number, target: THREE.Vector3): THREE.Quaternion {
    this.updateCamera();
    this.hitSphere(sx, sy, this.tmpV);
    this.tmpQ2.setFromUnitVectors(this.tmpV, target);
    this.orient.premultiply(this.tmpQ2).normalize();
    this.cameraDirtySince = performance.now();
    return this.tmpQ2;
  }

  private onPointerDown = (e: PointerEvent): void => {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events may carry an unknown pointerId; capture is optional.
    }
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    this.pointers.set(e.pointerId, { x: sx, y: sy, startX: sx, startY: sy, moved: false });
    this.angVel.set(0, 0, 0);
    this.northAnim = null;

    if (this.mode !== 'orbit' || this.blend) return;

    if (this.pointers.size === 2) {
      this.grabDir = null;
      const [a, b] = [...this.pointers.values()];
      const dir = new THREE.Vector3();
      this.updateCamera();
      this.hitSphere((a.x + b.x) / 2, (a.y + b.y) / 2, dir);
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), dir };
      return;
    }

    this.updateCamera();
    const dir = new THREE.Vector3();
    this.hitSphere(sx, sy, dir);
    this.grabDir = dir;
    this.lastMoveAt = performance.now();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const dx = sx - info.x;
    const dy = sy - info.y;
    info.x = sx;
    info.y = sy;
    if (Math.hypot(sx - info.startX, sy - info.startY) > TAP_SLOP_PX) info.moved = true;

    // Flight: dragging steers the ship.
    if (this.mode === 'flight' && !this.blend && this.pointers.size === 1 && (e.buttons & (1 | 2 | 4)) !== 0) {
      const yaw = this.tmpQ.setFromAxisAngle(this.tmpV.set(0, 1, 0), -dx * FLIGHT_STEER);
      const pitch = this.tmpQ2.setFromAxisAngle(this.tmpV.set(1, 0, 0), -dy * FLIGHT_STEER);
      this.fQuat.multiply(yaw).multiply(pitch).normalize();
      this.cameraDirtySince = performance.now();
      return;
    }

    if (this.mode !== 'orbit' || this.blend) return;

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const factor = dist / Math.max(1, this.pinch.dist);
      this.h = this.hTarget = this.clampH(this.h / factor);
      // Keep the grabbed surface point glued to the finger midpoint.
      this.rotateGrabTo(midX, midY, this.pinch.dir);
      this.pinch.dist = dist;
      return;
    }

    if (this.grabDir && this.pointers.size === 1 && (e.buttons & (1 | 2 | 4)) !== 0) {
      const now = performance.now();
      const dt = Math.max(1 / 240, (now - this.lastMoveAt) / 1000);
      this.lastMoveAt = now;
      const q = this.rotateGrabTo(sx, sy, this.grabDir);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      if (angle > 1e-6) {
        const s = Math.sqrt(Math.max(1e-12, 1 - q.w * q.w));
        const sign = q.w < 0 ? -1 : 1;
        this.tmpV2.set((q.x / s) * sign, (q.y / s) * sign, (q.z / s) * sign)
          .multiplyScalar(angle / dt);
        this.angVel.lerp(this.tmpV2, 0.45);
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const info = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.grabDir = null;
    if (!info || info.moved || e.button !== 0) return;

    if (this.mode === 'flight' && !this.blend) {
      // Tap a body: within range, capture into orbit; farther, set target.
      const rt = this.pickBody(info.x, info.y);
      if (rt) {
        const dSurf = this.fPos.distanceTo(rt.pos) - rt.spec.radius;
        if (dSurf < Math.max(CAPTURE_DIST, rt.spec.radius * 4)) this.enterOrbit(rt.spec.id);
        else this.flightTarget = rt.spec.id;
      } else {
        this.flightTarget = null;
      }
      return;
    }

    if (this.mode === 'orbit' && (this.tool === 'label' || this.tool === 'object')) {
      const cell = this.pickCell(info.x, info.y);
      if (cell >= 0) this.callbacks.onTap(this.tool, this.orbitBodyId, cell);
      this.angVel.set(0, 0, 0);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.blend) return;
    if (this.mode === 'flight') {
      this.throttle = Math.min(1, Math.max(-0.3, this.throttle - e.deltaY * 0.0009));
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // Wheeling out past the orbit limit releases the ship into flight.
    if (e.deltaY > 0 && this.hTarget >= this.hMax() * 0.999) {
      this.depart();
      this.throttle = -0.25;
      return;
    }
    this.hTarget = this.clampH(this.hTarget * Math.exp(e.deltaY * 0.0016));
    this.updateCamera();
    const dir = new THREE.Vector3();
    this.hitSphere(sx, sy, dir);
    this.zoomAnchor = { sx, sy, dir };
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  // ---------------------------------------------------------------- frame

  private frame = (now: number): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.system) return;

    const tSys = this.epoch + now / 1000;
    this.updateBodyPoses(tSys);

    if (this.blend) {
      this.blend.t = Math.min(1, this.blend.t + dt / BLEND_SEC);
      if (this.blend.t >= 1) this.blend = null;
    }

    if (this.mode === 'orbit' && this.currentBody()) {
      // Smooth zoom toward target, keeping the anchor point under the cursor.
      if (Math.abs(this.h - this.hTarget) > this.hTarget * 0.0005) {
        const k = 1 - Math.exp(-dt * 10);
        this.h += (this.hTarget - this.h) * k;
        if (Math.abs(this.h - this.hTarget) < this.hTarget * 0.0005) this.h = this.hTarget;
        if (this.zoomAnchor && !this.blend) {
          this.rotateGrabTo(this.zoomAnchor.sx, this.zoomAnchor.sy, this.zoomAnchor.dir);
        }
        this.cameraDirtySince = now;
      } else {
        this.zoomAnchor = null;
      }

      // Spin inertia.
      const speedPx = this.angVel.length() / this.worldPerPx();
      if (speedPx > 2 && this.pointers.size === 0 && !this.blend) {
        const angle = this.angVel.length() * dt;
        this.tmpQ.setFromAxisAngle(this.tmpV.copy(this.angVel).normalize(), angle);
        this.orient.premultiply(this.tmpQ).normalize();
        this.angVel.multiplyScalar(Math.exp(-dt * 3.2));
        this.cameraDirtySince = now;
      }

      // Reset-north swing.
      if (this.northAnim) {
        this.northAnim.t = Math.min(1, this.northAnim.t + dt / 0.55);
        const ease = smoothstep01(this.northAnim.t);
        this.orient.slerpQuaternions(this.northAnim.from, this.northAnim.to, ease);
        if (this.northAnim.t >= 1) this.northAnim = null;
        this.cameraDirtySince = now;
      }
    } else if (this.mode === 'flight') {
      // Throttle from held keys.
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
        this.throttle = Math.min(1, this.throttle + dt * 0.8);
      }
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
        this.throttle = Math.max(-0.3, this.throttle - dt * 0.8);
      }
      if (this.keys.has('KeyX')) this.throttle = 0;

      // Distance-scaled cruise: fast across the void, gentle near ground.
      const near = this.nearestBody();
      const dSurf = near ? Math.max(0.05, this.fPos.distanceTo(near.pos) - near.spec.radius) : 20;
      const vMax = Math.min(55, Math.max(0.35, 0.45 + 0.85 * dSurf));
      const targetSpeed = this.throttle * vMax;
      this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * 4));
      if (Math.abs(this.speed) > 1e-4) {
        const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(this.fQuat);
        this.fPos.addScaledVector(fwd, this.speed * dt);
        this.cameraDirtySince = now;
      }
      // Soft floor: the ship can never be inside a body.
      for (const rt of this.bodies.values()) {
        const minD = rt.spec.radius * 1.12;
        const d = this.tmpV.copy(this.fPos).sub(rt.pos);
        if (d.lengthSq() < minD * minD) {
          this.fPos.copy(rt.pos).addScaledVector(d.normalize(), minD);
        }
      }
      const sunMin = this.system.star.radius * 2.2;
      if (this.fPos.lengthSq() < sunMin * sunMin) {
        this.fPos.normalize().multiplyScalar(sunMin);
      }
    }

    // Autosave the camera once it settles.
    if (this.cameraDirtySince && now - this.cameraDirtySince > 800 && this.pointers.size === 0 && !this.blend) {
      this.cameraDirtySince = 0;
      this.callbacks.onCameraSettled(
        this.mode === 'orbit'
          ? {
              mode: 'orbit',
              bodyId: this.orbitBodyId,
              q: this.orient.toArray() as [number, number, number, number],
              d: 1 + this.h,
            }
          : {
              mode: 'flight',
              pos: this.fPos.toArray() as [number, number, number],
              q: this.fQuat.toArray() as [number, number, number, number],
            },
      );
    }

    this.updateCamera();
    this.updateLod(this.camera.position, now);
    this.processBuilds();

    // Per-body lighting and shader clocks. The sun sits at the origin, so a
    // body's light direction is just its position, seen from its own
    // spinning frame — the terminator sweeps as each world turns.
    const shaderT = (now / 1000) * 40;
    for (const rt of this.bodies.values()) {
      // Orbit lines are wayfinding for the void: hide a body's own line when
      // the camera is close, so it never slices across the world's face.
      if (rt.orbitLine) {
        const dSurf = this.camera.position.distanceTo(rt.pos) - rt.spec.radius;
        rt.orbitLine.visible = dSurf > rt.spec.radius * 3 + 2;
      }
      const qInv = this.tmpQ.copy(rt.spinQ).conjugate();
      const lightL = this.tmpV.copy(rt.pos).multiplyScalar(-1).normalize().applyQuaternion(qInv);
      if (rt.gasMat) {
        (rt.gasMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
        rt.gasMat.uniforms.uTime.value = shaderT * 0.35;
      }
      for (const assets of [rt.tier1, rt.tier2]) {
        if (!assets) continue;
        (assets.terrainMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
        (assets.waterMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
        assets.terrainMat.uniforms.uTime.value = shaderT;
        assets.waterMat.uniforms.uTime.value = shaderT;
        const camL = this.tmpV2
          .copy(this.camera.position)
          .sub(rt.pos)
          .applyQuaternion(qInv)
          .divideScalar(rt.spec.radius);
        (assets.waterMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
        if (assets.atmoMat) {
          (assets.atmoMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
          (assets.atmoMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame(this.getView());
  };
}
