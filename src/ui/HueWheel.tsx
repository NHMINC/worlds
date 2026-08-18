import { useEffect, useRef, type PointerEvent } from 'react';
import { hsvRgb } from '../render/cosmicBg';

const CSS_PX = 96;

function hueAt(clientX: number, clientY: number, el: HTMLCanvasElement): number {
  const r = el.getBoundingClientRect();
  const x = clientX - r.left - r.width / 2;
  const y = clientY - r.top - r.height / 2;
  return (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1;
}

function paint(canvas: HTMLCanvasElement, hue: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(CSS_PX * dpr);
  if (canvas.width !== W || canvas.height !== W) {
    canvas.width = W;
    canvas.height = W;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cx = W / 2;
  const cy = W / 2;
  const R = W * 0.49;
  const rIn = W * 0.3;
  const img = ctx.createImageData(W, W);
  const data = img.data;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const i = (y * W + x) * 4;
      if (d > R || d < rIn) {
        data[i + 3] = 0;
        continue;
      }
      const h = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
      const [rr, gg, bb] = hsvRgb(h, 1, 1);
      const edge = Math.min(1, (R - d) * 2.2, (d - rIn) * 2.2);
      data[i] = Math.round(rr * 255);
      data[i + 1] = Math.round(gg * 255);
      data[i + 2] = Math.round(bb * 255);
      data[i + 3] = Math.round(edge * 255);
    }
  }
  ctx.clearRect(0, 0, W, W);
  ctx.putImageData(img, 0, 0);

  const [cr, cg, cb] = hsvRgb(hue, 0.88, 0.92);
  ctx.beginPath();
  ctx.arc(cx, cy, rIn - W * 0.04, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${Math.round(cr * 255)},${Math.round(cg * 255)},${Math.round(cb * 255)})`;
  ctx.fill();

  const ang = hue * Math.PI * 2;
  const mid = (R + rIn) / 2;
  const mx = cx + Math.cos(ang) * mid;
  const my = cy + Math.sin(ang) * mid;
  const mark = W * 0.055;
  ctx.beginPath();
  ctx.arc(mx, my, mark + W * 0.012, 0, Math.PI * 2);
  ctx.fillStyle = '#0c1016';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(mx, my, mark, 0, Math.PI * 2);
  ctx.fillStyle = '#f4e4c1';
  ctx.fill();
}

export function HueWheel(props: {
  hue: number;
  disabled?: boolean;
  onChange: (hue: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef(false);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    const canvas = ref.current;
    if (canvas) paint(canvas, props.hue);
  }, [props.hue]);

  function apply(e: PointerEvent<HTMLCanvasElement>): void {
    if (props.disabled) return;
    props.onChange(hueAt(e.clientX, e.clientY, e.currentTarget));
  }

  return (
    <canvas
      ref={ref}
      className="gx-hue-wheel"
      width={CSS_PX}
      height={CSS_PX}
      role="slider"
      aria-label="Void hue"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(props.hue * 360)}
      aria-valuetext={`${Math.round(props.hue * 360)}°`}
      aria-disabled={props.disabled || undefined}
      onPointerDown={(e) => {
        if (props.disabled) return;
        drag.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        apply(e);
      }}
      onPointerUp={() => {
        drag.current = false;
      }}
      onPointerCancel={() => {
        drag.current = false;
      }}
      onKeyDown={(e) => {
        if (props.disabled) return;
        const step = e.shiftKey ? 0.04 : 0.015;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          onChangeRef.current((props.hue - step + 1) % 1);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          onChangeRef.current((props.hue + step) % 1);
        }
      }}
      tabIndex={props.disabled ? -1 : 0}
    />
  );
}
