# Galaxy look — experiment brief

Working notes from scanning Three.js / AI enthusiast galaxies, then
reading our explorer against them. **Not a contract.** The charter
stays in `AGENTS.md`. Use this when we want to *try a look* without
forgetting what we already have, or copying a painted spiral.

One law family per try. Live knobs first. Rebuild only if the knob
is already a remint / rebake. The owner looks at Pages. No harvest
mint scripts, no Playwright.

---

## What we already have

Do not re-learn these. They are the bottle.

| Layer | Law | Where |
|---|---|---|
| **Shape** | Thin + thick sech², broken exponential, bar / box / peanut, 4+2 log arms, flare, warp, corrugation. Occupancy is `density × volume × N_K`. | `galaxy.ts` `densityParts`, `UNIVERSE.GALAXY_*` |
| **Stars** | Harvest = hot tail (`SILHOUETTE_M` / `_L`) + old-clock giants (`SILHOUETTE_GIANT_*`). Colour is Teff (Tanner–Helland). Point = device-px Gaussian + CSS PSF (Gaussian core + Lorentzian tail). `I/(1+I)` so hue survives. Super-suns add wing, not a disc. | `galaxyStar.ts`, harvest vertex/frag in `galaxyView.ts` |
| **Stellar types** | `evolve(mass, age, Z)`. H II only if O/B + young + `inArm`. PN/SNR are death windows. Giants sit where the mass is old. | `stellar.ts` |
| **Dust** | Never drawn. Sightline extinction: baked `ismAt.photo` (hole × decline × mild arm × domain-warped fluff), Beer–Lambert `exp(−τ · DUST_RGB)`, wall cores. Midplane `DUST_MID = 0` so edge-on is a slit. | `extinctGlsl`, `dustVolume.ts` |
| **Nebulae** | Own catalog. Raymarched shells; brightness is emission measure (ρ²). Line spectrum by ionization: [O III] teal / Hα pink / [S II] red. Screen blend (`dest + src·(1−dest)`), not additive white. | `skyShape.ts` `emissionLook` / `nebRho`, `STAR_FRAG` pass 1 |
| **Far sky** | Clip-quad void + inclined-disk smudges + hash pins. Not a catalog. | `cosmicBg.ts` |

Retired on purpose: the saucer chart (`galaxySectors.ts` still has the
old tile-colour paint — do not revive it), `HARVEST_ALL` million pins,
drawing dust as points.

The charter already says face-on ~10⁹ stars **are the integral**. We
do not draw that integral yet. We draw the harvest pins and let dust
subtract. That gap is the main thing the prettier bottles still have.

---

## How they get their look

### Shape

**Stellata / OpenSpace / Gaia Sky — the unresolved mass glows.**
They raymarch (or billboard) a density volume so the disk and bulge
have surface brightness even where no pin is drawn. Stellata solves
`density0` so the proxy volumes integrate to Bland-Hawthorn & Gerhard
`M_V = −21.37`, with light B/T from an old metal-rich bulge (BC03),
not the mass B/T (Licquia ~0.15). They **deliberately skip** spiral
overdensity on that volume — a smooth band plus 32-step march was
enough; extra spatial frequency aliased. OpenSpace uses a baked NAOJ
N-body+hydro cube (1024×1024×128). Gaia Sky splits STAR / GAS / H II /
DUST / BULGE into channels (high-res stars+H II, ~4× fewer pixels on
gas+dust).

**galaxy-explorer — a density-wave point cloud + a gas plane.**
~85k points on 4 arms. `radPow = 0.72` piles them inward. Even arms
are major; odd arms × `minorDim = 0.42`. Thickness tapers with radius
(we **flare** — do not copy their taper). 80% of points sit in ~N/200
gaussian knots (associations); 20% are a diffuse field. The spiral
**meanders**: two low-freq fBm fields bend the arm angle so it is not
a snail. A **radial hole** clears the bulge, peak just outside, then
a long fade.

**MEI / Hu B / Ysaneya — occupancy, not paint.**
Density sum (bulge + bar + disk × arms + halo). Ysaneya’s octree keeps
rare bright stars in large cubes and only mints dwarfs near the camera
— the same job as our IMF floors. Hu B uses de Vaucouleurs +
Ringermacher–Mead log spirals so arms join a bar.

### Colour

**The warm-core / cool-arm photograph** (Journey, Akella, galaxy-explorer):
lerp `#ffcf8a` → `#86acec` (or cream → magenta-violet → azure) by
radius, then sprinkle 0.3% yellow “giants” and pink H II on major arms.
That is a tint. The *look* they want is real: old K light in the
bulge, young O/B in the gas. Ours is supposed to **emerge** from the
giant harvest + hot tail. If the core is too blue, the giant floor or
shine is wrong — do not add `inside` / `outside` uniforms.

**Stellata’s check, not a tint:** integrated MW `B−V ≈ 0.73`. A
luminosity-weighted glow should land near that, not be painted to it.

**Our harvest** already pushes Teff off grey (`HARVEST_SHINE_SAT =
2.7`) and bleaches only the photocentre of a very bright row.

**Nebula lines** we already have. They paint rose↔periwinkle patches
on a plane; we stratify [O III] / Hα / [S II] by radius and age.

### Nebula and gas

**Their big visual win:** gas is a **continuous midplane shader
field**, not sprites. galaxy-explorer: one disc plane, fBm + Worley,
coverage remap (crisp wisps, dark gaps), detail erosion (torn edges),
domain-warped spiral, faint inter-arm haze, darker lanes, H II as a
colour mix on the same shape, cores `pow(clump, exp)` that emit in
the local hue then bleach at the peak. Additive + UnrealBloomPass.

**We refused bloom** (it made white discs). Screen-blend + `I/(1+I)`
stay. Dust stays a **filter**, not a coloured plane.

**Lawful cousin of their gas plane:** a faint **ionized-sheet /
SFR glow** — emission measure on the molecular field where the clock
says young massive stars, same line palette as the nebula catalog.
Not drawing dust. Not a radius lerp. New pass, nebula family.

**Gaia Sky** drawing a DUST channel is the thing we retired. Do not
bring it back.

### Stellar type placement

| Them | Us |
|---|---|
| Journey: `branchAngle + r·spin + Math.random` | Address hash + density. No stream. |
| explorer: 0.3% yellow everywhere; H II only on major arms | Giants where mass is old; H II where O/B + young + `inArm` |
| Ysaneya octree LOD | `SILHOUETTE_*` floors + later faint survey |
| Stellata: published catalog only | Implicit `objectAt` |
| MEI: `hash(cell) < f(density)` | Occupancy quota; leftover `mulberry32` is debt |

If arms look too smooth, the gas/SFR/H II laws are weak — do not mint
cluster centres with `Math.random`.

---

## Ranked tries (one family each)

### 1. Hubble glow — highest leverage

**Symptom:** face-on is a pin field; the prettier bottles have a
filled disk and a rounded bulge.

**Law:** GPU integral of `densityParts` (or a luminosity-weighted mix:
old bulge/bar → K, young thin → B). Same catalog frame. Dust extincts
this pass the way it extincts stars. Screen-blend like nebulae.

**Not:** revive `galaxySectors.ts`. Not a texture. Stellata’s lesson:
keep the glow **smooth**; do not stamp spiral overdensity on it (arms
already live in the harvest + H II + dust lanes).

**Knobs (new family, if we take this on):** `GLOW_*` — gain, steps,
population mix. Live after the first bake if it is a volume; rebuild
if it is a mesh we should not add.

**Check:** face-on reads as an SBbc without counting pins. Edge-on is
a slit + peanut, not a brick. Integrated colour near `B−V ~ 0.73`,
not gold paint.

### 2. Unresolved SFR / ionized sheet

**Symptom:** arms have stars but no pink/teal gas wrap; their plane
looks “alive.”

**Law:** faint emission measure on `gasBase` × young-clock / SFR,
same [O III] / Hα / [S II] mix. Host H II shells stay the catalog.
This is the sheet those shells sit in.

**Not:** drawing `ismAt.photo`. Not cream→blue by radius.

**Knobs:** nebula family — `NEB_EMISSION` already exists; a sheet gain
would sit next to it. Rebake like nebulae / dust, do not remint stars.

### 3. Dust photograph: coverage + erosion (existing knobs)

**Symptom:** lanes are a carpet, a snake, or diamonds; their wisps
have dark windows.

**Law we already have:** `EXTINCT_CUT`, `EXTINCT_HARD`, `EXTINCT_WALL`,
`DUST_SIGMA`, `DUST_DETAIL`, `DUST_DENSE_CUT`, `DUST_FREQ` / `_SWIRL`.
Their “coverage remap + erosion” is this: raise the cut, harden the
core, keep the wall.

**Try live first** (cosmic engineer → galactic dust). One photograph
family. Do not grow the sheet.

### 4. Four-plus-two arm contrast (existing knobs)

**Symptom:** arms equally loud; they dim minor arms to ~0.42.

**Law:** `GALAXY_ARM_A` (4-arm, 0.2) vs `GALAXY_ARM_A2` (2-arm, 0.1),
and `GALAXY_GAS_ARM_A` (0.7) / `GALAXY_DUST_ARM` (0.18). Gas should
carry more contrast than stars — already decreed.

**Rebuild** (ribbon / occupancy-adjacent). Star ids must not move;
if a slide would, it is the wrong knob.

### 5. Giant-branch exposure (existing knobs)

**Symptom:** core is a hole, or only blue O stars.

**Law:** `SILHOUETTE_GIANT_M` / `_L` and harvest shine. Those K giants
**are** the Hubble bump. Do not tint the core.

**Rebuild** the harvest. Count is the floors’ outcome.

### 6. Dust-only spiral meander

**Symptom:** lanes look like a plotted log spiral.

**Law:** domain-warp the **photograph** arm hint (`DUST_SWIRL` already
bends clump noise). A small warp on dust *phase* (not `stellarArm`)
would meander lanes. Occupancy / SFR / star ids stay on the unwarped
sheet.

**Rebuild** dust only.

---

## Do not try

- `Math.random` / `mulberry32` clusters, Journey branch-spirals, Akella layers
- `inside` / `outside` colour uniforms, radius colour lerps
- `UnrealBloomPass` or additive stacking that whites the midplane
- Drawing dust as points, a coloured plane, or a Gaia Sky DUST channel
- N-body / WebGPU particle toys / octree addressing
- HYG / Gaia as the galaxy (Stellata’s job, not ours)
- Restoring the saucer mesh
- Changing harvest floors *and* dust *and* nebulae in one push
- Touching in-system `buildStars()`, worlds, or music to “help” the sky

---

## How to run a try

1. Name the failed law in one sentence (e.g. “face-on has no integral”).
2. Pick **one** row from the ranked list.
3. Prefer a live cosmic-engineer slide. Rebuild only if that family
   already remints / rebakes.
4. Ship on `main`. Hard-refresh. Stop. The next look is the owner’s.

If a try needs a new `UNIVERSE` family, add the knobs and the engineer
copy in the same change. Do not leave an undocumented fudge in a shader.
