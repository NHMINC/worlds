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
- **Generative music.** Progressive house from a seeded grammar: a short
  loop, four-on-the-floor, layers and filter that evolve. Tone.js performs
  it. The viewport mood tilts mode and density.

## Develop

```bash
npm install
npm run dev        # dev server
npm run build      # production build (includes PWA service worker)
npm run icons      # regenerate PNG app icons from scripts/gen-icons.mjs
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

An xAI API key in this browser's localStorage (`wb_xai_key`) unlocks name
suggestions when labeling places. Requests go directly to xAI.

## Layout

- `src/world/` — geodesic (Goldberg) grid, physics, galaxy catalog, terrain
- `src/render/` — galaxy explorer, host-pass globes, shared terrace / air / star
- `src/store/` — Dexie (IndexedDB) schema and JSON export/import
- `src/audio/` — generative ambient music
- `src/ai/` — AI provider interface with the xAI implementation
- `src/ui/` — explorer chrome, chart, inspect, marks
