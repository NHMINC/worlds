import { mulberry32, xmur3 } from '../world/rng';

/**
 * Musical laws of the bottle universe.
 *
 * Same charter as the physics: we set constants and a grammar; a piece
 * *emerges*. There is no playlist, no looped 8-bar stem, no “if iceball
 * play piano”. A system seed is the DNA. Wall-clock bars walk a circle of
 * fifths, mutate a motif, and breathe the arrangement. The viewport mood
 * is a climate — it tilts mode, tempo, and density the way temperature
 * tilts a hydrosphere. It does not pick a track.
 *
 * Listening target: chill-game tradition (warm keys, a pulse you can
 * nod to, a tune that comes and goes) — upbeat and soothing, never a
 * random tone cloud, never a drone.
 */

export type MoodGroup = 'water' | 'green' | 'dry' | 'cold' | 'rock' | 'space';

export interface MoodLike {
  group: MoodGroup;
  /** 0 far / flight, 1 on the ground. */
  density: number;
}

export type ModeId = 'ionian' | 'lydian' | 'mixolydian' | 'dorian' | 'aeolian';
export type Quality = 'triad' | '7' | 'add9' | '6' | 'sus2';

export const MODES: Record<ModeId, readonly number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

/** Visible knobs. Tune these; do not special-case a seed. */
export const MUSIC = {
  BPM_BASE: 86,
  BPM_MOOD: {
    green: 4,
    water: 2,
    dry: 0,
    rock: -2,
    cold: -8,
    space: -12,
  } as Record<MoodGroup, number>,
  SWING: {
    green: 0.1,
    water: 0.16,
    dry: 0.08,
    rock: 0.04,
    cold: 0.02,
    space: 0,
  } as Record<MoodGroup, number>,
  BARS_PER_PHRASE: 4,
  PHRASES_PER_SECTION: 4,
  /** How often a section walks a fifth / fourth. */
  MODULATE_FIFTH: 0.18,
  MODULATE_FOURTH: 0.1,
  TONIC_MIDI: 48,
  LEAD_OCT: 2,
  VOICE_LO: 52,
  VOICE_HI: 81,
};

export interface Dna {
  /** Pitch class 0–11. */
  tonic: number;
  brightness: number;
  bounce: number;
  warmth: number;
  leadHi: boolean;
}

export interface NoteEvent {
  /** Scale degree from the tonic, or -1 for a rest. */
  deg: number;
  oct: number;
  /** Length in sixteenth notes. */
  dur: number;
}

export interface Motif {
  events: NoteEvent[];
  length: number;
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
  pad: number;
  keys: number;
  bass: number;
  pulse: number;
  sparkle: number;
  lead: number;
}

export interface BarScore {
  chordDeg: number;
  quality: Quality;
  voices: number[];
  pad: number[];
  keys: PitchHit[];
  bass: PitchHit[];
  lead: PitchHit[];
  sparkle: PitchHit[];
  kicks: PulseHit[];
  shakers: PulseHit[];
}

export interface SectionScore {
  section: number;
  key: number;
  tonicMidi: number;
  mode: ModeId;
  scale: readonly number[];
  bpm: number;
  swing: number;
  bars: BarScore[];
}

/** Weighted moves from a diatonic degree. The grammar, not a playlist. */
const NEXT: Record<number, ReadonlyArray<readonly [number, number]>> = {
  0: [[3, 3], [5, 3], [4, 2], [1, 2], [2, 1], [6, 2]],
  1: [[4, 4], [0, 2], [3, 2], [5, 1]],
  2: [[5, 4], [3, 3], [0, 1]],
  3: [[0, 3], [4, 3], [1, 2], [5, 1], [6, 1]],
  4: [[0, 5], [5, 3], [3, 1]],
  5: [[3, 3], [1, 2], [4, 2], [0, 2], [2, 1]],
  6: [[0, 4], [3, 3], [5, 1]],
};

const CHORD_STEPS: Record<Quality, readonly [number, number, number]> = {
  triad: [0, 2, 4],
  '7': [0, 2, 6],
  add9: [0, 2, 8],
  '6': [0, 2, 5],
  sus2: [0, 1, 4],
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
    leadHi: rng() < 0.4,
  };
}

export function modeFor(group: MoodGroup, brightness: number): ModeId {
  if (group === 'green') return brightness > 0.62 ? 'lydian' : 'ionian';
  if (group === 'water') return brightness > 0.4 ? 'mixolydian' : 'ionian';
  if (group === 'dry') return brightness > 0.5 ? 'mixolydian' : 'dorian';
  if (group === 'cold') return brightness > 0.42 ? 'dorian' : 'aeolian';
  if (group === 'rock') return brightness > 0.55 ? 'mixolydian' : 'ionian';
  return brightness > 0.32 ? 'lydian' : 'ionian';
}

export function scaleOf(mode: ModeId): readonly number[] {
  return MODES[mode];
}

export function tempoFor(mood: MoodLike, dna: Dna): number {
  return MUSIC.BPM_BASE + MUSIC.BPM_MOOD[mood.group] + Math.round((dna.bounce - 0.5) * 6);
}

export function swingFor(mood: MoodLike, dna: Dna): number {
  return clamp(MUSIC.SWING[mood.group] + (dna.bounce - 0.5) * 0.08, 0, 0.22);
}

/** Slow walk around the circle of fifths — the piece never sits in one key. */
export function keyFor(dna: Dna, seed: string, section: number): number {
  let key = dna.tonic;
  for (let s = 0; s < section; s++) {
    const r = rngFor(seed, 'modulate', s)();
    if (r < MUSIC.MODULATE_FIFTH) key = (key + 7) % 12;
    else if (r < MUSIC.MODULATE_FIFTH + MUSIC.MODULATE_FOURTH) key = (key + 5) % 12;
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
  const raw = NEXT[from] ?? NEXT[0];
  const opts = allowBvii ? raw : raw.filter(([d]) => d !== 6);
  const table = opts.length ? opts : raw;
  let w = 0;
  for (const [, wt] of table) w += wt;
  let x = rng() * w;
  for (const [deg, wt] of table) {
    x -= wt;
    if (x <= 0) return deg;
  }
  return table[table.length - 1][0];
}

export function qualityFor(deg: number, mode: ModeId, warmth: number, rng: () => number): Quality {
  if (deg === 0) {
    if (mode === 'mixolydian') return rng() < 0.45 ? 'sus2' : rng() < 0.5 ? '7' : 'add9';
    if (mode === 'lydian') return rng() < 0.55 ? 'add9' : '6';
    const r = rng();
    if (r < 0.3 + warmth * 0.2) return 'add9';
    if (r < 0.55 + warmth * 0.15) return '6';
    if (r < 0.8) return '7';
    return 'triad';
  }
  if (deg === 3) return rng() < 0.55 + warmth * 0.2 ? 'add9' : '7';
  if (deg === 4) return rng() < 0.5 ? 'sus2' : 'triad';
  if (deg === 6) return 'triad';
  return '7';
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

/** Nearest-neighbour voice leading; common tones stay put, voices do not cross. */
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
    if (used.has(best)) best = best < 70 ? best + 12 : best - 12;
    used.add(best);
    out.push(best);
  }
  return uncluster(out);
}

export function makeMotif(rng: () => number, chordDeg: number): Motif {
  const events: NoteEvent[] = [];
  const chord = [0, 2, 4].map((s) => ((chordDeg + s) % 7 + 7) % 7);
  let deg = chord[Math.floor(rng() * chord.length)];
  let filled = 0;
  let lastLeap = 0;

  while (filled < 16) {
    const remain = 16 - filled;
    const rawDur = [2, 2, 2, 4, 4, 4, 6, 8][Math.floor(rng() * 8)];
    const dur = Math.min(rawDur, remain);
    const rest = filled > 0 && remain > 2 && rng() < 0.2;
    if (rest) {
      events.push({ deg: -1, oct: 0, dur });
      filled += dur;
      continue;
    }
    if (filled % 4 === 0 && rng() < 0.72) {
      deg = nearestDeg(deg, chord);
    } else if (lastLeap !== 0) {
      deg += lastLeap > 0 ? -1 : 1;
      lastLeap = 0;
    } else {
      const r = rng();
      let step = 0;
      if (r < 0.12) step = 0;
      else if (r < 0.58) step = rng() < 0.5 ? 1 : -1;
      else if (r < 0.84) step = rng() < 0.5 ? 2 : -2;
      else {
        step = rng() < 0.5 ? 3 : -3;
        lastLeap = step;
      }
      deg += step;
      if (deg > 8) deg -= 2;
      if (deg < -2) deg += 2;
    }
    events.push({ deg, oct: 0, dur });
    filled += dur;
  }

  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].deg >= 0) {
      if (rng() < 0.8) events[i] = { ...events[i], deg: rng() < 0.7 ? 0 : 4 };
      break;
    }
  }
  return { events, length: 16 };
}

export function varyMotif(motif: Motif, rng: () => number, kind: 'repeat' | 'seq' | 'thin' | 'ornament' | 'cadence'): Motif {
  if (kind === 'repeat') return { events: motif.events.map((e) => ({ ...e })), length: motif.length };

  if (kind === 'seq') {
    const lift = rng() < 0.5 ? 1 : 2;
    return {
      events: motif.events.map((e) => (e.deg < 0 ? { ...e } : { ...e, deg: e.deg + lift })),
      length: motif.length,
    };
  }

  if (kind === 'thin') {
    return {
      events: motif.events.map((e, i) => (i % 2 === 1 && e.deg >= 0 && rng() < 0.7 ? { ...e, deg: -1 } : { ...e })),
      length: motif.length,
    };
  }

  if (kind === 'ornament') {
    const events: NoteEvent[] = [];
    for (const e of motif.events) {
      if (e.deg >= 0 && e.dur >= 4 && rng() < 0.55) {
        const half = Math.floor(e.dur / 2);
        events.push({ deg: e.deg, oct: e.oct, dur: half });
        events.push({ deg: e.deg + (rng() < 0.5 ? 1 : -1), oct: e.oct, dur: e.dur - half });
      } else {
        events.push({ ...e });
      }
    }
    return { events, length: motif.length };
  }

  const events = motif.events.map((e) => ({ ...e }));
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].deg >= 0) {
      events[i] = { ...events[i], deg: 0 };
      break;
    }
  }
  return { events, length: motif.length };
}

export function arrangementFor(mood: MoodLike, dna: Dna, barInSection: number): Arrangement {
  const phrase = Math.floor(barInSection / MUSIC.BARS_PER_PHRASE);
  const settle = phrase === 3 ? 0.68 : 1;
  const lift = phrase === 2 ? 1.08 : 1;
  const d = mood.density;
  const space = mood.group === 'space';
  const cold = mood.group === 'cold';
  const water = mood.group === 'water';
  return {
    pad: 0.88,
    keys: (0.58 + d * 0.22) * settle,
    bass: space ? 0.38 + d * 0.15 : 0.72 + d * 0.12,
    pulse:
      (space ? 0.1 + d * 0.12 : 0.42 + dna.bounce * 0.32 + d * 0.22) *
      (cold ? 0.55 : 1) *
      settle,
    sparkle: (0.38 + (cold || water ? 0.22 : 0) + d * 0.18) * lift,
    lead: (0.48 + d * 0.4) * (phrase === 3 ? 0.42 : 1) * (space ? 0.58 : 1),
  };
}

export function composeSection(seed: string, section: number, mood: MoodLike, dna: Dna): SectionScore {
  const key = keyFor(dna, seed, section);
  const mode = modeFor(mood.group, dna.brightness);
  const scale = scaleOf(mode);
  const tonicMidi = MUSIC.TONIC_MIDI + key;
  const allowBvii = mode === 'mixolydian' || mode === 'dorian';
  const hold = mood.group === 'space' || mood.group === 'cold' ? 2 : 1;

  const progRng = rngFor(seed, 'prog', section, mood.group);
  const degrees = buildProgression(progRng, allowBvii, hold);
  const qualities = degrees.map((deg) => qualityFor(deg, mode, dna.warmth, progRng));

  const motifRng = rngFor(seed, 'motif', section);
  const head = makeMotif(motifRng, degrees[0]);

  let voices = placeVoicing(chordTones(tonicMidi, scale, degrees[0], qualities[0]));
  const bars: BarScore[] = [];

  for (let i = 0; i < 16; i++) {
    const deg = degrees[i];
    const quality = qualities[i];
    const tones = chordTones(tonicMidi, scale, deg, quality);
    voices = i === 0 ? placeVoicing(tones) : voiceLead(voices, tones);

    const phrase = Math.floor(i / 4);
    const barInPhrase = i % 4;
    const varyRng = rngFor(seed, 'vary', section, i);
    const kind = varyKind(phrase, barInPhrase, varyRng);
    const motif = varyMotif(head, varyRng, kind);
    const leadRest = i > 0 && ((phrase === 3 && barInPhrase % 2 === 1) || varyRng() < 0.1);

    const leadBase = tonicMidi + (dna.leadHi ? 24 : 12);
    const lead = leadRest ? [] : motifHits(motif, leadBase, scale);
    const root = midiOf(tonicMidi - 12, scale, deg, 0);
    const fifth = midiOf(tonicMidi - 12, scale, deg + 4, 0);
    const pulseRng = rngFor(seed, 'pulse', section, i);
    const groove = pulseHits(dna.bounce, mood.group, pulseRng);
    const pattern = keysPattern(seed, section, mood.group, dna);
    const sparkRng = rngFor(seed, 'spark', section, i);

    bars.push({
      chordDeg: deg,
      quality,
      voices: [...voices],
      pad: [voices[0] - 12, voices[1], voices[2]],
      keys: keysHits(voices, pattern),
      bass: bassHits(root, fifth, dna.bounce, pulseRng),
      lead,
      sparkle: sparkleHits(tonicMidi, scale, deg, lead, sparkRng, mood.group),
      kicks: groove.kicks,
      shakers: groove.shakers,
    });
  }

  return {
    section,
    key,
    tonicMidi,
    mode,
    scale,
    bpm: tempoFor(mood, dna),
    swing: swingFor(mood, dna),
    bars,
  };
}

export function roman(deg: number, quality: Quality): string {
  const names = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'VII'];
  return `${names[deg] ?? '?'}${quality === 'triad' ? '' : quality}`;
}

function buildProgression(rng: () => number, allowBvii: boolean, hold: number): number[] {
  const phrase = (start: number, cadence: 'half' | 'home'): number[] => {
    const out = [start];
    let cur = start;
    for (let i = 1; i < 4; i++) {
      if (i === 3 && cadence === 'home') cur = 0;
      else if (i === 2 && cadence === 'home') {
        const prefer = allowBvii ? [4, 3, 6] : [4, 3];
        const legal = new Set(grammarDestinations(cur, allowBvii));
        const opts = prefer.filter((d) => legal.has(d) || d === cur);
        cur = opts.length ? opts[Math.floor(rng() * opts.length)] : pickNext(cur, rng, allowBvii);
      } else if (i === 3 && cadence === 'half') {
        const prefer = rng() < 0.6 ? 4 : 3;
        const legal = grammarDestinations(cur, allowBvii);
        cur = legal.includes(prefer) || prefer === cur ? prefer : (legal[0] ?? cur);
      } else {
        cur = pickNext(cur, rng, allowBvii);
      }
      out.push(cur);
    }
    return out;
  };

  const a = phrase(rng() < 0.18 ? 5 : 0, 'half');
  if (hold === 2) {
    const d = phrase(a[3], 'home');
    return [...a, ...d].flatMap((x) => [x, x]);
  }
  const b = phrase(rng() < 0.35 ? 0 : a[3], 'half');
  const c = phrase(rng() < 0.5 ? 3 : 5, 'half');
  const d = phrase(c[3], 'home');
  return [...a, ...b, ...c, ...d];
}

function varyKind(phrase: number, barInPhrase: number, rng: () => number): 'repeat' | 'seq' | 'thin' | 'ornament' | 'cadence' {
  if (phrase === 3 && barInPhrase === 3) return 'cadence';
  if (barInPhrase === 0) return 'repeat';
  if (barInPhrase === 1) return rng() < 0.55 ? 'seq' : 'ornament';
  if (barInPhrase === 2) return rng() < 0.45 ? 'ornament' : 'repeat';
  return rng() < 0.5 ? 'thin' : 'cadence';
}

function keysPattern(seed: string, section: number, group: MoodGroup, dna: Dna): 'block' | 'broken' | 'sync' {
  const r = rngFor(seed, 'kpat', section, group, Math.round(dna.warmth * 10))();
  if (group === 'space' || group === 'cold') return r < 0.7 ? 'block' : 'broken';
  if (group === 'water' || group === 'green') return r < 0.4 ? 'sync' : r < 0.75 ? 'broken' : 'block';
  return r < 0.5 ? 'broken' : 'block';
}

function keysHits(voices: number[], pattern: 'block' | 'broken' | 'sync'): PitchHit[] {
  if (pattern === 'block') {
    return [
      { at: 0, notes: voices, vel: 0.64, dur: 6 },
      { at: 8, notes: voices, vel: 0.36, dur: 4 },
    ];
  }
  if (pattern === 'broken') {
    const a = voices[0];
    const b = voices[1] ?? voices[0];
    const c = voices[2] ?? b;
    return [
      { at: 0, notes: [a], vel: 0.52, dur: 3 },
      { at: 4, notes: [b], vel: 0.42, dur: 3 },
      { at: 8, notes: [c], vel: 0.5, dur: 3 },
      { at: 12, notes: [b], vel: 0.34, dur: 3 },
    ];
  }
  return [
    { at: 2, notes: voices, vel: 0.58, dur: 4 },
    { at: 8, notes: voices, vel: 0.34, dur: 3 },
    { at: 14, notes: [voices[2] ?? voices[0]], vel: 0.28, dur: 2 },
  ];
}

function bassHits(root: number, fifth: number, bounce: number, rng: () => number): PitchHit[] {
  const hits: PitchHit[] = [{ at: 0, notes: [root], vel: 0.82, dur: bounce > 0.55 ? 5 : 7 }];
  if (rng() < 0.72) {
    hits.push({ at: 8, notes: [rng() < 0.32 ? fifth : root], vel: 0.56, dur: 4 });
  }
  if (bounce > 0.48 && rng() < 0.42) {
    hits.push({ at: 14, notes: [rng() < 0.5 ? fifth : root + 12], vel: 0.4, dur: 2 });
  }
  return hits;
}

function pulseHits(bounce: number, group: MoodGroup, rng: () => number): { kicks: PulseHit[]; shakers: PulseHit[] } {
  const kicks: PulseHit[] = [{ at: 0, vel: 0.7 }];
  if (bounce > 0.32) kicks.push({ at: 8, vel: 0.46 });
  if (bounce > 0.68 && (group === 'green' || group === 'water') && rng() < 0.45) {
    kicks.push({ at: 6, vel: 0.26 });
  }
  const shakers: PulseHit[] = [];
  for (let at = 0; at < 16; at += 2) {
    shakers.push({ at, vel: at % 4 === 2 ? 0.56 : 0.26 });
  }
  return { kicks, shakers };
}

function motifHits(motif: Motif, tonicMidi: number, scale: readonly number[]): PitchHit[] {
  const hits: PitchHit[] = [];
  let t = 0;
  for (const ev of motif.events) {
    if (ev.deg >= 0 && t < 16) {
      hits.push({
        at: t,
        notes: [midiOf(tonicMidi, scale, ev.deg, ev.oct)],
        vel: t % 8 === 0 ? 0.6 : 0.44,
        dur: Math.max(1, ev.dur),
      });
    }
    t += ev.dur;
  }
  return hits;
}

function sparkleHits(
  tonicMidi: number,
  scale: readonly number[],
  chordDeg: number,
  lead: PitchHit[],
  rng: () => number,
  group: MoodGroup,
): PitchHit[] {
  const busy = new Set(lead.map((h) => h.at));
  const gaps = [2, 6, 10, 14].filter((at) => !busy.has(at));
  const n = group === 'space' || group === 'cold' ? (rng() < 0.7 ? 1 : 2) : rng() < 0.55 ? 1 : 0;
  const hits: PitchHit[] = [];
  for (let i = 0; i < n && gaps.length; i++) {
    const at = gaps.splice(Math.floor(rng() * gaps.length), 1)[0];
    const deg = chordDeg + (rng() < 0.55 ? 4 : 8);
    hits.push({
      at,
      notes: [midiOf(tonicMidi + 24, scale, deg, 0)],
      vel: 0.32 + rng() * 0.16,
      dur: 3,
    });
  }
  return hits;
}

function nearestDeg(deg: number, chord: number[]): number {
  let best = chord[0];
  let bestD = 99;
  for (const c of chord) {
    let d = Math.abs(c - deg);
    d = Math.min(d, 7 - d);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
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
