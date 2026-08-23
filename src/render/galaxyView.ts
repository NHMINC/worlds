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
import { harvestGlowPx } from './galaxyStar';
import { SkySurvey } from './skySurvey';
import { lockedToStar, type BodySpec } from '../world/systemgen';
import { type HostBodyRT } from './hostSystem';
import { HostLocale } from './hostLocale';
import { nearestBody } from './hostLook';
import { type HostNavMode } from './hostNav';
import { ShipFlight } from './flight';
import { Trackball } from './drone';
import { type Berth } from '../world/course';
import { Voyage } from './voyage';
import { decodeShipVoyage, encodePlace, encodeSession } from './sessionCodec';
import { Helm } from './helm';
import { Sight, type GalaxyFocus } from './sight';
import { DroneBridge } from './droneBridge';
import { VoyagePilot, type PilotPort } from './voyagePilot';
import { ShipControls } from './shipControls';
import { NavWorld } from './navWorld';
import { Navigator } from './navigator';
import { VoyageApproach } from './voyageApproach';

export type { GalaxyFocus } from './sight';
import {
  coerceOrbitKind,
  orbitLabel,
  orbitOmega,
  orbitRadiusKpc,
  shellFloorKm,
  starOrbitOmega,
  starOrbitRadiusKpc,
  starSkinKm,
  type WorldOrbitKind,
} from '../world/worldOrbit';
import { regionName, sketchMatches, type GalaxyFilterName } from '../world/sectors';
import { PerfMeter } from './perfHud';
import { prepareUniverse } from '../world/universePrep';
import type { LastPlace, SessionSnap } from '../world/types';
/** Park “here” this far ahead of the camera (catalog kpc). */
const FOCUS_PARK = 0.35;
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
  /** Drone planet-trackball while Target is on. */
  lookHold: 'center' | null;
  /** Anti-gravity drone is out. */
  drone: boolean;
  /** Increments on each ship ↔ drone camera handover (a cut). */
  camCut: number;
  /** Latched / ridden world, if any. */
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

/** Hex tools while the drone is out. */
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
  /** Drone tap on a hex — inspector (no tool) or the mark dialog. */
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
  /** Flight state machine — berth, ride, capture, depart, warp. */
  private readonly voyage = new Voyage();
  /** The autopilot's hands: rate-limited attitude + throttle. */
  private readonly fcs = new ShipControls(this.ship);
  /** The navigation truth — one snapshot per frame. */
  private nav!: NavWorld;
  /** Guidance: corridor, feasible speed, terminal rendezvous. */
  private navigator!: Navigator;
  /** Ring geometry — insertions, captures, ride placement. */
  private readonly pilot: VoyagePilot;
  /** Approach laws — cruise gears, speed caps, parks, fences. */
  private readonly approach: VoyageApproach;
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
  /** Centre reticle: chance acquire, wide hold. Owns the focus. */
  private readonly sight: Sight;
  /** The drone's window on the world (DroneWorld port). */
  private readonly bridge: DroneBridge;

  /** The survey photograph — harvest, nebulae, dust, cosmic shell. */
  private readonly sky: SkySurvey;

  private pickRing: THREE.Mesh;
  private hereRing: THREE.Mesh;
  private hereObj: GalaxyObject | null = null;


  /** Camera stays at the origin; the bubble centre moves. */
  /** Last centre we minted / advanced to. */
  private mintAt = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  /** Pointer / key routing. Events arrive as verbs on the port. */
  private readonly helm: Helm;
  /** Hex tool while the drone is out. Null = inspect on tap. */
  private markTool: MarkTool | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
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
  private selectedBodyId: string | null = null;
  private navMode: HostNavMode = null;
  private drone: Trackball | null = null;
  /** Ship ↔ drone camera handover count — the UI blinks on it. */
  private camCut = 0;
  /** The host star's light colour (Teff law), cached per host. */
  private readonly sunColor = new THREE.Vector3(1, 1, 1);
  private sunColorId = -1;
  private readonly orbitTmp = new THREE.Vector3();
  private readonly orbitTmp2 = new THREE.Vector3();
  /** Scratch for look-vector slerp (attitude nudges). */
  private readonly orbitQ = new THREE.Quaternion();
  /** On the skin of the latched rocky globe. */
  /** Boot restore: park the host, then the world, once bodies exist. */
  private pendingPlace: LastPlace | null = null;
  /** Exact ship / drone pose — applied once the host frame exists. */
  private pendingSession: SessionSnap | null = null;
  private lastPlaceKey = '';
  private lastSessionJson = '';
  private lastSessionWrite = 0;
  /** The latched SOI star's local km frame — a place, not a heading. */
  private readonly locale: HostLocale;
  private readonly hostTmp = new THREE.Vector3();
  private readonly hostTmp2 = new THREE.Vector3();
  private readonly hostTmpQ = new THREE.Quaternion();
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
      hostPresent: () => Boolean(this.locale.obj),
      center: () => this.ship.at,
    });

    this.locale = new HostLocale(seed, {
      furnaceUp: (id) => {
        this.sky.hideHarvestId(id);
        this.sky.beginFreeze();
      },
      furnaceGone: () => this.sky.applyStarVis(),
    });

    this.pickRing = this.makeRing(0xf4e4c1, 0.18);
    this.hereRing = this.makeRing(0x7ec8e3, 0.22);
    this.scene.add(this.pickRing);
    this.scene.add(this.hereRing);

    this.helm = new Helm(canvas, {
      region: () => this.mode === 'region',
      droneLive: () => Boolean(this.drone),
      lookHeld: () =>
        Boolean(this.voyage.departing || this.voyage.riding || this.voyage.capturing),
      wake: () => this.wake(),
      look: (dx, dy) => this.dragLook(dx, dy),
      zoom: (f) => this.zoom(f),
      tap: (cx, cy) => this.pick(cx, cy),
      setWarp: (on) => this.setWarp(on),
      setGear: (astern) => this.setGear(astern),
      warping: () => this.voyage.thrustOn,
    });
    const pilotPort: PilotPort = {
      region: () => this.mode === 'region',
      droneLive: () => Boolean(this.drone),
      looking: () => this.helm.looking,
      courseObj: () => this.courseObj,
      courseBodyId: () => this.courseBodyId,
      courseDist: (d) => {
        if (this.courseHud) this.courseHud.dist = d;
      },
      arrived: () => {
        this.courseObj = null;
        this.courseBodyId = null;
        this.courseHud = null;
      },
      moveBubble: (vx, vy, vz, force) => this.moveBubble(vx, vy, vz, force),
      applyCam: () => this.applyCam(),
      wake: (n) => this.wake(n),
      stopWarp: () => this.setWarp(false),
      breakOrbit: () => this.breakOrbit(),
      updateSubjects: () => {
        this.updateArriveSubject();
        this.updateWorldSubject();
      },
      arcCap: () => this.navigator.speedCap,
    };
    this.nav = new NavWorld(this.ship, this.locale);
    this.pilot = new VoyagePilot(this.ship, this.voyage, this.locale, this.camera, pilotPort);
    this.approach = new VoyageApproach(this.ship, this.fcs, this.voyage, this.locale, this.camera, pilotPort);
    this.navigator = new Navigator(
      this.ship,
      this.fcs,
      this.voyage,
      this.locale,
      this.nav,
      this.camera,
      this.pilot,
      pilotPort,
    );
    this.sight = new Sight(seed, {
      region: () => this.mode === 'region',
      orient: () => this.orientArc(),
      droneLive: () => Boolean(this.drone),
      fwd: () => this.ship.fwd,
      at: () => this.ship.at,
      clouds: () => [this.sky.cloud, this.sky.nebulae],
      filter: () => this.filter,
      hostObj: () => this.locale.obj,
      bodies: () => this.locale.sys.bodies,
      worldRt: (id) => this.worldRt(id),
      bodyHud: (rt) => this.hudForBody(rt),
    });
    this.bridge = new DroneBridge(this.voyage, this.locale, this.sight, this.camera, {
      worldId: () => this.worldId,
      courseBodyId: () => this.courseBodyId,
      selectedBodyId: () => this.selectedBodyId,
    });
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
    if (this.locale.obj && this.locale.obj.id !== obj.id) this.detachHost();
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
    decodeShipVoyage(snap, this.ship, this.voyage);
    this.mintAt.copy(this.ship.at);
    this.worldId = snap.worldId ?? snap.bodyId;
    this.bindSky();
    this.regionLabel = regionName(this.ship.at.x, this.ship.at.y, this.ship.at.z);
    if (snap.starId != null) {
      const obj = objectAt(this.seed, snap.starId);
      if (obj) {
        this.locale.obj = obj;
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
        this.courseHud = this.sight.starHud(dest, this.arriveDist(dest));
      }
      this.courseBodyId = snap.course.bodyId;
      // Legacy saves could hold a dest ring with courseLive unset —
      // the route is the one owner now, so either revives it.
      if (snap.courseLive || snap.pendingOrbit) {
        this.voyage.route.begin({
          ...snap.course,
          orbit: coerceOrbitKind(snap.pendingOrbit?.kind ?? snap.course.orbit),
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
    if (this.locale.obj && this.locale.obj.id !== starId) this.detachHost();
    this.setHere(starId);
    if (obj) this.parkAtStar(obj);
    else this.openAtHere();
    this.wake();
  }

  /** Rocky world under the ride / landing / course — inspector body. */
  inspectBody(): BodySpec | null {
    const id = this.voyage.riding?.bodyId ?? this.worldId ?? this.courseBodyId;
    const rt = this.worldRt(id);
    if (!rt || rt.spec.kind !== 'rocky') return null;
    return rt.spec;
  }

  /**
   * Hex on the latched globe, in canvas pixels. Hidden on the
   * far side; alpha fades over the limb — same facing law.
   */
  projectCell(bodyId: string, cell: number): ProjectedPoint {
    const hidden: ProjectedPoint = { x: 0, y: 0, visible: false, alpha: 0 };
    const globe = this.locale.globeOf(bodyId);
    const rt = this.worldRt(bodyId);
    const dir = globe?.cellCenter(cell);
    if (!globe || !rt || !dir || !this.locale.root) return hidden;
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
    if (!this.locale.obj) return { group: 'space', density: 0 };
    const rt = this.worldRt(this.voyage.riding?.bodyId ?? this.worldId);
    const density = this.drone ? 0.85 : this.voyage.riding ? 0.45 : 0.08;
    if (!rt || rt.spec.kind !== 'rocky') return { group: 'space', density };
    const p = rt.spec.physics;
    if (p.life) return { group: 'green', density };
    if (p.hydrosphere.state === 'liquid') return { group: 'water', density };
    if (p.hydrosphere.state === 'ice' || p.TsurfK < 250) return { group: 'cold', density };
    if (p.TsurfK > 330 || p.hydrosphere.substance === 'none') return { group: 'dry', density };
    return { group: 'rock', density };
  }

  snapshotPlace(): LastPlace | null {
    const host = this.locale.obj;
    if (!host) return null;
    const rt = this.worldRt(this.voyage.riding?.bodyId ?? this.worldId);
    let dir: [number, number, number] | null = null;
    if (rt) {
      this.locale.bodyFromEye(this.ship.at, rt, this.orbitTmp2).negate();
      if (this.orbitTmp2.lengthSq() > 1e-28) {
        this.locale.spinWorld(rt, this.orbitQ);
        this.orbitTmp2.normalize().applyQuaternion(this.hostTmpQ.copy(this.orbitQ).conjugate());
        dir = [this.orbitTmp2.x, this.orbitTmp2.y, this.orbitTmp2.z];
      }
    }
    let h: number | null = null;
    if (this.voyage.riding && rt) {
      const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
      h = this.voyage.riding.r / Math.max(R, 1e-18) - 1;
    }
    return encodePlace({
      seed: this.seed,
      starId: host.id,
      bodyId: rt?.spec.id ?? null,
      voyage: this.voyage,
      dir,
      h,
    });
  }

  snapshotSession(): SessionSnap {
    return encodeSession({
      seed: this.seed,
      ship: this.ship,
      voyage: this.voyage,
      hostId: this.locale.obj?.id ?? null,
      worldId: this.worldId,
      drone: this.drone ? this.drone.snap(this.droneRideT) : null,
    });
  }

  flushSession(): void {
    this.emitSession(true);
  }

  private parkAtStar(obj: GalaxyObject): void {
    const c = galToCart(obj.pos);
    this.enterRegion(c.x, c.y, c.z, obj);
    this.locale.obj = obj;
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
    this.voyage.pendingArriveOrbit = true;
  }

  /** True when the camp is fully applied (or abandoned). */
  private applyPendingPlace(tSys: number): boolean {
    const p = this.pendingPlace;
    if (!p || !this.locale.obj || this.locale.obj.id !== p.starId) return true;
    if (!this.locale.root || !this.locale.spec) return false;
    if (!p.bodyId) {
      // Star camp → ecliptic hold.
      if (this.locale.root) {
        this.hostTmp.copy(this.locale.root.position).negate().normalize();
      } else {
        this.orientArc();
        this.hostTmp.copy(this.ship.fwd).negate();
      }
      this.pilot.beginStarRide(this.hostTmp, tSys);
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
    // Landed camps restore as the ring they stood under — walking
    // is retired; the drone is the close look.
    const kind = coerceOrbitKind(p.orbit ?? 'equatorial');
    this.pilot.beginRide(rt, kind, dir, tSys);
    if (p.h != null && this.voyage.riding) {
      const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
      const lo = shellFloorKm(rt.spec) * KM_TO_KPC;
      const hi = Math.max(R * (1 + UNIVERSE.SOI_TRACK_MAX), UNIVERSE.WORLD_RANGE_KPC * 0.8);
      this.voyage.riding.r = THREE.MathUtils.clamp(R * (1 + p.h), lo, hi);
    }
    this.pilot.placeRide(tSys);
    this.pendingPlace = null;
    return true;
  }

  /** Apply the live save once the host km frame (and globe) exist. */
  private applyPendingSession(tSys: number): boolean {
    const s = this.pendingSession;
    if (!s) return true;
    if (s.starId != null) {
      if (!this.locale.obj || this.locale.obj.id !== s.starId) return false;
      if (!this.locale.root || !this.locale.spec) return false;
    }
    if (s.riding) {
      const kind = coerceOrbitKind(s.riding.kind);
      this.voyage.riding = {
        bodyId: s.riding.bodyId,
        kind,
        hang: false,
        r: s.riding.r,
        theta0: s.riding.theta0,
        omega: s.riding.omega,
      };
      if (s.riding.bodyId) {
        const rt = this.worldRt(s.riding.bodyId);
        if (rt) {
          this.voyage.riding.r = orbitRadiusKpc(rt.spec, kind);
          this.voyage.riding.omega = orbitOmega(rt.spec, kind);
        }
      } else if (this.locale.obj) {
        const mass = Math.max(0.08, this.locale.spec?.star.mass ?? this.locale.obj.star.mass);
        this.voyage.riding.r = starOrbitRadiusKpc({ radius: this.locale.starRadiusKm() });
        this.voyage.riding.omega = starOrbitOmega({ mass }, this.voyage.riding.r);
      }
      this.voyage.rideE1.set(s.riding.e1[0], s.riding.e1[1], s.riding.e1[2]);
      this.voyage.rideE2.set(s.riding.e2[0], s.riding.e2[1], s.riding.e2[2]);
      this.pilot.placeRide(tSys);
    }
    if (s.capturing) {
      this.voyage.capturing = {
        bodyId: s.capturing.bodyId,
        kind: coerceOrbitKind(s.capturing.kind),
        dir: new THREE.Vector3(s.capturing.dir[0], s.capturing.dir[1], s.capturing.dir[2]),
      };
    }
    if (s.landed && !s.riding) {
      // Walking is retired: a landed save rises onto the ring it
      // would have taken off to, over the same face.
      const rt = this.worldRt(s.worldId ?? s.bodyId);
      if (rt) {
        const kind = coerceOrbitKind(s.landKind ?? 'equatorial');
        this.locale.spinWorld(rt, this.orbitQ);
        this.orbitTmp2
          .set(s.surfDir?.[0] ?? 0, s.surfDir?.[1] ?? 0, s.surfDir?.[2] ?? 1)
          .applyQuaternion(this.orbitQ);
        if (this.orbitTmp2.lengthSq() < 1e-16) this.orbitTmp2.set(0, 0, 1);
        this.orbitTmp2.normalize();
        this.worldId = rt.spec.id;
        this.pilot.beginRide(rt, kind, this.orbitTmp2, tSys);
      }
    }
    if (s.drone && s.drone.phase !== 'home') {
      this.drone = new Trackball();
      this.drone.restore(s.drone);
      this.droneRideT = s.drone.rideT;
      this.placeDrone();
    }
    this.normalizeRestoredPose();
    this.pendingSession = null;
    this.applyCam();
    return true;
  }

  /**
   * Boot heal: a save from an older build (or an older law) can
   * hold a pose inside a hard fence — inside the sun, inside a
   * body's shell — where the fences that would have prevented it
   * now pin it in place. Restore is a state copy, so the copy is
   * normalized ONCE here: any fence-violating eye lifts radially
   * to the appropriate park (star ecliptic park / the body's
   * free-fly park). A saved ride needs no heal — placeRide pins
   * the eye to the ring exactly, under current laws.
   */
  private normalizeRestoredPose(): void {
    if (!this.locale.obj || this.voyage.riding) return;
    const at = this.ship.at;
    // Bodies first: their parks sit far outside the star wall,
    // so a body lift can never land inside the star's fence.
    for (const rt of this.locale.sys.bodies) {
      this.locale.bodyFromEye(at, rt, this.hostTmp);
      const d = this.hostTmp.length();
      const wall = shellFloorKm(rt.spec) * KM_TO_KPC;
      if (!(d < wall)) continue;
      const park = this.approach.parkBodyKpc(rt.spec);
      this.locale.bodyCatalog(rt, this.hostTmp2);
      if (d > 1e-18) {
        at.set(
          this.hostTmp2.x - (this.hostTmp.x / d) * park,
          this.hostTmp2.y - (this.hostTmp.y / d) * park,
          this.hostTmp2.z - (this.hostTmp.z / d) * park,
        );
      } else {
        this.orientArc();
        at.set(
          this.hostTmp2.x - this.ship.fwd.x * park,
          this.hostTmp2.y - this.ship.fwd.y * park,
          this.hostTmp2.z - this.ship.fwd.z * park,
        );
      }
    }
    const starR = this.locale.starRadiusKm();
    const wall = starSkinKm(starR) * KM_TO_KPC;
    const cart = galToCart(this.locale.obj.pos);
    this.hostTmp.set(at.x - cart.x, at.y - cart.y, at.z - cart.z);
    const d = this.hostTmp.length();
    if (d < wall) {
      const park = starOrbitRadiusKpc({ radius: starR });
      if (d > 1e-18) this.hostTmp.multiplyScalar(park / d);
      else {
        this.orientArc();
        this.hostTmp.copy(this.ship.fwd).negate().multiplyScalar(park);
      }
      at.set(cart.x + this.hostTmp.x, cart.y + this.hostTmp.y, cart.z + this.hostTmp.z);
    }
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
      this.locale.spinWorld(rt, this.orbitQ);
      this.orbitTmp.set(p.dir[0], p.dir[1], p.dir[2]).normalize().applyQuaternion(this.orbitQ);
      return this.orbitTmp;
    }
    this.locale.bodyFromEye(this.ship.at, rt, this.orbitTmp2).negate();
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
    this.voyage.clearRide();
    this.voyage.route.abort();
    this.voyage.pendingArriveOrbit = false;
    this.mode = 'region';
    this.ship.at.set(x, y, z);
    this.mintAt.set(x, y, z);
    this.bindSky();
    this.regionLabel = regionName(x, y, z);
    this.objects = [];
    this.voyage.resetThrust();
    this.courseObj = null;
    this.courseHud = null;

    const glen = Math.hypot(x, z);
    const ox = glen > 1e-4 ? x / glen : 1;
    const oz = glen > 1e-4 ? z / glen : 0;
    this.aimAt(ox, 0, oz);
    this.camera.near = 0.001;
    this.camera.far = regionCamFar();
    this.camera.updateProjectionMatrix();
    this.select(select);
    this.applyCam();
    this.sight.update(true);
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
    if (this.mode === 'region') this.sight.update(true);
  }

  /** After a nebula rebake — drop the nebula mesh only. Stars and fog stay. */
  replaceNebulae(): void {
    this.wake();
    this.sky.replaceNebulae();
    this.sectorPop = this.sky.shownCount();
    this.lastEnterMs = this.sky.nebulae?.ms ?? this.lastEnterMs;
    if (this.mode === 'region') this.sight.update(true);
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
    if (this.locale.fill) this.locale.fill.intensity = dim;
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
    considerObj(this.locale.obj);
    considerObj(this.courseObj);
    considerObj(this.sight.focusObj);
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
    if (this.mode === 'region') this.sight.update(true);
  }

  dismiss(): void {
    this.select(null);
  }

  /**
   * Name a berth and latch warp-ahead. Reticle / plate / chart
   * only — a tap does not call this. Works from catalog or
   * another system's SOI. While the drone is out it docks
   * (an instant cut) and the course begins. Drag aborts; Stop
   * only kills thrust.
   */
  setCourse(obj: GalaxyObject): void {
    this.setCourseBerth({ starId: obj.id, bodyId: null, orbit: 'ecliptic' });
  }

  /** Plate: a world of the focused / host star → equatorial berth. */
  setCourseBody(bodyId: string): void {
    const starId = this.sight.focusObj?.id ?? this.locale.obj?.id;
    if (starId == null) return;
    this.setCourseBerth({ starId, bodyId, orbit: 'equatorial' });
  }

  /**
   * Chart pick: berth on the focused harvest star (or the
   * host if there is no other focus). Does not require
   * hostObj === dest.
   */
  goToWorldOrbit(bodyId: string, kind: WorldOrbitKind): void {
    const starId = this.sight.focusObj?.id ?? this.locale.obj?.id;
    if (starId == null) return;
    this.setCourseBerth({ starId, bodyId, orbit: kind });
  }

  /** Live dest ring — the Course owns it, nobody shadows it. */
  private destOrbit(): { bodyId: string | null; kind: WorldOrbitKind } | null {
    return this.voyage.route.destOrbit();
  }

  setCourseBerth(dest: Berth): void {
    if (this.mode !== 'region') return;
    if (this.drone) this.setDrone(false);
    const obj = objectAt(this.seed, dest.starId);
    if (!obj) return;
    if (this.voyage.riding || this.voyage.capturing) this.breakOrbit();
    this.voyage.clearDepart();
    this.voyage.begin(dest);
    this.courseObj = obj;
    this.courseBodyId = dest.bodyId;
    if (dest.bodyId) {
      const rt = this.worldRt(dest.bodyId);
      this.selectedBodyId = dest.bodyId;
      this.courseHud = rt ? this.hudForBody(rt) : this.sight.starHud(obj, this.arriveDist(obj));
    } else {
      this.selectedBodyId = null;
      this.courseHud = this.sight.starHud(obj, this.arriveDist(obj));
    }
    this.select(null);
    this.beginAutopilot();
  }

  /** Lock-on is warp-ahead until a look drag aborts it. */
  private beginAutopilot(): void {
    if (this.drone) return;
    if (this.voyage.riding || this.voyage.capturing) {
      this.wake();
      return;
    }
    if (this.voyage.thrustOn) this.setWarp(false);
    this.setGear(false);
    this.setWarp(true);
    this.wake();
  }

  /** Finger drag: drop the route and stop warp. Stop does not call this. */
  private abortAutopilot(): void {
    if (!this.voyage.route.live) return;
    this.voyage.abortRoute();
    this.clearCourse();
    if (this.voyage.thrustOn) this.setWarp(false);
  }

  /**
   * Drone only. Off: free fly. On: lock the body in the
   * pip (tap or reticle). Launch already locked the body
   * nearest the ship — this retargets; it does not hop.
   */
  centerLook(): void {
    if (this.mode !== 'region' || !this.locale.obj || !this.drone) return;
    this.drone.toggleLock(this.bridge.world());
    this.placeDrone();
    this.applyCam();
    this.wake();
  }

  /** Strict two-way toggle: out ↔ back, both instant cuts. */
  toggleDrone(): boolean {
    this.setDrone(!this.drone);
    return Boolean(this.drone);
  }

  setDrone(on: boolean): void {
    if (this.mode !== 'region' || !this.locale.obj) return;
    if (!on) {
      if (!this.drone) return;
      // Instant return: the cut, then the ship camera — which is
      // exactly as the drone left it.
      this.drone = null;
      this.camCut++;
      this.restoreShipCam();
      return;
    }
    if (this.drone) return;
    // Launch must always work inside a sphere: a Leave burn is
    // simply cancelled (the old early-return made the button dead
    // for the whole burn), and a just-teleported host attaches
    // its frame on demand instead of refusing the first tap.
    this.voyage.clearDepart();
    if (!this.locale.star) this.locale.attachFurnace(this.locale.obj);
    const root = this.locale.root;
    if (!root) return;
    this.locale.orient(root);
    const tSys = (this.epochUnix + performance.now() / 1000) * UNIVERSE.TIME_SCALE;
    this.droneRideT = tSys;
    this.hostTmpQ.copy(root.quaternion).conjugate();
    // Spawn eye from the SHIP's own position (exact-difference
    // precision law), never from the root pin — a stale pin put
    // the drone at the star's centre on the attach-on-demand path.
    const cart = galToCart(this.locale.obj.pos);
    this.orbitTmp2
      .set(this.ship.at.x - cart.x, this.ship.at.y - cart.y, this.ship.at.z - cart.z)
      .applyQuaternion(this.hostTmpQ)
      .multiplyScalar(1 / KM_TO_KPC);
    const eyeKm = this.orbitTmp2.clone();
    const fwd = this.droneLocalLook(this.ship.fwd, this.hostTmpQ);
    const up = this.droneLocalLook(this.ship.up, this.hostTmpQ);
    this.drone = new Trackball();
    this.drone.launch(eyeKm, fwd, up, this.bridge.world());
    this.camCut++;
    this.placeDrone();
    this.applyCam();
    this.wake();
  }

  /** Camera back onto the parked ship. The ship never moved. */
  private restoreShipCam(): void {
    if (this.voyage.riding && this.locale.obj) {
      const tSys = (this.epochUnix + performance.now() / 1000) * UNIVERSE.TIME_SCALE;
      const dt = tSys - this.droneRideT;
      this.voyage.riding.theta0 -= this.voyage.riding.omega * dt;
      this.pilot.placeRide(tSys);
    } else {
      const root = this.locale.root;
      const lock = this.locale.obj;
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

  /** Soft floor: do not go inside a ball. Atmosphere is outside R. */
  /** World look vector into the drone's local frame. */
  private droneLocalLook(world: THREE.Vector3, localOfWorld: THREE.Quaternion): THREE.Vector3 {
    this.orbitTmp2.copy(world).applyQuaternion(localOfWorld);
    if (this.orbitTmp2.lengthSq() < 1e-16) this.orbitTmp2.set(0, 0, 1);
    return this.orbitTmp2.normalize().clone();
  }

  private placeDrone(): void {
    const drone = this.drone;
    if (!drone || !this.locale.root || !this.locale.obj) return;
    this.locale.pinEyeKm(drone.eye, null);
  }

  private turnDrone(dx: number, dy: number): void {
    if (!this.drone) return;
    this.drone.look(dx, dy, this.bridge.world());
    this.placeDrone();
    this.applyCam();
  }

  private tickDrone(): void {
    if (!this.drone) return;
    this.drone.tick(this.bridge.world());
    this.placeDrone();
  }

  private clearCourse(): void {
    this.courseObj = null;
    this.courseHud = null;
    this.courseBodyId = null;
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
    return this.sight.grownCount;
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
    if (this.drone || this.voyage.departing) return;
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
    this.sight.update(true);
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
    this.sight.update(true);
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
    this.sight.update(true);
    return best;
  }

  focusedObject(): GalaxyObject | null {
    return this.sight.focusObj;
  }

  focusedBodyId(): string | null {
    return this.sight.focusBodyId;
  }

  /** Chart subject: focused harvest star, else the host. */
  chartObject(): GalaxyObject | null {
    return this.sight.focusObj ?? this.locale.obj;
  }

  /** Refresh sight uniforms — smoke / tests. */
  syncArc(): void {
    if (this.mode === 'region') this.sight.update(true);
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
      return;
    }
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
      this.helm.cancelHold();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setWarp(false);
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.helm.dispose();
    this.detachHostStar();
    this.sky.thaw();
    this.sky.dispose();
    this.pickRing.geometry.dispose();
    (this.pickRing.material as THREE.Material).dispose();
    this.hereRing.geometry.dispose();
    (this.hereRing.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  /**
   * Player verb: drop the rail and burn to escape speed for
   * that body (√2 × circular, floored by the place crawl so
   * the burn is a beat). Not interruptible — then you float
   * free and the helm comes back. A live dest is kept.
   */
  leaveOrbit(): void {
    if (this.drone) return;
    if (!this.voyage.riding && !this.voyage.capturing) return;
    const vEsc = this.approach.departEscapeSpeed();
    this.breakOrbit();
    this.approach.aimDepartStarboard();
    this.voyage.beginDepart(vEsc, this.ship.fwd);
    this.applyCam();
    this.wake();
  }

  /**
   * Exit ring: drop the rail. If a dest course is live, keep it
   * (LeaveSoi / cruise owns the nose next). No dest → proximity.
   * Heading is the Leave starboard yaw — not a radial flip
   * into the star.
   */
  private breakOrbit(): void {
    if (this.voyage.breakOrbit()) this.fillCourseHud();
  }

  /** Dest survived Leave — put the plate back after In Orbit wiped it. */
  private fillCourseHud(): void {
    const dest = this.voyage.route.dest;
    if (!dest || this.courseHud) return;
    const obj = objectAt(this.seed, dest.starId);
    if (!obj) return;
    this.courseObj = obj;
    this.courseBodyId = dest.bodyId;
    if (dest.bodyId) {
      const rt = this.worldRt(dest.bodyId);
      this.courseHud = rt ? this.hudForBody(rt) : this.sight.starHud(obj, this.arriveDist(obj));
    } else {
      this.courseHud = this.sight.starHud(obj, this.arriveDist(obj));
    }
  }

  /** Latch warp on (fixed cruise) or off (stop). A tap, not a hold. */
  setWarp(on: boolean): void {
    if (this.drone) return;
    if (this.mode !== 'region') return;
    if (this.voyage.departing) return;
    if (on && (this.voyage.riding || this.voyage.capturing)) return;
    this.voyage.coast.set(0, 0, 0);
    this.voyage.thrustOn = on && this.approach.warpMayRun();
    if (this.voyage.thrustOn) this.wake(2);
  }

  /** Ahead / astern. Only while stopped — a running warp keeps the gear. */
  setGear(astern: boolean): void {
    if (this.mode !== 'region' || this.voyage.thrustOn) return;
    if (this.voyage.astern === astern) return;
    this.voyage.astern = astern;
    this.wake();
  }

  toggleGear(): void {
    this.setGear(!this.voyage.astern);
  }

  warping(): boolean {
    return this.voyage.thrustOn;
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
    if (this.drone && this.locale.root) {
      this.orbitTmp.copy(this.drone.fwd).applyQuaternion(this.locale.root.quaternion).normalize();
      this.orbitTmp2.copy(this.drone.up).applyQuaternion(this.locale.root.quaternion).normalize();
      this.drone.applyLook(this.camera, this.orbitTmp, this.orbitTmp2);
    } else {
      this.ship.orthonormalize();
      this.ship.applyCam(this.camera);
    }
    const lock = this.locale.obj;
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
    return this.locale.sys.get(id);
  }

  /** Catalog kpc from the camera to a host-pass body. */
  private bodyDist(rt: HostBodyRT): number {
    return this.locale.bodyFromEye(this.ship.at, rt, this.hostTmp).length();
  }

  private hudForBody(rt: HostBodyRT): GalaxyFocus {
    const b = rt.spec;
    let moons = 0;
    if (this.locale.spec) {
      for (const row of this.locale.spec.bodies) if (row.parent === b.id) moons++;
    }
    return {
      id: this.locale.obj?.id ?? 0,
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
    if (this.locale.obj) {
      if (this.arriveDist(this.locale.obj) <= range) return;
      this.locale.obj = null;
      return;
    }
    for (const cand of [this.courseObj, this.sight.focusObj, this.selected]) {
      if (cand && this.arriveDist(cand) <= range) {
        this.locale.obj = cand;
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
    if (!(range > 0) || !this.locale.obj) {
      this.worldId = null;
      return;
    }
    if (this.worldId) {
      const rt = this.worldRt(this.worldId);
      if (rt && this.bodyDist(rt) <= range) return;
      this.worldId = null;
    }
    for (const id of [this.courseBodyId, this.sight.focusBodyId, this.selectedBodyId]) {
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
    if (!this.locale.spec) {
      this.locale.dropGlobes();
      return;
    }
    const prefer = this.worldId ?? this.courseBodyId ?? this.voyage.riding?.bodyId ?? null;
    const rocky: HostBodyRT[] = [];
    for (const rt of this.locale.sys.bodies) {
      if (rt.spec.kind !== 'rocky') continue;
      rocky.push(rt);
    }
    const mint = (rt: HostBodyRT): void => {
      this.locale.mintGlobe(rt);
    };
    if (prefer) {
      const first = rocky.find((rt) => rt.spec.id === prefer);
      if (first) mint(first);
    }
    for (const rt of rocky) {
      if (this.locale.globes.has(rt.spec.id)) continue;
      mint(rt);
      break;
    }
    for (const id of [...this.locale.globes.keys()]) {
      if (!rocky.some((rt) => rt.spec.id === id)) {
        this.locale.globes.get(id)?.dispose();
        this.locale.globes.delete(id);
      }
    }
    const ordered = prefer
      ? [...rocky.filter((rt) => rt.spec.id === prefer), ...rocky.filter((rt) => rt.spec.id !== prefer)]
      : rocky;
    let budget = 8;
    const L = this.locale.spec.star.luminosity;
    if (this.sunColorId !== this.locale.starId) {
      const c = new THREE.Color(this.locale.spec.star.lightColor);
      this.sunColor.set(c.r, c.g, c.b);
      this.sunColorId = this.locale.starId;
    }
    for (const rt of ordered) {
      const g = this.locale.globes.get(rt.spec.id);
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
      if (g.ready) g.update(this.camera, tSys, L, rt.pos, rt.spinQ, this.sunColor);
    }
  }

  private detachHostStar(): void {
    this.locale.obj = null;
    this.detachHost();
  }

  /**
   * Tear down the local km frame. A live dest lives on
   * `route` — leaving a sphere is not aborting lock-on.
   */
  private detachHost(): void {
    this.worldId = null;
    this.sight.focusBodyId = null;
    this.selectedBodyId = null;
    this.pendingPlace = null;
    this.drone = null;
    this.voyage.clearRide();
    if (!this.voyage.route.live) {
      this.courseBodyId = null;
      this.voyage.pendingArriveOrbit = false;
      if (this.courseHud?.bodyId) this.clearCourse();
    }
    this.locale.detach();
    this.sky.thaw();
  }

  /**
   * Sphere entry: the photosphere replaces the harvest pin the
   * same frame. The pin cannot draw the approach. Worlds of that
   * host unfold in the same AU-scale pass.
   */
  private updateHostArrival(now: number): void {
    this.updateArriveSubject();
    this.updateWorldSubject();
    const lock = this.locale.obj;
    if (!lock) {
      if (this.locale.root || this.locale.star) {
        this.detachHost();
        this.applyCam();
      }
      return;
    }
    const cart = galToCart(lock.pos);
    const dx = cart.x - this.ship.at.x;
    const dy = cart.y - this.ship.at.y;
    const dz = cart.z - this.ship.at.z;
    if (this.locale.starId !== lock.id && (this.locale.root || this.locale.star)) this.detachHost();
    // The sphere is the object of interest: the pin cannot draw
    // the approach (it stays a point, then hops). Swap the frame
    // we enter. Looking around is not leaving.
    if (!this.locale.star) this.locale.attachFurnace(lock);

    const root = this.locale.root;
    if (root) {
      // Landed / drone / ride eyes pin from a km hover — starCart −
      // arcCenter drops the metres at 8 kpc. Do not overwrite the
      // pin before placeRide / placeSurface; that was a one-frame
      // star-relative root that made bodyFromEye aim at the void.
      if (!this.drone && !this.voyage.riding) root.position.set(dx, dy, dz);
      this.locale.orient(root);
    }

    const tSys = (this.epochUnix + now / 1000) * UNIVERSE.TIME_SCALE;
    this.locale.updateBodies(tSys, this.camera);
    if (this.pendingSession) {
      this.applyPendingSession(tSys);
    } else if (this.pendingPlace) {
      this.applyPendingPlace(tSys);
    } else if (this.drone) {
      this.tickDrone();
    } else if (this.voyage.departing) {
      // Escape burn owns the stick — do not recapture the ring.
    } else if (this.voyage.pendingArriveOrbit && this.destOrbit()) {
      this.pilot.enterRide();
    } else if (this.voyage.capturing) {
      this.navigator.captureTick(this.lastDt, tSys);
    } else if (this.voyage.riding) {
      this.pilot.placeRide(tSys);
    } else {
      this.voyage.pendingArriveOrbit = false;
    }
    if (root) root.updateMatrixWorld(true);
    if (this.locale.star && root) {
      const camLocal = new THREE.Vector3();
      this.locale.star.group.worldToLocal(camLocal.copy(this.camera.position));
      this.locale.star.update(camLocal, tSys, new THREE.Vector3(1, 1, 1));
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
  private moveBubble(vx: number, vy: number, vz: number, force = false): void {
    if (this.mode !== 'region') return;
    const maxV = force ? null : this.approach.moveCap();
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
      const allowed = this.approach.clampAdvance(vx, vy, vz, len);
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
   */
  private zoom(factor: number): void {
    const f = Math.max(1e-3, factor);
    if (this.drone) {
      this.drone.thrustZoom(f, this.bridge.world());
      this.placeDrone();
      this.applyCam();
      this.wake();
      return;
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

  /** Hex tool while the drone is out (label / marker / off). */
  setMarkTool(tool: MarkTool | null): void {
    this.markTool = tool;
  }

  /**
   * Hex under a drone tap: raycast the ready globes through the
   * tap point. The drone is the close look — this is how a cell
   * is inspected or marked. Same grid the globe grew from.
   */
  private pickGlobeCell(clientX: number, clientY: number): GlobePick | null {
    if (!this.drone) return null;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.ndc.set(((clientX - rect.left) / w) * 2 - 1, -((clientY - rect.top) / h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.locale.scene.updateMatrixWorld(true);
    let best: { pick: GlobePick; t: number } | null = null;
    for (const globe of this.locale.globes.values()) {
      const mesh = globe.terrainMesh();
      if (!globe.ready || !mesh) continue;
      const hits = this.raycaster.intersectObject(mesh, false);
      if (!hits[0]) continue;
      if (best && hits[0].distance >= best.t) continue;
      this.hostTmp.copy(hits[0].point);
      mesh.worldToLocal(this.hostTmp);
      const at = globe.cellAt(this.hostTmp.x, this.hostTmp.y, this.hostTmp.z);
      if (!at) continue;
      best = { pick: { bodyId: globe.bodyId, ...at }, t: hits[0].distance };
    }
    return best?.pick ?? null;
  }

  /**
   * In-system only. Drone out: a hex hit inspects or marks the
   * cell. Otherwise name a host world for the plate. Galaxy
   * stars are the reticle — a tap does not set course.
   */
  private pick(cx: number, cy: number): void {
    if (!this.locale.obj) return;
    if (this.drone) {
      const hit = this.pickGlobeCell(cx, cy);
      if (hit) {
        if (this.markTool) this.callbacks.onMark?.(this.markTool, hit);
        else this.callbacks.onInspect?.(hit);
        return;
      }
    }
    const body = this.pickBody(cx, cy);
    if (!body) return;
    this.selectedBodyId = body.spec.id;
    this.sight.focusBodyId = body.spec.id;
    this.sight.focusHud = this.hudForBody(body);
    this.sight.focusObj = this.locale.obj;
    this.select(null);
    this.wake();
  }

  /** Screen-nearest host body, same slop as a POI tap. */
  private pickBody(cx: number, cy: number): HostBodyRT | null {
    const rect = this.canvas.getBoundingClientRect();
    let best: HostBodyRT | null = null;
    let bestD = 28;
    for (const rt of this.locale.sys.bodies) {
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

  /** Drag look on the live vehicle. A drag aborts the autopilot. */
  private dragLook(dx: number, dy: number): void {
    if (this.drone) {
      this.turnDrone(dx, dy);
      return;
    }
    if (this.voyage.riding || this.voyage.capturing || this.voyage.departing) return;
    this.abortAutopilot();
    this.ship.look(dx, dy);
    this.applyCam();
  }

  /** A/D, ←/→, and a still hold on the left/right of the screen roll. */
  private tickRoll(dt: number): void {
    if (!this.drone && (this.voyage.riding || this.voyage.capturing || this.voyage.departing)) return;
    const s = this.helm.rollSign();
    if (!s) return;
    this.abortAutopilot();
    this.applyRoll(s * UNIVERSE.SOI_TWIST * dt);
  }

  // --------------------------------------------------------------- sight

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
    this.approach.lastDt = dt;
    // The truth snapshot guidance reads this frame.
    this.nav.tick(dt, (this.epochUnix + now / 1000) * UNIVERSE.TIME_SCALE);
    this.navigator.guide(dt);
    this.approach.cruise(dt);
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
      this.voyage.thrustOn ||
      this.voyage.departing ||
      this.voyage.coast.lengthSq() > 0 ||
      this.helm.steerHeld() ||
      this.voyage.riding ||
      this.destOrbit() ||
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
    this.sight.aim();

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
    if (this.locale.fill) this.locale.fill.intensity = dim;

    // One scene, one pass, straight to the canvas: the void is
    // black (vacuum emits nothing), self-extincted background
    // sprites add onto it, then the galaxy draws in front. A
    // stacked column saturates to white — film, not a knee.
    this.renderer.setRenderTarget(null);
    this.perf.beginDraw();
    this.renderer.render(this.scene, this.camera);
    if (this.locale.root && this.locale.obj) {
      // Close-approach pass: same camera pose, AU-scale depth window,
      // drawn over the live galaxy. The star is IN the galaxy — the
      // sky never bakes, blanks, or switches environment; the depth
      // buffer is simply re-cleared for the near geometry.
      const d = this.arriveDist(this.locale.obj);
      const aKpc = this.locale.sys.outerAu * AU_KM * KM_TO_KPC;
      let near = Math.min(d * 0.02, aKpc * 0.01);
      const cam = this.camera.position;
      for (const rt of this.locale.sys.bodies) {
        rt.group.getWorldPosition(this.hostTmp);
        const surf = cam.distanceTo(this.hostTmp) - rt.spec.radius * KM_TO_KPC;
        const k = 0.35;
        if (surf > 0) near = Math.min(near, surf * k);
      }
      const near0 = this.camera.near;
      const far0 = this.camera.far;
      this.camera.near = Math.max(1e-18, near);
      this.camera.far = Math.max(d * 8, aKpc * 40, 1e-8);
      this.camera.updateProjectionMatrix();
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.locale.scene, this.camera);
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
    this.navMode = this.voyage.route.navMode(
      {
        hostId: this.locale.obj?.id ?? null,
        riding:
          this.voyage.riding && this.locale.obj
            ? { starId: this.locale.obj.id, bodyId: this.voyage.riding.bodyId, orbit: this.voyage.riding.kind }
            : null,
        capturing: Boolean(this.voyage.capturing),
        insertBlend: this.voyage.insertBlend,
        hostArriveDist: this.locale.obj ? this.arriveDist(this.locale.obj) : null,
        arriveRange: UNIVERSE.ARRIVE_RANGE_KPC,
      },
      this.voyage.proximity,
    );
    const soi = this.soiDist();
    const nearRt =
      this.navMode === 'proximity' || this.navMode === 'orbit' || this.navMode === 'lock'
        ? nearestBody(this.locale.sys.bodies, (b) => this.bodyDist(b))
        : null;
    let navHint: string | null = null;
    if (this.navMode === 'orbit' && this.voyage.riding) {
      const ring = orbitLabel(this.voyage.riding.kind);
      if (this.voyage.riding.bodyId == null) {
        navHint = `${this.locale.spec?.star.name ?? 'Star'} · ${ring}`;
      } else {
        const rt = this.worldRt(this.voyage.riding.bodyId);
        navHint = rt ? `${rt.spec.name} · ${ring}` : ring;
      }
    } else if (this.navMode === 'proximity' && nearRt) {
      navHint = nearRt.spec.name;
    } else if (this.navMode === 'lock' && this.voyage.capturing) {
      const ring = orbitLabel(this.voyage.capturing.kind);
      if (this.voyage.capturing.bodyId == null) {
        navHint = `Capturing ${this.locale.spec?.star.name ?? 'star'} · ${ring}`;
      } else {
        const rt = this.worldRt(this.voyage.capturing.bodyId);
        navHint = rt ? `Capturing ${rt.spec.name} · ${ring}` : `Capturing · ${ring}`;
      }
    } else if (this.navMode === 'lock' && this.destOrbit()) {
      const dest = this.destOrbit()!;
      const ring = orbitLabel(dest.kind);
      const inserting = this.voyage.insertBlend > 0.55;
      if (dest.bodyId == null) {
        const name = this.courseHud?.name ?? this.locale.spec?.star.name ?? 'Star';
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
      grown: this.sight.grownCount,
      sector: this.regionLabel,
      population: this.sectorPop,
      focus: this.sight.focusHud,
      course: this.courseHud,
      warp: this.voyage.thrustOn,
      astern: this.voyage.astern,
      inView: this.overview,
      soiRemain: soi == null ? null : Math.max(0, UNIVERSE.ARRIVE_RANGE_KPC - soi),
      hostId: this.locale.obj?.id ?? null,
      backdrop: this.shownCount(),
      orbit: this.voyage.riding?.kind ?? this.voyage.capturing?.kind ?? this.destOrbit()?.kind ?? null,
      orbiting: Boolean(this.voyage.riding),
      navMode: this.navMode,
      nearestBodyId: nearRt?.spec.id ?? null,
      navHint,
      canLeaveOrbit: Boolean(this.voyage.riding || this.voyage.capturing),
      departing: Boolean(this.voyage.departing),
      lookHold: this.drone?.lock ? 'center' : null,
      drone: Boolean(this.drone),
      camCut: this.camCut,
      worldId: this.voyage.riding?.bodyId ?? this.voyage.capturing?.bodyId ?? this.worldId ?? this.courseBodyId,
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}
