/**
 * The voyage: one object that owns every piece of ship flight
 * state — the berth (`Course`), the ridden ring, the capture
 * burn, the leave-orbit burn, coast, the warp latch, and the
 * insertion blend. Transitions are named methods; nothing else
 * writes this state. Geometry (where the ring is, how the nose
 * eases) stays with the viewer; the machine lives here.
 *
 * Session restore pokes fields directly — restore is a state
 * copy, not a verb.
 *
 * Never imports drone.ts. No Three camera.
 */
import * as THREE from 'three';
import { Course, type Berth } from '../world/course';
import type { WorldOrbitKind } from '../world/worldOrbit';

/** On a rail. bodyId null = host-star ecliptic. */
export interface Ride {
  bodyId: string | null;
  kind: WorldOrbitKind;
  hang: boolean;
  r: number;
  theta0: number;
  omega: number;
}

/** Capture burn — easing onto the ring before In Orbit. */
export interface Capture {
  bodyId: string | null;
  kind: WorldOrbitKind;
  dir: THREE.Vector3;
}

/** Leave-orbit burn: ease to escape along a latched heading. */
export interface Depart {
  v: number;
  vEsc: number;
  dir: THREE.Vector3;
}

export class Voyage {
  /** The berth pipeline — dest + derived legs. */
  readonly route = new Course();
  riding: Ride | null = null;
  capturing: Capture | null = null;
  departing: Depart | null = null;
  /** Post-burn drift velocity, held until Warp or Stop. */
  readonly coast = new THREE.Vector3();
  /** Warp latch + gear. */
  thrustOn = false;
  astern = false;
  thrustSpeed = 0;
  /** Lock-on insertion blend 0…1 (far transfer → at the shell). */
  insertBlend = 0;
  /** Cruise reached the ring this frame — capture once bodies pose. */
  pendingArriveOrbit = false;
  /** Left a ring with no dest — HUD Free roam. */
  proximity = false;
  /**
   * Ride frame: hang face (body-local) or the inertial plane
   * basis E1/E2 with its north. Owned with the ride; the
   * geometry that fills them stays with the viewer.
   */
  readonly rideLocal = new THREE.Vector3();
  readonly rideE1 = new THREE.Vector3();
  readonly rideE2 = new THREE.Vector3();
  readonly rideNorth = new THREE.Vector3();

  /** Live dest ring — the Course owns it, nobody shadows it. */
  destOrbit(): { bodyId: string | null; kind: WorldOrbitKind } | null {
    return this.route.destOrbit();
  }

  /** Name a berth. Any half-done approach state is dropped. */
  begin(dest: Berth): void {
    this.route.begin(dest);
    this.pendingArriveOrbit = false;
    this.insertBlend = 0;
    this.proximity = false;
  }

  /** Look drag: drop the route. Thrust is the helm's business. */
  abortRoute(): void {
    this.route.abort();
    this.pendingArriveOrbit = false;
    this.insertBlend = 0;
  }

  /** Rail latched: dest reached, autopilot off, thrust dead. */
  arriveRide(ride: Ride): void {
    this.riding = ride;
    this.route.arrive();
    this.capturing = null;
    this.pendingArriveOrbit = false;
    this.insertBlend = 0;
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }

  /**
   * Exit ring: drop the rail. Returns true when a live dest
   * survives (LeaveSoi / cruise own the nose next); false is
   * free roam.
   */
  breakOrbit(): boolean {
    this.riding = null;
    this.capturing = null;
    this.insertBlend = 0;
    this.pendingArriveOrbit = false;
    if (this.route.live) return true;
    this.proximity = true;
    return false;
  }

  clearRide(): void {
    this.riding = null;
    this.capturing = null;
  }

  beginDepart(vEsc: number, dir: THREE.Vector3): void {
    this.thrustOn = false;
    this.thrustSpeed = 0;
    this.coast.set(0, 0, 0);
    this.departing = { v: 0, vEsc, dir: dir.clone() };
  }

  /** Burn done — float free on the reached velocity. */
  finishDepart(): void {
    const d = this.departing;
    if (!d) return;
    this.coast.copy(d.dir).multiplyScalar(d.v);
    this.departing = null;
  }

  clearDepart(): void {
    this.departing = null;
    this.coast.set(0, 0, 0);
  }

  resetThrust(): void {
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }
}
