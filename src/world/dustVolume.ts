/**
 * Dust is the dense tail of the molecular sheet. The explorer
 * never draws dust; it bakes `ismAt` into a volume and marches
 * the sightline. Most of the disc stays 0 — only the filaments
 * write. Occupancy (`dustClumpsInCell`) is a separate census.
 */
import { UNIVERSE } from './physics';
import { ismAt } from './galaxy';

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
  const pad = 0.2;
  const half = UNIVERSE.GALAXY_R_MAX + pad;
  const yHalf = UNIVERSE.GALAXY_Z_THICK * 4 + pad;
  return {
    origin: [-half, -yHalf, -half],
    size: [2 * half, 2 * yHalf, 2 * half],
  };
}

/** Sample the ISM dense tail into a 3D density volume. Empty space stays 0. */
export function bakeDustVolume(
  seed: string,
  onProgress?: (frac: number) => void,
): DustVolume {
  const nx = UNIVERSE.GALAXY_DUST_VOL_N;
  const ny = UNIVERSE.GALAXY_DUST_VOL_NY;
  const nz = nx;
  const { origin, size } = dustVolumeBounds();
  const data = new Float32Array(nx * ny * nz);
  const vx = size[0] / nx;
  const vy = size[1] / ny;
  const vz = size[2] / nz;
  const cut = UNIVERSE.GALAXY_DUST_DENSE_CUT;
  const streak = UNIVERSE.GALAXY_DUST_STREAK;
  for (let iy = 0; iy < ny; iy++) {
    const y = origin[1] + (iy + 0.5) * vy;
    for (let iz = 0; iz < nz; iz++) {
      const z = origin[2] + (iz + 0.5) * vz;
      for (let ix = 0; ix < nx; ix++) {
        const x = origin[0] + (ix + 0.5) * vx;
        const field = ismAt(seed, x, y, z).photo;
        const excess = field - cut;
        if (excess <= 0) continue;
        data[ix + nx * (iy + ny * iz)] = Math.min(1, excess ** streak);
      }
    }
    onProgress?.((iy + 1) / ny);
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
