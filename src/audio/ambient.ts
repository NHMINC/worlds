import * as Tone from 'tone';
import type { Mood } from '../render/engine';
import {
  arrangementFor,
  composeSection,
  dnaFromSeed,
  type Arrangement,
  type Dna,
  type PitchHit,
  type SectionScore,
} from './theory';

/**
 * The orchestra. theory.ts writes the score; this file only performs it.
 * All voices are synthesized — no samples. A 16th-note clock reads the
 * current bar and triggers hits. Live mood (zoom, biome, flight) rides
 * arrangement and tempo; harmony latches at section boundaries so a
 * glance across the sea does not smash the cadence.
 */

const LAYER = {
  pad: 0.42,
  keys: 0.52,
  bass: 0.7,
  lead: 0.48,
  sparkle: 0.38,
  kick: 0.5,
  shaker: 0.2,
};

export class AmbientMusic {
  private started = false;
  private muted = false;
  private volume = 0.7;
  private seed = 'brook';
  private dna: Dna = dnaFromSeed('brook');
  private getMood: () => Mood;

  private master?: Tone.Volume;
  private pad?: Tone.PolySynth<Tone.AMSynth>;
  private keys?: Tone.PolySynth<Tone.FMSynth>;
  private bass?: Tone.MonoSynth;
  private lead?: Tone.AMSynth;
  private sparkle?: Tone.FMSynth;
  private kick?: Tone.MembraneSynth;
  private shaker?: Tone.NoiseSynth;
  private filter?: Tone.Filter;

  private sixteenth = 0;
  private score: SectionScore | null = null;
  private latchedGroup: Mood['group'] | null = null;
  private latchedSection = -1;
  private lastPad: number[] = [];
  private lastBpm = 0;
  private liveMood: Mood | null = null;

  constructor(getMood: () => Mood) {
    this.getMood = getMood;
  }

  setSeed(seed: string): void {
    this.seed = seed;
    this.dna = dnaFromSeed(seed);
    this.sixteenth = 0;
    this.score = null;
    this.latchedGroup = null;
    this.latchedSection = -1;
    this.lastPad = [];
    this.liveMood = null;
  }

  async start(): Promise<void> {
    if (this.started) {
      this.applyVolume();
      return;
    }
    await Tone.start();
    this.started = true;

    const limiter = new Tone.Limiter(-4).toDestination();
    this.master = new Tone.Volume(this.volumeDb()).connect(limiter);

    const reverb = new Tone.Reverb({ decay: 3.6, preDelay: 0.018, wet: 0.28 });
    await reverb.ready;
    reverb.connect(this.master);

    const chorus = new Tone.Chorus({ frequency: 1.4, delayTime: 3.2, depth: 0.28, wet: 0.22 }).start();
    this.filter = new Tone.Filter({ type: 'lowpass', frequency: 2400, Q: 0.6 });
    chorus.connect(this.filter);
    this.filter.connect(reverb);

    const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.22, wet: 0.16 });
    delay.connect(reverb);

    const keysPan = new Tone.Panner(-0.16).connect(chorus);
    const sparkPan = new Tone.Panner(0.28).connect(delay);
    const leadPan = new Tone.Panner(0.04).connect(delay);

    this.pad = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 1.4,
      oscillator: { type: 'sine' },
      envelope: { attack: 2.2, decay: 1.1, sustain: 0.78, release: 3.2 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 1.8, decay: 0.6, sustain: 0.35, release: 2.6 },
    });
    this.pad.maxPolyphony = 8;
    this.pad.volume.value = -10;
    this.pad.connect(chorus);

    this.keys = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 1.4,
      modulationIndex: 7.5,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.018, decay: 0.45, sustain: 0.16, release: 1.15 },
      modulation: { type: 'triangle' },
      modulationEnvelope: { attack: 0.01, decay: 0.22, sustain: 0.04, release: 0.7 },
    });
    this.keys.maxPolyphony = 8;
    this.keys.volume.value = -8;
    this.keys.connect(keysPan);

    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.016, decay: 0.22, sustain: 0.42, release: 0.28 },
      filter: { type: 'lowpass', Q: 1.1, rolloff: -12 },
      filterEnvelope: {
        attack: 0.01,
        decay: 0.18,
        sustain: 0.22,
        release: 0.24,
        baseFrequency: 90,
        octaves: 2.2,
      },
    });
    this.bass.volume.value = -6;
    this.bass.connect(this.master);

    this.lead = new Tone.AMSynth({
      harmonicity: 2.1,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.028, decay: 0.18, sustain: 0.28, release: 0.55 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.02, decay: 0.12, sustain: 0.2, release: 0.4 },
    });
    this.lead.volume.value = -9;
    this.lead.connect(leadPan);

    this.sparkle = new Tone.FMSynth({
      harmonicity: 4.1,
      modulationIndex: 12,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.55, sustain: 0, release: 0.8 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.18 },
    });
    this.sparkle.volume.value = -11;
    this.sparkle.connect(sparkPan);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.028,
      octaves: 2.6,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.26, sustain: 0, release: 0.1 },
    });
    this.kick.volume.value = -9;
    this.kick.connect(this.master);

    const shakerFilter = new Tone.Filter({ type: 'bandpass', frequency: 6200, Q: 1.15 });
    shakerFilter.connect(this.master);
    this.shaker = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.055, sustain: 0, release: 0.02 },
    });
    this.shaker.volume.value = -18;
    this.shaker.connect(shakerFilter);

    const transport = Tone.getTransport();
    transport.bpm.value = 86;
    transport.swingSubdivision = '8n';
    transport.swing = 0.1;
    transport.scheduleRepeat((time) => this.on16th(time), '16n');
    transport.start();
  }

  private on16th(time: number): void {
    if (this.muted) return;
    const beat = this.sixteenth % 16;
    const bar = Math.floor(this.sixteenth / 16);
    const section = Math.floor(bar / 16);
    if (beat === 0 || !this.liveMood) this.liveMood = this.getMood();
    const mood = this.liveMood;

    if (beat === 0) {
      if (section !== this.latchedSection || this.latchedGroup === null) {
        this.latchedSection = section;
        this.latchedGroup = mood.group;
        this.score = composeSection(this.seed, section, mood, this.dna);
      }
      this.followClimate(mood);
    }

    const score = this.score;
    if (!score) {
      this.sixteenth++;
      return;
    }
    const barScore = score.bars[bar % 16];
    const arr = arrangementFor(mood, this.dna, bar % 16);

    if (beat === 0) this.holdPad(barScore.pad, arr, time);

    this.firePitched(this.keys, barScore.keys, beat, time, LAYER.keys * arr.keys, 0.12);
    this.firePitched(this.bass, barScore.bass, beat, time, LAYER.bass * arr.bass, 0.1);
    this.firePitched(this.lead, barScore.lead, beat, time, LAYER.lead * arr.lead, 0.14);
    this.firePitched(this.sparkle, barScore.sparkle, beat, time, LAYER.sparkle * arr.sparkle, 0.12);

    if (arr.pulse > 0.14) {
      for (const k of barScore.kicks) {
        if (k.at !== beat) continue;
        const note = barScore.bass[0]?.notes[0] ?? 36;
        this.kick?.triggerAttackRelease(this.hz(note), '8n', time, k.vel * LAYER.kick * arr.pulse);
      }
      if (arr.pulse > 0.22) {
        for (const s of barScore.shakers) {
          if (s.at !== beat) continue;
          this.shaker?.triggerAttackRelease('16n', time, s.vel * LAYER.shaker * arr.pulse);
        }
      }
    }

    this.sixteenth++;
  }

  private followClimate(mood: Mood): void {
    const bpm = this.score?.bpm ?? 86;
    if (Math.abs(bpm - this.lastBpm) > 0.2) {
      Tone.getTransport().bpm.rampTo(bpm, 1.6);
      this.lastBpm = bpm;
    }
    Tone.getTransport().swing = this.score?.swing ?? 0.08;
    const cutoff: Record<Mood['group'], number> = {
      space: 1600,
      cold: 2800,
      water: 2300,
      green: 2600,
      dry: 2200,
      rock: 1900,
    };
    this.filter?.frequency.rampTo(cutoff[mood.group] + mood.density * 400, 3);
  }

  private holdPad(notes: number[], arr: Arrangement, time: number): void {
    if (!this.pad || arr.pad < 0.2) return;
    const same = notes.length === this.lastPad.length && notes.every((n, i) => n === this.lastPad[i]);
    if (same) return;
    this.pad.releaseAll(time);
    this.pad.triggerAttack(notes.map((n) => this.hz(n)), time, LAYER.pad * arr.pad);
    this.lastPad = notes;
  }

  private firePitched(
    inst: Tone.Synth | Tone.MonoSynth | Tone.AMSynth | Tone.FMSynth | Tone.PolySynth | undefined,
    hits: PitchHit[],
    beat: number,
    time: number,
    gain: number,
    gate: number,
  ): void {
    if (!inst || gain < gate) return;
    const step = Tone.Time('16n').toSeconds();
    for (const h of hits) {
      if (h.at !== beat) continue;
      const dur = Math.max(step * 0.9, h.dur * step);
      const vel = h.vel * gain;
      if (inst instanceof Tone.PolySynth) {
        inst.triggerAttackRelease(h.notes.map((n) => this.hz(n)), dur, time, vel);
      } else {
        inst.triggerAttackRelease(this.hz(h.notes[0]), dur, time, vel);
      }
    }
  }

  private hz(midi: number): number {
    return Tone.Frequency(midi, 'midi').toFrequency();
  }

  private volumeDb(): number {
    if (this.muted || this.volume <= 0) return -Infinity;
    return -22 + this.volume * 16;
  }

  private applyVolume(): void {
    this.master?.volume.rampTo(this.volumeDb(), 0.3);
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyVolume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m) {
      this.pad?.releaseAll();
      this.keys?.releaseAll();
      this.bass?.triggerRelease();
      this.lead?.triggerRelease();
      this.sparkle?.triggerRelease();
      this.lastPad = [];
    }
    this.applyVolume();
  }

  get isStarted(): boolean {
    return this.started;
  }
}
