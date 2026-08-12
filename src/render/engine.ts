import * as THREE from 'three';
import { frequencyForSize, getGrid, type GeoGrid } from '../world/geodesic';
import {
  createToyGenerator, insolationAt, localTemp01, MAX_LEVEL, snowLineFor, waterLevelFor,
} from '../world/toygen';
import { paletteFor, SPACE_COLOR } from '../world/toyPalette';
import { UNIVERSE, airExtinction, hazeSpec, rayleighTint } from '../world/physics';
import { TerraceJob, makeTerrainMaterial, makeWaterMaterial } from './terraceMesh';
import { makeAtmoRimMaterial, makeHazeMaterial } from './atmosphere';
import { makeGasGiant } from './gasGiant';
import type { BodySpec, SystemSpec } from '../world/systemgen';
import { effectivePhysics, homeBodyId, lockedToStar } from '../world/systemgen';
import type { BodyPhysics } from '../world/physics';
import type { BiomeId, SavedCamera } from '../world/types';

// The engine is instantiated once and held in a React ref, so a hot update
// of this module would leave the app running the OLD engine class while the
// UI around it updates — silently stale behavior. Decline HMR: any change
// here forces a full page reload in dev.
if (import.meta.hot) import.meta.hot.decline();

export type Tool = 'pan' | 'label' | 'object' | 'inspect';
export type RigMode = 'orbit' | 'flight';
/** How the orbit rig rides: a station sweeps an inertial great circle while
 * the world turns beneath it (the ISS way); geostationary hangs over one
 * spot, pinned to the spinning frame. */
export type OrbitStyle = 'station' | 'geo';

/** Rough physical fiction: ~300 m hexes at F=96 give a size-100 world a
 * ~24 km radius over R_HOME GL units — one GL unit ≈ 5.3 km. */
export const KM_PER_UNIT = 5.3;

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

/**
 * Display scale for interplanetary space. The PHYSICS keeps its compact
 * orbital distances (every law — disk chemistry, temperature, tidal locking
 * — reads the true a), but the RENDER world spreads 10x wider: worlds
 * become destinations rather than neighbors, and at most one is ever inside
 * LOD range at a time. Moons stay in their parent's local (unscaled) frame.
 */
const SPACE_SCALE = 10;

/** LOD ranges (world units to the body's surface) and budgets. */
const TIER1_DIST = 180;
const TIER2_DIST = 28;
const MAX_TIER2 = 2;
const MAX_TIER1 = 5;
const BUILD_BUDGET_MS = 6;
/** Render-lattice frequency cap for the close-up tier. */
const TIER2_MAX_F = 224;

/** Flight tuning. */
const CAPTURE_DIST = 32; // dSurf within which orbit capture is offered
const FLIGHT_STEER = 0.0032; // rad per pixel
const BLEND_SEC = 1.3;
/** One full revolution of the station-style orbit ride. */
const STATION_PERIOD_SEC = 150;

/** Starfield radius; camera far plane must exceed it. */
const STARS_R = 7000;
const CAM_FAR = 14000;

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
  waterMat?: THREE.ShaderMaterial;
  atmoMat?: THREE.ShaderMaterial;
  hazeMat?: THREE.ShaderMaterial;
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
  /** EFFECTIVE physics: the generated model, re-derived through the same
   * pipeline whenever the player's climate dial moves (see
   * systemgen.effectivePhysics). Everything downstream reads this, never
   * spec.physics directly. */
  phys: BodyPhysics;
  group: THREE.Group;
  tier0: THREE.Object3D;
  gasMat: THREE.ShaderMaterial | null;
  orbitLine: THREE.Object3D | null;
  /** Orbit-plane basis (world frame): pos = orbX·x' + orbY·y'. */
  orbX: THREE.Vector3;
  orbY: THREE.Vector3;
  /** Axial tilt (identity for locked bodies; moons inherit the parent's). */
  tiltQ: THREE.Quaternion;
  /** Rocky-world data (lazy): grid, merged levels, dials. */
  grid: GeoGrid | null;
  levels: Uint8Array | null;
  waterLevel: number;
  snowLine: number;
  step: number;
  peakH: number;
  tier1: TierAssets | null;
  tier2: TierAssets | null;
  /** World pose this frame (spinQ is the FULL pose: tilt ∘ spin). */
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
  private orbitStyle: OrbitStyle = 'station';
  /** Last frame's body pose, for the station rig's spin counter-rotation. */
  private prevSpinQ = new THREE.Quaternion();

  // ---- flight rig (world space) ----
  private fPos = new THREE.Vector3(0, 0, 60);
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
  private tagV = new THREE.Vector3();
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

      // Orbit-plane basis and axial tilt. Planets: Keplerian elements
      // (node, inclination, periapsis). Moons: circular in the parent's
      // equatorial plane, so they borrow the parent's tilt.
      const orbX = new THREE.Vector3(1, 0, 0);
      const orbY = new THREE.Vector3(0, 1, 0);
      let tiltQ = new THREE.Quaternion();
      if (b.parent) {
        const parentRT = this.bodies.get(b.parent);
        if (parentRT) {
          tiltQ = parentRT.tiltQ.clone();
          orbX.applyQuaternion(tiltQ);
          orbY.applyQuaternion(tiltQ);
        }
      } else {
        const m = new THREE.Matrix4()
          .makeRotationZ(b.node)
          .multiply(new THREE.Matrix4().makeRotationX(b.inc))
          .multiply(new THREE.Matrix4().makeRotationZ(b.peri));
        orbX.applyMatrix4(m);
        orbY.applyMatrix4(m);
        if (b.obliquity > 0) {
          tiltQ.setFromAxisAngle(
            new THREE.Vector3(Math.cos(b.axialAz), Math.sin(b.axialAz), 0),
            b.obliquity,
          );
        }
      }

      // Orbit line: the true (tilted, eccentric) ellipse, sampled by
      // eccentric anomaly so the curve is dense where the body moves fast.
      // Planet orbits live in the 10x display space; moon orbits are local.
      const segs = 128;
      const pts = new Float32Array(segs * 3);
      const dispR = b.parent ? b.orbitRadius : b.orbitRadius * SPACE_SCALE;
      const semiMinor = dispR * Math.sqrt(1 - b.ecc * b.ecc);
      for (let i = 0; i < segs; i++) {
        const E = (i / segs) * 2 * Math.PI;
        const xo = dispR * (Math.cos(E) - b.ecc);
        const yo = semiMinor * Math.sin(E);
        pts[i * 3] = orbX.x * xo + orbY.x * yo;
        pts[i * 3 + 1] = orbX.y * xo + orbY.y * yo;
        pts[i * 3 + 2] = orbX.z * xo + orbY.z * yo;
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const orbitLine = new THREE.LineLoop(
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
        phys: effectivePhysics(spec, b, this.overrides.get(b.id)?.temp),
        group,
        tier0,
        gasMat,
        orbitLine,
        orbX,
        orbY,
        tiltQ,
        grid: null,
        levels: null,
        waterLevel: 13.4,
        snowLine: 25,
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
      this.orbitStyle = cam.style ?? 'station';
      this.orient.fromArray(cam.q).normalize();
      this.prepareBodyData(this.bodies.get(cam.bodyId)!);
      this.h = this.hTarget = this.clampH(cam.d - 1);
      this.prevSpinQ.copy(this.bodies.get(cam.bodyId)!.spinQ);
    } else {
      this.mode = 'orbit';
      this.orbitBodyId = homeBodyId(spec);
      this.orbitStyle = 'station';
      this.orient.copy(this.defaultOrient());
      this.prepareBodyData(this.bodies.get(this.orbitBodyId)!);
      this.h = this.hTarget = this.hPlanet();
      this.prevSpinQ.copy(this.bodies.get(this.orbitBodyId)!.spinQ);
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
    // The climate dial re-runs the physics pipeline: hydrosphere phase,
    // snow cycle, life and palette are re-derived, never just repainted.
    rt.phys = effectivePhysics(this.system!, rt.spec, o.temp);
    const phys = rt.phys;
    // Water sphere presence can lawfully flip (a thin-air iceball warmed
    // past its window sublimates its sheet away): that needs a rebuild.
    const built = rt.tier1 ?? rt.tier2;
    const wantWater = phys.hydrosphere.state !== 'none' || o.seaLevel !== undefined;
    const waterPresenceOk = !built || (built.waterMat !== undefined) === wantWater;
    // Temperature only moves the local temperature field and its derived
    // chemistry — uniforms, not geometry (snow line, sea ice, palette and
    // water tint all follow in the shaders).
    if (!terrainChanged && rt.levels && waterLevelFor(sea) === rt.waterLevel && waterPresenceOk) {
      rt.snowLine = snowLineFor(temp + this.snowShift(rt), rt.waterLevel, phys.snow);
      const gradient = paletteFor(phys);
      const h = phys.hydrosphere;
      // The climate dial moves TsurfK and pressure, so the aerial
      // perspective re-derives with the rest of the chemistry.
      const ext = airExtinction(phys);
      const airColor = ext ? hazeSpec(phys)?.color ?? ext.tint : null;
      for (const assets of [rt.tier1, rt.tier2]) {
        if (!assets) continue;
        const tu = assets.terrainMat.uniforms;
        tu.uTempBase.value = temp;
        tu.uSnowTempBase.value = temp + this.snowShift(rt);
        tu.uSnowAmount.value = phys.snow;
        tu.uSurfStrength.value = wantWater && h.state !== 'ice' ? h.foam : 0;
        tu.uAirSigma.value = ext?.sigma ?? 0;
        tu.uAirH.value = ext?.scaleH ?? 0.05;
        if (airColor) (tu.uAirColor.value as THREE.Vector3).set(...airColor);
        const tex = tu.uGrad.value as THREE.DataTexture;
        const data = tex.image.data as Uint8Array;
        gradient.forEach((c, i) => {
          data[i * 4] = Math.round(c[0] * 255);
          data[i * 4 + 1] = Math.round(c[1] * 255);
          data[i * 4 + 2] = Math.round(c[2] * 255);
        });
        tex.needsUpdate = true;
        if (assets.waterMat) {
          const wu = assets.waterMat.uniforms;
          wu.uTempBase.value = temp + this.snowShift(rt);
          wu.uClarity.value = h.clarity;
          (wu.uSurf.value as THREE.Vector3).set(...h.surf);
          (wu.uDeep.value as THREE.Vector3).set(...h.deep);
          (wu.uIceColor.value as THREE.Vector3).set(...h.ice);
          wu.uIceFloor.value =
            h.state === 'ice' && phys.atmosphere.pressure < UNIVERSE.LIQUID_MIN_P ? 1 : 0;
          wu.uAirSigma.value = ext?.sigma ?? 0;
          wu.uAirH.value = ext?.scaleH ?? 0.05;
          if (airColor) (wu.uAirColor.value as THREE.Vector3).set(...airColor);
        }
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

  /**
   * Offset between the snow dial (measured from the working volatile's
   * freeze point, see physics.snowTemp01) and the display dial. Zero for
   * water worlds; on methane worlds it re-centers the snow law so frost
   * caps peaks instead of blanketing everything "cold".
   */
  private snowShift(rt: BodyRT): number {
    const phys = rt.phys;
    return phys ? phys.snowTemp01 - phys.temp01 : 0;
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
    rt.snowLine = snowLineFor(temp + this.snowShift(rt), rt.waterLevel, rt.phys?.snow ?? 1);
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
    const renderGrid = tier === 2 ? getGrid(Math.min(TIER2_MAX_F, f * 4)) : getGrid(f);
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
    const phys = rt.phys;
    const locked = lockedToStar(rt.spec);
    const tempSpan = locked ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
    const { temp } = this.effective(rt.spec.id);

    // Bone-dry worlds render no fill: nothing condensed into their basins.
    // The player can still flood one by raising the sea dial (terraforming
    // trumps the default state).
    const seaOverridden = this.overrides.get(rt.spec.id)?.seaLevel !== undefined;
    const hydroState = phys?.hydrosphere.state ?? 'liquid';
    const showWater = hydroState !== 'none' || seaOverridden;

    // Aerial perspective from the physics: sigma/scale-height from
    // pressure, gravity and chemistry; the fade color matches the haze
    // deck when one exists so sky and fog agree.
    const ext = phys ? airExtinction(phys) : null;
    const air = ext
      ? { sigma: ext.sigma, scaleH: ext.scaleH, color: (phys && hazeSpec(phys)?.color) ?? ext.tint }
      : undefined;

    const terrainMat = makeTerrainMaterial({
      gradient: paletteFor(phys),
      tempBase: temp,
      tempSpan,
      lockedToStar: locked,
      surfStrength: showWater && hydroState !== 'ice' ? phys?.hydrosphere.foam ?? 1 : 0,
      snowAmount: phys?.snow ?? 1,
      snowTempBase: temp + this.snowShift(rt),
      air,
    });
    terrainMat.uniforms.uWaterLevel.value = rt.waterLevel;
    terrainMat.uniforms.uWarpFreq.value = 2.2 / rt.grid!.cellSpacing();
    const terrain = new THREE.Mesh(geometry, terrainMat);
    terrain.renderOrder = 0;
    root.add(terrain);

    let waterMat: THREE.ShaderMaterial | undefined;
    if (showWater) {
      waterMat = makeWaterMaterial({
        surf: phys?.hydrosphere.surf,
        deep: phys?.hydrosphere.deep,
        clarity: phys?.hydrosphere.clarity,
        tempBase: temp + this.snowShift(rt),
        tempSpan,
        lockedToStar: locked,
        iceColor: phys?.hydrosphere.ice,
        // No pressure means no melt anywhere: airless sheets sublimate,
        // they never pool (the triple-point rule).
        neverMelts:
          phys !== undefined &&
          phys.hydrosphere.state === 'ice' &&
          phys.atmosphere.pressure < UNIVERSE.LIQUID_MIN_P,
        air,
      });
      waterMat.uniforms.uWaveFreq.value = 9 / rt.grid!.cellSpacing();
      // Freeboard: floating sheets ride about half a terrain step above the
      // liquid line, so the shelf edge reads as a raised shore.
      waterMat.uniforms.uFreeboard.value = rt.step * 0.55;
      const water = new THREE.Mesh(
        new THREE.SphereGeometry(1, tier === 2 ? 96 : 48, tier === 2 ? 64 : 32),
        waterMat,
      );
      water.renderOrder = 5;
      root.add(water);
    }

    // Shells must clear the tallest possible column, whatever the sea level.
    const peakR = 1 + rt.peakH;

    // Thick atmospheres wear a gas shroud that hides the surface from
    // space (it thins only when the camera pushes down close).
    let hazeMat: THREE.ShaderMaterial | undefined;
    const haze = phys ? hazeSpec(phys) : null;
    const hazeR = Math.max(1.14, peakR + 0.05);
    if (haze) {
      hazeMat = makeHazeMaterial(haze.color, haze.opacity);
      const deck = new THREE.Mesh(new THREE.SphereGeometry(hazeR, 64, 40), hazeMat);
      deck.renderOrder = 8;
      root.add(deck);
    }

    // Rayleigh rim glow, tinted and scaled by the actual atmosphere. It
    // anchors to whatever the eye reads as the limb — the shroud top when
    // one exists, the surface otherwise — and decays outward, so the world
    // has exactly one progressive horizon.
    let atmoMat: THREE.ShaderMaterial | undefined;
    const pressure = phys?.atmosphere.pressure ?? 1;
    if (tier === 2 && pressure > 0.02) {
      // The eye's limb: the shroud top when one exists, otherwise halfway
      // up the terrain silhouette (the skyline is ragged, not a sphere).
      const inner = haze ? hazeR : 1 + rt.peakH * 0.5;
      const shellR = Math.max(inner + 0.24, peakR + 0.12);
      atmoMat = makeAtmoRimMaterial(rayleighTint(phys.atmosphere), pressure, inner, shellR);
      const atmo = new THREE.Mesh(new THREE.SphereGeometry(shellR, 64, 40), atmoMat);
      atmo.renderOrder = 10;
      root.add(atmo);
    }

    rt.group.add(root);
    const assets: TierAssets = { root, terrainMat, waterMat, atmoMat, hazeMat, geometry };
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
    assets.waterMat?.dispose();
    assets.atmoMat?.dispose();
    assets.hazeMat?.dispose();
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

  /**
   * Position and spin every body for system time t (seconds): a pure
   * function of (spec, t) — Kepler's equation for the eccentric, inclined
   * planet orbits (3 Newton steps converge for our mild e), circular
   * parent-equatorial paths for moons, axial tilt folded into the pose.
   */
  private updateBodyPoses(t: number): void {
    if (!this.system) return;
    for (const rt of this.bodies.values()) {
      const b = rt.spec;
      let xo: number;
      let yo: number;
      if (b.ecc > 0) {
        const M = b.orbitPhase + (2 * Math.PI * t) / b.orbitPeriod;
        let E = M + b.ecc * Math.sin(M);
        for (let i = 0; i < 3; i++) {
          E -= (E - b.ecc * Math.sin(E) - M) / (1 - b.ecc * Math.cos(E));
        }
        xo = b.orbitRadius * (Math.cos(E) - b.ecc);
        yo = b.orbitRadius * Math.sqrt(1 - b.ecc * b.ecc) * Math.sin(E);
      } else {
        const oa = b.orbitPhase + (2 * Math.PI * t) / b.orbitPeriod;
        xo = Math.cos(oa) * b.orbitRadius;
        yo = Math.sin(oa) * b.orbitRadius;
      }

      if (b.parent) {
        const parent = this.bodies.get(b.parent)!;
        rt.pos.set(
          parent.pos.x + rt.orbX.x * xo + rt.orbY.x * yo,
          parent.pos.y + rt.orbX.y * xo + rt.orbY.y * yo,
          parent.pos.z + rt.orbX.z * xo + rt.orbY.z * yo,
        );
        rt.orbitLine?.position.copy(parent.pos);
      } else {
        // Planets render in the 10x display space (the physics kept the
        // compact a; see SPACE_SCALE).
        rt.pos.set(
          (rt.orbX.x * xo + rt.orbY.x * yo) * SPACE_SCALE,
          (rt.orbX.y * xo + rt.orbY.y * yo) * SPACE_SCALE,
          (rt.orbX.z * xo + rt.orbY.z * yo) * SPACE_SCALE,
        );
      }

      // Locked bodies keep one face toward the parent: local +X (the
      // substellar/subparent point every temperature law anchors to) is
      // aimed from the ACTUAL world direction to the parent. The in-plane
      // anomaly alone is not enough — the orbit basis carries the node and
      // periapsis angles, and using posAngle raw pointed eyeball worlds at
      // a random azimuth (ice eye on the dayside). Free bodies spin on
      // their own clock around their tilted axis.
      let spin: number;
      if (b.tidallyLocked) {
        const parent = b.parent ? this.bodies.get(b.parent)! : null;
        if (parent) this.tmpV2.copy(parent.pos).sub(rt.pos);
        else this.tmpV2.copy(rt.pos).negate(); // the sun sits at the origin
        this.tmpV2.applyQuaternion(this.tmpQ.copy(rt.tiltQ).conjugate());
        spin = Math.atan2(this.tmpV2.y, this.tmpV2.x);
      } else {
        spin = (2 * Math.PI * t) / b.spinPeriod;
      }
      rt.spinQ.setFromAxisAngle(this.tmpV.set(0, 0, 1), spin);
      rt.spinQ.premultiply(rt.tiltQ);
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

  /**
   * Station-orbit altitude: halfway between a just-outside-the-air skim
   * (peaks, haze deck, ~2.5 scale heights, ISS-ratio floor) and the
   * planet-framing hang. Close enough that the world still fills most of
   * the view and streams beneath you; far enough that you are not scraping
   * the atmosphere. Geo still hangs wherever you arrived.
   */
  private hStation(rt: BodyRT): number {
    const phys = rt.phys;
    const ext = phys ? airExtinction(phys) : null;
    const haze = phys ? hazeSpec(phys) : null;
    // Mirror of attachTier's deck radius (Math.max(1.14, peakR + 0.05)).
    const hazeTop = haze ? Math.max(1.14, 1 + rt.peakH + 0.05) - 1 + 0.04 : 0;
    const airTop = ext ? 2.5 * ext.scaleH : 0;
    const skim = Math.max(0.063, rt.peakH + 0.04, hazeTop, airTop);
    return this.clampH((skim + this.hPlanet()) * 0.5);
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

  /** Local temperature dial at a body-frame direction (the insolation law). */
  private localTemp(rt: BodyRT, x: number, y: number, z: number): number {
    const locked = lockedToStar(rt.spec);
    const span = locked ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
    const { temp } = this.effective(rt.spec.id);
    return localTemp01(temp, span, insolationAt(x, y, z, locked));
  }

  private biomeOfLevel(rt: BodyRT, level: number, snowLine: number): BiomeId {
    const w = rt.waterLevel;
    if (level >= snowLine) return 'snow';
    if (level < w - 6) return 'deep';
    if (level < w - 2) return 'ocean';
    if (level < w) return 'shallow';
    if (level < w + 1.6) return 'beach';
    if (level < 20) return 'grassland';
    if (level < 24) return 'forest';
    return 'mountain';
  }

  biomeAt(bodyId: string, cell: number): BiomeId {
    const rt = this.bodies.get(bodyId);
    if (!rt || !rt.levels || !rt.grid) return 'grassland';
    const t = this.localTemp(
      rt,
      rt.grid.centers[cell * 3],
      rt.grid.centers[cell * 3 + 1],
      rt.grid.centers[cell * 3 + 2],
    );
    return this.biomeOfLevel(
      rt,
      rt.levels[cell],
      snowLineFor(t + this.snowShift(rt), rt.waterLevel, rt.phys?.snow ?? 1),
    );
  }

  /**
   * Inspector readout for a cell: its level, unit direction (for the
   * geology field) and local climate. Null until the body's data is built.
   */
  cellInfo(
    bodyId: string,
    cell: number,
  ): { level: number; dir: [number, number, number]; localTemp01: number } | null {
    const rt = this.bodies.get(bodyId);
    if (!rt?.grid || !rt.levels || cell < 0 || cell >= rt.levels.length) return null;
    const x = rt.grid.centers[cell * 3];
    const y = rt.grid.centers[cell * 3 + 1];
    const z = rt.grid.centers[cell * 3 + 2];
    return { level: rt.levels[cell], dir: [x, y, z], localTemp01: this.localTemp(rt, x, y, z) };
  }

  /** Water level (float level units) for a body, for elevation readouts. */
  waterLevelOf(bodyId: string): number {
    return this.bodies.get(bodyId)?.waterLevel ?? 13.4;
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
      const snow = snowLineFor(
        this.localTemp(rt, px, py, pz) + this.snowShift(rt),
        rt.waterLevel,
        rt.phys?.snow ?? 1,
      );
      if (level >= snow) groups.cold++;
      else if (level < rt.waterLevel) groups.water++;
      else if (level < rt.waterLevel + 1.6) groups.dry++;
      else if (level >= 24) groups.rock++;
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
  enterOrbit(bodyId?: string, style: OrbitStyle = 'station'): void {
    if (this.mode !== 'flight' || this.blend) return;
    let rt = bodyId ? this.bodies.get(bodyId) : null;
    if (!rt) {
      rt = this.nearestBody();
      if (!rt) return;
      const dSurf = this.fPos.distanceTo(rt.pos) - rt.spec.radius;
      if (dSurf > Math.max(CAPTURE_DIST, rt.spec.radius * 4)) return;
    }
    this.orbitBodyId = rt.spec.id;
    this.orbitStyle = style;
    this.prevSpinQ.copy(rt.spinQ);
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
    // Geo hangs where you arrived; a station capture eases to the
    // mid-altitude ride (halfway between the air-top skim and the
    // planet-framing hang).
    this.h = this.clampH(d - 1);
    this.hTarget = style === 'station' ? this.hStation(rt) : this.h;

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

  /**
   * Project a body's center to screen space for the world tags overlay.
   * Worlds outside the view (or behind the camera) clamp to the screen edge
   * like waypoint markers, so every world is always one tap away; only the
   * world currently being orbited hides its tag. dSurf lets the overlay
   * show tags only for far-away worlds.
   */
  projectBody(bodyId: string): (ProjectedPoint & { dSurf: number }) | null {
    const rt = this.bodies.get(bodyId);
    if (!rt) return null;
    const vc = this.tagV.copy(rt.pos).applyMatrix4(this.camera.matrixWorldInverse);
    // Behind the camera or outside the frame: no tag (the system map covers
    // off-screen worlds).
    if (vc.z > -0.01) return null;
    const p = this.tagV.copy(rt.pos).project(this.camera);
    const nx = p.x;
    const ny = p.y;
    if (Math.abs(nx) > 0.96 || Math.abs(ny) > 0.94) return null;
    const own = this.mode === 'orbit' && bodyId === this.orbitBodyId;
    return {
      x: (nx * 0.5 + 0.5) * this.width,
      y: (-ny * 0.5 + 0.5) * this.height,
      visible: !own,
      alpha: 1,
      dSurf: this.camera.position.distanceTo(rt.pos) - rt.spec.radius,
    };
  }

  /**
   * Live map angle for the system map: the body's position angle in the
   * ecliptic plane, around its parent (the sun for planets).
   */
  bodyMapAngle(bodyId: string): number {
    const rt = this.bodies.get(bodyId);
    if (!rt) return 0;
    const parent = rt.spec.parent ? this.bodies.get(rt.spec.parent) : null;
    const px = parent?.pos.x ?? 0;
    const py = parent?.pos.y ?? 0;
    return Math.atan2(rt.pos.y - py, rt.pos.x - px);
  }

  /** Tap-to-travel: from anywhere, jump the ship to a body and capture. */
  travelTo(bodyId: string): void {
    if (this.blend) return;
    if (this.mode === 'orbit') {
      if (bodyId === this.orbitBodyId) return;
      this.depart();
    }
    this.enterOrbit(bodyId);
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

    if (
      this.mode === 'orbit' &&
      (this.tool === 'label' || this.tool === 'object' || this.tool === 'inspect')
    ) {
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
      // Station orbit: ride an inertial great circle, ISS style. First
      // counter-rotate the body's spin delta out of the rig (the rig lives
      // in the spinning frame), so the terrain streams beneath; then
      // advance the ride. Paused while the player is touching the world —
      // a grabbed globe holds still — and while a blend or swing runs.
      const rtCur = this.currentBody()!;
      if (
        this.orbitStyle === 'station' &&
        !this.blend &&
        !this.northAnim &&
        this.pointers.size === 0
      ) {
        this.tmpQ.copy(rtCur.spinQ).invert().multiply(this.prevSpinQ);
        this.orient.premultiply(this.tmpQ).normalize();
        this.tmpQ.setFromAxisAngle(
          this.tmpV.set(-1, 0, 0),
          (2 * Math.PI * dt) / STATION_PERIOD_SEC,
        );
        this.orient.multiply(this.tmpQ).normalize();
      }
      this.prevSpinQ.copy(rtCur.spinQ);

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
      const dSurf = near ? Math.max(0.05, this.fPos.distanceTo(near.pos) - near.spec.radius) : 40;
      const vMax = Math.min(1100, Math.max(0.35, 0.45 + 0.85 * dSurf));
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
              style: this.orbitStyle,
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
        // Terrain time drives only the shoreline surf; it and the sea share
        // one halved clock so waves and wash stay in step.
        assets.terrainMat.uniforms.uTime.value = shaderT * 0.5;
        const camL = this.tmpV2
          .copy(this.camera.position)
          .sub(rt.pos)
          .applyQuaternion(qInv)
          .divideScalar(rt.spec.radius);
        (assets.terrainMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
        if (assets.waterMat) {
          (assets.waterMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
          assets.waterMat.uniforms.uTime.value = shaderT * 0.5;
          (assets.waterMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
        }
        if (assets.atmoMat) {
          (assets.atmoMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
          (assets.atmoMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
        }
        if (assets.hazeMat) {
          (assets.hazeMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
          (assets.hazeMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame(this.getView());
  };
}
