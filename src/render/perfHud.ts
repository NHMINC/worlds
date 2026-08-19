/**
 * Tiny performance HUD: rendered FPS, main-thread frame cost, and
 * GPU frame time via EXT_disjoint_timer_query_webgl2 where the
 * browser allows it (desktop Chrome does; iOS Safari does not —
 * it shows "—"). Enable with ?perf=1 or toggle with the P key.
 * Diagnostics, not a law: text updates only (Pages CSP is
 * style-src 'self', so element.style would never paint).
 */
type TimerExt = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

export class PerfHud {
  private el: HTMLDivElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private gpuMs = 0;
  private hasGpu = false;
  private cpuMs = 0;
  private drawn = 0;
  private ticks = 0;
  private lastFlush = performance.now();
  private on = false;
  private host: HTMLElement;

  constructor(host: HTMLElement, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.host = host;
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      this.gl = gl;
      this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    }
    if (typeof location !== 'undefined' && /[?&]perf\b/.test(location.search)) this.setOn(true);
  }

  toggle(): void {
    this.setOn(!this.on);
  }

  private setOn(on: boolean): void {
    this.on = on;
    if (on && !this.el) {
      this.el = document.createElement('div');
      this.el.className = 'gx-perf';
      this.host.appendChild(this.el);
    }
    this.el?.classList.toggle('is-off', !on);
  }

  /** Bracket the render call so the GPU timer sees only the draw. */
  beginDraw(): void {
    if (!this.on || !this.gl || !this.ext || this.active || this.pending.length > 8) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  endDraw(): void {
    if (!this.active || !this.gl || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Once per rAF tick — drawn says whether a render happened. */
  tick(cpuMs: number, drawn: boolean): void {
    if (!this.on) return;
    this.ticks++;
    if (drawn) {
      this.drawn++;
      this.cpuMs = this.cpuMs * 0.9 + cpuMs * 0.1;
    }
    this.poll();
    const now = performance.now();
    if (now - this.lastFlush < 500 || !this.el) return;
    const dt = (now - this.lastFlush) / 1000;
    const fps = this.drawn / dt;
    const resting = this.drawn === 0;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const lines = [
      resting ? 'resting' : `${fps.toFixed(0)} fps`,
      `cpu ${resting ? '~0' : this.cpuMs.toFixed(1)} ms`,
      `gpu ${this.hasGpu && !resting ? this.gpuMs.toFixed(1) + ' ms' : '—'}`,
    ];
    if (mem) lines.push(`js ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    this.el.textContent = lines.join('\n');
    this.drawn = 0;
    this.ticks = 0;
    this.lastFlush = now;
  }

  private poll(): void {
    const gl = this.gl;
    const ext = this.ext;
    if (!gl || !ext || this.pending.length === 0) return;
    const q = this.pending[0];
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.gpuMs = this.gpuMs * 0.8 + (ns / 1e6) * 0.2;
      this.hasGpu = true;
    }
    gl.deleteQuery(q);
    this.pending.shift();
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
  }
}
