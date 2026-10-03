// Bridge decks at street level (a road crossing a railway cutting or a river). Under them the terrain
// dips, but road surfaces, paint, kerbs and street objects must follow the deck. `makeSurface` returns
// the height everything on the road should use: the terrain, or the deck where one passes.
import { sampleGrid } from './terrain.js';

const CELL = 32;

// decks: [{ pts: [x, y, z, ...], half }] — a polyline at deck level and its half width in metres.
export function makeSurface(grid, decks) {
  const cells = new Map(); // "i,j" -> [[ax, ay, az, bx, by, bz, half]]
  for (const d of decks) {
    for (let i = 3; i < d.pts.length; i += 3) {
      const seg = [d.pts[i - 3], d.pts[i - 2], d.pts[i - 1], d.pts[i], d.pts[i + 1], d.pts[i + 2], d.half];
      const x0 = Math.min(seg[0], seg[3]) - d.half, x1 = Math.max(seg[0], seg[3]) + d.half;
      const z0 = Math.min(seg[2], seg[5]) - d.half, z1 = Math.max(seg[2], seg[5]) + d.half;
      for (let ci = Math.floor(x0 / CELL); ci <= Math.floor(x1 / CELL); ci++)
        for (let cj = Math.floor(z0 / CELL); cj <= Math.floor(z1 / CELL); cj++) {
          const k = ci + ',' + cj;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(seg);
        }
    }
  }
  return (x, z) => {
    let y = sampleGrid(grid, x, z);
    const segs = cells.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (segs) for (const [ax, ay, az, bx, by, bz, half] of segs) {
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) <= half) y = Math.max(y, ay + (by - ay) * t);
    }
    return y;
  };
}
