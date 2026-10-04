// 원경(플레이 지도 밖, 지평선까지): 초원 농경지 특유의 방풍림 격자 + 마을 실루엣(집·창고·나무) + 곡물 엘리베이터(사일로)
// + 고압 송전선(격자 철탑·늘어진 전선) + 나무 전신주. 모두 대기 원근(안개)으로 흐려진다.
//
// 먼 숲띠는 가까운 나무와 같은 임포스터 아틀라스(trees/Impostors.js)를 조각 셰이더에서 줄지어 합성한다:
// 띠를 따라 3줄, 약 3 m 간격으로 나무를 해시로 고르고(수종 구성은 띠마다 다름, 빈자리·고사목 포함) 해당 칸을 표본.
// → 가까운 숲띠와 같은 나무 모양·색·물듦이 지평선까지 이어지고, 같은 띠가 반복돼 보이지 않는다.

import * as THREE from 'three';
import { U, commonGLSL, patchMaterial } from './shaderLib.js';
import { Random } from '../core/Random.js';
import { WORLD } from '../data/world.js';
import { TREE_SPECIES } from '../data/trees.js';

const SP = ['poplar', 'locust', 'elm', 'maple', 'ash'];
// 띠 수종 구성(누적 확률: 포플러, 아카시아, 느릅, 단풍, 물푸레, 나머지 고사목)
const MIXES = [
  [0.5, 0.6, 0.8, 0.85, 0.96],
  [0.0, 0.3, 0.75, 0.85, 0.95],
  [0.1, 0.65, 0.9, 0.95, 0.97],
  [0.4, 0.45, 0.6, 0.65, 0.96],
];

const BELT_VS = /* glsl */ `
#include <common>
${commonGLSL()}
attribute vec2 aS;   // 띠를 따라 m, 땅 위 높이 m
attribute vec4 aW;   // 띠 시드, 수종 구성 번호, 나무 높이 배수, 0
varying vec2 vS;
varying vec4 vW;
varying vec3 vWP;
void main() {
  vS = aS;
  vW = aW;
  vWP = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

function beltFS(tplStart, tplCount, spH, spTint, spAut, mixes) {
  const f = (a) => a.map((x) => x.toFixed(3)).join(', ');
  return /* glsl */ `
#include <common>
${commonGLSL()}
uniform sampler2D uImpA;
uniform sampler2D uImpB;
uniform vec4 uImpTpl[24];
uniform vec2 uImpGrid;
uniform vec3 uAutumnCol[10];
uniform vec3 uBarkAvg[10];
varying vec2 vS;
varying vec4 vW;
varying vec3 vWP;
const int TPL_START[6] = int[6](${tplStart.join(', ')});
const int TPL_COUNT[6] = int[6](${tplCount.join(', ')});
const float SP_H[6] = float[6](${f(spH)});
const vec3 SP_TINT[6] = vec3[6](${spTint.map((t) => `vec3(${f(t)})`).join(', ')});
const float SP_AUT[6] = float[6](${f(spAut)});
const float MIX[${mixes.length * 5}] = float[${mixes.length * 5}](${mixes.flat().map((x) => x.toFixed(3)).join(', ')});
// 정수 넘침 없이(띠 번호 < 4096, 칸 번호 < 5000)
float hh(int a, int b, int c) { return hash2i(ivec2(a * 131 + c * 7919, b * 977 + c)); }
void main() {
  float s = vS.x;
  float y = vS.y;
  int wall = int(vW.x * 4095.0);
  int mixI = int(vW.y + 0.5);
  // 밉맵 단계: 화소당 미터 → 아틀라스 텍셀(칸 96 화소 ≈ 나무 폭 약 10 m)
  float mpp = max(length(vec2(dFdx(s), dFdy(s))), length(vec2(dFdx(y), dFdy(y))));
  float lod = clamp(log2(max(mpp * 96.0 / 10.0, 1.0)), 0.0, 6.0);
  vec4 hit = vec4(0.0);
  vec4 nrm = vec4(0.0);
  int hitSp = 0;
  float hitAut = 0.0;
  vec3 hitTint = vec3(0.0);
  float hitYaw = 0.0;
  // 4줄(가장자리 줄은 조금 낮음), 약 2.6 m 간격 — 옆에서 보면 수관이 겹쳐 한 덩어리
  for (int row = 0; row < 4 && hit.a < 0.5; row++) {
    float spacing = 2.6 + float(row) * 0.2;
    float off = fract(vW.x * 13.1 + float(row) * 0.37) * spacing;
    float c0 = floor((s - off) / spacing);
    for (int dc = -2; dc <= 2; dc++) {
      int ci = int(c0) + dc;
      float r0 = hh(ci, row, wall);
      if (r0 < 0.08) continue; // 빈자리
      float r1 = hh(ci, row + 7, wall);
      int sp = 5;
      for (int k = 0; k < 5; k++) { if (r1 < MIX[mixI * 5 + k]) { sp = k; break; } }
      float r2 = hh(ci, row + 13, wall);
      int ti = TPL_START[sp] + min(TPL_COUNT[sp] - 1, int(r2 * float(TPL_COUNT[sp])));
      vec4 info = uImpTpl[ti];
      float r3 = hh(ci, row + 19, wall);
      // 띠 끝·틈 쪽은 낮게(어린나무), 줄마다 키 차이
      float H = SP_H[sp] * mix(0.78, 1.15, r3) * vW.z * ((row == 1 || row == 2) ? 1.0 : 0.86);
      float scale = H / max(info.w, 1.0);
      float r4 = hh(ci, row + 23, wall);
      float xc = off + (float(ci) + 0.5 + (r4 - 0.5) * 0.6) * spacing;
      float wk = mix(0.95, 1.4, hh(ci, row + 47, wall));
      float u = (s - xc) / (info.x * scale * wk) + 0.5;
      float v = (y - info.z * scale) / (info.y * scale);
      if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) continue;
      float r5 = hh(ci, row + 29, wall);
      float fr = float(ti * 8 + int(r5 * 7.99));
      vec2 uv = (vec2(mod(fr, uImpGrid.x), floor(fr / uImpGrid.x)) + vec2(u, v)) / uImpGrid;
      vec4 k0 = textureLod(uImpA, uv, lod);
      if (k0.a > 0.42) {
        hit = k0;
        nrm = textureLod(uImpB, uv, lod);
        hitSp = sp;
        float r6 = hh(ci, row + 31, wall);
        hitAut = r6 < SP_AUT[sp] ? mix(0.25, 0.7, hh(ci, row + 37, wall)) : hh(ci, row + 41, wall) * 0.18;
        hitTint = SP_TINT[sp] * (0.88 + 0.24 * hh(ci, row + 43, wall));
        hitYaw = r4 * 6.2831853;
        break;
      }
    }
  }
  if (hit.a < 0.5) {
    // 줄기 사이 밑동: 관목·어린나무 층(어둡고 들쭉날쭉)
    float hS = (1.6 + 1.8 * vnoise(vec2(s * 0.18 + float(wall), 3.7)) + 0.6 * vnoise(vec2(s * 0.9, 1.3))) * vW.z;
    if (y > hS) discard;
    float n = vnoise(vec2(s * 1.7, y * 2.3 + float(wall)));
    vec3 alb = mix(vec3(0.05, 0.07, 0.03), vec3(0.09, 0.1, 0.05), n);
    vec3 col = alb * RECIPROCAL_PI * (sunE() * 0.25 * cloudShadow(vWP) + shIrradiance(vec3(0.0, 0.3, 0.95)) * 0.6);
    gl_FragColor = vec4(applyFog(col, vWP), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  float ia = 1.0 / hit.a;
  float key = hit.r * ia;
  float mat = hit.g * ia;
  float thr = hit.b * ia * 1.4;
  vec3 nt = normalize(nrm.rgb * ia * 2.0 - 1.0);
  float ao = nrm.a * ia;
  float c = cos(hitYaw), sn = sin(hitYaw);
  vec3 N = vec3(nt.x * c - nt.z * sn, nt.y, nt.x * sn + nt.z * c);
  int spI = hitSp == 5 ? 5 : hitSp;
  vec3 alb;
  if (mat < 0.25) {
    vec3 leaf = hitTint * key * 1.6;
    float yel = smoothstep(thr - 0.12, thr + 0.12, hitAut * 1.3);
    alb = mix(leaf, uAutumnCol[spI] * key * 1.6 * 0.95, yel);
  } else {
    alb = uBarkAvg[spI] * key * 2.0;
  }
  vec3 L = uSunDir;
  float diff = max(0.0, (dot(N, L) + 0.45) / 1.45);
  float selfSun = smoothstep(-0.6, 0.4, dot(N, L));
  vec3 col = alb * RECIPROCAL_PI * (sunE() * diff * mix(1.0, selfSun, 0.6) * cloudShadow(vWP) + shIrradiance(N) * ao);
  gl_FragColor = vec4(col, 1.0);
  gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWP);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

// ---------------------------------------------------------------------------
function latticeTexture() {
  // 격자 철탑(고압 송전 220 kV 급, 높이 약 30 m): 다리 4개가 위로 좁아지고, 팔 2단, X자 가새
  const W = 256;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgb(150,154,156)';
  g.lineCap = 'round';
  const leg = (t) => {
    // t: 0 = 바닥, 1 = 꼭대기 → 양쪽 다리 x
    const w = t < 0.62 ? 0.42 - 0.34 * (t / 0.62) : 0.08 - 0.04 * ((t - 0.62) / 0.38);
    return [W * (0.5 - w), W * (0.5 + w)];
  };
  const Y = (t) => H * (1 - t);
  g.lineWidth = 5;
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const [a] = leg(t);
    i ? g.lineTo(a, Y(t)) : g.moveTo(a, Y(t));
  }
  g.stroke();
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const [, b] = leg(t);
    i ? g.lineTo(b, Y(t)) : g.moveTo(b, Y(t));
  }
  g.stroke();
  // 가새(X자) 패널
  g.lineWidth = 2.5;
  const panels = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.58, 0.66, 0.74, 0.82, 0.9, 1.0];
  for (let i = 0; i < panels.length - 1; i++) {
    const t0 = panels[i];
    const t1 = panels[i + 1];
    const [a0, b0] = leg(t0);
    const [a1, b1] = leg(t1);
    g.beginPath();
    g.moveTo(a0, Y(t0));
    g.lineTo(b1, Y(t1));
    g.moveTo(b0, Y(t0));
    g.lineTo(a1, Y(t1));
    g.moveTo(a1, Y(t1));
    g.lineTo(b1, Y(t1));
    g.stroke();
  }
  // 팔(가로대) 2단 + 애자
  g.lineWidth = 4;
  for (const [t, w] of [
    [0.72, 0.48],
    [0.86, 0.36],
  ]) {
    g.beginPath();
    g.moveTo(W * (0.5 - w), Y(t));
    g.lineTo(W * (0.5 + w), Y(t));
    g.stroke();
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(W * (0.5 - w), Y(t));
    g.lineTo(W * 0.5, Y(t + 0.05));
    g.lineTo(W * (0.5 + w), Y(t));
    g.stroke();
    g.lineWidth = 4;
    for (const sx of [-w, w]) {
      g.fillStyle = 'rgb(120,120,110)';
      g.fillRect(W * (0.5 + sx) - 3, Y(t), 6, 22);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function addBox(arr, cx, cy, cz, sx, sy, sz, ang, col) {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const P = (x, y, z) => [cx + x * ca - z * sa, cy + y, cz + x * sa + z * ca];
  const hx = sx / 2;
  const hz = sz / 2;
  const v = [P(-hx, 0, -hz), P(hx, 0, -hz), P(hx, 0, hz), P(-hx, 0, hz), P(-hx, sy, -hz), P(hx, sy, -hz), P(hx, sy, hz), P(-hx, sy, hz)];
  // 바깥에서 볼 때 반시계(앞면이 바깥)
  const faces = [
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
    [4, 7, 6, 5],
  ];
  for (const f of faces) arr.quad(v[f[0]], v[f[1]], v[f[2]], v[f[3]], col);
}

class MeshBuilder {
  constructor() {
    this.pos = [];
    this.col = [];
  }
  tri(a, b, c, col) {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(...col);
  }
  quad(a, b, c, d, col) {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export class DistantScenery {
  /**
   * @param {THREE.Scene} scene
   * @param {(x:number, z:number) => number} terrainHeight 원경 지형 높이
   * @param {object} imp 나무 임포스터 정보(TreeRenderer.impostorInfo)
   */
  constructor(scene, terrainHeight, imp) {
    this.scene = scene;
    this.h = terrainHeight;
    const D = WORLD.distant;
    this.rng = new Random(WORLD.seed ^ 0x77);
    this._belts(D, imp);
    this._villages(D);
    this._powerLines(D);
  }

  // ---- 먼 숲띠 ----
  _belts(D, imp) {
    const rng = this.rng;
    const pos = [];
    const aS = [];
    const aW = [];
    const idx = [];
    const inner = WORLD.mapHalf + 60;
    const H = 28;
    const addWall = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(2, Math.ceil(len / 30));
      const seed = rng.next();
      const mixI = rng.int(0, MIXES.length - 1);
      const hk = rng.range(0.85, 1.12);
      const base = pos.length / 3;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        const y = this.h(x, z) - 0.3;
        // 띠 끝 30 m는 낮게(어린나무·관목)
        const endK = Math.min(1, Math.min(t * len, (1 - t) * len) / 30);
        const hh = H * (0.45 + 0.55 * endK);
        pos.push(x, y, z, x, y + hh, z);
        aS.push(t * len, 0, t * len, hh);
        aW.push(seed, mixI, hk * (0.45 + 0.55 * endK), 0, seed, mixI, hk * (0.45 + 0.55 * endK), 0);
      }
      for (let i = 0; i < n; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    };
    // 마을 길가·정원 나무(짧은 띠 몇 줄)
    for (const v of D.villages) {
      const ca = Math.cos(v.ang);
      const sa = Math.sin(v.ang);
      for (const off of [-48, 46, -105, 98]) {
        const a0 = -v.radius * rng.range(0.7, 1.0);
        const a1 = v.radius * rng.range(0.7, 1.0);
        let a = a0;
        while (a < a1) {
          const b = Math.min(a1, a + rng.range(40, 140));
          addWall(v.x + a * ca - off * sa, v.z + a * sa + off * ca, v.x + b * ca - off * sa, v.z + b * sa + off * ca);
          a = b + rng.range(10, 50);
        }
      }
    }
    const E = D.extent;
    const spacing = D.spacing;
    for (let z = -E; z <= E; z += spacing) {
      const zz = z + rng.range(-40, 40);
      let x = -E;
      while (x < E) {
        const seg = rng.range(500, 1300);
        const x1 = Math.min(E, x + seg);
        const crosses = Math.abs(zz) < inner && x1 > -inner && x < inner;
        if (!crosses && rng.next() > 0.12) addWall(x, zz, x1, zz);
        x = x1 + rng.range(30, 120);
      }
    }
    for (let x = -E; x <= E; x += spacing * 3.3) {
      const xx = x + rng.range(-60, 60);
      let z = -E;
      while (z < E) {
        const seg = rng.range(300, 900);
        const z1 = Math.min(E, z + seg);
        const crosses = Math.abs(xx) < inner && z1 > -inner && z < inner;
        if (!crosses && rng.next() > 0.45) addWall(xx, z, xx, z1);
        z = z1 + rng.range(200, 700);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 2));
    geo.setAttribute('aW', new THREE.Float32BufferAttribute(aW, 4));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    // 수종 → 템플릿 번호 범위
    const start = [];
    const count = [];
    for (const k of [...SP, 'snag']) {
      const list = imp.bySpecies[k];
      start.push(list[0]);
      count.push(list.length);
    }
    const spH = [22, 15.5, 12.5, 9, 13.5, 12];
    const spTint = SP.map((k) => TREE_SPECIES[k].leaf).concat([[0.1, 0.1, 0.08]]);
    const spAut = SP.map((k) => TREE_SPECIES[k].autumnChance).concat([0]);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...U, ...imp.speciesUniforms, uImpA: { value: imp.key }, uImpB: { value: imp.normal }, uImpTpl: { value: imp.tplInfo }, uImpGrid: { value: imp.grid } },
      vertexShader: BELT_VS,
      fragmentShader: beltFS(start, count, spH, spTint, spAut, MIXES),
      side: THREE.DoubleSide,
    });
    mat.name = 'distant-belts';
    this.beltMesh = new THREE.Mesh(geo, mat);
    this.beltMesh.frustumCulled = false;
    this.scene.add(this.beltMesh);
    this.beltInfo = { walls: idx.length / 6 };
  }

  // ---- 마을·곡물 엘리베이터 ----
  _villages(D) {
    const rng = new Random(WORLD.seed ^ 0x51a9);
    const mb = new MeshBuilder();
    const wallCols = [
      [0.62, 0.6, 0.55],
      [0.55, 0.52, 0.44],
      [0.5, 0.56, 0.6],
      [0.6, 0.55, 0.42],
      [0.42, 0.36, 0.3],
    ];
    const roofCols = [
      [0.22, 0.24, 0.26],
      [0.34, 0.18, 0.13],
      [0.2, 0.3, 0.26],
      [0.4, 0.4, 0.42],
    ];
    for (const v of D.villages) {
      const n = v.houses;
      for (let i = 0; i < n; i++) {
        // 길을 따라 늘어선 집(두 줄) + 몇 채는 안쪽
        const along = rng.range(-v.radius, v.radius);
        const side = rng.chance(0.5) ? 1 : -1;
        const off = side * rng.range(14, 30) + (rng.chance(0.25) ? side * rng.range(30, 90) : 0);
        const ca = Math.cos(v.ang);
        const sa = Math.sin(v.ang);
        const x = v.x + along * ca - off * sa;
        const z = v.z + along * sa + off * ca;
        const y = this.h(x, z) - 0.2;
        const w = rng.range(6, 10);
        const d = rng.range(8, 12);
        const hW = rng.range(2.8, 3.4);
        const col = wallCols[rng.int(0, wallCols.length - 1)].map((c) => c * rng.range(0.85, 1.1));
        const rc = roofCols[rng.int(0, roofCols.length - 1)].map((c) => c * rng.range(0.85, 1.15));
        const ang = v.ang + (rng.chance(0.85) ? 0 : Math.PI / 2) + rng.range(-0.05, 0.05);
        addBox(mb, x, y, z, w, hW, d, ang, col);
        // 박공지붕
        const ridge = rng.range(2.0, 3.0);
        const c2 = Math.cos(ang);
        const s2 = Math.sin(ang);
        const P = (px, py, pz) => [x + px * c2 - pz * s2, y + py, z + px * s2 + pz * c2];
        const hx = w / 2 + 0.4;
        const hz = d / 2 + 0.4;
        mb.quad(P(-hx, hW, -hz), P(-hx, hW, hz), P(0, hW + ridge, hz), P(0, hW + ridge, -hz), rc);
        mb.quad(P(hx, hW, hz), P(hx, hW, -hz), P(0, hW + ridge, -hz), P(0, hW + ridge, hz), rc);
        mb.tri(P(-hx + 0.4, hW, -hz + 0.4), P(0, hW + ridge, -hz + 0.4), P(hx - 0.4, hW, -hz + 0.4), col);
        mb.tri(P(hx - 0.4, hW, hz - 0.4), P(0, hW + ridge, hz - 0.4), P(-hx + 0.4, hW, hz - 0.4), col);
        // 헛간·창고
        if (rng.chance(0.4)) addBox(mb, x - s2 * (d * 0.9), y, z + c2 * (d * 0.9), rng.range(4, 7), rng.range(2.2, 3), rng.range(4, 6), ang, [0.36, 0.32, 0.27]);
      }
      // 큰 창고(콜호스 축사) 몇 동
      for (let i = 0; i < 3; i++) {
        const x = v.x + rng.range(-v.radius, v.radius) * 0.8 + Math.cos(v.ang + 1.57) * rng.range(90, 160);
        const z = v.z + rng.range(-v.radius, v.radius) * 0.3 + Math.sin(v.ang + 1.57) * rng.range(90, 160);
        addBox(mb, x, this.h(x, z) - 0.2, z, rng.range(12, 18), rng.range(4.5, 6), rng.range(45, 75), v.ang + rng.range(-0.1, 0.1), [0.48, 0.47, 0.45]);
      }
      // 곡물 엘리베이터: 원통 사일로 2줄 + 높은 작업탑
      if (v.elevator) {
        const e = v.elevator;
        const y = this.h(e.x, e.z) - 0.3;
        const conc = [0.62, 0.61, 0.58];
        const seg = 10;
        for (let r = 0; r < 2; r++) {
          for (let k = 0; k < 5; k++) {
            const cx = e.x + k * 8.2;
            const cz = e.z + r * 8.2;
            const R = 3.9;
            const H = 28;
            for (let s = 0; s < seg; s++) {
              const a0 = (s / seg) * Math.PI * 2;
              const a1 = ((s + 1) / seg) * Math.PI * 2;
              const p0 = [cx + Math.cos(a0) * R, y, cz + Math.sin(a0) * R];
              const p1 = [cx + Math.cos(a1) * R, y, cz + Math.sin(a1) * R];
              mb.quad(p0, [p0[0], y + H, p0[2]], [p1[0], y + H, p1[2]], p1, conc.map((c) => c * (0.92 + 0.08 * Math.cos(a0))));
              mb.tri([p0[0], y + H, p0[2]], [cx, y + H + 1, cz], [p1[0], y + H, p1[2]], [0.5, 0.5, 0.48]);
            }
          }
        }
        addBox(mb, e.x + 41, y, e.z + 4, 9, 46, 9, 0, [0.58, 0.57, 0.55]);
        addBox(mb, e.x + 41, y + 46, e.z + 4, 6, 5, 6, 0, [0.5, 0.48, 0.45]);
      }
      // 마을 나무(정원·길가): 먼 숲띠와 같은 셰이더로 짧은 띠 몇 줄
    }
    const geo = mb.geometry();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    patchMaterial(mat, { key: 'distantBuildings', noCanopy: true });
    this.buildings = new THREE.Mesh(geo, mat);
    this.buildings.frustumCulled = false;
    this.scene.add(this.buildings);
  }

  // ---- 송전선(격자 철탑 + 늘어진 전선), 나무 전신주 ----
  _powerLines(D) {
    const lattice = latticeTexture();
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    const towers = [];
    const wires = [];
    const poles = [];
    for (const line of D.powerLines) {
      const dx = line.to[0] - line.from[0];
      const dz = line.to[1] - line.from[1];
      const L = Math.hypot(dx, dz);
      const n = Math.floor(L / line.span);
      const ux = dx / L;
      const uz = dz / L;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const x = line.from[0] + ux * i * line.span;
        const z = line.from[1] + uz * i * line.span;
        // 플레이 지도 안은 지나지 않는다
        if (Math.abs(x) < WORLD.mapHalf + 40 && Math.abs(z) < WORLD.mapHalf + 40) {
          pts.push(null);
          continue;
        }
        pts.push([x, this.h(x, z), z]);
      }
      for (const p of pts) if (p) towers.push({ p, ang: Math.atan2(uz, ux), h: line.height, w: line.height * 0.42, wood: line.wood });
      // 전선: 팔 끝(양쪽 + 위) 사이 현수선(처짐 약 경간의 2 %)
      const arms = line.wood
        ? [
            [-0.7, 0.95],
            [0.7, 0.95],
          ]
        : [
            [-0.48, 0.72],
            [0.48, 0.72],
            [-0.36, 0.86],
            [0.36, 0.86],
          ];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) continue;
        for (const [side, hk] of arms) {
          const off = line.wood ? side : side * line.height * 0.42;
          const ax = a[0] - uz * off;
          const az = a[2] + ux * off;
          const bx = b[0] - uz * off;
          const bz = b[2] + ux * off;
          const ay = a[1] + line.height * hk;
          const by = b[1] + line.height * hk;
          const sag = line.span * 0.02;
          const K = 14;
          for (let k = 0; k < K; k++) {
            const t0 = k / K;
            const t1 = (k + 1) / K;
            const y0 = ay + (by - ay) * t0 - sag * 4 * t0 * (1 - t0);
            const y1 = ay + (by - ay) * t1 - sag * 4 * t1 * (1 - t1);
            wires.push(ax + (bx - ax) * t0, y0, az + (bz - az) * t0, ax + (bx - ax) * t1, y1, az + (bz - az) * t1);
          }
        }
      }
    }
    // 철탑: 교차 사각형 두 장(격자 질감, 멀리선 밉맵으로 옅어짐)
    const steel = towers.filter((t) => !t.wood);
    if (steel.length) {
      const mat = new THREE.MeshLambertMaterial({ map: lattice, side: THREE.DoubleSide, alphaToCoverage: true, transparent: false });
      patchMaterial(mat, { key: 'pylon', noCanopy: true });
      const mesh = new THREE.InstancedMesh(quad, mat, steel.length * 2);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      let k = 0;
      for (const t of steel) {
        for (const a of [t.ang, t.ang + Math.PI / 2]) {
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
          m.compose(new THREE.Vector3(...t.p), q, new THREE.Vector3(t.w * 2.1, t.h, 1));
          mesh.setMatrixAt(k++, m);
        }
      }
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.pylons = mesh;
    }
    // 나무 전신주: 가는 원기둥 + 가로대
    const wood = towers.filter((t) => t.wood);
    if (wood.length) {
      const mb = new MeshBuilder();
      const col = [0.28, 0.23, 0.18];
      for (const t of wood) {
        const [x, y, z] = t.p;
        const R = 0.13;
        for (let s = 0; s < 6; s++) {
          const a0 = (s / 6) * Math.PI * 2;
          const a1 = ((s + 1) / 6) * Math.PI * 2;
          mb.quad([x + Math.cos(a0) * R, y, z + Math.sin(a0) * R], [x + Math.cos(a0) * R * 0.75, y + t.h, z + Math.sin(a0) * R * 0.75], [x + Math.cos(a1) * R * 0.75, y + t.h, z + Math.sin(a1) * R * 0.75], [x + Math.cos(a1) * R, y, z + Math.sin(a1) * R], col);
        }
        addBox(mb, x, y + t.h * 0.93, z, 1.7, 0.12, 0.12, t.ang + Math.PI / 2, col);
      }
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      patchMaterial(mat, { key: 'poles', noCanopy: true });
      const mesh = new THREE.Mesh(mb.geometry(), mat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.poles = mesh;
    }
    if (wires.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...U },
        vertexShader: `${commonGLSL()}\nvarying vec3 vWP;\nvoid main(){ vWP = position; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `${commonGLSL()}\nvarying vec3 vWP;\nvoid main(){ vec3 col = vec3(0.09, 0.09, 0.1) * RECIPROCAL_PI * (sunE() * 0.4 + shIrradiance(vec3(0.0, 1.0, 0.0))); gl_FragColor = vec4(applyFog(col, vWP), 1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
      });
      mat.name = 'wires';
      // RECIPROCAL_PI는 three 공통 조각에 있다
      mat.fragmentShader = '#include <common>\n' + mat.fragmentShader;
      const lines = new THREE.LineSegments(g, mat);
      lines.frustumCulled = false;
      this.scene.add(lines);
      this.wires = lines;
    }
  }
}
