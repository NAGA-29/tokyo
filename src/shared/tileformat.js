// Binary city tile: the compiler writes it, the client reads it. One format, one file.
//
// All numbers little-endian. Coordinates are world metres (see geo.js), stored as f32.
//
//   header   u32 magic 'TKY1' | u16 version | u16 reserved | i32 tx | i32 tz
//            | u32 nBuildings | u32 nAreas | u32 nProps | u32 nWires
//   building u16 usage | u8 storeys | u8 flags | f32 base | f32 height | f32 measuredHeight | polygons
//   area     u8 kind | u8 reserved | u16 code | polygons
//   prop     u8 kind | u8 variant | u16 rotation (0..65535 = 0..2 pi, about +y) | f32 x | f32 z | f32 scale
//   wire     f32 x1 | f32 z1 | f32 x2 | f32 z2        (a span between two utility poles)
//   polygons u16 nPolys | per polygon: u16 nRings | per ring: u32 nPts | nPts * (f32 x, f32 z)
//
// The first ring of a polygon is its outline (counter-clockwise seen from above), the others holes
// (clockwise). Rings are open: the last point does not repeat the first.

export const MAGIC = 0x31594b54; // 'TKY1'
export const VERSION = 2;

export const BFLAG = { LOD2: 1, NO_SOLID: 2 };

// Ground surface kinds. For roads, `code` keeps the PLATEAU function code for finer styling later.
export const AREA = { ROAD: 0, CARRIAGEWAY: 1, SIDEWALK: 2, ISLAND: 3, OTHER: 4, PARK: 5, WOOD: 6, WATER: 7, PITCH: 8, MARK_WHITE: 9, MARK_YELLOW: 10 };

// Point objects placed by the compiler; the client instances a model per kind.
export const PROP = { TREE: 0, POLE: 1, LIGHT: 2, VENDING: 3, SIGNAL: 4 };

class Writer {
  constructor(size = 1 << 16) { this.buf = new ArrayBuffer(size); this.dv = new DataView(this.buf); this.o = 0; }
  need(n) {
    if (this.o + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.o + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.o));
    this.buf = next; this.dv = new DataView(next);
  }
  u8(v) { this.need(1); this.dv.setUint8(this.o, v); this.o += 1; }
  u16(v) { this.need(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.o, v, true); this.o += 4; }
  i32(v) { this.need(4); this.dv.setInt32(this.o, v, true); this.o += 4; }
  f32(v) { this.need(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  polygons(polys) {
    this.u16(polys.length);
    for (const rings of polys) {
      this.u16(rings.length);
      for (const ring of rings) {
        this.u32(ring.length);
        for (const [x, z] of ring) { this.f32(x); this.f32(z); }
      }
    }
  }
  bytes() { return new Uint8Array(this.buf, 0, this.o); }
}

const clampInt = (v, max) => Math.max(0, Math.min(max, Math.round(v || 0)));

export function encodeTile({ tx, tz, buildings, areas, props = [], wires = [] }) {
  const w = new Writer();
  w.u32(MAGIC); w.u16(VERSION); w.u16(0);
  w.i32(tx); w.i32(tz);
  w.u32(buildings.length); w.u32(areas.length); w.u32(props.length); w.u32(wires.length);
  for (const b of buildings) {
    w.u16(clampInt(b.usage, 65535)); w.u8(clampInt(b.storeys, 255)); w.u8(b.flags || 0);
    w.f32(b.base); w.f32(b.height); w.f32(b.measuredHeight ?? -1);
    w.polygons(b.polygons);
  }
  for (const a of areas) {
    w.u8(a.kind); w.u8(0); w.u16(clampInt(a.code, 65535));
    w.polygons(a.polygons);
  }
  const TAU = Math.PI * 2;
  for (const p of props) {
    w.u8(p.kind); w.u8(p.variant || 0);
    w.u16(Math.round(((((p.rot || 0) % TAU) + TAU) % TAU) / TAU * 65535));
    w.f32(p.x); w.f32(p.z); w.f32(p.scale ?? 1);
  }
  for (const [x1, z1, x2, z2] of wires) { w.f32(x1); w.f32(z1); w.f32(x2); w.f32(z2); }
  return w.bytes();
}

// Decodes into plain objects with rings as Float32Array [x0, z0, x1, z1, ...] (zero-copy friendly for meshing).
export function decodeTile(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let o = 0;
  const u8 = () => dv.getUint8(o++);
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
  const polygons = () => {
    const polys = new Array(u16());
    for (let p = 0; p < polys.length; p++) {
      const rings = new Array(u16());
      for (let r = 0; r < rings.length; r++) {
        const n = u32(), ring = new Float32Array(n * 2);
        for (let i = 0; i < n * 2; i++) ring[i] = f32();
        rings[r] = ring;
      }
      polys[p] = rings;
    }
    return polys;
  };

  if (u32() !== MAGIC) throw new Error('not a TKY1 tile');
  const version = u16(); u16();
  if (version !== VERSION) throw new Error(`tile version ${version}, expected ${VERSION}`);
  const tx = i32(), tz = i32(), nB = u32(), nA = u32(), nP = u32(), nW = u32();
  const buildings = new Array(nB);
  for (let i = 0; i < nB; i++) {
    const usage = u16(), storeys = u8(), flags = u8();
    const base = f32(), height = f32(), measuredHeight = f32();
    buildings[i] = { usage, storeys, flags, base, height, measuredHeight, polygons: polygons() };
  }
  const areas = new Array(nA);
  for (let i = 0; i < nA; i++) {
    const kind = u8(); u8(); const code = u16();
    areas[i] = { kind, code, polygons: polygons() };
  }
  const props = new Array(nP);
  for (let i = 0; i < nP; i++) {
    const kind = u8(), variant = u8(), rot = (u16() / 65535) * Math.PI * 2;
    props[i] = { kind, variant, rot, x: f32(), z: f32(), scale: f32() };
  }
  const wires = new Float32Array(nW * 4);
  for (let i = 0; i < nW * 4; i++) wires[i] = f32();
  return { tx, tz, buildings, areas, props, wires };
}
