/**
 * Close-up stars: a real sphere wrapped around a sharp point.
 * Distant catalog rows stay 1px pinpricks. Once the toy glow radius
 * subtends STAR_WRAP_ANG we mesh a sphere whose world size is fixed —
 * perspective grows and shrinks it. Bright stars are a solid of their
 * photosphere colour; black holes and very dim remnants are an outline
 * so the point (or the void) stays readable. objectAt is O(1).
 */
import * as THREE from 'three';
import { galToCart, type GalaxyObject } from '../world/galaxy';
import { teffToRgb } from '../world/stellar';

/** Max photospheres in the close-up pass. Cheap until you arrive. */
export const RESOLVE_MAX = 28;
/** kpc — only then does type / radius / phase earn a disc. Tripled from
 * 7.2: the detection bubble should light up well before arrival. */
export const RESOLVE_DIST = 21.6;

/**
 * Toy sphere radius (kpc). Real R☉ is metres against kiloparsecs —
 * unusable. The sphere is a wrap around the point, not a sprite.
 * Apparent size is just perspective: r / distance.
 */
export const GLOW_K = 0.0024;
export const GLOW_P = 0.16;
/** Dim / remnant floor — the outline still has a body the reticle can hit. */
export const GLOW_DIM = 0.0016;
/** Wrap the point in a sphere once it would be a few pixels across. */
export const STAR_WRAP_ANG = 0.0034;
/** @deprecated use STAR_WRAP_ANG */
export const STAR_DISC_ANG = STAR_WRAP_ANG;
export const STAR_ANG_MAX = 0.10;

export function glowRadiusKpc(L: number, dim = false): number {
  const r = GLOW_K * Math.pow(Math.max(L, 1e-4), GLOW_P);
  return Math.max(dim ? GLOW_DIM : 0.0007, Math.min(0.012, r));
}

export function apparentAngle(rWorld: number, dist: number): number {
  return rWorld / Math.max(1e-5, dist);
}

export function starIsOutline(o: GalaxyObject): boolean {
  const s = o.star;
  return (
    s.phase === 'black_hole' ||
    s.phase === 'white_dwarf' ||
    s.phase === 'neutron_star' ||
    s.phase === 'pulsar' ||
    s.luminosity < 0.05
  );
}

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
  return THREE.MathUtils.clamp(r * (giant ? 1.8 : 1), giant ? 0.08 : 0.055, giant ? 0.32 : 0.16);
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

const RIM_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = cameraPosition - w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const RIM_FRAG = /* glsl */ `
  uniform vec3 uCol;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
    if (fres < 0.06) discard;
    gl_FragColor = vec4(uCol, fres);
  }
`;

type Slot = {
  fill: THREE.Mesh;
  rim: THREE.Mesh;
  fillMat: THREE.MeshBasicMaterial;
  rimMat: THREE.ShaderMaterial;
};

export type StarDiscs = {
  group: THREE.Group;
  setStars: (stars: GalaxyObject[], cam: THREE.Vector3) => void;
  syncCamera: (camera: THREE.Camera) => void;
  pick: (raycaster: THREE.Raycaster) => GalaxyObject | null;
  list: () => GalaxyObject[];
  /** World radius of a wrapped sphere, or 0. */
  radiusOf: (id: number) => number;
  isOutline: (id: number) => boolean;
  dispose: () => void;
};

export function createStarDiscs(): StarDiscs {
  const group = new THREE.Group();
  group.renderOrder = 3;
  const ball = new THREE.SphereGeometry(1, 24, 16);
  const slots: Slot[] = [];

  for (let i = 0; i < RESOLVE_MAX; i++) {
    const fillMat = new THREE.MeshBasicMaterial({ depthWrite: true });
    const fill = new THREE.Mesh(ball, fillMat);
    fill.visible = false;
    fill.renderOrder = 3;
    const rimMat = new THREE.ShaderMaterial({
      vertexShader: RIM_VERT,
      fragmentShader: RIM_FRAG,
      uniforms: { uCol: { value: new THREE.Color(1, 1, 1) } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const rim = new THREE.Mesh(ball, rimMat);
    rim.visible = false;
    rim.renderOrder = 4;
    group.add(fill, rim);
    slots.push({ fill, rim, fillMat, rimMat });
  }

  let current: GalaxyObject[] = [];
  const worlds: THREE.Vector3[] = [];
  const radii: number[] = [];
  const outlines: boolean[] = [];

  function setStars(stars: GalaxyObject[], _cam: THREE.Vector3) {
    void _cam;
    current = stars.slice(0, RESOLVE_MAX);
    worlds.length = 0;
    radii.length = 0;
    outlines.length = 0;
    for (let i = 0; i < RESOLVE_MAX; i++) {
      const slot = slots[i];
      if (i >= current.length) {
        slot.fill.visible = false;
        slot.rim.visible = false;
        continue;
      }
      const o = current[i];
      const c = galToCart(o.pos);
      const p = new THREE.Vector3(c.x, c.y, c.z);
      worlds.push(p);
      const outline = starIsOutline(o);
      let rWorld = glowRadiusKpc(Math.max(o.star.luminosity, 1e-4), outline);
      if (o.star.nebula !== 'none') rWorld *= 2.0;
      radii.push(rWorld);
      outlines.push(outline);
      const rgb = starRgb(o);
      slot.fill.position.copy(p);
      slot.rim.position.copy(p);
      slot.fill.scale.setScalar(rWorld);
      slot.rim.scale.setScalar(rWorld * 1.04);
      slot.fillMat.color.copy(rgb);
      (slot.rimMat.uniforms.uCol.value as THREE.Color).copy(rgb);
      slot.fill.visible = !outline;
      slot.rim.visible = outline || o.star.nebula !== 'none';
    }
  }

  function syncCamera(_camera: THREE.Camera) {
    void _camera;
  }

  const hit = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  function pick(raycaster: THREE.Raycaster): GalaxyObject | null {
    let best: GalaxyObject | null = null;
    let bestD = Infinity;
    for (let i = 0; i < current.length; i++) {
      sphere.center.copy(worlds[i]);
      sphere.radius = radii[i];
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
    radiusOf(id: number) {
      const i = current.findIndex((o) => o.id === id);
      return i >= 0 ? radii[i] ?? 0 : 0;
    },
    isOutline(id: number) {
      const i = current.findIndex((o) => o.id === id);
      return i >= 0 ? Boolean(outlines[i]) : false;
    },
    dispose() {
      ball.dispose();
      for (const s of slots) {
        s.fillMat.dispose();
        s.rimMat.dispose();
      }
    },
  };
}
