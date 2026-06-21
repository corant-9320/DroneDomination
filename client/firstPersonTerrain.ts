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
import { tileHeight, HEIGHT_LEVELS, MAX_CLIMB_LIMB } from '../shared/movementConstants.js';
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
};

// White-overlay wash applied to each texture on load — matches the 2D map look.
const WASH_WHITE_ALPHA = 0.55;

// ---------------------------------------------------------------------------
// Pure helpers (exported — FirstPersonView.open() and rebuildUnits() use them)
// ---------------------------------------------------------------------------

/**
 * World-space terrain height for a tile, derived from its discrete 0–11 height.
 * Normalised to 0→1 and scaled by `elevWorldScale`. Open ocean sits slightly
 * below the flat floor; inland water (lakes, rivers) uses its own carved height
 * so a lake on a plateau or a river descending a valley stays at its real level
 * rather than dropping to sea level.
 */
export function elevationWorldHeight(tile: TileData, elevWorldScale: number): number {
  const isOpenOcean =
    (tile.terrain === 'ocean' || tile.elevType === 'ocean') && tile.rv === undefined;
  if (isOpenOcean) return -0.25 * elevWorldScale;
  return (tileHeight(tile) / (HEIGHT_LEVELS - 1)) * elevWorldScale;
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
  const elev = String(tile.elevType ?? '').toLowerCase();
  return (
    terrain === 'ocean' || terrain === 'water' || terrain === 'lake' ||
    elev === 'ocean' || elev === 'water' || elev === 'lake'
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
 * than a smooth join. A cliff is drawn when the height step exceeds the spider
 * climb limit (`MAX_CLIMB_LIMB`) — a face too steep for any ground chassis to
 * scale. This applies equally to land-land borders and tall coastal drops.
 * Smaller steps (including ordinary shorelines) still join smoothly; water is
 * kept flat separately by anchoring shared vertices to the water level.
 */
function isCliffEdge(a: TileData, b: TileData): boolean {
  return Math.abs(cliffHeight(a) - cliffHeight(b)) > MAX_CLIMB_LIMB;
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

  // Cliff skirts stay vertex-coloured (a darker wall, no texture needed) and
  // the rim outline is drawn as line segments.
  const skirtPositions: number[] = [];
  const skirtColors: number[] = [];
  const edgePositions: number[] = [];

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

    const key = textureKeys.keyForTile(tile) ?? 'grassland';
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

    // Cliff skirts — a darker vertical wall from each edge down to the floor.
    const sr = r * 0.55, sg = g * 0.55, sb = b * 0.55;
    for (let i = 0; i < n; i++) {
      const a = tv[i];
      const c = tv[(i + 1) % n];
      // Two triangles forming the quad [a_top, c_top, c_floor, a_floor].
      const pushSkirt = (x: number, y: number, z: number) => {
        skirtPositions.push(x, y, z);
        skirtColors.push(sr, sg, sb);
      };
      pushSkirt(a[0], a[1], a[2]);
      pushSkirt(c[0], c[1], c[2]);
      pushSkirt(c[0], floorY, c[2]);
      pushSkirt(a[0], a[1], a[2]);
      pushSkirt(c[0], floorY, c[2]);
      pushSkirt(a[0], floorY, a[2]);
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

  // Vertex-coloured cliff skirts (no texture).
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPositions), 3));
  skirtGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(skirtColors), 3));
  skirtGeo.computeVertexNormals();
  const skirtMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  scene.add(new THREE.Mesh(skirtGeo, skirtMat));
  disposables.push(skirtGeo, skirtMat);

  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgePositions), 3));
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.06 });
  scene.add(new THREE.LineSegments(edgeGeo, edgeMat));
  disposables.push(edgeGeo, edgeMat);

  return { pickMeshes, disposables };
}
