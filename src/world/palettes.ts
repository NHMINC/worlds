import type { BiomeId, BiomeStyle } from './types';

/**
 * Biome name/color table for the UI (place dialogs, AI naming context).
 * The toy renderer colors terrain purely from onion levels — see
 * toyPalette.ts — so these are labels, not the world's look.
 */
export interface WorldPalette {
  biomes: Record<BiomeId, BiomeStyle>;
}

export const PALETTE: WorldPalette = {
  biomes: {
    deep: { name: 'Deep Ocean', color: '#1e7fb8' },
    ocean: { name: 'Ocean', color: '#2a9bc4' },
    shallow: { name: 'Lagoon', color: '#52dcd4' },
    beach: { name: 'Beach', color: '#f6ecb8' },
    wetland: { name: 'Wetland', color: '#4c7a58' },
    snow: { name: 'Snowfield', color: '#f8fbff' },
    tundra: { name: 'Tundra', color: '#999c79' },
    taiga: { name: 'Taiga', color: '#3d6647' },
    grassland: { name: 'Grassland', color: '#7ed36e' },
    steppe: { name: 'Steppe', color: '#b0a26a' },
    forest: { name: 'Forest', color: '#33a45a' },
    rainforest: { name: 'Rainforest', color: '#2c8a52' },
    savanna: { name: 'Savanna', color: '#bd9f5c' },
    desert: { name: 'Desert', color: '#d7b678' },
    mountain: { name: 'Mountains', color: '#9b9179' },
    volcanic: { name: 'Volcanic Rock', color: '#57493f' },
    peak: { name: 'Peaks', color: '#f0efeb' },
  },
};
