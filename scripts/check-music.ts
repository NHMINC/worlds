/**
 * Invariant checks for the generative music laws.
 *
 *   npx tsx scripts/check-music.ts
 *
 * We assert the grammar, not a recording: notes stay in the mode, chords
 * walk legal moves, voices lead, motifs breathe, a seed is deterministic,
 * and the piece keeps becoming a new piece as sections pass.
 */
import {
  MUSIC,
  composeSection,
  dnaFromSeed,
  grammarDestinations,
  modeFor,
  roman,
  tempoFor,
  type MoodLike,
  type SectionScore,
} from '../src/audio/theory';

let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    fail++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

const GROUPS: MoodLike['group'][] = ['green', 'water', 'dry', 'cold', 'rock', 'space'];

function inScale(midi: number, tonicMidi: number, scale: readonly number[]): boolean {
  const pc = ((midi - tonicMidi) % 12 + 12) % 12;
  return scale.includes(pc);
}

function legalMove(from: number, to: number, allowBvii: boolean): boolean {
  if (from === to || to === 0) return true;
  if (to === 3 || to === 4 || (allowBvii && to === 6)) return true;
  return grammarDestinations(from, allowBvii).includes(to);
}

function dump(score: SectionScore): void {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  console.log(
    `\n  ${names[score.key]} ${score.mode}  bpm=${score.bpm} swing=${score.swing.toFixed(2)}  section=${score.section}`,
  );
  for (let i = 0; i < 8; i++) {
    const b = score.bars[i];
    const lead = b.lead.map((h) => h.notes[0]).join(',');
    console.log(`  bar ${i}  ${roman(b.chordDeg, b.quality).padEnd(8)} voices=${b.voices.join(' ')}  lead=${lead || '—'}`);
  }
}

const seeds = ['brook-tide-1', 'ember-vale-42', 'nimbus-opal-7', 'zephyr-moss-99'];
const mood: MoodLike = { group: 'green', density: 0.4 };

for (const seed of seeds) {
  const dna = dnaFromSeed(seed);
  const a = composeSection(seed, 0, mood, dna);
  const b = composeSection(seed, 0, mood, dna);
  check(`${seed} deterministic`, JSON.stringify(a) === JSON.stringify(b));
}

{
  const dna = dnaFromSeed(seeds[0]);
  const again = dnaFromSeed(seeds[0]);
  check('dna deterministic', JSON.stringify(dna) === JSON.stringify(again));
  const other = dnaFromSeed(seeds[1]);
  check('dna differs by seed', dna.tonic !== other.tonic || dna.brightness !== other.brightness);
}

{
  const dna = dnaFromSeed(seeds[0]);
  const s0 = composeSection(seeds[0], 0, mood, dna);
  const s3 = composeSection(seeds[0], 3, mood, dna);
  const s8 = composeSection(seeds[0], 8, mood, dna);
  const prog = (s: SectionScore) => s.bars.map((b) => `${b.chordDeg}${b.quality}`).join('-');
  const lead0 = s0.bars.map((b) => b.lead.map((h) => h.notes[0]).join('.')).join('|');
  const lead8 = s8.bars.map((b) => b.lead.map((h) => h.notes[0]).join('.')).join('|');
  check('section 0 ≠ section 3 progression or key', prog(s0) !== prog(s3) || s0.key !== s3.key);
  check('section 0 ≠ section 8 (evolution)', prog(s0) !== prog(s8) || lead0 !== lead8 || s0.key !== s8.key);
  dump(s0);
  dump(s8);
}

{
  let outOfScale = 0;
  let pitched = 0;
  let voiceMove = 0;
  let voiceN = 0;
  let stepwise = 0;
  let leaps = 0;
  let restBars = 0;
  let kickOnOne = 0;
  let bars = 0;
  let illegalMoves = 0;
  let homeCadence = 0;
  let opensTonic = 0;
  let sections = 0;
  let stackedVoices = 0;
  let clusters = 0;
  const progSet = new Set<string>();

  for (const seed of seeds) {
    const dna = dnaFromSeed(seed);
    for (const group of GROUPS) {
      const m: MoodLike = { group, density: group === 'space' ? 0 : 0.55 };
      for (let section = 0; section < 6; section++) {
        const score = composeSection(seed, section, m, dna);
        const bpm = tempoFor(m, dna);
        if (bpm < 70 || bpm > 96) {
          check(`${seed} ${group} tempo in range`, false, `${bpm}`);
        }
        const allowBvii = score.mode === 'mixolydian' || score.mode === 'dorian';
        progSet.add(score.bars.map((b) => b.chordDeg).join(','));
        sections++;
        if (score.bars[0].chordDeg === 0 || score.bars[0].chordDeg === 5) opensTonic++;
        if (score.bars[15].chordDeg === 0) homeCadence++;
        for (let i = 0; i < score.bars.length; i++) {
          const bar = score.bars[i];
          bars++;
          if (bar.kicks.some((k) => k.at === 0)) kickOnOne++;
          if (new Set(bar.voices).size !== bar.voices.length) stackedVoices++;
          const ordered = [...bar.voices].sort((a, b) => a - b);
          if (ordered.length >= 3 && ordered[ordered.length - 1] - ordered[0] <= 4) clusters++;
          for (let v = 1; v < ordered.length; v++) {
            if (ordered[v] - ordered[v - 1] < 2) clusters++;
          }
          if (bar.lead.length === 0) restBars++;
          const pitchedHits = [...bar.keys, ...bar.bass, ...bar.lead, ...bar.sparkle, ...bar.pad.map((n) => ({ notes: [n] }))];
          for (const h of pitchedHits) {
            for (const n of h.notes) {
              pitched++;
              if (!inScale(n, score.tonicMidi, score.scale)) outOfScale++;
            }
          }
          if (i > 0) {
            const prev = score.bars[i - 1].voices;
            for (let v = 0; v < Math.min(prev.length, bar.voices.length); v++) {
              voiceMove += Math.abs(bar.voices[v] - prev[v]);
              voiceN++;
            }
            const from = score.bars[i - 1].chordDeg;
            const to = bar.chordDeg;
            if (!legalMove(from, to, allowBvii)) {
              illegalMoves++;
              if (illegalMoves <= 12) {
                console.error(`  illegal ${from}→${to} ${seed} ${group} s${section} b${i} mode=${score.mode}`);
              }
            }
          }
          for (let k = 1; k < bar.lead.length; k++) {
            const a = bar.lead[k - 1].notes[0];
            const b = bar.lead[k].notes[0];
            const iv = Math.abs(a - b);
            if (iv <= 4) stepwise++;
            else leaps++;
          }
        }
      }
    }
  }

  check('notes stay in the mode', outOfScale === 0, `${outOfScale}/${pitched} off-scale`);
  check('chord moves stay in the grammar', illegalMoves === 0, `${illegalMoves} illegal`);
  check('sections open on I or vi', opensTonic === sections, `${opensTonic}/${sections}`);
  check('sections cadence to I', homeCadence === sections, `${homeCadence}/${sections}`);
  const avgLead = voiceN ? voiceMove / voiceN : 99;
  check('voice leading is close (avg < 6 st)', avgLead < 6, `avg ${avgLead.toFixed(2)}`);
  check('voices do not stack', stackedVoices === 0, `${stackedVoices} bars`);
  check('voicings stay open (no clusters)', clusters === 0, `${clusters} tight intervals`);
  check('kick on beat 1 almost always', kickOnOne / bars > 0.95, `${kickOnOne}/${bars}`);
  check('lead sometimes rests', restBars / bars > 0.05 && restBars / bars < 0.5, `${restBars}/${bars}`);
  check('melody mostly stepwise', stepwise / (stepwise + leaps + 1) > 0.55, `${stepwise} steps / ${leaps} leaps`);
  check('many distinct progressions', progSet.size >= 20, `${progSet.size} unique`);
}

{
  const dna = dnaFromSeed('brook-tide-1');
  const keys = new Set<number>();
  for (let s = 0; s < 24; s++) keys.add(composeSection('brook-tide-1', s, mood, dna).key);
  check('circle-of-fifths walk visits >1 key', keys.size >= 2, `${keys.size} keys`);
}

{
  for (const g of GROUPS) {
    const mode = modeFor(g, 0.7);
    check(`${g} has a mode`, Boolean(mode));
  }
  check('green prefers bright modes', modeFor('green', 0.8) === 'lydian' || modeFor('green', 0.2) === 'ionian');
  check('space prefers lydian when bright', modeFor('space', 0.8) === 'lydian');
}

{
  const dna = dnaFromSeed('brook-tide-1');
  const far: MoodLike = { group: 'space', density: 0 };
  const near: MoodLike = { group: 'green', density: 1 };
  const a = composeSection('brook-tide-1', 0, far, dna);
  const b = composeSection('brook-tide-1', 0, near, dna);
  check('flight is slower than a living surface', a.bpm < b.bpm, `${a.bpm} vs ${b.bpm}`);
  check('constants are the knobs', MUSIC.BPM_BASE === 86);
}

if (fail) {
  console.error(`\n${fail} check(s) failed`);
  process.exit(1);
}
console.log('\nall music laws hold');
