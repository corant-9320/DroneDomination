/**
 * Goldberg polyhedron geometry — geodesic sphere + dual computation.
 *
 * Produces the tile graph used by the rest of the world-gen pipeline:
 *
 *   1. generateGeodesicSphere(T)  — subdivide an icosahedron at frequency T,
 *      project all vertices to the unit sphere → SubdividedMesh.
 *
 *   2. computeDual(mesh)          — convert the subdivided mesh to its dual:
 *      triangle centroids become tile boundary vertices, original vertices
 *      become tile centres. Result: DualTile[].
 *
 * The dual of a subdivided icosahedron is a Goldberg polyhedron:
 *   - 12 pentagonal tiles (at the 12 original icosahedron vertices)
 *   - 10·T²-10 hexagonal tiles
 *   - Total: 10·T²+2 tiles (e.g. T=24 → 5762, T=36 → 12962)
 *
 * Segment alignment: segment N of a tile (the triangle slice bounded by
 * boundary[N]→boundary[N+1]) has its outer edge facing neighbours[N].
 * This invariant is enforced by alignBoundaryToNeighbours() and relied on
 * by the movement system, combat facing, and the local-map renderer.
 */

import { Vec3 } from './types.js';
import * as v from './vec3.js';

const PHI = (1 + Math.sqrt(5)) / 2;

// ─── Icosahedron ──────────────────────────────────────────────────────────────

/** 12 vertices of the base icosahedron (normalized to unit sphere) */
function icosahedronVertices(): Vec3[] {
  const verts: Vec3[] = [];
  verts.push(v.normalize({ x: 0, y: 1, z: 0 }));
  const upperAngle = Math.atan(0.5);
  for (let i = 0; i < 5; i++) {
    const theta = (2 * Math.PI * i) / 5;
    verts.push(v.normalize({
      x: Math.cos(upperAngle) * Math.cos(theta),
      y: Math.sin(upperAngle),
      z: Math.cos(upperAngle) * Math.sin(theta),
    }));
  }
  const lowerAngle = -Math.atan(0.5);
  for (let i = 0; i < 5; i++) {
    const theta = (2 * Math.PI * i) / 5 + Math.PI / 5;
    verts.push(v.normalize({
      x: Math.cos(lowerAngle) * Math.cos(theta),
      y: Math.sin(lowerAngle),
      z: Math.cos(lowerAngle) * Math.sin(theta),
    }));
  }
  verts.push(v.normalize({ x: 0, y: -1, z: 0 }));
  return verts;
}

/** 20 triangular faces of the icosahedron (vertex index triples) */
function icosahedronFaces(): [number, number, number][] {
  return [
    [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5], [0, 5, 1],
    [1, 6, 2], [2, 7, 3], [3, 8, 4], [4, 9, 5], [5, 10, 1],
    [6, 7, 2], [7, 8, 3], [8, 9, 4], [9, 10, 5], [10, 6, 1],
    [11, 7, 6], [11, 8, 7], [11, 9, 8], [11, 10, 9], [11, 6, 10],
  ];
}

// ─── Geodesic subdivision ─────────────────────────────────────────────────────

export interface SubdividedMesh {
  vertices: Vec3[];
  triangles: [number, number, number][];
}

/**
 * Generate a Class I geodesic sphere by subdividing an icosahedron at
 * frequency T and projecting all vertices onto the unit sphere.
 */
export function generateGeodesicSphere(T: number): SubdividedMesh {
  const icoVerts = icosahedronVertices();
  const icoFaces = icosahedronFaces();

  const vertexMap = new Map<string, number>();
  const vertices: Vec3[] = [];
  const triangles: [number, number, number][] = [];

  function vertexKey(pos: Vec3): string {
    const precision = 1e-8;
    const rx = Math.round(pos.x / precision) * precision;
    const ry = Math.round(pos.y / precision) * precision;
    const rz = Math.round(pos.z / precision) * precision;
    return `${rx.toFixed(9)},${ry.toFixed(9)},${rz.toFixed(9)}`;
  }

  function getOrAddVertex(pos: Vec3): number {
    const projected = v.normalize(pos);
    const key = vertexKey(projected);
    const existing = vertexMap.get(key);
    if (existing !== undefined) return existing;
    const idx = vertices.length;
    vertices.push(projected);
    vertexMap.set(key, idx);
    return idx;
  }

  for (const [ai, bi, ci] of icoFaces) {
    const a = icoVerts[ai];
    const b = icoVerts[bi];
    const c = icoVerts[ci];

    const faceVerts: number[][] = [];
    for (let i = 0; i <= T; i++) {
      const row: number[] = [];
      for (let j = 0; j <= T - i; j++) {
        const u = i / T;
        const vv = j / T;
        const pos: Vec3 = {
          x: a.x + u * (c.x - a.x) + vv * (b.x - a.x),
          y: a.y + u * (c.y - a.y) + vv * (b.y - a.y),
          z: a.z + u * (c.z - a.z) + vv * (b.z - a.z),
        };
        row.push(getOrAddVertex(pos));
      }
      faceVerts.push(row);
    }

    for (let i = 0; i < T; i++) {
      for (let j = 0; j < T - i; j++) {
        triangles.push([faceVerts[i][j], faceVerts[i][j + 1], faceVerts[i + 1][j]]);
        if (j < T - i - 1) {
          triangles.push([faceVerts[i + 1][j], faceVerts[i][j + 1], faceVerts[i + 1][j + 1]]);
        }
      }
    }
  }

  return { vertices, triangles };
}

// ─── Dual computation ─────────────────────────────────────────────────────────

export interface DualTile {
  index: number;
  sides: 5 | 6;
  neighbours: number[];
  position3d: Vec3;
  /** Ordered boundary polygon vertices on the unit sphere. */
  boundary: Vec3[];
}

/**
 * Compute the dual of the geodesic sphere.
 *
 * Each original vertex becomes a tile face (tile centre = original vertex).
 * Each original triangle becomes a boundary vertex (centroid, projected to sphere).
 * Two tiles are adjacent iff their original vertices shared an edge.
 *
 * Boundary alignment: segment N faces neighbours[N] — enforced by
 * alignBoundaryToNeighbours().
 */
export function computeDual(mesh: SubdividedMesh): DualTile[] {
  const { vertices, triangles } = mesh;
  const vertexCount = vertices.length;

  const adjacency: Set<number>[] = Array.from({ length: vertexCount }, () => new Set());
  const vertexTriangles: number[][] = Array.from({ length: vertexCount }, () => []);

  for (let ti = 0; ti < triangles.length; ti++) {
    const [a, b, c] = triangles[ti];
    adjacency[a].add(b); adjacency[a].add(c);
    adjacency[b].add(a); adjacency[b].add(c);
    adjacency[c].add(a); adjacency[c].add(b);
    vertexTriangles[a].push(ti);
    vertexTriangles[b].push(ti);
    vertexTriangles[c].push(ti);
  }

  const triCentroids: Vec3[] = triangles.map(([a, b, c]) =>
    v.normalize({
      x: (vertices[a].x + vertices[b].x + vertices[c].x) / 3,
      y: (vertices[a].y + vertices[b].y + vertices[c].y) / 3,
      z: (vertices[a].z + vertices[b].z + vertices[c].z) / 3,
    })
  );

  const tiles: DualTile[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const neighSet = adjacency[i];
    const sides = neighSet.size as 5 | 6;
    const centre = vertices[i];
    const neighArray = Array.from(neighSet);
    const sortedNeighbours = sortNeighboursAngular(centre, neighArray, vertices);

    const tris = vertexTriangles[i];
    const boundaryCentroids = tris.map((ti) => triCentroids[ti]);
    const sortedBoundary = sortPointsAngular(centre, boundaryCentroids);
    const alignedBoundary = alignBoundaryToNeighbours(centre, sortedBoundary, sortedNeighbours, vertices);

    tiles.push({ index: i, sides, neighbours: sortedNeighbours, position3d: centre, boundary: alignedBoundary });
  }

  return tiles;
}

// ─── Angular sorting helpers ──────────────────────────────────────────────────

/** Sort a set of 3D points by their angular position around a centre normal. */
function sortPointsAngular(centre: Vec3, points: Vec3[]): Vec3[] {
  const normal = v.normalize(centre);
  let ref: Vec3;
  if (Math.abs(normal.y) < 0.9) {
    ref = v.normalize(v.cross(normal, { x: 0, y: 1, z: 0 }));
  } else {
    ref = v.normalize(v.cross(normal, { x: 1, y: 0, z: 0 }));
  }
  const tangentY = v.normalize(v.cross(normal, ref));

  return points
    .map((pos) => {
      const diff = v.sub(pos, centre);
      return { pos, angle: Math.atan2(v.dot(diff, tangentY), v.dot(diff, ref)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((w) => w.pos);
}

/**
 * Rotate the sorted boundary array so that segment 0 faces neighbours[0].
 *
 * Both arrays are sorted angularly around the tile centre but may be offset
 * by a constant rotation. This finds that offset by matching segment 0's
 * outer-edge midpoint to the nearest neighbour direction, then rotates.
 */
function alignBoundaryToNeighbours(
  centre: Vec3,
  boundary: Vec3[],
  neighbours: number[],
  allVertices: Vec3[],
): Vec3[] {
  const sides = boundary.length;
  if (sides === 0 || neighbours.length === 0) return boundary;

  const normal = v.normalize(centre);

  function tangentDir(p: Vec3): Vec3 {
    const diff = v.sub(p, centre);
    const radial = v.dot(diff, normal);
    return v.normalize({
      x: diff.x - radial * normal.x,
      y: diff.y - radial * normal.y,
      z: diff.z - radial * normal.z,
    });
  }

  const neighbour0Dir = tangentDir(allVertices[neighbours[0]]);

  let bestSeg = 0;
  let bestDot = -Infinity;
  for (let seg = 0; seg < sides; seg++) {
    const mid = v.scale(v.add(boundary[seg], boundary[(seg + 1) % sides]), 0.5);
    const dp = v.dot(tangentDir(mid), neighbour0Dir);
    if (dp > bestDot) { bestDot = dp; bestSeg = seg; }
  }

  if (bestSeg === 0) return boundary;

  const rotated: Vec3[] = [];
  for (let k = 0; k < sides; k++) rotated.push(boundary[(k + bestSeg) % sides]);
  return rotated;
}

function sortNeighboursAngular(centre: Vec3, neighbours: number[], allVertices: Vec3[]): number[] {
  const normal = v.normalize(centre);
  let ref: Vec3;
  if (Math.abs(normal.y) < 0.9) {
    ref = v.normalize(v.cross(normal, { x: 0, y: 1, z: 0 }));
  } else {
    ref = v.normalize(v.cross(normal, { x: 1, y: 0, z: 0 }));
  }
  const tangentY = v.normalize(v.cross(normal, ref));

  return neighbours
    .map((ni) => {
      const pos = allVertices[ni];
      const diff = v.sub(pos, centre);
      return { index: ni, angle: Math.atan2(v.dot(diff, tangentY), v.dot(diff, ref)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((w) => w.index);
}
