/* Formation-sim law checks: the galaxy must EMERGE, deterministically,
 * in boot-tolerable time. Runs the gas-to-galaxy sim for the canonical
 * seed, then asserts:
 *   - determinism (two runs, identical field hash)
 *   - runtime budget
 *   - a disk formed (most stars on cool circular orbits, exp-ish Σ)
 *   - star formation consumed most of the gas
 *   - non-axisymmetric structure emerged (m=2 bar/arm amplitude)
 *   - chemical evolution ran (negative radial [Fe/H] gradient)
 *   - a central concentration exists (the bulge the old law faked)
 * Also dumps the field to /tmp/formation-dump.json + .bin for the
 * python renderer. Run: npx tsx scripts/check-formation.ts [seed]
 */
import { writeFileSync } from 'node:fs';
import { UNIVERSE } from '../src/world/physics';
import { runFormation, formationGenes, FORM, FORMATION_VERSION } from '../src/world/formation/sim';
import { bakeField, fieldDensity, fieldDensityParts, FIELD } from '../src/world/formation/field';

let fail = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    fail++;
    console.error('  FAIL:', msg);
  }
};

const seed = process.argv[2] ?? UNIVERSE.CANONICAL_SEED;
console.log(`=== formation: seed "${seed}" v${FORMATION_VERSION} ===`);
console.log('genes:', JSON.stringify(formationGenes(seed), (_, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));

const r1 = runFormation(seed);
console.log(`run 1: ${r1.ms.toFixed(0)} ms  (${FORM.N} particles, ${FORM.STEPS} steps, mesh ${FORM.MESH})`);
const f1 = bakeField(seed, FORMATION_VERSION, r1, UNIVERSE.GALAXY_AGE_GYR, UNIVERSE.GALAXY_POPULATION, UNIVERSE.GALAXY_N_K);
console.log(`bake 1: ${f1.ms.toFixed(0)} ms  hash ${f1.hash.toString(16)}`);

const r2 = runFormation(seed);
const f2 = bakeField(seed, FORMATION_VERSION, r2, UNIVERSE.GALAXY_AGE_GYR, UNIVERSE.GALAXY_POPULATION, UNIVERSE.GALAXY_N_K);
check(f1.hash === f2.hash, `determinism: hashes differ ${f1.hash.toString(16)} vs ${f2.hash.toString(16)}`);
check(r1.ms < 45_000, `runtime ${r1.ms.toFixed(0)} ms over budget`);

// --- star formation ---
let nStar = 0;
for (let i = 0; i < r1.n; i++) if (r1.star[i]) nStar++;
const starFrac = nStar / r1.n;
console.log(`stars: ${(starFrac * 100).toFixed(1)}% of baryons`);
check(starFrac > 0.5, `only ${(starFrac * 100).toFixed(1)}% of gas became stars`);
check(starFrac < 0.98, `gas exhausted (${(starFrac * 100).toFixed(1)}%) — no ISM left for dust/nurseries`);

// --- disk vs spheroid ---
const nvc = r1.vcirc.length;
const vcAt = (rad: number) => Math.max(20, r1.vcirc[Math.min(nvc - 1, Math.max(0, Math.floor(rad / r1.vcDr)))]);
let nThin = 0;
let nThick = 0;
let nSph = 0;
for (let i = 0; i < r1.n; i++) {
  if (!r1.star[i]) continue;
  const rad = Math.hypot(r1.px[i], r1.py[i]);
  const c = (r1.px[i] * r1.vy[i] - r1.py[i] * r1.vx[i]) / Math.max(rad, 1e-6) / vcAt(rad);
  if (c < FIELD.C_SPHEROID) nSph++;
  else if (c < FIELD.C_THIN) nThick++;
  else nThin++;
}
console.log(
  `populations: thin ${((100 * nThin) / nStar).toFixed(1)}%  thick ${((100 * nThick) / nStar).toFixed(1)}%  spheroid ${((100 * nSph) / nStar).toFixed(1)}%`,
);
check(nThin / nStar > 0.35, `thin disk is only ${((100 * nThin) / nStar).toFixed(1)}% — did not settle`);
check(nSph / nStar > 0.02, `spheroid ${((100 * nSph) / nStar).toFixed(1)}% — no bulge/halo formed`);

// --- surface-density profile + m=2 amplitude per annulus ---
const NR = 22;
const DR = 0.75;
const prof: number[] = [];
console.log('--  R    Σ(rel)   A2/A0   meanAge  [Fe/H] --');
const a2Arr: number[] = [];
for (let b = 0; b < NR; b++) {
  const r0 = b * DR;
  const r1b = r0 + DR;
  let m0 = 0;
  let c2 = 0;
  let s2 = 0;
  let ageS = 0;
  let fehS = 0;
  for (let i = 0; i < r1.n; i++) {
    if (!r1.star[i]) continue;
    const x = r1.px[i];
    const y = r1.py[i];
    const rad = Math.hypot(x, y);
    if (rad < r0 || rad >= r1b) continue;
    m0++;
    const inv = 1 / Math.max(rad * rad, 1e-9);
    c2 += (x * x - y * y) * inv;
    s2 += 2 * x * y * inv;
    ageS += ((r1.tTotal - r1.tBirth[i]) / r1.tTotal) * UNIVERSE.GALAXY_AGE_GYR;
    fehS += Math.log10(Math.max(1e-6, r1.metal[i]) / 0.0134);
  }
  const area = Math.PI * (r1b * r1b - r0 * r0);
  const sig = m0 / area;
  const a2 = m0 > 50 ? Math.hypot(c2, s2) / m0 : 0;
  a2Arr.push(a2);
  prof.push(sig);
  if (m0 > 20) {
    console.log(
      `  ${((r0 + r1b) / 2).toFixed(1).padStart(5)}  ${sig.toFixed(1).padStart(7)}  ${a2.toFixed(3)}   ${(ageS / m0).toFixed(2).padStart(5)}   ${(fehS / m0).toFixed(2).padStart(5)}`,
    );
  }
}
const a2Inner = Math.max(...a2Arr.slice(1, 6));
const a2Outer = Math.max(...a2Arr.slice(7, 16));
console.log(`m=2 amplitude: inner (bar) ${a2Inner.toFixed(3)}  outer (arms) ${a2Outer.toFixed(3)}`);
check(a2Inner > 0.08 || a2Outer > 0.08, 'no m=2 structure emerged (no bar, no arms)');

// Exponential-ish disk: fit log Σ over 3–12 kpc, expect negative slope.
let sx = 0, sy = 0, sxx = 0, sxy = 0, np = 0;
for (let b = 0; b < NR; b++) {
  const R = (b + 0.5) * DR;
  if (R < 3 || R > 12 || prof[b] <= 0) continue;
  const ly = Math.log(prof[b]);
  sx += R; sy += ly; sxx += R * R; sxy += R * ly; np++;
}
const slope = (np * sxy - sx * sy) / (np * sxx - sx * sx);
const rd = -1 / slope;
console.log(`disk scale length Rd ≈ ${rd.toFixed(2)} kpc`);
check(rd > 1 && rd < 12, `Rd ${rd.toFixed(2)} kpc is not a disk`);

// --- chemistry: inside-out enrichment gradient ---
const fehIn = f1.feh[(f1.out / 2) * f1.out + Math.floor(f1.out / 2 + 2 / (2 * f1.box / f1.out))];
let fehMid = 0, nMid = 0, fehOut = 0, nOut = 0;
for (let j = 0; j < f1.out; j++) {
  for (let i = 0; i < f1.out; i++) {
    const x = ((i + 0.5) / f1.out) * 2 * f1.box - f1.box;
    const y = ((j + 0.5) / f1.out) * 2 * f1.box - f1.box;
    const rad = Math.hypot(x, y);
    const v = f1.feh[j * f1.out + i];
    if (v <= -0.99 && f1.sigThin[j * f1.out + i] === 0) continue;
    if (rad > 2 && rad < 5) { fehMid += v; nMid++; }
    if (rad > 9 && rad < 13) { fehOut += v; nOut++; }
  }
}
fehMid /= Math.max(1, nMid);
fehOut /= Math.max(1, nOut);
console.log(`[Fe/H]: R≈2 ${fehIn.toFixed(2)}  R 2–5 ${fehMid.toFixed(2)}  R 9–13 ${fehOut.toFixed(2)}`);
check(fehMid > fehOut, `no metallicity gradient (${fehMid.toFixed(2)} !> ${fehOut.toFixed(2)})`);

// --- central concentration (the honest bulge) + vertical envelope ---
const rhoC = fieldDensity(f1, 0.3, 0, 0);
const rhoSun = fieldDensity(f1, 8.2, 0, 0);
const rhoCz1 = fieldDensity(f1, 0.3, 0, 1.2);
console.log(`ρ(0.3,0,0)=${rhoC.toFixed(3)}  ρ(8.2,0,0)=${rhoSun.toFixed(4)}  ρ(0.3,0,z=1.2)=${rhoCz1.toFixed(4)}`);
check(rhoC > rhoSun * 5, 'no central concentration');
check(rhoCz1 > 0, 'bulge has no vertical extent');
const parts = fieldDensityParts(f1, 8.2, 0, 0);
console.log(`parts at solar circle: thin ${parts.thin.toFixed(4)} thick ${parts.thick.toFixed(4)} sph ${parts.spheroid.toFixed(5)} gas ${parts.gas.toFixed(4)}`);

// --- population integral sanity ---
let integ = 0;
const dxs = 0.5;
for (let x = -f1.box; x < f1.box; x += dxs) {
  for (let y = -f1.box; y < f1.box; y += dxs) {
    for (let z = -3.5; z < 3.5; z += 0.25) {
      integ += fieldDensity(f1, x + 0.25, y + 0.25, z + 0.125) * dxs * dxs * 0.25;
    }
  }
}
const pop = integ * UNIVERSE.GALAXY_N_K;
console.log(`population integral ≈ ${(pop / 1e9).toFixed(2)} B (target ${(UNIVERSE.GALAXY_POPULATION / 1e9).toFixed(1)} B)`);
check(pop > UNIVERSE.GALAXY_POPULATION * 0.5 && pop < UNIVERSE.GALAXY_POPULATION * 2, 'population integral off by >2×');

// --- dump for the python renderer ---
const meta = {
  seed,
  out: f1.out,
  box: f1.box,
  sphBins: FIELD.SPH_BINS,
  sphDr: f1.sphDr,
  vcN: f1.vcirc.length,
  vcDr: f1.vcDr,
  nParticles: r1.n,
  hash: f1.hash,
  ms: r1.ms,
  arrays: ['sigThin', 'sigThick', 'hThin', 'feh', 'ageGyr', 'youngFrac', 'sigGas', 'sphRho', 'vcirc'],
};
const bufs: Float32Array[] = [f1.sigThin, f1.sigThick, f1.hThin, f1.feh, f1.ageGyr, f1.youngFrac, f1.sigGas, f1.sphRho, f1.vcirc];
const total = bufs.reduce((a, b) => a + b.length, 0);
const cat = new Float32Array(total);
let off = 0;
const lens: number[] = [];
for (const b of bufs) {
  cat.set(b, off);
  off += b.length;
  lens.push(b.length);
}
writeFileSync('/tmp/formation-dump.json', JSON.stringify({ ...meta, lens }));
writeFileSync('/tmp/formation-dump.bin', Buffer.from(cat.buffer));
// Particle scatter for the face-on render (stars only, subsampled).
const sub: number[] = [];
for (let i = 0; i < r1.n; i += 2) {
  if (!r1.star[i]) continue;
  sub.push(r1.px[i], r1.py[i], ((r1.tTotal - r1.tBirth[i]) / r1.tTotal) * UNIVERSE.GALAXY_AGE_GYR);
}
writeFileSync('/tmp/formation-particles.bin', Buffer.from(new Float32Array(sub).buffer));
console.log(`dumped field + ${sub.length / 3} star particles for rendering`);

console.log(fail === 0 ? 'OK' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
