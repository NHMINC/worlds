import { Capacitor } from '@capacitor/core';
import { db } from './db';
import { parseSystemExport, MAX_IMPORT_BYTES } from './parseExport';
import { uuid } from '../world/rng';
import type { SystemMeta } from '../world/types';

export async function buildSystemExport(systemId: string) {
  const system = await db.systems.get(systemId);
  if (!system) throw new Error('System not found');
  const bodyState = await db.bodyState.where('systemId').equals(systemId).toArray();
  const terrain = await db.terrain.where('systemId').equals(systemId).toArray();
  const labels = await db.labels.where('systemId').equals(systemId).toArray();
  const objects = await db.objects.where('systemId').equals(systemId).toArray();
  const { id: _id, ...systemRest } = system;
  return {
    formatVersion: 4 as const,
    app: 'hex-world-builder' as const,
    kind: 'system' as const,
    system: systemRest,
    bodyState: bodyState.map(({ systemId: _s, ...rest }) => rest),
    terrain: terrain.map(({ systemId: _s, ...rest }) => rest),
    labels: labels.map(({ systemId: _s, ...rest }) => rest),
    objects: objects.map(({ systemId: _s, ...rest }) => rest),
  };
}

/** Save a system to a single portable JSON file (download on web, share sheet on native). */
export async function exportSystem(systemId: string): Promise<void> {
  const data = await buildSystemExport(systemId);
  const json = JSON.stringify(data, null, 1);
  const filename = `${data.system.name.replace(/[^\w-]+/g, '_') || 'system'}.tinysystem.json`;

  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({
      path: filename,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: data.system.name, url: written.uri });
    return;
  }

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Import a system JSON file as a new system; returns the new system id. */
export async function importSystem(file: File): Promise<string> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('File is too large to import.');
  const text = await file.text();
  const data = parseSystemExport(text);
  const id = uuid();
  const system: SystemMeta = { ...data.system, id, updatedAt: Date.now() };
  await db.transaction('rw', [db.systems, db.bodyState, db.terrain, db.labels, db.objects], async () => {
    await db.systems.add(system);
    await db.bodyState.bulkAdd(data.bodyState.map((b) => ({ ...b, systemId: id })));
    await db.terrain.bulkAdd(data.terrain.map((t) => ({ ...t, systemId: id })));
    await db.labels.bulkAdd(data.labels.map((l) => ({ ...l, id: uuid(), systemId: id })));
    await db.objects.bulkAdd(data.objects.map((o) => ({ ...o, id: uuid(), systemId: id })));
  });
  return id;
}
