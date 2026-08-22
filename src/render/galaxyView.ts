/**
 * The galaxy explorer draws the harvest, nebulae, dust, and
 * cosmic shell, and routes input to the live vehicle. The
 * ship (`flight.ts`) is the same in or out of a sphere. The
 * drone (`drone.ts`) joins only at launch / land. A course
 * (`course.ts`) is a berth — derived legs, not a playlist.
 * Galaxy stars are named by the reticle (chance lock, then
 * hold). Going there is Set course / the chart — never a tap.
 * Camera is the live vehicle’s pose. Face-on / Edge-on /
 * Home / Back still emit yaw-pitch-roll.
 */
import * as THREE from 'three';
import { UNIVERSE, classify, surveyGain } from '../world/physics';
import { galToCart, homeStar, objectAt, type GalaxyObject } from '../world/galaxy';
import { aimLocks, harvestGlowPx } from './galaxyStar';
import { SkySurvey } from './skySurvey';
import { classifyStar } from '../world/stellar';
import {
  eclipticPole,
  lockedToStar,
  starSpecFromState,
  systemAt,
  type BodySpec,
  type SystemSpec,
} from '../world/systemgen';
import { RockyGlobe } from './rockyGlobe';
import { HostSystem, type HostBodyRT } from './hostSystem';
import { nearestBody } from './hostLook';
import { type HostNavMode } from './hostNav';
import { planOrbitInsert, type InsertMode } from './orbitInsert';
import { ShipFlight } from './flight';
import { Trackball, type DroneWorld } from './drone';
import { Course, type Berth } from '../world/course';
import {
  clearRadiusKm,
  coerceOrbitKind,
  fillViewRadius,
  isHangOrbit,
  isLimbOrbit,
  orbitLabel,
  orbitLimbPitch,
  escapeSpeedKpcS,
  orbitOmega,
  orbitRadiusKpc,
  shellFloorKm,
  starOrbitOmega,
  starOrbitRadiusKpc,
  viewSkinKm,
  type WorldOrbitKind,
} from '../world/worldOrbit';
import {
  regionName,
  sketchMatches,
  BIT_REMNANT,
  type GalaxyFilterName,
} from '../world/sectors';
import { PerfMeter } from './perfHud';
import { makeStar, type StarView } from './star';
import { prepareUniverse } from '../world/universePrep';
import type { LastPlace, SessionSnap, SessionVec } from '../world/types';
/** Park “here” this far ahead of the camera (catalog kpc). */
const FOCUS_PARK = 0.35;
const ZOOM_WHEEL_SENS = 0.0008;
const ZOOM_PINCH_POW = 0.7;
/** Tap vs a look: pick if the captured pointer never really moved. */
const TAP_SLOP = 22;
/** Still this long on a left/right edge before hold-roll starts. */
const HOLD_ROLL_MS = 240;
/** Left / right this fraction of the canvas is a hold-roll zone. Centre is tap / look. */
const HOLD_ROLL_EDGE = 0.28;
/**
 * Reticle acquire / hold. A star has to fly through the
 * tight pip to lock; once named it stays until the look
 * leaves a wider cone. Chance to catch, then consistent.
 */
const RETICLE_LOCK = 0.028;
const RETICLE_HOLD = 0.045;

export type GalaxyMode = 'region';
/** Sketch filter — same names the survey packs carry. */
export type GalaxyFilter = GalaxyFilterName;
export type GalaxyPreset = 'face' | 'edge' | 'home' | 'back';

/** Catalog kpc per kilometre — host meshes live in km under this scale. */
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;
const AU_KM = UNIVERSE.AU_KM;

interface BubblePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
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
function overviewHalfAngle(fovDeg: number, aspect: number, kind: 'face' | 'edge'): number {
  const vHalf = ((fovDeg * Math.PI) / 180) * 0.5;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(1e-4, aspect));
  return kind === 'edge' ? hHalf : Math.min(vHalf, hHalf);
}

/** Sit this far (kpc) so radius `r` fills `fill` of that half-angle. */
function overviewDistanceKpc(r: number, halfAngle: number, fill = 0.92): number {
  return r / Math.max(1e-4, Math.tan(Math.max(1e-4, halfAngle) * fill));
}

export interface GalaxyFocus {
  id: number;
  /** Set when the plate names a world of that host. */
  bodyId?: string;
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
  /** Held Set-course star (plate stays on it). */
  course: GalaxyFocus | null;
  /** True while warp is latched on (Stop). */
  warp: boolean;
  /** True when the helm is set astern (warp runs opposite the nose). */
  astern: boolean;
  /** Face-on / Edge-on canned view — Back is offered only then. */
  inView: boolean;
  /**
   * Catalog kpc remaining to the sphere fence, or null
   * outside every SOI. Place law — lock does not enter.
   */
  soiRemain: number | null;
  /** Host star in the 0.01 ly sphere, if any. */
  hostId: number | null;
  /** Luminous-tail backdrop points currently on the GPU (0 if not minted). */
  backdrop: number;
  /** Chart-picked ring, if we are warping to it or already riding. */
  orbit: WorldOrbitKind | null;
  /** True once the viewpoint is on that ring. */
  orbiting: boolean;
  /**
   * Autopilot mode derived from the berth course + place.
   * Null is free cruise.
   */
  navMode: HostNavMode;
  /** Proximity / orbit readout: nearest or ridden body id. */
  nearestBodyId: string | null;
  /** Short HUD line for the active nav mode (body · ring). */
  navHint: string | null;
  /** On a ring or capturing — Leave orbit, not Warp. */
  canLeaveOrbit: boolean;
  /** Escape burn after Leave orbit — Stop keeps the speed so far. */
  departing: boolean;
  /** Standing on the latched rocky globe. */
  landed: boolean;
  /** Globe is ready and we can set down from this place. */
  canLand: boolean;
  /** Drone planet-trackball while Target is on. */
  lookHold: 'center' | null;
  /** Anti-gravity drone is out. */
  drone: boolean;
  /** Launch lift / home capture. Null once the drone is free. */
  dronePhase: 'launch' | 'home' | null;
  /** Latched / ridden / landed world, if any. */
  worldId: string | null;
}

export interface RegionSelection {
  name: string;
  population: number;
  x: number;
  y: number;
  z: number;
}

export interface GlobePick {
  bodyId: string;
  cell: number;
  level: number;
  dir: [number, number, number];
  waterLevel: number;
}

export type MarkTool = 'label' | 'object';

export interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
}

interface Callbacks {
  onSelect: (obj: GalaxyObject | null) => void;
  onFrame?: (f: GalaxyFrame) => void;
  onPlace?: (p: LastPlace) => void;
  /** Live ship / drone save — written as the pose moves. */
  onSession?: (s: SessionSnap) => void;
  onInspect?: (hit: GlobePick | null) => void;
  onMark?: (tool: MarkTool, hit: GlobePick) => void;
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
  private readonly ship = new ShipFlight();
  private readonly route = new Course();
  /** Left a ring with no dest — HUD proximity. */
  private proximity = false;
  /** Ride clock frozen while the drone is out. */
  private droneRideT = 0;
  /** Face-on / Back / save only — not the look hot path. */
  private get arcYaw(): number {
    return this.ship.toEuler().yaw;
  }
  private set arcYaw(v: number) {
    const e = this.ship.toEuler();
    this.ship.setEuler(v, e.pitch, e.roll);
  }
  private get arcPitch(): number {
    return this.ship.toEuler().pitch;
  }
  private set arcPitch(v: number) {
    const e = this.ship.toEuler();
    this.ship.setEuler(e.yaw, v, e.roll);
  }
  private get arcRoll(): number {
    return this.ship.toEuler().roll;
  }
  private set arcRoll(v: number) {
    const e = this.ship.toEuler();
    this.ship.setEuler(e.yaw, e.pitch, v);
  }
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

  /** The survey photograph — harvest, nebulae, dust, cosmic shell. */
  private readonly sky: SkySurvey;

  private pickRing: THREE.Mesh;
  private hereRing: THREE.Mesh;
  private hereObj: GalaxyObject | null = null;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  /** Camera stays at the origin; the bubble centre moves. */
  /** Last centre we minted / advanced to. */
  private mintAt = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private keys = new Set<string>();

  private dragging = false;
  /** True once this captured pointer actually moved — a look, not a click. */
  private looking = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private holdRollTimer: ReturnType<typeof setTimeout> | null = null;
  /** +1 left (CCW), −1 right (CW), 0 none. */
  private holdRoll = 0;
  private holdClientX = 0;
  private thrustOn = false;
  /** Helm gear: false = ahead (along the nose), true = astern. */
  private astern = false;
  private thrustSpeed = 0;
  /**
   * Leave-orbit burn: ease to escape along a latched heading.
   * Then `coast` holds that velocity until Warp or Stop.
   */
  private departing: { v: number; vEsc: number; dir: THREE.Vector3 } | null = null;
  private readonly coast = new THREE.Vector3();
  private idle = 0;
  private lastT = performance.now();
  private lastDt = 1 / 60;
  private viewW = 0;
  private viewH = 0;

  /** Sketch filter lives on the sky (a survey display law). */
  private get filter(): GalaxyFilter {
    return this.sky.filter;
  }
  private selected: GalaxyObject | null = null;
  /**
   * Set course = Lock-on to a star's ecliptic park. Warp closes
   * on the fill-safe shell; capture burns into the Kepler ring
   * and Lock-on becomes In Orbit.
   */
  private courseObj: GalaxyObject | null = null;
  private courseHud: GalaxyFocus | null = null;
  /** World course inside the host sphere — heading, not the host. */
  private courseBodyId: string | null = null;
  /**
   * Close-approach world. Latched inside WORLD_RANGE_AU; released
   * when we fly out. Look drag drops the heading, not this place.
   */
  private worldId: string | null = null;
  private focusBodyId: string | null = null;
  private selectedBodyId: string | null = null;
  /** Goldberg globes for every rocky body of the host. */
  private readonly globes = new Map<string, RockyGlobe>();
  private markTool: MarkTool | null = null;
  /**
   * Session shadow of the dest ring. Live dest is
   * `route.destOrbit()` — this copy is restore-only.
   */
  private pendingOrbit: { bodyId: string | null; kind: WorldOrbitKind } | null = null;
  private riding: {
    /** null = host-star ecliptic. */
    bodyId: string | null;
    kind: WorldOrbitKind;
    hang: boolean;
    r: number;
    theta0: number;
    omega: number;
  } | null = null;
  /**
   * Exclusive autopilot mode. See `hostNav.ts`. Derived helpers
   * (`pendingOrbit`, `riding`) still drive the physics; this is
   * the contract the HUD and look system obey.
   */
  private navMode: HostNavMode = null;
  private drone: Trackball | null = null;
  /** Lock-on insertion blend 0…1 (far transfer → at the shell). */
  private insertBlend = 0;
  private readonly rideLocal = new THREE.Vector3();
  private readonly rideE1 = new THREE.Vector3();
  private readonly rideE2 = new THREE.Vector3();
  private readonly rideNorth = new THREE.Vector3();
  private readonly orbitTmp = new THREE.Vector3();
  private readonly orbitTmp2 = new THREE.Vector3();
  /** Nearest-core position in host-root km (drone lock / stay-out). */
  private readonly droneCorePos = new THREE.Vector3();
  /** Scratch for look-vector slerp (attitude nudges). */
  private readonly lookSlerp = new THREE.Vector3();
  private readonly orbitQ = new THREE.Quaternion();
  /** Cruise reached the ring this frame — start capture after bodies pose. */
  private pendingArriveOrbit = false;
  /**
   * Lock-on capture burn: ease onto the ring (position + heading)
   * before In Orbit. Null when not capturing.
   */
  private capturing: {
    bodyId: string | null;
    kind: WorldOrbitKind;
    dir: THREE.Vector3;
  } | null = null;
  /** On the skin of the latched rocky globe. */
  private landed = false;
  /** Ring to restore on take-off. */
  private landKind: WorldOrbitKind | null = null;
  private readonly surfDir = new THREE.Vector3(0, 0, 1);
  private readonly surfEast = new THREE.Vector3(1, 0, 0);
  private readonly surfNorth = new THREE.Vector3(0, 1, 0);
  private sYaw = 0;
  private sPitch = UNIVERSE.WORLD_SURF_PITCH;
  private sEyeH = 0.03;
  private sEyeHTarget = 0.03;
  private sWalk = 0;
  /** Boot restore: park the host, then the world, once bodies exist. */
  private pendingPlace: LastPlace | null = null;
  /** Exact ship / drone pose — applied once the host frame exists. */
  private pendingSession: SessionSnap | null = null;
  private lastPlaceKey = '';
  private lastSessionJson = '';
  private lastSessionWrite = 0;
  /**
   * Close-approach subject. Latched when the course, reticle, or
   * selected star comes inside ARRIVE_RANGE_LY; released when the
   * camera leaves that bubble. Latching, not re-testing the reticle,
   * because a full-screen star cannot stay on a 0.028 rad crosshair.
   */
  private hostObj: GalaxyObject | null = null;
  private hostStar: StarView | null = null;
  private hostStarId = -1;
  /**
   * The close star draws in its own depth pass over the live galaxy
   * — same camera pose, AU-scale near/far — so the sky never bakes,
   * blanks, or switches environment. One universe, two depth windows.
   */
  private readonly hostScene = new THREE.Scene();
  /** Local km frame at the locked host, scaled into catalog kpc. */
  private hostRoot: THREE.Group | null = null;
  /** Galaxy fill on objects in the bubble — ARRIVE_SKY_GAIN, not a flood. */
  private hostFill: THREE.AmbientLight | null = null;
  /** Kepler balls + rings — own file, not the galaxy flight. */
  private readonly host = new HostSystem();
  private hostSpec: SystemSpec | null = null;
  private readonly hostTmp = new THREE.Vector3();
  private readonly hostTmp2 = new THREE.Vector3();
  private readonly hostTmpQ = new THREE.Quaternion();
  private readonly hostPole = new THREE.Vector3();
  private readonly hostAlignQ = new THREE.Quaternion();
  private readonly hostEclipticZ = new THREE.Vector3(0, 0, 1);
  private readonly epochUnix = Date.now() / 1000 - performance.now() / 1000;

  constructor(
    canvas: HTMLCanvasElement,
    seed: string,
    callbacks: Callbacks,
    hereStarId: number | null = null,
    resume: LastPlace | null = null,
    session: SessionSnap | null = null,
  ) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.seed = seed;
    this.home = homeStar(seed);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    // Full device resolution (same cap as the engine). The old 1.5
    // cap made the browser bilinear-upscale every frame on a 2×
    // display — a blur that ate ~a third of each star dot's peak
    // brightness: a residual filter nobody decreed.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.perf = new PerfMeter(this.renderer.getContext());
    // The void is black by decree — vacuum emits nothing.
    this.renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    this.camera = new THREE.PerspectiveCamera(UNIVERSE.CAM_FOV, 1, 0.001, regionCamFar());
    this.sky = new SkySurvey(this.scene, seed, {
      wake: (n) => this.wake(n),
      pxPerRad: () => this.pxPerRad(),
      pixelRatio: () => this.renderer.getPixelRatio(),
      hostPresent: () => Boolean(this.hostObj),
      center: () => this.ship.at,
    });

    this.pickRing = this.makeRing(0xf4e4c1, 0.18);
    this.hereRing = this.makeRing(0x7ec8e3, 0.22);
    this.scene.add(this.pickRing);
    this.scene.add(this.hereRing);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('lostpointercapture', this.onLostCapture);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.attachSilhouette();

    this.setHere(hereStarId);
    if (session) this.restoreSession(session);
    else if (resume) this.restorePlace(resume);
    else this.openAtHere();
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
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
    this.wake();
  }

  /** Visits live in the panel. The sky does not tap-select them. */
  setVisited(_ids: number[]): void {}

  /**
   * Boot camp: the same star, the same world and ring (or the
   * landing face), look held on that body. Kepler at live `t`
   * — we do not freeze the clock.
   */
  restorePlace(place: LastPlace): void {
    const obj = objectAt(this.seed, place.starId);
    if (!obj) {
      this.openAtHere();
      return;
    }
    if (this.hostObj && this.hostObj.id !== obj.id) this.detachHost();
    this.pendingSession = null;
    this.pendingPlace = place;
    this.setHere(place.starId);
    this.parkAtStar(obj);
    this.wake();
  }

  /**
   * Boot the live save: catalog pose first, then the host
   * frame applies the ride / land / drone once bodies exist.
   */
  restoreSession(snap: SessionSnap): void {
    this.pendingPlace = null;
    this.pendingSession = snap;
    this.ship.at.set(snap.at[0], snap.at[1], snap.at[2]);
    this.ship.fwd.set(snap.fwd[0], snap.fwd[1], snap.fwd[2]);
    this.ship.up.set(snap.up[0], snap.up[1], snap.up[2]);
    this.ship.orthonormalize();
    this.mintAt.copy(this.ship.at);
    this.astern = snap.astern;
    this.thrustOn = Boolean(snap.thrustOn && !snap.riding && !snap.landed && !snap.departing);
    this.thrustSpeed = 0;
    this.coast.set(0, 0, 0);
    if (snap.coast) this.coast.set(snap.coast[0], snap.coast[1], snap.coast[2]);
    this.departing = snap.departing
      ? {
          v: snap.departing.v,
          vEsc: snap.departing.vEsc,
          dir: new THREE.Vector3(
            snap.departing.dir[0],
            snap.departing.dir[1],
            snap.departing.dir[2],
          ),
        }
      : null;
    this.proximity = snap.proximity;
    this.insertBlend = snap.insertBlend;
    this.pendingOrbit = snap.pendingOrbit
      ? { bodyId: snap.pendingOrbit.bodyId, kind: coerceOrbitKind(snap.pendingOrbit.kind) }
      : null;
    this.pendingArriveOrbit = snap.pendingArriveOrbit;
    this.worldId = snap.worldId ?? snap.bodyId;
    this.sYaw = snap.sYaw;
    this.sPitch = snap.sPitch;
    this.sEyeH = this.sEyeHTarget = snap.sEyeH;
    this.landKind = snap.landKind ? coerceOrbitKind(snap.landKind) : null;
    this.bindSky();
    this.regionLabel = regionName(this.ship.at.x, this.ship.at.y, this.ship.at.z);
    if (snap.starId != null) {
      const obj = objectAt(this.seed, snap.starId);
      if (obj) {
        this.hostObj = obj;
        this.setHere(obj.id);
      } else {
        this.openAtHere();
        this.pendingSession = null;
        return;
      }
    } else {
      this.setHere(null);
    }
    if (snap.course) {
      const dest = objectAt(this.seed, snap.course.starId);
      if (dest) {
        this.courseObj = dest;
        this.courseHud = this.hudForStar(dest);
      }
      this.courseBodyId = snap.course.bodyId;
      if (snap.courseLive) {
        this.route.begin({
          ...snap.course,
          orbit: coerceOrbitKind(snap.course.orbit),
        });
      }
    }
    this.applyCam();
    this.wake();
  }

  /** Leave the current host and park on another catalog star. */
  goToStar(starId: number): void {
    const obj = objectAt(this.seed, starId);
    this.pendingSession = null;
    this.pendingPlace = null;
    if (this.hostObj && this.hostObj.id !== starId) this.detachHost();
    this.setHere(starId);
    if (obj) this.parkAtStar(obj);
    else this.openAtHere();
    this.wake();
  }

  /** Rocky world under the ride / landing / course — inspector body. */
  inspectBody(): BodySpec | null {
    const id = this.riding?.bodyId ?? this.worldId ?? this.courseBodyId;
    const rt = this.worldRt(id);
    if (!rt || rt.spec.kind !== 'rocky') return null;
    return rt.spec;
  }

  /**
   * Viewport mood from the latched world's physics. Density is
   * how close we stand — space, a ring, the skin.
   */
  setMarkTool(tool: MarkTool | null): void {
    this.markTool = tool;
  }

  /**
   * Hex on the latched globe, in canvas pixels. Hidden on the
   * far side; alpha fades over the limb — same facing law.
   */
  projectCell(bodyId: string, cell: number): ProjectedPoint {
    const hidden: ProjectedPoint = { x: 0, y: 0, visible: false, alpha: 0 };
    const globe = this.globeOf(bodyId);
    const rt = this.worldRt(bodyId);
    const dir = globe?.cellCenter(cell);
    if (!globe || !rt || !dir || !this.hostRoot) return hidden;
    this.hostTmp.set(dir[0], dir[1], dir[2]);
    const r = globe.groundR(this.hostTmp);
    this.hostTmp.multiplyScalar(r);
    rt.group.localToWorld(this.hostTmp);
    this.hostTmp2.copy(this.camera.position);
    rt.group.worldToLocal(this.hostTmp2);
    const dist = this.hostTmp2.length();
    if (!(dist > 1e-8)) return hidden;
    this.hostTmp2.multiplyScalar(1 / dist);
    const facing = dir[0] * this.hostTmp2.x + dir[1] * this.hostTmp2.y + dir[2] * this.hostTmp2.z;
    const horizon = Math.min(1, 1 / dist);
    if (facing < horizon) return hidden;
    this.hostTmp.project(this.camera);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const x = (this.hostTmp.x * 0.5 + 0.5) * w;
    const y = (-this.hostTmp.y * 0.5 + 0.5) * h;
    const visible = x > -160 && x < w + 160 && y > -80 && y < h + 80;
    const t = Math.min(1, Math.max(0, (facing - horizon) / Math.max(1e-4, 0.12 * (1 - horizon))));
    return { x, y, visible, alpha: t * t * (3 - 2 * t) };
  }

  getMood(): { group: 'water' | 'green' | 'dry' | 'cold' | 'rock' | 'space'; density: number } {
    if (!this.hostObj) return { group: 'space', density: 0 };
    const rt = this.worldRt(this.riding?.bodyId ?? this.worldId);
    const density = this.landed ? 0.85 : this.riding ? 0.45 : 0.08;
    if (!rt || rt.spec.kind !== 'rocky') return { group: 'space', density };
    const p = rt.spec.physics;
    if (p.life) return { group: 'green', density };
    if (p.hydrosphere.state === 'liquid') return { group: 'water', density };
    if (p.hydrosphere.state === 'ice' || p.TsurfK < 250) return { group: 'cold', density };
    if (p.TsurfK > 330 || p.hydrosphere.substance === 'none') return { group: 'dry', density };
    return { group: 'rock', density };
  }

  snapshotPlace(): LastPlace | null {
    const host = this.hostObj;
    if (!host) return null;
    const rt = this.worldRt(this.riding?.bodyId ?? this.worldId);
    let dir: [number, number, number] | null = null;
    if (this.landed) {
      dir = [this.surfDir.x, this.surfDir.y, this.surfDir.z];
    } else if (this.riding?.hang) {
      dir = [this.rideLocal.x, this.rideLocal.y, this.rideLocal.z];
    } else if (rt) {
      this.bodyFromEye(rt, this.orbitTmp2).negate();
      if (this.orbitTmp2.lengthSq() > 1e-28) {
        this.spinWorld(rt, this.orbitQ);
        this.orbitTmp2.normalize().applyQuaternion(this.hostTmpQ.copy(this.orbitQ).conjugate());
        dir = [this.orbitTmp2.x, this.orbitTmp2.y, this.orbitTmp2.z];
      }
    }
    let h: number | null = null;
    if (this.riding && rt) {
      const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
      h = this.riding.r / Math.max(R, 1e-18) - 1;
    }
    return {
      galaxySeed: this.seed,
      starId: host.id,
      bodyId: rt?.spec.id ?? null,
      orbit: this.riding?.kind ?? (this.landed ? this.landKind : null),
      landed: this.landed,
      dir,
      h,
    };
  }

  snapshotSession(): SessionSnap {
    const v = (p: THREE.Vector3): SessionVec => [p.x, p.y, p.z];
    const ride = this.riding;
    return {
      v: 1,
      galaxySeed: this.seed,
      at: v(this.ship.at),
      fwd: v(this.ship.fwd),
      up: v(this.ship.up),
      thrustOn: this.thrustOn,
      astern: this.astern,
      coast: this.coast.lengthSq() > 0 ? v(this.coast) : null,
      departing: this.departing
        ? { v: this.departing.v, vEsc: this.departing.vEsc, dir: v(this.departing.dir) }
        : null,
      starId: this.hostObj?.id ?? null,
      bodyId:
        this.riding?.bodyId ??
        (this.landed ? this.worldId : null) ??
        this.capturing?.bodyId ??
        null,
      worldId: this.worldId,
      orbit: this.riding?.kind ?? (this.landed ? this.landKind : this.capturing?.kind) ?? null,
      landed: this.landed,
      riding: ride
        ? {
            bodyId: ride.bodyId,
            kind: ride.kind,
            hang: ride.hang,
            r: ride.r,
            theta0: ride.theta0,
            omega: ride.omega,
            e1: v(this.rideE1),
            e2: v(this.rideE2),
            local: v(this.rideLocal),
          }
        : null,
      capturing: this.capturing
        ? {
            bodyId: this.capturing.bodyId,
            kind: this.capturing.kind,
            dir: v(this.capturing.dir),
          }
        : null,
      pendingOrbit: this.destOrbit(),
      pendingArriveOrbit: this.pendingArriveOrbit,
      insertBlend: this.insertBlend,
      surfDir: this.landed ? v(this.surfDir) : null,
      sYaw: this.sYaw,
      sPitch: this.sPitch,
      sEyeH: this.sEyeH,
      landKind: this.landKind,
      course: this.route.dest,
      courseLive: this.route.live,
      proximity: this.proximity,
      drone: this.drone ? this.drone.snap(this.droneRideT) : null,
    };
  }

  flushSession(): void {
    this.emitSession(true);
  }

  private parkAtStar(obj: GalaxyObject): void {
    const c = galToCart(obj.pos);
    this.enterRegion(c.x, c.y, c.z, obj);
    this.hostObj = obj;
    this.setCourse(obj);
    const star = {
      radius: Math.max(1e-6, obj.star.radius) * UNIVERSE.RSUN_KM,
      mass: Math.max(0.08, obj.star.mass),
    };
    const park = starOrbitRadiusKpc(star);
    let ax = c.x;
    let ay = c.y;
    let az = c.z;
    const len = Math.hypot(ax, ay, az);
    if (len < 1e-8) {
      ax = 0;
      ay = 0;
      az = 1;
    } else {
      ax /= len;
      ay /= len;
      az /= len;
    }
    this.ship.at.set(c.x + ax * park, c.y + ay * park, c.z + az * park);
    this.mintAt.copy(this.ship.at);
    // Startup: star below, look forward over the furnace. Zenith =
    // radial out; prograde ⊥ zenith in the galactic-ish plane.
    this.orbitTmp.set(ax, ay, az);
    this.orbitTmp2.crossVectors(this.worldUp, this.orbitTmp);
    if (this.orbitTmp2.lengthSq() < 1e-16) this.orbitTmp2.set(1, 0, 0);
    this.orbitTmp2.normalize();
    this.aimOrbitBank(
      this.orbitTmp2.x,
      this.orbitTmp2.y,
      this.orbitTmp2.z,
      ax,
      ay,
      az,
    );
    this.applyCam();
    // Drop into the ecliptic ring (In Orbit) once the host frame exists.
    this.pendingArriveOrbit = true;
  }

  /** True when the camp is fully applied (or abandoned). */
  private applyPendingPlace(tSys: number): boolean {
    const p = this.pendingPlace;
    if (!p || !this.hostObj || this.hostObj.id !== p.starId) return true;
    if (!this.hostRoot || !this.hostSpec) return false;
    if (!p.bodyId) {
      // Star camp → ecliptic hold.
      if (this.hostRoot) {
        this.hostTmp.copy(this.hostRoot.position).negate().normalize();
      } else {
        this.orientArc();
        this.hostTmp.copy(this.ship.fwd).negate();
      }
      this.beginStarRide(this.hostTmp, tSys);
      this.pendingPlace = null;
      return true;
    }
    const rt = this.worldRt(p.bodyId);
    if (!rt) {
      this.pendingPlace = null;
      return true;
    }
    this.worldId = rt.spec.id;
    this.courseBodyId = rt.spec.id;
    this.courseHud = this.hudForBody(rt);
    const dir = this.dirFromPlace(p, rt);
    if (p.landed) {
      const globe = this.globeOf(rt.spec.id);
      if (!globe?.ready) return false;
      this.landKind = coerceOrbitKind(p.orbit ?? 'hover');
      this.clearRide();
      this.pendingOrbit = null;
      this.pendingArriveOrbit = false;
      this.capturing = null;
      this.surfDir.set(p.dir?.[0] ?? 0, p.dir?.[1] ?? 0, p.dir?.[2] ?? 1);
      if (this.surfDir.lengthSq() < 1e-16) this.surfDir.set(0, 0, 1);
      this.surfDir.normalize();
      this.sYaw = 0;
      this.sPitch = UNIVERSE.WORLD_SURF_PITCH;
      this.sEyeH = this.sEyeHTarget = Math.max(globe.terraceStep * 0.6, globe.terraceStep * 4);
      this.sWalk = 0;
      this.landed = true;
      this.navMode = null;
      this.placeSurface();
      this.pendingPlace = null;
      return true;
    }
    const kind = coerceOrbitKind(p.orbit ?? 'hover');
    this.beginRide(rt, kind, dir, tSys);
    if (p.h != null && this.riding) {
      const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
      const lo = shellFloorKm(rt.spec) * KM_TO_KPC;
      const hi = Math.max(R * (1 + UNIVERSE.SOI_TRACK_MAX), UNIVERSE.WORLD_RANGE_KPC * 0.8);
      this.riding.r = THREE.MathUtils.clamp(R * (1 + p.h), lo, hi);
    }
    if (kind && isHangOrbit(kind) && p.dir && this.riding) {
      this.rideLocal.set(p.dir[0], p.dir[1], p.dir[2]).normalize();
    }
    this.placeRide(tSys);
    this.pendingPlace = null;
    return true;
  }

  /** Apply the live save once the host km frame (and globe) exist. */
  private applyPendingSession(tSys: number): boolean {
    const s = this.pendingSession;
    if (!s) return true;
    if (s.starId != null) {
      if (!this.hostObj || this.hostObj.id !== s.starId) return false;
      if (!this.hostRoot || !this.hostSpec) return false;
    }
    if (s.landed) {
      const id = s.worldId ?? s.bodyId;
      const globe = this.globeOf(id);
      if (!globe?.ready) return false;
    }
    if (s.riding) {
      const kind = coerceOrbitKind(s.riding.kind);
      this.riding = {
        bodyId: s.riding.bodyId,
        kind,
        hang: isHangOrbit(kind),
        r: s.riding.r,
        theta0: s.riding.theta0,
        omega: s.riding.omega,
      };
      if (s.riding.bodyId) {
        const rt = this.worldRt(s.riding.bodyId);
        if (rt) {
          this.riding.r = orbitRadiusKpc(rt.spec, kind);
          this.riding.omega = isHangOrbit(kind) ? 0 : orbitOmega(rt.spec, kind);
        }
      } else if (this.hostObj) {
        const star = this.hostSpec?.star ?? {
          radius: Math.max(1e-6, this.hostObj.star.radius) * UNIVERSE.RSUN_KM,
          mass: Math.max(0.08, this.hostObj.star.mass),
        };
        this.riding.r = starOrbitRadiusKpc(star);
        this.riding.omega = starOrbitOmega(star, this.riding.r);
      }
      this.rideE1.set(s.riding.e1[0], s.riding.e1[1], s.riding.e1[2]);
      this.rideE2.set(s.riding.e2[0], s.riding.e2[1], s.riding.e2[2]);
      this.rideLocal.set(s.riding.local[0], s.riding.local[1], s.riding.local[2]);
      this.navMode = 'orbit';
      this.placeRide(tSys);
    }
    if (s.capturing) {
      this.capturing = {
        bodyId: s.capturing.bodyId,
        kind: coerceOrbitKind(s.capturing.kind),
        dir: new THREE.Vector3(s.capturing.dir[0], s.capturing.dir[1], s.capturing.dir[2]),
      };
    }
    if (s.landed) {
      this.landed = true;
      this.worldId = s.worldId ?? s.bodyId;
      this.courseBodyId = this.worldId;
      this.landKind = s.landKind ? coerceOrbitKind(s.landKind) : null;
      if (s.surfDir) this.surfDir.set(s.surfDir[0], s.surfDir[1], s.surfDir[2]);
      this.sYaw = s.sYaw;
      this.sPitch = s.sPitch;
      this.sEyeH = this.sEyeHTarget = s.sEyeH;
      this.sWalk = 0;
      this.navMode = null;
      this.placeSurface();
    }
    if (s.drone) {
      this.drone = new Trackball();
      this.drone.restore(s.drone);
      this.droneRideT = s.drone.rideT;
      this.placeDrone();
    }
    this.pendingSession = null;
    this.applyCam();
    return true;
  }

  private emitSession(force = false): void {
    if (!this.callbacks.onSession || this.pendingSession) return;
    const snap = this.snapshotSession();
    const json = JSON.stringify(snap);
    if (json === this.lastSessionJson) return;
    const now = performance.now();
    if (!force && now - this.lastSessionWrite < 200) return;
    this.lastSessionJson = json;
    this.lastSessionWrite = now;
    this.callbacks.onSession(snap);
  }

  private dirFromPlace(p: LastPlace, rt: HostBodyRT): THREE.Vector3 {
    if (p.dir) {
      this.spinWorld(rt, this.orbitQ);
      this.orbitTmp.set(p.dir[0], p.dir[1], p.dir[2]).normalize().applyQuaternion(this.orbitQ);
      return this.orbitTmp;
    }
    this.bodyFromEye(rt, this.orbitTmp2).negate();
    if (this.orbitTmp2.lengthSq() < 1e-28) {
      this.orientArc();
      this.orbitTmp2.copy(this.ship.fwd).negate();
    }
    return this.orbitTmp2.normalize();
  }

  private emitPlace(): void {
    if (this.pendingPlace || this.pendingSession || !this.callbacks.onPlace) return;
    const p = this.snapshotPlace();
    if (!p) return;
    const key = `${p.starId}|${p.bodyId ?? ''}|${p.orbit ?? ''}|${p.landed ? 1 : 0}`;
    if (key === this.lastPlaceKey) return;
    this.lastPlaceKey = key;
    this.callbacks.onPlace(p);
  }

  // ------------------------------------------------------------- region mode

  /** Catalog cartesian → camera frame (origin at the bubble centre). */
  private toView(x: number, y: number, z: number): { x: number; y: number; z: number } {
    if (this.mode !== 'region') return { x, y, z };
    return {
      x: x - this.ship.at.x,
      y: y - this.ship.at.y,
      z: z - this.ship.at.z,
    };
  }

  private viewCart(obj: GalaxyObject): { x: number; y: number; z: number } {
    const c = galToCart(obj.pos);
    return this.toView(c.x, c.y, c.z);
  }

  /**
   * Park the viewpoint at a catalog point. The sky is the once-per-
   * load harvest — we do not remint a neighbourhood. A teleport
   * drops the live dest; Set course / a visit then names a new one.
   */
  enterRegion(x: number, y: number, z: number, select: GalaxyObject | null = null): void {
    this.leaveSurface();
    this.clearRide();
    this.route.abort();
    this.pendingOrbit = null;
    this.pendingArriveOrbit = false;
    this.mode = 'region';
    this.ship.at.set(x, y, z);
    this.mintAt.set(x, y, z);
    this.bindSky();
    this.regionLabel = regionName(x, y, z);
    this.objects = [];
    this.resetThrust();
    this.courseObj = null;
    this.courseHud = null;

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
    return this.sky.shownCount();
  }

  /** Attach stars / nebulae / dust if those caches are warm. */
  private bindSky(): void {
    this.sky.bind();
    this.sectorPop = this.sky.shownCount();
    this.lastEnterMs = Math.max(this.sky.mintedMs(), this.lastEnterMs);
  }

  /** Live cosmic-engineer write. One uniform, next frame. */
  setLiveUniform(name: string, value: number): void {
    this.sky.setLiveUniform(name, value);
  }

  liveUniform(name: string): number | null {
    return this.sky.liveUniform(name);
  }

  /** After a star remint — drop the star mesh only. Nebulae and fog stay. */
  replaceSky(): void {
    this.wake();
    this.sky.replaceSky();
    this.sectorPop = this.sky.shownCount();
    this.lastEnterMs = this.sky.cloud?.ms ?? this.lastEnterMs;
    if (this.mode === 'region') this.updateSight(true);
  }

  /** After a nebula rebake — drop the nebula mesh only. Stars and fog stay. */
  replaceNebulae(): void {
    this.wake();
    this.sky.replaceNebulae();
    this.sectorPop = this.sky.shownCount();
    this.lastEnterMs = this.sky.nebulae?.ms ?? this.lastEnterMs;
    if (this.mode === 'region') this.updateSight(true);
  }

  private perf!: PerfMeter;

  /** Swap the 3D texture on the existing sky — after any bake. */
  replaceDust(): void {
    this.wake();
    this.sky.replaceDust();
  }

  /** Bubble centre + survey dim → the sky. Place laws stay here. */
  private pushMagUniforms(): void {
    const dim = this.skyDim();
    this.sky.pushCenter(this.ship.at.x, this.ship.at.y, this.ship.at.z, dim);
    if (this.hostFill) this.hostFill.intensity = dim;
  }

  /**
   * Catalog distance to the nearest harvest star if the
   * viewpoint is inside that star's sphere. Known subjects
   * first (host / course / reticle / here); otherwise a
   * harvest walk. Null outside every fence. Lock and helm
   * gear do not choose the centre.
   */
  private soiDist(): number | null {
    const range = UNIVERSE.ARRIVE_RANGE_KPC;
    if (!(range > 0)) return null;
    const r2 = range * range;
    let best2 = Infinity;
    const considerObj = (obj: GalaxyObject | null): void => {
      if (!obj) return;
      const d = this.arriveDist(obj);
      const d2 = d * d;
      if (d2 < best2) best2 = d2;
    };
    considerObj(this.hostObj);
    considerObj(this.courseObj);
    considerObj(this.focusObj);
    considerObj(this.selected);
    considerObj(this.hereObj);
    // A known subject inside AIM_RANGE is the sphere we are
    // with. Do not walk the disk for another 0.01 ly bubble.
    const aim2 = UNIVERSE.AIM_RANGE_KPC * UNIVERSE.AIM_RANGE_KPC;
    const cloud = this.sky.cloud;
    if (best2 > r2 && best2 > aim2 && cloud) {
      const cat = cloud.pos;
      const ox = this.ship.at.x;
      const oy = this.ship.at.y;
      const oz = this.ship.at.z;
      for (let i = 0; i < cloud.n; i++) {
        const i3 = i * 3;
        const dx = cat[i3] - ox;
        const dy = cat[i3 + 1] - oy;
        const dz = cat[i3 + 2] - oz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best2) best2 = d2;
        if (best2 <= r2) break;
      }
    }
    if (best2 > r2) return null;
    return Math.sqrt(best2);
  }

  /**
   * Survey gain at the viewpoint. surveyGain of soiDist —
   * a place law. Ahead, astern, lock, and look-around do
   * not enter. The furnace is a second pass and is not dimmed.
   */
  private skyDim(): number {
    const d = this.soiDist();
    return d == null ? 1 : surveyGain(d);
  }

  // --------------------------------------------------------------- state

  setFilter(f: GalaxyFilter): void {
    this.wake();
    this.sky.setFilter(f);
    if (this.mode === 'region') this.updateSight(true);
  }

  dismiss(): void {
    this.select(null);
  }

  /**
   * Name a berth and latch warp-ahead. Reticle / plate / chart
   * only — a tap does not call this. Works from catalog or
   * another system's SOI. While the drone is out this is a
   * no-op — land first. Drag aborts; Stop only kills thrust.
   */
  setCourse(obj: GalaxyObject): void {
    this.setCourseBerth({ starId: obj.id, bodyId: null, orbit: 'ecliptic' });
  }

  /** Plate: a world of the focused / host star → equatorial berth. */
  setCourseBody(bodyId: string): void {
    const starId = this.focusObj?.id ?? this.hostObj?.id;
    if (starId == null) return;
    this.setCourseBerth({ starId, bodyId, orbit: 'equatorial' });
  }

  /**
   * Chart pick: berth on the focused harvest star (or the
   * host if there is no other focus). Does not require
   * hostObj === dest.
   */
  goToWorldOrbit(bodyId: string, kind: WorldOrbitKind): void {
    const starId = this.focusObj?.id ?? this.hostObj?.id;
    if (starId == null) return;
    this.setCourseBerth({ starId, bodyId, orbit: kind });
  }

  /**
   * Live dest ring. Course owns it; `pendingOrbit` is only
   * a restore shadow so a host teardown cannot drop lock-on.
   */
  private destOrbit(): { bodyId: string | null; kind: WorldOrbitKind } | null {
    return this.route.destOrbit() ?? this.pendingOrbit;
  }

  setCourseBerth(dest: Berth): void {
    if (this.mode !== 'region' || this.drone) return;
    const obj = objectAt(this.seed, dest.starId);
    if (!obj) return;
    if (this.landed) this.takeOff();
    this.leaveSurface();
    if (this.riding || this.capturing) this.breakOrbit();
    this.clearDepart();
    this.proximity = false;
    this.route.begin(dest);
    this.courseObj = obj;
    this.courseBodyId = dest.bodyId;
    this.pendingArriveOrbit = false;
    this.pendingOrbit = { bodyId: dest.bodyId, kind: coerceOrbitKind(dest.orbit) };
    this.navMode = 'lock';
    this.resetRoutePlot();
    if (dest.bodyId) {
      const rt = this.worldRt(dest.bodyId);
      this.selectedBodyId = dest.bodyId;
      this.courseHud = rt ? this.hudForBody(rt) : this.hudForStar(obj);
    } else {
      this.selectedBodyId = null;
      this.courseHud = this.hudForStar(obj);
    }
    this.select(null);
    this.beginAutopilot();
  }

  private hudForStar(obj: GalaxyObject): GalaxyFocus {
    const brief = this.briefFor(obj);
    const st = obj.star;
    return {
      id: obj.id,
      name: brief.name,
      cls: classifyStar(st),
      phase: st.phase.replace(/_/g, ' '),
      planets: brief.planets,
      moons: brief.moons,
      life: brief.life,
      dark: st.phase.includes('dwarf') || st.luminosity < 0.05,
      x: 0.5,
      y: 0.5,
      dist: this.arriveDist(obj),
    };
  }

  /** Lock-on is warp-ahead until a look drag aborts it. */
  private beginAutopilot(): void {
    if (this.drone) return;
    this.navMode = 'lock';
    if (this.riding || this.capturing) {
      this.wake();
      return;
    }
    if (this.thrustOn) this.setWarp(false);
    this.setGear(false);
    this.setWarp(true);
    this.wake();
  }

  /** Finger drag: drop the route and stop warp. Stop does not call this. */
  private abortAutopilot(): void {
    if (!this.route.live && this.navMode !== 'lock') return;
    this.pendingOrbit = null;
    this.pendingArriveOrbit = false;
    this.insertBlend = 0;
    this.route.abort();
    this.clearCourse();
    if (this.thrustOn) this.setWarp(false);
  }

  private clearRide(): void {
    this.riding = null;
    this.capturing = null;
  }

  private leaveSurface(): void {
    this.landed = false;
    this.sWalk = 0;
  }

  private canLandNow(): boolean {
    if (this.landed || this.departing) return false;
    const id = this.riding?.bodyId ?? this.worldId;
    const rt = this.worldRt(id);
    if (!rt || rt.spec.kind !== 'rocky') return false;
    const globe = this.globeOf(rt.spec.id);
    if (!globe?.ready) return false;
    return true;
  }

  /**
   * Set down on the skin under the camera. The viewpoint
   * joins the spinning frame — you stand on the turning world.
   */
  land(): void {
    if (this.departing) return;
    if (this.drone) this.setDrone(false, false);
    if (this.mode !== 'region' || !this.hostObj) return;
    const id = this.riding?.bodyId ?? this.worldId;
    const rt = this.worldRt(id);
    if (!rt) return;
    const globe = this.globeOf(rt.spec.id);
    if (!this.canLandNow() || !globe) return;
    this.landKind = this.riding?.kind ?? 'hover';
    this.clearRide();
    this.pendingOrbit = null;
    this.pendingArriveOrbit = false;
    this.capturing = null;
    this.setWarp(false);
    this.bodyFromEye(rt, this.orbitTmp2).negate();
    if (this.orbitTmp2.lengthSq() < 1e-28) {
      this.orientArc();
      this.orbitTmp2.copy(this.ship.fwd).negate();
    }
    this.orbitTmp2.normalize();
    this.spinWorld(rt, this.orbitQ);
    this.surfDir.copy(this.orbitTmp2).applyQuaternion(this.orbitQ.clone().conjugate());
    this.surfBasis(this.surfDir, this.surfEast, this.surfNorth);
    this.orbitTmp.copy(this.ship.up).applyQuaternion(this.orbitQ.clone().conjugate());
    this.sYaw = Math.atan2(this.orbitTmp.dot(this.surfEast), this.orbitTmp.dot(this.surfNorth));
    this.sPitch = UNIVERSE.WORLD_SURF_PITCH;
    this.sEyeH = this.sEyeHTarget = Math.max(globe.terraceStep * 0.6, globe.terraceStep * 4);
    this.sWalk = 0;
    this.landed = true;
    this.navMode = null;
    this.courseBodyId = rt.spec.id;
    this.worldId = rt.spec.id;
    this.courseHud = this.hudForBody(rt);
    this.placeSurface();
    this.applyCam();
    this.wake();
  }

  /** Rise from the landing spot back onto the ring we left. */
  takeOff(): void {
    if (this.drone) this.setDrone(false, false);
    if (!this.landed || this.mode !== 'region') return;
    const rt = this.worldRt(this.worldId ?? this.courseBodyId);
    const kind = this.landKind ?? 'hover';
    this.leaveSurface();
    if (!rt) return;
    this.spinWorld(rt, this.orbitQ);
    this.orbitTmp2.copy(this.surfDir).applyQuaternion(this.orbitQ);
    const tSys = (this.epochUnix + performance.now() / 1000) * UNIVERSE.TIME_SCALE;
    this.beginRide(rt, kind, this.orbitTmp2, tSys);
    this.courseBodyId = rt.spec.id;
    this.courseHud = this.hudForBody(rt);
    this.applyCam();
    this.wake();
  }

  /**
   * Drone only. Off: free fly. On: lock the body in the
   * pip (tap or reticle). Launch already locked the body
   * nearest the ship — this retargets; it does not hop.
   */
  centerLook(): void {
    if (this.mode !== 'region' || !this.hostObj || !this.drone || this.drone.phase) return;
    this.drone.toggleLock(this.droneWorld());
    this.placeDrone();
    this.applyCam();
    this.wake();
  }

  /** Tap: on if off, off if on. Returns the new state. */
  toggleDrone(): boolean {
    this.setDrone(!this.drone);
    return Boolean(this.drone);
  }

  setDrone(on: boolean, ease = true): void {
    if (this.departing) return;
    if (this.mode !== 'region' || !this.hostObj || !this.hostRoot) return;
    if (!on) {
      if (!this.drone) return;
      if (!ease || this.drone.phase === 'home') {
        this.drone = null;
        this.restoreShipCam();
        return;
      }
      this.drone.beginHome();
      this.wake();
      return;
    }
    if (this.drone) return;
    this.clearDepart();
    const tSys = (this.epochUnix + performance.now() / 1000) * UNIVERSE.TIME_SCALE;
    this.droneRideT = tSys;
    this.hostTmpQ.copy(this.hostRoot.quaternion).conjugate();
    this.hostEyeKm(this.orbitTmp2);
    const fwd = this.droneLocalLook(this.ship.fwd, this.hostTmpQ);
    const up = this.droneLocalLook(this.ship.up, this.hostTmpQ);
    this.drone = new Trackball();
    this.drone.launch(this.orbitTmp2, fwd, up, this.droneWorld());
    this.placeDrone();
    this.applyCam();
    this.wake();
  }

  /** Camera back onto the parked ship. The ship never moved. */
  private restoreShipCam(): void {
    if (this.riding && this.hostObj) {
      const tSys = (this.epochUnix + performance.now() / 1000) * UNIVERSE.TIME_SCALE;
      const dt = tSys - this.droneRideT;
      this.riding.theta0 -= this.riding.omega * dt;
      this.placeRide(tSys);
    } else if (this.landed) {
      this.placeSurface();
    } else {
      const root = this.hostRoot;
      const lock = this.hostObj;
      if (root && lock) {
        const cart = galToCart(lock.pos);
        root.position.set(
          cart.x - this.ship.at.x,
          cart.y - this.ship.at.y,
          cart.z - this.ship.at.z,
        );
        root.updateMatrixWorld(true);
      }
    }
    this.applyCam();
    this.wake();
  }

  private droneWorld(): DroneWorld {
    return {
      nearestFrom: (eye) => {
        const n = this.dronePickNearestFrom(eye);
        return { id: n.id, pos: this.droneCorePos, R: n.R };
      },
      subject: (eye) => this.droneSubject(eye),
      coreOf: (id, out) => {
        const R = this.droneCoreOf(id);
        out.copy(this.droneCorePos);
        return R;
      },
      fillKm: (R) => this.droneFillKm(R),
      reticleTarget: () => this.droneReticleTarget(),
    };
  }

  /**
   * Core the drone backs off from and locks: the body the ship
   * is on (capture / ride / latched world). `null` is the star
   * only when there is no world in that chain.
   */
  private droneOrbitId(): string | null {
    return (
      this.capturing?.bodyId ??
      this.destOrbit()?.bodyId ??
      this.riding?.bodyId ??
      this.worldId ??
      this.courseBodyId ??
      null
    );
  }

  private droneSubject(eye: THREE.Vector3): { id: string | null; pos: THREE.Vector3; R: number } {
    const id = this.droneOrbitId();
    if (id && this.worldRt(id)) {
      const R = this.droneCoreOf(id);
      return { id, pos: this.droneCorePos, R };
    }
    if (id == null && (this.riding || this.destOrbit() || this.capturing)) {
      const R = this.droneCoreOf(null);
      return { id: null, pos: this.droneCorePos, R };
    }
    const n = this.dronePickNearestFrom(eye);
    return { id: n.id, pos: this.droneCorePos, R: n.R };
  }

  /** Same fill law as the ship park: disk covers ARRIVE_FILL of the short FOV. */
  private droneFillKm(R: number): number {
    return fillViewRadius(Math.max(R, 1), this.camera.fov, this.camera.aspect);
  }

  private placeDrone(): void {
    const drone = this.drone;
    if (!drone || !this.hostRoot || !this.hostObj) return;
    this.pinHostEyeKm(drone.eye, false);
  }

  /** Camera → host-root km. Inverse of pinHostEyeKm. */
  private hostEyeKm(out: THREE.Vector3): THREE.Vector3 {
    const root = this.hostRoot;
    if (!root) return out.set(0, 0, 0);
    return out
      .copy(root.position)
      .negate()
      .applyQuaternion(this.hostTmpQ.copy(root.quaternion).conjugate())
      .multiplyScalar(1 / KM_TO_KPC);
  }

  private hostStarRadiusKm(): number {
    return Math.max(1, this.hostSpec?.star.radius ?? UNIVERSE.RSUN_KM);
  }

  /**
   * Core nearest a host-km point (a world, else the star).
   * Launch uses the ship; stay-out uses the drone. Writes
   * droneCorePos. Lock itself never hops.
   */
  private dronePickNearestFrom(eye: THREE.Vector3): { id: string | null; R: number } {
    const rt = nearestBody(this.host.bodies, (b) => eye.distanceTo(b.pos));
    const starD = eye.length();
    if (rt && eye.distanceTo(rt.pos) < starD) {
      this.droneCorePos.copy(rt.pos);
      return { id: rt.spec.id, R: Math.max(1, rt.spec.radius) };
    }
    this.droneCorePos.set(0, 0, 0);
    return { id: null, R: this.hostStarRadiusKm() };
  }

  /** Body (or the star) in the centre pip. Null if the pip is empty. */
  private droneReticleTarget(): { id: string | null } | null {
    if (this.focusBodyId && this.worldRt(this.focusBodyId)) return { id: this.focusBodyId };
    if (this.selectedBodyId && this.worldRt(this.selectedBodyId)) return { id: this.selectedBodyId };
    const root = this.hostRoot;
    if (!root) return null;
    const d = root.position.length();
    if (d < 1e-18) return { id: null };
    const inv = 1 / d;
    const dot =
      root.position.x * inv * this.ship.fwd.x +
      root.position.y * inv * this.ship.fwd.y +
      root.position.z * inv * this.ship.fwd.z;
    if (dot >= Math.cos(RETICLE_LOCK)) return { id: null };
    return null;
  }

  private droneCoreOf(id: string | null): number {
    if (id) {
      const rt = this.worldRt(id);
      if (rt) {
        this.droneCorePos.copy(rt.pos);
        return Math.max(1, rt.spec.radius);
      }
    }
    this.droneCorePos.set(0, 0, 0);
    return this.hostStarRadiusKm();
  }

  /** Soft floor: do not go inside a ball. Atmosphere is outside R. */
  /** World look vector into the drone's local frame. */
  private droneLocalLook(world: THREE.Vector3, localOfWorld: THREE.Quaternion): THREE.Vector3 {
    this.orbitTmp2.copy(world).applyQuaternion(localOfWorld);
    if (this.orbitTmp2.lengthSq() < 1e-16) this.orbitTmp2.set(0, 0, 1);
    return this.orbitTmp2.normalize().clone();
  }

  private turnDrone(dx: number, dy: number): void {
    if (!this.drone) return;
    this.drone.look(dx, dy, this.droneWorld());
    this.placeDrone();
    this.applyCam();
  }

  private tickDrone(dt: number): void {
    if (!this.drone) return;
    const done = this.drone.tick(dt, this.droneWorld());
    this.placeDrone();
    if (done === 'docked') {
      this.drone = null;
      this.restoreShipCam();
    }
  }

  private surfBasis(dir: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3): void {
    east.set(-dir.y, dir.x, 0);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    north.crossVectors(dir, east);
  }

  private applySurfaceZoom(logZoom: number): void {
    if (logZoom > 0) {
      this.sWalk = Math.min(1, this.sWalk + logZoom * UNIVERSE.WORLD_SURF_WALK);
    } else if (this.sWalk > 0.02) {
      this.sWalk = Math.max(0, this.sWalk + logZoom * UNIVERSE.WORLD_SURF_STOP);
    } else {
      this.sWalk = 0;
      const globe = this.globeOf(this.worldId ?? this.courseBodyId);
      if (!globe) return;
      const lo = Math.max(0.004, globe.terraceStep * 0.6);
      this.sEyeHTarget = Math.min(
        UNIVERSE.WORLD_SURF_EYE_MAX,
        Math.max(lo, this.sEyeHTarget * Math.exp(logZoom * UNIVERSE.WORLD_SURF_HEIGHT)),
      );
    }
    this.wake();
  }

  private walkSurface(dt: number): void {
    if (!this.landed) return;
    if (Math.abs(this.sEyeH - this.sEyeHTarget) > this.sEyeHTarget * 0.001) {
      this.sEyeH += (this.sEyeHTarget - this.sEyeH) * (1 - Math.exp(-dt * 10));
    }
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
    if (mag <= 1e-4) return;
    this.surfBasis(this.surfDir, this.surfEast, this.surfNorth);
    const cy = Math.cos(this.sYaw);
    const sy = Math.sin(this.sYaw);
    this.orbitTmp
      .copy(this.surfNorth)
      .multiplyScalar(cy)
      .addScaledVector(this.surfEast, sy);
    this.orbitTmp2
      .set(0, 0, 0)
      .addScaledVector(this.surfNorth, (cy * mF - sy * mR) / mag)
      .addScaledVector(this.surfEast, (sy * mF + cy * mR) / mag);
    const ang = (0.06 + 2.4 * this.sEyeH) * Math.min(3, mag) * dt;
    this.surfDir.multiplyScalar(Math.cos(ang)).addScaledVector(this.orbitTmp2, Math.sin(ang)).normalize();
    this.surfBasis(this.surfDir, this.surfEast, this.surfNorth);
    this.orbitTmp.addScaledVector(this.surfDir, -this.orbitTmp.dot(this.surfDir)).normalize();
    this.sYaw = Math.atan2(this.orbitTmp.dot(this.surfEast), this.orbitTmp.dot(this.surfNorth));
  }

  private placeSurface(): void {
    if (!this.landed || !this.hostObj) return;
    const rt = this.worldRt(this.worldId ?? this.courseBodyId);
    if (!rt) {
      this.leaveSurface();
      return;
    }
    const globe = this.globeOf(rt.spec.id);
    const gR = globe?.ready ? globe.groundR(this.surfDir) : 1;
    const eyeKm = (gR + this.sEyeH) * Math.max(rt.spec.radius, 1);
    // Eye in the host-root km frame (body centre + spun hover).
    this.orbitTmp2.copy(this.surfDir).applyQuaternion(rt.spinQ).multiplyScalar(eyeKm).add(rt.pos);
    this.pinHostEyeKm(this.orbitTmp2);
    this.spinWorld(rt, this.orbitQ);
    this.surfBasis(this.surfDir, this.surfEast, this.surfNorth);
    this.orbitTmp
      .copy(this.surfNorth)
      .multiplyScalar(Math.cos(this.sYaw))
      .addScaledVector(this.surfEast, Math.sin(this.sYaw));
    this.orbitTmp2
      .copy(this.orbitTmp)
      .multiplyScalar(Math.cos(this.sPitch))
      .addScaledVector(this.surfDir, Math.sin(this.sPitch));
    this.orbitTmp2.applyQuaternion(this.orbitQ);
    this.ship.fwd.copy(this.orbitTmp2).normalize();
    this.ship.up.copy(this.surfDir).applyQuaternion(this.orbitQ).normalize();
    this.ship.right.crossVectors(this.ship.fwd, this.ship.up);
    if (this.ship.right.lengthSq() < 1e-12) this.ship.right.set(1, 0, 0);
    else this.ship.right.normalize();
    this.ship.up.crossVectors(this.ship.right, this.ship.fwd).normalize();
  }

  /**
   * Pin hostRoot so a host-root-local km point sits at the
   * camera. Do not fold that offset into the 8 kpc catalog
   * point first — a metre there is below a ULP.
   */
  private pinHostEyeKm(eyeKm: THREE.Vector3, writeShip = true): void {
    const root = this.hostRoot;
    const lock = this.hostObj;
    if (!root || !lock) return;
    this.orbitTmp.copy(eyeKm).multiplyScalar(KM_TO_KPC).applyQuaternion(root.quaternion);
    root.position.copy(this.orbitTmp).negate();
    root.updateMatrixWorld(true);
    if (!writeShip) return;
    const cart = galToCart(lock.pos);
    this.ship.at.copy(cart).add(this.orbitTmp);
  }

  /** Catalog position of a host-pass body — independent of arcCenter. */
  private bodyCatalog(rt: HostBodyRT, out: THREE.Vector3): THREE.Vector3 {
    const lock = this.hostObj;
    if (!lock) return out.set(0, 0, 0);
    const c = galToCart(lock.pos);
    out.copy(rt.pos).multiplyScalar(KM_TO_KPC);
    if (this.hostRoot) out.applyQuaternion(this.hostRoot.quaternion);
    out.x += c.x;
    out.y += c.y;
    out.z += c.z;
    return out;
  }

  /**
   * Camera → body in catalog kpc. Order is the precision law:
   * star − eye is an exact difference of two nearby ~8 kpc
   * doubles; the body's km offset adds after, in that small
   * frame. Folding the kilometres into the 8 kpc point first
   * quantizes them by a ULP (~30 km) — that noise was the
   * shell-park zigzag that never arrived.
   */
  private bodyFromEye(rt: HostBodyRT, out: THREE.Vector3): THREE.Vector3 {
    const lock = this.hostObj;
    if (!lock) return out.set(0, 0, 0);
    out.copy(rt.pos).multiplyScalar(KM_TO_KPC);
    if (this.hostRoot) out.applyQuaternion(this.hostRoot.quaternion);
    const c = galToCart(lock.pos);
    out.x += c.x - this.ship.at.x;
    out.y += c.y - this.ship.at.y;
    out.z += c.z - this.ship.at.z;
    return out;
  }

  /**
   * First forward hit with a sphere of radius `R` about the
   * body. Null if the ray misses, or if we are inside (the
   * only hit is the far side — we never punch through).
   */
  private firstShellHit(rel: THREE.Vector3, dir: THREE.Vector3, R: number): number | null {
    const d2 = rel.lengthSq();
    const R2 = R * R;
    if (d2 < R2) return null;
    const b = dir.x * rel.x + dir.y * rel.y + dir.z * rel.z;
    const disc = b * b - (d2 - R2);
    if (disc < 0) return null;
    const t = b - Math.sqrt(disc);
    if (t > 1e-18) return t;
    if (t >= -1e-12) return 0;
    return null;
  }

  /**
   * Close on a world shell at the first contact on the way.
   * Inside: back out radially (planet still ahead). True when
   * this frame consumed the step.
   */
  private closeWorldShell(rt: HostBodyRT, park: number, step: number, onPark: () => void): boolean {
    this.bodyFromEye(rt, this.hostTmp);
    const d = Math.max(this.hostTmp.length(), 1e-18);
    const slack = Math.max(park * 0.002, 1e-18);
    if (Math.abs(d - park) <= slack) {
      onPark();
      return true;
    }
    if (d < park) {
      const remain = park - d;
      const go = Math.min(step, remain);
      const k = go / d;
      this.moveBubble(-this.hostTmp.x * k, -this.hostTmp.y * k, -this.hostTmp.z * k);
      if (go >= remain * 0.999) onPark();
      return true;
    }
    const t = this.firstShellHit(this.hostTmp, this.ship.fwd, park);
    if (t != null && t <= step) {
      this.moveBubble(this.ship.fwd.x * t, this.ship.fwd.y * t, this.ship.fwd.z * t);
      onPark();
      return true;
    }
    return false;
  }

  private spinWorld(rt: HostBodyRT, out: THREE.Quaternion): THREE.Quaternion {
    out.copy(rt.spinQ);
    if (this.hostRoot) out.premultiply(this.hostRoot.quaternion);
    return out;
  }

  private enterRide(tSys: number): void {
    const pending = this.destOrbit();
    if (!pending) return;
    if (pending.bodyId == null) {
      // Host-star ecliptic — wait until the dest sphere is the place.
      if (!this.hostObj || this.hostObj.id !== this.route.dest?.starId) return;
      this.pendingArriveOrbit = false;
      this.setWarp(false);
      if (this.hostRoot) {
        this.hostTmp.copy(this.hostRoot.position).negate().normalize();
      } else {
        const c = galToCart(this.hostObj.pos);
        this.hostTmp.set(
          this.ship.at.x - c.x,
          this.ship.at.y - c.y,
          this.ship.at.z - c.z,
        );
        if (this.hostTmp.lengthSq() < 1e-28) {
          this.orientArc();
          this.hostTmp.copy(this.ship.fwd).negate();
        } else this.hostTmp.normalize();
      }
      this.capturing = {
        bodyId: null,
        kind: 'ecliptic',
        dir: this.hostTmp.clone(),
      };
      this.navMode = 'lock';
      this.tickCapture(this.lastDt || 1 / 60, tSys);
      return;
    }
    const rt = this.worldRt(pending.bodyId);
    if (!rt || this.hostObj?.id !== this.route.dest?.starId) return;
    this.pendingArriveOrbit = false;
    this.setWarp(false);
    this.bodyFromEye(rt, this.orbitTmp2).negate();
    if (this.orbitTmp2.lengthSq() < 1e-28) {
      this.orientArc();
      this.orbitTmp2.copy(this.ship.fwd).negate();
    }
    this.orbitTmp2.normalize();
    // Capture burn — ease onto the rail, then latch In Orbit.
    this.capturing = {
      bodyId: pending.bodyId,
      kind: pending.kind,
      dir: this.orbitTmp2.clone(),
    };
    this.navMode = 'lock';
    this.aimLimbParkLook(rt, pending.kind, this.orbitTmp2);
    this.tickCapture(this.lastDt || 1 / 60, tSys);
  }

  /**
   * Soft-seek the eye and nose onto the chosen ring. When close
   * enough, beginRide latches In Orbit and Lock-on ends.
   */
  private tickCapture(dt: number, tSys: number): void {
    const cap = this.capturing;
    if (!cap || !this.hostObj) return;
    if (cap.bodyId == null) {
      this.tickStarCapture(dt, tSys, cap.dir);
      return;
    }
    const rt = this.worldRt(cap.bodyId);
    if (!rt) {
      this.capturing = null;
      if (this.navMode === 'lock') this.navMode = null;
      return;
    }
    const r = orbitRadiusKpc(rt.spec, cap.kind);
    const hang = isHangOrbit(cap.kind);
    this.spinWorld(rt, this.orbitQ);
    // Desired ring offset from the body (catalog), same law as placeRide.
    if (hang) {
      this.rideLocal.copy(cap.dir).applyQuaternion(this.orbitQ.clone().conjugate());
      this.orbitTmp2.copy(this.rideLocal).applyQuaternion(this.orbitQ).multiplyScalar(r);
    } else {
      this.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
      this.layoutInertialPlane(cap.kind, cap.dir);
      // Capture holds the arrival longitude (theta = 0 on E1).
      this.orbitTmp2.copy(this.rideE1).multiplyScalar(r);
    }
    // Desired eye = body + offset.
    this.bodyCatalog(rt, this.orbitTmp);
    const tx = this.orbitTmp.x + this.orbitTmp2.x;
    const ty = this.orbitTmp.y + this.orbitTmp2.y;
    const tz = this.orbitTmp.z + this.orbitTmp2.z;
    // Hang / hover: nose into the body (full sphere). Inertial:
    // zenith along offset, fwd prograde (body below).
    if (hang) {
      this.orbitTmp.copy(this.orbitTmp2);
      if (this.orbitTmp.lengthSq() < 1e-28) this.orbitTmp.copy(cap.dir);
      this.orbitTmp.normalize();
      // Look at the sphere: fwd = −radial out.
      this.easeCapturePose(
        dt,
        tx,
        ty,
        tz,
        -this.orbitTmp.x,
        -this.orbitTmp.y,
        -this.orbitTmp.z,
        this.orbitTmp.x,
        this.orbitTmp.y,
        this.orbitTmp.z,
      );
    } else {
      this.limbParkFwd(rt, cap.kind, this.rideE2, this.rideE1, this.lookSlerp);
      this.easeCapturePose(
        dt,
        tx,
        ty,
        tz,
        this.lookSlerp.x,
        this.lookSlerp.y,
        this.lookSlerp.z,
        this.rideE1.x,
        this.rideE1.y,
        this.rideE1.z,
      );
    }
    const posErr = Math.hypot(tx - this.ship.at.x, ty - this.ship.at.y, tz - this.ship.at.z);
    const slack = Math.max(r * 0.002, 1e-18);
    if (posErr <= slack) {
      this.capturing = null;
      this.beginRide(rt, cap.kind, cap.dir, tSys);
    }
    this.applyCam();
    this.wake();
  }

  /** Capture onto the host-star ecliptic ring. */
  private tickStarCapture(dt: number, tSys: number, dir: THREE.Vector3): void {
    if (!this.hostObj) return;
    const star = this.hostSpec?.star ?? {
      radius: Math.max(1, this.hostObj.star.radius) * UNIVERSE.RSUN_KM,
      mass: Math.max(0.08, this.hostObj.star.mass),
    };
    const r = starOrbitRadiusKpc(star);
    this.prepareStarRideBasis(dir);
    this.orbitTmp2.copy(this.rideE1).multiplyScalar(r);
    const c = galToCart(this.hostObj.pos);
    const tx = c.x + this.orbitTmp2.x;
    const ty = c.y + this.orbitTmp2.y;
    const tz = c.z + this.orbitTmp2.z;
    // Same limb-down as a world ring: look along the upper
    // tangent so the photosphere sits in the lower half.
    this.pitchLimbFwd(this.rideE2, this.rideE1, this.starLimbR(), r, this.lookSlerp);
    this.easeCapturePose(
      dt,
      tx,
      ty,
      tz,
      this.lookSlerp.x,
      this.lookSlerp.y,
      this.lookSlerp.z,
      this.rideE1.x,
      this.rideE1.y,
      this.rideE1.z,
    );
    const posErr = Math.hypot(tx - this.ship.at.x, ty - this.ship.at.y, tz - this.ship.at.z);
    const slack = Math.max(r * 0.002, 1e-18);
    if (posErr <= slack) {
      this.capturing = null;
      this.beginStarRide(dir, tSys);
    }
    this.applyCam();
    this.wake();
  }

  /**
   * Inertial ring basis. Polar: plane contains the spin axis.
   * Equatorial (and the same geometry for a world arrival):
   * arrival projected into the equator.
   */
  private layoutInertialPlane(kind: WorldOrbitKind, arrival: THREE.Vector3): void {
    this.rideE1.copy(arrival);
    if (this.rideE1.lengthSq() < 1e-16) this.rideE1.copy(this.ship.fwd).negate();
    this.rideE1.normalize();
    if (coerceOrbitKind(kind) === 'polar') {
      this.rideE2.copy(this.rideNorth).addScaledVector(this.rideE1, -this.rideNorth.dot(this.rideE1));
    } else {
      this.rideE1.addScaledVector(this.rideNorth, -this.rideE1.dot(this.rideNorth));
      if (this.rideE1.lengthSq() < 1e-16) {
        this.rideE1.crossVectors(this.rideNorth, this.ship.fwd);
        if (this.rideE1.lengthSq() < 1e-16) this.rideE1.crossVectors(this.rideNorth, this.worldUp);
      }
      this.rideE1.normalize();
      this.rideE2.crossVectors(this.rideNorth, this.rideE1);
    }
    if (this.rideE2.lengthSq() < 1e-16) {
      this.rideE2.crossVectors(this.rideE1, this.ship.right);
      if (this.rideE2.lengthSq() < 1e-16) this.rideE2.crossVectors(this.rideE1, this.worldUp);
    }
    this.rideE2.normalize();
  }

  /** Ecliptic plane basis: pole from host frame, arrival projected in-plane. */
  private prepareStarRideBasis(dirCatalog: THREE.Vector3): void {
    if (this.hostRoot) {
      this.rideNorth.set(0, 0, 1).applyQuaternion(this.hostRoot.quaternion);
    } else {
      this.rideNorth.copy(this.worldUp);
    }
    this.rideE1.copy(dirCatalog);
    if (this.rideE1.lengthSq() < 1e-16) {
      this.orientArc();
      this.rideE1.copy(this.ship.fwd).negate();
    }
    this.rideE1.normalize();
    this.rideE1.addScaledVector(this.rideNorth, -this.rideE1.dot(this.rideNorth));
    if (this.rideE1.lengthSq() < 1e-16) {
      this.rideE1.crossVectors(this.rideNorth, this.ship.right);
      if (this.rideE1.lengthSq() < 1e-16) this.rideE1.crossVectors(this.rideNorth, this.worldUp);
    }
    this.rideE1.normalize();
    this.rideE2.crossVectors(this.rideNorth, this.rideE1);
    if (this.rideE2.lengthSq() < 1e-16) this.rideE2.crossVectors(this.rideE1, this.worldUp);
    this.rideE2.normalize();
  }

  /**
   * Ease the eye onto the ring. Soft-seek the nose onto the
   * parked look via look-vector slerp (no Euler corkscrew).
   */
  private easeCapturePose(
    dt: number,
    tx: number,
    ty: number,
    tz: number,
    fwdX: number,
    fwdY: number,
    fwdZ: number,
    zenX: number,
    zenY: number,
    zenZ: number,
  ): void {
    const k = 1 - Math.exp(-UNIVERSE.ORBIT_CAPTURE * dt);
    this.ship.at.x += (tx - this.ship.at.x) * k;
    this.ship.at.y += (ty - this.ship.at.y) * k;
    this.ship.at.z += (tz - this.ship.at.z) * k;
    if (this.hostRoot && this.hostObj) {
      const cart = galToCart(this.hostObj.pos);
      this.orbitTmp.set(
        this.ship.at.x - cart.x,
        this.ship.at.y - cart.y,
        this.ship.at.z - cart.z,
      );
      this.hostRoot.position.copy(this.orbitTmp).negate();
      this.hostRoot.updateMatrixWorld(true);
    }
    // Hang capture: fwd ≈ −zenith → face the sphere (roll → 0).
    const face =
      fwdX * zenX + fwdY * zenY + fwdZ * zenZ <
      -0.7 * Math.hypot(fwdX, fwdY, fwdZ) * Math.hypot(zenX, zenY, zenZ);
    this.easeLookToward(
      dt,
      UNIVERSE.ORBIT_CAPTURE,
      fwdX,
      fwdY,
      fwdZ,
      face ? null : zenX,
      face ? null : zenY,
      face ? null : zenZ,
      face,
    );
  }

  /** dirCatalog is body → camera at first contact, unit. The ring starts there. */
  private beginRide(rt: HostBodyRT, kind: WorldOrbitKind, dirCatalog: THREE.Vector3, tSys: number): void {
    const r = orbitRadiusKpc(rt.spec, kind);
    const hang = isHangOrbit(kind);
    this.spinWorld(rt, this.orbitQ);
    this.riding = {
      bodyId: rt.spec.id,
      kind,
      hang,
      r,
      theta0: 0,
      omega: hang ? 0 : orbitOmega(rt.spec, kind),
    };
    if (hang) {
      this.rideLocal.copy(dirCatalog).applyQuaternion(this.orbitQ.clone().conjugate());
    } else {
      // Height is the named ring. The plane contains the arrival
      // so we do not seek an equator / far-side start.
      this.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
      this.layoutInertialPlane(kind, dirCatalog);
      this.riding.theta0 = -this.riding.omega * tSys;
    }
    this.placeRide(tSys);
    // Lock-on ends. In Orbit: helm look stays locked to the ring.
    this.route.arrive();
    this.capturing = null;
    this.courseObj = null;
    this.courseBodyId = null;
    this.courseHud = null;
    this.pendingOrbit = null;
    this.pendingArriveOrbit = false;
    this.navMode = 'orbit';
    this.insertBlend = 0;
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }

  /**
   * Latch the host-star ecliptic ring. dirCatalog is star → camera
   * at first contact (projected into the ecliptic). Kepler ω from
   * GM☉ · mass at the limb-film radius.
   */
  private beginStarRide(dirCatalog: THREE.Vector3, tSys: number): void {
    if (!this.hostObj) return;
    const star = this.hostSpec?.star ?? {
      radius: Math.max(1e-6, this.hostObj.star.radius) * UNIVERSE.RSUN_KM,
      mass: Math.max(0.08, this.hostObj.star.mass),
    };
    const r = starOrbitRadiusKpc(star);
    const omega = starOrbitOmega(star, r);
    this.prepareStarRideBasis(dirCatalog);
    this.riding = {
      bodyId: null,
      kind: 'ecliptic',
      hang: false,
      r,
      theta0: -omega * tSys,
      omega,
    };
    this.placeRide(tSys);
    this.route.arrive();
    this.capturing = null;
    this.courseObj = null;
    this.courseBodyId = null;
    this.courseHud = null;
    this.pendingOrbit = null;
    this.pendingArriveOrbit = false;
    this.navMode = 'orbit';
    this.insertBlend = 0;
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }

  private placeRide(tSys: number): void {
    const ride = this.riding;
    if (!ride || !this.hostObj) {
      this.clearRide();
      return;
    }
    let ox: number;
    let oy: number;
    let oz: number;
    if (ride.bodyId == null) {
      // Host-star ecliptic — offset from the photosphere origin.
      const th = ride.theta0 + ride.omega * tSys;
      const c = Math.cos(th);
      const s = Math.sin(th);
      ox = (this.rideE1.x * c + this.rideE2.x * s) * ride.r;
      oy = (this.rideE1.y * c + this.rideE2.y * s) * ride.r;
      oz = (this.rideE1.z * c + this.rideE2.z * s) * ride.r;
      if (this.hostRoot) {
        this.orbitTmp2
          .set(ox, oy, oz)
          .applyQuaternion(this.hostTmpQ.copy(this.hostRoot.quaternion).conjugate())
          .multiplyScalar(1 / KM_TO_KPC);
        this.pinHostEyeKm(this.orbitTmp2);
      } else {
        const cart = galToCart(this.hostObj.pos);
        this.ship.at.set(cart.x + ox, cart.y + oy, cart.z + oz);
      }
      this.bankRideLook(tSys);
      return;
    }
    const rt = this.worldRt(ride.bodyId);
    if (!rt) {
      this.clearRide();
      return;
    }
    if (ride.hang) {
      this.spinWorld(rt, this.orbitQ);
      this.orbitTmp2.copy(this.rideLocal).applyQuaternion(this.orbitQ);
      ox = this.orbitTmp2.x * ride.r;
      oy = this.orbitTmp2.y * ride.r;
      oz = this.orbitTmp2.z * ride.r;
    } else {
      const th = ride.theta0 + ride.omega * tSys;
      const c = Math.cos(th);
      const s = Math.sin(th);
      ox = (this.rideE1.x * c + this.rideE2.x * s) * ride.r;
      oy = (this.rideE1.y * c + this.rideE2.y * s) * ride.r;
      oz = (this.rideE1.z * c + this.rideE2.z * s) * ride.r;
    }
    if (this.hostRoot) {
      // Pin the ride eye in the host km frame (the landed / drone
      // law): body centre + ring offset. Building arcCenter out of
      // the 8 kpc point instead quantizes the park by a ULP.
      this.orbitTmp2
        .set(ox, oy, oz)
        .applyQuaternion(this.hostTmpQ.copy(this.hostRoot.quaternion).conjugate())
        .multiplyScalar(1 / KM_TO_KPC)
        .add(rt.pos);
      this.pinHostEyeKm(this.orbitTmp2);
    } else {
      this.bodyCatalog(rt, this.orbitTmp);
      this.ship.at.set(this.orbitTmp.x + ox, this.orbitTmp.y + oy, this.orbitTmp.z + oz);
    }
    this.bankRideLook(tSys);
  }

  /**
   * Helm ride look. The ship camera is bolted to this attitude —
   * no free look, no zoom. Hover: nose into the body (full
   * sphere ahead). Equatorial / polar / ecliptic: prograde,
   * pitched so the forward limb fills ORBIT_LIMB_FILL of the
   * frame, banked nadir-down. Same law for a world or the
   * star. Drone is the free camera.
   */
  private bankRideLook(tSys: number): void {
    const ride = this.riding;
    if (!ride || this.drone) return;
    if (ride.hang) {
      // GEO / hover: face the hang face — full sphere ahead.
      const rt = this.worldRt(ride.bodyId);
      if (!rt) return;
      this.spinWorld(rt, this.orbitQ);
      this.orbitTmp2.copy(this.rideLocal).applyQuaternion(this.orbitQ);
      const len = Math.hypot(this.orbitTmp2.x, this.orbitTmp2.y, this.orbitTmp2.z);
      if (len < 1e-18) return;
      // Nose into the face; galactic north as screen-up.
      // Do not zero Euler roll — setEuler rebuilds from
      // galactic yaw/pitch and fights the look every frame.
      this.aimOrbitBank(
        -this.orbitTmp2.x / len,
        -this.orbitTmp2.y / len,
        -this.orbitTmp2.z / len,
        0,
        1,
        0,
      );
      return;
    }
    const th = ride.theta0 + ride.omega * tSys;
    const c = Math.cos(th);
    const s = Math.sin(th);
    // Radial out (body below) and prograde (dθ).
    let zx = this.rideE1.x * c + this.rideE2.x * s;
    let zy = this.rideE1.y * c + this.rideE2.y * s;
    let zz = this.rideE1.z * c + this.rideE2.z * s;
    const zlen = Math.hypot(zx, zy, zz);
    if (zlen < 1e-18) return;
    zx /= zlen;
    zy /= zlen;
    zz /= zlen;
    let fx = -this.rideE1.x * s + this.rideE2.x * c;
    let fy = -this.rideE1.y * s + this.rideE2.y * c;
    let fz = -this.rideE1.z * s + this.rideE2.z * c;
    const flen = Math.hypot(fx, fy, fz);
    if (flen < 1e-18) return;
    fx /= flen;
    fy /= flen;
    fz /= flen;
    const rt = ride.bodyId != null ? this.worldRt(ride.bodyId) : null;
    if (isLimbOrbit(ride.kind)) {
      const Rkpc =
        rt != null
          ? Math.max(rt.spec.radius, 1) * KM_TO_KPC
          : this.starLimbR();
      this.lookSlerp.set(fx, fy, fz);
      this.orbitTmp.set(zx, zy, zz);
      this.pitchLimbFwd(this.lookSlerp, this.orbitTmp, Rkpc, ride.r, this.lookSlerp);
      fx = this.lookSlerp.x;
      fy = this.lookSlerp.y;
      fz = this.lookSlerp.z;
    }
    this.aimOrbitBank(fx, fy, fz, zx, zy, zz);
  }

  /** Photosphere radius in catalog kpc — ecliptic limb uses this as R. */
  private starLimbR(): number {
    const km =
      this.hostSpec?.star.radius ??
      Math.max(1e-6, this.hostObj?.star.radius ?? 1) * UNIVERSE.RSUN_KM;
    return Math.max(km, 1) * KM_TO_KPC;
  }

  /**
   * Prograde pitched toward the body (−zenith) so the forward
   * limb fills ORBIT_LIMB_FILL. Same law for a world or the star.
   */
  private pitchLimbFwd(
    prograde: THREE.Vector3,
    zenith: THREE.Vector3,
    R: number,
    d: number,
    out: THREE.Vector3,
    blend = 1,
  ): void {
    const p = orbitLimbPitch(R, d, this.camera.fov, UNIVERSE.ORBIT_LIMB_FILL) * blend;
    const c = Math.cos(p);
    const s = Math.sin(p);
    out.set(
      prograde.x * c - zenith.x * s,
      prograde.y * c - zenith.y * s,
      prograde.z * c - zenith.z * s,
    );
    if (out.lengthSq() < 1e-16) out.copy(prograde);
    else out.normalize();
  }

  /**
   * Park look for an inertial limb ring: prograde pitched toward
   * the body so the forward limb fills ORBIT_LIMB_FILL.
   */
  private limbParkFwd(
    rt: HostBodyRT,
    kind: WorldOrbitKind,
    prograde: THREE.Vector3,
    zenith: THREE.Vector3,
    out: THREE.Vector3,
  ): void {
    if (!isLimbOrbit(kind)) {
      out.copy(prograde);
      return;
    }
    this.pitchLimbFwd(
      prograde,
      zenith,
      Math.max(rt.spec.radius, 1) * KM_TO_KPC,
      orbitRadiusKpc(rt.spec, kind),
      out,
    );
  }

  /** Write the parked limb look (capture start — matches the insert ease). */
  private aimLimbParkLook(rt: HostBodyRT, kind: WorldOrbitKind, zenith: THREE.Vector3): void {
    if (!isLimbOrbit(kind)) return;
    this.spinWorld(rt, this.orbitQ);
    this.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
    this.rideE1.copy(zenith);
    if (this.rideE1.lengthSq() < 1e-16) return;
    this.rideE1.normalize();
    this.rideE2.crossVectors(this.rideNorth, this.rideE1);
    if (this.rideE2.lengthSq() < 1e-16) {
      this.orientArc();
      this.rideE2.crossVectors(this.ship.right, this.rideE1);
    }
    if (this.rideE2.lengthSq() < 1e-16) return;
    this.rideE2.normalize();
    this.limbParkFwd(rt, kind, this.rideE2, this.rideE1, this.lookSlerp);
    this.aimOrbitBank(
      this.lookSlerp.x,
      this.lookSlerp.y,
      this.lookSlerp.z,
      this.rideE1.x,
      this.rideE1.y,
      this.rideE1.z,
    );
  }

  private clearCourse(): void {
    this.courseObj = null;
    this.courseHud = null;
    this.courseBodyId = null;
    if (this.navMode === 'lock') this.navMode = null;
  }

  /** Fresh Lock-on: clear insertion blend. */
  private resetRoutePlot(): void {
    this.insertBlend = 0;
  }

  /**
   * Transfer route. Space is empty; bodies are balls. The only
   * illegal move is into one. If we sit inside a non-target
   * graze, climb out. If the sightline hits a ball, take the
   * shorter of the two tangents (larger dot with the desired
   * aim). One peel per frame — the next frame sees the next
   * ball. No maze, no corridor search.
   */
  private routeAim(aim: THREE.Vector3, targetId: string | null): void {
    if (!this.hostObj || !this.hostRoot) return;
    const dT = aim.length();
    if (!(dT > 1e-18)) return;

    // Inside a non-target graze → only way is out.
    let escapeD = Infinity;
    let ex = 0;
    let ey = 0;
    let ez = 0;
    const noteEscape = (rx: number, ry: number, rz: number, radiusKm: number): void => {
      const dO = Math.hypot(rx, ry, rz);
      if (!(dO > 1e-18) || dO >= escapeD) return;
      const R = Math.max(radiusKm, 1);
      const grazeKm = Math.max(UNIVERSE.ROUTE_GRAZE * R, R + UNIVERSE.WORLD_ORBIT_CLEAR_KM);
      if (dO >= grazeKm * KM_TO_KPC) return;
      escapeD = dO;
      ex = rx;
      ey = ry;
      ez = rz;
    };
    for (const rt of this.host.bodies) {
      if (rt.spec.id === targetId) continue;
      this.bodyFromEye(rt, this.hostTmp2);
      noteEscape(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, rt.spec.radius);
    }
    if (targetId != null) {
      this.hostTmp2.copy(this.hostRoot.position);
      noteEscape(
        this.hostTmp2.x,
        this.hostTmp2.y,
        this.hostTmp2.z,
        this.hostSpec?.star.radius ?? UNIVERSE.RSUN_KM,
      );
    }
    if (escapeD < Infinity) {
      const inv = dT / Math.max(escapeD, 1e-18);
      aim.set(-ex * inv, -ey * inv, -ez * inv);
      return;
    }

    // Nearest ball the desired aim would enter.
    this.hostTmp.copy(aim).multiplyScalar(1 / dT);
    let bx = 0;
    let by = 0;
    let bz = 0;
    let bestD = Infinity;
    let bestSin = 0;
    const consider = (rx: number, ry: number, rz: number, radiusKm: number): void => {
      const dO = Math.hypot(rx, ry, rz);
      if (!(dO > 1e-18) || dO >= dT || dO >= bestD) return;
      const dOT = Math.hypot(aim.x - rx, aim.y - ry, aim.z - rz);
      const R = Math.max(radiusKm, 1);
      const grazeKm = Math.max(UNIVERSE.ROUTE_GRAZE * R, R + UNIVERSE.WORLD_ORBIT_CLEAR_KM);
      const graze = Math.min(grazeKm * KM_TO_KPC, dOT * 0.9);
      if (!(graze > 0)) return;
      const sinMin = Math.min(1, graze / dO);
      const cosMin = Math.sqrt(Math.max(0, 1 - sinMin * sinMin));
      const cosA = (aim.x * rx + aim.y * ry + aim.z * rz) / (dT * dO);
      if (cosA <= cosMin) return;
      bestD = dO;
      bestSin = sinMin;
      bx = rx;
      by = ry;
      bz = rz;
    };
    for (const rt of this.host.bodies) {
      if (rt.spec.id === targetId) continue;
      this.bodyFromEye(rt, this.hostTmp2);
      consider(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, rt.spec.radius);
    }
    if (targetId != null) {
      this.hostTmp2.copy(this.hostRoot.position);
      consider(
        this.hostTmp2.x,
        this.hostTmp2.y,
        this.hostTmp2.z,
        this.hostSpec?.star.radius ?? UNIVERSE.RSUN_KM,
      );
    }
    if (!(bestD < Infinity)) return;

    // Two tangents; keep the one closer to the desired aim.
    this.hostTmp2.set(bx, by, bz).normalize();
    this.orbitTmp2.crossVectors(this.hostTmp2, this.hostTmp);
    if (this.orbitTmp2.lengthSq() < 1e-24) {
      this.orbitTmp2.crossVectors(this.hostTmp2, this.worldUp);
      if (this.orbitTmp2.lengthSq() < 1e-24) this.orbitTmp2.set(1, 0, 0);
    }
    this.orbitTmp2.normalize();
    const ang = Math.asin(bestSin);
    this.rideE1.copy(this.hostTmp2).applyAxisAngle(this.orbitTmp2, ang);
    this.rideE2.copy(this.hostTmp2).applyAxisAngle(this.orbitTmp2, -ang);
    const pick = this.rideE1.dot(this.hostTmp) >= this.rideE2.dot(this.hostTmp) ? this.rideE1 : this.rideE2;
    aim.copy(pick).multiplyScalar(dT);
  }

  /** Ease the nose onto the Lock-on insertion. Off in orbit / proximity / capture. */
  private holdCourse(dt: number): void {
    if (!this.route.live && this.navMode !== 'lock') return;
    if (this.mode !== 'region') return;
    if (this.riding || this.landed || this.drone || this.capturing || this.departing) return;
    if (this.looking) return;
    let insertBlend = 0;
    // Eye→body before insert rewrite — zenith = radial out (−eye→body).
    let zenX = 0;
    let zenY = 0;
    let zenZ = 0;
    let haveZen = false;
    if (this.courseBodyId && this.hostObj && this.route.dest?.starId === this.hostObj.id) {
      const rt = this.worldRt(this.courseBodyId);
      if (!rt) return;
      this.bodyFromEye(rt, this.orbitTmp);
      zenX = -this.orbitTmp.x;
      zenY = -this.orbitTmp.y;
      zenZ = -this.orbitTmp.z;
      haveZen = this.orbitTmp.lengthSq() > 1e-28;
      const dest = this.destOrbit();
      if (dest && dest.bodyId === rt.spec.id) {
        insertBlend = this.applyPendingInsert(rt, dest.kind, this.orbitTmp);
      }
      this.routeAim(this.orbitTmp, rt.spec.id);
    } else if (this.courseObj) {
      const p = galToCart(this.courseObj.pos);
      this.orbitTmp.set(
        p.x - this.ship.at.x,
        p.y - this.ship.at.y,
        p.z - this.ship.at.z,
      );
      zenX = -this.orbitTmp.x;
      zenY = -this.orbitTmp.y;
      zenZ = -this.orbitTmp.z;
      haveZen = this.orbitTmp.lengthSq() > 1e-28;
      const dest = this.destOrbit();
      if (dest && dest.bodyId == null && dest.kind === 'ecliptic') {
        insertBlend = this.applyStarInsert(this.courseObj, this.orbitTmp);
      }
      if (this.hostObj && this.courseObj.id === this.hostObj.id) {
        this.routeAim(this.orbitTmp, null);
      }
    } else {
      return;
    }
    const dx = this.orbitTmp.x;
    const dy = this.orbitTmp.y;
    const dz = this.orbitTmp.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-15) return;
    if (this.courseHud) this.courseHud.dist = d;
    this.insertBlend = insertBlend;
    // Hang / hover face the sphere. Inertial banks body-below
    // only inside the insert window. Far lock-on is a heading
    // hold — passing zenith here snapped roll (away-from-star
    // = screen-up) on the Set course tap and the sky jumped.
    const dest = this.destOrbit();
    const hangLook =
      dest != null && dest.bodyId != null && isHangOrbit(dest.kind);
    const bank = !hangLook && haveZen && insertBlend > 1e-4;
    // Limb pitch is a ship attitude (not a second camera).
    let lx = dx;
    let ly = dy;
    let lz = dz;
    if (bank && dest?.bodyId && isLimbOrbit(dest.kind)) {
      const rt = this.worldRt(dest.bodyId);
      if (rt) {
        const zlen = Math.hypot(zenX, zenY, zenZ);
        const flen = Math.hypot(dx, dy, dz);
        if (zlen > 1e-18 && flen > 1e-18) {
          const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
          const rd = orbitRadiusKpc(rt.spec, dest.kind);
          const pitch = orbitLimbPitch(R, rd, this.camera.fov, UNIVERSE.ORBIT_LIMB_FILL) * insertBlend;
          const c = Math.cos(pitch);
          const s = Math.sin(pitch);
          lx = (dx / flen) * c - (zenX / zlen) * s;
          ly = (dy / flen) * c - (zenY / zlen) * s;
          lz = (dz / flen) * c - (zenZ / zlen) * s;
        }
      }
    } else if (bank && dest && dest.bodyId == null && dest.kind === 'ecliptic' && this.courseObj) {
      const zlen = Math.hypot(zenX, zenY, zenZ);
      const flen = Math.hypot(dx, dy, dz);
      if (zlen > 1e-18 && flen > 1e-18) {
        const star = {
          radius: Math.max(1e-6, this.courseObj.star.radius) * UNIVERSE.RSUN_KM,
        };
        const rd = starOrbitRadiusKpc(star);
        this.lookSlerp.set(dx / flen, dy / flen, dz / flen);
        this.orbitTmp2.set(zenX / zlen, zenY / zlen, zenZ / zlen);
        this.pitchLimbFwd(
          this.lookSlerp,
          this.orbitTmp2,
          this.starLimbR(),
          rd,
          this.lookSlerp,
          insertBlend,
        );
        lx = this.lookSlerp.x;
        ly = this.lookSlerp.y;
        lz = this.lookSlerp.z;
      }
    }
    this.ship.easeToward(
      dt,
      UNIVERSE.ARRIVE_HOLD,
      lx,
      ly,
      lz,
      bank ? zenX : null,
      bank ? zenY : null,
      bank ? zenZ : null,
      hangLook,
    );
    this.applyCam();
    this.wake();
  }

  /**
   * Nudge attitude without corkscrews. Slerp the nose toward
   * `fwd`; then either bank so `zenith` is screen-up, ease roll
   * to 0 (hang / hover face), or leave roll alone.
   */
  private easeLookToward(
    dt: number,
    rate: number,
    fwdX: number,
    fwdY: number,
    fwdZ: number,
    zenX: number | null,
    zenY: number | null,
    zenZ: number | null,
    faceBody: boolean,
  ): void {
    this.ship.easeToward(dt, rate, fwdX, fwdY, fwdZ, zenX, zenY, zenZ, faceBody);
  }

  /**
   * Rewrite eye→body into an insertion fly-to for the pending
   * body ring. Returns the 0…1 insert blend.
   */
  private applyPendingInsert(rt: HostBodyRT, kind: WorldOrbitKind, eyeToBody: THREE.Vector3): number {
    const r = orbitRadiusKpc(rt.spec, kind);
    const mode = this.insertModeOf(kind);
    this.spinWorld(rt, this.orbitQ);
    this.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
    if (coerceOrbitKind(kind) === 'polar') {
      this.lookSlerp.crossVectors(this.rideNorth, eyeToBody);
      if (this.lookSlerp.lengthSq() < 1e-24) {
        this.lookSlerp.crossVectors(this.rideNorth, this.ship.fwd);
        if (this.lookSlerp.lengthSq() < 1e-24) this.lookSlerp.set(1, 0, 0);
      }
      this.lookSlerp.normalize();
    } else {
      this.lookSlerp.copy(this.rideNorth);
    }
    return planOrbitInsert(
      eyeToBody,
      r,
      this.lookSlerp,
      mode,
      UNIVERSE.ORBIT_INSERT,
      this.orbitTmp2,
      this.rideE1,
      this.rideE2,
    );
  }

  /** Star ecliptic insertion. eyeToBody → fly-to; returns blend. */
  private applyStarInsert(obj: GalaxyObject, eyeToBody: THREE.Vector3): number {
    const star = {
      radius: Math.max(1e-6, obj.star.radius) * UNIVERSE.RSUN_KM,
    };
    const r = starOrbitRadiusKpc(star);
    if (this.hostRoot && this.hostObj?.id === obj.id) {
      this.rideNorth.set(0, 0, 1).applyQuaternion(this.hostRoot.quaternion);
    } else {
      this.rideNorth.copy(this.worldUp);
    }
    return planOrbitInsert(
      eyeToBody,
      r,
      this.rideNorth,
      'inertial',
      UNIVERSE.ORBIT_INSERT,
      this.orbitTmp2,
      this.rideE1,
      this.rideE2,
    );
  }

  private insertModeOf(kind: WorldOrbitKind): InsertMode {
    return isHangOrbit(kind) ? 'hover' : 'inertial';
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
      x: this.ship.at.x,
      y: this.ship.at.y,
      z: this.ship.at.z,
    };
  }

  selectedObject(): GalaxyObject | null {
    return this.selected;
  }

  beaconCount(): number {
    const n = this.shownCount();
    return n > 0 ? n : this.objects.length;
  }

  /** The arc's loaded survey — every row is a catalog id. */
  surveyStars(): GalaxyObject[] {
    return this.objects;
  }

  /** Latest performance summary for the bottom bar. */
  perfSummary(): string {
    return this.perf.summary();
  }

  /** Local catalog stars close enough to lock the reticle. Smoke / HUD. */
  grownStars(): number {
    return this.grownCount;
  }

  /** True when the luminous harvest is on the GPU. */
  cloudFitsRegion(): boolean {
    return this.sky.ready();
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
    if (this.landed || this.drone || this.departing) return;
    this.wake();
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
      x: this.ship.at.x,
      y: this.ship.at.y,
      z: this.ship.at.z,
      yaw: this.arcYaw,
      pitch: this.arcPitch,
      roll: this.arcRoll,
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
    this.arcRoll = 0;
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
    this.arcRoll = p.roll;
    this.applyCam();
    this.updateSight(true);
  }

  /** Open the region around a star and select it. */
  focus(obj: GalaxyObject): void {
    this.wake();
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
    this.ship.at.set(
      cat.x - this.ship.fwd.x * off,
      cat.y - this.ship.fwd.y * off,
      cat.z - this.ship.fwd.z * off,
    );
    this.mintAt.copy(this.ship.at);
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

  focusedBodyId(): string | null {
    return this.focusBodyId;
  }

  /** Chart subject: focused harvest star, else the host. */
  chartObject(): GalaxyObject | null {
    return this.focusObj ?? this.hostObj;
  }

  /** Refresh sight uniforms — smoke / tests. */
  syncArc(): void {
    if (this.mode === 'region') this.updateSight(true);
  }

  /** Harvest glow size (device px). f(L), not 1/d — smoke proves approach does not inflate it. */
  pointApparent(id: number): number {
    const cloud = this.sky.cloud;
    const px = this.renderer.getPixelRatio();
    if (!cloud) return 0;
    for (let i = 0; i < cloud.n; i++) {
      if (cloud.ids[i] === id) return harvestGlowPx(cloud.lum[i], px);
    }
    const o = objectAt(this.seed, id);
    return o ? harvestGlowPx(o.star.luminosity, px) : 0;
  }

  /**
   * An on-screen cloud star — smoke proves the harvest is addressable.
   */
  probePointStar(): { id: number; x: number; y: number } | null {
    const cloud = this.sky.cloud;
    if (!cloud) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const step = Math.max(1, Math.floor(cloud.n / 4000));
    const cx = this.ship.at.x;
    const cy = this.ship.at.y;
    const cz = this.ship.at.z;
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
    this.idle = 0;
  }

  /** Slide the bubble along the look. Smoke / WASD. */
  flyAlong(kpc: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    this.moveBubble(this.ship.fwd.x * kpc, this.ship.fwd.y * kpc, this.ship.fwd.z * kpc);
    this.applyCam();
  }

  /** Slide the bubble along camera right. Leftover smoke — not a player verb. */
  flyStrafe(kpc: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    this.moveBubble(this.ship.right.x * kpc, this.ship.right.y * kpc, this.ship.right.z * kpc);
    this.applyCam();
  }

  resize(w: number, h: number): void {
    if (w === this.viewW && h === this.viewH) return;
    this.viewW = w;
    this.viewH = h;
    this.wake();
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
      this.wake();
      if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    } else {
      this.cancelHoldRoll();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setWarp(false);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelHoldRoll();
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.detachHostStar();
    this.sky.thaw();
    this.sky.dispose();
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
    return Math.hypot(this.ship.at.x, this.ship.at.y, this.ship.at.z);
  }

  /** Signed look axis for this gear: +1 ahead, −1 astern. */
  private thrustSign(): number {
    return this.astern ? -1 : 1;
  }

  /** Warp may run inside the fence, or past it only while the gear points inward. */
  private warpMayRun(): boolean {
    const r = this.bubbleR();
    const lim = UNIVERSE.GALAXY_WARP_LIM;
    if (r < lim) return true;
    this.orientArc();
    if (r < 1e-6) return true;
    return this.ship.fwd.dot(this.ship.at) * this.thrustSign() < 0;
  }

  /**
   * Player verb: drop the rail and burn to escape speed for
   * that body (√2 × circular, floored by the place crawl so
   * the burn is a beat). Not interruptible — then you float
   * free and the helm comes back. A live dest is kept.
   */
  leaveOrbit(): void {
    if (this.drone || this.landed) return;
    if (!this.riding && !this.capturing) return;
    const vEsc = this.departEscapeSpeed();
    this.breakOrbit();
    this.aimDepartStarboard();
    this.thrustOn = false;
    this.thrustSpeed = 0;
    this.coast.set(0, 0, 0);
    this.departing = {
      v: 0,
      vEsc,
      dir: this.ship.fwd.clone(),
    };
    this.applyCam();
    this.wake();
  }

  /**
   * Yaw right 90°. The body we were looking at sits to port
   * so we can see it, and Ahead is tangent — not into the ball.
   * Warp can run; the shell fence still stops a later dive.
   */
  private aimDepartStarboard(): void {
    this.ship.orthonormalize();
    this.ship.fwd.copy(this.ship.right);
    this.ship.orthonormalize();
  }

  /** √2 ω r, floored by ARRIVE_K × the place fence, capped by sphere warp. */
  private departEscapeSpeed(): number {
    let omega = 0;
    let r = 0;
    let fence = UNIVERSE.ARRIVE_RANGE_KPC;
    if (this.riding) {
      omega = this.riding.omega;
      r = this.riding.r;
      fence = this.riding.bodyId != null ? UNIVERSE.WORLD_RANGE_KPC : UNIVERSE.ARRIVE_RANGE_KPC;
    } else if (this.capturing) {
      if (this.capturing.bodyId == null) {
        const obj = this.hostObj;
        if (obj) {
          r = this.arriveDist(obj);
          const star = this.hostSpec?.star ?? {
            mass: Math.max(0.08, obj.star.mass),
          };
          omega = starOrbitOmega(star, r);
        }
        fence = UNIVERSE.ARRIVE_RANGE_KPC;
      } else {
        const rt = this.worldRt(this.capturing.bodyId);
        if (rt) {
          r = this.bodyDist(rt);
          omega = orbitOmega(rt.spec, this.capturing.kind);
        }
        fence = UNIVERSE.WORLD_RANGE_KPC;
      }
    }
    const kepler = escapeSpeedKpcS(omega, r);
    const floor = UNIVERSE.ARRIVE_K * Math.max(fence, r);
    const cap = UNIVERSE.GALAXY_WARP * UNIVERSE.ARRIVE_WARP;
    return Math.min(cap, Math.max(kepler, floor));
  }

  private clearDepart(): void {
    this.departing = null;
    this.coast.set(0, 0, 0);
  }

  private finishDepart(): void {
    const d = this.departing;
    if (!d) return;
    this.coast.copy(d.dir).multiplyScalar(d.v);
    this.departing = null;
  }

  private tickDepart(dt: number): void {
    const d = this.departing;
    if (!d) return;
    const k = 1 - Math.exp(-UNIVERSE.ORBIT_CAPTURE * dt);
    d.v += (d.vEsc - d.v) * k;
    this.ship.fwd.copy(d.dir);
    this.ship.orthonormalize();
    this.moveBubble(d.dir.x * d.v * dt, d.dir.y * d.v * dt, d.dir.z * d.v * dt, true);
    this.applyCam();
    if (d.vEsc - d.v <= d.vEsc * 0.03 + 1e-18) this.finishDepart();
  }

  /**
   * Exit ring: drop the rail. If a dest course is live, keep it
   * (LeaveSoi / cruise owns the nose next). No dest → proximity.
   * Heading is the Leave starboard yaw — not a radial flip
   * into the star.
   */
  private breakOrbit(): void {
    this.clearRide();
    this.capturing = null;
    this.insertBlend = 0;
    this.pendingArriveOrbit = false;
    if (!this.route.live) {
      this.pendingOrbit = null;
      this.proximity = true;
      this.navMode = 'proximity';
    } else {
      this.navMode = 'lock';
      this.fillCourseHud();
    }
  }

  /** Dest survived Leave — put the plate back after In Orbit wiped it. */
  private fillCourseHud(): void {
    const dest = this.route.dest;
    if (!dest || this.courseHud) return;
    const obj = objectAt(this.seed, dest.starId);
    if (!obj) return;
    this.courseObj = obj;
    this.courseBodyId = dest.bodyId;
    if (dest.bodyId) {
      const rt = this.worldRt(dest.bodyId);
      this.courseHud = rt ? this.hudForBody(rt) : this.hudForStar(obj);
    } else {
      this.courseHud = this.hudForStar(obj);
    }
  }

  /** Latch warp on (fixed cruise) or off (stop). A tap, not a hold. */
  setWarp(on: boolean): void {
    if (this.drone) return;
    if (this.mode !== 'region' || this.landed) return;
    if (this.departing) return;
    if (on && (this.riding || this.capturing)) return;
    this.coast.set(0, 0, 0);
    this.thrustOn = on && this.warpMayRun();
    this.idle = 0;
    if (this.thrustOn) this.wake(2);
  }

  /** Ahead / astern. Only while stopped — a running warp keeps the gear. */
  setGear(astern: boolean): void {
    if (this.mode !== 'region' || this.thrustOn) return;
    if (this.astern === astern) return;
    this.astern = astern;
    this.idle = 0;
    this.wake();
  }

  toggleGear(): void {
    this.setGear(!this.astern);
  }

  warping(): boolean {
    return this.thrustOn;
  }

  private select(obj: GalaxyObject | null): void {
    this.wake();
    this.selected = obj;
    this.placeHighlights();
    this.callbacks.onSelect(obj);
  }

  // ------------------------------------------------------------- camera

  private aimAt(x: number, y: number, z: number): void {
    this.ship.lookAt(x, y, z);
  }

  /**
   * Ship frame for orbit: nose along `fwd` (prograde / transfer),
   * bank so `zenith` (away from the body) is screen-up.
   */
  private aimOrbitBank(
    fwdX: number,
    fwdY: number,
    fwdZ: number,
    zenX: number,
    zenY: number,
    zenZ: number,
  ): void {
    this.ship.lookBank(fwdX, fwdY, fwdZ, zenX, zenY, zenZ);
  }

  private orientArc(): void {
    this.ship.orthonormalize();
  }

  private pxPerRad(): number {
    const h = this.canvas.clientHeight || 800;
    const fov = (this.camera.fov * Math.PI) / 180;
    return (0.5 * h * this.renderer.getPixelRatio()) / Math.tan(fov * 0.5);
  }

  private applyCam(): void {
    if (this.drone && this.hostRoot) {
      this.orbitTmp.copy(this.drone.fwd).applyQuaternion(this.hostRoot.quaternion).normalize();
      this.orbitTmp2.copy(this.drone.up).applyQuaternion(this.hostRoot.quaternion).normalize();
      this.drone.applyLook(this.camera, this.orbitTmp, this.orbitTmp2);
    } else {
      this.ship.orthonormalize();
      this.ship.applyCam(this.camera);
    }
    const lock = this.hostObj;
    if (lock) {
      const d = this.arriveDist(lock);
      this.camera.near = Math.min(0.001, Math.max(1e-14, d * 0.04));
      this.camera.far = regionCamFar();
    } else {
      this.camera.near = 0.001;
      this.camera.far = regionCamFar();
    }
    this.camera.fov = THREE.MathUtils.clamp(UNIVERSE.CAM_FOV, 20, 160);
    this.camera.updateProjectionMatrix();
    this.pushMagUniforms();
  }

  private arriveDist(obj: GalaxyObject): number {
    const c = galToCart(obj.pos);
    return Math.hypot(
      c.x - this.ship.at.x,
      c.y - this.ship.at.y,
      c.z - this.ship.at.z,
    );
  }

  private worldRt(id: string | null | undefined): HostBodyRT | null {
    return this.host.get(id);
  }

  /** Catalog kpc from the camera to a host-pass body. */
  private bodyDist(rt: HostBodyRT): number {
    return this.bodyFromEye(rt, this.hostTmp).length();
  }

  private hudForBody(rt: HostBodyRT): GalaxyFocus {
    const b = rt.spec;
    let moons = 0;
    if (this.hostSpec) {
      for (const row of this.hostSpec.bodies) if (row.parent === b.id) moons++;
    }
    return {
      id: this.hostObj?.id ?? 0,
      bodyId: b.id,
      name: b.name,
      cls: classify(b.physics, lockedToStar(b)),
      phase: b.parent ? 'moon' : b.kind === 'gas' ? 'giant' : 'planet',
      planets: 0,
      moons,
      life: b.physics.life,
      dark: false,
      x: 0.5,
      y: 0.5,
      dist: this.bodyDist(rt),
    };
  }

  /**
   * The close star is a place, not a heading. Once we are inside
   * its ARRIVE_RANGE_LY sphere (or it has already become the furnace), keep
   * it until we fly away. Course lock and look-drag only steer;
   * they do not own the object.
   */
  private updateArriveSubject(): void {
    const range = UNIVERSE.ARRIVE_RANGE_KPC;
    if (this.hostObj) {
      if (this.arriveDist(this.hostObj) <= range) return;
      this.hostObj = null;
      return;
    }
    for (const cand of [this.courseObj, this.focusObj, this.selected]) {
      if (cand && this.arriveDist(cand) <= range) {
        this.hostObj = cand;
        return;
      }
    }
  }

  /**
   * The close world is a place, not a heading. Latch inside
   * WORLD_RANGE_AU; fly out to leave. Another world course
   * may replace it — the host sphere stays.
   */
  private updateWorldSubject(): void {
    const range = UNIVERSE.WORLD_RANGE_KPC;
    if (!(range > 0) || !this.hostObj) {
      this.worldId = null;
      return;
    }
    if (this.worldId) {
      const rt = this.worldRt(this.worldId);
      if (rt && this.bodyDist(rt) <= range) return;
      this.worldId = null;
    }
    for (const id of [this.courseBodyId, this.focusBodyId, this.selectedBodyId]) {
      const rt = this.worldRt(id);
      if (rt && this.bodyDist(rt) <= range) {
        this.worldId = id;
        return;
      }
    }
  }

  /**
   * Skin only: grow the toy globe on each rocky Kepler ball
   * (latched / coursed first). Rings, helm, and the clock stay
   * where they are. The placeholder hides when the terrace is on.
   */
  private tickGlobes(tSys: number): void {
    if (!this.hostSpec) {
      this.dropGlobes();
      return;
    }
    const prefer = this.worldId ?? this.courseBodyId ?? this.riding?.bodyId ?? null;
    const rocky: HostBodyRT[] = [];
    for (const rt of this.host.bodies) {
      if (rt.spec.kind !== 'rocky') continue;
      rocky.push(rt);
    }
    const mint = (rt: HostBodyRT): void => {
      if (!this.hostSpec || this.globes.has(rt.spec.id)) return;
      this.globes.set(rt.spec.id, new RockyGlobe(rt.spec, this.hostSpec, rt.group, rt.placeholder));
    };
    if (prefer) {
      const first = rocky.find((rt) => rt.spec.id === prefer);
      if (first) mint(first);
    }
    for (const rt of rocky) {
      if (this.globes.has(rt.spec.id)) continue;
      mint(rt);
      break;
    }
    for (const id of [...this.globes.keys()]) {
      if (!rocky.some((rt) => rt.spec.id === id)) {
        this.globes.get(id)?.dispose();
        this.globes.delete(id);
      }
    }
    const ordered = prefer
      ? [...rocky.filter((rt) => rt.spec.id === prefer), ...rocky.filter((rt) => rt.spec.id !== prefer)]
      : rocky;
    let budget = 8;
    const L = this.hostSpec.star.luminosity;
    for (const rt of ordered) {
      const g = this.globes.get(rt.spec.id);
      if (!g) continue;
      if (!g.ready) {
        if (budget <= 0.4) {
          this.wake(2);
          continue;
        }
        const t0 = performance.now();
        g.tick(Math.min(6, budget));
        budget -= performance.now() - t0;
        this.wake(2);
      }
      if (g.ready) g.update(this.camera, tSys, L, rt.pos, rt.spinQ);
    }
  }

  private globeOf(id: string | null | undefined): RockyGlobe | null {
    if (!id) return null;
    return this.globes.get(id) ?? null;
  }

  /** Hex under a landed tap. Same grid the globe grew from. */
  private pickGlobeCell(clientX: number, clientY: number): GlobePick | null {
    if (!this.landed || !this.worldId) return null;
    const globe = this.globeOf(this.worldId);
    const mesh = globe?.terrainMesh();
    if (!globe || !mesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.ndc.set(((clientX - rect.left) / w) * 2 - 1, -((clientY - rect.top) / h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.hostScene.updateMatrixWorld(true);
    const hits = this.raycaster.intersectObject(mesh, false);
    if (!hits[0]) return null;
    this.hostTmp.copy(hits[0].point);
    mesh.worldToLocal(this.hostTmp);
    const at = globe.cellAt(this.hostTmp.x, this.hostTmp.y, this.hostTmp.z);
    if (!at) return null;
    return { bodyId: globe.bodyId, ...at };
  }

  private dropGlobes(): void {
    for (const g of this.globes.values()) g.dispose();
    this.globes.clear();
  }

  private detachHostStar(): void {
    this.hostObj = null;
    this.detachHost();
  }

  /**
   * Tear down the local km frame. A live dest lives on
   * `route` — leaving a sphere is not aborting lock-on.
   */
  private detachHost(): void {
    this.worldId = null;
    this.focusBodyId = null;
    this.selectedBodyId = null;
    this.pendingPlace = null;
    this.drone = null;
    this.clearRide();
    this.leaveSurface();
    if (!this.route.live) {
      this.courseBodyId = null;
      this.pendingOrbit = null;
      this.pendingArriveOrbit = false;
      if (this.courseHud?.bodyId) this.clearCourse();
      this.navMode = null;
    }
    this.dropGlobes();
    this.clearHostBodies();
    this.detachHostFurnace();
    if (this.hostRoot) {
      this.hostScene.remove(this.hostRoot);
      this.hostRoot = null;
    }
    this.hostStarId = -1;
    this.hostFill = null;
    this.sky.thaw();
  }

  private detachHostFurnace(): void {
    if (!this.hostStar) return;
    this.hostRoot?.remove(this.hostStar.group);
    this.hostStar.dispose();
    this.hostStar = null;
    // The photosphere is gone: the harvest pin is the star again.
    this.sky.applyStarVis();
  }

  private ensureHostRoot(): THREE.Group {
    if (this.hostRoot) return this.hostRoot;
    const root = new THREE.Group();
    root.scale.setScalar(KM_TO_KPC);
    // Same law as the photograph: a small galaxy fill, not a 0.22 flood
    // that would make night impossible once worlds land.
    const fill = new THREE.AmbientLight(0x9aa8c4, UNIVERSE.ARRIVE_SKY_GAIN);
    root.add(fill);
    this.hostFill = fill;
    this.hostScene.add(root);
    this.hostRoot = root;
    return root;
  }

  private attachHostFurnace(lock: GalaxyObject): void {
    this.detachHostFurnace();
    this.clearHostBodies();
    let star = starSpecFromState(lock.star, () => 0.5);
    try {
      this.hostSpec = systemAt(this.seed, lock.id);
      star = this.hostSpec.star;
    } catch {
      this.hostSpec = null;
    }
    this.hostStar = makeStar(star);
    this.ensureHostRoot().add(this.hostStar.group);
    this.hostStarId = lock.id;
    // The photosphere replaces the pin. The catalog freezes on
    // this viewpoint — pins stay pins, the march sleeps.
    this.sky.hideHarvestId(lock.id);
    this.sky.beginFreeze();
    if (this.hostSpec) this.buildHostBodies(this.hostSpec);
  }

  /**
   * Host +Z is the ecliptic pole. The galaxy's pole is +Y (XZ disk).
   * Rotate the km frame so this system's hashed pole sits in the sky.
   */
  private orientHost(root: THREE.Group): void {
    const e = this.hostSpec?.ecliptic;
    if (!e) {
      root.quaternion.identity();
      return;
    }
    const p = eclipticPole(e);
    this.hostPole.set(p.x, p.y, p.z);
    this.hostAlignQ.setFromUnitVectors(this.hostEclipticZ, this.hostPole);
    this.hostTmpQ.setFromAxisAngle(this.hostPole, e.spin);
    root.quaternion.copy(this.hostTmpQ).multiply(this.hostAlignQ);
  }

  private buildHostBodies(spec: SystemSpec): void {
    this.host.build(this.ensureHostRoot(), spec);
  }

  private clearHostBodies(): void {
    this.host.clear(this.hostRoot);
    this.hostSpec = null;
  }

  private updateHostBodies(t: number): void {
    this.host.update(t, this.camera, this.hostRoot);
  }

  /**
   * Sphere entry: the photosphere replaces the harvest pin the
   * same frame. The pin cannot draw the approach. Worlds of that
   * host unfold in the same AU-scale pass.
   */
  private updateHostArrival(now: number): void {
    this.updateArriveSubject();
    this.updateWorldSubject();
    const lock = this.hostObj;
    if (!lock) {
      if (this.hostRoot || this.hostStar) {
        this.detachHost();
        this.applyCam();
      }
      return;
    }
    const cart = galToCart(lock.pos);
    const dx = cart.x - this.ship.at.x;
    const dy = cart.y - this.ship.at.y;
    const dz = cart.z - this.ship.at.z;
    if (this.hostStarId !== lock.id && (this.hostRoot || this.hostStar)) this.detachHost();
    // The sphere is the object of interest: the pin cannot draw
    // the approach (it stays a point, then hops). Swap the frame
    // we enter. Looking around is not leaving.
    if (!this.hostStar) this.attachHostFurnace(lock);

    const root = this.hostRoot;
    if (root) {
      // Landed / drone / ride eyes pin from a km hover — starCart −
      // arcCenter drops the metres at 8 kpc. Do not overwrite the
      // pin before placeRide / placeSurface; that was a one-frame
      // star-relative root that made bodyFromEye aim at the void.
      if (!this.landed && !this.drone && !this.riding) root.position.set(dx, dy, dz);
      this.orientHost(root);
    }

    const tSys = (this.epochUnix + now / 1000) * UNIVERSE.TIME_SCALE;
    this.updateHostBodies(tSys);
    if (this.pendingSession) {
      this.applyPendingSession(tSys);
    } else if (this.pendingPlace) {
      this.applyPendingPlace(tSys);
    } else if (this.drone) {
      this.tickDrone(this.lastDt);
    } else if (this.landed) {
      this.walkSurface(this.lastDt);
      this.placeSurface();
    } else if (this.departing) {
      // Escape burn owns the stick — do not recapture the ring.
    } else if (this.pendingArriveOrbit && this.destOrbit()) {
      this.enterRide(tSys);
    } else if (this.capturing) {
      this.tickCapture(this.lastDt, tSys);
    } else if (this.riding) {
      this.placeRide(tSys);
    } else {
      this.pendingArriveOrbit = false;
    }
    if (root) root.updateMatrixWorld(true);
    if (this.hostStar && root) {
      const camLocal = new THREE.Vector3();
      this.hostStar.group.worldToLocal(camLocal.copy(this.camera.position));
      this.hostStar.update(camLocal, tSys, new THREE.Vector3(1, 1, 1));
    }
    this.applyCam();
    this.emitPlace();
    this.emitSession();
    this.wake(2);
  }

  /**
   * Gestures are catalog kpc. The camera stays at the origin; the
   * viewpoint slides. The GPU holds the harvest — the vertex shader
   * subtracts uCenter. No membership walk.
   */
  /** Speed inside the host sphere: min(ARRIVE_WARP × warp, ARRIVE_K · d). */
  private sphereSpeed(d: number): number {
    return Math.min(
      UNIVERSE.GALAXY_WARP * UNIVERSE.ARRIVE_WARP,
      UNIVERSE.ARRIVE_K * Math.max(d, 1e-16),
    );
  }

  /** Course or host we are closing on / backing from. */
  private closeSubject(): GalaxyObject | null {
    return this.hostObj ?? this.courseObj;
  }

  /**
   * The body governing the speed / park cap: only an active
   * destination (chart pick or body course). The latched
   * `worldId` is a place law (SOI readout), not a course —
   * feeding it here pinned Free roam to ARRIVE_K × d at the
   * ring you just left, so Warp Ahead never left the planet.
   * The hard shell fence still keeps you out of the ball.
   */
  private closeWorld(): HostBodyRT | null {
    return this.worldRt(this.destOrbit()?.bodyId ?? this.courseBodyId);
  }

  /**
   * Speed. The sphere is a limit both ways. Ahead, from
   * ARRIVE_BRAKE_LY: half of disk warp, held until one frame
   * would reach the fence, then half again — the longest
   * stretch at each gear, the fewest frames to the SOI.
   * Floor is the sphere limit. Astern: sphere, then full warp.
   * A world course ramps k from ARRIVE_K down to
   * WORLD_SLOT_K as remain closes the insert window.
   */
  private closeSpeed(d: number, dt = this.lastDt): number {
    const warp = UNIVERSE.GALAXY_WARP;
    const fence = UNIVERSE.ARRIVE_RANGE_KPC;
    if (d <= fence) return this.sphereSpeed(d);
    if (this.astern) return warp;
    const brake = UNIVERSE.ARRIVE_BRAKE_KPC;
    if (d > brake) return warp;
    const vLim = this.sphereSpeed(fence);
    const frame = Math.min(0.05, Math.max(dt, 1 / 120));
    const remain = Math.max(d - fence, 0);
    let v = warp * 0.5;
    while (v > vLim && v * frame >= remain) v *= 0.5;
    return Math.max(vLim, v);
  }

  /**
   * World-course speed. k eases from ARRIVE_K (transfer)
   * to WORLD_SLOT_K (insertion) as remain closes the
   * ORBIT_INSERT window. No AU step — the window is the
   * body's own ring. A frame that would skip the slot
   * halves. Astern keeps the close-crawl.
   */
  private worldCloseSpeed(d: number, park: number, dt = this.lastDt): number {
    const vCeil = UNIVERSE.GALAXY_WARP * UNIVERSE.ARRIVE_WARP;
    const slot = Math.max(park, 1e-18);
    const remain = Math.max(Math.abs(d - slot), 1e-18);
    const insert = UNIVERSE.ORBIT_INSERT * slot;
    const kSlot = UNIVERSE.WORLD_SLOT_K;
    const kFar = Math.max(UNIVERSE.ARRIVE_K, kSlot);
    const a = remain / (remain + insert);
    const k = this.astern ? kFar : kSlot + (kFar - kSlot) * a;
    let v = Math.min(vCeil, k * remain);
    const slack = Math.max(d - slot, 0);
    const vLim = Math.min(vCeil, UNIVERSE.ARRIVE_K * slot);
    if (slack <= 0) return vLim;
    const frame = Math.min(0.05, Math.max(dt, 1 / 120));
    while (v > vLim && v * frame >= slack) v *= 0.5;
    return Math.max(vLim, Math.min(vCeil, v));
  }

  private moveCap(dt = this.lastDt): number | null {
    const world = this.closeWorld();
    if (world) {
      const d = this.bodyDist(world);
      const dest = this.destOrbit();
      const park =
        dest && dest.bodyId === world.spec.id
          ? orbitRadiusKpc(world.spec, dest.kind)
          : this.parkBodyKpc(world.spec);
      return this.worldCloseSpeed(d, park, dt);
    }
    const sub = this.closeSubject();
    if (sub) return this.closeSpeed(this.arriveDist(sub), dt);
    return null;
  }

  /**
   * Hard fence: no move crosses a body's view skin (air /
   * gas / a thin fraction of R) or the photosphere's. The
   * film park sits outside that wall. The 10 000 km figure
   * is a transfer graze, not this shell. The step lands on
   * the wall instead. If we are already inside, only steps
   * that climb out are allowed. Returns the allowed step
   * length along (dx,dy,dz)/len.
   */
  private clampHostAdvance(dx: number, dy: number, dz: number, len: number): number {
    if (!this.hostObj || !this.hostRoot || !(len > 0)) return len;
    const inv = 1 / len;
    this.orbitTmp2.set(dx * inv, dy * inv, dz * inv);
    let allowed = len;
    const fence = (rx: number, ry: number, rz: number, wallKm: number): void => {
      this.hostTmp.set(rx, ry, rz);
      const R = wallKm * KM_TO_KPC;
      const d2 = this.hostTmp.lengthSq();
      const R2 = R * R;
      if (d2 < R2) {
        // Inside: only allow motion that increases distance
        // (dir · bodyDir < 0 — bodyDir is eye→body).
        const closing = this.orbitTmp2.dot(this.hostTmp);
        if (closing > 0) allowed = 0;
        return;
      }
      const t = this.firstShellHit(this.hostTmp, this.orbitTmp2, R);
      if (t != null && t < allowed) allowed = t;
    };
    for (const rt of this.host.bodies) {
      this.bodyFromEye(rt, this.hostTmp2);
      fence(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, shellFloorKm(rt.spec));
    }
    this.hostTmp2.copy(this.hostRoot.position);
    const starR = Math.max(1, this.hostSpec?.star.radius ?? UNIVERSE.RSUN_KM);
    fence(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, viewSkinKm(starR));
    return allowed;
  }

  private moveBubble(vx: number, vy: number, vz: number, force = false): void {
    if (this.mode !== 'region') return;
    const maxV = force ? null : this.moveCap();
    if (maxV != null) {
      const max = maxV * Math.max(this.lastDt, 1 / 120);
      const len = Math.hypot(vx, vy, vz);
      if (len > max) {
        const s = max / len;
        vx *= s;
        vy *= s;
        vz *= s;
      }
    }
    const len = Math.hypot(vx, vy, vz);
    if (len > 0) {
      const allowed = this.clampHostAdvance(vx, vy, vz, len);
      if (allowed < len) {
        const s = allowed / len;
        vx *= s;
        vy *= s;
        vz *= s;
      }
    }
    this.ship.at.x += vx;
    this.ship.at.y += vy;
    this.ship.at.z += vz;
    this.mintAt.copy(this.ship.at);
    this.regionLabel = regionName(this.ship.at.x, this.ship.at.y, this.ship.at.z);
    this.pushMagUniforms();
    this.placeHighlights();
  }

  /** Harvest is minted once at app boot; wait for stars + nebulae + dust. */
  private attachSilhouette(): void {
    void prepareUniverse(this.seed).then(() => {
      if (this.disposed) return;
      this.bindSky();
      this.wake();
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
   * Pinch / wheel. Drone only — thrust along the look.
   * The ship helm does not zoom (that was a fake slide).
   * On the skin this is the walk throttle.
   */
  private zoom(factor: number): void {
    const f = Math.max(1e-3, factor);
    if (this.drone) {
      this.drone.thrustZoom(f, this.droneWorld());
      this.placeDrone();
      this.applyCam();
      this.wake();
      return;
    }
    if (this.landed) {
      this.applySurfaceZoom(-Math.log(f));
    }
  }

  /**
   * Roll the live vehicle around the nose.
   * Positive d is left / CCW; right / clockwise is negative
   * (same sign the old Y-down pinch negate used).
   */
  private applyRoll(d: number): void {
    if (Math.abs(d) < 1e-8) return;
    if (this.drone) {
      this.drone.twist(d);
      this.placeDrone();
    } else {
      this.ship.twist(d);
    }
    this.applyCam();
    this.wake();
  }

  // ------------------------------------------------------------- picking

  /**
   * In-system only: name a host world for the plate. Galaxy
   * stars are the reticle — a tap does not set course.
   */
  private pick(cx: number, cy: number): void {
    if (!this.hostObj) return;
    const body = this.pickBody(cx, cy);
    if (!body) return;
    this.selectedBodyId = body.spec.id;
    this.focusBodyId = body.spec.id;
    this.focusHud = this.hudForBody(body);
    this.focusObj = this.hostObj;
    this.select(null);
    this.wake();
  }

  /** Screen-nearest host body, same slop as a POI tap. */
  private pickBody(cx: number, cy: number): HostBodyRT | null {
    const rect = this.canvas.getBoundingClientRect();
    let best: HostBodyRT | null = null;
    let bestD = 28;
    for (const rt of this.host.bodies) {
      rt.group.getWorldPosition(this.hostTmp);
      const v = this.hostTmp.project(this.camera);
      if (v.z < -1.2 || v.z > 1.2) continue;
      const px = rect.left + (v.x * 0.5 + 0.5) * rect.width;
      const py = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestD) {
        bestD = d;
        best = rt;
      }
    }
    return best;
  }

  // ------------------------------------------------------------- input

  private onDown = (e: PointerEvent): void => {
    this.wake();
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is how a drag that leaves the canvas stays real input.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.looking = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved = 0;
      this.idle = 0;
      this.holdClientX = e.clientX;
      this.armHoldRoll();
    } else if (this.pointers.size === 2) {
      this.cancelHoldRoll();
      this.dragging = false;
      this.looking = false;
      const pts = [...this.pointers.values()];
      this.pinch0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };

  private onMove = (e: PointerEvent): void => {
    // Only a pointer we captured on down. Hover and UI clicks never land here.
    if (!this.pointers.has(e.pointerId)) return;
    if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.buttons === 0) return;
    this.wake();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if ((this.drone || this.landed) && this.pinch0 > 0) {
        const ratio = d / Math.max(1e-3, this.pinch0);
        this.zoom(Math.pow(1 / Math.max(0.2, ratio), ZOOM_PINCH_POW));
      }
      this.pinch0 = d;
      this.moved += 4;
      this.idle = 0;
      return;
    }
    if (!this.dragging) return;
    // This event's movement (capture keeps it real off-canvas).
    let dx = e.movementX;
    let dy = e.movementY;
    if (dx === 0 && dy === 0) {
      dx = e.clientX - this.lastX;
      dy = e.clientY - this.lastY;
    }
    if (dx === 0 && dy === 0) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved += Math.hypot(dx, dy);
    this.idle = 0;
    if (this.moved >= TAP_SLOP) this.cancelHoldRoll();
    if (this.mode === 'region') {
      this.looking = true;
      if (this.drone) {
        this.turnDrone(dx, dy);
        return;
      }
      if (this.landed) {
        this.sYaw += dx * UNIVERSE.WORLD_SURF_STEER;
        this.sPitch = THREE.MathUtils.clamp(
          this.sPitch - dy * UNIVERSE.WORLD_SURF_STEER,
          -1.35,
          1.35,
        );
        this.placeSurface();
        this.applyCam();
        return;
      }
      if (this.riding || this.capturing || this.departing) return;
      this.abortAutopilot();
      this.ship.look(dx, dy);
      this.applyCam();
      return;
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.wake();
    const rolled = this.holdRoll !== 0;
    this.cancelHoldRoll();
    const tap = !rolled && this.dragging && !this.looking && this.moved < TAP_SLOP;
    this.endPointer(e.pointerId);
    if (tap && this.landed) {
      const hit = this.pickGlobeCell(e.clientX, e.clientY);
      if (this.markTool) {
        if (hit) this.callbacks.onMark?.(this.markTool, hit);
      } else {
        this.callbacks.onInspect?.(hit);
      }
    } else if (tap && !this.landed) this.pick(e.clientX, e.clientY);
  };

  private onLostCapture = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.cancelHoldRoll();
    this.endPointer(e.pointerId);
  };

  private endPointer(id: number): void {
    this.pointers.delete(id);
    if (this.pointers.size < 2) {
      this.pinch0 = 0;
    }
    this.dragging = false;
    this.looking = false;
  };

  private onWheel = (e: WheelEvent): void => {
    this.wake();
    e.preventDefault();
    if (this.landed && !this.drone) this.applySurfaceZoom(-e.deltaY * 0.0016);
    else this.zoom(Math.exp(e.deltaY * ZOOM_WHEEL_SENS));
    this.idle = 0;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (this.landed) {
      if (this.isSurfaceKey(e.code)) {
        e.preventDefault();
        this.keys.add(e.code);
        this.wake();
      }
      return;
    }
    if (this.departing) return;
    if (this.riding || this.capturing) return;
    if (this.mode === 'region' && !e.repeat) {
      if (e.code === 'ArrowUp') {
        e.preventDefault();
        if (!this.thrustOn) this.setGear(false);
        this.setWarp(true);
        return;
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault();
        if (this.thrustOn) this.setWarp(false);
        else {
          this.setGear(true);
          this.setWarp(true);
        }
        return;
      }
      if (e.code === 'KeyW') {
        e.preventDefault();
        this.setWarp(true);
        return;
      }
      if (e.code === 'KeyS') {
        e.preventDefault();
        this.setWarp(false);
        return;
      }
    }
    if (this.isSteerKey(e.code)) {
      this.wake();
      if (this.mode === 'region') e.preventDefault();
      this.keys.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.keys.has(e.code) && !this.isSteerKey(e.code) && !this.isSurfaceKey(e.code)) return;
    this.keys.delete(e.code);
    this.wake();
  };

  private isSurfaceKey(code: string): boolean {
    return (
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'ShiftLeft' ||
      code === 'ShiftRight'
    );
  }

  private isSteerKey(code: string): boolean {
    return (
      code === 'KeyA' ||
      code === 'KeyD' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    );
  }

  private steerHeld(): boolean {
    if (this.holdRoll !== 0) return true;
    for (const c of this.keys) if (this.isSteerKey(c)) return true;
    return false;
  }

  /** +1 left, −1 right, 0 none. Keys win over a finger hold. */
  private rollSign(): number {
    const k = this.keys;
    let s = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) s += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s -= 1;
    if (s !== 0) return s > 0 ? 1 : -1;
    return this.holdRoll;
  }

  private armHoldRoll(): void {
    this.cancelHoldRoll();
    if (this.landed || this.mode !== 'region') return;
    this.holdRollTimer = setTimeout(() => this.maybeStartHoldRoll(), HOLD_ROLL_MS);
  }

  private maybeStartHoldRoll(): void {
    this.holdRollTimer = null;
    if (this.moved >= TAP_SLOP || this.pointers.size !== 1 || this.landed || this.mode !== 'region') {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const x = (this.holdClientX - rect.left) / Math.max(1, rect.width);
    if (x < HOLD_ROLL_EDGE) this.holdRoll = 1;
    else if (x > 1 - HOLD_ROLL_EDGE) this.holdRoll = -1;
    if (this.holdRoll) this.wake();
  }

  private cancelHoldRoll(): void {
    if (this.holdRollTimer != null) {
      clearTimeout(this.holdRollTimer);
      this.holdRollTimer = null;
    }
    this.holdRoll = 0;
  }

  /**
   * Free-fly star park (catalog kpc): ARRIVE_FILL film from
   * `worldOrbit.fillViewRadius`, on the live camera frame.
   */
  private parkKpc(obj: GalaxyObject): number {
    // Remnants are point-sized (pulsar ~1e-5 R☉). Fill-park on that
    // radius is ~1e-15 kpc — closer than holdCourse will aim, so
    // warp never Stops. Floor at a WD photosphere: one law, every
    // compact object still has a reachable park.
    const Rsun = Math.max(0.01, obj.star.radius);
    const R = Rsun * UNIVERSE.RSUN_KM * KM_TO_KPC;
    return fillViewRadius(R, this.camera.fov, this.camera.aspect);
  }

  private parkBodyKpc(b: BodySpec): number {
    const clear = clearRadiusKm(b) * KM_TO_KPC;
    const R = Math.max(1, b.radius) * KM_TO_KPC;
    return Math.max(clear, fillViewRadius(R, this.camera.fov, this.camera.aspect));
  }

  /**
   * Latched warp: W / Warp is a fixed catalog rate in the current
   * gear; S / Stop is stop. When stopped, ↑ sets ahead and warps,
   * ↓ sets astern and warps. Ahead: from ARRIVE_BRAKE_LY, half
   * disk warp until a frame would hit the fence, then half
   * again, down to the sphere limit. Astern: sphere limit
   * only, then full warp. Ahead Stops at the fill park.
   * Astern never parks.
   */
  private cruise(dt: number): void {
    if (this.mode !== 'region') {
      this.thrustOn = false;
      this.thrustSpeed = 0;
      return;
    }
    if (this.landed || this.drone) {
      this.thrustOn = false;
      this.thrustSpeed = 0;
      this.clearDepart();
      return;
    }
    if (this.departing) {
      this.tickDepart(dt);
      this.updateArriveSubject();
      this.updateWorldSubject();
      return;
    }
    if (!this.thrustOn && this.coast.lengthSq() > 0) {
      this.moveBubble(this.coast.x * dt, this.coast.y * dt, this.coast.z * dt, true);
      this.applyCam();
      this.updateArriveSubject();
      this.updateWorldSubject();
      return;
    }
    if (this.riding) {
      if (this.thrustOn) this.breakOrbit();
      else return;
    }
    if (this.capturing) {
      // Capture owns the stick — cruise waits.
      this.thrustOn = false;
      this.thrustSpeed = 0;
      return;
    }
    if (this.thrustOn && !this.warpMayRun()) this.thrustOn = false;
    this.orientArc();
    this.updateArriveSubject();
    this.updateWorldSubject();
    const sign = this.thrustSign();
    const course = this.courseObj;
    const dest = this.destOrbit();
    const world =
      dest?.bodyId != null
        ? this.worldRt(dest.bodyId)
        : this.courseBodyId
          ? this.worldRt(this.courseBodyId)
          : null;
    const orbitPark =
      world && dest && dest.bodyId === world.spec.id
        ? orbitRadiusKpc(world.spec, dest.kind)
        : null;
    const cap = this.moveCap(dt);
    const v = cap ?? UNIVERSE.GALAXY_WARP;
    this.thrustSpeed = this.thrustOn ? v : 0;
    if (this.thrustSpeed <= 0) return;
    let step = this.thrustSpeed * dt;
    if (world && orbitPark != null && !this.astern) {
      if (
        this.closeWorldShell(world, orbitPark, step, () => {
          this.pendingArriveOrbit = true;
          this.setWarp(false);
        })
      ) {
        return;
      }
    } else if (course && dest && dest.bodyId == null && !this.astern) {
      const d = this.arriveDist(course);
      const star = {
        radius: Math.max(1e-6, course.star.radius) * UNIVERSE.RSUN_KM,
        mass: Math.max(0.08, course.star.mass),
      };
      const park =
        dest.kind === 'ecliptic' ? starOrbitRadiusKpc(star) : this.parkKpc(course);
      if (d <= park) {
        if (dest.kind === 'ecliptic') this.pendingArriveOrbit = true;
        this.setWarp(false);
        return;
      }
      const c = galToCart(course.pos);
      const tCa =
        (c.x - this.ship.at.x) * this.ship.fwd.x +
        (c.y - this.ship.at.y) * this.ship.fwd.y +
        (c.z - this.ship.at.z) * this.ship.fwd.z;
      if (tCa > 0 && step >= d - park) {
        const inv = 1 / d;
        const remain = d - park;
        this.moveBubble(
          (c.x - this.ship.at.x) * inv * remain,
          (c.y - this.ship.at.y) * inv * remain,
          (c.z - this.ship.at.z) * inv * remain,
        );
        if (dest.kind === 'ecliptic') this.pendingArriveOrbit = true;
        this.setWarp(false);
        return;
      }
    }
    // Ahead only: a full-rate frame is larger than the brake.
    // Land just inside so the next frame is on the curve.
    // Astern does not land on a shell — jumping the fence
    // on the way out is fine.
    if (!this.astern && !world) {
      const sub = this.closeSubject();
      if (sub) {
        const d = this.arriveDist(sub);
        const c = galToCart(sub.pos);
        const closing =
          (c.x - this.ship.at.x) * this.ship.fwd.x +
          (c.y - this.ship.at.y) * this.ship.fwd.y +
          (c.z - this.ship.at.z) * this.ship.fwd.z;
        const brake = UNIVERSE.ARRIVE_BRAKE_KPC;
        if (closing > 0 && d > brake) {
          step = Math.min(step, d - brake * (1 - 1e-6));
        }
      }
    }
    this.moveBubble(this.ship.fwd.x * sign * step, this.ship.fwd.y * sign * step, this.ship.fwd.z * sign * step);
  }

  /** A/D, ←/→, and a still hold on the left/right of the screen roll. */
  private tickRoll(dt: number): void {
    if (this.landed) return;
    if (!this.drone && (this.riding || this.capturing || this.departing)) return;
    const s = this.rollSign();
    if (!s) return;
    this.abortAutopilot();
    this.applyRoll(s * UNIVERSE.SOI_TWIST * dt);
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
   * Centre reticle vs host worlds and local catalog points.
   * Acquire is a tight pip (chance). Hold is a wider cone so
   * the named object stays until the look leaves it. Bodies
   * and harvest stars compete on the same off-axis score —
   * a planet in the cone does not hide a star in the pip.
   */
  private aimReticle(): void {
    if (this.mode !== 'region' || (!this.sky.cloud && !this.sky.nebulae)) {
      this.focusObj = null;
      this.focusHud = null;
      this.focusBodyId = null;
      this.grownCount = 0;
      return;
    }
    if (!this.landed && !this.drone) this.orientArc();
    const lx = this.ship.fwd.x;
    const ly = this.ship.fwd.y;
    const lz = this.ship.fwd.z;
    const ox = this.ship.at.x;
    const oy = this.ship.at.y;
    const oz = this.ship.at.z;
    const holdCos = Math.cos(RETICLE_HOLD);
    const lockCos = Math.cos(RETICLE_LOCK);

    const holdBody = this.focusBodyId ? this.worldRt(this.focusBodyId) : null;
    if (holdBody) {
      holdBody.group.getWorldPosition(this.hostTmp);
      const dist = this.hostTmp.length();
      if (dist > 1e-18) {
        const inv = 1 / dist;
        const dot = this.hostTmp.x * inv * lx + this.hostTmp.y * inv * ly + this.hostTmp.z * inv * lz;
        if (dot >= holdCos) {
          this.grownCount = 1;
          this.focusObj = this.hostObj;
          this.focusHud = this.hudForBody(holdBody);
          this.focusHud.dist = dist;
          return;
        }
      }
    } else if (this.focusObj && !this.focusBodyId) {
      const c = galToCart(this.focusObj.pos);
      const dx = c.x - ox;
      const dy = c.y - oy;
      const dz = c.z - oz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1e-12 && dist <= UNIVERSE.AIM_RANGE_KPC) {
        const inv = 1 / dist;
        const dot = dx * inv * lx + dy * inv * ly + dz * inv * lz;
        if (dot >= holdCos) {
          this.grownCount = 1;
          if (this.focusHud) this.focusHud.dist = dist;
          return;
        }
      }
    }

    let grown = 0;
    let bestBody: HostBodyRT | null = null;
    let bestId = -1;
    let bestOff = 1;
    let bestDist = 0;
    let bestDim = false;
    if (this.hostObj) {
      for (const rt of this.host.bodies) {
        rt.group.getWorldPosition(this.hostTmp);
        const dist = this.hostTmp.length();
        if (dist < 1e-18) continue;
        const inv = 1 / dist;
        const dot = this.hostTmp.x * inv * lx + this.hostTmp.y * inv * ly + this.hostTmp.z * inv * lz;
        if (dot < lockCos) continue;
        grown++;
        const off = 1 - dot;
        if (off < bestOff) {
          bestOff = off;
          bestBody = rt;
          bestId = -1;
          bestDist = dist;
        }
      }
    }
    for (const cloud of [this.sky.cloud, this.sky.nebulae]) {
      if (!cloud) continue;
      const cat = cloud.pos;
      const lum = cloud.lum;
      const bits = cloud.bits;
      const ids = cloud.ids;
      for (let i = 0; i < cloud.n; i++) {
        if (!sketchMatches(bits[i], this.filter)) continue;
        const i3 = i * 3;
        const dx = cat[i3] - ox;
        const dy = cat[i3 + 1] - oy;
        const dz = cat[i3 + 2] - oz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-12) continue;
        const dist = Math.sqrt(d2);
        if (dist > UNIVERSE.AIM_RANGE_KPC) continue;
        const dim = (bits[i] & BIT_REMNANT) !== 0 || lum[i] < 0.05;
        if (!aimLocks(lum[i], dist, dim)) continue;
        grown++;
        const inv = 1 / dist;
        const dot = dx * inv * lx + dy * inv * ly + dz * inv * lz;
        if (dot < lockCos) continue;
        const off = 1 - dot;
        if (off < bestOff) {
          bestOff = off;
          bestBody = null;
          bestId = ids[i];
          bestDist = dist;
          bestDim = dim;
        }
      }
    }
    this.grownCount = grown;
    if (bestBody) {
      this.focusBodyId = bestBody.spec.id;
      this.focusObj = this.hostObj;
      this.focusHud = this.hudForBody(bestBody);
      this.focusHud.dist = bestDist;
      return;
    }
    this.focusBodyId = null;
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

  // --------------------------------------------------------------- frame

  /** Frames left before the loop rests. The galaxy is a static
   *  catalog: at rest nothing changes, so nothing should render —
   *  every star vertex re-marches the dust column each draw
   *  (~37M texture taps a frame), pure heat when the camera is
   *  still. Planets will live inside this scene; it must idle
   *  cold. */
  private restIn = 90;
  private lastPose = { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };

  /** Keep the loop rendering for at least n more frames.
   *  Resting stops rAF entirely — wake is the only restart. */
  private wake(n = 45): void {
    this.restIn = Math.max(this.restIn, n);
    if (this.disposed || !this.active || this.raf) return;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    if (this.disposed || !this.active) {
      this.raf = 0;
      return;
    }
    const f0 = performance.now();
    // Rewire every material whenever the baked volume changes —
    // the one path that covers boot mint, cache hit, and rebuild.
    if (this.sky.dustStale()) this.replaceDust();
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.lastDt = dt;
    this.idle += dt;
    this.holdCourse(dt);
    this.cruise(dt);
    this.tickRoll(dt);
    // Motion is the universal wake: input, warp, and settling
    // all end as pose drift. Hover, a parked Home pick, and a
    // spinning focus ring are not motion — those used to keep
    // the catalog remarching forever. Everything else that can
    // change a pixel calls wake() explicitly.
    const p = this.lastPose;
    const moved =
      Math.abs(p.x - this.ship.at.x) > 1e-9 ||
      Math.abs(p.y - this.ship.at.y) > 1e-9 ||
      Math.abs(p.z - this.ship.at.z) > 1e-9 ||
      Math.abs(p.yaw - this.arcYaw) > 1e-9 ||
      Math.abs(p.pitch - this.arcPitch) > 1e-9 ||
      Math.abs(p.roll - this.arcRoll) > 1e-9;
    if (moved || !Number.isFinite(p.x)) {
      p.x = this.ship.at.x;
      p.y = this.ship.at.y;
      p.z = this.ship.at.z;
      p.yaw = this.arcYaw;
      p.pitch = this.arcPitch;
      p.roll = this.arcRoll;
      this.applyCam();
      this.wake(30);
    }
    if (
      this.thrustOn ||
      this.departing ||
      this.coast.lengthSq() > 0 ||
      this.steerHeld() ||
      this.riding ||
      this.destOrbit() ||
      this.landed ||
      this.drone ||
      this.pendingPlace ||
      this.pendingSession
    ) {
      this.wake(2);
    }
    if (this.restIn <= 0) {
      this.perf.tick(performance.now() - f0, false);
      this.perf.markRest();
      this.raf = 0;
      return;
    }
    this.restIn--;
    this.updateSight();
    this.aimReticle();

    const t = now * 0.001;
    this.camera.updateMatrixWorld();
    this.sky.tickCamera(this.camera);

    const cam = this.camera.position;
    const ringFor = (mesh: THREE.Mesh, lo: number, hi: number, k: number) => {
      const d = cam.distanceTo(mesh.position);
      mesh.scale.setScalar(Math.max(lo, Math.min(hi, d * k)));
    };
    ringFor(this.pickRing, 0.00035, 0.03, 0.045);
    ringFor(this.hereRing, 0.0005, 0.045, 0.06);
    this.pickRing.rotation.z = t * 0.35;
    this.hereRing.rotation.z = t * -0.22;

    this.updateHostArrival(now);
    const tSys = (this.epochUnix + now / 1000) * UNIVERSE.TIME_SCALE;
    this.tickGlobes(tSys);
    this.sky.tickFreeze();
    if (this.pendingSession && this.applyPendingSession(tSys)) this.applyCam();
    if (this.pendingPlace && this.applyPendingPlace(tSys)) this.applyCam();
    this.emitSession();
    // Place can change this frame — write surveyGain after
    // attach so this draw matches the viewpoint.
    const dim = this.skyDim();
    this.sky.setDim(dim);
    if (this.hostFill) this.hostFill.intensity = dim;

    // One scene, one pass, straight to the canvas: the void is
    // black (vacuum emits nothing), self-extincted background
    // sprites add onto it, then the galaxy draws in front. A
    // stacked column saturates to white — film, not a knee.
    this.renderer.setRenderTarget(null);
    this.perf.beginDraw();
    this.renderer.render(this.scene, this.camera);
    if (this.hostRoot && this.hostObj) {
      // Close-approach pass: same camera pose, AU-scale depth window,
      // drawn over the live galaxy. The star is IN the galaxy — the
      // sky never bakes, blanks, or switches environment; the depth
      // buffer is simply re-cleared for the near geometry.
      const d = this.arriveDist(this.hostObj);
      const aKpc = this.host.outerAu * AU_KM * KM_TO_KPC;
      let near = Math.min(d * 0.02, aKpc * 0.01);
      const cam = this.camera.position;
      for (const rt of this.host.bodies) {
        rt.group.getWorldPosition(this.hostTmp);
        const surf = cam.distanceTo(this.hostTmp) - rt.spec.radius * KM_TO_KPC;
        const k = this.landed && rt.spec.id === this.worldId ? 0.12 : 0.35;
        if (surf > 0) near = Math.min(near, surf * k);
      }
      const near0 = this.camera.near;
      const far0 = this.camera.far;
      this.camera.near = Math.max(1e-18, near);
      this.camera.far = Math.max(d * 8, aKpc * 40, 1e-8);
      this.camera.updateProjectionMatrix();
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.hostScene, this.camera);
      this.renderer.autoClear = true;
      this.camera.near = near0;
      this.camera.far = far0;
      this.camera.updateProjectionMatrix();
    }
    this.perf.endDraw();
    this.perf.tick(performance.now() - f0, true);
    if (this.courseHud && this.courseBodyId) {
      const rt = this.worldRt(this.courseBodyId);
      if (rt) this.courseHud.dist = this.bodyDist(rt);
    } else if (this.courseHud && this.courseObj) {
      this.courseHud.dist = this.arriveDist(this.courseObj);
    }
    this.navMode = this.route.navMode(
      {
        hostId: this.hostObj?.id ?? null,
        riding:
          this.riding && this.hostObj
            ? { starId: this.hostObj.id, bodyId: this.riding.bodyId, orbit: this.riding.kind }
            : null,
        capturing: Boolean(this.capturing),
        insertBlend: this.insertBlend,
        hostArriveDist: this.hostObj ? this.arriveDist(this.hostObj) : null,
        arriveRange: UNIVERSE.ARRIVE_RANGE_KPC,
      },
      this.proximity,
    );
    const soi = this.soiDist();
    const nearRt =
      this.navMode === 'proximity' || this.navMode === 'orbit' || this.navMode === 'lock'
        ? nearestBody(this.host.bodies, (b) => this.bodyDist(b))
        : null;
    let navHint: string | null = null;
    if (this.navMode === 'orbit' && this.riding) {
      const ring = orbitLabel(this.riding.kind);
      if (this.riding.bodyId == null) {
        navHint = `${this.hostSpec?.star.name ?? 'Star'} · ${ring}`;
      } else {
        const rt = this.worldRt(this.riding.bodyId);
        navHint = rt ? `${rt.spec.name} · ${ring}` : ring;
      }
    } else if (this.navMode === 'proximity' && nearRt) {
      navHint = nearRt.spec.name;
    } else if (this.navMode === 'lock' && this.capturing) {
      const ring = orbitLabel(this.capturing.kind);
      if (this.capturing.bodyId == null) {
        navHint = `Capturing ${this.hostSpec?.star.name ?? 'star'} · ${ring}`;
      } else {
        const rt = this.worldRt(this.capturing.bodyId);
        navHint = rt ? `Capturing ${rt.spec.name} · ${ring}` : `Capturing · ${ring}`;
      }
    } else if (this.navMode === 'lock' && this.destOrbit()) {
      const dest = this.destOrbit()!;
      const ring = orbitLabel(dest.kind);
      const inserting = this.insertBlend > 0.55;
      if (dest.bodyId == null) {
        const name = this.courseHud?.name ?? this.hostSpec?.star.name ?? 'Star';
        navHint = inserting ? `Inserting ${name} · ${ring}` : `${name} · ${ring}`;
      } else {
        const rt = this.worldRt(dest.bodyId);
        const name = rt?.spec.name;
        navHint = inserting
          ? name
            ? `Inserting ${name} · ${ring}`
            : `Inserting · ${ring}`
          : name
            ? `${name} · ${ring}`
            : ring;
      }
    }
    this.callbacks.onFrame?.({
      mode: this.mode,
      theta: this.ship.toEuler().yaw,
      phi: Math.PI / 2 - this.ship.toEuler().pitch,
      radius: Math.hypot(this.ship.at.x, this.ship.at.z),
      pickable: true,
      resolved: this.shownCount(),
      grown: this.grownCount,
      sector: this.regionLabel,
      population: this.sectorPop,
      focus: this.focusHud,
      course: this.courseHud,
      warp: this.thrustOn,
      astern: this.astern,
      inView: this.overview,
      soiRemain: soi == null ? null : Math.max(0, UNIVERSE.ARRIVE_RANGE_KPC - soi),
      hostId: this.hostObj?.id ?? null,
      backdrop: this.shownCount(),
      orbit: this.riding?.kind ?? this.capturing?.kind ?? this.destOrbit()?.kind ?? this.landKind,
      orbiting: Boolean(this.riding),
      navMode: this.navMode,
      nearestBodyId: nearRt?.spec.id ?? null,
      navHint,
      canLeaveOrbit: Boolean(this.riding || this.capturing),
      departing: Boolean(this.departing),
      landed: this.landed,
      canLand: this.canLandNow(),
      lookHold: this.drone?.lock && !this.drone.phase ? 'center' : null,
      drone: Boolean(this.drone),
      dronePhase: this.drone?.phase ?? null,
      worldId: this.riding?.bodyId ?? this.capturing?.bodyId ?? this.worldId ?? this.courseBodyId,
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}
