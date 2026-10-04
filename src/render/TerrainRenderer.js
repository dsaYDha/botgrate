// 지형 렌더링: 카메라 중심 기하 클립맵(동심 격자 링, 수준마다 간격 2배).
// 정점 높이는 GPU에서 CPU와 같은 함수(terrainHeight)로 계산한다.
// 수준 경계는 CDLOD식 모프로 이어 붙이고, 겹치는 띠는 안쪽 수준이 덮는 영역을 discard.

import * as THREE from 'three';
import { U, patchMaterial } from './shaderLib.js';

const M = 64; // 수준당 반격자 칸 수(전체 2M × 2M 칸)

const GROUND_GLSL = /* glsl */ `
uniform sampler2D uSurfA;
uniform sampler2D uSurfB;
uniform vec4 uLevel;   // centerX, centerZ, spacing, isLast
uniform vec4 uInner;   // 안쪽 수준이 덮는 사각형
varying float vSpacing;

vec4 surfSample(sampler2D t, vec2 p) {
  float N = uTerrainInfo.z;
  vec2 uv = ((p + uTerrainInfo.x) / uTerrainInfo.y + 0.5) / N;
  return texture(t, uv);
}

// 플레이 지도 밖 원경 밭 구획
void farFields(vec2 p, out vec4 a, out vec4 b) {
  vec2 cell = floor(p / vec2(420.0, 300.0));
  float h = hash2i(ivec2(cell) + ivec2(91, 37));
  a = vec4(0.0);
  b = vec4(0.0, hash2i(ivec2(cell) + ivec2(5, 3)) > 0.5 ? 0.5 : 0.0, h, 0.0);
  if (h < 0.42) a.r = 1.0; else if (h < 0.72) a.g = 1.0; else a.b = 1.0;
  // 구획 경계의 풀둑
  vec2 f = fract(p / vec2(420.0, 300.0));
  vec2 e = min(f, 1.0 - f) * vec2(420.0, 300.0);
  float edge = 1.0 - smoothstep(2.0, 5.0, min(e.x, e.y));
  a *= 1.0 - edge;
  b.r = edge;
}

float stripeAA(float q, float period, float fw) {
  float s = 0.5 + 0.5 * cos(6.2831853 * q / period);
  return mix(s, 0.5, smoothstep(0.25, 0.7, fw / period));
}

vec3 groundAlbedo(vec3 wp, inout vec3 nW) {
  vec2 p = wp.xz;
  vec4 a, b;
  float inMap = step(abs(p.x), uTerrainInfo.x - 1.0) * step(abs(p.y), uTerrainInfo.x - 1.0);
  if (inMap > 0.5) { a = surfSample(uSurfA, p); b = surfSample(uSurfB, p); }
  else farFields(p, a, b);
  float wStub = a.r, wPlow = a.g, wFal = a.b, wFor = a.a, wGrass = b.r;
  float dir = b.g * 3.14159265;
  float seed = b.b;
  vec2 rowN = vec2(-sin(dir), cos(dir));
  float q = dot(p, rowN);
  float fw = max(fwidth(q), 1e-4);
  float dist = length(wp - cameraPosition);

  float n1 = vnoise(p * 0.35);
  float n2 = vnoise(p * 1.7 + 3.1);
  float n3 = vnoise(p * 7.3 - 1.7);
  float tint = (seed - 0.5) * 0.08;

  // 밀 그루터기: 줄 방향 그루터기 열 + 짚 부스러기 띠
  float rows = stripeAA(q, 0.18, fw);
  float windrow = smoothstep(0.55, 0.95, 0.5 + 0.5 * cos(6.2831853 * q / 6.2));
  vec3 straw = vec3(0.56, 0.47, 0.29) * (1.0 + tint);
  vec3 soilDry = vec3(0.36, 0.3, 0.21);
  vec3 cStub = mix(soilDry, straw, 0.55 + 0.2 * rows + 0.15 * windrow);
  cStub *= 0.86 + 0.22 * n1 + 0.1 * n2;

  // 갈아엎은 흙: 이랑 + 흙덩이
  float ph = q / 0.78;
  float furrow = sin(6.2831853 * ph);
  float fade = 1.0 - smoothstep(0.15, 0.5, fw / 0.78);
  vec3 soil = vec3(0.3, 0.235, 0.175) * (1.0 + tint);
  vec3 cPlow = soil * (0.82 + 0.25 * n2 + 0.18 * n3) * (1.0 + 0.16 * furrow * fade);
  cPlow = mix(cPlow, soil * 1.25, smoothstep(0.62, 0.8, n1) * 0.4);

  // 휴경지: 마른 풀·초록·갈색 얼룩
  // 잡초 덮인 땅: 멀리서 보면 잡초 색의 평균(어두운 황록·갈색)
  vec3 cFal = mix(vec3(0.27, 0.25, 0.14), vec3(0.17, 0.2, 0.08), smoothstep(0.35, 0.7, n1));
  cFal = mix(cFal, vec3(0.33, 0.28, 0.16), smoothstep(0.6, 0.85, n2) * 0.6);
  cFal *= 0.85 + 0.25 * n3;

  // 숲 바닥: 낙엽(일부 노란 잎), 축축한 그늘
  float leafSpeck = smoothstep(0.62, 0.78, vnoise(p * 5.1)) * (1.0 - smoothstep(30.0, 90.0, dist));
  vec3 cFor = vec3(0.3, 0.235, 0.15) * (0.75 + 0.35 * n2 + 0.2 * n3);
  cFor = mix(cFor, vec3(0.62, 0.5, 0.2), leafSpeck * 0.55);
  cFor = mix(cFor, vec3(0.2, 0.17, 0.12), smoothstep(0.55, 0.8, n1) * 0.35);

  // 풀둑·배수로
  vec3 cGrass = mix(vec3(0.2, 0.25, 0.11), vec3(0.34, 0.33, 0.19), smoothstep(0.3, 0.9, n2) * 0.7);
  cGrass *= 0.88 + 0.18 * n3;

  float wsum = max(wStub + wPlow + wFal + wFor + wGrass, 1e-3);
  vec3 col = (cStub * wStub + cPlow * wPlow + cFal * wFal + cFor * wFor + cGrass * wGrass) / wsum;

  // 이랑 법선(가까이서만)
  nW = normalize(nW + vec3(rowN.x, 0.0, rowN.y) * cos(6.2831853 * ph) * 0.45 * wPlow * fade);
  // 흙덩이 요철
  float bump = (vnoise(p * 9.0) - 0.5) * 0.25 * (wPlow + wFor * 0.5) * (1.0 - smoothstep(10.0, 40.0, dist));
  nW = normalize(nW + vec3(bump, 0.0, -bump));

  // 흙길
  if (inMap > 0.5) {
    float rd = terrainHD(p).y;
    float ard = abs(rd);
    float roadW = smoothstep(1.85, 1.45, ard);
    if (roadW > 0.0) {
      vec3 dirt = vec3(0.56, 0.48, 0.37) * (0.9 + 0.15 * n2 + 0.08 * n3);
      float rutC = 1.0 - smoothstep(0.08, 0.2, abs(ard - uRut.x * 0.5));
      dirt = mix(dirt, vec3(0.43, 0.36, 0.28), rutC * 0.7);
      float center = 1.0 - smoothstep(0.25, 0.42, ard);
      dirt = mix(dirt, vec3(0.37, 0.39, 0.21) * (0.85 + 0.3 * n3), center * smoothstep(0.3, 0.6, n2 + 0.2));
      col = mix(col, dirt, roadW);
    }
  }
  return col;
}
`;

function makeLevelGeometry(level) {
  const n = 2 * M + 1;
  const pos = new Float32Array(n * n * 3);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pos[k++] = i - M;
      pos[k++] = 0;
      pos[k++] = j - M;
    }
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
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class TerrainRenderer {
  constructor(scene, levels = 10, baseSpacing = 0.25) {
    this.levels = [];
    this.base = baseSpacing;
    for (let L = 0; L < levels; L++) {
      const spacing = baseSpacing * Math.pow(2, L);
      const uniforms = {
        uSurfA: U.uSurfA,
        uSurfB: U.uSurfB,
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
          vec3 transformed = vec3(wpos.x, terrainHeight(wpos), wpos.y);
          vSpacing = uLevel.z;
        `,
        vertexHeader: 'uniform vec4 uLevel;\nvarying float vSpacing;',
        beginNormal: 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);',
        fragmentColor: /* glsl */ `
          if (vWP.x > uInner.x && vWP.x < uInner.z && vWP.z > uInner.y && vWP.z < uInner.w) discard;
          vec3 nW = terrainNormal(vWP.xz, max(0.3, vSpacing * 0.75));
          diffuseColor.rgb = groundAlbedo(vWP, nW);
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
      const ext = M * inner.spacing - 1e-3;
      this.levels[L].uniforms.uInner.value.set(inner.cx - ext, inner.cz - ext, inner.cx + ext, inner.cz + ext);
    }
  }
}
