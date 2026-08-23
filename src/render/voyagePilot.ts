/**
 * The orbit pilot: the ring geometry that flies the machine —
 * insertions, captures, ride placement, the limb film looks,
 * and the autopilot heading hold. State lives on `Voyage`; the
 * pilot only computes and steers. Cruise gears, speed caps,
 * parks and fences are `voyageApproach.ts` (same port). The
 * conductor owns the frame loop, the camera, and the HUD.
 *
 * Never imports drone.ts. No Three camera writes — the ship
 * pose IS the camera when the ship is live; `port.applyCam`
 * commits it.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import { type HostBodyRT } from './hostSystem';
import { ShipFlight } from './flight';
import { Voyage } from './voyage';
import { HostLocale } from './hostLocale';
import {
  coerceOrbitKind,
  isHangOrbit,
  isLimbOrbit,
  orbitLimbPitch,
  orbitOmega,
  orbitRadiusKpc,
  starFilmRKm,
  starOrbitOmega,
  starOrbitRadiusKpc,
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
  /** Navigator's feasible-arc speed cap (kpc/s), null = free. */
  arcCap(): number | null;
}

export class VoyagePilot {
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly orbitTmp = new THREE.Vector3();
  private readonly orbitTmp2 = new THREE.Vector3();
  private readonly orbitQ = new THREE.Quaternion();
  private readonly lookSlerp = new THREE.Vector3();
  private readonly hostTmp = new THREE.Vector3();
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

  enterRide(): void {
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
  }

  /**
   * Inertial ring basis. Polar: plane contains the spin axis.
   * Equatorial (and the same geometry for a world arrival):
   * arrival projected into the equator.
   */
  layoutInertialPlane(kind: WorldOrbitKind, arrival: THREE.Vector3): void {
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
  prepareStarRideBasis(dirCatalog: THREE.Vector3): void {
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

  /** Star film radius in catalog kpc — ecliptic limb uses this as
   *  R, floored like every star film so a remnant's pitch matches
   *  the ring the film actually parked on. */
  starLimbR(): number {
    return starFilmRKm(this.locale.starRadiusKm()) * KM_TO_KPC;
  }

  /**
   * Prograde pitched toward the body (−zenith) so the forward
   * limb fills ORBIT_LIMB_FILL. Same law for a world or the star.
   */
  pitchLimbFwd(
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
  limbParkFwd(
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

}
