/**
 * The star as a law, not a sticker.
 *
 * A photosphere is a blackbody surface (Stefan–Boltzmann Teff from L and
 * R). Limb darkening is the Eddington grey atmosphere. Granules are
 * convection cells whose contrast and scale follow the convective
 * envelope. Spots and flares are the dynamo (starActivity). The K-corona
 * and the wind are Thomson scatter of THAT photosphere's light — a blue
 * star does not grow an orange halo — with density falling as Baumbach
 * r⁻⁶ near the limb and Parker r⁻² into the system (starWind).
 *
 * Glare is the eye: flux through the pupil (starEyeFlux, inverse-square
 * in the display stretch) spread by a PSF. Close in, the wash fills the
 * view. Out in the Kuiper it is a tight spike. We never paint a sunset
 * onto the disk; air in front multiplies the same Chapman transmittance
 * the sky already computed (uAirT).
 */
import * as THREE from 'three';
import {
  UNIVERSE,
  starActivity,
  starEyeFlux,
  starTeff,
  starWind,
} from '../world/physics';
import type { StarSpec } from '../world/systemgen';

const PHOTO_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vPos = position;
  vN = normal;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const STAR_NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.02 + 17.1;
    a *= 0.5;
  }
  return s;
}
vec3 hashDir(float i, float seed) {
  float a = hash21(vec2(i, seed)) * 6.2831853;
  float z = hash21(vec2(seed, i + 3.1)) * 2.0 - 1.0;
  float r = sqrt(max(1.0 - z * z, 0.0));
  return vec3(r * cos(a), r * sin(a), z);
}
`;

const PHOTO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uCam;
uniform vec3 uAirT;
uniform float uTime;
uniform float uSeed;
uniform float uTeff;
uniform float uActivity;
uniform float uDiskLum;
uniform float uFlare;
varying vec3 vPos;
varying vec3 vN;
varying vec3 vWorld;
${STAR_NOISE}

void main() {
  vec3 n = normalize(vN);
  vec3 view = normalize(uCam - vWorld);
  // Eddington-Barbier grey atmosphere: I = I0 (2/5 + 3/5 μ). Cooler
  // photospheres have more line opacity, so the limb coefficient walks
  // up a little — still one law, Teff as input.
  float mu = max(dot(n, view), 0.0);
  float uLD = mix(0.42, 0.68, clamp((6200.0 - uTeff) / 2800.0, 0.0, 1.0));
  float limb = (1.0 - uLD) + uLD * mu;

  // Convection cells. Radiative envelopes (hot) have almost no
  // granulation; the contrast ramps in as the envelope becomes
  // convective. Scale is a few cells across the disk — readable, not
  // a noise texture.
  float conv = clamp((6800.0 - uTeff) / 2800.0, 0.0, 1.0);
  float gFreq = mix(7.0, 14.0, clamp((uTeff - 3200.0) / 4000.0, 0.0, 1.0));
  float cells = fbm(n * gFreq + vec3(uTime * 0.11, uSeed, -uTime * 0.07));
  float gran = mix(1.0, mix(0.78, 1.22, cells), conv * 0.85);

  // Spots: cooler magnetic concentrations. Coverage follows activity.
  float spotN = fbm(n * 5.2 + vec3(uSeed * 3.1, 4.2, uTime * 0.02));
  float spots = smoothstep(1.0 - 0.22 * uActivity, 1.0 - 0.08 * uActivity, spotN);
  gran *= mix(1.0, 0.42, spots * uActivity);

  // Surface flares: reconnection patches. A handful of sites persist;
  // intensity is a sharp pulse so you see them fire, not shimmer.
  float flares = 0.0;
  for (int i = 0; i < 5; i++) {
    vec3 ax = hashDir(float(i), uSeed);
    float ph = hash21(vec2(float(i) * 7.7, uSeed));
    float om = 0.35 + 0.55 * hash21(vec2(uSeed, float(i) * 3.3));
    float pulse = pow(max(0.0, sin(uTime * om + ph * 6.28318)), 10.0);
    float d = 1.0 - dot(n, ax);
    flares += exp(-d * 55.0) * pulse;
  }
  flares *= uActivity * uFlare;

  // Cel bands on the live disk so the sun matches the worlds it lights:
  // three calm steps, then the furnace underneath.
  float bands = 0.78 + 0.12 * smoothstep(0.15, 0.28, mu) + 0.10 * smoothstep(0.55, 0.72, mu);
  vec3 hot = mix(uColor, vec3(1.0), 0.55 + 0.25 * clamp((uTeff - 4000.0) / 5000.0, 0.0, 1.0));
  vec3 cool = uColor * vec3(0.55, 0.38, 0.22);
  vec3 c = mix(cool, hot, clamp(gran, 0.0, 1.4));
  c *= limb * bands * uDiskLum;
  c += hot * flares * 3.4;
  // Core walks to white — the disk is brighter than the display.
  c = mix(c, vec3(1.0), clamp((limb * uDiskLum - 1.6) * 0.28, 0.0, 0.85));
  c *= uAirT;
  gl_FragColor = vec4(c, 1.0);
}
`;

const CORONA_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const CORONA_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uCam;
uniform vec3 uAirT;
uniform float uTime;
uniform float uSeed;
uniform float uPhotoR;
uniform float uOuterR;
uniform float uCorona;
uniform float uWind;
uniform float uActivity;
uniform float uFlare;
varying vec3 vWorld;
${STAR_NOISE}

void main() {
  vec3 rd = normalize(vWorld - uCam);
  vec3 ro = uCam;
  // Chord through the corona sphere. Camera may sit inside (close
  // approach): t0 starts at 0. Rays that strike the photosphere stop
  // there — the globe owns those pixels.
  float b = dot(ro, rd);
  float c0 = dot(ro, ro) - uOuterR * uOuterR;
  float disc = b * b - c0;
  if (disc <= 0.0) discard;
  float s = sqrt(disc);
  float t0 = max(-b - s, 0.0);
  float t1 = -b + s;
  if (t1 <= t0) discard;
  float cp = dot(ro, ro) - uPhotoR * uPhotoR;
  float discP = b * b - cp;
  if (discP > 0.0) {
    float tHit = -b - sqrt(discP);
    if (tHit > t0) t1 = min(t1, tHit);
    if (tHit > 0.0 && tHit < t0 + 1e-4) discard;
  }
  if (t1 <= t0) discard;

  vec3 acc = vec3(0.0);
  float dt = (t1 - t0) / 8.0;
  for (int i = 0; i < 8; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    float r = max(length(p), uPhotoR);
    vec3 dir = p / r;
    float rhoC = pow(uPhotoR / r, 6.0);
    float rhoW = pow(uPhotoR / r, 2.0);
    // Magnetic streamers: angular noise, frozen on the rotating frame,
    // advected slowly so the wind reads as a flow not a texture.
    float ang = atan(dir.y, dir.x);
    float stream = fbm(vec3(ang * 2.2, dir.z * 3.4, uSeed + uTime * 0.04));
    stream = pow(clamp(stream, 0.0, 1.0), 2.4);
    float dens = uCorona * rhoC + uWind * rhoW * mix(0.25, 1.0, stream);
    acc += uColor * dens * dt / max(uPhotoR, 1.0);
  }

  // Prominences: the same flare sites as the photosphere, seen as
  // tongues off the limb. They die with height (scale height ~ 0.15 R).
  for (int i = 0; i < 5; i++) {
    vec3 ax = hashDir(float(i), uSeed);
    float ph = hash21(vec2(float(i) * 7.7, uSeed));
    float om = 0.35 + 0.55 * hash21(vec2(uSeed, float(i) * 3.3));
    float pulse = pow(max(0.0, sin(uTime * om + ph * 6.28318)), 10.0);
    if (pulse < 0.05) continue;
    // Closest approach of this ray to the flare axis, outside the disk.
    vec3 hit = ro + rd * max(t0, 0.0);
    float along = max(dot(hit, ax), 0.0);
    vec3 perp = hit - ax * along;
    float off = length(perp) / max(uPhotoR, 1.0);
    float hgt = (along - uPhotoR) / max(uPhotoR, 1.0);
    float tongue = exp(-off * 14.0) * exp(-max(hgt, 0.0) * 7.0) * step(0.0, hgt + 0.08);
    acc += uColor * vec3(1.15, 0.95, 0.75) * tongue * pulse * uActivity * uFlare * 0.9;
  }

  acc *= uAirT;
  float a = clamp(max(acc.r, max(acc.g, acc.b)), 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(acc, a);
}
`;

const GLARE_VERT = /* glsl */ `
uniform float uScale;
varying vec2 vUv;
void main() {
  // View-space billboard centred on the star (group origin). Depth is
  // the star's depth so a world in front of the disk eclipses the wash
  // and sky pixels (no depth) still receive it.
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 ext = vec3(position.xy * uScale, 0.0);
  gl_Position = projectionMatrix * vec4(center.xyz + ext, 1.0);
  vUv = position.xy;
}
`;

const GLARE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uAirT;
uniform float uFlux;
uniform float uGain;
uniform float uDisk;
varying vec2 vUv;

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // The photosphere mesh owns the disk. This PSF is the OVERSPILL:
  // diffraction core + a 1/θ scatter tail. Flux is inverse-square at
  // the eye; the engine already sized the quad to sqrt(flux).
  float core = exp(-r * r * 28.0) * uFlux * uGain;
  float tail = (0.22 * uFlux * uGain) / (0.08 + 6.5 * r);
  // A faint diffraction cross (aperture), elongated a little so the
  // wash reads as glare and not a fog filter.
  float ax = min(abs(vUv.x), abs(vUv.y));
  float spike = exp(-ax * 55.0) * exp(-r * 2.4) * uFlux * 0.18 * uGain;
  // Soft hole over the disk so we do not double-paint the globe.
  float ring = smoothstep(uDisk * 0.72, uDisk * 1.15, r);
  vec3 c = uColor * (core + tail + spike) * ring;
  c *= uAirT;
  float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  if (a < 0.003) discard;
  gl_FragColor = vec4(c, a);
}
`;

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export interface StarView {
  group: THREE.Group;
  light: THREE.PointLight;
  update(camPos: THREE.Vector3, time: number, airT: THREE.Vector3): void;
  dispose(): void;
}

export function makeStar(spec: StarSpec): StarView {
  const group = new THREE.Group();
  const teff = starTeff(spec.luminosity, spec.radius);
  const activity = starActivity(teff, spec.luminosity);
  const wind = starWind(spec.luminosity, teff);
  const seed = hashName(spec.name);
  const color = new THREE.Color(spec.color);
  const lightC = new THREE.Color(spec.lightColor);
  const photoR = spec.radius;
  const outerR = photoR * 8.5;

  const photoMat = new THREE.ShaderMaterial({
    vertexShader: PHOTO_VERT,
    fragmentShader: PHOTO_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uCam: { value: new THREE.Vector3() },
      uAirT: { value: new THREE.Vector3(1, 1, 1) },
      uTime: { value: 0 },
      uSeed: { value: seed },
      uTeff: { value: teff },
      uActivity: { value: activity },
      uDiskLum: { value: UNIVERSE.STAR_DISK_LUM },
      uFlare: { value: UNIVERSE.STAR_FLARE },
    },
  });
  const photo = new THREE.Mesh(new THREE.SphereGeometry(photoR, 64, 48), photoMat);
  photo.renderOrder = 11;
  group.add(photo);

  const coronaMat = new THREE.ShaderMaterial({
    vertexShader: CORONA_VERT,
    fragmentShader: CORONA_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uCam: { value: new THREE.Vector3() },
      uAirT: { value: new THREE.Vector3(1, 1, 1) },
      uTime: { value: 0 },
      uSeed: { value: seed },
      uPhotoR: { value: photoR },
      uOuterR: { value: outerR },
      uCorona: { value: UNIVERSE.STAR_CORONA },
      uWind: { value: UNIVERSE.STAR_WIND * wind },
      uActivity: { value: activity },
      uFlare: { value: UNIVERSE.STAR_FLARE },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const corona = new THREE.Mesh(new THREE.SphereGeometry(outerR, 48, 32), coronaMat);
  corona.renderOrder = 12;
  group.add(corona);

  const glareMat = new THREE.ShaderMaterial({
    vertexShader: GLARE_VERT,
    fragmentShader: GLARE_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uAirT: { value: new THREE.Vector3(1, 1, 1) },
      uFlux: { value: 1 },
      uGain: { value: UNIVERSE.STAR_GLARE_GAIN },
      uScale: { value: photoR * 4 },
      uDisk: { value: 0.12 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const glare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glareMat);
  glare.frustumCulled = false;
  glare.renderOrder = 13;
  group.add(glare);

  // Inverse-square in the display stretch: intensity is candela so that
  // illuminance at A_HAB · SPACE_SCALE equals the old constant 2.5 for
  // L=1 (the scene's exposure). decay 2 is the law; distance 0 is
  // infinite reach. Inner worlds wash; the Kuiper fades.
  const dRef = UNIVERSE.A_HAB * UNIVERSE.SPACE_SCALE;
  const light = new THREE.PointLight(lightC, 2.5 * dRef * dRef * spec.luminosity, 0, 2);
  group.add(light);

  const tmpAir = new THREE.Vector3(1, 1, 1);

  return {
    group,
    light,
    update(camPos: THREE.Vector3, time: number, airT: THREE.Vector3): void {
      tmpAir.copy(airT);
      const d = Math.max(camPos.length(), photoR * 1.05);
      const flux = starEyeFlux(spec.luminosity, d);
      const ang = Math.min(1.15, UNIVERSE.STAR_GLARE_ANG * Math.sqrt(Math.max(flux, 1e-4)));
      const scale = d * Math.tan(ang);
      const disk = photoR / Math.max(scale, 1e-4);

      photoMat.uniforms.uCam.value.copy(camPos);
      photoMat.uniforms.uAirT.value.copy(tmpAir);
      photoMat.uniforms.uTime.value = time;
      coronaMat.uniforms.uCam.value.copy(camPos);
      coronaMat.uniforms.uAirT.value.copy(tmpAir);
      coronaMat.uniforms.uTime.value = time;
      glareMat.uniforms.uAirT.value.copy(tmpAir);
      glareMat.uniforms.uFlux.value = flux;
      glareMat.uniforms.uScale.value = scale;
      glareMat.uniforms.uDisk.value = Math.min(0.45, disk);
    },
    dispose(): void {
      photo.geometry.dispose();
      photoMat.dispose();
      corona.geometry.dispose();
      coronaMat.dispose();
      glare.geometry.dispose();
      glareMat.dispose();
    },
  };
}
