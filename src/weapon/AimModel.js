// 조준 흔들림과 반동.
// 흔들림 = 자세 흔들림(저주파 표류) + 호흡(주기 ~4 s, 숨 참기 가능) + 맥박 + 미세 떨림 + 이동.
// 반동 = 실제 충격량(탄두·장약 가스 운동량) × 지렛대 ÷ 관성 → 감쇠 스프링(사수가 자연조준점으로 복귀).
// 출력: yaw/pitch 오프셋(rad). 총구 방향(=탄이 나가는 방향)과 조준 시 화면이 함께 따른다.

import { vnoise } from '../core/noise.js';
import { Spring, clamp, lerp } from '../core/math.js';
import { rng } from '../core/Random.js';

const MRAD = 0.001;

export class AimModel {
  constructor(weapon, ammo, events) {
    this.weapon = weapon;
    this.ammo = ammo;
    this.events = events;
    this.t = 0;
    this.seed = Math.random() * 100;
    this.pitchSpring = new Spring(3.2, 0.72);
    this.yawSpring = new Spring(3.2, 0.72);
    this.kick = new Spring(9, 0.6);
    this.shakeP = new Spring(14, 0.5);
    this.shakeR = new Spring(12, 0.5);
    this.swayYaw = 0;
    this.swayPitch = 0;
    this.breathPhase = 0;
    this.heartPhase = 0;
    this.hold = { active: false, time: 0, recovery: 0, recoveryScale: 1 };
    this.residualPitch = 0; // 이번 프레임 시선에 더할 잔여 반동
    this.residualYaw = 0;
    this.breathOffset = 0;
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

  /** 숨 참기 입력(조준 중 Shift) */
  setHoldBreath(want) {
    const h = this.hold;
    const HB = this.weapon.sway.holdBreath;
    if (want && !h.active && h.recovery <= 0) {
      h.active = true;
      h.time = 0;
      this.events.emit('breath', { type: 'hold' });
    } else if (!want && h.active) {
      h.active = false;
      const over = Math.max(0, h.time - HB.stableTime);
      h.recovery = HB.recovery * (0.35 + over / (HB.maxTime - HB.stableTime));
      h.recoveryScale = 1.3 + over * 0.15;
      this.events.emit('breath', { type: over > 1 ? 'gasp' : 'exhale' });
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
  }

  /**
   * @param {number} dt
   * @param {object} s {stance, ads(0~1), exertion(0~1), heartRate, breathRate, stamina, moving(0~1), speed}
   */
  update(dt, s) {
    this.t += dt;
    const SW = this.weapon.sway;
    const st = SW.stances[s.stance] || SW.stances.stand;
    const HB = SW.holdBreath;
    const h = this.hold;

    // 숨 참기 상태
    let breathScale = 1;
    let wanderScale = 1;
    let tremorExtra = 0;
    if (h.active) {
      h.time += dt;
      const over = Math.max(0, h.time - HB.stableTime);
      breathScale = HB.breathScale;
      wanderScale = lerp(HB.wanderScale, 1.6, clamp(over / (HB.maxTime - HB.stableTime), 0, 1));
      tremorExtra = HB.overtimeTremor * over;
      if (h.time >= HB.maxTime) this.setHoldBreath(false);
    } else if (h.recovery > 0) {
      h.recovery -= dt;
      breathScale = h.recoveryScale;
      wanderScale = 1.15;
    }

    const ex = s.exertion;
    const fatigue = 1 + 0.5 * (1 - s.stamina);
    const notShoulder = lerp(SW.notShouldered, 1, s.ads);

    // 1) 자세 표류
    const t = this.t;
    const k = this.seed;
    const wander = st.wander * MRAD * (1 + 1.4 * ex) * fatigue * wanderScale * notShoulder;
    const wy = (vnoise(t * 0.35 + k, 1.3) - 0.5) * 2 * 0.65 + (vnoise(t * 0.9 + k, 7.7) - 0.5) * 2 * 0.35;
    const wp = (vnoise(t * 0.3 + k, 4.1) - 0.5) * 2 * 0.65 + (vnoise(t * 0.8 + k, 9.9) - 0.5) * 2 * 0.35;

    // 2) 호흡: 들숨-날숨, 날숨 끝 자연 정지
    if (!h.active) this.breathPhase += dt * s.breathRate;
    const ph = this.breathPhase % 1;
    const breathWave = ph < 0.42 ? 0.5 - 0.5 * Math.cos((ph / 0.42) * Math.PI) : ph < 0.8 ? 0.5 + 0.5 * Math.cos(((ph - 0.42) / 0.38) * Math.PI) : 0;
    this.breathOffset = breathWave;
    const breath = st.breath * MRAD * (1 + 1.3 * ex) * breathScale * notShoulder;

    // 3) 맥박
    this.heartPhase += dt * (s.heartRate / 60);
    const hp = this.heartPhase % 1;
    const pulseWave = hp < 0.12 ? Math.sin((hp / 0.12) * Math.PI) : 0;
    const pulse = st.pulse * MRAD * (1 + 1.2 * ex) * pulseWave;

    // 4) 떨림
    const tremor = (st.tremor + tremorExtra * 0.1) * MRAD * (1 + ex);
    const ty = (vnoise(t * 9.0 + k, 2.2) - 0.5) * 2;
    const tp = (vnoise(t * 10.5 + k, 5.4) - 0.5) * 2;

    // 5) 이동
    const mv = SW.moving * MRAD * clamp(s.speed / 1.5, 0, 2) * notShoulder;
    const my = Math.sin(t * 5.2) * mv * 0.8;
    const mp = Math.abs(Math.sin(t * 5.2)) * mv;

    this.swayYaw = wander * wy + tremor * ty + my + breath * 0.15 * Math.sin(ph * Math.PI * 2);
    this.swayPitch = wander * wp + breath * (breathWave - 0.4) * 2 + pulse + tremor * tp + mp;

    this.pitchSpring.update(dt);
    this.yawSpring.update(dt);
    this.kick.update(dt);
    this.shakeP.update(dt);
    this.shakeR.update(dt);
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
