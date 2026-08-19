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
import {
  cellCenter,
  cellsOverlappingAnnulus,
  cellsOverlappingBall,
  chemistry,
  density,
  densityParts,
  galToCart,
  isSlotAlive,
  slotBirthCart,
  objectAt,
  packId,
  splitId,
  slotScatterKpc,
  slotBirthRaw,
  slotBirthClock,
  finishSlotBirth,
  slotZams,
  slotMsLum,
  spheroidScaleHeight,
  type SlotBirth,
  type SlotClock,
  slotMsTeff,
  imfQuantile,
  slotRangeForMass,
  slotsInCell,
  u01,
  type GalPos,
  type GalaxyObject,
} from './galaxy';
import { evolve, mkFromTeff, msLifetime, msRadius, teffToRgb } from './stellar';
import { KIND_STAR, emissionLook, kindFromNebula, shapeAt, type SkyKind } from './skyShape';
import { bakeDustVolume, type DustVolume } from './dustVolume';

export { KIND_STAR, KIND_HII, KIND_PN, KIND_SNR } from './skyShape';

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
  /** Sky kind: star / hii / pn / snr. Dust is extinction, not a row. */
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

type ClockGate = Pick<SlotClock, 'massZams' | 'ageGyr' | 'inCloud'>;

/** Region-ball sketch floor (M☉): slots above it get the full
 *  clock so nearby luminous stars wear their real phase; below
 *  it the cheap MS sketch is indistinguishable at ball scale.
 *  A local render economy, not a survey — the harvest samples
 *  the whole IMF. */
const REGION_EVOLVE_M = 3.89;

/** Cheap clock gate: full-evolve only slots that can be luminous now. */
function maybeClockRow(b: ClockGate): boolean {
  const m = b.massZams;
  if (m < REGION_EVOLVE_M) return false;
  const tMs = msLifetime(m);
  if (b.ageGyr < tMs) return true;
  return b.ageGyr < tMs + giantWindow(m);
}

/** Cheap clock gate: evolve only slots that can wear a nebula. */
function maybeNebulaRow(b: ClockGate): boolean {
  const m = b.massZams;
  const tMs = msLifetime(m);
  // H II is O/B in a natal cloud. B starts below 8 M☉ — sit the
  // walk with NEBULA_M so the first look matches the old harvest.
  const mHii = Math.min(8, UNIVERSE.GALAXY_NEBULA_M);
  if (b.inCloud && b.ageGyr < UNIVERSE.HII_GYR && m >= mHii) return true;
  if (b.inCloud && m >= UNIVERSE.REMNANT_NS && b.ageGyr >= tMs && b.ageGyr < tMs + UNIVERSE.HII_GYR) {
    return true;
  }
  if (m < UNIVERSE.GALAXY_NEBULA_M) return false;
  if (b.ageGyr < tMs) return false;
  const deadFor = b.ageGyr - tMs - giantWindow(m);
  return deadFor < Math.max(UNIVERSE.PN_GYR, UNIVERSE.SNR_GYR) + 1e-9;
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

function sketchEvolve(b: SlotBirth | SlotClock): ReturnType<typeof evolve> {
  const R = 'pos' in b ? b.pos.R : b.R;
  const chem = chemistry(b.pop, R, b.ageGyr, b.rng());
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
  forceStar = false,
): void {
  const cart = galToCart(b.pos);
  const kind = forceStar ? KIND_STAR : kindFromNebula(ev.nebula);
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
    // Star rows carry the photosphere radius (R☉) — the painted
    // body derives from it (a K giant is a wide gold orb, an O a
    // brilliant point). Nebulae keep their shell radius in kpc.
    size: look ? look.radiusKpc : Math.min(500, Math.max(0.02, ev.radius)),
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
    // Photosphere radius (R☉) for the painted body; a remnant pin
    // stays a point.
    size: alive ? msRadius(b.massZams) : 0.02,
    gain: 0.22 + 0.78 * (L / (L + 0.25)),
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

function keepNebulaPhase(ev: ReturnType<typeof evolve>, id: number): boolean {
  if (ev.nebula === 'none') return false;
  if (ev.nebula === 'hii') return true;
  return nebulaGain(ev, id) >= UNIVERSE.GALAXY_SILHOUETTE_NEB_GAIN;
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
 * clock sketch runs on luminous hosts. Nebulae are their own
 * whole-disk catalog, not this local ball.
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
    // star you are on does not vanish.
    let s0 = Math.floor(regionImfFloor(d) * f);
    if (d <= slotScatterKpc() + r) {
      s0 = Math.min(s0, Math.floor(imfQuantile(REGION_EVOLVE_M) * f));
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
let nebulaMemo: { seed: string; cloud: StarCloud } | null = null;
let dustVolMemo: { seed: string; vol: DustVolume } | null = null;

function rememberDustVolume(seed: string, onDust?: (frac: number) => void): void {
  dustVolMemo = { seed, vol: bakeDustVolume(seed, onDust) };
}

/** Drop the star harvest so the next mint walks the disk under current UNIVERSE. */
export function forgetSilhouette(): void {
  silhouetteMemo = null;
}

/** Drop the nebula catalog so the next walk samples current shell laws. */
export function forgetNebulae(): void {
  nebulaMemo = null;
}

/** Drop the fog so the next bake samples the current ISM ribbons. */
export function forgetDustVolume(): void {
  dustVolMemo = null;
}

/** Rebake the extinction volume without reminting stars or nebulae. */
export function rebakeDustCache(seed: string, onDust?: (frac: number) => void): DustVolume {
  rememberDustVolume(seed, onDust);
  return dustVolMemo!.vol;
}

/** Cached star harvest, or null until the worker (or a sync mint) finishes. */
export function silhouetteCloud(seed: string): StarCloud | null {
  return silhouetteMemo?.seed === seed ? silhouetteMemo.cloud : null;
}

/** Cached nebula catalog, or null until the first walk finishes. */
export function nebulaCloud(seed: string): StarCloud | null {
  return nebulaMemo?.seed === seed ? nebulaMemo.cloud : null;
}

/** Baked ISM fog for this seed, or null until the first bake. */
export function harvestDustVolume(seed: string): DustVolume | null {
  return dustVolMemo?.seed === seed ? dustVolMemo.vol : null;
}

/** Install a star harvest minted off-thread. Same cache `buildSilhouetteCloud` uses. */
export function installSilhouetteCloud(seed: string, cloud: StarCloud): void {
  silhouetteMemo = { seed, cloud };
}

/** Install a nebula catalog walked on the main thread. */
export function installNebulaCloud(seed: string, cloud: StarCloud): void {
  nebulaMemo = { seed, cloud };
}

/**
 * Whole-disk star harvest: every living star above both survey
 * floors (IMF mass and present-day L). No shape sample, no mass
 * stride — the count is an outcome of those floors, not a cap.
 * Nebulae and dust are their own catalogs.
 */
export function buildSilhouetteCloud(
  seed: string,
  onRing?: (done: number, total: number) => void,
): StarCloud {
  if (silhouetteMemo && silhouetteMemo.seed === seed) return silhouetteMemo.cloud;
  const t0 = performance.now();
  const cloud = mintHarvestCloud(seed, t0, onRing);
  silhouetteMemo = { seed, cloud };
  return cloud;
}

/** Catalog span. Omitted ends are the full disk / every spoke. */
export type HarvestSpan = {
  ir0?: number;
  ir1?: number;
  it0?: number;
  it1?: number;
};

/**
 * Split the disk into `n` azimuth wedges of equal spoke count.
 * Every worker sees the core — the giant-branch cost is what
 * used to serialise behind one inner-ring shard.
 */
export function harvestThetaShards(nWorkers: number): [number, number][] {
  const nth = UNIVERSE.GALAXY_NTH;
  const n = Math.max(1, Math.min(Math.floor(nWorkers), nth));
  const out: [number, number][] = [];
  for (let s = 0; s < n; s++) {
    out.push([Math.floor((s * nth) / n), Math.floor(((s + 1) * nth) / n)]);
  }
  return out;
}

/** Concatenate shard clouds. Order is not the law — ids are. */
export function mergeStarClouds(parts: StarCloud[]): StarCloud {
  let n = 0;
  let ms = 0;
  for (const p of parts) {
    n += p.n;
    ms = Math.max(ms, p.ms);
  }
  const c = allocCloud(Math.max(1, n));
  let i = 0;
  for (const p of parts) {
    for (let k = 0; k < p.n; k++) copyStar(p, k, c, i++);
  }
  return { n, ...c, ms };
}

/** Harvest walk only — no cache, no dust bake. The worker uses this. */
export function mintSilhouetteCloud(
  seed: string,
  onRing?: (done: number, total: number) => void,
  span?: HarvestSpan,
): StarCloud {
  return mintHarvestCloud(seed, performance.now(), onRing, span);
}

/**
 * One disk walk, two catalogs. First boot uses this so stars and
 * nebulae do not each pay the slot-birth cost.
 */
export function mintSkyClouds(
  seed: string,
  onRing?: (done: number, total: number) => void,
  span?: HarvestSpan,
): { stars: StarCloud; nebulae: StarCloud } {
  return walkSkyClouds(seed, performance.now(), onRing, true, true, span);
}

function mintHarvestCloud(
  seed: string,
  t0: number,
  onRing?: (done: number, total: number) => void,
  span?: HarvestSpan,
): StarCloud {
  return walkSkyClouds(seed, t0, onRing, true, false, span).stars;
}

/**
 * Whole-disk nebula catalog. Host id is packId — set course still
 * hits the star. Walks only nebula-capable slots (young H II, or
 * the PN / SNR death window above NEBULA_M). Rebake when those
 * knobs change; do not remint the star harvest.
 */
export function mintNebulaCloud(
  seed: string,
  onRing?: (done: number, total: number) => void,
  span?: HarvestSpan,
): StarCloud {
  return walkSkyClouds(seed, performance.now(), onRing, false, true, span).nebulae;
}

/** Forget and walk the nebula catalog under current UNIVERSE. */
export function remintNebulaCache(
  seed: string,
  onRing?: (done: number, total: number) => void,
): StarCloud {
  nebulaMemo = null;
  const cloud = mintNebulaCloud(seed, onRing);
  nebulaMemo = { seed, cloud };
  return cloud;
}

function nebulaWalkFloor(): number {
  return Math.min(UNIVERSE.GALAXY_NEBULA_M, 8);
}

function walkSkyClouds(
  seed: string,
  t0: number,
  onRing: ((done: number, total: number) => void) | undefined,
  wantStars: boolean,
  wantNebulae: boolean,
  span?: HarvestSpan,
): { stars: StarCloud; nebulae: StarCloud } {
  const { GALAXY_NR: nr, GALAXY_NTH: nth, GALAXY_NZ: nz, GALAXY_R_MAX: rMax, GALAXY_N_K: nK } =
    UNIVERSE;
  const ir0 = Math.max(0, Math.floor(span?.ir0 ?? 0));
  const ir1 = Math.min(nr, Math.ceil(span?.ir1 ?? nr));
  const itLo = Math.max(0, Math.floor(span?.it0 ?? 0));
  const itHi = Math.min(nth, Math.ceil(span?.it1 ?? nth));
  const zExtent = UNIVERSE.GALAXY_Z_THICK * 4;
  // STRATIFIED SAMPLE: collectors as arithmetic. A truly uniform
  // draw of 10⁹ stars is ~85% M/L dwarfs — the sky is a dim red
  // smudge. Instead the IMF is cut into mass strata (the spectral
  // classes), each stratum gets an EQUAL share of the budget, and
  // each is sampled with its own systematic stride. Because slots
  // are IMF-ordered, a stratum is a contiguous slot slice per
  // cell — no score-keeping, no rejection, no full collectors:
  // the stride per stratum IS the quota. Within a stratum the
  // sample stays uniform across cells, so regions contribute in
  // their true proportion — O/B budget lands in the arms, the
  // giant budget pools in the old core. A stratum poorer than
  // its budget is simply taken whole (stride clamps at 1).
  //
  // Exact population first — one cheap hash pass (no births), so
  // the total lands on SAMPLE_N within the strides.
  let totalSlots = 0;
  if (wantStars) {
    for (let ir = 0; ir < nr; ir++) {
      for (let iz = 0; iz < nz; iz++) {
        for (let it = 0; it < nth; it++) {
          totalSlots += slotsInCell(seed, ir * nth * nz + it * nz + iz);
        }
      }
    }
  }
  // Stratum edges in ZAMS mass (M☉): M | K | G | F | A | B | O+.
  const strataM = [UNIVERSE.IMF_MIN, 0.45, 0.8, 1.15, 1.6, 3, 8];
  const nStrata = strataM.length;
  const budget = UNIVERSE.GALAXY_SAMPLE_N / nStrata;
  // One sampling plan: the mass strata (gate 'any'), then the ZOO
  // strata — rare classes as survey categories. A zoo stride is
  // sized by the class's estimated clock-window fraction, so each
  // collects ~its budget with cheap clock gates instead of an
  // exhaustive walk (finding every pulsar would mean reading 5M
  // NS-mass addresses; every black hole is 1.28M rows — 5× the
  // whole budget). Quiet old NS and WDs ride the mass strata in
  // their honest share. Budgets scale with SAMPLE_N.
  type Gate = 'living' | 'bh' | 'pulsar' | 'alive' | 'giant';
  const cats: Array<{ u0: number; u1: number; step: number; gate: Gate }> = [];
  const uOf = (m: number) => Math.min(1, Math.max(0, imfQuantile(m)));
  const addCat = (m0: number, m1: number, catBudget: number, fracEst: number, gate: Gate) => {
    const u0 = uOf(m0);
    const u1 = m1 >= 1000 ? 1 : uOf(m1);
    const pop = Math.max(0, (u1 - u0) * totalSlots);
    if (pop <= 0 || catBudget <= 0) return;
    cats.push({ u0, u1, step: Math.max(1, (pop * fracEst) / catBudget), gate });
  };
  // Mass strata are LIVING-gated: equal budgets in birth slots
  // spent most of the white-star budget on corpses (the A
  // stratum yielded 3.9k living of a 35.7k budget — the rest
  // were invisible white-dwarf rows) and the living sky came out
  // warm-heavy 3:1. The stride is scaled by each stratum's alive
  // fraction (≈ tMs at the stratum's mid mass over the ~8 Gyr
  // age span) so the budget buys living stars. Quiet remnants
  // leave the census — the zoo keeps the interesting ones.
  const aliveEst = (m0: number, m1: number) =>
    Math.min(1, Math.max(0.02, msLifetime(Math.sqrt(m0 * m1)) / 8));
  // Budget weights per stratum (M K G F A B O). Under MAX the
  // carpet between bright winners is the numerous dim classes —
  // all-warm M/K by count read as a tan wash — so the white
  // middle (G/F/A) carries more of the budget. Hot strata stay
  // small: living members are rare and each kept row costs
  // 1/aliveFrac clock reads.
  const stratW = [0.7, 0.9, 1.25, 1.25, 0.9, 0.35, 0.12];
  for (let j = 0; j < nStrata; j++) {
    const m0 = strataM[j];
    const m1 = j + 1 < nStrata ? strataM[j + 1] : 1000;
    addCat(m0, m1, budget * stratW[j], aliveEst(m0, Math.min(m1, 60)), 'living');
  }
  const N = UNIVERSE.GALAXY_SAMPLE_N;
  // Black holes: everything ≥ REMNANT_NS is dead almost at birth.
  addCat(UNIVERSE.REMNANT_NS, 1000, N * 0.03, 1, 'bh');
  // Pulsars: the PULSAR_GYR death window on the NS mass slice
  // (~1.5% of NS addresses are pulsars right now).
  addCat(UNIVERSE.REMNANT_WD, UNIVERSE.REMNANT_NS, N * 0.015, UNIVERSE.PULSAR_GYR / 8, 'pulsar');
  // Living massive tail: O supergiants and Wolf–Rayet — alive
  // fraction of the ≥ REMNANT_NS slice is ~tMs / age span.
  addCat(UNIVERSE.REMNANT_NS, 1000, N * 0.002, 0.0014, 'alive');
  // GIANT BRANCH: mid-mass slots inside their post-MS window —
  // the gold that lights the old core. A pixel under MAX shows
  // its brightest star, and number-proportional strata make the
  // bulge's median star a dim orange dwarf (a brown core). The
  // real bulge is golden because its LIGHT is K giants —
  // numerically rare, photometrically dominant. This category
  // is the magnitude/colour band the mass strata cannot see:
  // same mass, different clock phase.
  addCat(0.9, 3, N * 0.08, 0.03, 'giant');
  const spanFrac = (Math.max(1, itHi - itLo) / Math.max(1, nth)) *
    (Math.max(1, ir1 - ir0) / Math.max(1, nr));
  const uNeb = imfQuantile(nebulaWalkFloor());
  const nebFrac = Math.max(1e-6, 1 - uNeb);
  const nebFloor = nebulaWalkFloor();
  let stars = allocCloud(
    wantStars ? Math.ceil(UNIVERSE.GALAXY_SAMPLE_N * spanFrac * 1.25) + 8192 : 1,
  );
  let nebulae = allocCloud(wantNebulae ? 16_384 : 1);
  let ns = 0;
  let nn = 0;
  for (let ir = ir0; ir < ir1; ir++) {
    const vol = catalogCellVolume(ir);
    const R = ((ir + 0.5) / nr) * rMax;
    for (let iz = 0; iz < nz; iz++) {
      const z = ((iz + 0.5) / nz - 0.5) * 2 * zExtent;
      const ceil = thinDensityCeil(R, z) * vol * nK;
      // Nebula-only walks skip bins with no young thin gas. The
      // uniform star sample visits every occupied bin — halo,
      // thick disk, and bulge are population, not clutter.
      if (!wantStars && ceil * nebFrac < 0.2) continue;
      for (let it = itLo; it < itHi; it++) {
        const cell = ir * nth * nz + it * nz + iz;
        const filled = slotsInCell(seed, cell);
        if (filled <= 0) continue;
        if (wantStars) {
          const kept: number[] = [];
          for (let j = 0; j < cats.length; j++) {
            const cat = cats[j];
            const lo = cat.u0 * filled;
            const hi = cat.u1 * filled;
            for (let u = lo + u01(seed, 'sample', cell, j) * cat.step; u < hi; u += cat.step) {
              const slot = Math.floor(u);
              if (slot >= filled || kept.includes(slot)) continue;
              const clock = slotBirthClock(seed, cell, slot, filled);
              // Cheap clock gates: reject before paying evolve.
              const tMs = msLifetime(clock.massZams);
              const dead = clock.ageGyr - tMs - giantWindow(clock.massZams);
              if (cat.gate === 'living' && dead >= 0) continue;
              if (cat.gate === 'alive' && dead >= 0) continue;
              if (cat.gate === 'bh' && dead < 0) continue;
              if (cat.gate === 'pulsar' && (dead < 0 || dead >= UNIVERSE.PULSAR_GYR)) continue;
              if (cat.gate === 'giant' && (clock.ageGyr < tMs || dead >= 0)) continue;
              const ev = sketchEvolve(clock);
              if (cat.gate === 'bh' && ev.phase !== 'black_hole') continue;
              if (cat.gate === 'pulsar' && ev.phase !== 'pulsar') continue;
              if (
                cat.gate === 'living' &&
                (ev.phase === 'white_dwarf' ||
                  ev.phase === 'neutron_star' ||
                  ev.phase === 'pulsar' ||
                  ev.phase === 'black_hole')
              ) {
                continue;
              }
              if (
                cat.gate === 'giant' &&
                ev.phase !== 'giant' &&
                ev.phase !== 'subgiant' &&
                ev.phase !== 'carbon_star'
              ) {
                continue;
              }
              kept.push(slot);
              const birth = finishSlotBirth(clock);
              if (ns >= stars.ids.length) stars = ensureCloudCap(stars, ns, ns + 16_384);
              writeEvolved(cell, slot, ns++, stars, birth, ev, true);
            }
          }
        }
        if (wantNebulae) {
          // H II and leftover PN/SNR need a young thin host. Old
          // spheroid ages are past the nebula window.
          const parts = densityParts(cellCenter(cell));
          if (parts.thin <= 0) continue;
          const sNeb = Math.floor(uNeb * filled);
          for (let slot = sNeb; slot < filled; slot++) {
            const mass = slotZams(seed, cell, slot, filled);
            if (mass < nebFloor) continue;
            const clock = slotBirthClock(seed, cell, slot, filled);
            if (!maybeNebulaRow(clock)) continue;
            const ev = sketchEvolve(clock);
            const birth = finishSlotBirth(clock);
            if (keepNebulaPhase(ev, packId(cell, slot))) {
              if (nn >= nebulae.ids.length) nebulae = ensureCloudCap(nebulae, nn, nn + 4_096);
              writeEvolved(cell, slot, nn++, nebulae, birth, ev);
            }
          }
        }
      }
    }
    onRing?.(ir - ir0 + 1, Math.max(1, ir1 - ir0));
  }
  return {
    stars: finishCloud(stars, ns, t0),
    nebulae: finishCloud(nebulae, nn, t0),
  };
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
    const nearRim = d2 >= inner2;
    const nearRamp = d2 <= ramp2;
    if (nearRim || nearRamp) {
      const { cell, slot } = splitId(id);
      const filled = slotsInCell(seed, cell);
      if (slot < Math.floor(regionImfFloor(cellDist(cell, x1, y1, z1)) * filled)) {
        n = dropStar(cloud, i, n);
        continue;
      }
      if (nearRim) rim.add(id);
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
