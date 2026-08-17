/**
 * The sector map: the explorer's projection of the catalog grid.
 *
 * The galaxy is divided into GALAXY_SECTORS pizza slices and
 * GALAXY_SECTOR_RINGS annuli. One (ring, sector) intersection — a
 * "thick arc" — is an EXACT block of catalog cells (a contiguous span
 * of catalog rings × a contiguous span of spokes × every z bin), so the
 * address system is untouched: every star id keeps meaning what it
 * always meant.
 *
 * Ring boundaries are placed by EQUAL ENCLOSED MASS: the cumulative
 * radial mass profile of the same density law everything else uses is
 * inverted so each annulus holds ~the same number of stars. Inner arcs
 * are physically thin, outer arcs wide — the saucer equalises itself.
 *
 * Everything here is pure functions of (seed, ring, sector). Nothing is
 * stored; the map is mathematics.
 */
import { UNIVERSE } from './physics';
import { mulberry32, xmur3 } from './rng';
import {
  cellCenter,
  cellsOverlappingAnnulus,
  cellsOverlappingBall,
  chemistry,
  density,
  densityParts,
  dustBirthCart,
  dustClumpsInCell,
  dustPhysics,
  galToCart,
  isSlotAlive,
  slotBirthCart,
  objectAt,
  packId,
  splitId,
  slotScatterKpc,
  slotBirthRaw,
  slotMsLum,
  spheroidScaleHeight,
  type SlotBirth,
  slotMsTeff,
  imfQuantile,
  slotRangeForMass,
  slotsInCell,
  type GalPos,
  type GalaxyObject,
} from './galaxy';
import { evolve, mkFromTeff, msLifetime, teffToRgb } from './stellar';
import { KIND_DUST, KIND_STAR, emissionLook, kindFromNebula, shapeAt, type SkyKind } from './skyShape';
import { bakeDustVolume, type DustVolume } from './dustVolume';

export { KIND_STAR, KIND_HII, KIND_PN, KIND_SNR, KIND_DUST } from './skyShape';

const TAU = Math.PI * 2;

export interface SectorId {
  /** Annulus index, 0 (centre) .. GALAXY_SECTOR_RINGS-1 (rim). */
  ring: number;
  /** Pizza-slice index, 0 .. GALAXY_SECTORS-1, from azimuth 0. */
  sector: number;
}

/** Human name: sectors are letters+number (S37), rings count outward. */
export function sectorName(id: SectorId): string {
  return `S${id.sector + 1}·R${id.ring + 1}`;
}

// ------------------------------------------------------------- ring law

/**
 * Mass of each CATALOG ring (relative units): the same density ×
 * volume product slotsInCell uses, azimuth- and z-averaged. Computed
 * once — pure of the constants, independent of seed.
 */
let ringMassMemo: number[] | null = null;

export function catalogRingMasses(): number[] {
  if (ringMassMemo) return ringMassMemo;
  const { GALAXY_NR: nr, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const out = new Array<number>(nr).fill(0);
  const NTH_SAMP = 24;
  for (let ir = 0; ir < nr; ir++) {
    const R = ((ir + 0.5) / nr) * rMax;
    const R0 = (ir / nr) * rMax;
    const R1 = ((ir + 1) / nr) * rMax;
    // Annulus volume for this catalog ring (all θ, full z slab).
    const vol = Math.PI * (R1 * R1 - R0 * R0) * 2 * zMax;
    let mean = 0;
    for (let s = 0; s < NTH_SAMP; s++) {
      const theta = ((s + 0.5) / NTH_SAMP) * TAU;
      for (let zi = 0; zi < nz; zi += 3) {
        const z = ((zi + 0.5) / nz - 0.5) * 2 * zMax;
        mean += density({ R, theta, z });
      }
    }
    mean /= NTH_SAMP * Math.ceil(nz / 3);
    out[ir] = mean * vol;
  }
  ringMassMemo = out;
  return out;
}

/**
 * Sector-ring boundaries as CATALOG ring indices: RINGS+1 ascending
 * values from 0 to GALAXY_NR. Greedy equal-mass walk — each sector
 * ring closes once it holds its share of the cumulative mass (or one
 * catalog ring, whichever is larger: an indivisible dense core ring
 * may exceed the share on its own).
 */
let ringBoundsMemo: number[] | null = null;

export function ringBounds(): number[] {
  if (ringBoundsMemo) return ringBoundsMemo;
  const { GALAXY_NR: nr, GALAXY_SECTOR_RINGS: rings } = UNIVERSE;
  const mass = catalogRingMasses();
  const total = mass.reduce((a, b) => a + b, 0);
  const bounds: number[] = [0];
  let acc = 0;
  let spent = 0;
  for (let ir = 0; ir < nr; ir++) {
    acc += mass[ir];
    const ringsLeft = rings - (bounds.length - 1);
    const massLeft = total - spent;
    const share = massLeft / Math.max(1, ringsLeft);
    // Close this sector ring when it has its share — but never leave
    // fewer catalog rings than sector rings still to cut.
    if (
      bounds.length <= rings - 1 &&
      acc >= share &&
      nr - (ir + 1) >= rings - bounds.length
    ) {
      bounds.push(ir + 1);
      spent += acc;
      acc = 0;
    }
  }
  while (bounds.length < rings) bounds.push(nr - (rings - bounds.length));
  bounds.push(nr);
  ringBoundsMemo = bounds;
  return bounds;
}

/** Outer radius (kpc) of each sector-ring boundary — RINGS+1 values. */
export function ringRadii(): number[] {
  const { GALAXY_NR: nr, GALAXY_R_MAX: rMax } = UNIVERSE;
  return ringBounds().map((ir) => (ir / nr) * rMax);
}

// ------------------------------------------------------------ addressing

/** Catalog spoke span [it0, it1) of a sector slice. Exact partition. */
export function spokeBounds(sector: number): [number, number] {
  const { GALAXY_NTH: nth, GALAXY_SECTORS: S } = UNIVERSE;
  return [Math.floor((sector * nth) / S), Math.floor(((sector + 1) * nth) / S)];
}

export function sectorOfPos(p: GalPos): SectorId {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_SECTORS: S, GALAXY_R_MAX: rMax } = UNIVERSE;
  const ir = Math.max(0, Math.min(nr - 1, Math.floor((p.R / rMax) * nr)));
  const bounds = ringBounds();
  let ring = 0;
  while (ring < bounds.length - 2 && ir >= bounds[ring + 1]) ring++;
  const thN = (((p.theta % TAU) + TAU) % TAU) / TAU;
  const it = Math.min(nth - 1, Math.floor(thN * nth));
  // Exact inverse of spokeBounds: floor partitions disagree with the
  // naive floor(it·S/nth) wherever nth/S is fractional, so walk to the
  // bracket that actually contains this spoke.
  let sector = Math.min(S - 1, Math.floor((it * S) / nth));
  while (sector < S - 1 && it >= Math.floor(((sector + 1) * nth) / S)) sector++;
  while (sector > 0 && it < Math.floor((sector * nth) / S)) sector--;
  return { ring, sector };
}

export function sectorOfCell(cell: number): SectorId {
  return sectorOfPos(cellCenter(cell));
}

/** Every catalog cell inside one arc (ring span × spoke span × all z). */
export function sectorCells(id: SectorId): number[] {
  const { GALAXY_NTH: nth, GALAXY_NZ: nz } = UNIVERSE;
  const bounds = ringBounds();
  const [it0, it1] = spokeBounds(id.sector);
  const out: number[] = [];
  for (let ir = bounds[id.ring]; ir < bounds[id.ring + 1]; ir++) {
    for (let it = it0; it < it1; it++) {
      for (let iz = 0; iz < nz; iz++) {
        out.push(ir * nth * nz + it * nz + iz);
      }
    }
  }
  return out;
}

/** Arc centre (mid radius, mid azimuth, midplane) for cameras and labels. */
export function sectorCenter(id: SectorId): GalPos {
  const { GALAXY_NTH: nth } = UNIVERSE;
  const radii = ringRadii();
  const [it0, it1] = spokeBounds(id.sector);
  const theta = (((it0 + it1) / 2) / nth) * TAU;
  return { R: (radii[id.ring] + radii[id.ring + 1]) / 2, theta, z: 0 };
}

/** Rough bounding radius of the arc (for camera framing). */
export function sectorSpan(id: SectorId): number {
  const radii = ringRadii();
  const r0 = radii[id.ring];
  const r1 = radii[id.ring + 1];
  const arc = ((r0 + r1) / 2) * (TAU / UNIVERSE.GALAXY_SECTORS);
  return Math.max(r1 - r0, arc, UNIVERSE.GALAXY_Z_THICK * 2) * 0.75;
}

// -------------------------------------------------------------- content

/** Exact occupied-slot count of an arc: the law, not an estimate. */
export function sectorPopulation(seed: string, id: SectorId): number {
  let n = 0;
  for (const cell of sectorCells(id)) n += slotsInCell(seed, cell);
  return n;
}

/** GPU point cloud of every occupied slot in a query volume. No evolve(). */
export interface StarCloud {
  n: number;
  /** Catalog ids. Float64 — a packed id exceeds 2³² at the outer disk. */
  ids: Float64Array;
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  pulse: Float32Array;
  /** Inherent brightness 0..1 (faint M dwarfs stay pinpricks). */
  gain: Float32Array;
  /** Filter bits: remnant, hot, sunlike, cool, halo, arm. */
  bits: Uint8Array;
  /** MK letter index 0=WD/other, 1=O .. 8=M, 9=L, 10=T. */
  mk: Uint8Array;
  /** Present-day luminosity (evolve sketch) or a dim remnant pin. */
  lum: Float32Array;
  /** Sky kind: star / hii / pn / snr / dust. */
  kind: Uint8Array;
  ms: number;
}

/** @deprecated use StarCloud — the play verb is a region, not an arc. */
export type ArcCloud = StarCloud;

const MK_IX: Record<string, number> = { O: 1, B: 2, A: 3, F: 4, G: 5, K: 6, M: 7, L: 8, T: 9 };

export const MK_LETTER = ['WD', 'O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T'] as const;

export const BIT_REMNANT = 1;
export const BIT_HOT = 2;
export const BIT_SUNLIKE = 4;
export const BIT_COOL = 8;
export const BIT_HALO = 16;
export const BIT_ARM = 32;
export const BIT_NEBULA = 64;
export const BIT_DUST = 128;

/** Dust clump (cell, k): an ISM address, not a catalog slot. */
export function dustId(cell: number, k: number): number {
  return -(cell * UNIVERSE.GALAXY_DUST_MAX + k + 1);
}

export function cellFromDustId(id: number): number {
  return Math.floor((-id - 1) / UNIVERSE.GALAXY_DUST_MAX);
}

export function isDustId(id: number): boolean {
  return id < 0;
}

export type GalaxyFilterName =
  | 'all'
  | 'hot'
  | 'sunlike'
  | 'cool'
  | 'remnant'
  | 'nebula'
  | 'halo'
  | 'arm';

export function sketchMatches(bits: number, f: GalaxyFilterName): boolean {
  if (f === 'all') return true;
  if (f === 'hot') return (bits & BIT_HOT) !== 0;
  if (f === 'sunlike') return (bits & BIT_SUNLIKE) !== 0;
  if (f === 'cool') return (bits & BIT_COOL) !== 0;
  if (f === 'remnant') return (bits & BIT_REMNANT) !== 0;
  if (f === 'nebula') return (bits & BIT_NEBULA) !== 0;
  if (f === 'halo') return (bits & BIT_HALO) !== 0;
  return (bits & BIT_ARM) !== 0;
}

function allocCloud(n: number): Omit<StarCloud, 'n' | 'ms'> {
  return {
    ids: new Float64Array(n),
    pos: new Float32Array(n * 3),
    col: new Float32Array(n * 3),
    size: new Float32Array(n),
    pulse: new Float32Array(n),
    gain: new Float32Array(n),
    bits: new Uint8Array(n),
    mk: new Uint8Array(n),
    lum: new Float32Array(n),
    kind: new Uint8Array(n),
  };
}

function giantWindow(massZams: number): number {
  const tMs = msLifetime(massZams);
  return Math.min(0.8, tMs * (massZams <= 2 ? 0.15 : massZams < 8 ? 0.08 : UNIVERSE.WR_TAIL));
}

/** Cheap clock gate: evolve only slots that can be luminous or nebular. */
function maybeClockRow(b: SlotBirth): boolean {
  const m = b.massZams;
  const tMs = msLifetime(m);
  if (b.ageGyr < tMs) {
    return m >= UNIVERSE.GALAXY_SILHOUETTE_M || (m >= 8 && b.ageGyr < UNIVERSE.HII_GYR && b.inCloud);
  }
  const deadFor = b.ageGyr - tMs - giantWindow(m);
  return deadFor < Math.max(UNIVERSE.PN_GYR, UNIVERSE.SNR_GYR) + 1e-9;
}

function isLuminousPhase(phase: string, mk: string | null, L: number): boolean {
  if (phase === 'wolf_rayet' || phase === 'carbon_star' || phase === 'giant' || phase === 'supergiant') {
    return true;
  }
  if (mk === 'O' || mk === 'B') return true;
  if (mk === 'A' && L >= 20) return true;
  return L >= 25;
}

function writeRow(
  id: number,
  x: number,
  y: number,
  z: number,
  i: number,
  c: Omit<StarCloud, 'n' | 'ms'>,
  opts: {
    rgb: [number, number, number];
    L: number;
    kind: SkyKind;
    bits: number;
    mk: number;
    pulse: number;
    size: number;
    gain: number;
  },
): void {
  c.ids[i] = id;
  c.pos[i * 3] = x;
  c.pos[i * 3 + 1] = y;
  c.pos[i * 3 + 2] = z;
  c.col[i * 3] = opts.rgb[0];
  c.col[i * 3 + 1] = opts.rgb[1];
  c.col[i * 3 + 2] = opts.rgb[2];
  c.size[i] = opts.size;
  c.gain[i] = opts.gain;
  c.pulse[i] = opts.pulse;
  c.bits[i] = opts.bits;
  c.mk[i] = opts.mk;
  c.lum[i] = opts.L;
  c.kind[i] = opts.kind;
}

function sketchEvolve(b: SlotBirth): ReturnType<typeof evolve> {
  const chem = chemistry(b.pop, b.pos.R, b.ageGyr, b.rng());
  return evolve({
    massZams: b.massZams,
    ageGyr: b.ageGyr,
    feh: chem.feh,
    carbon: chem.carbon,
    // Same clock objectAt runs: H II lights in the natal cloud.
    inArm: b.inCloud,
  });
}

function writeEvolved(
  cell: number,
  slot: number,
  i: number,
  c: Omit<StarCloud, 'n' | 'ms'>,
  b: SlotBirth,
  ev: ReturnType<typeof evolve>,
): void {
  const cart = galToCart(b.pos);
  const kind = kindFromNebula(ev.nebula);
  const shape = shapeAt(kind, packId(cell, slot));
  // The event law: expansion, fading, and hue from the clock row.
  const look =
    kind === KIND_STAR
      ? null
      : emissionLook(kind, packId(cell, slot), {
          deadFor: Math.max(0, ev.postGyr - giantWindow(ev.massZams)),
          ageGyr: ev.ageGyr,
          luminosity: ev.luminosity,
          carbon: ev.carbon,
          feh: ev.feh,
        });
  const rgb = look ? look.rgb : teffToRgb(ev.teff);
  const L = Math.max(ev.luminosity, kind === KIND_STAR ? 0 : 0.2);
  let bit = 0;
  if (ev.phase === 'white_dwarf' || ev.phase === 'neutron_star' || ev.phase === 'pulsar' || ev.phase === 'black_hole') {
    bit |= BIT_REMNANT;
  } else if (ev.mk === 'O' || ev.mk === 'B' || ev.mk === 'A' || ev.phase === 'wolf_rayet') bit |= BIT_HOT;
  else if (ev.mk === 'F' || ev.mk === 'G' || ev.mk === 'K') bit |= BIT_SUNLIKE;
  else bit |= BIT_COOL;
  if (b.pop === 'halo') bit |= BIT_HALO;
  if (b.inArm) bit |= BIT_ARM;
  if (ev.nebula !== 'none') bit |= BIT_NEBULA;
  writeRow(packId(cell, slot), cart.x, cart.y, cart.z, i, c, {
    rgb,
    L,
    kind,
    bits: bit,
    mk: ev.mk ? (MK_IX[ev.mk] ?? 0) : 0,
    pulse: shape.seed,
    size: look ? look.radiusKpc : L < 0.05 ? 1.15 : 1.45 + Math.min(5.2, Math.log10(1 + L) * 2.0),
    gain: look ? look.gain : 0.22 + 0.78 * (L / (L + 0.25)),
  });
}

function writeFromBirth(
  cell: number,
  slot: number,
  i: number,
  c: Omit<StarCloud, 'n' | 'ms'>,
  b: SlotBirth,
  alive: boolean,
  forceCheap = false,
): void {
  if (!forceCheap && maybeClockRow(b)) {
    writeEvolved(cell, slot, i, c, b, sketchEvolve(b));
    return;
  }
  const cart = galToCart(b.pos);
  const L = alive ? slotMsLum(b.massZams) : 0.004;
  const teff = alive ? slotMsTeff(b.massZams) : 9000;
  const rgb = alive ? teffToRgb(teff) : ([0.62, 0.7, 0.88] as [number, number, number]);
  let bit = 0;
  if (!alive) bit |= BIT_REMNANT;
  else if (b.massZams > 1.4) bit |= BIT_HOT;
  else if (b.massZams >= 0.7 && b.massZams <= 1.15) bit |= BIT_SUNLIKE;
  else bit |= BIT_COOL;
  if (b.pop === 'halo') bit |= BIT_HALO;
  if (b.inArm) bit |= BIT_ARM;
  writeRow(packId(cell, slot), cart.x, cart.y, cart.z, i, c, {
    rgb,
    L,
    kind: KIND_STAR,
    bits: bit,
    mk: alive ? (MK_IX[mkFromTeff(teff)] ?? 0) : 0,
    pulse: 0,
    size: L < 0.05 ? 1.15 : 1.45 + Math.min(5.2, Math.log10(1 + L) * 2.0),
    gain: 0.22 + 0.78 * (L / (L + 0.25)),
  });
}

const DUST_SILICATE: [number, number, number] = [0.44, 0.31, 0.21];
const DUST_SOOT: [number, number, number] = [0.27, 0.15, 0.1];
const DUST_ICE: [number, number, number] = [0.7, 0.78, 0.9];

function mix3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Envelope radius (kpc) from the ISM field. Wisps sit at R_MIN. */
function dustRadiusKpc(seed: string, cell: number, k: number): number {
  const shape = shapeAt(KIND_DUST, dustId(cell, k));
  const phys = dustPhysics(seed, cell);
  const jitter = 0.7 + 0.6 * shape.seed;
  const u = Math.pow(Math.max(0, phys.field), 1.3);
  const r0 = UNIVERSE.GALAXY_DUST_R_MIN;
  const r1 = UNIVERSE.GALAXY_DUST_R_MAX;
  return Math.min(r1, (r0 + (r1 - r0) * u) * jitter);
}

/**
 * One dust clump (census): scattered position, envelope from the
 * field. Grain colour is chemistry; `gain` is field × dust-to-gas.
 * These rows are not the fog — the volume samples the ISM field.
 */
function writeDust(seed: string, cell: number, k: number, i: number, c: Omit<StarCloud, 'n' | 'ms'>): void {
  const cart = dustBirthCart(seed, cell, k);
  const id = dustId(cell, k);
  const shape = shapeAt(KIND_DUST, id);
  const phys = dustPhysics(seed, cell);
  const radius = dustRadiusKpc(seed, cell, k);
  let rgb = mix3(DUST_SILICATE, DUST_SOOT, phys.carbonFrac);
  rgb = mix3(rgb, DUST_ICE, phys.iceFrac * 0.7);
  // Metallicity is the dust-to-gas ratio: metal-poor gas makes thin dust.
  const d2g = Math.min(1.6, Math.pow(10, 0.5 * phys.feh));
  writeRow(id, cart.x, cart.y, cart.z, i, c, {
    rgb,
    L: 0,
    kind: KIND_DUST,
    bits: BIT_DUST,
    mk: 0,
    pulse: shape.seed,
    size: radius,
    gain: Math.min(1, phys.field * d2g),
  });
}

function writeBirth(seed: string, cell: number, slot: number, filled: number, i: number, c: Omit<StarCloud, 'n' | 'ms'>): void {
  const b = slotBirthRaw(seed, cell, slot, filled);
  writeFromBirth(cell, slot, i, c, b, isSlotAlive(b.massZams, b.ageGyr));
}

function finishCloud(c: Omit<StarCloud, 'n' | 'ms'>, n: number, t0: number): StarCloud {
  if (n === c.ids.length) return { n, ...c, ms: performance.now() - t0 };
  return {
    n,
    ids: c.ids.slice(0, n),
    pos: c.pos.slice(0, n * 3),
    col: c.col.slice(0, n * 3),
    size: c.size.slice(0, n),
    pulse: c.pulse.slice(0, n),
    gain: c.gain.slice(0, n),
    bits: c.bits.slice(0, n),
    mk: c.mk.slice(0, n),
    lum: c.lum.slice(0, n),
    kind: c.kind.slice(0, n),
    ms: performance.now() - t0,
  };
}

function nebulaGain(ev: ReturnType<typeof evolve>, id: number): number {
  const kind = kindFromNebula(ev.nebula);
  if (kind === KIND_STAR) return 0;
  return emissionLook(kind, id, {
    deadFor: Math.max(0, ev.postGyr - giantWindow(ev.massZams)),
    ageGyr: ev.ageGyr,
    luminosity: ev.luminosity,
    carbon: ev.carbon,
    feh: ev.feh,
  }).gain;
}

function keepSilhouettePhase(ev: ReturnType<typeof evolve>, id: number): boolean {
  if (ev.nebula !== 'none') {
    // H II regions are the showpiece nurseries — keep every one.
    if (ev.nebula === 'hii') return true;
    return nebulaGain(ev, id) >= UNIVERSE.GALAXY_SILHOUETTE_NEB_GAIN;
  }
  if (ev.phase === 'white_dwarf' || ev.phase === 'neutron_star' || ev.phase === 'pulsar' || ev.phase === 'black_hole') {
    return false;
  }
  return isLuminousPhase(ev.phase, ev.mk, ev.luminosity) && ev.luminosity >= UNIVERSE.GALAXY_SILHOUETTE_L;
}

/** Living photosphere — not a remnant, not a nebula. Shape sample only. */
function keepShapePhotosphere(ev: ReturnType<typeof evolve>): boolean {
  if (ev.nebula !== 'none') return false;
  if (ev.phase === 'white_dwarf' || ev.phase === 'neutron_star' || ev.phase === 'pulsar' || ev.phase === 'black_hole') {
    return false;
  }
  return ev.luminosity >= 0.3;
}

/** Deterministic [0,1) for the occupancy shape sample. Not a player seed. */
function harvestShapeUnit(seed: string, cell: number, lane: number, attempt: number): number {
  return mulberry32(xmur3(`galaxy:${seed}:harvestShape:${cell}:${lane}:${attempt}`)())();
}

/**
 * One point per occupied slot in an arc tile. Kept for the saucer
 * tessellation checks — play uses `buildRegionCloud`.
 */
export function buildArcCloud(seed: string, id: SectorId): StarCloud {
  const t0 = performance.now();
  const cells = sectorCells(id);
  let n = 0;
  const filledOf = new Int32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const f = slotsInCell(seed, cells[i]);
    filledOf[i] = f;
    n += f;
  }
  const c = allocCloud(n);
  let i = 0;
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const filled = filledOf[ci];
    for (let slot = 0; slot < filled; slot++) writeBirth(seed, cell, slot, filled, i++, c);
  }
  return finishCloud(c, n, t0);
}

/** Human label for a region centre: "14.2 kpc · 46°". */
export function regionName(x: number, _y: number, z: number): string {
  const R = Math.hypot(x, z);
  const deg = (((Math.atan2(z, x) * 180) / Math.PI) + 360) % 360;
  return `${R.toFixed(1)} kpc · ${deg.toFixed(0)}°`;
}

/** IMF floor for a cell at distance d from the tap. 0 = every slot. */
export function regionImfFloor(d: number): number {
  const full = UNIVERSE.GALAXY_REGION_FULL_R;
  const ramp = UNIVERSE.GALAXY_REGION_U_RAMP;
  const t = Math.max(0, Math.min(1, (d - full) / Math.max(1e-4, ramp)));
  return t * UNIVERSE.GALAXY_REGION_U_FAR;
}

/**
 * Occupied slots inside a Cartesian ball. Near the tap the IMF is
 * complete. Farther cells keep only their massive tail — the same
 * zoom law as the catalog — so a multi-kpc volume has gaps you can
 * fly instead of a glowing marble. Cheap birth for dwarfs; the
 * clock sketch runs on luminous / nebula hosts so the Nebulae
 * filter and the backdrop handshake share one sky.
 */
export function buildRegionCloud(seed: string, x: number, y: number, z: number, r = UNIVERSE.GALAXY_REGION_R): StarCloud {
  const t0 = performance.now();
  const cells = cellsOverlappingBall(x, y, z, r);
  const filledOf = new Int32Array(cells.length);
  const slot0 = new Int32Array(cells.length);
  let cap = 0;
  for (let i = 0; i < cells.length; i++) {
    const f = slotsInCell(seed, cells[i]);
    filledOf[i] = f;
    if (f <= 0) continue;
    const d = cellDist(cells[i], x, y, z);
    // Far cells keep the massive tail. A harvest star can sit a
    // scale-height away from its lattice centre (the core bump);
    // if this cell can reach the tap, include that tail so the
    // star you are on does not vanish. Shape-sample pins are
    // addressable via objectAt; they are not this neighbourhood.
    let s0 = Math.floor(regionImfFloor(d) * f);
    if (d <= slotScatterKpc() + r) {
      s0 = Math.min(s0, Math.floor(imfQuantile(UNIVERSE.GALAXY_SILHOUETTE_M) * f));
    }
    slot0[i] = s0;
    cap += f - s0;
  }
  let c = allocCloud(cap + 8192);
  const r2 = r * r;
  let n = 0;
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const filled = filledOf[ci];
    for (let slot = slot0[ci]; slot < filled; slot++) {
      const p = slotBirthCart(seed, cell, slot);
      const dx = p.x - x;
      const dy = p.y - y;
      const dz = p.z - z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      writeBirth(seed, cell, slot, filled, n++, c);
    }
    const clumps = dustClumpsInCell(seed, cell);
    for (let k = 0; k < clumps; k++) {
      const cart = dustBirthCart(seed, cell, k);
      const dx = cart.x - x;
      const dy = cart.y - y;
      const dz = cart.z - z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 1024);
      writeDust(seed, cell, k, n++, c);
    }
  }
  return { n, ...c, ms: performance.now() - t0 };
}

/**
 * Harvest skip bound at arm crest. The inner sech uses the spheroid
 * scale so the box/peanut's z-bins are walked; living B stars remain
 * a thin-disk clock, but the core is allowed to be a bump.
 */
function thinDensityCeil(R: number, z: number): number {
  const U = UNIVERSE;
  const zd = Math.max(U.GALAXY_ZD, spheroidScaleHeight(R));
  const e = Math.exp(z / zd);
  const sech2z = (2 / (e + 1 / e)) ** 2;
  const blend = 1 / (1 + Math.exp((R - U.GALAXY_R_BREAK) / U.GALAXY_R_BREAK_W));
  const sig = blend * Math.exp(-R / U.GALAXY_RD_INNER) + (1 - blend) * Math.exp(-R / U.GALAXY_RD);
  return U.GALAXY_THIN_AMP * sig * sech2z * (1 + U.GALAXY_ARM_A + U.GALAXY_ARM_A2);
}

function catalogCellVolume(ir: number): number {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } = UNIVERSE;
  const R0 = (ir / nr) * rMax;
  const R1 = ((ir + 1) / nr) * rMax;
  const zMax = UNIVERSE.GALAXY_Z_THICK * 4;
  const dz = (2 * zMax) / nz;
  return 0.5 * (R1 * R1 - R0 * R0) * (TAU / nth) * dz;
}

let silhouetteMemo: { seed: string; cloud: StarCloud } | null = null;
let dustVolMemo: { seed: string; vol: DustVolume } | null = null;

function rememberDustVolume(seed: string): void {
  dustVolMemo = { seed, vol: bakeDustVolume(seed) };
}

/** Cached harvest, or null until the worker (or a sync mint) finishes. */
export function silhouetteCloud(seed: string): StarCloud | null {
  return silhouetteMemo?.seed === seed ? silhouetteMemo.cloud : null;
}

/** Baked ISM fog for this seed, or null until the harvest is in. */
export function harvestDustVolume(seed: string): DustVolume | null {
  return dustVolMemo?.seed === seed ? dustVolMemo.vol : null;
}

/** Install a harvest minted off-thread. Same cache `buildSilhouetteCloud` uses. */
export function installSilhouetteCloud(seed: string, cloud: StarCloud): void {
  silhouetteMemo = { seed, cloud };
  rememberDustVolume(seed);
}

/**
 * Upper bound of ismNorm at (R, z): arm crest and +1σ clump cancel
 * against the field's own normalization, leaving the bare gas disk.
 */
function gasDensityCeil(R: number, z: number): number {
  const U = UNIVERSE;
  const half = (2 * U.GALAXY_Z_THICK * 4) / U.GALAXY_NZ / 2;
  const zSheet = Math.abs(z) <= half ? 0 : z;
  const e = Math.exp(zSheet / U.GALAXY_ZD_GAS);
  const sech2z = (2 / (e + 1 / e)) ** 2;
  return Math.exp(-R / (U.GALAXY_RD * U.GALAXY_RD_GAS)) * sech2z;
}

/**
 * Whole-disk harvest. Default: luminous tail + occupancy shape
 * sample. HARVEST_ALL disables those gates — every occupied slot
 * is eligible; the bottle holds ALL_CAP pins as a uniform stride
 * through occupancy (the mass model). Nebulae are a complete
 * clock pass, not that budget. Dust rows are the census; the
 * extinction volume is the ISM field.
 */
export function buildSilhouetteCloud(seed: string): StarCloud {
  if (silhouetteMemo && silhouetteMemo.seed === seed) return silhouetteMemo.cloud;
  const t0 = performance.now();
  const cloud = UNIVERSE.GALAXY_HARVEST_ALL ? mintAllCloud(seed, t0) : mintHarvestCloud(seed, t0);
  silhouetteMemo = { seed, cloud };
  rememberDustVolume(seed);
  return cloud;
}

function mintHarvestCloud(seed: string, t0: number): StarCloud {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax, GALAXY_N_K: nK } =
    UNIVERSE;
  const zExtent = UNIVERSE.GALAXY_Z_THICK * 4;
  const mLo = UNIVERSE.GALAXY_SILHOUETTE_M;
  const uLive = imfQuantile(mLo);
  const uPhoto = imfQuantile(UNIVERSE.GALAXY_HARVEST_SHAPE_M);
  const liveFrac = Math.max(1e-6, 1 - uLive);
  const shapeF = UNIVERSE.GALAXY_HARVEST_SHAPE_F;
  let c = allocCloud(280_000);
  let n = 0;
  for (let ir = 0; ir < nr; ir++) {
    const vol = catalogCellVolume(ir);
    const R = ((ir + 0.5) / nr) * rMax;
    for (let iz = 0; iz < nz; iz++) {
      const z = ((iz + 0.5) / nz - 0.5) * 2 * zExtent;
      const ceil = thinDensityCeil(R, z) * vol * nK;
      const dustCeil = gasDensityCeil(R, z) * vol * UNIVERSE.GALAXY_DUST_N_K;
      if (ceil * liveFrac < 0.2 && dustCeil < 0.05 && ceil * shapeF * nth < 0.15) continue;
      for (let it = 0; it < nth; it++) {
        const cell = ir * nth * nz + it * nz + iz;
        const mid = cellCenter(cell);
        const parts = densityParts(mid);
        const spheroid = mid.R < UNIVERSE.GALAXY_BOX_A * 2.6 ? parts.bulge + parts.bar : 0;
        const expect = (parts.thin + spheroid) * vol * nK;
        const wantTail = expect * liveFrac >= 0.2;
        const wantShape = ceil * shapeF >= 1e-8;
        if (wantTail || wantShape) {
          const filled = slotsInCell(seed, cell);
          if (filled > 0) {
            if (wantTail) {
              const sLive = Math.floor(uLive * filled);
              for (let slot = sLive; slot < filled; slot++) {
                const birth = slotBirthRaw(seed, cell, slot, filled);
                if (!maybeClockRow(birth)) continue;
                const ev = sketchEvolve(birth);
                if (!keepSilhouettePhase(ev, packId(cell, slot))) continue;
                if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
                writeEvolved(cell, slot, n++, c, birth, ev);
              }
            }
            if (wantShape) {
              const grown = writeShapeSample(seed, cell, filled, uPhoto, uLive, c, n);
              c = grown.c;
              n = grown.n;
            }
          }
        }
        if (dustCeil >= 0.05) {
          const clumps = dustClumpsInCell(seed, cell);
          for (let k = 0; k < clumps; k++) {
            if (dustRadiusKpc(seed, cell, k) < UNIVERSE.GALAXY_SILHOUETTE_DUST_R) continue;
            if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
            writeDust(seed, cell, k, n++, c);
          }
        }
      }
    }
  }
  return finishCloud(c, n, t0);
}

/**
 * Harvester off for count. The bottle's ALL_CAP pins are a
 * uniform stride through the photograph band (SHAPE_M and up)
 * — mass among stars that emit. I is still L. Nebulae stay
 * the old showpiece gate (H II + NEB_GAIN), not every shell.
 */
function mintAllCloud(seed: string, t0: number): StarCloud {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax } =
    UNIVERSE;
  const zExtent = UNIVERSE.GALAXY_Z_THICK * 4;
  const uLive = imfQuantile(UNIVERSE.GALAXY_SILHOUETTE_M);
  const uPhoto = imfQuantile(UNIVERSE.GALAXY_HARVEST_SHAPE_M);
  const cap = UNIVERSE.GALAXY_HARVEST_ALL_CAP;
  let occupied = 0;
  for (let ir = 0; ir < nr; ir++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let it = 0; it < nth; it++) {
        const cell = ir * nth * nz + it * nz + iz;
        const filled = slotsInCell(seed, cell);
        if (filled > 0) occupied += Math.max(0, filled - Math.ceil(uPhoto * filled));
      }
    }
  }
  const f = Math.min(1, cap / Math.max(1, occupied));
  let c = allocCloud(cap + 80_000);
  let n = 0;
  for (let ir = 0; ir < nr; ir++) {
    const vol = catalogCellVolume(ir);
    const R = ((ir + 0.5) / nr) * rMax;
    for (let iz = 0; iz < nz; iz++) {
      const z = ((iz + 0.5) / nz - 0.5) * 2 * zExtent;
      const dustCeil = gasDensityCeil(R, z) * vol * UNIVERSE.GALAXY_DUST_N_K;
      for (let it = 0; it < nth; it++) {
        const cell = ir * nth * nz + it * nz + iz;
        const filled = slotsInCell(seed, cell);
        if (filled > 0) {
          const sPhoto = Math.min(filled, Math.ceil(uPhoto * filled));
          const grown = writeAllMass(seed, cell, filled, sPhoto, f, c, n);
          c = grown.c;
          n = grown.n;
          const sLive = Math.min(filled, Math.floor(uLive * filled));
          for (let slot = sLive; slot < filled; slot++) {
            if (massSlotKept(seed, cell, filled, sPhoto, f, slot)) continue;
            const birth = slotBirthRaw(seed, cell, slot, filled);
            if (!maybeClockRow(birth)) continue;
            const ev = sketchEvolve(birth);
            if (ev.nebula === 'none') continue;
            if (!keepSilhouettePhase(ev, packId(cell, slot))) continue;
            if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
            writeEvolved(cell, slot, n++, c, birth, ev);
          }
        }
        if (dustCeil >= 0.05) {
          const clumps = dustClumpsInCell(seed, cell);
          for (let k = 0; k < clumps; k++) {
            if (dustRadiusKpc(seed, cell, k) < UNIVERSE.GALAXY_SILHOUETTE_DUST_R) continue;
            if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
            writeDust(seed, cell, k, n++, c);
          }
        }
      }
    }
  }
  return finishCloud(c, n, t0);
}

function massKeepCount(seed: string, cell: number, band: number, f: number): number {
  if (band <= 0 || f <= 0) return 0;
  const expect = band * f;
  return Math.floor(expect) + (harvestShapeUnit(seed, cell, 0, 0) < expect - Math.floor(expect) ? 1 : 0);
}

function massSlotKept(seed: string, cell: number, filled: number, s0: number, f: number, slot: number): boolean {
  const band = filled - s0;
  const nKeep = massKeepCount(seed, cell, band, f);
  if (nKeep <= 0 || slot < s0) return false;
  if (nKeep >= band) return true;
  const stride = band / nKeep;
  const offset = harvestShapeUnit(seed, cell, 1, 0) * stride;
  for (let k = 0; k < nKeep; k++) {
    if (s0 + Math.min(band - 1, Math.floor(offset + k * stride)) === slot) return true;
  }
  return false;
}

function isPhotographPhase(phase: string): boolean {
  return (
    phase === 'giant' ||
    phase === 'subgiant' ||
    phase === 'supergiant' ||
    phase === 'carbon_star' ||
    phase === 'wolf_rayet'
  );
}

/** Photograph pin: giant-branch / hot-MS light, or a showpiece nebula. */
function writeMassPin(
  seed: string,
  cell: number,
  slot: number,
  filled: number,
  i: number,
  c: Omit<StarCloud, 'n' | 'ms'>,
): boolean {
  const b = slotBirthRaw(seed, cell, slot, filled);
  const photoL = UNIVERSE.GALAXY_HARVEST_ALL_L;
  if (maybeClockRow(b)) {
    const ev = sketchEvolve(b);
    if (ev.nebula !== 'none') {
      if (!keepSilhouettePhase(ev, packId(cell, slot))) return false;
      writeEvolved(cell, slot, i, c, b, ev);
      return true;
    }
    if (
      ev.phase === 'white_dwarf' ||
      ev.phase === 'neutron_star' ||
      ev.phase === 'pulsar' ||
      ev.phase === 'black_hole'
    ) {
      return false;
    }
    if (!isPhotographPhase(ev.phase) && ev.luminosity < photoL) return false;
    writeEvolved(cell, slot, i, c, b, ev);
    return true;
  }
  if (!isSlotAlive(b.massZams, b.ageGyr)) return false;
  if (slotMsLum(b.massZams) < photoL) return false;
  writeFromBirth(cell, slot, i, c, b, true);
  return true;
}

/** Uniform stride through [s0, filled). f = 1 keeps the band. */
function writeAllMass(
  seed: string,
  cell: number,
  filled: number,
  s0: number,
  f: number,
  c: Omit<StarCloud, 'n' | 'ms'>,
  n: number,
): { c: Omit<StarCloud, 'n' | 'ms'>; n: number } {
  const band = filled - s0;
  const nKeep = massKeepCount(seed, cell, band, f);
  if (nKeep <= 0) return { c, n };
  if (nKeep >= band) {
    for (let slot = s0; slot < filled; slot++) {
      if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
      if (writeMassPin(seed, cell, slot, filled, n, c)) n++;
    }
    return { c, n };
  }
  for (let k = 0; k < nKeep; k++) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const slot = s0 + Math.min(band - 1, Math.floor(harvestShapeUnit(seed, cell, k + 1, attempt) * band));
      if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
      if (writeMassPin(seed, cell, slot, filled, n, c)) {
        n++;
        break;
      }
    }
  }
  return { c, n };
}

/** MS photosphere is a cheap birth row; only the giant window needs the clock. */
function tryShapeSlot(
  seed: string,
  cell: number,
  slot: number,
  filled: number,
  c: Omit<StarCloud, 'n' | 'ms'>,
  n: number,
): { c: Omit<StarCloud, 'n' | 'ms'>; n: number } | null {
  const birth = slotBirthRaw(seed, cell, slot, filled);
  if (birth.massZams < UNIVERSE.GALAXY_HARVEST_SHAPE_M) return null;
  const tMs = msLifetime(birth.massZams);
  if (birth.ageGyr < tMs) {
    if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
    writeFromBirth(cell, slot, n++, c, birth, true);
    return { c, n };
  }
  const deadFor = birth.ageGyr - tMs - giantWindow(birth.massZams);
  if (deadFor > 0) return null;
  const ev = sketchEvolve(birth);
  if (!keepShapePhotosphere(ev)) return null;
  if (n >= c.ids.length) c = ensureCloudCap(c, n, n + 16_384);
  writeEvolved(cell, slot, n++, c, birth, ev);
  return { c, n };
}

/**
 * One living photosphere per occupancy × SHAPE_F, picked in the
 * long-lived band [SHAPE_M, SILHOUETTE_M). Uniform in that band so
 * the sample is the mass model, not a second luminous walk. Dead
 * 2–4 M☉ slots retry; the longest-lived slot (low-mass end) is
 * the fallback. Remnants and nebulae stay on the tight tail gate.
 */
function writeShapeSample(
  seed: string,
  cell: number,
  filled: number,
  uPhoto: number,
  uLive: number,
  c: Omit<StarCloud, 'n' | 'ms'>,
  n: number,
): { c: Omit<StarCloud, 'n' | 'ms'>; n: number } {
  const expect = filled * UNIVERSE.GALAXY_HARVEST_SHAPE_F;
  if (expect <= 0) return { c, n };
  const s0 = Math.min(filled, Math.ceil(uPhoto * filled));
  const s1 = Math.min(filled, Math.floor(uLive * filled));
  const band = s1 - s0;
  if (band <= 0) return { c, n };
  const nFloor = Math.floor(expect);
  const frac = expect - nFloor;
  const nKeep = nFloor + (harvestShapeUnit(seed, cell, 0, 0) < frac ? 1 : 0);
  for (let k = 0; k < nKeep; k++) {
    let wrote = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const slot = s0 + Math.floor(harvestShapeUnit(seed, cell, k + 1, attempt) * band);
      const grown = tryShapeSlot(seed, cell, slot, filled, c, n);
      if (!grown) continue;
      c = grown.c;
      n = grown.n;
      wrote = true;
      break;
    }
    if (wrote) continue;
    const grown = tryShapeSlot(seed, cell, s0, filled, c, n);
    if (!grown) continue;
    c = grown.c;
    n = grown.n;
  }
  return { c, n };
}

function cellDist(cell: number, x: number, y: number, z: number): number {
  const mid = cellCenter(cell);
  return Math.hypot(
    mid.R * Math.cos(mid.theta) - x,
    mid.z - y,
    mid.R * Math.sin(mid.theta) - z,
  );
}

function copyStar(src: Omit<StarCloud, 'n' | 'ms'> | StarCloud, i: number, dst: Omit<StarCloud, 'n' | 'ms'>, j: number): void {
  dst.ids[j] = src.ids[i];
  dst.pos[j * 3] = src.pos[i * 3];
  dst.pos[j * 3 + 1] = src.pos[i * 3 + 1];
  dst.pos[j * 3 + 2] = src.pos[i * 3 + 2];
  dst.col[j * 3] = src.col[i * 3];
  dst.col[j * 3 + 1] = src.col[i * 3 + 1];
  dst.col[j * 3 + 2] = src.col[i * 3 + 2];
  dst.size[j] = src.size[i];
  dst.pulse[j] = src.pulse[i];
  dst.gain[j] = src.gain[i];
  dst.bits[j] = src.bits[i];
  dst.mk[j] = src.mk[i];
  dst.lum[j] = src.lum[i];
  dst.kind[j] = src.kind[i];
}

function ensureCloudCap(c: Omit<StarCloud, 'n' | 'ms'>, n: number, need: number): Omit<StarCloud, 'n' | 'ms'> {
  if (need <= c.ids.length) return c;
  const grown = allocCloud(Math.max(need + 8192, c.ids.length * 2));
  for (let k = 0; k < n; k++) copyStar(c, k, grown, k);
  return grown;
}

function dropStar(c: Omit<StarCloud, 'n' | 'ms'>, i: number, n: number): number {
  const last = n - 1;
  if (i !== last) copyStar(c, last, c, i);
  return last;
}

/**
 * Slide the magnification ball from (x0,y0,z0) to (x1,y1,z1).
 * Interior keepers stay put. Only the rim shell (and the IMF-ramp
 * core) is tested. Enterers append; leavers swap-remove. Same
 * membership as buildRegionCloud at the new centre — a border
 * monitor, not a rebuild of the galaxy.
 */
export function advanceRegionCloud(
  seed: string,
  cloud: StarCloud,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  r = UNIVERSE.GALAXY_REGION_R,
): StarCloud {
  const t0 = performance.now();
  const r2 = r * r;
  const scatter = slotScatterKpc() + 0.02;
  const slide = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  // A rim-cell star can sit 2×scatter inward of a cell that is not
  // well-inside. The shell must cover that, or we remint a keeper.
  const inner = Math.max(0, r - slide - 2 * scatter);
  const inner2 = inner * inner;
  const ramp =
    UNIVERSE.GALAXY_REGION_FULL_R + UNIVERSE.GALAXY_REGION_U_RAMP + slide + scatter;
  const ramp2 = ramp * ramp;
  const pos = cloud.pos;
  const ids = cloud.ids;
  const rim = new Set<number>();
  const dustHave = new Set<number>();
  let n = cloud.n;
  for (let i = 0; i < n; ) {
    const i3 = i * 3;
    const dx = pos[i3] - x1;
    const dy = pos[i3 + 1] - y1;
    const dz = pos[i3 + 2] - z1;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) {
      n = dropStar(cloud, i, n);
      continue;
    }
    const id = ids[i];
    if (isDustId(id) || (cloud.bits[i] & BIT_DUST) !== 0) dustHave.add(id);
    const nearRim = d2 >= inner2;
    const nearRamp = d2 <= ramp2;
    if (nearRim || nearRamp) {
      if (isDustId(id) || (cloud.bits[i] & BIT_DUST) !== 0) {
        if (nearRim) rim.add(id);
      } else {
        const { cell, slot } = splitId(id);
        const filled = slotsInCell(seed, cell);
        if (slot < Math.floor(regionImfFloor(cellDist(cell, x1, y1, z1)) * filled)) {
          n = dropStar(cloud, i, n);
          continue;
        }
        if (nearRim) rim.add(id);
      }
    }
    i++;
  }
  const shellLo = Math.max(0, r - slide - 2 * scatter);
  const cells = cellsOverlappingAnnulus(x1, y1, z1, shellLo, r);
  if (ramp > 0) {
    const core = cellsOverlappingAnnulus(x1, y1, z1, 0, ramp);
    for (let i = 0; i < core.length; i++) cells.push(core[i]);
  }
  let buf: Omit<StarCloud, 'n' | 'ms'> | StarCloud = cloud;
  for (const cell of cells) {
    const d1 = cellDist(cell, x1, y1, z1);
    const d0 = cellDist(cell, x0, y0, z0);
    const wellInsideOld = d0 + scatter < r && d1 + scatter < r;
    const nearRamp = d1 <= ramp;
    if (wellInsideOld && !nearRamp) continue;
    const filled = slotsInCell(seed, cell);
    if (filled > 0) {
      const s1 = Math.floor(regionImfFloor(d1) * filled);
      const s0 = Math.floor(regionImfFloor(d0) * filled);
      if (!wellInsideOld || s1 < s0) {
        const from = s1;
        const to = wellInsideOld ? s0 : filled;
        for (let slot = from; slot < to; slot++) {
          const id = packId(cell, slot);
          if (rim.has(id)) continue;
          const p = slotBirthCart(seed, cell, slot);
          const dx = p.x - x1;
          const dy = p.y - y1;
          const dz = p.z - z1;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          buf = ensureCloudCap(buf, n, n + 1);
          writeBirth(seed, cell, slot, filled, n, buf);
          n++;
        }
      }
    }
    // Dust keepers of well-inside cells are already members; only
    // entering cells mint their clumps.
    if (!wellInsideOld) {
      const clumps = dustClumpsInCell(seed, cell);
      for (let k = 0; k < clumps; k++) {
        const did = dustId(cell, k);
        if (rim.has(did) || dustHave.has(did)) continue;
        const cart = dustBirthCart(seed, cell, k);
        const dx = cart.x - x1;
        const dy = cart.y - y1;
        const dz = cart.z - z1;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        buf = ensureCloudCap(buf, n, n + 1);
        writeDust(seed, cell, k, n, buf);
        n++;
      }
    }
  }
  return { ...buf, n, ms: performance.now() - t0 };
}

/**
 * The brightest ~n REAL stars of an arc — a magnitude-limited survey.
 * Unique catalog ids, ranked by present-day light. The harvest is the
 * LIVING field (K/G/F that still burn at disk ages) plus a short
 * giant/hot tail and one massive-tip slot per cell (O/B while they
 * live, nebulae when they die). A quadratic walk of 0.8–2.4 M☉ is a
 * graveyard in an old population and must not fill the sky with WD
 * speckle. Every entry is a real catalog id you can set course to.
 */
export function sectorSample(seed: string, id: SectorId, n = UNIVERSE.GALAXY_SECTOR_STARS): GalaxyObject[] {
  const cells = sectorCells(id);
  const seen = new Set<number>();
  const out: GalaxyObject[] = [];
  const add = (cell: number, slot: number, filled: number): void => {
    if (slot < 0 || slot >= filled) return;
    const sid = packId(cell, slot);
    if (seen.has(sid)) return;
    const o = objectAt(seed, sid);
    if (!o) return;
    seen.add(sid);
    out.push(o);
  };
  const spread = (cell: number, filled: number, mLo: number, mHi: number, want: number): void => {
    const [bLo, bHi] = slotRangeForMass(filled, mLo, mHi);
    const bandN = Math.max(0, bHi - bLo);
    const take = Math.min(want, bandN);
    for (let j = 0; j < take; j++) {
      const slot = bLo + Math.floor(((j + 0.5) / take) * bandN);
      add(cell, Math.min(slot, bHi - 1), filled);
    }
  };
  // Overfill so the luminosity cut is global, not first-come.
  const livingTake = Math.max(4, Math.ceil((n * 3) / Math.max(1, cells.length)));
  for (const cell of cells) {
    const filled = slotsInCell(seed, cell);
    if (filled <= 0) continue;
    add(cell, filled - 1, filled);
    spread(cell, filled, 0.55, 1.05, livingTake);
    spread(cell, filled, 1.05, 3.0, 2);
  }
  out.sort((a, b) => starGlow(b) - starGlow(a));
  return out.slice(0, n);
}

/**
 * Display ranking: a magnitude-limited SKY ranks photospheres and
 * nebulae. Toy WD luminosities are stretched (the cooling clock is
 * compressed like TIME_SCALE); left raw they outshine K dwarfs and
 * the field reads as speckle. Bare remnants stay in the harvest and
 * the Remnants filter, but they do not fill the cut. Pulsars keep a
 * small findability nudge.
 */
function starGlow(o: GalaxyObject): number {
  const st = o.star;
  if (st.nebula !== 'none') return 15 + st.luminosity;
  if (st.phase === 'white_dwarf' || st.phase === 'neutron_star' || st.phase === 'black_hole') {
    return 0.02 * Math.max(st.luminosity, 1e-4);
  }
  if (st.phase === 'pulsar') return Math.max(0.8, st.luminosity);
  return st.luminosity;
}

/**
 * ~n systems of interest, galaxy-wide and deterministic: an absolute-
 * lattice walk of the catalog (never camera-relative) harvesting each
 * visited cell's top slot, scored for spectacle — remnants, nebulae,
 * Wolf–Rayets, supergiants, then raw luminosity. Markers for the map;
 * every one is a real address.
 */
export function systemsOfInterest(seed: string, n = 100): GalaxyObject[] {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz } = UNIVERSE;
  const izMid = Math.floor(nz / 2);
  const picks: Array<{ o: GalaxyObject; score: number }> = [];
  // ~4600 cells sampled on a fixed lattice around the midplane.
  for (let ir = 2; ir < nr; ir += 5) {
    for (let it = 0; it < nth; it += 12) {
      for (const iz of [izMid - 3, izMid, izMid + 3]) {
        const cell = ir * nth * nz + it * nz + iz;
        const filled = slotsInCell(seed, cell);
        if (filled <= 0) continue;
        const o = objectAt(seed, packId(cell, filled - 1));
        if (!o) continue;
        picks.push({ o, score: interestScore(o) });
      }
    }
  }
  picks.sort((a, b) => b.score - a.score);
  const out: GalaxyObject[] = [];
  const perBin = new Map<string, number>();
  for (const p of picks) {
    if (out.length >= n) break;
    // Spread the wonder across the disk, not along old arc tiles.
    const key = `${Math.floor(p.o.pos.R / 1.6)}:${Math.floor(((((p.o.pos.theta % TAU) + TAU) % TAU) / TAU) * 24)}`;
    const used = perBin.get(key) ?? 0;
    if (used >= 2) continue;
    perBin.set(key, used + 1);
    out.push(p.o);
  }
  return out;
}

function interestScore(o: GalaxyObject): number {
  const st = o.star;
  let s = Math.log10(1 + Math.max(0, st.luminosity));
  if (st.nebula !== 'none') s += 8;
  if (st.phase === 'black_hole') s += 9;
  if (st.phase === 'pulsar') s += 8;
  if (st.phase === 'neutron_star') s += 6;
  if (st.phase === 'wolf_rayet') s += 7;
  if (st.phase === 'supergiant') s += 5;
  if (st.phase === 'carbon_star') s += 4;
  return s;
}
