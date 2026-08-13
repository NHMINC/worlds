import * as Tone from 'tone';
import type { Mood } from '../render/engine';
import { HouseKit, duck } from './kit';
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
 * The orchestra. theory.ts writes the score. dsp.ts / kit.ts are the
 * drums. This file is routing, bass, pad, and the kick-triggered duck.
 */

const LAYER = {
  pad: 0.34,
  arp: 0.4,
  bass: 0.62,
  sub: 0.7,
  kick: 0.92,
  hatClosed: 0.38,
  hatOpen: 0.42,
  hatTick: 0.22,
  clap: 0.48,
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
  private padBody?: Tone.PolySynth;
  private arp?: Tone.Synth;
  private bass?: Tone.MonoSynth;
  private sub?: Tone.MonoSynth;
  private filter?: Tone.Filter;
  private padGain?: Tone.Gain;
  private bassGain?: Tone.Gain;
  private arpGain?: Tone.Gain;
  private kit?: HouseKit;

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
    if (this.started) this.kit?.retune(this.dna);
  }

  async start(): Promise<void> {
    if (this.started) {
      this.applyVolume();
      return;
    }
    await Tone.start();
    this.started = true;

    const limiter = new Tone.Limiter(-1.8).toDestination();
    const glue = new Tone.Compressor({
      threshold: -18,
      ratio: 2.4,
      attack: 0.014,
      release: 0.14,
      knee: 8,
    }).connect(limiter);
    this.master = new Tone.Volume(this.volumeDb()).connect(glue);

    const reverb = new Tone.Reverb({ decay: 2.2, preDelay: 0.01, wet: 1 });
    await reverb.ready;
    const verbSend = new Tone.Gain(0.16).connect(reverb);
    reverb.connect(this.master);

    this.padGain = new Tone.Gain(1);
    this.bassGain = new Tone.Gain(1);
    this.arpGain = new Tone.Gain(1);

    this.filter = new Tone.Filter({ type: 'lowpass', frequency: 900, Q: 0.95, rolloff: -24 });
    const chorus = new Tone.Chorus({ frequency: 0.28, delayTime: 5, depth: 0.5, wet: 0.4 }).start();
    const padHp = new Tone.Filter({ type: 'highpass', frequency: 110, Q: 0.4 });
    this.padGain.connect(padHp);
    padHp.connect(chorus);
    chorus.connect(this.filter);
    this.filter.connect(this.master);
    this.filter.connect(verbSend);

    const delay = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.26, wet: 0.2 });
    this.arpGain.connect(delay);
    delay.connect(this.master);
    delay.connect(verbSend);

    this.bassGain.connect(this.master);

    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth', spread: 32, count: 3 },
      envelope: { attack: 0.45, decay: 0.4, sustain: 0.7, release: 1.8 },
    });
    this.pad.maxPolyphony = 6;
    this.pad.volume.value = -7;
    this.pad.connect(this.padGain);

    this.padBody = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.52, decay: 0.5, sustain: 0.82, release: 2.1 },
    });
    this.padBody.maxPolyphony = 4;
    this.padBody.volume.value = -16;
    this.padBody.connect(this.padGain);

    this.arp = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.004, decay: 0.14, sustain: 0.06, release: 0.18 },
    });
    this.arp.volume.value = -9;
    this.arp.connect(this.arpGain);

    this.sub = new Tone.MonoSynth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.006, decay: 0.2, sustain: 0.18, release: 0.08 },
      filter: { type: 'lowpass', frequency: 140, Q: 0.4, rolloff: -12 },
    });
    this.sub.volume.value = -4;
    this.sub.connect(this.bassGain);

    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.008, decay: 0.13, sustain: 0.08, release: 0.07 },
      filter: { type: 'lowpass', Q: 1.7, rolloff: -24 },
      filterEnvelope: {
        attack: 0.008,
        decay: 0.09,
        sustain: 0.06,
        release: 0.07,
        baseFrequency: 64,
        octaves: 2.8,
      },
    });
    this.bass.volume.value = -7;
    const growl = new Tone.WaveShaper((x) => Math.tanh(x * 1.65), 2048);
    this.bass.connect(growl);
    growl.connect(this.bassGain);

    const kickDest = this.master;
    const hatDest = new Tone.Gain(1);
    hatDest.connect(this.master);
    const hatVerb = new Tone.Gain(0.07).connect(reverb);
    hatDest.connect(hatVerb);
    const clapDest = new Tone.Gain(1);
    clapDest.connect(this.master);
    clapDest.connect(verbSend);
    this.kit = new HouseKit(this.dna, kickDest, hatDest, clapDest);

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
    this.firePitched(this.sub, barScore.bass, beat, time, LAYER.sub * arr.bass, 0.12);
    this.firePitched(this.arp, barScore.arp, beat, time, LAYER.arp * arr.arp, 0.14);

    if (arr.kick > 0.15) {
      for (const k of barScore.kicks) {
        if (k.at !== beat) continue;
        this.kit?.hitKick(time, k.vel * LAYER.kick * arr.kick);
        if (this.padGain) duck(this.padGain, time, 0.62, 0.28);
        if (this.bassGain) duck(this.bassGain, time, 0.86, 0.12);
        if (this.arpGain) duck(this.arpGain, time, 0.28, 0.1);
      }
    }
    if (arr.hatClosed > 0.1) {
      for (const h of barScore.hatsClosed) {
        if (h.at !== beat) continue;
        this.kit?.hitHatClosed(time, h.vel * LAYER.hatClosed * arr.hatClosed);
      }
    }
    if (arr.hatOpen > 0.1) {
      for (const h of barScore.hatsOpen) {
        if (h.at !== beat) continue;
        this.kit?.hitHatOpen(time, h.vel * LAYER.hatOpen * arr.hatOpen);
      }
    }
    if (arr.hatTick > 0.1) {
      for (const h of barScore.hatsTick) {
        if (h.at !== beat) continue;
        this.kit?.hitHatTick(time, h.vel * LAYER.hatTick * arr.hatTick);
      }
    }
    if (arr.clap > 0.1) {
      for (const c of barScore.claps) {
        if (c.at !== beat) continue;
        this.kit?.hitClap(time, c.vel * LAYER.clap * arr.clap);
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
    const hz = 380 + open * 3200 + mood.density * 180;
    this.filter?.frequency.rampTo(hz, 6);
  }

  private holdPad(notes: number[], arr: Arrangement, time: number): void {
    if (!this.pad || arr.pad < 0.15) return;
    const same = notes.length === this.lastPad.length && notes.every((n, i) => n === this.lastPad[i]);
    if (same) return;
    this.pad.releaseAll(time);
    this.padBody?.releaseAll(time);
    const hz = notes.map((n) => this.hz(n));
    this.pad.triggerAttack(hz, time, LAYER.pad * arr.pad);
    const body = [...notes].sort((a, b) => a - b).slice(0, 2).map((n) => this.hz(n));
    this.padBody?.triggerAttack(body, time, LAYER.pad * arr.pad * 0.7);
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
      const dur = Math.max(step * 0.8, h.dur * step);
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
    return -16 + this.volume * 13;
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
      this.padBody?.releaseAll();
      this.arp?.triggerRelease();
      this.bass?.triggerRelease();
      this.sub?.triggerRelease();
      this.lastPad = [];
    }
    this.applyVolume();
  }

  get isStarted(): boolean {
    return this.started;
  }
}
