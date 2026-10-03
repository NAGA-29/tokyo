// Height profile of the road graph: on the ground, except bridges and the elevated expressway, which
// are lifted to a clearance by OSM layer. Their approaches are raised into ramps where the graph allows:
// a node also used by an ordinary street stays on the ground, so ramps always land.

const CLEARANCE = [0, 7, 11, 15.5, 20]; // road level above the ground under a bridge, by layer
const MAX_GRADE = 0.06;

const elevatable = (e) => !e.tunnel && (e.bridge || e.highway.startsWith('motorway'));

// edges: graph edges ({ ids, bridge, tunnel, layer, highway }); pos: node id -> [x, z]; ground(x, z).
// Returns a Map: node id -> road level.
export function profileRoads(edges, pos, ground) {
  const y = new Map(), pinned = new Set();
  const g = (id) => { const p = pos(id); return ground(p[0], p[1]); };
  for (const e of edges) {
    const lift = e.bridge && !e.tunnel ? CLEARANCE[Math.max(1, Math.min(4, e.layer))] : 0;
    for (const id of e.ids) {
      y.set(id, Math.max(y.get(id) ?? -Infinity, g(id) + lift));
      if (!elevatable(e) && !e.tunnel) pinned.add(id);
    }
  }
  for (const id of pinned) y.set(id, g(id));
  const segments = [];
  for (const e of edges) {
    if (!elevatable(e)) continue;
    for (let i = 1; i < e.ids.length; i++) {
      const a = pos(e.ids[i - 1]), b = pos(e.ids[i]), d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > 0.01) segments.push([e.ids[i - 1], e.ids[i], d]);
    }
  }
  // raise the lower end of any stretch that is too steep (never a pinned node), until nothing changes
  for (let pass = 0, changed = true; changed && pass < 300; pass++) {
    changed = false;
    for (const [a, b, d] of segments) {
      const ya = y.get(a), yb = y.get(b), max = MAX_GRADE * d;
      if (ya < yb - max - 1e-3 && !pinned.has(a)) { y.set(a, yb - max); changed = true; }
      else if (yb < ya - max - 1e-3 && !pinned.has(b)) { y.set(b, ya - max); changed = true; }
    }
  }
  return y;
}
