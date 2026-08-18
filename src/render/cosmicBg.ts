/**
 * Cosmic background: a far-plane void, a photograph of distant
 * galaxies, and distant pins. Each
 * galaxy is one inclined disk (hash size, cos i, position
 * angle, Hubble axis) — not a sprite stamp, not an archetype
 * switch. Each object has its own shine; engineer gains scale
 * the set. Not a catalog. Not pickable. Seeded from the bottle.
 */
import { xmur3 } from '../world/rng';

/** HSV → linear-ish RGB in 0..1. h wraps. */
export function hsvRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = ((h % 1) + 1) % 1;
  const ss = Math.max(0, Math.min(1, s));
  const vv = Math.max(0, Math.min(1, v));
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = vv * (1 - ss);
  const q = vv * (1 - f * ss);
  const t = vv * (1 - (1 - f) * ss);
  switch (i % 6) {
    case 0:
      return [vv, t, p];
    case 1:
      return [q, vv, p];
    case 2:
      return [p, vv, t];
    case 3:
      return [p, q, vv];
    case 4:
      return [t, p, vv];
    default:
      return [vv, p, q];
  }
}

/** Saturation of the void tint. Hue is the engineer wheel; this stays a colour. */
const VOID_SAT = 0.78;
/** Value at intensity 1 — a readable tinted night, not a neon sky. */
const VOID_V = 0.22;

/** Void colour from a rainbow hue and an intensity (both 0..1). */
export function cosmicVoidRgb(hue: number, intensity: number): [number, number, number] {
  const i = Math.max(0, Math.min(1, intensity));
  return hsvRgb(hue, VOID_SAT, i * VOID_V);
}

/**
 * Far-plane sky. A surrounding sphere puts triangles through w = 0
 * (the camera plane); those faces smear over the lens as you move.
 * A clip-space quad never crosses the camera.
 */
export function cosmicVert(): string {
  return /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;
}

/** Look-test sky: lime skin on the death-smear filaments.
 *  `steps` must match the included extinctGlsl march. */
export function cosmicFrag(extinctChunk: string, steps: number): string {
  const n = Number.isInteger(steps) ? `${steps}.0` : `${steps}`;
  return /* glsl */ `
  ${extinctChunk}
  uniform vec3 uVoidRgb;
  uniform vec3 uCenter;
  uniform mat3 uCamRotInv;
  uniform mat4 uInvProj;
  varying vec2 vNdc;

  float foxHash(float n) {
    return fract(sin(n) * 43758.5453);
  }

  vec3 foxGrad(vec3 p) {
    float e = 0.12;
    return vec3(
      extinctRho(p + vec3(e, 0.0, 0.0)) - extinctRho(p - vec3(e, 0.0, 0.0)),
      extinctRho(p + vec3(0.0, e, 0.0)) - extinctRho(p - vec3(0.0, e, 0.0)),
      extinctRho(p + vec3(0.0, 0.0, e)) - extinctRho(p - vec3(0.0, 0.0, e))
    );
  }

  // Grain follows the shear: long along θ, tight across R and y.
  float foxSkin(vec3 p) {
    float R = max(length(p.xz), 0.25);
    float th = atan(p.z, p.x);
    float along = th * R * 16.0;
    float across = R * 38.0;
    float vert = p.y * 52.0;
    float a = foxHash(along + 13.7 * foxHash(across + 8.1 * foxHash(vert)));
    float b = foxHash(along * 2.15 + across * 0.28 + vert * 1.05 + 4.2);
    return mix(0.68, 1.14, a) * mix(0.86, 1.1, b);
  }

  vec3 foxLook(vec3 from, vec3 dir, vec3 voidC) {
    vec2 span = extinctSpan(from, dir);
    if (span.x > span.y) return voidC;
    float t0 = max(span.x, 0.0);
    float dCat = span.y - t0;
    float dt = dCat / ${n};
    vec3 rgb = voidC;
    float a = 0.0;
    vec3 L = normalize(vec3(0.32, 0.86, 0.4));
    for (int i = 0; i < ${steps}; i++) {
      vec3 p = from + dir * (t0 + (float(i) + 0.5) * dt);
      float r = extinctRho(p);
      if (r < 0.014 || a > 0.97) continue;
      vec3 nrm = -normalize(foxGrad(p) + vec3(1e-6));
      float ndl = 0.2 + 0.8 * max(dot(nrm, L), 0.0);
      float facing = max(dot(nrm, -dir), 0.0);
      float wrap = 0.16 + 0.84 * facing;
      float rim = pow(1.0 - facing, 2.4);
      vec3 h = normalize(L - dir);
      float spec = pow(max(dot(nrm, h), 0.0), 22.0) * 0.4;
      float grain = foxSkin(p);
      vec3 lit = vec3(0.42, 1.0, 0.2);
      vec3 shade = vec3(0.02, 0.22, 0.05);
      vec3 lime = mix(shade, lit, ndl * wrap) * grain;
      lime += rim * vec3(0.55, 1.0, 0.38) * 0.5;
      lime += spec * vec3(0.85, 1.0, 0.7);
      float da = 1.0 - exp(-smoothstep(0.014, 0.28, r) * 2.1);
      float w = (1.0 - a) * da;
      rgb = mix(rgb, lime, w);
      a += w;
    }
    return rgb;
  }

  void main() {
    if (uDustDebug < 0.5) {
      gl_FragColor = vec4(uVoidRgb, 1.0);
      return;
    }
    vec4 view = uInvProj * vec4(vNdc, 1.0, 1.0);
    vec3 camDir = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 dir = normalize(uCamRotInv * camDir);
    gl_FragColor = vec4(foxLook(uCenter, dir, uVoidRgb), 1.0);
  }
`;
}

/** Device-px stamp. Same hop-soft Gaussian idea as the harvest floor. */
export const COSMIC_STAR_PIN = 6;
/** Device-px⁻². Tighter than the harvest floor — these sit at infinity. */
export const COSMIC_STAR_PIN_CORE = 1.15;

export type CosmicStars = {
  n: number;
  pos: Float32Array;
  col: Float32Array;
  shine: Float32Array;
};

export type CosmicSmudges = CosmicStars & {
  size: Float32Array;
  aspect: Float32Array;
  angle: Float32Array;
  seed: Float32Array;
  /** 0 = distant haze, 1 = nearby and sharp. */
  crisp: Float32Array;
};

/** Stateless 0..1 from the bottle and an address. Same inputs, same sky. */
function hash01(seedU: number, i: number, salt: number): number {
  let h = seedU | 0;
  h = Math.imul(h ^ (i | 0), 0x9e3779b1);
  h = Math.imul(h ^ (salt | 0), 0x85ebca6b);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function seedUnit(tag: string, seed: string): number {
  return xmur3(`${tag}:${seed}`)();
}

/**
 * Equal-area direction for address i. A Fibonacci spiral of the
 * max budget fills from one pole — draw-range of the first N is
 * then a cap, not a sky. hash(seed, i) on z and θ so any prefix
 * covers 4π. Same bottle, same sky.
 */
function hashDir(seedU: number, i: number): [number, number, number] {
  const z = hash01(seedU, i, 90) * 2 - 1;
  const theta = hash01(seedU, i, 91) * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [Math.cos(theta) * r, z, Math.sin(theta) * r];
}

/** Cheap large-scale web so smudges pile instead of spraying evenly. */
function cosmicWeb(dir: [number, number, number], cluster: number): number {
  const a = 0.5 + 0.5 * Math.sin(dir[0] * 2.15 + dir[1] * 1.7 + dir[2] * 0.4);
  const b = 0.5 + 0.5 * Math.sin(dir[0] * 5.4 + dir[2] * 4.1 + dir[1] * 2.2);
  const web = Math.min(1, Math.max(0, 0.62 * a + 0.38 * b));
  return web ** Math.max(cluster, 0.35);
}

function teffRgb(teff: number): [number, number, number] {
  const t = teff < 0.42 ? teff / 0.42 : (teff - 0.42) / 0.58;
  if (teff < 0.42) return [1, 0.68 + 0.25 * t, 0.42 + 0.4 * t];
  return [1 - 0.32 * t, 0.93 - 0.15 * t, 0.82 + 0.18 * t];
}

/**
 * Photograph budget of distant pins. Address i is hash(seed, i)
 * on the sphere. Same bottle, same sky.
 */
export function mintCosmicStars(seed: string, n: number): CosmicStars {
  const seedU = seedUnit('cosmic-stars', seed);
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const shine = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dir = hashDir(seedU, i);
    pos[i * 3] = dir[0];
    pos[i * 3 + 1] = dir[1];
    pos[i * 3 + 2] = dir[2];
    // Same hash, two powers: a dim field plus a rare nearby tail.
    const flux = hash01(seedU, i, 1);
    shine[i] = 0.0025 + 0.55 * flux ** 2.4 + 8.8 * flux ** 11;
    const rgb = teffRgb(hash01(seedU, i, 2));
    col[i * 3] = rgb[0];
    col[i * 3 + 1] = rgb[1];
    col[i * 3 + 2] = rgb[2];
  }
  return { n, pos, col, shine };
}

/**
 * Photograph budget of distant galaxies. Address i is hash(seed, i)
 * on the sphere. Size, inclination (cos i), and position angle are
 * hashes — the shader is one inclined disk plus bulge plus arms,
 * not an archetype switch. Same bottle, same sky.
 */
export function mintCosmicSmudges(seed: string, n: number, cluster: number): CosmicSmudges {
  const seedU = seedUnit('cosmic-smudges', seed);
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const shine = new Float32Array(n);
  const size = new Float32Array(n);
  const aspect = new Float32Array(n);
  const angle = new Float32Array(n);
  const seedA = new Float32Array(n);
  const crisp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dir = hashDir(seedU, i);
    pos[i * 3] = dir[0];
    pos[i * 3 + 1] = dir[1];
    pos[i * 3 + 2] = dir[2];
    const web = cosmicWeb(dir, cluster);
    crisp[i] = hash01(seedU, i, 7) ** 1.25;
    shine[i] = (0.1 + 1.85 * hash01(seedU, i, 1) ** 2.2) * (0.22 + 0.78 * web) * (0.38 + 0.97 * crisp[i]);
    size[i] = 0.2 + 2.8 * hash01(seedU, i, 2) ** 1.85;
    aspect[i] = hash01(seedU, i, 3);
    angle[i] = hash01(seedU, i, 4) * Math.PI * 2;
    seedA[i] = hash01(seedU, i, 5);
    const cool = hash01(seedU, i, 6);
    col[i * 3] = 0.88 - 0.36 * cool;
    col[i * 3 + 1] = 0.8 - 0.14 * cool;
    col[i * 3 + 2] = 0.66 + 0.2 * cool;
  }
  return { n, pos, col, shine, size, aspect, angle, seed: seedA, crisp };
}

export function cosmicStarVert(extinctGlsl: string): string {
  return /* glsl */ `
  ${extinctGlsl}
  attribute vec3 aColor;
  attribute float aShine;
  uniform vec3 uCenter;
  uniform float uStarGain;
  uniform float uPinCanvas;
  uniform float uPinCore;
  varying vec3 vColor;
  varying float vI;
  varying float vPx;
  varying float vCore;
  varying float vNear;

  void main() {
    vec3 dir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(dir, 0.0);
    // Limb / behind: w ≈ 0 puts a pin on the lens and it flashes.
    if (mv.z > -0.08) {
      vI = 0.0;
      vPx = 0.0;
      vCore = 0.0;
      vNear = 0.0;
      vColor = vec3(0.0);
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 ext = extinctLook(uCenter, dir);
    float extLum = dot(ext, vec3(0.2126, 0.7152, 0.0722));
    vI = aShine * uStarGain * extLum;
    vColor = aColor * ext / max(extLum, 1e-3);
    float n = clamp(pow(aShine / 9.5, 0.38), 0.0, 1.0);
    vNear = n;
    float pin = uPinCanvas * mix(0.5, 2.85, n);
    gl_PointSize = pin;
    vPx = pin;
    vCore = uPinCore * mix(0.36, 2.15, n);
    vec4 clip = projectionMatrix * mv;
    gl_Position = vec4(clip.xy, clip.w, clip.w);
  }
`;
}

export function cosmicStarFrag(): string {
  return /* glsl */ `
  varying vec3 vColor;
  varying float vI;
  varying float vPx;
  varying float vCore;
  varying float vNear;

  void main() {
    if (vI < 1e-5) discard;
    vec2 d = (gl_PointCoord - 0.5) * vPx;
    float rr = dot(d, d);
    float w = exp(-rr * vCore) + vNear * 0.28 / (1.0 + rr * 0.07);
    if (w < 0.01) discard;
    gl_FragColor = vec4(vColor * (vI * w), 1.0);
  }
`;
}

export function cosmicSmudgeVert(extinctGlsl: string): string {
  return /* glsl */ `
  ${extinctGlsl}
  attribute vec3 aColor;
  attribute float aShine;
  attribute float aSize;
  attribute float aAspect;
  attribute float aAngle;
  attribute float aSeed;
  attribute float aCrisp;
  uniform vec3 uCenter;
  uniform float uCosmicGain;
  uniform float uCosmicSize;
  uniform float uPxPerRad;
  varying vec3 vColor;
  varying float vI;
  varying float vIncl;
  varying float vAngle;
  varying float vSeed;
  varying float vCrisp;

  void main() {
    vec3 dir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(dir, 0.0);
    if (mv.z > -0.08) {
      vI = 0.0;
      vColor = vec3(0.0);
      vIncl = 0.0;
      vAngle = 0.0;
      vSeed = 0.0;
      vCrisp = 0.0;
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 ext = extinctLook(uCenter, dir);
    float extLum = dot(ext, vec3(0.2126, 0.7152, 0.0722));
    vI = aShine * uCosmicGain * extLum;
    vColor = aColor * ext / max(extLum, 1e-3);
    vIncl = clamp(aAspect, 0.0, 1.0);
    vAngle = aAngle;
    vSeed = aSeed;
    vCrisp = clamp(aCrisp, 0.0, 1.0);
    float ang = max(aSize, 0.16) * max(uCosmicSize, 0.06) * 0.062;
    gl_PointSize = clamp(ang * uPxPerRad, 14.0, 240.0);
    vec4 clip = projectionMatrix * mv;
    gl_Position = vec4(clip.xy, clip.w, clip.w);
  }
`;
}

export function cosmicSmudgeFrag(): string {
  return /* glsl */ `
  varying vec3 vColor;
  varying float vI;
  varying float vIncl;
  varying float vAngle;
  varying float vSeed;
  varying float vCrisp;

  float h11(float n) {
    return fract(sin(n) * 43758.5453);
  }

  void main() {
    if (vI < 1e-5) discard;
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float frame = dot(q, q);
    if (frame > 0.96) discard;
    float ca = cos(vAngle);
    float sa = sin(vAngle);
    vec2 p = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);

    // One Hubble axis: early = bulge, late = arms. Scatter on the rest.
    float early = h11(vSeed * 17.1);
    float bulgeAmt = mix(0.10, 0.84, early);
    float armStr = mix(1.08, 0.02, pow(early, 0.62)) * mix(0.5, 1.0, h11(vSeed * 31.7));
    float armM = mix(2.0, 3.7, h11(vSeed * 9.4));
    float pitch = mix(2.0, 7.2, h11(vSeed * 13.9));
    float phase = h11(vSeed * 5.2) * 6.2831853;
    float barStr = pow(h11(vSeed * 23.3), 1.8) * mix(0.08, 0.62, 1.0 - early * 0.55);
    float lane = pow(h11(vSeed * 41.0), 1.4);
    float crisp = clamp(vCrisp, 0.0, 1.0);
    float soft = 1.0 - crisp;

    float ci = mix(0.12, 1.0, vIncl);
    vec2 disk = vec2(p.x, p.y / ci);
    float r = length(disk);
    float rim = 1.0 - smoothstep(mix(0.70, 0.36, soft), mix(0.88, 0.98, soft), r);
    if (rim < 1e-4) discard;

    float bulge = exp(-dot(p, p) * mix(6.5, 24.0, mix(0.28, 1.0, crisp)) * mix(0.55, 1.0, bulgeAmt)) * bulgeAmt;
    float diskI = exp(-r * mix(2.15, 3.35, crisp)) * (1.0 - bulgeAmt * 0.38);
    float th = atan(disk.y, disk.x);
    float warp = 0.32 * sin(th * 2.0 + vSeed * 8.1);
    float spiral = 0.5 + 0.5 * cos(armM * th - pitch * log(max(r, 0.035)) + phase + warp);
    spiral = pow(max(spiral, 0.0), mix(0.7, 3.8, crisp * armStr));
    float arms = armStr * spiral * exp(-r * 2.35) * smoothstep(0.14, 0.4, ci) * mix(0.18, 1.0, crisp);
    float bar = barStr * exp(-disk.x * disk.x * 15.0 - disk.y * disk.y * 78.0) * mix(0.3, 1.0, ci) * mix(0.4, 1.0, crisp);
    float dust = 1.0 - lane * (1.0 - ci) * exp(-p.y * p.y * 88.0) * exp(-p.x * p.x * 1.7) * 0.58;
    float late = 1.0 - early;
    float lump = 0.78 + (0.08 + 0.22 * soft) * late * sin(disk.x * 8.0 + vSeed * 7.0) * sin(disk.y * 6.5 + vSeed * 4.4)
      + late * mix(0.12, 0.04, crisp) * sin(disk.x * 17.0 - disk.y * 13.0 + vSeed * 11.0);
    float haze = exp(-soft * frame * 2.15);

    float I = (bulge + diskI * (0.38 + 0.62 * (0.26 + arms)) + bar) * rim * dust * lump * haze;
    if (I < 0.012) discard;
    vec3 warm = vColor * vec3(1.1, 0.9, 0.74);
    vec3 cool = vColor * vec3(0.78, 0.86, 1.06);
    vec3 rgb = mix(cool, warm, clamp(bulge / max(I, 1e-4), 0.0, 1.0));
    gl_FragColor = vec4(rgb * (vI * I), 1.0);
  }
`;
}

