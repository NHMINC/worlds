import type { BodySpec } from '../world/systemgen';
import { classify, lockedToStar } from '../world/systemgen';
import { describeAtmosphere, type BodyPhysics } from '../world/physics';
import type { ElementShare } from '../world/geology';
import { BEDROCK_LEVEL } from '../world/toygen';

/**
 * The inspector: what the physics engine actually derived for this body,
 * and — when a hex is tapped — what that column's surface layer is made of.
 * Read-only this round; mining tools come later.
 */

export interface InspectedCell {
  cell: number;
  level: number;
  /** Elevation of the column top relative to sea level, meters. */
  elevationM: number;
  /** Local temperature (insolation law), Kelvin. */
  localK: number;
  elements: ElementShare[];
}

interface Props {
  body: BodySpec;
  /** Body physics from the catalog / generator. */
  physics?: BodyPhysics;
  cell: InspectedCell | null;
  onClose: () => void;
}

function kelvinLabel(k: number): string {
  return `${Math.round(k)} K (${Math.round(k - 273)}°C)`;
}

export function InspectorPanel({ body, physics, cell, onClose }: Props) {
  const p = physics ?? body.physics;
  const rows: Array<[string, string]> = [
    ['class', classify(p, lockedToStar(body))],
    ['gravity', `${p.gravity.toFixed(2)} g`],
    ['density', `${(p.densityRel * 5.51).toFixed(1)} g/cm³`],
    ['surface temp', kelvinLabel(p.TsurfK)],
    ['atmosphere', describeAtmosphere(p.atmosphere)],
  ];
  if (p.atmosphere.pressure >= 0.02) {
    rows.push(['pressure', `${p.atmosphere.pressure < 10 ? p.atmosphere.pressure.toFixed(2) : Math.round(p.atmosphere.pressure)} atm`]);
  }
  if (p.kind === 'rocky') {
    const h = p.hydrosphere;
    const substanceLabel = h.substance === 'co2' ? 'CO₂' : h.substance;
    rows.push([
      'ocean',
      h.substance === 'none'
        ? 'none'
        : `${substanceLabel}${h.state === 'ice' ? ' (frozen sheet)' : ''}`,
    ]);
    rows.push(['life', p.life ? 'yes — O2 signature' : 'none detected']);
  }
  rows.push(['spin', body.tidallyLocked ? (body.parent ? 'locked to planet' : 'locked to star') : `tilt ${Math.round((body.obliquity * 180) / Math.PI)}°`]);

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="inspector-title">{body.name}</span>
        <button className="mini-btn" onClick={onClose}>✕</button>
      </div>
      <dl className="inspector-grid">
        {rows.map(([k, v]) => (
          <div key={k} className="inspector-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      {p.kind === 'rocky' && (
        <div className="inspector-cell">
          {cell ? (
            <>
              <div className="inspector-subhead">
                hex #{cell.cell} · layer {cell.level}
                {cell.level === BEDROCK_LEVEL ? ' (bedrock)' : ''} ·{' '}
                {cell.elevationM >= 0 ? `${Math.round(cell.elevationM)} m` : `${Math.round(-cell.elevationM)} m below sea`}
                {' · '}
                {kelvinLabel(cell.localK)}
              </div>
              {cell.level === BEDROCK_LEVEL ? (
                <div className="inspector-note">Bare bedrock — unalterable, unminable.</div>
              ) : (
                <ul className="inspector-elements">
                  {cell.elements.slice(0, 6).map((e) => (
                    <li key={e.element}>
                      <span className="el-sym">{e.element}</span>
                      <span className="el-bar">
                        <span style={{ width: `${Math.max(2, Math.round(e.share * 100))}%` }} />
                      </span>
                      <span className="el-pct">{(e.share * 100).toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="inspector-note">Tap a hex to read its surface layer.</div>
          )}
        </div>
      )}
    </div>
  );
}
