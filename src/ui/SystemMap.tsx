import { useEffect, useRef } from 'react';
import type { ViewState } from '../render/engine';
import { UNIVERSE } from '../world/physics';
import { keplerPlane, type SystemSpec } from '../world/systemgen';

/**
 * The system map: a top-down schematic of the whole star system. Orbits are
 * rank-spaced (the real spacing is geometric, so even rings read better than
 * a physical scale), but every body rides its live orbital angle, so the map
 * drifts in real time. In the world viewer, tap a world to fly there. In the
 * explorer the same chart is zoomable — pinch / wheel / drag — and a tap
 * does nothing yet.
 */

export interface MapMoon {
  id: string;
  name: string;
  color: string;
}

export interface MapPlanet {
  id: string;
  name: string;
  color: string;
  kind: 'rocky' | 'gas';
  /** Relative radius (Earth = 1), mapped to dot size. */
  radius: number;
  ring: boolean;
  moons: MapMoon[];
}

interface Props {
  starName: string;
  starColor: string;
  planets: MapPlanet[];
  currentBodyId?: string;
  subscribe?: (fn: (v: ViewState) => void) => () => void;
  angleOf: (id: string) => number;
  onTravel?: (id: string) => void;
  onClose: () => void;
  /** Pinch / wheel zoom and drag-pan. Explorer chart. */
  zoomable?: boolean;
}

const RING_MIN = 26;
const RING_MAX = 96;
const VIEW = 220;
const HALF = VIEW / 2;
const ZOOM_MIN = 1;
const ZOOM_MAX = 14;

function dotSize(radius: number): number {
  return 2.2 + Math.sqrt(radius) * 1.05;
}

function cssColor(c: readonly number[]): string {
  return `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
}

/** Rank-spaced rings, Earth-relative dots. Shared by both viewers. */
export function planetsFromSpec(spec: SystemSpec, nameOf?: (id: string, fallback: string) => string): MapPlanet[] {
  const name = (id: string, fallback: string) => nameOf?.(id, fallback) ?? fallback;
  return spec.bodies
    .filter((b) => !b.parent)
    .map((b) => ({
      id: b.id,
      name: name(b.id, b.name),
      color: cssColor(b.meanColor),
      kind: b.kind,
      radius: b.radius / UNIVERSE.R_HOME,
      ring: b.kind === 'gas' && Boolean(b.gas?.ring),
      moons: spec.bodies
        .filter((m) => m.parent === b.id)
        .map((m) => ({ id: m.id, name: name(m.id, m.name), color: cssColor(m.meanColor) })),
    }));
}

/** In-plane Kepler angle for the schematic. Same clock as the engine. */
export function mapAngleOf(spec: SystemSpec, bodyId: string, t: number): number {
  const b = spec.bodies.find((row) => row.id === bodyId);
  if (!b) return 0;
  const { xo, yo } = keplerPlane(b.orbitRadius, b.orbitPeriod, b.orbitPhase, b.ecc, t);
  return Math.atan2(yo, xo);
}

export function systemClock(): number {
  return (Date.now() / 1000) * UNIVERSE.TIME_SCALE;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function SystemMap(props: Props) {
  const { planets, subscribe, angleOf, zoomable } = props;
  const groupRefs = useRef(new Map<string, SVGGElement>());
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const view = useRef({ z: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch0 = useRef(0);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const ringR = (i: number): number =>
    planets.length <= 1
      ? (RING_MIN + RING_MAX) / 2
      : RING_MIN + ((RING_MAX - RING_MIN) * i) / (planets.length - 1);

  const applyWorld = (): void => {
    const v = view.current;
    worldRef.current?.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.z})`);
  };

  const clientToSvg = (cx: number, cy: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const zoomAt = (factor: number, sx: number, sy: number): void => {
    const v = view.current;
    const next = clamp(v.z * factor, ZOOM_MIN, ZOOM_MAX);
    if (next === v.z) return;
    v.x = sx - ((sx - v.x) * next) / v.z;
    v.y = sy - ((sy - v.y) * next) / v.z;
    v.z = next;
    if (v.z <= ZOOM_MIN + 1e-4) {
      v.z = 1;
      v.x = 0;
      v.y = 0;
    }
    applyWorld();
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !zoomable) return;
    const onNativeWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = clientToSvg(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
    };
    svg.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onNativeWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomable]);

  // Live drift: move each body's group to its current orbital angle every
  // frame, without React re-renders (same pattern as the overlays).
  useEffect(() => {
    const apply = () => {
      planets.forEach((p, i) => {
        const g = groupRefs.current.get(p.id);
        if (!g) return;
        const a = angleOf(p.id);
        const r = ringR(i);
        g.setAttribute('transform', `translate(${r * Math.cos(a)}, ${-r * Math.sin(a)})`);
        p.moons.forEach((m, j) => {
          const mg = groupRefs.current.get(m.id);
          if (!mg) return;
          const ma = angleOf(m.id);
          const mr = dotSize(p.radius) + 3.2 + j * 2.8;
          mg.setAttribute('transform', `translate(${mr * Math.cos(ma)}, ${-mr * Math.sin(ma)})`);
        });
      });
    };
    apply();
    if (subscribe) return subscribe(apply);
    let id = 0;
    const tick = (): void => {
      apply();
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planets, subscribe, angleOf]);

  const setRef = (id: string) => (el: SVGGElement | null) => {
    if (el) groupRefs.current.set(id, el);
    else groupRefs.current.delete(id);
  };

  const travel = (id: string) => {
    if (!props.onTravel) return;
    props.onTravel(id);
    props.onClose();
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!zoomable) return;
    const svg = svgRef.current;
    svg?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch0.current = Math.hypot(a.x - b.x, a.y - b.y);
      drag.current = null;
      return;
    }
    if (view.current.z > 1) {
      drag.current = { x: e.clientX, y: e.clientY, px: view.current.x, py: view.current.y };
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!zoomable) return;
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0.current > 8 && d > 8) {
        const mid = clientToSvg((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAt(d / pinch0.current, mid.x, mid.y);
        pinch0.current = d;
      }
      return;
    }
    const d0 = drag.current;
    if (!d0) return;
    const svg = svgRef.current;
    const w = svg?.clientWidth || 1;
    const k = VIEW / w;
    view.current.x = d0.px + (e.clientX - d0.x) * k;
    view.current.y = d0.py + (e.clientY - d0.y) * k;
    applyWorld();
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!zoomable) return;
    pointers.current.delete(e.pointerId);
    drag.current = null;
    pinch0.current = 0;
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className={`modal sysmap-modal${zoomable ? ' is-zoom' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sysmap-head">
          <h2>{props.starName}</h2>
          <button className="btn" onClick={props.onClose}>Close</button>
        </div>
        <svg
          ref={svgRef}
          className={`sysmap${zoomable ? ' is-zoom' : ''}`}
          viewBox={`${-HALF} ${-HALF} ${VIEW} ${VIEW}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            <radialGradient id="sm-star-glow">
              <stop offset="0%" stopColor={props.starColor} stopOpacity="0.55" />
              <stop offset="100%" stopColor={props.starColor} stopOpacity="0" />
            </radialGradient>
          </defs>

          <g ref={worldRef}>
            {/* Orbit rings, innermost to outermost. */}
            {planets.map((p, i) => (
              <circle key={`ring-${p.id}`} className="sm-ring" cx="0" cy="0" r={ringR(i)} />
            ))}

            {/* The star. */}
            <circle cx="0" cy="0" r="16" fill="url(#sm-star-glow)" />
            <circle cx="0" cy="0" r="6" fill={props.starColor} />

            {/* Planets ride their rings; moons ride their planets. */}
            {planets.map((p) => {
              const d = dotSize(p.radius);
              return (
                <g key={p.id} ref={setRef(p.id)}>
                  {p.id === props.currentBodyId && (
                    <circle className="sm-here" r={d + 2.6} />
                  )}
                  {p.ring && (
                    <ellipse className="sm-gas-ring" rx={d * 1.9} ry={d * 0.7} />
                  )}
                  <circle
                    className="sm-body"
                    r={d}
                    fill={p.color}
                    onClick={props.onTravel ? () => travel(p.id) : undefined}
                  >
                    <title>{p.name}</title>
                  </circle>
                  <text className="sm-name" y={d + 7.5}>{p.name}</text>
                  {p.moons.map((m) => (
                    <g key={m.id} ref={setRef(m.id)}>
                      {m.id === props.currentBodyId && (
                        <circle className="sm-here" r={2.6} />
                      )}
                      <circle className="sm-moon-dot" r={1.3} fill={m.color} />
                      {/* Generous invisible hit area: moon dots are tiny. */}
                      <circle
                        className="sm-body sm-moon-hit"
                        r={3.4}
                        onClick={props.onTravel ? () => travel(m.id) : undefined}
                      >
                        <title>{m.name}</title>
                      </circle>
                    </g>
                  ))}
                </g>
              );
            })}
          </g>
        </svg>
        <p className="modal-note sysmap-note">
          {zoomable ? 'Pinch or scroll to zoom. Drag to pan.' : 'Tap a world to fly there.'}
        </p>
      </div>
    </div>
  );
}
