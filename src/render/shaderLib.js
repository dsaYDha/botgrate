// 공용 GLSL: 해시/노이즈(CPU core/noise.js와 동일), 지형 높이, 바람, 수관 햇빛 얼룩, 대기 원근(안개).
// 내장 머티리얼(MeshLambert 등)에 끼워 넣는 패치 도우미도 여기 있다.

import * as THREE from 'three';

// 모든 셰이더가 공유하는 유니폼 객체(값만 갱신하면 모든 머티리얼에 반영)
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(-0.61, 0.5, 0.61).normalize() },
  uSunColor: { value: new THREE.Color(1.0, 0.92, 0.8) },
  uSkyZenith: { value: new THREE.Color(0.2, 0.38, 0.72) },
  uSkyHorizon: { value: new THREE.Color(0.68, 0.74, 0.8) },
  uFogDensity: { value: 0.00028 },
  uWind: { value: new THREE.Vector4(1, 0, 5, 0) }, // dirX, dirZ, speed, time
  uTerrainHD: { value: null },
  uTerrainInfo: { value: new THREE.Vector4(700, 1, 1401, 0) }, // half, res, N
  uTerrainP0: { value: new THREE.Vector4(2.4, 340, 0.55, 75) }, // largeAmp, largeScale, midAmp, midScale
  uTerrainP1: { value: new THREE.Vector4(0.08, 9, 0, 0) }, // smallAmp, smallScale
  uRut: { value: new THREE.Vector4(1.65, 0.36, 0.11, 0.035) }, // gauge, width, depth, centerRise
  uSurfA: { value: null },
  uSurfB: { value: null },
  uShelterTex: { value: null },
  uShelterInfo: { value: new THREE.Vector4(700, 4, 351, 0) },
  uCanopyTex: { value: null },
  uCanopyInfo: { value: new THREE.Vector4(700, 1, 1400, 0) },
  uCanopyStrength: { value: 1.0 },
  uSunIntensity: { value: 3.6 },
  uHemiSky: { value: new THREE.Color(0.56, 0.66, 0.88) },
  uHemiGround: { value: new THREE.Color(0.4, 0.34, 0.24) },
  uHemiIntensity: { value: 0.8 },
};

export const GLSL_COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uFogDensity;
uniform vec4 uWind;
uniform highp sampler2D uTerrainHD;
uniform vec4 uTerrainInfo;
uniform vec4 uTerrainP0;
uniform vec4 uTerrainP1;
uniform vec4 uRut;
uniform sampler2D uShelterTex;
uniform vec4 uShelterInfo;
uniform sampler2D uCanopyTex;
uniform vec4 uCanopyInfo;
uniform float uCanopyStrength;
uniform float uSunIntensity;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
uniform float uHemiIntensity;

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

// ---- 지형 ----
float baseHeight(vec2 p) {
  float a = (fbmN(vec2(p.x / uTerrainP0.y + 13.7, p.y / uTerrainP0.y - 4.1), 3) - 0.5) * 2.0 * uTerrainP0.x;
  float b = (fbmN(vec2(p.x / uTerrainP0.w - 7.3, p.y / uTerrainP0.w + 2.9), 2) - 0.5) * 2.0 * uTerrainP0.z;
  float c = (vnoise(p / uTerrainP1.y) - 0.5) * 2.0 * uTerrainP1.x;
  return a + b + c;
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
// (높이, 도로 거리) — 격자 쌍선형(CPU Terrain._bilinear와 동일)
vec2 terrainHD(vec2 p) {
  float half_ = uTerrainInfo.x;
  float res = uTerrainInfo.y;
  int N = int(uTerrainInfo.z);
  vec2 f = (p + half_) / res;
  vec2 i = floor(f);
  if (i.x < 0.0 || i.y < 0.0 || i.x >= float(N - 1) || i.y >= float(N - 1)) return vec2(baseHeight(p), 1000.0);
  vec2 t = f - i;
  ivec2 c = ivec2(i);
  vec2 a = texelFetch(uTerrainHD, c, 0).rg;
  vec2 b = texelFetch(uTerrainHD, c + ivec2(1, 0), 0).rg;
  vec2 d = texelFetch(uTerrainHD, c + ivec2(0, 1), 0).rg;
  vec2 e = texelFetch(uTerrainHD, c + ivec2(1, 1), 0).rg;
  return a + (b - a) * t.x + (d - a) * t.y + (a - b - d + e) * t.x * t.y;
}
float terrainHeight(vec2 p) {
  vec2 hd = terrainHD(p);
  return hd.x + rutProfile(hd.y);
}
vec3 terrainNormal(vec2 p, float e) {
  float hx = terrainHeight(p + vec2(e, 0.0)) - terrainHeight(p - vec2(e, 0.0));
  float hz = terrainHeight(p + vec2(0.0, e)) - terrainHeight(p - vec2(0.0, e));
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
  float vis = 1.0 - occ * 0.95 * uCanopyStrength;
  float dyS = max(1.8 - hy, 0.0);
  vec2 ps = wp.xz + sunH * dyS;
  float dS = canopySample(ps, 0.0).g;
  float ns = vnoise(ps * 3.1) * 0.6 + vnoise(ps * 7.7) * 0.4;
  vis *= 1.0 - smoothstep(ns - 0.12, ns + 0.12, dS * 1.2) * 0.88 * uCanopyStrength;
  return vis;
}
// 하늘빛(산란광) 가시도
float canopySky(vec3 wp, float gy) {
  vec2 d = canopySample(wp.xz, 2.5);
  float below = 1.0 - smoothstep(9.0, 16.0, wp.y - gy);
  return 1.0 - (d.r * 0.72 * below + d.g * 0.35 * (1.0 - smoothstep(0.5, 2.5, wp.y - gy))) * uCanopyStrength;
}

// ---- 하늘·대기 원근 ----
vec3 skyColor(vec3 d) {
  float e = clamp(d.y, -1.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(max(e, 0.0), 0.5));
  float sd = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (pow(sd, 6.0) * 0.16 + pow(sd, 48.0) * 0.4) * (1.0 - max(e, 0.0) * 0.6);
  if (e < 0.0) c = mix(c, uSkyHorizon * 0.82, min(-e * 6.0, 1.0));
  return c;
}
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 v = wp - cameraPosition;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  float hf = exp(-max(wp.y + 5.0, 0.0) / 1800.0);
  float f = 1.0 - exp(-uFogDensity * dist * hf);
  vec3 fc = skyColor(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35, dir.z)));
  return mix(col, fc, f);
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
      .replace('#include <common>', `#include <common>\n${common}\nvarying vec3 vWP;\nvarying float vGY;\n${opts.vertexHeader || ''}`)
      .replace(
        '#include <begin_vertex>',
        opts.vertex ? opts.vertex : '#include <begin_vertex>',
      )
      .replace(
        '#include <project_vertex>',
        opts.project
          ? `${opts.project}\n vGY = ${opts.groundY || 'terrainHeight(vWP.xz)'};`
          : `#include <project_vertex>
        {
          vec4 wpc = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wpc = instanceMatrix * wpc;
          #endif
          vWP = (modelMatrix * wpc).xyz;
          vGY = ${opts.groundY || 'terrainHeight(vWP.xz)'};
        }`,
      );
    if (opts.beginNormal) shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', opts.beginNormal);

    let lights = THREE.ShaderChunk.lights_fragment_begin;
    lights = lights.replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= canopySunVis;',
    );
    lights = lights.replace(
      'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
      `vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );\n\tfloat canopySkyVis = ${opts.noCanopy ? '1.0' : 'canopySky(vWP, vGY)'};`,
    );
    lights = lights.replace(
      /(#if defined\( RE_IndirectSpecular \))/,
      'irradiance *= canopySkyVis;\n\n$1',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${common}\nvarying vec3 vWP;\nvarying float vGY;\n${opts.fragmentHeader || ''}`)
      .replace('#include <lights_fragment_begin>', `float canopySunVis = ${opts.noCanopy ? '1.0' : 'canopySun(vWP, vGY)'};\n${lights}`)
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
