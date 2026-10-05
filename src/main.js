// Procedural Tokyo client: streams the compiled city and renders it, under a free camera.
//
// URL parameters: ?area=tokyo  ?time=18.5 (Tokyo hour; default: now)  ?night=1  ?cam=x,z,distance,azimuthDeg,elevationDeg  ?radius=3000  ?traffic=0  ?ortho=0  ?clouds=0.25 (on, with that cover)  ?birds=150  ?cars=600
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import GUI from 'lil-gui';
import { makeProjection } from './shared/geo.js';
import { createMaterials, shared, variant, setVariant } from './world/materials.js';
import { loadTextures } from './world/textures.js';
import { Streamer } from './world/streamer.js';
import { Props } from './world/props.js';
import { Signs } from './world/signs.js';
import { buildRailways } from './world/rails.js';
import { buildFlyovers } from './world/flyovers.js';
import { Traffic, MAX_CARS } from './world/traffic.js';
import { buildStructures } from './world/structures.js';
import { loadOrtho } from './world/ortho.js';
import { Environment } from './world/environment.js';
import { Atmosphere } from './world/atmosphere.js';
import { createBirds, MAX_BIRDS } from './world/birds.js';
import { loadBackdrop } from './world/backdrop.js';
import { WaterMirror } from './world/mirror.js';
import { LampLight, installLampLight } from './world/lamplight.js';

installLampLight(); // (before any material is compiled)

const params = new URLSearchParams(location.search);
const AREA = params.get('area') || 'tokyo'; // (the first of the city switch)

// The loading screen (index.html): the city's name, a bar and what is being done.
const loader = {
  el: document.getElementById('loader'),
  show(city, step = '') { this.el.classList.remove('done'); if (city) this.el.querySelector('.city').textContent = city; this.set(0, step); },
  set(fraction, step) { this.el.querySelector('.fill').style.width = `${Math.round(fraction * 100)}%`; if (step != null) this.el.querySelector('.step').textContent = step; },
  hide() { this.el.classList.add('done'); },
};
loader.show(null, 'textures'); // (index.html has already written the city's name)
const USAGE = {
  401: 'office', 402: 'commercial', 403: 'hotel', 404: 'commercial complex', 411: 'house', 412: 'apartments',
  413: 'house + shop', 414: 'apartments + shop', 415: 'house + workshop', 421: 'government', 422: 'school / hospital / culture',
  431: 'transport / warehouse', 441: 'factory', 452: 'utility', 454: 'other', 461: 'unknown',
};

// ---------------------------------------------------------------- renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.info.autoReset = false; // the composer renders several passes; count the whole frame
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 60000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
controls.minDistance = 8;
controls.maxDistance = 3500;
controls.enableZoom = false; // the wheel is handled below, with inertia

const env = new Environment(scene, renderer);
// Time of day, as Tokyo's clock (JST = UTC + 9 h): the real time, or an hour set by hand.
const clockTime = {
  live: params.get('time') == null && params.get('night') !== '1',
  hour: params.get('time') != null ? Number(params.get('time')) : params.get('night') === '1' ? 22 : 12,
  // the moment on today's Tokyo date at which its clock shows `hour`
  date() {
    const JST = 9 * 3600e3, now = Date.now();
    if (this.live) { const t = new Date(now + JST); this.hour = t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600; return new Date(now); }
    const midnight = Math.floor((now + JST) / 864e5) * 864e5 - JST;
    return new Date(midnight + this.hour * 3600e3);
  },
  // the hour and the minute on their own, for the panel; setting either stops the live clock
  get h() { return Math.floor(this.hour) % 24; },
  set h(v) { this.live = false; this.hour = v + this.m / 60; },
  get m() { return Math.floor((this.hour % 1) * 60 + 1e-6); },
  set m(v) { this.live = false; this.hour = this.h + v / 60; },
  label() { const h = this.h, m = this.m; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; },
};

const materials = createMaterials(await loadTextures(renderer));
const props = new Props();
const signs = new Signs();
const streamer = new Streamer(scene, materials, props, signs, { base: `tiles/${AREA}`, radius: Number(params.get('radius')) || 900 }); // (progressive by default: the control panel can ask for the whole city)
loader.set(0.08, 'terrain');
const manifest = await streamer.init();
loader.set(0.14, 'railways and roads');
const proj = makeProjection(manifest.origin.lon, manifest.origin.lat);
// Beyond the area: plain ground in the grey of the area's own unbuilt land, out to the haze of the horizon.
{
  const b = manifest.bounds, plain = new THREE.Mesh(new THREE.CircleGeometry(50000, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.95, metalness: 0 }));
  plain.position.set((b.minX + b.maxX) / 2, manifest.terrain.min - 1, (b.minZ + b.maxZ) / 2); // just under the lowest ground
  plain.receiveShadow = true;
  plain.name = 'plain';
  scene.add(plain);
  // an area with the land around it (mountains on the horizon): the plain becomes the sea, at sea level
  if (manifest.backdrop) {
    plain.position.y = -0.5; plain.material.color.set(0x2c4a5e); plain.material.roughness = 0.35;
    loadBackdrop(`tiles/${AREA}`, `ortho/${AREA}/backdrop`, manifest, proj, renderer).then((mesh) => scene.add(mesh));
  }
}
const birds = createBirds();
if (params.get('birds') != null) birds.geometry.instanceCount = Math.min(MAX_BIRDS, Number(params.get('birds')) || 0);
scene.add(birds);
const lampLight = new LampLight(renderer);
const waterMirror = new WaterMirror(renderer);
// post-processing: ambient occlusion, sky, aerial perspective, volumetric clouds, bloom, tone mapping
const atmosphere = new Atmosphere(renderer, scene, camera, manifest.origin, manifest.bounds);
env.sky.visible = false; // the atmosphere draws the sky (the environment map keeps its own)
const ao = atmosphere.ao;
if (params.get('reflect') === '0') atmosphere.reflect = false;
// the abstract model (see materials.js): the city as a plain model of itself, with the light as it is
// (the clouds throw the same shadow on it as on the city: see the slider in the Clouds folder)
// How dark the clouds' shadow lies on the city (0: none). The pale model shows a shadow less than the city
// does (bright surfaces stay bright), so on it the shadow is made deeper.
let cloudShadow = 0.58, shadeTimer = 0;
const applyShade = () => { atmosphere.shade = Math.round((1 - cloudShadow) * (variant.abstract ? 0.6 : 1) * 100) / 100; };
const setAbstract = (on) => { setVariant({ abstract: on }); streamer.setAbstract(on); applyShade(); };
env.lightFromSky(atmosphere.environmentSky(), () => atmosphere.ready);
if (params.get('skylight') === '1') env.skyLight = true;
if (Number(params.get('fog')) > 0) atmosphere.fog = Number(params.get('fog'));
shared.uGlintOn.value = params.get('glint') != null ? Number(params.get('glint')) : 2; // (1: as it was designed; brighter by default)
env.golden = params.get('golden') != null ? Number(params.get('golden')) : 1;
env.brightness = Number(params.get('brightness')) || 1.15; // (a little brighter than the exposure was chosen for; 1: as it was)
if (params.get('abstract') === '1') setAbstract(true);
if (params.get('landmarks') === '1') setVariant({ landmarks: true });
if (params.get('windows') === '0') setVariant({ windows: false });
if (Number(params.get('clouds')) > 0) { atmosphere.coverage = Number(params.get('clouds')); atmosphere.cloudsOn = true; }
let orthoLoaded = false, orthoWanted = true; // (the photo fills in when the tiles arrive; the panel may have switched it off by then)
if (params.get('ortho') !== '0') loadOrtho(`ortho/${AREA}`, proj, manifest.bounds, renderer).then((ok) => { orthoLoaded = ok; shared.uOrthoOn.value = ok && orthoWanted ? 1 : 0; });
const railways = await buildRailways(`tiles/${AREA}/${manifest.rails}`, (x, z) => streamer.ground(x, z), streamer.cover);
scene.add(railways);
scene.add(await buildFlyovers(`tiles/${AREA}/${manifest.roads}`, (x, z) => streamer.ground(x, z)));
if (manifest.structures) scene.add(await buildStructures(`tiles/${AREA}/${manifest.structures}`, (x, z) => streamer.ground(x, z)));
const traffic = new Traffic(await (await fetch(`tiles/${AREA}/${manifest.roads}`)).json(), streamer.surface);
if (params.get('cars') != null) traffic.count = Math.min(MAX_CARS, Number(params.get('cars')) || 0);
if (params.get('traffic') !== '0') scene.add(traffic.group);
document.getElementById('credits').textContent = manifest.attribution.map((a) => a.split(' (')[0]).join(' · ');

// initial view: the area's own, or over its origin looking north-west (Shibuya: across the Scramble Crossing to the station)
const [cx, cz, dist, az, el] = (params.get('cam') || manifest.view || '0,0,420,215,32').split(',').map(Number);
controls.target.set(cx, streamer.ground(cx, cz), cz);
camera.position.copy(controls.target).add(new THREE.Vector3().setFromSphericalCoords(
  dist, THREE.MathUtils.degToRad(90 - el), THREE.MathUtils.degToRad(az)));
controls.update();

// ---------------------------------------------------------------- control panel
let guiState, clockText;
{
  // the compiled areas (tools/pipeline/compile.mjs keeps the list); another city is another page load
  const areas = await fetch('tiles/areas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) ?? [{ id: AREA, name: manifest.name }];
  const trains = railways.userData.trains.group, AO = ao.configuration.intensity;
  const state = {
    city: AREA,
    get info() { return document.getElementById('hud').style.display !== 'none'; }, set info(v) { document.getElementById('hud').style.display = v ? '' : 'none'; },

    get traffic() { return !!traffic.group.parent; }, set traffic(v) { if (v) scene.add(traffic.group); else scene.remove(traffic.group); },
    get trains() { return trains.visible; }, set trains(v) { trains.visible = v; },
    get photo() { return orthoWanted; }, set photo(v) { orthoWanted = v; shared.uOrthoOn.value = v && orthoLoaded ? 1 : 0; },
    get shadows() { return env.sun.castShadow; }, set shadows(v) { env.sun.castShadow = v; },
    get occlusion() { return ao.configuration.intensity > 0; }, set occlusion(v) { ao.configuration.intensity = v ? AO : 0; },
    bloom: true,
    get abstract() { return variant.abstract; }, set abstract(v) { if (v !== variant.abstract) setAbstract(v); },
    get landmarks() { return variant.landmarks; }, set landmarks(v) { if (v !== variant.landmarks) setVariant({ landmarks: v }); },
    // how dark the clouds' shadow lies on the city (0: none; the number is written into a shader, so it is set
    // when the slider is let go)
    // (the number is written into a shader: it is set a moment after the slider has come to rest)
    get cloudShadow() { return cloudShadow; }, set cloudShadow(v) { cloudShadow = v; clearTimeout(shadeTimer); shadeTimer = setTimeout(applyShade, 250); },
    windowPace: 6, // how fast the lit rooms come and go (1: a room may change every 1.5 to 5.5 minutes)
    get windows() { return variant.windows; }, set windows(v) { if (v !== variant.windows) setVariant({ windows: v }); },
    // the whole city at once, or only what lies within the view radius of the point looked at (fewer tiles: more frames)
    wholeCity: false, near: Number(params.get('radius')) || 900,
    get whole() { return this.wholeCity; }, set whole(v) { this.wholeCity = v; streamer.radius = v ? 1e5 : this.near; },
    get radius() { return this.near; }, set radius(v) { this.near = v; if (!this.wholeCity) streamer.radius = v; },
  };
  guiState = state;
  // the names of the cities, for the loading screen of the next visit (index.html reads them)
  try { for (const a of areas) localStorage.setItem(`procedural-tokyo:name:${a.id}`, a.name); } catch { /* storage unavailable */ }
  const gui = new GUI({ title: 'Settings' });
  gui.close(); // (out of the way until it is asked for)
  gui.add(state, 'city', Object.fromEntries(areas.map((a) => [a.name, a.id]))).onChange((id) => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('area', id);
    loader.show(areas.find((a) => a.id === id)?.name ?? id, 'leaving for the next city');
    setTimeout(() => { location.href = url.href; }, 60); // (let the screen appear first)
  });
  const time = gui.addFolder('Time (Tokyo)');
  time.add(clockTime, 'live').name('live clock').listen();
  // one slider over the day, with the clock time written beside it in place of the number box
  const slider = time.add(clockTime, 'hour', 0, 24, 1 / 60).name('time').listen().onChange(() => { clockTime.live = false; });
  slider.$input.style.display = 'none';
  clockText = document.createElement('span');
  clockText.style.cssText = 'min-width: 3.4em; padding-left: 8px; text-align: right; font-variant-numeric: tabular-nums;';
  slider.$widget.appendChild(clockText);
  gui.add(state, 'traffic');
  gui.add(traffic, 'count', 0, MAX_CARS, 10).name('cars');
  gui.add(traffic, 'highway', 0, 20, 0.5).name('highway traffic');
  gui.add(traffic, 'headlights', 0, 20, 0.5).name('car headlights');
  gui.add(props, 'streetLights', 0, 3, 0.05).name('street lights');
  gui.add(props, 'parkLights', 0, 3, 0.05).name('park lights');
  gui.add(state, 'trains');
  gui.add(env, 'brightness', 0.5, 2, 0.05);
  gui.add(env, 'skyLight').name('light from the real sky');
  gui.add(shared.uGlintOn, 'value', 0, 5, 0.1).name('sun in the windows (strength)');
  gui.add(shared.uGlass, 'value', 0, 3, 0.05).name('window glass');
  gui.add(atmosphere, 'fog', 0, 1, 0.01);
  gui.add(env, 'golden', 0, 1.5, 0.05).name('golden hour').onChange(() => env.apply());
  gui.add(state, 'abstract').name('abstract model');
  gui.add(state, 'landmarks').name('landmarks in detail (abstract)');
  gui.add(state, 'windows');
  gui.add(state, 'photo').name('aerial photo').listen();
  gui.add(birds.geometry, 'instanceCount', 0, MAX_BIRDS, 10).name('birds');
  gui.add(state, 'info').name('info panel');
  const sky = gui.addFolder('Clouds');
  sky.add(atmosphere, 'cloudsOn').name('clouds');
  sky.add(atmosphere, 'coverage', 0, 1, 0.05);
  sky.add(state, 'cloudShadow', 0, 0.85, 0.01).name('shadow on the city');
  sky.add(atmosphere, 'base', 200, 2000, 50).name('base altitude (m)');
  sky.add(atmosphere, 'overCity').name('over the city only');
  sky.add(atmosphere, 'quality', ['low', 'medium', 'high', 'ultra']);
  sky.add(atmosphere.clouds.localWeatherVelocity, 'x', 0, 0.02, 0.0005).name('wind');
  const rooms = gui.addFolder('Night windows');
  rooms.add(shared.uRoomLight, 'value', 0, 4, 0.05).name('light strength');
  rooms.add(shared.uWindowLife.value, 'x', 0, 1, 0.05).name('rooms that change');
  rooms.add(state, 'windowPace', 0, 60, 0.5).name('pace');
  rooms.add(shared.uCityGlass, 'value', 0, 3, 0.05).name('city in tower glass');
  rooms.add(shared.uNightBlue, 'value', 0, 1, 0.05).name('blue lights');
  const walls = gui.addFolder('Wall photos');
  walls.add(shared.uPhotoMix, 'value', 0, 1, 0.05).name('amount');
  walls.add(shared.uPhotoRange.value, 'x', 0, 1000, 10).name('from (m)');
  walls.add(shared.uPhotoRange.value, 'y', 10, 2000, 10).name('full at (m)');
  const quality = gui.addFolder('Rendering');
  quality.add(state, 'whole').name('whole city');
  quality.add(state, 'radius', 300, 3000, 50).name('view radius (m), if not');
  quality.add(atmosphere, 'reflect').name('window and water reflections');
  quality.add(state, 'shadows');
  quality.add(state, 'occlusion').name('ambient occlusion');
  quality.add(state, 'bloom');

  // The panel's settings are kept (in this browser) and are the same for every city: what is switched off in
  // one is off in the next. A URL that sets something itself (?time=, ?cars=, ...) is taken as it stands.
  const KEY = 'procedural-tokyo:settings:5'; // (a new number when the defaults change: what was kept before is left behind)
  const explicit = [...params.keys()].some((k) => k !== 'area');
  const strip = (saved) => { delete saved.controllers?.city; return saved; }; // (the city is the page's, not a setting)
  if (!explicit) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (saved) {
        gui.load(strip(saved));
        // (loading the time moved the slider, which stops the live clock: put the saved choice back)
        const live = saved.folders?.['Time (Tokyo)']?.controllers?.['live clock'];
        if (live != null) clockTime.live = live;
      }
    } catch (e) { console.warn('settings not restored:', e.message); }
  }
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(strip(gui.save()))); } catch { /* storage unavailable: nothing is kept */ } };
  // (a page opened with settings in its URL is a one-off view: it does not overwrite what is kept)
  if (!explicit) { gui.onFinishChange(keep); addEventListener('pagehide', keep); }
}

// ---------------------------------------------------------------- input
const keys = new Set();
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
addEventListener('keydown', (e) => {
  const el = document.activeElement, typing = el?.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  if (typing) return; // a number being typed into the panel
  // A panel control that was clicked keeps the keyboard: the arrow keys would then step its slider or its
  // city list instead of moving the view. Movement keys always belong to the scene.
  if (MOVE_KEYS.has(e.code)) { e.preventDefault(); if (el && el !== document.body) el.blur(); }
  if (e.code === 'KeyN') { clockTime.live = false; clockTime.hour = env.dark > 0.5 ? 12 : 22; } // noon <-> night
  keys.add(e.code);
}, { capture: true });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// WASD / arrows move the focus point over the ground; speed scales with the camera distance.
function keyboardPan(dt) {
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (!f && !r) return;
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, THREE.Object3D.DEFAULT_UP);
  const speed = Math.max(20, camera.position.distanceTo(controls.target)) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 0.9);
  const move = fwd.multiplyScalar(f).addScaledVector(right, r).normalize().multiplyScalar(speed * dt);
  controls.target.add(move);
  camera.position.add(move);
}

// Wheel zoom with inertia: each notch adds to a pending amount that is paid out over the next frames,
// towards the point of the ground under the cursor.
const zoom = { pending: 0, pivot: new THREE.Vector3(), ray: new THREE.Raycaster(), plane: new THREE.Plane() };
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  const notches = (e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY) / 100;
  zoom.pending = THREE.MathUtils.clamp(zoom.pending + notches * 0.16, -1.6, 1.6);
  zoom.ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  zoom.plane.set(THREE.Object3D.DEFAULT_UP, -controls.target.y);
  const hit = zoom.ray.ray.intersectPlane(zoom.plane, new THREE.Vector3());
  // looking at the sky, or at ground far beyond the view: zoom on the focus point instead
  zoom.pivot.copy(hit && hit.distanceTo(controls.target) < camera.position.distanceTo(controls.target) * 3 ? hit : controls.target);
}, { passive: false });
function wheelZoom(dt) {
  if (Math.abs(zoom.pending) < 1e-4) { zoom.pending = 0; return; }
  const step = zoom.pending * (1 - Math.exp(-dt * 9));
  zoom.pending -= step;
  const dist = camera.position.distanceTo(controls.target), scale = THREE.MathUtils.clamp(Math.exp(step), controls.minDistance / dist, controls.maxDistance / dist);
  camera.position.sub(zoom.pivot).multiplyScalar(scale).add(zoom.pivot);
  controls.target.sub(zoom.pivot).multiplyScalar(scale).add(zoom.pivot);
}

// Click a building to inspect it.
let picked = null;
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(scene.children, true).find((h) => h.object.userData.facade);
  picked = hit ? streamer.buildingAt(hit) : null;
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  atmosphere.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- loop
const hud = document.getElementById('hud');
const clock = new THREE.Clock();
let frames = 0, fpsTime = 0, fps = 0;

let loading = true;
// one frame: everything that moves, then the picture
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  renderer.info.reset();
  keyboardPan(dt);
  wheelZoom(dt);
  controls.update();

  // keep the focus on the ground and the camera above it
  controls.target.y = streamer.ground(controls.target.x, controls.target.z);
  const floor = streamer.ground(camera.position.x, camera.position.z) + 2;
  if (camera.position.y < floor) camera.position.y = floor;

  streamer.update(controls.target, camera.position);
  // the loading screen stays until the tiles around the view are in
  if (loading) {
    const size = manifest.tileSize, wanted = manifest.tiles.filter((t) => Math.hypot((t.x + 0.5) * size - controls.target.x, (t.z + 0.5) * size - controls.target.z) <= Math.min(streamer.radius, 900)).length || 1;
    const got = Math.min(1, streamer.stats.loaded / wanted);
    loader.set(0.2 + 0.8 * got, `city tiles ${streamer.stats.loaded} / ${manifest.tiles.length}`);
    if (got >= 1) { loading = false; loader.hide(); }
  }
  // the clock the lit windows go by: it runs at their pace (and is kept small: the shader counts in floats)
  shared.uWindowLife.value.y = (shared.uWindowLife.value.y + dt * (guiState?.windowPace ?? 6)) % 1e5;
  props.update(dt);
  if (birds.geometry.instanceCount) birds.userData.update(dt, controls.target, camera, streamer);
  signs.update();
  railways.userData.trains.update(dt, env.night);
  if (traffic.group.parent) traffic.update(dt, controls.target);
  env.setSky(...Object.values(atmosphere.setDate(clockTime.date())));
  clockText.textContent = clockTime.label();
  env.update(dt);
  env.follow(controls.target, camera);
  lampLight.update(scene, controls.target, camera.position, env.night);
  atmosphere.bloom.intensity = guiState.bloom ? env.bloom * 3 : 0;
  waterMirror.enabled = atmosphere.reflect && !variant.abstract; // (the abstract model's water mirrors nothing)
  waterMirror.update(scene, camera, streamer.tiles, controls.target, [traffic.group.parent ? null : traffic.group]);
  atmosphere.lightFog(env.dark, env.warmth * env.daylight, controls.target.y);
  atmosphere.render(dt);

  frames++; fpsTime += dt;
  if (fpsTime >= 0.5) { fps = frames / fpsTime; frames = 0; fpsTime = 0; }
  const s = streamer.stats, info = renderer.info.render;
  const [lon, lat] = proj.unproject(controls.target.x, controls.target.z);
  hud.textContent =
    `${manifest.name}  ${lat.toFixed(5)}N ${lon.toFixed(5)}E  ${controls.target.y.toFixed(1)} m\n` +
    `Tokyo ${clockTime.label()}${clockTime.live ? ' (live)' : ''} · sun ${env.elevation.toFixed(0)}°\n` +
    `${fps.toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1e6).toFixed(2)}M tris\n` +
    `tiles ${s.loaded}/${manifest.tiles.length}${streamer.pending ? ` (+${streamer.pending})` : ''} · ${s.buildings} buildings\n` +
    (picked ? `\n▸ ${USAGE[picked.usage] ?? 'usage ' + picked.usage}, ${picked.height.toFixed(1)} m` +
      `${picked.storeys ? `, ${picked.storeys} floors` : ''}, base ${picked.base.toFixed(1)} m\n` : '') +
    `\ndrag pan · right-drag rotate · wheel zoom\nWASD move (shift fast) · N day/night · click building`;
}
function frame() { tick(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);

// (for the console and for tools: tick() draws a frame by hand, clockTime sets the hour)
window.__app = { scene, camera, controls, streamer, env, renderer, materials, ao, atmosphere, traffic, shared, tick, clockTime };
