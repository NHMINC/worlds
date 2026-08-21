import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UNIVERSE } from '../world/physics';
import { lockedToStar, systemAt, type BodySpec } from '../world/systemgen';
import { GalaxyView, type GalaxyFrame, type GalaxyPreset, type GlobePick } from '../render/galaxyView';
import type { LastPlace } from '../world/types';
import { remintUniverse, rebakeUniverseDust, rebakeUniverseNebulae, onUniverseProgress } from '../world/universePrep';
import { AmbientMusic } from '../audio/ambient';
import { geologyFor } from '../world/geology';
import { insolationAt, localTemp01, METERS_PER_LEVEL } from '../world/toygen';
import {
  ENGINEER_GROUPS,
  atDefault,
  knobDefault,
  knobsInGroup,
  liveKnob,
  rebuildKnob,
  type RebuildScope,
} from './liveKnobs';
import { IconCenter, IconGlobe, IconInspect, IconMusic, IconMusicOff, IconOrbits, IconSun, IconTrackball } from './icons';
import { SystemMap, mapAngleOf, planetsFromSpec, systemClock } from './SystemMap';
import { OrbitPick } from './OrbitPick';
import { InspectorPanel, type InspectedCell } from './InspectorPanel';
import { orbitLabel } from '../world/worldOrbit';

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
  /** Later travel (visits / import / forget) — does not remint the view. */
  go?: ExplorerGo | null;
  /** False while the explorer is kept warm but hidden. */
  active?: boolean;
  onReady?: () => void;
  onPlace?: (p: LastPlace) => void;
  onOpenVisits?: () => void;
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
  const resumeRef = useRef(props.resume);
  resumeRef.current = props.resume;
  const inspectRef = useRef<(hit: GlobePick | null) => void>(() => {});
  const active = props.active !== false;
  const [ready, setReady] = useState(false);
  const [inspect, setInspect] = useState<{ body: BodySpec; cell: InspectedCell | null } | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const musicRef = useRef<AmbientMusic | null>(null);
  const [engineer, setEngineer] = useState<string | null>(null);
  const [knobVal, setKnobVal] = useState(0);
  const [knobDirty, setKnobDirty] = useState(false);
  const [menu, setMenu] = useState<null | 'view' | 'engineer'>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [orbitPick, setOrbitPick] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [rebuilding, setRebuilding] = useState<null | RebuildScope>(null);
  const [rebuildFrac, setRebuildFrac] = useState(0);
  const [rebuildLabel, setRebuildLabel] = useState('');
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
    landed: false,
    canLand: false,
    lookHold: null,
    drone: false,
    showSunLook: false,
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
          onInspect: (hit) => inspectRef.current(hit),
          onFrame: (f) => {
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
              prev.landed !== f.landed ||
              prev.canLand !== f.canLand ||
              prev.lookHold !== f.lookHold ||
              prev.drone !== f.drone ||
              prev.showSunLook !== f.showSunLook ||
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
    if (!ready) return;
    const flush = (): void => {
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

  useEffect(() => {
    return onUniverseProgress((p) => {
      setRebuildFrac(p.frac);
      setRebuildLabel(p.label);
    });
  }, []);

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
    if (frame.hostId == null) setMapOpen(false);
  }, [frame.hostId]);

  function openKnob(id: string): void {
    const live = liveKnob(id);
    if (live) {
      setKnobVal(viewRef.current?.liveUniform(live.uniform) ?? live.read());
      setKnobDirty(false);
      setEngineer(id);
      return;
    }
    const rebuild = rebuildKnob(id);
    if (!rebuild) return;
    setKnobVal(rebuild.read());
    setKnobDirty(false);
    setEngineer(id);
  }

  function slideKnob(id: string, raw: number): void {
    const v = Number(raw);
    const live = liveKnob(id);
    if (live) {
      setKnobVal(v);
      setKnobDirty(false);
      live.write?.(v);
      viewRef.current?.setLiveUniform(live.uniform, v);
      return;
    }
    const rebuild = rebuildKnob(id);
    if (!rebuild) return;
    setKnobVal(v);
    setKnobDirty(Math.abs(v - rebuild.read()) > rebuild.step * 0.25);
  }

  function pickSetting(id: string): void {
    if (!id) return;
    openKnob(id);
    setMenu('engineer');
  }

  function closeKnob(): void {
    setKnobDirty(false);
    setEngineer(null);
  }

  function cancelRebuild(): void {
    const k = engineer ? rebuildKnob(engineer) : undefined;
    setKnobDirty(false);
    if (k) setKnobVal(k.read());
  }

  function toggleGroup(id: string): void {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function resetToDefault(): void {
    if (!spec || !engineer || rebuilding) return;
    const v = knobDefault(spec);
    if (live) {
      setKnobVal(v);
      live.write?.(v);
      viewRef.current?.setLiveUniform(live.uniform, v);
      return;
    }
    if (rebuild) {
      setKnobVal(v);
      setKnobDirty(Math.abs(v - rebuild.read()) > rebuild.step * 0.25);
    }
  }

  async function confirmRebuild(id: string): Promise<void> {
    const k = rebuildKnob(id);
    const view = viewRef.current;
    if (!k || !view || rebuilding) return;
    k.write(knobVal);
    setRebuildFrac(0);
    setRebuildLabel(
      k.scope === 'harvest' ? 'Walking the disk…' : k.scope === 'nebula' ? 'Collecting nebulae…' : 'Baking the fog…',
    );
    setRebuilding(k.scope);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    try {
      if (k.scope === 'harvest') {
        await remintUniverse(seed);
        view.replaceSky();
      } else if (k.scope === 'nebula') {
        await rebakeUniverseNebulae(seed);
        view.replaceNebulae();
      } else {
        rebakeUniverseDust(seed);
        view.replaceDust();
      }
    } finally {
      setRebuilding(null);
      setKnobDirty(false);
    }
  }

  inspectRef.current = (hit) => {
    const body = viewRef.current?.inspectBody();
    if (!body) return;
    setInspect({
      body,
      cell: hit && hit.bodyId === body.id ? cellInspect(body, hit) : null,
    });
  };

  useEffect(() => {
    if (!frame.landed && !frame.orbiting) setInspect(null);
  }, [frame.landed, frame.orbiting, frame.hostId]);

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
  const live = engineer ? liveKnob(engineer) : undefined;
  const rebuild = engineer ? rebuildKnob(engineer) : undefined;
  const spec = live ?? rebuild;
  const isDefault = Boolean(spec && atDefault(spec, knobVal));
  const editing = Boolean(spec);
  const chartId = frame.hostId;
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
        {!ready && <div className="galaxy-loading">Opening the neighbourhood…</div>}
        {rebuilding && (
          <div className="gx-rebuild" role="status">
            <b>
              {rebuildLabel ||
                (rebuilding === 'harvest'
                  ? 'Walking the disk…'
                  : rebuilding === 'nebula'
                    ? 'Collecting nebulae…'
                    : 'Baking the fog…')}
            </b>
            <progress max={100} value={Math.round(rebuildFrac * 100)} />
            <em>{Math.round(rebuildFrac * 100)}%</em>
          </div>
        )}
        {inRegion && !editing && <div className="gx-pip" aria-hidden />}
        {inRegion && !editing && frame.hostId != null && (
          <div className="gx-look">
            <button
              type="button"
              className={`gx-look-btn${frame.lookHold === 'center' ? ' is-on' : ''}`}
              aria-label="Center"
              title="Center — hold look on the primary"
              onClick={() => viewRef.current?.centerLook()}
            >
              <IconCenter size={18} />
            </button>
            {frame.showSunLook && (
              <button
                type="button"
                className={`gx-look-btn${frame.lookHold === 'sun' ? ' is-on' : ''}`}
                aria-label="Sun"
                title="Sun — hold look on the star"
                onClick={() => viewRef.current?.sunLook()}
              >
                <IconSun size={18} />
              </button>
            )}
            <button
              type="button"
              className={`gx-look-btn${frame.drone ? ' is-on' : ''}`}
              aria-label="Trackball"
              title={frame.drone ? 'Leave trackball — back to the ship' : 'Trackball — roll the world'}
              onClick={() => viewRef.current?.setDrone(!frame.drone)}
            >
              <IconTrackball size={18} />
            </button>
          </div>
        )}
        {inRegion && !editing && (
          <div className="gx-helm">
            {frame.landed ? (
              <button
                type="button"
                className="gx-warp"
                onClick={() => viewRef.current?.takeOff()}
              >
                Take off
              </button>
            ) : (
              <>
                {!frame.warp && (
                  <button
                    type="button"
                    className={`gx-gear${frame.astern ? ' astern' : ''}`}
                    aria-label={frame.astern ? 'Astern' : 'Ahead'}
                    title={frame.astern ? 'Astern' : 'Ahead'}
                    onClick={() => viewRef.current?.toggleGear()}
                  >
                    {frame.astern ? '↓' : '↑'}
                  </button>
                )}
                <button
                  type="button"
                  className={`gx-warp${frame.warp ? ' stop' : ''}`}
                  onClick={() => viewRef.current?.setWarp(!frame.warp)}
                >
                  {frame.warp ? 'Stop' : 'Warp'}
                </button>
              </>
            )}
          </div>
        )}
        {inRegion && !editing && (frame.course || frame.focus) && (
          <div className="gx-plate">
            <b>{(frame.course ?? frame.focus)!.name}</b>
            <em>
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
            {frame.course && !frame.landed && (
              <i className="gx-plate-dist">{formatCatalogDist(frame.course.dist)}</i>
            )}
            {frame.landed ? (
              <i className="gx-plate-go">On the ground</i>
            ) : frame.canLand ? (
              <button
                type="button"
                className="gx-plate-go"
                onClick={() => viewRef.current?.land()}
              >
                Land
              </button>
            ) : frame.orbiting && frame.orbit ? (
              <i className="gx-plate-go">{orbitLabel(frame.orbit)}</i>
            ) : frame.orbit && frame.course ? (
              <i className="gx-plate-go">Warping to {orbitLabel(frame.orbit)}</i>
            ) : frame.course ? (
              <i className="gx-plate-go">Course Locked</i>
            ) : (
              <button
                type="button"
                className="gx-plate-go"
                onClick={() => {
                  const view = viewRef.current;
                  if (!view) return;
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
                    disabled={frame.landed || frame.drone}
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
          {!editing && (frame.landed || frame.orbiting) && viewRef.current?.inspectBody() && (
            <button
              type="button"
              className={`gx-chip gx-icon${inspect ? ' active' : ''}`}
              aria-label="Inspect"
              title="Inspect — tap a hex when landed"
              onClick={() => {
                const body = viewRef.current?.inspectBody();
                if (!body) return;
                setInspect((cur) => (cur ? null : { body, cell: null }));
              }}
            >
              <IconInspect size={16} />
            </button>
          )}
          <div className={`gx-drop gx-drop-eng-wrap${menu === 'engineer' ? ' is-open' : ''}`}>
            <button
              type="button"
              className={`gx-chip${menu === 'engineer' ? ' active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={menu === 'engineer'}
              disabled={Boolean(rebuilding)}
              onClick={() => {
                viewRef.current?.setWarp(false);
                setMenu((m) => (m === 'engineer' ? null : 'engineer'));
              }}
            >
              Cosmic engineer
            </button>
            {menu === 'engineer' && (
              <div className="gx-drop-menu gx-drop-eng" role="menu" aria-label="Cosmic engineer">
                {ENGINEER_GROUPS.map((g) => {
                  const open = openGroups.has(g.id);
                  return (
                    <div key={g.id} className="gx-eng-group">
                      <button
                        type="button"
                        className={`gx-eng-group-label${open ? ' is-open' : ''}`}
                        aria-expanded={open}
                        onClick={() => toggleGroup(g.id)}
                      >
                        {g.label}
                      </button>
                      {open &&
                        knobsInGroup(g.id).map((k) => (
                          <button
                            key={k.id}
                            type="button"
                            role="menuitem"
                            className={`gx-eng-item${k.remint ? ' is-rebuild' : ''}${engineer === k.id ? ' is-on' : ''}`}
                            onClick={() => pickSetting(k.id)}
                          >
                            <b>{k.label}</b>
                            <i>{k.hint}</i>
                          </button>
                        ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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

      {spec && engineer && (
        <footer className="galaxy-bottom is-eng">
          <div className="gx-eng">
            <div className="gx-eng-top">
              <div>
                <div className="gx-kicker">Cosmic engineer</div>
                <b className="gx-eng-name">{spec.label}</b>
              </div>
              <button
                type="button"
                className="gx-chip gx-close"
                disabled={Boolean(rebuilding)}
                onClick={closeKnob}
              >
                Close
              </button>
            </div>
            <p className="gx-eng-about">{spec.about}</p>
            <div className="gx-eng-slider">
              <input
                type="range"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={knobVal}
                disabled={Boolean(rebuilding)}
                onChange={(e) => slideKnob(engineer, Number(e.target.value))}
              />
              <em>
                {spec.step >= 1
                  ? String(Math.round(knobVal))
                  : knobVal.toFixed(
                      spec.step >= 0.01 ? (knobVal >= 10 ? 1 : 2) : spec.step >= 0.001 ? 3 : 4,
                    )}
              </em>
            </div>
            {(!isDefault || (rebuild && knobDirty)) && (
              <div className="gx-eng-actions">
                {!isDefault && (
                  <button
                    type="button"
                    className="gx-chip gx-eng-reset"
                    disabled={Boolean(rebuilding)}
                    onClick={resetToDefault}
                  >
                    Reset to default
                  </button>
                )}
                {rebuild && knobDirty && (
                  <>
                    <button
                      type="button"
                      className="gx-chip gx-eng-go"
                      disabled={Boolean(rebuilding)}
                      onClick={() => void confirmRebuild(engineer)}
                    >
                      Rebuild
                    </button>
                    <button
                      type="button"
                      className="gx-chip"
                      disabled={Boolean(rebuilding)}
                      onClick={cancelRebuild}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </footer>
      )}

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
    </div>
  );
}
