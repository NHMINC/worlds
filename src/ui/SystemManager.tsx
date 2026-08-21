import { useRef } from 'react';
import type { SystemMeta } from '../world/types';

interface Props {
  systems: SystemMeta[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: (file: File) => void;
  onClose: () => void;
}

export function SystemManager(props: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const visits = props.systems.filter((s) => s.starId != null);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Places you’ve been</h2>
        <p className="modal-note">
          Systems are discovered in the galaxy, not minted. This list is the
          overlay you left behind — nothing generated is stored.
        </p>

        {visits.length === 0 ? (
          <p className="modal-note">No visits yet. Arrive at a star — the camp writes the visit.</p>
        ) : (
          <ul className="world-list">
            {visits.map((s) => (
              <li key={s.id} className={s.id === props.currentId ? 'current' : ''}>
                <button className="world-open" onClick={() => props.onOpen(s.id)}>
                  <span className="world-name">{s.name}</span>
                  <span className="world-sub">helix #{s.starId}</span>
                </button>
                <button className="mini-btn" title="Export as file" onClick={() => props.onExport(s.id)}>
                  Export
                </button>
                <button
                  className="mini-btn danger"
                  title="Forget this visit"
                  onClick={() => {
                    if (confirm(`Forget “${s.name}”? The star stays in the galaxy.`)) props.onDelete(s.id);
                  }}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Import visit…
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
