/**
 * The Hubble layer: the mass model evaluated on the GPU. Surface brightness
 * is the integrated light of the whole stellar population — that is how
 * a phone shows ~10¹¹ stars. Cost is pixels × steps, not a point per star.
 *
 * Young light traces the arm crests (O/B live there); dust lanes sit on
 * the inner edge of the shock. That is why a face-on view reads as a
 * grand-design spiral, not a uniform disk. Not a painted texture.
 *
 * The ISM is supersonically turbulent, so every smooth law here is
 * modulated by a log-normal field: ρ = ρ̄·exp(σ·s), s an fBm octave
 * pair. The same clumps carry three consequences at once — knotted
 * young light, Hα (pink) where a clump sits on the crest with hot
 * stars inside it, and fractal dust that *reddens* what shines
 * through (per-channel transmittance), which is why the lanes read
 * brown against the golden bulge instead of grey.
 *
 * The field is ONLY the integral. Individual stars are catalog rows
 * (objectsNear → beacons and photospheres in galaxyView); hash-noise
 * sparkle and sampled "grain" points were a painted starfield — dots
 * that swam with the camera and could never be tapped — and they are
 * gone. Only real procedural addresses resolve around the camera.
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
  uniform float uSteps;
  uniform float uTurbS;
  uniform float uTurbF;
  uniform vec3 uDustRGB;
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

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  // Two octaves of a Kolmogorov-ish cascade, zero-mean.
  float fbm(vec3 p) {
    return 0.64 * vnoise(p) + 0.36 * vnoise(p * 2.63 + 17.7) - 0.5;
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
    if (hit.y < max(hit.x, 0.0)) discard;

    float t0 = max(hit.x, 0.0);
    float t1 = hit.y;
    float dt = (t1 - t0) / uSteps;
    vec3 acc = vec3(0.0);
    // Per-channel transmittance: dust reddens, it does not just dim.
    vec3 trans = vec3(1.0);

    for (int i = 0; i < 44; i++) {
      if (float(i) >= uSteps) break;
      if (trans.g < 0.02) break;
      float t = t0 + (float(i) + 0.5) * dt;
      vec3 p = uCam + rd * t;
      float R = length(p.xz);
      float z = p.y;
      float theta = atan(p.z, p.x);
      float r = length(p);
      float phase = armPhase(R, theta);
      float crest = max(0.0, cos(phase));
      float lane = smoothstep(0.05, 0.72, sin(phase));

      // Log-normal turbulent ISM: one clump field, three consequences.
      float s = fbm(p * uTurbF);
      float clump = exp(uTurbS * s);
      float sFine = fbm(p * uTurbF * 3.1 + 47.3);

      float thinMass = exp(-R / uRd) * sech2(z / uZd) * (1.0 + uArmA * cos(phase));
      // Young light lives on the crest — Hubble arms are light, not mass —
      // and it is born inside gas clumps, so it inherits their knots.
      float young = exp(-R / uRd) * sech2(z / uZd) * pow(0.12 + crest, 2.6) * clump;
      float thick = 0.14 * exp(-R / uRdThick) * sech2(z / uZthick);
      float bulge = 4.2 * exp(-3.5 * (r / uRe));
      float rb2 = (p.x * p.x) / (uBarA * uBarA) + (p.z * p.z) / (uBarB * uBarB) + (z * z) / (uBarC * uBarC);
      float bar = rb2 < 1.0 ? 3.4 * pow(1.0 - rb2, 1.8) : 0.0;
      float halo = 0.03 / pow(1.0 + r / uHaloA, 3.2);

      // H II: a dense clump on the crest with hot stars inside ionises.
      // Strömgren-style — needs both the gas (clump) and the O stars
      // (young). Tight threshold: beads along the arm, not a pink arm.
      float hii = smoothstep(0.85, 2.1, clump * (0.35 + 0.65 * crest)) * crest;

      vec3 gold = vec3(1.0, 0.72, 0.38);
      vec3 warm = vec3(0.95, 0.85, 0.66);
      vec3 blue = vec3(0.45, 0.68, 1.0);
      vec3 halpha = vec3(1.0, 0.30, 0.44);
      vec3 emit = vec3(0.0);
      emit += bulge * gold * 2.0;
      emit += bar * gold * 1.35;
      // The old disk shines too — the smooth luminous sheet the arms
      // are embroidered on. Without it the galaxy is a skeleton.
      emit += thinMass * warm * 0.5;
      emit += young * blue * 1.5;
      emit += young * halpha * hii * 2.3;
      emit += thick * vec3(0.55, 0.48, 0.7) * 0.22;
      emit += halo * vec3(0.4, 0.46, 0.65) * 0.12;

      // Fractal dust filaments on the inner edge of the shock. The fine
      // octave breaks the lane into the brown threads a photograph has.
      float filament = smoothstep(-0.18, 0.32, sFine + 0.45 * s);
      float dust = lane * clamp(thinMass * 1.6, 0.0, 1.4) * (0.2 + 1.2 * filament) * clump;
      // Self-extinction of light born at this step (half its own column).
      emit *= exp(-dust * uDustRGB * 0.6);

      float dens = (bulge + bar + young * 0.8 + thick * 0.3) * 0.55 + dust * 0.8;
      acc += trans * emit * dt * 1.65;
      trans *= exp(-(dens * uDustRGB * 0.6 + dens * 0.55) * dt * 1.15);
    }

    acc *= uDim * mix(1.0, 0.62, uResolve);
    // Hue-preserving Reinhard: the core saturates toward its own gold,
    // not toward clipped white.
    float lum = dot(acc, vec3(0.299, 0.587, 0.114));
    acc /= 1.0 + lum * 0.28;
    float tAvg = (trans.r + trans.g + trans.b) / 3.0;
    float a = clamp(max(1.0 - tAvg, length(acc) * 0.35), 0.0, 1.0);
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
      uSteps: { value: 44 },
      uTurbS: { value: UNIVERSE.GALAXY_TURB_SIGMA },
      uTurbF: { value: UNIVERSE.GALAXY_TURB_FREQ },
      uDustRGB: { value: new THREE.Vector3(...UNIVERSE.GALAXY_DUST_RGB) },
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
  steps = 44,
): void {
  camera.updateMatrixWorld();
  mat.uniforms.uCam.value.copy(camera.position);
  mat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
  mat.uniforms.uInvView.value.copy(camera.matrixWorld);
  mat.uniforms.uDim.value = dim;
  mat.uniforms.uResolve.value = resolve;
  mat.uniforms.uSteps.value = Math.max(4, Math.min(44, steps));
}
