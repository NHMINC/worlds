/* Invariant checks for the star as a law (run with tsx).
 *
 * We assert inverse-square, Stefan–Boltzmann Teff, the display knee,
 * activity (dynamo vs radiative), and wind — not a catalogue of pretty
 * suns. If a G dwarf at A_HAB is not flux 1, the exposure is wrong.
 */
import {
  UNIVERSE,
  starActivity,
  starEyeFlux,
  starIrradiance,
  starIrradianceDisplay,
  starTeff,
  starWind,
} from '../src/world/physics';

let fail = 0;
function bad(msg: string): void {
  console.error(msg);
  fail++;
}

// --- inverse-square at a body (physics a) ---
const hz = starIrradiance(1, UNIVERSE.A_HAB);
if (Math.abs(hz - 1) > 1e-9) bad(`HZ L=1 should be flux 1, got ${hz}`);

const twice = starIrradiance(1, UNIVERSE.A_HAB * 2);
if (Math.abs(twice - 0.25) > 1e-9) bad(`2× distance should be 1/4 flux, got ${twice}`);

const half = starIrradiance(1, UNIVERSE.A_HAB / 2);
if (Math.abs(half - 4) > 1e-9) bad(`½ distance should be 4× flux, got ${half}`);

const dimL = starIrradiance(0.25, UNIVERSE.A_HAB);
if (Math.abs(dimL - 0.25) > 1e-9) bad(`L=0.25 at HZ should be 0.25, got ${dimL}`);

// --- display knee: dim side untouched, bright side compressed ---
if (starIrradianceDisplay(1) !== 1) bad(`display(1) should be 1`);
if (starIrradianceDisplay(0.2) !== 0.2) bad(`display must not lift the dim side`);
const hot = starIrradianceDisplay(8);
if (!(hot > 1 && hot < 8)) bad(`display(8) should compress into (1, 8), got ${hot}`);
if (starIrradianceDisplay(16) <= hot) bad(`brighter flux must still read brighter after the knee`);

// --- Teff: G dwarf is the sun; hotter when L up or R down ---
const tSun = starTeff(1, UNIVERSE.STAR_R_GL);
if (Math.abs(tSun - UNIVERSE.STAR_TEFF_SUN) > 0.5) {
  bad(`L=1 R=STAR_R_GL should be ${UNIVERSE.STAR_TEFF_SUN} K, got ${tSun}`);
}
if (starTeff(16, UNIVERSE.STAR_R_GL) <= tSun) bad(`16 Lsun should be hotter`);
if (starTeff(1, UNIVERSE.STAR_R_GL * 2) >= tSun) bad(`2 Rsun at L=1 should be cooler`);

// --- activity: convective cool stars flare; hot radiative envelopes don't ---
const gAct = starActivity(5772, 1);
const mAct = starActivity(3200, 0.08);
const oAct = starActivity(30000, 1e5);
if (mAct <= gAct) bad(`M dwarf should be more active than a G dwarf (${mAct} vs ${gAct})`);
if (oAct >= gAct) bad(`O star should be quieter on the flare axis than a G dwarf (${oAct} vs ${gAct})`);

// --- wind: hot stars drive a stronger Thomson column ---
const gWind = starWind(1, 5772);
const oWind = starWind(1e5, 30000);
const mWind = starWind(0.08, 3200);
if (oWind <= gWind) bad(`O-star wind should outshine a G dwarf (${oWind} vs ${gWind})`);
if (mWind <= 0) bad(`M dwarfs still have a Parker wind`);
if (oWind > 12) bad(`O-star wind should compress through a display knee, got ${oWind}`);

// --- eye flux: same inverse-square, display stretch as the reference ---
const dRef = UNIVERSE.A_HAB * UNIVERSE.SPACE_SCALE;
if (Math.abs(starEyeFlux(1, dRef) - 1) > 1e-9) bad(`eye flux at A_HAB·SPACE_SCALE should be 1`);
if (Math.abs(starEyeFlux(1, dRef * 2) - 0.25) > 1e-9) bad(`eye flux must be inverse-square`);

if (fail) {
  console.error(`check-star: ${fail} failure(s)`);
  process.exit(1);
}
console.log('check-star: ok');
console.log(`  HZ=1  inner(a/2)=${half.toFixed(2)}  outer(2a)=${twice.toFixed(2)}  knee(8)=${hot.toFixed(2)}`);
console.log(`  Teff(G)=${tSun.toFixed(0)} K  activity G/M/O=${gAct.toFixed(2)}/${mAct.toFixed(2)}/${oAct.toFixed(2)}`);
console.log(`  wind G/O/M=${gWind.toFixed(2)}/${oWind.toFixed(2)}/${mWind.toFixed(2)}`);
