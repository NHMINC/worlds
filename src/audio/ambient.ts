import * as Tone from 'tone';
import { mulberry32, xmur3 } from '../world/rng';
import type { Mood } from '../render/engine';

/**
 * Fully generative ambient soundscape — no samples, everything synthesized.
 * Slow pads drift through a pentatonic-ish scale seeded per world; the biome
 * mix on screen picks the scale flavor and the zoom level sets note density.
 */

const SCALES: Record<Mood['group'], number[]> = {
  water: [0, 3, 5, 7, 10], // minor pentatonic — deep, airy
  green: [0, 2, 4, 7, 9], // major pentatonic — warm, open
  dry: [0, 1, 5, 7, 8], // hirajoshi-ish — sparse, sun-baked
  cold: [0, 2, 3, 7, 9], // dorian-ish pentatonic — still, crystalline
  rock: [0, 2, 5, 7, 10], // suspended — wide, hollow
  space: [0, 7, 12, 14, 19], // open fifths and ninths — vast, weightless
};

const FILTER_HZ: Record<Mood['group'], number> = {
  water: 700,
  green: 1000,
  dry: 850,
  cold: 1200,
  rock: 600,
  space: 450,
};

export class AmbientMusic {
  private started = false;
  private muted = false;
  private volume = 0.7;
  private root = 48; // MIDI C3, offset by seed
  private rng: () => number = Math.random;
  private getMood: () => Mood;

  private master?: Tone.Volume;
  private pad?: Tone.PolySynth;
  private melody?: Tone.PolySynth;
  private filter?: Tone.Filter;
  private tick = 0;

  constructor(getMood: () => Mood) {
    this.getMood = getMood;
  }

  setSeed(seed: string): void {
    const h = xmur3(`music:${seed}`);
    this.rng = mulberry32(h());
    this.root = 45 + Math.floor(this.rng() * 7); // A2..D#3
  }

  async start(): Promise<void> {
    if (this.started) {
      this.applyVolume();
      return;
    }
    await Tone.start();
    this.started = true;

    this.master = new Tone.Volume(this.volumeDb()).toDestination();
    const reverb = new Tone.Reverb({ decay: 9, wet: 0.55 }).connect(this.master);
    this.filter = new Tone.Filter(900, 'lowpass').connect(reverb);

    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 4, decay: 2, sustain: 0.7, release: 9 },
      volume: -18,
    }).connect(this.filter);

    this.melody = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.04, decay: 0.6, sustain: 0.1, release: 3 },
      volume: -24,
    }).connect(reverb);

    Tone.getTransport().bpm.value = 54;
    Tone.getTransport().scheduleRepeat((time) => this.step(time), '2n');
    Tone.getTransport().start();
  }

  private step(time: number): void {
    if (this.muted) return;
    const mood = this.getMood();
    const scale = SCALES[mood.group];
    this.filter?.frequency.rampTo(FILTER_HZ[mood.group], 4);
    this.tick++;

    // A slow chord bed every ~9 seconds.
    if (this.tick % 4 === 1 && this.pad) {
      const degree = scale[Math.floor(this.rng() * scale.length)];
      const rootNote = this.root + degree;
      const chord = [rootNote, rootNote + 7, rootNote + 12 + scale[Math.floor(this.rng() * scale.length)]];
      this.pad.triggerAttackRelease(
        chord.map((n) => Tone.Frequency(n, 'midi').toFrequency()),
        8,
        time,
        0.6 + this.rng() * 0.2,
      );
    }

    // Sparse detail notes — denser when zoomed in close.
    const p = 0.12 + mood.density * 0.5;
    if (this.rng() < p && this.melody) {
      const n = this.root + 24 + scale[Math.floor(this.rng() * scale.length)] + (this.rng() < 0.3 ? 12 : 0);
      this.melody.triggerAttackRelease(
        Tone.Frequency(n, 'midi').toFrequency(),
        1.5 + this.rng() * 2,
        time + this.rng() * 0.8,
        0.25 + this.rng() * 0.3,
      );
    }
  }

  private volumeDb(): number {
    if (this.muted || this.volume <= 0) return -Infinity;
    return -28 + this.volume * 24; // -28dB .. -4dB
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
    this.applyVolume();
  }

  get isStarted(): boolean {
    return this.started;
  }
}
