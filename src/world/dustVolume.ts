/**
 * Dust is the midplane clump photograph, baked RAW. The explorer
 * never draws dust; it bakes `ismAt.photo` into a volume and
 * marches the sightline. Carving the clouds out of the field
 * (floor + hardness — the old bake-time dense cut and streak)
 * happens in the march (`extinctRho`), so those are live knobs
 * and the raw cloud body is still known to the per-cloud
 * opacity law (`extinctMarch`). Most of the disc stays 0 — a
 * storage floor keeps empty space empty.
 *
 * The volume is samples of a continuous field, not bricks. A
 * lone voxel through hardware trilinear is (1−|x|)(1−|z|) —
 * a diamond face-on. Each crest is therefore splatted with a
 * small Gaussian (peak-preserving) so cloud crests and the lime
 * skin follow the field, not the lattice.
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
  // Loose grip opens the dust scale height (ZD / grip); the bake
  // volume must grow with it or tall ribbons are clipped flat.
  const zdEff = UNIVERSE.GALAXY_ZD_DUST / Math.max(UNIVERSE.GALAXY_DUST_GRIP, 0.05);
  const yHalf = Math.max(UNIVERSE.GALAXY_Z_THICK * 4, zdEff * 4) + pad;
  return {
    origin: [-half, -yHalf, -half],
    size: [2 * half, 2 * yHalf, 2 * half],
  };
}

/**
 * Peak-preserving Gaussian splat. Hardware trilinear of an
 * isolated sample is a separable tent — diamonds face-on. The
 * kernel is small and round in the disk (tighter in y): it only
 * anti-aliases the lattice. Shape comes from the warped field,
 * not from this stamp.
 */
function splatCrest(
  data: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  ix: number,
  iy: number,
  iz: number,
  peak: number,
): void {
  const invXz = 1 / (2 * 0.7 * 0.7);
  const invY = 1 / (2 * 0.45 * 0.45);
  for (let dj = -1; dj <= 1; dj++) {
    const jy = iy + dj;
    if (jy < 0 || jy >= ny) continue;
    const wy = Math.exp(-(dj * dj) * invY);
    for (let dk = -1; dk <= 1; dk++) {
      const jz = iz + dk;
      if (jz < 0 || jz >= nz) continue;
      for (let di = -1; di <= 1; di++) {
        const jx = ix + di;
        if (jx < 0 || jx >= nx) continue;
        const w = wy * Math.exp(-(di * di + dk * dk) * invXz);
        const i = jx + nx * (jy + ny * jz);
        const v = peak * w;
        if (v > data[i]) data[i] = v;
      }
    }
  }
}

/** Storage floor: field this thin can never matter to any carve
 *  (the shipped floor is 0.08) and skipping it keeps the volume
 *  sparse. Not a law — a compression constant. */
const BAKE_FLOOR = 0.02;

/** Sample the raw clump photograph into a 3D density volume.
 *  Empty space stays 0; the march carves the clouds. */
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
  for (let iy = 0; iy < ny; iy++) {
    const y = origin[1] + (iy + 0.5) * vy;
    for (let iz = 0; iz < nz; iz++) {
      const z = origin[2] + (iz + 0.5) * vz;
      for (let ix = 0; ix < nx; ix++) {
        const x = origin[0] + (ix + 0.5) * vx;
        const field = ismAt(seed, x, y, z).photo;
        if (field <= BAKE_FLOOR) continue;
        splatCrest(data, nx, ny, nz, ix, iy, iz, Math.min(1, field));
      }
    }
    onProgress?.((iy + 1) / ny);
  }
  return { nx, ny, nz, origin, size, data };
}
