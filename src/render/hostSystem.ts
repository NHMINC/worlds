/**
 * Host Kepler clock: ellipses + a group per body, scaled to
 * radius. RockyGlobe grows the terrace on rocky groups; gas
 * uses the chemistry mesh. No stand-in Lambert balls — those
 * were orbit-building scaffolding. Cruise / look / furnace
 * stay in `galaxyView`.
 */
import * as THREE from 'three';
import { UNIVERSE, starIrradiance, starIrradianceDisplay } from '../world/physics';
import { keplerPlane, type BodySpec, type SystemSpec } from '../world/systemgen';
import { makeGasGiant } from './gasGiant';

const AU_KM = UNIVERSE.AU_KM;
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

/** One body on the host clock — group + matching Kepler ring. */
export interface HostBodyRT {
  spec: BodySpec;
  group: THREE.Group;
  orbitLine: THREE.Line;
  /** Gas chemistry mesh, if this body is a giant. */
  gasMat: THREE.ShaderMaterial | null;
  orbX: THREE.Vector3;
  orbY: THREE.Vector3;
  tiltQ: THREE.Quaternion;
  pos: THREE.Vector3;
  spinQ: THREE.Quaternion;
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
   * Mint Kepler ellipses for every body. Rocky groups stay
   * empty until RockyGlobe attaches; gas gets its own mesh.
   */
  build(root: THREE.Group, spec: SystemSpec): void {
    this.clear(root);
    const byId = new Map<string, HostBodyRT>();
    let outer = 1;
    for (const b of spec.bodies) {
      if (!b.parent) outer = Math.max(outer, b.orbitRadius);
      const group = new THREE.Group();
      group.scale.setScalar(Math.max(b.radius, 1));
      let gasMat: THREE.ShaderMaterial | null = null;
      if (b.kind === 'gas' && b.gas) {
        const gas = makeGasGiant(b.gas);
        group.add(gas.group);
        gasMat = gas.material;
      }
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
        gasMat,
        orbX,
        orbY,
        tiltQ,
        pos: new THREE.Vector3(),
        spinQ: new THREE.Quaternion(),
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
        if (mesh.geometry) mesh.geometry.dispose();
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

  /** Pose every body on the Kepler clock. */
  update(t: number, camera: THREE.Camera, root: THREE.Group | null, L = 1): void {
    const byId = new Map<string, HostBodyRT>();
    for (const rt of this.bodies) byId.set(rt.spec.id, rt);
    for (const rt of this.bodies) {
      const b = rt.spec;
      const { xo, yo } = keplerPlane(b.orbitRadius, b.orbitPeriod, b.orbitPhase, b.ecc, t);
      if (b.parent) {
        const parent = byId.get(b.parent);
        if (!parent) continue;
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
      if (rt.gasMat) {
        const lightL = this.tmp
          .copy(rt.pos)
          .multiplyScalar(-1)
          .normalize()
          .applyQuaternion(this.tmpQ.copy(rt.spinQ).conjugate());
        (rt.gasMat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
        const aPhys = Math.max(rt.pos.length() / AU_KM, 0.02);
        rt.gasMat.uniforms.uSunIrr.value = starIrradianceDisplay(starIrradiance(L, aPhys));
      }
    }
    root?.updateMatrixWorld(true);
    const cam = camera.position;
    for (const rt of this.bodies) {
      rt.group.getWorldPosition(this.tmp);
      const dSurfKm = cam.distanceTo(this.tmp) / KM_TO_KPC - rt.spec.radius;
      rt.orbitLine.visible = dSurfKm > rt.spec.radius * 3 + 2;
    }
  }
}
