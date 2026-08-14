/**
 * The photographic star field: tens of thousands of true 3D points
 * drawn from the same SBbc density law the field integrates — inverse
 * transforms, not a stored list, so the same seed always prints the
 * same sky. These are the "grain" of the photograph and the parallax
 * you fall through; they are NOT addresses and are never pickable.
 * Pickable stars remain objectAt photospheres.
 *
 * Dynamics: the halo makes the rotation curve flat, v(R) ≈ V_ROT, so
 * stars orbit the central mass at Ω(R) = V_ROT / R while the two-armed
 * density wave turns rigidly at Ω_p. We render in the wave's corotating
 * frame: the arms stand still (so the catalog's addresses stay put) and
 * disk stars stream through them at Ω(R) − Ω_p — prograde inside
 * corotation, retrograde outside, frozen exactly at R_c = V_ROT / Ω_p.
 * That relative drift is computed per star in the vertex shader from
 * the unix clock: the galaxy is clockwork, not an animation loop.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { armPhase } from '../world/galaxy';
import { teffToRgb } from '../world/stellar';
import { mulberry32, xmur3 } from '../world/rng';

export const FIELD_STAR_COUNT = 42_000;

const VERT = /* glsl */ `
  attribute vec3 aRTZ;      // (R kpc, birth azimuth rad, height kpc)
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aMag;
  attribute float aDrift;   // Ω(R) − Ω_p, toy rad/s
  uniform float uT;
  uniform float uPixel;
  uniform float uDim;
  varying vec3 vColor;
  varying float vMag;
  void main() {
    float th = aRTZ.y + aDrift * uT;
    vec3 world = vec3(aRTZ.x * cos(th), aRTZ.z, aRTZ.x * sin(th));
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    float dist = max(0.05, -mv.z);
    gl_PointSize = clamp(aSize * uPixel * (9.0 / dist), 0.75, 6.0 * uPixel);
    // Inverse-square: nearby grains brighten as you fly past them.
    vMag = aMag * clamp(16.0 / (dist * dist), 0.08, 2.6) * uDim;
    vColor = aColor;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  varying float vMag;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 5.0);
    float halo = exp(-r2 * 1.4) * 0.3;
    float a = (core + halo) * vMag;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (0.6 + 0.6 * core), a);
  }
`;

/** Inverse CDF of the sech²(z/zd) vertical profile. */
function sech2Z(u: number, zd: number): number {
  const t = Math.max(-0.999, Math.min(0.999, 2 * u - 1));
  return zd * Math.atanh(t);
}

/** Exponential-disk radius by inverse transform, rejected past Rmax. */
function expR(rng: () => number, rd: number, rMax: number): number {
  for (let i = 0; i < 24; i++) {
    const r = -rd * Math.log(1 - rng());
    if (r < rMax) return r;
  }
  return rMax * rng();
}

function relOmega(R: number): number {
  const om = UNIVERSE.GALAXY_V_ROT / Math.max(R, 0.6);
  return om - UNIVERSE.GALAXY_OMEGA_P;
}

interface Grain {
  R: number;
  th: number;
  z: number;
  teff: number;
  size: number;
  mag: number;
  drift: number;
}

function sampleGrains(seed: string): Grain[] {
  const U = UNIVERSE;
  const rng = mulberry32(xmur3(`starfield:${seed}`)());
  const out: Grain[] = [];
  const armAccept = (R: number, th: number) =>
    (1 + U.GALAXY_ARM_A * Math.cos(armPhase(R, th))) / (1 + U.GALAXY_ARM_A);

  while (out.length < FIELD_STAR_COUNT) {
    const pick = rng();
    if (pick < 0.58) {
      // Old thin disk — the K-dwarf oatmeal, mildly arm-weighted (mass wave).
      const R = expR(rng, U.GALAXY_RD, U.GALAXY_R_MAX);
      const th = rng() * Math.PI * 2;
      if (rng() > armAccept(R, th)) continue;
      out.push({
        R, th, z: sech2Z(rng(), U.GALAXY_ZD),
        teff: 3600 + rng() * 2600,
        size: 0.9 + rng() * 1.1,
        mag: 0.25 + rng() * 0.5,
        drift: relOmega(R),
      });
    } else if (pick < 0.72) {
      // Young blue population — born on the crest, still on it.
      const R = expR(rng, U.GALAXY_RD, U.GALAXY_R_MAX);
      const th = rng() * Math.PI * 2;
      const crest = Math.max(0, Math.cos(armPhase(R, th)));
      if (rng() > Math.pow(crest, 3)) continue;
      out.push({
        R, th, z: sech2Z(rng(), U.GALAXY_ZD * 0.5),
        teff: 8000 + rng() * rng() * 22000,
        size: 1.4 + rng() * 1.6,
        mag: 0.5 + rng() * 0.9,
        // Fresh from the crest: barely sheared off the wave yet.
        drift: relOmega(R) * 0.15,
      });
    } else if (pick < 0.8) {
      // Red giants — bright, orange, everywhere the old disk is.
      const R = expR(rng, U.GALAXY_RD, U.GALAXY_R_MAX);
      const th = rng() * Math.PI * 2;
      if (rng() > armAccept(R, th)) continue;
      out.push({
        R, th, z: sech2Z(rng(), U.GALAXY_ZD * 1.4),
        teff: 3300 + rng() * 1200,
        size: 1.6 + rng() * 1.7,
        mag: 0.55 + rng() * 0.8,
        drift: relOmega(R),
      });
    } else if (pick < 0.92) {
      // Bulge — golden, dense, fast Ω capped by the softening radius.
      const r = -U.GALAXY_RE_BULGE * 0.62 * Math.log(1 - rng() * 0.998);
      const th = rng() * Math.PI * 2;
      const cz = 2 * rng() - 1;
      out.push({
        R: r * Math.sqrt(Math.max(0.001, 1 - cz * cz)),
        th, z: r * cz * 0.62,
        teff: 4200 + rng() * 1500,
        size: 0.85 + rng() * 1.0,
        mag: 0.3 + rng() * 0.55,
        drift: relOmega(Math.max(r, 0.7)),
      });
    } else if (pick < 0.975) {
      // Thick disk — puffed, older, redder, slower (asymmetric drift).
      const R = expR(rng, U.GALAXY_RD_THICK, U.GALAXY_R_MAX * 1.05);
      out.push({
        R, th: rng() * Math.PI * 2, z: sech2Z(rng(), U.GALAXY_Z_THICK),
        teff: 3500 + rng() * 1800,
        size: 0.8 + rng() * 0.9,
        mag: 0.18 + rng() * 0.35,
        drift: relOmega(R) * 0.75,
      });
    } else {
      // Halo — isotropic pressure-supported orbits: no mean rotation.
      const r = U.GALAXY_HALO_A * 0.35 * Math.pow(rng(), -0.45);
      if (r > U.GALAXY_R_MAX * 1.35) continue;
      const cz = 2 * rng() - 1;
      out.push({
        R: r * Math.sqrt(Math.max(0.001, 1 - cz * cz)),
        th: rng() * Math.PI * 2, z: r * cz,
        teff: rng() < 0.5 ? 3400 + rng() * 900 : 5800 + rng() * 2600,
        size: 0.75 + rng() * 0.8,
        mag: 0.12 + rng() * 0.3,
        drift: 0,
      });
    }
  }
  return out;
}

export type Starfield = {
  pts: THREE.Points;
  update: (unixSeconds: number, pixelRatio: number, dim: number) => void;
  count: number;
  dispose: () => void;
};

export function createStarfield(seed: string): Starfield {
  const grains = sampleGrains(seed);
  const n = grains.length;
  const rtz = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const mag = new Float32Array(n);
  const drift = new Float32Array(n);
  const pos = new Float32Array(n * 3); // placeholder; real pos from aRTZ

  for (let i = 0; i < n; i++) {
    const g = grains[i];
    rtz[i * 3] = g.R;
    rtz[i * 3 + 1] = g.th;
    rtz[i * 3 + 2] = g.z;
    const [r, gg, b] = teffToRgb(g.teff);
    col[i * 3] = r;
    col[i * 3 + 1] = gg;
    col[i * 3 + 2] = b;
    size[i] = g.size;
    mag[i] = g.mag;
    drift[i] = g.drift;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRTZ', new THREE.BufferAttribute(rtz, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  geo.setAttribute('aDrift', new THREE.BufferAttribute(drift, 1));
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(),
    UNIVERSE.GALAXY_R_MAX * 1.6,
  );

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uT: { value: 0 },
      uPixel: { value: 1 },
      uDim: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -5;

  return {
    pts,
    count: n,
    update(unixSeconds, pixelRatio, dim) {
      // Modulo in double precision before the float32 uniform, or the
      // epoch eats the mantissa and every star snaps to one angle.
      mat.uniforms.uT.value = unixSeconds % 1_000_000;
      mat.uniforms.uPixel.value = pixelRatio;
      mat.uniforms.uDim.value = dim;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
