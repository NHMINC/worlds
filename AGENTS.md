# AGENTS.md

Guidance for anyone (human or agent) changing this codebase. The product
evolved in conversation; this file is the distilled contract. When it
disagrees with older comments in `README.md`, **this file and the code
win** — the README still describes an earlier realistic-globe era.

---

## What this is

A **procedural mini-universe in a bottle**. One seed unfolds into a star,
planets, and moons that exist and run because of mathematics and physics —
not because we catalogued planet types and painted skins.

You can fly the system, orbit a world, and land on it. Worlds are small
Goldberg-hex globes with layered strata (Godus-like onion rings, a blending
skin over discrete columns) in Caribbean / cel-shaded tones. The feeling:
a perfect little world model you could hold. Chill, bright, readable.

We are **cosmic engineers**. We set base rules (constants, conservation,
causal order). The world is supposed to *emerge*. Prefer one law that
covers ten cases over ten patches that cover one case each.

**Less code. Less special cases. More maths and physics.**

Stack: Vite + React + TypeScript + Three.js. Persistence is IndexedDB
(Dexie) with a single portable JSON export. Mobile is web-first
(Capacitor). Music is generative (Tone.js), mood-reactive.

---

## The charter (non-negotiable)

> **We set parameters and laws; we never hand-roll outcomes.**
> **When a world looks wrong, fix the law, not the world.**
> **If the cosmic engineer set only constants and laws, would this still happen?**

This is a physics engine with toy scaling, not a catalogue of planet types.

- **Archetypes are outputs, never inputs.** There is no `if (iceball)` /
  `if (hothouse)` generator switch. Iceballs, methane seas, eyeball worlds,
  living paradises, and airless rocks are attractor regions of one causal
  chain. If a class of world looks wrong, the condensation, escape, or
  temperature law is wrong.
- **Chemistry is the single source of truth.** Stellar metallicity → disk
  condensation at that orbit → one elemental inventory per body → partition
  into core / crust / ocean / atmosphere. Visuals (palette, ocean tint,
  sky colour, gas-giant colour, snow, ice) **derive** from that inventory.
  Do not add a tint, a texture, or a special-case mesh that chemistry
  cannot explain.
- **Toy constants live in `UNIVERSE` (`src/world/physics.ts`).** Compress
  mass, distance, and time so a whole system fits in a bottle and stays
  fun — but keep the compression **visible and named**, not scattered
  fudges. “Exaggerate within laws” (great sunsets, readable water) means
  turning a knob in `UNIVERSE` or in a documented optical approximation,
  not a one-off `if (sunset) color = orange`.
- **Documented simplifications** (decreed, not hidden): metallic core and
  spin-aligned dipole on every body (a compass works); orbits are stable
  by fiat; interiors, plate tectonics, and **weather** are out of scope
  until we take them on as laws. Clouds are not a painted deck; aerosol
  opacity lives inside `airExtinction` / the scattering integral.

If you are about to special-case a seed, a body id, or a named planet
type: stop. Change the law. A new `if` that papers over one ugly world is
a patch. A better equation that makes that world *and* its cousins right
is the job.

---

## Causal chain (do not skip steps)

```
star (seed, metallicity, C/O, luminosity)
  → disk chemistry at orbital radius (condensation sequence)
  → body inventory + bulk density + radius
  → gravity (derived: g = G_TOY · densityRel · radiusRel — never a slider)
  → Jeans escape + wind stripping → atmosphere
  → greenhouse → T_surf
  → hydrosphere phase (none / ice / liquid water / liquid methane)
  → snow capacity, sea state, palette, life odds
```

Related laws that must stay physics, not flags:

- **Tidal locking** from torque (~1/a⁶), not a random “tidally locked”
  bit. Locked worlds get a **time-averaged insolation field** (angular
  distance from the substellar point). Eyeball terrain (scorched day,
  ice night, twilight ring) **emerges**; if it looks backwards, the
  insolation / light-direction frame is wrong.
- **Snow** needs a liquid reservoir and enough pressure for a precipitation
  cycle. Frozen-solid worlds with no liquid do not “weather” snow onto
  peaks. Frozen volatiles are unmoving ice sheets (water / CO₂ / CH₄ / N₂
  colours from chemistry), not animated water.
- **Seasons** come from axial tilt. Snow line and sea ice advance and
  retreat with local temperature. Locked bodies are damped to ~zero tilt.
- **Variety without abandoning physics:** Type-II migration, disk C/O
  scatter, and an outgassing law for moons exist so systems are not all
  Sol clones. Tune those laws; do not inject “exotic planet” presets.

Terraforming sliders (temp, sea level) are **dev tools** that re-run the
physics pipeline (`effectivePhysics`, hydrosphere, palette). They are not
a second visual path. Extremes should be reachable so we can inspect the
laws. Production will drop the sliders; the pipeline stays.

---

## One universe, not modes

Landing, orbiting, and flying are **viewers**, not separate worlds.

- Surface view is the same globe, same shaders, same scattering integral.
  Do not introduce a skydome, a different water material, or a “planet
  mode” colour grade.
- `scattering.ts` is **the only copy** of the air law. Terrain, water, and
  the sky shell compile the same GLSL and march the same integral.
  Viewpoint only changes which rays you own (ground hit vs sky miss).
- Light comes from the star at the origin. Day/night is spin + orbit as
  functions of `(spec, unix time t)` — deterministic, no “bake a sun
  behind the camera.”

Camera rigs (`src/render/engine.ts`):

| Mode | Meaning |
|------|---------|
| `orbit` | Around a body. **Station** = ISS-like inertial sweep; **geo** = hung over one spot. |
| `flight` | Free ship in the system. Distant bodies are simple spheres until close. |
| `surface` | Landed on a rocky body. Same globe. Drag looks. **Zoom in** (pinch out / wheel in) walks forward at a latched variable speed; **zoom out** stops that walk, then settles toward the ground. Zoom does not take off — the rocket does. WASD still glides on a keyboard. |

`engine.ts` **declines HMR**. After changing it, **full page reload** or
you will debug a stale engine class. The app lives at
`http://localhost:5173/` (`npm run dev`).

---

## Worlds: grid, layers, address

- **Goldberg hex grid** (`geodesic.ts`). Size is a frequency; `MAX_FINE_F`
  caps how big a world can be. Terrain is **31 states**: level **0 =
  unalterable bedrock**, levels **1–30 = alterable / minable layers**.
- The mesh is a **terrace skin** over those columns (`terraceMesh.ts`):
  discrete layers with a blending skin so coasts and contours meander.
  Colour is the physics-derived onion ramp (`toyPalette.paletteFor`),
  **re-anchored on the body’s actual waterline** so a raised sea does not
  leave drowned peaks wearing seabed colours.
- **Addressable universe:** `(systemSeed, bodyId, cell)` names a piece of
  ground forever. That address is the contract for inspection, mining,
  bases, labels, and every other player mark. Player terrain edits are
  **absolute level overlays**, never deltas, stored sparsely.
  `effectiveLevel(cell) = override ?? generated(cell)`.
- Per-(cell, layer) **geology** (`geology.ts`) is a pure function of seed
  + crust inventory. Nothing is stored until somebody digs. Inspection
  now; mining later. Do not bake a second composition table.
- Bump `CURRENT_GEN_VERSION` in `systemgen.ts` when generator output for a
  seed would change, and keep old behaviour for systems pinned to a
  previous version.

Time: orbits and spins are pure functions of spec and wall-clock Unix
time (geared by `UNIVERSE.TIME_SCALE`). No hidden simulation step that
diverges from that.

---

## Persistence: the universe must travel

The generated universe is cheap: a seed plus a gen version. The *player’s*
universe is the seed plus a sparse overlay. Saves stay tiny because we
never store generated terrain, chemistry, or meshes.

| Stored | Regenerated |
|--------|-------------|
| `SystemMeta` (seed, genVersion, camera) | Star, orbits, inventories, atmospheres |
| Sparse terrain overrides `[cell, level, …]` | Hex columns, hydrology, snow line |
| Labels, objects (city / town / landmark, later bases) | Palettes, geology, sea state |
| Optional per-body dials (dev terraforming) | Geology at `(dir, layer)` |

**Export is first-class.** One self-contained `.tinysystem.json`
(`formatVersion: 4`, `src/store/exportImport.ts`). Import creates a new
system id and copies the overlay. A friend can load your file and stand
on the same hex of the same world. Native iOS uses the share sheet.

When you add player state (mined voids, placed bases, cargo, claims):

- It must round-trip through that JSON. If it is not in the export, it
  does not exist.
- Prefer another sparse table keyed by `(systemId, bodyId, cell)` (and
  layer, if mining a column segment). Do not dump generated geology into
  the save.
- Bump `formatVersion` and keep importers for older files.

Do not put secrets, API keys, or machine-local paths in a save.

---

## Player layer: mine, place, inhabit

The physics universe does not know about the player. Mining and building
are **overlays on the addressable grid**, not new planet types.

**Now**

- Inspect a hex: composition of that column’s surface layer, from geology.
- Place labels and objects (`city` / `town` / `landmark`) on a cell.
- Sculpt by writing absolute levels (the same overlay mining will use).

**Direction (do not invent a parallel world to get here)**

- **Mine:** remove or replace a layer in a column. The hole is an overlay;
  the contents come from `geology.at(x,y,z,layer)` at dig time. Bedrock
  (level 0) cannot be dug. Yield is chemistry, not a loot table.
- **Place bases (and later factories, pads, claims):** records on a cell,
  like today’s objects, with enough fields to export. They sit on the
  terrain skin; they do not get a second renderer that ignores lighting
  and air.
- **Carry / stockpile:** player inventory derived from what was actually
  dug. If the crust has no Fe, there is no iron.

When those features land, they still obey the charter: no ore that
chemistry cannot explain, no building that cannot be named by
`(systemSeed, bodyId, cell)`, no save that cannot leave the device.

---

## Rendering laws (learned the hard way)

These are product rules, not optional polish.

### Atmosphere

- One progressive horizon: exponential air, not a planet limb + haze
  deck + rim glow as three shells.
- Thick air reduces visibility through **optical depth**, not a texture.
  Multiple scattering (diffusion floor) exists so thick atmospheres are
  dim, not pitch-black at the ground — that is transport, not weather.
- Aerosols are a **stratified deck** in the same integral (clearer air
  below), not a second mesh.
- The sky shell hands off to surfaces using the **bedrock** sphere as the
  miss test (valleys sit below radius 1). The **sea writes depth** so
  ocean rays occlude the sky. Do not hand off at the mathematical sea
  sphere: tessellation sag opens a black gap.
- Sunsets: exaggerate **inside** the scattering law (path length, Mie/dust
  when we have it as chemistry, luminance). Do not paint a sunset gradient.

### Water

The sea is a **surface**, not a window onto the framebuffer.

- **Alpha ≈ 1** from the ground (orbit may stay a translucent jewel).
  If opacity is “whatever is behind this pixel,” open ocean vanishes
  against the sky and drowned hills draw the horizon. That was a real bug;
  do not reintroduce it.
- **Refraction is colour**, not transparency: capture terrain colour +
  distance, Beer–Lambert the bottom through the column, tint so shallows
  read as *under* water. Short columns must not become a hole in the sky.
- **Reflections are Fresnel** on top of that body: cube-capture of land
  near the shore, analytic scattering sky elsewhere. A convex sea only
  images content above the local horizontal; far-field lookups must not
  smear beyond-horizon terrain onto the water (lumpy horizon).
- Keep a little of the water’s own colour at the limb so aerial
  perspective does not dissolve the sea into the sky.
- **Surf** (breaking crests, wet line, swash) must remain visible. Foam
  painted only on terrain will be buried by an opaque sea. Shoreline
  effects belong on the water in the shallows **and** on the first beach
  terrace. Do not raise the water sphere over the swash zone to hide
  poke-through. Foam is **always white**; night and shadow change its
  brightness, never its tint. Apply it after the air integral or the
  sky dyes the surf blue.
- Ice is a raised sheet (freeboard), static (no wave shimmer), with its
  own shoreline. Wave / surf animation is for **liquid**. Chemistry
  (`clarity`, `foam`, freeze point) drives how milky or glassy, and
  whether anything freezes.

### Gas giants

Colour from atmospheric chemistry. No hex terrain, no fake weather bands
until weather is a law. Objects in orbit around them must stay
deterministically addressable.

### Darkness

Pitch black is never fun. Below a brightness threshold (night or opaque
air), a **forward torch** turns on. The beam obeys the same extinction:
murk makes it obvious and short; clear air makes it faint and long.
Volumetric scatter of the beam is the same integral.

---

## Aesthetic

- Calm, high-contrast, readable. Cel-shaded bands, not photoreal noise
  textures. Land patterns that scream “hex” or “tiling” were tried and
  dropped.
- Hex structure is the *model*; the *skin* should crowd out the lattice
  at a glance, especially zoomed out.
- Coasts should feel like coasts (macro-smooth with local irregularity),
  not a hex outline and not a random nibble.
- Palette follows crust + life + heat/cold continuously. Vegetation green
  exists only where `life` is true; it is not a painted biome map.

---

## Not yet laws (until we take them on)

These are allowed as *future physics*, not as painted features:

- Weather systems, storms, painted cloud layers, oriented land textures.
- Full vegetation ecology (habitability and an O₂/organic signature can
  exist; lush biomes as a sim is later).
- Interiors and plate tectonics (columns plus hydrology/coastal-plain
  process passes stand in for now).

Player features (mining, bases, cargo) are **not** in this bucket — they
are overlays. See **Player layer**.

---

## How we change things

1. **Reproduce with a seed**, not a one-off mesh edit. Create systems,
   land, walk, flood the sea slider. Smoke scripts in `scripts/smoke-*.mjs`
   (Playwright against `localhost:5173`) exist for horizon, reflections,
   flood, torch, sky, land, etc. Use them; add one if you invent a new
   failure mode.
2. **Fix the law** in `physics.ts` / `scattering.ts` / the relevant
   shader’s shared chunk. If you must add an approximation (Chapman slant,
   Eddington diffusion, Schlick), comment *why* it is the law, not a
   bandage. Delete patches when the law makes them redundant.
3. **Bump `CURRENT_GEN_VERSION`** if a given seed’s generated terrain or
   system layout would change. Player overlays stay valid because they are
   absolute cell levels.
4. **Bump export `formatVersion`** if the JSON shape changes; keep reading
   older files.
5. **Do not commit secrets.** Do not drive-by refactors. Update this file
   when the contract changes.

Code map (start here):

| Area | Where |
|------|--------|
| Charter + `UNIVERSE` + body physics | `src/world/physics.ts` |
| System / orbits / gen version | `src/world/systemgen.ts` |
| Hex columns, hydrology, snow line | `src/world/toygen.ts` |
| Palettes from physics | `src/world/toyPalette.ts` |
| Per-cell geology (mining truth) | `src/world/geology.ts` |
| Grid | `src/world/geodesic.ts` |
| Scene, camera, reflections, capture | `src/render/engine.ts` |
| Terrain + water shaders, surf, foam | `src/render/terraceMesh.ts` |
| Sky shell | `src/render/atmosphere.ts` |
| Shared air integral | `src/render/scattering.ts` |
| Gas giants | `src/render/gasGiant.ts` |
| Persistence, export/import | `src/store/` |

---

## When in doubt

Ask: *If the cosmic engineer set only constants and laws, would this still
happen?* If the answer is “only because we special-cased it,” it does not
belong.

Ask: *Can this leave the device in the JSON export, and can another player
stand on the same hex?* If not, the addressable-universe contract is
broken.

If a picture looks wrong, write down which law failed (opacity vs
backdrop, handoff radius vs tessellation, insolation frame, missing
precip, etc.) and fix that — then walk a high-sea world, a hothouse, a
night side, and an airless rock before calling it done.
