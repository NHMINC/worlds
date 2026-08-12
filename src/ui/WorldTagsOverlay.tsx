import { useEffect, useRef } from 'react';
import type { ProjectedPoint, ViewState } from '../render/engine';

/**
 * Moving tags for far-away worlds: with interplanetary space spread 10x,
 * distant planets render as sub-pixel dots, so each one wears a small
 * screen-anchored tag that rides its orbit. Tapping a tag jumps the ship
 * there. Placement is imperative (same pattern as LabelsOverlay): the DOM
 * nodes are moved every frame without React re-renders.
 */

export interface WorldTagInfo {
  id: string;
  name: string;
  /** CSS color for the identity dot (the body's mean color). */
  color: string;
}

/** Beyond this camera-to-surface distance a world is "far" and earns a tag
 * (just past tier-1 LOD range: anything closer is visibly a globe). */
const TAG_DIST = 260;

interface Props {
  tags: WorldTagInfo[];
  subscribe: (fn: (v: ViewState) => void) => () => void;
  project: (id: string) => (ProjectedPoint & { dSurf: number }) | null;
  onTravel: (id: string) => void;
}

export function WorldTagsOverlay(props: Props) {
  const refs = useRef(new Map<string, HTMLElement>());
  const { tags, subscribe, project } = props;

  useEffect(() => {
    const apply = () => {
      for (const t of tags) {
        const el = refs.current.get(t.id);
        if (!el) continue;
        const p = project(t.id);
        const show = Boolean(p && p.visible && p.dSurf > TAG_DIST);
        el.style.display = show ? '' : 'none';
        if (show && p) {
          el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
        }
      }
    };
    apply();
    return subscribe(apply);
  }, [tags, subscribe, project]);

  const setRef = (id: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  };

  return (
    <div className="overlay">
      {tags.map((t) => (
        <button
          key={t.id}
          ref={setRef(t.id)}
          className="world-tag"
          style={{ display: 'none' }}
          onClick={() => props.onTravel(t.id)}
        >
          <span className="wt-dot" style={{ background: t.color }} />
          <span className="wt-name">{t.name}</span>
        </button>
      ))}
    </div>
  );
}
