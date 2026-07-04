/**
 * First-Person Terrain Mesh Builder
 *
 * Standalone geometry computation extracted from FirstPersonView. Constructs the
 * THREE.js terrain meshes for a first-person battlefield scene:
 *   - `buildTerrainMesh`  — public entry point: builds hex tops, cliff skirts,
 *                           and rim outlines; returns disposables + pick meshes.
 *   - `buildVertexHeight` — shared height-averaging lookup consumed by both the
 *                           terrain mesh and the unit-placement pass.
 *   - `elevationWorldHeight` / `avgHexRadius` — pure helpers, also re-exported
 *                           for use in FirstPersonView.
 *
 * No class state: every function is pure or takes everything it needs as args.
 */

import * as THREE from 'three';
import type { WorldData, TileData } from './worldData.js';
import type { FlatTile } from './localMapProjection.js';
import { tileHeight, HEIGHT_LEVELS } from '../shared/movementConstants.js';
import { tileColorRGB } from './colors.js';
import { TerrainTextures } from './terrainTextures.js';

import oceanUrl from '../artifacts/ocean.webp';
import grassUrl from '../artifacts/grass.webp';
import plainsUrl from '../artifacts/plains.webp';
import desertUrl from '../artifacts/desert.webp';
import tundraUrl from '../artifacts/tundra.webp';
import hillsUrl from '../artifacts/hills.webp';
import hillsPlainsUrl from '../artifacts/HillsPlains.webp';
import mountainUrl from '../artifacts/mountain.webp';
import cliffsUrl from '../artifacts/cliffs.webp';
import roadUrl from '../artifacts/road.webp';
import pavementUrl from '../artifacts/pavement.webp';

// ---------------------------------------------------------------------------
// Constants (shared with FirstPersonView via re-export where needed)
// ---------------------------------------------------------------------------

/** Texture key → source URL, mirroring TerrainTextures.SOURCES. */
const TEXTURE_SOURCES: Record<string, string> = {
  ocean: oceanUrl,
  grassland: grassUrl,
  plains: plainsUrl,
  desert: desertUrl,
  tundra: tundraUrl,
  hills: hillsUrl,
  hillsPlains: hillsPlainsUrl,
  mountain: mountainUrl,
  cliffs: cliffsUrl,
  road: roadUrl,
  pavement: pavementUrl,
};

// White-overlay wash applied to each texture on load — matches the 2D map look.
const WASH_WHITE_ALPHA = 0.55;

/**
 * Ease-in exponent for the elevation→world-height curve. >1 compresses the low
 * end (coasts, plains, hills join gently) and stretches the top (mountains stay
 * dramatic). At 1.0 this is the old linear map. Purely visual — gameplay reads
 * the discrete tileHeight directly and is unaffected.
 */
const ELEV_CURVE_EXP = 4;

/**
 * Render-only cliff threshold, in discrete height levels. A hex border whose
 * |height step| exceeds this renders as a vertical cliff face (flat tops + a
 * skirt wall) instead of a smooth tilted join. Deliberately decoupled from the
 * gameplay climb limits (MAX_CLIMB_WHEELED/LIMB): those govern what a chassis
 * can traverse; this governs when a slope looks like an intentional cliff rather
 * than an absurd ramp. Lower = more, cleaner cliffs; higher = more tilting.
 */
const MAX_SLOPE_RENDER = 3;

// ---------------------------------------------------------------------------
// Pure helpers (exported — FirstPersonView.open() and rebuildUnits() use them)
// ---------------------------------------------------------------------------

/**
 * World-space terrain height for a tile, derived from its discrete 0–11 height
 * through a non-linear ease-in curve (see ELEV_CURVE_EXP). Low terrain is
 * compressed so coasts and plains join gently; the top of the range is stretched
 * so mountains still read as mountains. Open ocean sits slightly below the flat
 * floor; inland water (lakes, rivers) uses its own carved height so a lake on a
 * plateau or a river descending a valley stays at its real level rather than
 * dropping to sea level.
 */
export function elevationWorldHeight(tile: TileData, elevWorldScale: number): number {
  const isOpenOcean =
    tile.terrain === 'ocean' && tile.rv === undefined;
  if (isOpenOcean) return -0.25 * elevWorldScale;
  const norm = tileHeight(tile) / (HEIGHT_LEVELS - 1); // 0 (flat) → 1 (peak)
  return Math.pow(norm, ELEV_CURVE_EXP) * elevWorldScale;
}

/**
 * The Y-offset applied to road and pavement geometry so it sits fractionally
 * above the terrain mesh without z-fighting. Units on city hexes must be lifted
 * by the same amount so they stand on the road surface rather than sinking into it.
 */
export function roadSurfaceLift(hexWorldRadius: number): number {
  return 0.004 * hexWorldRadius;
}

/**
 * Whether a tile should be treated as flat water — open ocean, inland lakes, and
 * river hexes (but not a bridged crossing, which is dry). All water is rendered
 * dead flat: its shared vertices are pinned to the water level so a land
 * neighbour slopes down to the waterline (or drops as a cliff when the bank is
 * tall) rather than dragging the water up to tilt and meet it.
 *
 * Mirrors `TerrainContext.isWaterTile` (used by the 2D views) so the 3D
 * first-person terrain treats lakes and rivers as water the same way.
 */
function isWaterTile(tile: TileData): boolean {
  if (tile.bridge) return false;          // a bridge deck is a dry crossing
  if (tile.rv !== undefined) return true; // river hexes are whole-hex water
  const terrain = String(tile.terrain ?? '').toLowerCase();
  return (
    terrain === 'ocean' || terrain === 'water' || terrain === 'lake'
  );
}

/**
 * Discrete height used for cliff comparison. Any water tile (ocean, lake, or
 * river) reads as the waterline (0) regardless of its stored height, so the
 * cliff test compares the neighbouring land elevation against the water surface
 * — a tall bank around a lake or river reads as a cliff, just like a coast.
 */
function cliffHeight(tile: TileData): number {
  return isWaterTile(tile) ? 0 : tileHeight(tile);
}

/**
 * Whether the border between two tiles should render as a vertical cliff rather
 * than a smooth join. A cliff is drawn when the height step exceeds the
 * render-only threshold (`MAX_SLOPE_RENDER`) — decoupled from the gameplay climb
 * limits so the visual cut-off can be tuned independently. This applies equally
 * to land-land borders and tall coastal drops. Smaller steps (including ordinary
 * shorelines) still join smoothly; water is kept flat separately by anchoring
 * shared vertices to the water level.
 */
export function isCliffEdge(a: TileData, b: TileData): boolean {
  return Math.abs(cliffHeight(a) - cliffHeight(b)) > MAX_SLOPE_RENDER;
}

/** Average distance from a flat tile's centre to its boundary vertices. */
export function avgHexRadius(ft: FlatTile): number {
  let sum = 0;
  for (const v of ft.poly) {
    sum += Math.sqrt((v.x - ft.cx) ** 2 + (v.y - ft.cy) ** 2);
  }
  return sum / Math.max(1, ft.poly.length);
}

// ---------------------------------------------------------------------------
// Texture cache
// ---------------------------------------------------------------------------

/**
 * Build (and cache on the provided Map) the THREE textures for terrain tops.
 * Returns the same map on subsequent calls if it has already been populated.
 * Created from the same `artifacts/*.webp` artwork the 2D map uses.
 */
export function getTerrainTextures(cache: Map<string, THREE.Texture>): Map<string, THREE.Texture> {
  if (cache.size > 0) return cache;
  const loader = new THREE.TextureLoader();
  for (const [key, url] of Object.entries(TEXTURE_SOURCES)) {
    const tex = loader.load(url, (loaded) => {
      // Wash textures out: composite a white overlay so the artwork reads as a
      // subtle, low-contrast surface — matching the washed look of the 2D view.
      const src = loaded.image as HTMLImageElement | HTMLCanvasElement;
      const canvas = document.createElement('canvas');
      canvas.width = src.width;
      canvas.height = src.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(src, 0, 0);
        ctx.globalAlpha = WASH_WHITE_ALPHA;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        loaded.image = canvas;
        loaded.needsUpdate = true;
      }
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    cache.set(key, tex);
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Vertex height lookup
// ---------------------------------------------------------------------------

/**
 * Build the shared "continuous surface" height lookup, now cliff-aware.
 *
 * For each boundary vertex we collect every tile that touches it and partition
 * them into clusters connected by *non-cliff* borders (see `isCliffEdge`). Each
 * tile's height at that vertex is the average over its own cluster — except a
 * cluster containing open water is pinned to the flat water level, so water
 * never tilts and a land neighbour slopes down to the waterline. Tiles
 * separated by a cliff (a drop steeper than the spider climb limit, including
 * tall coastal faces) resolve to *different* heights at the same point: their
 * plateau tops stay flat at their own elevation and the vertical skirt between
 * them reads as a cliff face.
 *
 * Where there is no cliff this collapses to the original behaviour — all tiles
 * touching a vertex average together, so neighbouring tops tilt to meet
 * seamlessly. The lookup takes the querying tile's index so it can return that
 * tile's cluster height; the unit-placement pass samples this exact surface so
 * models conform to what's drawn.
 */
export function buildVertexHeight(
  flatTiles: FlatTile[],
  world: WorldData,
  elevWorldScale: number,
): (tileIndex: number, p: { x: number; y: number }) => number {
  const vKey = (p: { x: number; y: number }): string =>
    `${Math.round(p.x * 1e4)}:${Math.round(p.y * 1e4)}`;

  // vertex key → list of tile indices whose polygon touches that vertex.
  const vTiles = new Map<string, number[]>();
  for (const ft of flatTiles) {
    for (const p of ft.poly) {
      const k = vKey(p);
      let arr = vTiles.get(k);
      if (!arr) { arr = []; vTiles.set(k, arr); }
      if (!arr.includes(ft.tileIndex)) arr.push(ft.tileIndex);
    }
  }

  // `${vertexKey}|${tileIndex}` → resolved cluster height for that tile.
  const heightByVertexTile = new Map<string, number>();

  for (const [k, tileIdxs] of vTiles) {
    // Union-find over the tiles at this vertex, joining any pair NOT separated
    // by a cliff border. (On a Goldberg hex grid an interior vertex is shared
    // by three pairwise-adjacent faces, so pairwise testing is exact.)
    const parent = tileIdxs.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    for (let i = 0; i < tileIdxs.length; i++) {
      for (let j = i + 1; j < tileIdxs.length; j++) {
        if (!isCliffEdge(world.tiles[tileIdxs[i]], world.tiles[tileIdxs[j]])) {
          parent[find(i)] = find(j);
        }
      }
    }

    // Average elevation within each cluster. A cluster that includes any open
    // water is pinned to the (flat) water level instead of averaged, so the
    // water surface stays dead flat and a land neighbour in the same cluster
    // slopes down to the waterline rather than tilting the water upward.
    const cluster = new Map<number, { sum: number; count: number; water: number | null }>();
    for (let i = 0; i < tileIdxs.length; i++) {
      const root = find(i);
      const tile = world.tiles[tileIdxs[i]];
      const hWorld = elevationWorldHeight(tile, elevWorldScale);
      const acc = cluster.get(root);
      const water = isWaterTile(tile) ? hWorld : null;
      if (acc) {
        acc.sum += hWorld;
        acc.count++;
        if (water !== null) acc.water = acc.water === null ? water : Math.min(acc.water, water);
      } else {
        cluster.set(root, { sum: hWorld, count: 1, water });
      }
    }
    for (let i = 0; i < tileIdxs.length; i++) {
      const acc = cluster.get(find(i))!;
      // A cluster containing water is pinned flat to the water level, so the
      // water surface stays level and a land neighbour in the same cluster
      // slopes DOWN to the waterline — this is what draws the shore slope.
      // (Do NOT clamp land vertices up to their own elevation here: that
      // flattens the shore and, critically, diverges from the authoritative
      // server steepness pass in src/world/segmentSteepness.ts, which pins the
      // same way.) Buildings/units are kept from sinking into a shore segment
      // at the placement layer (FirstPersonView), not by flattening the mesh.
      const height = acc.water !== null ? acc.water : acc.sum / acc.count;
      heightByVertexTile.set(`${k}|${tileIdxs[i]}`, height);
    }
  }

  return (tileIndex: number, p: { x: number; y: number }): number => {
    const h = heightByVertexTile.get(`${vKey(p)}|${tileIndex}`);
    if (h !== undefined) return h;
    return elevationWorldHeight(world.tiles[tileIndex], elevWorldScale);
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Objects returned by buildTerrainMesh so the caller can store and dispose them. */
export interface TerrainMeshResult {
  /** Terrain-top meshes — raycast targets for click picking. */
  pickMeshes: THREE.Mesh[];
  /** All THREE disposables (geometries + materials) created for the terrain. */
  disposables: Array<{ dispose: () => void }>;
}

/**
 * Build the ground hexes (raised to terrain elevation) and a far horizon disc,
 * and add them all to `scene`. Returns the pick meshes and disposables so the
 * caller (FirstPersonView) can store and release them on close.
 *
 * @param flatTiles    Projected flat-view tiles for the visible area.
 * @param world        Full world data (tiles needed for terrain type + colour).
 * @param toWorld      Flat-to-world coordinate conversion (matches the view's projection).
 * @param vertexHeight Shared continuous-surface height lookup (from buildVertexHeight).
 * @param textureCache Mutable Map used to cache textures across open/close cycles.
 * @param textureKeys  TerrainTextures instance used for tile→key mapping.
 * @param hexWorldRadius Target on-screen radius (world units) for a hex.
 * @param fieldExtent  World-space half-extent of the rendered field.
 * @param elevWorldScale Vertical scale for terrain elevation.
 * @param scene        Target THREE.Scene to add meshes to.
 */
export function buildTerrainMesh(
  flatTiles: FlatTile[],
  world: WorldData,
  toWorld: (px: number, py: number) => [number, number, number],
  vertexHeight: (tileIndex: number, p: { x: number; y: number }) => number,
  textureCache: Map<string, THREE.Texture>,
  textureKeys: TerrainTextures,
  hexWorldRadius: number,
  fieldExtent: number,
  elevWorldScale: number,
  scene: THREE.Scene,
): TerrainMeshResult {
  const textures = getTerrainTextures(textureCache);
  const disposables: Array<{ dispose: () => void }> = [];
  const pickMeshes: THREE.Mesh[] = [];

  // Determine the lowest terrain top so cliff skirts can drop to a common
  // floor below everything — this closes vertical gaps between hexes at
  // different elevations.
  let minTop = Infinity;
  for (const ft of flatTiles) {
    minTop = Math.min(minTop, elevationWorldHeight(world.tiles[ft.tileIndex], elevWorldScale));
  }
  if (!isFinite(minTop)) minTop = 0;
  const floorY = minTop - hexWorldRadius * 1.5;

  // Far horizon ground so there's no void beyond the rendered hexes.
  const horizonGeo = new THREE.CircleGeometry(fieldExtent * 5, 48);
  const horizonMat = new THREE.MeshBasicMaterial({ color: 0x6f7d54 });
  const horizon = new THREE.Mesh(horizonGeo, horizonMat);
  horizon.rotation.x = -Math.PI / 2;
  horizon.position.y = floorY + 0.05;
  scene.add(horizon);
  disposables.push(horizonGeo, horizonMat);

  // Hex tops are grouped by texture key — one textured mesh per terrain type
  // — so each plateau shows the same artwork as the 2D map, tinted by the
  // tile's biome colour (vertex colours multiply the texture).
  type TopGroup = { positions: number[]; colors: number[]; uvs: number[] };
  const topGroups = new Map<string, TopGroup>();

  // Cliff skirts — split into textured (for sheer cliffs) and vertex-coloured
  // (for gentle slopes).
  const texturedSkirtPositions: number[] = [];
  const texturedSkirtUVs: number[] = [];
  const texturedSkirtIndices: number[] = [];
  const edgePositions: number[] = [];

  // tileIndex → FlatTile, so each edge can look up its real neighbour and test
  // isCliffEdge instead of the previous "every tile has neighbours" placeholder
  // (which fired on every edge, including non-cliff slopes). Non-cliff edges
  // already meet seamlessly via buildVertexHeight's shared-vertex averaging —
  // they need no skirt at all. Emitting one there dropped a near-vertical wall
  // right in front of a unit standing on a shallow slope, occluding its model
  // while the always-on-top (depthTest:false) label sprite stayed visible.
  const ftByTileIdx = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTileIdx.set(ft.tileIndex, ft);

  for (const ft of flatTiles) {
    const tile = world.tiles[ft.tileIndex];
    const [r, g, b] = tileColorRGB(tile);
    const n = ft.poly.length;

    // World positions of the boundary vertices, each lifted to its shared
    // (averaged) height so neighbouring tiles meet seamlessly.
    const tv = ft.poly.map((p) => {
      const w = toWorld(p.x, p.y);
      return [w[0], vertexHeight(ft.tileIndex, p), w[2]] as [number, number, number];
    });

    // Per-tile UVs: map the hex's flat bounding box onto the full texture so
    // each hex shows the whole image (matching the 2D fillTileTexture look).
    let minX = Infinity, maxX = -Infinity, minPy = Infinity, maxPy = -Infinity;
    for (const p of ft.poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minPy) minPy = p.y;
      if (p.y > maxPy) maxPy = p.y;
    }
    const wX = maxX - minX || 1;
    const wY = maxPy - minPy || 1;
    const uvOf = (i: number): [number, number] => [
      (ft.poly[i].x - minX) / wX,
      1 - (ft.poly[i].y - minPy) / wY,
    ];

    const key = textureKeys.keyForTile(tile, world) ?? 'grassland';
    let grp = topGroups.get(key);
    if (!grp) {
      grp = { positions: [], colors: [], uvs: [] };
      topGroups.set(key, grp);
    }

    // Plateau top — triangle fan from poly[0].
    for (let i = 1; i < n - 1; i++) {
      for (const idx of [0, i, i + 1]) {
        grp.positions.push(tv[idx][0], tv[idx][1], tv[idx][2]);
        grp.colors.push(r, g, b);
        const [u, v] = uvOf(idx);
        grp.uvs.push(u, v);
      }
    }

    // Cliff skirts — a darker vertical wall from each edge down to the floor,
    // drawn only for genuine cliff borders (isCliffEdge). Ordinary slopes join
    // smoothly via the shared, averaged vertex heights from buildVertexHeight
    // and need no skirt — the neighbour's own top surface already closes the gap.
    for (let i = 0; i < n; i++) {
      const a = tv[i];
      const c = tv[(i + 1) % n];

      // Find the real neighbour across this edge (by outward-direction match,
      // same approach as the 2D renderer's neighbourAcrossSegment) and test the
      // actual height step against the render-only cliff threshold.
      const v0 = ft.poly[i];
      const v1 = ft.poly[(i + 1) % n];
      const midX = (v0.x + v1.x) / 2;
      const midY = (v0.y + v1.y) / 2;
      const outX = midX - ft.cx;
      const outY = midY - ft.cy;
      const outLen = Math.hypot(outX, outY);
      let neighbourTile: TileData | null = null;
      if (outLen > 1e-8 && world.tiles[ft.tileIndex].n) {
        const normX = outX / outLen;
        const normY = outY / outLen;
        let bestDot = -Infinity;
        for (const nIdx of world.tiles[ft.tileIndex].n) {
          const nft = ftByTileIdx.get(nIdx);
          if (!nft) continue;
          const dx = nft.cx - ft.cx;
          const dy = nft.cy - ft.cy;
          const len = Math.hypot(dx, dy);
          if (len < 1e-8) continue;
          const dot = (dx / len) * normX + (dy / len) * normY;
          if (dot > bestDot) {
            bestDot = dot;
            neighbourTile = world.tiles[nIdx];
          }
        }
      }
      const isCliff = neighbourTile !== null && isCliffEdge(world.tiles[ft.tileIndex], neighbourTile);
      if (!isCliff) continue;

      // Textured cliff face
      const baseIdx = texturedSkirtPositions.length / 3;
      const pushCliffVert = (x: number, y: number, z: number, u: number, v: number) => {
        texturedSkirtPositions.push(x, y, z);
        texturedSkirtUVs.push(u, v);
      };
      // Quad: [a_top, c_top, c_floor, a_floor]
      pushCliffVert(a[0], a[1], a[2], 0, 0);
      pushCliffVert(c[0], c[1], c[2], 1, 0);
      pushCliffVert(c[0], floorY, c[2], 1, 1);
      pushCliffVert(a[0], floorY, a[2], 0, 1);
      // Two triangles
      texturedSkirtIndices.push(baseIdx, baseIdx + 1, baseIdx + 2);
      texturedSkirtIndices.push(baseIdx, baseIdx + 2, baseIdx + 3);
    }

    // Hex outline along the plateau rim (slightly raised to avoid z-fighting).
    for (let i = 0; i < n; i++) {
      const v0 = tv[i];
      const v1 = tv[(i + 1) % n];
      edgePositions.push(v0[0], v0[1] + 0.02, v0[2], v1[0], v1[1] + 0.02, v1[2]);
    }
  }

  // One textured mesh per terrain key for the plateau tops.
  for (const [key, grp] of topGroups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(grp.positions), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(grp.colors), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(grp.uvs), 2));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: textures.get(key) ?? null,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const topMesh = new THREE.Mesh(geo, mat);
    scene.add(topMesh);
    pickMeshes.push(topMesh);
    disposables.push(geo, mat);
  }

  // Textured cliff faces (sheer, unclimbable slopes with cliff texture).
  if (texturedSkirtPositions.length > 0) {
    const cliffGeo = new THREE.BufferGeometry();
    cliffGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(texturedSkirtPositions), 3));
    cliffGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(texturedSkirtUVs), 2));
    cliffGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(texturedSkirtIndices), 1));
    cliffGeo.computeVertexNormals();
    const cliffMat = new THREE.MeshStandardMaterial({
      map: textures.get('cliffs') ?? null,
      roughness: 0.9,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    scene.add(new THREE.Mesh(cliffGeo, cliffMat));
    disposables.push(cliffGeo, cliffMat);
  }

  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgePositions), 3));
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.06 });
  scene.add(new THREE.LineSegments(edgeGeo, edgeMat));
  disposables.push(edgeGeo, edgeMat);

  // ── City road planes ────────────────────────────────────────────────────────
  // Collect the set of occupied (tileIndex, segment) pairs once — shared by
  // both the road pass (open segments) and the pavement pass (building segments).
  const occupiedSegs = new Set<string>();
  for (const b of world.buildings) {
    occupiedSegs.add(`${b.tileIndex}:${b.segment}`);
  }

  const roadTex = textures.get('road');
  if (roadTex) {
    // For each open (building-free) segment of every city hex, emit a thin
    // triangle that sits fractionally above the terrain surface, textured with
    // the road artwork. UVs mirror the 2D mapping: image y=0 at the outer edge
    // (left vertex), image y=1 at the hex centre; image x spans the edge at the
    // same scale so the texture is square and undistorted. This matches the 2D
    // drawCityRoads projection exactly, so the road reads as one continuous
    // surface across both views.

    const roadPositions: number[] = [];
    const roadUVs: number[] = [];

    for (const ft of flatTiles) {
      const tile = world.tiles[ft.tileIndex];
      if (!tile.city || tile.s !== 6 || ft.poly.length < 6) continue;

      const n = ft.poly.length;

      for (let s = 0; s < 6; s++) {
        if (occupiedSegs.has(`${ft.tileIndex}:${s}`)) continue;

        // Triangle vertices: hex centre (C), outer-edge left (A), outer-edge right (B).
        const pA = ft.poly[s % n];
        const pB = ft.poly[(s + 1) % n];

        const wC = toWorld(ft.cx, ft.cy);
        const wA = toWorld(pA.x, pA.y);
        const wB = toWorld(pB.x, pB.y);

        // Lift each vertex to the terrain surface, then nudge up by a tiny
        // epsilon so the road sits above the terrain without z-fighting.
        const ROAD_LIFT = 0.004 * (hexWorldRadius / 1.0);
        const yC = vertexHeight(ft.tileIndex, { x: ft.cx,  y: ft.cy  }) + ROAD_LIFT;
        const yA = vertexHeight(ft.tileIndex, { x: pA.x,   y: pA.y   }) + ROAD_LIFT;
        const yB = vertexHeight(ft.tileIndex, { x: pB.x,   y: pB.y   }) + ROAD_LIFT;

        // UV derivation mirrors 2D drawCityRoads:
        //   image y=0 → outer edge;  image y=1 → hex centre.
        //   image x   → along the outer edge, same scale as y.
        //
        // Edge vectors (flat projection space — toWorld is scale+sign only):
        const edgeLen = Math.hypot(pB.x - pA.x, pB.y - pA.y);
        if (edgeLen < 1e-9) continue;
        const mx = (pA.x + pB.x) / 2;
        const my = (pA.y + pB.y) / 2;
        const depth = Math.hypot(ft.cx - mx, ft.cy - my);
        if (depth < 1e-9) continue;

        // Along unit (left→right along outer edge):
        const ux = (pB.x - pA.x) / edgeLen;
        const uy = (pB.y - pA.y) / edgeLen;

        // The scale so both axes use the same pixels-per-unit ratio:
        const pixPerUnit = 1.0 / edgeLen;  // 1 image unit = edgeLen world units

        // u for each vertex = projection onto the along axis, normalised by edgeLen.
        // v = projection onto the depth axis (edge→centre), normalised by depth
        //     then mapped to [0..1] but scaled the same way (depth/edgeLen * ratio).
        //     We keep v proportional using edgeLen as the denominator (square texel).
        const uC = ((ft.cx - pA.x) * ux + (ft.cy - pA.y) * uy) * pixPerUnit;
        const uA = 0.0;
        const uB = 1.0;

        // Depth projection (along the midpoint→centre unit vector):
        const vScale = depth / edgeLen;  // keeps texel square
        const vC = vScale;
        // v at the outer edge vertices = 0 (they sit on the edge, image y=0)
        const vA = 0;
        const vB = 0;

        // Emit two triangles (one per half of the isosceles segment).
        // The full segment is triangle (C, A, B) — emit as one triangle.
        roadPositions.push(wA[0], yA, wA[2]);
        roadPositions.push(wB[0], yB, wB[2]);
        roadPositions.push(wC[0], yC, wC[2]);
        roadUVs.push(uA, vA, uB, vB, uC, vC);
      }
    }

    if (roadPositions.length > 0) {
      const roadGeo = new THREE.BufferGeometry();
      roadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(roadPositions), 3));
      roadGeo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(roadUVs),       2));
      roadGeo.computeVertexNormals();

      // Clone the road texture so we can set independent wrap / repeat without
      // affecting the shared cache entry.
      const roadTexClone = roadTex.clone();
      roadTexClone.wrapS = THREE.ClampToEdgeWrapping;
      roadTexClone.wrapT = THREE.ClampToEdgeWrapping;
      roadTexClone.needsUpdate = true;

      const roadMat = new THREE.MeshStandardMaterial({
        map: roadTexClone,
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const roadMesh = new THREE.Mesh(roadGeo, roadMat);
      scene.add(roadMesh);
      disposables.push(roadGeo, roadMat, roadTexClone);
    }
  }

  // ── City pavement planes ────────────────────────────────────────────────────
  // For each building-occupied segment of every city hex, emit a thin triangle
  // just above the terrain surface, textured with the pavement artwork. This
  // mirrors the road triangle construction exactly — same UV derivation, same
  // ROAD_LIFT — so pavement and road share a seamless visual language.
  const pavementTex = textures.get('pavement');
  if (pavementTex) {
    const pavementPositions: number[] = [];
    const pavementUVs: number[] = [];

    for (const ft of flatTiles) {
      const tile = world.tiles[ft.tileIndex];
      if (!tile.city || tile.s !== 6 || ft.poly.length < 6) continue;

      const n = ft.poly.length;

      for (let s = 0; s < 6; s++) {
        if (!occupiedSegs.has(`${ft.tileIndex}:${s}`)) continue;

        const pA = ft.poly[s % n];
        const pB = ft.poly[(s + 1) % n];

        const wC = toWorld(ft.cx, ft.cy);
        const wA = toWorld(pA.x, pA.y);
        const wB = toWorld(pB.x, pB.y);

        const ROAD_LIFT = 0.004 * (hexWorldRadius / 1.0);
        const yC = vertexHeight(ft.tileIndex, { x: ft.cx,  y: ft.cy  }) + ROAD_LIFT;
        const yA = vertexHeight(ft.tileIndex, { x: pA.x,   y: pA.y   }) + ROAD_LIFT;
        const yB = vertexHeight(ft.tileIndex, { x: pB.x,   y: pB.y   }) + ROAD_LIFT;

        const edgeLen = Math.hypot(pB.x - pA.x, pB.y - pA.y);
        if (edgeLen < 1e-9) continue;
        const mx = (pA.x + pB.x) / 2;
        const my = (pA.y + pB.y) / 2;
        const depth = Math.hypot(ft.cx - mx, ft.cy - my);
        if (depth < 1e-9) continue;

        const ux = (pB.x - pA.x) / edgeLen;
        const uy = (pB.y - pA.y) / edgeLen;
        const pixPerUnit = 1.0 / edgeLen;

        const uC = ((ft.cx - pA.x) * ux + (ft.cy - pA.y) * uy) * pixPerUnit;
        const uA = 0.0;
        const uB = 1.0;
        const vScale = depth / edgeLen;
        const vC = vScale;
        const vA = 0;
        const vB = 0;

        pavementPositions.push(wA[0], yA, wA[2]);
        pavementPositions.push(wB[0], yB, wB[2]);
        pavementPositions.push(wC[0], yC, wC[2]);
        pavementUVs.push(uA, vA, uB, vB, uC, vC);
      }
    }

    if (pavementPositions.length > 0) {
      const pavGeo = new THREE.BufferGeometry();
      pavGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pavementPositions), 3));
      pavGeo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(pavementUVs),       2));
      pavGeo.computeVertexNormals();

      const pavTexClone = pavementTex.clone();
      pavTexClone.wrapS = THREE.ClampToEdgeWrapping;
      pavTexClone.wrapT = THREE.ClampToEdgeWrapping;
      pavTexClone.needsUpdate = true;

      const pavMat = new THREE.MeshStandardMaterial({
        map: pavTexClone,
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const pavMesh = new THREE.Mesh(pavGeo, pavMat);
      scene.add(pavMesh);
      disposables.push(pavGeo, pavMat, pavTexClone);
    }
  }

  return { pickMeshes, disposables };
}
