/**
 * Strict allowlist parser for `.tinysystem.json` imports.
 * Unknown keys are dropped; prototype-polluting keys are rejected.
 */
import type {
  BodyStateRecord,
  LabelRecord,
  LastPlace,
  ObjectKind,
  ObjectRecord,
  SavedCamera,
  SystemMeta,
  TerrainOverrideRecord,
} from '../world/types';
import { isLastPlace } from './place';

export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_NAME = 200;
const MAX_SEED = 200;
const MAX_LABEL = 500;
const MAX_BODY_ID = 16;
const MAX_BODIES = 128;
const MAX_LABELS = 5_000;
const MAX_OBJECTS = 5_000;
const MAX_PACKED = 200_000;
const MAX_LEVEL = 30;
const MAX_CELL = 200_000;
const BODY_ID = /^p\d{1,2}(m\d{1,2})?$/;
const OBJECT_KINDS = new Set<ObjectKind>(['city', 'town', 'landmark']);

const UNRECOGNIZED =
  'Not a recognizable star-system file (single-world files from older versions cannot be imported).';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(msg);
}

function str(v: unknown, label: string, max: number): string {
  if (typeof v !== 'string') fail(`Invalid ${label}.`);
  if (v.length > max) fail(`${label} is too long.`);
  return v;
}

function finite(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`Invalid ${label}.`);
  return v;
}

function int(v: unknown, label: string): number {
  const n = finite(v, label);
  if (!Number.isInteger(n)) fail(`Invalid ${label}.`);
  return n;
}

function optionalFinite(v: unknown, label: string): number | undefined {
  if (v === undefined) return undefined;
  return finite(v, label);
}

function bodyId(v: unknown): string {
  const id = str(v, 'body id', MAX_BODY_ID);
  if (!BODY_ID.test(id)) fail('Invalid body id.');
  return id;
}

function tuple(v: unknown, n: number, label: string): number[] {
  if (!Array.isArray(v) || v.length !== n) fail(`Invalid ${label}.`);
  return v.map((x, i) => finite(x, `${label}[${i}]`));
}

function parseCamera(v: unknown): SavedCamera | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v) || typeof v.mode !== 'string') fail('Invalid camera.');
  if (v.mode === 'orbit') {
    const q = tuple(v.q, 4, 'camera.q') as [number, number, number, number];
    const style = v.style;
    if (style !== undefined && style !== 'station' && style !== 'geo') fail('Invalid camera.');
    const d = finite(v.d, 'camera.d');
    if (d <= 0 || d > 1e6) fail('Invalid camera.');
    return { mode: 'orbit', bodyId: bodyId(v.bodyId), q, d, ...(style ? { style } : {}) };
  }
  if (v.mode === 'flight') {
    return {
      mode: 'flight',
      pos: tuple(v.pos, 3, 'camera.pos') as [number, number, number],
      q: tuple(v.q, 4, 'camera.q') as [number, number, number, number],
    };
  }
  if (v.mode === 'surface') {
    const dir = tuple(v.dir, 3, 'camera.dir') as [number, number, number];
    if (dir.every((c) => c === 0)) fail('Invalid camera.');
    const eyeH = finite(v.eyeH, 'camera.eyeH');
    if (eyeH < 0 || eyeH > 1e6) fail('Invalid camera.');
    return {
      mode: 'surface',
      bodyId: bodyId(v.bodyId),
      dir,
      yaw: finite(v.yaw, 'camera.yaw'),
      pitch: finite(v.pitch, 'camera.pitch'),
      eyeH,
    };
  }
  fail('Invalid camera.');
}

function parseSystem(v: unknown): Omit<SystemMeta, 'id'> {
  if (!isRecord(v)) fail(UNRECOGNIZED);
  const genVersion = int(v.genVersion, 'generation version');
  if (genVersion < 1 || genVersion > 10_000) fail('Invalid generation version.');
  const createdAt = finite(v.createdAt, 'createdAt');
  const updatedAt = finite(v.updatedAt, 'updatedAt');
  const seed = str(v.seed, 'seed', MAX_SEED);
  if (!seed) fail('Invalid seed.');
  const name = str(v.name, 'name', MAX_NAME);
  if (!name) fail('Invalid name.');
  const cam = parseCamera(v.cam);
  return {
    name,
    seed,
    genVersion,
    createdAt,
    updatedAt,
    ...(cam ? { cam } : {}),
  };
}

function parseBodyState(v: unknown): Omit<BodyStateRecord, 'systemId'> {
  if (!isRecord(v)) fail('Invalid body state.');
  const temp = optionalFinite(v.temp, 'temperature');
  const seaLevel = optionalFinite(v.seaLevel, 'sea level');
  if (temp !== undefined && (temp < -10 || temp > 10)) fail('Invalid temperature.');
  if (seaLevel !== undefined && (seaLevel < -10 || seaLevel > 10)) fail('Invalid sea level.');
  const name = v.name === undefined ? undefined : str(v.name, 'body name', MAX_NAME);
  return {
    bodyId: bodyId(v.bodyId),
    ...(name ? { name } : {}),
    ...(temp !== undefined ? { temp } : {}),
    ...(seaLevel !== undefined ? { seaLevel } : {}),
  };
}

function parseTerrain(v: unknown): Omit<TerrainOverrideRecord, 'systemId'> {
  if (!isRecord(v)) fail('Invalid terrain.');
  if (!Array.isArray(v.packed) || v.packed.length > MAX_PACKED || v.packed.length % 2 !== 0) {
    fail('Invalid terrain.');
  }
  const packed: number[] = [];
  for (let i = 0; i < v.packed.length; i += 2) {
    const cell = int(v.packed[i], 'terrain cell');
    const level = int(v.packed[i + 1], 'terrain level');
    if (cell < 0 || cell > MAX_CELL || level < 0 || level > MAX_LEVEL) fail('Invalid terrain.');
    packed.push(cell, level);
  }
  return { bodyId: bodyId(v.bodyId), packed };
}

function parseLabel(v: unknown): Omit<LabelRecord, 'systemId' | 'id'> {
  if (!isRecord(v)) fail('Invalid label.');
  const cell = int(v.cell, 'label cell');
  if (cell < 0 || cell > MAX_CELL) fail('Invalid label.');
  const text = str(v.text, 'label', MAX_LABEL);
  if (!text) fail('Invalid label.');
  return { bodyId: bodyId(v.bodyId), cell, text };
}

function parseObject(v: unknown): Omit<ObjectRecord, 'systemId' | 'id'> {
  if (!isRecord(v)) fail('Invalid object.');
  if (typeof v.kind !== 'string' || !OBJECT_KINDS.has(v.kind as ObjectKind)) fail('Invalid object.');
  const cell = int(v.cell, 'object cell');
  if (cell < 0 || cell > MAX_CELL) fail('Invalid object.');
  const name = str(v.name, 'object name', MAX_NAME);
  if (!name) fail('Invalid object.');
  return { bodyId: bodyId(v.bodyId), cell, kind: v.kind as ObjectKind, name };
}

function uniqueBodyIds(rows: Array<{ bodyId: string }>, label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.bodyId)) fail(`Duplicate ${label}.`);
    seen.add(row.bodyId);
  }
}

function parseArray<T>(v: unknown, max: number, label: string, item: (x: unknown) => T): T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) fail(`Invalid ${label}.`);
  return v.map(item);
}

/** Allowlisted import document. Label/object ids are discarded and reissued. */
export interface ParsedSystemExport {
  formatVersion: 4 | 5;
  app: 'hex-world-builder';
  kind: 'system';
  system: Omit<SystemMeta, 'id'>;
  bodyState: Array<Omit<BodyStateRecord, 'systemId'>>;
  terrain: Array<Omit<TerrainOverrideRecord, 'systemId'>>;
  labels: Array<Omit<LabelRecord, 'systemId' | 'id'>>;
  objects: Array<Omit<ObjectRecord, 'systemId' | 'id'>>;
  place?: LastPlace;
}

/** Parse and allowlist a system export. Throws on anything unexpected. */
export function parseSystemExport(text: string): ParsedSystemExport {
  if (text.length > MAX_IMPORT_BYTES) fail('File is too large to import.');
  let raw: unknown;
  try {
    raw = JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail(UNRECOGNIZED);
      return value;
    });
  } catch (err) {
    if (err instanceof Error && err.message === UNRECOGNIZED) throw err;
    fail(UNRECOGNIZED);
  }
  if (
    !isRecord(raw) ||
    raw.app !== 'hex-world-builder' ||
    raw.kind !== 'system' ||
    (raw.formatVersion !== 4 && raw.formatVersion !== 5)
  ) {
    fail(UNRECOGNIZED);
  }
  const system = parseSystem(raw.system);
  const bodyState = parseArray(raw.bodyState, MAX_BODIES, 'body state', parseBodyState);
  const terrain = parseArray(raw.terrain, MAX_BODIES, 'terrain', parseTerrain);
  uniqueBodyIds(bodyState, 'body state');
  uniqueBodyIds(terrain, 'terrain');
  let place: LastPlace | undefined;
  if (raw.place !== undefined) {
    if (!isLastPlace(raw.place)) fail('Invalid place.');
    place = raw.place;
  }
  return {
    formatVersion: raw.formatVersion === 5 ? 5 : 4,
    app: 'hex-world-builder',
    kind: 'system',
    system,
    bodyState,
    terrain,
    labels: parseArray(raw.labels, MAX_LABELS, 'labels', parseLabel),
    objects: parseArray(raw.objects, MAX_OBJECTS, 'objects', parseObject),
    place,
  };
}
