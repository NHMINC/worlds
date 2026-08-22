import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UNIVERSE } from '../world/physics';
import { systemAt, type BodySpec } from '../world/systemgen';
import { GalaxyView, type GalaxyFrame, type GalaxyPreset, type GlobePick, type MarkTool } from '../render/galaxyView';
import type { LabelRecord, LastPlace, ObjectKind, ObjectRecord, SessionSnap } from '../world/types';
import { db, touchSystem } from '../store/db';
import { uuid } from '../world/rng';
import { AmbientMusic } from '../audio/ambient';
import { geologyFor } from '../world/geology';
import { insolationAt, localTemp01, METERS_PER_LEVEL } from '../world/toygen';
import { IconCenter, IconGlobe, IconInspect, IconLabel, IconMusic, IconMusicOff, IconOrbits, IconPlace, IconTrackball } from './icons';
import { SystemMap, mapAngleOf, planetsFromSpec, systemClock } from './SystemMap';
import { OrbitPick } from './OrbitPick';
import { InspectorPanel, type InspectedCell } from './InspectorPanel';
import { LabelsOverlay } from './LabelsOverlay';
import { PlaceDialog } from './PlaceDialog';
import { isHangOrbit, orbitLabel } from '../world/worldOrbit';
import { lockedToStar } from '../world/systemgen';
import { navModeLabel } from '../render/hostNav';
import { useEngineer } from './EngineerPanel';

const VIEW_PRESETS: Array<{ id: GalaxyPreset; label: string }> = [
  { id: 'face', label: 'Face-on' },
  { id: 'edge', label: 'Edge-on' },
  { id: 'home', label: 'Home' },
];

const LY_PER_KPC = 3261.56;

/** Catalog kpc → AU / ly / kpc, matching the approach laws. */
export function formatCatalogDist(kpc: number): string {
  const d = Number.isFinite(kpc) && kpc > 0 ? kpc : 0;
  if (d >= 0.1) return `${d >= 10 ? d.toFixed(1) : d.toFixed(2)} kpc`;
  const ly = d * LY_PER_KPC;
  if (ly >= 0.1) return `${ly >= 10 ? ly.toFixed(1) : ly.toFixed(2)} ly`;
  const au = (d * UNIVERSE.KPC_KM) / UNIVERSE.AU_KM;
  if (au >= 0.01) return `${au >= 10 ? au.toFixed(1) : au.toFixed(2)} AU`;
  const km = d * UNIVERSE.KPC_KM;
  if (km >= 1) return `${km >= 100 ? km.toFixed(0) : km.toFixed(1)} km`;
  return `${Math.max(0, km * 1000).toFixed(0)} m`;
}

function cellInspect(body: BodySpec, hit: GlobePick): InspectedCell {
  const geo = geologyFor(body.seed, body.physics, hit.waterLevel);
  const locked = lockedToStar(body);
  const span = locked ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
  const insol = insolationAt(hit.dir[0], hit.dir[1], hit.dir[2], locked);
  const t01 = localTemp01(body.temp ?? body.physics.temp01, span, insol);
  return {
    cell: hit.cell,
    level: hit.level,
    elevationM: (hit.level - hit.waterLevel) * METERS_PER_LEVEL,
    localK: UNIVERSE.T_COLD + t01 * (UNIVERSE.T_HOT - UNIVERSE.T_COLD),
    elements: geo.at(hit.dir[0], hit.dir[1], hit.dir[2], hit.level),
  };
}

export interface ExplorerGo {
  key: number;
  starId: number;
  /** Full camp when opening a visit; null parks on the star. */
  place: LastPlace | null;
}

interface Props {
  galaxySeed?: string;
  hereStarId?: number | null;
  visitedStarIds?: number[];
  /** Last camp — boot snaps here instead of the first-look park. */
  resume?: LastPlace | null;
  /** Live ship / drone save — wins over the coarse camp. */
  resumeSession?: SessionSnap | null;
  onSession?: (s: SessionSnap) => void;
  /** Later travel (visits / import / forget) — does not remint the view. */
  go?: ExplorerGo | null;
  /** False while the explorer is kept warm but hidden. */
  active?: boolean;
  onReady?: () => void;
  onPlace?: (p: LastPlace) => void;
  onOpenVisits?: () => void;
  /** Current visit row — labels and objects persist on this id. */
  visitId?: string | null;
}

export function GalaxyExplorer(props: Props) {
  const seed = props.galaxySeed ?? UNIVERSE.CANONICAL_SEED;
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<GalaxyView | null>(null);
  const hereRef = useRef(props.hereStarId ?? null);
  hereRef.current = props.hereStarId ?? null;
  const readyRef = useRef(props.onReady);
  readyRef.current = props.onReady;
  const placeRef = useRef(props.onPlace);
  placeRef.current = props.onPlace;
  const sessionWriteRef = useRef(props.onSession);
  sessionWriteRef.current = props.onSession;
  const resumeRef = useRef(props.resume);
  resumeRef.current = props.resume;
  const resumeSessionRef = useRef(props.resumeSession);
  resumeSessionRef.current = props.resumeSession;
  const markTicks = useRef(new Set<() => void>());
  const inspectRef = useRef<(hit: GlobePick | null) => void>(() => {});
  const markRef = useRef<(tool: MarkTool, hit: GlobePick) => void>(() => {});
  const [markTool, setMarkTool] = useState<MarkTool | null>(null);
  const [labels, setLabels] = useState<LabelRecord[]>([]);
  const [objects, setObjects] = useState<ObjectRecord[]>([]);
  const [placeDialog, setPlaceDialog] = useState<{
    mode: MarkTool;
    bodyId: string;
    cell: number;
    existingLabel?: LabelRecord;
    existingObject?: ObjectRecord;
  } | null>(null);
  const active = props.active !== false;
  const [ready, setReady] = useState(false);
  const [inspect, setInspect] = useState<{ body: BodySpec; cell: InspectedCell | null } | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const musicRef = useRef<AmbientMusic | null>(null);
  const [menu, setMenu] = useState<null | 'view' | 'engineer'>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [orbitPick, setOrbitPick] = useState<string | null>(null);
  const eng = useEngineer(
    () => viewRef.current,
    seed,
    menu === 'engineer',
    () => setMenu((m) => (m === 'engineer' ? null : 'engineer')),
  );
  const [frame, setFrame] = useState<GalaxyFrame>({
    mode: 'region',
    theta: 0,
    phi: 0,
    radius: 8,
    pickable: false,
    resolved: 0,
    grown: 0,
    sector: null,
    population: 0,
    focus: null,
    course: null,
    warp: false,
    astern: false,
    inView: false,
    soiRemain: null,
    hostId: null,
    backdrop: 0,
    orbit: null,
    orbiting: false,
    navMode: null,
    nearestBodyId: null,
    navHint: null,
    canLeaveOrbit: false,
    departing: false,
    lookHold: null,
    drone: false,
    dronePhase: null,
    worldId: null,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let cancelled = false;
    let view: GalaxyView | null = null;
    let ro: ResizeObserver | null = null;
    const boot = window.setTimeout(() => {
      if (cancelled) return;
      view = new GalaxyView(
        canvas,
        seed,
        {
          onSelect: () => {},
          onPlace: (p) => placeRef.current?.(p),
          onSession: (s) => sessionWriteRef.current?.(s),
          onInspect: (hit) => inspectRef.current(hit),
          onMark: (tool, hit) => markRef.current(tool, hit),
          onFrame: (f) => {
            for (const fn of markTicks.current) fn();
            setFrame((prev) =>
              prev.mode !== f.mode ||
              Math.abs(prev.radius - f.radius) > 0.08 ||
              Math.abs(prev.phi - f.phi) > 0.02 ||
              prev.pickable !== f.pickable ||
              prev.resolved !== f.resolved ||
              prev.grown !== f.grown ||
              prev.population !== f.population ||
              prev.sector !== f.sector ||
              prev.warp !== f.warp ||
              prev.astern !== f.astern ||
              prev.inView !== f.inView ||
              prev.backdrop !== f.backdrop ||
              prev.course?.id !== f.course?.id ||
              prev.course?.bodyId !== f.course?.bodyId ||
              Math.abs((prev.course?.dist ?? -1) - (f.course?.dist ?? -1)) > 1e-12 ||
              Math.abs((prev.soiRemain ?? -1) - (f.soiRemain ?? -1)) > 1e-12 ||
              prev.hostId !== f.hostId ||
              prev.orbit !== f.orbit ||
              prev.orbiting !== f.orbiting ||
              prev.navMode !== f.navMode ||
              prev.nearestBodyId !== f.nearestBodyId ||
              prev.navHint !== f.navHint ||
              prev.canLeaveOrbit !== f.canLeaveOrbit ||
              prev.departing !== f.departing ||
              prev.lookHold !== f.lookHold ||
              prev.drone !== f.drone ||
              prev.dronePhase !== f.dronePhase ||
              prev.worldId !== f.worldId ||
              prev.focus?.id !== f.focus?.id ||
              prev.focus?.bodyId !== f.focus?.bodyId ||
              (f.focus != null &&
                (Math.abs((prev.focus?.x ?? 0) - f.focus.x) > 2 ||
                  Math.abs((prev.focus?.y ?? 0) - f.focus.y) > 2))
                ? f
                : prev,
            );
          },
        },
        hereRef.current,
        resumeRef.current ?? null,
        resumeSessionRef.current ?? null,
      );
      viewRef.current = view;
      (window as unknown as { __galaxyView?: GalaxyView }).__galaxyView = view;
      view.setActive(active);
      setReady(true);
      readyRef.current?.();
      ro = new ResizeObserver(() => {
        view?.resize(wrap.clientWidth, wrap.clientHeight);
      });
      ro.observe(wrap);
      view.resize(wrap.clientWidth, wrap.clientHeight);
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(boot);
      ro?.disconnect();
      view?.dispose();
      viewRef.current = null;
      delete (window as unknown as { __galaxyView?: GalaxyView }).__galaxyView;
    };
    // Recreating the view remints the neighbourhood. hereStarId is
    // applied below; only a seed change is a new universe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.setHere(props.hereStarId ?? null);
  }, [props.hereStarId, ready]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !ready) return;
    view.setActive(active);
    if (active && wrapRef.current) {
      view.resize(wrapRef.current.clientWidth, wrapRef.current.clientHeight);
    }
    if (!active) setMapOpen(false);
  }, [active, ready]);

  useEffect(() => {
    if (ready) viewRef.current?.setVisited(props.visitedStarIds ?? []);
  }, [props.visitedStarIds, ready]);

  useEffect(() => {
    if (!ready || !props.go) return;
    const view = viewRef.current;
    if (!view) return;
    if (props.go.place) view.restorePlace(props.go.place);
    else view.goToStar(props.go.starId);
  }, [ready, props.go]);

  useEffect(() => {
    const id = props.visitId;
    if (!id) {
      setLabels([]);
      setObjects([]);
      return;
    }
    let cancelled = false;
    void Promise.all([
      db.labels.where('systemId').equals(id).toArray(),
      db.objects.where('systemId').equals(id).toArray(),
    ]).then(([lbs, objs]) => {
      if (cancelled) return;
      setLabels(lbs);
      setObjects(objs);
    });
    return () => {
      cancelled = true;
    };
  }, [props.visitId]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.setMarkTool(frame.drone ? markTool : null);
  }, [ready, markTool, frame.drone]);

  useEffect(() => {
    if (!frame.drone) setMarkTool(null);
  }, [frame.drone]);

  useEffect(() => {
    if (!ready) return;
    const flush = (): void => {
      viewRef.current?.flushSession();
      const p = viewRef.current?.snapshotPlace();
      if (p) placeRef.current?.(p);
    };
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ready]);

  const [perfText, setPerfText] = useState('');
  useEffect(() => {
    const id = window.setInterval(() => {
      setPerfText(viewRef.current?.perfSummary() ?? '');
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (menu !== 'view') return;
    const onDoc = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t && rootRef.current?.querySelector('.galaxy-top')?.contains(t)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!mapOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMapOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mapOpen]);

  useEffect(() => {
    if (frame.focus?.id == null && frame.hostId == null) setMapOpen(false);
  }, [frame.focus?.id, frame.hostId]);

  inspectRef.current = (hit) => {
    const body = viewRef.current?.inspectBody();
    if (!body) return;
    setInspect({
      body,
      cell: hit && hit.bodyId === body.id ? cellInspect(body, hit) : null,
    });
  };

  markRef.current = (tool, hit) => {
    const existingLabel = labels.find((l) => l.bodyId === hit.bodyId && l.cell === hit.cell);
    const existingObject = objects.find((o) => o.bodyId === hit.bodyId && o.cell === hit.cell);
    setPlaceDialog({
      mode: tool,
      bodyId: hit.bodyId,
      cell: hit.cell,
      existingLabel: tool === 'label' ? existingLabel : undefined,
      existingObject: tool === 'object' ? existingObject : undefined,
    });
  };

  const subscribeMarks = useCallback((fn: () => void) => {
    markTicks.current.add(fn);
    return () => {
      markTicks.current.delete(fn);
    };
  }, []);

  const projectMark = useCallback(
    (cell: number) => {
      const id = frame.worldId;
      if (!id) return null;
      return viewRef.current?.projectCell(id, cell) ?? null;
    },
    [frame.worldId],
  );

  async function saveMark(text: string, kind: ObjectKind): Promise<void> {
    const s = props.visitId;
    const d = placeDialog;
    if (!s || !d) return;
    if (d.mode === 'label') {
      if (d.existingLabel) {
        await db.labels.update(d.existingLabel.id, { text });
        setLabels((ls) => ls.map((l) => (l.id === d.existingLabel!.id ? { ...l, text } : l)));
      } else {
        const rec: LabelRecord = { id: uuid(), systemId: s, bodyId: d.bodyId, cell: d.cell, text };
        await db.labels.add(rec);
        setLabels((ls) => [...ls, rec]);
      }
    } else if (d.existingObject) {
      await db.objects.update(d.existingObject.id, { name: text, kind });
      setObjects((os) => os.map((o) => (o.id === d.existingObject!.id ? { ...o, name: text, kind } : o)));
    } else {
      const rec: ObjectRecord = { id: uuid(), systemId: s, bodyId: d.bodyId, cell: d.cell, kind, name: text };
      await db.objects.add(rec);
      setObjects((os) => [...os, rec]);
    }
    await touchSystem(s);
    setPlaceDialog(null);
  }

  async function deleteMark(): Promise<void> {
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

  function markBiome(body: BodySpec): string {
    const p = body.physics;
    if (p.life) return 'Grassland';
    if (p.hydrosphere.state === 'ice') return 'Snowfield';
    if (p.hydrosphere.state === 'liquid') return 'Beach';
    if (p.TsurfK > 330) return 'Desert';
    return 'Mountains';
  }

  useEffect(() => {
    if (!frame.orbiting && !frame.drone) setInspect(null);
  }, [frame.orbiting, frame.drone, frame.hostId]);

  async function toggleMusic(): Promise<void> {
    if (!musicOn) {
      if (!musicRef.current) {
        musicRef.current = new AmbientMusic(
          () => viewRef.current?.getMood() ?? { group: 'space', density: 0 },
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

  const inRegion = frame.mode === 'region';
  const editing = eng.editing;
  const chartId = frame.focus?.id ?? frame.hostId;
  const chartSpec = useMemo(() => {
    if (chartId == null) return null;
    try {
      return systemAt(seed, chartId);
    } catch {
      return null;
    }
  }, [seed, chartId]);
  const chartPlanets = useMemo(
    () => (chartSpec ? planetsFromSpec(chartSpec) : []),
    [chartSpec],
  );
  const chartSpecRef = useRef(chartSpec);
  chartSpecRef.current = chartSpec;
  const chartAngleOf = useCallback((id: string) => {
    const sys = chartSpecRef.current;
    return sys ? mapAngleOf(sys, id, systemClock()) : 0;
  }, []);

  return (
    <div
      ref={rootRef}
      className={`galaxy-explorer${active ? '' : ' is-dormant'}${mapOpen ? ' is-map' : ''}`}
      aria-hidden={!active}
      inert={!active ? true : undefined}
    >
      <div ref={wrapRef} className="galaxy-stage">
        <canvas ref={canvasRef} />
        {frame.worldId && (labels.length > 0 || objects.length > 0) && (
          <LabelsOverlay
            subscribe={subscribeMarks}
            projectCell={projectMark}
            labels={labels.filter((l) => l.bodyId === frame.worldId)}
            objects={objects.filter((o) => o.bodyId === frame.worldId)}
            interactive={Boolean(markTool)}
            onEditLabel={(l) =>
              setPlaceDialog({ mode: 'label', bodyId: l.bodyId, cell: l.cell, existingLabel: l })
            }
            onEditObject={(o) =>
              setPlaceDialog({ mode: 'object', bodyId: o.bodyId, cell: o.cell, existingObject: o })
            }
          />
        )}
        {!ready && <div className="galaxy-loading">Opening the neighbourhood…</div>}
        {eng.progress}
        {inRegion && !editing && <div className="gx-pip" aria-hidden />}
        {inRegion && !editing && frame.hostId != null && (
          <div className="gx-look">
            {frame.drone && !frame.dronePhase && (
              <button
                type="button"
                className={`gx-look-btn${frame.lookHold === 'center' ? ' is-on' : ''}`}
                aria-label="Target"
                aria-pressed={frame.lookHold === 'center'}
                title={
                  frame.lookHold === 'center'
                    ? 'Free fly — leave this lock'
                    : 'Lock the body in the pip'
                }
                onClick={() => viewRef.current?.centerLook()}
              >
                <IconCenter size={18} />
              </button>
            )}
            <button
              type="button"
              className={`gx-look-btn${frame.drone ? ' is-on' : ''}`}
              aria-label="Trackball"
              aria-pressed={frame.drone}
              disabled={frame.departing}
              title={
                frame.departing
                  ? 'Leaving orbit — then the drone'
                  : frame.dronePhase === 'home'
                  ? 'Landing on the ship…'
                  : frame.dronePhase === 'launch'
                    ? 'Lifting into target…'
                    : frame.drone
                      ? 'Return to the ship'
                      : 'Launch drone — lift into target lock'
              }
              onClick={() => {
                const on = viewRef.current?.toggleDrone();
                if (on == null) return;
                setFrame((prev) => (prev.drone === on ? prev : { ...prev, drone: on }));
              }}
            >
              <IconTrackball size={18} />
            </button>
          </div>
        )}
        {inRegion && !editing && (
          <div className="gx-helm">
            {frame.departing ? (
              <button
                type="button"
                className="gx-warp gx-leave"
                disabled
                aria-label="Leaving orbit"
                title="Burn to escape — then you fly free"
              >
                Leaving
              </button>
            ) : frame.canLeaveOrbit ? (
              <button
                type="button"
                className="gx-warp gx-leave"
                disabled={frame.drone}
                aria-label="Leave orbit"
                title="Leave orbit — burn to escape, then fly free"
                onClick={() => viewRef.current?.leaveOrbit()}
              >
                Leave
                <br />
                orbit
              </button>
            ) : (
              <>
                {!frame.warp && (
                  <button
                    type="button"
                    className={`gx-gear${frame.astern ? ' astern' : ''}`}
                    aria-label={frame.astern ? 'Astern' : 'Ahead'}
                    title={frame.astern ? 'Astern' : 'Ahead'}
                    disabled={frame.drone}
                    onClick={() => viewRef.current?.toggleGear()}
                  >
                    {frame.astern ? '↓' : '↑'}
                  </button>
                )}
                <button
                  type="button"
                  className={`gx-warp${frame.warp ? ' stop' : ''}`}
                  disabled={frame.drone}
                  onClick={() => viewRef.current?.setWarp(!frame.warp)}
                >
                  {frame.warp ? 'Stop' : 'Warp'}
                </button>
              </>
            )}
          </div>
        )}
        {inRegion && !editing && (frame.course || frame.focus || frame.navMode) && (
          <div className="gx-plate">
            {frame.navMode === 'orbit' ? (
              <>
                <b>{frame.navHint ?? 'Orbit'}</b>
                <em>{navModeLabel('orbit')}</em>
                {frame.orbit ? (
                  <i className="gx-plate-go">
                    {orbitLabel(frame.orbit)}
                    {isHangOrbit(frame.orbit)
                      ? ' · facing body'
                      : ' · body below'}
                  </i>
                ) : (
                  <i className="gx-plate-go">Free look</i>
                )}
              </>
            ) : frame.departing ? (
              <>
                <b>{frame.navHint ?? 'Leaving orbit'}</b>
                <em>Escape burn</em>
                <i className="gx-plate-go">Then free flight</i>
              </>
            ) : !(frame.course ?? frame.focus) && frame.navMode === 'proximity' ? (
              <>
                <b>{frame.navHint ?? 'Nearest body'}</b>
                <em>{navModeLabel('proximity')}</em>
                <i className="gx-plate-go">Aim a body or star — Set course</i>
              </>
            ) : !(frame.course ?? frame.focus) ? (
              <>
                <b>{frame.navHint ?? 'Free flight'}</b>
                <em>{frame.navMode ? navModeLabel(frame.navMode) : 'Cruise'}</em>
              </>
            ) : (
              <>
                <b>{(frame.course ?? frame.focus)!.name}</b>
                <em>
                  {frame.navMode === 'lock' ? `${navModeLabel('lock')} · ` : ''}
                  {(frame.course ?? frame.focus)!.cls} · {(frame.course ?? frame.focus)!.phase}
                </em>
                {(frame.course ?? frame.focus)!.bodyId ? (
                  <i>
                    {(frame.course ?? frame.focus)!.moons
                      ? `${(frame.course ?? frame.focus)!.moons} moon${(frame.course ?? frame.focus)!.moons === 1 ? '' : 's'}`
                      : (frame.course ?? frame.focus)!.phase}
                    {(frame.course ?? frame.focus)!.life ? ' · life' : ''}
                  </i>
                ) : (
                  <i>
                    {(frame.course ?? frame.focus)!.planets} planet
                    {(frame.course ?? frame.focus)!.planets === 1 ? '' : 's'}
                    {(frame.course ?? frame.focus)!.moons
                      ? ` · ${(frame.course ?? frame.focus)!.moons} moon${(frame.course ?? frame.focus)!.moons === 1 ? '' : 's'}`
                      : ''}
                    {(frame.course ?? frame.focus)!.life ? ' · life' : ''}
                  </i>
                )}
                {frame.course && (
                  <i className="gx-plate-dist">{formatCatalogDist(frame.course.dist)}</i>
                )}
                {frame.navHint && frame.navMode === 'lock' && (
                  <i>{frame.navHint}</i>
                )}
                {frame.orbiting && frame.orbit ? (
                  <i className="gx-plate-go">{orbitLabel(frame.orbit)}</i>
                ) : frame.orbit && frame.course ? (
                  <i className="gx-plate-go">Lock-on · {orbitLabel(frame.orbit)}</i>
                ) : frame.course ? (
                  <i className="gx-plate-go">Course Locked</i>
                ) : (
                  <button
                    type="button"
                    className="gx-plate-go"
                    disabled={frame.drone}
                    onClick={() => {
                      const view = viewRef.current;
                      if (!view || frame.drone) return;
                      const body = view.focusedBodyId();
                      if (body) view.setCourseBody(body);
                      else {
                        const o = view.focusedObject();
                        if (o) view.setCourse(o);
                      }
                    }}
                  >
                    Set course
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {!editing && perfText && (
          <div className="gx-hud gx-hud-perf" aria-live="polite">
            {perfText}
          </div>
        )}
        {!editing && frame.soiRemain != null && (
          <div className="gx-hud gx-hud-soi" aria-live="polite">
            {formatCatalogDist(frame.soiRemain)} to exit sphere
          </div>
        )}
      </div>

      <header className="galaxy-top">
        <div className="galaxy-brand">
          <div className="galaxy-title">Helix{frame.sector ? ` · ${frame.sector}` : ''}</div>
          <div className="galaxy-sub">
            {`${frame.population.toLocaleString()} shown · ${UNIVERSE.GALAXY_POPULATION.toLocaleString()} possible`}
          </div>
        </div>
        <div className="galaxy-menus">
          {!editing && (
          <div className={`gx-drop${menu === 'view' ? ' is-open' : ''}`}>
            <button
              type="button"
              className={`gx-chip${menu === 'view' ? ' active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={menu === 'view'}
              onClick={() => setMenu((m) => (m === 'view' ? null : 'view'))}
            >
              View
            </button>
            {menu === 'view' && (
              <div className="gx-drop-menu" role="menu" aria-label="View">
                {VIEW_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    className="gx-drop-item"
                    disabled={frame.drone}
                    onClick={() => {
                      viewRef.current?.setPreset(p.id);
                      setMenu(null);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          )}
          {!editing && (
            <button
              type="button"
              className="gx-chip gx-icon"
              aria-label="Places you’ve been"
              title="Places you’ve been"
              onClick={() => {
                setMenu(null);
                props.onOpenVisits?.();
              }}
            >
              <IconGlobe size={16} />
            </button>
          )}
          {!editing && chartSpec && (
            <button
              type="button"
              className={`gx-chip gx-icon${mapOpen ? ' active' : ''}`}
              aria-label="System chart"
              title="System chart"
              onClick={() => {
                setMenu(null);
                setMapOpen((open) => !open);
              }}
            >
              <IconOrbits size={16} />
            </button>
          )}
          {!editing && (frame.orbiting || frame.drone) && viewRef.current?.inspectBody() && (
            <button
              type="button"
              className={`gx-chip gx-icon${inspect ? ' active' : ''}`}
              aria-label="Inspect"
              title={frame.drone ? 'Inspect — tap a hex from the drone' : 'Inspect this world'}
              onClick={() => {
                const body = viewRef.current?.inspectBody();
                if (!body) return;
                setMarkTool(null);
                setInspect((cur) => (cur ? null : { body, cell: null }));
              }}
            >
              <IconInspect size={16} />
            </button>
          )}
          {!editing && frame.drone && props.visitId && (
            <>
              <button
                type="button"
                className={`gx-chip gx-icon${markTool === 'label' ? ' active' : ''}`}
                aria-label="Name a place"
                title="Name a place — tap a hex from the drone"
                onClick={() => {
                  setInspect(null);
                  setMarkTool((t) => (t === 'label' ? null : 'label'));
                }}
              >
                <IconLabel size={16} />
              </button>
              <button
                type="button"
                className={`gx-chip gx-icon${markTool === 'object' ? ' active' : ''}`}
                aria-label="Place a marker"
                title="Place a city, town, or landmark — tap a hex from the drone"
                onClick={() => {
                  setInspect(null);
                  setMarkTool((t) => (t === 'object' ? null : 'object'));
                }}
              >
                <IconPlace size={16} />
              </button>
            </>
          )}
          {eng.chip}
          {!editing && frame.inView && (
            <button
              type="button"
              className="gx-chip"
              onClick={() => viewRef.current?.setPreset('back')}
            >
              Back
            </button>
          )}
          {!editing && (
            <button
              type="button"
              className={`gx-chip gx-icon${musicOn ? ' active' : ''}`}
              aria-label={musicOn ? 'Music off' : 'Music on'}
              title={musicOn ? 'Music off' : 'Music on'}
              onClick={() => void toggleMusic()}
            >
              {musicOn ? <IconMusic size={16} /> : <IconMusicOff size={16} />}
            </button>
          )}
          {!editing && musicOn && (
            <input
              className="gx-volume"
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                setVolume(v);
                musicRef.current?.setVolume(v);
              }}
              title="Volume"
            />
          )}
        </div>
      </header>

      {eng.panel}

      {mapOpen && chartSpec && (
        <SystemMap
          starName={chartSpec.star.name}
          starColor={chartSpec.star.color}
          planets={chartPlanets}
          currentBodyId={frame.course?.bodyId ?? frame.focus?.bodyId}
          angleOf={chartAngleOf}
          zoomable
          closeOnTravel={false}
          onTravel={(id) => setOrbitPick(id)}
          onClose={() => {
            setMapOpen(false);
            setOrbitPick(null);
          }}
        />
      )}
      {orbitPick && chartSpec && chartSpec.bodies.some((b) => b.id === orbitPick) && (
        <OrbitPick
          body={chartSpec.bodies.find((b) => b.id === orbitPick)!}
          onCancel={() => setOrbitPick(null)}
          onPick={(kind) => {
            const id = orbitPick;
            setOrbitPick(null);
            setMapOpen(false);
            viewRef.current?.goToWorldOrbit(id, kind);
          }}
        />
      )}
      {inspect && (
        <InspectorPanel
          body={inspect.body}
          physics={inspect.body.physics}
          cell={inspect.cell}
          onClose={() => setInspect(null)}
        />
      )}
      {placeDialog && (
        <PlaceDialog
          mode={placeDialog.mode}
          initialText={placeDialog.existingLabel?.text ?? placeDialog.existingObject?.name ?? ''}
          initialKind={placeDialog.existingObject?.kind ?? 'city'}
          canDelete={Boolean(placeDialog.existingLabel || placeDialog.existingObject)}
          aiContext={(kind) => {
            const body =
              viewRef.current?.inspectBody() ??
              chartSpec?.bodies.find((b) => b.id === placeDialog.bodyId);
            return {
              kind,
              biome: body ? markBiome(body) : 'Mountains',
              worldName: body?.name ?? '…',
              existing: [...labels.map((l) => l.text), ...objects.map((o) => o.name)].slice(0, 8),
            };
          }}
          onSave={(text, kind) => void saveMark(text, kind)}
          onDelete={() => void deleteMark()}
          onClose={() => setPlaceDialog(null)}
        />
      )}
    </div>
  );
}
