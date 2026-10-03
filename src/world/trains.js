// Trains running on the railway lines. Each line's OSM ways are chained into paths (way direction =
// running direction); one train per path loops through the area, leaving at one edge and re-entering
// at the other.
import * as THREE from 'three';

// Line name (substring) -> rolling stock. Colours follow the real line colours.
const STOCK = [
  { match: '山手貨物線', stripe: '#00a08e', body: '#c9ccce', cars: 10, length: 20 },  // Saikyo / Shonan-Shinjuku trains use the freight tracks
  { match: '山手線', stripe: '#8fc31f', body: '#c9ccce', cars: 11, length: 20 },
  { match: '埼京', stripe: '#00a08e', body: '#c9ccce', cars: 10, length: 20 },
  { match: '小田急', stripe: '#2a6fc9', body: '#d2d4d6', cars: 10, length: 20 },
  { match: '井の頭', stripe: '#e8709f', body: '#d2d4d6', cars: 5, length: 20 },
  { match: '銀座', stripe: '#8a4a1c', body: '#f2b62a', cars: 6, length: 16 },
];
const DEFAULT_STOCK = { stripe: '#7b8794', body: '#c9ccce', cars: 8, length: 20 };
const SPEED = 15;        // m/s
const GAP = 350;         // metres of pause before a train re-enters
const MIN_PATH = 260;

// Side view of one car: plain body and underframe swatches in the top 8 px, the side below.
function carTextures(stock) {
  const W = 1024, H = 128, side = document.createElement('canvas'), glow = document.createElement('canvas');
  side.width = glow.width = W; side.height = glow.height = H;
  const g = side.getContext('2d'), e = glow.getContext('2d');
  g.fillStyle = stock.body; g.fillRect(0, 0, W, H);
  g.fillStyle = '#26282b'; g.fillRect(W / 2, 0, W / 2, 8);           // underframe swatch
  e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  g.fillStyle = stock.stripe; g.fillRect(0, 14, W, 8); g.fillRect(0, 76, W, 10); // roof-line and waist stripes
  const doors = 4, pitch = W / doors;
  for (let d = 0; d < doors; d++) {
    const x = pitch * (d + 0.5);
    for (const [wx, ww] of [[x - pitch * 0.42, pitch * 0.26], [x + pitch * 0.16, pitch * 0.26]]) { // windows between doors
      g.fillStyle = '#1c2228'; g.fillRect(wx, 32, ww, 36);
      e.fillStyle = '#fff2d2'; e.fillRect(wx, 32, ww, 36);
    }
    g.fillStyle = stock.stripe; g.fillRect(x - 26, 24, 52, 96);        // door leaves in the line colour
    g.fillStyle = '#1c2228'; g.fillRect(x - 20, 32, 17, 40); g.fillRect(x + 3, 32, 17, 40);
    e.fillStyle = '#fff2d2'; e.fillRect(x - 20, 32, 17, 40); e.fillRect(x + 3, 32, 17, 40);
    g.fillStyle = '#555'; g.fillRect(x - 1, 24, 2, 96);
  }
  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  return { map: tex(side), emissiveMap: tex(glow) };
}

// Car body (floor 1 m above the rail) and underframe; only the long sides show the side texture.
function carGeometry(length) {
  const plain = (geo, u) => { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, u, 0.985); return geo; };
  const body = new THREE.BoxGeometry(2.9, 2.75, length - 0.6).translate(0, 1.0 + 1.375, 0);
  const uv = body.attributes.uv;
  // BoxGeometry faces: +x, -x, +y, -y, +z, -z (4 vertices each). Sides keep the picture below the swatch row.
  for (let i = 0; i < uv.count; i++) {
    if (i < 8) uv.setY(i, uv.getY(i) * (120 / 128));
    else uv.setXY(i, 0.25, 0.985);
  }
  const under = plain(new THREE.BoxGeometry(2.5, 0.85, length - 2.5).translate(0, 0.575, 0), 0.75);
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = body.attributes[name], b = under.attributes[name], arr = new Float32Array(a.array.length + b.array.length);
    arr.set(a.array); arr.set(b.array, a.array.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  g.setIndex([...body.index.array, ...Array.from(under.index.array, (i) => i + body.attributes.position.count)]);
  return g;
}

// Chains lines of the same name end to start into paths: [{ name, pts: [[x, y, z]], cum: [distance], length }].
function chain(lines) {
  const key = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);
  const items = lines.map((l) => {
    const pts = [];
    for (let i = 0; i < l.pts.length; i += 3) pts.push([l.pts[i], l.pts[i + 1], l.pts[i + 2]]);
    return { name: l.name ?? '', pts, start: key(pts[0][0], pts[0][2]), end: key(pts.at(-1)[0], pts.at(-1)[2]), used: false };
  });
  const byStart = new Map();
  for (const it of items) { const k = it.name + '|' + it.start; if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(it); }
  const ends = new Set(items.map((it) => it.name + '|' + it.end));
  const paths = [];
  // begin at lines nothing leads into, then sweep up any loops left over
  for (const it of [...items.filter((i) => !ends.has(i.name + '|' + i.start)), ...items]) {
    if (it.used) continue;
    const pts = [];
    for (let cur = it; cur && !cur.used; cur = (byStart.get(cur.name + '|' + cur.end) ?? []).find((n) => !n.used)) {
      cur.used = true;
      pts.push(...(pts.length ? cur.pts.slice(1) : cur.pts));
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    if (cum.at(-1) >= MIN_PATH) paths.push({ name: it.name, pts, cum, length: cum.at(-1) });
  }
  return paths;
}

function pointAt(path, s, out) {
  const { pts, cum } = path;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1), a = pts[lo], b = pts[hi];
  return out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

export class Trains {
  constructor(lines) {
    this.group = new THREE.Group();
    this.group.name = 'trains';
    this.sets = [];
    const paths = chain(lines);
    const stocks = new Map(); // stock -> paths
    for (const p of paths) {
      const stock = STOCK.find((s) => p.name.includes(s.match)) ?? DEFAULT_STOCK;
      if (!stocks.has(stock)) stocks.set(stock, []);
      stocks.get(stock).push(p);
    }
    for (const [stock, list] of stocks) {
      const material = new THREE.MeshStandardMaterial({ ...carTextures(stock), roughness: 0.45, metalness: 0.35, emissive: 0xffffff, emissiveIntensity: 0 });
      const mesh = new THREE.InstancedMesh(carGeometry(stock.length), material, list.length * stock.cars);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; // cars move across the whole area
      this.group.add(mesh);
      this.sets.push({ stock, mesh, material, trains: list.map((path, i) => ({ path, s: (i * 613) % (path.length + GAP) })) });
    }
    this.dummy = new THREE.Object3D();
    this.a = new THREE.Vector3(); this.b = new THREE.Vector3();
  }

  update(dt, night) {
    const { dummy, a, b } = this;
    for (const { stock, mesh, material, trains } of this.sets) {
      material.emissiveIntensity = 0.15 + night * 1.1; // the saloon lights are always on
      let n = 0;
      for (const t of trains) {
        const span = t.path.length + stock.cars * stock.length + GAP;
        t.s = (t.s + SPEED * dt) % span; // distance of the train's nose from the start of the path
        for (let c = 0; c < stock.cars; c++, n++) {
          const centre = t.s - (c + 0.5) * stock.length, half = stock.length * 0.36;
          if (centre - half < 0 || centre + half > t.path.length) { dummy.scale.setScalar(0); dummy.updateMatrix(); mesh.setMatrixAt(n, dummy.matrix); continue; }
          pointAt(t.path, centre + half, a); pointAt(t.path, centre - half, b); // the two bogies
          dummy.position.copy(a).add(b).multiplyScalar(0.5);
          dummy.position.y += 0.16; // on top of the rails
          dummy.scale.setScalar(1);
          dummy.lookAt(a.x, a.y + 0.16, a.z);
          dummy.updateMatrix();
          mesh.setMatrixAt(n, dummy.matrix);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
