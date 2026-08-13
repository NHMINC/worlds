/**
 * Invariant checks for the progressive-house laws.
 *
 *   npx tsx scripts/check-music.ts
 *
 * A loop holds. Energy moves. Notes stay in the mode. A seed is
 * deterministic. Later sections are not a copy of the first.
 */
import {
  MUSIC,
  arrangementFor,
  composeSection,
  dnaFromSeed,
  loopChords,
  modeFor,
  phaseFor,
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

function dump(score: SectionScore): void {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  console.log(
    `\n  ${names[score.key]} ${score.mode}  ${score.phase}  bpm=${score.bpm}  section=${score.section}`,
  );
  for (let i = 0; i < 16; i += 4) {
    const b = score.bars[i];
    console.log(`  bars ${i}-${i + 3}  ${roman(b.chordDeg, b.quality).padEnd(8)} voices=${b.voices.join(' ')}`);
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
  check('dna deterministic', JSON.stringify(dna) === JSON.stringify(dnaFromSeed(seeds[0])));
  const other = dnaFromSeed(seeds[1]);
  check('dna differs by seed', dna.tonic !== other.tonic || dna.brightness !== other.brightness);
}

{
  const dna = dnaFromSeed(seeds[0]);
  const s0 = composeSection(seeds[0], 0, mood, dna);
  const s1 = composeSection(seeds[0], 1, mood, dna);
  const s8 = composeSection(seeds[0], 8, mood, dna);
  const loop = (s: SectionScore) => s.bars.filter((_, i) => i % 4 === 0).map((b) => b.chordDeg).join('-');
  check('loop holds from section 0 to 1 (slow change)', loop(s0) === loop(s1));
  check('a full cycle later the piece has moved', loop(s0) !== loop(s8) || s0.key !== s8.key || s0.phase !== s8.phase);
  check('section 0 is intro, section 6 is drop', s0.phase === 'intro' && composeSection(seeds[0], 6, mood, dna).phase === 'drop');
  dump(s0);
  dump(s8);
}

{
  let outOfScale = 0;
  let pitched = 0;
  let floorBars = 0;
  let held = 0;
  let holdChecks = 0;
  let bars = 0;
  let highPad = 0;
  let subAboveMid = 0;
  const loops = new Set<string>();

  for (const seed of seeds) {
    const dna = dnaFromSeed(seed);
    for (const group of GROUPS) {
      const m: MoodLike = { group, density: group === 'space' ? 0 : 0.55 };
      for (let section = 0; section < 8; section++) {
        const score = composeSection(seed, section, m, dna);
        const bpm = tempoFor(m, dna);
        if (bpm < 118 || bpm > 123) check(`${seed} ${group} tempo in house range`, false, `${bpm}`);
        loops.add(score.bars.filter((_, i) => i % 4 === 0).map((b) => b.chordDeg).join(','));
        for (let i = 0; i < score.bars.length; i++) {
          const bar = score.bars[i];
          bars++;
          const kickAts = bar.kicks.map((k) => k.at).sort((a, b) => a - b).join(',');
          if (kickAts === '0,4,8,12') floorBars++;
          if (i % 4 !== 0) {
            holdChecks++;
            if (bar.chordDeg === score.bars[i - 1].chordDeg) held++;
          }
          const pitchedHits = [...bar.bass, ...bar.sub, ...bar.arp, ...bar.pad.map((n) => ({ notes: [n] }))];
          for (const h of pitchedHits) {
            for (const n of h.notes) {
              pitched++;
              if (!inScale(n, score.tonicMidi, score.scale)) outOfScale++;
            }
          }
          if (bar.pad.some((n) => n > 76)) highPad++;
          const subN = bar.sub[0]?.notes[0] ?? 0;
          const midN = bar.bass[0]?.notes[0] ?? 0;
          if (subN >= midN) subAboveMid++;
        }
      }
    }
  }

  check('notes stay in the mode', outOfScale === 0, `${outOfScale}/${pitched} off-scale`);
  check('pad stays in the chest', highPad === 0, `${highPad} bars with a high pad`);
  check('sub sits under the mid bass', subAboveMid === 0, `${subAboveMid} bars inverted`);
  check('four-on-the-floor in every bar', floorBars === bars, `${floorBars}/${bars}`);
  check('chords hold for four bars', held === holdChecks, `${held}/${holdChecks}`);
  check('several distinct loops across seeds', loops.size >= 4, `${loops.size} unique`);
}

{
  const dna = dnaFromSeed('brook-tide-1');
  const intro = arrangementFor(mood, dna, 0, 0);
  const drop = arrangementFor(mood, dna, 6, 0);
  const brk = arrangementFor(mood, dna, 4, 8);
  const build0 = arrangementFor(mood, dna, 5, 0);
  const buildEnd = arrangementFor(mood, dna, 5, 15);
  const peak = arrangementFor(mood, dna, 3, 15);
  check('drop is louder than intro', drop.kick > intro.kick && drop.bass > intro.bass);
  check('drop brings 16th ticks, intro does not', drop.hatTick > 0.4 && intro.hatTick < 0.05);
  check('breakdown pulls the kick', brk.kick < 0.1);
  check('build holds, then opens the filter', build0.filter < 0.35 && buildEnd.filter > intro.filter + 0.4);
  check('build withholds the bass for the drop', buildEnd.bass < 0.15 && drop.bass > 0.8);
  check('build kick grows from silence', build0.kick < 0.1 && buildEnd.kick > 0.5);
  check('peak is not the release', peak.filter < drop.filter && peak.kick < drop.kick);
}

{
  const dna = dnaFromSeed('brook-tide-1');
  const keys = new Set<number>();
  for (let s = 0; s < 24; s++) keys.add(composeSection('brook-tide-1', s, mood, dna).key);
  check('key stays put inside a cycle, walks later', keys.size >= 2, `${keys.size} keys`);
  check('section 0 and 7 share a key', composeSection('brook-tide-1', 0, mood, dna).key === composeSection('brook-tide-1', 7, mood, dna).key);
}

{
  for (const g of GROUPS) check(`${g} has a mode`, Boolean(modeFor(g, 0.7)));
  check('phases cycle', phaseFor(0) === 'intro' && phaseFor(4) === 'break' && phaseFor(8) === 'intro');
  check('constants are the knobs', MUSIC.BPM_BASE === 121);
  const dna = dnaFromSeed('brook-tide-1');
  check('loop is four chords', loopChords('brook-tide-1', 0, modeFor('green', dna.brightness)).length === 4);
}

if (fail) {
  console.error(`\n${fail} check(s) failed`);
  process.exit(1);
}
console.log('\nall house laws hold');
