import { useEffect, useRef } from 'react';

/**
 * The system map: a top-down schematic of the whole star system. Orbits are
 * rank-spaced (the real spacing is geometric, so even rings read better than
 * a physical scale), but every body rides its live orbital angle, so the map
 * drifts in real time. Tap any world to fly there.
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
  /** Radius in Earth radii, mapped to dot size. */
  radius: number;
  ring: boolean;
  moons: MapMoon[];
}

interface Props {
  starName: string;
  starColor: string;
  planets: MapPlanet[];
  currentBodyId: string;
  /** Per-frame tick (engine or explorer) driving the live drift. */
  subscribe: (fn: () => void) => () => void;
  angleOf: (id: string) => number;
  onTravel: (id: string) => void;
  onClose: () => void;
}

const RING_MIN = 26;
const RING_MAX = 96;

function dotSize(radius: number): number {
  return 2.2 + Math.sqrt(radius) * 1.05;
}

export function SystemMap(props: Props) {
  const { planets, subscribe, angleOf } = props;
  const groupRefs = useRef(new Map<string, SVGGElement>());

  const ringR = (i: number): number =>
    planets.length <= 1
      ? (RING_MIN + RING_MAX) / 2
      : RING_MIN + ((RING_MAX - RING_MIN) * i) / (planets.length - 1);

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
    return subscribe(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planets, subscribe, angleOf]);

  const setRef = (id: string) => (el: SVGGElement | null) => {
    if (el) groupRefs.current.set(id, el);
    else groupRefs.current.delete(id);
  };

  const travel = (id: string) => {
    props.onTravel(id);
    props.onClose();
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal sysmap-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sysmap-head">
          <h2>{props.starName}</h2>
          <button className="btn" onClick={props.onClose}>Close</button>
        </div>
        <svg className="sysmap" viewBox="-110 -110 220 220">
          <defs>
            <radialGradient id="sm-star-glow">
              <stop offset="0%" stopColor={props.starColor} stopOpacity="0.55" />
              <stop offset="100%" stopColor={props.starColor} stopOpacity="0" />
            </radialGradient>
          </defs>

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
                  onClick={() => travel(p.id)}
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
                      onClick={() => travel(m.id)}
                    >
                      <title>{m.name}</title>
                    </circle>
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
        <p className="modal-note sysmap-note">Tap a world to fly there.</p>
      </div>
    </div>
  );
}
