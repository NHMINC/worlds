import { useEffect, useRef, useState } from 'react';
import { UNIVERSE } from '../world/physics';
import { classifyStar } from '../world/stellar';
import type { GalaxyObject } from '../world/galaxy';
import { GalaxyView, type GalaxyFrame, type GalaxyPreset } from '../render/galaxyView';
import { remintUniverse, rebakeUniverseDust, onUniverseProgress } from '../world/universePrep';
import { ENGINEER_GROUPS, knobsInGroup, liveKnob, rebuildKnob } from './liveKnobs';

const PRESETS: Array<{ id: GalaxyPreset; label: string }> = [
  { id: 'face', label: 'Face-on' },
  { id: 'edge', label: 'Edge-on' },
  { id: 'home', label: 'Home' },
  { id: 'back', label: 'Back' },
];

interface Props {
  galaxySeed?: string;
  hereStarId?: number | null;
  visitedStarIds?: number[];
  /** False on an empty save — there is no system to return to. */
  canClose?: boolean;
  /** False while the explorer is kept warm but hidden. */
  active?: boolean;
  onSetCourse: (obj: GalaxyObject) => void;
  onClose: () => void;
  onReady?: () => void;
}

export function GalaxyExplorer(props: Props) {
  const seed = props.galaxySeed ?? UNIVERSE.CANONICAL_SEED;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<GalaxyView | null>(null);
  const goRef = useRef(props.onSetCourse);
  goRef.current = props.onSetCourse;
  const hereRef = useRef(props.hereStarId ?? null);
  hereRef.current = props.hereStarId ?? null;
  const readyRef = useRef(props.onReady);
  readyRef.current = props.onReady;
  const active = props.active !== false;
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<GalaxyObject | null>(null);
  const [engineer, setEngineer] = useState<null | 'pick' | string>(null);
  const [knobVal, setKnobVal] = useState(0);
  const [knobDirty, setKnobDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState<null | 'harvest' | 'dust'>(null);
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
    warp: false,
    backdrop: 0,
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
          onSelect: setSelected,
          onGo: (obj) => goRef.current(obj),
          onFrame: (f) => {
            setFrame((prev) =>
              prev.mode !== f.mode ||
              Math.abs(prev.radius - f.radius) > 0.08 ||
              Math.abs(prev.phi - f.phi) > 0.02 ||
              prev.pickable !== f.pickable ||
              prev.resolved !== f.resolved ||
              prev.grown !== f.grown ||
              prev.sector !== f.sector ||
              prev.warp !== f.warp ||
              prev.backdrop !== f.backdrop ||
              prev.focus?.id !== f.focus?.id ||
              (f.focus != null &&
                (Math.abs((prev.focus?.x ?? 0) - f.focus.x) > 2 ||
                  Math.abs((prev.focus?.y ?? 0) - f.focus.y) > 2))
                ? f
                : prev,
            );
          },
        },
        hereRef.current,
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
    viewRef.current?.openAtHere();
  }, [props.hereStarId, ready]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !ready) return;
    view.setActive(active);
    if (active && wrapRef.current) {
      view.resize(wrapRef.current.clientWidth, wrapRef.current.clientHeight);
    }
  }, [active, ready]);

  useEffect(() => {
    if (ready) viewRef.current?.setVisited(props.visitedStarIds ?? []);
  }, [props.visitedStarIds, ready]);

  useEffect(() => {
    return onUniverseProgress((p) => {
      setRebuildFrac(p.frac);
      setRebuildLabel(p.label);
    });
  }, []);

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
    if (!id) {
      setKnobDirty(false);
      setEngineer('pick');
      setMenuOpen(true);
      return;
    }
    openKnob(id);
    setMenuOpen(false);
  }

  function cancelRebuild(): void {
    const k = engineer && engineer !== 'pick' ? rebuildKnob(engineer) : undefined;
    setKnobDirty(false);
    if (k) setKnobVal(k.read());
  }

  async function confirmRebuild(id: string): Promise<void> {
    const k = rebuildKnob(id);
    const view = viewRef.current;
    if (!k || !view || rebuilding) return;
    k.write(knobVal);
    setRebuildFrac(0);
    setRebuildLabel(k.scope === 'harvest' ? 'Walking the disk…' : 'Baking the fog…');
    setMenuOpen(false);
    setRebuilding(k.scope);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    try {
      if (k.scope === 'harvest') {
        await remintUniverse(seed);
        view.replaceSky();
      } else {
        rebakeUniverseDust(seed);
        view.replaceDust();
      }
    } finally {
      setRebuilding(null);
      setKnobDirty(false);
    }
  }

  const st = selected?.star;
  const cls = st ? classifyStar(st) : '';
  const inRegion = frame.mode === 'region';
  const live = engineer && engineer !== 'pick' ? liveKnob(engineer) : undefined;
  const rebuild = engineer && engineer !== 'pick' ? rebuildKnob(engineer) : undefined;
  const spec = live ?? rebuild;

  return (
    <div
      className={`galaxy-explorer${active ? '' : ' is-dormant'}`}
      aria-hidden={!active}
      inert={!active ? true : undefined}
    >
      <div ref={wrapRef} className="galaxy-stage">
        <canvas ref={canvasRef} />
        {!ready && <div className="galaxy-loading">Opening the neighbourhood…</div>}
        {rebuilding && (
          <div className="gx-rebuild" role="status">
            <b>{rebuildLabel || (rebuilding === 'harvest' ? 'Walking the disk…' : 'Baking the fog…')}</b>
            <progress max={100} value={Math.round(rebuildFrac * 100)} />
            <em>{Math.round(rebuildFrac * 100)}%</em>
          </div>
        )}
        {inRegion && !engineer && <div className="gx-pip" aria-hidden />}
        {inRegion && !engineer && (
          <button
            type="button"
            className={`gx-warp${frame.warp ? ' stop' : ''}`}
            onClick={() => viewRef.current?.setWarp(!frame.warp)}
          >
            {frame.warp ? 'Stop' : 'Warp'}
          </button>
        )}
        {inRegion && !engineer && frame.focus && (
          <div className="gx-plate">
            <b>{frame.focus.name}</b>
            <em>
              {frame.focus.cls} · {frame.focus.phase}
            </em>
            <i>
              {frame.focus.planets} planet{frame.focus.planets === 1 ? '' : 's'}
              {frame.focus.moons ? ` · ${frame.focus.moons} moon${frame.focus.moons === 1 ? '' : 's'}` : ''}
              {frame.focus.life ? ' · life' : ''}
            </i>
            <button
              type="button"
              className="gx-plate-go"
              onClick={() => {
                const o = viewRef.current?.focusedObject();
                if (o) props.onSetCourse(o);
              }}
            >
              Set course
            </button>
          </div>
        )}
      </div>

      <header className="galaxy-top">
        <div className="galaxy-brand">
          <div className="galaxy-title">Helix{frame.sector ? ` · ${frame.sector}` : ''}</div>
          <div className="galaxy-sub">
            {`${frame.population.toLocaleString()} luminous · dust is extinction`}
          </div>
        </div>
        <div className="galaxy-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className="gx-chip" onClick={() => viewRef.current?.setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {props.canClose !== false && (
          <button className="gx-chip gx-close" onClick={props.onClose}>
            Return
          </button>
        )}
      </header>

      {selected && st && (
        <aside className="galaxy-dossier">
          <div className="gd-head">
            <div className="gd-kicker">
              {selected.pop} {selected.inArm ? '· arm' : ''}
              {props.visitedStarIds?.includes(selected.id) ? ' · visited' : ''}
            </div>
            <button
              type="button"
              className="gd-x"
              aria-label="Close star detail"
              onClick={() => viewRef.current?.dismiss()}
            >
              ×
            </button>
          </div>
          <div className="gd-class">{cls}</div>
          <div className="gd-phase">{st.phase.replace(/_/g, ' ')}</div>
          <dl className="gd-grid">
            <div><dt>R</dt><dd>{selected.pos.R.toFixed(2)} kpc</dd></div>
            <div><dt>z</dt><dd>{selected.pos.z.toFixed(2)} kpc</dd></div>
            <div><dt>Age</dt><dd>{st.ageGyr.toFixed(2)} Gyr</dd></div>
            <div><dt>Mass</dt><dd>{st.mass.toFixed(2)} M☉</dd></div>
            <div><dt>L</dt><dd>{st.luminosity < 0.01 ? st.luminosity.toExponential(1) : st.luminosity.toFixed(2)} L☉</dd></div>
            <div><dt>Teff</dt><dd>{st.teff > 0 ? `${Math.round(st.teff)} K` : '—'}</dd></div>
            <div><dt>[Fe/H]</dt><dd>{st.feh >= 0 ? '+' : ''}{st.feh.toFixed(2)}</dd></div>
            <div><dt>C/O</dt><dd>{st.carbon.toFixed(2)}</dd></div>
          </dl>
          {st.nebula !== 'none' && <div className="gd-nebula">{st.nebula === 'hii' ? 'H II region' : st.nebula === 'planetary' ? 'Planetary nebula' : 'Supernova remnant'}</div>}
          <div className="gd-id">#{selected.id}</div>
          <button className="gd-go" onClick={() => props.onSetCourse(selected)}>
            Set course
          </button>
        </aside>
      )}

      <footer className={`galaxy-bottom${engineer ? ' is-eng' : ''}`}>
        {engineer && (
          <>
            <div className="gx-eng-head">
              <div className="gx-kicker">Cosmic engineer</div>
              <button
                type="button"
                className={`gx-eng-select${rebuild ? ' is-rebuild' : ''}${menuOpen ? ' is-open' : ''}`}
                disabled={Boolean(rebuilding)}
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                aria-label="Cosmic engineer setting"
                onClick={() => setMenuOpen((open) => !open)}
              >
                {spec ? (
                  <>
                    <b>{spec.label}</b>
                    <i>{spec.hint}</i>
                  </>
                ) : (
                  <b>Choose a setting…</b>
                )}
              </button>
              {rebuild && knobDirty ? (
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
                    className="gx-chip gx-close"
                    disabled={Boolean(rebuilding)}
                    onClick={cancelRebuild}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="gx-chip gx-close"
                  onClick={() => {
                    setMenuOpen(false);
                    setEngineer(null);
                  }}
                >
                  Close
                </button>
              )}
              {menuOpen && (
                <div className="gx-eng-menu" role="listbox" aria-label="Cosmic settings">
                  {ENGINEER_GROUPS.map((g) => (
                    <div key={g.id} className="gx-eng-group">
                      <div className="gx-eng-group-label">{g.label}</div>
                      {knobsInGroup(g.id).map((k) => (
                        <button
                          key={k.id}
                          type="button"
                          role="option"
                          aria-selected={engineer === k.id}
                          className={`gx-eng-item${k.remint ? ' is-rebuild' : ''}${engineer === k.id ? ' is-on' : ''}`}
                          onClick={() => pickSetting(k.id)}
                        >
                          <b>{k.label}</b>
                          <i>{k.hint}</i>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {spec && <p className="gx-eng-about">{spec.about}</p>}
            {spec && engineer !== 'pick' && (
              <div className="gx-eng-row">
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={knobVal}
                  disabled={Boolean(rebuilding)}
                  onChange={(e) => slideKnob(engineer, Number(e.target.value))}
                />
                <em>{knobVal.toFixed(knobVal >= 10 ? 1 : 2)}</em>
              </div>
            )}
          </>
        )}
        {!engineer && (
          <button
            type="button"
            className="gx-chip"
            onClick={() => {
              viewRef.current?.setWarp(false);
              setMenuOpen(true);
              setEngineer('pick');
            }}
          >
            Cosmic engineer
          </button>
        )}
      </footer>
    </div>
  );
}
