import type { ReactElement } from 'react';
import type { RigMode, Tool } from '../render/engine';
import {
  IconCompass, IconFitHeight, IconGear, IconGlobe, IconLabel,
  IconLetterbox, IconMusic, IconMusicOff, IconPlace, IconRocket,
} from './icons';

interface Props {
  /** Body name in orbit, system name in flight. */
  title: string;
  mode: RigMode;
  tool: Tool;
  setTool: (t: Tool) => void;
  /** Editing tools only appear when zoomed in close to rocky terrain. */
  canEdit: boolean;
  /** e.g. "42%" (0% whole planet .. 100% single-hex scale). */
  zoomLabel: string;
  viewLetterbox: () => void;
  viewFit: () => void;
  resetNorth: () => void;
  /** Leave orbit and become a ship. */
  depart: () => void;
  musicOn: boolean;
  toggleMusic: () => void;
  volume: number;
  setVolume: (v: number) => void;
  openManager: () => void;
  openSettings: () => void;
}

// Terrain sculpting arrives later; for now close-up editing is naming only.
const EDIT_TOOLS: Array<{ id: Tool; title: string; icon: (p: { size?: number }) => ReactElement }> = [
  { id: 'label', title: 'Name places', icon: IconLabel },
  { id: 'object', title: 'Place cities & landmarks', icon: IconPlace },
];

export function Toolbar(props: Props) {
  const orbit = props.mode === 'orbit';
  return (
    <div className="toolbar">
      <button className="tb-btn tb-world" title="Star systems" onClick={props.openManager}>
        <IconGlobe />
        <span className="tb-world-name">{props.title}</span>
      </button>

      {orbit && (
        <>
          <div className="tb-sep" />
          <button className="tb-btn" title="Whole planet" onClick={props.viewLetterbox}>
            <IconLetterbox />
          </button>
          <button className="tb-btn" title="Fill height (globe spans the screen)" onClick={props.viewFit}>
            <IconFitHeight />
          </button>
          <button className="tb-btn" title="North up" onClick={props.resetNorth}>
            <IconCompass />
          </button>
          <button className="tb-btn" title="Depart — leave orbit and fly" onClick={props.depart}>
            <IconRocket />
          </button>
          <div className="tb-level" title="Zoom (0% whole planet, 100% single hex)">
            <span className="tb-level-name">{props.zoomLabel}</span>
          </div>
        </>
      )}

      {orbit && props.canEdit && (
        <>
          <div className="tb-sep" />
          {EDIT_TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tb-btn ${props.tool === t.id ? 'active' : ''}`}
              title={t.title}
              onClick={() => props.setTool(props.tool === t.id ? 'pan' : t.id)}
            >
              <t.icon />
            </button>
          ))}
        </>
      )}

      <div className="tb-sep" />

      <button
        className={`tb-btn ${props.musicOn ? 'active' : ''}`}
        title={props.musicOn ? 'Music off' : 'Music on'}
        onClick={props.toggleMusic}
      >
        {props.musicOn ? <IconMusic /> : <IconMusicOff />}
      </button>
      {props.musicOn && (
        <input
          className="tb-volume"
          type="range"
          min={0}
          max={100}
          value={Math.round(props.volume * 100)}
          onChange={(e) => props.setVolume(Number(e.target.value) / 100)}
          title="Volume"
        />
      )}

      <button className="tb-btn" title="Settings" onClick={props.openSettings}>
        <IconGear />
      </button>
    </div>
  );
}
