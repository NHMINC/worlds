/**
 * Cosmic engineer UI: the grouped law dropdown, the bottom knob
 * panel, and the remint / rebake progress overlay. One owner for
 * the knob state and the rebuild orchestration; the explorer
 * places the three chunks (they live in different mount points)
 * and reads `editing` / `rebuilding` to hide its chrome.
 *
 * Live knobs write UNIVERSE + a GPU uniform — next frame.
 * Rebuild knobs are a draft until Rebuild remints / rebakes,
 * or Cancel discards.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { GalaxyView } from '../render/galaxyView';
import {
  ENGINEER_GROUPS,
  atDefault,
  knobDefault,
  knobsInGroup,
  liveKnob,
  rebuildKnob,
  type RebuildScope,
} from './liveKnobs';
import {
  remintUniverse,
  rebakeUniverseDust,
  rebakeUniverseNebulae,
  onUniverseProgress,
} from '../world/universePrep';

export interface EngineerUI {
  /** A knob panel is open — the explorer hides its chrome. */
  editing: boolean;
  rebuilding: boolean;
  /** Progress overlay (galaxy-stage). */
  progress: ReactNode;
  /** "Cosmic engineer" chip + dropdown (header). */
  chip: ReactNode;
  /** Bottom knob panel (root). */
  panel: ReactNode;
}

export function useEngineer(
  getView: () => GalaxyView | null,
  seed: string,
  menuOpen: boolean,
  onMenuToggle: () => void,
): EngineerUI {
  const [engineer, setEngineer] = useState<string | null>(null);
  const [knobVal, setKnobVal] = useState(0);
  const [knobDirty, setKnobDirty] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [rebuilding, setRebuilding] = useState<null | RebuildScope>(null);
  const [rebuildFrac, setRebuildFrac] = useState(0);
  const [rebuildLabel, setRebuildLabel] = useState('');

  useEffect(() => {
    return onUniverseProgress((p) => {
      setRebuildFrac(p.frac);
      setRebuildLabel(p.label);
    });
  }, []);

  function openKnob(id: string): void {
    const live = liveKnob(id);
    if (live) {
      setKnobVal(getView()?.liveUniform(live.uniform) ?? live.read());
      setKnobDirty(false);
      setEngineer(id);
      return;
    }
    const rebuild = rebuildKnob(id);
    if (!rebuild) return;
    setKnobVal(rebuild.read());
    setKnobDirty(false);
    setEngineer(id);
  }

  function slideKnob(id: string, raw: number): void {
    const v = Number(raw);
    const live = liveKnob(id);
    if (live) {
      setKnobVal(v);
      setKnobDirty(false);
      live.write?.(v);
      getView()?.setLiveUniform(live.uniform, v);
      return;
    }
    const rebuild = rebuildKnob(id);
    if (!rebuild) return;
    setKnobVal(v);
    setKnobDirty(Math.abs(v - rebuild.read()) > rebuild.step * 0.25);
  }

  function pickSetting(id: string): void {
    if (!id) return;
    openKnob(id);
  }

  function closeKnob(): void {
    setKnobDirty(false);
    setEngineer(null);
  }

  function cancelRebuild(): void {
    const k = engineer ? rebuildKnob(engineer) : undefined;
    setKnobDirty(false);
    if (k) setKnobVal(k.read());
  }

  function toggleGroup(id: string): void {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const live = engineer ? liveKnob(engineer) : undefined;
  const rebuild = engineer ? rebuildKnob(engineer) : undefined;
  const spec = live ?? rebuild;
  const isDefault = Boolean(spec && atDefault(spec, knobVal));

  function resetToDefault(): void {
    if (!spec || !engineer || rebuilding) return;
    const v = knobDefault(spec);
    if (live) {
      setKnobVal(v);
      live.write?.(v);
      getView()?.setLiveUniform(live.uniform, v);
      return;
    }
    if (rebuild) {
      setKnobVal(v);
      setKnobDirty(Math.abs(v - rebuild.read()) > rebuild.step * 0.25);
    }
  }

  async function confirmRebuild(id: string): Promise<void> {
    const k = rebuildKnob(id);
    const view = getView();
    if (!k || !view || rebuilding) return;
    k.write(knobVal);
    setRebuildFrac(0);
    setRebuildLabel(
      k.scope === 'harvest' ? 'Walking the disk…' : k.scope === 'nebula' ? 'Collecting nebulae…' : 'Baking the fog…',
    );
    setRebuilding(k.scope);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    try {
      if (k.scope === 'harvest') {
        await remintUniverse(seed);
        view.replaceSky();
      } else if (k.scope === 'nebula') {
        await rebakeUniverseNebulae(seed);
        view.replaceNebulae();
      } else {
        rebakeUniverseDust(seed);
        view.replaceDust();
      }
    } finally {
      setRebuilding(null);
      setKnobDirty(false);
    }
  }

  const progress = rebuilding ? (
    <div className="gx-rebuild" role="status">
      <b>
        {rebuildLabel ||
          (rebuilding === 'harvest'
            ? 'Walking the disk…'
            : rebuilding === 'nebula'
              ? 'Collecting nebulae…'
              : 'Baking the fog…')}
      </b>
      <progress max={100} value={Math.round(rebuildFrac * 100)} />
      <em>{Math.round(rebuildFrac * 100)}%</em>
    </div>
  ) : null;

  const chip = (
    <div className={`gx-drop gx-drop-eng-wrap${menuOpen ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`gx-chip${menuOpen ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={Boolean(rebuilding)}
        onClick={() => {
          getView()?.setWarp(false);
          onMenuToggle();
        }}
      >
        Cosmic engineer
      </button>
      {menuOpen && (
        <div className="gx-drop-menu gx-drop-eng" role="menu" aria-label="Cosmic engineer">
          {ENGINEER_GROUPS.map((g) => {
            const open = openGroups.has(g.id);
            return (
              <div key={g.id} className="gx-eng-group">
                <button
                  type="button"
                  className={`gx-eng-group-label${open ? ' is-open' : ''}`}
                  aria-expanded={open}
                  onClick={() => toggleGroup(g.id)}
                >
                  {g.label}
                </button>
                {open &&
                  knobsInGroup(g.id).map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      role="menuitem"
                      className={`gx-eng-item${k.remint ? ' is-rebuild' : ''}${engineer === k.id ? ' is-on' : ''}`}
                      onClick={() => pickSetting(k.id)}
                    >
                      <b>{k.label}</b>
                      <i>{k.hint}</i>
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const panel =
    spec && engineer ? (
      <footer className="galaxy-bottom is-eng">
        <div className="gx-eng">
          <div className="gx-eng-top">
            <div>
              <div className="gx-kicker">Cosmic engineer</div>
              <b className="gx-eng-name">{spec.label}</b>
            </div>
            <button
              type="button"
              className="gx-chip gx-close"
              disabled={Boolean(rebuilding)}
              onClick={closeKnob}
            >
              Close
            </button>
          </div>
          <p className="gx-eng-about">{spec.about}</p>
          <div className="gx-eng-slider">
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={knobVal}
              disabled={Boolean(rebuilding)}
              onChange={(e) => slideKnob(engineer, Number(e.target.value))}
            />
            <em>
              {spec.step >= 1
                ? String(Math.round(knobVal))
                : knobVal.toFixed(
                    spec.step >= 0.01 ? (knobVal >= 10 ? 1 : 2) : spec.step >= 0.001 ? 3 : 4,
                  )}
            </em>
          </div>
          {(!isDefault || (rebuild && knobDirty)) && (
            <div className="gx-eng-actions">
              {!isDefault && (
                <button
                  type="button"
                  className="gx-chip gx-eng-reset"
                  disabled={Boolean(rebuilding)}
                  onClick={resetToDefault}
                >
                  Reset to default
                </button>
              )}
              {rebuild && knobDirty && (
                <>
                  <button
                    type="button"
                    className="gx-chip gx-eng-go"
                    disabled={Boolean(rebuilding)}
                    onClick={() => void confirmRebuild(engineer)}
                  >
                    Rebuild
                  </button>
                  <button
                    type="button"
                    className="gx-chip"
                    disabled={Boolean(rebuilding)}
                    onClick={cancelRebuild}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </footer>
    ) : null;

  return { editing: Boolean(spec), rebuilding: Boolean(rebuilding), progress, chip, panel };
}
