// 지면 식생 덮개(판정용): 그루터기·잡초·키 큰 잡초 띠·해바라기의 높이와 밀도.
// 지면 종류 지도(쌍선형) + 덩이 노이즈로 정한다. 같은 식이 식생 렌더러(GLSL coverHeight)에도 있어
// 화면에 보이는 풀·잡초의 높이와 탄도·시야 판정이 맞는다.

import { vnoise } from '../core/noise.js';
import { smoothstep } from '../core/math.js';

// 덮개 종류별 탄도 특성(materials.js의 volume 재질 이름)
export const COVER_KINDS = ['stubbleCover', 'weeds', 'sunflower'];

const sa = [0, 0, 0, 0];
const sb = [0, 0, 0, 0];

/**
 * (x, z)의 덮개. out = {h(지면 위 높이 m), k: [그루터기, 잡초, 해바라기] 밀도 가중(0~1)}
 */
export function coverAt(terrain, x, z, out) {
  out.h = 0;
  out.k[0] = out.k[1] = out.k[2] = 0;
  if (!terrain.inMap(x, z)) return out;
  terrain._surf(terrain.surfA, x, z, sa);
  terrain._surf(terrain.surfB, x, z, sb);
  const road = smoothstep(1.85, 1.45, Math.abs(terrain.roadDistance(x, z)));
  const keep = 1 - road;
  const clump = smoothstep(0.25, 0.75, vnoise(x * 0.35 + 2.2, z * 0.35 - 7.1));
  const fine = vnoise(x * 1.3 + 0.7, z * 1.3 - 3.3);
  const wStub = sa[0] * keep;
  const wFal = sa[2] * keep;
  const wGrass = sb[0] * keep;
  const wSun = sb[1] * keep;
  const tall = sb[3];
  const hStub = 0.16;
  const hFal = (0.32 + 0.72 * clump) * (0.85 + 0.3 * fine);
  const hGrass = (0.35 + 0.95 * tall) * (0.6 + 0.6 * clump) * (0.85 + 0.3 * fine);
  const hSun = 1.72 + 0.32 * vnoise(x * 0.2 + 4.4, z * 0.2 - 1.1);
  let h = 0;
  let wsum = 0;
  if (wStub > 0.01) {
    h += hStub * wStub;
    wsum += wStub;
    out.k[0] = wStub;
  }
  if (wFal > 0.01) {
    h += hFal * wFal;
    wsum += wFal;
    out.k[1] += wFal * (0.6 + 0.4 * clump);
  }
  if (wGrass > 0.01) {
    h += hGrass * wGrass;
    wsum += wGrass;
    out.k[1] += wGrass * (0.4 + 0.6 * tall) * (0.6 + 0.4 * clump);
  }
  if (wSun > 0.01) {
    h += hSun * wSun;
    wsum += wSun;
    out.k[2] = wSun;
  }
  out.h = wsum > 0.05 ? h / wsum : 0;
  return out;
}

export function makeCoverSample() {
  return { h: 0, k: [0, 0, 0] };
}
