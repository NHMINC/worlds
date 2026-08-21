/**
 * Cleanroom host solar system: Kepler ellipses + textured
 * spheres sized to each body's radius. Same clock as
 * `systemAt` — no RockyGlobe, no gas giant rings. The galaxy
 * explorer attaches this under the host root the moment a
 * sphere is entered; cruise / look / furnace stay in
 * `galaxyView`.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { keplerPlane, type BodySpec, type SystemSpec } from '../world/systemgen';

const AU_KM = UNIVERSE.AU_KM;
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

/** Shared unit sphere for cleanroom host balls. */
const BALL_GEO = new THREE.SphereGeometry(1, 32, 24);

/** Magenta = body is not on its Kepler ring (cleanroom diagnostic). */
const BALL_ON = new THREE.Color(0xffffff);
const BALL_OFF = new THREE.Color(0xff2a7a);

/** Latitude-band texture so each world reads as a ball, not a flat tint. */
function ballTexture(rgb: [number, number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  const [r, gv, b] = rgb.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
  g.fillStyle = `rgb(${r},${gv},${b})`;
  g.fillRect(0, 0, 64, 32);
  const dark = `rgb(${(r * 0.55) | 0},${(gv * 0.55) | 0},${(b * 0.55) | 0})`;
  const lite = `rgb(${Math.min(255, (r * 1.15) | 0)},${Math.min(255, (gv * 1.15) | 0)},${Math.min(255, (b * 1.15) | 0)})`;
  for (let y = 0; y < 32; y += 4) {
    g.fillStyle = y % 8 === 0 ? dark : lite;
    g.fillRect(0, y, 64, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.moveTo(32, 0);
  g.lineTo(32, 32);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeBall(rgb: [number, number, number]): THREE.Mesh {
  return new THREE.Mesh(
    BALL_GEO,
    new THREE.MeshLambertMaterial({ map: ballTexture(rgb), color: 0xffffff }),
  );
}

/**
 * Kilometres from `rel` (orbit-centre → body) to the Kepler ellipse
 * in the (orbX, orbY) plane. Out-of-plane height counts too.
 */
function keplerPathMissKm(
  rel: THREE.Vector3,
  orbX: THREE.Vector3,
  orbY: THREE.Vector3,
  aKm: number,
  ecc: number,
): number {
  const a = Math.max(aKm, 1e-9);
  const e = Math.min(Math.max(ecc, 0), 0.999);
  const bAxis = a * Math.sqrt(Math.max(0, 1 - e * e));
  const xo = rel.dot(orbX);
  const yo = rel.dot(orbY);
  const zo =
    rel.x * (orbX.y * orbY.z - orbX.z * orbY.y) +
    rel.y * (orbX.z * orbY.x - orbX.x * orbY.z) +
    rel.z * (orbX.x * orbY.y - orbX.y * orbY.x);
  let cosE = xo / a + e;
  let sinE = yo / Math.max(bAxis, 1e-18);
  const n = Math.hypot(cosE, sinE);
  if (n > 1e-12) {
    cosE /= n;
    sinE /= n;
  } else {
    cosE = 1;
    sinE = 0;
  }
  const ex = a * (cosE - e);
  const ey = bAxis * sinE;
  return Math.hypot(xo - ex, yo - ey, zo);
}

/** One body on the host clock — sphere + matching Kepler ring. */
export interface HostBodyRT {
  spec: BodySpec;
  group: THREE.Group;
  orbitLine: THREE.Line;
  /** Cleanroom stand-in (textured unit sphere). RockyGlobe later. */
  placeholder: THREE.Object3D | null;
  orbX: THREE.Vector3;
  orbY: THREE.Vector3;
  tiltQ: THREE.Quaternion;
  pos: THREE.Vector3;
  spinQ: THREE.Quaternion;
  /** Last paint: on the Kepler ring, or flagged off. */
  onOrbitPath: boolean;
}

/**
 * Procedural host solar system under a km-scaled root.
 * Build once from `systemAt`; tick with universe time.
 */
export class HostSystem {
  bodies: HostBodyRT[] = [];
  /** Outermost planet a (AU) — depth window for the host pass. */
  outerAu = 1;

  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  get(id: string | null | undefined): HostBodyRT | null {
    if (!id) return null;
    for (const rt of this.bodies) if (rt.spec.id === id) return rt;
    return null;
  }

  /**
   * Mint Kepler ellipses + textured spheres for every body.
   * Clears any previous pack first.
   */
  build(root: THREE.Group, spec: SystemSpec): void {
    this.clear(root);
    const byId = new Map<string, HostBodyRT>();
    let outer = 1;
    for (const b of spec.bodies) {
      if (!b.parent) outer = Math.max(outer, b.orbitRadius);
      const group = new THREE.Group();
      group.scale.setScalar(Math.max(b.radius, 1));
      const ball = makeBall(b.meanColor);
      group.add(ball);
      root.add(group);

      const orbX = new THREE.Vector3(1, 0, 0);
      const orbY = new THREE.Vector3(0, 1, 0);
      let tiltQ = new THREE.Quaternion();
      if (b.parent) {
        const parent = byId.get(b.parent);
        if (parent) {
          tiltQ = parent.tiltQ.clone();
          orbX.applyQuaternion(tiltQ);
          orbY.applyQuaternion(tiltQ);
        }
      } else {
        const m = new THREE.Matrix4()
          .makeRotationZ(b.node)
          .multiply(new THREE.Matrix4().makeRotationX(b.inc))
          .multiply(new THREE.Matrix4().makeRotationZ(b.peri));
        orbX.applyMatrix4(m);
        orbY.applyMatrix4(m);
        if (b.obliquity > 0) {
          tiltQ.setFromAxisAngle(
            new THREE.Vector3(Math.cos(b.axialAz), Math.sin(b.axialAz), 0),
            b.obliquity,
          );
        }
      }
      // Keep the in-plane basis orthonormal — a skewed basis
      // drew parallelogram "ellipses" with hard corners.
      orbX.normalize();
      orbY.addScaledVector(orbX, -orbY.dot(orbX)).normalize();

      const dispR = b.parent ? b.orbitRadius : b.orbitRadius * AU_KM;
      // Sagitta law: enough segments that the drawn ring stays
      // within a quarter body radius of the true ellipse. Sample
      // with the same keplerPlane closed form the body rides.
      const sagTol = Math.max(1, b.radius) * 0.25;
      const sagTheta = Math.sqrt((8 * sagTol) / Math.max(dispR, 1e-9));
      const segs = Math.min(
        8192,
        Math.max(256, Math.ceil((2 * Math.PI) / Math.max(sagTheta, 1e-4))),
      );
      const pts = new Float32Array((segs + 1) * 3);
      const P = Math.max(1e-6, b.orbitPeriod);
      for (let i = 0; i <= segs; i++) {
        const tSample = (i / segs) * P;
        const { xo, yo } = keplerPlane(b.orbitRadius, b.orbitPeriod, b.orbitPhase, b.ecc, tSample);
        const x = b.parent ? xo : xo * AU_KM;
        const y = b.parent ? yo : yo * AU_KM;
        pts[i * 3] = orbX.x * x + orbY.x * y;
        pts[i * 3 + 1] = orbX.y * x + orbY.y * y;
        pts[i * 3 + 2] = orbX.z * x + orbY.z * y;
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const orbitLine = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({
          color: 0xd4e4f8,
          transparent: true,
          opacity: b.parent ? UNIVERSE.HOST_ORBIT_MOON : UNIVERSE.HOST_ORBIT,
          depthTest: false,
          depthWrite: false,
        }),
      );
      orbitLine.renderOrder = 20;
      root.add(orbitLine);

      const rt: HostBodyRT = {
        spec: b,
        group,
        orbitLine,
        placeholder: ball,
        orbX,
        orbY,
        tiltQ,
        pos: new THREE.Vector3(),
        spinQ: new THREE.Quaternion(),
        onOrbitPath: true,
      };
      byId.set(b.id, rt);
      this.bodies.push(rt);
    }
    this.outerAu = outer;
  }

  clear(root: THREE.Group | null): void {
    for (const rt of this.bodies) {
      root?.remove(rt.group);
      root?.remove(rt.orbitLine);
      rt.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        // Shared BALL_GEO — do not dispose it.
        if (mesh.geometry && mesh.geometry !== BALL_GEO) mesh.geometry.dispose();
        const mat = mesh.material;
        const kill = (m: THREE.Material) => {
          const mapped = m as THREE.MeshLambertMaterial;
          if (mapped.map) mapped.map.dispose();
          m.dispose();
        };
        if (Array.isArray(mat)) for (const m of mat) kill(m);
        else if (mat) kill(mat);
      });
      rt.orbitLine.geometry.dispose();
      (rt.orbitLine.material as THREE.Material).dispose();
    }
    this.bodies = [];
    this.outerAu = 1;
  }

  /**
   * Pose every body on the Kepler clock. Magenta tint when a
   * ball cannot find itself on its ring (or a moon has no parent).
   */
  update(t: number, camera: THREE.Camera, root: THREE.Group | null): void {
    const byId = new Map<string, HostBodyRT>();
    for (const rt of this.bodies) byId.set(rt.spec.id, rt);
    for (const rt of this.bodies) {
      const b = rt.spec;
      const { xo, yo } = keplerPlane(b.orbitRadius, b.orbitPeriod, b.orbitPhase, b.ecc, t);
      let center: THREE.Vector3 | null = null;
      if (b.parent) {
        const parent = byId.get(b.parent);
        if (!parent) {
          this.paintBall(rt, false);
          continue;
        }
        center = parent.pos;
        rt.pos.set(
          parent.pos.x + rt.orbX.x * xo + rt.orbY.x * yo,
          parent.pos.y + rt.orbX.y * xo + rt.orbY.y * yo,
          parent.pos.z + rt.orbX.z * xo + rt.orbY.z * yo,
        );
        rt.orbitLine.position.copy(parent.pos);
      } else {
        rt.pos.set(
          (rt.orbX.x * xo + rt.orbY.x * yo) * AU_KM,
          (rt.orbX.y * xo + rt.orbY.y * yo) * AU_KM,
          (rt.orbX.z * xo + rt.orbY.z * yo) * AU_KM,
        );
      }

      if (b.tidallyLocked) {
        const parent = b.parent ? byId.get(b.parent) : null;
        if (parent) this.tmp2.copy(parent.pos).sub(rt.pos);
        else this.tmp2.copy(rt.pos).negate();
        this.tmp2.applyQuaternion(this.tmpQ.copy(rt.tiltQ).conjugate());
        const spin = Math.atan2(this.tmp2.y, this.tmp2.x);
        rt.spinQ.setFromAxisAngle(this.tmp.set(0, 0, 1), spin);
      } else {
        rt.spinQ.setFromAxisAngle(this.tmp.set(0, 0, 1), (2 * Math.PI * t) / b.spinPeriod);
      }
      rt.spinQ.premultiply(rt.tiltQ);
      rt.group.position.copy(rt.pos);
      rt.group.quaternion.copy(rt.spinQ);

      const aKm = b.parent ? b.orbitRadius : b.orbitRadius * AU_KM;
      if (center) this.tmp.copy(rt.pos).sub(center);
      else this.tmp.copy(rt.pos);
      const miss = keplerPathMissKm(this.tmp, rt.orbX, rt.orbY, aKm, b.ecc);
      const tol = Math.max(1, Math.max(b.radius, 1) * 0.05, aKm * 1e-6);
      this.paintBall(rt, miss <= tol);
    }
    root?.updateMatrixWorld(true);
    const cam = camera.position;
    for (const rt of this.bodies) {
      rt.group.getWorldPosition(this.tmp);
      const dSurfKm = cam.distanceTo(this.tmp) / KM_TO_KPC - rt.spec.radius;
      rt.orbitLine.visible = dSurfKm > rt.spec.radius * 3 + 2;
    }
  }

  private paintBall(rt: HostBodyRT, onPath: boolean): void {
    if (rt.onOrbitPath === onPath) return;
    rt.onOrbitPath = onPath;
    const mesh = rt.placeholder as THREE.Mesh | null;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshLambertMaterial;
    mat.color.copy(onPath ? BALL_ON : BALL_OFF);
  }
}
