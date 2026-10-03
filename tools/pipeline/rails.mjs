// Height profile of the railway lines. The terrain model already contains embankments and cuttings,
// so a track normally sits on the ground; bridges are lifted to clear what they cross, and the
// neighbouring track is raised into a ramp so no stretch is steeper than a railway can climb.

const CLEARANCE = { 1: 6.2, 2: 12 };  // rail level above the ground under a bridge, by OSM layer
const MAX_GRADE = 0.03;               // 3 %
const BED = 0.45;                     // ballast and rail above the formation
const NEIGHBOUR = 22;                 // metres: tracks this close run at the same level
const DENSIFY = 6;                    // metres between height samples along a line
const MOUTH = 30;                     // metres before a tunnel mouth where the terrain is not the track bed

// lines: [{ ids: [node id], pts: [[x, z]], bridge, layer, ... }]; ground(x, z) -> terrain height.
// Returns the lines with pts as flat [x, y, z, ...], y = top of rail bed.
// unreliable(x, z): true where the terrain height is not the track bed (under a road bridge).
export function profileRailways(lines, ground, inBounds, unreliable = () => false) {
  // keep the stretch inside the area, plus one point beyond each end
  const kept = [];
  for (const l of lines) {
    let run = null;
    l.pts.forEach((p, i) => {
      if (inBounds(p[0], p[1])) {
        if (!run) { run = { ...l, ids: [], pts: [], tunnelStart: l.tunnelStart && i === 0, tunnelEnd: false }; if (i > 0) { run.ids.push(l.ids[i - 1]); run.pts.push(l.pts[i - 1]); } kept.push(run); }
        run.ids.push(l.ids[i]); run.pts.push(p);
        run.tunnelEnd = l.tunnelEnd && i === l.pts.length - 1;
      } else if (run) { run.ids.push(l.ids[i]); run.pts.push(p); run = null; }
    });
  }

  // OSM nodes can be 50 m apart; a straight line between two of them cuts through any rise in the ground.
  // Add points every DENSIFY metres (ids "way:segment:step"), each with its own ground height.
  for (const l of kept) {
    const ids = [l.ids[0]], pts = [l.pts[0]];
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1], b = l.pts[i], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / DENSIFY);
      for (let k = 1; k < n; k++) { ids.push(`${l.way}:${l.ids[i - 1]}:${k}`); pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]); }
      ids.push(l.ids[i]); pts.push(b);
    }
    l.ids = ids; l.pts = pts;
  }

  // one height per node, shared by the lines that meet there
  const y = new Map();
  for (const l of kept) {
    const lift = l.bridge ? CLEARANCE[Math.max(1, Math.min(2, l.layer))] : 0;
    // Ground under each point — except under a road bridge and near a tunnel mouth, where the terrain
    // model shows what is above the track. There the level is carried across from the open track either side.
    const n = l.pts.length, g = l.pts.map(([x, z]) => (unreliable(x, z) ? null : ground(x, z)));
    const along = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]));
    for (let i = 0; i < n; i++) {
      if ((l.tunnelStart && along[i] < MOUTH) || (l.tunnelEnd && along[n - 1] - along[i] < MOUTH)) g[i] = null;
    }
    for (let i = 0; i < n; i++) {
      if (g[i] != null) continue;
      let a = i - 1, b = i + 1;
      while (a >= 0 && g[a] == null) a--;
      while (b < n && g[b] == null) b++;
      const fill = a >= 0 && b < n ? g[a] + ((g[b] - g[a]) * (along[i] - along[a])) / (along[b] - along[a] || 1)
        : a >= 0 ? g[a] : b < n ? g[b] : ground(l.pts[i][0], l.pts[i][1]);
      l.ids.forEach((id, k) => { if (k === i) y.set(id, Math.max(y.get(id) ?? -Infinity, fill + lift + BED)); });
    }
    l.ids.forEach((id, i) => { if (g[i] != null) y.set(id, Math.max(y.get(id) ?? -Infinity, g[i] + lift + BED)); });
  }
  const segments = [];
  for (const l of kept) for (let i = 1; i < l.ids.length; i++) {
    const d = Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]);
    if (d > 0.01) segments.push([l.ids[i - 1], l.ids[i], d]);
  }
  // Raise the lower end of any stretch that is too steep, until nothing changes. Only ever raising keeps
  // every bridge at its clearance.
  const limitGrade = () => {
    for (let pass = 0, changed = true; changed && pass < 200; pass++) {
      changed = false;
      for (const [a, b, d] of segments) {
        const ya = y.get(a), yb = y.get(b), max = MAX_GRADE * d;
        if (ya < yb - max - 1e-3) { y.set(a, yb - max); changed = true; }
        else if (yb < ya - max - 1e-3) { y.set(b, ya - max); changed = true; }
      }
    }
  };
  // Tracks running side by side share one formation: every node takes the highest level found within
  // NEIGHBOUR metres among nodes of the same kind (same bridge flag and layer), so parallel tracks do not
  // end up on separate decks at slightly different heights. A line crossing overhead is another kind and
  // is left alone: the Ginza Line bridge must not pull the JR tracks below it up to its level.
  const where = new Map(), cells = new Map(), kind = new Map();
  for (const l of kept) l.ids.forEach((id, i) => { where.set(id, l.pts[i]); kind.set(id, l.bridge * 16 + l.layer); });
  for (const [id, [x, z]] of where) {
    const k = Math.floor(x / NEIGHBOUR) + ',' + Math.floor(z / NEIGHBOUR);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(id);
  }
  const levelNeighbours = () => {
    const next = new Map();
    for (const [id, [x, z]] of where) {
      let top = y.get(id);
      const ci = Math.floor(x / NEIGHBOUR), cj = Math.floor(z / NEIGHBOUR);
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
        for (const o of cells.get(i + ',' + j) ?? []) {
          const p = where.get(o);
          if (kind.get(o) === kind.get(id) && Math.hypot(p[0] - x, p[1] - z) <= NEIGHBOUR) top = Math.max(top, y.get(o));
        }
      next.set(id, top);
    }
    for (const [id, v] of next) y.set(id, v);
  };
  limitGrade(); levelNeighbours(); limitGrade();
  const r2 = (v) => Math.round(v * 100) / 100;
  // Tunnel mouths where a line goes underground: [x, y, z, dirX, dirZ, 1], the direction pointing into the tunnel.
  const mouth = (l, i, j) => {
    const p = l.pts[i], q = l.pts[j], len = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
    return [r2(p[0]), r2(y.get(l.ids[i])), r2(p[1]), r2((p[0] - q[0]) / len), r2((p[1] - q[1]) / len), 1];
  };
  return kept.filter((l) => l.pts.length >= 2).map(({ ids, pts, tunnelStart, tunnelEnd, ...l }) => ({
    ...l, pts: pts.flatMap(([x, z], i) => [r2(x), r2(y.get(ids[i])), r2(z)]),
    portals: [...(tunnelStart ? [mouth({ ids, pts }, 0, 1)] : []), ...(tunnelEnd ? [mouth({ ids, pts }, pts.length - 1, pts.length - 2)] : [])],
  }));
}
