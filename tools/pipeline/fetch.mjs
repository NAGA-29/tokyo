// Downloads the raw data for an area into data/raw/<area>/. Cached files are skipped.
//   PLATEAU CityGML  buildings (bldg) and road surfaces (tran), per 3rd-level mesh
//   OpenStreetMap    drivable road network and railways (Overpass API)
//   GSI DEM          5 m terrain tiles (dem5a), 10 m tiles (dem10b) to fill gaps
//   GSI aerial photo seamlessphoto tiles, into public/ortho/<area>/ (the client drapes them on the ground)
// Usage: node tools/pipeline/fetch.mjs [--area=shibuya] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { resolveArea, ROOT } from './config.mjs';
import { demTileRange, DEM_SOURCES } from './terrain.mjs';

const area = resolveArea();
const FORCE = process.argv.includes('--force');
const UA = 'procedural-tokyo/0.1 (city compiler; https://github.com/)';
const PLATEAU_API = 'https://api.plateau.reearth.io/datacatalog/citygml/m:';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const PLATEAU_TYPES = ['bldg', 'tran', 'brid', 'frn', 'veg'];

const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
const exists = (f) => !FORCE && fs.existsSync(f) && fs.statSync(f).size > 0;

async function download(url, file, { retries = 3, ...init } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, ...init });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      return buf;
    } catch (e) {
      if (attempt >= retries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// Runs `fn` over items with at most `n` in flight.
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

async function fetchPlateau() {
  const dir = path.join(area.rawDir, 'plateau');
  const jobs = [];
  for (const mesh of area.meshes) {
    const catFile = path.join(dir, `catalog_${mesh}.json`);
    const cat = exists(catFile)
      ? JSON.parse(fs.readFileSync(catFile, 'utf8'))
      : JSON.parse(await download(PLATEAU_API + mesh, catFile));
    // The same mesh file is listed under every ward it touches; keep one URL per type.
    for (const type of PLATEAU_TYPES) {
      const urls = new Set();
      for (const city of cat.cities ?? [])
        for (const f of city.files?.[type] ?? []) if (f.code === mesh) urls.add(f.url);
      if (urls.size === 0) { log(`plateau ${mesh} ${type}: none`); continue; }
      // Different wards occasionally publish different files for a shared mesh; they are
      // deduplicated by gml:id at compile time, so download all of them.
      [...urls].forEach((url, i) => jobs.push({ url, file: path.join(dir, `${mesh}_${type}${i ? '_' + i : ''}.gml`) }));
    }
  }
  const todo = jobs.filter((j) => !exists(j.file));
  log(`plateau: ${jobs.length} files, ${todo.length} to download`);
  await pool(todo, 3, async (j) => {
    const buf = await download(j.url, j.file);
    log(`  ${path.basename(j.file)} ${(buf.length / 1e6).toFixed(1)} MB`);
  });
}

// Overpass queries, one cached file each. `{bb}` is replaced by the area bounding box.
const OSM_QUERIES = {
  // drivable roads and railways
  'osm.json': `(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service)$"]({bb});
  way["railway"~"^(rail|light_rail|subway|monorail|narrow_gauge)$"]({bb});
);`,
  // green space, water, mapped trees, pedestrian crossings and street objects
  'osm_land.json': `(
  way["leisure"~"^(park|garden|playground|pitch)$"]({bb});
  relation["leisure"~"^(park|garden)$"]({bb});
  way["landuse"~"^(grass|forest|cemetery|religious|recreation_ground|village_green|meadow)$"]({bb});
  relation["landuse"~"^(grass|forest|religious)$"]({bb});
  way["natural"~"^(wood|water|scrub|grassland)$"]({bb});
  relation["natural"~"^(wood|water)$"]({bb});
  way["natural"="tree_row"]({bb});
  node["natural"="tree"]({bb});
  node["highway"~"^(traffic_signals|crossing)$"]({bb});
  way["footway"="crossing"]({bb});
  node["amenity"="vending_machine"]({bb});
);`,
  // everything else that is drawn, with geometry: the pedestrian network, platforms, car parks, barriers,
  // waterways, canopies, gates and small mapped objects
  'osm_extra.json': `(
  way["highway"~"^(footway|path|pedestrian|steps|cycleway)$"]({bb});
  way["railway"="platform"]({bb});
  way["public_transport"="platform"]({bb});
  way["amenity"="parking"]({bb});
  way["barrier"~"^(fence|hedge|wall|retaining_wall|guard_rail)$"]({bb});
  way["waterway"~"^(river|stream|canal|ditch)$"]({bb});
  way["man_made"~"^(bridge|ceremonial_gate)$"]({bb});
  way["building"="roof"]({bb});
  way["leisure"="swimming_pool"]({bb});
  node["highway"="stop"]({bb});
  node["railway"="level_crossing"]({bb});
  node["man_made"="ceremonial_gate"]({bb});
  node["emergency"="fire_hydrant"]({bb});
  node["tourism"="information"]["information"~"^(map|board)$"]({bb});
  node["leisure"="picnic_table"]({bb});
  node["playground"]({bb});
  way["building"]["building:colour"]({bb});
  way["building"]["building:material"]({bb});
);`,
  // named places (shops, restaurants, offices, named buildings) and street furniture, as points:
  // "out center" gives ways and relations a single coordinate
  'osm_poi.json': `(
  nwr["name"]["shop"]({bb});
  nwr["name"]["amenity"]({bb});
  nwr["name"]["tourism"]({bb});
  nwr["name"]["office"]({bb});
  nwr["name"]["leisure"~"^(fitness_centre|sports_centre|amusement_arcade|adult_gaming_centre|dance|bowling_alley)$"]({bb});
  nwr["name"]["building"]({bb});
  node["railway"~"^(station|subway_entrance)$"]({bb});
  node["highway"="bus_stop"]({bb});
  node["amenity"~"^(bench|bicycle_parking|post_box|telephone|toilets|taxi|police)$"]({bb});
  node["historic"]({bb});
  node["man_made"~"^(flagpole|surveillance)$"]({bb});
  node["barrier"="bollard"]({bb});
);
out center tags;`,
};

async function fetchOsm() {
  for (const [name, body] of Object.entries(OSM_QUERIES)) await fetchOverpass(name, body);
}

async function fetchOverpass(name, body) {
  const file = path.join(area.rawDir, name);
  if (exists(file)) return log(`osm ${name}: cached`);
  const { south, west, north, east } = area.bbox;
  // queries end with their own "out" statement, or get the default: the elements with all their nodes
  const filled = body.replaceAll('{bb}', `${south},${west},${north},${east}`);
  const query = `[out:json][timeout:180];\n${filled}${/\bout\b/.test(filled) ? '' : '\n(._;>;);\nout body;'}`;
  for (const url of OVERPASS) {
    try {
      log(`osm ${name}: querying ${new URL(url).host}`);
      const buf = await download(url, file, {
        retries: 2, method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      const n = JSON.parse(buf).elements.length;
      return log(`osm ${name}: ${n} elements, ${(buf.length / 1e6).toFixed(1)} MB`);
    } catch (e) {
      log(`osm ${name}: ${e.message}`);
    }
  }
  throw new Error(`osm ${name}: every Overpass endpoint failed`);
}

async function fetchDem() {
  for (const src of DEM_SOURCES) {
    const { z, x0, x1, y0, y1 } = demTileRange(area.bbox, src.zoom);
    const jobs = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        jobs.push({ url: src.url(z, x, y), file: path.join(area.rawDir, 'dem', src.id, `${z}_${x}_${y}.png`) });
    const todo = jobs.filter((j) => !exists(j.file));
    log(`dem ${src.id}: ${jobs.length} tiles, ${todo.length} to download`);
    await pool(todo, 4, async (j) => {
      try { await download(j.url, j.file); } catch (e) { log(`  ${e.message} (left as a gap)`); }
    });
  }
}

// Aerial photo: zoom 17 is about 1 m per pixel here, 170 tiles for the area.
async function fetchOrtho() {
  const z = 17, dir = path.join(ROOT, 'public/ortho', area.id), { x0, x1, y0, y1 } = demTileRange(area.bbox, z);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
    jobs.push({ url: `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`, file: path.join(dir, `${z}_${x}_${y}.jpg`) });
  const todo = jobs.filter((j) => !exists(j.file));
  log(`aerial photo: ${jobs.length} tiles, ${todo.length} to download`);
  await pool(todo, 4, async (j) => { try { await download(j.url, j.file); } catch (e) { log(`  ${e.message} (left as a gap)`); } });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ z, x0, x1, y0, y1, attribution: 'Aerial photo: Geospatial Information Authority of Japan (GSI) seamlessphoto' }));
}

log(`area ${area.id}: meshes ${area.meshes.join(' ')}`);
log(`bbox lat ${area.bbox.south.toFixed(5)}..${area.bbox.north.toFixed(5)} lon ${area.bbox.west.toFixed(5)}..${area.bbox.east.toFixed(5)}`);
await fetchOsm();
await fetchDem();
await fetchOrtho();
await fetchPlateau();
log('done');
