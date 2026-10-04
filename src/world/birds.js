// Birds over the city: flocks that wander above the area, each bird circling within its flock and beating
// its wings. One instanced mesh; every position comes out of the vertex shader from the time and a few random
// numbers per bird, so a thousand birds cost the CPU nothing.
import * as THREE from 'three';
import { shared } from './materials.js';

export const MAX_BIRDS = 2000;
const FLOCK = 14;  // birds per flock
const SPAN = 3.2;  // wingspan in metres: a good deal larger than life, or they would not be seen from the air

// A bird flying towards +z: a slim body and two wings of two panels each. aWing: 0 on the body, 1 at the tip.
function birdGeometry() {
  const pos = [], wing = [];
  const tri = (a, b, c) => { for (const [x, y, z, w] of [a, b, c]) { pos.push(x, y, z); wing.push(w); } };
  const h = SPAN / 2;
  tri([0, 0, 0.42, 0], [0.09, 0, -0.1, 0], [-0.09, 0, -0.1, 0]);       // head and chest
  tri([0.09, 0, -0.1, 0], [0, 0, -0.5, 0], [-0.09, 0, -0.1, 0]);       // tail
  for (const s of [-1, 1]) {
    tri([s * 0.06, 0, 0.2, 0], [s * h * 0.5, 0, 0.16, 0.5], [s * 0.06, 0, -0.16, 0]);         // inner panel
    tri([s * h * 0.5, 0, 0.16, 0.5], [s * h * 0.5, 0, -0.1, 0.5], [s * 0.06, 0, -0.16, 0]);
    tri([s * h * 0.5, 0, 0.16, 0.5], [s * h, 0, -0.02, 1], [s * h * 0.5, 0, -0.1, 0.5]);      // outer panel
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  const seed = new Float32Array(MAX_BIRDS * 4);
  for (let i = 0; i < MAX_BIRDS; i++) seed.set([Math.floor(i / FLOCK), Math.random(), Math.random(), Math.random()], i * 4);
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4)); // flock, and three random numbers
  return g;
}

// bounds: { minX, maxX, minZ, maxZ } of the area; ground: a typical ground height.
export function createBirds(bounds, ground = 20) {
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: shared.uTime, uNight: shared.uNight,
      uCentre: { value: new THREE.Vector3((bounds.minX + bounds.maxX) / 2, ground, (bounds.minZ + bounds.maxZ) / 2) },
      uReach: { value: new THREE.Vector2((bounds.maxX - bounds.minX) * 0.42, (bounds.maxZ - bounds.minZ) * 0.42) },
    },
    vertexShader: /* glsl */ `
      attribute float aWing;
      attribute vec4 aSeed;
      uniform float uTime;
      uniform vec3 uCentre;
      uniform vec2 uReach;
      varying float vShade;
      float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
      // where bird and flock are at time t
      vec3 place(float t) {
        float f = aSeed.x;
        // the flock: a slow, never-repeating loop over the area, 60 to 260 m up
        vec3 c = uCentre + vec3(
          uReach.x * sin(t * (0.010 + 0.012 * hash(f + 1.0)) + 6.28 * hash(f + 2.0)),
          60.0 + 200.0 * hash(f + 3.0) + 22.0 * sin(t * 0.04 + 6.28 * hash(f + 4.0)),
          uReach.y * sin(t * (0.010 + 0.012 * hash(f + 5.0)) + 6.28 * hash(f + 6.0)));
        // the bird: round the flock on its own circle, rising and falling a little
        float radius = 8.0 + 55.0 * aSeed.y, turn = (0.5 + aSeed.z) * 9.0 / radius * (hash(f + 7.0) < 0.5 ? -1.0 : 1.0);
        float a = t * turn + 6.28 * aSeed.w;
        return c + vec3(cos(a) * radius, 9.0 * sin(t * 0.21 + 6.28 * aSeed.z) + 14.0 * (aSeed.w - 0.5), sin(a) * radius * 0.8);
      }
      void main() {
        vec3 p = place(uTime), ahead = place(uTime + 0.25);
        vec3 fwd = normalize(ahead - p), right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd)), up = cross(fwd, right);
        // wings: beat for a while, then glide with the wings held a little up
        float beat = smoothstep(-0.2, 0.3, sin(uTime * 0.35 + 6.28 * aSeed.y));
        float lift = mix(0.18, sin(uTime * (7.0 + 4.0 * aSeed.z) + 6.28 * aSeed.w), beat) * 0.55;
        vec3 local = position;
        local.y += abs(local.x) * lift * aWing;
        local.x *= 1.0 - 0.22 * abs(lift) * aWing;
        vec3 world = p + right * local.x + up * local.y + fwd * local.z;
        vShade = 0.75 + 0.25 * aWing;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying float vShade;
      void main() { gl_FragColor = vec4(vec3(0.045, 0.045, 0.05) * vShade * mix(1.0, 0.25, uNight), 1.0); }`,
  });
  const mesh = new THREE.Mesh(birdGeometry(), material);
  mesh.frustumCulled = false; // (they are placed in the shader)
  mesh.name = 'birds';
  mesh.geometry.instanceCount = 150;
  return mesh;
}
