// Sky, sun, image-based ambient light, fog and the day/night blend.
import * as THREE from 'three';
import { createSky, SKY } from './sky.js';
import { shared } from './materials.js';

const SHADOW_SIZE = 4096;

const DAY = { fog: SKY.horizon, hemi: 0.55, sun: 3.4, sunColor: new THREE.Color(0xfff0dc), env: 1.0, exposure: 0.82, bloom: 0.12 };
const NIGHT = {
  fog: new THREE.Color().setRGB(0.02, 0.02, 0.028), hemi: 0.42, sun: 0.32, sunColor: new THREE.Color(0x9fb4e0),
  env: 1.0, exposure: 1.15, bloom: 0.45,
};

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.night = 0;
    this.target = 0;
    this.time = 0;
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(205));

    this.sky = createSky();
    this.sky.material.uniforms.uSunDir.value.copy(this.sunDir);
    scene.add(this.sky);

    // Environment map: the same sky without the sun disc (the sun is the directional light).
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = createSky({ sunDisc: 0, ground: SKY.ground });
    this.envSky.material.uniforms.uSunDir.value.copy(this.sunDir);
    this.envScene.add(this.envSky);
    this.bakeEnvironment();

    this.hemi = new THREE.HemisphereLight(0xfff4e6, 0x8a8172);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    const c = this.sun.shadow.camera;
    c.near = 10; c.far = 4000;
    this.shadowExtent = 0;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun, this.sun.target);

    scene.fog = new THREE.Fog(DAY.fog.clone(), 500, 4200);
    this.apply();
  }

  // Renders the environment map for day or night (whichever the blend is closer to).
  bakeEnvironment() {
    this.baked = this.night > 0.5 ? 1 : 0;
    this.envSky.material.uniforms.uNight.value = this.baked;
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene, 0, 0.1, 10).texture;
    old?.dispose();
  }

  toggle() { this.target = this.target > 0.5 ? 0 : 1; }

  setNight(v) { this.night = this.target = v; this.apply(); this.bakeEnvironment(); }

  // The sky follows the camera; the shadow frustum follows the focus, snapped to texels so shadows do not shimmer.
  follow(focus, camera) {
    this.sky.position.copy(camera.position);
    // Shadow coverage grows with the viewing distance (in coarse steps, so it rarely changes).
    const want = THREE.MathUtils.clamp(camera.position.distanceTo(focus) * 1.1, 220, 1800);
    const extent = 220 * 1.3 ** Math.ceil(Math.log(want / 220) / Math.log(1.3));
    if (extent !== this.shadowExtent) {
      this.shadowExtent = extent;
      const c = this.sun.shadow.camera;
      c.left = c.bottom = -extent; c.right = c.top = extent;
      c.updateProjectionMatrix();
      this.sun.shadow.normalBias = 0.25 + extent / 900;
    }
    const texel = (2 * extent) / SHADOW_SIZE;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 2000);
  }

  update(dt) {
    this.time += dt;
    this.sky.material.uniforms.uTime.value = this.time;
    if (this.night === this.target) return;
    const step = dt / 1.5;
    this.night = this.target > this.night ? Math.min(this.target, this.night + step) : Math.max(this.target, this.night - step);
    this.apply();
    // swap the environment map at the midpoint, where apply() has faded it down
    if ((this.night > 0.5 ? 1 : 0) !== this.baked) this.bakeEnvironment();
  }

  apply() {
    const t = this.night, lerp = (a, b) => a + (b - a) * t;
    this.sky.material.uniforms.uNight.value = t;
    this.scene.fog.color.copy(DAY.fog).lerp(NIGHT.fog, t);
    this.hemi.intensity = lerp(DAY.hemi, NIGHT.hemi);
    this.sun.intensity = lerp(DAY.sun, NIGHT.sun);
    this.sun.color.copy(DAY.sunColor).lerp(NIGHT.sunColor, t);
    // The environment map is baked for day or night; fade it out mid-transition so it never over-lights.
    this.scene.environmentIntensity = lerp(DAY.env, NIGHT.env) * (0.25 + 0.75 * Math.abs(1 - 2 * t));
    this.renderer.toneMappingExposure = lerp(DAY.exposure, NIGHT.exposure);
    this.bloom = lerp(DAY.bloom, NIGHT.bloom);
    shared.uNight.value = t;
  }
}
