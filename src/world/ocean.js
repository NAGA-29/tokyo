// The sea around the area. The water is the one from the "miniature" project (its render.wgsl), ported from
// WGSL: the displaced surface of Thomas Schander's Enscape Cube (https://www.shadertoy.com/view/4dSBDt), which
// builds on Alexander Alekseev's Seascape — CC BY-NC-SA 3.0. Octaves of a choppy noise wave give the height;
// here it shapes the normal of a flat, lit sheet (seen from the air, the height itself does not show), with
// miniature's water colour, crest foam and explicit sun glint. Scaled from miniature's unit-sized terrain to
// metres with Seascape's own figures: 0.16 rad/m and 0.6 m for the first octave.
import * as THREE from 'three';
import { shared } from './materials.js';

export const SEA = { height: 0.6, frequency: 0.16, speed: 0.25, choppiness: 0.1, normal: 1.6, foam: 0.1 };

const PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunGlint;
uniform vec4 uSea;  // height, frequency, speed, choppiness
uniform vec2 uSea2; // normal strength, crest foam
varying vec3 vSea;
vec3 gSeaNormal;    // world space
float gSeaFoam;

float seaHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float seaNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return -1.0 + 2.0 * mix(mix(seaHash(i), seaHash(i + vec2(1.0, 0.0)), f.x), mix(seaHash(i + vec2(0.0, 1.0)), seaHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Seascape-derived octave used by the Enscape Cube ShaderToy.
float seaOctave(vec2 uv, float choppy) {
  uv += seaNoise(uv);
  vec2 waves = 1.0 - abs(sin(uv));
  waves = mix(waves, abs(cos(uv)), waves);
  return pow(1.0 - pow(waves.x * waves.y, 0.65), choppy);
}
// footprint: metres of sea under one pixel. An octave finer than that is left out (it would only sparkle).
float seaHeight(vec2 p, float footprint) {
  float frequency = uSea.y, amplitude = uSea.x, choppy = 1.0 + uSea.w * 6.0, scale = 1.0, height = 0.0;
  vec2 uv = vec2(p.x * 0.75, p.y);
  float phase = 0.16 + uTime * uSea.z;
  mat2 octave = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 7; i++) {
    float keep = 1.0 - smoothstep(0.25, 0.9, footprint * frequency * scale);
    if (keep <= 0.0) break;
    float wave = seaOctave(uv * frequency + phase, choppy) + seaOctave(uv * frequency - phase, choppy);
    height += wave * amplitude * keep;
    uv = octave * uv; scale *= 2.0;
    frequency *= 1.9; amplitude *= 0.22;
    choppy = mix(choppy, 1.0, 0.2);
  }
  return height;
}
`;

const SURFACE = /* glsl */ `
{
  float footprint = max(length(dFdx(vSea.xz)), length(dFdy(vSea.xz)));
  float e = max(0.12, footprint * 0.75);
  float h = seaHeight(vSea.xz, footprint);
  float dx = seaHeight(vSea.xz + vec2(e, 0.0), footprint) - h, dz = seaHeight(vSea.xz + vec2(0.0, e), footprint) - h;
  gSeaNormal = normalize(vec3(-dx * uSea2.x, e, -dz * uSea2.x));
  normal = normalize((viewMatrix * vec4(gSeaNormal, 0.0)).xyz);
  // foam on the crests: high water on a steep face
  float crest = uSea.x * 1.5;
  gSeaFoam = clamp(smoothstep(crest * 0.55, crest, h) * smoothstep(0.98, 0.72, gSeaNormal.y) * uSea2.y, 0.0, 1.0);
}
`;

// The sky reflection in smooth water holds no sun: give it an explicit reflected sun disc. A slightly
// broadened lobe keeps the glint visible at display resolution while the wave normal breaks it across the sea.
const GLINT = /* glsl */ `
{
  vec3 toEye = normalize(cameraPosition - vSea);
  float sun = clamp(dot(reflect(-toEye, gSeaNormal), uSunDir), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(toEye, gSeaNormal), 0.0, 1.0), 5.0);
  // (the direct diffuse light is zero in shadow: it tells whether the sun reaches this water)
  float lit = smoothstep(0.0, 0.002, dot(reflectedLight.directDiffuse, vec3(0.333)));
  reflectedLight.directSpecular += uSunGlint * lit * fresnel * (pow(sun, 96.0) * 3.0 + pow(sun, 18.0) * 0.35) * 6.0;
}
`;

export function createOcean(radius = 50000) {
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.0, 0.05, 0.1), roughness: 0.05, metalness: 0 });
  const sea = new THREE.Vector4(), sea2 = new THREE.Vector2();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: shared.uTime, uSunDir: shared.uSunDir, uSunGlint: shared.uSunGlint, uSea: { value: sea }, uSea2: { value: sea2 } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSea;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSea = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SURFACE + 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), gSeaFoam);')
      // where the waves are finer than a pixel they blur into a rougher surface: the glitter widens into a sheen
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.3, smoothstep(1.5, 40.0, max(length(dFdx(vSea.xz)), length(dFdy(vSea.xz)))));')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + GLINT);
  };
  material.customProgramCacheKey = () => 'ocean-v3';
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 96).rotateX(-Math.PI / 2), material);
  mesh.receiveShadow = true;
  mesh.name = 'ocean';
  mesh.onBeforeRender = () => { sea.set(SEA.height, SEA.frequency, SEA.speed, SEA.choppiness); sea2.set(SEA.normal, SEA.foam); };
  return mesh;
}
