// 시선 계산: 관측자 눈 → 표적 점들까지 빛이 얼마나 지나가는가(투과율 0~1).
//   고체(지면·줄기·굵은 가지·통나무·짚 더미·뿌리판)에 막히면 0.
//   잎 볼륨(수관·덤불): T = exp(−G·LAD·L) — 볼륨 자료는 탄도와 같다(Shelterbelts.volumes).
//   땅 덮개(그루터기·잡초·해바라기): 탄도와 같은 coverAt 높이 아래를 지나는 길이 × 소광 계수.
// 같은 관측자에서 같은 표적의 여러 점(몸 부위)으로 가는 광선들은 거의 같은 길을 지나므로
// 후보 물체 수집·지형 단면·덮개 단면을 가운데 광선 하나로 한 번만 만들고 점마다 재사용한다.
// 그 밖에: 표적 위치의 햇빛(해 쪽으로 같은 투과율 계산), 표적 뒤 배경(하늘·숲·들판).

import { segStem, segCylinder, segEllipsoid, segCappedCylinder } from '../physics/intersect.js';
import { coverAt, makeCoverSample } from '../world/GroundCover.js';
import { sunDirection } from '../render/skyModel.js';
import { VISION } from '../data/perception.js';

const COVER_MAX_H = 2.3; // 땅 덮개 최대 높이(해바라기)
const TERRAIN_STEP = 2.0;
const COVER_STEP = 0.5;
const NEAR = 6.0; // 표적 근처는 미세 요철까지(정밀 지형)

let losStamp = 1;
// 원경 숲띠 벽(render/DistantScenery.js의 배치와 같은 대략값)
const FAR_Z = [-1040, 1060];
const FAR_X = [-956, 1816];
const FAR_WALL_H = 25;

export class Sight {
  constructor(world) {
    this.world = world;
    this.hash = world.hash;
    const s = sunDirection();
    this.sun = { x: s.x, y: s.y, z: s.z };
    this._cand = [];
    this._h = { t0: 0, t1: 0, nx: 0, ny: 0, nz: 0, radius: 0 };
    this._cs = makeCoverSample();
    this._coverCache = new Map();
    this._profT = new Float32Array(2048);
    this._profC = new Float32Array(2048);
    this._covT = new Float32Array(4096);
    this._covH = new Float32Array(4096);
    this._covS = new Float32Array(4096);
    this._covY = new Float32Array(4096);
    this.stats = { rays: 0, candidates: 0, ms: 0, calls: 0 };
    // 숲띠 높이(배경 판정용)
    this.beltHeights = world.beltHeights || {};
  }

  /** 지면 덮개(높이, 소광 계수 1/m) — 0.5 m 격자로 기억 */
  _cover(x, z) {
    const qx = Math.round(x * 2);
    const qz = Math.round(z * 2);
    const key = qx * 100003 + qz;
    let v = this._coverCache.get(key);
    if (v === undefined) {
      const c = coverAt(this.world.terrain, qx / 2, qz / 2, this._cs);
      const ex = VISION.coverExtinction;
      const sig = c.k[0] * ex[0] + c.k[1] * ex[1] + c.k[2] * ex[2];
      v = [c.h, sig];
      if (this._coverCache.size > 400000) this._coverCache.clear();
      this._coverCache.set(key, v);
    }
    return v;
  }

  /** 선분 a→b 둘레(pad m) 공간 해시 칸의 물체를 모은다(중복 없음) */
  _collect(ax, az, bx, bz, pad, out) {
    const H = this.hash;
    const stamp = ++losStamp;
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 8));
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const x0 = ax + (bx - ax) * t0;
      const z0 = az + (bz - az) * t0;
      const x1 = ax + (bx - ax) * t1;
      const z1 = az + (bz - az) * t1;
      const i0 = Math.max(0, Math.floor((Math.min(x0, x1) - pad + H.half) * H.inv));
      const i1 = Math.min(H.n - 1, Math.floor((Math.max(x0, x1) + pad + H.half) * H.inv));
      const j0 = Math.max(0, Math.floor((Math.min(z0, z1) - pad + H.half) * H.inv));
      const j1 = Math.min(H.n - 1, Math.floor((Math.max(z0, z1) + pad + H.half) * H.inv));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = H.cells[j * H.n + i];
          if (!c) continue;
          for (let q = 0; q < c.length; q++) {
            const o = c[q];
            if (o._los === stamp) continue;
            o._los = stamp;
            if (o.kind === 'shrubInst') continue;
            out.push(o);
          }
        }
      }
    }
    return out;
  }

  /**
   * 관측자 눈(ox,oy,oz) → 표적 점들(pts: [x,y,z, x,y,z, ...])의 투과율을 out[i]에 쓴다.
   * opts.skipLast: 표적 점 바로 앞 이 거리(m)는 덮개·지형 검사에서 뺀다(사람이 누운 자리의 풀은 눌림)
   * @returns {number[]} out
   */
  transmissionMulti(ox, oy, oz, pts, out, opts = {}) {
    const t0ms = this.stats.calls % 64 === 0 ? performance.now() : 0;
    const n = pts.length / 3;
    const w = this.world;
    const T = w.terrain;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += pts[i * 3];
      cy += pts[i * 3 + 1];
      cz += pts[i * 3 + 2];
    }
    cx /= n;
    cy /= n;
    cz /= n;
    let spread = 0;
    for (let i = 0; i < n; i++) spread = Math.max(spread, Math.hypot(pts[i * 3] - cx, pts[i * 3 + 2] - cz));
    const dxc = cx - ox;
    const dyc = cy - oy;
    const dzc = cz - oz;
    const L = Math.sqrt(dxc * dxc + dyc * dyc + dzc * dzc);
    const skipLast = opts.skipLast ?? 0.3;
    for (let i = 0; i < n; i++) out[i] = 1;
    if (L < 0.2) return out;

    // 1) 후보 물체
    const cand = this._collect(ox, oz, cx, cz, spread + 0.6, (this._cand.length = 0, this._cand));
    this.stats.candidates += cand.length;

    // 2) 지형 단면(가운데 광선): 지면 위 높이
    const K = Math.min(this._profT.length - 1, Math.max(2, Math.ceil(L / TERRAIN_STEP)));
    const pT = this._profT;
    const pC = this._profC;
    for (let k = 0; k <= K; k++) {
      const t = k / K;
      const x = ox + dxc * t;
      const z = oz + dzc * t;
      pT[k] = t;
      pC[k] = oy + dyc * t - T.macroHeightAt(x, z);
    }

    // 3) 덮개 단면: 가운데 광선이 덮개 최대 높이(+ 점 사이 높이차) 아래를 지나는 구간만
    let dyMax = 0;
    for (let i = 0; i < n; i++) dyMax = Math.max(dyMax, Math.abs(pts[i * 3 + 1] - cy));
    const lowLimit = COVER_MAX_H + dyMax + 0.3;
    const M = Math.min(this._covT.length, Math.ceil(L / COVER_STEP));
    let m = 0;
    const cT = this._covT;
    const cH = this._covH;
    const cS = this._covS;
    const cY = this._covY;
    const tSkip = 1 - skipLast / L;
    for (let k = 0; k < M; k++) {
      const t = (k + 0.5) / M;
      if (t > tSkip) break;
      // 지형 단면에서 이 지점의 지면 위 높이(선형 보간)
      const f = t * K;
      const k0 = Math.min(K - 1, Math.floor(f));
      const clr = pC[k0] + (pC[k0 + 1] - pC[k0]) * (f - k0);
      if (clr > lowLimit) continue;
      const x = ox + dxc * t;
      const z = oz + dzc * t;
      const cv = this._cover(x, z);
      if (cv[0] <= 0.02 || cv[1] <= 0) continue;
      cT[m] = t;
      cH[m] = cv[0];
      cS[m] = cv[1];
      cY[m] = clr;
      m++;
    }
    const dl = L / M;

    // 4) 점마다
    const h = this._h;
    const G = VISION.leafG;
    const P = VISION.opacityPath;
    for (let i = 0; i < n; i++) {
      const px = pts[i * 3];
      const py = pts[i * 3 + 1];
      const pz = pts[i * 3 + 2];
      const dx = px - ox;
      const dy = py - oy;
      const dz = pz - oz;
      const Li = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ddy = py - cy; // 가운데 광선 대비 높이 차(t에 비례)
      // 지형(먼 구간: 단면)
      let blocked = false;
      const tNear = Math.max(0, 1 - NEAR / Li);
      for (let k = 1; k < K; k++) {
        const t = pT[k];
        if (t >= tNear) break;
        if (pC[k] + ddy * t < -0.05) {
          blocked = true;
          break;
        }
      }
      // 지형(표적 근처: 미세 요철 포함)
      if (!blocked) {
        const nn = Math.ceil((Li - Li * tNear) / 0.5);
        const tEnd = 1 - skipLast / Li;
        for (let k = 0; k <= nn; k++) {
          const t = tNear + ((1 - tNear) * k) / nn;
          if (t > tEnd) break;
          const x = ox + dx * t;
          const z = oz + dz * t;
          if (oy + dy * t < T.heightAt(x, z) - 0.01) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) {
        out[i] = 0;
        continue;
      }
      let tau = 0;
      // 덮개
      for (let k = 0; k < m; k++) {
        if (cY[k] + ddy * cT[k] < cH[k]) tau += cS[k] * dl;
      }
      if (tau > 12) {
        out[i] = 0;
        continue;
      }
      // 물체
      let trans = 1;
      for (let q = 0; q < cand.length && !blocked; q++) {
        const o = cand[q];
        switch (o.kind) {
          case 'trunk':
            if (segStem(ox, oy, oz, dx, dy, dz, o, h) && h.t0 < 1 && h.t1 > 0) blocked = true;
            break;
          case 'limb':
            if (segCappedCylinder(ox, oy, oz, dx, dy, dz, o.ax, o.ay, o.az, o.bx, o.by, o.bz, o.r, h) && h.t0 < 1) {
              if (o.r >= VISION.thinLimbRadius) blocked = true;
              else trans *= VISION.thinLimbTransmission;
            }
            break;
          case 'log':
            if (segCylinder(ox, oy, oz, dx, dy, dz, o.ax, o.ay, o.az, o.bx, o.by, o.bz, (o.r + o.r2) * 0.5, h) && h.t0 < 1) blocked = true;
            break;
          case 'bale':
          case 'rootPlate':
            if (segCappedCylinder(ox, oy, oz, dx, dy, dz, o.ax, o.ay, o.az, o.bx, o.by, o.bz, o.r, h) && h.t0 < 1) blocked = true;
            break;
          case 'foliage': {
            // 빠른 거부: 볼륨 중심과 광선 사이 거리
            const r = o.rx > o.ry ? o.rx : o.ry;
            const wx = o.cx - ox;
            const wy = o.cy - oy;
            const wz = o.cz - oz;
            let s = (wx * dx + wy * dy + wz * dz) / (Li * Li);
            s = s < 0 ? 0 : s > 1 ? 1 : s;
            const ex = wx - dx * s;
            const ey = wy - dy * s;
            const ez = wz - dz * s;
            if (ex * ex + ey * ey + ez * ez > r * r) break;
            if (segEllipsoid(ox, oy, oz, dx, dy, dz, o.cx, o.cy, o.cz, o.rx, o.ry, o.rz, h)) {
              const a = h.t0 < 0 ? 0 : h.t0;
              const b = h.t1 > 1 ? 1 : h.t1;
              if (b > a) {
                const op = o.opacity >= 0.999 ? 0.999 : o.opacity;
                const lad = -Math.log(1 - op) / P;
                tau += G * lad * (b - a) * Li;
              }
            }
            break;
          }
          default:
            break;
        }
      }
      out[i] = blocked ? 0 : trans * Math.exp(-tau);
    }
    this.stats.rays += n;
    this.stats.calls++;
    if (t0ms) this.stats.ms = performance.now() - t0ms;
    return out;
  }

  /** 한 점 */
  transmission(ox, oy, oz, x, y, z, opts) {
    const o = this._one || (this._one = [0]);
    return this.transmissionMulti(ox, oy, oz, [x, y, z], o, opts)[0];
  }

  /** 점의 햇빛(0~1): 해 쪽으로 수관·줄기·지형 투과율 */
  sunlit(x, y, z) {
    const s = this.sun;
    const len = 60 / Math.max(0.2, s.y);
    return this.transmission(x, y, z, x + s.x * len, y + s.y * len, z + s.z * len, { skipLast: 0 });
  }

  /**
   * 관측자 눈 → 표적 점 연장선 뒤의 배경: 'sky'(실루엣) | 'forest'(숲띠 나무) | 'far'(먼 숲띠 지평선) | 'field'(땅)
   * 지형 + 수관 지도(수관 밀도 0.3 이상이면 그 숲띠 높이의 물체)로 연장선을 따라간다.
   */
  background(ox, oy, oz, px, py, pz) {
    const w = this.world;
    const T = w.terrain;
    const dx = px - ox;
    const dy = py - oy;
    const dz = pz - oz;
    const hd = Math.hypot(dx, dz) || 1;
    const ux = dx / hd;
    const uz = dz / hd;
    const slope = dy / hd;
    const half = w.data.mapHalf - 2;
    for (let s = 2; s < 2500; s += s < 60 ? 2 : 6) {
      const x = px + ux * s;
      const z = pz + uz * s;
      const y = py + slope * s;
      if (Math.abs(x) > half || Math.abs(z) > half) {
        // 지도 밖: 원경 숲띠(DistantScenery — 높이 약 28 m 벽, 동서 줄은 z ≈ −1040·+1060, 남북 줄은 x ≈ −956·+1816)
        // 연장선이 그 벽을 넘으면 하늘
        let best = Infinity;
        for (const zw of FAR_Z) {
          if (uz !== 0) {
            const ss = (zw - pz) / uz;
            if (ss > s && ss < best) best = ss;
          }
        }
        for (const xw of FAR_X) {
          if (ux !== 0) {
            const ss = (xw - px) / ux;
            if (ss > s && ss < best) best = ss;
          }
        }
        if (best === Infinity) return { kind: 'sky', dist: s };
        const yb = py + slope * best;
        return yb > FAR_WALL_H ? { kind: 'sky', dist: best } : { kind: 'far', dist: best };
      }
      const g = T.macroHeightAt(x, z);
      if (y < g) return { kind: 'field', dist: s };
      const c = w.belts.canopyAt(x, z);
      if (c > 0.3) {
        const belt = w.layout.beltAt(x, z, 4);
        const bh = belt ? this.beltHeights[belt.belt.id] || 15 : 12;
        if (y < g + bh * 0.95) return { kind: s < 120 ? 'forest' : 'far', dist: s };
      }
    }
    return { kind: 'sky', dist: 2500 };
  }
}
