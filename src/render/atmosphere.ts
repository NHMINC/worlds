import * as THREE from 'three';
import { UNIVERSE, type RGB } from '../world/physics';
import { AIR_SCATTER_GLSL, AIR_UNIFORMS_GLSL } from './scattering';

/**
 * Atmosphere rendering, driven entirely by the physics model:
 *
 * The SKY SHELL owns every view ray that crosses the air without striking
 * the globe (rays that hit terrain or sea integrate the same scattering
 * law in their own shaders). One integral, any viewpoint: from orbit it is
 * the blue limb, from the ground it is the sky. Cloud aerosols are part of
 * the same integral (physics.airExtinction folds them into sigma), so a
 * hothouse hides its surface because tau says so, not because a deck is
 * painted over it.
 */

const ATMO_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vNormal = normalize(position);
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Shared ray setup + scattering march for both shell passes.
const SKY_COMMON = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;   // body-local, unit planet radius
uniform vec3 uLightDir; // body-local
uniform float uTopR;    // shell top radius
uniform float uFloorR;  // bedrock floor: the lowest surface the mesh is guaranteed to draw
${AIR_UNIFORMS_GLSL}
varying vec3 vPos;
${AIR_SCATTER_GLSL}
// Marches the shell segment of this pixel's ray. Returns in-scattered
// light; tau is the per-channel optical depth; discards rays the shell
// does not own (missed the air, or struck ground that fogs itself).
// The hand-off test uses the BEDROCK sphere, not the nominal radius 1:
// valley floors and dry basins sit well below 1, so a ray can dip under
// the unit sphere yet strike no drawn surface at all — discarding those
// used to punch a black landform-shaped void between ground and sky.
// The sea writes depth (terraceMesh water) so ocean pixels still occlude
// this shell; a sea-sphere test here would open a black gap wherever the
// tessellated water mesh sags inside the mathematical sphere.
vec3 skyRay(out vec3 tau) {
  vec3 rd = normalize(vPos - uCamPos);
  float b = dot(uCamPos, rd);
  float cc = dot(uCamPos, uCamPos);
  float disc = b * b - (cc - uTopR * uTopR);
  if (disc <= 0.0) discard;
  float s = sqrt(disc);
  float t0 = max(-b - s, 0.0);
  float t1 = -b + s;
  float discP = b * b - (cc - uFloorR * uFloorR);
  if (discP > 0.0 && -b - sqrt(discP) > 0.0) discard;
  return airScatter(uCamPos + rd * t0, uCamPos + rd * t1, uLightDir, tau);
}
`;

// PASS 1 — extinction: multiplies whatever lies beyond (stars, the sun,
// other worlds) by the path's PER-CHANNEL transmittance. This is where a
// setting sun bleeds red: blue optical depth kills its blue long before
// its red — a scalar alpha could never do that. The exp veil is contrast
// masking: an LDR display cannot span the true ratio between scattered
// sunlight and starlight, so bright air additionally hides what is behind
// it — stars vanish into the noon blue and return through night air.
const SKY_EXT_FRAG = /* glsl */ `
${SKY_COMMON}
void main() {
  vec3 tau;
  vec3 sky = skyRay(tau);
  float veil = exp(-4.0 * dot(sky, vec3(1.0 / 3.0)));
  gl_FragColor = vec4(exp(-tau) * veil, 1.0);
}
`;

// PASS 2 — in-scatter: adds what the air itself sends toward the camera.
// Together the passes are the volume rendering equation, split across two
// blends because hardware carries only one alpha channel. The headlamp's
// beam belongs here too: sky rays inside the cone pick up the lamp light
// the air scatters back, so a beam raised toward a foggy night sky glows —
// and a clear one stays invisible.
const SKY_GLOW_FRAG = /* glsl */ `
${SKY_COMMON}
uniform vec3 uSunColor;
void main() {
  vec3 tau;
  // In-scatter is SUNLIGHT the air redirects: it carries the
  // star's spectrum. The torch is the ship's own lamp — white.
  vec3 sky = skyRay(tau) * uSunColor;
  sky += torchGlow(uCamPos, vPos);
  gl_FragColor = vec4(sky, 1.0);
}
`;

export interface AirSpec {
  sigma: number;
  scaleH: number;
  /** Chapman curvature 2H/(pi*R) of the real planet (physics.airExtinction). */
  curve: number;
  /** Per-wavelength scattering weights, mean 1 (physics.airExtinction). */
  weights: RGB;
  /** Single-scattering albedo per channel (physics.airExtinction). */
  albedo: RGB;
  /** Aerosol cloud deck: vertical optical column and Mie-flat weights. */
  aeroTau: number;
  aeroW: RGB;
}

export interface SkyShellMaterials {
  /** Multiply pass (render first): background x per-channel transmittance. */
  ext: THREE.ShaderMaterial;
  /** Additive pass: the air's own in-scattered light. Shares uniforms with ext. */
  glow: THREE.ShaderMaterial;
}

export function makeSkyShellMaterials(
  air: AirSpec,
  topR: number,
  floorR: number,
): SkyShellMaterials {
  // ONE uniforms object drives both passes: every engine update (camera,
  // light, terraforming dials) lands in the pair at once.
  const uniforms = {
    uCamPos: { value: new THREE.Vector3(0, 0, 3) },
    uLightDir: { value: new THREE.Vector3(1, 0, 0) },
    uTopR: { value: topR },
    uFloorR: { value: floorR },
    uAirW: { value: new THREE.Vector3(...air.weights) },
    uAirSigma: { value: air.sigma },
    uAirH: { value: air.scaleH },
    uSunLum: { value: UNIVERSE.SUN_LUM },
    uAirNight: { value: new THREE.Vector3(...UNIVERSE.NIGHT_AIR) },
    uAirCurv: { value: air.curve },
    uAirAlb: { value: new THREE.Vector3(...air.albedo) },
    uAeroTau: { value: air.aeroTau },
    uAeroW: { value: new THREE.Vector3(...air.aeroW) },
    uTorch: { value: 0 },
    uTorchDir: { value: new THREE.Vector3(0, 0, -1) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
  };
  const ext = new THREE.ShaderMaterial({
    vertexShader: ATMO_VERT,
    fragmentShader: SKY_EXT_FRAG,
    uniforms,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
  });
  const glow = new THREE.ShaderMaterial({
    vertexShader: ATMO_VERT,
    fragmentShader: SKY_GLOW_FRAG,
    uniforms,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  return { ext, glow };
}

// (The old painted HAZE DECK mesh is gone: aerosol optical depth now feeds
// physics.airExtinction's sigma, so cloud opacity emerges from the same
// scattering integral as the sky, the limb and the ground gloom.)
