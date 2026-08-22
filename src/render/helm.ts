/**
 * The helm: pointer / key / pinch / hold-roll input state and
 * routing. Events become named verbs on a port — the helm never
 * touches the ship, the drone, or the camera itself. One
 * pointer drags a look (or, still on a screen edge, arms a
 * hold-roll); two pinch (drone thrust); a short still tap
 * picks. Keys: W/S and ↑/↓ are the warp latch and gear,
 * A/D and ←/→ roll.
 *
 * After a pinch, the surviving finger is NOT a drag — rotation
 * resumes only with a fresh single-finger touch.
 */

/** Tap vs a look: pick if the captured pointer never really moved. */
const TAP_SLOP = 22;
/** Still this long on a left/right edge before hold-roll starts. */
const HOLD_ROLL_MS = 240;
/** Left / right this fraction of the canvas is a hold-roll zone. Centre is tap / look. */
const HOLD_ROLL_EDGE = 0.28;
const ZOOM_WHEEL_SENS = 0.0008;
const ZOOM_PINCH_POW = 0.7;

/** What the helm drives. The conductor decides who is live. */
export interface HelmPort {
  region(): boolean;
  droneLive(): boolean;
  /** Ride / capture / depart — the look is not the player's. */
  lookHeld(): boolean;
  wake(): void;
  /** Drag look on the live vehicle (drone else ship). */
  look(dx: number, dy: number): void;
  /** Pinch / wheel zoom (drone thrust). */
  zoom(factor: number): void;
  /** Short still tap. */
  tap(cx: number, cy: number): void;
  setWarp(on: boolean): void;
  setGear(astern: boolean): void;
  warping(): boolean;
}

export class Helm {
  readonly keys = new Set<string>();
  private dragging = false;
  /** True once this captured pointer actually moved — a look, not a click. */
  looking = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private holdRollTimer: ReturnType<typeof setTimeout> | null = null;
  /** +1 left (CCW), −1 right (CW), 0 none. */
  private holdRoll = 0;
  private holdClientX = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly port: HelmPort;

  constructor(canvas: HTMLCanvasElement, port: HelmPort) {
    this.canvas = canvas;
    this.port = port;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('lostpointercapture', this.onLostCapture);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  dispose(): void {
    this.cancelHoldRoll();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  /** Drop a pending / running hold-roll (explorer going dormant). */
  cancelHold(): void {
    this.cancelHoldRoll();
  }

  /** A steer input (key or hold) is live — keep the loop awake. */
  steerHeld(): boolean {
    if (this.holdRoll !== 0) return true;
    for (const c of this.keys) if (isSteerKey(c)) return true;
    return false;
  }

  /** +1 left, −1 right, 0 none. Keys win over a finger hold. */
  rollSign(): number {
    const k = this.keys;
    let s = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) s += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s -= 1;
    if (s !== 0) return s > 0 ? 1 : -1;
    return this.holdRoll;
  }

  private onDown = (e: PointerEvent): void => {
    this.port.wake();
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is how a drag that leaves the canvas stays real input.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.looking = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved = 0;
      this.holdClientX = e.clientX;
      this.armHoldRoll();
    } else if (this.pointers.size === 2) {
      this.cancelHoldRoll();
      this.dragging = false;
      this.looking = false;
      const pts = [...this.pointers.values()];
      this.pinch0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };

  private onMove = (e: PointerEvent): void => {
    // Only a pointer we captured on down. Hover and UI clicks never land here.
    if (!this.pointers.has(e.pointerId)) return;
    if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.buttons === 0) return;
    this.port.wake();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.port.droneLive() && this.pinch0 > 0) {
        const ratio = d / Math.max(1e-3, this.pinch0);
        this.port.zoom(Math.pow(1 / Math.max(0.2, ratio), ZOOM_PINCH_POW));
      }
      this.pinch0 = d;
      this.moved += 4;
      return;
    }
    if (!this.dragging) return;
    // This event's movement (capture keeps it real off-canvas).
    let dx = e.movementX;
    let dy = e.movementY;
    if (dx === 0 && dy === 0) {
      dx = e.clientX - this.lastX;
      dy = e.clientY - this.lastY;
    }
    if (dx === 0 && dy === 0) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved += Math.hypot(dx, dy);
    if (this.moved >= TAP_SLOP) this.cancelHoldRoll();
    if (this.port.region()) {
      this.looking = true;
      this.port.look(dx, dy);
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.port.wake();
    const rolled = this.holdRoll !== 0;
    this.cancelHoldRoll();
    const tap = !rolled && this.dragging && !this.looking && this.moved < TAP_SLOP;
    this.endPointer(e.pointerId);
    if (tap) this.port.tap(e.clientX, e.clientY);
  };

  private onLostCapture = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.cancelHoldRoll();
    this.endPointer(e.pointerId);
  };

  private endPointer(id: number): void {
    this.pointers.delete(id);
    if (this.pointers.size < 2) {
      this.pinch0 = 0;
    }
    this.dragging = false;
    this.looking = false;
  }

  private onWheel = (e: WheelEvent): void => {
    this.port.wake();
    e.preventDefault();
    this.port.zoom(Math.exp(e.deltaY * ZOOM_WHEEL_SENS));
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (this.port.lookHeld()) return;
    if (this.port.region() && !e.repeat) {
      if (e.code === 'ArrowUp') {
        e.preventDefault();
        if (!this.port.warping()) this.port.setGear(false);
        this.port.setWarp(true);
        return;
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault();
        if (this.port.warping()) this.port.setWarp(false);
        else {
          this.port.setGear(true);
          this.port.setWarp(true);
        }
        return;
      }
      if (e.code === 'KeyW') {
        e.preventDefault();
        this.port.setWarp(true);
        return;
      }
      if (e.code === 'KeyS') {
        e.preventDefault();
        this.port.setWarp(false);
        return;
      }
    }
    if (isSteerKey(e.code)) {
      this.port.wake();
      if (this.port.region()) e.preventDefault();
      this.keys.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.keys.has(e.code) && !isSteerKey(e.code)) return;
    this.keys.delete(e.code);
    this.port.wake();
  };

  private armHoldRoll(): void {
    this.cancelHoldRoll();
    if (!this.port.region()) return;
    this.holdRollTimer = setTimeout(() => this.maybeStartHoldRoll(), HOLD_ROLL_MS);
  }

  private maybeStartHoldRoll(): void {
    this.holdRollTimer = null;
    if (this.moved >= TAP_SLOP || this.pointers.size !== 1 || !this.port.region()) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const x = (this.holdClientX - rect.left) / Math.max(1, rect.width);
    if (x < HOLD_ROLL_EDGE) this.holdRoll = 1;
    else if (x > 1 - HOLD_ROLL_EDGE) this.holdRoll = -1;
    if (this.holdRoll) this.port.wake();
  }

  private cancelHoldRoll(): void {
    if (this.holdRollTimer != null) {
      clearTimeout(this.holdRollTimer);
      this.holdRollTimer = null;
    }
    this.holdRoll = 0;
  }
}

function isSteerKey(code: string): boolean {
  return (
    code === 'KeyA' ||
    code === 'KeyD' ||
    code === 'ArrowLeft' ||
    code === 'ArrowRight'
  );
}
