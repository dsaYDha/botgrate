// 지형: 높이맵(1 m 격자) + 지면 종류 가중치 + 도로 거리장.
// CPU(충돌·탄착·이동)와 GPU(렌더링)가 같은 데이터·같은 보간식을 쓴다.
//   높이 = 격자 쌍선형 보간 + 바퀴 자국 해석식(도로 거리장 기반)
// GPU 쪽 대응 코드는 render/shaderLib.js 의 terrainHeight().

import { fbm, vnoise } from '../core/noise.js';
import { smoothstep } from '../core/math.js';
import { Random } from '../core/Random.js';

export const SURF = { stubble: 0, plowed: 1, fallow: 2, forest: 3, grass: 4, road: 5 };

/** 지도 밖까지 이어지는 해석적 기복(GPU 원경 지형과 동일) */
export function baseHeight(x, z, T) {
  const a = (fbm(x / T.largeScale + 13.7, z / T.largeScale - 4.1, 3) - 0.5) * 2 * T.largeAmp;
  const b = (fbm(x / T.midScale - 7.3, z / T.midScale + 2.9, 2) - 0.5) * 2 * T.midAmp;
  const c = (vnoise(x / T.smallScale, z / T.smallScale) - 0.5) * 2 * T.smallAmp;
  return a + b + c;
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
    // RG: 높이, 도로 부호거리 (GPU용 float 텍스처로 그대로 올린다)
    this.hd = new Float32Array(NN * 2);
    this.surfA = new Uint8Array(NN * 4); // stubble, plowed, fallow, forest
    this.surfB = new Uint8Array(NN * 4); // grass, fieldDir, fieldSeed, ditch
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
        const jx = x + (vnoise(x * 0.11, z * 0.11) - 0.5) * 2.2;
        const jz = z + (vnoise(x * 0.11 + 5.2, z * 0.11 - 3.1) - 0.5) * 2.2;
        let type = -1;
        let fieldDir = 0;
        let fieldSeed = 0;
        let ditchW = 0;
        let beltRaise = 0;
        for (const b of belts) {
          const { u, v } = b.toLocal(jx, jz);
          const av = Math.abs(v);
          if (u >= b.from - 1.5 && u <= b.to + 1.5) {
            if (av <= b.half) {
              const cov = b.coverageDistance(u);
              type = cov > 0 ? SURF.forest : SURF.grass;
              // 띠 안쪽은 낙엽·흙먼지가 쌓여 약간 높다
              const raise = 0.22 * (1 - Math.pow(av / b.half, 2)) * smoothstep(-2, 6, cov);
              beltRaise = Math.max(beltRaise, raise);
            } else if (av <= b.half + margin && type < 0) {
              type = SURF.grass;
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
          // 도로가 지나는 곳은 메움(암거)
          const roadFill = smoothstep(roadHalf + 0.5, roadHalf + 3.0, ard);
          if (as < d.width * 0.5) {
            const k = 1 - Math.pow((2 * as) / d.width, 2);
            ditchH -= d.depth * Math.pow(k, 0.8) * endFade * roadFill;
          }
          // 판 흙을 띠 쪽에 쌓은 둑(끊겨 있음)
          const sb = s * -d.sign; // 띠 쪽이 +
          const sp = (sb - (d.width * 0.5 + 1.0)) / 1.1;
          if (sp > -1 && sp < 1) {
            const patch = smoothstep(0.38, 0.62, vnoise(u / 14 + d.v, 3.3));
            const k = 1 - sp * sp;
            spoilH += d.spoil * k * k * patch * endFade * roadFill;
          }
          if (Math.abs(v - d.v) < d.width * 0.5 + 0.9) ditchW = 255;
        }
        if (ditchW > 0 && type !== SURF.forest) type = SURF.grass;

        if (type < 0) {
          const f = layout.fieldAt(jx, jz);
          const fi = f ? world.fields.indexOf(f) : -1;
          const ftype = f ? f.type : world.defaultField;
          type = SURF[ftype];
          fieldDir = f ? f.dir : 0;
          fieldSeed = fi >= 0 ? fieldSeeds[fi] : 7;
        }

        const a = idx * 4;
        this.surfA[a + 0] = type === SURF.stubble ? 255 : 0;
        this.surfA[a + 1] = type === SURF.plowed ? 255 : 0;
        this.surfA[a + 2] = type === SURF.fallow ? 255 : 0;
        this.surfA[a + 3] = type === SURF.forest ? 255 : 0;
        this.surfB[a + 0] = type === SURF.grass ? 255 : 0;
        this.surfB[a + 1] = Math.round(((((fieldDir % Math.PI) + Math.PI) % Math.PI) / Math.PI) * 255);
        this.surfB[a + 2] = fieldSeed;
        this.surfB[a + 3] = ditchW;

        // --- 높이 ---
        let h = baseHeight(x, z, T) + beltRaise + ditchH + spoilH;
        for (const b of berms) {
          const dx = x - b.x;
          const dz = z - b.z;
          if (Math.abs(dx) > b.r || Math.abs(dz) > b.r) continue;
          const qx = dx * b.c + dz * b.s;
          const qz = -dx * b.s + dz * b.c;
          const r = Math.sqrt(Math.pow((2 * qx) / b.length, 4) + Math.pow((2 * qz) / b.width, 2));
          if (r < 1.2) {
            const shape = smoothstep(1.15, 0.35, r);
            const rough = 0.85 + 0.3 * vnoise(x * 0.7, z * 0.7);
            h += b.height * shape * rough;
          }
        }
        // 도로 바닥은 다져져 주변보다 약간 낮다
        h -= this.R.sink * smoothstep(roadHalf + 0.4, roadHalf - 0.3, ard);
        // 갈아엎은 흙밭 요철
        if (type === SURF.plowed) h += (vnoise(x * 0.9 + 3.1, z * 0.9 - 1.7) - 0.5) * 2 * T.plowRoughness;

        this.hd[idx * 2] = h;
        this.hd[idx * 2 + 1] = Math.max(-60, Math.min(60, rd));
      }
    }
  }

  // ---- 격자 쌍선형 보간 ----
  _bilinear(x, z, channel) {
    const { N, res, half, hd } = this;
    const fx = (x + half) / res;
    const fz = (z + half) / res;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return null;
    const tx = fx - i;
    const tz = fz - j;
    const a = hd[(j * N + i) * 2 + channel];
    const b = hd[(j * N + i + 1) * 2 + channel];
    const c = hd[((j + 1) * N + i) * 2 + channel];
    const d = hd[((j + 1) * N + i + 1) * 2 + channel];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  roadDistance(x, z) {
    const d = this._bilinear(x, z, 1);
    return d === null ? 1e3 : d;
  }

  heightAt(x, z) {
    const g = this._bilinear(x, z, 0);
    if (g === null) return baseHeight(x, z, this.T);
    const rd = this._bilinear(x, z, 1);
    return g + rutProfile(rd, this.R);
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

  /** 지면 종류 가중치(0~1) 쌍선형 */
  surfaceWeights(x, z) {
    const { N, res, half } = this;
    const fx = (x + half) / res;
    const fz = (z + half) / res;
    const i = Math.max(0, Math.min(N - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(N - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i));
    const tz = Math.max(0, Math.min(1, fz - j));
    const w = [0, 0, 0, 0, 0, 0];
    const corners = [
      [i, j, (1 - tx) * (1 - tz)],
      [i + 1, j, tx * (1 - tz)],
      [i, j + 1, (1 - tx) * tz],
      [i + 1, j + 1, tx * tz],
    ];
    for (const [ci, cj, f] of corners) {
      const a = (cj * N + ci) * 4;
      w[0] += (this.surfA[a] / 255) * f;
      w[1] += (this.surfA[a + 1] / 255) * f;
      w[2] += (this.surfA[a + 2] / 255) * f;
      w[3] += (this.surfA[a + 3] / 255) * f;
      w[4] += (this.surfB[a] / 255) * f;
    }
    // 도로는 거리장으로 판정
    const rd = Math.abs(this.roadDistance(x, z));
    const roadW = smoothstep(1.85, 1.45, rd);
    for (let k = 0; k < 5; k++) w[k] *= 1 - roadW;
    w[5] = roadW;
    return w;
  }

  /** 대표 지면 종류 이름 */
  surfaceAt(x, z) {
    const w = this.surfaceWeights(x, z);
    let best = 0;
    for (let k = 1; k < 6; k++) if (w[k] > w[best]) best = k;
    return ['stubble', 'plowed', 'fallow', 'forest', 'grass', 'road'][best];
  }

  inMap(x, z) {
    return Math.abs(x) < this.half - 1 && Math.abs(z) < this.half - 1;
  }
}
