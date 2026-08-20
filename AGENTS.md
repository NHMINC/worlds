# AGENTS.md

Guidance for anyone (human or agent) changing this codebase. The product
evolved in conversation; this file is the distilled contract. When it
disagrees with older comments in `README.md`, **this file and the code
win** — the README still describes an earlier realistic-globe era.

---

## What this is

A **procedural galaxy in a bottle**. One canonical seed unfolds into
the **Milky Way’s mass model** (Hubble SBbc — a thin disc, a long bar,
a boxy/peanut bulge, four mild stellar arms). Stars, remnants, and
nebulae are a cheap function of that seed plus laws. You **discover**
a star system by going there; you do not mint one. The stars in the
sky **are** that catalog.

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
> **RNG does not build the universe.**

This is a physics engine, not a catalogue of planet types or star types.
Spatial scale is real (R☉, AU, km). Time is 1:1; a live observer rate
is time-lapse on the same closed form. Hex coarseness is the remaining
toy — Godus blocks on a real-sized globe.

- **No RNG in universe construction.** Everyone in the canonical
  game must stand in the same galaxy. A star, a hex, a smudge, a
  dust filament is `f(seed, address)` — `objectAt`, `hash(seed, i, salt)`,
  a closed-form clock. Never `Math.random`, `crypto.getRandomValues`,
  `Date.now`, or a walking PRNG stream for the catalog, a system,
  terrain, geology, dust, nebulae, or the cosmic photograph. Same
  inputs, same universe, every player, every time. A `mulberry32`
  stream through `generateSystem` / `objectAt` is leftover debt:
  do not add draws; new laws hash the address. Allowed rolls live
  *outside* the universe only: a listen seed for the music (never
  the system seed), a UUID for a save row. The in-system
  `buildStars()` shell still uses `Math.random` and must retire
  so ground and explorer agree.
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
  (~`GALAXY_POPULATION`). A cell is a quota, not a brick: birth
  height is a sech² draw on the local scale (flared disk;
  spheroid inside the box/peanut), centered on the warped
  midplane — not the catalog z-bin, so edge-on is not a clipped
  slab. The core keeps the MW bulge/bar mass share as a rounded
  bump, not a brighter line and not a rectangular bar. We never
  `collectCatalog`.
  The explorer asks `objectsNear` for the volume it occupies; within
  a cell the IMF is stratified so zooming in is “include more slots,”
  not “load a bigger array.”
- **Named constants live in `UNIVERSE` (`src/world/physics.ts`).** Spatial
  scale is SI (`AU_KM`, `RSUN_KM`, `REARTH_KM`, `KPC_KM`). Time default
  is 1:1; `TIME_SCALE` is a live observer rate (time-lapse), not a hidden
  gearbox. Hex coarseness (`MAX_FINE_F`) is the remaining toy. Keep every
  compression **visible and named**. “Exaggerate within laws” (great
  sunsets, readable water) means turning a knob in `UNIVERSE` or a
  documented optical approximation, not a one-off `if (sunset) color = orange`.
- **Documented simplifications** (decreed, not hidden): metallic core and
  spin-aligned dipole on every body (a compass works); orbits are stable
  by fiat; we do not integrate an N-body galaxy for 10 Gyr (Milky Way
  density field + IMF + closed-form stellar clock instead); interstellar
  travel is warp at `GALAXY_WARP`, never clamped between the stars.
  The reticle plate only names an object inside `AIM_RANGE_KPC`
  (1 kpc). Set course is a heading hold (`ARRIVE_HOLD`): the plate
  reads Course Locked; a look drag hands the stick back. On a
  locked course warp stays warp — full rate, then `ARRIVE_WARP`
  (1/1000) inside the object's 1 ly sphere (a speed limit: if
  this step would enter the sphere the limit already applies;
  sticky — fly out before a new target or full warp). Stop at
  the fill park. No teleport. The harvest pin
  swaps for the photosphere at `STAR_REVEAL_PX` (or at
  `ARRIVE_PIN_KPC` when float32 catalog positions would hop);
  once that object is up it stays until we fly out of its
  1 ly sphere — a look drag only releases the heading;
  warp latches Stop when the disk covers `ARRIVE_FILL` of the
  vertical field. The close star draws as a second AU-scale depth
  pass over the live galaxy — the sky never bakes, blanks, or
  switches environment, and the controls never change. It does
  not open a system; landing on a world
  waits for the solar-system step; short nebula phases are toy-stretched
  (`HII_GYR`, `PN_GYR`, `SNR_GYR`) so they are findable; interiors,
  plate tectonics, and **weather** are out of scope until we take them
  on as laws. Clouds are not a painted deck; aerosol opacity lives
  inside `airExtinction` / the scattering integral. The **cosmic
  background** is the other decreed fake: we cannot mint the
  observable universe. It is SCENE CONTENT of the one galaxy
  scene — decreed content at extreme distance, not an external
  skybox: a black void (vacuum emits nothing — the tinted-night
  hue system is retired) plus distant
  galaxies (one inclined disk each — hash size, cos i, position
  angle, Hubble axis, crispness) and distant star-like pins
  (`COSMIC_STAR_*`, a dim field plus a rare bright tail). Past
  the dust box, extra distance adds nothing to a sightline, so
  the sprites draw as far-plane directions (w = 0; triangles
  never cross the camera). The warp fence keeps you off the
  photograph. Not a catalog. Not pickable. Dust filters it the
  same way it filters everything else: **every background object
  extincts its own light in its own shader** (`extinctLook`),
  exactly like a harvest star dims its own pin. Pins march per
  vertex (a point source is exact); smudges march per FRAGMENT —
  one centre-ray sample was the old leak, a 240 px disc painted
  across a lane its centre missed. A black void needs no
  filtering, so the fullscreen quad survives only as the lime
  fog look-test (drawn only when the debug knob is on).
  `extinctLook`
  is the CLOUD-COLUMN law (decreed optics, calibrated on the
  real MW): opacity is a saturating ramp of local density (fade
  floor → `GALAXY_EXTINCT_ABYSS`, contrast
  `GALAXY_EXTINCT_RAMP`) integrated along the ray in units of
  `GALAXY_EXTINCT_COL` — a column, not a crest. A typical cloud
  is a translucent reddened veil (~1 magnitude, the real
  face-on disc number); abyss-grade cores (~top 5% of bodies)
  go lightless in one crossing; overlaps add; long in-plane
  columns saturate at the cap. Honest Beer–Lambert through the
  toy-thin sheet is glass face-on (T ≈ 0.96 through a ribbon
  body) and can never silhouette a cloud; the saturating column
  can, and an eye embedded in a cloud looks out through the
  rest of it. The rim is a fade on the raw field; Beer–Lambert
  still tints it. Harvest stars march the same camera→star law
  (`extinctT`) — from inside the fog you still see what is
  close. Empty space is vacuum.

If you are about to special-case a seed, a body id, or a named planet
type: stop. Change the law. A new `if` that papers over one ugly world is
a patch. A better equation that makes that world *and* its cousins right
is the job.

---

## Causal chain (do not skip steps)

```
CANONICAL_SEED + UNIVERSE mass model (Milky Way)
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
list. The **galaxy explorer** is how you discover. The Hubble-glow
integral (an unresolved mass-model march) is retired — too
artificial and too slow; the shape of the galaxy is the harvest
itself plus the nebulae and the dust lanes.
The explorer shows the harvest: one STRATIFIED SAMPLE of the
whole population (`GALAXY_SAMPLE_N`, ~250k of ~10⁹). The IMF is
cut into mass strata (the spectral classes); each stratum gets
an equal share of the budget and is sampled by its own
deterministic systematic stride over the IMF-ordered slots —
collectors as arithmetic, no rejection, no score-keeping. A
truly uniform draw was ~85% M/L dwarfs (a dim red smudge); the
old magnitude-limited survey was 97% B stars (brightness and
temperature are one axis on the main sequence). Within a
stratum the sample stays uniform across cells, so regions keep
their true character: the O/B budget lands in the arms, the
giant budget pools in the old core, massive strata are largely
remnants because that is the clock. ZOO strata ride on top —
rare classes as survey categories (black holes, pulsars, the
living massive tail, and the GIANT BRANCH: mid-mass slots in
their post-MS window — the gold that lights the old core;
under MAX a pixel shows its brightest star, and without this
category the bulge's median star is a dim orange dwarf, a
brown core), each with a stride sized by its clock window so
it collects its budget with cheap gates instead of an
exhaustive walk. Magnitude and colour are outputs of
(mass, clock phase), so mass strata × clock windows IS the
type : magnitude : colour grid — no combinatorial table.
Quiet old NS and WDs ride the mass strata
in their honest share. The walk counts the exact population
first (one hash pass), so the count lands near
`GALAXY_SAMPLE_N` (zoo budgets add a few %). Nebulae stay
their own catalog.
The shape sample and the `HARVEST_ALL` million-pin photograph
are retired. A later survey will
resolve the faint neighbours of a camp. Set course holds the
heading on a picked star — flying there is the warp + close-
approach laws; it no longer loads a system. We **store
visits only** (overlays, camera, labels). We do
  not mint systems.   App boot mints the whole-disk backdrop once
  (`prepareUniverse`) behind the HTML “Preparing the universe”
  splash — not a React overlay, so Strict Mode remounts cannot
  flash it twice. The walk is `objectAt` in bulk: the same
  addresses via one deterministic stride — hash the address,
  never `Math.random`. The star sample visits every occupied
  cell (halo, thick disk, and bulge are population, not
  clutter); only nebula walks skip bins with no young thin
  gas. Height is finished only on keepers.
  Spokes shard across workers (every worker sees the core);
  the packed
  photograph lands in IndexedDB keyed by `VITE_BUILD_ID`
  (Pages: `github.sha`) plus seed and survey floors. Same
  build keeps the pack. A new deploy misses, drops the old
  row, and walks again. A harvest / nebula **Rebuild** also
  forgets and remints — the cache is not a lock on the knobs.
  The export JSON does not carry the photograph — a friend
  regenerates the same sky from the canonical seed. The explorer stays mounted (`is-dormant` on a
  world) so opening the map does not remint or show the splash
  again. An empty save does not write a camp: it queries nearby
  solar-circle hosts for a living world (`discoverHabitable`) and
  opens the region looking at that star. Set course no longer
  writes a visit — until the solar-system step lands, worlds open
  only from existing saves. Changing the grid renumbers `starId`;
  old visits from the 7k-sample era are void.
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

Worlds show the physics they were born with. There is no climate or sea
slider — those were a dev inspect path. `effectivePhysics` still exists
so a lawful override can re-run the pipeline; it is not a player verb.

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
  T_eq already drank, `a` in AU); the eye uses render km
  (`starEyeFlux`, referenced to `A_HAB · AU_KM`). Glare is the
  eye’s PSF on that flux, not a painted sprite. The disk draws *after*
  the sky shell so the LDR star-veil cannot filter the sun; air in
  front only multiplies the same Chapman transmittance the sky already
  computed. Knobs live in `UNIVERSE` (`STAR_*`). Renderer:
  `src/render/star.ts`.
- **The explorer is the harvest, not a magnifier ball.**
  **Cosmic engineer** (explorer bottom bar) is a dropdown of
  laws grouped by use (cosmic background, galactic dust,
  harvest survey, starlight, nebulae). Each option states what the setting
  does. Remint / rebake knobs are amber. Live photograph
  knobs already sit on the GPU (smudge brightness and count,
  background-star brightness and count, extinction, shine,
  nebula glow) — a slide is the next frame. Rebuild knobs (survey
  floors, nebula catalog, ribbon-geometry laws): the slider is a
  draft until **Rebuild** writes `UNIVERSE` and remints /
  rebakes, or **Cancel** discards. Star remint, nebula walk,
  and dust bake are three jobs — nebula knobs rebake like
  dust and do not remint the harvest. **Reset to default**
  restores the shipped law for the open setting (live: next
  frame; rebuild: a draft until Rebuild). The HTML splash
  stays gone; the explorer owns the wait. Mint and remint
  fill a progress bar from the walk itself (star rings,
  then nebulae, then the dust bake). A cache hit (same
  `VITE_BUILD_ID`) skips the walk and still bakes dust if
  needed. A new Pages SHA misses and remints. The bar is a native
  `<progress>` — Pages CSP is `style-src 'self'`, so a
  fill’s `element.style` never paints. App boot
  mints three catalogs once (`prepareUniverse`): the
  stratified star sample (`buildSilhouetteCloud` — equal budget
  per IMF mass stratum, each stratum uniform across the galaxy;
  the giants of the Hubble bump sit where the mass is old
  because that is where old slots are, not a painted core. One
  knob: Sample size, 100k–1M),
  the nebula catalog (`remintNebulaCache` — H II plus PN /
  SNR above `SILHOUETTE_NEB_GAIN`; `NEBULA_M` is that walk's
  IMF gate; host id is still `packId`), and dust as
  sightline extinction. You steer by those objects. The faint bulk
  (every adjacent dull star around a camp) is a later survey,
  not this sky. “Here” (the
  loaded star, else `homeStar`) is a **focus highlight** parked
  in front of the camera; visited samples can mark other points
  of interest. The explorer canvas stays alive after Return /
  set course; only the splash is once-per-load. An empty save
  opens the same way on a discovered living host. The camera
  sits at the viewpoint centre. Gestures **slide** through
  catalog space (1:1, no `VIEW_R` stretch).   Harvest stars are
  **point sources**: a soft device-pixel Gaussian floor (so a
  1-pixel `GL_POINTS` hop only moves the faint halo) plus the
  eye’s PSF once the wings need more room than that stamp
  (Gaussian core + Lorentzian tail — the same glare shape as
  the in-system sun). Magnitude lifts the wings with no
  bright-end cap; it does not stamp a larger disc. Pins add
  straight into the canvas under MAX compositing — a pixel is
  the brightest source covering it; light does not stack.
  (Additive summing was the blue-star killer: the harvest is
  ~97% blue B stars, but two overlapping blue halos summed to
  white per channel. Under MAX, overlap keeps the colour,
  whiteout is impossible by construction, and density reads as
  coverage. The HDR knee pass and the super-sun extra-I patch
  are retired — the magnitude law owns the whole scale.)
  The AMBASSADOR laws are the decreed stand-in for the
  unresolved sum a real photograph integrates (we cannot draw
  10⁹ stars on a phone): each sampled row carries its local
  star density (baked in the gain field) and its light scales
  with it (`HARVEST_DENS_GAIN`) — the Hubble bulge glows out of
  the density field, not a painted core — and warm rows floor
  their colour at yellow-gold (`HARVEST_HUE_FLOOR`), because
  integrated old-population light blends to gold, never a lone
  dwarf's brown. Colour is
  hue-preserving up to the channel ceiling, then OVEREXPOSES:
  light past the ceiling whitens the pixel the way a saturated
  photocell blends white — a glowing gold giant reads
  white-gold core, gold shoulder, gold halo; a dim orange dwarf
  never crosses the ceiling and stays honestly orange. A
  saturated-flat photocentre was a painted dead pixel.
  DOT + HALO, never a disc: the dot is a fixed sub-pixel
  Gaussian (a star is unresolved at any brightness); magnitude
  grows the halo's REACH, and the soft knee keeps a brightness
  gradient everywhere — no flat shelf, no rim. The magnitude zero-point
  (`HARVEST_SHINE_GAIN`) is the exposure: the survey floor is
  dim but present and brightness runs smoothly from there to
  the luminous tail — only the top of the population saturates,
  and it keeps differentiating through halo reach.
  `HARVEST_SHINE_L_P` is the steepness of that scale. A real
  PSF knows only flux — not the photosphere radius, not the
  class (the radius-widens-the-halo law is retired; a giant's
  gold is its colour and luminosity). The star row's size field
  still carries R☉ from the clock for the later close survey.
  Colour is NATURAL: the raw blackbody chromaticity (teffToRgb),
  hue-normalized only — saturation pushes distorted hue (yellow
  drifted orange) and are retired. Star shine (`uShineLGain`)
  and Magnitude contrast (`uShineLP`) are the live starlight
  knobs; the PSF wing energy is a law, not a knob (it read as a
  second brightness slider). r/d grow is a
  planet-zoom law, not this sky. **Dust is never drawn — it
  is sightline extinction** (`extinctGlsl`): `ismAt.photo` —
  hole × decline × domain-
  warped fractal fluff (`GALAXY_DUST_FREQ` is the size law,
  `GALAXY_DUST_COVER` the number law — summits pinned, so
  count moves without moving size or crest darkness; plus
  `_SWIRL` / `_DETAIL` / `_SIGMA`): a slow noise field bends the clump
  noise, so eddies curl at every angle — a turbulent ocean, no
  picked directions, no lattice axis, and NO arm term: grains
  are event debris (winds, ejecta, supernovae) scattered
  through the whole disc, not a tracer of the spiral pattern.
  Occupancy / SFR / H II keep their arm contrast — that is
  where stars form. The bake stores that
  raw photograph; the cloud carve (floor + hardness,
  `GALAXY_EXTINCT_CUT` / `_HARD` — the old bake-time dense
  cut and streak) is applied per tap in the march, so both
  are live knobs and the bake never needs a re-run to reshape
  the clouds. The sheet sits on the
  geometric midplane (`GALAXY_DUST_MID` = 0) so edge-on it
  still averages to a thin slit. `GALAXY_DUST_GRIP` is how
  tightly it hugs that plane: at 1 the scale height is
  `GALAXY_ZD_DUST` and the eddies are flattened (wider than
  tall); loosen it and the envelope opens as ZD / grip while
  the turbulence goes isotropic — the same ribbons grow long
  and project above and below the disc (the bake volume grows
  with it). `GALAXY_DUST_JITTER` corrugates the sheet: a seeded
  2D field a few clouds wide lifts and sinks the local centre,
  so each cloud carries its own altitude — with every centre
  pinned to one slice, flying through the disc met a coherent
  layer boundary (an inverse oreo). Occupancy / SFR / H II stay
  on the warped molecular sheet — star ids do not move. A
  crest is a small Gaussian splat (anti-aliasing only) —
  hardware trilinear of a lone sample is a diamond face-on.
  Starlight and the cosmic background obey the same cloud
  column (see the cosmic-background decree): a saturating ramp
  of density integrated along the sightline — typical clouds
  are ~1-magnitude veils, abyss cores black, overlaps add — and
  `GALAXY_EXTINCT_K` is the one opacity slider grading it all
  (clear at 0, full at `GALAXY_EXTINCT_K_FULL`). The old
  starlight-only binary wall is retired. Dust does not emit or
  reflect. Not harvest rows. A
  harvest star is visitable
  when you pick it; here / POIs are always pickable.
  **Face-on / Edge-on** slide the bubble so the disk diameter fills
  the screen (pole-on, or in the plane). Edge-on sits in the midplane
  — a lift turns the dust lane into a floor — and looks back at the
  origin. **Home** parks on the loaded star and pins that pose as
  the Back bookmark. **Back** restores the
  pose from before Face-on or Edge-on (or Home, if Home was tapped).
  Switching Face-on ↔ Edge-on does not overwrite the bookmark.
  The old saucer chart is retired.
  Nothing queries or rebuilds the catalog per camera move — the
  old free-flight explorer's blink / cluster / stutter / re-roll
  bug class is retired along with the raymarched field and the
  dynamic beacon system.   The render loop RESTS: the catalog is
  static, so a still camera renders nothing and rAF stops
  (every star vertex re-marches the dust column per draw —
  pure heat at rest). Motion is the universal wake (pose
  drift from input or warp). Knob writes, swaps, and a real
  resize wake explicitly. Hover, a parked Home pick, and a
  spinning focus ring do not — those markers freeze at rest.
  The bottom-bar readout says `resting` when the loop has
  stopped; GPU ms needs `EXT_disjoint_timer_query_webgl2`
  (desktop Chrome) and reads `n/a` on iOS Safari. Planets
  will live inside this scene — it must idle cold. A painted starfield is still a lie: every
  individual star drawn anywhere is an addressable catalog row.
  The in-system night shell (`buildStars`) is still unseeded and
  must retire so ground and explorer agree.
- **Explorer gestures.** The camera stays at the bubble centre.
  Fly is a **latched warp**: ↑ / W (or the **Warp** button)
  holds a fixed catalog rate; ↓ / S / **Stop** is stop.
  Past `GALAXY_WARP_LIM` (four disk radii) warp lets go
  quietly unless the nose points inward. A tap, not a hold.
  Drag looks. After a pinch, the surviving
  finger is NOT a drag — rotation resumes only with a fresh
  single-finger touch.   A/D still slide. The sight plate only locks an object inside
  `AIM_RANGE_KPC`. Set course holds the heading. Inside a host's
  1 ly sphere warp is `ARRIVE_WARP` (1/1000) of the cruise
  (sticky — fly out before a new target or full warp). A locked
  course stops at the `ARRIVE_FILL` park. Stars you are not
  aiming at never slow the ship.
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

Time: orbits, spins, day/night, and the sea (waves, foam, render-tide)
are `f(spec, t)` with `t` Unix seconds at rate `TIME_SCALE` (default 1
— a real day, a real year). Raise the observer rate to time-lapse the
same law. The galaxy age is a constant; stellar phase does not tick
during play. No hidden simulation step. A star’s catalog phase is
`evolve(mass, age, Z)`.

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

We are in **prototype mode**. The job is to iterate on procedural
ideas. Scaffolding consistency is not important. A 30-minute
mint-and-check loop is how ideas die.

**There is no test suite.** Do not write `scripts/check-*`,
`scripts/smoke-*`, Playwright walks, invariant harnesses, or
“prove it” harvest mints. Do not run leftovers if you find them.
The owner looks at the live sky and says what works.

If you need a number (a count, a density at R), write a throwaway
script, read the number, **delete the script before you commit**.
Do not leave diagnostics in the tree.

These universes are still delicate. A need to fix something in one
area is not a licence to adjust something in another. One law, one
knob family. Leave the rest of the bottle alone.

1. **Change the law** in `physics.ts` / `galaxy.ts` / `stellar.ts` /
   `scattering.ts` / the relevant shader’s shared chunk. If you must
   add an approximation (Chapman slant, Eddington diffusion, Schlick),
   comment *why* it is the law, not a bandage. Do not reach for
   `Math.random` or a new `mulberry32` stream to build the world.
2. **Bump `CURRENT_GEN_VERSION`** if a given seed’s generated terrain
   or system layout would change. Player overlays stay valid because
   they are absolute cell levels.
3. **Bump export `formatVersion`** if the JSON shape changes; keep
   reading older files.
4. **Do not commit secrets.** Update this file when the contract
   changes. Do not invent a test to replace a look.
5. **Ship on `main`.** This is a solo project. Work on `main`.
   **Commit and `git push origin main`.** No feature branches, no
   pull requests, no merge step. The live app (GitHub Pages,
   `https://nhminc.github.io/worlds/`) only builds from `main`;
   that is the only way the owner can look.
   **`origin/main` is not the live sky.** The `pages` workflow
   (`.github/workflows/pages.yml`) must go **green for that push
   SHA**. The only gate is the production build (`tsc -b && vite
   build`) — a red deploy means they are still on the previous
   universe. Then tell the owner to **hard-refresh once** so the
   PWA drops the previous worker, and **stop**. The next look is
   theirs.
   Other agents may land on `main` while you work. `git fetch
   origin main` before you push; if the remote moved, pull (do
   not rebase away, do not force-push `main`).

## Cursor Cloud specific instructions

- Work on `main`. Commit and push `origin main`. Do not open a
  PR. Do not create a `cursor/*` branch for the owner.
- Do not run or restore `scripts/check-*` / `scripts/smoke-*`.
- Do not stand up Playwright, computerUse walkthroughs, or a
  harvest mint to verify a visual change. The owner looks at Pages.
- On-the-spot diagnostics are allowed. Delete them before commit.
- After Pages is green, stop and wait for the owner.

Code map (start here):

| Area | Where |
|------|--------|
| Charter + `UNIVERSE` + body physics | `src/world/physics.ts` |
| Galaxy (MW field + implicit catalog) | `src/world/galaxy.ts` |
| Stellar clock (IMF, MK, remnants, nebulae) | `src/world/stellar.ts` |
| Sector tessellation + region cloud | `src/world/sectors.ts` |
| Nebula shape law (backdrop + local) | `src/world/skyShape.ts` |
| ISM fog (gas field → extinction volume) | `src/world/dustVolume.ts` |
| Galaxy explorer (stars + nebulae + dust + cosmic shell) | `src/render/galaxyView.ts`, `src/ui/GalaxyExplorer.tsx` |
| Cosmic background (decreed outer shell) | `src/render/cosmicBg.ts` |
| Universe boot (once-per-load backdrop) | `src/world/universePrep.ts` |
| Packed harvest cache (IDB, not the export) | `src/store/harvestCache.ts` |
| Region point size / brightness law | `src/render/galaxyStar.ts` |
| First look (habitable search) | `src/world/discover.ts` |
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
| Live site (Pages from `main`) | `.github/workflows/pages.yml` → `https://nhminc.github.io/worlds/` |

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
precip, etc.) and fix **that**. Do not retune an unrelated constant
because the first look did not land. Ship the fix; the owner looks.
