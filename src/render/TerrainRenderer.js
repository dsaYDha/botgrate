// 지형 렌더링: 카메라 중심 기하 클립맵(동심 격자 링, 수준마다 간격 2배).
// 정점 높이는 GPU에서 CPU와 같은 함수(3차 B-스플라인 + 바퀴 자국 + 미세 요철)로 계산한다.
// 수준 경계는 CDLOD식 모프로 이어 붙이고, 겹치는 띠는 안쪽 수준이 덮는 영역을 discard.
// 지면 색·질감: 절차 생성 배열 텍스처(groundTextures.js)를 지면 종류 지도에 따라 섞는다.
//   그루터기 줄(17 cm 간격)·짚 줄(콤바인 폭 7.6 m)·트랙터 바퀴 자국(24 m)·밭 끝 회전 구역,
//   갈아엎은 이랑과 습한 곳, 숲 바닥 낙엽층, 흙길 바퀴 자국·마른 웅덩이 자리, 경사면 흙 노출.

import * as THREE from 'three';
import { U, patchMaterial } from './shaderLib.js';
import { makeGroundTextures, GROUND_TILE } from './groundTextures.js';

const M = 64; // 수준당 반격자 칸 수(전체 2M × 2M 칸)

const GROUND_GLSL = /* glsl */ `
uniform highp sampler2DArray uGroundAlb;
uniform highp sampler2DArray uGroundNrm;
uniform vec4 uLevel;   // centerX, centerZ, spacing, isLast
uniform vec4 uInner;   // 안쪽 수준이 덮는 사각형
varying float vSpacing;
varying vec3 vMacroN;

const float TILE_SIZE[8] = float[8](${GROUND_TILE.map((t) => t.toFixed(2)).join(', ')});

// 값 노이즈와 그 미분(같은 해시)
vec3 vnoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  ivec2 c = ivec2(i);
  float a = hash2i(c), b = hash2i(c + ivec2(1, 0)), d = hash2i(c + ivec2(0, 1)), e = hash2i(c + ivec2(1, 1));
  float k = a - b - d + e;
  return vec3(a + (b - a) * u.x + (d - a) * u.y + k * u.x * u.y, du.x * ((b - a) + k * u.y), du.y * ((d - a) + k * u.x));
}
// 미세 요철 기울기(microReliefW의 해석적 미분). 이랑은 화면에서 표현 못할 만큼 멀면 줄인다.
vec2 microGrad(vec2 p, vec4 sa, float dir, float furrowFade) {
  vec3 n1 = vnoiseD(p * 0.9 + vec2(13.1, 7.7)); n1.yz *= 0.9;
  vec3 n2 = vnoiseD(p * 2.6 + vec2(-4.3, 9.1)); n2.yz *= 2.6;
  vec3 nf = vnoiseD(p * 0.45 + vec2(3.3)); nf.yz *= 0.45;
  vec2 gGen = n1.yz * 0.035 + n2.yz * 0.014;
  vec2 gFor = nf.yz * 0.09 + n2.yz * 0.02;
  vec2 rowN = vec2(-sin(dir), cos(dir));
  float q = dot(p, rowN);
  vec2 gFur = -sin(6.2831853 * q / 0.75) * (6.2831853 / 0.75) * 0.045 * rowN * furrowFade + n1.yz * 0.02;
  float wGen = max(0.0, 1.0 - sa.g - sa.a);
  return gGen * wGen + gFor * sa.a + gFur * sa.g;
}

// 플레이 지도 밖 원경 밭 구획
void farFields(vec2 p, out vec4 a, out vec4 b, out vec4 c) {
  vec2 cell = floor(p / vec2(420.0, 300.0));
  float h = hash2i(ivec2(cell) + ivec2(91, 37));
  a = vec4(0.0);
  b = vec4(0.0, 0.0, 0.25, 0.0);
  c = vec4(hash2i(ivec2(cell) + ivec2(5, 3)) > 0.5 ? 0.5 : 0.0, h, 0.0, 1.0);
  if (h < 0.42) a.r = 1.0; else if (h < 0.72) a.g = 1.0; else a.b = 1.0;
  vec2 f = fract(p / vec2(420.0, 300.0));
  vec2 e = min(f, 1.0 - f) * vec2(420.0, 300.0);
  float edge = 1.0 - smoothstep(2.0, 5.0, min(e.x, e.y));
  a *= 1.0 - edge;
  b.r = edge;
}

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// 한 층을 반복이 덜 보이게 두 번(다른 회전·크기) 표본해 섞는다. 법선은 월드 xz 기울기로 돌려준다.
void layerAdd(int layer, vec2 p, float ang, float w, float pick, inout vec3 alb, inout vec2 grad, inout float cav, inout float wsum) {
  if (w < 0.004) return;
  float t = TILE_SIZE[layer];
  mat2 R1 = rot2(ang);
  mat2 R2 = rot2(ang + 1.9 + float(layer));
  vec2 uv1 = (R1 * p) / t;
  vec2 uv2 = (R2 * p) / (t * 1.17) + vec2(0.37, 0.71);
  vec4 a1 = texture(uGroundAlb, vec3(uv1, float(layer)));
  vec4 a2 = texture(uGroundAlb, vec3(uv2, float(layer)));
  vec4 n1 = texture(uGroundNrm, vec3(uv1, float(layer)));
  vec4 n2 = texture(uGroundNrm, vec3(uv2, float(layer)));
  // 높이 기반 섞기: 높은 쪽이 보이게
  float b = clamp(pick + (a2.a - a1.a) * 0.6, 0.0, 1.0);
  vec4 a = mix(a1, a2, b);
  vec2 t1 = n1.rg * 2.0 - 1.0;
  vec2 t2 = n2.rg * 2.0 - 1.0;
  // 텍스처 공간 기울기 → 월드 xz (회전의 역)
  vec2 g1 = transpose(R1) * t1;
  vec2 g2 = transpose(R2) * t2;
  alb += a.rgb * w;
  grad += mix(g1, g2, b) * w;
  cav += mix(n1.b, n2.b, b) * w;
  wsum += w;
}

vec3 groundShade(vec3 wp, vec3 macroN, out vec3 nW, out float cavity) {
  vec2 p = wp.xz;
  vec4 sa, sb, sc;
  bool inMap = inTerrainMap(p);
  float roadD = 1000.0;
  if (inMap) {
    sa = surfSampleA(p);
    sb = surfSampleB(p);
    sc = surfSampleC(p);
    roadD = terrainHD(p).y;
  } else farFields(p, sa, sb, sc);
  float ard = abs(roadD);
  float roadW = inMap ? 1.0 - smoothstep(1.45, 1.85, ard) : 0.0;
  float keep = 1.0 - roadW;
  float wStub = sa.r * keep, wPlow = sa.g * keep, wFal = sa.b * keep, wFor = sa.a * keep;
  float wGrass = sb.r * keep, wSun = sb.g * keep, wet = sb.b;
  float dir = sc.r * 3.14159265;
  float seed = sc.g;
  float headland = sc.b;
  float dist = length(wp - cameraPosition);

  vec2 rT = vec2(cos(dir), sin(dir));
  vec2 rN = vec2(-rT.y, rT.x);
  float q = dot(p, rN);
  float along = dot(p, rT);
  float fq = fwidth(q);
  float rowAng = -dir; // 텍스처 x축 = 줄 방향

  // 경사면: 풀·그루터기가 벗겨지고 흙이 드러남(둔덕·배수로 둑)
  float slope = 1.0 - macroN.y;
  float exposed = smoothstep(0.1, 0.26, slope + (vnoise(p * 0.7) - 0.5) * 0.08);

  float pickN = smoothstep(0.3, 0.7, vnoise(p * 0.13 + seed * 17.0));
  float n1 = vnoise(p * 0.21 + 3.0);
  float n2 = vnoise(p * 0.77 - 5.0);

  vec3 alb = vec3(0.0);
  vec2 grad = vec2(0.0);
  float cav = 0.0;
  float ws = 0.0;

  // --- 그루터기 밭 ---
  if (wStub > 0.004) {
    float noHead = 1.0 - headland;
    // 짚 줄: 콤바인 작업 폭 7.6 m마다 폭 약 1.6 m, 가장자리 들쭉날쭉, 군데군데 끊김
    float qs = mod(q + seed * 61.0, 7.6);
    float e = abs(qs - 3.8) + (vnoise(vec2(along * 0.35, seed * 13.0 + q * 0.05)) - 0.5) * 0.6;
    float swath = (1.0 - smoothstep(0.55, 0.95, e)) * smoothstep(0.22, 0.42, vnoise(vec2(along * 0.045, q * 0.09 + 7.0))) * noHead;
    swath *= 1.0 - smoothstep(0.6, 2.0, fq);
    // 트랙터 바퀴 자국(방제기 폭 24 m, 바퀴 간격 1.8 m, 자국 폭 45 cm)
    float qt = mod(q + seed * 97.0, 24.0) - 12.0;
    float td = min(abs(qt - 0.9), abs(qt + 0.9));
    float track = (1.0 - smoothstep(0.17, 0.3, td)) * noHead * (1.0 - smoothstep(0.25, 0.7, fq));
    float soilPatch = smoothstep(0.62, 0.85, n2) * 0.5 + track * 0.8;
    float stubW = wStub * (1.0 - swath * 0.75) * (1.0 - soilPatch);
    layerAdd(4, p, rowAng, stubW, 0.0, alb, grad, cav, ws);
    layerAdd(3, p, rowAng, wStub * swath * 0.75, pickN, alb, grad, cav, ws);
    layerAdd(0, p, 0.0, wStub * soilPatch * (1.0 - swath * 0.75), pickN, alb, grad, cav, ws);
  }
  // --- 갈아엎은 흙밭 ---
  if (wPlow > 0.004) {
    layerAdd(1, p, rowAng, wPlow * 0.8, pickN, alb, grad, cav, ws);
    layerAdd(0, p, 0.5, wPlow * 0.2, pickN, alb, grad, cav, ws);
  }
  // --- 휴경지(잡초 밑): 마른 풀·이끼·흙 얼룩 ---
  if (wFal > 0.004) {
    float m = smoothstep(0.35, 0.75, n1);
    layerAdd(3, p, 0.3, wFal * (0.65 - 0.3 * m), pickN, alb, grad, cav, ws);
    layerAdd(5, p, 1.1, wFal * (0.15 + 0.3 * m), pickN, alb, grad, cav, ws);
    layerAdd(0, p, 2.0, wFal * 0.2, pickN, alb, grad, cav, ws);
  }
  // --- 숲 바닥: 낙엽층 + 맨흙 + 이끼 낀 곳 ---
  if (wFor > 0.004) {
    float bare = smoothstep(0.62, 0.82, n2) * 0.5;
    float moss = smoothstep(0.7, 0.9, vnoise(p * 0.33 + 9.0)) * 0.45;
    layerAdd(2, p, 0.0, wFor * (1.0 - bare - moss), pickN, alb, grad, cav, ws);
    layerAdd(0, p, 1.3, wFor * bare, pickN, alb, grad, cav, ws);
    layerAdd(5, p, 2.1, wFor * moss, pickN, alb, grad, cav, ws);
  }
  // --- 둑·배수로 풀밭 ---
  if (wGrass > 0.004) {
    float dry = smoothstep(0.3, 0.8, n1) * (1.0 - wet * 0.6);
    layerAdd(5, p, 0.7, wGrass * (1.0 - dry * 0.6), pickN, alb, grad, cav, ws);
    layerAdd(3, p, 2.4, wGrass * dry * 0.6, pickN, alb, grad, cav, ws);
  }
  // --- 해바라기 밭: 마른 흙 + 떨어진 잎 ---
  if (wSun > 0.004) {
    layerAdd(0, p, rowAng, wSun * 0.6, pickN, alb, grad, cav, ws);
    layerAdd(2, p, 0.9, wSun * 0.25, pickN, alb, grad, cav, ws);
    layerAdd(3, p, 1.7, wSun * 0.15, pickN, alb, grad, cav, ws);
  }
  // --- 흙길: 바퀴 자국은 다져져 어둡고, 낮은 곳엔 마른 웅덩이 자리, 가운데 풀 ---
  if (roadW > 0.004) {
    float rut = 1.0 - smoothstep(0.1, 0.24, abs(ard - uRut.x * 0.5));
    float puddle = rut * smoothstep(0.55, 0.75, vnoise(vec2(dot(p, vec2(0.13, 0.11)), roadD * 0.5 + 3.0)));
    float center = (1.0 - smoothstep(0.24, 0.42, ard)) * smoothstep(0.35, 0.6, n2 + 0.2);
    layerAdd(7, p, 0.0, roadW * (1.0 - puddle - center * 0.8), pickN, alb, grad, cav, ws);
    layerAdd(6, p, 0.4, roadW * puddle, 0.0, alb, grad, cav, ws);
    layerAdd(5, p, 1.0, roadW * center * 0.8, pickN, alb, grad, cav, ws);
  }
  if (ws < 1e-3) layerAdd(0, p, 0.0, 1.0, pickN, alb, grad, cav, ws);
  alb /= ws;
  grad /= ws;
  cav /= ws;

  // 경사면 흙
  if (exposed > 0.01 && wFor < 0.5 && roadW < 0.5) {
    vec3 a0 = vec3(0.0); vec2 g0 = vec2(0.0); float c0 = 0.0; float w0 = 0.0;
    layerAdd(0, p, 0.8, 1.0, pickN, a0, g0, c0, w0);
    alb = mix(alb, a0, exposed);
    grad = mix(grad, g0, exposed);
    cav = mix(cav, c0, exposed);
  }

  // 습한 흙은 어둡다(갈아엎은 밭 낮은 곳)
  alb *= 1.0 - wet * (wPlow * 0.38 + wSun * 0.2 + wStub * 0.12);
  // 큰 규모 밝기·색 변화(타일 반복과 단조로움을 숨김)
  float big = vnoise(p * 0.013 + seed * 7.0) * 0.6 + vnoise(p * 0.041 - seed * 3.0) * 0.4;
  alb *= 0.86 + 0.28 * big;
  alb *= vec3(1.0 + (seed - 0.5) * 0.06, 1.0, 1.0 - (seed - 0.5) * 0.08);
  alb *= mix(0.78, 1.0, cav);

  // 법선: 거시(정점) + 미세 요철(해석적) + 질감
  float furrowFade = 1.0 - smoothstep(0.08, 0.25, fq);
  vec2 mg = inMap ? microGrad(p, sa, dir, furrowFade) : vec2(0.0);
  vec2 tg = grad * 0.55;
  nW = normalize(macroN + vec3(-mg.x + tg.x, 0.0, -mg.y + tg.y));
  cavity = cav;
  return alb;
}
`;

function makeLevelGeometry(level) {
  const n = 2 * M + 1;
  const pos = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) pos.push(i - M, 0, j - M);
  }
  const idx = [];
  const h0 = M / 2 + 1;
  const h1 = (3 * M) / 2 - 1;
  for (let j = 0; j < 2 * M; j++) {
    for (let i = 0; i < 2 * M; i++) {
      if (level > 0 && i >= h0 && i < h1 && j >= h0 && j < h1) continue;
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // 대각선 방향 교대(마름모 무늬 줄이기)
      if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  // 바깥 테두리 스커트: 테두리 정점을 아래로 늘어뜨린 띠(y = 1 표시). 바깥 수준과의 이음매에 생기는
  // 한 화소짜리 틈(하늘이 비치는 흰 점선)을 막는다.
  const ring = [];
  for (let i = 0; i < 2 * M; i++) ring.push(i); // 아래 변(j = 0)
  for (let j = 0; j < 2 * M; j++) ring.push(j * n + 2 * M); // 오른쪽 변
  for (let i = 2 * M; i > 0; i--) ring.push(2 * M * n + i); // 위 변
  for (let j = 2 * M; j > 0; j--) ring.push(j * n); // 왼쪽 변
  const base = pos.length / 3;
  for (const v of ring) pos.push(pos[v * 3], 1, pos[v * 3 + 2]);
  const R = ring.length;
  for (let k = 0; k < R; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % R];
    const as = base + k;
    const bs = base + ((k + 1) % R);
    idx.push(a, as, b, b, as, bs, a, b, as, b, bs, as);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class TerrainRenderer {
  constructor(scene, levels = 10, baseSpacing = 0.25) {
    this.levels = [];
    this.base = baseSpacing;
    const tex = makeGroundTextures(512);
    this.groundTex = tex;
    for (let L = 0; L < levels; L++) {
      const spacing = baseSpacing * Math.pow(2, L);
      const uniforms = {
        uGroundAlb: { value: tex.albedo },
        uGroundNrm: { value: tex.normal },
        uLevel: { value: new THREE.Vector4(0, 0, spacing, L === levels - 1 ? 1 : 0) },
        uInner: { value: new THREE.Vector4(1, 1, -1, -1) },
      };
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      patchMaterial(mat, {
        key: 'terrain',
        uniforms,
        fragmentHeader: GROUND_GLSL,
        groundY: 'vWP.y',
        vertex: /* glsl */ `
          vec2 g = position.xz;
          float cheb = max(abs(g.x), abs(g.y)) / ${M.toFixed(1)};
          float k = uLevel.w > 0.5 ? 0.0 : smoothstep(0.8, 0.96, cheb);
          g -= mod(g, 2.0) * k;
          vec2 wpos = uLevel.xy + g * uLevel.z;
          vec3 transformed = vec3(wpos.x, terrainHeightVis(wpos) - position.y * (0.15 + uLevel.z * 0.8), wpos.y);
          vSpacing = uLevel.z;
          vMacroN = terrainNormal(wpos, max(0.5, uLevel.z * 0.9));
        `,
        vertexHeader: 'uniform vec4 uLevel;\nvarying float vSpacing;\nvarying vec3 vMacroN;',
        beginNormal: 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);',
        fragmentColor: /* glsl */ `
          if (vWP.x > uInner.x && vWP.x < uInner.z && vWP.z > uInner.y && vWP.z < uInner.w) discard;
          vec3 nW;
          float groundCav;
          diffuseColor.rgb = groundShade(vWP, normalize(vMacroN), nW, groundCav);
          vec3 groundNormalView = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        `,
        normal: 'normal = groundNormalView;',
      });
      const mesh = new THREE.Mesh(makeLevelGeometry(L), mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = -10;
      scene.add(mesh);
      this.levels.push({ mesh, uniforms, spacing });
    }
  }

  update(camPos) {
    for (let L = 0; L < this.levels.length; L++) {
      const lv = this.levels[L];
      const s = lv.spacing;
      const cx = Math.round(camPos.x / (2 * s)) * 2 * s;
      const cz = Math.round(camPos.z / (2 * s)) * 2 * s;
      lv.uniforms.uLevel.value.x = cx;
      lv.uniforms.uLevel.value.y = cz;
      lv.cx = cx;
      lv.cz = cz;
    }
    for (let L = 1; L < this.levels.length; L++) {
      const inner = this.levels[L - 1];
      // 안쪽 수준과 한 칸 겹치게(겹친 띠는 안쪽 수준이 완전히 모프돼 같은 면) — 잘라내기 경계의 틈 방지
      const ext = (M - 1) * inner.spacing;
      this.levels[L].uniforms.uInner.value.set(inner.cx - ext, inner.cz - ext, inner.cx + ext, inner.cz + ext);
    }
  }
}
