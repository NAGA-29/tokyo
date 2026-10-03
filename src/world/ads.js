// Billboards and LED screens (sign styles 3-5, placed by tools/pipeline/signs.mjs). The artwork is
// invented — sixteen posters drawn once into an atlas — and a screen cycles through them with a wipe,
// seen through an LED grid. Boards are lit at night; screens are bright all day.
import * as THREE from 'three';
import { shared } from './materials.js';

const CELLS = 4, SIZE = 512;
const FONT = '"Yu Gothic", "Meiryo", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
const SLOGANS = ['新発売', '大特価', '春の祭', '東京', '音楽', '夢', '旅', '夏', '光', '未来'];
const WORDS = ['NEON', 'HELLO!', 'TOKYO NIGHT', 'SUPER FRESH', 'MEGA SALE', 'NEW', 'LIVE', 'GO!', 'OPEN'];
const PALETTES = [
  ['#e4002b', '#ffffff', '#ffd400'], ['#0b1d51', '#00d1ff', '#ffffff'], ['#ffd400', '#111111', '#e4002b'], ['#111111', '#ff2e88', '#ffffff'],
  ['#00a676', '#ffffff', '#ffe066'], ['#ff6b00', '#ffffff', '#1a1a1a'], ['#7b2ff7', '#f107a3', '#ffffff'], ['#f4f1ea', '#e4002b', '#111111'],
];

function atlas() {
  const c = document.createElement('canvas');
  c.width = c.height = CELLS * SIZE;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < CELLS * CELLS; i++) {
    const [bg, a, b] = PALETTES[i % PALETTES.length], S = SIZE;
    g.save();
    g.translate((i % CELLS) * S, Math.floor(i / CELLS) * S);
    g.beginPath(); g.rect(0, 0, S, S); g.clip();
    const grad = g.createLinearGradient(0, 0, S, S);
    grad.addColorStop(0, bg); grad.addColorStop(1, a);
    g.fillStyle = i % 3 === 0 ? grad : bg; g.fillRect(0, 0, S, S);
    // a graphic: sun, stripes, burst or blocks
    g.fillStyle = b; g.strokeStyle = a; g.lineWidth = 26;
    const kind = i % 4;
    if (kind === 0) { g.beginPath(); g.arc(S * 0.7, S * 0.36, S * 0.24, 0, Math.PI * 2); g.fill(); }
    else if (kind === 1) for (let k = -2; k < 8; k++) { g.beginPath(); g.moveTo(k * 90, S); g.lineTo(k * 90 + 220, 0); g.stroke(); }
    else if (kind === 2) for (let k = 0; k < 14; k++) { g.save(); g.translate(S * 0.3, S * 0.4); g.rotate((k * Math.PI) / 7); g.fillRect(0, -9, S * 0.36, 18); g.restore(); }
    else { g.fillRect(S * 0.08, S * 0.1, S * 0.3, S * 0.3); g.fillStyle = a; g.fillRect(S * 0.42, S * 0.1, S * 0.5, S * 0.14); }
    // a slogan: vertical kanji, or a Latin word across the bottom
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (i % 2 === 0) {
      const text = [...pick(SLOGANS)], size = Math.min(170, (S * 0.84) / text.length);
      g.font = `900 ${size}px ${FONT}`; g.lineWidth = 12; g.strokeStyle = bg; g.fillStyle = kind === 0 ? a : b;
      text.forEach((ch, k) => { const y = S * 0.5 + (k - (text.length - 1) / 2) * size * 1.02; g.strokeText(ch, S * 0.26, y); g.fillText(ch, S * 0.26, y); });
    } else {
      const text = pick(WORDS);
      g.font = `900 ${S * 0.2}px ${FONT}`;
      const w = g.measureText(text).width, k = Math.min(1, (S * 0.9) / w);
      g.translate(S / 2, S * 0.78); g.scale(k, 1);
      g.lineWidth = 12; g.strokeStyle = bg; g.strokeText(text, 0, 0); g.fillStyle = b; g.fillText(text, 0, 0);
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export class Ads {
  constructor() {
    // uv: position within the board (0-1); aAd: x poster index, y 1 for a screen, z seed
    this.material = new THREE.MeshStandardMaterial({ map: atlas(), roughness: 0.5 });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = shared.uNight;
      shader.uniforms.uTime = shared.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aAd;\nvarying vec3 vAd;\nvarying vec2 vBoard;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAd = aAd;\nvBoard = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
          uniform float uNight, uTime;
          varying vec3 vAd;
          varying vec2 vBoard;
          vec3 gAd;
          vec3 poster(float index) {
            float i = mod(floor(index + 0.5), ${CELLS * CELLS}.0); // the index is interpolated: round it
            vec2 cell = vec2(mod(i, ${CELLS}.0), ${CELLS - 1}.0 - floor(i / ${CELLS}.0));
            return texture2D(map, (cell + clamp(vBoard, 0.004, 0.996)) / ${CELLS}.0).rgb;
          }`)
        .replace('#include <map_fragment>', `
          gAd = poster(vAd.x);
          if (vAd.y > 0.5) {
            // a screen: the next poster wipes in every few seconds; LED pixels show close up
            float t = uTime * 0.16 + vAd.z * 9.0, wipe = smoothstep(0.86, 1.0, fract(t));
            gAd = mix(poster(vAd.x + floor(t)), poster(vAd.x + floor(t) + 1.0), step(vBoard.x, wipe));
            vec2 led = fract(vBoard * vec2(160.0, 90.0));
            float fine = max(fwidth(vBoard.x * 160.0), fwidth(vBoard.y * 90.0));
            gAd *= mix(0.72 + 0.5 * step(0.22, led.x) * step(0.22, led.y), 1.0, smoothstep(0.3, 1.0, fine));
          }
          diffuseColor.rgb *= gAd;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gAd * (vAd.y > 0.5 ? 0.9 + 0.5 * uNight : 0.06 + 1.1 * uNight);`);
    };
    this.frame = new THREE.MeshStandardMaterial({ color: 0x2a2c2f, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
  }

  // ads: signs of style 3 (billboard on a wall), 4 (screen on a wall), 5 (billboard on a frame on the roof).
  build(ads) {
    const pos = [], uv = [], ad = [], frame = [];
    for (const s of ads) {
      const rx = s.nz, rz = -s.nx, out = 0.3; // reader's right; boards stand a little off the wall
      const P = (side, up, off = out) => [s.x + rx * side * s.w / 2 + s.nx * off, s.y + (up - 0.5) * s.h, s.z + rz * side * s.w / 2 + s.nz * off];
      const corners = [P(-1, 0), P(1, 0), P(1, 1), P(-1, 0), P(1, 1), P(-1, 1)];
      for (const c of corners) pos.push(...c);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      const seed = (Math.abs(s.x * 0.37 + s.z * 0.91) % 1);
      for (let i = 0; i < 6; i++) ad.push(s.color, s.style === 4 ? 1 : 0, seed);
      // a dark casing behind the board, and legs under a rooftop one
      const back = [P(-1.03, -0.03, out - 0.08), P(1.03, -0.03, out - 0.08), P(1.03, 1.03, out - 0.08), P(-1.03, 1.03, out - 0.08)];
      frame.push(...back[0], ...back[1], ...back[2], ...back[0], ...back[2], ...back[3]);
      if (s.style === 5) for (const side of [-0.8, 0, 0.8]) {
        const a = P(side - 0.03, 0, out - 0.1), b = P(side + 0.03, 0, out - 0.1), legs = 1.6;
        frame.push(a[0], a[1] - legs, a[2], b[0], b[1] - legs, b[2], ...b, a[0], a[1] - legs, a[2], ...b, ...a);
      }
    }
    const group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aAd', new THREE.Float32BufferAttribute(ad, 3));
    geo.computeVertexNormals();
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.Float32BufferAttribute(frame, 3));
    fgeo.computeVertexNormals();
    group.add(new THREE.Mesh(fgeo, this.frame), new THREE.Mesh(geo, this.material));
    return group;
  }
}
