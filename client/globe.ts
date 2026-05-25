/**
 * Globe View — renders the full Goldberg sphere using Three.js.
 * Each tile is drawn as a proper hex/pentagon polygon face with edges.
 * Seamless tessellation with no gaps.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WorldData, TileData } from './worldData.js';
import { tileColorRGB, factionColorRGB } from './colors.js';
import { dbg } from './debug.js';

export class GlobeView {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private raycaster: THREE.Raycaster;
  private mouse: THREE.Vector2;
  private tileMesh: THREE.Mesh;
  private cliffMesh: THREE.Mesh;
  private edgeMesh: THREE.LineSegments;
  private cityMarkers: THREE.Points;
  private world: WorldData;
  private canvas: HTMLCanvasElement;
  private onTileSelect: (tileIndex: number) => void;
  private onViewCentreChange: ((tileIndex: number) => void) | null = null;
  private tileIdByFace: Uint16Array; // maps triangle index -> tile index
  private lastViewCentreTile: number = -1;
  private isProgrammaticPan: boolean = false;
  private panTarget: THREE.Vector3 | null = null;
  private panStart: THREE.Vector3 | null = null;
  private panProgress: number = 1; // 1 = done
  private mouseDownPos: { x: number; y: number } | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    world: WorldData,
    onTileSelect: (tileIndex: number) => void
  ) {
    this.canvas = canvas;
    this.world = world;
    this.onTileSelect = onTileSelect;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080810);

    // Camera
    const rect = canvas.parentElement!.getBoundingClientRect();
    this.camera = new THREE.PerspectiveCamera(50, rect.width / rect.height, 0.1, 100);
    this.camera.position.set(0, 0, 2.8);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(rect.width, rect.height);

    // Controls
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 5;

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Build the tile mesh (all polygons as triangulated faces)
    dbg.globe.time('buildTileMesh');
    const { mesh, cliffMesh, edgeLines, faceToTile } = this.buildTileMesh();
    dbg.globe.timeEnd('buildTileMesh');
    this.tileMesh = mesh;
    this.cliffMesh = cliffMesh;
    this.edgeMesh = edgeLines;
    this.tileIdByFace = faceToTile;
    this.scene.add(this.tileMesh);
    this.scene.add(this.cliffMesh);
    this.scene.add(this.edgeMesh);

    // City markers
    this.cityMarkers = this.buildCityMarkers();
    this.scene.add(this.cityMarkers);
    dbg.globe.log('Globe initialized:', {
      tiles: world.tileCount,
      cities: world.cities.length,
      cameraPos: this.camera.position.toArray(),
    });

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(3, 2, 4);
    this.scene.add(dirLight);

    // Events — track mousedown position to distinguish click from drag
    canvas.addEventListener('mousedown', (e) => {
      this.mouseDownPos = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('click', this.onClick.bind(this));
    window.addEventListener('resize', this.onResize.bind(this));

    // Fire view-centre callback as the user orbits the globe (throttled)
    let emitPending = false;
    this.controls.addEventListener('change', () => {
      if (emitPending) return;
      emitPending = true;
      requestAnimationFrame(() => {
        emitPending = false;
        this.emitViewCentre();
      });
    });

    this.animate();
  }

  /**
   * Radial scale factor per elevation type.
   * Tiles are pushed outward from the unit sphere by this amount,
   * giving a subtle raised appearance proportional to terrain height.
   */
  private static readonly ELEVATION_SCALE: Record<string, number> = {
    flat:     1.000,
    rolling:  1.006,
    hills:    1.013,
    mountain: 1.022,
  };

  /** Darken an RGB triple — scales toward black while preserving hue. */
  private static darken(r: number, g: number, b: number, factor: number): [number, number, number] {
    return [r * factor, g * factor, b * factor];
  }

  private buildTileMesh() {
    const tiles = this.world.tiles;
    const tileCount = tiles.length;

    // Pre-compute elevation scale and color for every tile
    const elevScales = new Float32Array(tileCount);
    const tileRGB: Array<[number, number, number]> = new Array(tileCount);
    for (let ti = 0; ti < tileCount; ti++) {
      const tile = tiles[ti];
      elevScales[ti] = tile.terrain === 'ocean'
        ? 1.0
        : (GlobeView.ELEVATION_SCALE[tile.elevType] ?? 1.0);
      tileRGB[ti] = tile.city
        ? factionColorRGB(this.world, tile.city)
        : tileColorRGB(tile);
    }

    // Count total triangles needed: each N-sided tile = N-2 triangles (fan)
    let totalTriangles = 0;
    for (const tile of tiles) {
      totalTriangles += tile.s - 2;
    }

    // Count cliff quads: for each neighbour pair where elevScale differs,
    // process each pair once (ti < nj). Each cliff edge = 1 quad = 2 triangles.
    let cliffTriangles = 0;
    for (let ti = 0; ti < tileCount; ti++) {
      for (const nj of tiles[ti].n) {
        if (nj <= ti) continue;
        if (elevScales[ti] !== elevScales[nj]) cliffTriangles += 2;
      }
    }

    // ── Tile top buffers (unlit) ─────────────────────────────────────────────
    const tPositions = new Float32Array(totalTriangles * 9);
    const tColors    = new Float32Array(totalTriangles * 9);
    const faceToTile = new Uint16Array(totalTriangles);

    // ── Cliff wall buffers (unlit — MeshBasicMaterial) ──────────────────────
    const cPositions = new Float32Array(cliffTriangles * 9);
    const cColors    = new Float32Array(cliffTriangles * 9);

    // ── Edge line buffers ────────────────────────────────────────────────────
    let totalEdgeVerts = 0;
    for (const tile of tiles) totalEdgeVerts += tile.s * 2;
    const edgePositions = new Float32Array(totalEdgeVerts * 3);

    let triIdx  = 0;
    let cTriIdx = 0;
    let edgeIdx = 0;

    // ── Pass 1: tile top faces ───────────────────────────────────────────────
    for (let ti = 0; ti < tileCount; ti++) {
      const tile = tiles[ti];
      const boundary = tile.b;
      const sides = tile.s;
      const elevScale = elevScales[ti];
      const [r, g, b] = tileRGB[ti];

      for (let i = 1; i < sides - 1; i++) {
        const v0 = boundary[0];
        const v1 = boundary[i];
        const v2 = boundary[i + 1];
        const base = triIdx * 9;

        tPositions[base]     = v0[0] * elevScale; tPositions[base + 1] = v0[1] * elevScale; tPositions[base + 2] = v0[2] * elevScale;
        tPositions[base + 3] = v1[0] * elevScale; tPositions[base + 4] = v1[1] * elevScale; tPositions[base + 5] = v1[2] * elevScale;
        tPositions[base + 6] = v2[0] * elevScale; tPositions[base + 7] = v2[1] * elevScale; tPositions[base + 8] = v2[2] * elevScale;

        tColors[base]     = r; tColors[base + 1] = g; tColors[base + 2] = b;
        tColors[base + 3] = r; tColors[base + 4] = g; tColors[base + 5] = b;
        tColors[base + 6] = r; tColors[base + 7] = g; tColors[base + 8] = b;

        faceToTile[triIdx] = ti;
        triIdx++;
      }

      const edgePush = elevScale * 1.001;
      for (let i = 0; i < sides; i++) {
        const v0 = boundary[i];
        const v1 = boundary[(i + 1) % sides];
        const eBase = edgeIdx * 3;
        edgePositions[eBase]     = v0[0] * edgePush; edgePositions[eBase + 1] = v0[1] * edgePush; edgePositions[eBase + 2] = v0[2] * edgePush;
        edgePositions[eBase + 3] = v1[0] * edgePush; edgePositions[eBase + 4] = v1[1] * edgePush; edgePositions[eBase + 5] = v1[2] * edgePush;
        edgeIdx += 2;
      }
    }

    // ── Pass 2: cliff side faces (unlit) ─────────────────────────────────────
    // Fill the gap between adjacent tiles at different elevations with a quad
    // coloured as a darkened version of the higher tile's colour.
    // Uses MeshBasicMaterial so lighting cannot darken them further.
    const CLIFF_DARKEN = 0.72;
    const snap = (v: [number, number, number]) =>
      `${Math.round(v[0] * 4096)},${Math.round(v[1] * 4096)},${Math.round(v[2] * 4096)}`;

    for (let ti = 0; ti < tileCount; ti++) {
      const tile = tiles[ti];
      for (const nj of tile.n) {
        if (nj <= ti) continue;

        const scaleA = elevScales[ti];
        const scaleB = elevScales[nj];
        if (scaleA === scaleB) continue;

        const hiIdx   = scaleA > scaleB ? ti : nj;
        const loIdx   = scaleA > scaleB ? nj : ti;
        const hiScale = elevScales[hiIdx];
        const loScale = elevScales[loIdx];
        const hiTile  = tiles[hiIdx];
        const loTile  = tiles[loIdx];

        const [hr, hg, hb] = tileRGB[hiIdx];
        const [cr, cg, cb] = GlobeView.darken(hr, hg, hb, CLIFF_DARKEN);

        const hiB = hiTile.b;
        const loB = loTile.b;
        const hiSides = hiTile.s;
        const loSides = loTile.s;

        const loSet = new Set<string>();
        for (let k = 0; k < loSides; k++) loSet.add(snap(loB[k]));

        for (let k = 0; k < hiSides; k++) {
          const vA = hiB[k];
          const vB = hiB[(k + 1) % hiSides];
          if (!loSet.has(snap(vA)) || !loSet.has(snap(vB))) continue;

          const hiAx = vA[0] * hiScale, hiAy = vA[1] * hiScale, hiAz = vA[2] * hiScale;
          const hiBx = vB[0] * hiScale, hiBy = vB[1] * hiScale, hiBz = vB[2] * hiScale;
          const loAx = vA[0] * loScale, loAy = vA[1] * loScale, loAz = vA[2] * loScale;
          const loBx = vB[0] * loScale, loBy = vB[1] * loScale, loBz = vB[2] * loScale;

          // Triangle 1: hiA, loB, hiB
          let base = cTriIdx * 9;
          cPositions[base]     = hiAx; cPositions[base + 1] = hiAy; cPositions[base + 2] = hiAz;
          cPositions[base + 3] = loBx; cPositions[base + 4] = loBy; cPositions[base + 5] = loBz;
          cPositions[base + 6] = hiBx; cPositions[base + 7] = hiBy; cPositions[base + 8] = hiBz;
          cColors[base]     = cr; cColors[base + 1] = cg; cColors[base + 2] = cb;
          cColors[base + 3] = cr; cColors[base + 4] = cg; cColors[base + 5] = cb;
          cColors[base + 6] = cr; cColors[base + 7] = cg; cColors[base + 8] = cb;
          cTriIdx++;

          // Triangle 2: hiA, loA, loB
          base = cTriIdx * 9;
          cPositions[base]     = hiAx; cPositions[base + 1] = hiAy; cPositions[base + 2] = hiAz;
          cPositions[base + 3] = loAx; cPositions[base + 4] = loAy; cPositions[base + 5] = loAz;
          cPositions[base + 6] = loBx; cPositions[base + 7] = loBy; cPositions[base + 8] = loBz;
          cColors[base]     = cr; cColors[base + 1] = cg; cColors[base + 2] = cb;
          cColors[base + 3] = cr; cColors[base + 4] = cg; cColors[base + 5] = cb;
          cColors[base + 6] = cr; cColors[base + 7] = cg; cColors[base + 8] = cb;
          cTriIdx++;

          break;
        }
      }
    }

    // ── Tile top mesh (Basic — flat colour, consistent with cliff shading) ────
    const tileGeometry = new THREE.BufferGeometry();
    tileGeometry.setAttribute('position', new THREE.BufferAttribute(tPositions, 3));
    tileGeometry.setAttribute('color',    new THREE.BufferAttribute(tColors, 3));
    const tileMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(tileGeometry, tileMaterial);

    // ── Cliff wall mesh (Basic — flat colour, immune to lighting) ────────────
    const cliffGeometry = new THREE.BufferGeometry();
    cliffGeometry.setAttribute('position', new THREE.BufferAttribute(cPositions.slice(0, cTriIdx * 9), 3));
    cliffGeometry.setAttribute('color',    new THREE.BufferAttribute(cColors.slice(0, cTriIdx * 9), 3));
    const cliffMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const cliffMesh = new THREE.Mesh(cliffGeometry, cliffMaterial);

    // ── Edge lines ────────────────────────────────────────────────────────────
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute('position', new THREE.BufferAttribute(edgePositions.slice(0, edgeIdx * 3), 3));
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, opacity: 0.02, transparent: true });
    const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);

    return { mesh, cliffMesh, edgeLines, faceToTile };
  }

  private buildCityMarkers(): THREE.Points {
    const count = this.world.cities.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const city = this.world.cities[i];
      const tile = this.world.tiles[city.tileIndex];
      // Above the sphere
      const push = 1.03;
      positions[i * 3] = tile.pos[0] * push;
      positions[i * 3 + 1] = tile.pos[1] * push;
      positions[i * 3 + 2] = tile.pos[2] * push;

      const [r, g, b] = factionColorRGB(this.world, city.id);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.04,
      vertexColors: true,
      sizeAttenuation: true,
    });

    return new THREE.Points(geometry, material);
  }

  private onClick(event: MouseEvent) {
    // Suppress click if the user dragged (orbit) before releasing
    if (this.mouseDownPos) {
      const dx = event.clientX - this.mouseDownPos.x;
      const dy = event.clientY - this.mouseDownPos.y;
      if (dx * dx + dy * dy > 9) { // > 3px movement = drag, not click
        this.mouseDownPos = null;
        return;
      }
    }
    this.mouseDownPos = null;

    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.tileMesh);

    if (intersects.length > 0) {
      const faceIndex = intersects[0].faceIndex;
      if (faceIndex !== undefined && faceIndex !== null) {
        const tileIndex = this.tileIdByFace[faceIndex];
        dbg.globe.log('Click hit: faceIndex=', faceIndex, '→ tileIndex=', tileIndex);
        this.onTileSelect(tileIndex);
      }
    } else {
      dbg.globe.log('Click missed globe (no intersection)');
    }
  }

  private onResize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height);
  }

  /** Pan the camera so the given tile faces the viewer (smooth slerp). */
  panToTile(tileIndex: number) {
    const tile = this.world.tiles[tileIndex];
    if (!tile) {
      dbg.globe.warn('panToTile: invalid tileIndex', tileIndex);
      return;
    }

    dbg.globe.log('panToTile:', tileIndex);
    const [x, y, z] = tile.pos;
    const len = Math.sqrt(x * x + y * y + z * z);
    const dist = this.camera.position.length();

    const target = new THREE.Vector3(x / len * dist, y / len * dist, z / len * dist);

    // If already very close, snap immediately
    const current = this.camera.position.clone();
    if (current.distanceTo(target) < 0.01) {
      this.lastViewCentreTile = tileIndex;
      return;
    }

    this.panStart = current;
    this.panTarget = target;
    this.panProgress = 0;
    this.isProgrammaticPan = true;
    this.lastViewCentreTile = tileIndex;
  }

  /** Register a callback for when the globe's view centre tile changes (orbit/rotate). */
  setOnViewCentreChange(cb: (tileIndex: number) => void) {
    this.onViewCentreChange = cb;
  }

  /** Raycast from screen centre to find which tile the camera is looking at, then emit. */
  private emitViewCentre() {
    if (!this.onViewCentreChange) return;
    if (this.isProgrammaticPan) return;

    // Cast a ray from the centre of the viewport toward the sphere
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersects = this.raycaster.intersectObject(this.tileMesh);

    if (intersects.length > 0) {
      const faceIndex = intersects[0].faceIndex;
      if (faceIndex !== undefined && faceIndex !== null) {
        const tileIndex = this.tileIdByFace[faceIndex];
        if (tileIndex !== this.lastViewCentreTile) {
          this.lastViewCentreTile = tileIndex;
          this.onViewCentreChange(tileIndex);
        }
      }
    }
  }

  private animate() {
    requestAnimationFrame(() => this.animate());

    // Smooth slerp pan when following the local map
    if (this.panTarget && this.panStart && this.panProgress < 1) {
      this.panProgress = Math.min(1, this.panProgress + 0.15);
      // Slerp on unit sphere, then scale to correct distance
      const dist = this.panStart.length();
      const startDir = this.panStart.clone().normalize();
      const endDir = this.panTarget.clone().normalize();
      const pos = startDir.clone().lerp(endDir, this.panProgress).normalize().multiplyScalar(dist);
      this.camera.position.copy(pos);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      if (this.panProgress >= 1) {
        this.panTarget = null;
        this.panStart = null;
        this.isProgrammaticPan = false;
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
