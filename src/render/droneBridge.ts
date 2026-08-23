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
import { ShipFlight } from './flight';
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

  private readonly ship: ShipFlight;
  private readonly voyage: Voyage;
  private readonly locale: HostLocale;
  private readonly sight: Sight;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly port: BridgePort;

  constructor(
    ship: ShipFlight,
    voyage: Voyage,
    locale: HostLocale,
    sight: Sight,
    camera: THREE.PerspectiveCamera,
    port: BridgePort,
  ) {
    this.ship = ship;
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
      reticleTarget: () => this.reticleTarget(),
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
   * is on (capture / ride / latched world). `null` is the star
   * only when there is no world in that chain.
   */
  private orbitId(): string | null {
    return (
      this.voyage.capturing?.bodyId ??
      this.destOrbit()?.bodyId ??
      this.voyage.riding?.bodyId ??
      this.port.worldId() ??
      this.port.courseBodyId() ??
      null
    );
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

  /** Body (or the star) in the centre pip. Null if the pip is empty. */
  private reticleTarget(): { id: string | null } | null {
    if (this.sight.focusBodyId && this.worldRt(this.sight.focusBodyId)) {
      return { id: this.sight.focusBodyId };
    }
    const sel = this.port.selectedBodyId();
    if (sel && this.worldRt(sel)) return { id: sel };
    const root = this.locale.root;
    if (!root) return null;
    const d = root.position.length();
    if (d < 1e-18) return { id: null };
    const inv = 1 / d;
    const dot =
      root.position.x * inv * this.ship.fwd.x +
      root.position.y * inv * this.ship.fwd.y +
      root.position.z * inv * this.ship.fwd.z;
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
