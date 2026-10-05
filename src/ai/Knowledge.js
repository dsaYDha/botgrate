// 적 한 명이 아는 위협(플레이어)의 위치: 항상 '추정 위치 + 오차'(2차원 정규분포, 칼만 갱신).
//   관측(본 것·들은 것·전해 들은 것)이 오면 오차가 줄고, 새 정보가 없으면 표적이 움직였을 수 있는 만큼 커진다.
//   관측이 추정과 너무 다르면(3σ 밖) 표적이 옮겨 갔다고 보고 새 관측으로 바꾼다 — 그 전까지는 옛 위치를 향해 대응한다.
// 인지 단계: unaware(모름) → suspicious(의심) → searching(수색: 위협은 있는데 위치를 모름)
//           → located(위치 파악: 오차 25 m 이하) → engaging(교전: 지금 보이거나 그 위치로 쏘는 중)
// 이 객체는 인지 시스템(Senses)만 갱신하고, 두뇌는 읽기만 한다.

import { KNOWLEDGE } from '../data/perception.js';

export const STAGES = ['unaware', 'suspicious', 'searching', 'located', 'engaging'];
export const STAGE_NAMES = { unaware: '모름', suspicious: '의심', searching: '수색', located: '위치 파악', engaging: '교전' };

export class ThreatKnowledge {
  constructor() {
    this.reset();
  }

  reset() {
    this.has = false; // 위치 추정이 있는가
    this.x = 0;
    this.z = 0;
    // 공분산 [pxx, pxz, pzz]
    this.pxx = 0;
    this.pxz = 0;
    this.pzz = 0;
    this.lastObs = -1e9; // 마지막 관측 시각
    this.lastSource = null;
    this.firstAware = -1;
    this.threat = false; // 적대 행위(총성·탄·동료 피격)를 확인했는가
    this.suspicion = 0; // 0~1: 확인되지 않은 낌새
    this.visible = false; // 지금 눈에 보이는가
    this.visibleSince = -1;
    this.seenPoint = null; // 보이는 동안: 본 몸 부위 위치(조준점) {x,y,z}
    this.vx = 0; // 보이는 동안 추정 속도
    this.vz = 0;
    this.firing = false; // 그 위치로 쏘는 중(두뇌가 표시)
    this.obsCount = 0;
    this.sharedFrom = null;
  }

  /** 오차 반지름(m, 약 2σ — 큰 축) */
  get err() {
    if (!this.has) return Infinity;
    const a = this.pxx;
    const b = this.pxz;
    const c = this.pzz;
    const tr = (a + c) / 2;
    const det = a * c - b * b;
    const l1 = tr + Math.sqrt(Math.max(0, tr * tr - det));
    return 2 * Math.sqrt(Math.max(0, l1));
  }

  stage(now) {
    if (this.visible || (this.firing && this.has)) return 'engaging';
    if (this.has && this.err <= KNOWLEDGE.locatedSigma * 2 && now - this.lastObs < KNOWLEDGE.forgetAfter) return 'located';
    if (this.threat) return 'searching';
    if (this.suspicion > 0.05 || this.has) return 'suspicious';
    return 'unaware';
  }

  /** 시간 경과: 표적이 움직였을 수 있는 만큼 오차가 커짐 */
  grow(dt) {
    if (!this.has || this.visible) return;
    const q = KNOWLEDGE.processSpeed * KNOWLEDGE.processSpeed * dt;
    this.pxx += q;
    this.pzz += q;
    this.suspicion = Math.max(0, this.suspicion - dt * 0.01);
  }

  /**
   * 관측 반영. 오차는 방위 방향(lat)과 거리 방향(rad)의 표준편차로 받는다.
   * 관측자 위치(ox, oz)를 주면 관측자 기준 극좌표(방위·거리)에서 합친다: 한 자리에서 보고 들은 것은
   * '그 방향, 그 거리쯤'이라는 호(弧) 모양 정보다. 직교좌표 타원으로 합치면 방위가 조금씩 다른 관측의 얇은
   * 타원이 엉뚱한 곳에서 교차해(같은 자리에서 하는 가짜 삼각측량) 오차를 과신하게 된다.
   * @param {number} x 관측 위치(관측자 + 방향 × 추정 거리)
   * @param {number} z
   * @param {number} sLat 옆(방위) 표준편차(m, 관측 거리에서)
   * @param {number} sRad 앞뒤(거리) 표준편차(m)
   * @param {number} ux 관측자 → 관측 위치 단위벡터
   * @param {number} uz
   * @param {number} floor 방위 오차 하한(m, 관측 거리에서): 같은 방향에서 거듭 들은 소리는 오차가 서로 묶여 있다
   * @param {number} ox 관측자 위치
   * @param {number} oz
   * @param {number} rangeFloor 거리 오차 하한(m): 같은 사람의 거리 눈대중 치우침처럼 매번 같은 쪽으로 틀리는 오차
   */
  observe(x, z, sLat, sRad, ux, uz, now, source, floor = 0, ox = NaN, oz = NaN, rangeFloor = 0) {
    this.obsCount++;
    this.lastSource = source;
    const r1 = Math.hypot(x - ox, z - oz);
    const r0 = this.has ? Math.hypot(this.x - ox, this.z - oz) : Infinity;
    if (r1 > 3 && r0 > 3) this._observePolar(ox, oz, Math.atan2(ux, -uz), r1, Math.atan2(sLat, r1), sRad, floor > 0 ? Math.atan2(floor, r1) : 0, rangeFloor / r1);
    else this._observeXY(x, z, sLat, sRad, ux, uz, floor);
    this.lastObs = now;
    if (this.firstAware < 0) this.firstAware = now;
  }

  /**
   * 합친 추정을 지형지물에 맞춤: 그 방위의 숲 가장자리(법선 nx, nz)까지 거리 r로.
   * 결과는 '그 가장자리 위 어딘가': 오차 타원을 가장자리를 따라 눕힌다 — 가장자리에 수직인 쪽은 sr,
   * 가장자리를 따라서는 방위 오차가 그 가장자리 위에서 번지는 길이(비스듬히 볼수록 길다).
   * 가장자리 짐작의 오차는 매번 같은 쪽이라(같은 가장자리) 거듭 맞춰도 sr 밑으로 줄지 않는다.
   * 관측마다 가장자리에 맞추지 않는 이유: 방위가 크게 빗나간 관측이 다른 숲띠(직각으로 놓인 띠)에 붙으면
   * 두 가장자리의 교점(엉뚱한 모서리)으로 끌려간다 — 먼저 방위·거리를 합치고, 합친 방위로 '저 숲 가장자리'를 고른다.
   */
  snapRange(ox, oz, r, sr, nx, nz) {
    if (!this.has) return;
    const p = this._toPolar(ox, oz);
    if (!p) return;
    const ux = Math.sin(p.b);
    const uz = -Math.cos(p.b);
    const c = Math.abs(ux * nx + uz * nz);
    const sb = Math.min(1.2, Math.sqrt(p.bb));
    const along = Math.min((r * Math.tan(sb)) / Math.max(0.3, c), 3 * r);
    const tx = -nz;
    const tz = nx;
    const a2 = along * along;
    const n2 = sr * sr;
    this._set(ox + ux * r, oz + uz * r, a2 * tx * tx + n2 * nx * nx, a2 * tx * tz + n2 * nx * nz, a2 * tz * tz + n2 * nz * nz);
  }

  /**
   * 극좌표 칼만. 상태는 (방위 b, 로그 거리 l = ln r): 사람의 거리 눈대중 오차는 거리에 비례(로그정규)라서,
   * 거리를 그대로 합치면 짧게 들은 관측이 '오차가 작다'며 과하게 반영돼 추정이 가까운 쪽으로 끌려간다.
   * 관측 (b1 ± sb, r1 ± sr), 방위 하한 fb(rad), 로그 거리 하한 fl.
   */
  _observePolar(ox, oz, b1, r1, sb, sr, fb, fl = 0) {
    const l1 = Math.log(r1);
    const sl = sr / r1;
    const p = this.has ? this._toPolar(ox, oz) : null;
    if (!p) {
      this._setPolar(ox, oz, b1, l1, Math.max(sb, fb) ** 2, 0, sl * sl);
      return;
    }
    const { b: b0, l: l0, bb, bl, ll } = p;
    // 혁신(방위는 ±π로 감음), S = P + R
    let yb = b1 - b0;
    yb = Math.atan2(Math.sin(yb), Math.cos(yb));
    const yl = l1 - l0;
    const sbb = bb + sb * sb;
    const sll = ll + sl * sl;
    const det = sbb * sll - bl * bl;
    if (det <= 1e-14) {
      this._setPolar(ox, oz, b1, l1, Math.max(sb, fb) ** 2, 0, sl * sl);
      return;
    }
    const ibb = sll / det;
    const ibl = -bl / det;
    const ill = sbb / det;
    const d2 = yb * (ibb * yb + ibl * yl) + yl * (ibl * yb + ill * yl);
    if (d2 > KNOWLEDGE.gateSigma2) {
      // 표적이 옮겨 갔다: 새 관측으로 바꿈
      this._setPolar(ox, oz, b1, l1, Math.max(sb, fb) ** 2, 0, sl * sl);
      return;
    }
    // K = P S⁻¹, P' = (I − K) P
    const kbb = bb * ibb + bl * ibl;
    const kbl = bb * ibl + bl * ill;
    const klb = bl * ibb + ll * ibl;
    const kll = bl * ibl + ll * ill;
    const b = b0 + kbb * yb + kbl * yl;
    const l = l0 + klb * yb + kll * yl;
    let nbb = Math.max(1e-8, (1 - kbb) * bb - kbl * bl);
    let nbl = (1 - kbb) * bl - kbl * ll;
    let nll = Math.max(1e-6, -klb * bl + (1 - kll) * ll);
    if (fl > 0 && nll < fl * fl) {
      nbl *= fl / Math.sqrt(nll);
      nll = fl * fl;
    }
    // 같은 방향에서 거듭 들은 소리는 오차가 서로 묶여 있어(딱 소리 혼동·메아리) 방위 오차가 무한히 줄지 않는다
    if (fb > 0 && nbb < fb * fb) {
      nbl *= fb / Math.sqrt(nbb);
      nbb = fb * fb;
    }
    this._setPolar(ox, oz, b, l, nbb, nbl, nll);
  }

  /** 현재 추정을 관측자 기준 (방위, 로그 거리)와 그 공분산으로 */
  _toPolar(ox, oz) {
    const dx = this.x - ox;
    const dz = this.z - oz;
    const r = Math.hypot(dx, dz);
    if (r < 1) return null;
    // 거리 방향 u, 방위가 커지는 방향 t. ∂b = t·d / r, ∂l = u·d / r
    const ux = dx / r;
    const uz = dz / r;
    const tx = -uz;
    const tz = ux;
    const q = (ax, az, bx, bz) => ax * (this.pxx * bx + this.pxz * bz) + az * (this.pxz * bx + this.pzz * bz);
    const r2 = r * r;
    return { b: Math.atan2(dx, -dz), l: Math.log(r), bb: q(tx, tz, tx, tz) / r2, bl: q(tx, tz, ux, uz) / r2, ll: q(ux, uz, ux, uz) / r2 };
  }

  /** (방위 b, 로그 거리 l)와 그 공분산 → 직교좌표 평균·공분산(야코비안 J = ∂(x,z)/∂(b,l)) */
  _setPolar(ox, oz, b, l, bb, bl, ll) {
    const r = Math.exp(Math.min(l, 9));
    const s = Math.sin(b);
    const c = Math.cos(b);
    const j11 = r * c;
    const j12 = r * s;
    const j21 = r * s;
    const j22 = -r * c;
    const a11 = j11 * bb + j12 * bl;
    const a12 = j11 * bl + j12 * ll;
    const a21 = j21 * bb + j22 * bl;
    const a22 = j21 * bl + j22 * ll;
    this._set(ox + r * s, oz - r * c, Math.max(0.01, a11 * j11 + a12 * j12), a11 * j21 + a12 * j22, Math.max(0.01, a21 * j21 + a22 * j22));
  }

  /** 직교좌표 칼만(관측자가 표적 바로 옆일 때만) */
  _observeXY(x, z, sLat, sRad, ux, uz, floor) {
    // 관측 공분산 R = U diag(rad², lat²) Uᵀ (U = [u, n])
    const r2 = sRad * sRad;
    const l2 = sLat * sLat;
    const rxx = r2 * ux * ux + l2 * uz * uz;
    const rxz = (r2 - l2) * ux * uz;
    const rzz = r2 * uz * uz + l2 * ux * ux;
    if (!this.has) {
      this._set(x, z, rxx, rxz, rzz);
    } else {
      // 혁신 y = z − m, S = P + R
      const yx = x - this.x;
      const yz = z - this.z;
      const sxx = this.pxx + rxx;
      const sxz = this.pxz + rxz;
      const szz = this.pzz + rzz;
      const det = sxx * szz - sxz * sxz;
      if (det <= 1e-9) {
        this._set(x, z, rxx, rxz, rzz);
      } else {
        const ixx = szz / det;
        const ixz = -sxz / det;
        const izz = sxx / det;
        const d2 = yx * (ixx * yx + ixz * yz) + yz * (ixz * yx + izz * yz);
        if (d2 > KNOWLEDGE.gateSigma2) {
          this._set(x, z, rxx, rxz, rzz);
        } else {
          const kxx = this.pxx * ixx + this.pxz * ixz;
          const kxz = this.pxx * ixz + this.pxz * izz;
          const kzx = this.pxz * ixx + this.pzz * ixz;
          const kzz = this.pxz * ixz + this.pzz * izz;
          this.x += kxx * yx + kxz * yz;
          this.z += kzx * yx + kzz * yz;
          const pxx = (1 - kxx) * this.pxx - kxz * this.pxz;
          const pxz = (1 - kxx) * this.pxz - kxz * this.pzz;
          const pzz = -kzx * this.pxz + (1 - kzz) * this.pzz;
          this.pxx = Math.max(0.01, pxx);
          this.pxz = pxz;
          this.pzz = Math.max(0.01, pzz);
        }
      }
    }
    if (floor > 0) {
      const e = this.err;
      if (e < 2 * floor) {
        const k = (2 * floor) / Math.max(1e-3, e);
        this.pxx *= k * k;
        this.pxz *= k * k;
        this.pzz *= k * k;
      }
    }
  }

  /** 남에게 들은 위치: 내 것보다 나을 때만 바꾼다(같은 정보를 되받아 오차가 줄어드는 일 없게 — 합치지 않음) */
  adopt(x, z, sig, now, source) {
    if (this.has && this.err <= 2 * sig) return false;
    this._set(x, z, sig * sig, 0, sig * sig);
    this.lastObs = now;
    this.lastSource = source;
    if (this.firstAware < 0) this.firstAware = now;
    return true;
  }

  _set(x, z, pxx, pxz, pzz) {
    this.has = true;
    this.x = x;
    this.z = z;
    this.pxx = pxx;
    this.pxz = pxz;
    this.pzz = pzz;
  }

  /** 추정 위치에서 무작위 한 점(제압 사격 조준점): 오차 분포에서 뽑기 */
  sample(rng, scale = 1) {
    const a = this.pxx;
    const b = this.pxz;
    const c = this.pzz;
    // 촐레스키
    const l11 = Math.sqrt(Math.max(1e-6, a));
    const l21 = b / l11;
    const l22 = Math.sqrt(Math.max(1e-6, c - l21 * l21));
    const g1 = rng.gauss() * scale;
    const g2 = rng.gauss() * scale;
    return { x: this.x + l11 * g1, z: this.z + l21 * g1 + l22 * g2 };
  }

  copyFrom(o) {
    this.has = o.has;
    this.x = o.x;
    this.z = o.z;
    this.pxx = o.pxx;
    this.pxz = o.pxz;
    this.pzz = o.pzz;
    this.lastObs = o.lastObs;
  }
}
