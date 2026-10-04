// 나무 셰이더: 잎 뭉치 카드·줄기·가지·쓰러진 나무·임포스터 + 그림자(깊이)·굽기(임포스터 MRT) 변형.
// 인스턴스 정보는 데이터 텍스처(나무 하나당 RGBA32F 8칸)에서 읽는다 → 프레임마다 올리는 건 (번호, 흐림)뿐.
//
// 빛: 지형(MeshLambert 패치)과 같은 규약 — 직사광 = 해 조도 × N·L × 그림자 × 구름 그림자,
// 하늘빛 = SH 조도 × 가림, 둘 다 반사율/π. 잎은 감싼 확산(wrap) + 투과(역광)로 뒷면이 검지 않다.
// 그림자: '높음'은 그림자 맵(잎 그림자 포함), 그 밖·먼 곳은 수관 지도(이웃 수관이 해를 가리는 정도).

import * as THREE from 'three';
import { U, commonGLSL } from '../shaderLib.js';
import { STEM_GLSL } from '../../world/stemShape.js';
import { TREE_SPECIES, SHRUB_SPECIES } from '../../data/trees.js';

export const SPECIES_INDEX = { poplar: 0, locust: 1, elm: 2, maple: 3, ash: 4, snag: 5, elder: 6, rose: 7, blackthorn: 8, oleaster: 9 };
export const SPECIES_KEYS = Object.keys(SPECIES_INDEX);
export const TREE_TEX_W = 1024;
export const TEXELS = 8;
export const FLAG = { dead: 1, sapling: 2, fruit: 4, shrub: 8, jagged: 16, sawn: 32, still: 64 };
// 임포스터 아틀라스: 템플릿 × 방위 8, 칸 96×192 화소
export const IMP = { views: 8, fw: 96, fh: 192, cols: 21 };

// 수종별 껍질 층(treeTextures BARK_LAYERS)과 색 배수
const BARK_LAYER = [0, 2, 3, 4, 5, 6, 4, 4, 3, 5];
// 껍질 반사율이 실제(살아 있는 줄기 약 0.08~0.18, 바랜 고사목 0.2 안팎)에 맞도록 층 평균에 곱하는 값
const BARK_TINT = [
  [1.3, 1.3, 1.3],
  [1.5, 1.45, 1.4],
  [1.4, 1.4, 1.4],
  [1.3, 1.3, 1.3],
  [1.25, 1.25, 1.25],
  [1.0, 1.0, 1.0],
  [1.15, 1.1, 1.0],
  [0.95, 0.98, 0.7],
  [0.8, 0.78, 0.78],
  [1.05, 1.0, 0.92],
];
const SHRUB_AUTUMN = { elder: [0.3, 0.27, 0.1], rose: [0.32, 0.15, 0.05], blackthorn: [0.24, 0.11, 0.07], oleaster: [0.3, 0.28, 0.16] };
const FLUTTER = [1.0, 0.75, 0.55, 0.7, 0.7, 0.0, 0.8, 0.6, 0.6, 0.7];

function vec3List(fn) {
  return SPECIES_KEYS.map((k, i) => new THREE.Vector3(...fn(k, i)));
}

/** 수종 표(유니폼): 물든 잎 색·열매 색·껍질 색 배수·임포스터용 껍질 평균색 */
export function speciesUniforms(barkAvg) {
  const autumn = vec3List((k) => TREE_SPECIES[k]?.autumn || SHRUB_AUTUMN[k] || [0.3, 0.27, 0.1]);
  const fruit = vec3List((k) => SHRUB_SPECIES[k]?.fruit || [0.1, 0.08, 0.06]);
  const tint = vec3List((k, i) => BARK_TINT[i]);
  const avg = vec3List((k, i) => {
    const a = barkAvg[i === 0 ? 1 : BARK_LAYER[i]] || [0.2, 0.18, 0.15];
    return [a[0] * BARK_TINT[i][0], a[1] * BARK_TINT[i][1], a[2] * BARK_TINT[i][2]];
  });
  return {
    uAutumnCol: { value: autumn },
    uFruitCol: { value: fruit },
    uBarkTint: { value: tint },
    uBarkAvg: { value: avg },
  };
}

// ---------------------------------------------------------------------------
// 공용 GLSL
// ---------------------------------------------------------------------------
const TREE_COMMON = /* glsl */ `
uniform highp sampler2D uTreeData;
uniform float uWindOn;
const int BARK_L[10] = int[10](${BARK_LAYER.join(', ')});
const float FLUTTER[10] = float[10](${FLUTTER.map((f) => f.toFixed(2)).join(', ')});

vec4 tFetch(int i, int k) {
  int t = i * ${TEXELS} + k;
  return texelFetch(uTreeData, ivec2(t % ${TREE_TEX_W}, t / ${TREE_TEX_W}), 0);
}
// 템플릿 점 → 월드: 가지가 붙은 높이 hA에서의 줄기 변위 + 회전·크기 (Shelterbelts._toWorld와 같은 식)
vec3 treePoint(vec3 p, float hA, vec4 t0, vec4 t1, vec4 t2) {
  float s = t0.w;
  vec2 off = stemOffset(hA * s, t1);
  vec2 q = p.xz * s;
  return vec3(t0.x + off.x + q.x * t2.x - q.y * t2.y, t0.y + p.y * s, t0.z + off.y + q.x * t2.y + q.y * t2.x);
}
vec3 treeRot(vec3 n, vec4 t2) { return vec3(n.x * t2.x - n.z * t2.y, n.y, n.x * t2.y + n.z * t2.x); }
vec3 treeRotInv(vec3 n, vec4 t2) { return vec3(n.x * t2.x + n.z * t2.y, n.y, -n.x * t2.y + n.z * t2.x); }

// 나무 전체 흔들림: 수관 높이 바람의 제곱에 비례하는 휨(높이²), 고유 진동수는 키에 반비례.
// 꼭대기 변위 ≈ 0.0028·v²·(H/15) m (7 m/s에서 15 m 나무 약 14 cm), 돌풍마다 커진다.
vec3 treeSway(vec3 base, float H, float seed, float hRel, out vec2 wdir, out float ws) {
  vec2 w = windAt(base.xz, max(2.0, H * 0.7), 10.0);
  ws = length(w);
  wdir = ws > 0.01 ? w / ws : vec2(1.0, 0.0);
  float f = 1.6 / sqrt(max(H, 1.5));
  float ph = seed * 6.2831853;
  float osc = sin(uTime * 6.2831853 * f + ph) * 0.6 + sin(uTime * 6.2831853 * f * 2.3 + ph * 3.0) * 0.2;
  float k = ws * ws * 0.0028 * (H / 15.0);
  float h = clamp(hRel / max(H, 0.5), 0.0, 1.25);
  vec2 perp = vec2(-wdir.y, wdir.x);
  vec2 d = (wdir * (0.65 + 0.45 * osc) + perp * 0.25 * sin(uTime * 6.2831853 * f * 0.7 + ph * 2.0)) * k * h * h;
  float drop = dot(d, d) / max(2.0 * hRel, 1.0);
  return vec3(d.x, -drop, d.y) * uWindOn;
}
// 가지 흔들림: 줄기에서 떨어진 거리(m)에 비례(같은 굵은 가지 묶음은 같은 위상 — 붙은 높이로 식별)
vec3 branchSway(float dist, float key, float ws, vec2 wdir) {
  float ph = fract(key * 7.31) * 6.2831853;
  float f = 1.1 + fract(key * 3.7) * 0.8;
  float a = ws * 0.0045 * dist * (0.6 + 0.4 * sin(uTime * 1.3 * f + ph * 1.7));
  float s1 = sin(uTime * 6.2831853 * f + ph);
  return vec3(wdir.x * s1 * 0.5, s1 * 0.8 + 0.2, wdir.y * s1 * 0.5) * a * uWindOn;
}
`;

const TREE_FRAG = /* glsl */ `
uniform vec3 uAutumnCol[10];
uniform vec3 uFruitCol[10];
uniform vec3 uBarkTint[10];
uniform vec3 uBarkAvg[10];
const int BARK_LF[10] = int[10](${BARK_LAYER.join(', ')});

float ditherN() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
// LOD 전환 디더: f ≤ 1이면 화소의 f만큼 그림, f > 1이면 나머지(1 - (f-1))를 그림 → 두 LOD가 겹치지 않고 이어진다
void lodClip(float f) {
  float n = ditherN();
  if (f <= 1.0) { if (n >= f) discard; }
  else if (n < f - 1.0) discard;
}
// 잎 하나가 물드는 문턱: 수관 위·바깥일수록, 가지마다·잎마다 다르게(낮을수록 먼저 물듦)
float autumnThr(float h01, float depth, float brR, float leafId) {
  float prone = 0.5 * h01 + 0.5 * (1.0 - depth) + (brR - 0.5) * 0.6;
  return leafId * 0.7 + (1.0 - prone) * 0.6;
}
// 햇빛 그림자(2단 캐스케이드): 위치를 offset만큼 해 쪽으로 밀어 얇은 잎의 자기 그림자 줄무늬를 막음
float treeSunShadow(vec3 wp, vec3 offset, float viewDepth) {
#if defined( TREE_LIT ) && defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
  SunLightShadow sl = sunLightShadows[0];
  vec4 swp = vec4(wp + offset, 1.0);
  float shadow = 1.0;
  for (int i = SUN_LIGHT_CASCADES - 1; i >= 0; i--) {
    vec4 cascade = sunShadowCascade[i];
    if (viewDepth >= cascade.x && viewDepth < cascade.y) {
      float cs = getShadow(sunShadowMap[0], sl.shadowMapSize, sl.shadowIntensity, sl.shadowBias, sl.shadowRadius, sunShadowMatrix[i] * swp);
      shadow = mix(cs, shadow, smoothstep(cascade.z, cascade.y, viewDepth));
    }
  }
  return shadow;
#else
  return 1.0;
#endif
}
// 껍질 법선(접선 공간 xy) → 월드: 화면 미분으로 접선틀
vec3 perturbN(vec3 N, vec3 p, vec2 uv, vec2 tn, float k) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float m = max(dot(T, T), dot(B, B));
  if (m < 1e-12) return N;
  return normalize(N + (T * tn.x + B * tn.y) * inversesqrt(m) * k);
}
// 껍질·나무 표면 빛(람베르트, 지형과 같은 규약)
vec3 woodShade(vec3 alb, vec3 N, vec3 wp, float gy, float viewDepth, float ao) {
  float sh = treeSunShadow(wp, N * 0.03 + uSunDir * 0.02, viewDepth);
  float vis = sh * canopySun(wp, gy) * cloudShadow(wp);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 direct = sunE() * ndl * vis;
  vec3 amb = shIrradiance(N) * canopySky(wp, gy) * ao;
  return alb * RECIPROCAL_PI * (direct + amb);
}
`;

const OUT_DECL = /* glsl */ `
#ifdef BAKE
layout(location = 0) out highp vec4 o0;
layout(location = 1) out highp vec4 o1;
#endif
`;

export function treeFrag(body) {
  return frag(body);
}
function frag(body) {
  // 그림자 맵 표본 선언은 빛을 받는 머티리얼(TREE_LIT)만: 깊이·굽기·임포스터는 그림자 표본기가 없다
  return `#include <common>\n#include <packing>\n#ifdef TREE_LIT\n#include <shadowmap_pars_fragment>\n#endif\n${commonGLSL()}\n${STEM_GLSL}\n${TREE_FRAG}\n${OUT_DECL}\n${body}`;
}
function vert(body) {
  return `#include <common>\n#ifdef TREE_LIT\n#include <shadowmap_pars_vertex>\n#endif\n${commonGLSL()}\n${STEM_GLSL}\n${TREE_COMMON}\n${body}`;
}
// 조각 셰이더의 그림자 varying 선언과 짝(값은 쓰지 않음: 그림자 위치는 treeSunShadow가 직접 계산)
export const SHADOW_VARY = /* glsl */ `
#if defined( TREE_LIT ) && defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
  vSunShadowWorldPosition = vec4(vWP, vViewZ);
  vSunShadowWorldNormal = vec3(0.0);
#endif
`;

const OUTPUT = /* glsl */ `
  gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWP);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

// ---------------------------------------------------------------------------
// 잎 뭉치 카드
// ---------------------------------------------------------------------------
const LEAF_VS = vert(/* glsl */ `
attribute vec2 aInst;
attribute vec4 aC1;
attribute vec4 aC2;
attribute vec4 aC3;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vNc;
varying vec3 vNs;
varying vec4 vLeaf;
varying vec4 vI;
varying vec3 vTint;
varying vec3 vOcc;
varying float vViewZ;
varying float vCardR;
void main() {
  int id = int(aInst.x + 0.5);
  vec4 t0 = tFetch(id, 0);
  vec4 t1 = tFetch(id, 1);
  vec4 t2 = tFetch(id, 2);
  vec4 t3 = tFetch(id, 3);
  vec4 t5 = tFetch(id, 5);
  vec4 t6 = tFetch(id, 6);
  vec4 t7 = tFetch(id, 7);
  vCardR = fract(aC2.w * 13.7 + t5.x * 3.1);
  vec3 cW = treePoint(aC3.xyz, aC2.x, t0, t1, t2);
  // 부러진 꼭대기 위의 잎은 없다(판정의 잎 볼륨도 같은 높이에서 잘림)
  if (cW.y > t2.z) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 local = aC3.xyz + (position - aC3.xyz) * t6.y;
  vec3 wp = treePoint(local, aC2.x, t0, t1, t2);
  vec3 nW = treeRot(normal, t2);
  int sp = int(t5.y + 0.5);
#ifndef BAKE
  vec2 wdir;
  float ws;
  vec3 sway = treeSway(t0.xyz, t5.z, t5.x, wp.y - t0.y, wdir, ws);
  vec3 bs = branchSway(length(aC3.xz) * t0.w, aC2.x + t5.x * 13.0, ws, wdir);
  float fl = sin(uTime * (7.0 + aC2.w * 6.0) + aC2.w * 40.0) * (0.008 + ws * 0.0035) * FLUTTER[sp];
  wp += sway + bs + nW * fl * uWindOn;
#endif
  vWP = wp;
  vUv = uv;
#ifdef BAKE
  vNc = normal;
  vNs = aC1.xyz;
#else
  vNc = nW;
  vNs = treeRot(aC1.xyz, t2);
#endif
  // 열매: 열매 맺은 덤불(인스턴스 표시)의 열매 달린 뭉치에만
  vLeaf = vec4(aC1.w, aC2.z, aC2.y, (int(t5.w + 0.5) & ${FLAG.fruit}) != 0 ? aC3.w : 0.0);
  vI = vec4(aInst.y, t5.y, t3.w, t5.w);
  vTint = t3.rgb;
#if !defined(BAKE) && !defined(DEPTH_PASS)
  // 이웃 수관이 해를 가리는 정도(그림자 맵 밖): 해 쪽으로 이 나무 꼭대기보다 높은 곳까지 올라간 지점의 수관 밀도
  float dy = max(t7.x + 1.0 - wp.y, 0.0);
  vec2 sp2 = wp.xz + uSunDir.xz / max(uSunDir.y, 0.15) * (dy + 1.5);
  float dens = canopySample(sp2, 1.0).r;
  float nb = 1.0 - dens * 0.85 * smoothstep(0.5, 5.0, dy) * uCanopyStrength;
  float sky = 1.0 - canopySample(wp.xz, 2.0).r * 0.45 * (1.0 - aC2.z * 0.7) * uCanopyStrength;
  vOcc = vec3(nb, sky, cloudShadow(wp));
#else
  vOcc = vec3(1.0);
#endif
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  ${SHADOW_VARY}
  gl_Position = projectionMatrix * mv;
}
`);

const LEAF_FS = frag(/* glsl */ `
uniform sampler2D uLeafAtlas;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vNc;
varying vec3 vNs;
varying vec4 vLeaf;
varying vec4 vI;
varying vec3 vTint;
varying vec3 vOcc;
varying float vViewZ;
varying float vCardR;
void main() {
#if !defined(BAKE) && !defined(DEPTH_PASS)
  lodClip(vI.x);
#endif
  vec4 tx = texture(uLeafAtlas, vUv);
  // 밉맵 단계만큼 덮임 보정(멀리서 수관이 성글어지지 않게)
  vec2 tsz = vec2(textureSize(uLeafAtlas, 0));
  vec2 ddx = dFdx(vUv * tsz);
  vec2 ddy = dFdy(vUv * tsz);
  float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
  float a = tx.a;
  // 잔가지·열매 구분은 가까운 밉맵에서만(멀리선 평균이 섞여 잎이 '열매'로 오인돼 지워지지 않게)
  float clsK = clamp(1.0 - (mip - 2.0) * 0.3, 0.0, 1.0);
  bool nonLeaf = tx.g > 1.0 - 0.5 * clsK;
  bool fruitPx = nonLeaf && tx.b > 0.6;
  if (fruitPx && vLeaf.w < 0.5) a *= 1.0 - clsK;
  // 가까이: 잎 윤곽을 날카롭게(문턱 0.5) / 멀리(밉맵): 평균 덮임을 그대로 보존(고정 문턱이면 성긴 뭉치가 통째로 사라짐)
  // 문턱은 결정적(잡음 없음): 카드마다 제 잎 모양이 남으므로 겹친 카드의 덮임이 그대로 합쳐진다.
  // 밉맵이 깊어질수록(작게 보일수록) 평균 덮임이 0.5 아래로 떨어지므로 문턱을 낮춰 수관 밀도를 지킨다
  float thrA = mix(0.5, 0.28, smoothstep(1.5, 6.0, mip));
#if defined(DEPTH_PASS) || defined(BAKE) || !defined(USE_A2C)
  if (a < thrA) discard;
  float alpha = 1.0;
#else
  float alpha = clamp((a - thrA) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
  if (alpha < 0.01) discard;
#endif
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
#else
  int sp = int(vI.y + 0.5);
  float leafId = tx.b;
  float shd = 0.5 + 0.78 * tx.r;
  float idv = 1.0 + (leafId - 0.5) * 0.16;
  float thr = autumnThr(vLeaf.y, vLeaf.x, vLeaf.z, leafId);
  vec3 Nc = normalize(gl_FrontFacing ? vNc : -vNc);
  vec3 N = normalize(mix(Nc, normalize(vNs), 0.6));
  float depth = vLeaf.x;
  float ao = mix(0.45, 1.0, 1.0 - depth) * mix(0.8, 1.0, vLeaf.y);
#ifdef BAKE
  // 임포스터: 명암·재질·물듦 문턱·법선(템플릿 공간)·차폐를 굽는다(색은 인스턴스마다 다시 칠함)
  float key = nonLeaf ? (fruitPx ? 0.5 + 0.5 * tx.r : 0.35 + 0.5 * tx.r) : shd * idv / 1.6;
  o0 = vec4(clamp(key, 0.0, 1.0), nonLeaf ? (fruitPx ? 1.0 : 0.5) : 0.0, clamp(thr, 0.0, 1.4) / 1.4, 1.0);
  o1 = vec4(N * 0.5 + 0.5, ao);
#else
  vec3 tint = vTint * (0.9 + 0.2 * vLeaf.z);
  vec3 leaf = tint * shd * idv;
  float yel = smoothstep(thr - 0.12, thr + 0.12, vI.z * 1.3);
  leaf = mix(leaf, uAutumnCol[sp] * shd * (0.85 + 0.3 * leafId), yel);
  // 마른 잎 몇 장
  leaf = mix(leaf, vec3(0.15, 0.1, 0.055) * shd, step(0.975, fract(leafId * 7.13 + vLeaf.z)) * 0.85);
  vec3 alb = leaf;
  float tr = 1.0;
  if (nonLeaf) {
    alb = fruitPx ? uFruitCol[sp] * (0.7 + 0.5 * tx.r) : vec3(0.11, 0.095, 0.08) * (0.7 + 0.6 * tx.r);
    tr = 0.0;
  }
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWP);
  // 수관 자체 그늘: 해 반대쪽·안쪽 잎
  float selfSun = mix(1.0, smoothstep(-0.55, 0.45, dot(normalize(vNs), L)), 0.8) * (1.0 - depth * 0.45);
  float sunVis = vOcc.x * selfSun;
#if defined( TREE_LIT ) && defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
  float smap = treeSunShadow(vWP, L * (0.08 + vViewZ * 0.0012), vViewZ);
  float farK = smoothstep(uCanopyFade.x, uCanopyFade.y, vViewZ);
  sunVis = mix(smap * mix(1.0, selfSun, 0.45), sunVis, farK);
#endif
  sunVis *= vOcc.z;
  float diff = max(0.0, (dot(N, L) + 0.45) / 1.45);
  // 투과: 해를 등진 잎을 볼 때(앞쪽 산란) + 잎 뒷면에 해가 비칠 때. 투과광은 노란 기가 도는 연두
  float fwd = pow(max(dot(-V, L), 0.0), 4.0);
  float back = max(-dot(Nc, L), 0.0);
  float trans = (0.55 * fwd + 0.45 * back) * (1.0 - depth * 0.5) * tr;
  vec3 transAlb = alb * vec3(1.0, 1.15, 0.55) * 1.15;
  vec3 E = sunE();
  // 하늘빛도 잎을 통과한다(그늘진 잎의 녹색 투과광)
  vec3 skyR = shIrradiance(N) * ao * vOcc.y;
  vec3 skyT = shIrradiance(-N) * 0.35 * ao * vOcc.y * tr;
  vec3 col = alb * RECIPROCAL_PI * (E * diff * sunVis + skyR) + transAlb * RECIPROCAL_PI * (E * trans * sunVis + skyT);
  gl_FragColor = vec4(col, alpha);
  ${OUTPUT}
#endif
#endif
}
`);

// ---------------------------------------------------------------------------
// 줄기(단위 원기둥 → 휘고 기울고 가늘어지는 줄기, 뿌리 퍼짐·덩이, 부러진/자른 꼭대기)
// ---------------------------------------------------------------------------
const TRUNK_VS = vert(/* glsl */ `
attribute vec2 aInst;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying vec4 vI;
varying vec4 vT;
varying float vViewZ;
varying float vGY;
void main() {
  int id = int(aInst.x + 0.5);
  vec4 t0 = tFetch(id, 0);
  vec4 t1 = tFetch(id, 1);
  vec4 t2 = tFetch(id, 2);
  vec4 t4 = tFetch(id, 4);
  vec4 t5 = tFetch(id, 5);
  vec4 t6 = tFetch(id, 6);
  vec4 t7 = tFetch(id, 7);
  float sink = t7.y;
  int fl = int(t5.w + 0.5);
  float isCap = step(1.00005, position.y);
  float isCenter = step(1.00015, position.y);
  float t = min(position.y, 1.0);
  float L = t4.x;
  float h = t * L;
  vec4 shape = vec4(L, t4.y, t4.z, t4.w);
  float r = stemRadius(h, shape, sink);
  float th = uv.x * 6.2831853;
  // 뿌리 덩이(둘레 평균 0, 밑동 0.4 m 안): 판정 원과의 차이는 반지름의 ±8 % 이내
  float lobe = (sin(th * 3.0 + t5.x * 40.0) * 0.6 + sin(th * 5.0 + t5.x * 90.0) * 0.4) * min(t4.w, 0.6) * 0.14 * exp(-max(h - sink, 0.0) / 0.3);
  r *= 1.0 + lobe;
  // 부러진 꼭대기: 맨 위 고리를 들쭉날쭉(쪼개진 섬유), 가운데는 조금 낮게
  float jag = 0.0;
  if ((fl & ${FLAG.jagged}) != 0 && t > 0.999) {
    jag = (0.5 + 0.5 * sin(th * 4.0 + t5.x * 20.0)) * 0.7 + vnoise(vec2(th * 2.0, t5.x * 50.0)) * 0.7;
    jag *= r * 2.0;
    if (isCenter > 0.5) jag = r * 0.9;
  }
  float hh = h - jag;
  vec2 off = stemOffset(hh, t1);
  vec3 wp = vec3(t0.x + off.x + position.x * r, t0.y + hh, t0.z + off.y + position.z * r);
  float dr = (stemRadius(h + 0.05, shape, sink) - stemRadius(max(h - 0.05, 0.0), shape, sink)) / 0.1;
  vec2 sl = stemSlope(h, t1);
  vec3 n = normalize(vec3(cos(th), -(sl.x * cos(th) + sl.y * sin(th) + dr), sin(th)));
  if (isCap > 0.5) n = (fl & ${FLAG.jagged}) != 0 ? normalize(vec3(cos(th) * 0.5, 1.0, sin(th) * 0.5)) : vec3(0.0, 1.0, 0.0);
#ifndef BAKE
  if ((fl & ${FLAG.still}) == 0) {
    vec2 wdir;
    float ws;
    wp += treeSway(t0.xyz, t5.z, t5.x, hh, wdir, ws);
  }
#endif
  vWP = wp;
#ifdef BAKE
  vN = n;
#else
  vN = n;
#endif
  vUv = isCap > 0.5 ? vec2(position.x, position.z) * r : vec2(uv.x * t6.z, hh);
  vT = vec4(hh, t6.w, t5.x, isCap);
  vI = vec4(aInst.y, t5.y, 0.0, t5.w);
  vGY = t0.y + sink;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  ${SHADOW_VARY}
  gl_Position = projectionMatrix * mv;
}
`);

const BARK_ALBEDO = /* glsl */ `
uniform highp sampler2DArray uBarkAlb;
uniform highp sampler2DArray uBarkNrm;
// 수종 껍질(포플러는 아래 거친 층 → 위 흰 층, 경계가 들쭉날쭉)
void barkSample(int sp, vec2 uv, float h, float sw, bool upper, out vec3 alb, out vec4 nm) {
  float layer = float(BARK_LF[sp]);
  vec4 a = texture(uBarkAlb, vec3(uv, layer));
  nm = texture(uBarkNrm, vec3(uv, layer));
  if (sp == 0) {
    float w = upper ? 1.0 : smoothstep(-0.5, 0.5, h - sw + (vnoise(uv * vec2(2.0, 0.7)) - 0.5) * 1.6);
    if (w > 0.0) {
      vec4 a2 = texture(uBarkAlb, vec3(uv, 1.0));
      vec4 n2 = texture(uBarkNrm, vec3(uv, 1.0));
      a = mix(a, a2, w);
      nm = mix(nm, n2, w);
    }
  }
  alb = a.rgb * uBarkTint[sp];
}
`;

const TRUNK_FS = frag(/* glsl */ `
${BARK_ALBEDO}
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying vec4 vI;
varying vec4 vT;
varying float vViewZ;
varying float vGY;
void main() {
#if !defined(BAKE) && !defined(DEPTH_PASS)
  lodClip(vI.x);
#endif
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
#else
  int sp = int(vI.y + 0.5);
  int fl = int(vI.w + 0.5);
  vec3 alb;
  vec4 nm;
  barkSample(sp, vUv, vT.x, vT.y, false, alb, nm);
  alb *= 0.88 + 0.24 * fract(vT.z * 7.7);
  vec3 N0 = normalize(vN);
  // 이끼: 북쪽(-z)·밑동, 고사목·그루터기에 더
  float north = smoothstep(-0.2, 0.8, -N0.z);
  float mossAmt = ((fl & ${FLAG.dead}) != 0 ? 0.8 : 0.45) * fract(vT.z * 13.1);
  float moss = north * (1.0 - smoothstep(0.4, 2.2, vT.x)) * mossAmt * smoothstep(0.35, 0.7, vnoise(vUv * vec2(6.0, 3.0)));
  alb = mix(alb, vec3(0.07, 0.1, 0.03), moss);
  // 밑동 흙 튐
  alb *= mix(0.65, 1.0, smoothstep(0.1, 0.45, vT.x));
  float ao = nm.b * mix(0.62, 1.0, smoothstep(0.0, 1.6, vT.x));
  vec2 tn = nm.rg * 2.0 - 1.0;
  if (vT.w > 0.5) {
    float rr = length(vUv);
    if ((fl & ${FLAG.sawn}) != 0) {
      // 톱으로 자른 면: 나이테(약 4 mm), 비바람에 회색으로 바램
      float ring = 0.5 + 0.5 * sin(rr * 1570.0 + vnoise(vUv * 30.0) * 4.0);
      alb = mix(vec3(0.36, 0.33, 0.29), vec3(0.27, 0.24, 0.2), ring * 0.6) * (0.85 + 0.3 * vnoise(vUv * 60.0));
    } else {
      // 부러진 면: 쪼개진 섬유(밝은 속살이 바래 회갈색)
      alb = vec3(0.34, 0.3, 0.24) * (0.65 + 0.45 * vnoise(vec2(vUv.x * 80.0, vUv.y * 12.0)));
    }
    tn = vec2(0.0);
    ao = 0.9;
  }
#ifdef BAKE
  vec3 Nb = perturbN(N0, vWP, vUv, tn, 0.6);
  vec3 avg = uBarkAvg[sp];
  float key = dot(alb, vec3(0.3, 0.55, 0.15)) / max(dot(avg, vec3(0.3, 0.55, 0.15)), 1e-3);
  o0 = vec4(clamp(key * 0.5, 0.0, 1.0), 0.5, 1.0, 1.0);
  o1 = vec4(Nb * 0.5 + 0.5, ao);
#else
  vec3 N = perturbN(N0, vWP, vUv, tn, 1.0);
  vec3 col = woodShade(alb, N, vWP, vGY, vViewZ, ao);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
#endif
#endif
}
`);

// ---------------------------------------------------------------------------
// 가지 관(원줄기·굵은 가지·잔가지·죽은 가지)
// ---------------------------------------------------------------------------
const BRANCH_VS = vert(/* glsl */ `
attribute vec2 aInst;
attribute vec3 aAxis;
attribute vec4 aB;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying vec4 vI;
varying vec4 vB;
varying float vViewZ;
varying float vGY;
void main() {
  int id = int(aInst.x + 0.5);
  vec4 t0 = tFetch(id, 0);
  vec4 t1 = tFetch(id, 1);
  vec4 t2 = tFetch(id, 2);
  vec4 t5 = tFetch(id, 5);
  // 굵기 배율: 두 갈래 원줄기(단계 0)는 줄기처럼 s·rScale, 나머지 가지는 s·√rScale (판정과 같음)
  float rs = aB.y < 0.5 ? t2.w * t2.w / max(t0.w, 1e-4) : t2.w;
  vec3 axW = treePoint(aAxis, aB.x, t0, t1, t2);
  vec3 wp = axW + treeRot(position - aAxis, t2) * rs;
  vec3 nW = treeRot(normal, t2);
#ifndef BAKE
  vec2 wdir;
  float ws;
  wp += treeSway(t0.xyz, t5.z, t5.x, wp.y - t0.y, wdir, ws);
  if (aB.y > 0.5) wp += branchSway(length(aAxis.xz) * t0.w, aB.x + t5.x * 13.0, ws, wdir);
#endif
  vWP = wp;
  vN = nW;
#ifdef BAKE
  vN = normal;
#endif
  vUv = vec2(uv.x, uv.y * t0.w);
  vB = vec4(aB.y, aB.w, t2.z, axW.y);
  vI = vec4(aInst.y, t5.y, 0.0, t5.w);
  vGY = t0.y + 0.12;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  ${SHADOW_VARY}
  gl_Position = projectionMatrix * mv;
}
`);

const BRANCH_FS = frag(/* glsl */ `
${BARK_ALBEDO}
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying vec4 vI;
varying vec4 vB;
varying float vViewZ;
varying float vGY;
void main() {
  // 부러진 꼭대기 위 가지 없음
  if (vB.w > vB.z) discard;
#if !defined(BAKE) && !defined(DEPTH_PASS)
  lodClip(vI.x);
#endif
#ifdef DEPTH_PASS
  gl_FragColor = vec4(1.0);
#else
  int sp = int(vI.y + 0.5);
  int fl = int(vI.w + 0.5);
  bool dead = vB.x > 2.5 || (fl & ${FLAG.dead}) != 0;
  vec3 alb;
  vec4 nm;
  barkSample(dead ? 5 : sp, vUv, 99.0, 0.0, true, alb, nm);
  // 잔가지는 매끈한 어린 껍질
  float thin = step(1.5, vB.x) * (1.0 - step(2.5, vB.x));
  alb = mix(alb, uBarkAvg[dead ? 5 : sp] * 1.05, thin * 0.6);
  alb *= 0.9 + 0.2 * vB.y;
  float ao = mix(1.0, nm.b, 0.7);
  vec2 tn = (nm.rg * 2.0 - 1.0) * (1.0 - thin);
#ifdef BAKE
  vec3 Nb = perturbN(normalize(vN), vWP, vUv, tn, 0.5);
  vec3 avg = uBarkAvg[sp];
  float key = dot(alb, vec3(0.3, 0.55, 0.15)) / max(dot(avg, vec3(0.3, 0.55, 0.15)), 1e-3);
  o0 = vec4(clamp(key * 0.5, 0.0, 1.0), 0.5, 1.0, 1.0);
  o1 = vec4(Nb * 0.5 + 0.5, ao);
#else
  vec3 N = perturbN(normalize(vN), vWP, vUv, tn, 0.8);
  vec3 col = woodShade(alb, N, vWP, vGY, vViewZ, ao);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
#endif
#endif
}
`);

// ---------------------------------------------------------------------------
// 쓰러진 나무·그루터기 가지·뿌리판(월드 좌표 정적 기하)
// ---------------------------------------------------------------------------
const WOOD_VS = /* glsl */ `
#include <common>
#ifdef TREE_LIT
#include <shadowmap_pars_vertex>
#endif
${commonGLSL()}
attribute vec4 aWood;
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying vec4 vW;
varying float vViewZ;
varying float vGY;
void main() {
  vWP = position;
  vN = normal;
  vUv = uv;
  vW = aWood;
  vGY = terrainHeight(position.xz);
  vec4 mv = viewMatrix * vec4(position, 1.0);
  vViewZ = -mv.z;
  ${SHADOW_VARY}
  gl_Position = projectionMatrix * mv;
}
`;

const WOOD_FS = frag(/* glsl */ `
${BARK_ALBEDO}
varying vec2 vUv;
varying vec3 vWP;
varying vec3 vN;
varying vec4 vW;
varying float vViewZ;
varying float vGY;
void main() {
  vec3 N0 = normalize(vN);
  vec3 alb;
  vec4 nm;
  int layer = int(vW.x + 0.5);
  float ao = 1.0;
  vec2 tn = vec2(0.0);
  if (vW.w < 0.5) {
    // 껍질: 층 번호를 수종 표 대신 직접(5 = 고사목 층)
    barkSample(layer, vUv, 99.0, 0.0, true, alb, nm);
    alb *= 0.85 + 0.3 * vW.z;
    // 윗면 이끼, 땅 닿는 쪽 습하고 어두움
    float up = smoothstep(0.1, 0.7, N0.y);
    float m = up * vW.y * smoothstep(0.3, 0.65, vnoise(vWP.xz * 3.0 + vWP.y * 2.0) * 0.7 + vnoise(vWP.xz * 11.0) * 0.3);
    alb = mix(alb, vec3(0.07, 0.11, 0.03), m);
    // 땅에 닿은 아랫면만 습해 어둡다
    alb *= mix(0.72, 1.0, smoothstep(0.0, 0.1, vWP.y - vGY));
    ao = mix(1.0, nm.b, 0.6) * mix(0.7, 1.0, smoothstep(0.0, 0.15, vWP.y - vGY));
    tn = nm.rg * 2.0 - 1.0;
  } else if (vW.w < 1.5) {
    // 끝면: 부러진 섬유 + 바랜 나이테
    float rr = length(vUv);
    float ring = 0.5 + 0.5 * sin(rr * 1570.0 + vnoise(vUv * 30.0) * 5.0);
    alb = mix(vec3(0.34, 0.3, 0.25), vec3(0.24, 0.21, 0.17), ring * 0.5) * (0.7 + 0.4 * vnoise(vec2(vUv.x * 70.0, vUv.y * 9.0)));
    ao = 0.85;
  } else {
    // 뿌리판: 흙덩이 + 굵은·가는 뿌리 줄무늬 + 돌
    float n1 = vnoise(vUv * 9.0 + vWP.y * 3.0);
    float roots = smoothstep(0.75, 0.9, vnoise(vec2(atan(vUv.y, vUv.x) * 9.0, length(vUv) * 2.0)));
    alb = mix(vec3(0.12, 0.095, 0.07), vec3(0.2, 0.16, 0.12), n1);
    alb = mix(alb, vec3(0.26, 0.21, 0.16), roots * 0.8);
    alb = mix(alb, vec3(0.3, 0.29, 0.27), step(0.93, vnoise(vUv * 23.0)) * 0.7);
    ao = 0.75;
  }
  vec3 N = perturbN(N0, vWP, vUv, tn, 1.0);
  vec3 col = woodShade(alb, N, vWP, vGY, vViewZ, ao);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}
`);

// ---------------------------------------------------------------------------
// 임포스터(먼 나무): 원통형 빌보드 + 방위 8장 중 가까운 두 장을 디더로 섞음, 구운 법선으로 다시 빛
// ---------------------------------------------------------------------------
const IMP_VS = vert(/* glsl */ `
attribute vec2 aInst;
uniform vec4 uImpTpl[24];
uniform vec2 uImpGrid;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec4 vI;
varying vec3 vWP;
varying vec3 vTint;
varying vec4 vRot;
varying vec3 vOcc;
void main() {
  int id = int(aInst.x + 0.5);
  vec4 t0 = tFetch(id, 0);
  vec4 t1 = tFetch(id, 1);
  vec4 t2 = tFetch(id, 2);
  vec4 t3 = tFetch(id, 3);
  vec4 t5 = tFetch(id, 5);
  vec4 t6 = tFetch(id, 6);
  vec4 t7 = tFetch(id, 7);
  int tpl = int(t6.x + 0.5);
  vec4 info = uImpTpl[tpl];
  float s = t0.w;
  float hH = info.y * s;
  vec2 d = cameraPosition.xz - t0.xz;
  d = length(d) > 1e-3 ? normalize(d) : vec2(0.0, 1.0);
  vec2 dt = vec2(d.x * t2.x + d.y * t2.y, -d.x * t2.y + d.y * t2.x);
  float psi = atan(dt.x, dt.y);
  float f = psi / (6.2831853 / ${IMP.views}.0);
  float k0 = floor(f);
  float w = f - k0;
  float kA = mod(k0, ${IMP.views}.0);
  float kB = mod(k0 + 1.0, ${IMP.views}.0);
  vec3 right = vec3(d.y, 0.0, -d.x);
  float y = info.z * s + position.y * hH;
  vec2 lean = stemOffset(max(y, 0.0), t1);
  vec3 wp = vec3(t0.x + lean.x, t0.y + y, t0.z + lean.y) + right * position.x * info.x * s;
#ifndef BAKE
  vec2 wdir;
  float ws;
  wp += treeSway(t0.xyz, t5.z, t5.x, y, wdir, ws);
#endif
  vec2 grid = uImpGrid;
  vec2 inFrame = vec2(position.x + 0.5, position.y);
  float fa = float(tpl) * ${IMP.views}.0 + kA;
  float fb = float(tpl) * ${IMP.views}.0 + kB;
  vUvA = (vec2(mod(fa, grid.x), floor(fa / grid.x)) + inFrame) / grid;
  vUvB = (vec2(mod(fb, grid.x), floor(fb / grid.x)) + inFrame) / grid;
  vI = vec4(aInst.y, t5.y, t3.w, w);
  vTint = t3.rgb;
  vRot = vec4(t2.x, t2.y, t5.x, t5.w);
  vWP = wp;
  float dy = max(t7.x + 1.0 - wp.y, 0.0);
  vec2 sp2 = wp.xz + uSunDir.xz / max(uSunDir.y, 0.15) * (dy + 1.5);
  float nb = 1.0 - canopySample(sp2, 1.0).r * 0.85 * smoothstep(0.5, 5.0, dy) * uCanopyStrength;
  float sky = 1.0 - canopySample(wp.xz, 2.0).r * 0.4 * uCanopyStrength;
  vOcc = vec3(nb, sky, cloudShadow(wp));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`);

const IMP_FS = frag(/* glsl */ `
uniform sampler2D uImpA;
uniform sampler2D uImpB;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec4 vI;
varying vec3 vWP;
varying vec3 vTint;
varying vec4 vRot;
varying vec3 vOcc;
void main() {
  lodClip(vI.x);
  // 이웃한 두 방위 그림을 화소 디더로 섞음
  vec2 uv = hash2i(ivec2(gl_FragCoord.xy) + ivec2(17, 31)) < vI.w ? vUvB : vUvA;
  vec4 k0 = texture(uImpA, uv);
  vec4 k1 = texture(uImpB, uv);
  float a = k0.a;
  vec2 isz = vec2(textureSize(uImpA, 0));
  vec2 ddx = dFdx(uv * isz);
  vec2 ddy = dFdy(uv * isz);
  float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
  float thrA = mix(0.5, 0.3, smoothstep(0.5, 4.0, mip));
#ifdef USE_A2C
  float alpha = clamp((a - thrA) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
  if (alpha < 0.01) discard;
#else
  if (a < thrA) discard;
  float alpha = 1.0;
#endif
  float ia = 1.0 / max(a, 1e-3);
  float key = k0.r * ia;
  float mat = k0.g * ia;
  float thr = k0.b * ia * 1.4;
  vec3 nt = normalize(k1.rgb * ia * 2.0 - 1.0);
  float ao = k1.a * ia;
  vec3 N = vec3(nt.x * vRot.x - nt.z * vRot.y, nt.y, nt.x * vRot.y + nt.z * vRot.x);
  int sp = int(vI.y + 0.5);
  vec3 alb;
  float tr = 0.0;
  if (mat < 0.25) {
    vec3 leaf = vTint * key * 1.6;
    float yel = smoothstep(thr - 0.12, thr + 0.12, vI.z * 1.3);
    alb = mix(leaf, uAutumnCol[sp] * key * 1.6 * 0.95, yel);
    tr = 1.0;
  } else if (mat < 0.75) {
    alb = uBarkAvg[sp] * key * 2.0;
  } else if ((int(vRot.w + 0.5) & ${FLAG.fruit}) != 0) {
    alb = uFruitCol[sp] * key;
  } else {
    alb = vTint * 0.9;
    tr = 1.0;
  }
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWP);
  float selfSun = smoothstep(-0.6, 0.4, dot(N, L));
  float sunVis = vOcc.x * mix(1.0, selfSun, 0.6) * vOcc.z;
  float diff = max(0.0, (dot(N, L) + 0.45) / 1.45);
  float fwd = pow(max(dot(-V, L), 0.0), 4.0);
  float trans = 0.5 * fwd * tr;
  vec3 E = sunE();
  vec3 col = alb * RECIPROCAL_PI * (E * diff * sunVis + shIrradiance(N) * ao * vOcc.y) + alb * vec3(1.0, 1.15, 0.55) * 1.15 * RECIPROCAL_PI * E * trans * sunVis;
  gl_FragColor = vec4(col, alpha);
  ${OUTPUT}
}
`);

// ---------------------------------------------------------------------------
// 머티리얼 공장
// ---------------------------------------------------------------------------
function baseUniforms(shared, extra = {}, lights = false) {
  const u = {};
  if (lights) Object.assign(u, THREE.UniformsUtils.clone(THREE.UniformsLib.lights));
  Object.assign(u, U, shared, extra);
  return u;
}

/**
 * @param {'leaf'|'trunk'|'branch'} kind
 * @param {'main'|'depth'|'bake'} mode
 * @param {object} shared 공용 유니폼(uTreeData, uWindOn, uLeafAtlas, uBark*, 수종 표 …)
 * @param {{a2c:boolean}} opt
 */
export function makeTreeMaterial(kind, mode, shared, opt = {}) {
  const src = { leaf: [LEAF_VS, LEAF_FS], trunk: [TRUNK_VS, TRUNK_FS], branch: [BRANCH_VS, BRANCH_FS] }[kind];
  const defines = {};
  if (mode === 'depth') defines.DEPTH_PASS = '';
  if (mode === 'bake') defines.BAKE = '';
  if (mode === 'main' && opt.a2c && kind === 'leaf') defines.USE_A2C = '';
  if (mode === 'main') defines.TREE_LIT = '';
  const m = new THREE.ShaderMaterial({
    uniforms: baseUniforms(shared, {}, mode === 'main'),
    vertexShader: src[0],
    fragmentShader: src[1],
    defines,
    lights: mode === 'main',
    side: kind === 'leaf' ? THREE.DoubleSide : THREE.FrontSide,
    alphaToCoverage: mode === 'main' && kind === 'leaf' && !!opt.a2c,
    glslVersion: mode === 'bake' ? THREE.GLSL3 : null,
  });
  m.name = `tree-${kind}-${mode}`;
  return m;
}

export function makeWoodMaterial(shared) {
  const m = new THREE.ShaderMaterial({
    uniforms: baseUniforms(shared, {}, true),
    vertexShader: WOOD_VS,
    fragmentShader: WOOD_FS,
    defines: { TREE_LIT: '' },
    lights: true,
  });
  m.name = 'tree-wood';
  return m;
}

export function makeImpostorMaterial(shared, impA, impB, tplInfo, grid, opt = {}) {
  const defines = {};
  if (opt.a2c) defines.USE_A2C = '';
  const m = new THREE.ShaderMaterial({
    uniforms: baseUniforms(shared, { uImpA: { value: impA }, uImpB: { value: impB }, uImpTpl: { value: tplInfo }, uImpGrid: { value: grid } }, false),
    vertexShader: IMP_VS,
    fragmentShader: IMP_FS,
    defines,
    side: THREE.DoubleSide,
    alphaToCoverage: !!opt.a2c,
  });
  m.name = 'tree-impostor';
  return m;
}
