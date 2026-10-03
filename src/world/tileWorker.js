// Fetches, decodes and meshes tiles off the main thread.
import { decodeTile } from '../shared/tileformat.js';
import { buildTile } from './meshing.js';
import { makeSurface } from '../shared/decks.js';

let grid = null, surface = null;

// All typed arrays in a result, so they are transferred rather than copied.
function buffers(o, out = []) {
  for (const v of Object.values(o)) {
    if (ArrayBuffer.isView(v)) out.push(v.buffer);
    else if (v && typeof v === 'object') buffers(v, out);
  }
  return out;
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'init') {
    grid = { ...m.grid, data: new Float32Array(m.grid.data) };
    surface = makeSurface(grid, m.decks);
    return;
  }
  if (m.type === 'tile') {
    try {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tile = decodeTile(await res.arrayBuffer());
      const mesh = buildTile(tile, grid, m.tileSize, surface);
      self.postMessage({ type: 'tile', key: m.key, mesh }, buffers(mesh));
    } catch (e) {
      self.postMessage({ type: 'error', key: m.key, message: e.message });
    }
  }
};
