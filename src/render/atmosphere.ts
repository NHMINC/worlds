import * as THREE from 'three';
import type { RGB } from '../world/physics';

/**
 * Atmosphere rendering, driven entirely by the physics model:
 *
 *  - the RIM is Rayleigh-ish limb glow tinted by what the actual gas mix
 *    scatters (N2/O2 skies glow blue, CO2 pale, CH4 a burnt orange), with
 *    its reach and brightness scaled by surface pressure;
 *  - the HAZE DECK is an opaque cloud shell that thick atmospheres wear
 *    (hothouse CO2, organic CH4 smog): from space it hides the surface
 *    completely, and it only thins once the camera pushes down close.
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

const RIM_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;   // body-local
uniform vec3 uLightDir; // body-local
uniform vec3 uTint;     // Rayleigh tint of the gas mix
uniform float uStrength; // pressure-scaled
uniform float uInner;   // radius of the visible limb (surface or cloud top)
uniform float uScaleH;  // exponential scale height of the glow
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  // ONE progressive horizon: air density decays exponentially with
  // altitude, so the glow is brightest hugging the limb and fades to
  // nothing well before the shell geometry ends — no detached halo ring.
  // Altitude of this view ray = its closest approach to the body center.
  // The band decays on both sides of the limb: outward with the gas scale
  // height, inward a little slower (thin-air tinge over the disk edge).
  vec3 d = normalize(vPos - uCamPos);
  float b = length(cross(uCamPos, d));
  float x = b - uInner;
  float a = uStrength * exp(-max(x, 0.0) / uScaleH) * exp(-max(-x, 0.0) / (uScaleH * 1.8));
  float sun = 0.18 + 0.82 * smoothstep(-0.35, 0.55, dot(vNormal, uLightDir));
  gl_FragColor = vec4(uTint * a * sun, a * sun);
}
`;

export function makeAtmoRimMaterial(
  tint: RGB,
  pressure: number,
  inner: number,
  shellR: number,
): THREE.ShaderMaterial {
  // Pressure sets the glow's presence: Mars-thin is a whisper, Earth a
  // clean band, super-pressures saturate. (The peak now sits right at the
  // limb, so it caps lower than the old edge-peaked profile did.)
  const strength = Math.min(1.0, Math.pow(Math.max(0, pressure), 0.35) * 0.6);
  // Scale height sized so the glow reaches ~1% at the shell edge: the
  // geometry never shows its own silhouette.
  const scaleH = (shellR - inner) / 4.5;
  return new THREE.ShaderMaterial({
    vertexShader: ATMO_VERT,
    fragmentShader: RIM_FRAG,
    uniforms: {
      uCamPos: { value: new THREE.Vector3(0, 0, 3) },
      uLightDir: { value: new THREE.Vector3(1, 0, 0) },
      uTint: { value: new THREE.Vector3(...tint) },
      uStrength: { value: strength },
      uInner: { value: inner },
      uScaleH: { value: scaleH },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const HAZE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;   // body-local, unit-radius frame
uniform vec3 uLightDir;
uniform vec3 uColor;
uniform float uOpacity; // vertical optical opacity, from density + chemistry
varying vec3 vNormal;
varying vec3 vPos;

void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCamPos - vPos);

  // NO patterns: clouds and weather are a later law. The shroud is one
  // chemistry-tinted gas, and all structure is physics — slant optical
  // depth (Beer-Lambert along the view path) thickens toward the limb,
  // and the cel day/night light shades it like every other body.
  float dl = dot(n, uLightDir);
  float ql = 0.72 + 0.13 * smoothstep(0.0, 0.15, dl) + 0.15 * smoothstep(0.4, 0.55, dl);
  float day = smoothstep(-0.16, 0.12, dl);
  vec3 c = mix(uColor * vec3(0.22, 0.27, 0.42), uColor * ql, day);

  // Slant path: looking through the shell at grazing angles crosses far
  // more gas than looking straight down.
  float mu = clamp(dot(n, view), 0.12, 1.0);
  float alpha = 1.0 - pow(1.0 - uOpacity, 1.0 / mu);

  // The shroud reads from space and thins only when the camera is nearly
  // down inside it.
  float camAlt = length(uCamPos) - 1.0;
  float fade = smoothstep(0.05, 0.4, camAlt);
  gl_FragColor = vec4(c, alpha * fade);
}
`;

export function makeHazeMaterial(color: RGB, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ATMO_VERT,
    fragmentShader: HAZE_FRAG,
    uniforms: {
      uCamPos: { value: new THREE.Vector3(0, 0, 3) },
      uLightDir: { value: new THREE.Vector3(1, 0, 0) },
      uColor: { value: new THREE.Vector3(...color) },
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthWrite: false,
  });
}
