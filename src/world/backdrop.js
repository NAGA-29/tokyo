// The land around an area: coarse terrain (backdrop.bin, a height grid some tens of kilometres wide) under a
// coarse aerial photo. It is what stands on the horizon — Mt Fuji behind Fujinomiya — and has no buildings.
import * as THREE from 'three';

const MAX = 4096;          // photo texture pixels along a side
const SINK = 40;           // metres the backdrop is sunk under the area itself, so the detailed ground covers it

const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// base: the area's tile directory; photoBase: its backdrop photo tiles; proj: makeProjection() of the area.
export async function loadBackdrop(base, photoBase, manifest, proj, renderer) {
  const { file, x0, z0, step, w, h } = manifest.backdrop, b = manifest.bounds;
  const heights = new Float32Array(await (await fetch(`${base}/${file}`)).arrayBuffer());
  const sizeX = (w - 1) * step, sizeZ = (h - 1) * step;

  // ---- the terrain: every grid cell, except those under the area itself; around it the backdrop dips away
  const pos = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2);
  const inside = (x, z, m) => x > b.minX - m && x < b.maxX + m && z > b.minZ - m && z < b.maxZ + m;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, x = x0 + i * step, z = z0 + j * step;
    pos.set([x, heights[k] - (inside(x, z, 0) ? SINK : 0), z], k * 3);
    uv.set([i / (w - 1), 1 - j / (h - 1)], k * 2);
  }
  const index = [];
  for (let j = 0; j + 1 < h; j++) for (let i = 0; i + 1 < w; i++) {
    const x = x0 + i * step, z = z0 + j * step;
    if (inside(x, z, -step) && inside(x + step, z + step, -step)) continue; // (well inside the area: nothing to draw)
    const a = j * w + i, c = a + w;
    index.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();

  // ---- the photo: the tiles laid out in the area's own metres
  const canvas = document.createElement('canvas'), k = MAX / Math.max(sizeX, sizeZ);
  canvas.width = Math.round(sizeX * k); canvas.height = Math.round(sizeZ * k);
  const g = canvas.getContext('2d');
  g.fillStyle = '#2c4a5e'; g.fillRect(0, 0, canvas.width, canvas.height); // (no photo: the sea)
  const tiles = await fetch(`${photoBase}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const jobs = [];
  if (tiles) for (let x = tiles.x0; x <= tiles.x1; x++) for (let y = tiles.y0; y <= tiles.y1; y++) {
    jobs.push(fetch(`${photoBase}/${tiles.z}_${x}_${y}.jpg`).then((r) => (r.ok ? r.blob() : null)).then((blob) => blob && createImageBitmap(blob)).then((img) => {
      if (!img) return;
      const [ax, az] = proj.project(tileLon(x, tiles.z), tileLat(y, tiles.z)), [bx, bz] = proj.project(tileLon(x + 1, tiles.z), tileLat(y + 1, tiles.z));
      g.drawImage(img, (ax - x0) * k, (az - z0) * k, (bx - ax) * k + 0.5, (bz - az) * k + 0.5);
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 }));
  mesh.name = 'backdrop';
  mesh.frustumCulled = false;
  return mesh;
}
