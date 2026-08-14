/**
 * The shared galaxy: an SBbc (grand-design barred spiral) as a density
 * field plus an implicit stellar catalog. Nothing is stored. A star is
 * (seed, cell, slot) → position, population, IMF draw, birth time,
 * chemistry, then stellar.evolve.
 *
 * Lin–Shu arms are a cosine overdensity on a logarithmic spiral; the bar
 * is a Ferrers ellipsoid; the halo is a potential-shaped envelope. We do
 * not integrate N-body for 10 Gyr — that is the decreed shortcut, same
 * family as “orbits are stable by fiat.”
 */
import { mulberry32, xmur3 } from './rng';
import { UNIVERSE } from './physics';
import { evolve, imfMass, type StellarState } from './stellar';

export type Population = 'thin' | 'thick' | 'halo' | 'bulge' | 'bar';

export interface GalPos {
  /** Galactocentric radius (kpc). */
  R: number;
  /** Azimuth (rad). */
  theta: number;
  /** Height above the midplane (kpc). */
  z: number;
}

export interface GalaxyObject {
  id: number;
  pos: GalPos;
  pop: Population;
  inArm: boolean;
  star: StellarState;
}

const TAU = Math.PI * 2;
const sech2 = (x: number) => {
  const e = Math.exp(x);
  const s = 2 / (e + 1 / e);
  return s * s;
};

function rngFor(seed: string, ...parts: Array<string | number>): () => number {
  return mulberry32(xmur3(`galaxy:${seed}:${parts.join(':')}`)());
}

function u01(seed: string, ...parts: Array<string | number>): number {
  return rngFor(seed, ...parts)();
}

/** Logarithmic-spiral phase. 0 = arm crest. */
export function armPhase(R: number, theta: number): number {
  const { GALAXY_ARM_M: m, GALAXY_PITCH: pitch, GALAXY_RD: rd } = UNIVERSE;
  const cot = 1 / Math.max(0.05, Math.tan(pitch));
  return m * theta - m * cot * Math.log(Math.max(R, 0.15) / rd);
}

export function inSpiralArm(R: number, theta: number): boolean {
  const c = Math.cos(armPhase(R, theta));
  return c > 0.25;
}

/**
 * Component densities at a point (relative, not physical Msun/pc³).
 * The catalog only needs shape and contrast.
 */
export function densityParts(p: GalPos): Record<Population, number> {
  const U = UNIVERSE;
  const r = Math.hypot(p.R, p.z);
  const thin =
    Math.exp(-p.R / U.GALAXY_RD) *
    sech2(p.z / U.GALAXY_ZD) *
    (1 + U.GALAXY_ARM_A * Math.cos(armPhase(p.R, p.theta)));
  const thick = 0.14 * Math.exp(-p.R / U.GALAXY_RD_THICK) * sech2(p.z / U.GALAXY_Z_THICK);
  const bulge = 4.2 * Math.exp(-3.5 * (r / U.GALAXY_RE_BULGE));
  const x = p.R * Math.cos(p.theta);
  const y = p.R * Math.sin(p.theta);
  const rb2 =
    (x * x) / (U.GALAXY_BAR_A * U.GALAXY_BAR_A) +
    (y * y) / (U.GALAXY_BAR_B * U.GALAXY_BAR_B) +
    (p.z * p.z) / (U.GALAXY_BAR_C * U.GALAXY_BAR_C);
  const bar = rb2 < 1 ? 3.4 * Math.pow(1 - rb2, 1.8) : 0;
  const halo = 0.03 / Math.pow(1 + r / U.GALAXY_HALO_A, 3.2);
  return {
    thin: Math.max(0, thin),
    thick: Math.max(0, thick),
    bulge: Math.max(0, bulge),
    bar: Math.max(0, bar),
    halo: Math.max(0, halo),
  };
}

export function density(p: GalPos): number {
  const d = densityParts(p);
  return d.thin + d.thick + d.bulge + d.bar + d.halo;
}

function pickPop(d: Record<Population, number>, u: number): Population {
  const keys: Population[] = ['thin', 'thick', 'bulge', 'bar', 'halo'];
  let t = 0;
  for (const k of keys) t += d[k];
  if (t <= 0) return 'halo';
  let acc = 0;
  const cut = u * t;
  for (const k of keys) {
    acc += d[k];
    if (cut <= acc) return k;
  }
  return 'thin';
}

/**
 * Inside-out, leaky-box chemistry. Inner disk formed earlier and is
 * metal-richer; halo is old and poor; bulge is old and rich. C/O climbs
 * with Z and with thin-disk youth (AGB return).
 */
export function chemistry(
  pop: Population,
  R: number,
  ageGyr: number,
  scatter: number,
): { feh: number; carbon: number } {
  const rd = UNIVERSE.GALAXY_RD;
  const young = 1 - ageGyr / UNIVERSE.GALAXY_AGE_GYR;
  let feh = 0;
  if (pop === 'thin') feh = 0.18 - 0.07 * (R / rd) + 0.22 * young;
  else if (pop === 'thick') feh = -0.55 - 0.03 * (R / rd);
  else if (pop === 'halo') feh = -1.55 + 0.15 * (R / (rd * 4));
  else if (pop === 'bulge') feh = 0.25 - 0.4 * Math.max(0, ageGyr - 8) / 5;
  else feh = 0.05 - 0.04 * (R / rd);
  feh += (scatter - 0.5) * (pop === 'halo' ? 0.7 : 0.25);
  const zRel = Math.pow(10, feh);
  const carbon = 0.55 + 0.45 * Math.min(2.2, zRel) + 0.35 * Math.max(0, young) * (pop === 'thin' ? 1 : 0.2);
  return { feh, carbon };
}

/** Birth-age window (Gyr of age today) for a population at radius R. */
export function ageWindow(pop: Population, R: number): [number, number] {
  const T = UNIVERSE.GALAXY_AGE_GYR;
  if (pop === 'thin') {
    const start = 0.35 * (R / UNIVERSE.GALAXY_R_MAX) * T;
    return [0.02, T - start];
  }
  if (pop === 'thick') return [6.5, 11.5];
  if (pop === 'halo') return [10, T];
  if (pop === 'bulge') return [7.5, T];
  return [6, T];
}

export function cellCount(): number {
  return UNIVERSE.GALAXY_NR * UNIVERSE.GALAXY_NTH * UNIVERSE.GALAXY_NZ;
}

export function catalogSize(): number {
  return cellCount() * UNIVERSE.GALAXY_MAX_SLOT;
}

export function splitId(id: number): { cell: number; slot: number } {
  const max = UNIVERSE.GALAXY_MAX_SLOT;
  return { cell: Math.floor(id / max), slot: id % max };
}

export function packId(cell: number, slot: number): number {
  return cell * UNIVERSE.GALAXY_MAX_SLOT + slot;
}

function cellCenter(cell: number): GalPos {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const iz = cell % nz;
  const it = Math.floor(cell / nz) % nth;
  const ir = Math.floor(cell / (nz * nth));
  const R = ((ir + 0.5) / nr) * rMax;
  const theta = ((it + 0.5) / nth) * TAU;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const z = ((iz + 0.5) / nz - 0.5) * 2 * zMax;
  return { R, theta, z };
}

function cellVolume(cell: number): number {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const ir = Math.floor(cell / (nz * nth));
  const R0 = (ir / nr) * rMax;
  const R1 = ((ir + 1) / nr) * rMax;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / nz;
  const dtheta = TAU / nth;
  return 0.5 * (R1 * R1 - R0 * R0) * dtheta * dz;
}

/** How many slots in this cell are occupied. Density is the law. */
export function slotsInCell(seed: string, cell: number): number {
  const c = cellCenter(cell);
  const expect = density(c) * cellVolume(cell) * UNIVERSE.GALAXY_N_K;
  if (expect <= 0) return 0;
  const whole = Math.floor(expect);
  const extra = u01(seed, 'occ', cell) < expect - whole ? 1 : 0;
  return Math.min(UNIVERSE.GALAXY_MAX_SLOT, whole + extra);
}

/**
 * The object at a catalog id, or null if that slot is empty.
 * Pure and O(1). This is the whole galaxy.
 */
export function objectAt(seed: string, id: number): GalaxyObject | null {
  const { cell, slot } = splitId(id);
  if (cell < 0 || cell >= cellCount() || slot < 0) return null;
  const filled = slotsInCell(seed, cell);
  if (slot >= filled) return null;

  const rng = rngFor(seed, cell, slot);
  const mid = cellCenter(cell);
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const dR = rMax / nr;
  const dTh = TAU / nth;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / nz;
  const pos: GalPos = {
    R: Math.max(0.05, mid.R + (rng() - 0.5) * dR),
    theta: mid.theta + (rng() - 0.5) * dTh,
    z: mid.z + (rng() - 0.5) * dz,
  };
  const parts = densityParts(pos);
  const pop = pickPop(parts, rng());
  const [ageLo, ageHi] = ageWindow(pop, pos.R);
  const arm = inSpiralArm(pos.R, pos.theta);
  // Density wave: thin-disk births pile up on the arm crest (young = small age).
  let uAge = rng();
  if (pop === 'thin' && arm) uAge = Math.pow(uAge, 2.2);
  const ageGyr = ageLo + uAge * Math.max(0.01, ageHi - ageLo);
  const { feh, carbon } = chemistry(pop, pos.R, ageGyr, rng());
  const massZams = imfMass(rng());
  const star = evolve({ massZams, ageGyr, feh, carbon, inArm: arm });
  return { id, pos, pop, inArm: arm, star };
}

/** Walk a neighbourhood of cells; return occupied objects (capped). */
export function objectsNear(seed: string, p: GalPos, dR: number, limit = 80): GalaxyObject[] {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const ir0 = Math.max(0, Math.floor(((p.R - dR) / rMax) * nr));
  const ir1 = Math.min(nr - 1, Math.floor(((p.R + dR) / rMax) * nr));
  const dTh = dR / Math.max(0.4, p.R);
  const itc = Math.floor((((p.theta % TAU) + TAU) % TAU / TAU) * nth);
  const dit = Math.max(1, Math.ceil((dTh / TAU) * nth));
  const izc = Math.floor(((p.z / zMax + 1) / 2) * nz);
  const out: GalaxyObject[] = [];
  for (let ir = ir0; ir <= ir1 && out.length < limit; ir++) {
    for (let dt = -dit; dt <= dit && out.length < limit; dt++) {
      const it = (itc + dt + nth * 8) % nth;
      for (let iz = Math.max(0, izc - 1); iz <= Math.min(nz - 1, izc + 1) && out.length < limit; iz++) {
        const cell = ir * nth * nz + it * nz + iz;
        const n = slotsInCell(seed, cell);
        for (let s = 0; s < n && out.length < limit; s++) {
          const o = objectAt(seed, packId(cell, s));
          if (o) out.push(o);
        }
      }
    }
  }
  return out;
}

/**
 * A thin-disk G/K dwarf near the solar circle — the galactic cousin of
 * homeBodyId. Scan is init-only; the id is then a constant of the seed.
 */
export function homeStarId(seed = UNIVERSE.CANONICAL_SEED): number {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax, R_SUN: rSun } = UNIVERSE;
  const irSun = Math.round((rSun / rMax) * nr);
  const izMid = Math.floor(nz / 2);
  let best = -1;
  let bestScore = -1e9;
  for (let dir = 0; dir <= 4; dir++) {
    for (const sign of dir === 0 ? [0] : [-1, 1]) {
      const ir = irSun + sign * dir;
      if (ir < 2 || ir >= nr - 1) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const iz = izMid + dz;
        if (iz < 0 || iz >= nz) continue;
        for (let it = 0; it < nth; it++) {
          const cell = ir * nth * nz + it * nz + iz;
          const n = slotsInCell(seed, cell);
          for (let s = 0; s < n; s++) {
            const o = objectAt(seed, packId(cell, s));
            if (!o) continue;
            const st = o.star;
            if (st.phase !== 'main_sequence') continue;
            if (st.mk !== 'G' && st.mk !== 'K' && st.mk !== 'F') continue;
            if (st.lumClass !== 'V' && st.lumClass !== 'VI') continue;
            if (o.pop === 'halo') continue;
            const score =
              (st.mk === 'G' ? 4 : st.mk === 'K' ? 2.5 : 1) +
              (o.pop === 'thin' ? 1.2 : 0) +
              (1 - Math.abs(st.feh)) +
              (st.nebula === 'none' ? 0.3 : 0) -
              Math.abs(o.pos.R - rSun) * 0.15 -
              Math.abs(o.pos.z) * 0.4;
            if (score > bestScore) {
              bestScore = score;
              best = o.id;
            }
          }
        }
      }
    }
  }
  if (best < 0) throw new Error(`no FGK dwarf near the solar circle for seed ${seed}`);
  return best;
}

/** Convenience: the canonical galaxy's home star. */
export function homeStar(seed = UNIVERSE.CANONICAL_SEED): GalaxyObject | null {
  return objectAt(seed, homeStarId(seed));
}
