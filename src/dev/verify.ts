/**
 * SOI camera verification choreography (owner-requested; run on
 * demand with `?verify=N` — not CI, not a gate). Samples real
 * catalog systems, teleports the live explorer between them at
 * normal clock speed, and asserts on the actual camera: after
 * Center — free, zoomed in and out, trackball, and riding — the
 * subject's rendered position must project to the centre of the
 * view; warp-to-orbit must arrive on the named ring without ever
 * crossing a body's hard wall. Results land on screen, in the
 * console, and on `window.__verifyResult`.
 */
import * as THREE from 'three';
import type { GalaxyView } from '../render/galaxyView';
import { galToCart, objectAt } from '../world/galaxy';
import { silhouetteCloud } from '../world/sectors';
import { systemAt } from '../world/systemgen';
import { orbitRadiusKpc } from '../world/worldOrbit';
import { UNIVERSE } from '../world/physics';
import { mulberry32 } from '../world/rng';

const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;
/** NDC tolerance: a held Center may trail a moving body by a frame. */
const NDC_EPS = 0.035;

interface Row {
  sys: string;
  step: string;
  ok: boolean;
  note: string;
}

export interface VerifyResult {
  pass: number;
  fail: number;
  rows: Row[];
}

declare global {
  interface Window {
    __verifyResult?: VerifyResult;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const tick = (): void => {
      if (--left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await frames(1);
  }
  return pred();
}

function teleport(v: V, x: number, y: number, z: number): void {
  v.arcCenter.set(x, y, z);
  v.mintAt.copy(v.arcCenter);
  v.pushMagUniforms();
  v.applyCam();
  v.wake(30);
}

/** Drop every latch so a teleport sticks (a ride pins arcCenter). */
function reset(v: V): void {
  v.setWarp(false);
  v.setDrone(false);
  v.clearRide();
  v.leaveSurface();
  v.pendingOrbit = null;
  v.pendingArriveOrbit = false;
  v.dropLookHold();
}

const tmp = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();

/**
 * Screen offset of a rendered point (camera at origin). Behind is
 * the view-space sign, NOT ndc z: the main pass keeps a star-scale
 * near plane and close bodies draw in the second AU-scale pass, so
 * a centred nearby planet legitimately projects with z < −1.
 */
function ndcOf(v: V, world: THREE.Vector3): { x: number; y: number; behind: boolean } {
  const cam = v.camera as THREE.PerspectiveCamera;
  cam.getWorldDirection(tmpFwd);
  const behind = world.dot(tmpFwd) <= 0;
  tmp.copy(world).project(cam);
  return { x: tmp.x, y: tmp.y, behind };
}

function bodyNdc(v: V, rt: V): { x: number; y: number; behind: boolean } {
  rt.group.getWorldPosition(tmp);
  return ndcOf(v, tmp);
}

function centered(p: { x: number; y: number; behind: boolean }): boolean {
  return !p.behind && Math.abs(p.x) < NDC_EPS && Math.abs(p.y) < NDC_EPS;
}

function fmt(p: { x: number; y: number; behind: boolean }): string {
  return p.behind ? 'behind camera' : `ndc ${p.x.toFixed(3)}, ${p.y.toFixed(3)}`;
}

function sphereDir(rng: () => number, out: THREE.Vector3): THREE.Vector3 {
  const z = rng() * 2 - 1;
  const a = rng() * 2 * Math.PI;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
}

function overlay(): HTMLPreElement {
  let el = document.getElementById('gx-verify') as HTMLPreElement | null;
  if (!el) {
    el = document.createElement('pre');
    el.id = 'gx-verify';
    el.className = 'gx-verify';
    document.body.appendChild(el);
  }
  return el;
}

export async function runVerify(view: GalaxyView, seed: string, count = 3): Promise<VerifyResult> {
  // One choreography per page load: Strict Mode double-mounts and
  // HMR remounts must not launch parallel runs fighting one camera.
  const w = window as unknown as { __verifyRunning?: boolean };
  if (w.__verifyRunning) return window.__verifyResult ?? { pass: 0, fail: 0, rows: [] };
  w.__verifyRunning = true;
  const v = view as V;
  const rows: Row[] = [];
  const out = overlay();
  const post = (): void => {
    void fetch('/__verify', {
      method: 'POST',
      body: JSON.stringify({ rows }, null, 1),
    }).catch(() => {});
  };
  const log = (row: Row): void => {
    rows.push(row);
    const mark = row.ok ? 'PASS' : 'FAIL';
    out.textContent += `${mark}  ${row.sys}  ${row.step}${row.note ? ` — ${row.note}` : ''}\n`;
    out.scrollTop = out.scrollHeight;
    if (!row.ok) console.warn('[verify]', row);
    post();
  };
  const subject = (): string => {
    const rt = v.lookPrimaryWorld();
    return rt ? String(rt.spec.id) : 'star';
  };
  const dbg = (rt: V): string => {
    rt.group.getWorldPosition(tmp);
    const len = Math.max(1e-30, tmp.length());
    const expYaw = Math.atan2(tmp.x, tmp.z);
    const expPitch = Math.asin(Math.max(-1, Math.min(1, tmp.y / len)));
    return (
      ` hold=${v.lookHold ?? 'none'} latch=${v.lookWorldId ?? '-'}` +
      ` world=${v.worldId ?? '-'} ride=${v.riding?.bodyId ?? '-'}` +
      ` yaw=${v.arcYaw.toFixed(3)}/${expYaw.toFixed(3)}` +
      ` pitch=${v.arcPitch.toFixed(3)}/${expPitch.toFixed(3)} roll=${v.arcRoll.toFixed(3)}`
    );
  };
  out.textContent = `verify v5: ${count} systems from the catalog…\n`;

  // Deterministic sample: real catalog rows with at least two bodies.
  const cloud = silhouetteCloud(seed);
  const rng = mulberry32(48271);
  const picks: number[] = [];
  if (cloud) {
    for (let tries = 0; tries < 400 && picks.length < count; tries++) {
      const id = cloud.ids[Math.floor(rng() * cloud.n)];
      if (picks.includes(id)) continue;
      try {
        const spec = systemAt(seed, id);
        if (spec.bodies.length >= 2) picks.push(id);
      } catch {
        /* remnant or empty — next candidate */
      }
    }
  }
  if (!picks.length) {
    log({ sys: '-', step: 'sample', ok: false, note: 'no harvest cloud / no systems found' });
  }

  const dir = new THREE.Vector3();
  const at = new THREE.Vector3();

  for (const id of picks) {
    const obj = objectAt(seed, id);
    const sys = `#${id}`;
    if (!obj) {
      log({ sys, step: 'objectAt', ok: false, note: 'no object' });
      continue;
    }
    const cart = galToCart(obj.pos);
    const range = UNIVERSE.ARRIVE_RANGE_KPC;

    // Leave any current host, then course + enter this one.
    reset(v);
    sphereDir(rng, dir);
    teleport(v, cart.x + dir.x * range * 4, cart.y + dir.y * range * 4, cart.z + dir.z * range * 4);
    await until(() => v.hostObj == null, 3000);
    view.setCourse(obj);
    sphereDir(rng, dir);
    teleport(
      v,
      cart.x + dir.x * range * 0.3,
      cart.y + dir.y * range * 0.3,
      cart.z + dir.z * range * 0.3,
    );
    const entered = await until(
      () => v.hostObj?.id === obj.id && v.hostBodies.length > 0,
      8000,
    );
    if (!entered) {
      log({ sys, step: 'enter host', ok: false, note: 'sphere never latched' });
      continue;
    }

    // Center on the star from open space.
    view.centerLook();
    await frames(4);
    const star = ndcOf(v, v.hostRoot.position);
    log({ sys, step: 'center star', ok: centered(star), note: fmt(star) });

    const bodies: V[] = v.hostBodies.slice(0, 3);
    for (const rt of bodies) {
      const name = rt.spec.id;
      const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
      for (const k of [400, 24]) {
        reset(v);
        rt.group.getWorldPosition(at).add(v.arcCenter);
        sphereDir(rng, dir);
        teleport(v, at.x - dir.x * R * k, at.y - dir.y * R * k, at.z - dir.z * R * k);
        view.centerLook();
        await frames(4);
        let p = bodyNdc(v, rt);
        log({
          sys,
          step: `center ${name} @${k}R`,
          ok: centered(p),
          note: `${fmt(p)} subject=${subject()}${centered(p) ? '' : dbg(rt)}`,
        });
        // The hold must track the moving body (normal clock).
        await frames(20);
        p = bodyNdc(v, rt);
        log({ sys, step: `center ${name} @${k}R holds`, ok: centered(p), note: `${fmt(p)} subject=${subject()}` });
        // Zoom in twice, out once — Center must survive the dolly.
        for (const f of [0.82, 0.82, 1.4]) {
          v.zoom(f);
          await frames(3);
          p = bodyNdc(v, rt);
          log({ sys, step: `center ${name} zoom ${f}`, ok: centered(p), note: `${fmt(p)} subject=${subject()}` });
        }
        // Trackball drone: the body is the subject; zoom is altitude.
        view.setDrone(true);
        await frames(3);
        p = bodyNdc(v, rt);
        log({ sys, step: `drone ${name}`, ok: centered(p), note: `${fmt(p)} subject=${v.drone?.bodyId ?? 'star'}` });
        v.zoom(0.8);
        await frames(3);
        p = bodyNdc(v, rt);
        log({ sys, step: `drone ${name} zoom`, ok: centered(p), note: `${fmt(p)} subject=${v.drone?.bodyId ?? 'star'}` });
        view.setDrone(false);
        await frames(2);
      }
    }

    // Warp onto a ring, then transfer to a second body: never
    // through a wall, never held, parked on the named ring.
    const rides: Array<{ rt: V; kind: 'leo' | 'station' }> = [
      { rt: bodies[0], kind: 'leo' },
    ];
    if (bodies[1]) rides.push({ rt: bodies[1], kind: 'station' });
    let rideOk = true;
    for (let i = 0; i < rides.length && rideOk; i++) {
      const { rt, kind } = rides[i];
      const name = rt.spec.id;
      if (i === 0) {
        reset(v);
        rt.group.getWorldPosition(at).add(v.arcCenter);
        sphereDir(rng, dir);
        const R = Math.max(rt.spec.radius, 1) * KM_TO_KPC;
        teleport(v, at.x - dir.x * R * 30, at.y - dir.y * R * 30, at.z - dir.z * R * 30);
        await frames(2);
      }
      view.goToWorldOrbit(name, kind);
      let wallHit = '';
      const arrived = await until(() => {
        for (const o of v.hostBodies) {
          const wall = 1.1 * Math.max(o.spec.radius, 1) * KM_TO_KPC;
          if (!wallHit && v.bodyDist(o) < wall) wallHit = `inside ${o.spec.id} wall`;
        }
        return v.riding?.bodyId === name;
      }, 90000);
      if (wallHit) log({ sys, step: `route to ${name}`, ok: false, note: wallHit });
      if (!arrived) {
        const dT = v.worldRt(name) ? v.bodyDist(v.worldRt(name)) : -1;
        log({
          sys,
          step: `ride ${name} ${kind}`,
          ok: false,
          note: `never arrived (held?) d=${dT.toExponential(2)} kpc thrust=${v.thrustOn} riding=${v.riding?.bodyId ?? 'no'} pending=${v.pendingOrbit?.bodyId ?? 'no'}`,
        });
        rideOk = false;
        break;
      }
      const ring = orbitRadiusKpc(rt.spec, kind);
      const dNow = v.bodyDist(rt);
      const onRing = Math.abs(dNow - ring) / ring < 0.02;
      log({
        sys,
        step: `ride ${name} ${kind}`,
        ok: onRing && !wallHit,
        note: `ring off by ${(Math.abs(dNow - ring) / ring * 100).toFixed(2)}%`,
      });
      view.centerLook();
      await frames(4);
      const p = bodyNdc(v, rt);
      log({
        sys,
        step: `center ${name} riding`,
        ok: centered(p),
        note: `${fmt(p)} subject=${subject()}${centered(p) ? '' : dbg(rt)}`,
      });
    }
    reset(v);
  }

  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  const result: VerifyResult = { pass, fail, rows };
  window.__verifyResult = result;
  out.textContent += `\ndone: ${pass} pass, ${fail} fail. Reload to fly normally.\n`;
  console.table(rows);
  console.log(`[verify] ${pass} pass, ${fail} fail`);
  return result;
}
