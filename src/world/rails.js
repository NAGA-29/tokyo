// Railways: track bed, rails, viaducts with piers, embankment slopes and overhead-line masts, built
// once for the whole area from rails.json (height profile from tools/pipeline/rails.mjs).
import * as THREE from 'three';
import { Trains } from './trains.js';

const STEP = 3;            // metres between cross-sections
const GAUGE = 1.067;       // Japanese narrow gauge
const VIADUCT_ABOVE = 2.0; // rail level this far above the ground gets a deck on piers; lower, an earth slope
const PIER_SPACING = 16, MAST_SPACING = 40;

// Flat list of triangles with a colour per vertex; normals come from the faces.
export class Soup {
  constructor() { this.pos = []; this.col = []; this.uv = []; }
  quad(a, b, c, d, color, uvs) { this.tri(a, b, c, color, uvs && [uvs[0], uvs[1], uvs[2]]); this.tri(a, c, d, color, uvs && [uvs[0], uvs[2], uvs[3]]); }
  tri(a, b, c, color, uvs) {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(...color);
    if (uvs) this.uv.push(...uvs[0], ...uvs[1], ...uvs[2]);
  }
  // Axis-aligned-in-its-own-frame box: centre c, half extents along the unit vectors t (along), n (across) and up.
  box(c, t, n, ht, hn, y0, y1, color) {
    const P = (st, sn, y) => [c[0] + t[0] * ht * st + n[0] * hn * sn, y, c[2] + t[2] * ht * st + n[2] * hn * sn];
    for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]].map((v, i, a) => [v, a[(i + 1) % 4]]))
      this.quad(P(s1[0], s1[1], y0), P(s2[0], s2[1], y0), P(s2[0], s2[1], y1), P(s1[0], s1[1], y1), color);
    this.quad(P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1), color);
  }
  mesh(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = m.receiveShadow = true;
    return m;
  }
}

// Ballast with two concrete sleepers per 1.3 m of track.
function bedTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d'), img = g.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const n = 0.75 + 0.5 * Math.random();
    img.data[i * 4] = 104 * n; img.data[i * 4 + 1] = 96 * n; img.data[i * 4 + 2] = 88 * n; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#9d9c97';
  for (const y of [20, 84]) g.fillRect(16, y, 96, 22);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Cross-sections every STEP metres along a polyline of [x, y, z] triples:
// { p: [x, y, z], t: unit tangent, n: unit right, s: distance along, h: height above the ground }.
export function sections(pts, ground) {
  const P = [];
  for (let i = 0; i < pts.length; i += 3) P.push([pts[i], pts[i + 1], pts[i + 2]]);
  const out = [];
  let s = 0, next = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (len < 0.01) continue;
    const t = [(b[0] - a[0]) / len, 0, (b[2] - a[2]) / len];
    while (next <= s + len + 1e-6) {
      const k = (next - s) / len, p = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      out.push({ p, t, n: [-t[2], 0, t[0]], s: next, h: p[1] - ground(p[0], p[2]) });
      next += STEP;
    }
    s += len;
  }
  // smooth the direction across OSM vertices so the track does not kink
  for (let i = 1; i < out.length - 1; i++) {
    const tx = out[i + 1].p[0] - out[i - 1].p[0], tz = out[i + 1].p[2] - out[i - 1].p[2], l = Math.hypot(tx, tz) || 1;
    out[i].t = [tx / l, 0, tz / l]; out[i].n = [-tz / l, 0, tx / l];
  }
  return out;
}

export async function buildRailways(url, ground) {
  const lines = await (await fetch(url)).json();
  const concrete = [0.64, 0.64, 0.62], steel = [0.33, 0.31, 0.3], earth = [0.4, 0.45, 0.3], white = [1, 1, 1];
  const bed = new Soup(), structure = new Soup(), wires = [];
  // point at lateral offset l and height v above the rail bed of a section
  const at = (c, l, v) => [c.p[0] + c.n[0] * l, c.p[1] + v, c.p[2] + c.n[2] * l];
  // sweep a cross-section profile ([lateral, vertical] points, or a function of the section) between sections
  const sweep = (soup, a, b, profile, color) => {
    const pa = typeof profile === 'function' ? profile(a) : profile, pb = typeof profile === 'function' ? profile(b) : profile;
    for (let j = 0; j + 1 < pa.length; j++)
      soup.quad(at(a, ...pa[j]), at(b, ...pb[j]), at(b, ...pb[j + 1]), at(a, ...pa[j + 1]), color);
  };

  for (const line of lines) {
    const cs = sections(line.pts, ground);
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i], b = cs[i + 1], h = Math.min(a.h, b.h);
      bed.quad(at(a, -1.4, 0), at(b, -1.4, 0), at(b, 1.4, 0), at(a, 1.4, 0), white,
        [[0, a.s / 1.3], [0, b.s / 1.3], [1, b.s / 1.3], [1, a.s / 1.3]]);
      for (const c of [-GAUGE / 2, GAUGE / 2])
        sweep(structure, a, b, [[c - 0.035, 0.0], [c - 0.035, 0.16], [c + 0.035, 0.16], [c + 0.035, 0.0]], steel);
      if (h > VIADUCT_ABOVE) {
        // deck with parapets: outer faces and underside, the inner faces of both parapets, and the deck surface
        sweep(structure, a, b, [[-2.05, 1.0], [-2.2, 1.0], [-2.2, -0.9], [2.2, -0.9], [2.2, 1.0], [2.05, 1.0]], concrete);
        sweep(structure, a, b, [[-2.05, 1.0], [-2.05, -0.03], [-1.4, -0.03]], concrete);
        sweep(structure, a, b, [[1.4, -0.03], [2.05, -0.03], [2.05, 1.0]], concrete);
      } else if (Math.max(a.h, b.h) > 0.6) {
        // earth slopes down to the ground on both sides
        sweep(structure, a, b, (c) => [[-1.4, 0], [-1.9, -0.05], [-1.9 - Math.max(c.h, 0) * 1.5, -Math.max(c.h, 0) - 0.1]], earth);
        sweep(structure, a, b, (c) => [[1.9 + Math.max(c.h, 0) * 1.5, -Math.max(c.h, 0) - 0.1], [1.9, -0.05], [1.4, 0]], earth);
      }
    }
    // piers under the deck, overhead-line masts beside the track
    const electrified = line.railway !== 'subway'; // the Ginza Line runs on a third rail
    let mastPrev = null;
    cs.forEach((c, i) => {
      if (c.h > VIADUCT_ABOVE + 0.5 && Math.round(c.s / STEP) % Math.round(PIER_SPACING / STEP) === 0)
        structure.box(c.p, c.t, c.n, 0.7, 1.3, c.p[1] - c.h - 1.5, c.p[1] - 0.9, concrete);
      if (electrified && (Math.round(c.s / STEP) % Math.round(MAST_SPACING / STEP) === 0 || i === cs.length - 1)) {
        const side = 2.45, foot = at(c, side, 0);
        structure.box(foot, c.t, c.n, 0.09, 0.09, c.p[1] - (c.h > VIADUCT_ABOVE ? 0 : Math.max(c.h, 0)), c.p[1] + 6.4, steel);
        structure.box(at(c, side / 2 - 0.2, 0), c.t, c.n, 0.05, side / 2 + 0.2, c.p[1] + 5.95, c.p[1] + 6.05, steel);
        if (mastPrev) {
          // contact wire and the messenger wire sagging above it
          wires.push(...at(mastPrev, 0, 5.2), ...at(c, 0, 5.2));
          const mid = [(mastPrev.p[0] + c.p[0]) / 2, (mastPrev.p[1] + c.p[1]) / 2 + 5.45, (mastPrev.p[2] + c.p[2]) / 2];
          wires.push(...at(mastPrev, 0, 5.9), ...mid, ...mid, ...at(c, 0, 5.9));
        }
        mastPrev = c;
      }
    });
  }

  const group = new THREE.Group();
  group.name = 'railways';
  const lin = (c) => new THREE.Color().setRGB(...c, THREE.SRGBColorSpace);
  for (const soup of [bed, structure]) for (let i = 0; i < soup.col.length; i += 3) {
    const c = lin(soup.col.slice(i, i + 3));
    soup.col[i] = c.r; soup.col[i + 1] = c.g; soup.col[i + 2] = c.b;
  }
  group.add(bed.mesh(new THREE.MeshStandardMaterial({ map: bedTexture(), roughness: 0.95 })));
  group.add(structure.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide })));
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
  group.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x14161a })));
  const trains = new Trains(lines);
  group.add(trains.group);
  group.userData.trains = trains; // call trains.update(dt, night) every frame
  return group;
}
