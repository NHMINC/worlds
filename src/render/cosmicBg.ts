/**
 * Cosmic background: the decreed outer shell. One inverted sphere,
 * a void colour, and a cheap angular field of galaxy smudges.
 * Not a catalog. Not pickable. Seeded from the bottle seed.
 */
import { xmur3 } from '../world/rng';

/** Void colour: black → very dark blue. */
export function cosmicVoidRgb(t: number): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  return [0.018 * u, 0.032 * u, 0.07 * u];
}

export function cosmicVert(): string {
  return /* glsl */ `
  uniform vec3 uCenter;
  uniform float uCosmicR;
  varying vec3 vDir;
  void main() {
    vec3 cat = normalize(position) * uCosmicR;
    vDir = cat;
    vec3 view = cat - uCenter;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(view, 1.0);
  }
`;
}

export function cosmicFrag(extinctGlsl: string): string {
  return /* glsl */ `
  ${extinctGlsl}
  uniform vec3 uCenter;
  uniform float uVoid;
  uniform float uCosmicGain;
  uniform float uCosmicOcc;
  uniform float uCosmicCluster;
  uniform float uCosmicCells;
  uniform float uCosmicSize;
  uniform float uSeed;
  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * vec3(0.1031, 0.11369, 0.13787) + uSeed);
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973) + uSeed);
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  void main() {
    vec3 dir = normalize(vDir);
    float web = 0.62 * vnoise(dir * 2.15 + 1.7) + 0.38 * vnoise(dir * 5.4 + 4.1);
    web = pow(clamp(web, 0.0, 1.0), max(uCosmicCluster, 0.35));

    float cells = max(uCosmicCells, 4.0);
    vec3 g = dir * cells;
    vec3 id = floor(g);
    float smudge = 0.0;
    vec3 tint = vec3(0.0);
    for (int z = -1; z <= 1; z++) {
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 cid = id + vec3(float(x), float(y), float(z));
          float h = hash13(cid);
          float keep = step(h, uCosmicOcc * mix(0.1, 1.15, web));
          if (keep < 0.5) continue;
          vec3 jitter = hash33(cid) - 0.5;
          vec3 cdir = normalize(cid + 0.5 + jitter * 0.65);
          vec3 t1 = normalize(cross(cdir, vec3(0.07, 1.0, 0.13)));
          vec3 t2 = cross(cdir, t1);
          vec2 q = vec2(dot(dir - cdir, t1), dot(dir - cdir, t2)) * cells;
          float ang = h * 6.2831853;
          float ca = cos(ang);
          float sa = sin(ang);
          vec2 p = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
          float aspect = 0.42 + 0.85 * hash13(cid + 17.0);
          p.y /= aspect;
          float sz = max(uCosmicSize, 0.06);
          p /= sz;
          vec2 warp = vec2(
            vnoise(vec3(p * 1.8, h * 5.0) + cid) - 0.5,
            vnoise(vec3(p.yx * 1.8, h * 9.0) + cid.yzx) - 0.5
          );
          p += warp * (0.38 + 0.34 * hash13(cid + 5.0));
          float lump = 0.22 + 1.15 * vnoise(vec3(p * 3.1, h * 13.0) + cid.zxy);
          lump *= 0.45 + 0.7 * vnoise(vec3(p.yx * 5.4, h * 21.0) + cid);
          float blob = exp(-dot(p, p) * 11.5) * max(0.0, lump) * (0.4 + 0.6 * h);
          smudge += blob;
          float cool = hash13(cid + 31.0);
          tint += blob * mix(vec3(0.86, 0.78, 0.64), vec3(0.52, 0.62, 0.8), cool);
        }
      }
    }

    vec3 voidC = vec3(0.018, 0.032, 0.07) * uVoid;
    vec3 ext = extinctT(uCenter, dir * length(vDir));
    vec3 glow = vec3(0.0);
    if (smudge > 1e-4) {
      glow = (tint / smudge) * (smudge / (1.0 + 1.8 * smudge)) * uCosmicGain * ext;
    }
    gl_FragColor = vec4(voidC + glow, 1.0);
  }
`;
}

export function cosmicSeedFloat(seed: string): number {
  return xmur3(`cosmic:${seed}`)() / 4294967296;
}

