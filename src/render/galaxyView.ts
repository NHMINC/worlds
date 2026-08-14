/**
 * The galaxy explorer: a viewer of the implicit catalog. Stars, remnants
 * and nebulae are objectAt samples. The disk, bar and bulge are the
 * density law sampled cheaper. Nothing here is a painted spiral.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import {
  collectCatalog,
  galToCart,
  homeStar,
  sampleDust,
  type GalaxyObject,
  type Population,
} from '../world/galaxy';
import { classifyStar, teffToRgb } from '../world/stellar';

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

const POP_RGB: Record<Population, [number, number, number]> = {
  thin: [0.42, 0.58, 0.92],
  thick: [0.55, 0.48, 0.78],
  bulge: [0.95, 0.72, 0.42],
  bar: [0.88, 0.62, 0.38],
  halo: [0.35, 0.4, 0.55],
};

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

const DUST_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aVis;
  uniform float uPixel;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(1.2, -mv.z);
    gl_PointSize = aSize * aVis * uPixel * (110.0 / dist);
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  uniform float uDim;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float a = exp(-r2 * 2.1) * 0.55 * uDim;
    gl_FragColor = vec4(vColor, a);
  }
`;

export interface GalaxyFrame {
  theta: number;
  phi: number;
  radius: number;
}

interface Callbacks {
  onSelect: (obj: GalaxyObject | null) => void;
  onFrame?: (f: GalaxyFrame) => void;
}

export class GalaxyView {
  readonly objects: GalaxyObject[];
  readonly home: GalaxyObject | null;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private callbacks: Callbacks;
  private disposed = false;
  private raf = 0;

  private starPts: THREE.Points;
  private nebPts: THREE.Points;
  private dustPts: THREE.Points;
  private visStar: THREE.BufferAttribute;
  private visNeb: THREE.BufferAttribute;
  private starMat: THREE.ShaderMaterial;
  private nebMat: THREE.ShaderMaterial;
  private dustMat: THREE.ShaderMaterial;
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
  private idle = 0;
  private filter: GalaxyFilter = 'all';
  private selected: GalaxyObject | null = null;
  private lastT = performance.now();

  constructor(canvas: HTMLCanvasElement, seed: string, callbacks: Callbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.objects = collectCatalog(seed);
    this.home = homeStar(seed);
    for (const o of this.objects) this.byId.set(o.id, o);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(new THREE.Color('#070b14'), 1);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.08, 400);

    this.scene.fog = new THREE.FogExp2(0x070b14, 0.0035);

    const dust = this.buildDust();
    this.dustPts = dust.pts;
    this.dustMat = dust.mat;
    this.scene.add(this.dustPts);

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
    this.raf = requestAnimationFrame(this.frame);
  }

  private hereObj: GalaxyObject | null = null;

  setHere(id: number | null): void {
    const o = id != null ? this.byId.get(id) : undefined;
    this.hereObj = o ?? null;
    if (!o) {
      this.hereRing.visible = false;
      return;
    }
    const c = galToCart(o.pos);
    this.hereRing.position.set(c.x, c.y, c.z);
    this.hereRing.visible = true;
  }

  setFilter(f: GalaxyFilter): void {
    this.filter = f;
    const starVis = this.visStar.array as Float32Array;
    for (let i = 0; i < this.ids.length; i++) {
      const o = this.byId.get(this.ids[i])!;
      starVis[i] = matchesFilter(o, f) ? 1 : 0;
    }
    this.visStar.needsUpdate = true;
    const nebVis = this.visNeb.array as Float32Array;
    for (let i = 0; i < this.nebIds.length; i++) {
      const o = this.byId.get(this.nebIds[i])!;
      nebVis[i] = matchesFilter(o, f) ? 1 : 0;
    }
    this.visNeb.needsUpdate = true;
    this.dustMat.uniforms.uDim.value = f === 'all' ? 1 : 0.35;
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
    for (const o of this.objects) {
      if (!matchesFilter(o, this.filter)) continue;
      const k = classifyStar(o.star).replace(/\+.*/, '').replace(/[0-9].*/, '');
      const letter = /^[OBAFGKMLT]/.test(k) ? k[0] : k;
      c[letter] = (c[letter] ?? 0) + 1;
    }
    return c;
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
    this.dustPts.geometry.dispose();
    this.starMat.dispose();
    this.nebMat.dispose();
    this.dustMat.dispose();
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

  private buildDust(): { pts: THREE.Points; mat: THREE.ShaderMaterial } {
    const samples = sampleDust(52000);
    const n = samples.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const vis = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      pos[i * 3] = s.x;
      pos[i * 3 + 1] = s.y;
      pos[i * 3 + 2] = s.z;
      const rgb = POP_RGB[s.pop];
      const b = Math.min(1.15, 0.35 + s.d * 0.7);
      col[i * 3] = rgb[0] * b;
      col[i * 3 + 1] = rgb[1] * b;
      col[i * 3 + 2] = rgb[2] * b;
      size[i] = 2.2 + Math.min(7, s.d * 4.5);
      vis[i] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aVis', new THREE.BufferAttribute(vis, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: { uPixel: { value: 1 }, uDim: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { pts: new THREE.Points(geo, mat), mat };
  }

  private buildStars(): {
    pts: THREE.Points;
    mat: THREE.ShaderMaterial;
    vis: THREE.BufferAttribute;
    ids: number[];
  } {
    const stars = this.objects.filter((o) => o.star.nebula === 'none' || o.star.phase === 'main_sequence' || o.star.phase === 'giant' || o.star.phase === 'supergiant' || o.star.phase === 'subgiant' || o.star.phase === 'wolf_rayet' || o.star.phase === 'carbon_star' || o.star.phase === 'brown_dwarf' || o.star.phase === 'white_dwarf' || o.star.phase === 'neutron_star' || o.star.phase === 'pulsar' || o.star.phase === 'black_hole');
    const n = stars.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const pulse = new Float32Array(n);
    const visArr = new Float32Array(n);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
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
      size[i] = 1.1 + Math.min(6.5, Math.log10(1 + L) * 2.4 + (o.star.phase === 'black_hole' ? 1.8 : 0));
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

  private pick(cx: number, cy: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = cx - rect.left;
    const y = cy - rect.top;
    let best = -1;
    let bestD = 14;
    const vis = this.visStar.array as Float32Array;
    const pos = this.starPts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.ids.length; i++) {
      if (vis[i] < 0.5) continue;
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
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.pinch0 > 0) {
        const ratio = d / this.pinch0;
        this.tgtRadius = Math.max(2.2, Math.min(70, this.tgtRadius / ratio));
        this.radius = this.tgtRadius;
      }
      this.pinch0 = d;
      this.moved += 4;
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
    const next = this.tgtRadius * Math.exp(e.deltaY * 0.0014);
    this.tgtRadius = Math.max(2.2, Math.min(70, next));
    this.idle = 0;
  };

  private frame = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.idle += dt;
    if (!this.dragging && this.idle > 2.4) this.tgtTheta += dt * 0.045;
    this.theta += (this.tgtTheta - this.theta) * (1 - Math.exp(-dt * 4.2));
    this.phi += (this.tgtPhi - this.phi) * (1 - Math.exp(-dt * 4.2));
    this.radius += (this.tgtRadius - this.radius) * (1 - Math.exp(-dt * 3.6));
    this.look.lerp(this.tgtLook, 1 - Math.exp(-dt * 3.2));
    this.applyCam();
    const t = now * 0.001;
    this.starMat.uniforms.uTime.value = t;
    this.nebMat.uniforms.uTime.value = t;
    const px = this.renderer.getPixelRatio();
    this.starMat.uniforms.uPixel.value = px;
    this.nebMat.uniforms.uPixel.value = px;
    this.dustMat.uniforms.uPixel.value = px;
    this.pickRing.rotation.z = t * 0.35;
    this.homeRing.rotation.z = -t * 0.12;
    this.hereRing.rotation.z = t * 0.2;
    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame?.({ theta: this.theta, phi: this.phi, radius: this.radius });
    this.raf = requestAnimationFrame(this.frame);
  };
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
