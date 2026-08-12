# Hex Worlds

A calm, local-first world builder. A true spinning globe tiled with a
honeycomb you can orbit freely and zoom from whole-planet view down to
individual hexes, painting biomes and naming places as you go — with a
generative ambient soundtrack that reacts to what's on screen.

## How it works

- **Procedural first.** Every world is generated deterministically from its
  seed directly on the sphere. Tectonic plates carry continental or
  oceanic crust and interact by type — collision fold belts, subduction
  cordilleras with offshore trenches, island arcs, mid-ocean ridges,
  rift valleys. On top of that: continental shelves and abyssal plains,
  hotspot volcano chains (with the occasional mega shield volcano), ancient
  impact craters that flood into circular seas or fade to ghost rings,
  meandering megacanyons, and an Earth-style climate — ITCZ rains,
  subtropical desert belts, rain shadows behind upwind mountains, polar
  pack ice. Seventeen biomes result, from mangrove wetlands and dry
  steppes to basalt lava fields around active volcanoes. Per-seed personality (land coverage, mountain vigor, volcanism,
  cratering, moisture) means ocean worlds, pangeas, cratered relics and
  volcanic worlds all happen. Nothing generated is ever stored, so saves
  stay tiny.
- **A real globe.** The sphere is tiled as a Goldberg polyhedron — a
  subdivided icosahedron's dual — giving 256,002 near-uniform hexagons (plus
  exactly 12 pentagons hiding at the old icosahedron corners). The planet
  renders as 20 face chunks with per-cell colors filled progressively in
  time-sliced batches over a fast coarse backdrop, so spinning and zooming
  never hitch. A free trackball camera with inertia orbits in any
  orientation; a compass button swings north back up. Water color follows
  depth and land color follows altitude up to snow caps, under a soft
  atmosphere rim.
- **Edits are sparse overrides.** Painting a hex stores one record keyed by
  its cell id. Labels and markers are plain records too, anchored to cells
  and projected onto the globe (they slide over the horizon with it).
- **Portable saves.** Everything lives in IndexedDB and exports as a single
  self-contained JSON file. Each world records the generator version it was
  created with, so future algorithm changes never reshape old worlds.
- **Generative music.** Tone.js synthesizes an endless seeded soundscape; the
  biome mix in the viewport picks the scale flavor, zoom depth sets density.

## Develop

```bash
npm install
npm run dev        # dev server
npm run build      # production build (includes PWA service worker)
npm run icons      # regenerate PNG app icons from scripts/gen-icons.mjs
npm run worlds     # render sample worlds to previews/*.png for generator tuning
npx tsx scripts/check-geodesic.ts   # sanity-check the geodesic grid math
```

The preview renderer still draws flat equirectangular maps — that projection
is the quickest way to eyeball a whole planet while tuning the generator, and
it samples the exact same spherical terrain the globe shows.

## Mobile (Capacitor)

The same build runs as a native iOS app:

```bash
npm run ios        # build web, sync into ios/, open Xcode
```

Requires Xcode and CocoaPods. On device, JSON export goes through the native
share sheet instead of a download.

## AI naming (optional)

Add an xAI API key in Settings to get name suggestions when labeling places.
The key is stored only in this browser's localStorage and requests go directly
to xAI.

## Layout

- `src/world/` — geodesic (Goldberg) grid, seeded RNG, terrain generator, biome palettes
- `src/render/` — Three.js engine: globe chunks, trackball camera, picking, painting
- `src/store/` — Dexie (IndexedDB) schema and JSON export/import
- `src/audio/` — generative ambient music
- `src/ai/` — AI provider interface with the xAI implementation
- `src/ui/` — React toolbar, palette, dialogs, label overlay
