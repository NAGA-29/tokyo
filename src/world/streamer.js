// Keeps the tiles within `radius` of a focus point loaded, nearest first, and drops the ones
// that fall beyond radius + hysteresis. Meshing happens in a small pool of workers.
import * as THREE from 'three';
import { tileKey } from '../shared/geo.js';
import { sampleGrid } from '../shared/terrain.js';
import { makeSurface } from '../shared/decks.js';

const WORKERS = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1));
const MAX_IN_FLIGHT = WORKERS * 2;

function geometry(arrays, attrs) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of attrs) if (arrays[name]?.length) g.setAttribute(name, new THREE.BufferAttribute(arrays[name], size));
  if (arrays.index) g.setIndex(new THREE.BufferAttribute(arrays.index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export class Streamer {
  constructor(scene, materials, props, { base, radius = 1100, hysteresis = 250 } = {}) {
    this.scene = scene;
    this.materials = materials;
    this.props = props;
    this.base = base;
    this.radius = radius;
    this.hysteresis = hysteresis;
    this.tiles = new Map(); // key -> { state, group, info, ends, tris }
    this.inFlight = 0;
    this.stats = { loaded: 0, buildings: 0, triangles: 0 };
  }

  async init() {
    this.manifest = await (await fetch(`${this.base}/manifest.json`)).json();
    const t = this.manifest.terrain;
    const data = new Float32Array(await (await fetch(`${this.base}/${t.file}`)).arrayBuffer());
    this.grid = { x0: t.x0, z0: t.z0, step: t.step, w: t.w, h: t.h, data };
    const decks = this.manifest.decks ?? [];
    this.surface = makeSurface(this.grid, decks);
    this.available = new Map(this.manifest.tiles.map((tl) => [tileKey(tl.x, tl.z), tl]));
    this.workers = Array.from({ length: WORKERS }, () => {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', decks, grid: { ...this.grid, data: data.slice().buffer } });
      w.onmessage = (e) => this.onResult(e.data);
      return w;
    });
    this.nextWorker = 0;
    return this.manifest;
  }

  // Terrain height, and the height of whatever one stands on (the terrain, or a bridge deck).
  ground(x, z) { return sampleGrid(this.grid, x, z); }

  // focus: the point tiles are streamed around; eye: the camera position, for level of detail.
  update(focus, eye = focus) {
    const size = this.manifest.tileSize;
    for (const [key, t] of this.tiles) {
      if (t.state !== 'ready' || !t.trees) continue;
      // Distance from the eye to the nearest point of the tile, so trees next to the camera are never the
      // simple ones; a margin on the way out stops a tile flickering at the threshold.
      const tl = this.available.get(key), x0 = tl.x * size, z0 = tl.z * size;
      const dx = Math.max(x0 - eye.x, 0, eye.x - (x0 + size)), dz = Math.max(z0 - eye.z, 0, eye.z - (z0 + size));
      const dy = Math.max(0, eye.y - this.ground(x0 + size / 2, z0 + size / 2) - 25);
      // a tile full of trees (a wood) keeps its detailed ones closer: thousands of them are too much to draw
      const d = Math.hypot(dx, dy, dz), limit = this.props.constructor.lodDistance * (t.trees.count > 120 ? 0.5 : 1);
      const near = t.trees.near.visible ? d < limit * 1.25 : d < limit;
      t.trees.near.visible = near; t.trees.far.visible = !near;
    }
    const dist = (tl) => Math.hypot((tl.x + 0.5) * size - focus.x, (tl.z + 0.5) * size - focus.z);
    // unload
    for (const [key, t] of this.tiles) {
      if (t.state === 'ready' && dist(this.available.get(key)) > this.radius + this.hysteresis) this.unload(key);
    }
    // load, nearest first
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    const wanted = [];
    for (const [key, tl] of this.available) {
      if (this.tiles.has(key)) continue;
      const d = dist(tl);
      if (d <= this.radius) wanted.push([d, key, tl]);
    }
    wanted.sort((a, b) => a[0] - b[0]);
    for (const [, key, tl] of wanted) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      this.tiles.set(key, { state: 'loading' });
      this.inFlight++;
      const w = this.workers[this.nextWorker++ % this.workers.length];
      w.postMessage({ type: 'tile', key, url: new URL(`${this.base}/${tl.file}`, location.href).href, tileSize: size });
    }
  }

  onResult(msg) {
    this.inFlight--;
    const t = this.tiles.get(msg.key);
    if (msg.type === 'error') { console.warn(`tile ${msg.key}: ${msg.message}`); this.tiles.delete(msg.key); return; }
    if (!t) return; // unloaded while in flight
    const { terrain, roads, paint, buildings, info, props, wires } = msg.mesh;
    const group = new THREE.Group();
    group.name = `tile ${msg.key}`;

    const ground = new THREE.Mesh(geometry(terrain, [['position', 3], ['normal', 3]]), this.materials.terrain);
    ground.receiveShadow = true;
    group.add(ground);

    if (roads.position.length) {
      const m = new THREE.Mesh(geometry(roads, [['position', 3], ['normal', 3], ['color', 3], ['aLayer', 1]]), this.materials.road);
      m.receiveShadow = true;
      group.add(m);
    }
    if (paint.position.length) {
      const m = new THREE.Mesh(geometry(paint, [['position', 3], ['normal', 3], ['color', 3], ['aLayer', 1]]), this.materials.paint);
      m.receiveShadow = true;
      group.add(m);
    }
    let trees = null;
    if (props.length || wires.length) {
      trees = this.props.build(props, wires, this.surface);
      trees.near.visible = false; // update() picks the level of detail on the next frame
      group.add(trees.group);
    }
    if (buildings.position.length) {
      const m = new THREE.Mesh(
        geometry(buildings, [['position', 3], ['normal', 3], ['color', 3], ['aFacade', 4], ['aBldg', 4]]),
        this.materials.facade,
      );
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData = { tile: msg.key, info, ends: buildings.ends };
      group.add(m);
    }
    const tris = terrain.index.length / 3 + roads.position.length / 9 + buildings.triangles;
    Object.assign(t, { state: 'ready', group, trees, buildings: info.length, tris });
    this.scene.add(group);
    this.stats.loaded++; this.stats.buildings += info.length; this.stats.triangles += tris;
  }

  unload(key) {
    const t = this.tiles.get(key);
    this.scene.remove(t.group);
    // prop models are shared between tiles; only per-tile geometry is freed
    t.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); else if (!o.isGroup) o.geometry?.dispose(); });
    this.tiles.delete(key);
    this.stats.loaded--; this.stats.buildings -= t.buildings; this.stats.triangles -= t.tris;
  }

  // Building under a raycast hit on a facade mesh: { usage, storeys, height, base }.
  buildingAt(hit) {
    const { info, ends } = hit.object.userData ?? {};
    if (!info || !hit.face) return null;
    const v = hit.face.a;
    let lo = 0, hi = ends.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] > v) hi = mid; else lo = mid + 1; }
    const [usage, storeys, height, base] = info[lo];
    return { usage, storeys, height, base };
  }

  get pending() { return this.inFlight; }
}
