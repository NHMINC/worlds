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
    return THREE.MathUtils.clamp(0.22 * Math.pow(L, 0.16), 0.16, 0.42);
  }
  switch (s.phase) {
    case 'black_hole':
      return 0.09;
    case 'neutron_star':
      return 0.04;
    case 'pulsar':
      return 0.055;
    case 'white_dwarf':
      return THREE.MathUtils.clamp(0.032 * Math.pow(R, 0.2), 0.028, 0.05);
    case 'wolf_rayet':
      return THREE.MathUtils.clamp(0.08 * Math.pow(L, 0.1), 0.06, 0.16);
    default:
      break;
  }
  const giant = s.phase === 'giant' || s.phase === 'supergiant' || s.phase === 'carbon_star';
  const fromL = 0.048 * Math.pow(L, 0.18);
  const fromR = 0.03 * Math.pow(R, 0.28);
  const r = Math.max(fromL, fromR);
  return THREE.MathUtils.clamp(r * (giant ? 1.8 : 1), giant ? 0.08 : 0.04, giant ? 0.32 : 0.14);
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
  varying vec2 vUv;
  varying vec3 vCol;
  varying float vKind;
  attribute vec3 iCol;
  attribute float iKind;
  void main() {
    vUv = uv;
    vCol = iCol;
    vKind = iKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
      float ring = smoothstep(0.18, 0.36, r) * (1.0 - smoothstep(0.68, 1.0, r));
      float core = (1.0 - smoothstep(0.0, 0.3, r)) * 0.45;
      a = ring * 0.85 + core;
      col = mix(col, vec3(1.0), core);
    } else if (kind > 4.5 && kind < 5.5) {
      float hole = 1.0 - smoothstep(0.16, 0.32, r);
      float disk = smoothstep(0.3, 0.4, r) * (1.0 - smoothstep(0.52, 0.95, r));
      a = max(disk * 0.95, 0.0);
      col = mix(vec3(1.0, 0.82, 0.55), col, 0.4);
      if (hole > 0.55) discard;
    } else if (kind > 3.5 && kind < 4.5) {
      float core = 1.0 - smoothstep(0.0, 0.2, r);
      float beam = exp(-pow(abs(p.x) * 8.0, 2.0)) * (1.0 - smoothstep(0.12, 1.0, abs(p.y)));
      a = max(core, beam * 0.9);
      col = mix(col, vec3(0.85, 0.92, 1.0), beam);
    } else if (kind > 2.5 && kind < 3.5) {
      float core = 1.0 - smoothstep(0.0, 0.24, r);
      float halo = (1.0 - smoothstep(0.18, 1.0, r)) * 0.4;
      a = max(core, halo);
      col = mix(col, vec3(1.0), core * 0.55);
    } else if (kind > 1.5 && kind < 2.5) {
      float limb = pow(max(0.0, 1.0 - r * r), 0.4);
      float glow = (1.0 - smoothstep(0.5, 1.0, r)) * 0.5;
      a = max(limb, glow);
      col = mix(col, vec3(0.85, 0.9, 1.0), 0.3);
    } else {
      float limb = pow(max(0.0, 1.0 - r * r), 0.5);
      float glow = (1.0 - smoothstep(0.38, 1.0, r)) * 0.7;
      a = max(limb, glow);
      col = mix(col * (0.45 + 0.55 * limb), vec3(1.0), limb * 0.45);
    }

    if (a < 0.02) discard;
    gl_FragColor = vec4(col, a);
  }
`;

type Slot = {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  col: THREE.BufferAttribute;
  kind: THREE.BufferAttribute;
};

export type StarDiscs = {
  group: THREE.Group;
  setStars: (stars: GalaxyObject[]) => void;
  syncCamera: (camera: THREE.Camera) => void;
  pick: (raycaster: THREE.Raycaster) => GalaxyObject | null;
  list: () => GalaxyObject[];
  dispose: () => void;
};

export function createStarDiscs(): StarDiscs {
  const group = new THREE.Group();
  group.renderOrder = 3;
  const slots: Slot[] = [];

  for (let i = 0; i < RESOLVE_MAX; i++) {
    const plane = new THREE.PlaneGeometry(2, 2);
    const n = plane.attributes.position.count;
    const colArr = new Float32Array(n * 3);
    const kindArr = new Float32Array(n);
    const col = new THREE.BufferAttribute(colArr, 3);
    const kind = new THREE.BufferAttribute(kindArr, 1);
    plane.setAttribute('iCol', col);
    plane.setAttribute('iKind', kind);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(plane, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 3;
    group.add(mesh);
    slots.push({ mesh, geo: plane, col, kind });
  }

  let current: GalaxyObject[] = [];
  const worlds: THREE.Vector3[] = [];
  const radii: number[] = [];

  function paint(slot: Slot, rgb: THREE.Color, k: number) {
    const n = slot.col.count;
    for (let i = 0; i < n; i++) {
      slot.col.setXYZ(i, rgb.r, rgb.g, rgb.b);
      slot.kind.setX(i, k);
    }
    slot.col.needsUpdate = true;
    slot.kind.needsUpdate = true;
  }

  function setStars(stars: GalaxyObject[]) {
    current = stars.slice(0, RESOLVE_MAX);
    worlds.length = 0;
    radii.length = 0;
    for (let i = 0; i < RESOLVE_MAX; i++) {
      const slot = slots[i];
      if (i >= current.length) {
        slot.mesh.visible = false;
        continue;
      }
      const o = current[i];
      const c = galToCart(o.pos);
      const p = new THREE.Vector3(c.x, c.y, c.z);
      worlds.push(p);
      const rad = visualRadiusKpc(o) * 1.35;
      radii.push(rad);
      slot.mesh.position.copy(p);
      slot.mesh.scale.setScalar(rad);
      slot.mesh.visible = true;
      paint(slot, starRgb(o), starKind(o));
    }
  }

  const face = new THREE.Quaternion();
  function syncCamera(camera: THREE.Camera) {
    camera.getWorldQuaternion(face);
    for (const slot of slots) {
      if (slot.mesh.visible) slot.mesh.quaternion.copy(face);
    }
  }

  const hit = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  function pick(raycaster: THREE.Raycaster): GalaxyObject | null {
    let best: GalaxyObject | null = null;
    let bestD = Infinity;
    for (let i = 0; i < current.length; i++) {
      sphere.center.copy(worlds[i]);
      sphere.radius = radii[i] * 0.75;
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
    group,
    setStars,
    syncCamera,
    pick,
    list: () => current,
    dispose() {
      for (const s of slots) {
        s.geo.dispose();
        (s.mesh.material as THREE.Material).dispose();
      }
    },
  };
}
