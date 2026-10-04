// 지면 식생 덮개(판정용): 그루터기·휴경지 잡초·둑 풀과 숲 가장자리 키 큰 잡초 띠·해바라기·숲 바닥(빛 드는 곳의
// 쐐기풀·풀 덩이)·흙길 가운데 풀의 높이와 밀도. 지면 종류 지도(쌍선형) + 덩이 노이즈 + 수관 지도로 정한다.
// 같은 식이 식생 렌더러(render/VegetationRenderer.js의 GLSL coverAtG)에도 있어 화면에 보이는 풀·잡초의 높이(평균)와
// 탄도·시야 판정이 맞는다.

import { vnoise } from '../core/noise.js';
import { smoothstep } from '../core/math.js';

// 덮개 종류별 탄도 특성(materials.js의 volume 재질 이름)
export const COVER_KINDS = ['stubbleCover', 'weeds', 'sunflower'];

const sa = [0, 0, 0, 0];
const sb = [0, 0, 0, 0];

/** 수관 지도 R(0~1) 쌍선형 — GPU canopySample(p, 0.0)과 같은 표본 위치 */
export function canopyBilinear(c, x, z) {
  if (!c) return 0;
  const N = c.N;
  const fx = (x + c.half) / c.res - 0.5;
  const fz = (z + c.half) / c.res - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const at = (ii, jj) => {
    ii = Math.min(N - 1, Math.max(0, ii));
    jj = Math.min(N - 1, Math.max(0, jj));
    return c.data[(jj * N + ii) * 4] / 255;
  };
  return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
}

/**
 * 덮개 종류별 가중치와 높이(렌더러의 분포 지도도 이것을 쓴다).
 * out: {wStub, wFal, wGrass, wSun, wFor, wRoad, tall, hStub, hFal, hGrass, hSun, hFor, hRoad}
 */
export function coverParts(terrain, x, z, out) {
  out.wStub = out.wFal = out.wGrass = out.wSun = out.wFor = out.wRoad = 0;
  if (!terrain.inMap(x, z)) return out;
  terrain._surf(terrain.surfA, x, z, sa);
  terrain._surf(terrain.surfB, x, z, sb);
  const rd = terrain.roadDistance(x, z);
  const road = smoothstep(1.85, 1.45, Math.abs(rd));
  const keep = 1 - road;
  const clump = smoothstep(0.25, 0.75, vnoise(x * 0.35 + 2.2, z * 0.35 - 7.1));
  const fine = vnoise(x * 1.3 + 0.7, z * 1.3 - 3.3);
  out.wStub = sa[0] * keep;
  out.wFal = sa[2] * keep;
  out.wGrass = sb[0] * keep;
  out.wSun = sb[1] * keep;
  out.tall = sb[3];
  // 숲 바닥: 수관이 열려 빛이 드는 곳에만(덩이로) 쐐기풀·풀
  const light = 1 - canopyBilinear(terrain.canopy, x, z);
  const patch = smoothstep(0.35, 0.65, vnoise(x * 0.12 + 5.5, z * 0.12 - 2.4));
  out.wFor = sa[3] * keep * smoothstep(0.45, 0.75, light) * patch;
  // 흙길 가운데 둔덕의 풀 띠
  out.wRoad = road * (1 - smoothstep(0.28, 0.42, Math.abs(rd)));
  out.hStub = 0.16;
  out.hFal = (0.32 + 0.72 * clump) * (0.85 + 0.3 * fine);
  out.hGrass = (0.35 + 0.95 * out.tall) * (0.6 + 0.6 * clump) * (0.85 + 0.3 * fine);
  out.hSun = 1.72 + 0.32 * vnoise(x * 0.2 + 4.4, z * 0.2 - 1.1);
  out.hFor = (0.45 + 0.6 * clump) * (0.85 + 0.3 * fine);
  out.hRoad = 0.12 + 0.08 * fine;
  out.clump = clump;
  return out;
}

const P = {};

/**
 * (x, z)의 덮개. out = {h(지면 위 높이 m), k: [그루터기, 잡초, 해바라기] 밀도 가중(0~1)}
 */
export function coverAt(terrain, x, z, out) {
  out.h = 0;
  out.k[0] = out.k[1] = out.k[2] = 0;
  if (!terrain.inMap(x, z)) return out;
  const c = coverParts(terrain, x, z, P);
  let h = 0;
  let wsum = 0;
  if (c.wStub > 0.01) {
    h += c.hStub * c.wStub;
    wsum += c.wStub;
    out.k[0] = c.wStub;
  }
  if (c.wFal > 0.01) {
    h += c.hFal * c.wFal;
    wsum += c.wFal;
    out.k[1] += c.wFal * (0.6 + 0.4 * c.clump);
  }
  if (c.wGrass > 0.01) {
    h += c.hGrass * c.wGrass;
    wsum += c.wGrass;
    out.k[1] += c.wGrass * (0.4 + 0.6 * c.tall) * (0.6 + 0.4 * c.clump);
  }
  if (c.wSun > 0.01) {
    h += c.hSun * c.wSun;
    wsum += c.wSun;
    out.k[2] = c.wSun;
  }
  if (c.wFor > 0.01) {
    h += c.hFor * c.wFor;
    wsum += c.wFor;
    out.k[1] += c.wFor * 0.7;
  }
  if (c.wRoad > 0.01) {
    h += c.hRoad * c.wRoad;
    wsum += c.wRoad;
    out.k[1] += c.wRoad * 0.5;
  }
  out.h = wsum > 0.05 ? h / wsum : 0;
  return out;
}

export function makeCoverSample() {
  return { h: 0, k: [0, 0, 0] };
}

// GLSL 쌍둥이(같은 식). 렌더러가 식생 인스턴스 높이·종류 선택에 쓴다.
export const COVER_GLSL = /* glsl */ `
struct Cover { float wStub; float wFal; float wGrass; float wSun; float wFor; float wRoad; float tall; float clump;
  float hStub; float hFal; float hGrass; float hSun; float hFor; float hRoad; };
Cover coverAtG(vec2 p) {
  Cover c;
  vec4 sa = surfSampleA(p);
  vec4 sb = surfSampleB(p);
  float rd = terrainHD(p).y;
  float road = 1.0 - smoothstep(1.45, 1.85, abs(rd));
  float keep = 1.0 - road;
  c.clump = smoothstep(0.25, 0.75, vnoise(vec2(p.x * 0.35 + 2.2, p.y * 0.35 - 7.1)));
  float fine = vnoise(vec2(p.x * 1.3 + 0.7, p.y * 1.3 - 3.3));
  c.wStub = sa.r * keep;
  c.wFal = sa.b * keep;
  c.wGrass = sb.r * keep;
  c.wSun = sb.g * keep;
  c.tall = sb.a;
  float light = 1.0 - canopySample(p, 0.0).r;
  float patchN = smoothstep(0.35, 0.65, vnoise(vec2(p.x * 0.12 + 5.5, p.y * 0.12 - 2.4)));
  c.wFor = sa.a * keep * smoothstep(0.45, 0.75, light) * patchN;
  c.wRoad = road * (1.0 - smoothstep(0.28, 0.42, abs(rd)));
  c.hStub = 0.16;
  c.hFal = (0.32 + 0.72 * c.clump) * (0.85 + 0.3 * fine);
  c.hGrass = (0.35 + 0.95 * c.tall) * (0.6 + 0.6 * c.clump) * (0.85 + 0.3 * fine);
  c.hSun = 1.72 + 0.32 * vnoise(vec2(p.x * 0.2 + 4.4, p.y * 0.2 - 1.1));
  c.hFor = (0.45 + 0.6 * c.clump) * (0.85 + 0.3 * fine);
  c.hRoad = 0.12 + 0.08 * fine;
  return c;
}
`;
