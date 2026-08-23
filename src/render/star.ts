/**
 * The star: its observable surface, drawn as a law. The disk is
 * a blackbody at the stellar clock's Teff (Stefan–Boltzmann
 * from L and R — the same colour law the catalog uses), shaded
 * by Eddington grey-atmosphere limb darkening, at the exact
 * photosphere radius the fences and parks are built from.
 * NOTHING draws past the surface — no corona shell, no glare
 * quad (those once drew light out beyond the hard wall, so a
 * correctly parked ship looked like it was inside the sun).
 * Granulation / spots / flares and a corona kept inside the
 * wall are later stages.
 *
 * The PointLight is the illumination law: lightColor,
 * inverse-square referenced at A_HAB.
 */
import * as THREE from 'three';
import { UNIVERSE, starTeff } from '../world/physics';
import type { StarSpec } from '../world/systemgen';

const PHOTO_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vN = normal;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Eddington–Barbier grey atmosphere: I = I0 (2/5 + 3/5 μ).
// Cooler photospheres carry more line opacity, so the limb
// coefficient walks up — one law, Teff as input. The centre
// sits above 1 and clips toward white; the limb keeps the
// Teff colour under the LDR.
const PHOTO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uCam;
uniform float uTeff;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(vN);
  vec3 view = normalize(uCam - vWorld);
  float mu = max(dot(n, view), 0.0);
  float uLD = mix(0.42, 0.68, clamp((6200.0 - uTeff) / 2800.0, 0.0, 1.0));
  float limb = (1.0 - uLD) + uLD * mu;
  vec3 hot = mix(uColor, vec3(1.0), 0.2 + 0.35 * clamp((uTeff - 3800.0) / 5000.0, 0.0, 1.0));
  vec3 c = mix(uColor, hot, mu) * (limb * 1.18);
  gl_FragColor = vec4(c, 1.0);
}
`;

const Z_AXIS = new THREE.Vector3(0, 0, 1);

export interface StarView {
  group: THREE.Group;
  light: THREE.PointLight;
  /** Photosphere radius drawn, km — the one truth to reconcile. */
  surfaceKm: number;
  /**
   * The sub-threshold highlight: a billboarded ring of fixed
   * ANGULAR size marking where the star is when its surface is
   * too small to see (a neutron star's park is thousands of
   * radii out; a far approach is sub-pixel for any star). The
   * locale hangs the class label (what it is) inside this group.
   */
  marker: THREE.Group;
  update(camPos: THREE.Vector3, time: number, airT: THREE.Vector3): void;
  dispose(): void;
}

export function makeStar(spec: StarSpec): StarView {
  const group = new THREE.Group();
  // The observable surface: the photosphere radius in km.
  // Floored at 1 km so a compact remnant still has a surface.
  const surfaceKm = Math.max(1, spec.radius);
  const color = new THREE.Color(spec.color);
  const mat = new THREE.ShaderMaterial({
    vertexShader: PHOTO_VERT,
    fragmentShader: PHOTO_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uCam: { value: new THREE.Vector3() },
      uTeff: { value: starTeff(spec.luminosity, spec.radius) },
    },
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(surfaceKm, 64, 48), mat);
  group.add(ball);

  // Marker law: the ring holds STAR_MARK_ANG on screen and turns
  // on when the surface subtends less than half of it — the ring
  // can never overlap a readable disk, and it hands off to the
  // disk on the way in. One law for a black hole at park and the
  // Sun mid-cruise.
  const marker = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x9fd8ff,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.94, 64), ringMat);
  ring.renderOrder = 30;
  marker.add(ring);
  marker.visible = false;
  group.add(marker);

  // Inverse-square: illuminance at A_HAB · AU_KM equals 2.5 for L=1.
  const dRef = UNIVERSE.A_HAB * UNIVERSE.AU_KM;
  const light = new THREE.PointLight(
    new THREE.Color(spec.lightColor),
    2.5 * dRef * dRef * spec.luminosity,
    0,
    2,
  );
  group.add(light);

  const camDir = new THREE.Vector3();

  return {
    group,
    light,
    surfaceKm,
    marker,
    update(camPos: THREE.Vector3): void {
      (mat.uniforms.uCam.value as THREE.Vector3).copy(camPos);
      const d = camPos.length();
      if (!(d > 0)) {
        marker.visible = false;
        return;
      }
      const angSurface = Math.asin(Math.min(1, surfaceKm / d));
      marker.visible = angSurface < UNIVERSE.STAR_MARK_ANG * 0.5;
      if (!marker.visible) return;
      marker.scale.setScalar(d * Math.tan(UNIVERSE.STAR_MARK_ANG));
      camDir.copy(camPos).multiplyScalar(1 / d);
      marker.quaternion.setFromUnitVectors(Z_AXIS, camDir);
    },
    dispose(): void {
      ball.geometry.dispose();
      mat.dispose();
      ring.geometry.dispose();
      ringMat.dispose();
    },
  };
}
