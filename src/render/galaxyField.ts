/**
 * The galaxy field: ONE integral for the distant backdrop.
 *
 * The region dive used to sketch the far disk with tens of thousands
 * of raymarched envelope sprites. Toward the core they stacked ~50×
 * deeper than toward the rim — the frame cost followed the stellar
 * density law instead of the screen. This pass replaces that stack
 * with a single full-screen march of the SAME laws (densityParts +
 * the gas/turbulence field), so the cost is fixed per pixel no
 * matter where you look. Envelope sprites survive only near the
 * magnification bubble (GALAXY_NEAR_ENVELOPES), where a nebula is
 * an object you are approaching, not a statistic.
 *
 * The march runs in catalog space from the bubble centre: directions
 * are preserved by the uniform magnifier, so the sky pattern matches
 * the sprites it replaces. It starts at the sample-ball radius —
 * the local catalog owns the inside. Rendered at reduced resolution
 * (GALAXY_FIELD_RES) and upsampled: the glow is low-frequency; stars
 * and near envelopes stay crisp on top.
 *
 * The turbulence here is the same absolute (unseeded) field the dust
 * sprites march — one cloudscape, two consumers.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';

const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

function marchFrag(): string {
  const U = UNIVERSE;
  const cot = 1 / Math.max(0.05, Math.tan(U.GALAXY_PITCH));
  const turbCeil = (1 + U.GALAXY_ARM_A) * Math.exp(U.GALAXY_TURB_SIGMA);
  return /* glsl */ `
  precision highp float;
  uniform vec3 uCenter;
  uniform mat3 uCamRot;
  uniform float uTanHalf;
  uniform float uAspect;
  varying vec2 vNdc;

  #define RD ${glslFloat(U.GALAXY_RD)}
  #define ZD ${glslFloat(U.GALAXY_ZD)}
  #define ARM_A ${glslFloat(U.GALAXY_ARM_A)}
  #define ARM_M ${glslFloat(U.GALAXY_ARM_M)}
  #define ARM_COT ${glslFloat(cot)}
  #define RD_THICK ${glslFloat(U.GALAXY_RD_THICK)}
  #define Z_THICK ${glslFloat(U.GALAXY_Z_THICK)}
  #define RE_BULGE ${glslFloat(U.GALAXY_RE_BULGE)}
  #define BAR_A ${glslFloat(U.GALAXY_BAR_A)}
  #define BAR_B ${glslFloat(U.GALAXY_BAR_B)}
  #define BAR_C ${glslFloat(U.GALAXY_BAR_C)}
  #define RD_GAS ${glslFloat(U.GALAXY_RD_GAS)}
  #define TURB_SIGMA ${glslFloat(U.GALAXY_TURB_SIGMA)}
  #define TURB_FREQ ${glslFloat(U.GALAXY_TURB_FREQ)}
  #define TURB_CEIL ${glslFloat(turbCeil)}
  #define R_BOUND ${glslFloat(U.GALAXY_R_MAX * 1.25)}
  #define T_NEAR ${glslFloat(U.GALAXY_REGION_R)}
  #define STEPS ${U.GALAXY_FIELD_STEPS}
  #define EXPOSURE ${glslFloat(U.GALAXY_FIELD_EXPOSURE)}
  #define DUST_TAU ${glslFloat(U.GALAXY_FIELD_TAU)}

  float fieldHash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  float fieldVnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = fieldHash(i);
    float n100 = fieldHash(i + vec3(1.0, 0.0, 0.0));
    float n010 = fieldHash(i + vec3(0.0, 1.0, 0.0));
    float n110 = fieldHash(i + vec3(1.0, 1.0, 0.0));
    float n001 = fieldHash(i + vec3(0.0, 0.0, 1.0));
    float n101 = fieldHash(i + vec3(1.0, 0.0, 1.0));
    float n011 = fieldHash(i + vec3(0.0, 1.0, 1.0));
    float n111 = fieldHash(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
      mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
      u.z) * 2.0 - 1.0;
  }

  float sech2f(float x) {
    float e = exp(clamp(x, -12.0, 12.0));
    float s = 2.0 / (e + 1.0 / e);
    return s * s;
  }

  void main() {
    vec3 dirView = normalize(vec3(vNdc.x * uTanHalf * uAspect, vNdc.y * uTanHalf, -1.0));
    vec3 rd = normalize(uCamRot * dirView);
    // Ray vs the galaxy bound (sphere at the galactic origin).
    float b = -dot(rd, uCenter);
    float cc = dot(uCenter, uCenter) - R_BOUND * R_BOUND;
    float h = b * b - cc;
    if (h <= 0.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    h = sqrt(h);
    float t0 = max(T_NEAR, b - h);
    float t1 = b + h;
    if (t1 <= t0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    float dt = (t1 - t0) / float(STEPS);
    // Per-pixel jitter hides march banding without a blur pass.
    float jit = fieldHash(vec3(vNdc * 617.0, 0.37));
    vec3 col = vec3(0.0);
    vec3 trans = vec3(1.0);
    for (int i = 0; i < STEPS; i++) {
      float t = t0 + (float(i) + jit) * dt;
      vec3 p = uCenter + rd * t;
      float R = length(p.xz);
      float zH = p.y;
      float phase = ARM_M * atan(p.z, p.x) - ARM_M * ARM_COT * log(max(R, 0.15) / RD);
      float crest = cos(phase);
      float armF = 1.0 + ARM_A * crest;
      float thin = exp(-R / RD) * sech2f(zH / ZD) * max(armF, 0.0);
      float thick = 0.14 * exp(-R / RD_THICK) * sech2f(zH / Z_THICK);
      float r3 = length(p);
      float bulge = 4.2 * exp(-3.5 * r3 / RE_BULGE);
      float rb2 = (p.x * p.x) / (BAR_A * BAR_A) + (p.z * p.z) / (BAR_B * BAR_B) + (zH * zH) / (BAR_C * BAR_C);
      float bar = rb2 < 1.0 ? 3.4 * pow(1.0 - rb2, 1.8) : 0.0;
      // Emission: the saucer's colour law as volume emissivity —
      // cream old light, golden bulge/bar, young blue + Ha on crests.
      float young = exp(-R / RD) * pow(0.12 + max(crest, 0.0), 2.6) * sech2f(zH / ZD);
      vec3 emiss =
        (thin + thick) * vec3(1.0, 0.87, 0.7) +
        (bulge + bar) * vec3(1.0, 0.8, 0.52) +
        young * (vec3(0.62, 0.75, 1.0) + vec3(1.0, 0.45, 0.5) * 0.35);
      // Dust: the gas disk × the same log-normal turbulence the dust
      // sprites march. Beer-Lambert; blue dies first (toy reddening).
      float gas = exp(-R / (RD * RD_GAS)) * sech2f(zH / ZD) * max(armF, 0.0);
      if (gas > 0.004) {
        float n = (fieldVnoise(p * TURB_FREQ) + 0.5 * fieldVnoise(p * TURB_FREQ * 2.3 + 31.7)) / 1.5;
        float rho = min(1.0, gas * exp(TURB_SIGMA * n) / TURB_CEIL);
        trans *= exp(-DUST_TAU * rho * dt * vec3(0.72, 1.0, 1.35));
      }
      col += trans * emiss * dt;
      if (trans.g < 0.02) break;
    }
    col *= EXPOSURE;
    // Photograph knee — hue survives, the core cannot clip to white.
    col = col / (1.0 + col);
    gl_FragColor = vec4(col, 1.0);
  }
`;
}

const MARCH_VERT = /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D uField;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(uField, vUv).rgb, 1.0);
  }
`;

function fullscreenTriangle(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  return geo;
}

export interface GalaxyField {
  /** Composite quad for the main scene. Toggle `visible` with the mode. */
  quad: THREE.Mesh;
  /** March the field into the low-res target. Call before the main render. */
  render(
    renderer: THREE.WebGLRenderer,
    camRot: THREE.Matrix3,
    centerCat: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
  ): void;
  setSize(w: number, h: number): void;
  dispose(): void;
}

export function createGalaxyField(): GalaxyField {
  const target = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const marchGeo = fullscreenTriangle();
  const marchMat = new THREE.ShaderMaterial({
    vertexShader: MARCH_VERT,
    fragmentShader: marchFrag(),
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uCamRot: { value: new THREE.Matrix3() },
      uTanHalf: { value: 0.5 },
      uAspect: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const marchScene = new THREE.Scene();
  const marchMesh = new THREE.Mesh(marchGeo, marchMat);
  marchMesh.frustumCulled = false;
  marchScene.add(marchMesh);
  const marchCam = new THREE.Camera();

  const quadGeo = fullscreenTriangle();
  const quadMat = new THREE.ShaderMaterial({
    vertexShader: COMPOSITE_VERT,
    fragmentShader: COMPOSITE_FRAG,
    uniforms: { uField: { value: target.texture } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(quadGeo, quadMat);
  quad.frustumCulled = false;
  quad.renderOrder = -10;
  quad.visible = false;

  return {
    quad,
    render(renderer, camRot, centerCat, camera): void {
      (marchMat.uniforms.uCamRot.value as THREE.Matrix3).copy(camRot);
      (marchMat.uniforms.uCenter.value as THREE.Vector3).copy(centerCat);
      marchMat.uniforms.uTanHalf.value = Math.tan((camera.fov * Math.PI) / 360);
      marchMat.uniforms.uAspect.value = camera.aspect;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(marchScene, marchCam);
      renderer.setRenderTarget(prev);
    },
    setSize(w: number, h: number): void {
      const res = UNIVERSE.GALAXY_FIELD_RES;
      target.setSize(Math.max(2, Math.round(w * res)), Math.max(2, Math.round(h * res)));
    },
    dispose(): void {
      target.dispose();
      marchGeo.dispose();
      marchMat.dispose();
      quadGeo.dispose();
      quadMat.dispose();
    },
  };
}
