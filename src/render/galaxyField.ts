/**
 * The Hubble layer: the mass model evaluated on the GPU. Surface brightness
 * is the integrated light of the whole stellar population — that is how
 * a phone shows ~10¹¹ stars. Cost is pixels × steps, not a point per star.
 *
 * Young light traces the arm crests (O/B live there); dust lanes sit on
 * the inner edge of the shock. That is why a face-on view reads as a
 * grand-design spiral, not a uniform disk. Not a painted texture.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uCam;
  uniform mat4 uInvProj;
  uniform mat4 uInvView;
  uniform float uDim;
  uniform float uRd;
  uniform float uRmax;
  uniform float uZd;
  uniform float uZthick;
  uniform float uRdThick;
  uniform float uRe;
  uniform float uBarA;
  uniform float uBarB;
  uniform float uBarC;
  uniform float uArmM;
  uniform float uPitch;
  uniform float uArmA;
  uniform float uHaloA;
  uniform float uResolve;
  varying vec2 vUv;

  float sech2(float x) {
    float e = exp(clamp(x, -12.0, 12.0));
    float s = 2.0 / (e + 1.0 / e);
    return s * s;
  }

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float armPhase(float R, float theta) {
    float cot = 1.0 / max(0.05, tan(uPitch));
    return uArmM * theta - uArmM * cot * log(max(R, 0.15) / uRd);
  }

  vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
    vec3 inv = 1.0 / rd;
    vec3 t1 = (bmin - ro) * inv;
    vec3 t2 = (bmax - ro) * inv;
    vec3 tmn = min(t1, t2);
    vec3 tmx = max(t1, t2);
    float t0 = max(max(tmn.x, tmn.y), tmn.z);
    float t1b = min(min(tmx.x, tmx.y), tmx.z);
    return vec2(t0, t1b);
  }

  vec3 rayDir() {
    vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec4 world = uInvView * (uInvProj * clip);
    vec3 pw = world.xyz / max(abs(world.w), 1e-6);
    return normalize(pw - uCam);
  }

  void main() {
    vec3 rd = rayDir();
    vec3 bmin = vec3(-uRmax * 1.25, -uZthick * 8.0, -uRmax * 1.25);
    vec3 bmax = -bmin;
    vec2 hit = boxHit(uCam, rd, bmin, bmax);
    if (hit.y < max(hit.x, 0.0)) {
      float sky = hash13(rd * 380.0);
      if (sky > 0.997) {
        gl_FragColor = vec4(vec3(0.8, 0.86, 1.0) * 0.45, 0.45);
      } else {
        discard;
      }
      return;
    }

    float t0 = max(hit.x, 0.0);
    float t1 = hit.y;
    float dt = (t1 - t0) / 40.0;
    vec3 acc = vec3(0.0);
    float trans = 1.0;

    for (int i = 0; i < 40; i++) {
      if (trans < 0.02) break;
      float t = t0 + (float(i) + 0.5) * dt;
      vec3 p = uCam + rd * t;
      float R = length(p.xz);
      float z = p.y;
      float theta = atan(p.z, p.x);
      float r = length(p);
      float phase = armPhase(R, theta);
      float crest = max(0.0, cos(phase));
      float lane = smoothstep(0.05, 0.72, sin(phase));

      float thinMass = exp(-R / uRd) * sech2(z / uZd) * (1.0 + uArmA * cos(phase));
      // Young light lives on the crest — Hubble arms are light, not mass.
      float young = exp(-R / uRd) * sech2(z / uZd) * pow(0.12 + crest, 2.6);
      float thick = 0.14 * exp(-R / uRdThick) * sech2(z / uZthick);
      float bulge = 4.2 * exp(-3.5 * (r / uRe));
      float rb2 = (p.x * p.x) / (uBarA * uBarA) + (p.z * p.z) / (uBarB * uBarB) + (z * z) / (uBarC * uBarC);
      float bar = rb2 < 1.0 ? 3.4 * pow(1.0 - rb2, 1.8) : 0.0;
      float halo = 0.03 / pow(1.0 + r / uHaloA, 3.2);

      vec3 gold = vec3(1.0, 0.72, 0.38);
      vec3 blue = vec3(0.45, 0.68, 1.0);
      vec3 pink = vec3(1.0, 0.42, 0.62);
      vec3 emit = vec3(0.0);
      emit += bulge * gold * 2.4;
      emit += bar * gold * 1.35;
      emit += young * (blue * 1.15 + pink * pow(crest, 3.0) * 0.95);
      emit += thick * vec3(0.55, 0.48, 0.7) * 0.22;
      emit += halo * vec3(0.4, 0.46, 0.65) * 0.12;
      float extinct = 1.0 - 0.82 * lane * clamp(thinMass * 1.4, 0.0, 1.0);
      emit *= extinct;

      // Close in, the integral breaks into sparkle — the IMF tail resolving,
      // not stored rows. Face-on stays a smooth Hubble glow.
      float grid = mix(18.0, 86.0, uResolve);
      float h = hash13(floor(p * grid + 0.5));
      float rare = mix(0.0016, 0.038, uResolve) * (young * 4.0 + bulge * 1.6 + bar);
      if (h > 1.0 - rare) {
        emit += vec3(1.0, 0.93, 0.82) * mix(14.0, 6.5, uResolve) * (h - (1.0 - rare)) / max(rare, 1e-5);
      }
      emit *= mix(1.0, 0.58, uResolve);

      float dens = (bulge + bar + young + thick * 0.3) * dt * 0.55;
      acc += trans * emit * dt * 1.65;
      trans *= exp(-dens * 1.15);
    }

    float sky = hash13(rd * 400.0);
    if (sky > 0.996) acc += vec3(0.85, 0.9, 1.0) * 0.55;

    acc *= uDim;
    float a = clamp(max(1.0 - trans, length(acc) * 0.35), 0.0, 1.0);
    gl_FragColor = vec4(acc, a);
  }
`;

export function createGalaxyField(): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uDim: { value: 1 },
      uRd: { value: UNIVERSE.GALAXY_RD },
      uRmax: { value: UNIVERSE.GALAXY_R_MAX },
      uZd: { value: UNIVERSE.GALAXY_ZD },
      uZthick: { value: UNIVERSE.GALAXY_Z_THICK },
      uRdThick: { value: UNIVERSE.GALAXY_RD_THICK },
      uRe: { value: UNIVERSE.GALAXY_RE_BULGE },
      uBarA: { value: UNIVERSE.GALAXY_BAR_A },
      uBarB: { value: UNIVERSE.GALAXY_BAR_B },
      uBarC: { value: UNIVERSE.GALAXY_BAR_C },
      uArmM: { value: UNIVERSE.GALAXY_ARM_M },
      uPitch: { value: UNIVERSE.GALAXY_PITCH },
      uArmA: { value: UNIVERSE.GALAXY_ARM_A },
      uHaloA: { value: UNIVERSE.GALAXY_HALO_A },
      uResolve: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, mat };
}

export function updateGalaxyField(
  mat: THREE.ShaderMaterial,
  camera: THREE.PerspectiveCamera,
  dim = 1,
  resolve = 0,
): void {
  camera.updateMatrixWorld();
  mat.uniforms.uCam.value.copy(camera.position);
  mat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
  mat.uniforms.uInvView.value.copy(camera.matrixWorld);
  mat.uniforms.uDim.value = dim;
  mat.uniforms.uResolve.value = resolve;
}
