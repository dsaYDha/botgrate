// 바람장: 전역 바람(방향·기본 풍속) + 돌풍(바람을 따라 흘러가는 패치) + 방풍림 차폐.
//
// 차폐 모델(경험적, 중간 공극률 방풍림): 높이 H인 띠에 대해
//   풍하측: 가장자리 뒤 x/H 거리별 상대 풍속(LEE 표). 3~6H에서 최소(~0.3), 10~20H에서 서서히 회복.
//   풍상측: 띠 바로 앞(~2H)만 약간 감소.
//   띠 안: 바람 들어오는 가장자리에서 안쪽으로 갈수록 급감(~0.3).
//   비스듬한 바람은 효과가 cos 비례로 약해지고, 띠 끝·틈으로 돌아 들어온 바람은 차폐되지 않음.
//   높이 방향: 0.7H~1.5H 위로 가면 차폐가 사라지고, 지면 근처는 로그 바람 분포.
// 같은 돌풍식이 GLSL(render/shaderLib.js)에도 있어 풀·나무 흔들림과 탄도가 같은 바람을 본다.

import { vnoise } from '../core/noise.js';
import { clamp, interpTable, smoothstep } from '../core/math.js';

const LEE = [
  [0, 0.38],
  [1, 0.33],
  [2, 0.3],
  [4, 0.3],
  [6, 0.36],
  [8, 0.46],
  [10, 0.56],
  [12, 0.65],
  [15, 0.76],
  [20, 0.88],
  [25, 0.95],
  [30, 1.0],
];

export const WIND_CONST = {
  z0: 0.05, // 지면 거칠기 길이(그루터기 밭)
  refHeight: 2.0, // 기본 풍속 기준 높이
  gustiness: 0.3, // 난류 강도
  advect: 0.85, // 돌풍 패치 이동 속도 / 평균 풍속
};

export class WindField {
  constructor(world, layout, terrain, beltHeights = {}) {
    this.world = world;
    this.layout = layout;
    this.terrain = terrain;
    this.beltHeights = beltHeights;
    this.res = 4;
    this.half = world.mapHalf;
    this.N = Math.round((2 * this.half) / this.res) + 1;
    this.shelter = new Float32Array(this.N * this.N);
    this.turb = new Float32Array(this.N * this.N);
    this.speed = 5;
    this.fromDeg = 270; // 풍향(불어오는 쪽, 북=0 시계방향)
    this.dirX = 1;
    this.dirZ = 0;
    this.time = 0;
    this.version = 0; // 차폐 격자 갱신 횟수(텍스처 갱신 감지)
  }

  /** 풍향(불어오는 방향, 도)과 풍속(m/s) 설정 */
  set(speed, fromDeg) {
    this.speed = speed;
    this.fromDeg = ((fromDeg % 360) + 360) % 360;
    const toRad = ((this.fromDeg + 180) * Math.PI) / 180;
    // 나침반 각 θ의 방향 벡터: (sinθ, -cosθ)  (북 = -z)
    this.dirX = Math.sin(toRad);
    this.dirZ = -Math.cos(toRad);
    this._computeShelter();
    this.version++;
  }

  randomize(rng) {
    this.set(rng.range(2, 8), rng.range(0, 360));
  }

  _computeShelter() {
    const { N, res, half, layout } = this;
    const wx = this.dirX;
    const wz = this.dirZ;
    for (let j = 0; j < N; j++) {
      const z = -half + j * res;
      for (let i = 0; i < N; i++) {
        const x = -half + i * res;
        let f = 1.0;
        let turb = 1.0;
        for (const b of layout.belts) {
          const H = this.beltHeights[b.id] || 15;
          const { u, v } = b.toLocal(x, z);
          const wn = wx * b.n[0] + wz * b.n[1];
          const wt = wx * b.t[0] + wz * b.t[1];
          const cos = Math.abs(wn);
          const sgn = wn >= 0 ? 1 : -1;
          const dLee = v * sgn; // 풍하측 +
          let fb = 1;
          if (Math.abs(v) <= b.half) {
            if (u < b.from || u > b.to) continue;
            const cov = b.coverageDistance(u);
            const s = (dLee + b.half) / (2 * b.half);
            const inside = 0.78 - 0.5 * smoothstep(0, 0.45, s);
            const k = smoothstep(-2, 4, cov);
            fb = 1 + (inside - 1) * k;
            if (cov < 0) fb = Math.max(fb, 1.05 * smoothstep(-1, -6, cov) + fb * (1 - smoothstep(-1, -6, cov)));
            turb = Math.min(turb, 0.75);
          } else if (dLee > 0) {
            const xe = dLee - b.half;
            const cosc = Math.max(cos, 0.2);
            const X = xe / cosc / H;
            if (X > 32) continue;
            // 바람이 지나온 지점(띠 중심선)의 축 좌표
            const sc = v / (wn || 1e-6);
            const uc = u - sc * wt;
            const cov = b.coverageDistance(uc);
            const trans = 3 + 0.18 * Math.abs(sc);
            const c = smoothstep(-trans, trans, cov);
            const fl = interpTable(LEE, X);
            fb = 1 - (1 - fl) * Math.pow(cos, 0.7) * c;
            if (X > 1 && X < 12) turb = Math.max(turb, 1 + 0.35 * c * cos);
          } else {
            const xw = -dLee - b.half;
            const Xw = xw / (H * Math.max(cos, 0.2));
            if (Xw > 6) continue;
            const sc = v / (wn || 1e-6);
            const uc = u - sc * wt;
            const c = smoothstep(-3, 3, b.coverageDistance(uc));
            fb = 1 - 0.16 * Math.exp(-Xw / 1.2) * cos * c;
          }
          f = Math.min(f, fb);
        }
        this.shelter[j * N + i] = f;
        this.turb[j * N + i] = turb;
      }
    }
  }

  _grid(arr, x, z) {
    const { N, res, half } = this;
    const fx = (x + half) / res;
    const fz = (z + half) / res;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return 1;
    const tx = fx - i;
    const tz = fz - j;
    const a = arr[j * N + i];
    const b = arr[j * N + i + 1];
    const c = arr[(j + 1) * N + i];
    const d = arr[(j + 1) * N + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  shelterAt(x, z) {
    return this._grid(this.shelter, x, z);
  }

  /** 로그 바람 분포: 기준 높이(2 m) 대비 배수 */
  profile(h) {
    const z0 = WIND_CONST.z0;
    return Math.log(Math.max(h, 0.12) / z0) / Math.log(WIND_CONST.refHeight / z0);
  }

  /** 돌풍 배수(평균 1). GLSL windGust()와 같은 식. */
  gust(x, z, t, turbMul = 1) {
    const wx = this.dirX;
    const wz = this.dirZ;
    const s = x * wx + z * wz - this.speed * t * WIND_CONST.advect;
    const n = -x * wz + z * wx;
    let g =
      vnoise(s * 0.011, n * 0.028) * 0.55 +
      vnoise(s * 0.031 + 17.3, n * 0.06 - 4.1) * 0.3 +
      vnoise(s * 0.09 + 3.7, n * 0.15 + 9.2) * 0.15;
    g = (g - 0.5) * 2;
    const lull = 0.08 * Math.sin(t * 0.13) + 0.06 * Math.sin(t * 0.047 + 1.7);
    return Math.max(0.12, 1 + WIND_CONST.gustiness * g * 1.8 * turbMul + lull);
  }

  /** 풍향 흔들림(rad) */
  veer(x, z, t) {
    const s = x * this.dirX + z * this.dirZ - this.speed * t * WIND_CONST.advect;
    return (vnoise(s * 0.004 + 5.0, t * 0.021 + 0.3) - 0.5) * 0.45;
  }

  /**
   * (x, y, z) 지점의 바람 벡터(m/s). groundY를 주면 지면 위 높이 계산을 생략.
   * out: {x,y,z}
   */
  sample(x, y, z, t, out, groundY = null) {
    const gy = groundY === null ? this.terrain.heightAt(x, z) : groundY;
    const h = y - gy;
    const shel = this.shelterAt(x, z);
    const H = 15;
    const fv = shel + (1 - shel) * smoothstep(0.7 * H, 1.5 * H, h);
    const turb = this._grid(this.turb, x, z);
    const sp = this.speed * this.profile(h) * fv * this.gust(x, z, t, turb);
    const a = this.veer(x, z, t);
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.x = (this.dirX * c - this.dirZ * s) * sp;
    out.y = 0;
    out.z = (this.dirX * s + this.dirZ * c) * sp;
    return sp;
  }

  /** GPU용 차폐 격자 텍스처 데이터(R: 차폐 배수/1.2, G: 난류 배수/2) */
  textureData() {
    const NN = this.N * this.N;
    const data = new Uint8Array(NN * 4);
    for (let k = 0; k < NN; k++) {
      data[k * 4] = Math.round(clamp(this.shelter[k] / 1.2, 0, 1) * 255);
      data[k * 4 + 1] = Math.round(clamp(this.turb[k] / 2, 0, 1) * 255);
      data[k * 4 + 3] = 255;
    }
    return data;
  }

  /** 나침반 16방위 이름(디버그용) */
  static compass(deg) {
    const names = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
    return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  }
}
