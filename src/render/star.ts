/**
 * The star as a SKIN, not stacked discs.
 *
 * A photosphere is the τ ≈ 1 surface of a furnace. What you see
 * is that surface plus the thin chromosphere sitting on it — one
 * shining body. The old stack (tessellated globe + corona shell +
 * hole-punched glare quad) read as a marble core inside a bigger
 * white circle with corners. Those were layers, not a sun.
 *
 * The disk is an ANALYTICAL sphere (ray–sphere in the fragment
 * shader). The mesh is only a bounding volume, so the limb has no
 * tessellation angles. Colour is the stellar clock's Teff
 * (Stefan–Boltzmann from L and R), shaded by a continuous
 * Eddington grey-atmosphere law — no cel bands, those painted a
 * concentric “core.” Granules are convective cells at a few
 * percent contrast (Worley F2−F1); spots and flares follow the
 * dynamo (`starActivity`). Granulation is luminance, never a
 * second albedo — a marble planet was the old cool/hot mix.
 *
 * Shine is the limb continued: the DISPLAY edge (high floor —
 * full Eddington is welding glass) decays as exp + Lorentzian,
 * never a hoop, plus a tight Baumbach r⁻⁶ haze. The Parker
 * wind is a column law, not a filled disc.
 *
 * From a planet the host wears DISTANCE glare: closer = the
 * sky burns (up to STAR_GLARE_SKY), further = it dies.
 * Luminosity is a lift, not a gate. The photosphere owns the
 * disk; glare is the sky around it — never killed just because
 * the disk is large (that was the hard white cutout).
 *
 * EVERY star shader works in the group's LOCAL km frame — uCam
 * is worldToLocal kilometres. Mixing km uniforms with world-kpc
 * varyings is how a previous glare quad blew up and vanished.
 *
 * The sub-threshold marker ring and the PointLight (the
 * illumination law) ride along unchanged.
 */
import * as THREE from 'three';
import {
  UNIVERSE,
  starActivity,
  starTeff,
} from '../world/physics';
import type { StarSpec } from '../world/systemgen';

const Z_AXIS = new THREE.Vector3(0, 0, 1);

const SKIN_VERT = /* glsl */ `
uniform float uBoundR;
varying vec3 vPos;
void main() {
  // Unit-sphere mesh × bound radius = group-local km. Mesh scale
  // stays 1 so uCam (group worldToLocal) and vPos share a frame.
  vPos = position * uBoundR;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos, 1.0);
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
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
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
// Cellular convection: F2 − F1 on the sphere. Real granules are
// cells with dark lanes, not marble fBm — that was the “visible
// core” texture. Contrast is applied by the caller, a few percent.
float granule(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash33(i + g);
    float d = length(f - g - o);
    if (d < f1) { f2 = f1; f1 = d; }
    else if (d < f2) f2 = d;
  }
  return clamp((f2 - f1) * 1.8, 0.0, 1.0);
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
uniform float uDiskFloor;
uniform float uFlare;
uniform float uGran;
uniform float uPhotoR;
varying vec3 vPos;
${STAR_NOISE}

void main() {
  vec3 rd = normalize(vPos - uCam);
  vec3 ro = uCam;
  float R = uPhotoR;
  float b = dot(ro, rd);
  float c0 = dot(ro, ro) - R * R;
  float disc = b * b - c0;
  if (disc <= 0.0) discard;
  float s = sqrt(disc);
  float t = -b - s;
  if (t < 0.0) t = -b + s;
  if (t < 0.0) discard;

  vec3 p = ro + rd * t;
  vec3 n = normalize(p);
  vec3 view = -rd;
  float mu = max(dot(n, view), 0.0);

  // Display limb law: physical Eddington shape (centre > limb,
  // cooler stars darken more) remapped onto STAR_DISK_FLOOR so
  // the body stays a furnace. Raw μ = 0 at u ~ 0.6 is welding glass.
  float uPhys = mix(0.42, 0.68, clamp((6200.0 - uTeff) / 2800.0, 0.0, 1.0));
  float phys = (1.0 - uPhys) + uPhys * mu;
  float limb = uDiskFloor + (1.0 - uDiskFloor) * (phys - (1.0 - uPhys)) / max(uPhys, 1e-4);
  limb = clamp(limb, uDiskFloor, 1.0);

  // Convection cells. Radiative envelopes (hot) have almost none;
  // contrast ramps in as the envelope becomes convective. Scale is
  // a few cells across the disk. STAR_GRAN is the peak contrast —
  // real granulation is a few percent, not a dirty ball.
  float conv = clamp((6800.0 - uTeff) / 2800.0, 0.0, 1.0);
  float gFreq = mix(5.5, 9.0, clamp((uTeff - 3200.0) / 4000.0, 0.0, 1.0));
  vec3 drift = n * gFreq + vec3(uTime * 0.07, uSeed, -uTime * 0.045);
  float cells = granule(drift);
  float gran = 1.0 + uGran * conv * (cells - 0.5);

  float spotN = fbm(n * 5.2 + vec3(uSeed * 3.1, 4.2, uTime * 0.02));
  float spots = smoothstep(1.0 - 0.22 * uActivity, 1.0 - 0.08 * uActivity, spotN);
  gran *= mix(1.0, 0.55, spots * uActivity);

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

  // Limb samples cooler layers — the same slant that darkens also
  // reddens, more for a line-rich cool photosphere. Luminance
  // granulation only: tinting cells was the marble core.
  float red = mix(0.12, 0.42, clamp((6200.0 - uTeff) / 2800.0, 0.0, 1.0));
  vec3 c = uColor * vec3(
    1.0,
    1.0 - red * (1.0 - mu),
    1.0 - red * 1.35 * (1.0 - mu)
  );
  // Furnace exposure: the whole disk is bright; the centre clips
  // toward white-hot; the rim keeps Teff. Welding glass was a
  // ~1× multiply on a 0.4 limb. STAR_DISK_LUM is the extra face
  // gain, not a painted core.
  float face = mix(1.22, 1.22 + 0.26 * uDiskLum, pow(mu, 1.45));
  float heat = pow(mu, 1.7) * 0.52;
  c = mix(c, vec3(1.0), heat);
  c *= limb * gran * face;
  c += uColor * flares * 1.8;
  gl_FragColor = vec4(c, 1.0);
}
`;

// Shine: chromosphere skin + Thomson corona, and (when the disk
// has not resolved) a soft flux bloom. One pass, dies before the
// mesh edge — the glow is the limb, never a second circle.
const GLOW_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uCam;
uniform float uTime;
uniform float uSeed;
uniform float uTeff;
uniform float uPhotoR;
uniform float uOuterR;
uniform float uCorona;
uniform float uChroma;
uniform float uChromaH;
uniform float uDiskFloor;
uniform float uBloom;
uniform float uBloomAng;
varying vec3 vPos;
${STAR_NOISE}

void main() {
  vec3 rd = normalize(vPos - uCam);
  vec3 ro = uCam;
  float b = dot(ro, rd);
  float c0 = dot(ro, ro) - uOuterR * uOuterR;
  float disc = b * b - c0;
  if (disc <= 0.0) discard;
  float s = sqrt(disc);
  float t0 = max(-b - s, 0.0);
  float t1 = -b + s;
  if (t1 <= t0) discard;

  // The photosphere owns its pixels. Shine starts at the limb.
  float cp = dot(ro, ro) - uPhotoR * uPhotoR;
  float discP = b * b - cp;
  if (discP > 0.0) {
    float tHit = -b - sqrt(discP);
    if (tHit < 0.0) tHit = -b + sqrt(discP);
    if (tHit > 0.0) {
      if (tHit < t0 + 1e-4) discard;
      t1 = min(t1, tHit);
    }
  }
  if (t1 <= t0) discard;

  float tca = max(-b, 0.0);
  vec3 closest = ro + rd * tca;
  float impact = length(closest);
  vec3 around = impact > 1e-8 ? closest / impact : vec3(0.0, 1.0, 0.0);

  // Shine is the DISPLAY limb continued — same floor × face as
  // the photosphere edge, then exp + Lorentzian (1 at x = 0).
  // Welding-glass μ = 0 as the start made a dim ball; a peak
  // above the edge made a hoop.
  float limbI = 1.22 * uDiskFloor;
  float h = max(uPhotoR * uChromaH, 1e-4);
  float x = max(impact - uPhotoR, 0.0) / h;
  float shine = limbI * uChroma * (0.60 * exp(-x) + 0.40 / (1.0 + 5.5 * x * x));
  shine *= 0.94 + 0.10 * fbm(around * 5.5 + vec3(uTime * 0.06, uSeed, 0.0));
  float cool = clamp((5200.0 - uTeff) / 2400.0, 0.0, 1.0);
  vec3 shineCol = mix(uColor, vec3(1.0), 0.45 * exp(-x));
  shineCol = mix(shineCol, vec3(1.0, 0.32, 0.20), 0.22 * cool * (1.0 - exp(-x)));
  vec3 acc = shineCol * shine;

  // Baumbach r⁻⁶ only, and dead close to the limb. The wind is a
  // column law, not a filled disc — drawing r⁻² to STAR_CORONA_DRAW
  // was the large blue halo.
  float dt = (t1 - t0) / 8.0;
  float thom = 0.0;
  for (int i = 0; i < 8; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    float r = max(length(p), uPhotoR);
    float window = smoothstep(uOuterR, uPhotoR * 1.05, r);
    thom += uCorona * pow(uPhotoR / r, 6.0) * window;
  }
  acc += uColor * thom * (dt * 0.035 / max(uPhotoR, 1e-6));

  // Host glare: distance-weighted PSF. Core bleaches (a star
  // is too bright to hold colour at the photocentre); wings
  // keep Teff. Soft Gaussian + Lorentzian — no hard disc.
  if (uBloom > 0.001) {
    float ang = acos(clamp(dot(rd, normalize(-uCam)), -1.0, 1.0));
    float s = ang / max(uBloomAng, 1e-4);
    float core = exp(-s * s);
    float tail = 0.45 / (1.0 + 5.5 * s * s);
    float sky = 0.28 * exp(-ang / max(uBloomAng * 1.7, 0.12));
    vec3 bCol = mix(uColor, vec3(1.0), 0.78 * core);
    acc += bCol * uBloom * (core + tail + sky);
  }

  float a = clamp(max(acc.r, max(acc.g, acc.b)), 0.0, 1.0);
  if (a < 0.003) discard;
  gl_FragColor = vec4(acc, a);
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
  const surfaceKm = Math.max(1, spec.radius);
  const teff = starTeff(spec.luminosity, spec.radius);
  const activity = starActivity(teff, spec.luminosity);
  const seed = hashName(spec.name);
  const color = new THREE.Color(spec.color);
  const glow0 = surfaceKm * UNIVERSE.STAR_CORONA_DRAW;

  const photoMat = new THREE.ShaderMaterial({
    vertexShader: SKIN_VERT,
    fragmentShader: PHOTO_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSeed: { value: seed },
      uTeff: { value: teff },
      uActivity: { value: activity },
      uDiskLum: { value: UNIVERSE.STAR_DISK_LUM },
      uDiskFloor: { value: UNIVERSE.STAR_DISK_FLOOR },
      uFlare: { value: UNIVERSE.STAR_FLARE },
      uGran: { value: UNIVERSE.STAR_GRAN },
      uPhotoR: { value: surfaceKm },
      uBoundR: { value: surfaceKm * 1.06 },
    },
  });
  // Bounding volume only — a little fat so a coarse tessellation
  // still covers the analytical limb. The fragment discards misses.
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), photoMat);
  ball.renderOrder = 11;
  group.add(ball);

  const glowMat = new THREE.ShaderMaterial({
    vertexShader: SKIN_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSeed: { value: seed },
      uTeff: { value: teff },
      uPhotoR: { value: surfaceKm },
      uOuterR: { value: glow0 },
      uCorona: { value: UNIVERSE.STAR_CORONA },
      uChroma: { value: UNIVERSE.STAR_CHROMA },
      uChromaH: { value: UNIVERSE.STAR_CHROMA_H },
      uDiskFloor: { value: UNIVERSE.STAR_DISK_FLOOR },
      uBloom: { value: 0 },
      uBloomAng: { value: UNIVERSE.STAR_GLARE_ANG },
      uBoundR: { value: glow0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), glowMat);
  glow.renderOrder = 12;
  group.add(glow);

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
      (glowMat.uniforms.uCam.value as THREE.Vector3).copy(camPos);
      glowMat.uniforms.uTime.value = time;

      const d = camPos.length();
      if (!(d > 0)) {
        marker.visible = false;
        return;
      }
      const angSurface = Math.asin(Math.min(1, surfaceKm / d));
      // Glare falls with distance from the star. Luminosity lifts
      // the bright end but L0 keeps a nearby dwarf findable —
      // L/d² made every M star a pixel you had to mark.
      const dRef = UNIVERSE.A_HAB * UNIVERSE.AU_KM;
      const dist = dRef / Math.max(d, surfaceKm * UNIVERSE.STAR_CORONA_R);
      const distTerm = Math.pow(dist, UNIVERSE.STAR_GLARE_DIST);
      const lumTerm =
        UNIVERSE.STAR_GLARE_L0 +
        (1 - UNIVERSE.STAR_GLARE_L0) *
          Math.pow(Math.min(Math.max(spec.luminosity, 0), 8), UNIVERSE.STAR_GLARE_L_P);
      const scale = distTerm * lumTerm;
      // Width grows as you approach — a close planet sets the
      // sky on fire. Killing glare when the disk subtended was
      // the hard white cutout: the sun filled the frame and
      // wore no sky. Intensity knees so the wash does not wipe
      // the planet.
      const bloomAng = Math.min(UNIVERSE.STAR_GLARE_SKY, UNIVERSE.STAR_GLARE_ANG * scale);
      const bloomI = Math.min(
        UNIVERSE.STAR_GLARE_I_MAX,
        UNIVERSE.STAR_GLARE_GAIN * Math.pow(Math.max(scale, 1e-4), 0.42),
      );
      glowMat.uniforms.uBloom.value = bloomI;
      glowMat.uniforms.uBloomAng.value = Math.max(bloomAng, 1e-4);
      const glowAng = Math.min(1.2, Math.max(angSurface + 0.04, bloomAng));
      const outerKm = Math.max(glow0, d * Math.tan(glowAng));
      glowMat.uniforms.uOuterR.value = outerKm;
      glowMat.uniforms.uBoundR.value = outerKm;

      marker.visible = angSurface < UNIVERSE.STAR_MARK_ANG * 0.5;
      if (!marker.visible) return;
      marker.scale.setScalar(d * Math.tan(UNIVERSE.STAR_MARK_ANG));
      camDir.copy(camPos).multiplyScalar(1 / d);
      marker.quaternion.setFromUnitVectors(Z_AXIS, camDir);
    },
    dispose(): void {
      ball.geometry.dispose();
      photoMat.dispose();
      glow.geometry.dispose();
      glowMat.dispose();
      ring.geometry.dispose();
      ringMat.dispose();
    },
  };
}
