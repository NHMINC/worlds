/**
 * Dust clumps are the fog. Each harvest clump is a sphere of
 * influence (radius + gain from the ISM field). The explorer
 * never draws those rows — it bakes them into a density volume
 * and marches the sightline. A star behind a cloud goes dark.
 */
import { UNIVERSE } from './physics';
import { KIND_DUST } from './skyShape';

export interface DustRows {
  n: number;
  pos: ArrayLike<number>;
  size: ArrayLike<number>;
  gain: ArrayLike<number>;
  kind: ArrayLike<number>;
}

export interface DustVolume {
  nx: number;
  ny: number;
  nz: number;
  /** Catalog-kpc min corner (x, y, z). */
  origin: [number, number, number];
  /** Catalog-kpc extent. */
  size: [number, number, number];
  /** nx * ny * nz, index = ix + nx * (iy + ny * iz). */
  data: Float32Array;
}

export function dustVolumeBounds(): {
  origin: [number, number, number];
  size: [number, number, number];
} {
  const pad = UNIVERSE.GALAXY_DUST_R_MAX;
  const half = UNIVERSE.GALAXY_R_MAX + pad;
  const yHalf = UNIVERSE.GALAXY_Z_THICK * 4 + pad;
  return {
    origin: [-half, -yHalf, -half],
    size: [2 * half, 2 * yHalf, 2 * half],
  };
}

/** Envelope at a point: gain · max(0, 1 − r²/R²). Same skin writeDust stores. */
export function clumpEnvelope(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  gain: number,
): number {
  const r = Math.max(radius, 1e-4);
  const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
  const t = 1 - d2 / (r * r);
  return t > 0 ? gain * t : 0;
}

/** Splat every dust row into a 3D density field. Empty space stays 0. */
export function bakeDustVolume(rows: DustRows): DustVolume {
  const nx = UNIVERSE.GALAXY_DUST_VOL_N;
  const ny = UNIVERSE.GALAXY_DUST_VOL_NY;
  const nz = nx;
  const { origin, size } = dustVolumeBounds();
  const data = new Float32Array(nx * ny * nz);
  const vx = size[0] / nx;
  const vy = size[1] / ny;
  const vz = size[2] / nz;
  const [ox, oy, oz] = origin;
  for (let i = 0; i < rows.n; i++) {
    if (rows.kind[i] !== KIND_DUST) continue;
    const cx = rows.pos[i * 3];
    const cy = rows.pos[i * 3 + 1];
    const cz = rows.pos[i * 3 + 2];
    const R = Math.max(rows.size[i], 1e-4);
    const gain = Math.max(0, rows.gain[i]);
    const peak = UNIVERSE.GALAXY_DUST_RHO0 + UNIVERSE.GALAXY_DUST_RHO1 * gain;
    // Never thinner than a voxel — a 0.05 kpc wisp would miss the
    // cell centre and vanish from the fog.
    const Rs = Math.max(R, 0.55 * Math.max(vx, vy, vz));
    if (peak <= 0) continue;
    const ix0 = Math.max(0, Math.floor((cx - Rs - ox) / vx));
    const ix1 = Math.min(nx - 1, Math.floor((cx + Rs - ox) / vx));
    const iy0 = Math.max(0, Math.floor((cy - Rs - oy) / vy));
    const iy1 = Math.min(ny - 1, Math.floor((cy + Rs - oy) / vy));
    const iz0 = Math.max(0, Math.floor((cz - Rs - oz) / vz));
    const iz1 = Math.min(nz - 1, Math.floor((cz + Rs - oz) / vz));
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = oz + (iz + 0.5) * vz;
      for (let iy = iy0; iy <= iy1; iy++) {
        const y = oy + (iy + 0.5) * vy;
        const row = nx * (iy + ny * iz);
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = ox + (ix + 0.5) * vx;
          const env = clumpEnvelope(x, y, z, cx, cy, cz, Rs, peak);
          if (env > 0) data[row + ix] += env;
        }
      }
    }
  }
  return { nx, ny, nz, origin, size, data };
}

function trilinear(vol: DustVolume, x: number, y: number, z: number): number {
  const { nx, ny, nz, origin: [ox, oy, oz], size, data } = vol;
  const fx = ((x - ox) / size[0]) * nx - 0.5;
  const fy = ((y - oy) / size[1]) * ny - 0.5;
  const fz = ((z - oz) / size[2]) * nz - 0.5;
  if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > nx - 0.5 || fy > ny - 0.5 || fz > nz - 0.5) {
    return 0;
  }
  const x0 = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(ny - 2, Math.floor(fy)));
  const z0 = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const tz = Math.max(0, Math.min(1, fz - z0));
  const at = (ix: number, iy: number, iz: number) => data[ix + nx * (iy + ny * iz)];
  const c00 = at(x0, y0, z0) * (1 - tx) + at(x0 + 1, y0, z0) * tx;
  const c10 = at(x0, y0 + 1, z0) * (1 - tx) + at(x0 + 1, y0 + 1, z0) * tx;
  const c01 = at(x0, y0, z0 + 1) * (1 - tx) + at(x0 + 1, y0, z0 + 1) * tx;
  const c11 = at(x0, y0 + 1, z0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1) * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

/** Optical depth along a segment. Same Riemann sum the vertex shader uses. */
export function clumpColumnTau(
  vol: DustVolume,
  from: [number, number, number],
  to: [number, number, number],
  steps = UNIVERSE.GALAXY_EXTINCT_STEPS,
  k = UNIVERSE.GALAXY_EXTINCT_K,
  cap = UNIVERSE.GALAXY_EXTINCT_MAX,
): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const dist = Math.hypot(dx, dy, dz);
  const dt = dist / Math.max(1, steps);
  let tau = 0;
  const inv = 1 / Math.max(dist, 1e-4);
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    tau += trilinear(vol, from[0] + dx * t * inv, from[1] + dy * t * inv, from[2] + dz * t * inv);
  }
  return Math.min(tau * k * dt, cap);
}

/** RGB transmittance exp(−τ · DUST_RGB). */
export function clumpTransmittance(
  vol: DustVolume,
  from: [number, number, number],
  to: [number, number, number],
): [number, number, number] {
  const tau = clumpColumnTau(vol, from, to);
  const rgb = UNIVERSE.GALAXY_DUST_RGB;
  return [Math.exp(-tau * rgb[0]), Math.exp(-tau * rgb[1]), Math.exp(-tau * rgb[2])];
}
