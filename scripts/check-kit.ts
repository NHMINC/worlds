/**
 * Invariant checks for the house kit DSP.
 *
 *   npx tsx scripts/check-kit.ts
 *
 * We assert the instrument laws: kicks have a punch then a body,
 * hats are metallic (high zero-cross) and stereo, claps decay, a DNA
 * is deterministic, and nothing is silent or brick-walled.
 */
import {
  KIT,
  kitFromDna,
  renderClap,
  renderHatClosed,
  renderHatOpen,
  renderHatTick,
  renderKick,
  rms,
  zeroCrossRate,
} from '../src/audio/dsp';

let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    fail++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

const SR = 44100;
const spec = kitFromDna(0.6, 0.45, 0.55);
const kick = renderKick(SR, spec.kick);
const closed = renderHatClosed(SR, spec.hat);
const open = renderHatOpen(SR, spec.hat);
const tick = renderHatTick(SR, spec.hat);
const clap = renderClap(SR, spec.clap);

function peak(data: Float32Array): number {
  let m = 0;
  for (let i = 0; i < data.length; i++) m = Math.max(m, Math.abs(data[i]));
  return m;
}

function finite(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) return false;
  }
  return true;
}

function channelsDiffer(L: Float32Array, R: Float32Array): boolean {
  const n = Math.min(L.length, R.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(L[i] - R[i]) > 1e-4) return true;
  }
  return false;
}

check('kick length', Math.abs(kick.length / SR - KIT.KICK_LEN) < 0.002);
check('closed hat shorter than open', closed.L.length < open.L.length);
check('tick shorter than closed', tick.L.length < closed.L.length);
check(
  'all samples finite',
  finite(kick) &&
    finite(closed.L) &&
    finite(closed.R) &&
    finite(open.L) &&
    finite(tick.L) &&
    finite(clap.L) &&
    finite(clap.R),
);
check('kick peak is hot but not clipped-solid', peak(kick) > 0.7 && peak(kick) <= 0.95);
check(
  'hats and clap have level',
  peak(closed.L) > 0.5 && peak(open.L) > 0.5 && peak(tick.L) > 0.4 && peak(clap.L) > 0.5,
);

const kickHead = rms(kick, 0, Math.floor(0.012 * SR));
const kickTail = rms(kick, Math.floor(0.2 * SR), kick.length);
check('kick is a transient then a body', kickHead > kickTail * 1.45, `head ${kickHead.toFixed(3)} tail ${kickTail.toFixed(3)}`);

const kickZ = zeroCrossRate(kick);
const hatZ = zeroCrossRate(closed.L);
check('kick is tonal (low zero-cross)', kickZ < 0.08, `${kickZ.toFixed(3)}`);
check('hat is metallic (high zero-cross)', hatZ > 0.15, `${hatZ.toFixed(3)}`);
check('hats are stereo', channelsDiffer(closed.L, closed.R));
check('clap is stereo', channelsDiffer(clap.L, clap.R));

const clapHead = rms(clap.L, 0, Math.floor(0.04 * SR));
const clapTail = rms(clap.L, Math.floor(0.2 * SR), clap.L.length);
check('clap decays', clapHead > clapTail * 1.8, `head ${clapHead.toFixed(3)} tail ${clapTail.toFixed(3)}`);

const again = renderKick(SR, spec.kick);
let same = again.length === kick.length;
for (let i = 0; i < kick.length && same; i++) if (again[i] !== kick[i]) same = false;
check('kick is deterministic', same);

const dull = renderKick(SR, kitFromDna(0.1, 0.8, 0.2).kick);
const bright = renderKick(SR, kitFromDna(0.9, 0.2, 0.8).kick);
let differ = false;
for (let i = 0; i < Math.min(dull.length, bright.length); i++) {
  if (Math.abs(dull[i] - bright[i]) > 1e-5) {
    differ = true;
    break;
  }
}
check('DNA changes the kick', differ);

if (fail) {
  console.error(`\n${fail} check(s) failed`);
  process.exit(1);
}
console.log('\nkit laws hold');
