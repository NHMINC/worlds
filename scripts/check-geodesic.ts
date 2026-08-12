/**
 * Sanity checks for the geodesic (Goldberg) grid.
 *
 *   npx tsx scripts/check-geodesic.ts
 *
 * Verifies cell counts, adjacency symmetry, pentagon count, CCW polygon
 * winding, polygon corner sharing, nearest-cell correctness against brute
 * force (small F) and round-trips (large F), and reports build timings.
 */
import { GeoGrid } from '../src/world/geodesic';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const F of [4, 11, 40]) {
  const t0 = performance.now();
  const g = new GeoGrid(F);
  const buildMs = performance.now() - t0;
  console.log(`\n--- F=${F} (${g.count} cells, built in ${buildMs.toFixed(0)}ms) ---`);

  check(`count = 10F²+2`, g.count === 10 * F * F + 2, `${g.count}`);

  // Degree census and adjacency symmetry.
  let pentagons = 0;
  let symmetric = true;
  let unitCenters = true;
  for (let id = 0; id < g.count; id++) {
    const deg = g.degree(id);
    if (deg === 5) pentagons++;
    for (const n of g.neighborsOf(id)) {
      if (!g.neighborsOf(n).includes(id)) symmetric = false;
    }
    const [x, y, z] = g.center(id);
    if (Math.abs(Math.hypot(x, y, z) - 1) > 1e-5) unitCenters = false;
  }
  check('exactly 12 pentagons', pentagons === 12, `${pentagons}`);
  check('adjacency is symmetric', symmetric);
  check('centers are unit vectors', unitCenters);

  // Polygons: CCW winding around the outward normal, corners shared by 3
  // cells. A corner is identified by its unordered {cell, n_k, n_k+1} id
  // triple — the same corner is emitted by exactly the three cells of the
  // subdivision triangle it is the centroid of.
  let ccw = true;
  let cornerShare = true;
  const cornerMap = new Map<string, number>();
  for (let id = 0; id < g.count; id++) {
    const poly = g.polygon(id);
    const nbs = g.neighborsOf(id);
    const deg = g.degree(id);
    const [cx, cy, cz] = g.center(id);
    let area = 0;
    for (let k = 0; k < deg; k++) {
      const k2 = (k + 1) % deg;
      // Signed area contribution: c · (v_k × v_k2) > 0 for CCW from outside.
      const ax = poly[k * 3];
      const ay = poly[k * 3 + 1];
      const az = poly[k * 3 + 2];
      const bx = poly[k2 * 3];
      const by = poly[k2 * 3 + 1];
      const bz = poly[k2 * 3 + 2];
      area += cx * (ay * bz - az * by) + cy * (az * bx - ax * bz) + cz * (ax * by - ay * bx);
      const key = [id, nbs[k], nbs[k2]].sort((a, b) => a - b).join(',');
      cornerMap.set(key, (cornerMap.get(key) ?? 0) + 1);
    }
    if (area <= 0) ccw = false;
  }
  for (const n of cornerMap.values()) if (n !== 3) cornerShare = false;
  check('polygons wind CCW', ccw);
  check('every polygon corner shared by exactly 3 cells', cornerShare);

  // Nearest cell: brute force comparison on random directions.
  const rng = mulberry(42 + F);
  let nearestOk = true;
  for (let s = 0; s < 500; s++) {
    const z = 2 * rng() - 1;
    const a = 2 * Math.PI * rng();
    const r = Math.sqrt(1 - z * z);
    const px = r * Math.cos(a);
    const py = r * Math.sin(a);
    const got = g.nearestCell(px, py, z);
    let best = -1;
    let bestD = -Infinity;
    for (let id = 0; id < g.count; id++) {
      const d = g.centers[id * 3] * px + g.centers[id * 3 + 1] * py + g.centers[id * 3 + 2] * z;
      if (d > bestD) {
        bestD = d;
        best = id;
      }
    }
    if (got !== best) nearestOk = false;
  }
  check('nearestCell matches brute force (500 random dirs)', nearestOk);

  // Ownership partition: every cell owned exactly once.
  const owned = new Uint8Array(g.count);
  for (let f = 0; f < 20; f++) for (const id of g.cellsOwned(f)) owned[id]++;
  check('face ownership partitions all cells', owned.every((n) => n === 1));
}

// Full-resolution build: timing plus center round-trips.
{
  const t0 = performance.now();
  const g = new GeoGrid(160);
  const buildMs = performance.now() - t0;
  console.log(`\n--- F=160 (${g.count} cells, built in ${buildMs.toFixed(0)}ms) ---`);
  check('count = 256002', g.count === 256002, `${g.count}`);
  const rng = mulberry(7);
  let roundTrip = true;
  for (let s = 0; s < 20000; s++) {
    const id = Math.floor(rng() * g.count);
    const [x, y, z] = g.center(id);
    if (g.nearestCell(x, y, z) !== id) roundTrip = false;
  }
  check('nearestCell(center(id)) === id (20k random cells)', roundTrip);
  let ccwFull = true;
  for (let id = 0; id < g.count; id++) {
    const poly = g.polygon(id);
    const deg = g.degree(id);
    const [cx, cy, cz] = g.center(id);
    let area = 0;
    for (let k = 0; k < deg; k++) {
      const k2 = (k + 1) % deg;
      area +=
        cx * (poly[k * 3 + 1] * poly[k2 * 3 + 2] - poly[k * 3 + 2] * poly[k2 * 3 + 1]) +
        cy * (poly[k * 3 + 2] * poly[k2 * 3] - poly[k * 3] * poly[k2 * 3 + 2]) +
        cz * (poly[k * 3] * poly[k2 * 3 + 1] - poly[k * 3 + 1] * poly[k2 * 3]);
    }
    if (area <= 0) ccwFull = false;
  }
  check('polygons wind CCW at full resolution', ccwFull);
  let pentagons = 0;
  for (let id = 0; id < g.count; id++) if (g.degree(id) === 5) pentagons++;
  check('exactly 12 pentagons', pentagons === 12, `${pentagons}`);

  // Area uniformity: min/max polygon area ratio (via spherical excess proxy).
  let minA = Infinity;
  let maxA = 0;
  for (let id = 0; id < g.count; id += 97) {
    const poly = g.polygon(id);
    const deg = g.degree(id);
    const [cx, cy, cz] = g.center(id);
    let area = 0;
    for (let k = 0; k < deg; k++) {
      const k2 = (k + 1) % deg;
      area +=
        cx * (poly[k * 3 + 1] * poly[k2 * 3 + 2] - poly[k * 3 + 2] * poly[k2 * 3 + 1]) +
        cy * (poly[k * 3 + 2] * poly[k2 * 3] - poly[k * 3] * poly[k2 * 3 + 2]) +
        cz * (poly[k * 3] * poly[k2 * 3 + 1] - poly[k * 3 + 1] * poly[k2 * 3]);
    }
    if (deg === 6) {
      minA = Math.min(minA, area);
      maxA = Math.max(maxA, area);
    }
  }
  console.log(`hexagon area spread: max/min = ${(maxA / minA).toFixed(2)}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
