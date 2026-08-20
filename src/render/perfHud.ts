/**
 * Performance meter: rendered FPS, main-thread frame cost, and
 * GPU frame time via EXT_disjoint_timer_query_webgl2 where the
 * browser allows it (desktop Chrome does; iOS Safari does not —
 * it shows "n/a"). A pure collector: the explorer's corner
 * overlay reads `summary()`.
 */
type TimerExt = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

export class PerfMeter {
  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private gpuMs = 0;
  private hasGpu = false;
  private cpuMs = 0;
  private drawn = 0;
  private lastFlush = performance.now();
  private text = '';

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      this.gl = gl;
      this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    }
  }

  /** Bracket the render call so the GPU timer sees only the draw. */
  beginDraw(): void {
    if (!this.gl || !this.ext || this.active || this.pending.length > 8) return;
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
    if (drawn) {
      this.drawn++;
      this.cpuMs = this.cpuMs * 0.9 + cpuMs * 0.1;
    }
    this.poll();
    const now = performance.now();
    if (now - this.lastFlush < 500) return;
    this.flush(now);
  }

  /** Force the resting line now — the loop is about to stop. */
  markRest(): void {
    this.drawn = 0;
    this.flush(performance.now());
  }

  private flush(now: number): void {
    const dt = Math.max(1e-3, (now - this.lastFlush) / 1000);
    const fps = this.drawn / dt;
    const resting = this.drawn === 0;
    const gpu = resting
      ? '—'
      : this.hasGpu
        ? `${this.gpuMs.toFixed(1)} ms`
        : this.ext
          ? '—'
          : 'n/a';
    const parts = [
      resting ? 'resting' : `${fps.toFixed(0)} fps`,
      `cpu ${resting ? '~0' : this.cpuMs.toFixed(1)} ms`,
      `gpu ${gpu}`,
    ];
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) parts.push(`js ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    this.text = parts.join(' · ');
    this.drawn = 0;
    this.lastFlush = now;
  }

  /** Latest half-second summary, for the bottom bar. */
  summary(): string {
    return this.text;
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
}
