/**
 * Offline DSP for the house kit. We render one-shots from laws, then
 * play the buffers. Tone.js is the clock; this file is the instrument.
 *
 * Kick is a 909-shaped body (triangle → saturate → lowpass) plus a
 * clean sine sub and a short highpassed click. Hats are an inharmonic
 * square cluster with a tick+ring envelope, rendered stereo. Clap is
 * burst noise through a bandpass, also stereo, with a short room tail.
 */

export const KIT = {
  KICK_LEN: 0.32,
  KICK_PITCH0: 152,
  KICK_PITCH1: 46,
  KICK_PITCH_TAU: 0.038,
  KICK_BODY_TAU: 0.11,
  KICK_SUB_TAU: 0.19,
  KICK_PUNCH_TAU: 0.026,
  KICK_BODY_LP: 2200,
  HAT_CLOSED_LEN: 0.1,
  HAT_OPEN_LEN: 0.42,
  HAT_TICK_LEN: 0.048,
  /** 808-style metallic cluster, plus a few higher inharmonics. */
  HAT_FREQS: [205.3, 304.4, 369.6, 522.3, 540.0, 800.1, 987.4, 1174.6, 1396.9],
  CLAP_LEN: 0.32,
  CLAP_BP: 1050,
  CLAP_Q: 0.82,
};

export interface StereoBuf {
  L: Float32Array;
  R: Float32Array;
}

export function expDecay(t: number, tau: number): number {
  return Math.exp(-t / Math.max(1e-5, tau));
}

export function sine(phase: number): number {
  return Math.sin(phase);
}

export function square(phase: number): number {
  return Math.sin(phase) >= 0 ? 1 : -1;
}

/** Naive triangle from the same running phase as sine/square. */
export function triangle(phase: number): number {
  return (2 / Math.PI) * Math.asin(Math.sin(phase));
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

function delaySamples(src: Float32Array, samples: number): Float32Array {
  const out = new Float32Array(src.length);
  const d = Math.max(0, samples | 0);
  for (let i = d; i < src.length; i++) out[i] = src[i - d];
  return out;
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
  const dcHp = new OnePole(lpCoeff(22, sr));
  const bodyLp = new OnePole(lpCoeff(KIT.KICK_BODY_LP, sr));
  const clickHp = new OnePole(lpCoeff(3200, sr));
  let phase = 0;
  let punchPhase = 0;
  let knockPhase = 0;
  const noise = mulberry(0x9e3779b1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const pitch = spec.pitchEnd + (KIT.KICK_PITCH0 - spec.pitchEnd) * expDecay(t, KIT.KICK_PITCH_TAU);
    phase += (2 * Math.PI * pitch) / sr;
    // Triangle body, driven, then lowpassed so the grit lives in the knock band.
    const tri = triangle(phase) * expDecay(t, KIT.KICK_BODY_TAU);
    const body = bodyLp.step(tanhSoft(tri, spec.drive));
    const sub = sine(phase) * expDecay(t, KIT.KICK_SUB_TAU) * 0.95;
    // Knock sits 80–120 Hz — the part a club system reads as weight.
    const knockHz = 88 + 30 * expDecay(t, 0.018);
    knockPhase += (2 * Math.PI * knockHz) / sr;
    const knock = sine(knockPhase) * expDecay(t, 0.034) * spec.punch * 0.9;
    const punchHz = 110 + 190 * expDecay(t, KIT.KICK_PUNCH_TAU);
    punchPhase += (2 * Math.PI * punchHz) / sr;
    const punch = sine(punchPhase) * expDecay(t, KIT.KICK_PUNCH_TAU) * spec.punch * 0.5;
    const clickN = t < 0.008 ? (noise() * 2 - 1) * expDecay(t, 0.0026) * spec.click : 0;
    const click = clickN - clickHp.step(clickN);
    const raw = body * 0.74 + sub * 0.92 + knock + punch + click * 0.88;
    const shaped = tanhSoft(raw, 1.06);
    out[i] = shaped - dcHp.step(shaped);
  }
  peakNormalize(out, 0.94);
  return out;
}

export interface HatSpec {
  bright: number;
  seed: number;
}

function renderHatChannel(
  sr: number,
  seconds: number,
  spec: HatSpec,
  open: boolean,
  detune: number,
  seedXor: number,
): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const hpHz = open ? 5000 + spec.bright * 1800 : 7000 + spec.bright * 1700;
  const hp = new OnePole(lpCoeff(hpHz, sr));
  const bp = new BandPass(open ? 6400 : 7900, 0.68, sr);
  const noise = mulberry(spec.seed ^ seedXor);
  const phases = KIT.HAT_FREQS.map(() => noise() * Math.PI * 2);
  const ringTau = open ? 0.14 : 0.03;
  const tickTau = open ? 0.012 : 0.007;
  const tune = detune * (0.985 + spec.bright * 0.05);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let metal = 0;
    for (let k = 0; k < phases.length; k++) {
      phases[k] += (2 * Math.PI * KIT.HAT_FREQS[k] * tune) / sr;
      metal += square(phases[k]);
    }
    metal /= phases.length;
    const hiss = (noise() * 2 - 1) * 0.32;
    const tick = expDecay(t, tickTau);
    const ring = expDecay(t, ringTau);
    const env = open ? tick * 0.32 + ring : tick * 0.9 + ring * 0.55;
    const raw = (metal * 0.8 + hiss) * env;
    const air = raw - hp.step(raw);
    out[i] = tanhSoft(bp.step(air) + air * 0.32, 1.12);
  }
  peakNormalize(out, open ? 0.7 : 0.76);
  return out;
}

function stereoHat(sr: number, seconds: number, spec: HatSpec, open: boolean): StereoBuf {
  const L = renderHatChannel(sr, seconds, spec, open, 1, 0x11a3);
  const R = delaySamples(renderHatChannel(sr, seconds, spec, open, 1.0036, 0x5e2d), 2);
  return { L, R };
}

export function renderHatClosed(sr: number, spec: HatSpec): StereoBuf {
  return stereoHat(sr, KIT.HAT_CLOSED_LEN, spec, false);
}

export function renderHatOpen(sr: number, spec: HatSpec): StereoBuf {
  return stereoHat(sr, KIT.HAT_OPEN_LEN, spec, true);
}

/** Short 16th ghost — same metal, almost all tick. */
export function renderHatTick(sr: number, spec: HatSpec): StereoBuf {
  const n = Math.floor(KIT.HAT_TICK_LEN * sr);
  const bright: HatSpec = { bright: Math.min(1, spec.bright + 0.18), seed: spec.seed ^ 0x4d2 };
  const L = renderHatChannel(sr, KIT.HAT_TICK_LEN, bright, false, 1.002, 0x88c1);
  const R = delaySamples(renderHatChannel(sr, KIT.HAT_TICK_LEN, bright, false, 1.006, 0x21f0), 1);
  // Re-shape to a clickier envelope so ghosts don't smear into the closed hat.
  for (let i = 0; i < n; i++) {
    const env = expDecay(i / sr, 0.011);
    L[i] *= env;
    R[i] *= env;
  }
  peakNormalize(L, 0.62);
  peakNormalize(R, 0.62);
  return { L, R };
}

export interface ClapSpec {
  tone: number;
  seed: number;
}

function renderClapChannel(sr: number, spec: ClapSpec, bursts: number[], seedXor: number): Float32Array {
  const n = Math.floor(KIT.CLAP_LEN * sr);
  const out = new Float32Array(n);
  const bp = new BandPass(KIT.CLAP_BP + spec.tone * 280, KIT.CLAP_Q, sr);
  const room = new OnePole(lpCoeff(2400, sr));
  const noise = mulberry(spec.seed ^ seedXor);
  const amps = [1, 0.78, 0.55, 0.4];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let burst = 0;
    for (let b = 0; b < bursts.length; b++) {
      const dt = t - bursts[b];
      if (dt >= 0 && dt < 0.02) burst += (noise() * 2 - 1) * expDecay(dt, 0.0062) * (amps[b] ?? 0.3);
    }
    const tail = t > 0.028 ? (noise() * 2 - 1) * expDecay(t - 0.028, 0.078) * 0.5 : 0;
    const raw = burst + tail;
    out[i] = tanhSoft(bp.step(raw) + room.step(raw) * 0.22, 1.2);
  }
  peakNormalize(out, 0.84);
  return out;
}

export function renderClap(sr: number, spec: ClapSpec): StereoBuf {
  const L = renderClapChannel(sr, spec, [0, 0.011, 0.021, 0.032], 0x51ed);
  const R = renderClapChannel(sr, spec, [0.0009, 0.0124, 0.0202, 0.0336], 0x9c47);
  return { L, R };
}

export function kitFromDna(brightness: number, warmth: number, bounce: number): {
  kick: KickSpec;
  hat: HatSpec;
  clap: ClapSpec;
} {
  return {
    kick: {
      pitchEnd: KIT.KICK_PITCH1 + (warmth - 0.5) * 6,
      click: 0.34 + brightness * 0.36,
      punch: 0.32 + bounce * 0.3,
      drive: 1.45 + bounce * 0.4,
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
