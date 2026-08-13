export type BiomeId =
  | 'deep'
  | 'ocean'
  | 'shallow'
  | 'beach'
  | 'wetland'
  | 'snow'
  | 'tundra'
  | 'taiga'
  | 'grassland'
  | 'steppe'
  | 'forest'
  | 'rainforest'
  | 'savanna'
  | 'desert'
  | 'mountain'
  | 'volcanic'
  | 'peak';

export interface BiomeStyle {
  name: string;
  color: string; // hex css color
}

/**
 * Saved camera. Orbit poses live in the body's spinning frame (geostationary
 * hold), so they land on the same terrain forever regardless of orbital
 * position; flight poses are world-space ship state.
 */
export type SavedCamera =
  | {
      mode: 'orbit';
      bodyId: string;
      q: [number, number, number, number];
      d: number;
      /** 'station' rides an inertial low orbit (terrain streams beneath);
       * 'geo' hangs over one spot. Older saves default to station. */
      style?: 'station' | 'geo';
    }
  | { mode: 'flight'; pos: [number, number, number]; q: [number, number, number, number] }
  | {
      mode: 'surface';
      bodyId: string;
      /** Landing spot: unit direction in the body's local frame. */
      dir: [number, number, number];
      /** Heading around the local up (0 = toward the north pole). */
      yaw: number;
      pitch: number;
      /** Hover altitude above the terrain skin, body-local units. */
      eyeH: number;
    };

/**
 * The saved document: a star system. Everything else regenerates from the
 * seed under the pinned genVersion; player changes are sparse overlays keyed
 * by (bodyId, cell) — the addressable-universe contract.
 */
export interface SystemMeta {
  id: string;
  name: string;
  seed: string;
  genVersion: number;
  createdAt: number;
  updatedAt: number;
  cam?: SavedCamera;
}

/** Per-body dials and naming, overriding the physics-derived defaults. */
export interface BodyStateRecord {
  systemId: string;
  /** Stable body address within the system: 'p3', 'p3m1'. */
  bodyId: string;
  name?: string;
  temp?: number;
  seaLevel?: number;
}

/**
 * Sculpted terrain: absolute level overrides (never deltas), packed as
 * [cell, level, cell, level, ...]. Applied after generation:
 * effectiveLevel(cell) = override ?? generated(cell).
 */
export interface TerrainOverrideRecord {
  systemId: string;
  bodyId: string;
  packed: number[];
}

export interface LabelRecord {
  id: string;
  systemId: string;
  bodyId: string;
  /** Geodesic cell on the body's data grid. */
  cell: number;
  text: string;
}

export type ObjectKind = 'city' | 'town' | 'landmark';

export interface ObjectRecord {
  id: string;
  systemId: string;
  bodyId: string;
  cell: number;
  kind: ObjectKind;
  name: string;
}

export interface SystemExport {
  formatVersion: 4;
  app: 'hex-world-builder';
  kind: 'system';
  system: Omit<SystemMeta, 'id'>;
  bodyState: Array<Omit<BodyStateRecord, 'systemId'>>;
  terrain: Array<Omit<TerrainOverrideRecord, 'systemId'>>;
  labels: Array<Omit<LabelRecord, 'systemId'>>;
  objects: Array<Omit<ObjectRecord, 'systemId'>>;
}
