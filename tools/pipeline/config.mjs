// Areas the pipeline can build. An area is a block of PLATEAU 3rd-level meshes (~1.1 x 0.9 km each)
// around a centre; the world origin (0, 0, 0) sits on `origin`.
import path from 'node:path';
import { meshBlock, meshBounds3 } from '../../src/shared/geo.js';

export const AREAS = {
  shibuya: {
    name: 'Shibuya',
    origin: [139.70045, 35.65948], // Shibuya Scramble Crossing [lon, lat]
    radius: 1,                     // 3 x 3 meshes, about 3.4 x 2.8 km
  },
  tokyo: {
    name: 'Tokyo',
    origin: [139.76712, 35.68124], // Tokyo Station, between Marunouchi and Yaesu
    radius: 1,
  },
  shiba: {
    name: 'Shiba (Tokyo Tower)',
    origin: [139.74543, 35.65858], // Tokyo Tower
    radius: 1,
  },
};

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const RAW = path.join(ROOT, 'data/raw');

export function resolveArea(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--area='));
  const id = arg ? arg.split('=')[1] : 'shibuya';
  const area = AREAS[id];
  if (!area) throw new Error(`unknown area "${id}" (known: ${Object.keys(AREAS).join(', ')})`);
  const meshes = meshBlock(area.origin[0], area.origin[1], area.radius);
  const b = meshes.map(meshBounds3);
  const bbox = {
    south: Math.min(...b.map((m) => m.south)), west: Math.min(...b.map((m) => m.west)),
    north: Math.max(...b.map((m) => m.north)), east: Math.max(...b.map((m) => m.east)),
  };
  return { id, ...area, meshes, bbox, rawDir: path.join(RAW, id), outDir: path.join(ROOT, 'public/tiles', id) };
}
