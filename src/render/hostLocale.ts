/**
 * The host locale: the local km frame at the latched SOI star —
 * the furnace (photosphere), the Kepler bodies, the rocky
 * globes, and the frame's ecliptic orientation. This is a
 * place, not a heading: it owns nothing about the course,
 * the ride, or the camera. Attach and detach only tear down
 * locale state; a live dest lives on `Voyage` and survives.
 *
 * Drawn as a second AU-scale depth pass (`scene`) over the
 * live galaxy — one universe, two depth windows.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import {
  eclipticPole,
  starSpecFromState,
  systemAt,
  systemU,
  type SystemSpec,
} from '../world/systemgen';
import { HostSystem, type HostBodyRT } from './hostSystem';
import { RockyGlobe } from './rockyGlobe';
import { makeStar, type StarView } from './star';

/** Catalog kpc per kilometre — host meshes live in km under this scale. */
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

/** What the locale tells the sky when the furnace swaps a pin. */
export interface LocaleHooks {
  /** The photosphere replaces this harvest pin. */
  furnaceUp(starId: number): void;
  /** The photosphere is gone: the pin is the star again. */
  furnaceGone(): void;
}

export class HostLocale {
  /**
   * Close-approach subject. Latched when the course, reticle, or
   * selected star comes inside ARRIVE_RANGE_LY; released when the
   * camera leaves that bubble. Latching, not re-testing the
   * reticle, because a full-screen star cannot stay on a tight pip.
   */
  obj: GalaxyObject | null = null;
  star: StarView | null = null;
  starId = -1;
  /** Second depth pass over the live galaxy. */
  readonly scene = new THREE.Scene();
  /** Local km frame at the locked host, scaled into catalog kpc. */
  root: THREE.Group | null = null;
  /** Galaxy fill on objects in the bubble — ARRIVE_SKY_GAIN, not a flood. */
  fill: THREE.AmbientLight | null = null;
  /** Kepler balls + rings — own file, not the galaxy flight. */
  readonly sys = new HostSystem();
  spec: SystemSpec | null = null;
  /** Goldberg globes for every rocky body of the host. */
  readonly globes = new Map<string, RockyGlobe>();

  private readonly pole = new THREE.Vector3();
  private readonly alignQ = new THREE.Quaternion();
  private readonly eclipticZ = new THREE.Vector3(0, 0, 1);
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();

  private readonly seed: string;
  private readonly hooks: LocaleHooks;

  constructor(seed: string, hooks: LocaleHooks) {
    this.seed = seed;
    this.hooks = hooks;
  }

  ensureRoot(): THREE.Group {
    if (this.root) return this.root;
    const root = new THREE.Group();
    root.scale.setScalar(KM_TO_KPC);
    // Same law as the photograph: a small galaxy fill, not a 0.22 flood
    // that would make night impossible once worlds land.
    const fill = new THREE.AmbientLight(0x9aa8c4, UNIVERSE.ARRIVE_SKY_GAIN);
    root.add(fill);
    this.fill = fill;
    this.scene.add(root);
    this.root = root;
    return root;
  }

  attachFurnace(lock: GalaxyObject): void {
    this.detachFurnace();
    this.clearBodies();
    // Fallback star hashes the same address systemAt uses, so a
    // failed system mint still shows the catalog star's true name.
    let star = starSpecFromState(lock.star, systemU(`${this.seed}:${lock.id}`));
    try {
      this.spec = systemAt(this.seed, lock.id);
      star = this.spec.star;
    } catch {
      this.spec = null;
    }
    this.star = makeStar(star);
    this.ensureRoot().add(this.star.group);
    this.starId = lock.id;
    // The photosphere replaces the pin. The catalog freezes on
    // this viewpoint — pins stay pins, the march sleeps.
    this.hooks.furnaceUp(lock.id);
    if (this.spec) this.buildBodies(this.spec);
  }

  detachFurnace(): void {
    if (!this.star) return;
    this.root?.remove(this.star.group);
    this.star.dispose();
    this.star = null;
    this.hooks.furnaceGone();
  }

  /**
   * Tear down the km frame — furnace, bodies, globes, root.
   * Locale state only: the course, ride, and camera are not ours.
   */
  detach(): void {
    this.dropGlobes();
    this.clearBodies();
    this.detachFurnace();
    if (this.root) {
      this.scene.remove(this.root);
      this.root = null;
    }
    this.starId = -1;
    this.fill = null;
  }

  /**
   * Host +Z is the ecliptic pole. The galaxy's pole is +Y (XZ disk).
   * Rotate the km frame so this system's hashed pole sits in the sky.
   */
  orient(root: THREE.Group): void {
    const e = this.spec?.ecliptic;
    if (!e) {
      root.quaternion.identity();
      return;
    }
    const p = eclipticPole(e);
    this.pole.set(p.x, p.y, p.z);
    this.alignQ.setFromUnitVectors(this.eclipticZ, this.pole);
    this.tmpQ.setFromAxisAngle(this.pole, e.spin);
    root.quaternion.copy(this.tmpQ).multiply(this.alignQ);
  }

  buildBodies(spec: SystemSpec): void {
    this.sys.build(this.ensureRoot(), spec);
  }

  clearBodies(): void {
    this.sys.clear(this.root);
    this.spec = null;
  }

  updateBodies(t: number, camera: THREE.PerspectiveCamera): void {
    this.sys.update(t, camera, this.root);
  }

  /** Grow a Goldberg globe on a rocky Kepler ball, once. */
  mintGlobe(rt: HostBodyRT): void {
    if (!this.spec || rt.spec.kind !== 'rocky' || this.globes.has(rt.spec.id)) return;
    this.globes.set(rt.spec.id, new RockyGlobe(rt.spec, this.spec, rt.group, rt.placeholder));
  }

  globeOf(id: string | null | undefined): RockyGlobe | null {
    if (!id) return null;
    return this.globes.get(id) ?? null;
  }

  dropGlobes(): void {
    for (const g of this.globes.values()) g.dispose();
    this.globes.clear();
  }

  starRadiusKm(): number {
    return Math.max(1, this.spec?.star.radius ?? UNIVERSE.RSUN_KM);
  }

  // ------------------------------------------------- km ↔ kpc bridges

  /** Body spin in the oriented km frame. */
  spinWorld(rt: HostBodyRT, out: THREE.Quaternion): THREE.Quaternion {
    out.copy(rt.spinQ);
    if (this.root) out.premultiply(this.root.quaternion);
    return out;
  }

  /** Camera → host-root km. Inverse of pinEyeKm. */
  hostEyeKm(out: THREE.Vector3): THREE.Vector3 {
    const root = this.root;
    if (!root) return out.set(0, 0, 0);
    return out
      .copy(root.position)
      .negate()
      .applyQuaternion(this.tmpQ.copy(root.quaternion).conjugate())
      .multiplyScalar(1 / KM_TO_KPC);
  }

  /** Catalog position of a host-pass body — independent of arcCenter. */
  bodyCatalog(rt: HostBodyRT, out: THREE.Vector3): THREE.Vector3 {
    const lock = this.obj;
    if (!lock) return out.set(0, 0, 0);
    const c = galToCart(lock.pos);
    out.copy(rt.pos).multiplyScalar(KM_TO_KPC);
    if (this.root) out.applyQuaternion(this.root.quaternion);
    out.x += c.x;
    out.y += c.y;
    out.z += c.z;
    return out;
  }

  /** Eye → star in catalog kpc — the exact-difference law. */
  starFromEye(shipAt: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const lock = this.obj;
    if (!lock) return out.set(0, 0, 0);
    const c = galToCart(lock.pos);
    return out.set(c.x - shipAt.x, c.y - shipAt.y, c.z - shipAt.z);
  }

  /**
   * Camera → body in catalog kpc. Order is the precision law:
   * star − eye is an exact difference of two nearby ~8 kpc
   * doubles; the body's km offset adds after, in that small
   * frame. Folding the kilometres into the 8 kpc point first
   * quantizes them by a ULP (~30 km) — that noise was the
   * shell-park zigzag that never arrived.
   */
  bodyFromEye(shipAt: THREE.Vector3, rt: HostBodyRT, out: THREE.Vector3): THREE.Vector3 {
    const lock = this.obj;
    if (!lock) return out.set(0, 0, 0);
    out.copy(rt.pos).multiplyScalar(KM_TO_KPC);
    if (this.root) out.applyQuaternion(this.root.quaternion);
    const c = galToCart(lock.pos);
    out.x += c.x - shipAt.x;
    out.y += c.y - shipAt.y;
    out.z += c.z - shipAt.z;
    return out;
  }

  /**
   * Pin the root so a host-root-local km point sits at the
   * camera. Do not fold that offset into the 8 kpc catalog
   * point first — a metre there is below a ULP. Writes the
   * ship's catalog position when `shipAt` is given.
   */
  pinEyeKm(eyeKm: THREE.Vector3, shipAt: THREE.Vector3 | null): void {
    const root = this.root;
    const lock = this.obj;
    if (!root || !lock) return;
    this.tmpV.copy(eyeKm).multiplyScalar(KM_TO_KPC).applyQuaternion(root.quaternion);
    root.position.copy(this.tmpV).negate();
    root.updateMatrixWorld(true);
    if (!shipAt) return;
    const cart = galToCart(lock.pos);
    shipAt.copy(cart).add(this.tmpV);
  }
}
