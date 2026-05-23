/**
 * Globe View — renders the full Goldberg sphere using Three.js.
 * Each tile is drawn as a proper hex/pentagon polygon face with edges.
 * Seamless tessellation with no gaps.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WorldData, TileData } from './worldData.js';
import { terrainColorRGB, factionColorRGB } from './colors.js';
import { dbg } from './debug.js';

export class GlobeView {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private raycaster: THREE.Raycaster;
  private mouse: THREE.Vector2;
  private tileMesh: THREE.Mesh;
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
    const { mesh, edgeLines, faceToTile } = this.buildTileMesh();
    dbg.globe.timeEnd('buildTileMesh');
    this.tileMesh = mesh;
    this.edgeMesh = edgeLines;
    this.tileIdByFace = faceToTile;
    this.scene.add(this.tileMesh);
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

  private buildTileMesh() {
    const tiles = this.world.tiles;
    const tileCount = tiles.length;

    // Count total triangles needed: each N-sided tile = N-2 triangles (fan)
    let totalTriangles = 0;
    for (const tile of tiles) {
      totalTriangles += tile.s - 2;
    }

    const positions = new Float32Array(totalTriangles * 3 * 3);
    const colors = new Float32Array(totalTriangles * 3 * 3);
    const normals = new Float32Array(totalTriangles * 3 * 3);
    const faceToTile = new Uint16Array(totalTriangles);

    // Edge lines: each tile has `sides` edges, but each edge is shared by 2 tiles
    // We'll just draw all edges per tile (duplicates get hidden by z-buffer)
    let totalEdgeVerts = 0;
    for (const tile of tiles) {
      totalEdgeVerts += tile.s * 2; // 2 verts per edge segment
    }
    const edgePositions = new Float32Array(totalEdgeVerts * 3);

    let triIdx = 0;
    let edgeIdx = 0;

    for (let ti = 0; ti < tileCount; ti++) {
      const tile = tiles[ti];
      const boundary = tile.b;
      const sides = tile.s;

      // Color for this tile — use faction color for city tiles, terrain color otherwise
      const [r, g, b] = tile.city
        ? factionColorRGB(this.world, tile.city)
        : terrainColorRGB(tile.terrain);

      // Normal = tile centre (on unit sphere, points outward)
      const nx = tile.pos[0];
      const ny = tile.pos[1];
      const nz = tile.pos[2];

      // Fan triangulation from first boundary vertex
      for (let i = 1; i < sides - 1; i++) {
        const v0 = boundary[0];
        const v1 = boundary[i];
        const v2 = boundary[i + 1];

        const base = triIdx * 9;
        positions[base] = v0[0];
        positions[base + 1] = v0[1];
        positions[base + 2] = v0[2];
        positions[base + 3] = v1[0];
        positions[base + 4] = v1[1];
        positions[base + 5] = v1[2];
        positions[base + 6] = v2[0];
        positions[base + 7] = v2[1];
        positions[base + 8] = v2[2];

        // Same color for all 3 vertices
        colors[base] = r;     colors[base + 1] = g; colors[base + 2] = b;
        colors[base + 3] = r; colors[base + 4] = g; colors[base + 5] = b;
        colors[base + 6] = r; colors[base + 7] = g; colors[base + 8] = b;

        // Normal
        normals[base] = nx;     normals[base + 1] = ny; normals[base + 2] = nz;
        normals[base + 3] = nx; normals[base + 4] = ny; normals[base + 5] = nz;
        normals[base + 6] = nx; normals[base + 7] = ny; normals[base + 8] = nz;

        faceToTile[triIdx] = ti;
        triIdx++;
      }

      // Edge lines
      for (let i = 0; i < sides; i++) {
        const v0 = boundary[i];
        const v1 = boundary[(i + 1) % sides];
        // Push slightly outward so edges render above faces
        const push = 1.001;

        const eBase = edgeIdx * 3;
        edgePositions[eBase] = v0[0] * push;
        edgePositions[eBase + 1] = v0[1] * push;
        edgePositions[eBase + 2] = v0[2] * push;
        edgePositions[eBase + 3] = v1[0] * push;
        edgePositions[eBase + 4] = v1[1] * push;
        edgePositions[eBase + 5] = v1[2] * push;
        edgeIdx += 2;
      }
    }

    // Tile faces
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });

    const mesh = new THREE.Mesh(geometry, material);

    // Edge lines
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(edgePositions.slice(0, edgeIdx * 3), 3)
    );
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x000000,
      opacity: 0.02,
      transparent: true,
    });
    const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);

    return { mesh, edgeLines, faceToTile };
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
