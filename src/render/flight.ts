/**
 * Ship only. Catalog-kpc basis pose + the ship stick
 * (yaw around current up, pitch around fwd × up, twist
 * around the nose). Camera is this pose when the ship
 * is live. Euler exists for Face-on / Back / save — not
 * the hot path.
 *
 * Does not import drone.ts. Course intents land here as
 * look / bank; GalaxyView owns place (SOI, rings).
 */
import * as THREE from 'three';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class ShipFlight {
  readonly at = new THREE.Vector3();
  readonly fwd = new THREE.Vector3(0, 0, -1);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly right = new THREE.Vector3(1, 0, 0);

  private readonly t0 = new THREE.Vector3();
  private readonly t1 = new THREE.Vector3();

  /** Yaw around current up, pitch around fwd × up. */
  look(dx: number, dy: number): void {
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

  /** Roll around the nose. Clockwise / right is negative d. */
  twist(d: number): void {
    if (Math.abs(d) < 1e-8) return;
    this.up.applyAxisAngle(this.fwd, d);
    this.orthonormalize();
  }

  lookAt(x: number, y: number, z: number): void {
    const len = Math.hypot(x, y, z);
    if (!(len > 1e-18)) return;
    this.fwd.set(x / len, y / len, z / len);
    this.orthonormalize();
  }

  /**
   * Nose along `fwd`, bank so `zenith` is screen-up.
   * +twist rotates up toward right (fwd × up). The bank
   * angle is atan2(desired·right, desired·up) — a minus
   * here runs away: each frame lookAt keeps the up, the
   * leftover grows, and the helm rolls forever.
   */
  lookBank(fx: number, fy: number, fz: number, zx: number, zy: number, zz: number): void {
    this.lookAt(fx, fy, fz);
    this.t0.set(zx, zy, zz);
    this.t0.addScaledVector(this.fwd, -this.t0.dot(this.fwd));
    if (this.t0.lengthSq() < 1e-16) return;
    this.t0.normalize();
    this.twist(Math.atan2(this.t0.dot(this.right), this.t0.dot(this.up)));
  }

  /**
   * Face-on / Back / save only. Rebuilds the basis from
   * yaw (around galactic Y), pitch, then roll around the nose.
   */
  setEuler(yaw: number, pitch: number, roll: number): void {
    const cp = Math.cos(pitch);
    this.fwd.set(cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw));
    this.right.crossVectors(this.fwd, WORLD_UP);
    if (this.right.lengthSq() < 1e-10) this.right.set(1, 0, 0);
    else this.right.normalize();
    this.up.crossVectors(this.right, this.fwd).normalize();
    if (Math.abs(roll) > 1e-8) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      this.t0.copy(this.right);
      this.t1.copy(this.up);
      this.right.copy(this.t0).multiplyScalar(c).addScaledVector(this.t1, s);
      this.up.crossVectors(this.right, this.fwd).normalize();
      this.right.crossVectors(this.fwd, this.up).normalize();
    }
  }

  toEuler(): { yaw: number; pitch: number; roll: number } {
    const yaw = Math.atan2(this.fwd.x, this.fwd.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(this.fwd.y, -1, 1));
    const cp = Math.cos(pitch);
    this.t0.set(cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw));
    this.t1.crossVectors(this.t0, WORLD_UP);
    if (this.t1.lengthSq() < 1e-10) this.t1.set(1, 0, 0);
    else this.t1.normalize();
    this.t0.crossVectors(this.t1, this.t0).normalize();
    const roll = Math.atan2(-this.up.dot(this.t1), this.up.dot(this.t0));
    return { yaw, pitch, roll };
  }

  addEuler(dYaw: number, dPitch: number, dRoll = 0): void {
    const e = this.toEuler();
    this.setEuler(e.yaw + dYaw, THREE.MathUtils.clamp(e.pitch + dPitch, -1.45, 1.45), e.roll + dRoll);
  }

  applyCam(cam: THREE.PerspectiveCamera): void {
    cam.position.set(0, 0, 0);
    cam.up.copy(this.up);
    this.t0.copy(this.fwd);
    cam.lookAt(this.t0);
  }

  orthonormalize(): void {
    this.fwd.normalize();
    this.up.addScaledVector(this.fwd, -this.up.dot(this.fwd));
    if (this.up.lengthSq() < 1e-16) {
      this.up.crossVectors(this.fwd, WORLD_UP);
      if (this.up.lengthSq() < 1e-16) this.up.set(0, 1, 0);
    }
    this.up.normalize();
    this.right.crossVectors(this.fwd, this.up).normalize();
    this.up.crossVectors(this.right, this.fwd).normalize();
  }
}
