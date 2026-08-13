/**
 * Offline DSP for the house kit. We render one-shots from laws, then
 * play the buffers. Tone.js is the clock; this file is the instrument.
 */

export const KIT = {
  KICK_LEN: 0.28,
  KICK_PITCH0: 172,
  KICK_PITCH1: 51,
  KICK_PITCH_TAU: 0.036,
  KICK_BODY_TAU: 0.085,
  KICK_SUB_TAU: 0.15,
  KICK_PUNCH_TAU: 0.022,
  HAT_CLOSED_LEN: 0.09,
  HAT_OPEN_LEN: 0.34,
  /** 808-style metallic cluster (six squares). */
  HAT_FREQS: [205.3, 304.4, 369.6, 522.3, 540.0, 800.1],
  CLAP_LEN: 0.24,
  CLAP_BP: 1050,
  CLAP_Q: 0.85,
};

export function expDecay(t: number, tau: number): number {
  return Math.exp(-t / Math.max(1e-5, tau));
}

export function sine(phase: number): number {
  return Math.sin(phase);
}

export function square(phase: number): number {
  return Math.sin(phase) >= 0 ? 1 : -1;
}

export function tanhSoft(x: number, drive: number): number {
  return Math.tanh(x * drive);
}

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function peakNormalize(data: Float32Array, peak = 0.92): void {
  let m = 0;
  for (let i = 0; i < data.length; i++) m = Math.max(m, Math.abs(data[i]));
  if (m < 1e-8) return;
  const g = peak / m;
  for (let i = 0; i < data.length; i++) data[i] *= g;
}

export function rms(data: Float32Array, start = 0, end = data.length): number {
  let s = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) s += data[i] * data[i];
  return Math.sqrt(s / n);
}

export function zeroCrossRate(data: Float32Array): number {
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i] >= 0) !== (data[i - 1] >= 0)) n++;
  }
  return n / data.length;
}

class OnePole {
  private y = 0;
  private readonly a: number;
  constructor(a: number) {
    this.a = a;
  }
  step(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

function lpCoeff(hz: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * hz) / sr);
}

/** RBJ bandpass, unity peak. */
class BandPass {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;

  constructor(hz: number, q: number, sr: number) {
    const w0 = (2 * Math.PI * hz) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export interface KickSpec {
  pitchEnd: number;
  click: number;
  punch: number;
  drive: number;
}

export function renderKick(sr: number, spec: KickSpec): Float32Array {
  const n = Math.floor(KIT.KICK_LEN * sr);
  const out = new Float32Array(n);
  const hp = new OnePole(lpCoeff(28, sr));
  let phase = 0;
  let punchPhase = 0;
  const noise = mulberry(0x9e3779b1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const pitch = spec.pitchEnd + (KIT.KICK_PITCH0 - spec.pitchEnd) * expDecay(t, KIT.KICK_PITCH_TAU);
    phase += (2 * Math.PI * pitch) / sr;
    const body = sine(phase) * expDecay(t, KIT.KICK_BODY_TAU);
    const sub = sine(phase) * expDecay(t, KIT.KICK_SUB_TAU) * 0.7;
    const punchHz = 90 + 230 * expDecay(t, KIT.KICK_PUNCH_TAU);
    punchPhase += (2 * Math.PI * punchHz) / sr;
    const punch = sine(punchPhase) * expDecay(t, KIT.KICK_PUNCH_TAU) * spec.punch;
    const clickN = t < 0.007 ? (noise() * 2 - 1) * expDecay(t, 0.003) * spec.click : 0;
    const clickT = t < 0.0045 ? sine(2 * Math.PI * 2400 * t) * expDecay(t, 0.0022) * spec.click * 0.55 : 0;
    const raw = body + sub * 0.85 + punch + clickN * 0.65 + clickT;
    const shaped = tanhSoft(raw, spec.drive);
    out[i] = shaped - hp.step(shaped);
  }
  peakNormalize(out, 0.94);
  return out;
}

export interface HatSpec {
  bright: number;
  seed: number;
}

function renderHat(sr: number, seconds: number, spec: HatSpec, open: boolean): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const hpHz = open ? 5200 + spec.bright * 1800 : 7200 + spec.bright * 1600;
  const hp = new OnePole(lpCoeff(hpHz, sr));
  const bp = new BandPass(open ? 6500 : 7800, 0.7, sr);
  const noise = mulberry(spec.seed);
  const phases = KIT.HAT_FREQS.map(() => noise() * Math.PI * 2);
  const tau = open ? 0.11 : 0.028;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let metal = 0;
    for (let k = 0; k < phases.length; k++) {
      phases[k] += (2 * Math.PI * KIT.HAT_FREQS[k] * (0.98 + spec.bright * 0.06)) / sr;
      metal += square(phases[k]);
    }
    metal /= phases.length;
    const hiss = (noise() * 2 - 1) * 0.35;
    const env = expDecay(t, tau) * (open ? 1 : 1.05);
    const raw = (metal * 0.78 + hiss) * env;
    const air = raw - hp.step(raw);
    out[i] = tanhSoft(bp.step(air) + air * 0.35, 1.15);
  }
  peakNormalize(out, open ? 0.72 : 0.78);
  return out;
}

export function renderHatClosed(sr: number, spec: HatSpec): Float32Array {
  return renderHat(sr, KIT.HAT_CLOSED_LEN, spec, false);
}

export function renderHatOpen(sr: number, spec: HatSpec): Float32Array {
  return renderHat(sr, KIT.HAT_OPEN_LEN, spec, true);
}

export interface ClapSpec {
  tone: number;
  seed: number;
}

export function renderClap(sr: number, spec: ClapSpec): Float32Array {
  const n = Math.floor(KIT.CLAP_LEN * sr);
  const out = new Float32Array(n);
  const bp = new BandPass(KIT.CLAP_BP + spec.tone * 280, KIT.CLAP_Q, sr);
  const noise = mulberry(spec.seed ^ 0x51ed);
  const bursts = [0, 0.011, 0.021, 0.032];
  const amps = [1, 0.78, 0.55, 0.38];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let burst = 0;
    for (let b = 0; b < bursts.length; b++) {
      const dt = t - bursts[b];
      if (dt >= 0 && dt < 0.018) burst += (noise() * 2 - 1) * expDecay(dt, 0.006) * amps[b];
    }
    const tail = t > 0.03 ? (noise() * 2 - 1) * expDecay(t - 0.03, 0.055) * 0.45 : 0;
    out[i] = tanhSoft(bp.step(burst + tail), 1.25);
  }
  peakNormalize(out, 0.86);
  return out;
}

export function kitFromDna(brightness: number, warmth: number, bounce: number): {
  kick: KickSpec;
  hat: HatSpec;
  clap: ClapSpec;
} {
  return {
    kick: {
      pitchEnd: KIT.KICK_PITCH1 + (warmth - 0.5) * 6,
      click: 0.32 + brightness * 0.38,
      punch: 0.28 + bounce * 0.28,
      drive: 1.35 + bounce * 0.35,
    },
    hat: {
      bright: brightness,
      seed: Math.floor(brightness * 1e9) ^ 0x91b1,
    },
    clap: {
      tone: warmth,
      seed: Math.floor(warmth * 1e9) ^ 0xc2a3,
    },
  };
}
