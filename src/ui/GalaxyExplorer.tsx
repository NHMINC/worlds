import { useEffect, useRef, useState } from 'react';
import { UNIVERSE } from '../world/physics';
import { classifyStar } from '../world/stellar';
import type { GalaxyObject } from '../world/galaxy';
import { GalaxyView, type GalaxyFilter, type GalaxyFrame, type GalaxyPreset } from '../render/galaxyView';

const FILTERS: Array<{ id: GalaxyFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'hot', label: 'Hot' },
  { id: 'sunlike', label: 'Sunlike' },
  { id: 'cool', label: 'Cool' },
  { id: 'remnant', label: 'Remnants' },
  { id: 'nebula', label: 'Nebulae' },
  { id: 'arm', label: 'Arms' },
  { id: 'halo', label: 'Halo' },
];

const PRESETS: Array<{ id: GalaxyPreset; label: string }> = [
  { id: 'face', label: 'Face-on' },
  { id: 'edge', label: 'Edge-on' },
  { id: 'home', label: 'Home' },
  { id: 'arm', label: 'Arm' },
];

interface Props {
  galaxySeed?: string;
  hereStarId?: number | null;
  visitedStarIds?: number[];
  onSetCourse: (obj: GalaxyObject) => void;
  onClose: () => void;
}

export function GalaxyExplorer(props: Props) {
  const seed = props.galaxySeed ?? UNIVERSE.CANONICAL_SEED;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<GalaxyView | null>(null);
  const goRef = useRef(props.onSetCourse);
  goRef.current = props.onSetCourse;
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<GalaxyObject | null>(null);
  const [filter, setFilter] = useState<GalaxyFilter>('all');
  const [census, setCensus] = useState<Record<string, number>>({});
  const [frame, setFrame] = useState<GalaxyFrame>({
    theta: 0,
    phi: 0,
    radius: 40,
    pickable: false,
    resolved: 0,
    discs: 0,
  });
  const [count, setCount] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let cancelled = false;
    let view: GalaxyView | null = null;
    let ro: ResizeObserver | null = null;
    const boot = window.setTimeout(() => {
      if (cancelled) return;
      view = new GalaxyView(canvas, seed, {
        onSelect: setSelected,
        onGo: (obj) => goRef.current(obj),
        onFrame: (f) => {
          setFrame((prev) =>
            Math.abs(prev.radius - f.radius) > 0.08 ||
            Math.abs(prev.phi - f.phi) > 0.02 ||
            prev.pickable !== f.pickable ||
            Math.abs(prev.resolved - f.resolved) > 2 ||
            prev.discs !== f.discs
              ? f
              : prev,
          );
        },
      });
      view.setHere(props.hereStarId ?? null);
      viewRef.current = view;
      (window as unknown as { __galaxyView?: GalaxyView }).__galaxyView = view;
      setCensus(view.census());
      setCount(view.beaconCount());
      setReady(true);
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
  }, [seed, props.hereStarId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !ready) return;
    setCensus(view.census());
    setCount(frame.resolved);
  }, [frame.resolved, filter, ready]);

  function applyFilter(f: GalaxyFilter): void {
    setFilter(f);
    viewRef.current?.setFilter(f);
    if (viewRef.current) {
      setCensus(viewRef.current.census());
      setCount(viewRef.current.beaconCount());
    }
  }

  const st = selected?.star;
  const cls = st ? classifyStar(st) : '';
  const incDeg = (frame.phi * 180) / Math.PI;
  const censusKeys = Object.keys(census).sort((a, b) => (census[b] ?? 0) - (census[a] ?? 0));
  const censusMax = Math.max(1, ...censusKeys.map((k) => census[k] ?? 0));

  return (
    <div className="galaxy-explorer">
      <div ref={wrapRef} className="galaxy-stage">
        <canvas ref={canvasRef} />
        {!ready && <div className="galaxy-loading">Evaluating the mass model…</div>}
      </div>

      <header className="galaxy-top">
        <div className="galaxy-brand">
          <div className="galaxy-title">Helix</div>
          <div className="galaxy-sub">
            {frame.pickable
              ? `SBbc · ${count} systems in reach`
              : `SBbc · ${UNIVERSE.GALAXY_POPULATION.toExponential(0)} addressable systems · zoom in`}
          </div>
        </div>
        <div className="galaxy-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className="gx-chip" onClick={() => viewRef.current?.setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <button className="gx-chip gx-close" onClick={props.onClose}>
          Return
        </button>
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

      <aside className="galaxy-census">
        <div className="gx-kicker">In view</div>
        {censusKeys.slice(0, 8).map((k) => (
          <div key={k} className="gx-bar-row">
            <span>{k}</span>
            <i style={{ width: `${(100 * (census[k] ?? 0)) / censusMax}%` }} />
            <em>{census[k]}</em>
          </div>
        ))}
      </aside>

      <footer className="galaxy-bottom">
        <div className="galaxy-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`gx-chip ${filter === f.id ? 'active' : ''}`}
              onClick={() => applyFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="galaxy-readout">
          i {incDeg.toFixed(0)}° · {frame.radius.toFixed(1)} kpc
          {frame.discs > 0 ? ' · tap a star to go' : frame.pickable ? ' · tap a star' : ' · fly in to pick'}
        </div>
      </footer>
    </div>
  );
}
