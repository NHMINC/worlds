import { useEffect, useRef } from 'react';
import type { ProjectedPoint, ViewState } from '../render/engine';
import type { LabelRecord, ObjectRecord } from '../world/types';

interface Props {
  subscribe: (fn: (v: ViewState) => void) => () => void;
  /** Project a geodesic cell to screen space (null before a world loads). */
  projectCell: (cell: number) => ProjectedPoint | null;
  labels: LabelRecord[];
  objects: ObjectRecord[];
  /** When true (label/object tool active) markers are clickable. */
  interactive: boolean;
  onEditLabel: (l: LabelRecord) => void;
  onEditObject: (o: ObjectRecord) => void;
}

const GLYPHS: Record<string, string> = { city: '◆', town: '●', landmark: '▲' };

function place(el: HTMLElement, p: ProjectedPoint | null): void {
  // Markers ride the globe: hidden on the far side, fading over the limb.
  const visible = Boolean(p && p.visible && p.alpha > 0.02);
  el.style.display = visible ? '' : 'none';
  if (!visible || !p) return;
  el.style.opacity = String(p.alpha);
  el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
}

export function LabelsOverlay(props: Props) {
  const refs = useRef(new Map<string, HTMLElement>());
  const { labels, objects, subscribe, projectCell } = props;

  useEffect(() => {
    const apply = () => {
      for (const l of labels) {
        const el = refs.current.get(`l:${l.id}`);
        if (el) place(el, projectCell(l.cell));
      }
      for (const o of objects) {
        const el = refs.current.get(`o:${o.id}`);
        if (el) place(el, projectCell(o.cell));
      }
    };
    apply();
    return subscribe(apply);
  }, [labels, objects, subscribe, projectCell]);

  const setRef = (key: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };

  return (
    <div className={`overlay ${props.interactive ? 'interactive' : ''}`}>
      {props.labels.map((l) => (
        <div
          key={l.id}
          ref={setRef(`l:${l.id}`)}
          className="map-label"
          style={{ display: 'none' }}
          onClick={() => props.interactive && props.onEditLabel(l)}
        >
          {l.text}
        </div>
      ))}
      {props.objects.map((o) => (
        <div
          key={o.id}
          ref={setRef(`o:${o.id}`)}
          className={`map-object kind-${o.kind}`}
          style={{ display: 'none' }}
          onClick={() => props.interactive && props.onEditObject(o)}
        >
          <span className="obj-glyph">{GLYPHS[o.kind]}</span>
          <span className="obj-name">{o.name}</span>
        </div>
      ))}
    </div>
  );
}
