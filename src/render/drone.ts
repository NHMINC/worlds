/**
 * Trackball drone. Own look / zoom-thrust / roll / Target /
 * home. Launch and return are INSTANT camera switches (the
 * conductor blinks a cut): on launch the drone is already at
 * the hover film — the whole body in frame with edge padding —
 * locked on the ship's orbit subject; on return the ship camera
 * simply takes over. No lift / pull / home flight: translation
 * is kinematic by decree, so there is no momentum to animate.
 *
 * Does not import flight.ts or course.ts. GalaxyView calls
 * launch only; while this is live, pointers come here.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import type { SessionDrone, SessionVec } from '../world/types';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export type DroneWorld = {
  nearestFrom(eye: THREE.Vector3): { id: string | null; pos: THREE.Vector3; R: number };
  /** Core of the body the ship is orbiting (star only if that berth is the star). */
  subject(eye: THREE.Vector3): { id: string | null; pos: THREE.Vector3; R: number };
  coreOf(id: string | null, out: THREE.Vector3): number;
  /** km from core: the FULL disk with edge padding (HOVER_FILL of the shorter live FOV). */
  fillKm(R: number): number;
  /** Pip content from the DRONE's pose (host-root km). */
  reticleTarget(eye: THREE.Vector3, fwd: THREE.Vector3): { id: string | null } | null;
};

export class Trackball {
  readonly eye = new THREE.Vector3();
  readonly fwd = new THREE.Vector3(0, 0, 1);
  readonly up = new THREE.Vector3(0, 1, 0);
  lock = false;
  lockId: string | null = null;
  readonly rel = new THREE.Vector3();

  /** Parked ship in host-km, frozen at launch. */
  readonly parkedEye = new THREE.Vector3();
  readonly parkedFwd = new THREE.Vector3(0, 0, 1);
  readonly parkedUp = new THREE.Vector3(0, 1, 0);

  private readonly core = new THREE.Vector3();
  private readonly t0 = new THREE.Vector3();
  private readonly t1 = new THREE.Vector3();

  /**
   * Instant launch: park the ship pose as the dock target, then
   * appear at the hover film on the ship's own radial — the
   * whole body in frame with padding — locked on the ship's
   * orbit subject, looking at it.
   */
  launch(eye: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3, world: DroneWorld): void {
    this.eye.copy(eye);
    this.fwd.copy(fwd).normalize();
    this.up.copy(up);
    this.orthonormalize();
    this.parkedEye.copy(eye);
    this.parkedFwd.copy(this.fwd);
    this.parkedUp.copy(this.up);
    const n = world.subject(this.eye);
    this.lockId = n.id;
    this.core.copy(n.pos);
    this.t0.copy(this.eye).sub(this.core);
    if (this.t0.lengthSq() < 1e-12) this.t0.copy(this.parkedUp);
    if (this.t0.lengthSq() < 1e-12) this.t0.copy(this.parkedFwd).negate();
    this.t0.normalize();
    const fill = Math.max(world.fillKm(n.R), n.R * 1.002);
    this.eye.copy(this.core).addScaledVector(this.t0, fill);
    this.captureLock(this.lockId, world);
    this.stayOut(world);
  }

  look(dx: number, dy: number, world: DroneWorld): void {
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
    if (Math.abs(d) < 1e-8) return;
    this.up.applyAxisAngle(this.fwd, d);
    this.orthonormalize();
  }

  /** Zoom is thrust along the look. */
  thrustZoom(factor: number, world: DroneWorld): void {
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
    if (this.lock) {
      this.lock = false;
      return;
    }
    const aim = world.reticleTarget(this.eye, this.fwd);
    if (!aim) return;
    this.captureLock(aim.id, world);
  }

  tick(world: DroneWorld): void {
    if (this.lock) {
      this.followLock(world);
      this.aimAtCore(world);
    }
    this.stayOut(world);
  }

  snap(rideT: number): SessionDrone {
    const v = (p: THREE.Vector3): SessionVec => [p.x, p.y, p.z];
    return {
      eye: v(this.eye),
      fwd: v(this.fwd),
      up: v(this.up),
      lock: this.lock,
      lockId: this.lockId,
      rel: v(this.rel),
      // Phases are retired: launch and return are instant cuts.
      // The fields stay so old files keep loading.
      phase: null,
      launchLeg: 'lift',
      liftEye: v(this.eye),
      parkedEye: v(this.parkedEye),
      parkedFwd: v(this.parkedFwd),
      parkedUp: v(this.parkedUp),
      rideT,
    };
  }

  restore(s: SessionDrone): void {
    this.eye.set(s.eye[0], s.eye[1], s.eye[2]);
    this.fwd.set(s.fwd[0], s.fwd[1], s.fwd[2]);
    this.up.set(s.up[0], s.up[1], s.up[2]);
    this.lock = s.lock;
    this.lockId = s.lockId;
    this.rel.set(s.rel[0], s.rel[1], s.rel[2]);
    this.parkedEye.set(s.parkedEye[0], s.parkedEye[1], s.parkedEye[2]);
    this.parkedFwd.set(s.parkedFwd[0], s.parkedFwd[1], s.parkedFwd[2]);
    this.parkedUp.set(s.parkedUp[0], s.parkedUp[1], s.parkedUp[2]);
    this.orthonormalize();
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
    let R: number;
    if (this.lock) {
      R = world.coreOf(this.lockId, this.core);
    } else {
      const n = world.nearestFrom(this.eye);
      this.core.copy(n.pos);
      R = n.R;
    }
    const min = R * 1.002;
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
