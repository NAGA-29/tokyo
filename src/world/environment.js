// Sky, sun, image-based ambient light and the day/night blend. (No fog: the whole area is loaded and seen clearly.)
import * as THREE from 'three';
import { createSky, SKY } from './sky.js';
import { shared } from './materials.js';

const SHADOW_SIZE = 4096;

const DAY = { hemi: 0.55, sun: 3.4, sunColor: new THREE.Color(0xfff0dc), env: 1.0, exposure: 0.82, bloom: 0.12 };
const NIGHT = {
  hemi: 0.42, sun: 0.32, sunColor: new THREE.Color(0x9fb4e0),
  env: 1.0, exposure: 1.15, bloom: 0.45,
};

const SUNSET = new THREE.Color(0xff9a52);
// The golden hour (see `golden`): the sun's colour at the horizon, the light of the sky on what the sun does not
// reach (peach from above, a cool violet from below: warm light, cool shade), and the colours they have by day.
const GOLD = { sun: new THREE.Color(0xff6a24), sky: new THREE.Color(0xffb890), ground: new THREE.Color(0x5a4c7c) };
const REAL = { fill: 0.72, sky: 1.35, sun: 1.12 }; // realistic light: how much of the even fill goes, and the sky's and the sun's share
const HEMI = { sky: new THREE.Color(0xfff4e6), ground: new THREE.Color(0x8a8172) };
const MOON_STAND_IN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(205));

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.night = 0;  // how far the city's lights are on: they come on while it is still light
    this.dark = 0;   // how dark it is: this follows the sun all the way down through twilight
    this.daylight = 1; this.moonlight = 0; this.warmth = 0; this.elevation = 40;
    this.time = 0;
    this.brightness = 1; // of the whole picture (the exposure is multiplied by it)
    this.golden = 0;     // how much the low sun colours the city (0: as it was; 1: a golden hour)
    this.real = 0;       // realistic light (see `realistic`): 0 or 1
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
    // (the other way to light the scene from its sky: see lightFromSky)
    this.skyLit = false; this.physical = null; this.envScale = 1; this.bakedSun = new THREE.Vector3();
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

    this.apply();
  }

  // Renders the environment map for the sky as dark as it now is (again whenever that has changed a little).
  bakeEnvironment() {
    this.bakedAt = performance.now();
    this.baked = this.dark;
    this.envSky.material.uniforms.uNight.value = this.baked;
    const physical = this.skyLit && this.physical && this.physical.ready();
    if (this.physical) {
      this.envSky.visible = !physical; this.physical.group.visible = physical;
      // (a physical night sky is black: the glow of the city's lights on the haze is put under it)
      this.physical.glow.color.copy(SKY.nightHorizon).multiplyScalar(this.baked / this.physical.scale);
      this.bakedSun.copy(this.sunWas ?? this.bakedSun);
    }
    this.envScale = physical ? this.physical.scale : 1;
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene, 0, 0.1, 10).texture;
    old?.dispose();
  }

  // Lights the scene from the sky the atmosphere works out instead of the painted one: the shaded sides and the
  // glass then take the colours of the hour — the blue of noon, the orange of the low sun — from the same sky
  // that is seen. sky: { mesh, scale } (Atmosphere.environmentSky()); ready(): whether the atmosphere can draw yet.
  lightFromSky(sky, ready) {
    const glow = new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const group = new THREE.Group();
    Object.assign(sky.mesh.material, { blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false });
    sky.mesh.renderOrder = 1;
    group.add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), glow), sky.mesh);
    group.visible = false;
    this.envScene.add(group);
    this.physical = { group, glow, scale: sky.scale, ready };
  }
  // Realistic light: the sky itself lights the shade (and so its colour changes with the hour), with little of
  // the even fill; the sun a little stronger against it.
  get realistic() { return this.real > 0; }
  set realistic(v) { this.real = v ? 1 : 0; this.skyLight = !!v; this.apply(); }
  get skyLight() { return this.skyLit; }
  set skyLight(v) { if (v !== this.skyLit) { this.skyLit = v; this.bakeEnvironment(); this.apply(); } }

  // sun, moon: unit vectors towards them (world space). The light is the sun by day — dimmer and warmer as it
  // sinks — and the moon by night (or a stand-in for it while the moon is down); the change of direction
  // happens around sunset, when neither casts a shadow to speak of.
  setSky(sun, moon) {
    const deg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1))), step = THREE.MathUtils.smoothstep;
    this.elevation = deg;
    // Dusk in order: the lights come on as the sun nears the horizon and are all on when it sets; the dark
    // then comes slowly, with the sun, until the end of nautical twilight (and the other way round at dawn).
    this.night = 1 - step(deg, 0, 9);
    this.dark = 1 - step(deg, -13, 5);
    this.daylight = step(deg, -5, 9);          // how much of the sun's light arrives (the afterglow included)
    this.moonlight = 1 - step(deg, -14, -5.5);
    this.warmth = 1 - step(deg, 3, 24);        // 1 at the horizon: orange light
    if (deg > -5.5) this.sunDir.copy(sun).setY(Math.max(sun.y, 0.06)).normalize(); // (never quite grazing: shadows stay finite)
    else if (moon.y > 0.2) this.sunDir.copy(moon);
    else this.sunDir.copy(MOON_STAND_IN);
    shared.uSunDir.value.copy(sun);
    shared.uSunGlint.value.copy(DAY.sunColor).lerp(SUNSET, this.warmth).multiplyScalar(this.daylight * 3);
    this.apply();
    this.sunWas = sun;
    // (the map is baked again as the light changes — not more often than a few times a second, however fast the
    // day is played through)
    const now = performance.now(), due = now - (this.bakedAt ?? 0) > 200;
    if (!due) { /* soon */ }
    else if (Math.abs(this.dark - this.baked) > 0.04 || (this.dark !== this.baked && (this.dark === 0 || this.dark === 1))) this.bakeEnvironment();
    // lit from the physical sky, the map follows the sun (and waits for the atmosphere's tables to be ready)
    else if (this.skyLit && this.physical && this.physical.ready() && (this.envScale === 1 || sun.angleTo(this.bakedSun) > 0.006)) this.bakeEnvironment();
  }

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
  }

  apply() {
    const t = this.dark, lerp = (a, b) => a + (b - a) * t;
    this.sky.material.uniforms.uNight.value = t;
    // (realistic light: what the sun does not reach is lit by the sky itself, through the environment map; of the
    // even fill from above only a little is left)
    this.hemi.intensity = lerp(DAY.hemi, NIGHT.hemi) * (1 - 0.3 * this.golden * this.warmth * this.warmth * this.daylight) * (1 - REAL.fill * this.real * (1 - t));
    // the golden hour: with the sun low, its light is a deeper orange and stronger against the fill, and the fill
    // takes the colours of the evening sky (nothing of this by day, when warmth is 0, or once the sun is gone)
    const gold = this.golden * this.warmth * this.warmth * this.daylight;
    this.sun.intensity = DAY.sun * this.daylight * (1 + 0.35 * gold) * (1 + (REAL.sun - 1) * this.real) + NIGHT.sun * this.moonlight;
    this.sun.color.copy(DAY.sunColor).lerp(SUNSET, this.warmth).lerp(GOLD.sun, 0.75 * gold).lerp(NIGHT.sunColor, this.moonlight);
    this.hemi.color.copy(HEMI.sky).lerp(GOLD.sky, gold);
    this.hemi.groundColor.copy(HEMI.ground).lerp(GOLD.ground, gold);
    this.scene.environmentIntensity = lerp(DAY.env, NIGHT.env) * this.envScale * (1 + (REAL.sky - 1) * this.real * (this.envScale > 1 ? 1 : 0)); // (the map itself darkens with the sky)
    this.renderer.toneMappingExposure = lerp(DAY.exposure, NIGHT.exposure) * this.brightness;
    this.bloom = lerp(DAY.bloom, NIGHT.bloom);
    shared.uNight.value = this.night;
    shared.uDark.value = t;
  }
}
