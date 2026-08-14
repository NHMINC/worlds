/**
 * Stellar evolution as a law: mass + age + chemistry → what sits there
 * now. No catalogue of “pretty star types.” Harvard class, luminosity
 * class, remnants and nebulae are attractor regions of one clock.
 *
 * Cheap on purpose. A main-sequence lifetime, a short giant, then a
 * remnant. We do not integrate a stellar structure code; we evaluate
 * the closed-form clock the cosmic engineer set in UNIVERSE.
 */
import { UNIVERSE } from './physics';

export type MKClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'L' | 'T';
export type LumClass = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI';

/** What the object is *now*, after the clock has run. */
export type StellarPhase =
  | 'brown_dwarf'
  | 'main_sequence'
  | 'subgiant'
  | 'giant'
  | 'supergiant'
  | 'wolf_rayet'
  | 'carbon_star'
  | 'white_dwarf'
  | 'neutron_star'
  | 'pulsar'
  | 'black_hole';

export type NebulaKind = 'none' | 'hii' | 'planetary' | 'snr';

export type WdType = 'DA' | 'DB' | 'DC' | 'DQ';

export interface StellarState {
  phase: StellarPhase;
  /** Harvard class when the photosphere is visible; null on BH / bare NS. */
  mk: MKClass | null;
  /** MK subtype 0 (hot) … 9 (cool) inside that letter; null on remnants. */
  sub: number | null;
  lumClass: LumClass | null;
  /** White-dwarf atmosphere class when phase is white_dwarf. */
  wdType: WdType | null;
  nebula: NebulaKind;
  /** Present-day mass (Msun). Remnant mass for WD/NS/BH. */
  mass: number;
  /** Zero-age main-sequence mass (Msun). */
  massZams: number;
  luminosity: number;
  teff: number;
  radius: number;
  ageGyr: number;
  /** [Fe/H] dex, solar = 0. */
  feh: number;
  /** Disk C/O relative to solar — the number systemgen already drinks. */
  carbon: number;
  /** Time since the star left the main sequence (Gyr). 0 if still on it. */
  postGyr: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Kroupa IMF inverse-CDF: u in [0,1) → M/Msun. Amplitudes match at breaks. */
export function imfMass(u: number): number {
  const {
    IMF_BD: mBd, IMF_MIN: m0, IMF_BRK: mb, IMF_MAX: m1,
    IMF_A0: a0, IMF_A1: a1, IMF_A2: a2,
  } = UNIVERSE;
  const integ = (lo: number, hi: number, a: number) =>
    (Math.pow(hi, a + 1) - Math.pow(lo, a + 1)) / (a + 1);
  const A0 = 1;
  const A1 = A0 * Math.pow(m0, a0 - a1);
  const A2 = A1 * Math.pow(mb, a1 - a2);
  const n0 = A0 * integ(mBd, m0, a0);
  const n1 = A1 * integ(m0, mb, a1);
  const n2 = A2 * integ(mb, m1, a2);
  const t = Math.max(0, Math.min(0.999999, u)) * (n0 + n1 + n2);
  const inv = (lo: number, A: number, a: number, tLocal: number) =>
    Math.pow(Math.pow(lo, a + 1) + (tLocal / A) * (a + 1), 1 / (a + 1));
  if (t < n0) return inv(mBd, A0, a0, t);
  if (t < n0 + n1) return inv(m0, A1, a1, t - n0);
  return inv(mb, A2, a2, t - n0 - n1);
}

/** Main-sequence luminosity (Lsun) from ZAMS mass. */
export function msLuminosity(m: number): number {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  if (m < 20) return 1.4 * Math.pow(m, 3.5);
  return 3200 * m;
}

/** Main-sequence radius (Rsun). */
export function msRadius(m: number): number {
  if (m < 1) return Math.pow(m, 0.8);
  return Math.pow(m, 0.57);
}

/** Main-sequence lifetime (Gyr). τ = 10 · M / L, the fuel-clock. */
export function msLifetime(m: number): number {
  return (10 * m) / Math.max(1e-6, msLuminosity(m));
}

export function teffFromLR(L: number, R: number): number {
  // T / Tsun = (L / R²)^0.25, Tsun = 5772 K.
  return 5772 * Math.pow(Math.max(L, 1e-8) / Math.max(R * R, 1e-8), 0.25);
}

/** Harvard letter from Teff. */
export function mkFromTeff(teff: number): MKClass {
  return mkGrade(teff).mk;
}

/** Cheap blackbody (Tanner–Helland-ish) for photosphere colour. */
export function teffToRgb(teff: number): [number, number, number] {
  if (teff <= 0) return [0.12, 0.1, 0.16];
  const t = Math.max(1, Math.min(40, teff / 1000));
  let r: number;
  let g: number;
  let b: number;
  if (t <= 6.6) {
    r = 1;
    g = Math.max(0, Math.min(1, 0.3901 * Math.log(t) + 0.48));
    b = t <= 1.9 ? 0 : Math.max(0, Math.min(1, 0.5432 * Math.log(t - 0.8) + 0.12));
  } else {
    r = Math.max(0.6, Math.min(1, 1.2929 * Math.pow(t - 6, -0.1332)));
    g = Math.max(0.7, Math.min(1, 1.1295 * Math.pow(t - 6, -0.0755)));
    b = 1;
  }
  return [r, g, b];
}

export function rgbToHex(rgb: [number, number, number]): string {
  const h = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/**
 * MK letter + subtype 0–9. Subtype 0 is the hot edge of the class,
 * 9 the cool edge — the usual MK numbering.
 */
export function mkGrade(teff: number): { mk: MKClass; sub: number } {
  const bands: Array<[MKClass, number, number]> = [
    ['O', 50000, 30000],
    ['B', 30000, 10000],
    ['A', 10000, 7500],
    ['F', 7500, 6000],
    ['G', 6000, 5200],
    ['K', 5200, 3700],
    ['M', 3700, 2400],
    ['L', 2400, 1300],
    ['T', 1300, 500],
  ];
  const t = Math.max(500, teff);
  for (const [mk, hot, cool] of bands) {
    if (t >= cool) {
      const u = (hot - t) / Math.max(1, hot - cool);
      const sub = Math.max(0, Math.min(9, Math.round(u * 9)));
      return { mk, sub };
    }
  }
  return { mk: 'T', sub: 9 };
}

/** White-dwarf atmosphere from leftover chemistry + cooling Teff. */
export function wdAtmosphere(teff: number, carbon: number, feh: number): WdType {
  if (carbon > 1.15) return 'DQ';
  if (teff > 25000 && feh < -0.2) return 'DB';
  if (teff > 6000) return 'DA';
  return 'DC';
}

/** Remnant mass (Msun) after the clock runs out. */
export function remnantMass(mZams: number): { phase: 'white_dwarf' | 'neutron_star' | 'black_hole'; mass: number } {
  if (mZams < UNIVERSE.REMNANT_WD) {
    // Weidemann-ish: WD mass climbs slowly with ZAMS, caps at Chandrasekhar.
    return { phase: 'white_dwarf', mass: Math.min(1.38, 0.48 + 0.1 * mZams) };
  }
  if (mZams < UNIVERSE.REMNANT_NS) {
    return { phase: 'neutron_star', mass: 1.4 };
  }
  // Fryer-lite: a slice of the ZAMS falls in; the rest is ejected.
  return { phase: 'black_hole', mass: Math.min(40, 0.2 * mZams + 2) };
}

/**
 * Run the stellar clock. `inArm` and a young massive star light an H II
 * region; a fresh remnant wears a PN or SNR for the toy-visible window.
 */
export function evolve(opts: {
  massZams: number;
  ageGyr: number;
  feh: number;
  carbon: number;
  inArm?: boolean;
}): StellarState {
  const m0 = Math.max(UNIVERSE.IMF_MIN * 0.5, opts.massZams);
  const age = Math.max(0, opts.ageGyr);
  const feh = opts.feh;
  const carbon = opts.carbon;
  const inArm = opts.inArm ?? false;

  if (m0 < UNIVERSE.IMF_MIN) {
    const L = 1e-4 * Math.pow(m0 / 0.08, 2);
    const R = 0.1 * Math.pow(m0 / 0.08, 0.8);
    const teff = teffFromLR(L, R);
    const g = mkGrade(teff);
    return {
      phase: 'brown_dwarf',
      mk: g.mk,
      sub: g.sub,
      lumClass: 'V',
      wdType: null,
      nebula: 'none',
      mass: m0,
      massZams: m0,
      luminosity: L,
      teff,
      radius: R,
      ageGyr: age,
      feh,
      carbon,
      postGyr: 0,
    };
  }

  // Metal-poor stars are hotter (less line opacity) and burn a little faster.
  const tMs = msLifetime(m0) * Math.pow(10, 0.15 * feh);
  // Giant / WR window: a fraction of the MS life, shorter for heavy stars.
  const tGiant = Math.min(0.8, tMs * (m0 <= 2 ? 0.15 : m0 < 8 ? 0.08 : UNIVERSE.WR_TAIL));

  if (age < tMs) {
    const L = msLuminosity(m0);
    const R = msRadius(m0);
    const teff = teffFromLR(L, R) * Math.pow(10, -0.07 * feh);
    const g = mkGrade(teff);
    const wr = m0 >= UNIVERSE.REMNANT_NS && age > tMs * (1 - UNIVERSE.WR_TAIL);
    const hii = (g.mk === 'O' || g.mk === 'B') && age < UNIVERSE.HII_GYR && inArm;
    const wrG = mkGrade(Math.max(teff, 40000));
    return {
      phase: wr ? 'wolf_rayet' : 'main_sequence',
      mk: wr ? 'O' : g.mk,
      sub: wr ? wrG.sub : g.sub,
      lumClass: feh < -1.2 && m0 < 1.2 ? 'VI' : 'V',
      wdType: null,
      nebula: hii ? 'hii' : 'none',
      mass: m0,
      massZams: m0,
      luminosity: wr ? L * 1.8 : L,
      teff: wr ? Math.max(teff, 40000) : teff,
      radius: wr ? R * 0.6 : R,
      ageGyr: age,
      feh,
      carbon,
      postGyr: 0,
    };
  }

  const post = age - tMs;
  if (post < tGiant) {
    const frac = post / Math.max(1e-6, tGiant);
    if (m0 >= UNIVERSE.REMNANT_NS) {
      const L = msLuminosity(m0) * 8;
      const R = msRadius(m0) * 12;
      const teff = teffFromLR(L, R);
      const g = mkGrade(m0 > 40 ? Math.max(teff, 32000) : Math.min(teff, 28000));
      return {
        phase: 'supergiant',
        mk: g.mk,
        sub: g.sub,
        lumClass: 'I',
        wdType: null,
        nebula: inArm && post < UNIVERSE.HII_GYR ? 'hii' : 'none',
        mass: m0 * 0.7,
        massZams: m0,
        luminosity: L,
        teff,
        radius: R,
        ageGyr: age,
        feh,
        carbon,
        postGyr: post,
      };
    }
    if (m0 >= 8) {
      const L = msLuminosity(m0) * 20;
      const R = 40 + 80 * frac;
      const teff = teffFromLR(L, R);
      const g = mkGrade(teff);
      return {
        phase: 'supergiant',
        mk: g.mk,
        sub: g.sub,
        lumClass: 'I',
        wdType: null,
        nebula: 'none',
        mass: m0 * 0.8,
        massZams: m0,
        luminosity: L,
        teff,
        radius: R,
        ageGyr: age,
        feh,
        carbon,
        postGyr: post,
      };
    }
    // Low/intermediate mass: subgiant → giant → (C-star on late AGB).
    const late = frac > 0.7;
    const carbonStar = late && m0 > 1.2 && m0 < 8 && carbon > 1.0;
    const L = (m0 <= 2 ? 40 : 200) * (0.4 + frac);
    const R = (m0 <= 2 ? 8 : 40) * (1 + 3 * frac);
    const teff = teffFromLR(L, R);
    const g = mkGrade(carbonStar ? Math.min(teff, 3600) : teff);
    return {
      phase: carbonStar ? 'carbon_star' : frac < 0.25 ? 'subgiant' : 'giant',
      mk: g.mk,
      sub: g.sub,
      lumClass: frac < 0.25 ? 'IV' : m0 > 3 ? 'II' : 'III',
      wdType: null,
      nebula: 'none',
      mass: m0 * (1 - 0.15 * frac),
      massZams: m0,
      luminosity: L,
      teff,
      radius: R,
      ageGyr: age,
      feh,
      carbon,
      postGyr: post,
    };
  }

  const rem = remnantMass(m0);
  const deadFor = post - tGiant;
  if (rem.phase === 'white_dwarf') {
    const cool = clamp01(deadFor / 8);
    const teff = 80000 * (1 - 0.85 * cool) + 4000;
    const R = 0.01;
    const L = Math.pow(R, 2) * Math.pow(teff / 5772, 4);
    const g = mkGrade(teff);
    const wdType = wdAtmosphere(teff, carbon, feh);
    return {
      phase: 'white_dwarf',
      mk: g.mk,
      sub: g.sub,
      lumClass: null,
      wdType,
      nebula: deadFor < UNIVERSE.PN_GYR ? 'planetary' : 'none',
      mass: rem.mass,
      massZams: m0,
      luminosity: L,
      teff,
      radius: R,
      ageGyr: age,
      feh,
      carbon,
      postGyr: post,
    };
  }
  if (rem.phase === 'neutron_star') {
    const pulsar = deadFor < UNIVERSE.PULSAR_GYR;
    return {
      phase: pulsar ? 'pulsar' : 'neutron_star',
      mk: null,
      sub: null,
      lumClass: null,
      wdType: null,
      nebula: deadFor < UNIVERSE.SNR_GYR ? 'snr' : 'none',
      mass: rem.mass,
      massZams: m0,
      luminosity: pulsar ? 0.1 : 1e-6,
      teff: pulsar ? 1e6 : 2e5,
      radius: 1.4e-5,
      ageGyr: age,
      feh,
      carbon,
      postGyr: post,
    };
  }
  return {
    phase: 'black_hole',
    mk: null,
    sub: null,
    lumClass: null,
    wdType: null,
    nebula: deadFor < UNIVERSE.SNR_GYR ? 'snr' : 'none',
    mass: rem.mass,
    massZams: m0,
    luminosity: 0,
    teff: 0,
    // Rs = 2GM/c² ≈ 2.95 km × M/Msun; Rsun = 6.96e5 km.
    radius: (rem.mass * 2.95) / 6.96e5,
    ageGyr: age,
    feh,
    carbon,
    postGyr: post,
  };
}

/** MK + luminosity class as a short label, e.g. "G2V", "DA", "NS", "BH". */
export function classifyStar(s: StellarState): string {
  if (s.phase === 'white_dwarf') {
    const wd = s.wdType ?? 'DA';
    return s.nebula === 'planetary' ? `${wd}+PN` : wd;
  }
  if (s.phase === 'pulsar') return s.nebula === 'snr' ? 'PSR+SNR' : 'PSR';
  if (s.phase === 'neutron_star') return 'NS';
  if (s.phase === 'black_hole') return s.nebula === 'snr' ? 'BH+SNR' : 'BH';
  if (s.phase === 'wolf_rayet') return s.sub != null ? `WR${s.sub}` : 'WR';
  if (s.phase === 'carbon_star') return 'C';
  const mk = s.mk ?? '?';
  const sub = s.sub != null ? String(s.sub) : '';
  const lum = s.lumClass ?? '';
  const neb = s.nebula === 'hii' ? '+HII' : '';
  return `${mk}${sub}${lum}${neb}`;
}
