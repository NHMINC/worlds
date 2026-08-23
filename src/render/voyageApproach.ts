/**
 * The approach: cruise gears, speed caps, film parks, shell
 * fences, and the leave-orbit burn — how the ship closes on a
 * place without skipping a fence or grazing a ball. State lives
 * on `Voyage`; the ring geometry (insertions, captures, rides)
 * is `voyagePilot.ts`. Same conductor port.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import { type BodySpec } from '../world/systemgen';
import { type HostBodyRT } from './hostSystem';
import { ShipFlight } from './flight';
import { ShipControls } from './shipControls';
import { Voyage } from './voyage';
import { HostLocale } from './hostLocale';
import { type PilotPort } from './voyagePilot';
import {
  clearRadiusKm,
  fillViewRadius,
  escapeSpeedKpcS,
  orbitOmega,
  orbitRadiusKpc,
  shellFloorKm,
  starOrbitOmega,
  starFilmRKm,
  starOrbitRadiusKpc,
  starSkinKm,
  type WorldOrbitKind,
} from '../world/worldOrbit';

/** Catalog kpc per kilometre — host meshes live in km under this scale. */
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

export class VoyageApproach {
  /** Frame dt (s), written by the conductor at frame start. */
  lastDt = 1 / 60;

  private readonly orbitTmp2 = new THREE.Vector3();
  private readonly hostTmp = new THREE.Vector3();
  private readonly hostTmp2 = new THREE.Vector3();

  private readonly ship: ShipFlight;
  private readonly fcs: ShipControls;
  private readonly voyage: Voyage;
  private readonly locale: HostLocale;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly port: PilotPort;

  constructor(
    ship: ShipFlight,
    fcs: ShipControls,
    voyage: Voyage,
    locale: HostLocale,
    camera: THREE.PerspectiveCamera,
    port: PilotPort,
  ) {
    this.ship = ship;
    this.fcs = fcs;
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
    // A star is a furnace: the hard wall is the corona skin, not
    // a photosphere graze — nothing flies into the fire.
    const starR = Math.max(1, this.locale.spec?.star.radius ?? UNIVERSE.RSUN_KM);
    fence(this.hostTmp2.x, this.hostTmp2.y, this.hostTmp2.z, starSkinKm(starR));
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
    this.fcs.point(d.dir.x, d.dir.y, d.dir.z);
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
    // Remnants are point-sized (pulsar ~1e-5 R☉). Fill-park on
    // that radius is ~1e-15 kpc — below a catalog ULP at 8 kpc.
    // One floor for every star film: STAR_FILM_R_MIN.
    const R = starFilmRKm(obj.star.radius * UNIVERSE.RSUN_KM) * KM_TO_KPC;
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
      this.fcs.brake();
      this.voyage.thrustSpeed = 0;
      return;
    }
    if (this.port.droneLive()) {
      this.voyage.thrustOn = false;
      this.fcs.brake();
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
      this.fcs.brake();
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
    const vCmd = cap ?? UNIVERSE.GALAXY_WARP;
    if (!this.voyage.thrustOn) {
      this.fcs.brake();
      this.voyage.thrustSpeed = 0;
      return;
    }
    // Throttle: spin-up eases at SHIP_ACCEL; a lower cap (brake
    // gears, fences, the feasible-arc law) binds this frame.
    this.voyage.thrustSpeed = this.fcs.throttle(dt, vCmd);
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
