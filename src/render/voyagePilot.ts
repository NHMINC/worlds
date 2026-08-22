/**
 * The voyage pilot: the geometry that flies the machine. It
 * eases the nose onto insertions, captures onto rings, places
 * the ride each tick, runs cruise (warp motion, brake gears,
 * shell parks), and the leave-orbit burn. State lives on
 * `Voyage`; the pilot only computes and steers. The conductor
 * owns the frame loop, the camera, and the HUD — they arrive
 * here as a narrow port.
 *
 * Never imports drone.ts. No Three camera writes — the ship
 * pose IS the camera when the ship is live; `port.applyCam`
 * commits it.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import { type BodySpec } from '../world/systemgen';
import { type HostBodyRT } from './hostSystem';
import { planOrbitInsert, type InsertMode } from './orbitInsert';
import { ShipFlight } from './flight';
import { Voyage } from './voyage';
import { HostLocale } from './hostLocale';
import {
  clearRadiusKm,
  coerceOrbitKind,
  fillViewRadius,
  isHangOrbit,
  isLimbOrbit,
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

/** Catalog kpc per kilometre — host meshes live in km under this scale. */
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

/** What the pilot borrows from the conductor. */
export interface PilotPort {
  region(): boolean;
  droneLive(): boolean;
  /** A finger is dragging a look — autopilot yields. */
  looking(): boolean;
  /** Set-course star / world the plate remembers (HUD memory). */
  courseObj(): GalaxyObject | null;
  courseBodyId(): string | null;
  /** Live plate distance. */
  courseDist(d: number): void;
  /** Ride latched — clear the course HUD memory. */
  arrived(): void;
  /** Bubble step (speed cap + host fences + uCenter push). */
  moveBubble(vx: number, vy: number, vz: number, force?: boolean): void;
  applyCam(): void;
  wake(n?: number): void;
  stopWarp(): void;
  breakOrbit(): void;
  /** Re-latch the SOI / world place subjects after a move. */
  updateSubjects(): void;
}

export class VoyagePilot {
  /** Frame dt (s), written by the conductor at frame start. */
  lastDt = 1 / 60;

  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly orbitTmp = new THREE.Vector3();
  private readonly orbitTmp2 = new THREE.Vector3();
  private readonly orbitQ = new THREE.Quaternion();
  private readonly lookSlerp = new THREE.Vector3();
  private readonly hostTmp = new THREE.Vector3();
  private readonly hostTmp2 = new THREE.Vector3();
  private readonly hostTmpQ = new THREE.Quaternion();

  private readonly ship: ShipFlight;
  private readonly voyage: Voyage;
  private readonly locale: HostLocale;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly port: PilotPort;

  constructor(
    ship: ShipFlight,
    voyage: Voyage,
    locale: HostLocale,
    camera: THREE.PerspectiveCamera,
    port: PilotPort,
  ) {
    this.ship = ship;
    this.voyage = voyage;
    this.locale = locale;
    this.camera = camera;
    this.port = port;
  }

  private worldRt(id: string | null | undefined): HostBodyRT | null {
    return this.locale.sys.get(id);
  }

  /** Catalog kpc from the camera to a host-pass body. */
  private bodyDist(rt: HostBodyRT): number {
    return this.locale.bodyFromEye(this.ship.at, rt, this.hostTmp).length();
  }

  private arriveDist(obj: GalaxyObject): number {
    const c = galToCart(obj.pos);
    return Math.hypot(
      c.x - this.ship.at.x,
      c.y - this.ship.at.y,
      c.z - this.ship.at.z,
    );
  }

  private destOrbit(): { bodyId: string | null; kind: WorldOrbitKind } | null {
    return this.voyage.route.destOrbit();
  }

  /** Nose along fwd, bank so zenith (away from the body) is screen-up. */
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

  /**
   * Hard fence: no move crosses a body's view skin (air /
   * gas / a thin fraction of R) or the photosphere's. The
   * film park sits outside this wall. The step lands on
   * the wall instead. If we are already inside, only steps
   * that climb out are allowed. Returns the allowed step
   * length along (dx,dy,dz)/len.
   */
  clampAdvance(dx: number, dy: number, dz: number, len: number): number {
    if (!this.locale.obj || !this.locale.root || !(len > 0)) return len;
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
    for (const rt of this.locale.sys.bodies) {
      this.locale.bodyFromEye(this.ship.at, rt, this.hostTmp2);
      fence(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, shellFloorKm(rt.spec));
    }
    this.hostTmp2.copy(this.locale.root.position);
    const starR = Math.max(1, this.locale.spec?.star.radius ?? UNIVERSE.RSUN_KM);
    fence(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, viewSkinKm(starR));
    return allowed;
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
  closeWorldShell(rt: HostBodyRT, park: number, step: number, onPark: () => void): boolean {
    this.locale.bodyFromEye(this.ship.at, rt, this.hostTmp);
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
      this.port.moveBubble(-this.hostTmp.x * k, -this.hostTmp.y * k, -this.hostTmp.z * k);
      if (go >= remain * 0.999) onPark();
      return true;
    }
    const t = this.firstShellHit(this.hostTmp, this.ship.fwd, park);
    if (t != null && t <= step) {
      this.port.moveBubble(this.ship.fwd.x * t, this.ship.fwd.y * t, this.ship.fwd.z * t);
      onPark();
      return true;
    }
    return false;
  }


  enterRide(tSys: number): void {
    const pending = this.destOrbit();
    if (!pending) return;
    if (pending.bodyId == null) {
      // Host-star ecliptic — wait until the dest sphere is the place.
      if (!this.locale.obj || this.locale.obj.id !== this.voyage.route.dest?.starId) return;
      this.voyage.pendingArriveOrbit = false;
      this.port.stopWarp();
      if (this.locale.root) {
        this.hostTmp.copy(this.locale.root.position).negate().normalize();
      } else {
        const c = galToCart(this.locale.obj.pos);
        this.hostTmp.set(
          this.ship.at.x - c.x,
          this.ship.at.y - c.y,
          this.ship.at.z - c.z,
        );
        if (this.hostTmp.lengthSq() < 1e-28) {
          this.ship.orthonormalize();
          this.hostTmp.copy(this.ship.fwd).negate();
        } else this.hostTmp.normalize();
      }
      this.voyage.capturing = {
        bodyId: null,
        kind: 'ecliptic',
        dir: this.hostTmp.clone(),
      };
      this.tickCapture(this.lastDt || 1 / 60, tSys);
      return;
    }
    const rt = this.worldRt(pending.bodyId);
    if (!rt || this.locale.obj?.id !== this.voyage.route.dest?.starId) return;
    this.voyage.pendingArriveOrbit = false;
    this.port.stopWarp();
    this.locale.bodyFromEye(this.ship.at, rt, this.orbitTmp2).negate();
    if (this.orbitTmp2.lengthSq() < 1e-28) {
      this.ship.orthonormalize();
      this.orbitTmp2.copy(this.ship.fwd).negate();
    }
    this.orbitTmp2.normalize();
    // Capture burn — ease onto the rail, then latch In Orbit.
    this.voyage.capturing = {
      bodyId: pending.bodyId,
      kind: pending.kind,
      dir: this.orbitTmp2.clone(),
    };
    this.aimLimbParkLook(rt, pending.kind, this.orbitTmp2);
    this.tickCapture(this.lastDt || 1 / 60, tSys);
  }

  /**
   * Soft-seek the eye and nose onto the chosen ring. When close
   * enough, beginRide latches In Orbit and Lock-on ends.
   */
  tickCapture(dt: number, tSys: number): void {
    const cap = this.voyage.capturing;
    if (!cap || !this.locale.obj) return;
    if (cap.bodyId == null) {
      this.tickStarCapture(dt, tSys, cap.dir);
      return;
    }
    const rt = this.worldRt(cap.bodyId);
    if (!rt) {
      this.voyage.capturing = null;
      return;
    }
    const r = orbitRadiusKpc(rt.spec, cap.kind);
    const hang = isHangOrbit(cap.kind);
    this.locale.spinWorld(rt, this.orbitQ);
    // Desired ring offset from the body (catalog), same law as placeRide.
    if (hang) {
      this.voyage.rideLocal.copy(cap.dir).applyQuaternion(this.orbitQ.clone().conjugate());
      this.orbitTmp2.copy(this.voyage.rideLocal).applyQuaternion(this.orbitQ).multiplyScalar(r);
    } else {
      this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
      this.layoutInertialPlane(cap.kind, cap.dir);
      // Capture holds the arrival longitude (theta = 0 on E1).
      this.orbitTmp2.copy(this.voyage.rideE1).multiplyScalar(r);
    }
    // Desired eye = body + offset.
    this.locale.bodyCatalog(rt, this.orbitTmp);
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
      this.limbParkFwd(rt, cap.kind, this.voyage.rideE2, this.voyage.rideE1, this.lookSlerp);
      this.easeCapturePose(
        dt,
        tx,
        ty,
        tz,
        this.lookSlerp.x,
        this.lookSlerp.y,
        this.lookSlerp.z,
        this.voyage.rideE1.x,
        this.voyage.rideE1.y,
        this.voyage.rideE1.z,
      );
    }
    const posErr = Math.hypot(tx - this.ship.at.x, ty - this.ship.at.y, tz - this.ship.at.z);
    const slack = Math.max(r * 0.002, 1e-18);
    if (posErr <= slack) {
      this.voyage.capturing = null;
      this.beginRide(rt, cap.kind, cap.dir, tSys);
    }
    this.port.applyCam();
    this.port.wake();
  }

  /** Capture onto the host-star ecliptic ring. */
  private tickStarCapture(dt: number, tSys: number, dir: THREE.Vector3): void {
    if (!this.locale.obj) return;
    const star = this.locale.spec?.star ?? {
      radius: Math.max(1, this.locale.obj.star.radius) * UNIVERSE.RSUN_KM,
      mass: Math.max(0.08, this.locale.obj.star.mass),
    };
    const r = starOrbitRadiusKpc(star);
    this.prepareStarRideBasis(dir);
    this.orbitTmp2.copy(this.voyage.rideE1).multiplyScalar(r);
    const c = galToCart(this.locale.obj.pos);
    const tx = c.x + this.orbitTmp2.x;
    const ty = c.y + this.orbitTmp2.y;
    const tz = c.z + this.orbitTmp2.z;
    // Same limb-down as a world ring: look along the upper
    // tangent so the photosphere sits in the lower half.
    this.pitchLimbFwd(this.voyage.rideE2, this.voyage.rideE1, this.starLimbR(), r, this.lookSlerp);
    this.easeCapturePose(
      dt,
      tx,
      ty,
      tz,
      this.lookSlerp.x,
      this.lookSlerp.y,
      this.lookSlerp.z,
      this.voyage.rideE1.x,
      this.voyage.rideE1.y,
      this.voyage.rideE1.z,
    );
    const posErr = Math.hypot(tx - this.ship.at.x, ty - this.ship.at.y, tz - this.ship.at.z);
    const slack = Math.max(r * 0.002, 1e-18);
    if (posErr <= slack) {
      this.voyage.capturing = null;
      this.beginStarRide(dir, tSys);
    }
    this.port.applyCam();
    this.port.wake();
  }

  /**
   * Inertial ring basis. Polar: plane contains the spin axis.
   * Equatorial (and the same geometry for a world arrival):
   * arrival projected into the equator.
   */
  private layoutInertialPlane(kind: WorldOrbitKind, arrival: THREE.Vector3): void {
    this.voyage.rideE1.copy(arrival);
    if (this.voyage.rideE1.lengthSq() < 1e-16) this.voyage.rideE1.copy(this.ship.fwd).negate();
    this.voyage.rideE1.normalize();
    if (coerceOrbitKind(kind) === 'polar') {
      this.voyage.rideE2.copy(this.voyage.rideNorth).addScaledVector(this.voyage.rideE1, -this.voyage.rideNorth.dot(this.voyage.rideE1));
    } else {
      this.voyage.rideE1.addScaledVector(this.voyage.rideNorth, -this.voyage.rideE1.dot(this.voyage.rideNorth));
      if (this.voyage.rideE1.lengthSq() < 1e-16) {
        this.voyage.rideE1.crossVectors(this.voyage.rideNorth, this.ship.fwd);
        if (this.voyage.rideE1.lengthSq() < 1e-16) this.voyage.rideE1.crossVectors(this.voyage.rideNorth, this.worldUp);
      }
      this.voyage.rideE1.normalize();
      this.voyage.rideE2.crossVectors(this.voyage.rideNorth, this.voyage.rideE1);
    }
    if (this.voyage.rideE2.lengthSq() < 1e-16) {
      this.voyage.rideE2.crossVectors(this.voyage.rideE1, this.ship.right);
      if (this.voyage.rideE2.lengthSq() < 1e-16) this.voyage.rideE2.crossVectors(this.voyage.rideE1, this.worldUp);
    }
    this.voyage.rideE2.normalize();
  }

  /** Ecliptic plane basis: pole from host frame, arrival projected in-plane. */
  private prepareStarRideBasis(dirCatalog: THREE.Vector3): void {
    if (this.locale.root) {
      this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.locale.root.quaternion);
    } else {
      this.voyage.rideNorth.copy(this.worldUp);
    }
    this.voyage.rideE1.copy(dirCatalog);
    if (this.voyage.rideE1.lengthSq() < 1e-16) {
      this.ship.orthonormalize();
      this.voyage.rideE1.copy(this.ship.fwd).negate();
    }
    this.voyage.rideE1.normalize();
    this.voyage.rideE1.addScaledVector(this.voyage.rideNorth, -this.voyage.rideE1.dot(this.voyage.rideNorth));
    if (this.voyage.rideE1.lengthSq() < 1e-16) {
      this.voyage.rideE1.crossVectors(this.voyage.rideNorth, this.ship.right);
      if (this.voyage.rideE1.lengthSq() < 1e-16) this.voyage.rideE1.crossVectors(this.voyage.rideNorth, this.worldUp);
    }
    this.voyage.rideE1.normalize();
    this.voyage.rideE2.crossVectors(this.voyage.rideNorth, this.voyage.rideE1);
    if (this.voyage.rideE2.lengthSq() < 1e-16) this.voyage.rideE2.crossVectors(this.voyage.rideE1, this.worldUp);
    this.voyage.rideE2.normalize();
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
    if (this.locale.root && this.locale.obj) {
      const cart = galToCart(this.locale.obj.pos);
      this.orbitTmp.set(
        this.ship.at.x - cart.x,
        this.ship.at.y - cart.y,
        this.ship.at.z - cart.z,
      );
      this.locale.root.position.copy(this.orbitTmp).negate();
      this.locale.root.updateMatrixWorld(true);
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
  beginRide(rt: HostBodyRT, kind: WorldOrbitKind, dirCatalog: THREE.Vector3, tSys: number): void {
    const r = orbitRadiusKpc(rt.spec, kind);
    const hang = isHangOrbit(kind);
    this.locale.spinWorld(rt, this.orbitQ);
    const omega = hang ? 0 : orbitOmega(rt.spec, kind);
    let theta0 = 0;
    if (hang) {
      this.voyage.rideLocal.copy(dirCatalog).applyQuaternion(this.orbitQ.clone().conjugate());
    } else {
      // Height is the named ring. The plane contains the arrival
      // so we do not seek an equator / far-side start.
      this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
      this.layoutInertialPlane(kind, dirCatalog);
      theta0 = -omega * tSys;
    }
    // Lock-on ends. In Orbit: helm look stays locked to the ring.
    this.voyage.arriveRide({ bodyId: rt.spec.id, kind, hang, r, theta0, omega });
    this.placeRide(tSys);
    this.port.arrived();
  }

  /**
   * Latch the host-star ecliptic ring. dirCatalog is star → camera
   * at first contact (projected into the ecliptic). Kepler ω from
   * GM☉ · mass at the limb-film radius.
   */
  beginStarRide(dirCatalog: THREE.Vector3, tSys: number): void {
    if (!this.locale.obj) return;
    const star = this.locale.spec?.star ?? {
      radius: Math.max(1e-6, this.locale.obj.star.radius) * UNIVERSE.RSUN_KM,
      mass: Math.max(0.08, this.locale.obj.star.mass),
    };
    const r = starOrbitRadiusKpc(star);
    const omega = starOrbitOmega(star, r);
    this.prepareStarRideBasis(dirCatalog);
    this.voyage.arriveRide({
      bodyId: null,
      kind: 'ecliptic',
      hang: false,
      r,
      theta0: -omega * tSys,
      omega,
    });
    this.placeRide(tSys);
    this.port.arrived();
  }

  placeRide(tSys: number): void {
    const ride = this.voyage.riding;
    if (!ride || !this.locale.obj) {
      this.voyage.clearRide();
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
      ox = (this.voyage.rideE1.x * c + this.voyage.rideE2.x * s) * ride.r;
      oy = (this.voyage.rideE1.y * c + this.voyage.rideE2.y * s) * ride.r;
      oz = (this.voyage.rideE1.z * c + this.voyage.rideE2.z * s) * ride.r;
      if (this.locale.root) {
        this.orbitTmp2
          .set(ox, oy, oz)
          .applyQuaternion(this.hostTmpQ.copy(this.locale.root.quaternion).conjugate())
          .multiplyScalar(1 / KM_TO_KPC);
        this.locale.pinEyeKm(this.orbitTmp2, this.ship.at);
      } else {
        const cart = galToCart(this.locale.obj.pos);
        this.ship.at.set(cart.x + ox, cart.y + oy, cart.z + oz);
      }
      this.bankRideLook(tSys);
      return;
    }
    const rt = this.worldRt(ride.bodyId);
    if (!rt) {
      this.voyage.clearRide();
      return;
    }
    if (ride.hang) {
      this.locale.spinWorld(rt, this.orbitQ);
      this.orbitTmp2.copy(this.voyage.rideLocal).applyQuaternion(this.orbitQ);
      ox = this.orbitTmp2.x * ride.r;
      oy = this.orbitTmp2.y * ride.r;
      oz = this.orbitTmp2.z * ride.r;
    } else {
      const th = ride.theta0 + ride.omega * tSys;
      const c = Math.cos(th);
      const s = Math.sin(th);
      ox = (this.voyage.rideE1.x * c + this.voyage.rideE2.x * s) * ride.r;
      oy = (this.voyage.rideE1.y * c + this.voyage.rideE2.y * s) * ride.r;
      oz = (this.voyage.rideE1.z * c + this.voyage.rideE2.z * s) * ride.r;
    }
    if (this.locale.root) {
      // Pin the ride eye in the host km frame (the landed / drone
      // law): body centre + ring offset. Building arcCenter out of
      // the 8 kpc point instead quantizes the park by a ULP.
      this.orbitTmp2
        .set(ox, oy, oz)
        .applyQuaternion(this.hostTmpQ.copy(this.locale.root.quaternion).conjugate())
        .multiplyScalar(1 / KM_TO_KPC)
        .add(rt.pos);
      this.locale.pinEyeKm(this.orbitTmp2, this.ship.at);
    } else {
      this.locale.bodyCatalog(rt, this.orbitTmp);
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
    const ride = this.voyage.riding;
    if (!ride || this.port.droneLive()) return;
    if (ride.hang) {
      // GEO / hover: face the hang face — full sphere ahead.
      const rt = this.worldRt(ride.bodyId);
      if (!rt) return;
      this.locale.spinWorld(rt, this.orbitQ);
      this.orbitTmp2.copy(this.voyage.rideLocal).applyQuaternion(this.orbitQ);
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
    let zx = this.voyage.rideE1.x * c + this.voyage.rideE2.x * s;
    let zy = this.voyage.rideE1.y * c + this.voyage.rideE2.y * s;
    let zz = this.voyage.rideE1.z * c + this.voyage.rideE2.z * s;
    const zlen = Math.hypot(zx, zy, zz);
    if (zlen < 1e-18) return;
    zx /= zlen;
    zy /= zlen;
    zz /= zlen;
    let fx = -this.voyage.rideE1.x * s + this.voyage.rideE2.x * c;
    let fy = -this.voyage.rideE1.y * s + this.voyage.rideE2.y * c;
    let fz = -this.voyage.rideE1.z * s + this.voyage.rideE2.z * c;
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
      this.locale.spec?.star.radius ??
      Math.max(1e-6, this.locale.obj?.star.radius ?? 1) * UNIVERSE.RSUN_KM;
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
    this.locale.spinWorld(rt, this.orbitQ);
    this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
    this.voyage.rideE1.copy(zenith);
    if (this.voyage.rideE1.lengthSq() < 1e-16) return;
    this.voyage.rideE1.normalize();
    this.voyage.rideE2.crossVectors(this.voyage.rideNorth, this.voyage.rideE1);
    if (this.voyage.rideE2.lengthSq() < 1e-16) {
      this.ship.orthonormalize();
      this.voyage.rideE2.crossVectors(this.ship.right, this.voyage.rideE1);
    }
    if (this.voyage.rideE2.lengthSq() < 1e-16) return;
    this.voyage.rideE2.normalize();
    this.limbParkFwd(rt, kind, this.voyage.rideE2, this.voyage.rideE1, this.lookSlerp);
    this.aimOrbitBank(
      this.lookSlerp.x,
      this.lookSlerp.y,
      this.lookSlerp.z,
      this.voyage.rideE1.x,
      this.voyage.rideE1.y,
      this.voyage.rideE1.z,
    );
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
    if (!this.locale.obj || !this.locale.root) return;
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
    for (const rt of this.locale.sys.bodies) {
      if (rt.spec.id === targetId) continue;
      this.locale.bodyFromEye(this.ship.at, rt, this.hostTmp2);
      noteEscape(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, rt.spec.radius);
    }
    if (targetId != null) {
      this.hostTmp2.copy(this.locale.root.position);
      noteEscape(
        this.hostTmp2.x,
        this.hostTmp2.y,
        this.hostTmp2.z,
        this.locale.spec?.star.radius ?? UNIVERSE.RSUN_KM,
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
    for (const rt of this.locale.sys.bodies) {
      if (rt.spec.id === targetId) continue;
      this.locale.bodyFromEye(this.ship.at, rt, this.hostTmp2);
      consider(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, rt.spec.radius);
    }
    if (targetId != null) {
      this.hostTmp2.copy(this.locale.root.position);
      consider(
        this.hostTmp2.x,
        this.hostTmp2.y,
        this.hostTmp2.z,
        this.locale.spec?.star.radius ?? UNIVERSE.RSUN_KM,
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
    this.voyage.rideE1.copy(this.hostTmp2).applyAxisAngle(this.orbitTmp2, ang);
    this.voyage.rideE2.copy(this.hostTmp2).applyAxisAngle(this.orbitTmp2, -ang);
    const pick = this.voyage.rideE1.dot(this.hostTmp) >= this.voyage.rideE2.dot(this.hostTmp) ? this.voyage.rideE1 : this.voyage.rideE2;
    aim.copy(pick).multiplyScalar(dT);
  }

  /** Ease the nose onto the Lock-on insertion. Off in orbit / proximity / capture. */
  holdCourse(dt: number): void {
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
      this.locale.bodyFromEye(this.ship.at, rt, this.orbitTmp);
      zenX = -this.orbitTmp.x;
      zenY = -this.orbitTmp.y;
      zenZ = -this.orbitTmp.z;
      haveZen = this.orbitTmp.lengthSq() > 1e-28;
      const dest = this.destOrbit();
      if (dest && dest.bodyId === rt.spec.id) {
        insertBlend = this.applyPendingInsert(rt, dest.kind, this.orbitTmp);
      }
      this.routeAim(this.orbitTmp, rt.spec.id);
    } else if (this.port.courseObj()) {
      const course = this.port.courseObj()!;
      const p = galToCart(course.pos);
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
        insertBlend = this.applyStarInsert(course, this.orbitTmp);
      }
      if (this.locale.obj && course.id === this.locale.obj.id) {
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
    this.port.courseDist(d);
    this.voyage.insertBlend = insertBlend;
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
    this.port.applyCam();
    this.port.wake();
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
    this.locale.spinWorld(rt, this.orbitQ);
    this.voyage.rideNorth.set(0, 0, 1).applyQuaternion(this.orbitQ);
    if (coerceOrbitKind(kind) === 'polar') {
      this.lookSlerp.crossVectors(this.voyage.rideNorth, eyeToBody);
      if (this.lookSlerp.lengthSq() < 1e-24) {
        this.lookSlerp.crossVectors(this.voyage.rideNorth, this.ship.fwd);
        if (this.lookSlerp.lengthSq() < 1e-24) this.lookSlerp.set(1, 0, 0);
      }
      this.lookSlerp.normalize();
    } else {
      this.lookSlerp.copy(this.voyage.rideNorth);
    }
    return planOrbitInsert(
      eyeToBody,
      r,
      this.lookSlerp,
      mode,
      UNIVERSE.ORBIT_INSERT,
      this.orbitTmp2,
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
      this.orbitTmp2,
      this.voyage.rideE1,
      this.voyage.rideE2,
    );
  }

  private insertModeOf(kind: WorldOrbitKind): InsertMode {
    return isHangOrbit(kind) ? 'hover' : 'inertial';
  }


  private bubbleR(): number {
    return Math.hypot(this.ship.at.x, this.ship.at.y, this.ship.at.z);
  }

  /** Signed look axis for this gear: +1 ahead, −1 astern. */
  private thrustSign(): number {
    return this.voyage.astern ? -1 : 1;
  }

  /** Warp may run inside the fence, or past it only while the gear points inward. */
  warpMayRun(): boolean {
    const r = this.bubbleR();
    const lim = UNIVERSE.GALAXY_WARP_LIM;
    if (r < lim) return true;
    this.ship.orthonormalize();
    if (r < 1e-6) return true;
    return this.ship.fwd.dot(this.ship.at) * this.thrustSign() < 0;
  }


  /**
   * Yaw right 90°. The body we were looking at sits to port
   * so we can see it, and Ahead is tangent — not into the ball.
   * Warp can run; the shell fence still stops a later dive.
   */
  aimDepartStarboard(): void {
    this.ship.orthonormalize();
    this.ship.fwd.copy(this.ship.right);
    this.ship.orthonormalize();
  }

  /** √2 ω r, floored by ARRIVE_K × the place fence, capped by sphere warp. */
  departEscapeSpeed(): number {
    let omega = 0;
    let r = 0;
    let fence = UNIVERSE.ARRIVE_RANGE_KPC;
    if (this.voyage.riding) {
      omega = this.voyage.riding.omega;
      r = this.voyage.riding.r;
      fence = this.voyage.riding.bodyId != null ? UNIVERSE.WORLD_RANGE_KPC : UNIVERSE.ARRIVE_RANGE_KPC;
    } else if (this.voyage.capturing) {
      if (this.voyage.capturing.bodyId == null) {
        const obj = this.locale.obj;
        if (obj) {
          r = this.arriveDist(obj);
          const star = this.locale.spec?.star ?? {
            mass: Math.max(0.08, obj.star.mass),
          };
          omega = starOrbitOmega(star, r);
        }
        fence = UNIVERSE.ARRIVE_RANGE_KPC;
      } else {
        const rt = this.worldRt(this.voyage.capturing.bodyId);
        if (rt) {
          r = this.bodyDist(rt);
          omega = orbitOmega(rt.spec, this.voyage.capturing.kind);
        }
        fence = UNIVERSE.WORLD_RANGE_KPC;
      }
    }
    const kepler = escapeSpeedKpcS(omega, r);
    const floor = UNIVERSE.ARRIVE_K * Math.max(fence, r);
    const cap = UNIVERSE.GALAXY_WARP * UNIVERSE.ARRIVE_WARP;
    return Math.min(cap, Math.max(kepler, floor));
  }

  tickDepart(dt: number): void {
    const d = this.voyage.departing;
    if (!d) return;
    const k = 1 - Math.exp(-UNIVERSE.ORBIT_CAPTURE * dt);
    d.v += (d.vEsc - d.v) * k;
    this.ship.fwd.copy(d.dir);
    this.ship.orthonormalize();
    this.port.moveBubble(d.dir.x * d.v * dt, d.dir.y * d.v * dt, d.dir.z * d.v * dt, true);
    this.port.applyCam();
    if (d.vEsc - d.v <= d.vEsc * 0.03 + 1e-18) this.voyage.finishDepart();
  }


  /** Speed inside the host sphere: min(ARRIVE_WARP × warp, ARRIVE_K · d). */
  private sphereSpeed(d: number): number {
    return Math.min(
      UNIVERSE.GALAXY_WARP * UNIVERSE.ARRIVE_WARP,
      UNIVERSE.ARRIVE_K * Math.max(d, 1e-16),
    );
  }

  /** Course or host we are closing on / backing from. */
  private closeSubject(): GalaxyObject | null {
    return this.locale.obj ?? this.port.courseObj();
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
    return this.worldRt(this.destOrbit()?.bodyId ?? this.port.courseBodyId());
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
    if (this.voyage.astern) return warp;
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
    const k = this.voyage.astern ? kFar : kSlot + (kFar - kSlot) * a;
    let v = Math.min(vCeil, k * remain);
    const slack = Math.max(d - slot, 0);
    const vLim = Math.min(vCeil, UNIVERSE.ARRIVE_K * slot);
    if (slack <= 0) return vLim;
    const frame = Math.min(0.05, Math.max(dt, 1 / 120));
    while (v > vLim && v * frame >= slack) v *= 0.5;
    return Math.max(vLim, Math.min(vCeil, v));
  }

  moveCap(dt = this.lastDt): number | null {
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

  parkBodyKpc(b: BodySpec): number {
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
  cruise(dt: number): void {
    if (!this.port.region()) {
      this.voyage.thrustOn = false;
      this.voyage.thrustSpeed = 0;
      return;
    }
    if (this.port.droneLive()) {
      this.voyage.thrustOn = false;
      this.voyage.thrustSpeed = 0;
      this.voyage.clearDepart();
      return;
    }
    if (this.voyage.departing) {
      this.tickDepart(dt);
      this.port.updateSubjects();
      this.port.updateSubjects();
      return;
    }
    if (!this.voyage.thrustOn && this.voyage.coast.lengthSq() > 0) {
      this.port.moveBubble(this.voyage.coast.x * dt, this.voyage.coast.y * dt, this.voyage.coast.z * dt, true);
      this.port.applyCam();
      this.port.updateSubjects();
      this.port.updateSubjects();
      return;
    }
    if (this.voyage.riding) {
      if (this.voyage.thrustOn) this.port.breakOrbit();
      else return;
    }
    if (this.voyage.capturing) {
      // Capture owns the stick — cruise waits.
      this.voyage.thrustOn = false;
      this.voyage.thrustSpeed = 0;
      return;
    }
    if (this.voyage.thrustOn && !this.warpMayRun()) this.voyage.thrustOn = false;
    this.ship.orthonormalize();
    this.port.updateSubjects();
    this.port.updateSubjects();
    const sign = this.thrustSign();
    const course = this.port.courseObj();
    const dest = this.destOrbit();
    const world =
      dest?.bodyId != null
        ? this.worldRt(dest.bodyId)
        : this.port.courseBodyId()
          ? this.worldRt(this.port.courseBodyId())
          : null;
    const orbitPark =
      world && dest && dest.bodyId === world.spec.id
        ? orbitRadiusKpc(world.spec, dest.kind)
        : null;
    const cap = this.moveCap(dt);
    const v = cap ?? UNIVERSE.GALAXY_WARP;
    this.voyage.thrustSpeed = this.voyage.thrustOn ? v : 0;
    if (this.voyage.thrustSpeed <= 0) return;
    let step = this.voyage.thrustSpeed * dt;
    if (world && orbitPark != null && !this.voyage.astern) {
      if (
        this.closeWorldShell(world, orbitPark, step, () => {
          this.voyage.pendingArriveOrbit = true;
          this.port.stopWarp();
        })
      ) {
        return;
      }
    } else if (course && dest && dest.bodyId == null && !this.voyage.astern) {
      const d = this.arriveDist(course);
      const star = {
        radius: Math.max(1e-6, course.star.radius) * UNIVERSE.RSUN_KM,
        mass: Math.max(0.08, course.star.mass),
      };
      const park =
        dest.kind === 'ecliptic' ? starOrbitRadiusKpc(star) : this.parkKpc(course);
      if (d <= park) {
        if (dest.kind === 'ecliptic') this.voyage.pendingArriveOrbit = true;
        this.port.stopWarp();
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
        this.port.moveBubble(
          (c.x - this.ship.at.x) * inv * remain,
          (c.y - this.ship.at.y) * inv * remain,
          (c.z - this.ship.at.z) * inv * remain,
        );
        if (dest.kind === 'ecliptic') this.voyage.pendingArriveOrbit = true;
        this.port.stopWarp();
        return;
      }
    }
    // Ahead only: a full-rate frame is larger than the brake.
    // Land just inside so the next frame is on the curve.
    // Astern does not land on a shell — jumping the fence
    // on the way out is fine.
    if (!this.voyage.astern && !world) {
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
    this.port.moveBubble(this.ship.fwd.x * sign * step, this.ship.fwd.y * sign * step, this.ship.fwd.z * sign * step);
  }

}
