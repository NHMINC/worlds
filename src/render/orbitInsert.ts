/**
 * Lock-on orbital insertion. The ship flies a TANGENT of the
 * chosen ring so the nose is already prograde at contact —
 * never a dive at the near face and a 90° slam on the shell
 * (that turn drove the ship into the body). Two tangents, two
 * senses: pick the one closer to the current heading (enter
 * on the other side when the near-side turn is the sharp one)
 * and latch that side until the dest changes.
 *
 * eyeToBody is eye→body on entry and eye→contact on exit.
 * outLook is the fly-to (the tangent itself).
 * u, v come back as contact radial and prograde.
 * Returns blend 0 (far transfer) … 1 (at the shell).
 */
import * as THREE from 'three';

export type InsertMode = 'inertial' | 'hang' | 'hover';

/** Perpendicular distance of a unit ray `dir` from the body (rel = eye→body). */
export function rayImpact(rel: THREE.Vector3, dir: THREE.Vector3): number {
  const cx = rel.y * dir.z - rel.z * dir.y;
  const cy = rel.z * dir.x - rel.x * dir.z;
  const cz = rel.x * dir.y - rel.y * dir.x;
  return Math.hypot(cx, cy, cz);
}

export function planOrbitInsert(
  eyeToBody: THREE.Vector3,
  r: number,
  normal: THREE.Vector3,
  mode: InsertMode,
  farRadii: number,
  outLook: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  fwd: THREE.Vector3,
  side: { sign: number },
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
    v.crossVectors(normal, fwd);
    if (v.lengthSq() < 1e-24) v.crossVectors(normal, eyeToBody);
    if (v.lengthSq() < 1e-24) v.set(1, 0, 0).cross(normal);
    u.copy(v);
  }
  u.normalize();
  v.crossVectors(normal, u);
  if (v.lengthSq() < 1e-24) v.set(1, 0, 0);
  v.normalize();

  const dPlane = Math.abs(-bx * u.x - by * u.y - bz * u.z);
  // Two contacts: the exterior tangents when outside the ring
  // cylinder, a short lead along the ring when already on or
  // inside it (a 90° chord from the near face would cut the
  // occupancy ball).
  let c = 0;
  let s = 0;
  if (dPlane > r * 1.000001) {
    const a = Math.acos(Math.min(1, r / dPlane));
    c = Math.cos(a);
    s = Math.sin(a);
  } else {
    const lead = 0.25;
    c = Math.cos(lead);
    s = Math.sin(lead);
  }

  const pick = pickSide(bx, by, bz, r, c, s, u, v, fwd, side.sign);
  side.sign = pick;
  // Contact on the ring: rotate nadir by ±α (or the short lead).
  const cu = c;
  const sv = pick * s;
  const tx = u.x * cu + v.x * sv;
  const ty = u.y * cu + v.y * sv;
  const tz = u.z * cu + v.z * sv;
  u.set(tx, ty, tz);
  v.crossVectors(normal, u);
  if (v.lengthSq() < 1e-24) v.set(1, 0, 0);
  v.normalize();

  // eye → contact = (body→contact) − (body→eye) = r·û + eye→body.
  eyeToBody.set(bx + r * u.x, by + r * u.y, bz + r * u.z);
  outLook.copy(eyeToBody);

  const remain = Math.max(0, d - r);
  const far = Math.max(r * farRadii, 1e-12);
  let blend = 1 - Math.min(1, remain / far);
  return blend * blend * (3 - 2 * blend);
}

/** +1 / −1: the tangent whose fly-to is closer to `fwd`. */
function pickSide(
  bx: number,
  by: number,
  bz: number,
  r: number,
  c: number,
  s: number,
  u: THREE.Vector3,
  v: THREE.Vector3,
  fwd: THREE.Vector3,
  latched: number,
): number {
  if (latched === 1 || latched === -1) return latched;
  const d0 = aimDot(bx, by, bz, r, c, s, u, v, fwd);
  const d1 = aimDot(bx, by, bz, r, c, -s, u, v, fwd);
  return d0 >= d1 ? 1 : -1;
}

function aimDot(
  bx: number,
  by: number,
  bz: number,
  r: number,
  c: number,
  sv: number,
  u: THREE.Vector3,
  v: THREE.Vector3,
  fwd: THREE.Vector3,
): number {
  const ax = bx + r * (u.x * c + v.x * sv);
  const ay = by + r * (u.y * c + v.y * sv);
  const az = bz + r * (u.z * c + v.z * sv);
  return ax * fwd.x + ay * fwd.y + az * fwd.z;
}
