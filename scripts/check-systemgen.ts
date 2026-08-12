/* Quick invariants check for the system generator (run with tsx). */
import { generateSystem, homeBodyId } from '../src/world/systemgen';

let fail = 0;
const counts: number[] = [];
let gasTotal = 0;
let tempTotal = 0;
let moonTotal = 0;

for (let i = 0; i < 300; i++) {
  const seed = `check-${i}`;
  const a = generateSystem(seed);
  const b = generateSystem(seed);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error(`NON-DETERMINISTIC: ${seed}`);
    fail++;
  }
  const planets = a.bodies.filter((x) => !x.parent);
  const moons = a.bodies.filter((x) => x.parent);
  counts.push(planets.length);
  if (planets.length < 4 || planets.length > 15) {
    console.error(`BAD COUNT ${planets.length}: ${seed}`);
    fail++;
  }
  gasTotal += planets.filter((p) => p.kind === 'gas').length;
  tempTotal += planets.filter(
    (p) => p.kind === 'rocky' && (p.temp ?? 0) > 0.2 && (p.temp ?? 0) < 0.8 && (p.seaLevel ?? 0) > 0.3,
  ).length;
  moonTotal += moons.length;
  for (const m of moons) {
    if (!m.tidallyLocked || m.spinPeriod !== m.orbitPeriod) {
      console.error(`MOON NOT LOCKED: ${seed} ${m.id}`);
      fail++;
    }
    const parent = a.bodies.find((p) => p.id === m.parent)!;
    if (parent.kind === 'rocky' && parent.tidallyLocked) {
      console.error(`SCORCHED PLANET HAS MOON: ${seed} ${m.id}`);
      fail++;
    }
  }
  const home = a.bodies.find((x) => x.id === homeBodyId(a))!;
  if (home.kind !== 'rocky') {
    console.error(`HOME NOT ROCKY: ${seed}`);
    fail++;
  }
  // Orbit sanity: strictly increasing planet orbits, periods Keplerian-ish.
  for (let p = 1; p < planets.length; p++) {
    if (planets[p].orbitRadius <= planets[p - 1].orbitRadius) {
      console.error(`ORBITS NOT INCREASING: ${seed}`);
      fail++;
    }
  }
}

const avg = counts.reduce((x, y) => x + y, 0) / counts.length;
console.log(`planets: min ${Math.min(...counts)} max ${Math.max(...counts)} avg ${avg.toFixed(1)}`);
console.log(`per system: gas ${(gasTotal / 300).toFixed(1)}, temperate water worlds ${(tempTotal / 300).toFixed(1)}, moons ${(moonTotal / 300).toFixed(1)}`);
console.log(fail === 0 ? 'ALL CHECKS PASSED' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
