import { useMemo, useRef, useState } from 'react';
import { generateSystem, type BodySpec } from '../world/systemgen';
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

function kindLabel(b: BodySpec): string {
  if (b.kind === 'gas') return b.gas?.ring ? 'gas giant · ringed' : 'gas giant';
  const t = b.temp ?? 0.5;
  const sea = b.seaLevel ?? 0.5;
  if (t > 0.85) return 'scorched rock';
  if (t < 0.2) return 'ice world';
  if (sea < 0.25) return 'dry world';
  return 'water world';
}

export function SystemManager(props: Props) {
  const [name, setName] = useState('New System');
  const [seed, setSeed] = useState(randomSeedString);

  const fileRef = useRef<HTMLInputElement>(null);

  // Live roster preview: the seed IS the system, so show what it deals.
  const preview = useMemo(() => generateSystem(seed.trim() || 'seed'), [seed]);
  const planets = preview.bodies.filter((b) => !b.parent);
  const moonCount = preview.bodies.length - planets.length;

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
            <input value={name} onChange={(e) => setName(e.target.value)} />
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
              <li key={p.id}>
                <span className="roster-name">{p.name}</span>
                <span className="roster-kind">
                  {kindLabel(p)}
                  {p.tidallyLocked ? ' · locked' : ''}
                  {moons.length > 0 ? ` · ${moons.length} moon${moons.length > 1 ? 's' : ''}` : ''}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="modal-actions">
          <button
            className="btn primary"
            onClick={() => props.onCreate({ name: name.trim() || 'New System', seed: seed.trim() || 'seed' })}
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
