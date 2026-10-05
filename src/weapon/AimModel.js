// 조준 흔들림과 반동.
// 흔들림 = 자세 표류(느리게 떠도는 궤적) + 호흡(주기 ~4 s, 숨 참기 가능) + 맥박 튐 + 미세 떨림 + 걸음.
//   표류는 상관 시간이 있는 무작위 과정(오른스타인-울렌벡 + 저역 필터)으로, 축별 표준편차가 데이터의
//   자세별 값(MOA)과 정확히 같아지도록 정규화한다. 그래서 명중률 시험(tests/accuracy.test.js)이 같은 모델을 쓴다.
//   배수: 심박(질주 직후 2~3배, 수십 초에 걸쳐 회복), 팔 피로(거치 없이 10 s 넘게 조준), 숨 참기 한계 초과,
//   비견착, 걷기. 거치(통나무·둔덕·줄기 등)하면 자세별 거치 값으로 줄어든다.
// 반동 = 실제 충격량(탄두·장약 가스 운동량) × 지렛대 ÷ 관성 → 감쇠 스프링(사수가 자연조준점으로 복귀).
// 출력: yaw/pitch 오프셋(rad). 총구 방향(=탄이 나가는 방향)과 조준 시 화면이 함께 따른다.
// 눈 위치 어긋남(eyeOff, m): 4배율 광학의 아이박스 그림자에 쓴다(이동·반동·자세 전환 직후 커지고 안정되면 사라짐).

import { vnoise } from '../core/noise.js';
import { Spring, clamp, lerp } from '../core/math.js';
import { rng } from '../core/Random.js';

export const MOA = Math.PI / (180 * 60);
const TAU_F = 0.12; // 표류 저역 필터(s): 손떨림 같은 잔떨림 없이 매끈하게
const D90 = 4.292; // 2차원 정규분포 90 % 원 지름 / 축별 표준편차

export class AimModel {
  constructor(weapon, ammo, events) {
    this.weapon = weapon;
    this.ammo = ammo;
    this.events = events;
    this.t = 0;
    this.seed = rng.next() * 100;
    this.pitchSpring = new Spring(3.2, 0.72);
    this.yawSpring = new Spring(3.2, 0.72);
    this.kick = new Spring(9, 0.6);
    this.shakeP = new Spring(14, 0.5);
    this.shakeR = new Spring(12, 0.5);
    this.swayYaw = 0;
    this.swayPitch = 0;
    this.breathPhase = rng.next();
    this.heartPhase = rng.next();
    this.hold = { active: false, time: 0, recovery: 0, recoveryScale: 1, stable: 5, max: 11 };
    this.residualPitch = 0; // 이번 프레임 시선에 더할 잔여 반동
    this.residualYaw = 0;
    this.breathOffset = 0;
    // 표류 상태(단위 분산 과정, 축 2개)
    this.ou = [rng.gauss(), rng.gauss()];
    this.ouF = [this.ou[0], this.ou[1]];
    // 팔 피로: 거치 없이 조준한 누적 시간(s)
    this.aimTime = 0;
    this.fatigue = 1;
    // 현재 흔들림(디버그·시험용): 표류 축별 표준편차(MOA), 호흡 진폭(MOA)
    this.wanderMoa = 0;
    this.breathMoa = 0;
    this.rested = false;
    // 눈 위치 어긋남(m) — 광학 아이박스
    this.eyeOff = { x: 0, y: 0 };
    this._eyeN = [0, 0];
    this._adsPrev = 0;
    this._stancePrev = null;
    // 자유 반동 충격량 J (N·s)
    const W = weapon;
    const v0 = W.muzzleVelocity;
    this.impulse = ammo.mass * v0 + ammo.powderMass * v0 * W.recoil.gasVelocityFactor;
  }

  get yaw() {
    return this.swayYaw + this.yawSpring.x;
  }
  get pitch() {
    return this.swayPitch + this.pitchSpring.x;
  }

  /** 현재 흔들림 영역의 90 % 원 지름(MOA): 표류 + 호흡(무작위 순간에 쏠 때) */
  get swayDiameterMoa() {
    const b = this.breathMoa * 0.62; // 호흡 파형의 표준편차 ≈ 진폭 × 0.62
    return D90 * Math.sqrt(this.wanderMoa * this.wanderMoa + 0.5 * b * b);
  }

  /** 숨 참기 입력(조준 중 Shift) */
  setHoldBreath(want) {
    const h = this.hold;
    const HB = this.weapon.sway.holdBreath;
    if (want && !h.active && h.recovery <= 0) {
      h.active = true;
      h.time = 0;
      this.events?.emit('breath', { type: 'hold' });
    } else if (!want && h.active) {
      h.active = false;
      const over = Math.max(0, h.time - h.stable);
      h.recovery = HB.recovery * (0.35 + over / Math.max(0.5, h.max - h.stable));
      h.recoveryScale = 1.3 + over * 0.15;
      this.events?.emit('breath', { type: over > 1 ? 'gasp' : 'exhale' });
    }
  }

  /** 발사 시 반동 */
  shot(stance) {
    const R = this.weapon.recoil;
    const st = R.stances[stance] || R.stances.stand;
    this.pitchSpring.set(st.freq, st.damping);
    this.yawSpring.set(st.freq, st.damping);
    const w0 = (this.impulse * st.leverArm) / st.inertia; // rad/s
    const vp = w0 * (1 + rng.gauss() * 0.12);
    const vy = w0 * st.yawRatio * (rng.gauss() * 0.8 + st.yawBias);
    this.pitchSpring.impulse(vp);
    this.yawSpring.impulse(vy);
    // 사수가 다 되돌리지 못하는 몫은 시선 자체에 남김
    const wn = 2 * Math.PI * st.freq;
    this.residualPitch += st.residual * (vp / wn);
    this.residualYaw += st.residual * (vy / wn) * 0.5;
    this.kick.impulse(-R.modelKick * 9 * 2 * Math.PI * 0.25);
    this.shakeP.impulse(R.cameraShake * 40 * (0.8 + rng.next() * 0.4));
    this.shakeR.impulse(R.cameraShake * 30 * rng.gauss());
    // 개머리판이 뺨을 치고 올라옴 → 눈이 광축에서 잠깐 벗어남
    const E = this.weapon.sway.eye;
    const k = stance === 'prone' ? 0.6 : stance === 'crouch' ? 0.85 : 1;
    this.eyeOff.y -= E.recoil * k * (0.7 + rng.next() * 0.6);
    this.eyeOff.x += E.recoil * k * 0.45 * rng.gauss();
  }

  /**
   * 급한 격발(이전 발 직후 방아쇠를 서둘러 당김): 격발 순간 총이 살짝 흔들린다(오른손잡이는 대개 왼쪽 아래로).
   * @param {string} stance
   * @param {number} haste 0(침착) ~ 1(아주 급함)
   * @param {boolean} rested
   * @returns {[number, number]} [yaw, pitch] 총구 방향 변화(rad)
   */
  triggerJerk(stance, haste, rested) {
    if (haste <= 0) return [0, 0];
    const T = this.weapon.sway.trigger;
    const s = (T.jerk[stance] || T.jerk.stand) * haste * (rested ? T.restedScale : 1) * MOA;
    const y = (rng.gauss() * 0.8 - T.biasLeft) * s;
    const p = (rng.gauss() * 0.8 - T.biasLow) * s;
    // 보이는 총도 같이 움찔
    this.yawSpring.impulse(y * 2 * Math.PI * 3);
    this.pitchSpring.impulse(p * 2 * Math.PI * 3);
    return [y, p];
  }

  /**
   * @param {number} dt
   * @param {object} s {stance, ads(0~1), exertion(0~1), heartRate, breathRate, stamina, speed, rest(거치 여부), transition}
   */
  update(dt, s) {
    this.t += dt;
    const SW = this.weapon.sway;
    const st = SW.stances[s.stance] || SW.stances.stand;
    const HB = SW.holdBreath;
    const h = this.hold;
    const ex = clamp(s.exertion || 0, 0, 1);
    const rested = !!s.rest;
    this.rested = rested;

    // 숨 참기: 숨이 찰수록 짧게만 참을 수 있다
    const cut = 1 - HB.exertionCut * ex;
    h.stable = HB.stableTime * cut;
    h.max = HB.maxTime * cut;
    let breathScale = 1;
    let wanderScale = 1;
    let tremorExtra = 0;
    if (h.active) {
      h.time += dt;
      const over = Math.max(0, h.time - h.stable);
      breathScale = HB.breathScale;
      wanderScale = lerp(1, HB.wanderOvertime, clamp(over / Math.max(0.5, h.max - h.stable), 0, 1));
      tremorExtra = HB.overtimeTremor * over;
      if (h.time >= h.max) this.setHoldBreath(false);
    } else if (h.recovery > 0) {
      h.recovery -= dt;
      breathScale = h.recoveryScale;
      wanderScale = 1.15;
    }

    // 팔 피로: 서서·무릎쏴로 거치 없이 조준을 오래 유지하면 커지고, 조준을 풀거나 거치하면 회복
    const aiming = s.ads > 0.6;
    if (aiming && !rested && st.fatigueRate > 0) this.aimTime += dt;
    else this.aimTime = Math.max(0, this.aimTime - SW.fatigueRecover * dt);
    this.fatigue = 1 + Math.min(SW.fatigueMax, Math.max(0, this.aimTime - SW.fatigueOnset) * st.fatigueRate);

    const exMul = 1 + SW.exertion * ex;
    const notShoulder = lerp(SW.notShouldered, 1, s.ads);
    const walk = clamp(s.speed / 1.5, 0, 2);

    // 1) 자세 표류(축별 표준편차 = sigma)
    const holdMoa = rested ? st.rested : st.hold;
    const sigma = holdMoa * exMul * this.fatigue * wanderScale * notShoulder * (1 + 0.6 * walk);
    this.wanderMoa = sigma;
    const tau = st.corr;
    const a = Math.exp(-dt / tau);
    const b = Math.sqrt(1 - a * a);
    const kf = 1 - Math.exp(-dt / TAU_F);
    const norm = Math.sqrt((tau + TAU_F) / tau);
    for (let i = 0; i < 2; i++) {
      this.ou[i] = this.ou[i] * a + b * rng.gauss();
      this.ouF[i] += (this.ou[i] - this.ouF[i]) * kf;
    }
    const wy = this.ouF[0] * norm * sigma * MOA;
    const wp = this.ouF[1] * norm * sigma * MOA;

    // 2) 호흡: 들숨-날숨, 날숨 끝 자연 정지(이때 쏘면 호흡 흔들림이 거의 없다)
    if (!h.active) this.breathPhase += dt * s.breathRate;
    const ph = this.breathPhase % 1;
    const breathWave = ph < 0.42 ? 0.5 - 0.5 * Math.cos((ph / 0.42) * Math.PI) : ph < 0.8 ? 0.5 + 0.5 * Math.cos(((ph - 0.42) / 0.38) * Math.PI) : 0;
    this.breathOffset = breathWave;
    const breathMoa = st.breath * (1 + 1.5 * ex) * breathScale * notShoulder * (rested ? SW.restedBreath : 1);
    this.breathMoa = breathMoa;
    const breath = breathMoa * MOA;

    // 3) 맥박: 박동마다 작은 튐
    this.heartPhase += dt * (s.heartRate / 60);
    const hp = this.heartPhase % 1;
    const pulseWave = hp < 0.12 ? Math.sin((hp / 0.12) * Math.PI) : 0;
    const pulse = st.pulse * (1 + 1.5 * ex) * (rested ? 0.8 : 1) * MOA * pulseWave;

    // 4) 미세 떨림
    const t = this.t;
    const k = this.seed;
    const tremor = (st.tremor * (1 + ex) * this.fatigue + tremorExtra) * MOA;
    const ty = (vnoise(t * 9.0 + k, 2.2) - 0.5) * 2;
    const tp = (vnoise(t * 10.5 + k, 5.4) - 0.5) * 2;

    // 5) 걷기: 걸음마다 흔들림(조준하고 걸으면 서서쏴보다 훨씬 크다)
    const mv = SW.moving * MOA * walk * notShoulder;
    const my = Math.sin(t * 5.2) * mv * 0.8;
    const mp = Math.abs(Math.sin(t * 5.2)) * mv;

    this.swayYaw = wy + tremor * ty + my + breath * 0.15 * Math.sin(ph * Math.PI * 2) + pulse * 0.25;
    this.swayPitch = wp + breath * (breathWave - 0.4) * 2 + pulse + tremor * tp + mp;
    // 부상(팔): 흔들림 전체가 커진다
    if (s.extraSway && s.extraSway !== 1) {
      this.swayYaw *= s.extraSway;
      this.swayPitch *= s.extraSway;
      this.wanderMoa *= s.extraSway;
      this.breathMoa *= s.extraSway;
    }

    this.pitchSpring.update(dt);
    this.yawSpring.update(dt);
    this.kick.update(dt);
    this.shakeP.update(dt);
    this.shakeR.update(dt);
    this._updateEye(dt, s, ex, walk);
  }

  /** 눈 위치 어긋남: 조준을 막 시작하거나 자세를 바꾼 직후·이동·숨 가쁨 → 커지고, 가만히 있으면 안정 */
  _updateEye(dt, s, ex, walk) {
    const E = this.weapon.sway.eye;
    const e = this.eyeOff;
    // 조준을 막 올렸을 때: 뺨이 개머리판에 자리 잡기 전
    if (s.ads > 0.6 && this._adsPrev <= 0.6) {
      e.x = rng.gauss() * E.settleStart * 0.6;
      e.y = (0.4 + Math.abs(rng.gauss()) * 0.6) * E.settleStart;
    }
    this._adsPrev = s.ads;
    const st = s.transition ? 'transition' : s.stance;
    if (this._stancePrev && st !== this._stancePrev) {
      e.x += rng.gauss() * E.settleStart;
      e.y += rng.gauss() * E.settleStart;
    }
    this._stancePrev = st;
    // 이동·숨 가쁨에 따른 머리 흔들림(느린 무작위 과정)
    const sd = E.move * walk + E.exertion * ex + (s.transition ? E.settleStart : 0);
    const a = Math.exp(-dt / 0.25);
    const b = Math.sqrt(1 - a * a);
    this._eyeN[0] = this._eyeN[0] * a + b * rng.gauss();
    this._eyeN[1] = this._eyeN[1] * a + b * rng.gauss();
    const tx = this._eyeN[0] * sd;
    const ty = this._eyeN[1] * sd;
    const tauS = s.stance === 'prone' ? E.settleProne : E.settle;
    const kk = 1 - Math.exp(-dt / tauS);
    e.x += (tx - e.x) * kk;
    e.y += (ty - e.y) * kk;
  }

  consumeResidual() {
    const r = [this.residualYaw, this.residualPitch];
    this.residualYaw = 0;
    this.residualPitch = 0;
    return r;
  }

  get modelKick() {
    return this.kick.x;
  }
  get cameraShakePitch() {
    return this.shakeP.x;
  }
  get cameraShakeRoll() {
    return this.shakeR.x;
  }
}
