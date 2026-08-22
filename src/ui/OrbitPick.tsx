import type { BodySpec } from '../world/systemgen';
import { orbitOptions, type WorldOrbitKind } from '../world/worldOrbit';

interface Props {
  body: BodySpec;
  onPick: (kind: WorldOrbitKind) => void;
  onCancel: () => void;
}

/** Chart tap: pick a ring, then the explorer warps onto it. */
export function OrbitPick(props: Props) {
  const opts = orbitOptions(props.body);
  return (
    <div className="modal-backdrop orbit-pick-backdrop" onClick={props.onCancel}>
      <div className="modal modal-small orbit-pick" onClick={(e) => e.stopPropagation()}>
        <h2>Orbit {props.body.name}</h2>
        <p className="modal-note">Polar or equatorial (body below), or hover (facing).</p>
        <div className="orbit-pick-list">
          {opts.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              className="orbit-pick-opt"
              onClick={() => props.onPick(opt.kind)}
            >
              <b>{opt.label}</b>
              <span>{opt.hint}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
