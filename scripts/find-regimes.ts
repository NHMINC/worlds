/* Search the seed space for one example of each emergent regime (run with
 * tsx). The charter test: regimes must EMERGE from the laws; we only search
 * for where. Prints seed + bodyId per regime for the visual smoke pass. */
import { classify, generateSystem, homeBodyId, lockedToStar } from '../src/world/systemgen';

const WANTED = [
  'living world',
  'hothouse',
  'methane world',
  'airless rock',
  'eyeball world',
  'iceball',
  'gas giant',
  'frozen methane world',
  'dry-ice world',
  'nitrogen iceball',
  'warm giant',
  'scorched giant',
  'carbon world',
  'titan moon', // pseudo-regime: a gas giant's moon wearing an atmosphere
];

const found = new Map<string, { seed: string; bodyId: string; name: string; home: string }>();

for (let i = 0; i < 2000 && found.size < WANTED.length; i++) {
  const seed = `smoke-${i}`;
  const sys = generateSystem(seed);
  for (const b of sys.bodies) {
    const label = classify(b.physics, lockedToStar(b));
    if (WANTED.includes(label) && !found.has(label)) {
      found.set(label, { seed, bodyId: b.id, name: b.name, home: homeBodyId(sys) });
    }
    // Titans carry a regime label of their own kind (iceball, methane
    // world...); what makes them special is air on a gas giant's moon.
    if (!found.has('titan moon') && b.kind === 'rocky' && b.parent) {
      const parent = sys.bodies.find((x) => x.id === b.parent)!;
      if (parent.kind === 'gas' && b.physics.atmosphere.pressure > 0.3) {
        found.set('titan moon', { seed, bodyId: b.id, name: b.name, home: homeBodyId(sys) });
      }
    }
  }
}

for (const want of WANTED) {
  const hit = found.get(want);
  if (!hit) {
    console.error(`NOT FOUND in 2000 seeds: ${want} — generator bug!`);
    process.exitCode = 1;
  } else {
    const sys = generateSystem(hit.seed);
    const b = sys.bodies.find((x) => x.id === hit.bodyId)!;
    const p = b.physics;
    console.log(
      `${want.padEnd(14)} seed=${hit.seed.padEnd(10)} body=${hit.bodyId.padEnd(5)} ${hit.name.padEnd(14)}` +
        ` g=${p.gravity.toFixed(2)} P=${p.atmosphere.pressure.toFixed(2)}atm T=${Math.round(p.TsurfK)}K sea=${p.sea01.toFixed(2)} home=${hit.home}`,
    );
  }
}
