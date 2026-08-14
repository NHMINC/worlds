/* Invariant checks for the system generator + physics engine (run with tsx).
 *
 * Charter tests: we assert LAWS, and we SEARCH the generated universe for
 * emergent regimes (living worlds, hothouses, methane seas, airless rocks,
 * eyeballs, iceballs, gas giants). If a regime cannot be found across many
 * seeds, that is a generator bug, not a test to skip.
 */
import { classify, effectivePhysics, generateSystem, homeBodyId, lockedToStar } from '../src/world/systemgen';
import { UNIVERSE, airExtinction } from '../src/world/physics';
import { Geology, geologyFor } from '../src/world/geology';
import { MAX_LEVEL } from '../src/world/toygen';

const SYSTEMS = 300;
let fail = 0;

function bad(msg: string): void {
  console.error(msg);
  fail++;
}

const counts: number[] = [];
let gasTotal = 0;
let moonTotal = 0;
const regimes = new Map<string, number>();
const gravities: number[] = [];
let rockyPlanets = 0;
let interesting = 0;
let airless = 0;
let livingCount = 0;
let titanCount = 0;

for (let i = 0; i < SYSTEMS; i++) {
  const seed = `check-${i}`;
  const a = generateSystem(seed);
  const b = generateSystem(seed);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad(`NON-DETERMINISTIC (incl. physics/chemistry): ${seed}`);
  }

  const planets = a.bodies.filter((x) => !x.parent);
  const moons = a.bodies.filter((x) => x.parent);
  counts.push(planets.length);
  // Accretion deals 4-15, but migration lawfully eats planets: a lonely
  // hot Jupiter plus the decreed rocky survivor is a valid system.
  if (planets.length < 2 || planets.length > 15) bad(`BAD COUNT ${planets.length}: ${seed}`);
  gasTotal += planets.filter((p) => p.kind === 'gas').length;
  moonTotal += moons.length;

  for (const body of a.bodies) {
    const p = body.physics;
    const label = classify(p, lockedToStar(body));
    regimes.set(label, (regimes.get(label) ?? 0) + 1);

    // --- gravity is derived and sane ---
    if (!(p.gravity > 0.02 && p.gravity < 4)) bad(`GRAVITY OUT OF RANGE ${p.gravity}: ${seed} ${body.id}`);
    if (body.kind === 'rocky' && !body.parent) {
      gravities.push(p.gravity);
      rockyPlanets++;
      if (p.atmosphere.pressure > 0.05 && p.hydrosphere.state === 'liquid') interesting++;
      if (p.atmosphere.pressure < 0.02) airless++;
      if (p.life) livingCount++;
    }

    // --- chemistry consistency: one inventory, no contradictions ---
    const invSum = Object.values(p.inventory).reduce((x, y) => x + y, 0);
    if (body.kind === 'rocky' && Math.abs(invSum - 1) > 0.01) bad(`INVENTORY NOT NORMALIZED: ${seed} ${body.id}`);
    if ((p.atmosphere.mix.O2 ?? 0) > 0.001 && !p.life) bad(`O2 WITHOUT LIFE: ${seed} ${body.id}`);
    const h = p.hydrosphere;
    if (h.substance === 'water' && (p.inventory.H <= 0 || p.inventory.O <= 0)) {
      bad(`WATER SEA WITHOUT H/O: ${seed} ${body.id}`);
    }
    if ((h.substance === 'methane' || h.substance === 'co2') && p.inventory.C <= 0.01) {
      bad(`CARBON SEA ON CARBON-POOR WORLD: ${seed} ${body.id}`);
    }
    if (h.substance === 'nitrogen' && p.inventory.N <= 0.003) {
      bad(`NITROGEN ICE WITHOUT N: ${seed} ${body.id}`);
    }
    if (p.kind === 'gas' && p.inventory.H + p.inventory.He < 0.6) {
      bad(`GAS GIANT NOT H/HE BULK: ${seed} ${body.id}`);
    }
    if (p.life && !(h.substance === 'water' && h.state === 'liquid')) {
      bad(`LIFE WITHOUT LIQUID WATER: ${seed} ${body.id}`);
    }

    // --- phase law: a frozen sheet must actually be below its substance's
    // freeze point (ice is a physical state, never a paint choice) ---
    if (h.state === 'ice') {
      const ceiling =
        h.substance === 'water' ? 258 : h.substance === 'methane' ? 78 : h.substance === 'co2' ? 150 : 70;
      if (p.TsurfK >= ceiling) bad(`ICE SHEET ABOVE FREEZE: ${seed} ${body.id} ${h.substance} ${Math.round(p.TsurfK)}K`);
    }

    // --- cryosphere law: snow is precipitation, never paint ---
    if (p.atmosphere.pressure < 0.02 && p.snow > 0.05) {
      bad(`SNOW WITHOUT ATMOSPHERE: ${seed} ${body.id}`);
    }
    if (h.substance === 'none' && p.snow > 0.01) {
      bad(`SNOW WITHOUT RESERVOIR: ${seed} ${body.id}`);
    }
    // "Freeze-locked" is a property of the temperature FIELD, not the mean:
    // the reservoir is sealed only when even the warmest point (equator on
    // spinners, substellar point on locked worlds) stays frozen. Then no
    // evaporation, no precipitation, bare peaks. Conversely an ice world
    // with an open melt band (Snowball Earth's equatorial ring) MUST keep
    // its snow cycle — that gap is exactly the Inovos V bug.
    {
      const starLocked = body.tidallyLocked && !body.parent;
      const span = starLocked ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
      const insolMax = starLocked ? 1.0 : (1 - 0.785) * 1.6;
      const freeze01 =
        (UNIVERSE.WATER_WIN[0] - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD);
      const warmest01 = p.snowTemp01 + span * insolMax;
      const canMelt = p.atmosphere.pressure > UNIVERSE.LIQUID_MIN_P && warmest01 > freeze01;
      if (h.state === 'none' && p.snow > 0) {
        bad(`SNOW ON DRY WORLD: ${seed} ${body.id}`);
      }
      if (h.state === 'ice' && !canMelt && p.snow > 0) {
        bad(`SNOW ON FREEZE-LOCKED WORLD: ${seed} ${body.id}`);
      }
      if (h.state === 'ice' && p.atmosphere.pressure > 0.3 && warmest01 > freeze01 + 0.03 && p.snow <= 0) {
        bad(`OPEN SEA WITHOUT SNOW CYCLE: ${seed} ${body.id} warmest=${warmest01.toFixed(2)}`);
      }
    }
    if (p.life && p.snow < 0.3) {
      bad(`LIVING WORLD CANNOT SNOW: ${seed} ${body.id} snow=${p.snow.toFixed(2)}`);
    }
    // A world whose seas are liquid must read temperate on its own volatile's
    // snow dial — frost caps peaks, never blankets liquid lowlands.
    if (h.substance === 'methane' && h.state === 'liquid' && (p.snowTemp01 < 0.2 || p.snowTemp01 > 0.8)) {
      bad(`METHANE SNOW DIAL OFF: ${seed} ${body.id} ${p.snowTemp01.toFixed(2)}`);
    }

    // --- spin laws ---
    if (body.tidallyLocked && body.obliquity !== 0) bad(`LOCKED WITH TILT: ${seed} ${body.id}`);

    // --- limb law: temperate air is a readable halo that still dies
    // with the exponential. Too tall and vacuum glows; too short and
    // the envelope sits on the dirt. Hot low-g air may sit taller —
    // that is the barometric law.
    if (body.kind === 'rocky' && p.gravity > 0.8 && p.TsurfK > 250 && p.TsurfK < 320) {
      const ext = airExtinction(p);
      if (ext && 7 * ext.scaleH > 0.36) {
        bad(`TEMPERATE AIR HALO: ${seed} ${body.id} 7H=${(7 * ext.scaleH).toFixed(3)}`);
      }
      if (ext && 7 * ext.scaleH < 0.08) {
        bad(`TEMPERATE AIR INVISIBLE: ${seed} ${body.id} 7H=${(7 * ext.scaleH).toFixed(3)}`);
      }
    }
  }

  for (const m of moons) {
    if (!m.tidallyLocked || m.spinPeriod !== m.orbitPeriod) bad(`MOON NOT LOCKED: ${seed} ${m.id}`);
    if (m.ecc !== 0) bad(`MOON NOT CIRCULAR: ${seed} ${m.id}`);
    const parent = a.bodies.find((p) => p.id === m.parent)!;
    if (parent.kind === 'rocky' && parent.tidallyLocked) bad(`LOCKED PLANET HAS MOON: ${seed} ${m.id}`);
    // Titan law: a moon's atmosphere is earned by size — below the
    // outgassing ramp the volatiles stay sealed in the ice.
    if (m.kind === 'rocky' && m.physics.atmosphere.pressure > 0.05) {
      if (m.physics.radiusRel < UNIVERSE.OUTGAS_R[0]) {
        bad(`MOON AIR BELOW OUTGAS SIZE: ${seed} ${m.id}`);
      }
      titanCount++;
    }
  }

  // --- home world is livable, never hidden under a haze deck when any
  // clear-skied rocky body (planet or moon) exists ---
  const home = a.bodies.find((x) => x.id === homeBodyId(a))!;
  if (home.kind !== 'rocky') bad(`HOME NOT ROCKY: ${seed}`);
  const anyClear = a.bodies.some(
    (x) => x.kind === 'rocky' && x.physics.atmosphere.pressure <= UNIVERSE.HAZE_P,
  );
  if (anyClear && home.physics.atmosphere.pressure > UNIVERSE.HAZE_P) {
    bad(`HOME HIDDEN UNDER HAZE: ${seed}`);
  }

  // --- orbit safety: periapsis clears the inner neighbor's apoapsis ---
  for (let p = 1; p < planets.length; p++) {
    const inner = planets[p - 1];
    const outer = planets[p];
    if (outer.orbitRadius * (1 - outer.ecc) <= inner.orbitRadius * (1 + inner.ecc)) {
      bad(`ORBITS CROSS: ${seed} ${outer.id}`);
    }
    if (outer.ecc < 0 || outer.ecc > 0.15) bad(`ECC OUT OF RANGE: ${seed} ${outer.id}`);
  }

  // --- Kepler solver converges (pure function of (spec, t)) ---
  if (i < 20) {
    for (const p of planets) {
      const t = 123456.789;
      const M = p.orbitPhase + (2 * Math.PI * t) / p.orbitPeriod;
      let E = M + p.ecc * Math.sin(M);
      for (let it = 0; it < 3; it++) E -= (E - p.ecc * Math.sin(E) - M) / (1 - p.ecc * Math.cos(E));
      if (Math.abs(E - p.ecc * Math.sin(E) - M) > 1e-9) bad(`KEPLER NOT CONVERGED: ${seed} ${p.id}`);
    }
  }
}

// --- limb law (universe knobs): a readable halo that dies in vacuum ---
{
  // 7H is where the exponential has died. On the reference 1 g world the
  // envelope must READ as a halo (~20% of the radius) without lighting
  // space (the old 0.05 stretch put 7H at 35%). Real H/R is AIR_HR_HOME.
  if (7 * UNIVERSE.AIR_H > 0.28) {
    bad(`AIR TOO PUFFY: 7H=${(7 * UNIVERSE.AIR_H).toFixed(3)} (vacuum would glow)`);
  }
  if (7 * UNIVERSE.AIR_H < 0.18) {
    bad(`AIR TOO TIGHT: 7H=${(7 * UNIVERSE.AIR_H).toFixed(3)} (halo would hug the dirt)`);
  }
  // σ·H is the Earthlike vertical column. The Chapman slant was sized so
  // this product reaches grazing optical depth ~2 (sunsets); keep it.
  const col = UNIVERSE.AIR_SIGMA * UNIVERSE.AIR_H;
  if (col < 0.08 || col > 0.16) {
    bad(`AIR COLUMN OFF (sunsets/sky): σH=${col.toFixed(3)}`);
  }
  // The halo is a line through the well, not a filled shell: AIR_LINE
  // (density at half-glow) must sit inside the first couple of scale
  // heights so 1 atm upper air shows space.
  if (UNIVERSE.AIR_LINE < 0.12 || UNIVERSE.AIR_LINE > 0.4) {
    bad(`AIR_LINE OFF (limb should be a line): ${UNIVERSE.AIR_LINE}`);
  }
}

// --- geology: deterministic, depth-lawful ---
{
  const sys = generateSystem('check-geology');
  const body = sys.bodies.find((b) => b.kind === 'rocky')!;
  const g1 = geologyFor(body.seed, body.physics, 13.4);
  const deep = g1.at(0.3, 0.5, 0.81, 2);
  const deep2 = new Geology(body.seed, body.physics, 13.4).at(0.3, 0.5, 0.81, 2);
  if (JSON.stringify(deep) !== JSON.stringify(deep2)) bad('GEOLOGY NON-DETERMINISTIC');
  if (g1.at(0.3, 0.5, 0.81, 0).length !== 0) bad('BEDROCK REPORTED MINABLE');
  if (g1.at(0.3, 0.5, 0.81, MAX_LEVEL).length === 0) bad('TOP LAYER EMPTY');
  // Metals should on average concentrate toward bedrock.
  let deepFe = 0;
  let topFe = 0;
  let n = 0;
  for (let k = 0; k < 200; k++) {
    const z = (k / 100 - 1) * 0.9;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const x = r * Math.cos(k * 2.4);
    const y = r * Math.sin(k * 2.4);
    const fe = (layer: number) => g1.at(x, y, z, layer).find((e) => e.element === 'Fe')?.share ?? 0;
    deepFe += fe(2);
    topFe += fe(28);
    n++;
  }
  if (deepFe / n <= topFe / n) bad(`METALS NOT DEPTH-CONCENTRATED: deep ${deepFe / n} top ${topFe / n}`);
}

// --- terraforming: the climate dial re-runs the LAWS, never repaints ---
{
  let cooledLiquid = 0;
  for (let i = 0; i < 40; i++) {
    const sys = generateSystem(`terra-${i}`);
    const home = sys.bodies.find((b) => b.id === homeBodyId(sys))!;

    // Determinism under override, and identity when the dial is untouched.
    const cold = effectivePhysics(sys, home, 0);
    const cold2 = effectivePhysics(sys, home, 0);
    if (JSON.stringify(cold) !== JSON.stringify(cold2)) bad(`TERRAFORM NON-DETERMINISTIC: terra-${i}`);
    if (effectivePhysics(sys, home) !== home.physics) bad(`NO-OVERRIDE NOT IDENTITY: terra-${i}`);

    // Every seeded quantity except the temperature chain must survive the
    // override untouched (the rng stream is branch-independent).
    if (cold.gravity !== home.physics.gravity || JSON.stringify(cold.inventory) !== JSON.stringify(home.physics.inventory)) {
      bad(`TERRAFORM PERTURBS SEEDED QUANTITIES: terra-${i}`);
    }

    // Full cold: a watery home world must freeze-lock — sheet, sealed snow
    // cycle, iceball classification, no life.
    if (home.physics.hydrosphere.state === 'liquid') {
      cooledLiquid++;
      if (cold.hydrosphere.state !== 'ice') bad(`COOLED SEA DID NOT FREEZE: terra-${i} ${cold.hydrosphere.state}`);
      // Spinners seal at full cold. Locked worlds lawfully keep a substellar
      // melt pond (warmest01 = 0.55 > freeze), so their cycle stays open.
      const homeLocked = lockedToStar(home);
      const coldWarmest =
        cold.snowTemp01 + (homeLocked ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN * (1 - 0.785) * 1.6);
      const coldFreeze01 =
        (UNIVERSE.WATER_WIN[0] - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD);
      if (coldWarmest <= coldFreeze01 && cold.snow > 0) {
        bad(`SNOW ON FULLY COOLED WORLD: terra-${i} snow=${cold.snow.toFixed(2)}`);
      }
      if (coldWarmest > coldFreeze01 + 0.03 && cold.snow <= 0) {
        bad(`COOLED MELT POND WITHOUT SNOW: terra-${i}`);
      }
      if (cold.life) bad(`LIFE SURVIVES DEEP FREEZE: terra-${i}`);
      // Spinners must reclassify when frozen; locked worlds may lawfully
      // stay "eyeball world" (the label reads substance + lock, and the
      // dayside pond is exactly the eyeball condition).
      if (!homeLocked && classify(cold, false) === classify(home.physics, false)) {
        bad(`CLASSIFICATION IGNORES TERRAFORMING: terra-${i}`);
      }
      // Full hot: no frozen sheet can persist at the top of the dial.
      const hot = effectivePhysics(sys, home, 1);
      if (hot.hydrosphere.state === 'ice') bad(`ICE SHEET AT MAX HEAT: terra-${i}`);
      if (hot.snow > 0.001 && hot.hydrosphere.state !== 'liquid') bad(`HOT SNOW WITHOUT LIQUID: terra-${i}`);

      // The dial is unclamped: past the display range the chemistry keeps
      // working. 40 K must leave a frozen sheet of SOMETHING on a watery
      // world; 600 K must strip every volatile off the surface.
      const dialOfK = (k: number) => (k - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD);
      const cryo = effectivePhysics(sys, home, dialOfK(40));
      if (cryo.hydrosphere.state !== 'ice') bad(`NO SHEET AT 40K: terra-${i} ${cryo.hydrosphere.state}`);
      const scorch = effectivePhysics(sys, home, dialOfK(600));
      if (scorch.hydrosphere.state !== 'none') bad(`VOLATILE SURVIVES 600K: terra-${i} ${scorch.hydrosphere.substance}`);
      if (scorch.snow !== 0) bad(`SNOW AT 600K: terra-${i}`);
      if (scorch.life) bad(`LIFE AT 600K: terra-${i}`);
    }
  }
  if (cooledLiquid === 0) bad('TERRAFORM CHECK NEVER SAW A LIQUID HOME WORLD');
}

// --- population statistics: the universe is interesting but honest ---
const avg = counts.reduce((x, y) => x + y, 0) / counts.length;
const gAvg = gravities.reduce((x, y) => x + y, 0) / Math.max(1, gravities.length);
console.log(`planets: min ${Math.min(...counts)} max ${Math.max(...counts)} avg ${avg.toFixed(1)}`);
console.log(`per system: gas ${(gasTotal / SYSTEMS).toFixed(1)}, moons ${(moonTotal / SYSTEMS).toFixed(1)}`);
console.log(`rocky planet gravity: avg ${gAvg.toFixed(2)}g over ${rockyPlanets}`);
console.log(`rocky planets: interesting ${(100 * interesting / rockyPlanets).toFixed(0)}%, airless ${(100 * airless / rockyPlanets).toFixed(0)}%, living ${(100 * livingCount / rockyPlanets).toFixed(0)}%`);
console.log('regimes:', [...regimes.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', '));

if (gAvg < 0.75 || gAvg > 1.3) bad(`ROCKY GRAVITY AVG OFF 1g: ${gAvg.toFixed(2)}`);
if (interesting / rockyPlanets < 0.2) bad(`TOO FEW INTERESTING WORLDS: ${(interesting / rockyPlanets).toFixed(2)}`);
if (airless === 0) bad('NO AIRLESS ROCKS ANYWHERE (escape law broken?)');
if (livingCount === 0) bad('NO LIVING WORLDS ANYWHERE');
if (titanCount === 0) bad('NO TITAN MOONS ANYWHERE (outgassing law broken?)');
console.log(`titan moons (air): ${titanCount}`);

// Emergent-regime search: each must exist somewhere in 300 systems.
// Migration adds irradiated giants; carbon chemistry adds carbon worlds.
for (const want of ['living world', 'hothouse', 'methane world', 'airless rock', 'eyeball world', 'iceball', 'gas giant', 'warm giant', 'carbon world']) {
  if (!regimes.has(want)) bad(`REGIME NEVER EMERGES: ${want}`);
}

console.log(fail === 0 ? 'ALL CHECKS PASSED' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
