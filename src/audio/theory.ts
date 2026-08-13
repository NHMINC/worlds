import { mulberry32, xmur3 } from '../world/rng';

/**
 * Progressive-house laws of the bottle universe.
 *
 * The genre is patience. A short loop holds. Energy is a path a DJ
 * would walk: settle, strip, hang in the breakdown, hold the room
 * ready, then release. We never write a new tune every bar. Same
 * charter as the physics: constants and a grammar; a piece emerges.
 * A system seed is the DNA. Mood is climate (mode, density), not a
 * track picker.
 *
 * Form, in 16-bar sections that cycle every eight:
 *   intro → groove → lift → peak → break → build → drop → ride
 * Each phase has a start mix and an end mix. The build *holds* in
 * the breakdown, then climbs; the bass waits for the drop.
 *
 * Register: pad and voices sit in the chest. Sub is a long C1-ish
 * root; mid bass is the offbeat roll an octave above. Harmony is a
 * 4-chord loop, each chord held four bars. The loop mutates slowly.
 * The key walks a fifth only at cycle boundaries.
 */

export type MoodGroup = 'water' | 'green' | 'dry' | 'cold' | 'rock' | 'space';

export interface MoodLike {
  group: MoodGroup;
  /** 0 far / flight, 1 on the ground. */
  density: number;
}

export type ModeId = 'ionian' | 'lydian' | 'mixolydian' | 'dorian' | 'aeolian';
export type Quality = 'triad' | '7' | 'add9' | '6' | 'sus2';
export type Phase = 'intro' | 'groove' | 'lift' | 'peak' | 'break' | 'build' | 'drop' | 'ride';

export const MODES: Record<ModeId, readonly number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

const PHASES: readonly Phase[] = ['intro', 'groove', 'lift', 'peak', 'break', 'build', 'drop', 'ride'];

/** Visible knobs. Tune these; do not special-case a seed. */
export const MUSIC = {
  BPM_BASE: 124,
  BPM_MOOD: {
    green: 2,
    water: 1,
    dry: 0,
    rock: 0,
    cold: -2,
    space: -2,
  } as Record<MoodGroup, number>,
  BARS_PER_SECTION: 16,
  BARS_PER_CHORD: 4,
  PHASES_PER_CYCLE: 8,
  TONIC_MIDI: 45,
  VOICE_LO: 43,
  VOICE_HI: 67,
};

export interface Dna {
  tonic: number;
  brightness: number;
  bounce: number;
  warmth: number;
}

export interface PitchHit {
  at: number;
  notes: number[];
  vel: number;
  dur: number;
}

export interface PulseHit {
  at: number;
  vel: number;
}

export interface Arrangement {
  kick: number;
  hatClosed: number;
  hatOpen: number;
  hatTick: number;
  clap: number;
  bass: number;
  pad: number;
  arp: number;
  filter: number;
}

export interface BarScore {
  chordDeg: number;
  quality: Quality;
  voices: number[];
  pad: number[];
  /** Offbeat mid-bass roll (around C2). */
  bass: PitchHit[];
  /** Long rooted sub (around C1). */
  sub: PitchHit[];
  arp: PitchHit[];
  kicks: PulseHit[];
  hatsClosed: PulseHit[];
  hatsOpen: PulseHit[];
  hatsTick: PulseHit[];
  claps: PulseHit[];
}

export interface SectionScore {
  section: number;
  phase: Phase;
  key: number;
  tonicMidi: number;
  mode: ModeId;
  scale: readonly number[];
  bpm: number;
  swing: number;
  filter: number;
  bars: BarScore[];
}

/** Weighted moves — used when a loop chord mutates. */
const NEXT: Record<number, ReadonlyArray<readonly [number, number]>> = {
  0: [[5, 4], [3, 3], [4, 2], [6, 2], [2, 1]],
  1: [[4, 3], [0, 2], [5, 1]],
  2: [[6, 3], [5, 3], [0, 2]],
  3: [[0, 3], [4, 2], [5, 2], [6, 2]],
  4: [[0, 4], [5, 3], [3, 1]],
  5: [[3, 3], [2, 2], [6, 2], [0, 2]],
  6: [[0, 4], [3, 2], [5, 1]],
};

const CHORD_STEPS: Record<Quality, readonly [number, number, number]> = {
  triad: [0, 2, 4],
  '7': [0, 2, 6],
  add9: [0, 2, 8],
  '6': [0, 2, 5],
  sus2: [0, 1, 4],
};

/** House attractors: four chords, held, not a new idea every bar. */
const MINOR_LOOPS: ReadonlyArray<readonly number[]> = [
  [0, 5, 2, 6],
  [0, 5, 3, 6],
  [0, 3, 5, 6],
];
const MAJOR_LOOPS: ReadonlyArray<readonly number[]> = [
  [0, 4, 5, 3],
  [0, 5, 3, 4],
  [0, 3, 4, 0],
];

type Ease = 'linear' | 'holdThen' | 'thenHold';

interface PhasePath {
  start: Arrangement;
  end: Arrangement;
  ease: Ease;
}

/**
 * The DJ path. `holdThen` sits in the breakdown, then climbs (the
 * last bars do more). `thenHold` dumps quickly and hangs.
 */
const PHASE_PATH: Record<Phase, PhasePath> = {
  intro: {
    ease: 'linear',
    start: { kick: 0, hatClosed: 0, hatOpen: 0, hatTick: 0, clap: 0, bass: 0, pad: 0.78, arp: 0.08, filter: 0.1 },
    end: { kick: 0.38, hatClosed: 0, hatOpen: 0, hatTick: 0, clap: 0, bass: 0, pad: 0.72, arp: 0.12, filter: 0.2 },
  },
  groove: {
    ease: 'linear',
    start: { kick: 0.76, hatClosed: 0.2, hatOpen: 0, hatTick: 0, clap: 0.18, bass: 0.7, pad: 0.6, arp: 0.1, filter: 0.26 },
    end: { kick: 0.84, hatClosed: 0.38, hatOpen: 0, hatTick: 0, clap: 0.32, bass: 0.78, pad: 0.62, arp: 0.16, filter: 0.32 },
  },
  lift: {
    ease: 'linear',
    start: { kick: 0.84, hatClosed: 0.4, hatOpen: 0.15, hatTick: 0, clap: 0.36, bass: 0.8, pad: 0.64, arp: 0.2, filter: 0.34 },
    end: { kick: 0.9, hatClosed: 0.52, hatOpen: 0.4, hatTick: 0.16, clap: 0.5, bass: 0.86, pad: 0.66, arp: 0.28, filter: 0.46 },
  },
  peak: {
    ease: 'linear',
    start: { kick: 0.9, hatClosed: 0.52, hatOpen: 0.42, hatTick: 0.18, clap: 0.52, bass: 0.86, pad: 0.66, arp: 0.28, filter: 0.48 },
    end: { kick: 0.92, hatClosed: 0.56, hatOpen: 0.5, hatTick: 0.22, clap: 0.58, bass: 0.88, pad: 0.68, arp: 0.3, filter: 0.54 },
  },
  break: {
    ease: 'thenHold',
    start: { kick: 0.35, hatClosed: 0.12, hatOpen: 0, hatTick: 0, clap: 0, bass: 0.15, pad: 0.9, arp: 0.32, filter: 0.36 },
    end: { kick: 0, hatClosed: 0, hatOpen: 0, hatTick: 0, clap: 0, bass: 0, pad: 0.94, arp: 0.18, filter: 0.22 },
  },
  build: {
    ease: 'holdThen',
    start: { kick: 0, hatClosed: 0, hatOpen: 0, hatTick: 0, clap: 0, bass: 0, pad: 0.9, arp: 0.36, filter: 0.24 },
    end: { kick: 0.74, hatClosed: 0.55, hatOpen: 0.28, hatTick: 0.4, clap: 0.48, bass: 0.06, pad: 0.78, arp: 0.48, filter: 0.9 },
  },
  drop: {
    ease: 'linear',
    start: { kick: 1, hatClosed: 0.7, hatOpen: 0.86, hatTick: 0.7, clap: 0.82, bass: 1, pad: 0.7, arp: 0.32, filter: 0.92 },
    end: { kick: 1, hatClosed: 0.72, hatOpen: 0.88, hatTick: 0.74, clap: 0.84, bass: 1, pad: 0.68, arp: 0.3, filter: 0.9 },
  },
  ride: {
    ease: 'linear',
    start: { kick: 0.96, hatClosed: 0.62, hatOpen: 0.72, hatTick: 0.48, clap: 0.7, bass: 0.92, pad: 0.66, arp: 0.24, filter: 0.78 },
    end: { kick: 0.72, hatClosed: 0.36, hatOpen: 0.22, hatTick: 0.12, clap: 0.4, bass: 0.58, pad: 0.7, arp: 0.16, filter: 0.42 },
  },
};

export function rngFor(seed: string, ...parts: Array<string | number>): () => number {
  const h = xmur3(`music:${seed}:${parts.join(':')}`);
  return mulberry32(h());
}

export function dnaFromSeed(seed: string): Dna {
  const rng = rngFor(seed, 'dna');
  return {
    tonic: Math.floor(rng() * 12),
    brightness: rng(),
    bounce: rng(),
    warmth: rng(),
  };
}

export function modeFor(group: MoodGroup, brightness: number): ModeId {
  if (group === 'green') return brightness > 0.7 ? 'lydian' : brightness > 0.35 ? 'ionian' : 'dorian';
  if (group === 'water') return brightness > 0.55 ? 'mixolydian' : 'dorian';
  if (group === 'dry') return brightness > 0.5 ? 'mixolydian' : 'dorian';
  if (group === 'cold') return brightness > 0.45 ? 'dorian' : 'aeolian';
  if (group === 'rock') return brightness > 0.6 ? 'mixolydian' : 'aeolian';
  return brightness > 0.4 ? 'dorian' : 'aeolian';
}

export function scaleOf(mode: ModeId): readonly number[] {
  return MODES[mode];
}

export function phaseFor(section: number): Phase {
  return PHASES[((section % MUSIC.PHASES_PER_CYCLE) + MUSIC.PHASES_PER_CYCLE) % MUSIC.PHASES_PER_CYCLE];
}

export function tempoFor(mood: MoodLike, dna: Dna): number {
  return MUSIC.BPM_BASE + MUSIC.BPM_MOOD[mood.group] + Math.round((dna.bounce - 0.5) * 2);
}

export function keyFor(dna: Dna, seed: string, section: number): number {
  const cycles = Math.floor(section / MUSIC.PHASES_PER_CYCLE);
  let key = dna.tonic;
  for (let c = 1; c <= cycles; c++) {
    const r = rngFor(seed, 'modulate', c)();
    key = (key + (r < 0.7 ? 7 : 5)) % 12;
  }
  return key;
}

export function midiOf(tonicMidi: number, scale: readonly number[], degree: number, oct = 0): number {
  const n = scale.length;
  const wrap = ((degree % n) + n) % n;
  const o = Math.floor(degree / n) + oct;
  return tonicMidi + o * 12 + scale[wrap];
}

export function grammarDestinations(from: number, allowBvii: boolean): number[] {
  const raw = NEXT[from] ?? NEXT[0];
  const opts = allowBvii ? raw : raw.filter(([d]) => d !== 6);
  return (opts.length ? opts : raw).map(([d]) => d);
}

export function pickNext(from: number, rng: () => number, allowBvii: boolean): number {
  const dest = grammarDestinations(from, allowBvii);
  return dest[Math.floor(rng() * dest.length)] ?? 0;
}

export function qualityFor(deg: number, warmth: number, rng: () => number): Quality {
  if (deg === 0) return rng() < 0.45 + warmth * 0.2 ? 'add9' : rng() < 0.5 ? 'sus2' : 'triad';
  if (deg === 3 || deg === 5) return rng() < 0.4 ? 'add9' : 'triad';
  return rng() < 0.35 ? 'sus2' : 'triad';
}

export function chordTones(tonicMidi: number, scale: readonly number[], deg: number, quality: Quality): number[] {
  return CHORD_STEPS[quality].map((step) => midiOf(tonicMidi, scale, deg + step, 0));
}

export function placeVoicing(tones: number[]): number[] {
  return uncluster(
    tones.map((n, i) => {
      let x = n;
      const lo = MUSIC.VOICE_LO + i * 6;
      const hi = MUSIC.VOICE_HI - (tones.length - 1 - i) * 4;
      while (x < lo) x += 12;
      while (x > hi) x -= 12;
      if (x < lo) x += 12;
      return x;
    }),
  );
}

export function voiceLead(prev: number[], next: number[]): number[] {
  const pcs = [...new Set(next.map((n) => ((n % 12) + 12) % 12))];
  const sortedPrev = [...prev].sort((a, b) => a - b);
  const used = new Set<number>();
  const out: number[] = [];
  for (const p of sortedPrev) {
    let best = p;
    let bestScore = 1e9;
    for (const pc of pcs) {
      const rel = pc - ((((p % 12) + 12) % 12));
      for (const c of [p + rel, p + rel - 12, p + rel + 12]) {
        if (c < MUSIC.VOICE_LO - 2 || c > MUSIC.VOICE_HI + 2) continue;
        if (used.has(c)) continue;
        const score = Math.abs(c - p);
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    if (used.has(best)) best = best < (MUSIC.VOICE_LO + MUSIC.VOICE_HI) / 2 ? best + 12 : best - 12;
    used.add(best);
    out.push(best);
  }
  return uncluster(out);
}

export function arrangementFor(mood: MoodLike, _dna: Dna, section: number, bar = 0): Arrangement {
  const path = PHASE_PATH[phaseFor(section)];
  const t = easeT(bar / Math.max(1, MUSIC.BARS_PER_SECTION - 1), path.ease);
  const base = lerpArr(path.start, path.end, t);
  const d = mood.density;
  const space = mood.group === 'space' ? 0.78 : 1;
  const cold = mood.group === 'cold' ? 0.85 : 1;
  return {
    kick: base.kick * space,
    hatClosed: base.hatClosed * (0.75 + d * 0.35) * cold,
    hatOpen: base.hatOpen * (0.7 + d * 0.4),
    hatTick: base.hatTick * (0.7 + d * 0.4) * cold,
    clap: base.clap * space,
    bass: base.bass * space,
    pad: base.pad,
    arp: base.arp * (0.65 + d * 0.45),
    filter: clamp(base.filter + d * 0.06, 0, 1),
  };
}

export function composeSection(seed: string, section: number, mood: MoodLike, dna: Dna): SectionScore {
  const key = keyFor(dna, seed, section);
  const mode = modeFor(mood.group, dna.brightness);
  const scale = scaleOf(mode);
  const tonicMidi = MUSIC.TONIC_MIDI + key;
  const phase = phaseFor(section);
  const arr = arrangementFor(mood, dna, section);
  const loop = evolvingLoop(seed, section, mode);
  const hold = MUSIC.BARS_PER_CHORD;
  const degrees = loop.flatMap((c) => Array.from({ length: hold }, () => c));

  const qRng = rngFor(seed, 'qual', section);
  const qualities = loop.map((deg) => qualityFor(deg, dna.warmth, qRng));

  let voices = placeVoicing(chordTones(tonicMidi, scale, degrees[0], qualities[0]));
  const arpPattern = arpDegrees(rngFor(seed, 'arp', Math.floor(section / 2)));
  const bars: BarScore[] = [];

  for (let i = 0; i < MUSIC.BARS_PER_SECTION; i++) {
    const deg = degrees[i];
    const quality = qualities[Math.floor(i / hold)];
    const tones = chordTones(tonicMidi, scale, deg, quality);
    voices = i === 0 ? placeVoicing(tones) : voiceLead(voices, tones);
    const subRoot = midiOf(tonicMidi - 12, scale, deg, 0);
    const midRoot = midiOf(tonicMidi, scale, deg, 0);
    const midFifth = midiOf(tonicMidi, scale, deg + 4, 0);
    bars.push({
      chordDeg: deg,
      quality,
      voices: [...voices],
      pad: [...voices],
      bass: midHits(midRoot, midFifth, dna.bounce, i),
      sub: subHits(subRoot),
      arp: arpHits(arpPattern, tonicMidi, scale, deg),
      kicks: fourOnFloor(),
      hatsClosed: closedHats(),
      hatsOpen: openHats(),
      hatsTick: tickHats(),
      claps: claps(),
    });
  }

  return {
    section,
    phase,
    key,
    tonicMidi,
    mode,
    scale,
    bpm: tempoFor(mood, dna),
    swing: 0,
    filter: arr.filter,
    bars,
  };
}

export function roman(deg: number, quality: Quality): string {
  const names = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'VII'];
  return `${names[deg] ?? '?'}${quality === 'triad' ? '' : quality}`;
}

export function loopChords(seed: string, section: number, mode: ModeId): number[] {
  return evolvingLoop(seed, section, mode);
}

function evolvingLoop(seed: string, section: number, mode: ModeId): number[] {
  const minor = mode === 'aeolian' || mode === 'dorian';
  const bank = minor ? MINOR_LOOPS : MAJOR_LOOPS;
  const allowBvii = minor || mode === 'mixolydian';
  const head = rngFor(seed, 'loop0', mode);
  let loop = [...bank[Math.floor(head() * bank.length)]];
  for (let s = 0; s < section; s++) {
    const r = rngFor(seed, 'loopmut', s)();
    if (r < 0.22) {
      const i = 1 + Math.floor(rngFor(seed, 'loopi', s)() * 3);
      loop[i] = pickNext(loop[i - 1] ?? 0, rngFor(seed, 'loopn', s), allowBvii);
    } else if (r < 0.28) {
      loop = [...bank[Math.floor(rngFor(seed, 'loopnew', s)() * bank.length)]];
    }
  }
  return loop;
}

function arpDegrees(rng: () => number): number[] {
  const patterns: ReadonlyArray<readonly number[]> = [
    [0, 2, 4, 2],
    [0, 2, 4, 7],
    [0, 4, 2, 4],
    [2, 0, 4, 2],
  ];
  return [...patterns[Math.floor(rng() * patterns.length)]];
}

function arpHits(pattern: number[], tonicMidi: number, scale: readonly number[], chordDeg: number): PitchHit[] {
  return [0, 4, 8, 12].map((at, i) => ({
    at,
    notes: [midiOf(tonicMidi, scale, chordDeg + pattern[i % pattern.length], 0)],
    vel: i % 2 === 0 ? 0.48 : 0.36,
    dur: 3,
  }));
}

/** Long rooted sub — the floor the kick locks to. */
function subHits(root: number): PitchHit[] {
  return [
    { at: 0, notes: [root], vel: 0.84, dur: 7 },
    { at: 8, notes: [root], vel: 0.8, dur: 7 },
  ];
}

/**
 * Offbeat mid-bass roll an octave above the sub. Bounce walks the
 * last hit; odd bars can pick up a syncopation. The structure, not
 * a new riff every section.
 */
function midHits(root: number, fifth: number, bounce: number, bar: number): PitchHit[] {
  const late = bounce > 0.75 ? Math.min(root + 12, 60) : bounce > 0.5 ? fifth : root;
  if (bar % 2 === 1 && bounce > 0.48) {
    return [
      { at: 2, notes: [root], vel: 0.76, dur: 3 },
      { at: 6, notes: [root], vel: 0.68, dur: 3 },
      { at: 11, notes: [root], vel: 0.6, dur: 2 },
      { at: 14, notes: [late], vel: 0.7, dur: 3 },
    ];
  }
  return [
    { at: 2, notes: [root], vel: 0.78, dur: 3 },
    { at: 6, notes: [root], vel: 0.7, dur: 3 },
    { at: 10, notes: [root], vel: 0.74, dur: 3 },
    { at: 14, notes: [late], vel: 0.68, dur: 3 },
  ];
}

function fourOnFloor(): PulseHit[] {
  return [0, 4, 8, 12].map((at) => ({ at, vel: 0.86 }));
}

function closedHats(): PulseHit[] {
  return [0, 2, 4, 6, 8, 10, 12, 14].map((at) => ({ at, vel: at % 4 === 0 ? 0.22 : 0.4 }));
}

/** Off-grid 16ths. The mix law (hatTick) decides whether they speak. */
function tickHats(): PulseHit[] {
  return [1, 3, 5, 7, 9, 11, 13, 15].map((at) => ({ at, vel: 0.26 }));
}

function openHats(): PulseHit[] {
  return [2, 6, 10, 14].map((at) => ({ at, vel: 0.52 }));
}

function claps(): PulseHit[] {
  return [4, 12].map((at) => ({ at, vel: 0.62 }));
}

function uncluster(notes: number[]): number[] {
  const out = [...notes].sort((a, b) => a - b);
  if (out.length >= 3 && out[out.length - 1] - out[0] <= 4) {
    const raised = out[1] + 12;
    out[1] = out[2];
    out[2] = raised;
    out.sort((a, b) => a - b);
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i] - out[i - 1] < 2) out[i] += 12;
  }
  return out;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpArr(a: Arrangement, b: Arrangement, t: number): Arrangement {
  return {
    kick: lerp(a.kick, b.kick, t),
    hatClosed: lerp(a.hatClosed, b.hatClosed, t),
    hatOpen: lerp(a.hatOpen, b.hatOpen, t),
    hatTick: lerp(a.hatTick, b.hatTick, t),
    clap: lerp(a.clap, b.clap, t),
    bass: lerp(a.bass, b.bass, t),
    pad: lerp(a.pad, b.pad, t),
    arp: lerp(a.arp, b.arp, t),
    filter: lerp(a.filter, b.filter, t),
  };
}

function easeT(t: number, ease: Ease): number {
  const x = clamp(t, 0, 1);
  if (ease === 'holdThen') {
    if (x < 0.4) return 0;
    const u = (x - 0.4) / 0.6;
    return u * u;
  }
  if (ease === 'thenHold') return x < 0.3 ? x / 0.3 : 1;
  return x;
}
