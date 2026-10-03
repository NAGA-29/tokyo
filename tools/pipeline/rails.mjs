// Height profile of the railway lines. The terrain model already contains embankments and cuttings,
// so a track normally sits on the ground; bridges are lifted to clear what they cross, and the
// neighbouring track is raised into a ramp so no stretch is steeper than a railway can climb.

const CLEARANCE = { 1: 6.2, 2: 12 };  // rail level above the ground under a bridge, by OSM layer
const MAX_GRADE = 0.03;               // 3 %
const BED = 0.45;                     // ballast and rail above the formation

// lines: [{ ids: [node id], pts: [[x, z]], bridge, layer, ... }]; ground(x, z) -> terrain height.
// Returns the lines with pts as flat [x, y, z, ...], y = top of rail bed.
export function profileRailways(lines, ground, inBounds) {
  // keep the stretch inside the area, plus one point beyond each end
  const kept = [];
  for (const l of lines) {
    let run = null;
    l.pts.forEach((p, i) => {
      if (inBounds(p[0], p[1])) {
        if (!run) { run = { ...l, ids: [], pts: [] }; if (i > 0) { run.ids.push(l.ids[i - 1]); run.pts.push(l.pts[i - 1]); } kept.push(run); }
        run.ids.push(l.ids[i]); run.pts.push(p);
      } else if (run) { run.ids.push(l.ids[i]); run.pts.push(p); run = null; }
    });
  }

  // one height per OSM node, shared by the lines that meet there
  const y = new Map();
  for (const l of kept) {
    const lift = l.bridge ? CLEARANCE[Math.max(1, Math.min(2, l.layer))] : 0;
    l.ids.forEach((id, i) => y.set(id, Math.max(y.get(id) ?? -Infinity, ground(l.pts[i][0], l.pts[i][1]) + lift + BED)));
  }
  const segments = [];
  for (const l of kept) for (let i = 1; i < l.ids.length; i++) {
    const d = Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]);
    if (d > 0.01) segments.push([l.ids[i - 1], l.ids[i], d]);
  }
  // Raise the lower end of any stretch that is too steep, until nothing changes. Only ever raising keeps
  // every bridge at its clearance.
  for (let pass = 0, changed = true; changed && pass < 200; pass++) {
    changed = false;
    for (const [a, b, d] of segments) {
      const ya = y.get(a), yb = y.get(b), max = MAX_GRADE * d;
      if (ya < yb - max - 1e-3) { y.set(a, yb - max); changed = true; }
      else if (yb < ya - max - 1e-3) { y.set(b, ya - max); changed = true; }
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return kept.filter((l) => l.pts.length >= 2).map(({ ids, pts, ...l }) => ({
    ...l, pts: pts.flatMap(([x, z], i) => [r2(x), r2(y.get(ids[i])), r2(z)]),
  }));
}
