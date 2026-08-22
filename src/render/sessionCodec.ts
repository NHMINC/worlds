/**
 * Save-shape mappers: module state → the portable session /
 * camp JSON. Pure reads — no module is mutated here, and the
 * shapes (`SessionSnap` v1, `LastPlace`) do not change, so old
 * files keep loading. Restore stays with the conductor: it
 * needs the host frame to exist before a pose can be applied.
 */
import * as THREE from 'three';
import type { LastPlace, SessionDrone, SessionSnap, SessionVec } from '../world/types';
import type { ShipFlight } from './flight';
import type { Voyage } from './voyage';

const v = (p: THREE.Vector3): SessionVec => [p.x, p.y, p.z];

/** Live ship / drone save — written as the pose moves. */
export function encodeSession(args: {
  seed: string;
  ship: ShipFlight;
  voyage: Voyage;
  hostId: number | null;
  worldId: string | null;
  drone: SessionDrone | null;
}): SessionSnap {
  const { seed, ship, voyage } = args;
  const ride = voyage.riding;
  return {
    v: 1,
    galaxySeed: seed,
    at: v(ship.at),
    fwd: v(ship.fwd),
    up: v(ship.up),
    thrustOn: voyage.thrustOn,
    astern: voyage.astern,
    coast: voyage.coast.lengthSq() > 0 ? v(voyage.coast) : null,
    departing: voyage.departing
      ? { v: voyage.departing.v, vEsc: voyage.departing.vEsc, dir: v(voyage.departing.dir) }
      : null,
    starId: args.hostId,
    bodyId: voyage.riding?.bodyId ?? voyage.capturing?.bodyId ?? null,
    worldId: args.worldId,
    orbit: voyage.riding?.kind ?? voyage.capturing?.kind ?? null,
    landed: false,
    riding: ride
      ? {
          bodyId: ride.bodyId,
          kind: ride.kind,
          hang: ride.hang,
          r: ride.r,
          theta0: ride.theta0,
          omega: ride.omega,
          e1: v(voyage.rideE1),
          e2: v(voyage.rideE2),
          local: v(voyage.rideLocal),
        }
      : null,
    capturing: voyage.capturing
      ? {
          bodyId: voyage.capturing.bodyId,
          kind: voyage.capturing.kind,
          dir: v(voyage.capturing.dir),
        }
      : null,
    pendingOrbit: voyage.destOrbit(),
    pendingArriveOrbit: voyage.pendingArriveOrbit,
    insertBlend: voyage.insertBlend,
    surfDir: null,
    sYaw: 0,
    sPitch: 0,
    sEyeH: 0,
    landKind: null,
    course: voyage.route.dest,
    courseLive: voyage.route.live,
    proximity: voyage.proximity,
    drone: args.drone,
  };
}

/**
 * Coarse camp. `dir` is the conductor's job (body → eye needs
 * the host frame); `h` is the ride height over the body radius.
 */
export function encodePlace(args: {
  seed: string;
  starId: number;
  bodyId: string | null;
  voyage: Voyage;
  dir: [number, number, number] | null;
  h: number | null;
}): LastPlace {
  return {
    galaxySeed: args.seed,
    starId: args.starId,
    bodyId: args.bodyId,
    orbit: args.voyage.riding?.kind ?? null,
    landed: false,
    dir: args.dir,
    h: args.h,
  };
}
