/**
 * Hubble integral: unresolved starlight. The same mass model the
 * catalog drinks, sampled as a field — old spheroid warm, young
 * thin-disk cool, dust the same extinctT the pins march.
 *
 * Not a saucer. Colour is teffToRgb of the light-weighted
 * photospheres (UNIVERSE.GALAXY_GLOW_*_TEFF).
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { GALAXY_GLOW_GLSL } from '../world/galaxy';
import { teffToRgb } from '../world/stellar';

const GLOW_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const extinctGlow = () => /* glsl */ `
uniform float uExtinctK;
uniform float uExtinctMax;
uniform vec3 uDustRgb;
uniform sampler3D uDustVol;
uniform vec3 uDustOrigin;
uniform vec3 uDustInvSize;
float extinctRho(vec3 p) {
  vec3 uv = (p - uDustOrigin) * uDustInvSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.z < 0.0 ||
      uv.x > 1.0 || uv.y > 1.0 || uv.z > 1.0) return 0.0;
  return texture(uDustVol, uv).r;
}
vec3 extinctStepT(vec3 p, float dt) {
  float tau = extinctRho(p) * uExtinctK * dt;
  return exp(-tau * uDustRgb);
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
uniform vec3 uCenter;
uniform vec3 uVoid;
uniform float uGain;
uniform vec3 uOldRgb;
uniform vec3 uYoungRgb;
uniform float uRad;
uniform float uClumpRef;
uniform float uClumpVoid;

${GALAXY_GLOW_GLSL}
${extinctGlow()}

float glowClump(float rho) {
  float c = clamp(rho / max(uClumpRef, 1e-6), 0.0, 1.0);
  return uClumpVoid + (1.0 - uClumpVoid) * c;
}

bool sphHit(vec3 ro, vec3 rd, float rad, out float t0, out float t1) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float h = b * b - c;
  if (h < 0.0) return false;
  h = sqrt(h);
  t0 = -b - h;
  t1 = -b + h;
  return t1 > 0.0;
}

void main() {
  vec3 rd = normalize(vWorld);
  vec3 ro = uCenter;
  float t0, t1;
  if (!sphHit(ro, rd, uRad, t0, t1)) {
    gl_FragColor = vec4(uVoid, 1.0);
    return;
  }
  t0 = max(t0, 0.0);
  if (t1 <= t0) {
    gl_FragColor = vec4(uVoid, 1.0);
    return;
  }
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  // Face-on / tilt: the mass and the dust sheet live in a few
  // hundred pc of the warped midplane. A uniform march across the
  // bounding sphere skips them (dt ~ 0.7 kpc vs zd_gas = 0.12).
  // Newton from the y=0 guess onto y = gxMidplane. Edge-on
  // (|rd.y| small) keeps the long in-plane march.
  float ay = abs(rd.y);
  if (ay > 0.16) {
    float tHit = -ro.y / rd.y;
    for (int k = 0; k < 3; k++) {
      vec3 q = ro + rd * tHit;
      float z0 = gxMidplane(length(q.xz), atan(q.z, q.x));
      tHit += (z0 - q.y) / rd.y;
    }
    float span = ${UNIVERSE.GALAXY_WARP_Z + UNIVERSE.GALAXY_CORRUGATE + 3.2} / ay;
    float w0 = max(t0, tHit - span);
    float w1 = min(t1, tHit + span);
    if (w1 > w0) {
      t0 = w0;
      t1 = w1;
    }
  }
  const int STEPS = ${UNIVERSE.GALAXY_GLOW_STEPS};
  float dt = (t1 - t0) / float(STEPS);
  vec3 col = vec3(0.0);
  vec3 T = vec3(1.0);
  float t = t0 + jit * dt;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (t + 0.5 * dt);
    vec2 L = gxGlow(p);
    float rho = extinctRho(p);
    vec3 emit = L.x * uOldRgb + L.y * glowClump(rho) * uYoungRgb;
    col += T * emit * dt * uGain;
    T *= extinctStepT(p, dt);
    t += dt;
    if (max(T.r, max(T.g, T.b)) < 0.02) break;
  }
  vec3 rgb = uVoid + (vec3(1.0) - exp(-col));
  gl_FragColor = vec4(rgb, 1.0);
}
`;

export function glowBoundingRadius(): number {
  const r = UNIVERSE.GALAXY_R_MAX;
  const z = UNIVERSE.GALAXY_Z_THICK * 4 + UNIVERSE.GALAXY_WARP_Z;
  return Math.hypot(r, z) * 1.12;
}

function glowChroma(rgb: [number, number, number], sat: number): [number, number, number] {
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const ch = (c: number) => Math.min(1, Math.max(0, lum + sat * (c - lum)));
  return [ch(rgb[0]), ch(rgb[1]), ch(rgb[2])];
}

export function makeGalaxyGlowMaterial(
  dust: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  const oldRgb = glowChroma(teffToRgb(UNIVERSE.GALAXY_GLOW_OLD_TEFF), UNIVERSE.GALAXY_GLOW_SAT);
  const youngRgb = glowChroma(teffToRgb(UNIVERSE.GALAXY_GLOW_YOUNG_TEFF), UNIVERSE.GALAXY_GLOW_SAT);
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uVoid: { value: new THREE.Color('#070b14') },
      uGain: { value: UNIVERSE.GALAXY_GLOW_GAIN },
      uOldRgb: { value: new THREE.Vector3(...oldRgb) },
      uYoungRgb: { value: new THREE.Vector3(...youngRgb) },
      uRad: { value: glowBoundingRadius() },
      uClumpRef: { value: UNIVERSE.GALAXY_GLOW_CLUMP_REF },
      uClumpVoid: { value: UNIVERSE.GALAXY_GLOW_CLUMP_VOID },
      uExtinctK: dust.uExtinctK,
      uExtinctMax: dust.uExtinctMax,
      uDustRgb: dust.uDustRgb,
      uDustVol: dust.uDustVol,
      uDustOrigin: dust.uDustOrigin,
      uDustInvSize: dust.uDustInvSize,
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
}

export function makeGalaxyGlowMesh(mat: THREE.ShaderMaterial): THREE.Mesh {
  const far = UNIVERSE.GALAXY_R_MAX * 8 * 0.92;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(far, 48, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -3;
  return mesh;
}
