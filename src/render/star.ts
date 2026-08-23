/**
 * The star, for now, is its observable surface and nothing
 * else: one white sphere at the photosphere radius the physics
 * uses everywhere (the stellar clock's R, the same kilometres
 * the fences and parks are built from). No corona shell, no
 * glare quad — those drew light out to several radii, so a
 * ship correctly parked at 4.2 R still LOOKED like it was
 * inside the sun, and nobody could tell whether navigation or
 * drawing was wrong. Navigation first; the furnace look
 * returns later as a law.
 *
 * The PointLight stays — worlds still need their sun's light
 * (inverse-square, referenced at A_HAB).
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import type { StarSpec } from '../world/systemgen';

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
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
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
