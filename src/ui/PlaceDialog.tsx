import { useState } from 'react';
import { getAIProvider, type NameContext } from '../ai/provider';
import type { ObjectKind } from '../world/types';

interface Props {
  mode: 'label' | 'object';
  initialText: string;
  initialKind: ObjectKind;
  canDelete: boolean;
  aiContext: (kind: ObjectKind | 'place') => NameContext;
  onSave: (text: string, kind: ObjectKind) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function PlaceDialog(props: Props) {
  const [text, setText] = useState(props.initialText);
  const [kind, setKind] = useState<ObjectKind>(props.initialKind);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const provider = getAIProvider();

  const suggest = async () => {
    if (!provider) return;
    setLoading(true);
    setError('');
    try {
      const names = await provider.suggestNames(props.aiContext(props.mode === 'object' ? kind : 'place'));
      setSuggestions(names);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Suggestion failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>{props.mode === 'label' ? 'Name this place' : 'Place a marker'}</h2>
        <div className="form-grid">
          {props.mode === 'object' && (
            <label>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as ObjectKind)}>
                <option value="city">City</option>
                <option value="town">Town</option>
                <option value="landmark">Landmark</option>
              </select>
            </label>
          )}
          <label>
            Name
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) props.onSave(text.trim(), kind);
              }}
            />
          </label>
        </div>

        {provider && (
          <div className="suggest-block">
            <button className="btn" onClick={suggest} disabled={loading}>
              {loading ? 'Thinking…' : 'Suggest names'}
            </button>
            {error && <span className="error-text">{error}</span>}
            {suggestions.length > 0 && (
              <div className="suggest-list">
                {suggestions.map((s) => (
                  <button key={s} className="suggest-chip" onClick={() => setText(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn primary" disabled={!text.trim()} onClick={() => props.onSave(text.trim(), kind)}>
            Save
          </button>
          {props.canDelete && (
            <button className="btn danger" onClick={props.onDelete}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
