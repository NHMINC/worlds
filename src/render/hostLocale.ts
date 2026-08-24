/**
 * The host locale: the local km frame at the latched SOI star —
 * the furnace (photosphere), the Kepler bodies, the rocky
 * globes, and the frame's ecliptic orientation. This is a
 * place, not a heading: it owns nothing about the course,
 * the ride, or the camera. Attach and detach only tear down
 * locale state; a live dest lives on `Voyage` and survives.
 *
 * Drawn as a second AU-scale depth pass (`scene`) over the
 * live galaxy — one universe, two depth windows. The star
 * then gets a screen bloom (`starBloom`); planets do not.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import type { StellarState } from '../world/stellar';
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
  /** Kepler groups + rings — own file, not the galaxy flight. */
  readonly sys = new HostSystem();
  spec: SystemSpec | null = null;
  /** Goldberg globes for every rocky body of the host. */
  readonly globes = new Map<string, RockyGlobe>();
  /** Class tag inside the star's sub-threshold marker. */
  private starLabel: { sprite: THREE.Sprite; tex: THREE.CanvasTexture; mat: THREE.SpriteMaterial } | null = null;

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
    this.dropGlobes();
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
    this.attachStarLabel(lock.star);
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
    this.dropStarLabel();
    this.star.dispose();
    this.star = null;
    this.hooks.furnaceGone();
  }

  /**
   * What the sub-threshold marker is pointing at: the catalog's
   * own stellar state — MK class for living stars, the remnant
   * phase otherwise. Truth from `evolve`, not a painted tag.
   * A sprite (screen-facing, offset above the ring via
   * sprite.center so roll cannot move it) inside the marker
   * group, so the marker law owns its visibility.
   */
  private attachStarLabel(st: StellarState): void {
    if (!this.star || typeof document === 'undefined') return;
    let text: string;
    switch (st.phase) {
      case 'black_hole':
        text = 'Black hole';
        break;
      case 'pulsar':
        text = 'Pulsar';
        break;
      case 'neutron_star':
        text = 'Neutron star';
        break;
      case 'white_dwarf':
        text = st.wdType ? `White dwarf ${st.wdType}` : 'White dwarf';
        break;
      case 'wolf_rayet':
        text = 'Wolf–Rayet';
        break;
      case 'carbon_star':
        text = 'Carbon star';
        break;
      case 'brown_dwarf':
        text = 'Brown dwarf';
        break;
      default:
        text = st.mk
          ? `${st.mk}${st.sub ?? ''}${st.lumClass ? ` ${st.lumClass}` : ''} star`
          : 'Star';
    }
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = '600 34px system-ui, sans-serif';
    const w = Math.ceil(g.measureText(text).width) + 24;
    c.width = w;
    c.height = 48;
    const g2 = c.getContext('2d')!;
    g2.font = '600 34px system-ui, sans-serif';
    g2.textBaseline = 'middle';
    g2.textAlign = 'center';
    g2.fillStyle = 'rgba(159, 216, 255, 0.95)';
    g2.fillText(text, w / 2, 26);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    // Marker units: the ring is radius ~0.9. Keep the text a
    // fixed fraction of the ring; center-offset puts it above.
    const h = 0.34;
    sprite.scale.set((h * w) / 48, h, 1);
    sprite.center.set(0.5, -3.6);
    sprite.renderOrder = 31;
    this.starLabel = { sprite, tex, mat };
    this.star.marker.add(sprite);
  }

  private dropStarLabel(): void {
    if (!this.starLabel) return;
    this.starLabel.sprite.removeFromParent();
    this.starLabel.tex.dispose();
    this.starLabel.mat.dispose();
    this.starLabel = null;
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
    this.sys.update(t, camera, this.root, this.spec?.star.luminosity ?? 1);
  }

  /** Grow a Goldberg globe on a rocky Kepler group, once. */
  mintGlobe(rt: HostBodyRT): void {
    if (!this.spec || rt.spec.kind !== 'rocky' || this.globes.has(rt.spec.id)) return;
    this.globes.set(rt.spec.id, new RockyGlobe(rt.spec, this.spec, rt.group));
  }

  globeOf(id: string | null | undefined): RockyGlobe | null {
    if (!id) return null;
    return this.globes.get(id) ?? null;
  }

  dropGlobes(): void {
    for (const g of this.globes.values()) g.dispose();
    this.globes.clear();
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

  /**
   * Photosphere radius, km — THE star size every consumer must
   * share: the minted spec when the system assembled, else the
   * catalog state through the same law `starSpecFromState`
   * applies (`max(1e-6, R☉) · RSUN_KM`). Fences, parks, the
   * drawn sphere, and guidance all read this one number; a
   * fixed-RSUN fallback here once put a giant's hard wall deep
   * inside its own photosphere.
   */
  starRadiusKm(): number {
    const spec = this.spec?.star.radius;
    if (spec != null) return Math.max(1, spec);
    const cat = this.obj?.star.radius ?? 1;
    return Math.max(1, Math.max(1e-6, cat) * UNIVERSE.RSUN_KM);
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
