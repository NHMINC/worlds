import { useCallback, useEffect, useRef, useState } from 'react';
import { Engine, type BodyOverrides, type RigMode, type Tool, type ViewState } from './render/engine';
import { AmbientMusic } from './audio/ambient';
import { db, deleteSystem, touchSystem } from './store/db';
import { exportSystem, importSystem } from './store/exportImport';
import { CURRENT_GEN_VERSION, systemAt, type SystemSpec } from './world/systemgen';
import { objectAt, type GalaxyObject } from './world/galaxy';
import { discoverHabitable } from './world/discover';
import { prepareUniverse } from './world/universePrep';
import { PALETTE } from './world/palettes';
import { uuid } from './world/rng';
import type {
  BodyStateRecord, LabelRecord, ObjectKind, ObjectRecord, SystemMeta,
} from './world/types';
import { Toolbar } from './ui/Toolbar';
import { GalaxyExplorer } from './ui/GalaxyExplorer';
import { UniverseBoot } from './ui/UniverseBoot';
import { SystemManager } from './ui/SystemManager';
import { SettingsModal } from './ui/SettingsModal';
import { PlaceDialog } from './ui/PlaceDialog';
import { LabelsOverlay } from './ui/LabelsOverlay';
import { WorldTagsOverlay, type WorldTagInfo } from './ui/WorldTagsOverlay';
import { SystemMap, type MapPlanet } from './ui/SystemMap';
import { FlightHud } from './ui/FlightHud';
import { InspectorPanel, type InspectedCell } from './ui/InspectorPanel';
import { geologyFor } from './world/geology';
import { UNIVERSE } from './world/physics';
import { METERS_PER_LEVEL } from './world/toygen';

const LAST_SYSTEM_KEY = 'wb_last_system';

/** Normalized zoom (0..1, log scale) above which editing tools appear. */
const EDIT_ZOOM_NORM = 0.65;

interface PlaceDialogState {
  mode: 'label' | 'object';
  bodyId: string;
  cell: number;
  existingLabel?: LabelRecord;
  existingObject?: ObjectRecord;
}

/** A fresh system: the seed decides everything, the star lends its name. */
function newSystemMeta(
  name: string,
  seed: string,
  extra?: { starId?: number; galaxySeed?: string },
): SystemMeta {
  return {
    id: uuid(),
    name,
    seed,
    genVersion: CURRENT_GEN_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const musicRef = useRef<AmbientMusic | null>(null);
  const systemRef = useRef<SystemMeta | null>(null);
  const specRef = useRef<SystemSpec | null>(null);
  const overridesRef = useRef(new Map<string, BodyOverrides>());
  const frameListeners = useRef(new Set<(v: ViewState) => void>());
  const zoomLabelRef = useRef('');
  const canEditRef = useRef(false);
  const modeRef = useRef<RigMode>('orbit');
  const bodyIdRef = useRef('');

  const [systems, setSystems] = useState<SystemMeta[]>([]);
  const [system, setSystem] = useState<SystemMeta | null>(null);
  const [spec, setSpec] = useState<SystemSpec | null>(null);
  const [bodyStates, setBodyStates] = useState<Map<string, BodyStateRecord>>(new Map());
  const [labels, setLabels] = useState<LabelRecord[]>([]);
  const [objects, setObjects] = useState<ObjectRecord[]>([]);
  const [mode, setMode] = useState<RigMode>('orbit');
  const [currentBodyId, setCurrentBodyId] = useState('');
  const [tool, setTool] = useState<Tool>('pan');
  const [zoomLabel, setZoomLabel] = useState('0%');
  const [canEdit, setCanEdit] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [galaxyOpen, setGalaxyOpen] = useState(false);
  /** Boot: cinematic (prep) → relocation flight → done. */
  const [bootStage, setBootStage] = useState<'prep' | 'flight' | 'done'>('prep');
  /** The cinematic veil fades once the explorer has taken over. */
  const [veil, setVeil] = useState<'solid' | 'leaving' | 'gone'>('solid');
  const [lookStarId, setLookStarId] = useState<number | null>(null);
  const [placeDialog, setPlaceDialog] = useState<PlaceDialogState | null>(null);
  const [inspected, setInspected] = useState<InspectedCell | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  const [volume, setVolume] = useState(0.7);

  systemRef.current = system;
  specRef.current = spec;
  modeRef.current = mode;

  // ------------------------------------------------------------ engine

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const engine = new Engine(canvas, {
      onFrame: (v) => {
        const label = `${Math.round(v.zNorm * 100)}%`;
        if (label !== zoomLabelRef.current) {
          zoomLabelRef.current = label;
          setZoomLabel(label);
        }
        if (v.mode !== modeRef.current) {
          modeRef.current = v.mode;
          setMode(v.mode);
          if (v.mode === 'flight') setTool('pan');
        }
        if (v.bodyId !== bodyIdRef.current) {
          bodyIdRef.current = v.bodyId;
          setCurrentBodyId(v.bodyId);
        }
        // Editing is a close-up, in-orbit, rocky-world activity.
        const body = specRef.current?.bodies.find((b) => b.id === v.bodyId);
        const editable = v.mode === 'orbit' && v.zNorm >= EDIT_ZOOM_NORM && body?.kind === 'rocky';
        if (editable !== canEditRef.current) {
          canEditRef.current = editable;
          setCanEdit(editable);
          if (!editable) setTool('pan');
        }
        for (const fn of frameListeners.current) fn(v);
      },
      onTap: (tapTool, bodyId, cell) => {
        if (tapTool === 'inspect') {
          const info = engine.cellInfo(bodyId, cell);
          const body = specRef.current?.bodies.find((b) => b.id === bodyId);
          if (!info || !body) return;
          const waterLevel = engine.waterLevelOf(bodyId);
          const geo = geologyFor(body.seed, body.physics, waterLevel);
          setInspected({
            cell,
            level: info.level,
            elevationM: (info.level - waterLevel) * METERS_PER_LEVEL,
            localK: UNIVERSE.T_COLD + info.localTemp01 * (UNIVERSE.T_HOT - UNIVERSE.T_COLD),
            elements: geo.at(info.dir[0], info.dir[1], info.dir[2], info.level),
          });
          return;
        }
        setPlaceDialog({ mode: tapTool === 'label' ? 'label' : 'object', bodyId, cell });
      },
      onCameraSettled: (cam) => {
        const s = systemRef.current;
        if (s) void db.systems.update(s.id, { cam });
      },
      onTerrainEdited: (bodyId, overrides) => {
        // The addressable-universe write path: absolute level overrides,
        // packed [cell, level, ...], one row per body.
        const s = systemRef.current;
        if (!s) return;
        const packed: number[] = [];
        for (const [cell, level] of overrides) packed.push(cell, level);
        void db.terrain.put({ systemId: s.id, bodyId, packed });
        void touchSystem(s.id);
      },
    });
    engineRef.current = engine;
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__engine = engine;
    }

    const ro = new ResizeObserver(() => {
      engine.resize(wrap.clientWidth, wrap.clientHeight);
    });
    ro.observe(wrap);
    engine.resize(wrap.clientWidth, wrap.clientHeight);

    return () => {
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function visitAlive(s: SystemMeta): boolean {
    if (s.starId == null) return false;
    // A generator bump re-addresses the sky: older visits are void.
    if (s.genVersion !== CURRENT_GEN_VERSION) return false;
    return objectAt(s.galaxySeed ?? UNIVERSE.CANONICAL_SEED, s.starId) != null;
  }

  async function openFreshGalaxy(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const start = discoverHabitable();
    setLookStarId(start.starId);
    setGalaxyOpen(true);
  }

  /**
   * The universe is minted (UniverseBoot watched it happen). Validate
   * visits against the formed catalog, load the last system behind the
   * veil, then start the relocation flight to the start (or last) star.
   */
  async function handlePrepared(): Promise<void> {
    const engine = engineRef.current;
    if (!engine) return;
    const raw = await db.systems.orderBy('updatedAt').reverse().toArray();
    for (const s of raw) {
      if (s.starId != null && !visitAlive(s)) await deleteSystem(s.id);
    }
    const list = (await db.systems.orderBy('updatedAt').reverse().toArray()).filter(visitAlive);
    setSystems(list);
    if (list.length === 0) {
      const start = discoverHabitable();
      setLookStarId(start.starId);
    } else {
      const lastId = localStorage.getItem(LAST_SYSTEM_KEY);
      const target = list.find((s) => s.id === lastId) ?? list[0];
      if (target) await openSystem(target.id, engine);
    }
    setBootStage('flight');
    setGalaxyOpen(true);
  }

  /** The flight arrived. A saved system closes the explorer over it. */
  function handleIntroDone(): void {
    setBootStage('done');
    if (systemRef.current) setGalaxyOpen(false);
  }

  async function openSystem(id: string, engineArg?: Engine): Promise<void> {
    const engine = engineArg ?? engineRef.current;
    if (!engine) return;
    const s = await db.systems.get(id);
    if (!s) return;
    if (s.starId == null || !visitAlive(s)) return;
    const sysSpec = systemAt(s.galaxySeed ?? UNIVERSE.CANONICAL_SEED, s.starId);
    const [bs, terr, lbs, objs] = await Promise.all([
      db.bodyState.where('systemId').equals(id).toArray(),
      db.terrain.where('systemId').equals(id).toArray(),
      db.labels.where('systemId').equals(id).toArray(),
      db.objects.where('systemId').equals(id).toArray(),
    ]);
    // Player state as engine overrides: dials plus sparse absolute terrain.
    const overrides = new Map<string, BodyOverrides>();
    // Climate / sea dials are retired. Worlds show generated physics.
    for (const t of terr) {
      const o = overrides.get(t.bodyId) ?? {};
      const m = new Map<number, number>();
      for (let i = 0; i + 1 < t.packed.length; i += 2) m.set(t.packed[i], t.packed[i + 1]);
      o.terrain = m;
      overrides.set(t.bodyId, o);
    }
    overridesRef.current = overrides;
    engine.loadSystem(sysSpec, { cam: s.cam, overrides });
    setSystem(s);
    setSpec(sysSpec);
    setBodyStates(new Map(bs.map((b) => [b.bodyId, b])));
    setLabels(lbs);
    setObjects(objs);
    localStorage.setItem(LAST_SYSTEM_KEY, id);
    setManagerOpen(false);
  }

  // ------------------------------------------------------------ tools

  useEffect(() => {
    engineRef.current?.setTool(tool);
    if (tool !== 'inspect') setInspected(null);
  }, [tool]);

  // A new body under the camera means a stale hex readout.
  useEffect(() => {
    setInspected(null);
  }, [currentBodyId]);

  // ------------------------------------------------------------ systems

  async function handleDelete(id: string): Promise<void> {
    await deleteSystem(id);
    const list = (await db.systems.orderBy('updatedAt').reverse().toArray()).filter(visitAlive);
    setSystems(list);
    if (system?.id === id) {
      if (list[0]) await openSystem(list[0].id);
      else {
        setSystem(null);
        setSpec(null);
        // The formed field and backdrop are already cached in memory.
        await prepareUniverse();
        await openFreshGalaxy();
      }
    }
  }

  async function handleSetCourse(obj: GalaxyObject): Promise<void> {
    const gSeed = UNIVERSE.CANONICAL_SEED;
    const existing = systems.find((s) => s.starId === obj.id && (s.galaxySeed ?? gSeed) === gSeed);
    if (existing) {
      await openSystem(existing.id);
      setGalaxyOpen(false);
      return;
    }
    const spec0 = systemAt(gSeed, obj.id);
    const meta = newSystemMeta(spec0.star.name, spec0.seed, { starId: obj.id, galaxySeed: gSeed });
    await db.systems.add(meta);
    setSystems((await db.systems.orderBy('updatedAt').reverse().toArray()).filter((s) => s.starId != null));
    await openSystem(meta.id);
    setGalaxyOpen(false);
  }

  useEffect(() => {
    engineRef.current?.setPaused(galaxyOpen);
  }, [galaxyOpen]);

  async function handleImport(file: File): Promise<void> {
    try {
      const id = await importSystem(file);
      setSystems((await db.systems.orderBy('updatedAt').reverse().toArray()).filter((s) => s.starId != null));
      await openSystem(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Import failed');
    }
  }

  const currentBody = spec?.bodies.find((b) => b.id === currentBodyId) ?? null;

  // ------------------------------------------------------------ labels & objects

  async function savePlace(text: string, kind: ObjectKind): Promise<void> {
    const s = system;
    const d = placeDialog;
    if (!s || !d) return;
    if (d.mode === 'label') {
      if (d.existingLabel) {
        await db.labels.update(d.existingLabel.id, { text });
        setLabels((ls) => ls.map((l) => (l.id === d.existingLabel!.id ? { ...l, text } : l)));
      } else {
        const rec: LabelRecord = { id: uuid(), systemId: s.id, bodyId: d.bodyId, cell: d.cell, text };
        await db.labels.add(rec);
        setLabels((ls) => [...ls, rec]);
      }
    } else {
      if (d.existingObject) {
        await db.objects.update(d.existingObject.id, { name: text, kind });
        setObjects((os) => os.map((o) => (o.id === d.existingObject!.id ? { ...o, name: text, kind } : o)));
      } else {
        const rec: ObjectRecord = { id: uuid(), systemId: s.id, bodyId: d.bodyId, cell: d.cell, kind, name: text };
        await db.objects.add(rec);
        setObjects((os) => [...os, rec]);
      }
    }
    await touchSystem(s.id);
    setPlaceDialog(null);
  }

  async function deletePlace(): Promise<void> {
    const d = placeDialog;
    if (!d) return;
    if (d.existingLabel) {
      await db.labels.delete(d.existingLabel.id);
      setLabels((ls) => ls.filter((l) => l.id !== d.existingLabel!.id));
    }
    if (d.existingObject) {
      await db.objects.delete(d.existingObject.id);
      setObjects((os) => os.filter((o) => o.id !== d.existingObject!.id));
    }
    setPlaceDialog(null);
  }

  // ------------------------------------------------------------ music

  async function toggleMusic(): Promise<void> {
    if (!musicOn) {
      if (!musicRef.current) {
        musicRef.current = new AmbientMusic(
          () => engineRef.current?.getMood() ?? { group: 'green', density: 0 },
        );
      }
      musicRef.current.beginListen();
      musicRef.current.setVolume(volume);
      musicRef.current.setMuted(false);
      await musicRef.current.start();
      setMusicOn(true);
    } else {
      musicRef.current?.setMuted(true);
      setMusicOn(false);
    }
  }

  function handleVolume(v: number): void {
    setVolume(v);
    musicRef.current?.setVolume(v);
  }

  // ------------------------------------------------------------ overlay plumbing

  const subscribeFrames = useCallback((fn: (v: ViewState) => void) => {
    frameListeners.current.add(fn);
    return () => {
      frameListeners.current.delete(fn);
    };
  }, []);

  const projectCell = useCallback(
    (bodyId: string, cell: number) => engineRef.current?.projectCell(bodyId, cell) ?? null,
    [],
  );

  const projectBody = useCallback(
    (bodyId: string) => engineRef.current?.projectBody(bodyId) ?? null,
    [],
  );

  const angleOf = useCallback(
    (bodyId: string) => engineRef.current?.bodyMapAngle(bodyId) ?? 0,
    [],
  );

  // One tag per planet (moons live in their parent's neighborhood).
  const worldTags: WorldTagInfo[] = (spec?.bodies ?? [])
    .filter((b) => !b.parent)
    .map((b) => ({
      id: b.id,
      name: b.name,
      color: `rgb(${b.meanColor.map((c) => Math.round(c * 255)).join(',')})`,
    }));

  const palette = PALETTE;
  const bodyDisplayName = (id: string): string =>
    bodyStates.get(id)?.name ?? spec?.bodies.find((b) => b.id === id)?.name ?? '…';

  const cssColor = (c: readonly number[]): string =>
    `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
  const mapPlanets: MapPlanet[] = (spec?.bodies ?? [])
    .filter((b) => !b.parent)
    .map((b) => ({
      id: b.id,
      name: bodyDisplayName(b.id),
      color: cssColor(b.meanColor),
      kind: b.kind,
      radius: b.radius,
      ring: b.kind === 'gas' && Boolean(b.gas?.ring),
      moons: (spec?.bodies ?? [])
        .filter((m) => m.parent === b.id)
        .map((m) => ({ id: m.id, name: bodyDisplayName(m.id), color: cssColor(m.meanColor) })),
    }));
  const bodyLabels = labels.filter((l) => l.bodyId === currentBodyId);
  const bodyObjects = objects.filter((o) => o.bodyId === currentBodyId);

  return (
    <div className="app">
      <div ref={wrapRef} className="canvas-wrap">
        <canvas ref={canvasRef} />
        {!galaxyOpen && (
          <>
            <LabelsOverlay
              subscribe={subscribeFrames}
              projectCell={(cell) => projectCell(currentBodyId, cell)}
              labels={bodyLabels}
              objects={bodyObjects}
              interactive={tool === 'label' || tool === 'object'}
              onEditLabel={(l) => setPlaceDialog({ mode: 'label', bodyId: l.bodyId, cell: l.cell, existingLabel: l })}
              onEditObject={(o) => setPlaceDialog({ mode: 'object', bodyId: o.bodyId, cell: o.cell, existingObject: o })}
            />
            <WorldTagsOverlay
              tags={worldTags}
              subscribe={subscribeFrames}
              project={projectBody}
              onTravel={(id) => engineRef.current?.travelTo(id)}
            />
            <FlightHud
              subscribe={subscribeFrames}
              onEnterOrbit={(style) => engineRef.current?.enterOrbit(undefined, style)}
            />
            {mode === 'surface' && (
              <div className="surface-hint">drag to look · zoom in to walk · zoom out to stop or settle</div>
            )}
          </>
        )}
      </div>

      {galaxyOpen && (
        <GalaxyExplorer
          hereStarId={system?.starId ?? lookStarId}
          visitedStarIds={systems.map((s) => s.starId).filter((id): id is number => id != null)}
          canClose={system != null}
          intro={bootStage === 'flight'}
          onSetCourse={(o) => void handleSetCourse(o)}
          onClose={() => setGalaxyOpen(false)}
          onReady={() => {
            setVeil((v) => (v === 'solid' ? 'leaving' : v));
            window.setTimeout(() => setVeil('gone'), 950);
          }}
          onIntroDone={handleIntroDone}
        />
      )}

      {veil !== 'gone' && (
        <UniverseBoot onDone={() => void handlePrepared()} leaving={veil === 'leaving'} />
      )}

      {!galaxyOpen && (
      <Toolbar
        title={mode === 'flight' ? system?.name ?? '…' : bodyDisplayName(currentBodyId)}
        mode={mode}
        tool={tool}
        setTool={setTool}
        canEdit={canEdit}
        canInspect={mode === 'orbit' && currentBody?.kind === 'rocky'}
        zoomLabel={zoomLabel}
        viewLetterbox={() => engineRef.current?.viewLetterbox()}
        viewFit={() => engineRef.current?.viewFitHeight()}
        resetNorth={() => engineRef.current?.resetNorth()}
        depart={() => engineRef.current?.depart()}
        canLand={mode === 'orbit' && currentBody?.kind === 'rocky'}
        land={() => engineRef.current?.land()}
        takeOff={() => engineRef.current?.takeOff()}
        musicOn={musicOn}
        toggleMusic={() => void toggleMusic()}
        volume={volume}
        setVolume={handleVolume}
        openManager={() => setManagerOpen(true)}
        openMap={() => setMapOpen(true)}
        openGalaxy={() => setGalaxyOpen(true)}
        openSettings={() => setSettingsOpen(true)}
      />
      )}

      {tool === 'inspect' && mode === 'orbit' && currentBody && (
        <InspectorPanel body={currentBody} physics={currentBody.physics} cell={inspected} onClose={() => setTool('pan')} />
      )}

      {managerOpen && (
        <SystemManager
          systems={systems}
          currentId={system?.id ?? null}
          onOpen={(id) => void openSystem(id)}
          onDelete={(id) => void handleDelete(id)}
          onExport={(id) => void exportSystem(id)}
          onImport={(f) => void handleImport(f)}
          onClose={() => setManagerOpen(false)}
        />
      )}

      {mapOpen && spec && (
        <SystemMap
          starName={spec.star.name}
          starColor={spec.star.color}
          planets={mapPlanets}
          currentBodyId={currentBodyId}
          subscribe={subscribeFrames}
          angleOf={angleOf}
          onTravel={(id) => engineRef.current?.travelTo(id)}
          onClose={() => setMapOpen(false)}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {placeDialog && system && (
        <PlaceDialog
          mode={placeDialog.mode}
          initialText={placeDialog.existingLabel?.text ?? placeDialog.existingObject?.name ?? ''}
          initialKind={placeDialog.existingObject?.kind ?? 'city'}
          canDelete={Boolean(placeDialog.existingLabel || placeDialog.existingObject)}
          aiContext={(kind) => ({
            kind,
            biome:
              palette.biomes[engineRef.current?.biomeAt(placeDialog.bodyId, placeDialog.cell) ?? 'forest'].name,
            worldName: bodyDisplayName(placeDialog.bodyId),
            existing: [...labels.map((l) => l.text), ...objects.map((o) => o.name)].slice(0, 8),
          })}
          onSave={(text, kind) => void savePlace(text, kind)}
          onDelete={() => void deletePlace()}
          onClose={() => setPlaceDialog(null)}
        />
      )}
    </div>
  );
}
