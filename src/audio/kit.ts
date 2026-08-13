import * as Tone from 'tone';
import { kitFromDna, renderClap, renderHatClosed, renderHatOpen, renderKick } from './dsp';
import type { Dna } from './theory';

function toBuffer(channel: Float32Array): AudioBuffer {
  const sr = Tone.getContext().sampleRate;
  const buf = Tone.getContext().createBuffer(1, channel.length, sr);
  buf.getChannelData(0).set(channel);
  return buf;
}

function fire(buffer: AudioBuffer, dest: Tone.ToneAudioNode, time: number, vel: number): Tone.ToneBufferSource {
  const g = new Tone.Gain(Math.max(0.001, vel)).connect(dest);
  const src = new Tone.ToneBufferSource({ url: buffer, fadeOut: 0.008 });
  src.connect(g);
  src.start(time);
  src.onended = () => {
    src.dispose();
    g.dispose();
  };
  return src;
}

/**
 * One-shots baked from the kit laws. Each hit is a fresh buffer source
 * so four-on-the-floor never fights Player state. Closed hat chokes open
 * hat — the 909 law.
 */
export class HouseKit {
  private kickBuf: AudioBuffer;
  private closedBuf: AudioBuffer;
  private openBuf: AudioBuffer;
  private clapBuf: AudioBuffer;
  private readonly kickDest: Tone.ToneAudioNode;
  private readonly hatDest: Tone.ToneAudioNode;
  private readonly clapDest: Tone.ToneAudioNode;
  private openVoice?: Tone.ToneBufferSource;

  constructor(dna: Dna, kickDest: Tone.ToneAudioNode, hatDest: Tone.ToneAudioNode, clapDest: Tone.ToneAudioNode) {
    this.kickDest = kickDest;
    this.hatDest = hatDest;
    this.clapDest = clapDest;
    const baked = bake(dna);
    this.kickBuf = baked.kick;
    this.closedBuf = baked.closed;
    this.openBuf = baked.open;
    this.clapBuf = baked.clap;
  }

  retune(dna: Dna): void {
    const baked = bake(dna);
    this.kickBuf = baked.kick;
    this.closedBuf = baked.closed;
    this.openBuf = baked.open;
    this.clapBuf = baked.clap;
  }

  hitKick(time: number, vel: number): void {
    fire(this.kickBuf, this.kickDest, time, vel);
  }

  hitHatClosed(time: number, vel: number): void {
    this.openVoice?.stop(time);
    this.openVoice = undefined;
    fire(this.closedBuf, this.hatDest, time, vel);
  }

  hitHatOpen(time: number, vel: number): void {
    this.openVoice?.stop(time);
    this.openVoice = fire(this.openBuf, this.hatDest, time, vel);
  }

  hitClap(time: number, vel: number): void {
    fire(this.clapBuf, this.clapDest, time, vel);
  }
}

function bake(dna: Dna): { kick: AudioBuffer; closed: AudioBuffer; open: AudioBuffer; clap: AudioBuffer } {
  const spec = kitFromDna(dna.brightness, dna.warmth, dna.bounce);
  const sr = Tone.getContext().sampleRate;
  return {
    kick: toBuffer(renderKick(sr, spec.kick)),
    closed: toBuffer(renderHatClosed(sr, spec.hat)),
    open: toBuffer(renderHatOpen(sr, spec.hat)),
    clap: toBuffer(renderClap(sr, spec.clap)),
  };
}

/** Exponential duck on a gain, trough on the hit. House pump, not an LFO. */
export function duck(gain: Tone.Gain, time: number, depth: number, release: number): void {
  const g = gain.gain;
  const floor = Math.max(0.04, 1 - depth);
  g.cancelAndHoldAtTime(time);
  g.setValueAtTime(1, time);
  g.exponentialRampToValueAtTime(floor, time + 0.012);
  g.exponentialRampToValueAtTime(1, time + Math.max(0.06, release));
}
