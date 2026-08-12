import * as THREE from 'three';
import type { GasSpec } from '../world/systemgen';

/**
 * The gas giant model: no terrain, no water — one sphere wearing an animated
 * cel-shaded shader. Latitude bands from the seeded palette, curled at the
 * edges by drifting 3D noise, sliding at different speeds by latitude
 * (differential rotation, like the real thing), one great storm oval, and
 * the same three-band cel light + moonlit night treatment as the rocky
 * worlds so the whole system shares an aesthetic. Cheap at any distance:
 * fragment cost scales with pixels covered, so a far giant is nearly free
 * and never needs LOD tiers.
 */

const GAS_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vNormal = normal;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GAS_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uBands;  // band palette, N x 1
uniform float uBandCount;
uniform float uBandFreq;
uniform vec3 uLightDir;    // body-local
uniform float uTime;
uniform vec2 uStorm;       // (latitude, phase)
varying vec3 vNormal;
varying vec3 vPos;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

vec3 bandColor(float band) {
  float u = (mod(band, uBandCount) + 0.5) / uBandCount;
  return texture2D(uBands, vec2(u, 0.5)).rgb;
}

void main() {
  vec3 p = normalize(vPos);
  float lat = asin(clamp(p.z, -1.0, 1.0));
  float lon = atan(p.y, p.x);

  // Differential rotation: each latitude slides at its own pace.
  float drift = uTime * (0.02 + 0.014 * cos(lat * 3.0));
  float dlon = lon + drift;
  vec3 q = vec3(cos(dlon) * cos(lat), sin(dlon) * cos(lat), sin(lat));

  // Curl the band edges with two octaves of drifting noise.
  float w = (vnoise(q * 3.0 + vec3(0.0, 0.0, uTime * 0.01)) - 0.5)
          + 0.5 * (vnoise(q * 6.3 + vec3(7.7, 2.1, 4.9)) - 0.5);
  float band = (lat / 3.14159265 + 0.5) * uBandFreq * uBandCount + w * 0.9;

  float bi = floor(band);
  float bf = band - bi;
  float aa = max(fwidth(band) * 1.2, 0.03);
  vec3 c = mix(bandColor(bi), bandColor(bi + 1.0), smoothstep(1.0 - aa, 1.0, bf));

  // The great storm: a bright swirled oval parked at a seeded latitude,
  // drifting a touch faster than its band.
  float slon = dlon * 1.35 + uStorm.y;
  vec2 sd = vec2(atan(sin(slon), cos(slon)) * cos(uStorm.x) / 0.5, (lat - uStorm.x) / 0.2);
  float storm = 1.0 - smoothstep(0.5, 1.0, length(sd));
  float swirl = vnoise(vec3(sd * 2.0, uTime * 0.05)) - 0.5;
  c = mix(c, c * vec3(1.16, 1.04, 0.96) + vec3(0.05), storm * (0.75 + 0.3 * swirl));

  // Cel light + moonlit night, matching the rocky worlds.
  vec3 n = normalize(vNormal);
  float dl = dot(n, uLightDir);
  float ql = 0.7 + 0.14 * smoothstep(0.0, 0.15, dl) + 0.16 * smoothstep(0.4, 0.55, dl);
  float day = smoothstep(-0.16, 0.12, dl);
  vec3 night = c * vec3(0.22, 0.27, 0.42);
  gl_FragColor = vec4(mix(night, c * ql, day), 1.0);
}
`;

export function makeGasGiantMaterial(spec: GasSpec): THREE.ShaderMaterial {
  const n = spec.colors.length;
  const data = new Uint8Array(n * 4);
  spec.colors.forEach((c, i) => {
    data[i * 4] = Math.round(c[0] * 255);
    data[i * 4 + 1] = Math.round(c[1] * 255);
    data[i * 4 + 2] = Math.round(c[2] * 255);
    data[i * 4 + 3] = 255;
  });
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;

  return new THREE.ShaderMaterial({
    vertexShader: GAS_VERT,
    fragmentShader: GAS_FRAG,
    uniforms: {
      uBands: { value: tex },
      uBandCount: { value: n },
      uBandFreq: { value: spec.bandFreq },
      uLightDir: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0 },
      uStorm: { value: new THREE.Vector2(spec.stormLat, spec.stormPhase) },
    },
  });
}

/**
 * Full gas giant visual: unit-radius sphere (the body group carries scale)
 * plus an optional tilted ring. Returns the group and the material whose
 * uTime/uLightDir the engine updates per frame.
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
