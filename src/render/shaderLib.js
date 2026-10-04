// 공용 GLSL: 해시/노이즈(CPU core/noise.js와 동일), 지형 높이, 바람, 수관 햇빛 얼룩, 대기 원근(안개).
// 내장 머티리얼(MeshLambert 등)에 끼워 넣는 패치 도우미도 여기 있다.

import * as THREE from 'three';

// 모든 셰이더가 공유하는 유니폼 객체(값만 갱신하면 모든 머티리얼에 반영)
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(-0.739, 0.431, 0.518).normalize() },
  // 지면에 닿는 직사광 = uSunColor(정규화된 색) × uSunIntensity
  uSunColor: { value: new THREE.Color(1.0, 0.92, 0.75) },
  uSunIntensity: { value: 3.3 },
  uWind: { value: new THREE.Vector4(1, 0, 5, 0) }, // dirX, dirZ, speed, time
  uTerrainHD: { value: null },
  uTerrainInfo: { value: new THREE.Vector4(700, 1, 1401, 0) }, // half, res, N
  uTerrainP0: { value: new THREE.Vector4(2.4, 340, 0.55, 75) }, // largeAmp, largeScale, midAmp, midScale
  uTerrainP1: { value: new THREE.Vector4(0.08, 9, 0, 0) }, // smallAmp, smallScale
  uRut: { value: new THREE.Vector4(1.65, 0.36, 0.11, 0.035) }, // gauge, width, depth, centerRise
  uSurfA: { value: null },
  uSurfB: { value: null },
  uSurfC: { value: null },
  uShelterTex: { value: null },
  uShelterInfo: { value: new THREE.Vector4(700, 4, 351, 0) },
  uCanopyTex: { value: null },
  uCanopyInfo: { value: new THREE.Vector4(700, 1, 1400, 0) },
  uCanopyStrength: { value: 1.0 },
  // 잎 그림자가 그림자 맵에 들어가는 거리(시작, 끝): 그 안에서는 수관 지도 햇빛 가림을 끈다(이중 그늘 방지)
  uCanopyFade: { value: new THREE.Vector2(-2, -1) },
  // 하늘빛(지면 반사 포함) 2차 구면조화: 복사휘도 계수(three.js LightProbe 규약)
  uSH: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
  // 이전 셰이더 호환용 반구광(SH에서 계산해 채움)
  uHemiSky: { value: new THREE.Color(0.56, 0.66, 0.88) },
  uHemiGround: { value: new THREE.Color(0.4, 0.34, 0.24) },
  uHemiIntensity: { value: 1.0 },
  // 하늘 모델: tauR, (tauM, mieG, kR, kM), (kMs, 지평선 탈채도, 0, 0)
  uSkyTauR: { value: new THREE.Vector3(0.0464, 0.108, 0.2648) },
  uSkyP: { value: new THREE.Vector4(0.14, 0.78, 4.5, 0.7) },
  uSkyP2: { value: new THREE.Vector4(0.015, 0.65, 0, 0) },
  // 대기 원근: (소산 계수, 고도 척도, 0, 0), 색별 배수
  uHaze: { value: new THREE.Vector4(0.00066, 1200, 0, 0) },
  uHazeTint: { value: new THREE.Vector3(0.86, 1.0, 1.16) },
  // 적운(높이, 크기, 덮임 문턱, 불투명도), 권운(높이, 크기, 불투명도, 0)
  uCloud: { value: new THREE.Vector4(1600, 1100, 0.56, 0.78) },
  uCloud2: { value: new THREE.Vector4(8000, 5200, 0.32, 0) },
  uCloudOffset: { value: new THREE.Vector2() },
  uCirrusOffset: { value: new THREE.Vector2() },
};

export const GLSL_COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec4 uWind;
uniform highp sampler2D uTerrainHD;
uniform vec4 uTerrainInfo;
uniform vec4 uTerrainP0;
uniform vec4 uTerrainP1;
uniform vec4 uRut;
uniform sampler2D uSurfA;
uniform sampler2D uSurfB;
uniform sampler2D uSurfC;
uniform sampler2D uShelterTex;
uniform vec4 uShelterInfo;
uniform sampler2D uCanopyTex;
uniform vec4 uCanopyInfo;
uniform float uCanopyStrength;
uniform vec2 uCanopyFade;
uniform float uSunIntensity;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
uniform float uHemiIntensity;
uniform vec3 uSH[9];
uniform vec3 uSkyTauR;
uniform vec4 uSkyP;
uniform vec4 uSkyP2;
uniform vec4 uHaze;
uniform vec3 uHazeTint;
uniform vec4 uCloud;
uniform vec4 uCloud2;
uniform vec2 uCloudOffset;
uniform vec2 uCirrusOffset;

float hash2i(ivec2 p) {
  uint h = uint(p.x) * 0x8da6b343u ^ uint(p.y) * 0xd8163841u;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h ^= h >> 16u;
  return float(h >> 8u) / 16777216.0;
}
float hash1(float n) { return hash2i(ivec2(int(n), 9137)); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = hash2i(c);
  float b = hash2i(c + ivec2(1, 0));
  float d = hash2i(c + ivec2(0, 1));
  float e = hash2i(c + ivec2(1, 1));
  return a + (b - a) * u.x + (d - a) * u.y + (a - b - d + e) * u.x * u.y;
}
float fbmN(vec2 p, int oct) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    sum += amp * vnoise(p + vec2(float(i) * 17.13, -float(i) * 9.71));
    norm += amp;
    p *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

// ---- 지형 (world/Terrain.js와 같은 식) ----
float baseHeight(vec2 p) {
  float a = (fbmN(vec2(p.x / uTerrainP0.y + 13.7, p.y / uTerrainP0.y - 4.1), 3) - 0.5) * 2.0 * uTerrainP0.x;
  float b = (fbmN(vec2(p.x / uTerrainP0.w - 7.3, p.y / uTerrainP0.w + 2.9), 2) - 0.5) * 2.0 * uTerrainP0.z;
  float c = (vnoise(p / uTerrainP1.y) - 0.5) * 2.0 * uTerrainP1.x;
  float far = smoothstep(1400.0, 5000.0, length(p));
  float d = far > 0.0 ? (fbmN(vec2(p.x / 2600.0 + 3.3, p.y / 2600.0 - 8.1), 3) - 0.42) * 2.0 * 26.0 * far : 0.0;
  return a + b + c + d;
}
float rutProfile(float d) {
  float ad = abs(d);
  if (ad > 1.2) return 0.0;
  float h = 0.0;
  float t = (ad - uRut.x * 0.5) / (uRut.y * 0.5);
  if (t > -1.0 && t < 1.0) { float k = 1.0 - t * t; h -= uRut.z * k * k; }
  float c = ad / (uRut.x * 0.5 - uRut.y * 0.5);
  if (c < 1.0) { float k = 1.0 - c * c; h += uRut.w * k * k; }
  return h;
}
bool inTerrainMap(vec2 p) {
  vec2 c = (p + uTerrainInfo.x) / uTerrainInfo.y;
  return c.x >= 1.0 && c.y >= 1.0 && c.x <= uTerrainInfo.z - 2.0 && c.y <= uTerrainInfo.z - 2.0;
}
// (높이, 도로 거리): 3차 B-스플라인을 쌍선형 표본 4번으로(반정밀도 텍스처, CPU _bspline과 같은 값)
vec2 terrainHD(vec2 p) {
  float N = uTerrainInfo.z;
  vec2 c = (p + uTerrainInfo.x) / uTerrainInfo.y;
  if (c.x < 1.0 || c.y < 1.0 || c.x > N - 2.0 || c.y > N - 2.0) return vec2(baseHeight(p), 1000.0);
  vec2 i = floor(c);
  vec2 f = c - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / N;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) / N;
  vec2 t00 = textureLod(uTerrainHD, vec2(h0.x, h0.y), 0.0).rg;
  vec2 t10 = textureLod(uTerrainHD, vec2(h1.x, h0.y), 0.0).rg;
  vec2 t01 = textureLod(uTerrainHD, vec2(h0.x, h1.y), 0.0).rg;
  vec2 t11 = textureLod(uTerrainHD, vec2(h1.x, h1.y), 0.0).rg;
  return g0.y * (g0.x * t00 + g1.x * t10) + g1.y * (g0.x * t01 + g1.x * t11);
}
vec4 surfSampleA(vec2 p) { return textureLod(uSurfA, ((p + uTerrainInfo.x) / uTerrainInfo.y + 0.5) / uTerrainInfo.z, 0.0); }
vec4 surfSampleB(vec2 p) { return textureLod(uSurfB, ((p + uTerrainInfo.x) / uTerrainInfo.y + 0.5) / uTerrainInfo.z, 0.0); }
vec4 surfSampleC(vec2 p) {
  int N = int(uTerrainInfo.z);
  ivec2 c = clamp(ivec2(floor((p + uTerrainInfo.x) / uTerrainInfo.y + 0.5)), ivec2(0), ivec2(N - 1));
  return texelFetch(uSurfC, c, 0);
}
// 미세 요철(Terrain.js microRelief와 같은 식): 일반 ±2.4 cm, 숲 바닥 둔덕 ±5 cm, 갈아엎은 이랑 ±6 cm
float microReliefW(vec2 p, vec4 sa, float dir) {
  float n1 = vnoise(p * 0.9 + vec2(13.1, 7.7)) - 0.5;
  float n2 = vnoise(p * 2.6 + vec2(-4.3, 9.1)) - 0.5;
  float general = n1 * 0.035 + n2 * 0.014;
  float forest = (vnoise(p * 0.45 + vec2(3.3)) - 0.5) * 0.09 + n2 * 0.02;
  vec2 rowN = vec2(-sin(dir), cos(dir));
  float q = dot(p, rowN);
  float furrow = cos(6.2831853 * q / 0.75) * 0.045 + n1 * 0.02;
  float wGen = max(0.0, 1.0 - sa.g - sa.a);
  return general * wGen + forest * sa.a + furrow * sa.g;
}
float microRelief(vec2 p) {
  if (!inTerrainMap(p)) return 0.0;
  return microReliefW(p, surfSampleA(p), surfSampleC(p).r * 3.14159265);
}
// 거시 지형(B-스플라인 + 바퀴 자국)
float terrainMacro(vec2 p) {
  vec2 hd = terrainHD(p);
  return hd.x + rutProfile(hd.y);
}
// 판정과 같은 높이(미세 요철 포함)
float terrainHeight(vec2 p) {
  return terrainMacro(p) + microRelief(p);
}
// 화면용 높이: 미세 요철은 가까운 곳(격자가 표현 가능한 곳)만, 멀어지면 0으로(CPU 판정은 항상 포함)
float microFade(vec2 p) {
  return 1.0 - smoothstep(24.0, 40.0, distance(p, cameraPosition.xz));
}
float terrainHeightVis(vec2 p) {
  return terrainMacro(p) + microRelief(p) * microFade(p);
}
vec3 terrainNormal(vec2 p, float e) {
  float hx = terrainMacro(p + vec2(e, 0.0)) - terrainMacro(p - vec2(e, 0.0));
  float hz = terrainMacro(p + vec2(0.0, e)) - terrainMacro(p - vec2(0.0, e));
  return normalize(vec3(-hx, 2.0 * e, -hz));
}

// ---- 바람 (world/Wind.js와 같은 식) ----
float windShelter(vec2 p) {
  vec2 uv = (p + uShelterInfo.x) / (uShelterInfo.y * (uShelterInfo.z - 1.0));
  uv = uv * (uShelterInfo.z - 1.0) / uShelterInfo.z + 0.5 / uShelterInfo.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  return texture(uShelterTex, uv).r * 1.2;
}
float windTurb(vec2 p) {
  vec2 uv = (p + uShelterInfo.x) / (uShelterInfo.y * (uShelterInfo.z - 1.0));
  uv = uv * (uShelterInfo.z - 1.0) / uShelterInfo.z + 0.5 / uShelterInfo.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  return texture(uShelterTex, uv).g * 2.0;
}
float windGust(vec2 p, float t, float turbMul) {
  float s = p.x * uWind.x + p.y * uWind.y - uWind.z * t * 0.85;
  float n = -p.x * uWind.y + p.y * uWind.x;
  float g = vnoise(vec2(s * 0.011, n * 0.028)) * 0.55
          + vnoise(vec2(s * 0.031 + 17.3, n * 0.06 - 4.1)) * 0.3
          + vnoise(vec2(s * 0.09 + 3.7, n * 0.15 + 9.2)) * 0.15;
  g = (g - 0.5) * 2.0;
  float lull = 0.08 * sin(t * 0.13) + 0.06 * sin(t * 0.047 + 1.7);
  return max(0.12, 1.0 + 0.3 * g * 1.8 * turbMul + lull);
}
float windVeer(vec2 p, float t) {
  float s = p.x * uWind.x + p.y * uWind.y - uWind.z * t * 0.85;
  return (vnoise(vec2(s * 0.004 + 5.0, t * 0.021 + 0.3)) - 0.5) * 0.45;
}
float windProfile(float h) {
  return log(max(h, 0.12) / 0.05) / log(2.0 / 0.05);
}
// 지면 위 높이 h에서의 바람(xz, m/s)
vec2 windAt(vec2 p, float h, float shelterBlendH) {
  float sh = windShelter(p);
  float fv = mix(sh, 1.0, smoothstep(0.7 * shelterBlendH, 1.5 * shelterBlendH, h));
  float sp = uWind.z * windProfile(h) * fv * windGust(p, uWind.w, windTurb(p));
  float a = windVeer(p, uWind.w);
  float c = cos(a), s = sin(a);
  return vec2(uWind.x * c - uWind.y * s, uWind.x * s + uWind.y * c) * sp;
}

// ---- 수관 아래 햇빛 얼룩 / 하늘빛 가림 ----
vec2 canopySample(vec2 p, float lod) {
  vec2 uv = (p + uCanopyInfo.x) / (uCanopyInfo.y * uCanopyInfo.z);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0);
  return textureLod(uCanopyTex, uv, lod).rg;
}
// 직사광 가시도(0~1). 점에서 태양 쪽으로 수관 높이(약 10 m)까지 올라간 지점의 수관 밀도로 판정.
float canopySun(vec3 wp, float gy) {
  vec2 sunH = uSunDir.xz / max(uSunDir.y, 0.15);
  float hy = wp.y - gy;
  // 수관 아래·중간 두 높이에서 태양 쪽 밀도(긴 그림자·들쭉날쭉한 가장자리)
  vec2 p1 = wp.xz + sunH * max(7.0 - hy, 0.0);
  vec2 p2 = wp.xz + sunH * max(13.0 - hy, 0.0);
  float d1 = canopySample(p1, 0.0).r;
  float d2 = canopySample(p2, 0.0).r;
  float dC = max(d1, d2 * 0.9);
  vec2 pc = mix(p1, p2, 0.5);
  // 잎 사이로 드는 작은 햇빛 반점(바람에 일렁임)
  vec2 sway = vec2(sin(uTime * 1.3 + pc.x * 0.2), cos(uTime * 1.1 + pc.y * 0.2)) * 0.02 * uWind.z;
  float n = vnoise(pc * 1.6 + sway) * 0.45 + vnoise(pc * 4.3 - sway * 2.0) * 0.35 + vnoise(pc * 9.7 + sway) * 0.2;
  float occ = smoothstep(n - 0.08, n + 0.08, dC * 1.45 - 0.08);
  // 그림자 맵이 잎 그림자를 그리는 거리 안에서는 수관 지도 가림을 끈다
  float far = smoothstep(uCanopyFade.x, uCanopyFade.y, distance(wp, cameraPosition));
  float vis = 1.0 - occ * 0.95 * uCanopyStrength * far;
  float dyS = max(1.8 - hy, 0.0);
  vec2 ps = wp.xz + sunH * dyS;
  float dS = canopySample(ps, 0.0).g;
  float ns = vnoise(ps * 3.1) * 0.6 + vnoise(ps * 7.7) * 0.4;
  vis *= 1.0 - smoothstep(ns - 0.12, ns + 0.12, dS * 1.2) * 0.88 * uCanopyStrength * far;
  return vis;
}
// 하늘빛(산란광) 가시도
float canopySky(vec3 wp, float gy) {
  vec2 d = canopySample(wp.xz, 2.5);
  float below = 1.0 - smoothstep(9.0, 16.0, wp.y - gy);
  return 1.0 - (d.r * 0.72 * below + d.g * 0.35 * (1.0 - smoothstep(0.5, 2.5, wp.y - gy))) * uCanopyStrength;
}

// ---- 하늘·대기 원근 (render/skyModel.js와 같은 식) ----
vec3 sunE() { return uSunColor * uSunIntensity; }
float airmassF(float s) {
  s = max(s, 0.0);
  float hdeg = degrees(asin(min(s, 1.0)));
  return 1.0 / (s + 0.50572 * pow(hdeg + 6.07995, -1.6364));
}
// 구름 없는 하늘 복사휘도
vec3 skyRadiance(vec3 d) {
  float mu = dot(d, uSunDir);
  float mv = airmassF(d.y);
  float g = uSkyP.y;
  float pR = 0.0596831 * (1.0 + mu * mu);
  float pM = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  vec3 tau = uSkyTauR + uSkyP.x;
  vec3 col = 1.0 - exp(-tau * mv);
  vec3 scat = (uSkyP.z * uSkyTauR * pR + uSkyP.w * uSkyP.x * pM) / tau;
  vec3 L = sunE() * (scat * col + uSkyP2.x * col * vec3(0.75, 0.85, 1.0));
  float hz = 1.0 - smoothstep(0.0, 0.25, max(d.y, 0.0));
  float l = dot(L, vec3(0.2126, 0.7152, 0.0722));
  return mix(L, l * vec3(0.92, 0.97, 1.08), hz * uSkyP2.y);
}
// 이전 이름 호환
vec3 skyColor(vec3 d) { return skyRadiance(d.y < 0.0 ? normalize(vec3(d.x, 0.0, d.z)) : d); }
// 하늘빛 조도(SH, three.js shGetIrradianceAt과 같은 식)
vec3 shIrradiance(vec3 n) {
  float x = n.x, y = n.y, z = n.z;
  vec3 r = uSH[0] * 0.886227;
  r += uSH[1] * 2.0 * 0.511664 * y;
  r += uSH[2] * 2.0 * 0.511664 * z;
  r += uSH[3] * 2.0 * 0.511664 * x;
  r += uSH[4] * 2.0 * 0.429043 * x * y;
  r += uSH[5] * 2.0 * 0.429043 * y * z;
  r += uSH[6] * (0.743125 * z * z - 0.247708);
  r += uSH[7] * 2.0 * 0.429043 * x * z;
  r += uSH[8] * 0.429043 * (x * x - y * y);
  return max(r, vec3(0.0));
}
// 적운층 밀도(0~1). 하늘 돔과 구름 그림자가 같은 함수를 쓴다.
float cloudDensity(vec2 p) {
  vec2 q = (p + uCloudOffset) / uCloud.y;
  // 개별 적운 덩어리(큰 노이즈) 안에서만 뭉게뭉게한 세부(작은 노이즈)가 보이게
  vec2 w = vec2(vnoise(q * 2.3 + vec2(3.1, 1.3)), vnoise(q * 2.3 - vec2(7.3, 2.9))) - 0.5;
  q += w * 0.18;
  float base = vnoise(q) * 0.62 + vnoise(q * 2.07 + 11.1) * 0.38;
  float puff = vnoise(q * 4.3 - 5.7) * 0.6 + vnoise(q * 9.1 + 2.2) * 0.4;
  float n = base + (puff - 0.5) * 0.22;
  return smoothstep(uCloud.z, uCloud.z + 0.1, n);
}
// 구름 그림자: 지면 점에서 태양 쪽으로 구름 높이까지 올라간 곳의 밀도
float cloudShadow(vec3 wp) {
  float sy = max(uSunDir.y, 0.08);
  vec2 p = wp.xz + uSunDir.xz / sy * (uCloud.x - wp.y);
  return 1.0 - cloudDensity(p) * uCloud.w * 0.92;
}
// 대기 원근: 투과율(색별) + 그 방위 지평선 하늘빛으로 산란광
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 v = wp - cameraPosition;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  float hAvg = max(0.5 * (wp.y + cameraPosition.y), 0.0);
  vec3 tau = uHaze.x * uHazeTint * dist * exp(-hAvg / uHaze.y);
  vec3 T = exp(-tau);
  vec3 dirH = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35 + 0.015, dir.z));
  return col * T + skyRadiance(dirH) * (1.0 - T);
}
`;

export function commonGLSL() {
  return GLSL_COMMON;
}

/**
 * 내장 머티리얼 패치: 월드 좌표 varying, 수관 그늘(직사광·하늘빛), 대기 원근 안개.
 * opts.vertex: 'begin_vertex' 대체 코드(지형 변위 등), opts.fragmentColor: diffuseColor 수정 코드,
 * opts.normal: 'normal_fragment_begin' 이후 법선 덮어쓰기 코드
 */
export function patchMaterial(material, opts = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    for (const k in U) shader.uniforms[k] = U[k];
    if (opts.uniforms) Object.assign(shader.uniforms, opts.uniforms);
    const common = commonGLSL() + (opts.header || '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${common}\nvarying vec3 vWP;\nvarying float vGY;\nvarying float vCloud;\n${opts.vertexHeader || ''}`)
      .replace(
        '#include <begin_vertex>',
        opts.vertex ? opts.vertex : '#include <begin_vertex>',
      )
      .replace(
        '#include <project_vertex>',
        opts.project
          ? `${opts.project}\n vGY = ${opts.groundY || 'terrainHeight(vWP.xz)'};\n vCloud = ${opts.noCloud ? '1.0' : 'cloudShadow(vWP)'};`
          : `#include <project_vertex>
        {
          vec4 wpc = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wpc = instanceMatrix * wpc;
          #endif
          vWP = (modelMatrix * wpc).xyz;
          vGY = ${opts.groundY || 'terrainHeight(vWP.xz)'};
          vCloud = ${opts.noCloud ? '1.0' : 'cloudShadow(vWP)'};
        }`,
      );
    if (opts.beginNormal) shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', opts.beginNormal);

    let lights = THREE.ShaderChunk.lights_fragment_begin;
    lights = lights.replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= canopySunVis;',
    );
    lights = lights.replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= canopySunVis;');
    lights = lights.replace(
      'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
      `vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );\n\tfloat canopySkyVis = ${opts.noCanopy ? '1.0' : 'canopySky(vWP, vGY)'};`,
    );
    lights = lights.replace(
      /(#if defined\( RE_IndirectSpecular \))/,
      'irradiance *= canopySkyVis;\n\n$1',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${common}\nvarying vec3 vWP;\nvarying float vGY;\nvarying float vCloud;\n${opts.fragmentHeader || ''}`)
      .replace('#include <lights_fragment_begin>', `float canopySunVis = ${opts.noCanopy ? '1.0' : 'canopySun(vWP, vGY)'} * vCloud;\n${lights}`)
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWP);\n#include <tonemapping_fragment>')
      .replace('#include <fog_fragment>', '');
    if (opts.fragmentColor) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${opts.fragmentColor}`);
    if (opts.normal) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${opts.normal}`);
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => (opts.key || 'patched') + (material.uuid && opts.unique ? material.uuid : '');
  return material;
}

/** 커스텀 ShaderMaterial 뒷부분: 안개 → 톤매핑 → 색공간 */
export const GLSL_OUTPUT = /* glsl */ `
  gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWP);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
