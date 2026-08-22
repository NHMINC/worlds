/**
 * The sight: the centre reticle vs host worlds and the local
 * catalog. Acquire is chance — an object has to fly through a
 * tight pip; once named it holds until the look leaves a wider
 * cone. Bodies and harvest stars compete on the same off-axis
 * score, so a planet in the cone cannot hide a star in the pip.
 * Owns the focus (object / body / plate payload) and the brief
 * memo. Going somewhere is Set course — never this file.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, objectAt, type GalaxyObject } from '../world/galaxy';
import { aimLocks } from './galaxyStar';
import { classifyStar } from '../world/stellar';
import { systemAt } from '../world/systemgen';
import { sketchMatches, type GalaxyFilterName, type StarCloud } from '../world/sectors';
import type { HostBodyRT } from './hostSystem';

/**
 * Reticle acquire / hold. A star has to fly through the
 * tight pip to lock; once named it stays until the look
 * leaves a wider cone. Chance to catch, then consistent.
 */
export const RETICLE_LOCK = 0.028;
const RETICLE_HOLD = 0.045;

export interface GalaxyFocus {
  id: number;
  /** Set when the plate names a world of that host. */
  bodyId?: string;
  name: string;
  cls: string;
  phase: string;
  planets: number;
  moons: number;
  life: boolean;
  dark: boolean;
  /** Stage-local pixels. */
  x: number;
  y: number;
  dist: number;
}

/** What the sight looks along and through. */
export interface SightPort {
  region(): boolean;
  /** Free look (no drone) — refresh the arc frame first. */
  orient(): void;
  droneLive(): boolean;
  fwd(): THREE.Vector3;
  at(): THREE.Vector3;
  clouds(): (StarCloud | null)[];
  filter(): GalaxyFilterName;
  hostObj(): GalaxyObject | null;
  bodies(): HostBodyRT[];
  worldRt(id: string | null): HostBodyRT | null;
  /** Plate payload for a host body (needs the host frame). */
  bodyHud(rt: HostBodyRT): GalaxyFocus;
}

export class Sight {
  /** Most-centred star in the pip, held until the look leaves. */
  focusObj: GalaxyObject | null = null;
  focusHud: GalaxyFocus | null = null;
  focusBodyId: string | null = null;
  /** Local catalog objects close enough to lock — HUD / smoke. */
  grownCount = 0;

  private readonly briefMemo = new Map<
    number,
    { name: string; planets: number; moons: number; life: boolean }
  >();
  private lastAt = 0;
  private readonly tmp = new THREE.Vector3();

  private readonly seed: string;
  private readonly port: SightPort;

  constructor(seed: string, port: SightPort) {
    this.seed = seed;
    this.port = port;
  }

  /** Throttled reticle refresh (the frame calls this). */
  update(force = false): void {
    if (!this.port.region()) return;
    const now = performance.now();
    if (!force && now - this.lastAt < 50) return;
    this.lastAt = now;
    this.aim();
  }

  private clear(): void {
    this.focusObj = null;
    this.focusHud = null;
    this.focusBodyId = null;
    this.grownCount = 0;
  }

  aim(): void {
    const clouds = this.port.clouds();
    if (!this.port.region() || clouds.every((c) => !c)) {
      this.clear();
      return;
    }
    if (!this.port.droneLive()) this.port.orient();
    const fwd = this.port.fwd();
    const at = this.port.at();
    const lx = fwd.x;
    const ly = fwd.y;
    const lz = fwd.z;
    const ox = at.x;
    const oy = at.y;
    const oz = at.z;
    const holdCos = Math.cos(RETICLE_HOLD);
    const lockCos = Math.cos(RETICLE_LOCK);

    const holdBody = this.focusBodyId ? this.port.worldRt(this.focusBodyId) : null;
    if (holdBody) {
      holdBody.group.getWorldPosition(this.tmp);
      const dist = this.tmp.length();
      if (dist > 1e-18) {
        const inv = 1 / dist;
        const dot = this.tmp.x * inv * lx + this.tmp.y * inv * ly + this.tmp.z * inv * lz;
        if (dot >= holdCos) {
          this.grownCount = 1;
          this.focusObj = this.port.hostObj();
          this.focusHud = this.port.bodyHud(holdBody);
          this.focusHud.dist = dist;
          return;
        }
      }
    } else if (this.focusObj && !this.focusBodyId) {
      const c = galToCart(this.focusObj.pos);
      const dx = c.x - ox;
      const dy = c.y - oy;
      const dz = c.z - oz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1e-12 && dist <= UNIVERSE.AIM_RANGE_KPC) {
        const inv = 1 / dist;
        const dot = dx * inv * lx + dy * inv * ly + dz * inv * lz;
        if (dot >= holdCos) {
          this.grownCount = 1;
          if (this.focusHud) this.focusHud.dist = dist;
          return;
        }
      }
    }

    let grown = 0;
    let bestBody: HostBodyRT | null = null;
    let bestId = -1;
    let bestOff = 1;
    let bestDist = 0;
    let bestDim = false;
    if (this.port.hostObj()) {
      for (const rt of this.port.bodies()) {
        rt.group.getWorldPosition(this.tmp);
        const dist = this.tmp.length();
        if (dist < 1e-18) continue;
        const inv = 1 / dist;
        const dot = this.tmp.x * inv * lx + this.tmp.y * inv * ly + this.tmp.z * inv * lz;
        if (dot < lockCos) continue;
        grown++;
        const off = 1 - dot;
        if (off < bestOff) {
          bestOff = off;
          bestBody = rt;
          bestId = -1;
          bestDist = dist;
        }
      }
    }
    const filter = this.port.filter();
    for (const cloud of clouds) {
      if (!cloud) continue;
      const cat = cloud.pos;
      const lum = cloud.lum;
      const bits = cloud.bits;
      const ids = cloud.ids;
      for (let i = 0; i < cloud.n; i++) {
        if (!sketchMatches(bits[i], filter)) continue;
        const i3 = i * 3;
        const dx = cat[i3] - ox;
        const dy = cat[i3 + 1] - oy;
        const dz = cat[i3 + 2] - oz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-12) continue;
        const dist = Math.sqrt(d2);
        if (dist > UNIVERSE.AIM_RANGE_KPC) continue;
        const dim = (bits[i] & 1) !== 0 || lum[i] < 0.05;
        if (!aimLocks(lum[i], dist, dim)) continue;
        grown++;
        const inv = 1 / dist;
        const dot = dx * inv * lx + dy * inv * ly + dz * inv * lz;
        if (dot < lockCos) continue;
        const off = 1 - dot;
        if (off < bestOff) {
          bestOff = off;
          bestBody = null;
          bestId = ids[i];
          bestDist = dist;
          bestDim = dim;
        }
      }
    }
    this.grownCount = grown;
    if (bestBody) {
      this.focusBodyId = bestBody.spec.id;
      this.focusObj = this.port.hostObj();
      this.focusHud = this.port.bodyHud(bestBody);
      this.focusHud.dist = bestDist;
      return;
    }
    this.focusBodyId = null;
    if (bestId < 0) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    if (this.focusObj?.id === bestId && this.focusHud) {
      this.focusHud.dist = bestDist;
      this.focusHud.dark = bestDim;
      return;
    }
    const hit = objectAt(this.seed, bestId);
    if (!hit) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    this.focusObj = hit;
    this.focusHud = this.starHud(hit, bestDist, bestDim);
  }

  /** One-system brief (name, counts, life), memoized. */
  briefFor(obj: GalaxyObject): { name: string; planets: number; moons: number; life: boolean } {
    const hit = this.briefMemo.get(obj.id);
    if (hit) return hit;
    if (this.briefMemo.size > 48) this.briefMemo.clear();
    try {
      const spec = systemAt(this.seed, obj.id);
      let planets = 0;
      let moons = 0;
      let life = false;
      for (const b of spec.bodies) {
        if (b.parent) moons++;
        else planets++;
        if (b.physics.life) life = true;
      }
      const row = { name: spec.star.name, planets, moons, life };
      this.briefMemo.set(obj.id, row);
      return row;
    } catch {
      const row = { name: classifyStar(obj.star), planets: 0, moons: 0, life: false };
      this.briefMemo.set(obj.id, row);
      return row;
    }
  }

  /** Plate payload for a harvest star. */
  starHud(obj: GalaxyObject, dist: number, dark?: boolean): GalaxyFocus {
    const brief = this.briefFor(obj);
    const st = obj.star;
    return {
      id: obj.id,
      name: brief.name,
      cls: classifyStar(st),
      phase: st.phase.replace(/_/g, ' '),
      planets: brief.planets,
      moons: brief.moons,
      life: brief.life,
      dark: dark ?? (st.phase.includes('dwarf') || st.luminosity < 0.05),
      x: 0.5,
      y: 0.5,
      dist,
    };
  }
}
