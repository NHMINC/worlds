import { useState } from 'react';
import { getAIKey, getAIModel, setAIKey, setAIModel } from '../ai/provider';

interface Props {
  onClose: () => void;
}

export function SettingsModal(props: Props) {
  const [key, setKey] = useState(getAIKey);
  const [model, setModel] = useState(getAIModel);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <h3>AI naming (xAI)</h3>
        <p className="modal-note">
          Add an xAI API key to get name suggestions when labeling places. The key is stored
          only on this device and requests go directly to xAI — never paste a key on a shared
          computer.
        </p>
        <div className="form-grid">
          <label>
            API key
            <input
              type="password"
              value={key}
              placeholder="xai-..."
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button
            className="btn primary"
            onClick={() => {
              setAIKey(key.trim());
              setAIModel(model.trim());
              props.onClose();
            }}
          >
            Save
          </button>
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
