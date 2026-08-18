/**
 * Cosmic background: a far-plane void, a photograph of galaxy
 * smudges, and a photograph of distant star-like pins. Each
 * object has its own shine; engineer gains scale the set.
 * Not a catalog. Not pickable. Seeded from the bottle seed.
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

export function cosmicFrag(): string {
  return /* glsl */ `
  uniform vec3 uVoidRgb;
  void main() {
    gl_FragColor = vec4(uVoidRgb, 1.0);
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

/** Golden-spiral direction for address i of a budget of n. */
function fibonacciDir(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = n <= 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * i;
  return [Math.cos(theta) * r, y, Math.sin(theta) * r];
}

function rotateDir(
  dir: [number, number, number],
  yaw: number,
  pitch: number,
): [number, number, number] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = dir[0] * cy + dir[2] * sy;
  const z1 = -dir[0] * sy + dir[2] * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = dir[1] * cp - z1 * sp;
  const z2 = dir[1] * sp + z1 * cp;
  return [x1, y2, z2];
}

function jitterDir(
  dir: [number, number, number],
  seedU: number,
  i: number,
  amount: number,
): [number, number, number] {
  const jx = hash01(seedU, i, 11) * 2 - 1;
  const jy = hash01(seedU, i, 12) * 2 - 1;
  const jz = hash01(seedU, i, 13) * 2 - 1;
  const x = dir[0] + jx * amount;
  const y = dir[1] + jy * amount;
  const z = dir[2] + jz * amount;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
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
 * Photograph budget of distant pins. Address i is a Fibonacci
 * direction plus hash(seed, i). Same bottle, same sky.
 */
export function mintCosmicStars(seed: string, n: number): CosmicStars {
  const seedU = seedUnit('cosmic-stars', seed);
  const yaw = hash01(seedU, 0, 90) * Math.PI * 2;
  const pitch = (hash01(seedU, 0, 91) * 2 - 1) * 0.35;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const shine = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dir = jitterDir(rotateDir(fibonacciDir(i, n), yaw, pitch), seedU, i, 0.012);
    pos[i * 3] = dir[0];
    pos[i * 3 + 1] = dir[1];
    pos[i * 3 + 2] = dir[2];
    shine[i] = 0.012 + 2.4 * hash01(seedU, i, 1) ** 5.6;
    const rgb = teffRgb(hash01(seedU, i, 2));
    col[i * 3] = rgb[0];
    col[i * 3 + 1] = rgb[1];
    col[i * 3 + 2] = rgb[2];
  }
  return { n, pos, col, shine };
}

/**
 * Photograph budget of galaxy smudges. Address i is a Fibonacci
 * direction plus hash(seed, i). The web only weights shine — it
 * does not reject slots. Same bottle, same sky.
 */
export function mintCosmicSmudges(seed: string, n: number, cluster: number): CosmicSmudges {
  const seedU = seedUnit('cosmic-smudges', seed);
  const yaw = hash01(seedU, 0, 90) * Math.PI * 2;
  const pitch = (hash01(seedU, 0, 91) * 2 - 1) * 0.35;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const shine = new Float32Array(n);
  const size = new Float32Array(n);
  const aspect = new Float32Array(n);
  const angle = new Float32Array(n);
  const seedA = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dir = jitterDir(rotateDir(fibonacciDir(i, n), yaw, pitch), seedU, i, 0.02);
    pos[i * 3] = dir[0];
    pos[i * 3 + 1] = dir[1];
    pos[i * 3 + 2] = dir[2];
    const web = cosmicWeb(dir, cluster);
    shine[i] = (0.1 + 1.7 * hash01(seedU, i, 1) ** 2.3) * (0.22 + 0.78 * web);
    size[i] = 0.45 + 1.4 * hash01(seedU, i, 2);
    aspect[i] = 0.42 + 0.85 * hash01(seedU, i, 3);
    angle[i] = hash01(seedU, i, 4) * Math.PI * 2;
    seedA[i] = hash01(seedU, i, 5);
    const cool = hash01(seedU, i, 6);
    col[i * 3] = 0.86 - 0.34 * cool;
    col[i * 3 + 1] = 0.78 - 0.16 * cool;
    col[i * 3 + 2] = 0.64 + 0.16 * cool;
  }
  return { n, pos, col, shine, size, aspect, angle, seed: seedA };
}

export function cosmicStarVert(extinctGlsl: string): string {
  return /* glsl */ `
  ${extinctGlsl}
  attribute vec3 aColor;
  attribute float aShine;
  uniform vec3 uCenter;
  uniform float uStarGain;
  uniform float uPinCanvas;
  varying vec3 vColor;
  varying float vI;
  varying float vPx;

  void main() {
    vec3 dir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(dir, 0.0);
    // Limb / behind: w ≈ 0 puts a pin on the lens and it flashes.
    if (mv.z > -0.08) {
      vI = 0.0;
      vPx = 0.0;
      vColor = vec3(0.0);
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 ext = extinctLook(uCenter, dir);
    float extLum = dot(ext, vec3(0.2126, 0.7152, 0.0722));
    vI = aShine * uStarGain * extLum;
    vColor = aColor * ext / max(extLum, 1e-3);
    gl_PointSize = uPinCanvas;
    vPx = uPinCanvas;
    vec4 clip = projectionMatrix * mv;
    gl_Position = vec4(clip.xy, clip.w, clip.w);
  }
`;
}

export function cosmicStarFrag(): string {
  return /* glsl */ `
  uniform float uPinCore;
  varying vec3 vColor;
  varying float vI;
  varying float vPx;

  void main() {
    if (vI < 1e-5) discard;
    vec2 d = (gl_PointCoord - 0.5) * vPx;
    float w = exp(-dot(d, d) * uPinCore);
    if (w < 0.012) discard;
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
  uniform vec3 uCenter;
  uniform float uCosmicGain;
  uniform float uCosmicSize;
  uniform float uPxPerRad;
  varying vec3 vColor;
  varying float vI;
  varying float vAspect;
  varying float vAngle;
  varying float vSeed;

  void main() {
    vec3 dir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(dir, 0.0);
    if (mv.z > -0.08) {
      vI = 0.0;
      vColor = vec3(0.0);
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 ext = extinctLook(uCenter, dir);
    float extLum = dot(ext, vec3(0.2126, 0.7152, 0.0722));
    vI = aShine * uCosmicGain * extLum;
    vColor = aColor * ext / max(extLum, 1e-3);
    vAspect = max(aAspect, 0.25);
    vAngle = aAngle;
    vSeed = aSeed;
    float ang = max(aSize, 0.2) * max(uCosmicSize, 0.06) * 0.048;
    gl_PointSize = clamp(ang * uPxPerRad, 8.0, 180.0);
    vec4 clip = projectionMatrix * mv;
    gl_Position = vec4(clip.xy, clip.w, clip.w);
  }
`;
}

export function cosmicSmudgeFrag(): string {
  return /* glsl */ `
  varying vec3 vColor;
  varying float vI;
  varying float vAspect;
  varying float vAngle;
  varying float vSeed;

  void main() {
    if (vI < 1e-5) discard;
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float ca = cos(vAngle);
    float sa = sin(vAngle);
    vec2 p = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    p.y /= vAspect;
    p += vec2(
      0.28 * sin(p.y * 5.2 + vSeed * 6.2831853),
      0.28 * cos(p.x * 4.6 + vSeed * 9.1)
    );
    float lump = 0.45 + 0.7 * sin(p.x * 7.1 + p.y * 5.4 + vSeed * 13.0);
    float blob = exp(-dot(p, p) * 3.4) * max(0.0, lump);
    if (blob < 0.02) discard;
    gl_FragColor = vec4(vColor * (vI * blob), 1.0);
  }
`;
}

