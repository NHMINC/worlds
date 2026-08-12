import { useEffect, useRef } from 'react';
import type { OrbitStyle, ViewState } from '../render/engine';

interface Props {
  subscribe: (fn: (v: ViewState) => void) => () => void;
  onEnterOrbit: (style: OrbitStyle) => void;
}

function fmtKm(km: number): string {
  if (km >= 100) return `${Math.round(km).toLocaleString()} km`;
  return `${km.toFixed(1)} km`;
}

/**
 * Minimal ship HUD, only visible in flight: nearest (or targeted) body,
 * distance, speed, and the enter-orbit affordance. Driven by direct DOM
 * writes from the frame stream, like the labels overlay, so it never
 * re-renders React at 60 fps.
 */
export function FlightHud(props: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const distRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const geoBtnRef = useRef<HTMLButtonElement>(null);
  const { subscribe } = props;

  useEffect(
    () =>
      subscribe((v) => {
        const root = rootRef.current;
        if (!root) return;
        const show = v.mode === 'flight' && v.flight !== null;
        root.style.display = show ? '' : 'none';
        if (!show || !v.flight) return;
        if (nameRef.current) nameRef.current.textContent = v.flight.bodyName;
        if (distRef.current) distRef.current.textContent = fmtKm(v.flight.distanceKm);
        if (speedRef.current) speedRef.current.textContent = `${v.flight.speedKmS.toFixed(1)} km/s`;
        if (btnRef.current) btnRef.current.disabled = !v.flight.canOrbit;
        if (geoBtnRef.current) geoBtnRef.current.disabled = !v.flight.canOrbit;
      }),
    [subscribe],
  );

  return (
    <div ref={rootRef} className="flight-hud" style={{ display: 'none' }}>
      <div className="hud-row">
        <span ref={nameRef} className="hud-name" />
        <span ref={distRef} className="hud-dist" />
        <span ref={speedRef} className="hud-speed" />
        <button
          ref={btnRef}
          className="btn primary hud-orbit"
          title="Low orbit: circle the world while it turns beneath you"
          onClick={() => props.onEnterOrbit('station')}
        >
          Orbit
        </button>
        <button
          ref={geoBtnRef}
          className="btn hud-orbit"
          title="Geostationary: hang over one spot"
          onClick={() => props.onEnterOrbit('geo')}
        >
          Geo
        </button>
      </div>
      <div className="hud-hint">drag to steer · scroll or W/S for thrust · tap a world to visit</div>
    </div>
  );
}
