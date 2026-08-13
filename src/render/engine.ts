import * as THREE from 'three';
import { frequencyForSize, getGrid, type GeoGrid } from '../world/geodesic';
import {
  basinFetch, generateLevels, insolationAt, localTemp01, MAX_LEVEL, snowLineFor, waterLevelFor,
} from '../world/toygen';
import { paletteFor, SPACE_COLOR } from '../world/toyPalette';
import { UNIVERSE, airExtinction, hazeSpec, seaState, tidalForcing } from '../world/physics';
import { TerraceJob, makeTerrainMaterial, makeWaterMaterial, skinLevel, terrace, warpPoint } from './terraceMesh';
import { makeSkyShellMaterials } from './atmosphere';
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
export type RigMode = 'orbit' | 'flight' | 'surface';
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
/** Surface zoom → walk: positive log-zoom (pinch out / wheel in) raises a
 * latched 0..1 forward throttle. Zoom out first dumps that throttle; once
 * you're stopped, further zoom-out settles hover height. Never takes off. */
const SURF_WALK_GAIN = 2.6;
const SURF_STOP_GAIN = 5.0;
const SURF_HEIGHT_GAIN = 1;
/** One full revolution of the station-style orbit ride. Geared to the same
 * 3x-slower universe as the celestial clock (UNIVERSE.TIME_SCALE), so a
 * sunrise seen from orbit lasts long enough to be watched. */
const STATION_PERIOD_SEC = 450;

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
  /** Extinction pass of the sky shell (shares uniforms with atmoMat). */
  atmoExtMat?: THREE.ShaderMaterial;
  /** The sea sphere (when present): the tide scales it each frame. */
  water?: THREE.Mesh;
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
  /** Per-cell basin fetch (0..255, toygen.basinFetch): open-water reach. */
  fetch: Uint8Array | null;
  /** Tidal waterline breathing amplitude, in levels (0 = no moving tide). */
  tideAmp: number;
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

  /** Wall-clock system time, geared down by UNIVERSE.TIME_SCALE: orbits
   * keep turning between sessions, at a pace where a dawn can be watched.
   * (Scaled absolute time, so reloads land on consistent positions.) */
  private readonly epoch =
    (Date.now() / 1000 - performance.now() / 1000) * UNIVERSE.TIME_SCALE;

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

  // ---- surface rig (hover above the terrain, body-local spinning frame) ----
  private sDir = new THREE.Vector3(0, 0, 1);
  /** Heading around the local up: 0 faces the north pole, +ve turns east. */
  private sYaw = 0;
  private sPitch = 0;
  /** Hover altitude above the terrain skin (unit-sphere frame). */
  private sEyeH = 0.03;
  private sEyeHTarget = 0.03;
  /** Latched forward walk from zoom/pinch, 0 idle .. 1 brisk. */
  private sWalk = 0;

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
  /** Headlamp brightness, eased so dusk fades it in rather than snapping. */
  private torchLevel = 0;
  /**
   * The water's mirror world: a cube camera parked at the main camera's
   * reflection point beneath the sea surface, rendering the terrain layer
   * only. The water shader samples it along Fresnel-reflected rays, so land
   * standing over the shore appears IN the water — the sky component stays
   * analytic (scattering law), this capture supplies what the sky cannot:
   * geometry. Lazily built; only runs in surface mode.
   */
  private reflRT?: THREE.WebGLCubeRenderTarget;
  private reflCam?: THREE.CubeCamera;
  /**
   * The water-column capture: a screen-sized float target holding the
   * terrain's COLOR (rgb) and body-local DISTANCE (alpha, 0 = no ground).
   * The water shader refracts that bottom through the sea by Beer–Lambert
   * so shallows show sand and open ocean is opaque water — never a window
   * onto the sky. Lazily built; only runs in surface mode.
   */
  private colRT?: THREE.WebGLRenderTarget;
  private tmpM4 = new THREE.Matrix4();
  private tmpC = new THREE.Color();
  private tmpSz = new THREE.Vector2();

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

    // Bodies: tier-0 spheres for everyone, chemistry-tinted atmosphere
    // balls for the giants, faint orbit rings for orientation.
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
        fetch: null,
        tideAmp: 0,
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
    this.updateBodyPoses(this.epoch + (performance.now() / 1000) * UNIVERSE.TIME_SCALE);

    // Restore the camera, or open in orbit around the home world.
    const cam = state.cam;
    if (cam?.mode === 'flight') {
      this.mode = 'flight';
      this.fPos.fromArray(cam.pos);
      this.fQuat.fromArray(cam.q).normalize();
      this.throttle = 0;
      this.speed = 0;
    } else if (cam?.mode === 'surface' && this.bodies.get(cam.bodyId)?.spec.kind === 'rocky') {
      this.mode = 'surface';
      this.orbitBodyId = cam.bodyId;
      this.sDir.fromArray(cam.dir).normalize();
      this.sYaw = cam.yaw;
      this.sPitch = cam.pitch;
      this.sEyeH = this.sEyeHTarget = cam.eyeH;
      this.prepareBodyData(this.bodies.get(cam.bodyId)!);
      this.prevSpinQ.copy(this.bodies.get(cam.bodyId)!.spinQ);
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
      const gradient = paletteFor(phys, rt.waterLevel);
      const h = phys.hydrosphere;
      // The climate dial moves TsurfK and pressure, so the aerial
      // perspective re-derives with the rest of the chemistry.
      const ext = airExtinction(phys);
      // The dials moved the physics, so the sea state (wind from pressure,
      // tide from moons) re-derives with the rest of the chemistry.
      const seaSt = this.seaStateFor(rt);
      rt.tideAmp = wantWater && phys.hydrosphere.state === 'liquid' ? 0.3 * seaSt.tide : 0;
      for (const assets of [rt.tier1, rt.tier2]) {
        if (!assets) continue;
        const tu = assets.terrainMat.uniforms;
        tu.uTempBase.value = temp;
        tu.uSnowTempBase.value = temp + this.snowShift(rt);
        tu.uSnowAmount.value = phys.snow;
        tu.uSurfStrength.value = wantWater && h.state !== 'ice' ? h.foam : 0;
        tu.uWaveEnergy.value = seaSt.energy;
        tu.uWaveTempo.value = seaSt.tempo;
        tu.uAirSigma.value = ext?.sigma ?? 0;
        tu.uAirH.value = ext?.scaleH ?? 0.05;
        tu.uAirCurv.value = ext?.curve ?? 1;
        tu.uAeroTau.value = ext?.aeroTau ?? 0;
        if (ext) {
          (tu.uAirW.value as THREE.Vector3).set(...ext.weights);
          (tu.uAirAlb.value as THREE.Vector3).set(...ext.albedo);
          (tu.uAeroW.value as THREE.Vector3).set(...ext.aeroW);
        }
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
          wu.uWaveEnergy.value = seaSt.energy;
          wu.uWaveTempo.value = seaSt.tempo;
          (wu.uSurf.value as THREE.Vector3).set(...h.surf);
          (wu.uDeep.value as THREE.Vector3).set(...h.deep);
          (wu.uIceColor.value as THREE.Vector3).set(...h.ice);
          wu.uIceFloor.value =
            h.state === 'ice' && phys.atmosphere.pressure < UNIVERSE.LIQUID_MIN_P ? 1 : 0;
          wu.uAirSigma.value = ext?.sigma ?? 0;
          wu.uAirH.value = ext?.scaleH ?? 0.05;
          wu.uAirCurv.value = ext?.curve ?? 1;
          wu.uAeroTau.value = ext?.aeroTau ?? 0;
          if (ext) {
            (wu.uAirW.value as THREE.Vector3).set(...ext.weights);
            (wu.uAirAlb.value as THREE.Vector3).set(...ext.albedo);
            (wu.uAeroW.value as THREE.Vector3).set(...ext.aeroW);
          }
        }
        // The sky shell breathes with the same numbers: thin the air with
        // the dials and the sky dims and the stars come through.
        if (assets.atmoMat) {
          const au = assets.atmoMat.uniforms;
          au.uAirSigma.value = ext?.sigma ?? 0;
          au.uAirH.value = ext?.scaleH ?? 0.05;
          au.uAirCurv.value = ext?.curve ?? 1;
          au.uAeroTau.value = ext?.aeroTau ?? 0;
          if (ext) {
            (au.uAirW.value as THREE.Vector3).set(...ext.weights);
            (au.uAirAlb.value as THREE.Vector3).set(...ext.albedo);
            (au.uAeroW.value as THREE.Vector3).set(...ext.aeroW);
          }
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
    const levels = generateLevels(rt.spec.seed, rt.grid);
    const terrain = this.overrides.get(rt.spec.id)?.terrain;
    if (terrain) {
      for (const [cell, level] of terrain) {
        if (cell >= 0 && cell < levels.length) levels[cell] = level;
      }
    }
    rt.levels = levels;
    const { temp, sea } = this.effective(rt.spec.id);
    rt.waterLevel = waterLevelFor(sea);
    // Basin fetch on the FINAL field (player edits included): waves need
    // open water to grow, so ponds stay glassy and oceans take the swell.
    rt.fetch = basinFetch(rt.grid, levels, rt.waterLevel);
    rt.snowLine = snowLineFor(temp + this.snowShift(rt), rt.waterLevel, rt.phys?.snow ?? 1);
    rt.step = stepFor(rt.grid);
    rt.peakH = (MAX_LEVEL - rt.waterLevel) * rt.step;
  }

  /** The body's sea state: wind from pressure, tempo from gravity, tide
   * from its moons — but only if it SPINS beneath them (a locked body's
   * bulge is static and raises no waves). See physics.seaState. */
  private seaStateFor(rt: BodyRT): { energy: number; tempo: number; tide: number } {
    const phys = rt.phys;
    if (!phys) return { energy: 0.85, tempo: 1, tide: 0 };
    let tide = 0;
    if (!rt.spec.tidallyLocked && this.system) {
      tide = tidalForcing(
        this.system.bodies
          .filter((b) => b.parent === rt.spec.id)
          .map((b) => ({
            densityRel: b.physics.densityRel,
            radiusGL: b.radius,
            orbitGL: b.orbitRadius,
          })),
      );
    }
    return seaState(phys, tide);
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
    const job = new TerraceJob(
      rt.grid!,
      renderGrid,
      rt.levels!,
      { waterLevel: rt.waterLevel, step: rt.step, rounding: TERRACE_ROUNDING },
      rt.fetch ?? undefined,
    );
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

    // What stirs this body's seas (wind, gravity, moons): the wave model in
    // both shaders runs on these two numbers. Liquid spinners with moons
    // also breathe their waterline (see the frame loop).
    const sea = this.seaStateFor(rt);
    rt.tideAmp = showWater && hydroState === 'liquid' ? 0.3 * sea.tide : 0;

    // The air, from the physics: extinction, scale height and per-wavelength
    // scattering weights all derive from pressure, gravity and chemistry.
    // Terrain, sea and sky shell march the same law along their own rays.
    const ext = phys ? airExtinction(phys) : null;
    const air = ext
      ? {
          sigma: ext.sigma,
          scaleH: ext.scaleH,
          curve: ext.curve,
          weights: ext.weights,
          albedo: ext.albedo,
          aeroTau: ext.aeroTau,
          aeroW: ext.aeroW,
        }
      : undefined;

    const terrainMat = makeTerrainMaterial({
      gradient: paletteFor(phys, rt.waterLevel),
      tempBase: temp,
      tempSpan,
      lockedToStar: locked,
      surfStrength: showWater && hydroState !== 'ice' ? phys?.hydrosphere.foam ?? 1 : 0,
      waveEnergy: sea.energy,
      waveTempo: sea.tempo,
      snowAmount: phys?.snow ?? 1,
      snowTempBase: temp + this.snowShift(rt),
      air,
    });
    terrainMat.uniforms.uWaterLevel.value = rt.waterLevel;
    terrainMat.uniforms.uWarpFreq.value = 2.2 / rt.grid!.cellSpacing();
    const terrain = new THREE.Mesh(geometry, terrainMat);
    terrain.renderOrder = 0;
    // Layer 1 is what the water's reflection camera sees: terrain only, so
    // the mirror capture holds land against a transparent sky (the water
    // shader falls back to the analytic scattering sky where alpha is 0).
    terrain.layers.enable(1);
    root.add(terrain);

    let waterMat: THREE.ShaderMaterial | undefined;
    let waterMesh: THREE.Mesh | undefined;
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
        waveEnergy: sea.energy,
        waveTempo: sea.tempo,
        air,
      });
      waterMat.uniforms.uWaveFreq.value = 9 / rt.grid!.cellSpacing();
      // Freeboard: floating sheets ride about half a terrain step above the
      // liquid line, so the shelf edge reads as a raised shore.
      waterMat.uniforms.uFreeboard.value = rt.step * 0.55;
      // Beer–Lambert extinction for the column-based opacity, calibrated in
      // terrain steps. A layer is 60 m of water (METERS_PER_LEVEL) and real
      // seas hide their bottom within a few tens of meters: one full layer
      // down is nearly opaque, and only the top fraction of a layer glows
      // turquoise at the coast. Chemistry keeps its word through clarity —
      // glassy seas (pure water, methane) reach a little deeper.
      waterMat.uniforms.uMurk.value =
        (3.5 - 1.3 * (phys?.hydrosphere.clarity ?? 0.75)) / rt.step;
      waterMat.uniforms.uStep.value = rt.step;
      // Tier 2 water is finely tessellated for the SILHOUETTE, not the
      // shading: from the shore the sea's horizon is this sphere seen
      // edge-on, and a coarse mesh's facets sag below the true sphere —
      // the scallops read as rolling water hills on the skyline. At 384
      // segments the sag (~2e-6 R) is subpixel from standing height.
      const water = new THREE.Mesh(
        new THREE.SphereGeometry(1, tier === 2 ? 384 : 48, tier === 2 ? 256 : 32),
        waterMat,
      );
      water.renderOrder = 5;
      root.add(water);
      waterMesh = water;
    }

    // Shells must clear the tallest possible column, whatever the sea level.
    const peakR = 1 + rt.peakH;

    // No painted cloud deck: aerosol opacity lives inside airExtinction's
    // sigma now, so thick atmospheres hide their surfaces through the same
    // scattering integral that draws the sky and the limb.

    // The sky shell: the same scattering law, marched along the rays that
    // cross the air without striking the globe. From orbit those are the
    // limb; from the ground they are the whole sky. Its top sits where the
    // exponential air has genuinely run out (~6 scale heights).
    let atmoMat: THREE.ShaderMaterial | undefined;
    let atmoExtMat: THREE.ShaderMaterial | undefined;
    if (tier === 2 && air) {
      // 7H clears both the exponential gas and the aerosol deck (center 3H,
      // width 1.2H — the Gaussian has died by 3H + 3 widths).
      const shellR = Math.max(peakR + 0.06, 1 + 7 * air.scaleH);
      // The shell hands rays off to the ground only below the BEDROCK
      // sphere — the lowest surface the mesh is guaranteed to draw. Valley
      // floors sit well under the nominal radius 1, and handing off there
      // punched a black landform-shaped void around dry worlds' limbs.
      // (A hair inside: a doubly-fogged sub-pixel fringe is invisible, a
      // gap is not.) The sea writes depth so ocean rays still depth-test
      // the sky out; handing off at the sea sphere itself would open a
      // black gap wherever the tessellated water mesh sags inside it.
      const floorR = Math.max(0.05, 1 - rt.waterLevel * rt.step - 0.005);
      const shell = makeSkyShellMaterials(air, shellR, floorR);
      // Two passes over one shell: multiply the background by per-channel
      // transmittance (setting suns bleed red), then add the in-scatter.
      const shellGeo = new THREE.SphereGeometry(shellR, 64, 40);
      const ext = new THREE.Mesh(shellGeo, shell.ext);
      ext.renderOrder = 9;
      root.add(ext);
      const atmo = new THREE.Mesh(shellGeo, shell.glow);
      atmo.renderOrder = 10;
      root.add(atmo);
      atmoMat = shell.glow;
      atmoExtMat = shell.ext;
    }

    rt.group.add(root);
    const assets: TierAssets = {
      root, terrainMat, waterMat, atmoMat, atmoExtMat, water: waterMesh, geometry,
    };
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
    assets.atmoExtMat?.dispose();
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
        (this.mode !== 'flight' && rt.spec.id === this.orbitBodyId) || dSurf < TIER2_DIST;
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
    const rt = this.mode === 'flight' ? this.nearestBody() : this.currentBody();
    const name = rt?.spec.name ?? '';
    let zNorm = 0;
    if (this.mode === 'orbit') {
      const hi = this.hPlanet();
      const lo = this.hMin();
      zNorm = Math.min(1, Math.max(0, Math.log(hi / this.h) / Math.log(hi / lo)));
    } else if (this.mode === 'surface') {
      zNorm = 1;
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
    const c =
      this.mode === 'surface'
        ? this.tmpV.copy(this.sDir)
        : this.tmpV.set(0, 0, 1).applyQuaternion(this.orient);
    const d = 1 + (this.mode === 'surface' ? this.sEyeH : this.h);
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

  /** Leave orbit (or the surface): a ship at the current pose, engines idle. */
  depart(): void {
    if (this.mode === 'flight' || this.blend) return;
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

  // ---------------------------------------------------------------- surface rig

  /** Tangent basis at a body-local direction: east, and north toward +Z. */
  private surfBasis(dir: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3): void {
    east.set(-dir.y, dir.x, 0);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    north.crossVectors(dir, east);
  }

  /**
   * Terrain-skin radius under a body-local direction: the same
   * jittered-column blend + terrace shaping the mesh is built from,
   * floored at the sea surface — you hover over water, never under it.
   */
  private groundR(rt: BodyRT, dir: THREE.Vector3): number {
    const grid = rt.grid;
    const levels = rt.levels;
    if (!grid || !levels) return 1;
    const r = 1 + (terrace(skinLevel(grid, levels, dir.x, dir.y, dir.z), TERRACE_ROUNDING) - rt.waterLevel) * rt.step;
    return Math.max(r, 1);
  }

  /** Lowest hover: just above a single terrace step. */
  private sEyeMin(rt: BodyRT): number {
    return Math.max(0.004, rt.step * 0.6);
  }

  /** Hover ceiling; the rocket takes you back to orbit, not zoom-out. */
  private sEyeMax(): number {
    return 0.35;
  }

  /**
   * Surface zoom mapping. `logZoom` > 0 is zoom-in (pinch out / wheel in):
   * raise the latched walk throttle. `logZoom` < 0 is zoom-out: dump walk
   * first, then settle toward the ground. Never departs to orbit.
   */
  private applySurfaceZoom(logZoom: number): void {
    if (logZoom > 0) {
      this.sWalk = Math.min(1, this.sWalk + logZoom * SURF_WALK_GAIN);
    } else if (this.sWalk > 0.02) {
      this.sWalk = Math.max(0, this.sWalk + logZoom * SURF_STOP_GAIN);
    } else {
      this.sWalk = 0;
      const rt = this.currentBody();
      if (!rt) return;
      this.sEyeHTarget = Math.min(
        this.sEyeMax(),
        Math.max(this.sEyeMin(rt), this.sEyeHTarget * Math.exp(logZoom * SURF_HEIGHT_GAIN)),
      );
    }
    this.cameraDirtySince = performance.now();
  }

  /**
   * Land: set the ship down at the point under the screen center. The rig
   * moves into the body's spinning frame — you stand on the turning world —
   * hovering a little above the terrain skin (or the sea surface).
   */
  land(): void {
    if (this.mode !== 'orbit' || this.blend) return;
    const rt = this.currentBody();
    if (!rt || rt.spec.kind !== 'rocky') return;
    this.prepareBodyData(rt);
    this.updateCamera();
    this.sDir.set(0, 0, 1).applyQuaternion(this.orient).normalize();
    // Keep the on-screen "up" as the initial heading.
    const east = new THREE.Vector3();
    const north = new THREE.Vector3();
    this.surfBasis(this.sDir, east, north);
    const scrUp = this.tmpV.set(0, 1, 0).applyQuaternion(this.orient);
    this.sYaw = Math.atan2(scrUp.dot(east), scrUp.dot(north));
    this.sPitch = -0.15;
    this.sEyeH = this.sEyeHTarget = Math.max(this.sEyeMin(rt), rt.step * 4);
    this.sWalk = 0;
    this.blend = {
      t: 0,
      fromPos: this.camera.position.clone(),
      fromQuat: this.camera.quaternion.clone(),
    };
    this.mode = 'surface';
    this.angVel.set(0, 0, 0);
    this.zoomAnchor = null;
    this.northAnim = null;
    this.pinch = null;
    this.grabDir = null;
    this.cameraDirtySince = performance.now();
  }

  /** Take off: rise from the landing spot back into the orbit rig. */
  takeOff(): void {
    if (this.mode !== 'surface' || this.blend) return;
    const rt = this.currentBody();
    if (!rt) return;
    this.updateCamera();
    const fromPos = this.camera.position.clone();
    const fromQuat = this.camera.quaternion.clone();
    // Orbit rig aimed straight down at the spot we left.
    let up = new THREE.Vector3(0, 0, 1).addScaledVector(this.sDir, -this.sDir.z);
    if (up.lengthSq() < 1e-6) up = new THREE.Vector3(0, 1, 0);
    up.normalize();
    const x = new THREE.Vector3().crossVectors(up, this.sDir);
    this.orient.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, this.sDir));
    this.h = this.clampH(this.groundR(rt, this.sDir) - 1 + this.sEyeH);
    this.hTarget = this.hStation(rt);
    this.sWalk = 0;
    this.prevSpinQ.copy(rt.spinQ);
    this.blend = { t: 0, fromPos, fromQuat };
    this.mode = 'orbit';
    this.angVel.set(0, 0, 0);
    this.zoomAnchor = null;
    this.cameraDirtySince = performance.now();
  }

  /** Surface camera pose in world space: hover above the terrain skin. */
  private surfaceCamPose(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const rt = this.currentBody()!;
    const east = new THREE.Vector3();
    const north = new THREE.Vector3();
    this.surfBasis(this.sDir, east, north);
    const fwd = new THREE.Vector3()
      .addScaledVector(north, Math.cos(this.sYaw))
      .addScaledVector(east, Math.sin(this.sYaw));
    const view = new THREE.Vector3()
      .addScaledVector(fwd, Math.cos(this.sPitch))
      .addScaledVector(this.sDir, Math.sin(this.sPitch));
    outPos
      .copy(this.sDir)
      .multiplyScalar(this.groundR(rt, this.sDir) + this.sEyeH)
      .applyQuaternion(rt.spinQ)
      .multiplyScalar(rt.spec.radius)
      .add(rt.pos);
    view.applyQuaternion(rt.spinQ);
    const upW = this.tmpV.copy(this.sDir).applyQuaternion(rt.spinQ);
    const m = new THREE.Matrix4().lookAt(outPos, this.tmpV2.copy(outPos).add(view), upW);
    outQuat.setFromRotationMatrix(m);
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
    if (this.mode !== 'flight' && this.currentBody()) {
      const rt = this.currentBody()!;
      if (this.mode === 'orbit') this.orbitCamPose(this.tmpV3, this.tmpQ2);
      else this.surfaceCamPose(this.tmpV3, this.tmpQ2);
      if (this.blend) {
        const e = smoothstep01(this.blend.t);
        this.camera.position.lerpVectors(this.blend.fromPos, this.tmpV3, e);
        this.camera.quaternion.slerpQuaternions(this.blend.fromQuat, this.tmpQ2, e);
      } else {
        this.camera.position.copy(this.tmpV3);
        this.camera.quaternion.copy(this.tmpQ2);
      }
      const hCam = this.mode === 'orbit' ? this.h * 0.2 : this.sEyeH * 0.25;
      this.camera.near = Math.min(2, Math.max(0.0004, hCam * rt.spec.radius));
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
    this.reflRT?.dispose();
    this.colRT?.dispose();
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
    // Same domain warp as the skin, so the click edits the column whose
    // ground is actually drawn under the cursor.
    const w = warpPoint(rt.grid, this.tmpV.x, this.tmpV.y, this.tmpV.z);
    return rt.grid.nearestCell(w[0], w[1], w[2]);
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
    const own = this.mode !== 'flight' && bodyId === this.orbitBodyId;
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
    if (this.mode !== 'flight') {
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

    if (this.blend) return;

    if (this.mode === 'surface') {
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), dir: this.sDir.clone() };
      }
      return;
    }

    if (this.mode !== 'orbit') return;

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

    // Surface: pinch scale walks / stops / settles; one finger looks around.
    if (this.mode === 'surface' && !this.blend) {
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const factor = dist / Math.max(1, this.pinch.dist);
        this.applySurfaceZoom(Math.log(Math.max(1e-3, factor)));
        this.pinch.dist = dist;
        return;
      }
      if (this.pointers.size === 1) {
        this.sYaw += dx * FLIGHT_STEER;
        this.sPitch = Math.min(1.35, Math.max(-1.35, this.sPitch - dy * FLIGHT_STEER));
        this.cameraDirtySince = performance.now();
      }
      return;
    }

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
    if (this.mode === 'surface') {
      // Wheel in / trackpad pinch-out walks; wheel out stops, then settles.
      this.applySurfaceZoom(-e.deltaY * 0.0016);
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

    const tSys = this.epoch + (now / 1000) * UNIVERSE.TIME_SCALE;
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
    } else if (this.mode === 'surface' && this.currentBody()) {
      // Hover-height easing (wheel).
      if (Math.abs(this.sEyeH - this.sEyeHTarget) > this.sEyeHTarget * 0.001) {
        this.sEyeH += (this.sEyeHTarget - this.sEyeH) * (1 - Math.exp(-dt * 10));
        this.cameraDirtySince = now;
      }
      // Glide across the terrain: WASD plus the latched zoom-walk throttle.
      let mF = 0;
      let mR = 0;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mF += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mF -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mR += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mR -= 1;
      const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
      mF = mF * boost + this.sWalk;
      mR *= boost;
      const mag = Math.hypot(mF, mR);
      if (mag > 1e-4 && !this.blend) {
        const east = this.tmpV;
        const north = this.tmpV2;
        this.surfBasis(this.sDir, east, north);
        const cy = Math.cos(this.sYaw);
        const sy = Math.sin(this.sYaw);
        // World-tangent forward (for heading transport) and move direction.
        const fwd = new THREE.Vector3().addScaledVector(north, cy).addScaledVector(east, sy);
        const move = this.tmpV3
          .set(0, 0, 0)
          .addScaledVector(north, (cy * mF - sy * mR) / mag)
          .addScaledVector(east, (sy * mF + cy * mR) / mag);
        // Angular speed grows with hover height: skim low, cruise high.
        // Zoom-walk mag is 0..1; WASD+shift can push it to ~3.
        const ang = (0.06 + 2.4 * this.sEyeH) * Math.min(3, mag) * dt;
        this.sDir
          .multiplyScalar(Math.cos(ang))
          .addScaledVector(move, Math.sin(ang))
          .normalize();
        // Re-express the heading in the new local basis so travel is straight.
        this.surfBasis(this.sDir, east, north);
        fwd.addScaledVector(this.sDir, -fwd.dot(this.sDir)).normalize();
        this.sYaw = Math.atan2(fwd.dot(east), fwd.dot(north));
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
          : this.mode === 'surface'
            ? {
                mode: 'surface',
                bodyId: this.orbitBodyId,
                dir: this.sDir.toArray() as [number, number, number],
                yaw: this.sYaw,
                pitch: this.sPitch,
                eyeH: this.sEyeH,
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

    // The water's mirror world: from the ground, park the reflection camera
    // at the eye's image point beneath the sea surface (mirror across the
    // sea sphere — locally a flat mirror: same ray from the center, radius
    // 2·R_sea − r) and photograph the terrain layer against a transparent
    // sky. The water shader samples this along its Fresnel-reflected rays;
    // where nothing was captured, the analytic scattering sky shows through.
    if (this.mode === 'surface') {
      const hereRt = this.bodies.get(this.orbitBodyId ?? '');
      const hereAssets = hereRt ? hereRt.tier2 ?? hereRt.tier1 : undefined;
      if (hereRt && hereAssets?.waterMat) {
        if (!this.reflCam || !this.reflRT) {
          this.reflRT = new THREE.WebGLCubeRenderTarget(512);
          this.reflCam = new THREE.CubeCamera(0.002, 60, this.reflRT);
          for (const c of this.reflCam.children) (c as THREE.Camera).layers.set(1);
          this.scene.add(this.reflCam);
        }
        const d = this.tmpV.copy(this.camera.position).sub(hereRt.pos);
        const r = Math.max(d.length(), 1e-9);
        const seaScale = hereAssets.water?.scale.x ?? 1;
        const seaR = hereRt.spec.radius * seaScale;
        this.reflCam.position.copy(hereRt.pos).addScaledVector(d, (2 * seaR - r) / r);
        // A reflection contains nothing from beneath its mirror: clip the
        // terrain below the sea sphere for this pass, or the underwater
        // beach slope occludes the coast and the mirror fills with seabed.
        for (const a of [hereRt.tier1, hereRt.tier2]) {
          if (a) a.terrainMat.uniforms.uMirrorClip.value = seaScale;
        }
        const bg = this.scene.background;
        this.scene.background = null;
        this.renderer.getClearColor(this.tmpC);
        const a0 = this.renderer.getClearAlpha();
        this.renderer.setClearColor(0x000000, 0);
        this.reflCam.update(this.renderer, this.scene);
        this.renderer.setClearColor(this.tmpC, a0);
        this.scene.background = bg;
        for (const a of [hereRt.tier1, hereRt.tier2]) {
          if (a) a.terrainMat.uniforms.uMirrorClip.value = 0;
        }

        // The water-column capture: photograph the terrain (color +
        // distance packed in alpha) through the main camera. The water
        // shader refracts that bottom through the sea — optical depth
        // kills the sand in deep water, so the sea is a surface with a
        // bottom, not a window onto whatever happens to sit behind it.
        if (!this.colRT) {
          this.colRT = new THREE.WebGLRenderTarget(2, 2, {
            type: THREE.HalfFloatType,
            depthBuffer: true,
            stencilBuffer: false,
          });
        }
        this.renderer.getDrawingBufferSize(this.tmpSz);
        if (this.colRT.width !== this.tmpSz.x || this.colRT.height !== this.tmpSz.y) {
          this.colRT.setSize(this.tmpSz.x, this.tmpSz.y);
        }
        const qInvCol = this.tmpQ.copy(hereRt.spinQ).conjugate();
        const camCol = this.tmpV2
          .copy(this.camera.position)
          .sub(hereRt.pos)
          .applyQuaternion(qInvCol)
          .divideScalar(hereRt.spec.radius);
        for (const a of [hereRt.tier1, hereRt.tier2]) {
          if (!a) continue;
          a.terrainMat.uniforms.uWriteCol.value = 1;
          (a.terrainMat.uniforms.uCamPos.value as THREE.Vector3).copy(camCol);
        }
        const bg1 = this.scene.background;
        this.scene.background = null;
        this.renderer.getClearColor(this.tmpC);
        const a1 = this.renderer.getClearAlpha();
        this.renderer.setClearColor(0x000000, 0);
        const mask = this.camera.layers.mask;
        this.camera.layers.set(1); // terrain only
        this.renderer.setRenderTarget(this.colRT);
        this.renderer.render(this.scene, this.camera);
        this.renderer.setRenderTarget(null);
        this.camera.layers.mask = mask;
        this.renderer.setClearColor(this.tmpC, a1);
        this.scene.background = bg1;
        for (const a of [hereRt.tier1, hereRt.tier2]) {
          if (a) a.terrainMat.uniforms.uWriteCol.value = 0;
        }
      }
    }

    for (const rt of this.bodies.values()) {
      // Orbit lines are wayfinding for the void: hide a body's own line when
      // the camera is close, so it never slices across the world's face —
      // and hide them all from the ground, where they'd band across the sky.
      if (rt.orbitLine) {
        const dSurf = this.camera.position.distanceTo(rt.pos) - rt.spec.radius;
        rt.orbitLine.visible = this.mode !== 'surface' && dSurf > rt.spec.radius * 3 + 2;
      }
      const qInv = this.tmpQ.copy(rt.spinQ).conjugate();
      const lightL = this.tmpV.copy(rt.pos).multiplyScalar(-1).normalize().applyQuaternion(qInv);
      if (rt.gasMat) {
        (rt.gasMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
      }
      // The headlamp: on the ground, when the ambient daylight at the camera
      // dies — night, or a cloud deck the sun cannot pierce — a forward beam
      // fades in. "Dark" is judged by the same physics the shaders draw:
      // sunlight through the Chapman slant column plus the multiple-
      // scattering floor, per channel (the brightest surviving color is what
      // eyes adapt to). No switch, just the law noticing dusk.
      let torch = 0;
      const isHere = this.mode === 'surface' && rt.spec.id === this.orbitBodyId;
      const torchDirL = this.tmpV3;
      if (isHere && (rt.tier2 ?? rt.tier1)) {
        const tu = (rt.tier2 ?? rt.tier1)!.terrainMat.uniforms;
        const sigma = tu.uAirSigma.value as number;
        const H = tu.uAirH.value as number;
        const curve = tu.uAirCurv.value as number;
        const aeroTau = tu.uAeroTau.value as number;
        const airW = tu.uAirW.value as THREE.Vector3;
        const aeroW = tu.uAeroW.value as THREE.Vector3;
        const airAlb = tu.uAirAlb.value as THREE.Vector3;
        const camL = this.tmpV2
          .copy(this.camera.position)
          .sub(rt.pos)
          .applyQuaternion(qInv)
          .divideScalar(rt.spec.radius);
        const r = Math.max(camL.length(), 1);
        const mu = camL.dot(lightL) / r;
        const hor = -Math.sqrt(Math.max(1 - 1 / (r * r), 0));
        const lt = Math.min(1, Math.max(0, (mu - (hor - 0.03)) / 0.09));
        const lit = lt * lt * (3 - 2 * lt);
        let day = lit;
        if (sigma > 0 || aeroTau > 0) {
          const rho = Math.exp(-(r - 1) / H);
          const C = 1 / Math.sqrt(mu * mu + curve / r);
          const slantF =
            mu >= 0
              ? C
              : (2 * Math.exp(Math.min((0.5 * r * mu * mu) / H, 20))) / Math.sqrt(curve / r) - C;
          const zd = (r - 1 - 3 * H) / (1.2 * H);
          const above = 1 / (1 + Math.exp(1.7 * zd));
          day = 0;
          for (const [w, aw, alb] of [
            [airW.x, aeroW.x, airAlb.x],
            [airW.y, aeroW.y, airAlb.y],
            [airW.z, aeroW.z, airAlb.z],
          ]) {
            const colUp = sigma * w * rho * H + aeroTau * aw * above;
            const Tsun = Math.exp(-Math.min(colUp * slantF, 40)) * lit;
            let Tdif =
              Math.max(0, 1 / (1 + 0.75 * colUp) - Math.exp(-colUp)) * lit * Math.max(mu, 0);
            Tdif *= Math.exp(-colUp * Math.sqrt(3 * Math.max(0, 1 - alb)));
            day = Math.max(day, Tsun + Tdif);
          }
        }
        torch = 1.4 * Math.min(1, Math.max(0, (0.14 - day) / 0.095));
        this.camera.getWorldDirection(torchDirL).applyQuaternion(qInv);
        this.torchLevel += (torch - this.torchLevel) * 0.08;
        torch = this.torchLevel;
      }
      // Tide (render-only): moon-bearing spinners breathe their waterline —
      // the sea sphere swells a fraction of a level and the surf line
      // follows it up and down the beach terraces. Locked worlds and
      // moonless ones hold still (tideAmp is 0). Phase offset per body so
      // sibling worlds don't inhale together.
      const tideLv = rt.tideAmp > 0
        ? rt.tideAmp * Math.sin(shaderT * 0.003 + rt.spec.orbitPhase)
        : 0;
      for (const assets of [rt.tier1, rt.tier2]) {
        if (!assets) continue;
        (assets.terrainMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
        // Terrain time drives only the shoreline surf; it and the sea share
        // one quarter-speed clock so waves and wash stay in step.
        assets.terrainMat.uniforms.uTime.value = shaderT * 0.25;
        if (rt.tideAmp > 0) {
          assets.terrainMat.uniforms.uWaterLevel.value = rt.waterLevel + tideLv;
          assets.water?.scale.setScalar(1 + tideLv * rt.step);
        }
        const camL = this.tmpV2
          .copy(this.camera.position)
          .sub(rt.pos)
          .applyQuaternion(qInv)
          .divideScalar(rt.spec.radius);
        (assets.terrainMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
        assets.terrainMat.uniforms.uTorch.value = torch;
        if (torch > 0) {
          (assets.terrainMat.uniforms.uTorchDir.value as THREE.Vector3).copy(torchDirL);
        }
        if (assets.waterMat) {
          (assets.waterMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
          assets.waterMat.uniforms.uTime.value = shaderT * 0.25;
          (assets.waterMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
          assets.waterMat.uniforms.uTorch.value = torch;
          if (torch > 0) {
            (assets.waterMat.uniforms.uTorchDir.value as THREE.Vector3).copy(torchDirL);
          }
          // Both captures are valid only for the body we stand on, and only
          // while standing (surface mode is when they're shot): the cube was
          // taken from THIS eye's reflection point, the distance map through
          // THIS frame's camera.
          const here = isHere && this.mode === 'surface';
          const colOn = here && this.colRT ? 1 : 0;
          assets.waterMat.uniforms.uColOn.value = colOn;
          if (colOn) {
            assets.waterMat.uniforms.uColT.value = this.colRT!.texture;
            (assets.waterMat.uniforms.uScr.value as THREE.Vector2).set(
              this.colRT!.width,
              this.colRT!.height,
            );
            assets.waterMat.uniforms.uDistScale.value = rt.spec.radius;
          }
          const envOn = here && this.reflRT ? 1 : 0;
          assets.waterMat.uniforms.uEnvOn.value = envOn;
          if (envOn) {
            assets.waterMat.uniforms.uEnv.value = this.reflRT!.texture;
            (assets.waterMat.uniforms.uL2W.value as THREE.Matrix3).setFromMatrix4(
              this.tmpM4.makeRotationFromQuaternion(rt.spinQ),
            );
            (assets.waterMat.uniforms.uReflC.value as THREE.Vector3)
              .copy(this.reflCam!.position)
              .sub(rt.pos)
              .applyQuaternion(qInv)
              .divideScalar(rt.spec.radius);
          }
        }
        if (assets.atmoMat) {
          (assets.atmoMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
          (assets.atmoMat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
          assets.atmoMat.uniforms.uTorch.value = torch;
          if (torch > 0) {
            (assets.atmoMat.uniforms.uTorchDir.value as THREE.Vector3).copy(torchDirL);
          }
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame(this.getView());
  };
}
