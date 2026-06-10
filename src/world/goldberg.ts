/**
 * Goldberg G(36,0) polyhedron generation.
 *
 * Approach: Subdivide icosahedron faces into a frequency-36 triangular grid,
 * project vertices to the unit sphere, then compute the dual polyhedron.
 * The dual of a subdivided icosahedron gives us the Goldberg polyhedron:
 * - 12 pentagonal faces (at original icosahedron vertices)
 * - 12950 hexagonal faces
 * - Total: 12962 tiles
 *
 * Formula: F = 10*T^2 + 2 where T=36 → 10*1296+2 = 12962
 */

import { Vec3 } from './types.js';
import * as v from './vec3.js';

const PHI = (1 + Math.sqrt(5)) / 2;

/** 12 vertices of the base icosahedron (normalized to unit sphere) */
function icosahedronVertices(): Vec3[] {
  const verts: Vec3[] = [];
  // Top vertex
  verts.push(v.normalize({ x: 0, y: 1, z: 0 }));
  // Upper ring (5 vertices)
  const upperAngle = Math.atan(0.5);
  for (let i = 0; i < 5; i++) {
    const theta = (2 * Math.PI * i) / 5;
    verts.push(
      v.normalize({
        x: Math.cos(upperAngle) * Math.cos(theta),
        y: Math.sin(upperAngle),
        z: Math.cos(upperAngle) * Math.sin(theta),
      })
    );
  }
  // Lower ring (5 vertices)
  const lowerAngle = -Math.atan(0.5);
  for (let i = 0; i < 5; i++) {
    const theta = (2 * Math.PI * i) / 5 + Math.PI / 5;
    verts.push(
      v.normalize({
        x: Math.cos(lowerAngle) * Math.cos(theta),
        y: Math.sin(lowerAngle),
        z: Math.cos(lowerAngle) * Math.sin(theta),
      })
    );
  }
  // Bottom vertex
  verts.push(v.normalize({ x: 0, y: -1, z: 0 }));
  return verts;
}

/** 20 triangular faces of the icosahedron (vertex index triples) */
function icosahedronFaces(): [number, number, number][] {
  return [
    // Top cap
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 5],
    [0, 5, 1],
    // Middle band
    [1, 6, 2],
    [2, 7, 3],
    [3, 8, 4],
    [4, 9, 5],
    [5, 10, 1],
    [6, 7, 2],
    [7, 8, 3],
    [8, 9, 4],
    [9, 10, 5],
    [10, 6, 1],
    // Bottom cap
    [11, 7, 6],
    [11, 8, 7],
    [11, 9, 8],
    [11, 10, 9],
    [11, 6, 10],
  ];
}

/**
 * For a given frequency T, subdivide one triangular face into T^2 sub-triangles.
 * Returns indices of the vertices in the global vertex array.
 * We create (T+1)(T+2)/2 vertices per face, but many are shared between faces.
 */

interface SubdividedMesh {
  vertices: Vec3[];
  triangles: [number, number, number][];
}

/**
 * Generate the Class I geodesic sphere by subdividing an icosahedron at frequency T
 * and projecting all vertices onto the unit sphere.
 */
export function generateGeodesicSphere(T: number): SubdividedMesh {
  const icoVerts = icosahedronVertices();
  const icoFaces = icosahedronFaces();

  // We'll use a map to deduplicate vertices shared between faces
  const vertexMap = new Map<string, number>();
  const vertices: Vec3[] = [];
  const triangles: [number, number, number][] = [];

  function vertexKey(pos: Vec3): string {
    // Round to avoid floating-point duplicates
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

  // For each icosahedron face, create T^2 sub-triangles
  for (const [ai, bi, ci] of icoFaces) {
    const a = icoVerts[ai];
    const b = icoVerts[bi];
    const c = icoVerts[ci];

    // Create a grid of vertices for this face
    // Row i has (T - i + 1) vertices, going from edge AB toward C
    const faceVerts: number[][] = [];

    for (let i = 0; i <= T; i++) {
      const row: number[] = [];
      for (let j = 0; j <= T - i; j++) {
        // Barycentric-like interpolation
        const u = i / T;
        const vv = j / T;
        // Point = a + u*(c-a) + v*(b-a)
        const pos: Vec3 = {
          x: a.x + u * (c.x - a.x) + vv * (b.x - a.x),
          y: a.y + u * (c.y - a.y) + vv * (b.y - a.y),
          z: a.z + u * (c.z - a.z) + vv * (b.z - a.z),
        };
        row.push(getOrAddVertex(pos));
      }
      faceVerts.push(row);
    }

    // Create triangles from the grid
    for (let i = 0; i < T; i++) {
      for (let j = 0; j < T - i; j++) {
        // Upward triangle
        const v0 = faceVerts[i][j];
        const v1 = faceVerts[i][j + 1];
        const v2 = faceVerts[i + 1][j];
        triangles.push([v0, v1, v2]);

        // Downward triangle (if exists)
        if (j < T - i - 1) {
          const v3 = faceVerts[i + 1][j];
          const v4 = faceVerts[i][j + 1];
          const v5 = faceVerts[i + 1][j + 1];
          triangles.push([v3, v4, v5]);
        }
      }
    }
  }

  return { vertices, triangles };
}

/**
 * Compute the dual of the geodesic sphere.
 * Each vertex in the original mesh becomes a face (tile) in the dual.
 * Each face in the original mesh becomes a vertex in the dual (face centroid).
 * Adjacency: two dual faces are adjacent if they share an edge in the original,
 * i.e., their corresponding original vertices are connected by an edge.
 */
export interface DualTile {
  index: number;
  sides: 5 | 6;
  neighbours: number[];
  position3d: Vec3;
  /** Vertices of the polygon boundary (ordered, on unit sphere) */
  boundary: Vec3[];
}

export function computeDual(mesh: SubdividedMesh): DualTile[] {
  const { vertices, triangles } = mesh;
  const vertexCount = vertices.length;

  // Build adjacency: for each vertex, find all vertices connected by an edge
  const adjacency: Set<number>[] = Array.from({ length: vertexCount }, () => new Set());

  // For each vertex, collect the triangles that include it
  const vertexTriangles: number[][] = Array.from({ length: vertexCount }, () => []);

  for (let ti = 0; ti < triangles.length; ti++) {
    const [a, b, c] = triangles[ti];
    adjacency[a].add(b);
    adjacency[a].add(c);
    adjacency[b].add(a);
    adjacency[b].add(c);
    adjacency[c].add(a);
    adjacency[c].add(b);

    vertexTriangles[a].push(ti);
    vertexTriangles[b].push(ti);
    vertexTriangles[c].push(ti);
  }

  // Compute triangle centroids (projected to unit sphere)
  const triCentroids: Vec3[] = triangles.map(([a, b, c]) => {
    return v.normalize({
      x: (vertices[a].x + vertices[b].x + vertices[c].x) / 3,
      y: (vertices[a].y + vertices[b].y + vertices[c].y) / 3,
      z: (vertices[a].z + vertices[b].z + vertices[c].z) / 3,
    });
  });

  const tiles: DualTile[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const neighSet = adjacency[i];
    const sides = neighSet.size as 5 | 6;

    // Sort neighbours in angular order around the vertex normal
    const centre = vertices[i];
    const neighArray = Array.from(neighSet);
    const sortedNeighbours = sortNeighboursAngular(centre, neighArray, vertices);

    // Compute boundary polygon: centroids of surrounding triangles, ordered
    const tris = vertexTriangles[i];
    const boundaryCentroids = tris.map((ti) => triCentroids[ti]);

    // Sort boundary vertices angularly around the tile centre
    const sortedBoundary = sortPointsAngular(centre, boundaryCentroids);

    // Phase-align the boundary to the neighbour array so that segment N
    // (the triangle centre→boundary[N]→boundary[N+1]) has its outer edge
    // facing neighbour N. The two angular sorts above are independent and
    // can land out of phase by one slot; the segment-based movement model
    // (and all its consumers) require segment index == neighbour index.
    const alignedBoundary = alignBoundaryToNeighbours(
      centre,
      sortedBoundary,
      sortedNeighbours,
      vertices
    );

    tiles.push({
      index: i,
      sides,
      neighbours: sortedNeighbours,
      position3d: centre,
      boundary: alignedBoundary,
    });
  }

  return tiles;
}

/** Sort a set of 3D points by their angular position around a centre normal */
function sortPointsAngular(centre: Vec3, points: Vec3[]): Vec3[] {
  const normal = v.normalize(centre);

  let ref: Vec3;
  if (Math.abs(normal.y) < 0.9) {
    ref = v.normalize(v.cross(normal, { x: 0, y: 1, z: 0 }));
  } else {
    ref = v.normalize(v.cross(normal, { x: 1, y: 0, z: 0 }));
  }
  const tangentY = v.normalize(v.cross(normal, ref));

  const withAngle = points.map((pos) => {
    const diff = v.sub(pos, centre);
    const projX = v.dot(diff, ref);
    const projY = v.dot(diff, tangentY);
    const angle = Math.atan2(projY, projX);
    return { pos, angle };
  });

  withAngle.sort((a, b) => a.angle - b.angle);
  return withAngle.map((w) => w.pos);
}

/**
 * Rotate the (already angularly sorted) boundary array so that segment N —
 * the triangle (centre, boundary[N], boundary[N+1]) — has its outer edge
 * midpoint pointing toward neighbour N.
 *
 * Both `boundary` and `neighbours` are sorted by the same angular convention
 * around the tile centre, so they share an orientation but may differ by a
 * constant rotational offset (0 or 1 slot in practice). This finds that offset
 * by matching segment 0's edge-midpoint direction to the nearest neighbour
 * direction, then rotates the boundary so the offset becomes zero.
 *
 * Returns a new array; does not mutate the input.
 */
function alignBoundaryToNeighbours(
  centre: Vec3,
  boundary: Vec3[],
  neighbours: number[],
  allVertices: Vec3[]
): Vec3[] {
  const sides = boundary.length;
  if (sides === 0 || neighbours.length === 0) return boundary;

  const normal = v.normalize(centre);

  // Tangent-plane direction from the centre toward a point on the sphere.
  function tangentDir(p: Vec3): Vec3 {
    const diff = v.sub(p, centre);
    const radial = v.dot(diff, normal);
    return v.normalize({
      x: diff.x - radial * normal.x,
      y: diff.y - radial * normal.y,
      z: diff.z - radial * normal.z,
    });
  }

  // Direction toward neighbour 0.
  const neighbour0Dir = tangentDir(allVertices[neighbours[0]]);

  // Find which segment's outer-edge midpoint best matches neighbour 0's direction.
  let bestSeg = 0;
  let bestDot = -Infinity;
  for (let seg = 0; seg < sides; seg++) {
    const mid = v.scale(v.add(boundary[seg], boundary[(seg + 1) % sides]), 0.5);
    const dp = v.dot(tangentDir(mid), neighbour0Dir);
    if (dp > bestDot) {
      bestDot = dp;
      bestSeg = seg;
    }
  }

  if (bestSeg === 0) return boundary;

  // Rotate boundary left by bestSeg so segment 0 aligns with neighbour 0.
  const rotated: Vec3[] = [];
  for (let k = 0; k < sides; k++) {
    rotated.push(boundary[(k + bestSeg) % sides]);
  }
  return rotated;
}
function sortNeighboursAngular(
  centre: Vec3,
  neighbours: number[],
  allVertices: Vec3[]
): number[] {
  // Build a local tangent frame
  const normal = v.normalize(centre);

  // Pick a reference direction in the tangent plane
  let ref: Vec3;
  if (Math.abs(normal.y) < 0.9) {
    ref = v.normalize(v.cross(normal, { x: 0, y: 1, z: 0 }));
  } else {
    ref = v.normalize(v.cross(normal, { x: 1, y: 0, z: 0 }));
  }
  const tangentY = v.normalize(v.cross(normal, ref));

  // Compute angle for each neighbour
  const withAngle = neighbours.map((ni) => {
    const pos = allVertices[ni];
    const diff = v.sub(pos, centre);
    // Project onto tangent plane
    const projX = v.dot(diff, ref);
    const projY = v.dot(diff, tangentY);
    const angle = Math.atan2(projY, projX);
    return { index: ni, angle };
  });

  withAngle.sort((a, b) => a.angle - b.angle);
  return withAngle.map((w) => w.index);
}
