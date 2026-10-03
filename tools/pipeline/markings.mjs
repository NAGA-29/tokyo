// Road paint and traffic signals. Lane lines are laid out from the *measured* carriageway: at each
// sample the distance to the kerb on both sides (PLATEAU carriageway polygons) gives the true centre
// and width, so paint does not inherit the offset of the OSM centreline.
import { AREA, PROP } from '../../src/shared/tileformat.js';
import { hash, forEachAlong } from './landscape.mjs';

const STEP = 2.5;          // sample spacing along a road (m); dashes are 2 samples on, 2 off (5 m / 5 m)
const LINE = 0.15;         // paint width (m)
const MAJOR = new Set(['trunk', 'primary', 'secondary', 'tertiary']);

export function buildMarkings({ edges, pos, idx, land, inBounds }) {
  const marks = [], props = [];
  const quad = (kind, a, b, c, d) => marks.push({ kind, ring: [a, b, c, d] });
  const reach = (x, z, nx, nz, side, max = 18) => {
    for (let d = 0.5; d <= max; d += 0.25) if (!idx.carriageway.has(x + nx * d * side, z + nz * d * side)) return d;
    return null;
  };

  // junctions: graph nodes where three or more edge ends meet
  const degree = new Map(), at = new Map(); // node id -> count; node id -> [{ e, i }]
  for (const e of edges) {
    for (const id of [e.ids[0], e.ids.at(-1)]) degree.set(id, (degree.get(id) ?? 0) + 1);
    e.ids.forEach((id, i) => { if (!at.has(id)) at.set(id, []); at.get(id).push({ e, i }); });
  }
  const junctions = [...degree].filter(([, n]) => n >= 3).map(([id]) => pos(id));
  const nearestJunction = (x, z, max) => {
    let best = null, bd = max;
    for (const j of junctions) { const d = Math.hypot(j[0] - x, j[1] - z); if (d < bd) { bd = d; best = j; } }
    return best;
  };

  // ---- lane lines
  for (const e of edges) {
    const hw = e.highway.replace('_link', '');
    if (e.bridge || e.tunnel || hw === 'motorway' || e.highway.endsWith('_link')) continue;
    if (!MAJOR.has(hw) && e.lanes < 2) continue;
    const pts = e.ids.map(pos);
    const samples = [];
    forEachAlong(pts, STEP, (x, z, dx, dz, n) => {
      const nx = -dz, nz = dx; // right of travel
      let s = null;
      if (idx.carriageway.has(x, z)) {
        const R = reach(x, z, nx, nz, 1), L = reach(x, z, nx, nz, -1);
        if (R != null && L != null) s = { x: x + nx * (R - L) / 2, z: z + nz * (R - L) / 2, nx, nz, w: R + L, n };
      }
      samples.push(s);
    }, STEP / 2);
    const widths = samples.filter(Boolean).map((s) => s.w).sort((a, b) => a - b);
    if (widths.length < 4) continue;
    const median = widths[widths.length >> 1];
    // keep the regular stretch of road: junctions and bays show up as jumps in width
    const ok = samples.map((s) => s && s.w > median * 0.8 && s.w < median * 1.25);
    let lanes = Math.min(e.lanes, Math.floor(median / 2.6));
    if (lanes < 2 && !(MAJOR.has(hw) && median > 5)) continue;
    lanes = Math.max(lanes, 1);
    const lw = median / lanes;
    const lines = []; // { o: lateral offset, kind, dashed }
    if (!e.oneway && lanes >= 2) {
      const yellow = lanes === 2 && hash(e.way, 21) < 0.35;
      lines.push({ o: 0, kind: yellow ? AREA.MARK_YELLOW : AREA.MARK_WHITE, dashed: lanes === 2 && !yellow });
    }
    for (let k = 1; k < lanes; k++) {
      const o = -median / 2 + k * lw;
      if (!e.oneway && Math.abs(o) < 0.4) continue; // the centre line is already there
      lines.push({ o, kind: AREA.MARK_WHITE, dashed: true });
    }
    if (hw !== 'tertiary' && median > 6) for (const s of [-1, 1]) lines.push({ o: s * (median / 2 - 0.35), kind: AREA.MARK_WHITE, dashed: false });
    for (let i = 0; i + 1 < samples.length; i++) {
      if (!ok[i] || !ok[i + 1]) continue;
      const a = samples[i], b = samples[i + 1];
      for (const l of lines) {
        if (l.dashed && Math.floor(a.n / 2) % 2) continue;
        const p = (s, o) => [s.x + s.nx * o, s.z + s.nz * o];
        quad(l.kind, p(a, l.o - LINE / 2), p(b, l.o - LINE / 2), p(b, l.o + LINE / 2), p(a, l.o + LINE / 2));
      }
    }
  }

  // ---- zebra crossings (Japanese style: bars parallel to the traffic) and stop lines
  const zebraAt = [];
  const zebra = (path) => {
    const run = [];
    forEachAlong(path, 0.9, (x, z, dx, dz) => {
      if (!inBounds(x, z) || !idx.carriageway.has(x, z)) return;
      const rx = -dz, rz = dx; // road direction: across the crossing path
      quad(AREA.MARK_WHITE, [x - dx * 0.225 - rx * 1.8, z - dz * 0.225 - rz * 1.8], [x + dx * 0.225 - rx * 1.8, z + dz * 0.225 - rz * 1.8],
        [x + dx * 0.225 + rx * 1.8, z + dz * 0.225 + rz * 1.8], [x - dx * 0.225 + rx * 1.8, z - dz * 0.225 + rz * 1.8]);
      run.push([x, z, dx, dz]);
    }, 0.45);
    if (run.length < 5) return;
    const [ax, az] = run[0], [bx, bz, dx, dz] = run.at(-1);
    const cx = (ax + bx) / 2, cz = (az + bz) / 2, half = Math.hypot(bx - ax, bz - az) / 2 + 0.45;
    zebraAt.push([cx, cz]);
    // Stop lines: 2.5 m before the bars, across the left half of the road (left-hand traffic),
    // only on the side facing away from the junction.
    const rx = -dz, rz = dx, j = nearestJunction(cx, cz, 35);
    for (const s of [-1, 1]) {
      const px = cx + rx * 4.4 * s, pz = cz + rz * 4.4 * s;
      if (j && Math.hypot(px - j[0], pz - j[1]) < Math.hypot(cx - j[0], cz - j[1])) continue;
      // traffic here drives towards the crossing along -s * r; its left-hand side is -s * (dx, dz)
      const lx = -dx * s, lz = -dz * s;
      if (!idx.carriageway.has(px + lx * half * 0.5, pz + lz * half * 0.5)) continue;
      quad(AREA.MARK_WHITE, [px - rx * 0.225, pz - rz * 0.225], [px + rx * 0.225, pz + rz * 0.225],
        [px + rx * 0.225 + lx * (half - 0.3), pz + rz * 0.225 + lz * (half - 0.3)], [px - rx * 0.225 + lx * (half - 0.3), pz - rz * 0.225 + lz * (half - 0.3)]);
    }
  };
  for (const path of land.crossings) zebra(path);
  // crossings mapped only as a node on the road: build the path across the carriageway
  for (const c of land.crossingNodes) {
    const hit = at.get(c.id)?.[0];
    if (!hit || hit.e.bridge || hit.e.tunnel) continue;
    const [x, z] = pos(c.id);
    if (zebraAt.some(([zx, zz]) => Math.hypot(zx - x, zz - z) < 9) || !idx.carriageway.has(x, z)) continue;
    const ids = hit.e.ids, p = pos(ids[Math.max(0, hit.i - 1)]), q = pos(ids[Math.min(ids.length - 1, hit.i + 1)]);
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, nx = -(q[1] - p[1]) / len, nz = (q[0] - p[0]) / len;
    const R = reach(x, z, nx, nz, 1), L = reach(x, z, nx, nz, -1);
    if (R != null && L != null) zebra([[x - nx * (L + 0.5), z - nz * (L + 0.5)], [x + nx * (R + 0.5), z + nz * (R + 0.5)]]);
  }

  // ---- traffic signals: one mast per approach, at the left kerb a few metres before the junction
  const taken = new Set();
  for (const id of land.signals) {
    for (const { e, i } of at.get(id) ?? []) {
      if (e.tunnel || e.bridge || e.highway.startsWith('motorway')) continue;
      const here = pos(id);
      for (const [j, allowed] of [[i - 1, e.oneway !== -1], [i + 1, e.oneway !== 1]]) {
        if (!allowed || j < 0 || j >= e.ids.length) continue;
        const from = pos(e.ids[j]), len = Math.hypot(here[0] - from[0], here[1] - from[1]);
        if (len < 1) continue;
        const dx = (here[0] - from[0]) / len, dz = (here[1] - from[1]) / len, nx = -dz, nz = dx;
        const back = Math.min(8, len * 0.8), qx = here[0] - dx * back, qz = here[1] - dz * back;
        if (!idx.carriageway.has(qx, qz)) continue;
        const L = reach(qx, qz, nx, nz, -1);
        if (L == null) continue;
        const x = qx - nx * (L + 0.4), z = qz - nz * (L + 0.4), key = Math.floor(x / 6) + ',' + Math.floor(z / 6);
        if (!inBounds(x, z) || idx.building.has(x, z) || taken.has(key)) continue;
        taken.add(key);
        // faces the approaching traffic; the arm length (scale) reaches towards the middle of the road
        props.push({ kind: PROP.SIGNAL, variant: 0, rot: Math.atan2(-dx, -dz), x, z, scale: Math.min(1.6, Math.max(0.7, L / 4)) });
      }
    }
  }
  return { marks, props };
}
