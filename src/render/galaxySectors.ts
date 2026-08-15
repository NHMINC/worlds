/**
 * The saucer: a static mesh of annular tiles coloured by the density
 * law (golden bulge/bar, blue crests, brown lanes). Chart fabric, not
 * a catalog and not a tap grid — a tap is a coordinate on this shape.
 * Built once; never touches the camera.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { armPhase, densityParts } from '../world/galaxy';
import { ringRadii, spokeBounds } from '../world/sectors';

const TAU = Math.PI * 2;

/**
 * Saucer half-thickness (kpc): disk slab plus the bulge dome.
 *
 * The bulge term MUST be Gaussian in R. An exponential `exp(-R/h)` has
 * a non-zero slope at R=0, so the tiles meet in a cone (a golden spike
 * when the map is seen edge-on). `exp(-R²/σ²)` has zero derivative at
 * the origin — a smooth lens, the same shape a self-gravitating bulge
 * actually has.
 */
export function saucerHeight(R: number): number {
  return 2.2 * UNIVERSE.GALAXY_ZD + 1.9 * Math.exp(-(R * R) / (1.3 * 1.3));
}

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute vec2 aUv;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    vColor = aColor;
    vUv = aUv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  void main() {
    vec3 c = vColor;
    // World-space grain — not per-tile, or the old pizza grid comes back.
    float g = hash21(floor(vUv * vec2(48.0, 96.0)));
    c *= 0.92 + 0.16 * g * smoothstep(0.02, 0.3, dot(vColor, vec3(0.33)));
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Tile colour law: the density integral as paint. */
function tileColor(R: number, theta: number): [number, number, number] {
  const parts = densityParts({ R, theta, z: 0 });
  const phase = armPhase(R, theta);
  const crest = Math.max(0, Math.cos(phase));
  const lane = Math.min(1, Math.max(0, (Math.sin(phase) - 0.05) / 0.67));
  const young = Math.exp(-R / UNIVERSE.GALAXY_RD) * Math.pow(0.12 + crest, 2.6);
  let r = 0.05 + 0.85 * (parts.bulge + parts.bar) * 0.5 + 0.5 * parts.thin * 0.55 + 0.45 * young * 1.2;
  let g = 0.07 + 0.62 * (parts.bulge + parts.bar) * 0.5 + 0.45 * parts.thin * 0.55 + 0.62 * young * 1.2;
  let b = 0.12 + 0.33 * (parts.bulge + parts.bar) * 0.5 + 0.34 * parts.thin * 0.55 + 1.0 * young * 1.2;
  // Dust lanes darken and redden (blue dies first).
  const dust = 0.55 * lane * Math.min(1, parts.thin * 1.4);
  r *= 1 - dust * 0.5;
  g *= 1 - dust * 0.7;
  b *= 1 - dust * 0.85;
  // Hue-preserving soft knee.
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const k = 1 / (1 + lum * 0.6);
  return [Math.min(1, r * k), Math.min(1, g * k), Math.min(1, b * k)];
}

export interface SectorMap {
  group: THREE.Group;
  /** Raycast the saucer; returns the hit point, or null. */
  pick(raycaster: THREE.Raycaster): THREE.Vector3 | null;
  dispose(): void;
}

export function createSectorMap(): SectorMap {
  const { GALAXY_SECTORS: S, GALAXY_SECTOR_RINGS: RINGS, GALAXY_NTH: nth } = UNIVERSE;
  const radii = ringRadii();

  // Two sheets (top / bottom) of RINGS × S tiles. Radial subdivisions
  // exist so the Gaussian bulge is a dome, not one cone-facet per ring
  // (R_SEG=1 made even a zero-slope law look like a witch's hat).
  const AZ_SEG = 2;
  const R_SEG = 4;
  const vertsPerTile = (AZ_SEG + 1) * (R_SEG + 1);
  const trisPerTile = AZ_SEG * R_SEG * 2;
  const tiles = RINGS * S;
  const sheets = 2;
  const positions = new Float32Array(tiles * vertsPerTile * sheets * 3);
  const colors = new Float32Array(tiles * vertsPerTile * sheets * 3);
  const uvs = new Float32Array(tiles * vertsPerTile * sheets * 2);
  const index = new Uint32Array(tiles * trisPerTile * sheets * 3);

  let vi = 0;
  let ii = 0;
  for (let ring = 0; ring < RINGS; ring++) {
    const r0 = radii[ring];
    const r1 = radii[ring + 1];
    for (let sector = 0; sector < S; sector++) {
      const [it0, it1] = spokeBounds(sector);
      const th0 = (it0 / nth) * TAU;
      const th1 = (it1 / nth) * TAU;
      for (let sheet = 0; sheet < sheets; sheet++) {
        const sign = sheet === 0 ? 1 : -1;
        const base = vi;
        for (let ri = 0; ri <= R_SEG; ri++) {
          const R = r0 + ((r1 - r0) * ri) / R_SEG;
          for (let ai = 0; ai <= AZ_SEG; ai++) {
            const th = th0 + ((th1 - th0) * ai) / AZ_SEG;
            const y = sign * saucerHeight(R);
            positions[vi * 3] = R * Math.cos(th);
            positions[vi * 3 + 1] = y;
            positions[vi * 3 + 2] = R * Math.sin(th);
            const [cr, cg, cb] = tileColor(R, th);
            colors[vi * 3] = cr;
            colors[vi * 3 + 1] = cg;
            colors[vi * 3 + 2] = cb;
            uvs[vi * 2] = R / UNIVERSE.GALAXY_R_MAX;
            uvs[vi * 2 + 1] = ((th % TAU) + TAU) % TAU / TAU;
            vi++;
          }
        }
        for (let ri = 0; ri < R_SEG; ri++) {
          for (let ai = 0; ai < AZ_SEG; ai++) {
            const a = base + ri * (AZ_SEG + 1) + ai;
            const b = a + 1;
            const c = a + (AZ_SEG + 1);
            const d = c + 1;
            index[ii++] = a;
            index[ii++] = c;
            index[ii++] = b;
            index[ii++] = b;
            index[ii++] = c;
            index[ii++] = d;
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  const group = new THREE.Group();
  group.add(mesh);

  return {
    group,
    pick(raycaster: THREE.Raycaster): THREE.Vector3 | null {
      const hits = raycaster.intersectObject(mesh, false);
      if (!hits.length) return null;
      return hits[0].point.clone();
    },
    dispose(): void {
      geo.dispose();
      mat.dispose();
    },
  };
}
