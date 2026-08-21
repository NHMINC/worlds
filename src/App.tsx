import { useEffect, useState } from 'react';
import { db, deleteSystem } from './store/db';
import { exportSystem, importSystem } from './store/exportImport';
import { objectAt } from './world/galaxy';
import { discoverHabitable } from './world/discover';
import { hideUniverseSplash, prepareUniverse } from './world/universePrep';
import { UNIVERSE } from './world/physics';
import type { LastPlace, SystemMeta } from './world/types';
import { getPlace, placeFromVisit, putPlace } from './store/place';
import { listVisits, upsertVisit, visitAlive, visitByStar } from './store/visits';
import { GalaxyExplorer, type ExplorerGo } from './ui/GalaxyExplorer';
import { SystemManager } from './ui/SystemManager';

export default function App() {
  const [systems, setSystems] = useState<SystemMeta[]>([]);
  const [system, setSystem] = useState<SystemMeta | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [lookStarId, setLookStarId] = useState<number | null>(null);
  const [camp, setCamp] = useState<LastPlace | null>(null);
  const [campReady, setCampReady] = useState(false);
  const [go, setGo] = useState<ExplorerGo | null>(null);

  useEffect(() => {
    void boot();
  }, []);

  function placeAlive(p: LastPlace | null): LastPlace | null {
    if (!p) return null;
    const seed = p.galaxySeed || UNIVERSE.CANONICAL_SEED;
    if (objectAt(seed, p.starId) == null) return null;
    return p;
  }

  async function openFreshGalaxy(travel = false): Promise<void> {
    const start = discoverHabitable();
    setLookStarId(start.starId);
    setCamp(null);
    setSystem(null);
    if (travel) setGo({ key: Date.now(), starId: start.starId, place: null });
    setCampReady(true);
  }

  async function openCamp(place: LastPlace): Promise<void> {
    setLookStarId(place.starId);
    setCamp(place);
    setSystem((await visitByStar(place.starId, place.galaxySeed)) ?? null);
    setCampReady(true);
  }

  async function boot(): Promise<void> {
    const prep = prepareUniverse();
    const raw = await db.systems.orderBy('updatedAt').reverse().toArray();
    for (const s of raw) {
      if (s.starId != null && !visitAlive(s)) await deleteSystem(s.id);
    }
    const list = await listVisits();
    setSystems(list);
    await prep;
    const saved = placeAlive(await getPlace());
    const fromVisit = saved ?? placeAlive(list[0] ? placeFromVisit(list[0]) : null);
    if (fromVisit) await openCamp(fromVisit);
    else await openFreshGalaxy();
    hideUniverseSplash();
  }

  function handlePlace(p: LastPlace): void {
    setCamp(p);
    setLookStarId(p.starId);
    void putPlace(p);
    void upsertVisit(p).then((row) => {
      if (!row) return;
      setSystem((cur) => (cur?.id === row.id ? cur : row));
      void listVisits().then(setSystems);
    });
  }

  function travelTo(place: LastPlace): void {
    setLookStarId(place.starId);
    setCamp(place);
    setGo({ key: Date.now(), starId: place.starId, place });
  }

  async function openVisit(id: string): Promise<void> {
    const s = await db.systems.get(id);
    if (!s || s.starId == null || !visitAlive(s)) return;
    const saved = placeAlive(await getPlace());
    const dest =
      saved && saved.starId === s.starId ? saved : placeAlive(placeFromVisit(s));
    if (!dest) return;
    setSystem(s);
    travelTo(dest);
    setManagerOpen(false);
  }

  async function handleDelete(id: string): Promise<void> {
    await deleteSystem(id);
    const list = await listVisits();
    setSystems(list);
    if (system?.id !== id) return;
    if (list[0]) await openVisit(list[0].id);
    else await openFreshGalaxy(true);
  }

  async function handleImport(file: File): Promise<void> {
    try {
      const id = await importSystem(file);
      setSystems(await listVisits());
      await openVisit(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Import failed');
    }
  }

  return (
    <div className="app">
      {campReady && (
        <GalaxyExplorer
          hereStarId={lookStarId ?? camp?.starId ?? system?.starId}
          visitedStarIds={systems.map((s) => s.starId).filter((id): id is number => id != null)}
          resume={camp}
          go={go}
          onPlace={handlePlace}
          onOpenVisits={() => setManagerOpen(true)}
          visitId={system?.id ?? null}
        />
      )}

      {managerOpen && (
        <SystemManager
          systems={systems}
          currentId={system?.id ?? null}
          onOpen={(id) => void openVisit(id)}
          onDelete={(id) => void handleDelete(id)}
          onExport={(id) => void exportSystem(id)}
          onImport={(f) => void handleImport(f)}
          onClose={() => setManagerOpen(false)}
        />
      )}
    </div>
  );
}
