import * as THREE from 'three';
import type { GasSpec } from '../world/systemgen';

/**
 * A gas giant is a ball of atmosphere: one chemistry-tinted color and the
 * same cel day/night as the rocky worlds. No bands, storms or differential
 * rotation — those are weather, and weather is a later law. Cheap at any
 * distance; no LOD tiers.
 */

const GAS_VERT = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GAS_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uLightDir;
uniform float uSunIrr;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 c = uColor;
  float dl = dot(n, uLightDir);
  float ql = 0.7 + 0.14 * smoothstep(0.0, 0.15, dl) + 0.16 * smoothstep(0.4, 0.55, dl);
  float day = smoothstep(-0.16, 0.12, dl);
  vec3 night = c * vec3(0.22, 0.27, 0.42);
  gl_FragColor = vec4(mix(night, c * ql * uSunIrr, day), 1.0);
}
`;

export function makeGasGiantMaterial(spec: GasSpec): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GAS_VERT,
    fragmentShader: GAS_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(...spec.color) },
      uLightDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunIrr: { value: 1 },
    },
  });
}

/**
 * Full gas giant visual: unit-radius sphere (the body group carries scale)
 * plus an optional ring. Returns the group and the material whose light
 * uniform the engine updates per frame.
 */
export function makeGasGiant(spec: GasSpec): { group: THREE.Group; material: THREE.ShaderMaterial } {
  const group = new THREE.Group();
  const material = makeGasGiantMaterial(spec);
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
  group.add(globe);
  if (spec.ring) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 2.3, 64),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(...spec.ringColor),
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.62,
      }),
    );
    ring.rotation.x = spec.ringTilt;
    group.add(ring);
  }
  return { group, material };
}
