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

export interface StarView {
  group: THREE.Group;
  light: THREE.PointLight;
  /** Photosphere radius drawn, km — the one truth to reconcile. */
  surfaceKm: number;
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

  // Inverse-square: illuminance at A_HAB · AU_KM equals 2.5 for L=1.
  const dRef = UNIVERSE.A_HAB * UNIVERSE.AU_KM;
  const light = new THREE.PointLight(
    new THREE.Color(spec.lightColor),
    2.5 * dRef * dRef * spec.luminosity,
    0,
    2,
  );
  group.add(light);

  return {
    group,
    light,
    surfaceKm,
    update(): void {
      // A bare surface has nothing to animate.
    },
    dispose(): void {
      ball.geometry.dispose();
      mat.dispose();
    },
  };
}
