# procedural-tokyo

A three.js driving game set in a Tokyo compiled from public data, with procedural detail on top.
The architecture follows [BoundlessNYC](https://github.com/mkturkcan/boundless-nyc): an offline compiler turns raw
records into binary tiles, and the client streams them around the player.

## Client

```
node tools/assets/fetch_textures.mjs   # once: CC0 textures from Poly Haven -> public/textures/ (14 MB)
npm run dev                            # http://localhost:5280  (needs compiled tiles, see below)
```

Streams the 256 m tiles around the camera; meshing runs in Web Workers (`src/world/meshing.js`).

Road surfaces, painted lines and road symbols share the terrain mesh's triangulation (`src/world/drape.js`),
so markings stay above the asphalt on slopes and bridge approaches, including across tile boundaries.
`npm test` checks their geometric clearance; `node tools/tests/road-markings.test.mjs --all` checks every locally compiled tile.

- **Buildings**: real footprints and heights; walls textured by use (tile, concrete panel, plaster, brick tile, metal
  siding); windows fitted per wall with frames, mullions and interior-mapped rooms that light up at night; parapets,
  rooftop equipment, balconies on apartment blocks, pitched roofs on houses, shop sign bands.
- **Ground**: terrain, PLATEAU road surfaces with kerbs, parks, woods and water from OSM, lane lines, zebra crossings
  and stop lines, lane arrows, 止まれ at side streets and painted speed limits. Roads PLATEAU maps only as an
  outline are split into carriageway and sidewalk from the OSM centrelines (`tools/pipeline/roadsplit.mjs`).
- **Street objects** (`src/world/props.js`): trees (ez-tree up close, simple shapes far away), utility poles with
  wires, street lights with light pools at night, vending machines, traffic signals that cycle.
- **Atmosphere** (`sky.js`, `environment.js`): procedural sky with clouds, image-based ambient light and reflections,
  sun shadows that scale with the view, ambient occlusion (n8ao), bloom, day/night.

Drag to pan, right-drag to rotate, WASD to move, N for day/night, click a building to inspect it.
URL parameters: `?night=1`, `?cam=x,z,distance,azimuth,elevation`, `?radius=1500`.

## Pipeline

```
npm install
npm run fetch      # raw data -> data/raw/<area>/        (~1.1 GB for Shibuya)
npm run compile    # data/raw -> public/tiles/<area>/    (~8 MB, a few seconds)
npm run preview    # top-down render -> data/preview/<area>.png
npm test           # tile format round trip + checks over the compiled area
```

All scripts take `--area=<id>` (default `shibuya`); areas are defined in `tools/pipeline/config.mjs` as a centre and a
block of PLATEAU meshes.

| Source | What we take |
|---|---|
| [Project PLATEAU](https://www.mlit.go.jp/plateau/) CityGML (`bldg`) | Building footprints (floor of the LOD1 solid), base height, height, storeys, usage code, LOD2 flag |
| PLATEAU CityGML (`tran`) | Road surfaces: LOD1 outline, and carriageway / sidewalk / island areas where mapped |
| [OpenStreetMap](https://www.openstreetmap.org/) (Overpass) | Drivable road graph: class, lanes, one-way, speed, layer, bridge/tunnel, names; railways; parks, woods, water, mapped trees, pedestrian crossings, traffic signals |
| [GSI DEM tiles](https://maps.gsi.go.jp/development/ichiran.html) | Terrain: 5 m DEM (`dem5a`), 10 m (`dem10b`) for gaps |

PLATEAU files are fetched per 3rd-level mesh through the PLATEAU data catalog API; the Tokyo dataset lists the same
mesh under every ward it touches, so buildings and roads are deduplicated by `gml:id`.

## Compiled output (`public/tiles/<area>/`)

World frame: metres, x east, y up (Tokyo Peil height), z south; the origin is the area centre (Shibuya: the Scramble
Crossing).

| File | Contents |
|---|---|
| `manifest.json` | origin, bounds, tile list, terrain grid description, attribution |
| `t_<x>_<z>.bin` | one 256 m tile: buildings, ground surfaces (roads, paint, parks, water), props (trees, poles, lights, vending machines, signals) and wires; format in `src/shared/tileformat.js` |
| `terrain.bin` | Float32 height grid, 5 m spacing |
| `roads.json` | road graph: junction nodes `[x, y, z]`, edges with polylines (ground height per point) and OSM attributes |
| `rails.json` | surface and elevated railway polylines |

`src/shared/` is used by both the compiler and the client.

## Attribution

3D city model: Project PLATEAU (MLIT). Elevation: GSI. Road network and railways: © OpenStreetMap contributors (ODbL);
a redistributed compiled area is a derived database under the ODbL. Textures: Poly Haven (CC0). Trees: ez-tree (MIT).

The compiler places paint and street objects from the data: lane lines follow the carriageway measured from the
PLATEAU polygons (not the OSM centreline), poles and lights stand at the measured road edge, crossings and signals
come from their OSM positions (`tools/pipeline/markings.mjs`, `landscape.mjs`).
