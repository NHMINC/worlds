/**
 * Geodesic (Goldberg) grid: the sphere tiled with hexagon cells plus exactly
 * 12 pentagons, built as the dual of a class-I subdivided icosahedron.
 *
 * The icosahedron's 20 triangular faces are subdivided at frequency F; the
 * subdivision vertices (10F² + 2 of them) are the cell centers, and each
 * cell's polygon corners are the centroids of the triangles around its
 * center. Cells are near-uniform hexagons everywhere except the 12 original
 * icosahedron corners, which become pentagons.
 *
 * The icosahedron is oriented with two corners on the ±Z poles (the terrain
 * generator's polar axis), so pentagons sit at the poles and on two latitude
 * rings.
 *
 * Cell ids are dense integers in [0, count):
 *   [0, 12)                      the 12 corner pentagons
 *   [12, 12 + 30(F−1))           edge cells: 30 edges × (F−1), parametrized
 *                                from the lower-numbered corner
 *   [12 + 30(F−1), count)        interior cells: 20 faces × (F−1)(F−2)/2
 */

export type Vec3 = [number, number, number];

function norm3(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** 12 icosahedron corners: poles on ±Z plus two latitude rings of five. */
function icoCorners(): Vec3[] {
  const v: Vec3[] = [[0, 0, 1]];
  const lat = Math.atan(0.5);
  const c = Math.cos(lat);
  const s = Math.sin(lat);
  for (let i = 0; i < 5; i++) {
    const lon = (2 * Math.PI * i) / 5;
    v.push([c * Math.cos(lon), c * Math.sin(lon), s]);
  }
  for (let i = 0; i < 5; i++) {
    const lon = (2 * Math.PI * i) / 5 + Math.PI / 5;
    v.push([c * Math.cos(lon), c * Math.sin(lon), -s]);
  }
  v.push([0, 0, -1]);
  return v;
}

/** 20 faces as corner-id triples (winding is irrelevant; cells sort CCW later). */
const FACES: ReadonlyArray<readonly [number, number, number]> = (() => {
  const f: Array<[number, number, number]> = [];
  for (let i = 0; i < 5; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % 5);
    const c = 6 + i;
    const d = 6 + ((i + 1) % 5);
    f.push([0, a, b]); // polar cap, north
    f.push([a, c, b]); // upper middle band
    f.push([b, c, d]); // lower middle band
    f.push([11, d, c]); // polar cap, south
  }
  return f;
})();

export const FACE_COUNT = 20;

export class GeoGrid {
  readonly f: number;
  readonly count: number;
  /** Unit-sphere cell centers, 3 floats per cell. */
  readonly centers: Float32Array;
  /** 6 neighbor ids per cell, sorted CCW (viewed from outside); [5] is −1 for pentagons. */
  readonly neighbors: Int32Array;

  private corners: Vec3[];
  /** Inverse corner matrix rows per face, for gnomonic barycentric coords. */
  private baryRows: Float64Array; // 20 × 9
  /** Corner-pair key (a*12+b, a<b) → edge index 0..29. */
  private edgeIndex = new Map<number, number>();
  /** Two adjacent face indices per edge. */
  private edgeFaces: Array<[number, number]> = [];
  /** Normalized face centroids and each face's angular radius cosine margin. */
  private faceCenters: Float32Array; // 20 × 3
  private faceRadius: Float64Array; // 20, radians

  constructor(frequency: number) {
    const F = frequency;
    this.f = F;
    this.count = 10 * F * F + 2;
    this.corners = icoCorners();
    this.centers = new Float32Array(3 * this.count);
    this.neighbors = new Int32Array(6 * this.count).fill(-1);
    this.baryRows = new Float64Array(20 * 9);
    this.faceCenters = new Float32Array(20 * 3);
    this.faceRadius = new Float64Array(20);

    // ---- Edge table ---------------------------------------------------
    for (let f = 0; f < 20; f++) {
      const [a, b, c] = FACES[f];
      for (const [u, v] of [[a, b], [a, c], [b, c]] as const) {
        const key = Math.min(u, v) * 12 + Math.max(u, v);
        let e = this.edgeIndex.get(key);
        if (e === undefined) {
          e = this.edgeFaces.length;
          this.edgeIndex.set(key, e);
          this.edgeFaces.push([f, f]);
        } else {
          this.edgeFaces[e][1] = f;
        }
      }
    }

    // ---- Face frames (barycentric inverses, centers, radii) -----------
    for (let f = 0; f < 20; f++) {
      const [ia, ib, ic] = FACES[f];
      const A = this.corners[ia];
      const B = this.corners[ib];
      const C = this.corners[ic];
      // Inverse of M = [A B C] via cross products: rows are (B×C, C×A, A×B)/det.
      const bxc: Vec3 = [B[1] * C[2] - B[2] * C[1], B[2] * C[0] - B[0] * C[2], B[0] * C[1] - B[1] * C[0]];
      const cxa: Vec3 = [C[1] * A[2] - C[2] * A[1], C[2] * A[0] - C[0] * A[2], C[0] * A[1] - C[1] * A[0]];
      const axb: Vec3 = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
      const det = A[0] * bxc[0] + A[1] * bxc[1] + A[2] * bxc[2];
      for (let k = 0; k < 3; k++) {
        this.baryRows[f * 9 + k] = bxc[k] / det;
        this.baryRows[f * 9 + 3 + k] = cxa[k] / det;
        this.baryRows[f * 9 + 6 + k] = axb[k] / det;
      }
      const ctr = norm3(A[0] + B[0] + C[0], A[1] + B[1] + C[1], A[2] + B[2] + C[2]);
      this.faceCenters[f * 3] = ctr[0];
      this.faceCenters[f * 3 + 1] = ctr[1];
      this.faceCenters[f * 3 + 2] = ctr[2];
      this.faceRadius[f] = Math.acos(Math.min(1, ctr[0] * A[0] + ctr[1] * A[1] + ctr[2] * A[2]));
    }

    // ---- Centers and adjacency ----------------------------------------
    // Per-face id grid so each lattice id is computed once, then lattice
    // edges in the three "forward" directions link the mesh. Shared edge and
    // corner cells get identical ids from both faces, so cross-face
    // adjacency falls out for free.
    const rowStart = new Int32Array(F + 2); // lattice row offsets (row = i)
    for (let i = 0, acc = 0; i <= F + 1; i++) {
      rowStart[i] = acc;
      acc += F + 1 - i;
    }
    const ids = new Int32Array(rowStart[F] + 1);
    for (let f = 0; f < 20; f++) {
      const [ia, ib, ic] = FACES[f];
      const A = this.corners[ia];
      const B = this.corners[ib];
      const C = this.corners[ic];
      for (let i = 0; i <= F; i++) {
        for (let j = 0; j <= F - i; j++) {
          const id = this.cellIdRaw(f, i, j);
          ids[rowStart[i] + j] = id;
          const u = i / F;
          const v = j / F;
          const w = 1 - u - v;
          const p = norm3(
            w * A[0] + u * B[0] + v * C[0],
            w * A[1] + u * B[1] + v * C[1],
            w * A[2] + u * B[2] + v * C[2],
          );
          this.centers[id * 3] = p[0];
          this.centers[id * 3 + 1] = p[1];
          this.centers[id * 3 + 2] = p[2];
        }
      }
      for (let i = 0; i <= F; i++) {
        for (let j = 0; j <= F - i; j++) {
          const id = ids[rowStart[i] + j];
          if (i + 1 + j <= F) this.link(id, ids[rowStart[i + 1] + j]);
          if (i + j + 1 <= F) this.link(id, ids[rowStart[i] + j + 1]);
          if (j >= 1 && i + j <= F) this.link(id, ids[rowStart[i + 1] + j - 1]);
        }
      }
    }

    // ---- Sort each cell's neighbors CCW --------------------------------
    const angles = new Float64Array(6);
    const tmp = new Int32Array(6);
    for (let id = 0; id < this.count; id++) {
      const cx = this.centers[id * 3];
      const cy = this.centers[id * 3 + 1];
      const cz = this.centers[id * 3 + 2];
      // Tangent basis (u ⟂ c, v = c × u): increasing atan2 is CCW from outside.
      // u = r × c with a reference axis chosen well away from c.
      let ux: number;
      let uy: number;
      let uz: number;
      if (Math.abs(cz) > 0.9) {
        // r = (1, 0, 0): r × c = (0, −cz, cy)
        ux = 0;
        uy = -cz;
        uz = cy;
      } else {
        // r = (0, 0, 1): r × c = (−cy, cx, 0)
        ux = -cy;
        uy = cx;
        uz = 0;
      }
      const ul = Math.hypot(ux, uy, uz);
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const vx = cy * uz - cz * uy;
      const vy = cz * ux - cx * uz;
      const vz = cx * uy - cy * ux;
      const deg = this.neighbors[id * 6 + 5] === -1 ? 5 : 6;
      for (let k = 0; k < deg; k++) {
        const n = this.neighbors[id * 6 + k];
        const nx = this.centers[n * 3];
        const ny = this.centers[n * 3 + 1];
        const nz = this.centers[n * 3 + 2];
        angles[k] = Math.atan2(nx * vx + ny * vy + nz * vz, nx * ux + ny * uy + nz * uz);
        tmp[k] = n;
      }
      // Insertion sort by angle (≤6 entries).
      for (let a = 1; a < deg; a++) {
        const angA = angles[a];
        const idA = tmp[a];
        let b = a - 1;
        while (b >= 0 && angles[b] > angA) {
          angles[b + 1] = angles[b];
          tmp[b + 1] = tmp[b];
          b--;
        }
        angles[b + 1] = angA;
        tmp[b + 1] = idA;
      }
      for (let k = 0; k < deg; k++) this.neighbors[id * 6 + k] = tmp[k];
    }
  }

  private link(a: number, b: number): void {
    this.addNeighbor(a, b);
    this.addNeighbor(b, a);
  }

  private addNeighbor(a: number, b: number): void {
    const base = a * 6;
    for (let k = 0; k < 6; k++) {
      const cur = this.neighbors[base + k];
      if (cur === b) return;
      if (cur === -1) {
        this.neighbors[base + k] = b;
        return;
      }
    }
  }

  /** Global id of lattice point (i, j) on face f — corners/edges deduped. */
  private cellIdRaw(f: number, i: number, j: number): number {
    const F = this.f;
    const [a, b, c] = FACES[f];
    if (i === 0 && j === 0) return a;
    if (i === F) return b;
    if (j === F) return c;
    if (j === 0) return this.edgeCellId(a, b, i);
    if (i === 0) return this.edgeCellId(a, c, j);
    if (i + j === F) return this.edgeCellId(b, c, j);
    const T = ((F - 1) * (F - 2)) / 2;
    const before = (i - 1) * (F - 1) - ((i - 1) * i) / 2;
    return 12 + 30 * (F - 1) + f * T + before + (j - 1);
  }

  /** Edge cell id; t = 1..F−1 measured from corner a toward corner b. */
  private edgeCellId(a: number, b: number, t: number): number {
    if (a > b) {
      t = this.f - t;
      const s = a;
      a = b;
      b = s;
    }
    const e = this.edgeIndex.get(a * 12 + b)!;
    return 12 + e * (this.f - 1) + (t - 1);
  }

  center(id: number): Vec3 {
    return [this.centers[id * 3], this.centers[id * 3 + 1], this.centers[id * 3 + 2]];
  }

  /** Neighbor count: 5 for the 12 pentagons, 6 otherwise. */
  degree(id: number): number {
    return this.neighbors[id * 6 + 5] === -1 ? 5 : 6;
  }

  neighborsOf(id: number): number[] {
    const deg = this.degree(id);
    const out: number[] = new Array(deg);
    for (let k = 0; k < deg; k++) out[k] = this.neighbors[id * 6 + k];
    return out;
  }

  /**
   * Cell polygon corners (CCW, unit sphere): normalized centroids of the
   * subdivision triangles around the center — shared exactly by the three
   * cells meeting at each corner, so the tiling has no gaps.
   */
  polygon(id: number): Float64Array {
    const deg = this.degree(id);
    const out = new Float64Array(deg * 3);
    const cx = this.centers[id * 3];
    const cy = this.centers[id * 3 + 1];
    const cz = this.centers[id * 3 + 2];
    for (let k = 0; k < deg; k++) {
      const n1 = this.neighbors[id * 6 + k];
      const n2 = this.neighbors[id * 6 + ((k + 1) % deg)];
      const x = cx + this.centers[n1 * 3] + this.centers[n2 * 3];
      const y = cy + this.centers[n1 * 3 + 1] + this.centers[n2 * 3 + 1];
      const z = cz + this.centers[n1 * 3 + 2] + this.centers[n2 * 3 + 2];
      const l = Math.hypot(x, y, z);
      out[k * 3] = x / l;
      out[k * 3 + 1] = y / l;
      out[k * 3 + 2] = z / l;
    }
    return out;
  }

  /** Cell whose center is nearest to direction p (need not be unit length). */
  nearestCell(px: number, py: number, pz: number): number {
    // Best face by gnomonic barycentric coordinates.
    let face = 0;
    let bestScore = -Infinity;
    let bu = 0;
    let bv = 0;
    for (let f = 0; f < 20; f++) {
      const r = this.baryRows;
      const o = f * 9;
      const b0 = r[o] * px + r[o + 1] * py + r[o + 2] * pz;
      const b1 = r[o + 3] * px + r[o + 4] * py + r[o + 5] * pz;
      const b2 = r[o + 6] * px + r[o + 7] * py + r[o + 8] * pz;
      const score = Math.min(b0, b1, b2);
      if (score > bestScore) {
        bestScore = score;
        face = f;
        const sum = b0 + b1 + b2;
        bu = b1 / sum;
        bv = b2 / sum;
      }
    }
    // Round to the triangular lattice (i + j + k = F).
    const F = this.f;
    const fi = F * bu;
    const fj = F * bv;
    const fk = F - fi - fj;
    let i = Math.round(fi);
    let j = Math.round(fj);
    let k = Math.round(fk);
    if (i + j + k !== F) {
      const di = Math.abs(i - fi);
      const dj = Math.abs(j - fj);
      const dk = Math.abs(k - fk);
      if (di >= dj && di >= dk) i = F - j - k;
      else if (dj >= dk) j = F - i - k;
      else k = F - i - j;
    }
    if (i < 0) i = 0;
    if (j < 0) j = 0;
    if (i + j > F) {
      if (i > j) i = F - j;
      else j = F - i;
    }
    let id = this.cellIdRaw(face, i, j);
    // Greedy hill-climb on the neighbor graph fixes any rounding slip; the
    // neighbor graph is the Delaunay triangulation of the centers, so this
    // converges to the true nearest center in a few steps.
    for (let guard = 0; guard < 12; guard++) {
      let best = this.centers[id * 3] * px + this.centers[id * 3 + 1] * py + this.centers[id * 3 + 2] * pz;
      let move = -1;
      const deg = this.degree(id);
      for (let n = 0; n < deg; n++) {
        const nb = this.neighbors[id * 6 + n];
        const d = this.centers[nb * 3] * px + this.centers[nb * 3 + 1] * py + this.centers[nb * 3 + 2] * pz;
        if (d > best) {
          best = d;
          move = nb;
        }
      }
      if (move === -1) break;
      id = move;
    }
    return id;
  }

  // ---------------------------------------------------------------- chunks

  /** Owner face of a cell (shared edge/corner cells go to the lowest face index). */
  ownerFace(id: number): number {
    if (id < 12) {
      for (let f = 0; f < 20; f++) {
        const [a, b, c] = FACES[f];
        if (a === id || b === id || c === id) return f;
      }
      return 0;
    }
    const F = this.f;
    const edgeSpan = 30 * (F - 1);
    if (id - 12 < edgeSpan) {
      const e = Math.floor((id - 12) / (F - 1));
      return Math.min(this.edgeFaces[e][0], this.edgeFaces[e][1]);
    }
    const T = ((F - 1) * (F - 2)) / 2;
    return Math.floor((id - 12 - edgeSpan) / T);
  }

  /** All cell ids owned by a face (its interior plus shared cells it owns). */
  cellsOwned(face: number): number[] {
    const F = this.f;
    const out: number[] = [];
    const [a, b, c] = FACES[face];
    for (const corner of [a, b, c]) {
      if (this.ownerFace(corner) === face) out.push(corner);
    }
    for (const [u, v] of [[a, b], [a, c], [b, c]] as const) {
      const key = Math.min(u, v) * 12 + Math.max(u, v);
      const e = this.edgeIndex.get(key)!;
      if (Math.min(this.edgeFaces[e][0], this.edgeFaces[e][1]) !== face) continue;
      for (let t = 1; t <= F - 1; t++) out.push(12 + e * (F - 1) + (t - 1));
    }
    const T = ((F - 1) * (F - 2)) / 2;
    const base = 12 + 30 * (F - 1) + face * T;
    for (let k = 0; k < T; k++) out.push(base + k);
    return out;
  }

  faceCenter(face: number): Vec3 {
    return [this.faceCenters[face * 3], this.faceCenters[face * 3 + 1], this.faceCenters[face * 3 + 2]];
  }

  /** Angular radius of a face (center to farthest corner), radians. */
  faceAngularRadius(face: number): number {
    return this.faceRadius[face];
  }

  /** Typical center-to-center angular spacing between cells, radians. */
  cellSpacing(): number {
    return Math.sqrt((8 * Math.PI) / (Math.sqrt(3) * this.count));
  }
}

const gridCache = new Map<number, GeoGrid>();

/** Shared grid instances — geometry is world-independent, so cache per frequency. */
export function getGrid(frequency: number): GeoGrid {
  let g = gridCache.get(frequency);
  if (!g) {
    g = new GeoGrid(frequency);
    gridCache.set(frequency, g);
  }
  return g;
}

/** Toy-world grid frequency at 100% size (10·96² + 2 = 92,162 columns). */
export const MAX_FINE_F = 96;

/**
 * Grid frequency for a world-size percentage. Cell count scales with F², so
 * the frequency goes with the square root: 20% of the hexes ≈ 45% of the
 * frequency. Missing/out-of-range sizes clamp; older worlds (no size) are 100%.
 */
export function frequencyForSize(sizePct?: number): number {
  const pct = Math.min(100, Math.max(10, sizePct ?? 100));
  return Math.max(24, Math.round(MAX_FINE_F * Math.sqrt(pct / 100)));
}

/** Cells in a Goldberg grid of frequency f. */
export function cellCountFor(f: number): number {
  return 10 * f * f + 2;
}

/**
 * Physical circumference implied by ~300 m hex columns, km. The cell spacing
 * is in radians, so the planet radius is 0.3 km / spacing.
 */
export function equatorKmFor(f: number): number {
  const spacing = Math.sqrt((8 * Math.PI) / (Math.sqrt(3) * cellCountFor(f)));
  return 2 * Math.PI * (0.3 / spacing);
}
