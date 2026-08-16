/**
 * The boot cinematic: instead of a "Preparing the universe" spinner,
 * the player watches the actual pipeline run.
 *
 *   Act 1 — FORMATION. The gas-to-galaxy sim streams live snapshots
 *   from its worker; gas is dim blue, newborn stars flash blue-white
 *   and fade gold as they age. A warm cache plays the stored
 *   keyframes as a fast replay instead of re-running 13 Gyr.
 *
 *   Act 2 — CATALOG. The backdrop mint streams batches of real
 *   catalog rows (positions and colours); the sky fills in ring by
 *   ring over the fading formation cloud.
 *
 * The view orbits a little above the plane so the collapse reads as
 * 3D (a ball flattening, not a stamped disk). Act 3 still opens the
 * explorer face-on.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { prepareUniverse } from '../world/universePrep';

interface Props {
  seed?: string;
  /** Everything is minted; the parent may start the flight. */
  onDone: () => void;
  /** Fade the veil (the explorer has taken over underneath). */
  leaving: boolean;
}

const FORM_PTS = 10_000;
const CATALOG_CAP = 400_000;
/** Replay pace (keyframes per second) for a warm cache. */
const REPLAY_FPS = 12;
/** How fast the drawn cloud chases the latest snap (per frame). */
const FOLLOW = 0.16;

/** Same framing law as the explorer's Face-on preset. */
function overviewHeight(fovDeg: number): number {
  const half = ((fovDeg * Math.PI) / 180) * 0.35;
  return UNIVERSE.GALAXY_R_MAX / Math.max(1e-4, Math.tan(half));
}

/** Colour of a formation particle: k < 0 gas, else stellar age (Myr). */
function formColor(k: number, out: { r: number; g: number; b: number }): void {
  if (k < 0) {
    out.r = 0.10;
    out.g = 0.16;
    out.b = 0.30;
    return;
  }
  // Newborns are blue-white; a Gyr later they are the old gold disk.
  const t = Math.min(1, k / 1200);
  out.r = 0.85 + 0.15 * t;
  out.g = 0.92 - 0.22 * t;
  out.b = 1.0 - 0.55 * t;
}

export function UniverseBoot(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [caption, setCaption] = useState('Igniting the primordial cloud');
  const [detail, setDetail] = useState('');
  const [frac, setFrac] = useState(0);
  const doneRef = useRef(props.onDone);
  doneRef.current = props.onDone;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(new THREE.Color('#070b14'), 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
    const camDist = overviewHeight(50) * 0.92;
    const camTilt = 0.52;
    camera.up.set(0, 1, 0);
    camera.position.set(0, camDist * Math.cos(camTilt), camDist * Math.sin(camTilt));
    camera.lookAt(0, 0, 0);

    // --- Act 1 mesh: the forming galaxy ---
    const formGeo = new THREE.BufferGeometry();
    const formPos = new Float32Array(FORM_PTS * 3);
    const formCol = new Float32Array(FORM_PTS * 3);
    formGeo.setAttribute('position', new THREE.BufferAttribute(formPos, 3));
    formGeo.setAttribute('color', new THREE.BufferAttribute(formCol, 3));
    formGeo.setDrawRange(0, 0);
    const formMat = new THREE.PointsMaterial({
      size: 2.8,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const formPts = new THREE.Points(formGeo, formMat);
    formPts.frustumCulled = false;
    scene.add(formPts);

    // --- Act 2 mesh: the catalog buildout ---
    const catGeo = new THREE.BufferGeometry();
    const catPos = new Float32Array(CATALOG_CAP * 3);
    const catCol = new Float32Array(CATALOG_CAP * 3);
    catGeo.setAttribute('position', new THREE.BufferAttribute(catPos, 3));
    catGeo.setAttribute('color', new THREE.BufferAttribute(catCol, 3));
    catGeo.setDrawRange(0, 0);
    const catMat = new THREE.PointsMaterial({
      size: 1.4,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const catPts = new THREE.Points(catGeo, catMat);
    catPts.frustumCulled = false;
    scene.add(catPts);

    let catN = 0;
    let fading = false;
    const rgb = { r: 0, g: 0, b: 0 };
    const targetPos = new Float32Array(FORM_PTS * 3);
    const targetCol = new Float32Array(FORM_PTS * 3);
    let formN = 0;
    let hasTarget = false;

    const setTarget = (pts: Float32Array): void => {
      const m = Math.min(FORM_PTS, Math.floor(pts.length / 4));
      for (let j = 0; j < m; j++) {
        targetPos[j * 3] = pts[j * 4];
        targetPos[j * 3 + 1] = pts[j * 4 + 2];
        targetPos[j * 3 + 2] = pts[j * 4 + 1];
        formColor(pts[j * 4 + 3], rgb);
        targetCol[j * 3] = rgb.r;
        targetCol[j * 3 + 1] = rgb.g;
        targetCol[j * 3 + 2] = rgb.b;
      }
      formN = m;
      if (!hasTarget) {
        formPos.set(targetPos.subarray(0, m * 3));
        formCol.set(targetCol.subarray(0, m * 3));
        formGeo.setDrawRange(0, m);
        (formGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        (formGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
        hasTarget = true;
      }
    };

    const followTarget = (): void => {
      if (!hasTarget) return;
      for (let j = 0; j < formN; j++) {
        const o = j * 3;
        formPos[o] += (targetPos[o] - formPos[o]) * FOLLOW;
        formPos[o + 1] += (targetPos[o + 1] - formPos[o + 1]) * FOLLOW;
        formPos[o + 2] += (targetPos[o + 2] - formPos[o + 2]) * FOLLOW;
        formCol[o] += (targetCol[o] - formCol[o]) * FOLLOW;
        formCol[o + 1] += (targetCol[o + 1] - formCol[o + 1]) * FOLLOW;
        formCol[o + 2] += (targetCol[o + 2] - formCol[o + 2]) * FOLLOW;
      }
      formGeo.setDrawRange(0, formN);
      (formGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (formGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    };

    // Warm cache: keyframes queue up and play at a fixed pace.
    let replay: Float32Array[] | null = null;
    let replayAt = 0;
    let replayLast = 0;

    const prep = prepareUniverse(props.seed ?? UNIVERSE.CANONICAL_SEED, {
      onFormationSnap: (pts, f, tMyr) => {
        if (disposed) return;
        setTarget(pts);
        const gyr = (f * UNIVERSE.GALAXY_AGE_GYR).toFixed(1);
        setCaption('The galaxy forms');
        setDetail(`${gyr} Gyr · ${Math.round(tMyr).toLocaleString()} Myr of dynamics`);
        setFrac(f * 0.72);
      },
      onFormationReplay: (keyframes) => {
        if (disposed) return;
        replay = keyframes;
        setCaption('The galaxy forms');
      },
      onFieldReady: () => {
        if (disposed) return;
        fading = true;
        setFrac(0.75);
        setCaption('Cataloguing the stars');
        setDetail('');
      },
      onCatalogBatch: (pos, col, f) => {
        if (disposed) return;
        const m = Math.min(Math.floor(pos.length / 3), CATALOG_CAP - catN);
        if (m > 0) {
          catPos.set(pos.subarray(0, m * 3), catN * 3);
          catCol.set(col.subarray(0, m * 3), catN * 3);
          catN += m;
          catGeo.setDrawRange(0, catN);
          (catGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          (catGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
        }
        // A warm-cache replay may still be playing Act 1 — let it keep
        // the caption until it ends.
        if (!replay || replayAt >= replay.length) {
          setCaption('Cataloguing the stars');
          setDetail(
            `${catN.toLocaleString()} beacons · standing for ${UNIVERSE.GALAXY_POPULATION.toLocaleString()}`,
          );
          setFrac(0.75 + 0.25 * f);
        }
      },
    });

    let finished = false;
    void prep.then(() => {
      // Let a replay finish its last frames before handing over.
      const hand = (): void => {
        if (disposed) return;
        if (replay && replayAt < replay.length) {
          window.setTimeout(hand, 120);
          return;
        }
        if (finished) return;
        finished = true;
        setFrac(1);
        setCaption('Setting course');
        setDetail('');
        doneRef.current();
      };
      hand();
    });

    const resize = (): void => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();

    let raf = 0;
    const frame = (now: number): void => {
      if (disposed) return;
      if (replay && replayAt < replay.length && now - replayLast > 1000 / REPLAY_FPS) {
        replayLast = now;
        setTarget(replay[replayAt]);
        setDetail(`${((replayAt / Math.max(1, replay.length - 1)) * UNIVERSE.GALAXY_AGE_GYR).toFixed(1)} Gyr`);
        setFrac(0.72 * (replayAt / Math.max(1, replay.length - 1)));
        replayAt++;
      }
      followTarget();
      const az = now * 0.000055;
      camera.position.set(
        camDist * Math.sin(camTilt) * Math.sin(az),
        camDist * Math.cos(camTilt),
        camDist * Math.sin(camTilt) * Math.cos(az),
      );
      camera.lookAt(0, 0, 0);
      // The formed cloud yields to the catalog: same galaxy, real rows.
      if (fading && (!replay || replayAt >= replay.length) && formMat.opacity > 0.12) {
        formMat.opacity = Math.max(0.12, formMat.opacity - 0.012);
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      formGeo.dispose();
      formMat.dispose();
      catGeo.dispose();
      catMat.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`universe-boot-stage${props.leaving ? ' leaving' : ''}`} role="status">
      <canvas ref={canvasRef} />
      <div className="ub-caption">
        <div className="ub-title">{caption}</div>
        {detail && <div className="ub-detail">{detail}</div>}
        <div className="ub-bar">
          <i style={{ width: `${Math.round(frac * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}
