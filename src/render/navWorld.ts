/**
 * The navigation truth: what the autopilot is allowed to
 * believe about the world. One read-only snapshot per tick —
 * every object the ship must respect, with position, velocity,
 * and the full fence stack (wall < graze), plus the ship's own
 * achieved velocity. Everything derives from the same closed
 * forms the renderer flies (keplerPlane, the corona laws), so
 * the navigator and the world can never disagree.
 *
 * Frames: positions are EYE-RELATIVE catalog kpc (the precision
 * law — star − eye is an exact difference of nearby doubles; a
 * body's km offset adds after, in that small frame). Velocities
 * are catalog kpc per WALL second (TIME_SCALE folded in),
 * finite-differenced from the same Kepler law the bodies ride.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { keplerPlane } from '../world/systemgen';
import {
  shellFloorKm,
  starGrazeKm,
  starOrbitRadiusKpc,
  starSkinKm,
} from '../world/worldOrbit';
import { ShipFlight } from './flight';
import { HostLocale } from './hostLocale';
import type { HostBodyRT } from './hostSystem';

const AU_KM = UNIVERSE.AU_KM;
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

/** One object the ship must respect. id null = the host star. */
export interface NavObject {
  id: string | null;
  /** Eye → object, catalog kpc. */
  readonly pos: THREE.Vector3;
  /** Catalog kpc per wall second. The star holds its frame: 0. */
  readonly vel: THREE.Vector3;
  radiusKm: number;
  /** Hard fence — no move crosses it (corona for the star). */
  wallKm: number;
  /** Router ball — the corridor tangents around this. */
  grazeKm: number;
}

export class NavWorld {
  /** Star first (when a host is latched), then every body. */
  readonly objects: NavObject[] = [];
  /** The ship's achieved velocity (kpc / wall s) — truth, not plan. */
  readonly selfVel = new THREE.Vector3();
  /** Universe seconds of this snapshot. */
  tSys = 0;

  private readonly ship: ShipFlight;
  private readonly locale: HostLocale;
  private readonly prevAt = new THREE.Vector3();
  private havePrev = false;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private pool: NavObject[] = [];

  constructor(ship: ShipFlight, locale: HostLocale) {
    this.ship = ship;
    this.locale = locale;
  }

  /** The host star's row, if a host is latched. */
  star(): NavObject | null {
    return this.objects.length > 0 && this.objects[0].id === null ? this.objects[0] : null;
  }

  body(id: string | null | undefined): NavObject | null {
    if (!id) return null;
    for (const o of this.objects) if (o.id === id) return o;
    return null;
  }

  /** Ecliptic park radius (kpc) for the latched star. */
  starParkKpc(): number {
    const starR = Math.max(1, this.locale.spec?.star.radius ?? UNIVERSE.RSUN_KM);
    return starOrbitRadiusKpc({ radius: starR });
  }

  /**
   * Rebuild the snapshot. Bodies get closed-form Kepler
   * velocities (central difference of the same law they ride,
   * rotated into the catalog frame); the ship gets its achieved
   * velocity from the last tick.
   */
  tick(dtWall: number, tSys: number): void {
    this.tSys = tSys;
    if (this.havePrev && dtWall > 1e-6) {
      this.selfVel.set(
        (this.ship.at.x - this.prevAt.x) / dtWall,
        (this.ship.at.y - this.prevAt.y) / dtWall,
        (this.ship.at.z - this.prevAt.z) / dtWall,
      );
    } else {
      this.selfVel.set(0, 0, 0);
    }
    this.prevAt.copy(this.ship.at);
    this.havePrev = true;

    const prevPool = this.pool;
    this.pool = this.objects.slice();
    this.objects.length = 0;
    const take = (): NavObject => {
      const o = prevPool.pop() ?? this.pool.pop();
      if (o) return o;
      return { id: null, pos: new THREE.Vector3(), vel: new THREE.Vector3(), radiusKm: 1, wallKm: 1, grazeKm: 1 };
    };

    const lock = this.locale.obj;
    if (!lock) return;

    // The star: eye-relative by exact difference; static in its
    // own frame; corona fences.
    const starR = Math.max(1, this.locale.spec?.star.radius ?? UNIVERSE.RSUN_KM);
    const star = take();
    star.id = null;
    this.locale.starFromEye(this.ship.at, star.pos);
    star.vel.set(0, 0, 0);
    star.radiusKm = starR;
    star.wallKm = starSkinKm(starR);
    star.grazeKm = starGrazeKm(starR);
    this.objects.push(star);

    // Bodies: same eye-relative precision path, Kepler velocity
    // from the same closed form (central difference, universe
    // seconds → wall seconds via TIME_SCALE).
    const root = this.locale.root;
    for (const rt of this.locale.sys.bodies) {
      const o = take();
      o.id = rt.spec.id;
      this.locale.bodyFromEye(this.ship.at, rt, o.pos);
      this.kmVel(rt, tSys, this.tmp);
      o.vel.copy(this.tmp).multiplyScalar(KM_TO_KPC * UNIVERSE.TIME_SCALE);
      if (root) o.vel.applyQuaternion(root.quaternion);
      const R = Math.max(rt.spec.radius, 1);
      o.radiusKm = R;
      o.wallKm = shellFloorKm(rt.spec);
      o.grazeKm = Math.max(UNIVERSE.ROUTE_GRAZE * R, R + UNIVERSE.WORLD_ORBIT_CLEAR_KM);
      this.objects.push(o);
    }
  }

  /**
   * Body position on the host clock (host km), at any universe
   * time — the SAME law HostSystem.update flies (keplerPlane in
   * the orbX/orbY basis, parents chained).
   */
  poseKm(rt: HostBodyRT, tSys: number, out: THREE.Vector3): THREE.Vector3 {
    const b = rt.spec;
    const { xo, yo } = keplerPlane(b.orbitRadius, b.orbitPeriod, b.orbitPhase, b.ecc, tSys);
    const scale = b.parent ? 1 : AU_KM;
    out.set(
      (rt.orbX.x * xo + rt.orbY.x * yo) * scale,
      (rt.orbX.y * xo + rt.orbY.y * yo) * scale,
      (rt.orbX.z * xo + rt.orbY.z * yo) * scale,
    );
    if (b.parent) {
      const parent = this.locale.sys.get(b.parent);
      if (parent) {
        this.poseKm(parent, tSys, this.tmp2);
        out.add(this.tmp2);
      }
    }
    return out;
  }

  /** Central-difference Kepler velocity, host km per UNIVERSE second. */
  kmVel(rt: HostBodyRT, tSys: number, out: THREE.Vector3): THREE.Vector3 {
    const P = Math.max(1e-3, rt.spec.orbitPeriod);
    const eps = Math.min(60, P / 1000);
    this.poseKm(rt, tSys + eps, out);
    this.poseKm(rt, tSys - eps, this.tmp);
    return out.sub(this.tmp).multiplyScalar(1 / (2 * eps));
  }
}
