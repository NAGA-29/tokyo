// The frame's post-processing: ambient occlusion, then the sky, the aerial perspective and volumetric clouds
// of @takram/three-atmosphere and @takram/three-clouds, then bloom and tone mapping. (pmndrs postprocessing:
// the takram effects are written for it.)
//
// The takram effects work in physical units on an Earth-centred frame. The scene keeps its own lights and its
// local frame: worldToECEFMatrix places it on the globe, and the colour buffer is scaled into their units
// before the effects and back after them.
import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, Effect, BloomEffect, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { WindowReflections } from './reflections.js';
import { FogEffect } from './fog.js';
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, SkyMaterial, getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere';
import { CloudsEffect, CLOUD_SHAPE_TEXTURE_SIZE, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE } from '@takram/three-clouds';
import { DataTextureLoader, Ellipsoid, Geodetic, parseUint8Array, radians, STBNLoader } from '@takram/three-geospatial';
import { shared } from './materials.js';

const ASSETS = 'assets/takram'; // cloud shape and weather textures and blue noise, as shipped with the packages
const UNITS = 0.1;              // scene radiance -> the radiance the atmosphere works in (a sunlit white wall in both)
const FADE = 500;                // metres beyond the area over which the clouds thin out to nothing
const CLOUD_GLOW = 0.6, CLOUD_NIGHT = new THREE.Vector3(0.55, 0.6, 0.8); // the clouds' own light at the horizon, and its colour by night
const FOG_DAY = new THREE.Color(0.72, 0.75, 0.79), HAZE_DAY = new THREE.Color(0.56, 0.68, 0.86), HAZE_WARM = new THREE.Color(1.05, 0.56, 0.3);
const FOG_WARM = new THREE.Color(0.85, 0.6, 0.45), FOG_NIGHT = new THREE.Color(0.035, 0.04, 0.055); // fog under the low sun, and at night
export const SHADE = 0.42;             // what is left of a surface's light under a thick cloud: the sky still lights it

// The grade of the finished picture, as a camera and a print would give it: more contrast (an S-curve), a
// little more colour, warm lights and cool shades, darker corners. Nothing at amount 0.
class Grade extends Effect {
  constructor() {
    super('Grade', `uniform float amount;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 g = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.4 * amount);
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l), g, 1.0 + 0.16 * amount);
  g += amount * (vec3(0.03, 0.012, -0.022) * smoothstep(0.45, 1.0, l) + vec3(-0.016, 0.0, 0.026) * (1.0 - smoothstep(0.0, 0.45, l)));
  g *= 1.0 - 0.26 * amount * smoothstep(0.35, 1.0, length(uv - 0.5) * 1.3);
  outputColor = vec4(mix(inputColor.rgb, pow(max(g, 0.0), vec3(2.2)), step(1e-4, amount)), inputColor.a);
}`, { uniforms: new Map([['amount', new THREE.Uniform(0)]]) });
  }
}

class Scale extends Effect {
  constructor(k) {
    super('Scale', 'uniform float k; void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(inputColor.rgb * k, inputColor.a); }',
      { uniforms: new Map([['k', new THREE.Uniform(k)]]) });
  }
}

export class Atmosphere {
  // origin: { lon, lat } of the world origin; the world is x east, y up, z south.
  // bounds: { minX, maxX, minZ, maxZ } of the area; the clouds can be kept to the sky above it.
  constructor(renderer, scene, camera, origin, bounds) {
    this.renderer = renderer;
    renderer.toneMapping = THREE.NoToneMapping; // done by the last pass

    // ---- where the scene sits on the globe
    const position = new Geodetic(radians(origin.lon), radians(origin.lat), 0).toECEF();
    const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
    Ellipsoid.WGS84.getEastNorthUpVectors(position, east, north, up);
    this.worldToECEF = new THREE.Matrix4().makeBasis(east, up, north.clone().negate()).setPosition(position);
    this.rotation = new THREE.Matrix3().setFromMatrix4(this.worldToECEF);

    // ---- sky and aerial perspective. The scene is lit by its own lights, so no post-process lighting;
    // the shadow of the clouds is laid over it instead (see below).
    const aerial = this.aerial = new AerialPerspectiveEffect(camera);
    aerial.sky = true;
    aerial.ground = false; // no dark planet below the horizon: beyond the area there is only sky
    aerial.worldToECEFMatrix.copy(this.worldToECEF);
    const hook = 'radiance = inputColor.rgb;\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)';
    const source = aerial.getFragmentShader();
    if (source.includes(hook)) aerial.setFragmentShader(source.replace(hook, `radiance = inputColor.rgb * mix(${SHADE.toFixed(2)}, 1.0, sunTransmittance);\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)`));
    else console.warn('atmosphere: the aerial perspective shader has changed; clouds will not shade the ground');
    // Blue all round: the area is an island in the sky, so a ray that leaves it downwards sees the sky mirrored
    // at the horizon (capped, so that no second sun appears below) instead of a planet's surface.
    const sky = `    outputColor.rgb = getSkyRadiance(
      vCameraPosition,
      rayDirection,`, lit = aerial.getFragmentShader();
    if (lit.includes(sky)) aerial.setFragmentShader(lit.replace(sky, `    vec3 skyUp = normalize(vCameraPosition);
    float skyBelow = min(dot(rayDirection, skyUp), 0.0);
    vec3 skyDirection = rayDirection - 2.0 * skyBelow * skyUp;
    outputColor.rgb = getSkyRadiance(
      vCameraPosition,
      skyDirection,`)
      .replace(`    outputColor.a = 1.0;
    #else // SKY`, `    if (skyBelow < 0.0) outputColor.rgb = min(outputColor.rgb, vec3(0.5));
    outputColor.a = 1.0;
    #else // SKY`));
    else console.warn('atmosphere: the sky shader has changed; the sky is not mirrored below the horizon');

    // ---- clouds: rendered into buffers that the aerial perspective composites
    const clouds = this.clouds = new CloudsEffect(camera);
    clouds.worldToECEFMatrix.copy(this.worldToECEF);
    clouds.coverage = 0.25;
    this.quality = 'high';
    clouds.localWeatherVelocity.set(0.001, 0);
    this.base = 450; // metres: the foot of the low clouds (the library's default is 750)

    // Clouds over the area only. The library spreads its weather map over the whole globe; here the map is
    // faded out beyond the area's rectangle, in the cloud pass and in the pass that renders their shadow.
    this.cityRect = new THREE.Uniform(new THREE.Vector4(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ));
    this.cityFade = new THREE.Uniform(FADE);
    const where = 'vec2 getGlobeUv(const vec3 position) {', mask = '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;';
    for (const material of [clouds.cloudsPass.currentMaterial, clouds.shadowPass.currentMaterial]) {
      const src = material.fragmentShader;
      if (!src.includes(where) || !src.includes(mask)) { console.warn('atmosphere: the cloud shader has changed; clouds are not kept to the area'); continue; }
      material.fragmentShader = src
        .replace(where, `uniform vec4 cityRect;\nuniform float cityFade;\nvec3 cityPosition;\n${where}\n  cityPosition = position;`)
        .replace(mask, `  {\n    vec3 w = (ecefToWorldMatrix * vec4(cityPosition - altitudeCorrection, 1.0)).xyz;\n    vec2 d = max(cityRect.xy - w.xz, w.xz - cityRect.zw);\n    localWeather *= 1.0 - smoothstep(0.0, cityFade, max(d.x, d.y));\n  }\n${mask}`);
      material.uniforms.cityRect = this.cityRect;
      material.uniforms.cityFade = this.cityFade;
      material.needsUpdate = true;
    }
    // Clouds that are never black. The library lights them with the sun and with the sky's light, and has
    // neither once the sun is at the horizon: a little light is added there — the afterglow at dusk and dawn,
    // the glow of the city at night (see setDate) — which is nothing by day.
    this.cloudAmbient = new THREE.Uniform(new THREE.Vector3());
    {
      const material = clouds.cloudsPass.currentMaterial, light = 'radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;';
      if (material.fragmentShader.includes(light)) {
        material.fragmentShader = material.fragmentShader.replace(light, 'radiance += (skyIrradiance * skyLightScale + cloudAmbient) * RECIPROCAL_PI4 * skyGradient;')
          .replace('uniform float skyLightScale;', 'uniform float skyLightScale;\nuniform vec3 cloudAmbient;');
        material.uniforms.cloudAmbient = this.cloudAmbient;
        material.needsUpdate = true;
      } else console.warn('atmosphere: the cloud shader has changed; clouds get no light of their own at dusk');
    }
    const pass = (property) => {
      if (property === 'atmosphereOverlay') aerial.overlay = clouds.atmosphereOverlay;
      else if (property === 'atmosphereShadow') aerial.shadow = clouds.atmosphereShadow;
      else if (property === 'atmosphereShadowLength') aerial.shadowLength = clouds.atmosphereShadowLength;
    };
    clouds.events.addEventListener('change', (e) => pass(e.property));
    this.connect = () => ['atmosphereOverlay', 'atmosphereShadow', 'atmosphereShadowLength'].forEach(pass);

    // the atmosphere's lookup tables are computed here rather than downloaded
    const generator = new PrecomputedTexturesGenerator(renderer);
    this.ready = false; // (the sky is dark until the tables are done)
    generator.update().then(() => { this.ready = true; }).catch((e) => console.error(e));
    this.textures = generator.textures;
    Object.assign(aerial, generator.textures);
    Object.assign(clouds, generator.textures);

    const repeat = (t) => { t.minFilter = THREE.LinearMipMapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; };
    const volume = (size) => new DataTextureLoader(THREE.Data3DTexture, parseUint8Array, {
      width: size, height: size, depth: size, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, wrapR: THREE.RepeatWrapping, colorSpace: THREE.NoColorSpace,
    });
    clouds.localWeatherTexture = new THREE.TextureLoader().load(`${ASSETS}/local_weather.png`, repeat);
    shared.uCloudMap.value = clouds.localWeatherTexture;
    shared.uWorldToECEF.value.copy(this.worldToECEF);
    shared.uCloudRect.value.copy(this.cityRect.value);
    clouds.turbulenceTexture = new THREE.TextureLoader().load(`${ASSETS}/turbulence.png`, repeat);
    clouds.shapeTexture = volume(CLOUD_SHAPE_TEXTURE_SIZE).load(`${ASSETS}/shape.bin`);
    clouds.shapeDetailTexture = volume(CLOUD_SHAPE_DETAIL_TEXTURE_SIZE).load(`${ASSETS}/shape_detail.bin`);
    const stbn = new STBNLoader().load(`${ASSETS}/stbn.bin`);
    clouds.stbnTexture = stbn; aerial.stbnTexture = stbn;

    // The same sky without clouds, for when they are switched off: the cloud passes then cost nothing.
    const plain = this.plain = new AerialPerspectiveEffect(camera);
    plain.sky = true;
    plain.ground = false;
    plain.worldToECEFMatrix.copy(this.worldToECEF);
    plain.setFragmentShader(aerial.getFragmentShader());
    Object.assign(plain, generator.textures);
    plain.stbnTexture = stbn;

    // ---- the passes
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));
    // window glass reflects what is on screen (first of all: it reads the panes marked in the alpha channel)
    this.reflections = new WindowReflections(camera);
    this.reflectionPass = new EffectPass(camera, this.reflections);
    this.composer.addPass(this.reflectionPass);
    // ambient occlusion: contact shading between buildings and the ground
    this.ao = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
    Object.assign(this.ao.configuration, { aoRadius: 7, distanceFalloff: 1, intensity: 2.6, halfRes: true, gammaCorrection: false });
    this.ao.configuration.color = new THREE.Color(0.02, 0.02, 0.03);
    this.composer.addPass(this.ao);
    // (each scale in a pass of its own: within one pass, postprocessing runs the effects that read depth first)
    this.composer.addPass(new EffectPass(camera, new Scale(UNITS)));
    this.cloudPass = new EffectPass(camera, clouds, aerial);
    this.composer.addPass(this.cloudPass);
    this.skyPass = new EffectPass(camera, plain);
    this.composer.addPass(this.skyPass);
    this.composer.addPass(new EffectPass(camera, new Scale(1 / UNITS)));
    // fog over the city (fog.js): no pass at all until there is some
    this.fogEffect = new FogEffect(camera);
    this.fogPass = new EffectPass(camera, this.fogEffect);
    this.fogPass.enabled = false;
    this.fogAmount = 0;
    this.composer.addPass(this.fogPass);
    this.bloom = new BloomEffect({ intensity: 0.5, luminanceThreshold: 0.9, luminanceSmoothing: 0.2, mipmapBlur: true });
    this.gradeEffect = new Grade();
    this.composer.addPass(new EffectPass(camera, this.bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }), this.gradeEffect));
    this.hazeAmount = 0;
    this.connect();
    this.sun = new THREE.Vector3(); this.moon = new THREE.Vector3();
    this.cloudsOn = false; // volumetric clouds are heavy: off until asked for
  }

  // What is left of a surface's light under a thick cloud (SHADE as designed; nearer 1: a lighter shadow). The
  // number is written into the shader: setting another compiles it again, and until one is set the shader is
  // the one made above.
  get shade() { return this.shadeNow ?? SHADE; }
  set shade(v) {
    if (v === this.shade) return;
    this.shadeNow = v;
    for (const fx of [this.aerial, this.plain]) fx.setFragmentShader(fx.getFragmentShader().replace(/mix\([0-9.]+, 1\.0, sunTransmittance\)/, `mix(${v.toFixed(2)}, 1.0, sunTransmittance)`));
  }
  // The sky as the atmosphere works it out, for an environment map (environment.js): the whole dome at the hour
  // it is, without the sun's disc (the sun is the scene's own light) and with sunlit ground below the horizon.
  // Returns { mesh: a quad that fills whatever camera looks at it, scale: its radiance into the scene's units }.
  environmentSky() {
    const material = this.skyMaterial = new SkyMaterial({ sun: false, moon: false, ground: true, groundAlbedo: new THREE.Color(0.22, 0.21, 0.19) });
    Object.assign(material, this.textures);
    material.worldToECEFMatrix.copy(this.worldToECEF);
    material.sunDirection.copy(this.sun);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    return { mesh, scale: 0.72 / UNITS }; // (a little under the sky's own strength: the picture was balanced for a dimmer one)
  }

  // How foggy the city is: 0 none .. 1 thick (a few hundred metres to be seen).
  get fog() { return this.fogAmount; }
  set fog(v) { this.fogAmount = v; this.setAir(); }
  // The haze of the distance (0 none .. 1): thin air that takes the colour of the hour — blue-white by day,
  // orange under a low sun — so that the far city glows with the sky instead of going grey.
  get haze() { return this.hazeAmount; }
  set haze(v) { this.hazeAmount = v; this.setAir(); }
  setAir() {
    const f = this.fogAmount, h = this.hazeAmount, u = this.fogEffect.uniforms;
    this.fogPass.enabled = f > 0 || h > 0;
    u.get('uDensity').value = (f > 0 ? 0.0001 + 0.0059 * f * f : 0) + 0.00009 * h;
    u.get('uHeight').value = f > 0 ? 120 + 260 * f : 420;
  }
  // How strongly the finished picture is graded (0: not at all).
  get grade() { return this.gradeEffect.uniforms.get('amount').value; }
  set grade(v) { this.gradeEffect.uniforms.get('amount').value = v; }
  // The fog's colour is the light it stands in: dark (0 day .. 1 night), warm (0 .. 1: the low sun); ground: the
  // height the fog lies on.
  lightFog(dark, warm, ground) {
    if (!this.fogPass.enabled) return;
    const u = this.fogEffect.uniforms;
    // (fog is grey; the haze of the distance has more of the sky's colour, and of the low sun's)
    const thick = Math.min(1, this.fogAmount * 3);
    u.get('uColor').value.copy(HAZE_DAY).lerp(HAZE_WARM, warm * (1 - dark)).lerp(FOG_DAY.clone().lerp(FOG_WARM, 0.55 * warm * (1 - dark)), thick).lerp(FOG_NIGHT, dark);
    u.get('uGround').value = ground;
  }

  get cloudsOn() { return this.cloudPass.enabled; }
  set cloudsOn(v) { this.cloudPass.enabled = v; this.skyPass.enabled = !v; }
  get reflect() { return this.reflectionPass.enabled; }
  set reflect(v) { this.reflectionPass.enabled = v; }
  get coverage() { return this.clouds.coverage; }
  set coverage(v) { this.clouds.coverage = v; }
  // Altitude of the base of the two low cloud layers (the second starts 250 m above the first, as by default).
  get base() { return this.clouds.cloudLayers[0].altitude; }
  set base(v) { this.clouds.cloudLayers[0].altitude = v; this.clouds.cloudLayers[1].altitude = v + 250; }
  // clouds over the area only, or over the whole sky
  get overCity() { return this.cityFade.value < 1e6; }
  set overCity(v) { this.cityFade.value = v ? FADE : 1e9; }
  get quality() { return this.cloudQuality; } // (the effect only takes a preset, it does not tell which it has)
  set quality(v) { this.cloudQuality = v; this.clouds.qualityPreset = v; }

  // Puts the sun and the moon where they stand over the area at `date`. Returns their directions in world
  // space (unit vectors, y up) for the scene's own light.
  setDate(date) {
    getSunDirectionECEF(date, this.sun);
    getMoonDirectionECEF(date, this.moon);
    for (const fx of [this.aerial, this.plain]) { fx.sunDirection.copy(this.sun); fx.moonDirection.copy(this.moon); }
    this.clouds.sunDirection.copy(this.sun);
    this.skyMaterial?.sunDirection.copy(this.sun);
    // world -> ECEF is a rotation: its transpose brings a direction back
    const toWorld = this.toWorld ??= this.rotation.clone().transpose();
    const sun = this.sun.clone().applyMatrix3(toWorld);
    // the clouds' own light (see cloudAmbient): from nothing with the sun 14 degrees up to all of it at the
    // horizon, warm while the sun is near it and a dim blue-grey in the night
    const height = THREE.MathUtils.radToDeg(Math.asin(sun.y)), low = 1 - THREE.MathUtils.smoothstep(height, 2, 14), night = 1 - THREE.MathUtils.smoothstep(height, -12, -3);
    this.cloudAmbient.value.set(1, 0.8, 0.72).lerp(CLOUD_NIGHT, night).multiplyScalar(low * THREE.MathUtils.lerp(CLOUD_GLOW, CLOUD_GLOW * 0.3, night));
    return { sun, moon: this.moon.clone().applyMatrix3(toWorld) };
  }

  setSize(w, h) { this.composer.setSize(w, h); }
  render(dt) {
    // what the water needs to mirror the clouds (materials.js)
    shared.uCloudsOn.value = this.cloudsOn ? 1 : 0;
    shared.uCloudCover.value = this.clouds.coverage;
    shared.uCloudBase.value = this.clouds.cloudLayers[0].altitude;
    shared.uCloudOffset.value.copy(this.clouds.localWeatherOffset);
    shared.uCloudFade.value = this.cityFade.value;
    this.composer.render(dt);
  }
}
