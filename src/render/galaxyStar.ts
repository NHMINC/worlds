/**
 * Close-up stars: photospheres from evolve(), not bigger point sprites.
 * GL_POINTS become squares on a phone once gl_PointSize grows. We keep
 * distant beacons tiny and only mesh a star when the camera is in its
 * neighbourhood. Type, radius, and phase are free — objectAt is O(1) —
 * we just do not spend the draw until you arrive.
 */
import * as THREE from 'three';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import { teffToRgb } from '../world/stellar';

/** Max photospheres in the close-up pass. Cheap until you arrive. */
export const RESOLVE_MAX = 16;
/** kpc — only then does type / radius / phase earn a disc. */
export const RESOLVE_DIST = 7.2;

const KIND = {
  photo: 0,
  giant: 1,
  wd: 2,
  ns: 3,
  pulsar: 4,
  bh: 5,
  nebula: 6,
  wr: 7,
} as const;

/**
 * Apparent disc in the map (kpc). Real R☉ is metres against
 * kiloparsecs — unusable. Scale from present-day L, R, and phase
 * so a giant is a giant and a white dwarf is a pin.
 */
export function visualRadiusKpc(o: GalaxyObject): number {
  const s = o.star;
  const L = Math.max(s.luminosity, 1e-4);
  const R = Math.max(s.radius, 0.01);
  if (s.nebula === 'planetary' || s.nebula === 'snr' || s.nebula === 'hii') {
    return THREE.MathUtils.clamp(0.055 * Math.pow(L, 0.18), 0.04, 0.16);
  }
  switch (s.phase) {
    case 'black_hole':
      return 0.022;
    case 'neutron_star':
      return 0.009;
    case 'pulsar':
      return 0.014;
    case 'white_dwarf':
      return THREE.MathUtils.clamp(0.007 * Math.pow(R, 0.25), 0.005, 0.014);
    case 'wolf_rayet':
      return THREE.MathUtils.clamp(0.018 * Math.pow(L, 0.12), 0.014, 0.05);
    default:
      break;
  }
  const giant = s.phase === 'giant' || s.phase === 'supergiant' || s.phase === 'carbon_star';
  const fromL = 0.007 * Math.pow(L, 0.22);
  const fromR = 0.004 * Math.pow(R, 0.35);
  const r = Math.max(fromL, fromR);
  return THREE.MathUtils.clamp(r * (giant ? 1.7 : 1), giant ? 0.016 : 0.007, giant ? 0.09 : 0.045);
}

export function starKind(o: GalaxyObject): number {
  const s = o.star;
  if (s.nebula !== 'none') return KIND.nebula;
  if (s.phase === 'black_hole') return KIND.bh;
  if (s.phase === 'pulsar') return KIND.pulsar;
  if (s.phase === 'neutron_star') return KIND.ns;
  if (s.phase === 'white_dwarf') return KIND.wd;
  if (s.phase === 'wolf_rayet') return KIND.wr;
  if (s.phase === 'giant' || s.phase === 'supergiant' || s.phase === 'carbon_star') return KIND.giant;
  return KIND.photo;
}

function starRgb(o: GalaxyObject): THREE.Color {
  const s = o.star;
  if (s.phase === 'black_hole') return new THREE.Color(0.55, 0.62, 0.85);
  if (s.phase === 'neutron_star' || s.phase === 'pulsar') return new THREE.Color(0.72, 0.82, 1);
  if (s.nebula === 'planetary') return new THREE.Color(0.35, 0.85, 0.7);
  if (s.nebula === 'snr') return new THREE.Color(0.85, 0.45, 0.35);
  if (s.nebula === 'hii') return new THREE.Color(1, 0.38, 0.62);
  const [r, g, b] = teffToRgb(s.teff);
  return new THREE.Color(r, g, b);
}

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iCol;
  attribute float iRad;
  attribute float iKind;
  uniform vec3 uRight;
  uniform vec3 uUp;
  varying vec2 vUv;
  varying vec3 vCol;
  varying float vKind;
  void main() {
    vUv = uv;
    vCol = iCol;
    vKind = iKind;
    vec3 world = iPos + (uRight * position.x + uUp * position.y) * iRad;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vCol;
  varying float vKind;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    float kind = vKind;
    vec3 col = vCol;
    float a = 1.0;

    if (kind > 5.5 && kind < 6.5) {
      float ring = smoothstep(0.22, 0.38, r) * (1.0 - smoothstep(0.72, 1.0, r));
      float core = (1.0 - smoothstep(0.0, 0.28, r)) * 0.35;
      a = ring * 0.72 + core;
      col = mix(col, vec3(1.0), core);
    } else if (kind > 4.5 && kind < 5.5) {
      float hole = 1.0 - smoothstep(0.18, 0.34, r);
      float disk = smoothstep(0.32, 0.42, r) * (1.0 - smoothstep(0.55, 0.92, r));
      a = max(disk * 0.9, 0.0);
      col = mix(vec3(1.0, 0.82, 0.55), col, 0.45);
      if (hole > 0.6) discard;
    } else if (kind > 3.5 && kind < 4.5) {
      float core = 1.0 - smoothstep(0.0, 0.18, r);
      float beam = exp(-pow(abs(p.x) * 9.0, 2.0)) * (1.0 - smoothstep(0.15, 1.0, abs(p.y)));
      a = max(core, beam * 0.85);
      col = mix(col, vec3(0.85, 0.92, 1.0), beam);
    } else if (kind > 2.5 && kind < 3.5) {
      float core = 1.0 - smoothstep(0.0, 0.22, r);
      float halo = (1.0 - smoothstep(0.2, 1.0, r)) * 0.35;
      a = max(core, halo);
      col = mix(col, vec3(1.0), core * 0.5);
    } else if (kind > 1.5 && kind < 2.5) {
      float limb = pow(max(0.0, 1.0 - r * r), 0.45);
      float glow = (1.0 - smoothstep(0.55, 1.0, r)) * 0.4;
      a = max(limb, glow);
      col = mix(col, vec3(0.85, 0.9, 1.0), 0.25);
    } else {
      float limb = pow(max(0.0, 1.0 - r * r), 0.55);
      float glow = (1.0 - smoothstep(0.42, 1.0, r)) * 0.55;
      a = max(limb, glow * 0.85);
      col = mix(col * (0.55 + 0.45 * limb), vec3(1.0), limb * 0.35);
    }

    if (a < 0.02) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export type StarDiscs = {
  mesh: THREE.Mesh;
  setStars: (stars: GalaxyObject[]) => void;
  syncCamera: (camera: THREE.Camera) => void;
  pick: (raycaster: THREE.Raycaster) => GalaxyObject | null;
  list: () => GalaxyObject[];
  dispose: () => void;
};

export function createStarDiscs(): StarDiscs {
  const plane = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = plane.index ? plane.index.clone() : null;
  geo.setAttribute('position', plane.attributes.position.clone());
  geo.setAttribute('uv', plane.attributes.uv.clone());

  const iPos = new Float32Array(RESOLVE_MAX * 3);
  const iCol = new Float32Array(RESOLVE_MAX * 3);
  const iRad = new Float32Array(RESOLVE_MAX);
  const iKind = new Float32Array(RESOLVE_MAX);
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(iCol, 3));
  geo.setAttribute('iRad', new THREE.InstancedBufferAttribute(iRad, 1));
  geo.setAttribute('iKind', new THREE.InstancedBufferAttribute(iKind, 1));
  geo.instanceCount = 0;
  plane.dispose();

  const uRight = { value: new THREE.Vector3(1, 0, 0) };
  const uUp = { value: new THREE.Vector3(0, 1, 0) };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uRight, uUp },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  let current: GalaxyObject[] = [];
  const worlds: THREE.Vector3[] = [];
  const radii: number[] = [];

  function setStars(stars: GalaxyObject[]) {
    current = stars.slice(0, RESOLVE_MAX);
    worlds.length = 0;
    radii.length = 0;
    for (let i = 0; i < current.length; i++) {
      const o = current[i];
      const c = galToCart(o.pos);
      const p = new THREE.Vector3(c.x, c.y, c.z);
      worlds.push(p);
      const rad = visualRadiusKpc(o) * 2.4;
      radii.push(rad);
      iPos[i * 3] = p.x;
      iPos[i * 3 + 1] = p.y;
      iPos[i * 3 + 2] = p.z;
      const col = starRgb(o);
      iCol[i * 3] = col.r;
      iCol[i * 3 + 1] = col.g;
      iCol[i * 3 + 2] = col.b;
      iRad[i] = rad;
      iKind[i] = starKind(o);
    }
    geo.instanceCount = current.length;
    (geo.getAttribute('iPos') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (geo.getAttribute('iCol') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (geo.getAttribute('iRad') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (geo.getAttribute('iKind') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  function syncCamera(camera: THREE.Camera) {
    uRight.value.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    uUp.value.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  }

  const hit = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  function pick(raycaster: THREE.Raycaster): GalaxyObject | null {
    let best: GalaxyObject | null = null;
    let bestD = Infinity;
    for (let i = 0; i < current.length; i++) {
      sphere.center.copy(worlds[i]);
      sphere.radius = radii[i] * 0.55;
      if (raycaster.ray.intersectSphere(sphere, hit)) {
        const d = hit.distanceTo(raycaster.ray.origin);
        if (d < bestD) {
          bestD = d;
          best = current[i];
        }
      }
    }
    return best;
  }

  return {
    mesh,
    setStars,
    syncCamera,
    pick,
    list: () => current,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
