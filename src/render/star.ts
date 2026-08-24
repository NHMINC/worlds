/**
 * The star as a law, not a sticker — drawn INSIDE the wall.
 *
 * The disk is a blackbody at the stellar clock's Teff
 * (Stefan–Boltzmann from L and R), shaded by Eddington
 * grey-atmosphere limb darkening. Granules are convection cells
 * whose contrast follows the convective envelope; spots and
 * flares are the dynamo (starActivity). The K-corona and wind
 * are Thomson scatter of THAT photosphere's light (starWind) —
 * a blue star does not grow an orange halo — Baumbach r⁻⁶ plus
 * Parker r⁻², drawn only out to STAR_CORONA_DRAW photosphere
 * radii: well inside the 4 R hard wall, so a parked ship can
 * never look swallowed again (the old shell reached the wall).
 *
 * Glare is the eye: flux through the pupil (starEyeFlux,
 * inverse-square referenced at A_HAB) as the eye's PSF —
 * Gaussian core, Lorentzian tail, and the ciliary starburst
 * (STAR_SPIKE): soft radial rays, the lens part of looking at
 * a sun. The halo HUGS THE LIMB: its width past the disk's own
 * angular radius is capped at STAR_GLARE_CAP — a distant sun
 * is a hard bright point, a parked one wears a bounded halo
 * past the limb, never a wash that hides where the surface is
 * (and never zero: an absolute cap used to swallow the whole
 * halo behind a close disk).
 *
 * EVERY star shader works in the group's LOCAL km frame — see
 * PHOTO_VERT. Mixing km uniforms with world-kpc varyings is how
 * the sun lit whole systems while wearing no glow of its own.
 *
 * The sub-threshold marker ring and the PointLight (the
 * illumination law) ride along unchanged.
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

const Z_AXIS = new THREE.Vector3(0, 0, 1);

// LOCAL-frame law: every star shader works in the group's own km
// frame — uCam arrives in local km (worldToLocal), so positions
// must stay local too. The old verts handed WORLD kpc positions to
// km-frame math: the km numbers drowned the kpc ones, the corona's
// per-pixel ray collapsed to a constant, and the glare quad blew up
// to astronomical size so every on-screen pixel sampled its centre
// (inside the disk hole) and discarded — the sun never wore a glow.
const PHOTO_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vPos;
void main() {
  vN = normal;
  vPos = position;
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
uniform float uTime;
uniform float uSeed;
uniform float uTeff;
uniform float uActivity;
uniform float uDiskLum;
uniform float uFlare;
varying vec3 vN;
varying vec3 vPos;
${STAR_NOISE}

void main() {
  vec3 n = normalize(vN);
  vec3 view = normalize(uCam - vPos);
  // Eddington-Barbier grey atmosphere: I = I0 (2/5 + 3/5 μ). Cooler
  // photospheres have more line opacity, so the limb coefficient walks
  // up a little — still one law, Teff as input.
  float mu = max(dot(n, view), 0.0);
  float uLD = mix(0.42, 0.68, clamp((6200.0 - uTeff) / 2800.0, 0.0, 1.0));
  float limb = (1.0 - uLD) + uLD * mu;

  // Convection cells. Radiative envelopes (hot) have almost no
  // granulation; the contrast ramps in as the envelope becomes
  // convective. Scale is a few cells across the disk — readable, not
  // a noise texture. Lanes stay shallow: real granulation is a few
  // percent — deep lanes read as a dirty, dim ball.
  float conv = clamp((6800.0 - uTeff) / 2800.0, 0.0, 1.0);
  float gFreq = mix(4.5, 8.5, clamp((uTeff - 3200.0) / 4000.0, 0.0, 1.0));
  float cells = fbm(n * gFreq + vec3(uTime * 0.11, uSeed, -uTime * 0.07));
  float gran = mix(1.0, mix(0.72, 1.22, cells), max(conv, 0.35));

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
  float bands = 0.88 + 0.10 * smoothstep(0.12, 0.30, mu) + 0.10 * smoothstep(0.52, 0.74, mu);
  vec3 hot = mix(uColor, vec3(1.0), 0.22 + 0.35 * clamp((uTeff - 3800.0) / 5000.0, 0.0, 1.0));
  vec3 cool = uColor * vec3(0.72, 0.48, 0.26);
  vec3 c = mix(cool, hot, clamp(gran, 0.0, 1.4));
  // A photosphere is a FURNACE: the centre sits well above the LDR
  // clip (uDiskLum is that overdrive), so the core is white-hot and
  // granulation reads mid-disk; only the limb falls through the clip
  // and keeps Teff colour (Eddington darkening does the falling).
  // The old centre gain barely reached 1 and the whole disk was a
  // dull gradient — lit planets under a dim sun.
  float lum = mix(0.95, 0.5 * uDiskLum, mu * mu);
  c *= limb * bands * lum * gran;
  c += hot * flares * 2.6;
  gl_FragColor = vec4(c, 1.0);
}
`;

const CORONA_VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// The corona is ONE smooth radial glow — light radiating out
// uniformly. Density is Baumbach r⁻⁶ plus a Parker r⁻² wind,
// integrated along the chord, with a window that reaches exactly
// zero before the mesh edge so the shell has no visible rim.
// The shell tops out at STAR_CORONA_DRAW photosphere radii —
// far inside the hard wall.
const CORONA_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uCam;
uniform float uPhotoR;
uniform float uOuterR;
uniform float uCorona;
uniform float uWind;
varying vec3 vPos;

void main() {
  vec3 rd = normalize(vPos - uCam);
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
    float rhoC = pow(uPhotoR / r, 6.0);
    float rhoW = pow(uPhotoR / r, 2.0);
    // Fade the wind term to zero well inside the shell: the glow dies
    // in the maths, not at the geometry, so there is no circle.
    float window = smoothstep(uOuterR, uOuterR * 0.45, r);
    acc += uColor * (uCorona * rhoC + uWind * rhoW * window) * dt * 0.28;
  }
  acc /= max(uPhotoR, 1e-6);

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
  // and sky pixels (no depth) still receive it. uScale is LOCAL km;
  // the modelView column length converts it into view units — adding
  // raw km to a kpc-view centre was the every-pixel-discards bug.
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float ws = length(modelViewMatrix[0].xyz);
  vec3 ext = vec3(position.xy * uScale * ws, 0.0);
  gl_Position = projectionMatrix * vec4(center.xyz + ext, 1.0);
  vUv = position.xy;
}
`;

const GLARE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uFlux;
uniform float uGain;
uniform float uDisk;
uniform float uSpike;
varying vec2 vUv;

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // The photosphere mesh owns the disk. This is the glare: the eye's
  // response to raw flux — Gaussian core, Lorentzian tail (the same
  // PSF shape as the harvest pins), plus the ciliary starburst: the
  // eye's lens fibrils spread a bright source into soft radial rays.
  // Inverse-square lives in uFlux (the quad is sized to the capped
  // angle too), so a distant sun is a small bright point and a close
  // one wears a bounded halo. The window term reaches exactly zero at
  // the quad edge — the glow ends in the maths, never a visible rim.
  float f = pow(max(uFlux, 0.03), 0.42);
  float core = exp(-r * r * 16.0) * (0.65 + 0.9 * clamp(uFlux, 0.0, 2.5));
  float phi = atan(vUv.y, vUv.x);
  float rays = pow(abs(cos(phi * 3.0)), 24.0) + 0.6 * pow(abs(sin(phi * 3.0)), 24.0);
  float tail = (0.5 * f) / (0.04 + 3.4 * r * r) * (1.0 + uSpike * rays);
  float window = 1.0 - r * r;
  window *= window;
  // Soft hole over the disk so we do not double-paint the globe.
  float ring = smoothstep(uDisk * 0.72, uDisk * 1.15, r);
  vec3 c = uColor * ((core + tail) * uGain * window) * ring;
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
  /** Photosphere radius drawn, km — the one truth to reconcile. */
  surfaceKm: number;
  /**
   * The sub-threshold highlight: a billboarded ring of fixed
   * ANGULAR size marking where the star is when its surface is
   * too small to see (a neutron star's park is thousands of
   * radii out; a far approach is sub-pixel for any star). The
   * locale hangs the class label (what it is) inside this group.
   */
  marker: THREE.Group;
  update(camPos: THREE.Vector3, time: number, airT: THREE.Vector3): void;
  dispose(): void;
}

export function makeStar(spec: StarSpec): StarView {
  const group = new THREE.Group();
  // The observable surface: the photosphere radius in km.
  // Floored at 1 km so a compact remnant still has a surface.
  const surfaceKm = Math.max(1, spec.radius);
  const teff = starTeff(spec.luminosity, spec.radius);
  const activity = starActivity(teff, spec.luminosity);
  const wind = starWind(spec.luminosity, teff);
  const seed = hashName(spec.name);
  const color = new THREE.Color(spec.color);
  // The drawn corona tops out far inside the hard wall
  // (STAR_CORONA_R): drawing to the wall is how a parked ship
  // once looked swallowed.
  const outerR = surfaceKm * UNIVERSE.STAR_CORONA_DRAW;

  const photoMat = new THREE.ShaderMaterial({
    vertexShader: PHOTO_VERT,
    fragmentShader: PHOTO_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSeed: { value: seed },
      uTeff: { value: teff },
      uActivity: { value: activity },
      uDiskLum: { value: UNIVERSE.STAR_DISK_LUM },
      uFlare: { value: UNIVERSE.STAR_FLARE },
    },
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(surfaceKm, 64, 48), photoMat);
  ball.renderOrder = 11;
  group.add(ball);

  const coronaMat = new THREE.ShaderMaterial({
    vertexShader: CORONA_VERT,
    fragmentShader: CORONA_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uCam: { value: new THREE.Vector3() },
      uPhotoR: { value: surfaceKm },
      uOuterR: { value: outerR },
      uCorona: { value: UNIVERSE.STAR_CORONA },
      uWind: { value: UNIVERSE.STAR_WIND * wind },
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
      uFlux: { value: 1 },
      uGain: { value: UNIVERSE.STAR_GLARE_GAIN },
      uScale: { value: surfaceKm * 1.5 },
      uDisk: { value: 0.12 },
      uSpike: { value: UNIVERSE.STAR_SPIKE },
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

  // Marker law: the ring holds STAR_MARK_ANG on screen and turns
  // on when the surface subtends less than half of it — the ring
  // can never overlap a readable disk, and it hands off to the
  // disk on the way in. One law for a black hole at park and the
  // Sun mid-cruise.
  const marker = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x9fd8ff,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.94, 64), ringMat);
  ring.renderOrder = 30;
  marker.add(ring);
  marker.visible = false;
  group.add(marker);

  // Inverse-square: illuminance at A_HAB · AU_KM equals 2.5 for L=1.
  const dRef = UNIVERSE.A_HAB * UNIVERSE.AU_KM;
  const light = new THREE.PointLight(
    new THREE.Color(spec.lightColor),
    2.5 * dRef * dRef * spec.luminosity,
    0,
    2,
  );
  group.add(light);

  const camDir = new THREE.Vector3();

  return {
    group,
    light,
    surfaceKm,
    marker,
    update(camPos: THREE.Vector3, time: number): void {
      (photoMat.uniforms.uCam.value as THREE.Vector3).copy(camPos);
      photoMat.uniforms.uTime.value = time;
      (coronaMat.uniforms.uCam.value as THREE.Vector3).copy(camPos);

      const d = camPos.length();
      if (!(d > 0)) {
        marker.visible = false;
        return;
      }
      // Glare at the eye: the halo HUGS THE LIMB. Its width is
      // capped BEYOND the disk's own angular radius — an absolute
      // cap swallowed the whole halo behind a parked photosphere
      // (the disk subtends ~0.7 rad at the ecliptic park, the cap
      // was 0.35: the sun wore no glow at all up close).
      const flux = starEyeFlux(spec.luminosity, Math.max(d, surfaceKm * 1.05));
      const angSurface = Math.asin(Math.min(1, surfaceKm / d));
      const halo = Math.min(
        UNIVERSE.STAR_GLARE_CAP,
        UNIVERSE.STAR_GLARE_ANG * Math.sqrt(Math.max(flux, 1e-4)),
      );
      const ang = Math.min(1.35, angSurface + halo);
      const scale = d * Math.tan(ang);
      glareMat.uniforms.uFlux.value = flux;
      glareMat.uniforms.uScale.value = scale;
      // The hole over the disk tracks the TRUE limb fraction on the
      // billboard (tan ratio — the quad is a plane at the star's
      // depth), so the halo always starts at the limb (the old 0.45
      // cap painted the wash over the outer disk instead of past it).
      glareMat.uniforms.uDisk.value = Math.min(
        0.98,
        Math.tan(angSurface) / Math.max(Math.tan(ang), 1e-6),
      );
      marker.visible = angSurface < UNIVERSE.STAR_MARK_ANG * 0.5;
      if (!marker.visible) return;
      marker.scale.setScalar(d * Math.tan(UNIVERSE.STAR_MARK_ANG));
      camDir.copy(camPos).multiplyScalar(1 / d);
      marker.quaternion.setFromUnitVectors(Z_AXIS, camDir);
    },
    dispose(): void {
      ball.geometry.dispose();
      photoMat.dispose();
      corona.geometry.dispose();
      coronaMat.dispose();
      glare.geometry.dispose();
      glareMat.dispose();
      ring.geometry.dispose();
      ringMat.dispose();
    },
  };
}
