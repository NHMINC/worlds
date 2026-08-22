/**
 * Trackball drone. Own look / zoom-thrust / roll / Target /
 * launch / home. Home is fly-to-ship then a camera dock onto
 * the parked ship pose — not the ship's orbit-entry bank.
 *
 * Does not import flight.ts or course.ts. GalaxyView calls
 * launch / land only; while this is live, pointers come here.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Drone home ease (1/s). Own law — not ORBIT_CAPTURE. */
const HOME_RATE = 2.2;
const LAUNCH_RATE = 2.2;

export type DronePhase = 'launch' | 'home' | null;
type LaunchLeg = 'lift' | 'pull';

export type DroneWorld = {
  nearestFrom(eye: THREE.Vector3): { id: string | null; pos: THREE.Vector3; R: number };
  /** Core of the body the ship is orbiting (star only if that berth is the star). */
  subject(eye: THREE.Vector3): { id: string | null; pos: THREE.Vector3; R: number };
  coreOf(id: string | null, out: THREE.Vector3): number;
  /** km from core so the disk covers ARRIVE_FILL of the shorter FOV. */
  fillKm(R: number): number;
  reticleTarget(): { id: string | null } | null;
};

export class Trackball {
  readonly eye = new THREE.Vector3();
  readonly fwd = new THREE.Vector3(0, 0, 1);
  readonly up = new THREE.Vector3(0, 1, 0);
  lock = false;
  lockId: string | null = null;
  readonly rel = new THREE.Vector3();
  phase: DronePhase = null;
  private launchLeg: LaunchLeg = 'lift';
  private readonly liftEye = new THREE.Vector3();

  /** Parked ship in host-km, frozen at launch. */
  readonly parkedEye = new THREE.Vector3();
  readonly parkedFwd = new THREE.Vector3(0, 0, 1);
  readonly parkedUp = new THREE.Vector3(0, 1, 0);

  private readonly core = new THREE.Vector3();
  private readonly t0 = new THREE.Vector3();
  private readonly t1 = new THREE.Vector3();

  /**
   * Spawn from the ship's host-km eye / look. Park that pose
   * as the dock target. Launch lifts along ship-up facing
   * forward, backs away from the orbited body until the disk
   * fits the frame, then locks trackball on that core.
   */
  launch(eye: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3, world: DroneWorld): void {
    this.eye.copy(eye);
    this.fwd.copy(fwd).normalize();
    this.up.copy(up);
    this.orthonormalize();
    this.parkedEye.copy(eye);
    this.parkedFwd.copy(this.fwd);
    this.parkedUp.copy(this.up);
    this.lock = false;
    this.lockId = null;
    this.rel.set(0, 0, 0);
    this.phase = 'launch';
    this.stayOut(world);
    this.beginLaunch(world);
  }

  beginHome(): void {
    this.lock = false;
    this.phase = 'home';
    this.rel.set(-1, 0, 0);
  }

  look(dx: number, dy: number, world: DroneWorld): void {
    if (this.phase) return;
    if (this.lock) {
      const k = 0.005;
      this.t0.copy(this.up);
      this.t1.crossVectors(this.fwd, this.up);
      if (this.t1.lengthSq() < 1e-16) {
        this.t1.set(1, 0, 0).addScaledVector(this.fwd, -this.fwd.x);
        if (this.t1.lengthSq() < 1e-16) this.t1.set(0, 1, 0);
      }
      this.t1.normalize();
      const R = world.coreOf(this.lockId, this.core);
      void R;
      this.rel.applyAxisAngle(this.t0, -dx * k);
      this.t1.applyAxisAngle(this.t0, -dx * k);
      this.rel.applyAxisAngle(this.t1, -dy * k);
      this.up.applyAxisAngle(this.t1, -dy * k);
      this.eye.copy(this.core).add(this.rel);
      this.stayOut(world);
      world.coreOf(this.lockId, this.core);
      this.rel.copy(this.eye).sub(this.core);
      this.aimAtCore(world);
    } else {
      this.spinLook(dx, dy);
    }
  }

  twist(d: number): void {
    if (this.phase) return;
    if (Math.abs(d) < 1e-8) return;
    this.up.applyAxisAngle(this.fwd, d);
    this.orthonormalize();
  }

  /** Zoom is thrust along the look. */
  thrustZoom(factor: number, world: DroneWorld): void {
    if (this.phase) return;
    const f = Math.max(1e-3, factor);
    let R: number;
    if (this.lock) {
      R = world.coreOf(this.lockId, this.core);
    } else {
      const n = world.nearestFrom(this.eye);
      this.core.copy(n.pos);
      R = n.R;
    }
    const d = Math.max(this.eye.distanceTo(this.core), R);
    this.eye.addScaledVector(this.fwd, d * UNIVERSE.SOI_ZOOM * -Math.log(f));
    this.stayOut(world);
    if (this.lock) {
      world.coreOf(this.lockId, this.core);
      this.rel.copy(this.eye).sub(this.core);
    }
  }

  /** Target: off if on; else lock the pip body. Does not hop. */
  toggleLock(world: DroneWorld): void {
    if (this.phase) return;
    if (this.lock) {
      this.lock = false;
      return;
    }
    const aim = world.reticleTarget();
    if (!aim) return;
    this.captureLock(aim.id, world);
  }

  tick(dt: number, world: DroneWorld): 'live' | 'docked' {
    if (this.phase === 'launch') this.tickLaunch(dt, world);
    else if (this.phase === 'home') {
      if (this.tickHome(dt, world)) return 'docked';
    } else if (this.lock) {
      this.followLock(world);
      this.aimAtCore(world);
    }
    this.stayOut(world);
    return 'live';
  }

  applyLook(
    cam: THREE.PerspectiveCamera,
    worldFwd: THREE.Vector3,
    worldUp: THREE.Vector3,
  ): void {
    cam.position.set(0, 0, 0);
    cam.up.copy(worldUp);
    this.t0.copy(worldFwd);
    cam.lookAt(this.t0);
  }

  private beginLaunch(world: DroneWorld): void {
    const n = world.subject(this.eye);
    this.lockId = n.id;
    this.core.copy(n.pos);
    const d = Math.max(this.eye.distanceTo(this.core), n.R);
    const hover = Math.max(d - n.R, 0);
    const lift = Math.max(n.R, hover) * UNIVERSE.DRONE_LIFT;
    this.liftEye.copy(this.parkedEye).addScaledVector(this.parkedUp, lift);
    this.launchLeg = 'lift';
  }

  private beginPull(world: DroneWorld): void {
    const R = world.coreOf(this.lockId, this.core);
    this.t0.copy(this.eye).sub(this.core);
    if (this.t0.lengthSq() < 1e-12) this.t0.copy(this.parkedUp);
    if (this.t0.lengthSq() < 1e-12) this.t0.copy(this.parkedFwd).negate();
    this.t0.normalize();
    const fill = Math.max(world.fillKm(R), R * 1.002);
    this.rel.copy(this.t0).multiplyScalar(fill);
    this.launchLeg = 'pull';
  }

  private tickLaunch(dt: number, world: DroneWorld): void {
    if (this.launchLeg === 'lift') {
      const err = this.easePose(dt, LAUNCH_RATE, this.liftEye, this.parkedFwd, this.parkedUp, world);
      const slack = Math.max(this.liftEye.distanceTo(this.parkedEye) * 0.08, 1);
      if (err > slack) return;
      this.beginPull(world);
      const R = world.coreOf(this.lockId, this.core);
      if (this.eye.distanceTo(this.core) >= world.fillKm(R) * 0.97) {
        this.finishLaunch(world);
      }
      return;
    }
    const R = world.coreOf(this.lockId, this.core);
    const fill = Math.max(world.fillKm(R), R * 1.002);
    this.rel.setLength(fill);
    this.t0.copy(this.core).add(this.rel);
    const dist = this.eye.distanceTo(this.t0);
    const slack = Math.max(fill * 0.03, 1);
    if (dist > slack) {
      this.t1.copy(this.t0).sub(this.eye);
      const step = Math.min(dist, Math.max(dist * LAUNCH_RATE * dt, dist * 0.08));
      if (this.t1.lengthSq() > 1e-16) {
        this.t1.normalize();
        this.eye.addScaledVector(this.t1, step);
      }
      this.fwd.copy(this.parkedFwd);
      this.up.copy(this.parkedUp);
      this.orthonormalize();
      this.stayOut(world);
      return;
    }
    this.finishLaunch(world);
  }

  private finishLaunch(world: DroneWorld): void {
    this.phase = null;
    this.captureLock(this.lockId, world);
  }

  /**
   * Fly a line to the parked ship. Keep / ease the drone look
   * on the way. When close, blend the camera onto the frozen
   * ship pose and dock.
   */
  private tickHome(dt: number, world: DroneWorld): boolean {
    const dest = this.parkedEye;
    const dist = this.eye.distanceTo(dest);
    const dock = Math.max(2, this.parkedEye.length() * 1e-9 + 2);
    if (dist > dock * 6) {
      this.t0.copy(dest).sub(this.eye);
      const step = Math.min(dist, Math.max(dist * HOME_RATE * dt, dist * 0.08));
      if (this.t0.lengthSq() > 1e-16) {
        this.t0.normalize();
        this.eye.addScaledVector(this.t0, step);
        this.fwd.lerp(this.t0, 1 - Math.exp(-HOME_RATE * dt));
        this.orthonormalize();
      }
      this.stayOut(world);
      return false;
    }
    const err = this.easePose(dt, HOME_RATE, dest, this.parkedFwd, this.parkedUp, world);
    return err <= dock;
  }

  private easePose(
    dt: number,
    rate: number,
    eye: THREE.Vector3,
    fwd: THREE.Vector3,
    up: THREE.Vector3,
    world: DroneWorld,
  ): number {
    const k = 1 - Math.exp(-rate * dt);
    this.eye.lerp(eye, k);
    this.fwd.lerp(fwd, k);
    this.up.lerp(up, k);
    this.orthonormalize();
    this.stayOut(world);
    return this.eye.distanceTo(eye);
  }

  private captureLock(id: string | null, world: DroneWorld): void {
    this.lock = true;
    this.lockId = id;
    world.coreOf(id, this.core);
    this.rel.copy(this.eye).sub(this.core);
    this.aimAtCore(world);
  }

  private followLock(world: DroneWorld): void {
    if (!this.lock) return;
    world.coreOf(this.lockId, this.core);
    this.eye.copy(this.core).add(this.rel);
  }

  private aimAtCore(world: DroneWorld): void {
    world.coreOf(this.lockId, this.core);
    this.t0.copy(this.core).sub(this.eye);
    if (this.t0.lengthSq() < 1e-12) return;
    this.fwd.copy(this.t0).normalize();
    this.orthonormalize();
  }

  private stayOut(world: DroneWorld): void {
    const n = world.nearestFrom(this.eye);
    this.core.copy(n.pos);
    const min = n.R * 1.002;
    const d = this.eye.distanceTo(this.core);
    if (d >= min) return;
    if (d < 1e-9) {
      this.eye.copy(this.core).addScaledVector(this.fwd, -min);
      return;
    }
    this.eye.sub(this.core).multiplyScalar(min / d).add(this.core);
  }

  private spinLook(dx: number, dy: number): void {
    const k = 0.005;
    this.t0.copy(this.up);
    this.t1.crossVectors(this.fwd, this.up);
    if (this.t1.lengthSq() < 1e-16) {
      this.t1.set(1, 0, 0).addScaledVector(this.fwd, -this.fwd.x);
      if (this.t1.lengthSq() < 1e-16) this.t1.set(0, 1, 0);
    }
    this.t1.normalize();
    this.fwd.applyAxisAngle(this.t0, -dx * k);
    this.up.applyAxisAngle(this.t0, -dx * k);
    this.fwd.applyAxisAngle(this.t1, -dy * k);
    this.up.applyAxisAngle(this.t1, -dy * k);
    this.orthonormalize();
  }

  private orthonormalize(): void {
    this.fwd.normalize();
    this.up.addScaledVector(this.fwd, -this.up.dot(this.fwd));
    if (this.up.lengthSq() < 1e-16) {
      this.up.crossVectors(this.fwd, WORLD_UP);
      if (this.up.lengthSq() < 1e-16) this.up.set(0, 1, 0);
    }
    this.up.normalize();
  }
}
