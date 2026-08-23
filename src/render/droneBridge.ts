/**
 * The drone's window on the world: the `DroneWorld` port the
 * trackball flies against. It answers "what core is nearest",
 * "what is the ship's orbit subject", "how far is a full-disk
 * view", and "what is in the pip" — reading the voyage, the
 * locale, and the sight. It never moves the drone or the camera;
 * launch / dock / tick stay with the conductor.
 */
import * as THREE from 'three';
import { fillViewRadius, type WorldOrbitKind } from '../world/worldOrbit';
import type { DroneWorld } from './drone';
import type { HostBodyRT } from './hostSystem';
import { nearestBody } from './hostLook';
import { Voyage } from './voyage';
import { HostLocale } from './hostLocale';
import { Sight, RETICLE_LOCK } from './sight';

/** Conductor state the bridge reads (never writes). */
export interface BridgePort {
  /** Close-approach world latch (a place, not a heading). */
  worldId(): string | null;
  /** Set-course world the plate remembers. */
  courseBodyId(): string | null;
  /** Host body named by a tap. */
  selectedBodyId(): string | null;
}

export class DroneBridge {
  /** Nearest-core position in host-root km (drone lock / stay-out). */
  private readonly corePos = new THREE.Vector3();

  private readonly voyage: Voyage;
  private readonly locale: HostLocale;
  private readonly sight: Sight;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly port: BridgePort;

  constructor(
    voyage: Voyage,
    locale: HostLocale,
    sight: Sight,
    camera: THREE.PerspectiveCamera,
    port: BridgePort,
  ) {
    this.voyage = voyage;
    this.locale = locale;
    this.sight = sight;
    this.camera = camera;
    this.port = port;
  }

  /** The port the trackball flies against. */
  world(): DroneWorld {
    return {
      nearestFrom: (eye) => {
        const n = this.pickNearestFrom(eye);
        return { id: n.id, pos: this.corePos, R: n.R };
      },
      subject: (eye) => this.subject(eye),
      coreOf: (id, out) => {
        const R = this.coreOf(id);
        out.copy(this.corePos);
        return R;
      },
      fillKm: (R) => fillViewRadius(Math.max(R, 1), this.camera.fov, this.camera.aspect),
      reticleTarget: (eye, fwd) => this.reticleTarget(eye, fwd),
    };
  }

  private worldRt(id: string | null | undefined): HostBodyRT | null {
    return this.locale.sys.get(id);
  }

  private destOrbit(): { bodyId: string | null; kind: WorldOrbitKind } | null {
    return this.voyage.route.destOrbit();
  }

  /**
   * Core the drone backs off from and locks: the body the ship
   * is on (capture / ride / dest), else the latched / course
   * world. A star berth's bodyId is null ON PURPOSE — a ??
   * chain conflated that null with "no berth" and fell through
   * to a bystander world, so a drone launched from the star
   * ride flew off to trackball a planet instead of the sun.
   */
  private orbitId(): string | null {
    if (this.voyage.capturing) return this.voyage.capturing.bodyId;
    const dest = this.destOrbit();
    if (dest) return dest.bodyId;
    if (this.voyage.riding) return this.voyage.riding.bodyId;
    return this.port.worldId() ?? this.port.courseBodyId() ?? null;
  }

  private subject(eye: THREE.Vector3): { id: string | null; pos: THREE.Vector3; R: number } {
    const id = this.orbitId();
    if (id && this.worldRt(id)) {
      const R = this.coreOf(id);
      return { id, pos: this.corePos, R };
    }
    if (id == null && (this.voyage.riding || this.destOrbit() || this.voyage.capturing)) {
      const R = this.coreOf(null);
      return { id: null, pos: this.corePos, R };
    }
    const n = this.pickNearestFrom(eye);
    return { id: n.id, pos: this.corePos, R: n.R };
  }

  private starRadiusKm(): number {
    return this.locale.starRadiusKm();
  }

  /**
   * Core nearest a host-km point (a world, else the star).
   * Launch uses the ship; stay-out uses the drone. Writes
   * corePos. Lock itself never hops.
   */
  private pickNearestFrom(eye: THREE.Vector3): { id: string | null; R: number } {
    const rt = nearestBody(this.locale.sys.bodies, (b) => eye.distanceTo(b.pos));
    const starD = eye.length();
    if (rt && eye.distanceTo(rt.pos) < starD) {
      this.corePos.copy(rt.pos);
      return { id: rt.spec.id, R: Math.max(1, rt.spec.radius) };
    }
    this.corePos.set(0, 0, 0);
    return { id: null, R: this.starRadiusKm() };
  }

  /**
   * Body (or the star) in the centre pip. Null if the pip is
   * empty. The star cone is evaluated in the DRONE's own frame
   * (host-root km: the star is the origin, so star-ward is
   * −eye) — the old test dotted the SHIP's nose against the
   * star from the SHIP's position, so Target could never lock
   * the star from a drone flying somewhere else.
   */
  private reticleTarget(eye: THREE.Vector3, fwd: THREE.Vector3): { id: string | null } | null {
    if (this.sight.focusBodyId && this.worldRt(this.sight.focusBodyId)) {
      return { id: this.sight.focusBodyId };
    }
    const sel = this.port.selectedBodyId();
    if (sel && this.worldRt(sel)) return { id: sel };
    const d = eye.length();
    if (d < 1e-9) return { id: null };
    const dot = -(eye.x * fwd.x + eye.y * fwd.y + eye.z * fwd.z) / d;
    if (dot >= Math.cos(RETICLE_LOCK)) return { id: null };
    return null;
  }

  private coreOf(id: string | null): number {
    if (id) {
      const rt = this.worldRt(id);
      if (rt) {
        this.corePos.copy(rt.pos);
        return Math.max(1, rt.spec.radius);
      }
    }
    this.corePos.set(0, 0, 0);
    return this.starRadiusKm();
  }
}
