// The sea around the area: a flat sheet whose surface normal is made of travelling waves, so it mirrors the
// sky, breaks the sun into a glitter path and darkens under clouds like any other lit surface. (The waves
// are in the shading only: at the scale of a city seen from the air their height does not show.)
import * as THREE from 'three';
import { shared } from './materials.js';

// direction (degrees), wavelength (m), steepness: a swell, the wind sea across it, and chop
const WAVES = [[20, 140, 0.05], [57, 83, 0.05], [-23, 47, 0.07], [98, 29, 0.07], [-61, 17, 0.09], [39, 9.5, 0.1], [-104, 5.3, 0.1], [141, 3.7, 0.09], [8, 2.3, 0.08]];

export function createOcean(radius = 50000) {
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.012, 0.05, 0.075), roughness: 0.14, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSea;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSea = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const waves = WAVES.map(([deg, length, steep]) => {
      const a = THREE.MathUtils.degToRad(deg), k = (2 * Math.PI) / length, speed = Math.sqrt(9.81 / k); // deep-water waves
      const f = (v) => v.toFixed(5);
      // each wave is left out where it is finer than a pixel (it would only sparkle)
      return `  slope += vec2(${f(Math.cos(a))}, ${f(Math.sin(a))}) * (${f(steep)} * cos(${f(k)} * dot(sea, vec2(${f(Math.cos(a))}, ${f(Math.sin(a))})) - ${f(k * speed)} * uTime) * (1.0 - smoothstep(${f(length * 0.2)}, ${f(length * 0.6)}, footprint)));`;
    }).join('\n');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
varying vec3 vSea;
float seaHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float seaNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(seaHash(i), seaHash(i + vec2(1.0, 0.0)), f.x), mix(seaHash(i + vec2(0.0, 1.0)), seaHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float footprint = max(length(dFdx(vSea.xz)), length(dFdy(vSea.xz)));
  // straight wave trains crossing each other weave a grid: bend them, as wind and current do
  vec2 sea = vSea.xz + 14.0 * vec2(seaNoise(vSea.xz * 0.011), seaNoise(vSea.xz * 0.011 + 17.3)) + 3.0 * vec2(seaNoise(vSea.xz * 0.06 + 5.1), seaNoise(vSea.xz * 0.06 + 41.7));
  vec2 slope = vec2(0.0);
${waves}
  normal = normalize((viewMatrix * vec4(normalize(vec3(-slope.x, 1.0, -slope.y)), 0.0)).xyz);
}`)
      // far away the waves blur into a rougher surface: the glitter widens into a sheen
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, smoothstep(2.0, 60.0, max(length(dFdx(vSea.xz)), length(dFdy(vSea.xz)))));');
  };
  material.customProgramCacheKey = () => 'ocean-v2';
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 96).rotateX(-Math.PI / 2), material);
  mesh.receiveShadow = true;
  mesh.name = 'ocean';
  return mesh;
}
