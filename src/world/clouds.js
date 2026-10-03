// Drifting clouds: one layer of noise, seen as a sheet in the sky and felt on the ground as shadows.
// The shadows are not in the shadow map (which covers only the surroundings of the focus, and is sharp):
// every lit material dims its sunlight by the cloud standing between its fragment and the sun. That is
// done once for all of them by extending three's lighting shader chunks.
import * as THREE from 'three';
import { shared } from './materials.js';

const HEIGHT = 900;          // metres above sea level
const WIND = [9, 4];         // metres per second
const SIZE = 16000, FADE = [4200, 7000]; // the sheet follows the camera and fades out towards its edge

// density(xz) in 0..1. shared.uCloud = (drift x, drift z, cover 0..1, shadow strength); all zero = no clouds.
const CLOUD_GLSL = /* glsl */ `
uniform vec4 uCloud;
float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cloudNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + vec2(1.0, 0.0)), f.x), mix(cloudHash(i + vec2(0.0, 1.0)), cloudHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float cloudDensity(vec2 xz) {
  vec2 p = (xz + uCloud.xy) / 950.0;
  float n = cloudNoise(p) * 0.55 + cloudNoise(p * 2.1 + 7.3) * 0.28 + cloudNoise(p * 4.3 + 1.7) * 0.17;
  n = (n - 0.5) * 2.4 + 0.5; // summed noise huddles around its mean: spread it over 0..1
  return smoothstep(1.0 - uCloud.z, 1.25 - uCloud.z, n);
}
`;

// Call once, before any material is compiled.
export function installCloudShadows() {
  THREE.ShaderChunk.lights_pars_begin += CLOUD_GLSL + /* glsl */ `
#if NUM_DIR_LIGHTS > 0
// how much of the sun reaches a point (view space): the cloud on the way to the sun
float cloudLight(vec3 viewPos) {
  if (uCloud.w <= 0.0) return 1.0;
  mat3 toWorld = transpose(mat3(viewMatrix));
  vec3 p = cameraPosition + toWorld * viewPos, sun = toWorld * directionalLights[0].direction;
  float t = max(${HEIGHT.toFixed(1)} - p.y, 0.0) / max(sun.y, 0.2);
  return 1.0 - uCloud.w * cloudDensity(p.xz + sun.xz * t);
}
#endif
`;
  const hook = 'getDirectionalLightInfo( directionalLight, directLight );';
  THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(hook, `${hook}\n\t\tdirectLight.color *= cloudLight( geometryPosition );`);
  // materials without a hook of their own get the uniform here; the others add shared.uCloud themselves
  THREE.Material.prototype.onBeforeCompile = function (shader) { shader.uniforms.uCloud = shared.uCloud; };
}

export class Clouds {
  constructor() {
    this.cover = 0.4; this.shadow = 0.62; this.speed = 1;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uCloud: shared.uCloud, uNight: shared.uNight, uFade: { value: new THREE.Vector2(...FADE) }, uOpacity: { value: 1 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: /* glsl */ `
        ${CLOUD_GLSL}
        uniform float uNight, uOpacity; uniform vec2 uFade;
        varying vec3 vW;
        void main() {
          float d = cloudDensity(vW.xz);
          // wisps at the edges
          d *= 0.75 + 0.5 * cloudNoise((vW.xz + uCloud.xy) / 90.0);
          float a = clamp(d, 0.0, 1.0) * uOpacity * (1.0 - smoothstep(uFade.x, uFade.y, distance(vW.xz, cameraPosition.xz)));
          if (a < 0.004) discard;
          // white, greyer where the cloud is thick; at night a dim sheet lit from the city below
          vec3 day = mix(vec3(1.0), vec3(0.74, 0.77, 0.82), smoothstep(0.3, 1.0, d));
          vec3 night = vec3(0.10, 0.085, 0.08);
          gl_FragColor = vec4(mix(day, night, uNight), a * 0.92);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), this.material);
    this.mesh.position.y = HEIGHT;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'clouds';
    this.apply();
  }

  apply() { shared.uCloud.value.z = this.cover; shared.uCloud.value.w = this.cover > 0 ? this.shadow : 0; this.mesh.visible = this.cover > 0; }

  update(dt, camera) {
    shared.uCloud.value.x += WIND[0] * dt * this.speed; shared.uCloud.value.y += WIND[1] * dt * this.speed;
    this.mesh.position.x = camera.position.x; this.mesh.position.z = camera.position.z;
    // seen from above, the sheet would hide the city: it thins out as the camera climbs through it
    this.material.uniforms.uOpacity.value = THREE.MathUtils.clamp((HEIGHT + 60 - camera.position.y) / 320, 0.18, 1);
  }
}
