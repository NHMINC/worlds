import Dexie, { type Table } from 'dexie';
import type {
  BodyStateRecord,
  LabelRecord,
  ObjectRecord,
  SystemMeta,
  TerrainOverrideRecord,
} from '../world/types';

class WorldBuilderDB extends Dexie {
  systems!: Table<SystemMeta, string>;
  bodyState!: Table<BodyStateRecord, [string, string]>;
  terrain!: Table<TerrainOverrideRecord, [string, string]>;
  labels!: Table<LabelRecord, string>;
  objects!: Table<ObjectRecord, string>;

  constructor() {
    super('hex-world-builder');
    // Legacy eras (flat map, then single globe). Kept so old databases can
    // upgrade cleanly to v4, where the saved document becomes a star system.
    this.version(1).stores({
      worlds: 'id, updatedAt',
      edits: '[worldId+level+q+r], worldId',
      labels: 'id, worldId',
      objects: 'id, worldId',
    });
    this.version(2)
      .stores({ edits: null })
      .upgrade(async (tx) => {
        await tx.table('labels').clear();
        await tx.table('objects').clear();
      });
    this.version(3).stores({
      edits: '[worldId+cell], worldId',
    });
    // v4: the star-system pivot. Single worlds cannot be reproduced inside
    // seeded systems, so the old tables are dropped; labels/objects keep
    // their primary key but are cleared (their coordinates belonged to
    // retired worlds). Everything is now keyed by (systemId, bodyId).
    this.version(4)
      .stores({
        worlds: null,
        edits: null,
        systems: 'id, updatedAt',
        bodyState: '[systemId+bodyId], systemId',
        terrain: '[systemId+bodyId], systemId',
        labels: 'id, systemId, [systemId+bodyId]',
        objects: 'id, systemId, [systemId+bodyId]',
      })
      .upgrade(async (tx) => {
        await tx.table('labels').clear();
        await tx.table('objects').clear();
      });
  }
}

export const db = new WorldBuilderDB();

export async function deleteSystem(systemId: string): Promise<void> {
  await db.transaction('rw', [db.systems, db.bodyState, db.terrain, db.labels, db.objects], async () => {
    await db.bodyState.where('systemId').equals(systemId).delete();
    await db.terrain.where('systemId').equals(systemId).delete();
    await db.labels.where('systemId').equals(systemId).delete();
    await db.objects.where('systemId').equals(systemId).delete();
    await db.systems.delete(systemId);
  });
}

export async function touchSystem(systemId: string): Promise<void> {
  await db.systems.update(systemId, { updatedAt: Date.now() });
}
