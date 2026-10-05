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
   * @param {number} x 관측 위치
   * @param {number} z
   * @param {number} sLat 옆(방위) 표준편차(m)
   * @param {number} sRad 앞뒤(거리) 표준편차(m)
   * @param {number} ux 관측자 → 관측 위치 단위벡터
   * @param {number} uz
   */
  observe(x, z, sLat, sRad, ux, uz, now, source, floor = 0) {
    // 관측 공분산 R = U diag(rad², lat²) Uᵀ (U = [u, n])
    const r2 = sRad * sRad;
    const l2 = sLat * sLat;
    const rxx = r2 * ux * ux + l2 * uz * uz;
    const rxz = (r2 - l2) * ux * uz;
    const rzz = r2 * uz * uz + l2 * ux * ux;
    this.obsCount++;
    this.lastSource = source;
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
          // 표적이 옮겨 갔다: 새 관측으로 바꿈
          this._set(x, z, rxx, rxz, rzz);
        } else {
          // K = P S⁻¹
          const kxx = this.pxx * ixx + this.pxz * ixz;
          const kxz = this.pxx * ixz + this.pxz * izz;
          const kzx = this.pxz * ixx + this.pzz * ixz;
          const kzz = this.pxz * ixz + this.pzz * izz;
          this.x += kxx * yx + kxz * yz;
          this.z += kzx * yx + kzz * yz;
          // P = (I − K) P
          const pxx = (1 - kxx) * this.pxx - kxz * this.pxz;
          const pxz = (1 - kxx) * this.pxz - kxz * this.pzz;
          const pzz = -kzx * this.pxz + (1 - kzz) * this.pzz;
          this.pxx = Math.max(0.01, pxx);
          this.pxz = pxz;
          this.pzz = Math.max(0.01, pzz);
        }
      }
    }
    // 같은 방향에서 거듭 들은 소리는 오차가 서로 묶여 있어(딱 소리 혼동·메아리) 무한히 줄지 않는다: 하한
    if (floor > 0) {
      const e = this.err;
      if (e < 2 * floor) {
        const k = (2 * floor) / Math.max(1e-3, e);
        this.pxx *= k * k;
        this.pxz *= k * k;
        this.pzz *= k * k;
      }
    }
    this.lastObs = now;
    if (this.firstAware < 0) this.firstAware = now;
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
