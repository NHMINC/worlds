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
 * Progressive house: four-on-the-floor, offbeat hats, rolling bass,
 * a pad that pumps against the kick, a filter that opens with the phase.
 */

const LAYER = {
  pad: 0.38,
  arp: 0.42,
  bass: 0.72,
  kick: 0.78,
  hatClosed: 0.22,
  hatOpen: 0.28,
  clap: 0.36,
};

export class AmbientMusic {
  private started = false;
  private muted = false;
  private volume = 0.7;
  private seed = 'brook';
  private dna: Dna = dnaFromSeed('brook');
  private getMood: () => Mood;

  private master?: Tone.Volume;
  private pad?: Tone.PolySynth;
  private arp?: Tone.Synth;
  private bass?: Tone.MonoSynth;
  private kick?: Tone.MembraneSynth;
  private hatClosed?: Tone.NoiseSynth;
  private hatOpen?: Tone.NoiseSynth;
  private clap?: Tone.NoiseSynth;
  private filter?: Tone.Filter;
  private pump?: Tone.LFO;

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

    const limiter = new Tone.Limiter(-3).toDestination();
    this.master = new Tone.Volume(this.volumeDb()).connect(limiter);

    const reverb = new Tone.Reverb({ decay: 2.8, preDelay: 0.012, wet: 0.22 });
    await reverb.ready;
    reverb.connect(this.master);

    const padGain = new Tone.Gain(1);
    const bassGain = new Tone.Gain(1);
    this.pump = new Tone.LFO({ frequency: '4n', type: 'sine', min: 0.28, max: 1, phase: 270 });
    this.pump.connect(padGain.gain);
    this.pump.connect(bassGain.gain);
    this.pump.start();

    this.filter = new Tone.Filter({ type: 'lowpass', frequency: 900, Q: 0.7 });
    const chorus = new Tone.Chorus({ frequency: 0.35, delayTime: 4.5, depth: 0.45, wet: 0.35 }).start();
    padGain.connect(chorus);
    chorus.connect(this.filter);
    this.filter.connect(reverb);

    const delay = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.28, wet: 0.18 });
    delay.connect(reverb);

    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', spread: 28, count: 3 },
      envelope: { attack: 0.55, decay: 0.35, sustain: 0.72, release: 1.6 },
    });
    this.pad.maxPolyphony = 6;
    this.pad.volume.value = -8;
    this.pad.connect(padGain);

    this.arp = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.006, decay: 0.16, sustain: 0.08, release: 0.22 },
    });
    this.arp.volume.value = -10;
    this.arp.connect(delay);

    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.18, sustain: 0.15, release: 0.12 },
      filter: { type: 'lowpass', Q: 1.4, rolloff: -24 },
      filterEnvelope: {
        attack: 0.01,
        decay: 0.12,
        sustain: 0.15,
        release: 0.1,
        baseFrequency: 80,
        octaves: 2.4,
      },
    });
    this.bass.volume.value = -5;
    this.bass.connect(bassGain);
    bassGain.connect(this.master);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.018,
      octaves: 5,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.08 },
    });
    this.kick.volume.value = -6;
    this.kick.connect(this.master);

    const hatHp = new Tone.Filter({ type: 'highpass', frequency: 7000, Q: 0.6 });
    hatHp.connect(this.master);
    this.hatClosed = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 },
    });
    this.hatClosed.volume.value = -16;
    this.hatClosed.connect(hatHp);

    this.hatOpen = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.06 },
    });
    this.hatOpen.volume.value = -18;
    this.hatOpen.connect(hatHp);

    const clapBp = new Tone.Filter({ type: 'bandpass', frequency: 1800, Q: 0.9 });
    clapBp.connect(reverb);
    this.clap = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.05 },
    });
    this.clap.volume.value = -12;
    this.clap.connect(clapBp);

    const transport = Tone.getTransport();
    transport.bpm.value = 124;
    transport.swing = 0;
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
    const arr = arrangementFor(mood, this.dna, section);

    if (beat === 0) this.holdPad(barScore.pad, arr, time);

    this.firePitched(this.bass, barScore.bass, beat, time, LAYER.bass * arr.bass, 0.12);
    this.firePitched(this.arp, barScore.arp, beat, time, LAYER.arp * arr.arp, 0.14);

    if (arr.kick > 0.15) {
      for (const k of barScore.kicks) {
        if (k.at !== beat) continue;
        this.kick?.triggerAttackRelease(this.hz(36), '8n', time, k.vel * LAYER.kick * arr.kick);
      }
    }
    if (arr.hatClosed > 0.12) {
      for (const h of barScore.hatsClosed) {
        if (h.at !== beat) continue;
        this.hatClosed?.triggerAttackRelease('32n', time, h.vel * LAYER.hatClosed * arr.hatClosed);
      }
    }
    if (arr.hatOpen > 0.12) {
      for (const h of barScore.hatsOpen) {
        if (h.at !== beat) continue;
        this.hatOpen?.triggerAttackRelease('8n', time, h.vel * LAYER.hatOpen * arr.hatOpen);
      }
    }
    if (arr.clap > 0.12) {
      for (const c of barScore.claps) {
        if (c.at !== beat) continue;
        this.clap?.triggerAttackRelease('8n', time, c.vel * LAYER.clap * arr.clap);
      }
    }

    this.sixteenth++;
  }

  private followClimate(mood: Mood): void {
    const bpm = this.score?.bpm ?? 124;
    if (Math.abs(bpm - this.lastBpm) > 0.2) {
      Tone.getTransport().bpm.rampTo(bpm, 2.4);
      this.lastBpm = bpm;
    }
    const open = this.score?.filter ?? 0.4;
    const hz = 420 + open * 2800 + mood.density * 200;
    this.filter?.frequency.rampTo(hz, 6);
  }

  private holdPad(notes: number[], arr: Arrangement, time: number): void {
    if (!this.pad || arr.pad < 0.15) return;
    const same = notes.length === this.lastPad.length && notes.every((n, i) => n === this.lastPad[i]);
    if (same) return;
    this.pad.releaseAll(time);
    this.pad.triggerAttack(notes.map((n) => this.hz(n)), time, LAYER.pad * arr.pad);
    this.lastPad = notes;
  }

  private firePitched(
    inst: Tone.Synth | Tone.MonoSynth | Tone.PolySynth | undefined,
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
      const dur = Math.max(step * 0.85, h.dur * step);
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
    return -18 + this.volume * 14;
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
      this.arp?.triggerRelease();
      this.bass?.triggerRelease();
      this.lastPad = [];
    }
    this.applyVolume();
  }

  get isStarted(): boolean {
    return this.started;
  }
}
