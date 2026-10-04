// 지면 식생: 밀 그루터기 줄·휴경지 잡초·둑 풀·숲 가장자리 키 큰 잡초 띠(쑥·엉겅퀴·우엉·큰 볏과)·
// 숲 바닥 빛 드는 곳의 쐐기풀·흙길 가운데 풀·거두지 않은 해바라기 밭.
// 식물 하나 = 교차한 세로 카드 1~3장(render/plantTextures.js 절차 생성 아틀라스). 위치는 타일 번호와 인스턴스 번호의
// 해시로 GPU에서 만든다(CPU 버퍼 없음). 높이·종류 비율은 판정(world/GroundCover.js)과 같은 식(coverAtG):
// 보이는 풀·잡초·해바라기 높이(평균) = 탄도·시야 덮개 높이.
//
// 그리기 호출을 줄이려고 타일 매개변수를 '인스턴스 K개마다 하나씩' 넘어가는 속성(divisor K)으로 넣는다:
// 거리 등급(가까움·중간·멂)마다 메시 하나 = 그리기 한 번.
//  - 낮은 식생: 8 m 타일, 거리 ≈ 품질 grassRange. 먼 곳은 개수를 줄이고 카드를 넓혀 덮임 유지 → 지면 질감으로 이어짐
//    (숲 가장자리 키 큰 잡초 띠도 여기 — 띠가 좁아 큰 타일로는 빈 칸이 너무 많다)
//  - 해바라기 밭: 24 m 타일, 줄 방향 격자(줄 간격 0.7 m × 포기 간격 0.35 m), 거리 ≈ 350 m(밭 전체가 덩어리로 보임)

import * as THREE from 'three';
import { U, commonGLSL } from './shaderLib.js';
import { treeFrag, SHADOW_VARY } from './trees/treeShaders.js';
import { makePlantAtlas, PLANT_TILES as PT } from './plantTextures.js';
import { COVER_GLSL, coverParts } from '../world/GroundCover.js';

// 종류별 최대 밀도(포기 또는 그루터기 줄 토막 / m²)
const D = { stub: 12, fal: 5, grass: 7, tall: 5, for: 3, road: 6 };
const LOW = { tile: 8, classes: [{ K: 900, maxDe: 16, near: true }, { K: 240, maxDe: 40 }, { K: 70, maxDe: 1e9 }] };
const TALL = { tile: 24, rowA: 0.35, rowB: 0.7 };

function plantGeometry(cards, rows) {
  const pos = [];
  const idx = [];
  for (let c = 0; c < cards; c++) {
    const base = pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const y = r / rows;
      pos.push(-0.5, y, c, 0.5, y, c);
    }
    for (let r = 0; r < rows; r++) {
      const a = base + r * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

const VS = /* glsl */ `
#include <common>
#ifdef TREE_LIT
#include <shadowmap_pars_vertex>
#endif
${commonGLSL()}
${COVER_GLSL}
uniform vec4 uSys; // 체계(0 낮은 식생 / 1 키 큰 식생), 타일 크기, 타일당 인스턴스 칸 K, 카드 수
uniform float uZoom; // 조준경 배율(먼 곳 밀도·그루터기 거리)
attribute vec4 aTileA; // x0, z0, 타일 키, 이 타일에서 쓸 인스턴스 수
attribute vec4 aTileB; // 카드 폭 배수(먼 곳), 타일 최대 밀도, 줄 방향(rad), 0
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vNc;
varying vec4 vP;   // 높이 비율 t, 마름, 투과, 차폐
varying vec3 vTint;
varying vec3 vOcc; // 이웃 수관 햇빛, 하늘빛, 구름 그림자
varying float vViewZ;

void killV() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }

void main() {
  int K = int(uSys.z + 0.5);
  int lid = gl_InstanceID - (gl_InstanceID / K) * K;
  if (lid >= int(aTileA.w + 0.5)) { killV(); return; }
  int key = int(aTileA.z);
  float T = uSys.y;
  float r0 = hash2i(ivec2(lid * 3 + 1, key + 17));
  float r1 = hash2i(ivec2(lid * 5 + 2, key + 29));
  float r2 = hash2i(ivec2(lid * 7 + 3, key + 41));
  float r3 = hash2i(ivec2(lid * 11 + 5, key + 53));
  vec2 p;
  bool tallSys = uSys.x > 0.5;
  if (!tallSys) {
    p = aTileA.xy + vec2(hash2i(ivec2(lid, key)), hash2i(ivec2(lid + 7919, key ^ 0x5bd1))) * T;
  } else {
    // 줄 방향 격자 칸을 순열(소수 7919 곱)로 고름 → 같은 칸이 두 번 쓰이지 않는다
    float dir = aTileB.z;
    vec2 tv = vec2(cos(dir), sin(dir));
    vec2 nv = vec2(-tv.y, tv.x);
    vec2 cen = aTileA.xy + T * 0.5;
    float R = T * 0.7072;
    int NA = int(ceil(2.0 * R / ${TALL.rowA}));
    int NB = int(ceil(2.0 * R / ${TALL.rowB}));
    int S = NA * NB;
    int slot = (lid * 7919) % S;
    float a = floor(dot(cen, tv) / ${TALL.rowA}) - float(NA / 2) + float(slot % NA);
    float b = floor(dot(cen, nv) / ${TALL.rowB}) - float(NB / 2) + float(slot / NA);
    p = tv * (a * ${TALL.rowA}) + nv * (b * ${TALL.rowB});
    if (p.x < aTileA.x || p.y < aTileA.y || p.x >= aTileA.x + T || p.y >= aTileA.y + T) { killV(); return; }
  }
  if (!inTerrainMap(p)) { killV(); return; }
  Cover cv = coverAtG(p);
  // 종류: 0 그루터기, 1 휴경지 잡초, 2 둑 풀, 3 숲 바닥, 4 흙길 가운데 풀, 5 해바라기, 6 키 큰 잡초
  float kind = -1.0;
  if (!tallSys) {
    float x = r0 * aTileB.y;
    float acc = cv.wStub * ${D.stub.toFixed(1)};
    if (x < acc) kind = 0.0;
    else if (x < (acc += cv.wFal * ${D.fal.toFixed(1)})) kind = 1.0;
    else if (x < (acc += cv.wGrass * (1.0 - cv.tall) * ${D.grass.toFixed(1)})) kind = 2.0;
    else if (x < (acc += cv.wGrass * cv.tall * ${D.tall.toFixed(1)})) kind = 6.0;
    else if (x < (acc += cv.wFor * ${D.for.toFixed(1)})) kind = 3.0;
    else if (x < (acc += cv.wRoad * ${D.road.toFixed(1)})) kind = 4.0;
  } else {
    // 격자 한 칸 = 해바라기 한 포기(4.1 포기/m²), 줄에서 몇 cm만 벗어남
    if (r0 < cv.wSun) kind = 5.0;
    p += (vec2(r2, r3) - 0.5) * 0.08;
  }
  if (kind < 0.0) { killV(); return; }

  // 종(아틀라스 칸)·크기·성질
  float tile = ${PT.grassMixed}.0;
  float h = 0.3;
  float wid = 0.5;
  float stiff = 1.0;  // 바람에 휘는 정도
  float dry = 0.3;    // 녹색을 짚색으로 바꾸는 정도
  float tr = 1.0;     // 투과(초록 잎)
  float cards = uSys.w;
  float ang = r3 * 3.14159265;
  if (kind < 0.5) {
    // 그루터기 기하는 가까이만(약 20 m) — 그 너머는 지면 질감의 그루터기 줄이 이어받는다
    float dCam = distance(p, cameraPosition.xz) / max(uZoom, 1.0);
    if (r2 > smoothstep(26.0, 10.0, dCam)) { killV(); return; }
    tile = r3 < 0.75 ? ${PT.stubble}.0 : ${PT.stubble2}.0;
    h = cv.hStub * mix(0.75, 1.25, r1);
    wid = 0.3;
    stiff = 0.05;
    dry = 0.0;
    tr = 0.2;
    // 수확 줄(17 cm 간격)에 맞춰 놓인 그루터기 토막(방향은 줄 방향 ± 흔들림)
    float dir = surfSampleC(p).r * 3.14159265;
    vec2 rowN = vec2(-sin(dir), cos(dir));
    float q = dot(p, rowN);
    p += rowN * ((floor(q / 0.17) + 0.5) * 0.17 - q);
    ang = dir + (r3 - 0.5) * 0.7;
    cards = 2.0;
  } else if (kind < 1.5) {
    tile = r2 < 0.38 ? ${PT.grassDry}.0 : r2 < 0.6 ? ${PT.grassMixed}.0 : r2 < 0.78 ? ${PT.wormwood}.0 : r2 < 0.88 ? ${PT.thistle}.0 : ${PT.tansy}.0;
    h = cv.hFal * mix(0.7, 1.3, r1);
    stiff = tile == ${PT.wormwood}.0 || tile == ${PT.thistle}.0 ? 0.45 : 1.0;
    dry = 0.45 + 0.4 * r3;
  } else if (kind < 2.5) {
    tile = r2 < 0.4 ? ${PT.grassGreen}.0 : r2 < 0.7 ? ${PT.grassMixed}.0 : r2 < 0.86 ? ${PT.grassDry}.0 : ${PT.tansy}.0;
    h = cv.hGrass * mix(0.7, 1.3, r1);
    dry = 0.2 + 0.45 * r3;
  } else if (kind < 3.5) {
    tile = r2 < 0.55 ? ${PT.nettle}.0 : r2 < 0.82 ? ${PT.grassGreen}.0 : ${PT.burdock}.0;
    h = cv.hFor * mix(0.7, 1.3, r1);
    stiff = 0.5;
    dry = 0.05 + 0.2 * r3;
  } else if (kind < 4.5) {
    tile = r2 < 0.6 ? ${PT.grassMixed}.0 : ${PT.grassGreen}.0;
    h = cv.hRoad * mix(0.7, 1.3, r1);
    dry = 0.3 + 0.4 * r3;
  } else if (kind < 5.5) {
    tile = r2 < 0.5 ? ${PT.sunflower}.0 : ${PT.sunflower2}.0;
    h = cv.hSun * mix(0.92, 1.08, r1);
    stiff = 0.12;
    dry = 0.0;
    tr = 0.35;
    cards = min(cards, 2.0);
  } else {
    tile = r2 < 0.32 ? ${PT.wormwood2}.0 : r2 < 0.44 ? ${PT.thistle2}.0 : r2 < 0.64 ? ${PT.burdock2}.0 : ${PT.grassTall}.0;
    h = cv.hGrass * mix(0.75, 1.25, r1);
    stiff = tile == ${PT.grassTall}.0 ? 0.9 : 0.4;
    dry = 0.35 + 0.4 * r3;
  }
  if (kind > 0.5 && kind < 5.5) wid = h * (tile == ${PT.burdock}.0 || tile == ${PT.burdock2}.0 ? 0.75 : 0.6);
  if (kind > 4.5) wid = h * 0.5;
  // 타일 뒤쪽 번호는 작게 → 밀도가 줄 때 갑자기 사라지지 않음
  float fade = 1.0 - smoothstep(aTileA.w * 0.75, aTileA.w, float(lid));
  h *= mix(0.55, 1.0, fade);
  wid *= aTileB.x;

  float ci = position.z;
  if (ci >= cards) { killV(); return; }
  float ca = ang + ci * (cards > 2.5 ? 1.0471976 : (kind < 0.5 ? 0.5 : 1.5707963));
  vec2 cdir = vec2(cos(ca), sin(ca));
  float t = position.y;
  float gy = terrainHeightVis(p);
  // 바람: 식물 높이의 바람(차폐 격자·돌풍), 강성에 따라 휨 + 떨림
  vec2 w = windAt(p, max(h * 0.7, 0.15), 3.0);
  float ws = length(w);
  vec2 wdir = ws > 0.01 ? w / ws : vec2(1.0, 0.0);
  float flut = sin(uTime * (2.6 + r1 * 2.2) + r2 * 30.0 + dot(p, wdir) * 1.3);
  float bend = clamp(ws * ws * 0.010 * stiff, 0.0, 1.1) * (1.0 + 0.3 * flut) + 0.05 * stiff * flut;
  vec2 lean = wdir * bend * t * t * h;
  vec3 wp = vec3(p.x + cdir.x * position.x * wid + lean.x, gy + h * t * (1.0 - 0.3 * bend * bend * t) - 0.02, p.y + cdir.y * position.x * wid + lean.y);
  vWP = wp;
  // 아틀라스: flipY 없음 → v 0 = 칸 위(식물 꼭대기), 1 = 땅. 좌우 무작위 뒤집기
  float u = position.x + 0.5;
  if (r1 > 0.5) u = 1.0 - u;
  vUv = (vec2(mod(tile, 8.0), floor(tile / 8.0)) + vec2(u * 0.98 + 0.01, (1.0 - t) * 0.985 + 0.005)) / vec2(8.0, 2.0);
  vNc = vec3(-cdir.y, 0.0, cdir.x);
  // 밑동 차폐: 빽빽한 풀 포기 아래는 어둡고, 하늘로 펼친 우엉 잎(포기 아래쪽 큰 잎)은 덜 가려진다
  bool broad = tile == ${PT.burdock}.0 || tile == ${PT.burdock2}.0;
  float ao = mix(broad ? 0.62 : 0.35, 1.0, smoothstep(0.0, 0.75, t));
  vP = vec4(t, dry, tr, ao);
  vTint = vec3(0.86 + 0.28 * r1) * vec3(1.0, 1.0 + (r2 - 0.5) * 0.08, 1.0 - (r3 - 0.5) * 0.1);
  // 수관이 해를 가리는 정도(그림자 맵 밖·잎 그림자 없는 품질): 태양 쪽 7 m·관목 높이 1.2 m
  vec2 sunH = uSunDir.xz / max(uSunDir.y, 0.15);
  vec2 sp = p + sunH * 7.0;
  vec2 cd = canopySample(sp, 0.0);
  float fl = vnoise(sp * 2.6) * 0.6 + vnoise(sp * 7.9) * 0.4;
  float occ = (1.0 - smoothstep(fl - 0.1, fl + 0.1, cd.r * 1.45 - 0.08) * 0.95 * uCanopyStrength)
            * (1.0 - smoothstep(0.3, 0.8, canopySample(p + sunH * 1.2, 0.0).g) * 0.8 * uCanopyStrength);
  float sky = 1.0 - canopySample(p, 2.5).r * 0.6 * uCanopyStrength;
  vOcc = vec3(occ, sky, cloudShadow(wp));
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  ${SHADOW_VARY}
  gl_Position = projectionMatrix * mv;
}
`;

const FS = treeFrag(/* glsl */ `
uniform sampler2D uPlantAtlas;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vNc;
varying vec4 vP;
varying vec3 vTint;
varying vec3 vOcc;
varying float vViewZ;
void main() {
  vec4 tx = texture(uPlantAtlas, vUv);
  vec2 tsz = vec2(textureSize(uPlantAtlas, 0));
  vec2 ddx = dFdx(vUv * tsz);
  vec2 ddy = dFdy(vUv * tsz);
  float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
  float a = tx.a;
  float thrA = mix(0.5, 0.3, smoothstep(1.5, 5.5, mip));
#ifdef USE_A2C
  float alpha = clamp((a - thrA) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
  if (alpha < 0.01) discard;
#else
  if (a < thrA) discard;
  float alpha = 1.0;
#endif
  vec3 alb = tx.rgb * vTint;
  // 마름: 초록 성분만 짚색 쪽으로(9월 말 — 포기마다 다르게)
  float l = dot(alb, vec3(0.3, 0.59, 0.11));
  float green = clamp((alb.g - max(alb.r, alb.b)) * 9.0, 0.0, 1.0);
  alb = mix(alb, vec3(l * 1.16, l * 1.0, l * 0.6), green * vP.y);
  float t = vP.x;
  vec3 Nc = normalize(gl_FrontFacing ? vNc : -vNc);
  vec3 N = normalize(Nc * 0.55 + vec3(0.0, 0.85, 0.0));
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWP);
  float sh = 1.0;
  float farK = 1.0;
#if defined( TREE_LIT ) && defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
  sh = treeSunShadow(vWP, L * (0.06 + vViewZ * 0.001), vViewZ);
  farK = smoothstep(uCanopyFade.x, uCanopyFade.y, vViewZ);
#endif
  // 잎 그림자가 그림자 맵에 있으면(높음) 가까운 곳은 그림자 맵만, 아니면 수관 지도도 곱한다
  float sunVis = sh * mix(1.0, vOcc.x, farK) * vOcc.z;
  float diff = max(0.0, (dot(N, L) + 0.5) / 1.5);
  float fwd = pow(max(dot(-V, L), 0.0), 4.0);
  float back = max(-dot(Nc, L), 0.0);
  float trans = (0.6 * fwd + 0.4 * back) * vP.z * green;
  vec3 E = sunE();
  float ao = vP.w;
  vec3 col = alb * RECIPROCAL_PI * (E * diff * sunVis + shIrradiance(N) * ao * vOcc.y) + alb * vec3(1.0, 1.15, 0.6) * RECIPROCAL_PI * E * trans * sunVis;
  gl_FragColor = vec4(col, alpha);
  gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWP);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`);

/** 타일 묶음 메시: 타일 매개변수 속성 2개(divisor K) */
class TileBatch {
  constructor(scene, geometry, material, K, maxTiles, sys, tileSize, cards) {
    this.K = K;
    this.max = maxTiles;
    this.a = new Float32Array(maxTiles * 4);
    this.b = new Float32Array(maxTiles * 4);
    this.attrA = new THREE.InstancedBufferAttribute(this.a, 4, false, K);
    this.attrB = new THREE.InstancedBufferAttribute(this.b, 4, false, K);
    this.attrA.setUsage(THREE.DynamicDrawUsage);
    this.attrB.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(geometry.index);
    g.setAttribute('position', geometry.attributes.position);
    g.setAttribute('aTileA', this.attrA);
    g.setAttribute('aTileB', this.attrB);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = material.clone();
    for (const k in material.uniforms) this.mat.uniforms[k] = material.uniforms[k];
    this.mat.uniforms.uSys = { value: new THREE.Vector4(sys, tileSize, K, cards) };
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.n = 0;
    this.instances = 0;
  }
  push(x0, z0, key, count, widthK, dMax, dir) {
    if (this.n >= this.max) return false;
    const o = this.n * 4;
    this.a[o] = x0;
    this.a[o + 1] = z0;
    this.a[o + 2] = key;
    this.a[o + 3] = Math.min(this.K, count);
    this.b[o] = widthK;
    this.b[o + 1] = dMax;
    this.b[o + 2] = dir;
    this.b[o + 3] = 0;
    this.n++;
    this.instances += Math.min(this.K, count);
    return true;
  }
  finish() {
    this.geo.instanceCount = this.n * this.K;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      for (const at of [this.attrA, this.attrB]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, this.n * 4);
        at.needsUpdate = true;
      }
    }
    this.lastInstances = this.instances;
    this.n = 0;
    this.instances = 0;
  }
}

export class VegetationRenderer {
  constructor(scene, world, quality) {
    this.scene = scene;
    this.world = world;
    this.quality = quality;
    this.atlas = makePlantAtlas();
    const a2c = true;
    this.zoomU = { value: 1 };
    const uniforms = { ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights), ...U, uPlantAtlas: { value: this.atlas }, uZoom: this.zoomU };
    const defines = { TREE_LIT: '' };
    if (a2c) defines.USE_A2C = '';
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VS,
      fragmentShader: FS,
      defines,
      lights: true,
      side: THREE.DoubleSide,
      alphaToCoverage: a2c,
    });
    this.material.name = 'vegetation';
    const near = plantGeometry(3, 3);
    const far = plantGeometry(2, 1);
    // 낮은 식생: 거리 등급 3개 / 키 큰 식생: 3개
    this.low = LOW.classes.map((c, i) => new TileBatch(scene, i === 0 ? near : far, this.material, c.K, 400, 0, LOW.tile, i === 0 ? 3 : 2));
    const S = this._tallSlots();
    this.tallK = [S, Math.ceil(S * 0.7), Math.ceil(S * 0.22)];
    this.tall = [new TileBatch(scene, near, this.material, this.tallK[0], 24, 1, TALL.tile, 2), new TileBatch(scene, far, this.material, this.tallK[1], 48, 1, TALL.tile, 2), new TileBatch(scene, far, this.material, this.tallK[2], 160, 1, TALL.tile, 2)];
    this._buildMasks();
    this.frustum = new THREE.Frustum();
    this.box = new THREE.Box3();
    this.tmpM = new THREE.Matrix4();
    this.totalInstances = 0;
  }

  _tallSlots() {
    const R = TALL.tile * 0.7072;
    return Math.ceil((2 * R) / TALL.rowA) * Math.ceil((2 * R) / TALL.rowB);
  }

  /** 타일별 최대 밀도(낮은 식생)·키 큰 식생 비율과 줄 방향 — 빈 타일은 아예 그리지 않음 */
  _buildMasks() {
    const t0 = performance.now();
    const terrain = this.world.terrain;
    const half = terrain.half;
    const c = {};
    const nL = Math.ceil((2 * half) / LOW.tile);
    this.lowN = nL;
    this.lowMax = new Float32Array(nL * nL);
    const sampleL = [0.17, 0.5, 0.83];
    for (let j = 0; j < nL; j++) {
      for (let i = 0; i < nL; i++) {
        let m = 0;
        for (const fy of sampleL) {
          for (const fx of sampleL) {
            const x = -half + (i + fx) * LOW.tile;
            const z = -half + (j + fy) * LOW.tile;
            coverParts(terrain, x, z, c);
            const d = c.wStub * D.stub + c.wFal * D.fal + c.wGrass * (1 - c.tall) * D.grass + c.wGrass * c.tall * D.tall + c.wFor * D.for + c.wRoad * D.road;
            m = Math.max(m, d);
          }
        }
        // 표본 사이 경계를 놓치지 않도록 여유
        this.lowMax[j * nL + i] = m > 0.02 ? Math.min(14, m * 1.15 + 0.4) : 0;
      }
    }
    const nT = Math.ceil((2 * half) / TALL.tile);
    this.tallN = nT;
    this.tallFrac = new Float32Array(nT * nT);
    this.tallDir = new Float32Array(nT * nT);
    const sampleT = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (let j = 0; j < nT; j++) {
      for (let i = 0; i < nT; i++) {
        let m = 0;
        let sunW = 0;
        for (const fy of sampleT) {
          for (const fx of sampleT) {
            const x = -half + (i + fx) * TALL.tile;
            const z = -half + (j + fy) * TALL.tile;
            coverParts(terrain, x, z, c);
            m = Math.max(m, c.wSun);
            sunW = Math.max(sunW, c.wSun);
          }
        }
        this.tallFrac[j * nT + i] = m > 0.02 ? m : 0;
        const cx = -half + (i + 0.5) * TALL.tile;
        const cz = -half + (j + 0.5) * TALL.tile;
        this.tallDir[j * nT + i] = sunW > 0.02 ? terrain.fieldDirAt(cx, cz) : 0.6;
      }
    }
    this.maskMs = performance.now() - t0;
    console.info(`[vegetation] tile masks ${this.maskMs.toFixed(0)} ms`);
  }

  update(camera, zoom) {
    const last = this._last;
    const q = camera.quaternion;
    if (last && camera.position.distanceToSquared(last.pos) < 0.25 && Math.abs(q.dot(last.quat)) > 0.9999 && Math.abs(zoom / last.zoom - 1) < 0.02) return;
    this._last = { pos: camera.position.clone(), quat: q.clone(), zoom };
    this.zoomU.value = Math.max(1, zoom);
    this.frustum.setFromProjectionMatrix(this.tmpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cp = camera.position;
    const z = Math.max(1, zoom);
    const half = this.world.terrain.half;
    const dens = this.quality.grassDensity;
    // ---- 낮은 식생 ----
    const rangeL = this.quality.grassRange * Math.min(4, Math.pow(z, 0.85));
    const T = LOW.tile;
    const nL = this.lowN;
    const i0 = Math.max(0, Math.floor((cp.x - rangeL + half) / T));
    const i1 = Math.min(nL - 1, Math.floor((cp.x + rangeL + half) / T));
    const j0 = Math.max(0, Math.floor((cp.z - rangeL + half) / T));
    const j1 = Math.min(nL - 1, Math.floor((cp.z + rangeL + half) / T));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dMax = this.lowMax[j * nL + i];
        if (dMax <= 0) continue;
        const x0 = -half + i * T;
        const z0 = -half + j * T;
        const nx = Math.max(x0, Math.min(cp.x, x0 + T));
        const nz = Math.max(z0, Math.min(cp.z, z0 + T));
        const d = Math.hypot(nx - cp.x, nz - cp.z, Math.max(0, cp.y - 1.5) * 0.5);
        if (d > rangeL) continue;
        this.box.min.set(x0, cp.y - 40, z0);
        this.box.max.set(x0 + T, cp.y + 40, z0 + T);
        if (!this.frustum.intersectsBox(this.box)) continue;
        const de = d / z;
        const f = de < 7 ? 1 : Math.max(0.01, Math.pow(7 / de, 1.6));
        const n = Math.round(T * T * dMax * f * dens);
        if (n < 3) continue;
        const widthK = Math.min(3, Math.sqrt(1 / f));
        const key = ((i * 73856093) ^ (j * 19349663)) & 0xffffff;
        const cls = LOW.classes.findIndex((c) => de < c.maxDe);
        this.low[cls].push(x0, z0, key, n, widthK, dMax, 0);
      }
    }
    // ---- 키 큰 식생 ----
    const rangeT = 350 * Math.min(2.5, Math.pow(z, 0.7));
    const TT = TALL.tile;
    const nT = this.tallN;
    const S = this.tallK[0];
    const a0 = Math.max(0, Math.floor((cp.x - rangeT + half) / TT));
    const a1 = Math.min(nT - 1, Math.floor((cp.x + rangeT + half) / TT));
    const b0 = Math.max(0, Math.floor((cp.z - rangeT + half) / TT));
    const b1 = Math.min(nT - 1, Math.floor((cp.z + rangeT + half) / TT));
    for (let j = b0; j <= b1; j++) {
      for (let i = a0; i <= a1; i++) {
        const frac = this.tallFrac[j * nT + i];
        if (frac <= 0) continue;
        const x0 = -half + i * TT;
        const z0 = -half + j * TT;
        const nx = Math.max(x0, Math.min(cp.x, x0 + TT));
        const nz = Math.max(z0, Math.min(cp.z, z0 + TT));
        const d = Math.hypot(nx - cp.x, nz - cp.z);
        if (d > rangeT) continue;
        this.box.min.set(x0, cp.y - 40, z0);
        this.box.max.set(x0 + TT, cp.y + 40, z0 + TT);
        if (!this.frustum.intersectsBox(this.box)) continue;
        const de = d / z;
        const f = de < 22 ? 1 : Math.max(0.02, Math.pow(22 / de, 1.25));
        const cls = de < 30 ? 0 : de < 80 ? 1 : 2;
        const n = Math.round(S * f * Math.min(1, dens + 0.2));
        if (n < 4) continue;
        const widthK = Math.min(4, Math.sqrt(1 / f));
        const key = ((i * 83492791) ^ (j * 2654435761)) & 0xffffff;
        this.tall[cls].push(x0, z0, key, n, widthK, frac, this.tallDir[j * nT + i]);
      }
    }
    let total = 0;
    for (const b of this.low) {
      b.finish();
      total += b.lastInstances;
    }
    for (const b of this.tall) {
      b.finish();
      total += b.lastInstances;
    }
    this.totalInstances = total;
  }
}
