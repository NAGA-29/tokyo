// Height profile of the road graph: on the ground, except bridges and the elevated expressway, which
// are lifted to a clearance by OSM layer. Their approaches are raised into ramps where the graph allows:
// a node also used by an ordinary street stays on the ground, so ramps always land.

const CLEARANCE = [0, 7, 11, 15.5, 20]; // road level above the ground under a bridge, by layer
const MAX_GRADE = 0.06;

const elevatable = (e) => !e.tunnel && (e.bridge || e.highway.startsWith('motorway'));

// edges: graph edges ({ ids, bridge, tunnel, layer, highway }); pos: node id -> [x, z]; ground(x, z).
// A street bridge whose ends stand this much above the lowest ground beneath it crosses a cutting or a
// river: it runs level from bank to bank instead of climbing over the dip.
const SPAN_DIP = 2.5;

// Returns { level: Map node id -> road level, spans: Set of edges that are bank-to-bank bridges }.
export function profileRoads(edges, pos, ground) {
  const y = new Map(), pinned = new Set(), spans = new Set();
  const g = (id) => { const p = pos(id); return ground(p[0], p[1]); };
  for (const e of edges) {
    if (!e.bridge || e.tunnel || e.highway.startsWith('motorway')) continue;
    const pts = e.ids.map(pos), ends = [g(e.ids[0]), g(e.ids.at(-1))];
    let low = Infinity, total = 0;
    for (let i = 1; i < pts.length; i++) {
      const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      for (let s = 0; s <= len; s += 3) low = Math.min(low, ground(pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * s) / (len || 1), pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * s) / (len || 1)));
      total += len;
    }
    if (Math.min(...ends) - low > SPAN_DIP) { e.spanLength = total; spans.add(e); }
  }
  for (const e of edges) {
    if (spans.has(e)) continue;
    const lift = e.bridge && !e.tunnel ? CLEARANCE[Math.max(1, Math.min(4, e.layer))] : 0;
    for (const id of e.ids) {
      y.set(id, Math.max(y.get(id) ?? -Infinity, g(id) + lift));
      if (!elevatable(e) && !e.tunnel) pinned.add(id);
    }
  }
  for (const id of pinned) y.set(id, g(id));
  // bank-to-bank bridges: both ends at their ground level (or whatever joins there), a straight line between
  for (const e of spans) {
    const a = y.get(e.ids[0]) ?? g(e.ids[0]), b = y.get(e.ids.at(-1)) ?? g(e.ids.at(-1));
    y.set(e.ids[0], a); y.set(e.ids.at(-1), b);
    let walked = 0;
    for (let i = 1; i < e.ids.length - 1; i++) {
      const p = pos(e.ids[i - 1]), q = pos(e.ids[i]);
      walked += Math.hypot(q[0] - p[0], q[1] - p[1]);
      y.set(e.ids[i], a + ((b - a) * walked) / e.spanLength);
    }
    for (const id of e.ids) pinned.add(id);
  }
  const segments = [];
  for (const e of edges) {
    if (!elevatable(e) || spans.has(e)) continue;
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
  return { level: y, spans };
}
