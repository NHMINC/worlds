/**
 * Dust is a catalog of deaths. Each smear is an explosion that
 * never ends, dragged into an arc by differential rotation. The
 * explorer never draws dust — it bakes those arcs into a volume
 * and marches the sightline. A star behind a filament goes dark.
 */
import { UNIVERSE } from './physics';
import { collectDustSmears, omegaShear } from './galaxy';
import { mulberry32 } from './rng';

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

function splat(data: Float32Array, nx: number, ny: number, nz: number, fx: number, fy: number, fz: number, rho: number): void {
  const ix = Math.round(fx);
  const iy = Math.round(fy);
  const iz = Math.round(fz);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
  const i = ix + nx * (iy + ny * iz);
  data[i] = Math.min(1, data[i] + rho);
}

/** Sample death-smears into a 3D density volume. Empty space stays 0. */
export function bakeDustVolume(seed: string): DustVolume {
  const nx = UNIVERSE.GALAXY_DUST_VOL_N;
  const ny = UNIVERSE.GALAXY_DUST_VOL_NY;
  const nz = nx;
  const { origin, size } = dustVolumeBounds();
  const data = new Float32Array(nx * ny * nz);
  const vx = size[0] / nx;
  const vy = size[1] / ny;
  const vz = size[2] / nz;
  const step = Math.min(vx, vy, vz) * 0.7;
  const rho = UNIVERSE.GALAXY_DUST_SMEAR_RHO;
  const smears = collectDustSmears(seed);
  for (let e = 0; e < smears.length; e++) {
    const ev = smears[e];
    const rng = mulberry32(ev.seed);
    const omegaE = omegaShear(ev.R);
    for (let r = 0; r < ev.rays; r++) {
      const az = rng() * Math.PI * 2;
      const alt = (rng() - 0.5) * ev.loft;
      const ca = Math.cos(alt);
      const dx = ca * Math.cos(az);
      const dy = Math.sin(alt);
      const dz = ca * Math.sin(az);
      const len = ev.rExp * (0.4 + 0.6 * rng());
      for (let s = 0; s <= len; s += step) {
        const px = ev.x + dx * s;
        const py = ev.y + dy * s;
        const pz = ev.z + dz * s;
        const R = Math.hypot(px, pz);
        const th = R > 1e-8 ? Math.atan2(pz, px) : 0;
        const th2 = th + (omegaShear(R) - omegaE) * ev.ageGyr;
        const x2 = R * Math.cos(th2);
        const z2 = R * Math.sin(th2);
        const fx = ((x2 - origin[0]) / size[0]) * nx - 0.5;
        const fy = ((py - origin[1]) / size[1]) * ny - 0.5;
        const fz = ((z2 - origin[2]) / size[2]) * nz - 0.5;
        splat(data, nx, ny, nz, fx, fy, fz, rho);
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
