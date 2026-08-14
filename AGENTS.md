# AGENTS.md

Guidance for anyone (human or agent) changing this codebase. The product
evolved in conversation; this file is the distilled contract. When it
disagrees with older comments in `README.md`, **this file and the code
win** — the README still describes an earlier realistic-globe era.

---

## What this is

A **procedural galaxy in a bottle**. One canonical seed unfolds into a
single **grand-design barred spiral** (Hubble SBbc — two long arms, a
bar, a bulge: the accepted beautiful galaxy, and our own Milky Way’s
class). Stars, remnants, and nebulae are a cheap function of that seed
plus laws. You **discover** a star system by going there; you do not
mint one. The stars in the sky **are** that catalog.

Worlds stay small Goldberg-hex globes with layered strata (Godus-like
onion rings) in Caribbean / cel-shaded tones. The feeling: a perfect
little universe you could hold. Chill, bright, readable.

Everyone who plays the canonical game is in **the same galaxy**. Private
universes (another seed through the same laws) and cosmic-engineer knobs
(other `UNIVERSE` values) come later. Multiplayer only works once these
laws are boringly stable — a generator change moves every address.

We are **cosmic engineers**. We set base rules (constants, conservation,
causal order). The world is supposed to *emerge*. Prefer one law that
covers ten cases over ten patches that cover one case each.

**Less code. Less special cases. More maths and physics.**

Stack: Vite + React + TypeScript + Three.js. Persistence is IndexedDB
(Dexie) with a single portable JSON export. Mobile is web-first
(Capacitor). Music is generative progressive house (Tone.js): a short
loop that evolves, mood-reactive. Each listen mints a fresh seed —
never the system seed — so a restart is a new piece, not a replay.

---

## The charter (non-negotiable)

> **We set parameters and laws; we never hand-roll outcomes.**
> **When a world looks wrong, fix the law, not the world.**
> **If the cosmic engineer set only constants and laws, would this still happen?**

This is a physics engine with toy scaling, not a catalogue of planet
types or star types.

- **Archetypes are outputs, never inputs.** There is no `if (iceball)` /
  `if (hothouse)` / `if (pulsar)` generator switch. Iceballs, O stars,
  pulsars, H II regions, and living paradises are attractor regions of
  one causal chain. If a class looks wrong, the mass, clock, chemistry,
  or density law is wrong.
- **Chemistry is the single source of truth.** Galactic position →
  [Fe/H] and C/O → stellar inventory → disk condensation at that orbit
  → one elemental inventory per body → core / crust / ocean /
  atmosphere. Visuals **derive** from that inventory. Do not add a tint
  or a special-case mesh that chemistry cannot explain.
- **The stellar zoo is a clock, not a list.** Harvard class, luminosity
  class, white dwarfs, neutron stars, pulsars, black holes, Wolf–Rayet,
  carbon stars, H II, planetary nebulae, and SN remnants are
  `evolve(mass, age, Z)` plus a short-lived nebula window. We do not
  store the galaxy. A star is an address: `objectAt(seed, id)` is O(1)
  at a billion ids the same as at ten. Occupancy is
  `density × volume × GALAXY_N_K` — that *is* the population
  (~`GALAXY_POPULATION`). We never `collectCatalog`. The explorer
  asks `objectsNear` for the volume it occupies; within a cell the
  IMF is stratified so zooming in is “include more slots,” not
  “load a bigger array.”
- **Toy constants live in `UNIVERSE` (`src/world/physics.ts`).** Compress
  mass, distance, and time so a whole system fits in a bottle and stays
  fun — but keep the compression **visible and named**, not scattered
  fudges. “Exaggerate within laws” (great sunsets, readable water) means
  turning a knob in `UNIVERSE` or in a documented optical approximation,
  not a one-off `if (sunset) color = orange`.
- **Documented simplifications** (decreed, not hidden): metallic core and
  spin-aligned dipole on every body (a compass works); orbits are stable
  by fiat; we do not integrate an N-body galaxy for 10 Gyr (Lin–Shu
  density field + IMF + closed-form stellar clock instead); interstellar
  travel is a deterministic set-course, not a real light-year cruise;
  short nebula phases are toy-stretched (`HII_GYR`, `PN_GYR`, `SNR_GYR`)
  so they are findable, the way `TIME_SCALE` stretches a dawn; interiors,
  plate tectonics, and **weather** are out of scope until we take them
  on as laws. Clouds are not a painted deck; aerosol opacity lives
  inside `airExtinction` / the scattering integral.

If you are about to special-case a seed, a body id, or a named planet
type: stop. Change the law. A new `if` that papers over one ugly world is
a patch. A better equation that makes that world *and* its cousins right
is the job.

---

## Causal chain (do not skip steps)

```
CANONICAL_SEED + UNIVERSE mass model (SBbc)
  → density / rotation / population (thin, thick, halo, bulge, bar)
  → star at (R, θ, z): IMF mass, birth time, [Fe/H], C/O
  → evolve(mass, age, Z) → MK class / remnant / nebula
  → disk chemistry at orbital radius (condensation sequence)
  → body inventory + bulk density + radius
  → gravity (derived: g = G_TOY · densityRel · radiusRel — never a slider)
  → Jeans escape + wind stripping → atmosphere
  → greenhouse → T_surf
  → hydrosphere phase (none / ice / liquid water / liquid methane)
  → snow capacity, sea state, palette, life odds
```

Canonical play is `objectAt` → `systemAt(galaxySeed, starId)` — a pure
function. Every occupied slot is addressable, the way No Man’s Sky
addresses a system: the id *is* the star, not an index into a stored
list. The **galaxy explorer** is how you discover: the Hubble glow
is the mass model on the GPU. Face-on, ~10⁹ stars are the integral.
As you zoom and fly, `objectsNear` resolves the massive tail of
nearby cells, then more of the IMF. You cannot pick a star until
you are close enough that it has resolved. Set course loads that
star. We **store visits only** (overlays, camera, labels). We do
not mint systems. A first landing may sample thousands of FGK hosts
near the solar circle (the home point) to find a world that already
has life — that is a query, not a catalog. Changing the grid
renumbers `starId`; old visits from the 7k-sample era are void.
`generateSystem(seed)` remains the inner assembler and a legacy bottle
for old files — it is not a player verb.

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
- Light comes from the **loaded** star at the origin. Day/night is spin
  + orbit as functions of `(spec, unix time t)` — deterministic, no
  “bake a sun behind the camera.”
- **The star is a furnace, not a sticker.** Photosphere Teff is
  Stefan–Boltzmann from L and R (`starTeff`). Limb darkening is the
  Eddington grey atmosphere. Granules, spots and flares follow the
  convective dynamo (`starActivity`); the K-corona and the wind are
  Thomson scatter of *that* photosphere’s light (`starWind`) — a blue
  star does not grow an orange halo. Inverse-square is two distances
  and one law: bodies use physics `a` (`starIrradiance`, the same `a`
  T_eq already drank); the eye uses the display stretch
  (`starEyeFlux`, referenced to `A_HAB · SPACE_SCALE`). Glare is the
  eye’s PSF on that flux, not a painted sprite. The disk draws *after*
  the sky shell so the LDR star-veil cannot filter the sun; air in
  front only multiplies the same Chapman transmittance the sky already
  computed. Knobs live in `UNIVERSE` (`STAR_*`). Renderer:
  `src/render/star.ts`.
- **The sky is the catalog.** The galaxy explorer *is* that catalog:
  a GPU raymarch of the same density / young-light / dust-lane law
  (`galaxyField.ts`) plus `objectsNear` — not a painted spiral, not a
  7k sample list. ~10⁹ stars are addressable (`objectAt`). Face-on
  they are the integral. Zooming asks nearby cells for more of their
  stratified IMF.   Distant catalog rows are tiny points of light — never
  grown `GL_POINTS` (those become squares on a phone). Inside ~7 kpc
  the nearest stars become photospheres from `evolve()` (`galaxyStar.ts`):
  teff colour, limb, remnant, nebula. We only mesh what we occupy.
  Tap a resolved disc to set course; a still-point source only selects
  or zooms. A star is pickable only when the camera is inside ~10 kpc
  of it. The in-system night shell (`buildStars`) is still unseeded and
  must retire so ground and explorer agree. A painted starfield is a lie.
- **The photograph is turbulence + a star sample, on the clock.**
  The ISM is log-normal: every smooth law in the field shader is
  multiplied by `exp(σ·fBm)` (`GALAXY_TURB_SIGMA/FREQ`). One clump
  field carries three consequences — knotted young light, Hα beads
  where a dense clump sits on the crest (Strömgren: needs gas *and*
  O stars), and fractal dust that **reddens** through per-channel
  transmittance (`GALAXY_DUST_RGB`; blue dies first, lanes go brown).
  The grain you fly through is `galaxyStarfield.ts`: ~42k true 3D
  points inverse-transform-sampled from the same density law (never
  stored, never pickable — the pickable sky stays `objectAt`).
  Dynamics: flat rotation curve `v(R) = GALAXY_V_ROT`, pattern speed
  `GALAXY_OMEGA_P`; we render in the wave's corotating frame so arms
  and addresses stand still while disk stars stream through at
  Ω(R) − Ω_p — prograde inside corotation (R_c = v/Ω_p ≈ 8.4 kpc),
  retrograde beyond, from unix time in the vertex shader. Not an
  animation loop; a clock.
- **Render distance** (the only things that “run”): one star system
  fully instantiated; one planetoid + its moons in close LOD; one
  high-res landscape. Everything else is the same laws sampled cheaper
  (points, dots, the band). At any Unix time `t` we already know where
  every star and planet is — we just do not mesh them.

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
- **Addressable universe:** `(galaxySeed, starId, bodyId, cell)` names a
  piece of ground forever. Today’s `(systemSeed, bodyId, cell)` is the
  inner tuple. That address is the contract for inspection, mining,
  bases, labels, and every other player mark. Player terrain edits are
  **absolute level overlays**, never deltas, stored sparsely.
  `effectiveLevel(cell) = override ?? generated(cell)`.
- Per-(cell, layer) **geology** (`geology.ts`) is a pure function of seed
  + crust inventory. Nothing is stored until somebody digs. Inspection
  now; mining later. Do not bake a second composition table.
- Bump `CURRENT_GEN_VERSION` in `systemgen.ts` when generator output for a
  seed would change, and keep old behaviour for systems pinned to a
  previous version.

Time: orbits, spins, and the stellar clock are pure functions of spec
and wall-clock Unix time (geared by `UNIVERSE.TIME_SCALE`). No hidden
galaxy or system simulation step that diverges from that. A star’s
phase at time `t` is `evolve(mass, age(t), Z)`.

**Music** is progressive house as a law. `src/audio/theory.ts` is the
score: ~124 BPM, four-on-the-floor, a 4-chord loop held for bars at a
time, and an 8-phase energy cycle (intro → groove → lift → peak →
break → build → drop → ride). `src/audio/dsp.ts` bakes the kit
(analog kick, 808-style metallic hats, burst clap) from those laws;
Tone.js is only the clock and the mixer. The kick ducks the pad and
bass with an exponential pump, not an LFO. Viewport mood tilts mode
and density — it does not pick a track. If the drums sound like
factory synths, the kit law is wrong.

---

## Persistence: the universe must travel

The generated universe is cheap: a seed plus a gen version. The *player’s*
universe is the seed plus a sparse overlay. Saves stay tiny because we
never store generated terrain, chemistry, or meshes.

| Stored | Regenerated |
|--------|-------------|
| `SystemMeta` (seed, genVersion, camera; later `starId`) | Galaxy catalog, stellar phase, orbits, inventories, atmospheres |
| Sparse terrain overrides `[cell, level, …]` | Hex columns, hydrology, snow line |
| Labels, objects (city / town / landmark, later bases) | Palettes, geology, sea state, stellar phase |
| Optional per-body dials (dev terraforming) | Geology at `(dir, layer)` |

**Export is first-class.** One self-contained `.tinysystem.json`
(`formatVersion: 4`, `src/store/exportImport.ts`). Import creates a new
system id and copies the overlay. A friend can load your file and stand
on the same hex of the same world. Native iOS uses the share sheet.
Older exports are **private bottles** — they are not objects placed into
the canonical galaxy. The shared sky is `objectAt(CANONICAL_SEED, id)`.

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
`(galaxySeed, starId, bodyId, cell)`, no save that cannot leave the device.

---

## Rendering laws (learned the hard way)

These are product rules, not optional polish.

### Atmosphere

- One progressive horizon: exponential air, not a planet limb + haze
  deck + rim glow as three shells. Vacuum has no scatterers. The
  visible halo is a **line**: a long tangent through the well-mixed
  lower column (`AIR_LINE` in `UNIVERSE`). At 1 atm the upper layers
  are transparent — black space shows through — and the glow does
  not fill the shell out to the boundary.
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
- **Sunglint** is Cox–Munk facet slope on the liquid (`waveSlope`,
  `UNIVERSE.WAVE_SLOPE_*`), not a painted disc. Calm / airless seas are a
  tight mirror; wind (sea-state energy) opens a glitter path elongated in
  the sun–camera plane. Apply after the air integral, mixing toward the
  sun’s colour (same order as foam) — in-scatter must not dye the sun, and
  extinction must not make the glint darker than the in-scattered sea. Ice
  has no liquid facets. From orbit, glitter raises alpha so translucency
  cannot punch space through the path.
- Keep a little of the water’s own colour at the limb so aerial
  perspective does not dissolve the sea into the sky.
- **Surf** (breaking crests, wet line, swash) must remain visible. Foam
  painted only on terrain will be buried by an opaque sea. Shoreline
  effects belong on the water in the shallows **and** on the first beach
  terrace. Do not raise the water sphere over the swash zone to hide
  poke-through. Foam is **always white**; night and shadow change its
  brightness, never its tint. Apply it after the air integral or the
  sky dyes the surf blue. On a low beach the wash is **tongues** (along-
  shore lobes of a wet sheet): foam on the rim, a lacy web inside — not
  a stripe parallel to the waterline. Cliffs still splash.
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
- Wiring the catalog into the **in-system** night-sky shader (the explorer
  already *is* the catalog; `buildStars()` in the system viewer is still
  a random shell and must retire).
- Live multiplayer. Freeze generation before anyone shares a hex live.

Player features (mining, bases, cargo) are **not** in this bucket — they
are overlays. See **Player layer**.

---

## How we change things

1. **Reproduce with a seed**, not a one-off mesh edit. Sample `objectAt`,
   land, walk, flood the sea slider. `scripts/check-galaxy.ts` is the
   catalog law; smoke scripts in `scripts/smoke-*.mjs` (Playwright against
   `localhost:5173`) exist for horizon, reflections, flood, torch, sky,
   land, etc. Use them; add one if you invent a new failure mode.
2. **Fix the law** in `physics.ts` / `galaxy.ts` / `stellar.ts` /
   `scattering.ts` / the relevant shader’s shared chunk. If you must add
   an approximation (Chapman slant, Eddington diffusion, Schlick), comment
   *why* it is the law, not a bandage. Delete patches when the law makes
   them redundant.
3. **Bump `CURRENT_GEN_VERSION`** if a given seed’s generated terrain or
   system layout would change. Player overlays stay valid because they are
   absolute cell levels.
4. **Bump export `formatVersion`** if the JSON shape changes; keep reading
   older files.
5. **Do not commit secrets.** Do not drive-by refactors. Update this file
   when the contract changes.
6. **Ship on `main`.** Commit and push directly to `main`. Do not open a
   feature-branch PR and wait. The live site (GitHub Pages) is how we
   hear and see a change; Pages only builds from `main`. A draft PR is
   an unpublished universe — that is how “the music didn’t change”
   happened. After a Pages deploy, **hard-refresh once** so the PWA
   picks up the new build.

Code map (start here):

| Area | Where |
|------|--------|
| Charter + `UNIVERSE` + body physics | `src/world/physics.ts` |
| Galaxy (SBbc field + implicit catalog) | `src/world/galaxy.ts` |
| Stellar clock (IMF, MK, remnants, nebulae) | `src/world/stellar.ts` |
| Galaxy explorer (GPU field + catalog beacons) | `src/render/galaxyField.ts`, `src/render/galaxyView.ts`, `src/ui/GalaxyExplorer.tsx` |
| Close-up photospheres (LOD from `evolve()`) | `src/render/galaxyStar.ts` |
| Star-field grain + orbital drift (corotating frame) | `src/render/galaxyStarfield.ts` |
| First landing (habitable search) | `src/world/discover.ts` |
| System / orbits / gen version | `src/world/systemgen.ts` |
| Hex columns, hydrology, snow line | `src/world/toygen.ts` |
| Palettes from physics | `src/world/toyPalette.ts` |
| Per-cell geology (mining truth) | `src/world/geology.ts` |
| Grid | `src/world/geodesic.ts` |
| Scene, camera, reflections, capture | `src/render/engine.ts` |
| Star (photosphere, corona, wind, glare) | `src/render/star.ts` |
| Terrain + water shaders, surf, foam | `src/render/terraceMesh.ts` |
| Sky shell | `src/render/atmosphere.ts` |
| Shared air integral | `src/render/scattering.ts` |
| Gas giants | `src/render/gasGiant.ts` |
| Persistence, export/import | `src/store/` |
| Generative progressive house (score + kit) | `src/audio/` |

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
