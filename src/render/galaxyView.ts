/**
 * The galaxy explorer: the mass model on the GPU (the Hubble glow) plus
 * catalog stars that resolve as you fly in. Billions exist as the
 * integral; objectAt becomes a point only in the volume you occupy.
 * You cannot pick a star from 40 kpc away. Nothing here is a painted spiral.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import {
  cartToGal,
  galToCart,
  homeStar,
  objectAt,
  objectsNear,
  type GalaxyObject,
} from '../world/galaxy';
import { classifyStar, teffToRgb } from '../world/stellar';
import { createGalaxyField, updateGalaxyField } from './galaxyField';

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 70;
/** Orbit radius (kpc) inside which a resolved star may be picked. */
const PICK_ZOOM = 9.5;
/** Face-on: the field is the photograph; catalog points stay dark. */
const FIELD_ONLY_ZOOM = 32;

export type GalaxyFilter = 'all' | 'hot' | 'sunlike' | 'cool' | 'remnant' | 'nebula' | 'halo' | 'arm';
export type GalaxyPreset = 'face' | 'edge' | 'home' | 'arm';

export function matchesFilter(o: GalaxyObject, f: GalaxyFilter): boolean {
  const st = o.star;
  if (f === 'all') return true;
  if (f === 'hot') return st.mk === 'O' || st.mk === 'B' || st.mk === 'A' || st.phase === 'wolf_rayet';
  if (f === 'sunlike') {
    return (st.mk === 'F' || st.mk === 'G' || st.mk === 'K') && (st.lumClass === 'V' || st.lumClass === 'VI');
  }
  if (f === 'cool') return st.mk === 'M' || st.mk === 'L' || st.mk === 'T' || st.phase === 'brown_dwarf';
  if (f === 'remnant') {
    return st.phase === 'white_dwarf' || st.phase === 'neutron_star' || st.phase === 'pulsar' || st.phase === 'black_hole';
  }
  if (f === 'nebula') return st.nebula !== 'none';
  if (f === 'halo') return o.pop === 'halo';
  return o.inArm;
}

const STAR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aPulse;
  attribute float aVis;
  uniform float uTime;
  uniform float uPixel;
  varying vec3 vColor;
  varying float vPulse;
  void main() {
    vColor = aColor;
    float pulse = aPulse > 0.5 ? 0.55 + 0.45 * sin(uTime * 18.0 + position.x * 7.0) : 1.0;
    vPulse = pulse;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(0.8, -mv.z);
    gl_PointSize = aSize * aVis * pulse * uPixel * (42.0 / dist);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vPulse;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 4.2);
    float halo = exp(-r2 * 1.15) * 0.35;
    float a = (core + halo) * vPulse;
    gl_FragColor = vec4(vColor * (0.65 + 0.55 * core), a);
  }
`;

export interface GalaxyFrame {
  theta: number;
  phi: number;
  radius: number;
  pickable: boolean;
  resolved: number;
}

interface Callbacks {
  onSelect: (obj: GalaxyObject | null) => void;
  onFrame?: (f: GalaxyFrame) => void;
}

export class GalaxyView {
  objects: GalaxyObject[] = [];
  readonly home: GalaxyObject | null;
  private seed: string;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private callbacks: Callbacks;
  private disposed = false;
  private raf = 0;

  private starPts: THREE.Points;
  private nebPts: THREE.Points;
  private fieldMesh: THREE.Mesh;
  private fieldMat: THREE.ShaderMaterial;
  private visStar: THREE.BufferAttribute;
  private visNeb: THREE.BufferAttribute;
  private starMat: THREE.ShaderMaterial;
  private nebMat: THREE.ShaderMaterial;
  private homeRing: THREE.Mesh;
  private hereRing: THREE.Mesh;
  private pickRing: THREE.Mesh;

  private ids: number[];
  private nebIds: number[];
  private byId = new Map<number, GalaxyObject>();

  private theta = 0.35;
  private phi = 0.42;
  private radius = 38;
  private tgtTheta = 0.35;
  private tgtPhi = 0.42;
  private tgtRadius = 38;
  private look = new THREE.Vector3();
  private tgtLook = new THREE.Vector3();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private pinchMidX = 0;
  private pinchMidY = 0;
  private idle = 0;
  private resolved = 0;
  private qKey = '';
  private filter: GalaxyFilter = 'all';
  private selected: GalaxyObject | null = null;
  private lastT = performance.now();

  constructor(canvas: HTMLCanvasElement, seed: string, callbacks: Callbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.seed = seed;
    this.home = homeStar(seed);
    if (this.home) this.byId.set(this.home.id, this.home);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(new THREE.Color('#070b14'), 1);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.08, 400);

    const field = createGalaxyField();
    this.fieldMesh = field.mesh;
    this.fieldMat = field.mat;
    this.fieldMesh.renderOrder = -10;
    this.scene.add(this.fieldMesh);

    const stars = this.buildStars();
    this.starPts = stars.pts;
    this.starMat = stars.mat;
    this.visStar = stars.vis;
    this.ids = stars.ids;
    this.scene.add(this.starPts);

    const nebs = this.buildNebulae();
    this.nebPts = nebs.pts;
    this.nebMat = nebs.mat;
    this.visNeb = nebs.vis;
    this.nebIds = nebs.ids;
    this.scene.add(this.nebPts);

    this.homeRing = this.makeRing(0x9ec4ff, 0.28);
    this.hereRing = this.makeRing(0x7fa88b, 0.22);
    this.pickRing = this.makeRing(0xf4e4c1, 0.18);
    this.scene.add(this.homeRing, this.hereRing, this.pickRing);
    if (this.home) {
      const c = galToCart(this.home.pos);
      this.homeRing.position.set(c.x, c.y, c.z);
      this.homeRing.visible = true;
    } else {
      this.homeRing.visible = false;
    }
    this.hereRing.visible = false;
    this.pickRing.visible = false;

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.setPreset('face');
    this.theta = this.tgtTheta;
    this.phi = this.tgtPhi;
    this.radius = this.tgtRadius;
    this.applyCam();
    this.loadLocal();
    this.raf = requestAnimationFrame(this.frame);
  }

  private hereObj: GalaxyObject | null = null;

  setHere(id: number | null): void {
    const o = id != null ? objectAt(this.seed, id) : null;
    this.hereObj = o;
    if (!o) {
      this.hereRing.visible = false;
      this.applyVis();
      return;
    }
    const c = galToCart(o.pos);
    this.hereRing.position.set(c.x, c.y, c.z);
    this.hereRing.visible = true;
    this.qKey = '';
    this.applyVis();
  }

  setFilter(f: GalaxyFilter): void {
    this.filter = f;
    this.qKey = '';
    this.applyVis();
  }

  dismiss(): void {
    this.select(null);
  }

  canPick(): boolean {
    return this.tgtRadius <= PICK_ZOOM;
  }

  /**
   * How much of this catalog row is resolved at the current camera.
   * Luminosity floor falls as you fly in: giants first, then sunlike,
   * then the M-dwarf oatmeal. Face-on is field-only.
   */
  private resolveAmt(o: GalaxyObject, wx: number, wy: number, wz: number): number {
    if (!matchesFilter(o, this.filter)) return 0;
    const zoom = this.radius;
    if (zoom > FIELD_ONLY_ZOOM) return 0;
    const cam = this.camera.position;
    const dist = Math.hypot(wx - cam.x, wy - cam.y, wz - cam.z);
    const appear = zoom * 1.5 + 1.8;
    if (dist > appear) return 0;
    const neb = o.star.nebula !== 'none';
    const L = Math.max(1e-8, o.star.luminosity);
    const floor = neb
      ? Math.pow(Math.max(zoom, 4) / 16, 2.8)
      : Math.pow(Math.max(zoom, 0.55) / 5.8, 3.5);
    if (L < floor * 0.2) return 0;
    const bright = L / Math.max(floor, 1e-8);
    const near = 1 - dist / appear;
    return clamp01(smoothstep(0.2, 1.15, bright) * smoothstep(0.02, 0.4, near));
  }

  private applyVis(): void {
    const starVis = this.visStar.array as Float32Array;
    const starPos = this.starPts.geometry.getAttribute('position') as THREE.BufferAttribute;
    let n = 0;
    for (let i = 0; i < this.ids.length; i++) {
      const o = this.byId.get(this.ids[i])!;
      const v = this.resolveAmt(o, starPos.getX(i), starPos.getY(i), starPos.getZ(i));
      starVis[i] = v;
      if (v > 0.45) n++;
    }
    this.visStar.needsUpdate = true;
    const nebVis = this.visNeb.array as Float32Array;
    const nebPos = this.nebPts.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < this.nebIds.length; i++) {
      const o = this.byId.get(this.nebIds[i])!;
      const v = this.resolveAmt(o, nebPos.getX(i), nebPos.getY(i), nebPos.getZ(i));
      nebVis[i] = v;
      if (v > 0.45) n++;
    }
    this.visNeb.needsUpdate = true;
    this.resolved = n;
  }

  private uMinForZoom(): number {
    const z = this.radius;
    if (this.filter === 'cool') {
      if (z > 10) return 0.9;
      if (z > 4) return 0.4;
      return 0;
    }
    if (z > 22) return 0.9985;
    if (z > 14) return 0.994;
    if (z > 9) return 0.97;
    if (z > 5) return 0.86;
    if (z > 2.4) return 0.5;
    return 0;
  }

  private refreshIfNeeded(): void {
    const uMin = this.uMinForZoom();
    const key =
      this.radius > 30
        ? `far:${this.filter}`
        : `${this.look.x.toFixed(1)}:${this.look.z.toFixed(1)}:${this.radius.toFixed(1)}:${this.filter}:${uMin.toFixed(3)}`;
    if (key === this.qKey) return;
    this.qKey = key;
    this.loadLocal();
  }

  private loadLocal(): void {
    if (this.radius > 30) {
      this.objects = [];
    } else {
      const gal = cartToGal(this.look.x, this.look.y, this.look.z);
      const dR = Math.min(5.2, Math.max(0.18, this.radius * 0.72));
      this.objects = objectsNear(this.seed, gal, dR, { uMin: this.uMinForZoom(), limit: 2400 });
    }
    this.byId.clear();
    for (const o of this.objects) this.byId.set(o.id, o);
    if (this.home) this.byId.set(this.home.id, this.home);
    if (this.hereObj) this.byId.set(this.hereObj.id, this.hereObj);
    this.rebuildPoints();
  }

  private rebuildPoints(): void {
    this.scene.remove(this.starPts, this.nebPts);
    this.starPts.geometry.dispose();
    this.nebPts.geometry.dispose();
    this.starMat.dispose();
    this.nebMat.dispose();
    const stars = this.buildStars();
    this.starPts = stars.pts;
    this.starMat = stars.mat;
    this.visStar = stars.vis;
    this.ids = stars.ids;
    this.scene.add(this.starPts);
    const nebs = this.buildNebulae();
    this.nebPts = nebs.pts;
    this.nebMat = nebs.mat;
    this.visNeb = nebs.vis;
    this.nebIds = nebs.ids;
    this.scene.add(this.nebPts);
    this.applyVis();
  }

  setPreset(p: GalaxyPreset): void {
    if (p === 'face') {
      this.tgtTheta = 0.25;
      this.tgtPhi = 0.16;
      this.tgtRadius = 40;
      this.tgtLook.set(0, 0, 0);
    } else if (p === 'edge') {
      this.tgtTheta = 0.15;
      this.tgtPhi = 1.42;
      this.tgtRadius = 36;
      this.tgtLook.set(0, 0, 0);
    } else if (p === 'home') {
      const obj = this.hereObj ?? this.home;
      if (obj) {
        const c = galToCart(obj.pos);
        this.tgtLook.set(c.x, c.y, c.z);
        this.tgtTheta = obj.pos.theta + 0.55;
        this.tgtPhi = 0.72;
        this.tgtRadius = 6.5;
        this.select(obj);
      }
    } else {
      this.tgtTheta = 1.15;
      this.tgtPhi = 0.55;
      this.tgtRadius = 18;
      this.tgtLook.set(UNIVERSE.GALAXY_RD * 0.4, 0, UNIVERSE.GALAXY_RD * 0.9);
    }
    this.idle = 0;
  }

  focus(obj: GalaxyObject): void {
    const c = galToCart(obj.pos);
    this.tgtLook.set(c.x, c.y, c.z);
    this.tgtRadius = 5.2;
    this.tgtPhi = 0.7;
    this.select(obj);
    this.idle = 0;
  }

  selectedObject(): GalaxyObject | null {
    return this.selected;
  }

  census(): Record<string, number> {
    const c: Record<string, number> = {};
    const starPos = this.starPts.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < this.ids.length; i++) {
      const o = this.byId.get(this.ids[i])!;
      if (this.resolveAmt(o, starPos.getX(i), starPos.getY(i), starPos.getZ(i)) <= 0.45) continue;
      const k = classifyStar(o.star).replace(/\+.*/, '').replace(/[0-9].*/, '');
      const letter = /^[OBAFGKMLT]/.test(k) ? k[0] : k;
      c[letter] = (c[letter] ?? 0) + 1;
    }
    return c;
  }

  beaconCount(): number {
    return this.resolved;
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.starPts.geometry.dispose();
    this.nebPts.geometry.dispose();
    this.fieldMesh.geometry.dispose();
    this.starMat.dispose();
    this.nebMat.dispose();
    this.fieldMat.dispose();
    this.homeRing.geometry.dispose();
    (this.homeRing.material as THREE.Material).dispose();
    this.hereRing.geometry.dispose();
    (this.hereRing.material as THREE.Material).dispose();
    this.pickRing.geometry.dispose();
    (this.pickRing.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private select(obj: GalaxyObject | null): void {
    this.selected = obj;
    if (obj) {
      const c = galToCart(obj.pos);
      this.pickRing.position.set(c.x, c.y, c.z);
      this.pickRing.visible = true;
    } else {
      this.pickRing.visible = false;
    }
    this.callbacks.onSelect(obj);
  }

  private makeRing(color: number, inner: number): THREE.Mesh {
    const g = new THREE.RingGeometry(inner, inner * 1.55, 48);
    const m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = Math.PI / 2;
    mesh.visible = false;
    return mesh;
  }

  private buildStars(): {
    pts: THREE.Points;
    mat: THREE.ShaderMaterial;
    vis: THREE.BufferAttribute;
    ids: number[];
  } {
    const stars = this.objects.filter((o) => o.star.nebula === 'none' || o.star.phase === 'main_sequence' || o.star.phase === 'giant' || o.star.phase === 'supergiant' || o.star.phase === 'subgiant' || o.star.phase === 'wolf_rayet' || o.star.phase === 'carbon_star' || o.star.phase === 'brown_dwarf' || o.star.phase === 'white_dwarf' || o.star.phase === 'neutron_star' || o.star.phase === 'pulsar' || o.star.phase === 'black_hole');
    const n = Math.max(1, stars.length);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const pulse = new Float32Array(n);
    const visArr = new Float32Array(n);
    const ids: number[] = [];
    if (stars.length === 0) visArr[0] = 0;
    for (let i = 0; i < stars.length; i++) {
      const o = stars[i];
      const c = galToCart(o.pos);
      pos[i * 3] = c.x;
      pos[i * 3 + 1] = c.y;
      pos[i * 3 + 2] = c.z;
      const rgb = starRgb(o);
      col[i * 3] = rgb[0];
      col[i * 3 + 1] = rgb[1];
      col[i * 3 + 2] = rgb[2];
      const L = Math.max(1e-6, o.star.luminosity);
      size[i] = 1.6 + Math.min(8.2, Math.log10(1 + L) * 2.8 + (o.star.phase === 'black_hole' ? 1.8 : 0));
      pulse[i] = o.star.phase === 'pulsar' ? 1 : 0;
      visArr[i] = 1;
      ids.push(o.id);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPulse', new THREE.BufferAttribute(pulse, 1));
    const vis = new THREE.BufferAttribute(visArr, 1);
    geo.setAttribute('aVis', vis);
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: { value: 0 }, uPixel: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { pts: new THREE.Points(geo, mat), mat, vis, ids };
  }

  private buildNebulae(): {
    pts: THREE.Points;
    mat: THREE.ShaderMaterial;
    vis: THREE.BufferAttribute;
    ids: number[];
  } {
    const nebs = this.objects.filter((o) => o.star.nebula !== 'none');
    const n = Math.max(1, nebs.length);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const pulse = new Float32Array(n);
    const visArr = new Float32Array(n);
    const ids: number[] = [];
    if (nebs.length === 0) visArr[0] = 0;
    for (let i = 0; i < nebs.length; i++) {
      const o = nebs[i];
      const c = galToCart(o.pos);
      pos[i * 3] = c.x;
      pos[i * 3 + 1] = c.y;
      pos[i * 3 + 2] = c.z;
      const rgb = nebRgb(o.star.nebula);
      col[i * 3] = rgb[0];
      col[i * 3 + 1] = rgb[1];
      col[i * 3 + 2] = rgb[2];
      size[i] = 7 + (o.star.nebula === 'hii' ? 4 : 2);
      pulse[i] = 0;
      visArr[i] = 1;
      ids.push(o.id);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPulse', new THREE.BufferAttribute(pulse, 1));
    const vis = new THREE.BufferAttribute(visArr, 1);
    geo.setAttribute('aVis', vis);
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: { value: 0 }, uPixel: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { pts: new THREE.Points(geo, mat), mat, vis, ids };
  }

  private applyCam(): void {
    const r = this.radius;
    const x = this.look.x + r * Math.sin(this.phi) * Math.cos(this.theta);
    const y = this.look.y + r * Math.cos(this.phi);
    const z = this.look.z + r * Math.sin(this.phi) * Math.sin(this.theta);
    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
  }

  private clampLook(): void {
    const maxR = UNIVERSE.GALAXY_R_MAX * 1.08;
    const r = Math.hypot(this.tgtLook.x, this.tgtLook.z);
    if (r > maxR) {
      this.tgtLook.x *= maxR / r;
      this.tgtLook.z *= maxR / r;
    }
    this.tgtLook.y = Math.max(-2.5, Math.min(2.5, this.tgtLook.y));
  }

  private panLook(dxPx: number, dyPx: number): void {
    this.camera.updateMatrixWorld();
    const te = this.camera.matrixWorld.elements;
    let rx = te[0];
    let rz = te[2];
    let rlen = Math.hypot(rx, rz);
    if (rlen < 1e-4) {
      rx = 1;
      rz = 0;
      rlen = 1;
    }
    rx /= rlen;
    rz /= rlen;
    let fx = -te[8];
    let fz = -te[10];
    let flen = Math.hypot(fx, fz);
    if (flen < 1e-4) {
      fx = 0;
      fz = 1;
      flen = 1;
    }
    fx /= flen;
    fz /= flen;
    const scale = this.radius * 0.0034;
    this.tgtLook.x += rx * dxPx * scale + fx * dyPx * scale;
    this.tgtLook.z += rz * dxPx * scale + fz * dyPx * scale;
    this.clampLook();
    this.look.copy(this.tgtLook);
  }

  private zoomToward(cx: number, cy: number, factor: number): void {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.tgtRadius * factor));
    if (factor < 1) {
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector3(
        ((cx - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -((cy - rect.top) / Math.max(1, rect.height)) * 2 + 1,
        0.5,
      );
      ndc.unproject(this.camera);
      const dir = ndc.sub(this.camera.position).normalize();
      const n = this.camera.position.clone().sub(this.look).normalize();
      const denom = dir.dot(n);
      if (Math.abs(denom) > 1e-4) {
        const t = this.look.clone().sub(this.camera.position).dot(n) / denom;
        if (t > 0.2) {
          const hit = this.camera.position.clone().add(dir.multiplyScalar(t));
          const pull = (1 - factor) * 0.45;
          this.tgtLook.lerp(hit, pull);
          this.clampLook();
        }
      }
    }
    this.tgtRadius = next;
  }

  private pick(cx: number, cy: number): void {
    if (!this.canPick()) {
      this.select(null);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const x = cx - rect.left;
    const y = cy - rect.top;
    let best = -1;
    let bestD = 16;
    const vis = this.visStar.array as Float32Array;
    const pos = this.starPts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.ids.length; i++) {
      if (vis[i] < 0.55) continue;
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).project(this.camera);
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      if (v.z < -1 || v.z > 1) continue;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = this.ids[i];
      }
    }
    const nebVis = this.visNeb.array as Float32Array;
    const nebPos = this.nebPts.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < this.nebIds.length; i++) {
      if (nebVis[i] < 0.55) continue;
      v.set(nebPos.getX(i), nebPos.getY(i), nebPos.getZ(i)).project(this.camera);
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      if (v.z < -1 || v.z > 1) continue;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = this.nebIds[i];
      }
    }
    const o = best >= 0 ? this.byId.get(best) ?? null : null;
    this.select(o);
  }

  private onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved = 0;
      this.idle = 0;
    } else if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      this.pinch0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.pinchMidX = (pts[0].x + pts[1].x) * 0.5;
      this.pinchMidY = (pts[0].y + pts[1].y) * 0.5;
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) * 0.5;
      const midY = (pts[0].y + pts[1].y) * 0.5;
      this.panLook(midX - this.pinchMidX, this.pinchMidY - midY);
      this.pinchMidX = midX;
      this.pinchMidY = midY;
      if (this.pinch0 > 0) {
        const ratio = d / this.pinch0;
        this.tgtRadius = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.tgtRadius / ratio));
        this.radius = this.tgtRadius;
      }
      this.pinch0 = d;
      this.moved += 4;
      this.idle = 0;
      return;
    }
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved += Math.hypot(dx, dy);
    this.tgtTheta -= dx * 0.005;
    this.tgtPhi = Math.max(0.08, Math.min(1.52, this.tgtPhi - dy * 0.005));
    this.theta = this.tgtTheta;
    this.phi = this.tgtPhi;
    this.idle = 0;
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch0 = 0;
    if (this.pointers.size === 0) {
      if (this.dragging && this.moved < 8) this.pick(e.clientX, e.clientY);
      this.dragging = false;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomToward(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0014));
    this.idle = 0;
  };

  private frame = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.idle += dt;
    if (!this.dragging && this.idle > 2.4 && this.radius > 20) this.tgtTheta += dt * 0.045;
    this.theta += (this.tgtTheta - this.theta) * (1 - Math.exp(-dt * 4.2));
    this.phi += (this.tgtPhi - this.phi) * (1 - Math.exp(-dt * 4.2));
    this.radius += (this.tgtRadius - this.radius) * (1 - Math.exp(-dt * 3.6));
    this.look.lerp(this.tgtLook, 1 - Math.exp(-dt * 3.2));
    this.applyCam();
    this.refreshIfNeeded();
    this.applyVis();
    if (this.selected && this.tgtRadius > PICK_ZOOM) this.select(null);
    const t = now * 0.001;
    this.starMat.uniforms.uTime.value = t;
    this.nebMat.uniforms.uTime.value = t;
    const px = this.renderer.getPixelRatio();
    this.starMat.uniforms.uPixel.value = px;
    this.nebMat.uniforms.uPixel.value = px;
    const resolve = clamp01((28 - this.radius) / 24);
    updateGalaxyField(this.fieldMat, this.camera, this.filter === 'all' ? 1 : 0.18, resolve);
    const ringS = Math.max(0.05, this.radius * 0.032);
    this.pickRing.scale.setScalar(ringS);
    this.homeRing.scale.setScalar(ringS);
    this.hereRing.scale.setScalar(ringS * 0.85);
    this.pickRing.rotation.z = t * 0.35;
    this.homeRing.rotation.z = -t * 0.12;
    this.hereRing.rotation.z = t * 0.2;
    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame?.({
      theta: this.theta,
      phi: this.phi,
      radius: this.radius,
      pickable: this.canPick(),
      resolved: this.resolved,
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function starRgb(o: GalaxyObject): [number, number, number] {
  if (o.star.phase === 'black_hole') return [0.35, 0.22, 0.55];
  if (o.star.phase === 'pulsar') return [0.75, 0.88, 1];
  if (o.star.phase === 'neutron_star') return [0.55, 0.7, 0.95];
  if (o.star.phase === 'white_dwarf') return teffToRgb(o.star.teff);
  return teffToRgb(o.star.teff);
}

function nebRgb(kind: GalaxyObject['star']['nebula']): [number, number, number] {
  if (kind === 'hii') return [1, 0.38, 0.62];
  if (kind === 'planetary') return [0.35, 0.95, 0.82];
  if (kind === 'snr') return [1, 0.62, 0.28];
  return [0.6, 0.6, 0.7];
}
