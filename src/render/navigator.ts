/**
 * Guidance. The navigator reads the truth (`NavWorld`), decides,
 * and commands the flight controls (`ShipControls`) — it never
 * touches the ship pose or thrust directly. Three jobs:
 *
 *   - **Corridor routing** (was `routeAim`): space is empty;
 *     bodies are balls. If the sightline hits one, fly the
 *     shorter tangent — and LATCH that side until the ball
 *     clears. Re-picking every frame was an oscillator near a
 *     graze ball.
 *   - **Feasible speed**: pursuit demands a line-of-sight rate
 *     of v·sinθ/d; the nose turns at SHIP_TURN_RATE. So
 *     v ≤ NAV_ARC_MARGIN · SHIP_TURN_RATE · d / sinθ — never fly
 *     faster than you can turn the arc you are on. Without this
 *     the ship circled its target instead of arriving.
 *   - **Terminal rendezvous** (was the capture position lerp):
 *     close the ring point exponentially THROUGH the same
 *     fence-checked bubble step every other move uses, with the
 *     target's own Kepler drift fed forward, while the FCS eases
 *     the parked look. The latch (beginRide) stays a rail verb
 *     on the pilot.
 *
 * The pilot keeps the rail: ride placement, ring bases, limb
 * geometry, depart. The approach keeps the gears and fences.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import { type HostBodyRT } from './hostSystem';
import { planOrbitInsert } from './orbitInsert';
import { ShipFlight } from './flight';
import { ShipControls } from './shipControls';
import { Voyage } from './voyage';
import { HostLocale } from './hostLocale';
import { NavWorld } from './navWorld';
import { VoyagePilot, type PilotPort } from './voyagePilot';
import {
  orbitLimbPitch,
  orbitRadiusKpc,
  sideFovDeg,
  starOrbitRadiusKpc,
  type WorldOrbitKind,
} from '../world/worldOrbit';

/** Catalog kpc per kilometre. */
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

export class Navigator {
  /**
   * Feasible speed this frame (kpc/s) — the arc law's cap on
   * cruise. Null while no route is being flown.
   */
  speedCap: number | null = null;

  /** Corridor hysteresis: the ball we are deflecting around
   *  (undefined = free) and the tangent we latched. */
  private lockBall: string | null | undefined = undefined;
  private readonly lockDir = new THREE.Vector3();

  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly aimTmp = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tanA = new THREE.Vector3();
  private readonly tanB = new THREE.Vector3();
  private readonly lookSlerp = new THREE.Vector3();
  private readonly latchUp = new THREE.Vector3();
  private readonly orbitQ = new THREE.Quaternion();

  private readonly ship: ShipFlight;
  private readonly fcs: ShipControls;
  private readonly voyage: Voyage;
  private readonly locale: HostLocale;
  private readonly nav: NavWorld;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly pilot: VoyagePilot;
  private readonly port: PilotPort;

  constructor(
    ship: ShipFlight,
    fcs: ShipControls,
    voyage: Voyage,
    locale: HostLocale,
    nav: NavWorld,
    camera: THREE.PerspectiveCamera,
    pilot: VoyagePilot,
    port: PilotPort,
  ) {
    this.ship = ship;
    this.fcs = fcs;
    this.voyage = voyage;
    this.locale = locale;
    this.nav = nav;
    this.camera = camera;
    this.pilot = pilot;
    this.port = port;
  }

  private worldRt(id: string | null | undefined): HostBodyRT | null {
    return this.locale.sys.get(id);
  }

  private destOrbit(): { bodyId: string | null; kind: WorldOrbitKind } | null {
    return this.voyage.route.destOrbit();
  }

  /** Ease the nose onto the Lock-on insertion. Off in orbit / proximity / capture. */
  guide(dt: number): void {
    this.speedCap = null;
    if (!this.voyage.route.live) return;
    if (!this.port.region()) return;
    if (this.voyage.riding || this.port.droneLive() || this.voyage.capturing || this.voyage.departing) return;
    if (this.port.looking()) return;
    let insertBlend = 0;
    // Eye→body before insert rewrite — zenith = radial out (−eye→body).
    let zenX = 0;
    let zenY = 0;
    let zenZ = 0;
    let haveZen = false;
    if (this.port.courseBodyId() && this.locale.obj && this.voyage.route.dest?.starId === this.locale.obj.id) {
      const rt = this.worldRt(this.port.courseBodyId());
      if (!rt) return;
      this.locale.bodyFromEye(this.ship.at, rt, this.aimTmp);
      zenX = -this.aimTmp.x;
      zenY = -this.aimTmp.y;
      zenZ = -this.aimTmp.z;
      haveZen = this.aimTmp.lengthSq() > 1e-28;
      const dest = this.destOrbit();
      if (dest && dest.bodyId === rt.spec.id) {
        insertBlend = this.applyPendingInsert(rt, dest.kind, this.aimTmp);
      }
      this.corridor(this.aimTmp, rt.spec.id);
    } else if (this.port.courseObj()) {
      const course = this.port.courseObj()!;
      const p = galToCart(course.pos);
      this.aimTmp.set(
        p.x - this.ship.at.x,
        p.y - this.ship.at.y,
        p.z - this.ship.at.z,
      );
      zenX = -this.aimTmp.x;
      zenY = -this.aimTmp.y;
      zenZ = -this.aimTmp.z;
      haveZen = this.aimTmp.lengthSq() > 1e-28;
      const dest = this.destOrbit();
      if (dest && dest.bodyId == null && dest.kind === 'ecliptic') {
        insertBlend = this.applyStarInsert(course, this.aimTmp);
      }
      if (this.locale.obj && course.id === this.locale.obj.id) {
        this.corridor(this.aimTmp, null);
      }
    } else {
      return;
    }
    const dx = this.aimTmp.x;
    const dy = this.aimTmp.y;
    const dz = this.aimTmp.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-15) return;
    this.port.courseDist(d);
    this.voyage.insertBlend = insertBlend;

    // Feasible-speed law: the tightest circular arc that leaves
    // the current heading and passes through the target has
    // radius d / (2·sin(θ/2)) — d/2 for a target dead astern,
    // unbounded only when truly aligned. The nose turns at
    // SHIP_TURN_RATE, so cap v at NAV_ARC_MARGIN of the arc's
    // rate. (A plain sinθ law is blind astern — sin π = 0 — and
    // the ship circled a small park at full dive speed forever.)
    const cosT = THREE.MathUtils.clamp(
      (dx * this.ship.fwd.x + dy * this.ship.fwd.y + dz * this.ship.fwd.z) / d,
      -1,
      1,
    );
    const sinHalf = Math.sqrt(Math.max(0, (1 - cosT) / 2));
    if (sinHalf > 0.01) {
      this.speedCap =
        (UNIVERSE.NAV_ARC_MARGIN * UNIVERSE.SHIP_TURN_RATE * d) / (2 * sinHalf);
    }

    // Banking engages only inside the insert window. Far
    // lock-on is a heading hold — passing zenith here snapped
    // roll on the Set course tap and the sky jumped.
    const dest = this.destOrbit();
    const bank = haveZen && insertBlend > 1e-4;
    // Limb yaw is a ship attitude (not a second camera) — the
    // side-on ride: the near limb walks to the centre line.
    let lx = dx;
    let ly = dy;
    let lz = dz;
    if (bank && dest?.bodyId) {
      const rt = this.worldRt(dest.bodyId);
      if (rt) {
        const zlen = Math.hypot(zenX, zenY, zenZ);
        const flen = Math.hypot(dx, dy, dz);
        if (zlen > 1e-18 && flen > 1e-18) {
          const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
          const rd = orbitRadiusKpc(rt.spec, dest.kind);
          const hFov = sideFovDeg(this.camera.fov, this.camera.aspect);
          const pitch = orbitLimbPitch(R, rd, hFov, UNIVERSE.ORBIT_LIMB_FILL) * insertBlend;
          const c = Math.cos(pitch);
          const s = Math.sin(pitch);
          lx = (dx / flen) * c - (zenX / zlen) * s;
          ly = (dy / flen) * c - (zenY / zlen) * s;
          lz = (dz / flen) * c - (zenZ / zlen) * s;
        }
      }
    } else if (bank && dest && dest.bodyId == null && dest.kind === 'ecliptic' && this.port.courseObj()) {
      const courseStar = this.port.courseObj()!;
      const zlen = Math.hypot(zenX, zenY, zenZ);
      const flen = Math.hypot(dx, dy, dz);
      if (zlen > 1e-18 && flen > 1e-18) {
        const star = {
          radius: Math.max(1e-6, courseStar.star.radius) * UNIVERSE.RSUN_KM,
        };
        const rd = starOrbitRadiusKpc(star);
        this.lookSlerp.set(dx / flen, dy / flen, dz / flen);
        this.tmp2.set(zenX / zlen, zenY / zlen, zenZ / zlen);
        this.pilot.pitchLimbFwd(
          this.lookSlerp,
          this.tmp2,
          this.pilot.starLimbR(),
          rd,
          this.lookSlerp,
          insertBlend,
        );
        lx = this.lookSlerp.x;
        ly = this.lookSlerp.y;
        lz = this.lookSlerp.z;
      }
    }
    // Side-on bank: screen-up = fwd × nadir (nadir = −zenith)
    // puts the body on the LEFT as the insert eases in.
    let ux: number | null = null;
    let uy: number | null = null;
    let uz: number | null = null;
    if (bank) {
      const nx = -zenX;
      const ny = -zenY;
      const nz = -zenZ;
      ux = ly * nz - lz * ny;
      uy = lz * nx - lx * nz;
      uz = lx * ny - ly * nx;
      const ul = Math.hypot(ux, uy, uz);
      if (ul > 1e-18) {
        ux /= ul;
        uy /= ul;
        uz /= ul;
      } else {
        ux = null;
        uy = null;
        uz = null;
      }
    }
    this.fcs.steer(dt, UNIVERSE.ARRIVE_HOLD, lx, ly, lz, ux, uy, uz, false);
    this.port.applyCam();
    this.port.wake();
  }

  /**
   * Transfer corridor. Space is empty; bodies are balls; the only
   * illegal move is into one. Inside a non-target graze, the only
   * way is out. If the sightline hits a ball, take a tangent —
   * and keep the SAME side until that ball clears (hysteresis;
   * re-picking each frame oscillated near a graze ball). One peel
   * per frame — the next frame sees the next ball.
   */
  private corridor(aim: THREE.Vector3, targetId: string | null): void {
    const objs = this.nav.objects;
    if (objs.length === 0) return;
    const dT = aim.length();
    if (!(dT > 1e-18)) return;

    // Inside a non-target graze → only way is out. (The star's
    // ball counts on every course — a star dest targets the RING,
    // not the core.)
    let escD = Infinity;
    let escObj: (typeof objs)[number] | null = null;
    for (const o of objs) {
      if (o.id != null && o.id === targetId) continue;
      const dO = o.pos.length();
      if (!(dO > 1e-18) || dO >= escD) continue;
      if (dO >= o.grazeKm * KM_TO_KPC) continue;
      escD = dO;
      escObj = o;
    }
    if (escObj) {
      aim.copy(escObj.pos).multiplyScalar(-dT / Math.max(escD, 1e-18));
      this.lockBall = undefined;
      return;
    }

    // Nearest ball the desired aim would enter.
    this.tmp.copy(aim).multiplyScalar(1 / dT);
    let best: (typeof objs)[number] | null = null;
    let bestD = Infinity;
    let bestSin = 0;
    for (const o of objs) {
      if (o.id != null && o.id === targetId) continue;
      const dO = o.pos.length();
      if (!(dO > 1e-18) || dO >= dT || dO >= bestD) continue;
      const dOT = Math.hypot(aim.x - o.pos.x, aim.y - o.pos.y, aim.z - o.pos.z);
      const graze = Math.min(o.grazeKm * KM_TO_KPC, dOT * 0.9);
      if (!(graze > 0)) continue;
      const sinMin = Math.min(1, graze / dO);
      const cosMin = Math.sqrt(Math.max(0, 1 - sinMin * sinMin));
      const cosA = (aim.x * o.pos.x + aim.y * o.pos.y + aim.z * o.pos.z) / (dT * dO);
      if (cosA <= cosMin) continue;
      best = o;
      bestD = dO;
      bestSin = sinMin;
    }
    if (!best) {
      this.lockBall = undefined;
      return;
    }

    // Two tangents around the ball.
    this.tmp2.copy(best.pos).multiplyScalar(1 / bestD);
    this.tanA.crossVectors(this.tmp2, this.tmp);
    if (this.tanA.lengthSq() < 1e-24) {
      this.tanA.crossVectors(this.tmp2, this.worldUp);
      if (this.tanA.lengthSq() < 1e-24) this.tanA.set(1, 0, 0);
    }
    this.tanA.normalize();
    const ang = Math.asin(bestSin);
    const axis = this.tanA;
    this.tanB.copy(this.tmp2).applyAxisAngle(axis, -ang);
    this.tanA.copy(this.tmp2).applyAxisAngle(axis, ang);
    // Latched side: while the same ball blocks, keep the tangent
    // nearest the one we flew last frame; on a fresh ball, take
    // the one nearest the desired aim.
    const ref = this.lockBall !== undefined && this.lockBall === best.id ? this.lockDir : this.tmp;
    const pick = this.tanA.dot(ref) >= this.tanB.dot(ref) ? this.tanA : this.tanB;
    this.lockBall = best.id;
    this.lockDir.copy(pick);
    aim.copy(pick).multiplyScalar(dT);
  }

  /**
   * Soft-seek the eye and nose onto the chosen ring. When close
   * enough, beginRide latches In Orbit and Lock-on ends.
   */
  captureTick(dt: number, tSys: number): void {
    const cap = this.voyage.capturing;
    if (!cap || !this.locale.obj) return;
    if (cap.bodyId == null) {
      this.starCapture(dt, tSys, cap.dir);
      return;
    }
    const rt = this.worldRt(cap.bodyId);
    if (!rt) {
      this.voyage.capturing = null;
      return;
    }
    const r = orbitRadiusKpc(rt.spec, cap.kind);
    this.locale.spinWorld(rt, this.orbitQ);
    // Desired ring offset from the body (catalog), same law as placeRide.
    this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
    this.pilot.layoutInertialPlane(cap.kind, cap.dir);
    // Capture holds the arrival longitude (theta = 0 on E1).
    this.tmp2.copy(this.voyage.rideE1).multiplyScalar(r);
    // Desired eye = body + offset; the ring point drifts with the
    // body's own Kepler velocity (rendezvous feeds that forward).
    this.locale.bodyCatalog(rt, this.tmp);
    const cx = this.tmp.x;
    const cy = this.tmp.y;
    const cz = this.tmp.z;
    const tx = cx + this.tmp2.x;
    const ty = cy + this.tmp2.y;
    const tz = cz + this.tmp2.z;
    const drift = this.nav.body(cap.bodyId)?.vel ?? null;
    // Side-on parked look: fwd prograde yawed to the limb, up =
    // fwd × nadir (body left).
    this.pilot.limbParkFwd(rt, cap.kind, this.voyage.rideE2, this.voyage.rideE1, this.lookSlerp);
    this.latchUp
      .crossVectors(this.lookSlerp, this.tmp2.copy(this.voyage.rideE1).negate())
      .normalize();
    const posErr = this.rendezvous(
      dt,
      tx,
      ty,
      tz,
      cx,
      cy,
      cz,
      r,
      drift,
      this.lookSlerp.x,
      this.lookSlerp.y,
      this.lookSlerp.z,
      this.latchUp.x,
      this.latchUp.y,
      this.latchUp.z,
    );
    if (posErr <= this.latchSlack(r) && this.attitudeSettled()) {
      this.voyage.capturing = null;
      this.pilot.beginRide(rt, cap.kind, cap.dir, tSys);
    }
    this.port.applyCam();
    this.port.wake();
  }

  /** Capture onto the host-star ecliptic ring. */
  private starCapture(dt: number, tSys: number, dir: THREE.Vector3): void {
    if (!this.locale.obj) return;
    const r = starOrbitRadiusKpc({ radius: this.locale.starRadiusKm() });
    this.pilot.prepareStarRideBasis(dir);
    this.tmp2.copy(this.voyage.rideE1).multiplyScalar(r);
    const c = galToCart(this.locale.obj.pos);
    const tx = c.x + this.tmp2.x;
    const ty = c.y + this.tmp2.y;
    const tz = c.z + this.tmp2.z;
    // Same limb-down as a world ring: look along the upper
    // tangent so the photosphere sits in the lower half.
    this.pilot.pitchLimbFwd(this.voyage.rideE2, this.voyage.rideE1, this.pilot.starLimbR(), r, this.lookSlerp);
    this.latchUp
      .crossVectors(this.lookSlerp, this.tmp2.copy(this.voyage.rideE1).negate())
      .normalize();
    const posErr = this.rendezvous(
      dt,
      tx,
      ty,
      tz,
      c.x,
      c.y,
      c.z,
      r,
      null,
      this.lookSlerp.x,
      this.lookSlerp.y,
      this.lookSlerp.z,
      this.latchUp.x,
      this.latchUp.y,
      this.latchUp.z,
    );
    if (posErr <= this.latchSlack(r) && this.attitudeSettled()) {
      this.voyage.capturing = null;
      this.pilot.beginStarRide(dir, tSys);
    }
    this.port.applyCam();
    this.port.wake();
  }

  /**
   * The latch bolts the ride pose, so the ship must already BE
   * in it: nose on the parked look and roll settled, within
   * ORBIT_LATCH_ANG — or orbit entry ends on a sudden tilt.
   * lookSlerp / latchUp still hold this frame's parked look.
   */
  private attitudeSettled(): boolean {
    const lim = Math.cos(UNIVERSE.ORBIT_LATCH_ANG);
    return this.ship.fwd.dot(this.lookSlerp) >= lim && this.ship.up.dot(this.latchUp) >= lim;
  }

  /**
   * Latch slack: r·0.002, floored at 256 coordinate ULPs of the
   * eye — 8 kpc from the origin one ULP is ~2e-15 kpc, and the
   * exponential close stalls once its per-frame step rounds to
   * zero. Without the floor a small park (a black hole's, a
   * world ring's) can never resolve — the black-hole lesson, now
   * an invariant. Measured: the park-sphere slide stalls near
   * 74 ULP at 60 fps and ~150 at 120 fps (the per-frame step
   * halves with dt), so 256 covers the frame-rate family.
   * placeRide then pins the eye exactly; the snap is a fraction
   * of a percent of the film-floored park — invisible.
   */
  private latchSlack(r: number): number {
    const ulp = 2 ** -52 * this.ship.at.length();
    return Math.max(r * 0.002, 256 * ulp);
  }

  /**
   * Terminal rendezvous step. Close the target exponentially
   * (ORBIT_CAPTURE) with the target's own drift fed forward, as
   * a bounded, fence-checked bubble move — never a raw position
   * write. The FCS eases the parked look at the same rate.
   * Returns the position error left after the move.
   */
  private rendezvous(
    dt: number,
    tx: number,
    ty: number,
    tz: number,
    cx: number,
    cy: number,
    cz: number,
    rMin: number,
    drift: THREE.Vector3 | null,
    fwdX: number,
    fwdY: number,
    fwdZ: number,
    zenX: number,
    zenY: number,
    zenZ: number,
  ): number {
    const at = this.ship.at;
    const dx = tx - at.x;
    const dy = ty - at.y;
    const dz = tz - at.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 0) {
      const k = 1 - Math.exp(-UNIVERSE.ORBIT_CAPTURE * dt);
      // Tentative endpoint: exponential close + the target's drift.
      let nx = at.x + dx * k + (drift ? drift.x * dt : 0);
      let ny = at.y + dy * k + (drift ? drift.y * dt : 0);
      let nz = at.z + dz * k + (drift ? drift.z * dt : 0);
      // The park sphere is the deck of the terminal phase. A
      // near-pole arrival chording to an in-plane ring point
      // would dive inside the wall — slide on the sphere instead.
      const rx = nx - cx;
      const ry = ny - cy;
      const rz = nz - cz;
      const rl = Math.hypot(rx, ry, rz);
      if (rl > 0 && rl < rMin) {
        const lift = rMin / rl;
        nx = cx + rx * lift;
        ny = cy + ry * lift;
        nz = cz + rz * lift;
      }
      this.port.moveBubble(nx - at.x, ny - at.y, nz - at.z, true);
      // Keep the host root pinned to the moved eye (the same
      // repin the old capture ease did) so meshes cannot lag.
      if (this.locale.root && this.locale.obj) {
        const cart = galToCart(this.locale.obj.pos);
        this.tmp.set(at.x - cart.x, at.y - cart.y, at.z - cart.z);
        this.locale.root.position.copy(this.tmp).negate();
        this.locale.root.updateMatrixWorld(true);
      }
    }
    this.fcs.steer(dt, UNIVERSE.ORBIT_CAPTURE, fwdX, fwdY, fwdZ, zenX, zenY, zenZ, false);
    return Math.hypot(tx - at.x, ty - at.y, tz - at.z);
  }

  /**
   * Rewrite eye→body into an insertion fly-to for the pending
   * body ring. Returns the 0…1 insert blend.
   */
  private applyPendingInsert(rt: HostBodyRT, kind: WorldOrbitKind, eyeToBody: THREE.Vector3): number {
    const r = orbitRadiusKpc(rt.spec, kind);
    this.locale.spinWorld(rt, this.orbitQ);
    this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
    this.lookSlerp.copy(this.voyage.rideNorth);
    return planOrbitInsert(
      eyeToBody,
      r,
      this.lookSlerp,
      'inertial',
      UNIVERSE.ORBIT_INSERT,
      this.tmp2,
      this.voyage.rideE1,
      this.voyage.rideE2,
    );
  }

  /** Star ecliptic insertion. eyeToBody → fly-to; returns blend. */
  private applyStarInsert(obj: GalaxyObject, eyeToBody: THREE.Vector3): number {
    const star = {
      radius: Math.max(1e-6, obj.star.radius) * UNIVERSE.RSUN_KM,
    };
    const r = starOrbitRadiusKpc(star);
    if (this.locale.root && this.locale.obj?.id === obj.id) {
      this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.locale.root.quaternion);
    } else {
      this.voyage.rideNorth.copy(this.worldUp);
    }
    return planOrbitInsert(
      eyeToBody,
      r,
      this.voyage.rideNorth,
      'inertial',
      UNIVERSE.ORBIT_INSERT,
      this.tmp2,
      this.voyage.rideE1,
      this.voyage.rideE2,
    );
  }

}
