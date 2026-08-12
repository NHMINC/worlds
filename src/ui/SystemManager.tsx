import { Fragment, useMemo, useRef, useState } from 'react';
import { classify, generateSystem, lockedToStar, type BodySpec } from '../world/systemgen';
import { describeBody } from '../world/physics';
import { randomSeedString } from '../world/rng';
import type { SystemMeta } from '../world/types';

export interface NewSystemForm {
  name: string;
  seed: string;
}

interface Props {
  systems: SystemMeta[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onCreate: (form: NewSystemForm) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: (file: File) => void;
  onClose: () => void;
}

/** The emergent classification, straight from the physics. */
function kindLabel(b: BodySpec): string {
  const label = classify(b.physics, lockedToStar(b));
  if (b.kind === 'gas' && b.gas?.ring) return `${label} · ringed`;
  return label;
}

export function SystemManager(props: Props) {
  // The system is named after its star unless the player types their own
  // name (an empty custom name falls back to the star again).
  const [customName, setCustomName] = useState('');
  const [seed, setSeed] = useState(randomSeedString);

  const fileRef = useRef<HTMLInputElement>(null);

  // Live roster preview: the seed IS the system, so show what it deals.
  const preview = useMemo(() => generateSystem(seed.trim() || 'seed'), [seed]);
  const planets = preview.bodies.filter((b) => !b.parent);
  const moonCount = preview.bodies.length - planets.length;
  const name = customName.trim() || preview.star.name;

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Star systems</h2>

        {props.systems.length > 0 && (
          <ul className="world-list">
            {props.systems.map((s) => (
              <li key={s.id} className={s.id === props.currentId ? 'current' : ''}>
                <button className="world-open" onClick={() => props.onOpen(s.id)}>
                  <span className="world-name">{s.name}</span>
                  <span className="world-sub">seed “{s.seed}”</span>
                </button>
                <button className="mini-btn" title="Export as file" onClick={() => props.onExport(s.id)}>
                  Export
                </button>
                <button
                  className="mini-btn danger"
                  title="Delete system"
                  onClick={() => {
                    if (confirm(`Delete “${s.name}” and all its worlds forever?`)) props.onDelete(s.id);
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3>New system</h3>
        <div className="form-grid">
          <label>
            Name
            <input
              value={customName}
              placeholder={preview.star.name}
              onChange={(e) => setCustomName(e.target.value)}
            />
          </label>
          <label>
            Seed
            <span className="seed-row">
              <input value={seed} onChange={(e) => setSeed(e.target.value)} />
              <button className="mini-btn" title="Random seed" onClick={() => setSeed(randomSeedString())}>
                ↻
              </button>
            </span>
          </label>
        </div>

        <h3>
          {preview.star.name} — {planets.length} planets, {moonCount} moons
        </h3>
        <ul className="roster">
          {planets.map((p) => {
            const moons = preview.bodies.filter((m) => m.parent === p.id);
            return (
              <Fragment key={p.id}>
                <li>
                  <span className="roster-name">{p.name}</span>
                  <span className="roster-kind">
                    {kindLabel(p)}
                    {p.tidallyLocked ? ' · locked' : ''}
                  </span>
                  <span className="roster-phys">{describeBody(p.physics)}</span>
                </li>
                {moons.map((m) => (
                  <li key={m.id} className="roster-moon">
                    <span className="roster-name">{m.name}</span>
                    <span className="roster-kind">{kindLabel(m)}</span>
                    <span className="roster-phys">{describeBody(m.physics)}</span>
                  </li>
                ))}
              </Fragment>
            );
          })}
        </ul>

        <div className="modal-actions">
          <button
            className="btn primary"
            onClick={() => props.onCreate({ name, seed: seed.trim() || 'seed' })}
          >
            Create system
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Import file…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) props.onImport(f);
              e.target.value = '';
            }}
          />
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
