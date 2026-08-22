/**
 * Lock-on orbital insertion. The ship does not dive at a core and
 * pretend: the fly-to point slides forward along the chosen ring
 * so the nose (forward under autopilot) yaws onto prograde as the
 * shell is reached. Hover is the exception — it aims the hang
 * face and looks at the full sphere.
 *
 * eyeToBody is eye→body on entry and eye→aim on exit.
 * outLook is the desired nose (matches aim for inertial approach;
 * hang / hover look at the body).
 * Returns blend 0 (far transfer) … 1 (at the shell).
 */
import * as THREE from 'three';

export type InsertMode = 'inertial' | 'hang' | 'hover';

export function planOrbitInsert(
  eyeToBody: THREE.Vector3,
  r: number,
  normal: THREE.Vector3,
  mode: InsertMode,
  farRadii: number,
  outLook: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
): number {
  const bx = eyeToBody.x;
  const by = eyeToBody.y;
  const bz = eyeToBody.z;
  const d = Math.hypot(bx, by, bz);
  if (!(d > 1e-18) || !(r > 0)) {
    outLook.copy(eyeToBody);
    return 0;
  }

  // Hover: sit on the radial hang face, nose into the sphere.
  if (mode === 'hover' || mode === 'hang') {
    const s = d > r * 1.001 ? 1 - r / d : 0;
    eyeToBody.set(bx * s, by * s, bz * s);
    outLook.set(bx, by, bz);
    const remain = Math.max(0, d - r);
    const far = Math.max(r * farRadii, 1e-12);
    let blend = 1 - Math.min(1, remain / far);
    return blend * blend * (3 - 2 * blend);
  }

  // In-plane unit from body toward the eye (nadir azimuth).
  u.set(-bx, -by, -bz);
  u.addScaledVector(normal, -u.dot(normal));
  if (u.lengthSq() < 1e-24) {
    v.crossVectors(normal, eyeToBody);
    if (v.lengthSq() < 1e-24) v.set(1, 0, 0).cross(normal);
    u.copy(v);
  }
  u.normalize();
  // Prograde in the plane.
  v.crossVectors(normal, u);
  if (v.lengthSq() < 1e-24) v.set(1, 0, 0);
  v.normalize();

  const remain = Math.max(0, d - r);
  const far = Math.max(r * farRadii, 1e-12);
  let blend = 1 - Math.min(1, remain / far);
  blend = blend * blend * (3 - 2 * blend);

  // Aim point on the ring slides from nadir (φ=0) toward a
  // quarter-orbit lead (φ=π/2). From outside, eye→I starts as
  // "in to the near-side shell" and becomes prograde at contact.
  const phi = blend * Math.PI * 0.5;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  eyeToBody.set(
    bx + r * (u.x * cp + v.x * sp),
    by + r * (u.y * cp + v.y * sp),
    bz + r * (u.z * cp + v.z * sp),
  );
  outLook.copy(eyeToBody);
  return blend;
}
