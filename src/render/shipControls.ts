/**
 * The flight control system: the only hands on the stick while
 * the autopilot flies. Guidance (navigator / pilots) command
 * through this API — steer toward an aim, throttle to a speed —
 * and the FCS enforces the ship's physical limits:
 *
 *   - the nose turns at ≤ SHIP_TURN_RATE (rad/s), never a
 *     per-frame fraction (the old 0.55 rad/FRAME clamp allowed
 *     ~33 rad/s at 60 fps — the end-over-end tumble);
 *   - the bank rolls at ≤ SHIP_ROLL_RATE, so a flipping zenith
 *     cannot whip the horizon;
 *   - an antipodal aim rotates around a DETERMINISTIC axis (the
 *     zenith, else the current up) — never an arbitrary one;
 *   - throttle spins up at SHIP_ACCEL (1/s, scale-free across
 *     the twelve orders of magnitude between crawl and warp);
 *     cuts bind instantly, so fences and Stop keep their word.
 *
 * Telemetry (pointing error, achieved turn rate, speed) is how
 * guidance plans feasible arcs. Manual stick input (drag look,
 * verbs like Face-on) stays direct — the player IS the
 * controller then; the FCS is the autopilot's hands.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { ShipFlight } from './flight';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class ShipControls {
  /** Pointing error after the last steer (rad). */
  pointErr = 0;
  /** Achieved turn rate of the last steer (rad/s). */
  turnRate = 0;

  private v = 0;
  private readonly ship: ShipFlight;
  private readonly t0 = new THREE.Vector3();
  private readonly t1 = new THREE.Vector3();
  private readonly t2 = new THREE.Vector3();

  constructor(ship: ShipFlight) {
    this.ship = ship;
  }

  /** Current commanded speed (catalog kpc / s). */
  speed(): number {
    return this.v;
  }

  /** All stop. Cuts always bind instantly — Stop keeps its word. */
  brake(): void {
    this.v = 0;
  }

  /**
   * Command a speed. Spin-up eases at SHIP_ACCEL (1/s); any cut
   * binds this frame so a fence cap can never be overrun by lag.
   * Returns the speed to fly this frame.
   */
  throttle(dt: number, vTarget: number): number {
    const vT = Math.max(0, vTarget);
    if (vT <= this.v) this.v = vT;
    else this.v += (vT - this.v) * (1 - Math.exp(-UNIVERSE.SHIP_ACCEL * dt));
    return this.v;
  }

  /** Instant heading latch — burn verbs, not a tracking loop. */
  point(dirX: number, dirY: number, dirZ: number): void {
    this.ship.lookAt(dirX, dirY, dirZ);
  }

  /**
   * Steer the nose toward `aim` and the bank toward `zenith`
   * (screen-up), or toward world-up when facing a body, or
   * hold the bank (heading hold) when neither.
   *
   * `rate` is the proportional loop (1/s, e.g. ARRIVE_HOLD);
   * the step is HARD-capped at SHIP_TURN_RATE·dt and the roll
   * at SHIP_ROLL_RATE·dt. Returns the remaining pointing error.
   */
  steer(
    dt: number,
    rate: number,
    fwdX: number,
    fwdY: number,
    fwdZ: number,
    zenX: number | null,
    zenY: number | null,
    zenZ: number | null,
    faceBody: boolean,
  ): number {
    const ship = this.ship;
    const flen = Math.hypot(fwdX, fwdY, fwdZ);
    if (flen < 1e-15) return this.pointErr;
    const tx = fwdX / flen;
    const ty = fwdY / flen;
    const tz = fwdZ / flen;
    const cx = ship.fwd.x;
    const cy = ship.fwd.y;
    const cz = ship.fwd.z;
    const dot = THREE.MathUtils.clamp(cx * tx + cy * ty + cz * tz, -1, 1);
    const ang = Math.acos(dot);
    // Proportional loop, hard-capped at the ship's turn rate.
    let k = 1 - Math.exp(-rate * dt);
    const maxAng = UNIVERSE.SHIP_TURN_RATE * dt;
    if (ang > 1e-9 && ang * k > maxAng) k = maxAng / ang;
    let bx: number;
    let by: number;
    let bz: number;
    if (dot > 0.999999) {
      bx = tx;
      by = ty;
      bz = tz;
    } else if (dot < -0.999999) {
      // Antipodal: pitch around a DETERMINISTIC axis — the zenith
      // (nadir plane), else the current up. Never arbitrary.
      if (zenX != null && zenY != null && zenZ != null) this.t2.set(zenX, zenY, zenZ);
      else this.t2.copy(ship.up);
      this.t2.addScaledVector(ship.fwd, -this.t2.dot(ship.fwd));
      if (this.t2.lengthSq() < 1e-16) {
        this.t2.crossVectors(ship.fwd, WORLD_UP);
        if (this.t2.lengthSq() < 1e-16) this.t2.set(1, 0, 0);
      }
      this.t2.normalize();
      this.t1.copy(ship.fwd).applyAxisAngle(this.t2, Math.PI * k);
      bx = this.t1.x;
      by = this.t1.y;
      bz = this.t1.z;
    } else {
      const so = Math.sin(ang);
      const a = Math.sin((1 - k) * ang) / so;
      const b = Math.sin(k * ang) / so;
      bx = a * cx + b * tx;
      by = a * cy + b * ty;
      bz = a * cz + b * tz;
    }
    ship.lookAt(bx, by, bz);
    this.pointErr = Math.max(0, ang * (1 - k));
    this.turnRate = dt > 0 ? Math.min(ang, ang * k) / dt : 0;

    // Bank: roll toward the zenith (or world-up on a face hold)
    // at ≤ SHIP_ROLL_RATE — a flipping zenith cannot whip the
    // horizon faster than the ship can roll.
    let ux: number | null = null;
    let uy = 0;
    let uz = 0;
    if (zenX != null && zenY != null && zenZ != null) {
      ux = zenX;
      uy = zenY;
      uz = zenZ;
    } else if (faceBody) {
      ux = WORLD_UP.x;
      uy = WORLD_UP.y;
      uz = WORLD_UP.z;
    }
    if (ux != null) {
      this.t0.set(ux, uy, uz);
      this.t0.addScaledVector(ship.fwd, -this.t0.dot(ship.fwd));
      if (this.t0.lengthSq() < 1e-16) return this.pointErr;
      this.t0.normalize();
      const upDot = THREE.MathUtils.clamp(ship.up.dot(this.t0), -1, 1);
      const upAng = Math.acos(upDot);
      let kr = k;
      const maxRoll = UNIVERSE.SHIP_ROLL_RATE * dt;
      if (upAng > 1e-9 && upAng * kr > maxRoll) kr = maxRoll / upAng;
      ship.up.lerp(this.t0, kr);
      ship.orthonormalize();
    }
    return this.pointErr;
  }
}
