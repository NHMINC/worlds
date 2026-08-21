/**
 * CPU copy of `extinctGlsl` in galaxyView. Same column, same
 * knobs. Used once when the catalog freezes on SOI entry so
 * the vertex march can sleep. If you change the march, change
 * both.
 */
import { UNIVERSE } from './physics';
import type { DustVolume } from './dustVolume';

const STEPS = UNIVERSE.GALAXY_EXTINCT_STEPS;
const K_FULL = UNIVERSE.GALAXY_EXTINCT_K_FULL;
const COL = UNIVERSE.GALAXY_EXTINCT_COL;
const RAMP = UNIVERSE.GALAXY_EXTINCT_RAMP;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-12));
  return t * t * (3 - 2 * t);
}

function sampleRhoRaw(vol: DustVolume, x: number, y: number, z: number): number {
  const ux = (x - vol.origin[0]) / vol.size[0];
  const uy = (y - vol.origin[1]) / vol.size[1];
  const uz = (z - vol.origin[2]) / vol.size[2];
  if (ux < 0 || uy < 0 || uz < 0 || ux > 1 || uy > 1 || uz > 1) return 0;
  const nx = vol.nx;
  const ny = vol.ny;
  const nz = vol.nz;
  const fx = ux * nx - 0.5;
  const fy = uy * ny - 0.5;
  const fz = uz * nz - 0.5;
  const x0 = Math.min(nx - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(ny - 1, Math.max(0, Math.floor(fy)));
  const z0 = Math.min(nz - 1, Math.max(0, Math.floor(fz)));
  const x1 = Math.min(nx - 1, x0 + 1);
  const y1 = Math.min(ny - 1, y0 + 1);
  const z1 = Math.min(nz - 1, z0 + 1);
  const tx = clamp01(fx - Math.floor(fx));
  const ty = clamp01(fy - Math.floor(fy));
  const tz = clamp01(fz - Math.floor(fz));
  const data = vol.data;
  const at = (ix: number, iy: number, iz: number) => data[ix + nx * (iy + ny * iz)];
  const c00 = at(x0, y0, z0) * (1 - tx) + at(x1, y0, z0) * tx;
  const c10 = at(x0, y1, z0) * (1 - tx) + at(x1, y1, z0) * tx;
  const c01 = at(x0, y0, z1) * (1 - tx) + at(x1, y0, z1) * tx;
  const c11 = at(x0, y1, z1) * (1 - tx) + at(x1, y1, z1) * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function extinctGrade(): number {
  return Math.min(UNIVERSE.GALAXY_EXTINCT_K / Math.max(K_FULL, 1e-6), 1);
}

function march(
  vol: DustVolume,
  from: [number, number, number],
  dir: [number, number, number],
  t0: number,
  dCat: number,
): [number, number] {
  const dt = dCat / STEPS;
  const h = Math.max(dt, 0.04) * 0.33;
  const lo = Math.max(UNIVERSE.GALAXY_EXTINCT_CUT, 1e-3);
  const v0 = lo * 0.55;
  const abyss = Math.max(UNIVERSE.GALAXY_EXTINCT_ABYSS, v0 * 2);
  const cut = UNIVERSE.GALAXY_EXTINCT_CUT;
  const hard = Math.max(UNIVERSE.GALAXY_EXTINCT_HARD, 0.15);
  let skin = 0;
  let col = 0;
  for (let i = 0; i < STEPS; i++) {
    const t = t0 + (i + 0.5) * dt;
    const px = from[0] + dir[0] * t;
    const py = from[1] + dir[1] * t;
    const pz = from[2] + dir[2] * t;
    const r1 = sampleRhoRaw(vol, px - dir[0] * h, py - dir[1] * h, pz - dir[2] * h);
    const r2 = sampleRhoRaw(vol, px, py, pz);
    const r3 = sampleRhoRaw(vol, px + dir[0] * h, py + dir[1] * h, pz + dir[2] * h);
    col +=
      (Math.pow(smoothstep(v0, abyss, r1), RAMP) +
        Math.pow(smoothstep(v0, abyss, r2), RAMP) +
        Math.pow(smoothstep(v0, abyss, r3), RAMP)) *
      (dt / 3);
    const raw = Math.max(r2, Math.max(r1, r3));
    skin += Math.pow(Math.max(raw - cut, 0), hard);
  }
  return [skin, col / COL];
}

function tauFromMarch(m: [number, number], dCat: number): number {
  const k = UNIVERSE.GALAXY_EXTINCT_K;
  const cap = UNIVERSE.GALAXY_EXTINCT_MAX;
  let depth = Math.min(m[0] * k * dCat * (1 / STEPS), cap);
  depth += cap * extinctGrade() * m[1];
  return Math.min(depth, cap);
}

function transmit(tau: number): [number, number, number] {
  const rgb = UNIVERSE.GALAXY_DUST_RGB;
  return [Math.exp(-tau * rgb[0]), Math.exp(-tau * rgb[1]), Math.exp(-tau * rgb[2])];
}

/** Camera → star column. Same as GLSL `extinctT`. */
export function extinctT(
  vol: DustVolume,
  from: [number, number, number],
  to: [number, number, number],
): [number, number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const dCat = Math.hypot(dx, dy, dz);
  if (dCat < 1e-4) return [1, 1, 1];
  const inv = 1 / dCat;
  const m = march(vol, from, [dx * inv, dy * inv, dz * inv], 0, dCat);
  return transmit(tauFromMarch(m, dCat));
}

/** Far-photograph look. Same as GLSL `extinctLook`. */
export function extinctLook(
  vol: DustVolume,
  from: [number, number, number],
  dir: [number, number, number],
): [number, number, number] {
  const d = [dir[0] || 1e-8, dir[1] || 1e-8, dir[2] || 1e-8] as [number, number, number];
  const b0 = vol.origin;
  const b1: [number, number, number] = [
    vol.origin[0] + vol.size[0],
    vol.origin[1] + vol.size[1],
    vol.origin[2] + vol.size[2],
  ];
  const tA = [(b0[0] - from[0]) / d[0], (b0[1] - from[1]) / d[1], (b0[2] - from[2]) / d[2]];
  const tB = [(b1[0] - from[0]) / d[0], (b1[1] - from[1]) / d[1], (b1[2] - from[2]) / d[2]];
  const tmin = [Math.min(tA[0], tB[0]), Math.min(tA[1], tB[1]), Math.min(tA[2], tB[2])];
  const tmax = [Math.max(tA[0], tB[0]), Math.max(tA[1], tB[1]), Math.max(tA[2], tB[2])];
  const enter = Math.max(tmin[0], Math.max(tmin[1], tmin[2]));
  const leave = Math.min(tmax[0], Math.min(tmax[1], tmax[2]));
  if (leave < 0 || enter > leave) return [1, 1, 1];
  const t0 = Math.max(enter, 0);
  const dCat = leave - t0;
  if (dCat < 1e-4) return [1, 1, 1];
  const m = march(vol, from, d, t0, dCat);
  return transmit(tauFromMarch(m, dCat));
}
