// 지형: 높이맵(1 m 격자, 3차 B-스플라인으로 매끄럽게) + 미세 요철(해석식) + 지면 종류 지도.
// CPU(충돌·탄착·이동·시야)와 GPU(렌더링)가 같은 데이터·같은 식을 쓴다.
//   높이 = B-스플라인(격자 높이) + 바퀴 자국(도로 거리장) + 미세 요철(지면 종류별)
// GPU 대응 코드: render/shaderLib.js 의 terrainHD() / terrainHeight().
// 격자 값은 GPU 반정밀도(half float) 텍스처와 같도록 CPU에서도 반정밀도로 반올림해 둔다.

import * as THREE from 'three';
import { fbm, vnoise } from '../core/noise.js';
import { smoothstep } from '../core/math.js';
import { Random } from '../core/Random.js';

export const SURF = { stubble: 0, plowed: 1, fallow: 2, forest: 3, grass: 4, road: 5, sunflower: 6 };
export const SURF_NAMES = ['stubble', 'plowed', 'fallow', 'forest', 'grass', 'road', 'sunflower'];

const HEADLAND = 12; // 밭 가장자리 회전 구역 폭(m)

/** 지도 밖까지 이어지는 해석적 기복(GPU 원경 지형과 동일) */
export function baseHeight(x, z, T) {
  const a = (fbm(x / T.largeScale + 13.7, z / T.largeScale - 4.1, 3) - 0.5) * 2 * T.largeAmp;
  const b = (fbm(x / T.midScale - 7.3, z / T.midScale + 2.9, 2) - 0.5) * 2 * T.midAmp;
  const c = (vnoise(x / T.smallScale, z / T.smallScale) - 0.5) * 2 * T.smallAmp;
  // 지평선 쪽 완만한 언덕(플레이 구역에서 멀어질수록 커짐) — 맵 경계가 평평한 끝선으로 보이지 않게
  const r = Math.hypot(x, z);
  const far = smoothstep(1400, 5000, r);
  const d = far > 0 ? (fbm(x / 2600 + 3.3, z / 2600 - 8.1, 3) - 0.42) * 2 * 26 * far : 0;
  return a + b + c + d;
}

/** 도로 중심선 거리 d에서의 바퀴 자국·가운데 둔덕 높이(격자보다 가는 형상) */
export function rutProfile(d, R) {
  const ad = Math.abs(d);
  if (ad > 1.2) return 0;
  let h = 0;
  const t = (ad - R.gauge * 0.5) / (R.width * 0.5);
  if (t > -1 && t < 1) {
    const k = 1 - t * t;
    h -= R.depth * k * k;
  }
  const c = ad / (R.gauge * 0.5 - R.width * 0.5);
  if (c < 1) {
    const k = 1 - c * c;
    h += R.centerRise * k * k;
  }
  return h;
}

/**
 * 미세 요철(m). GLSL microRelief()와 같은 식.
 * sa = [그루터기, 흙밭, 휴경지, 숲], sb = [풀, 해바라기, 습기, 키 큰 잡초] (0~1), dir = 이랑 방향(rad)
 */
export function microRelief(x, z, sa, sb, dir) {
  const n1 = vnoise(x * 0.9 + 13.1, z * 0.9 + 7.7) - 0.5;
  const n2 = vnoise(x * 2.6 - 4.3, z * 2.6 + 9.1) - 0.5;
  const general = n1 * 0.035 + n2 * 0.014;
  const forest = (vnoise(x * 0.45 + 3.3, z * 0.45 + 3.3) - 0.5) * 0.09 + n2 * 0.02;
  const rnx = -Math.sin(dir);
  const rnz = Math.cos(dir);
  const q = x * rnx + z * rnz;
  const furrow = Math.cos((6.2831853 * q) / 0.75) * 0.045 + n1 * 0.02;
  const wPlow = sa[1];
  const wFor = sa[3];
  const wGen = Math.max(0, 1 - wPlow - wFor);
  return general * wGen + forest * wFor + furrow * wPlow;
}

function toHalf(v) {
  return THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(v));
}

// 3차 B-스플라인 가중치
function bsw(t, out) {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = (-t3 + 3 * t2 - 3 * t + 1) / 6;
  out[1] = (3 * t3 - 6 * t2 + 4) / 6;
  out[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  out[3] = t3 / 6;
}

export class Terrain {
  constructor(world, layout) {
    this.world = world;
    this.layout = layout;
    this.T = world.terrain;
    this.R = world.rut;
    this.res = world.mapRes;
    this.half = world.mapHalf;
    this.N = Math.round((2 * this.half) / this.res) + 1;
    const NN = this.N * this.N;
    // RG: 높이, 도로 부호거리 (반정밀도로 반올림된 값)
    this.hd = new Float32Array(NN * 2);
    this.surfA = new Uint8Array(NN * 4); // 그루터기, 흙밭, 휴경지, 숲
    this.surfB = new Uint8Array(NN * 4); // 풀(둑·배수로), 해바라기, 습기, 키 큰 잡초
    this.surfC = new Uint8Array(NN * 4); // 이랑 방향(0~π), 밭 시드, 회전 구역, 0
    this._wx = new Float64Array(4);
    this._wz = new Float64Array(4);
    this._sa = [0, 0, 0, 0];
    this._sb = [0, 0, 0, 0];
    this._build();
  }

  _build() {
    const { N, res, half, T, layout, world } = this;
    const rng = new Random(world.seed ^ 0x1234);
    const fieldSeeds = world.fields.map(() => Math.floor(rng.next() * 255));
    const margin = world.marginWidth;
    const belts = layout.belts;
    const ditches = layout.ditches;
    const berms = world.berms.map((b) => ({
      ...b,
      c: Math.cos(b.angle),
      s: Math.sin(b.angle),
      r: Math.max(b.length, b.width) * 0.75 + 1,
    }));
    const roads = layout.roads;
    const H = new Float32Array(N * N);

    for (let j = 0; j < N; j++) {
      const z = -half + j * res;
      for (let i = 0; i < N; i++) {
        const x = -half + i * res;
        const idx = j * N + i;

        // --- 도로 거리 ---
        let rd = 1e3;
        let roadHalf = 1.7;
        for (const r of roads) {
          const d = r.signedDistance(x, z);
          if (Math.abs(d) < Math.abs(rd)) {
            rd = d;
            roadHalf = r.half;
          }
        }
        const ard = Math.abs(rd);

        // --- 지면 종류(경계를 노이즈로 흔들어 자연스럽게) ---
        const jx = x + (vnoise(x * 0.11, z * 0.11) - 0.5) * 3.2 + (vnoise(x * 0.43, z * 0.43) - 0.5) * 1.2;
        const jz = z + (vnoise(x * 0.11 + 5.2, z * 0.11 - 3.1) - 0.5) * 3.2 + (vnoise(x * 0.43 + 2.2, z * 0.43 - 6.1) - 0.5) * 1.2;
        let type = -1;
        let fieldDir = 0;
        let fieldSeed = 0;
        let headland = 0;
        let ditchW = 0;
        let tallWeeds = 0; // 키 큰 잡초(쑥·엉겅퀴·우엉) 띠: 숲 가장자리·배수로
        let beltRaise = 0;
        for (const b of belts) {
          const { u, v } = b.toLocal(jx, jz);
          const av = Math.abs(v);
          // 띠 끝은 관목·풀로 점점 줄어든다: 숲 바닥 범위도 끝에서 좁아짐
          if (u >= b.from - 6 && u <= b.to + 6) {
            const endTaper = Math.min(1, Math.max(0, Math.min(u - b.from + 6, b.to + 6 - u) / 14));
            const halfHere = b.half * (0.55 + 0.45 * endTaper);
            if (av <= halfHere) {
              const cov = b.coverageDistance(u);
              type = cov > 0 ? SURF.forest : SURF.grass;
              const raise = 0.22 * (1 - Math.pow(av / b.half, 2)) * smoothstep(-2, 6, cov);
              beltRaise = Math.max(beltRaise, raise);
            } else if (av <= halfHere + margin && type < 0) {
              type = SURF.grass;
              // 숲 가장자리 잡초 띠(군데군데 끊김)
              const brk = vnoise(u / 9 + b.center * 0.01, v > 0 ? 2.1 : 5.7);
              tallWeeds = Math.max(tallWeeds, smoothstep(0.18, 0.4, brk));
            }
          }
        }
        // 배수로(풀이 무성)
        let ditchH = 0;
        let spoilH = 0;
        for (const d of ditches) {
          const b = d.beltRef;
          const { u, v } = b.toLocal(x, z);
          if (u < b.from - 2 || u > b.to + 2) continue;
          const s = v - d.v;
          const as = Math.abs(s);
          if (as > d.width + 3) continue;
          const endFade = smoothstep(b.from - 2, b.from + 3, u) * smoothstep(b.to + 2, b.to - 3, u);
          const roadFill = smoothstep(roadHalf + 0.5, roadHalf + 3.0, ard);
          if (as < d.width * 0.5 + 0.5) {
            // 둥근 바닥의 배수로(B-스플라인 평활을 감안해 깊이를 조금 키움)
            const k = Math.max(0, 1 - Math.pow((2 * as) / (d.width + 1.0), 2));
            ditchH -= d.depth * 1.18 * k * k * (3 - 2 * k) * endFade * roadFill;
          }
          const sb = s * -d.sign;
          const sp = (sb - (d.width * 0.5 + 1.1)) / 1.3;
          if (sp > -1 && sp < 1) {
            const patch = smoothstep(0.38, 0.62, vnoise(u / 14 + d.v, 3.3));
            const k = 1 - sp * sp;
            spoilH += d.spoil * k * k * patch * endFade * roadFill;
          }
          if (Math.abs(v - d.v) < d.width * 0.5 + 0.9) {
            ditchW = 255;
            tallWeeds = Math.max(tallWeeds, 0.65 * smoothstep(0.25, 0.5, vnoise(u / 7 + d.v, 8.8)));
          }
        }
        if (ditchW > 0 && type !== SURF.forest) type = SURF.grass;

        let fi = -1;
        if (type < 0) {
          const f = layout.fieldAt(jx, jz);
          fi = f ? world.fields.indexOf(f) : -1;
          const ftype = f ? f.type : world.defaultField;
          type = SURF[ftype];
          fieldDir = f ? f.dir : 0;
          fieldSeed = fi >= 0 ? fieldSeeds[fi] : 7;
          // 밭 가장자리 회전 구역: 줄이 가까운 경계와 나란히
          if (f && (ftype === 'stubble' || ftype === 'plowed')) {
            const [x0, z0, x1, z1] = f.rect;
            const dX = Math.min(x - x0, x1 - x);
            const dZ = Math.min(z - z0, z1 - z);
            if (Math.min(dX, dZ) < HEADLAND) {
              headland = 255;
              fieldDir = dX < dZ ? Math.PI / 2 : 0;
            }
          }
        }

        const a = idx * 4;
        this.surfA[a + 0] = type === SURF.stubble ? 255 : 0;
        this.surfA[a + 1] = type === SURF.plowed ? 255 : 0;
        this.surfA[a + 2] = type === SURF.fallow ? 255 : 0;
        this.surfA[a + 3] = type === SURF.forest ? 255 : 0;
        this.surfB[a + 0] = type === SURF.grass ? 255 : 0;
        this.surfB[a + 1] = type === SURF.sunflower ? 255 : 0;
        this.surfB[a + 3] = type === SURF.grass ? Math.round(tallWeeds * 255) : 0;
        this.surfC[a + 0] = Math.round(((((fieldDir % Math.PI) + Math.PI) % Math.PI) / Math.PI) * 255) % 256;
        this.surfC[a + 1] = fieldSeed;
        this.surfC[a + 2] = headland;
        this.surfC[a + 3] = 255;

        // --- 높이 ---
        let h = baseHeight(x, z, T) + beltRaise + ditchH + spoilH;
        for (const b of berms) {
          const dx = x - b.x;
          const dz = z - b.z;
          if (Math.abs(dx) > b.r || Math.abs(dz) > b.r) continue;
          const qx = dx * b.c + dz * b.s;
          const qz = -dx * b.s + dz * b.c;
          // 둥근 둔덕: 초타원 거리의 매끄러운 종 모양(각진 면 없음)
          const r = Math.sqrt(Math.pow((2 * qx) / (b.length + 1.2), 4) + Math.pow((2 * qz) / (b.width + 1.0), 2));
          if (r < 1) {
            const k = 1 - r * r;
            h += b.height * 1.12 * k * k;
          }
        }
        // 도로 바닥은 다져져 주변보다 약간 낮다
        h -= this.R.sink * smoothstep(roadHalf + 0.4, roadHalf - 0.3, ard);
        H[idx] = h;
        this.hd[idx * 2] = toHalf(h);
        this.hd[idx * 2 + 1] = toHalf(Math.max(-60, Math.min(60, rd)));
      }
    }

    // --- 습기: 주변(9×9 m)보다 낮은 곳 + 큰 얼룩 → 갈아엎은 흙이 더 어둡게 ---
    const tmp = new Float32Array(N * N);
    const R = 4;
    for (let j = 0; j < N; j++) {
      let acc = 0;
      for (let i = -R; i <= R; i++) acc += H[j * N + Math.max(0, Math.min(N - 1, i))];
      for (let i = 0; i < N; i++) {
        tmp[j * N + i] = acc / (2 * R + 1);
        acc += H[j * N + Math.min(N - 1, i + R + 1)] - H[j * N + Math.max(0, i - R)];
      }
    }
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let j = -R; j <= R; j++) acc += tmp[Math.max(0, Math.min(N - 1, j)) * N + i];
      for (let j = 0; j < N; j++) {
        const avg = acc / (2 * R + 1);
        acc += tmp[Math.min(N - 1, j + R + 1) * N + i] - tmp[Math.max(0, j - R) * N + i];
        const idx = j * N + i;
        const x = -half + i * res;
        const z = -half + j * res;
        const n = vnoise(x * 0.025 + 1.7, z * 0.025 - 4.4);
        const wet = Math.max(0, Math.min(1, (avg - H[idx]) * 7 + (n - 0.55) * 1.6));
        this.surfB[idx * 4 + 2] = Math.round(wet * 255);
      }
    }
  }

  // ---- 격자 보간 ----
  /** 3차 B-스플라인(GPU 4회 쌍선형 표본과 같은 값). 지도 밖이면 null */
  _bspline(x, z, channel) {
    const { N, res, half, hd } = this;
    const fx = (x + half) / res;
    const fz = (z + half) / res;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    if (fx < 1 || fz < 1 || fx > N - 2 || fz > N - 2) return null;
    const wx = this._wx;
    const wz = this._wz;
    bsw(fx - i, wx);
    bsw(fz - j, wz);
    let s = 0;
    for (let b = 0; b < 4; b++) {
      const row = (j - 1 + b) * N;
      let r = 0;
      for (let a = 0; a < 4; a++) r += wx[a] * hd[(row + i - 1 + a) * 2 + channel];
      s += wz[b] * r;
    }
    return s;
  }

  /** 지면 종류 텍스처(RGBA8) 쌍선형: out에 0~1 값 4개 */
  _surf(tex, x, z, out) {
    const { N, res, half } = this;
    const fx = Math.max(0, Math.min(N - 1.0001, (x + half) / res));
    const fz = Math.max(0, Math.min(N - 1.0001, (z + half) / res));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = (j * N + i) * 4;
    const b = a + 4;
    const c = a + N * 4;
    const d = c + 4;
    for (let k = 0; k < 4; k++) {
      const va = tex[a + k];
      const vb = tex[b + k];
      const vc = tex[c + k];
      const vd = tex[d + k];
      out[k] = (va + (vb - va) * tx + (vc - va) * tz + (va - vb - vc + vd) * tx * tz) / 255;
    }
    return out;
  }

  /** 가장 가까운 격자점의 이랑 방향(rad) — GPU texelFetch와 같은 규칙 */
  fieldDirAt(x, z) {
    const { N, res, half } = this;
    const i = Math.max(0, Math.min(N - 1, Math.floor((x + half) / res + 0.5)));
    const j = Math.max(0, Math.min(N - 1, Math.floor((z + half) / res + 0.5)));
    return (this.surfC[(j * N + i) * 4] / 255) * Math.PI;
  }

  roadDistance(x, z) {
    const d = this._bspline(x, z, 1);
    return d === null ? 1e3 : d;
  }

  /** 거시 지형만(B-스플라인 + 바퀴 자국), 미세 요철 제외 */
  macroHeightAt(x, z) {
    const g = this._bspline(x, z, 0);
    if (g === null) return baseHeight(x, z, this.T);
    const rd = this._bspline(x, z, 1);
    return g + rutProfile(rd, this.R);
  }

  heightAt(x, z) {
    const g = this._bspline(x, z, 0);
    if (g === null) return baseHeight(x, z, this.T);
    const rd = this._bspline(x, z, 1);
    const sa = this._surf(this.surfA, x, z, this._sa);
    const sb = this._surf(this.surfB, x, z, this._sb);
    return g + rutProfile(rd, this.R) + microRelief(x, z, sa, sb, this.fieldDirAt(x, z));
  }

  normalAt(x, z, out = [0, 1, 0]) {
    const e = 0.3;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx / (2 * e);
    const nz = -hz / (2 * e);
    const l = Math.sqrt(nx * nx + 1 + nz * nz);
    out[0] = nx / l;
    out[1] = 1 / l;
    out[2] = nz / l;
    return out;
  }

  /** 지면 종류 가중치(0~1): [그루터기, 흙밭, 휴경지, 숲, 풀, 흙길, 해바라기] */
  surfaceWeights(x, z) {
    const sa = this._surf(this.surfA, x, z, [0, 0, 0, 0]);
    const sb = this._surf(this.surfB, x, z, [0, 0, 0, 0]);
    const w = [sa[0], sa[1], sa[2], sa[3], sb[0], 0, sb[1]];
    const rd = Math.abs(this.roadDistance(x, z));
    const roadW = smoothstep(1.85, 1.45, rd);
    for (let k = 0; k < 7; k++) w[k] *= 1 - roadW;
    w[5] = roadW;
    return w;
  }

  /** 대표 지면 종류 이름 */
  surfaceAt(x, z) {
    const w = this.surfaceWeights(x, z);
    let best = 0;
    for (let k = 1; k < w.length; k++) if (w[k] > w[best]) best = k;
    return SURF_NAMES[best];
  }

  inMap(x, z) {
    return Math.abs(x) < this.half - 1 && Math.abs(z) < this.half - 1;
  }
}
