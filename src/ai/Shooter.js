// 적 병사의 소총 다루기: 탄창 단위 탄 소모·재장전, 총 들어 조준, 격발.
// 정확도는 플레이어와 같은 모델이다:
//   사람 흔들림 = AimModel(같은 자세별 흔들림 표, 심박·숨 참기·거치·반동 스프링) × 숙련도 배율(0.8~1.5) × 제압·부상 배율
//   총+탄 분산 = 7.62×39 축별 1.6 MOA, 탄간 총구속도 편차
//   조준 = 두뇌가 준 조준점(눈으로 본 몸 부위, 또는 안 보일 때 추정 위치에서 뽑은 점)
//        + 눈대중 거리에 맞춘 앙각(거리 오차 ±10~20 %만큼 위아래로 빗나감) + 바람은 거의 보정하지 않음
// 탄은 실제 총구에서 같은 투사체 시스템(BulletSystem)으로 나간다.

import { WEAPONS, ENEMY_WEAPON } from '../data/weapons.js';
import { AMMO } from '../data/ammo.js';
import { AimModel, MOA } from '../weapon/AimModel.js';
import { BallisticModel, solveZeroElevation, millerStability } from '../physics/ballistics.js';
import { MOVEMENT } from '../data/movement.js';
import { rng } from '../core/Random.js';
import { clamp, lerp } from '../core/math.js';

const W = WEAPONS[ENEMY_WEAPON];
const A = AMMO[W.ammoId];
const H = MOVEMENT.heart;

// 거리별 앙각 표(총구에서 조준점까지 직선 대비, rad): 사수가 '이 거리면 이만큼 위'로 아는 값
let HOLD = null;
let TOF = null;
function holdTable() {
  if (HOLD) return;
  const m = new BallisticModel({ dragModel: A.dragModel, bc: A.bc });
  HOLD = [];
  TOF = [];
  for (let d = 10; d <= 900; d += 10) {
    const el = solveZeroElevation(m, { muzzleVelocity: W.muzzleVelocity, sightHeight: 0, zeroRange: d });
    HOLD.push(el);
  }
  // 비행시간(리드용): 근사 — 평균 속도
  for (let d = 10; d <= 900; d += 10) {
    let t = 0;
    let v = W.muzzleVelocity;
    const k = Math.log(715 / 458) / 300; // 7.62×39 속도 감소율(시험 [7] 표)
    for (let s = 0; s < d; s += 5) {
      v = W.muzzleVelocity * Math.exp(-k * s);
      t += 5 / v;
    }
    TOF.push(t);
  }
}
function lookup(T, d) {
  const f = clamp(d / 10 - 1, 0, T.length - 1.001);
  const i = Math.floor(f);
  return T[i] + (T[i + 1] - T[i]) * (f - i);
}
export function holdFor(d) {
  holdTable();
  return lookup(HOLD, d);
}
export function tofFor(d) {
  holdTable();
  return lookup(TOF, d);
}

export class Shooter {
  /**
   * @param {object} enemy 몸(Enemy)
   * @param {object} ctx {bullets, events}
   * @param {object} skill {sway, reaction}
   */
  constructor(enemy, ctx, skill) {
    this.e = enemy;
    this.ctx = ctx;
    this.skill = skill;
    this.data = W;
    this.ammo = A;
    this.aim = new AimModel(W, A, null);
    this.sg = millerStability({
      massGrains: A.massGrains,
      diameterIn: A.diameter / 0.0254,
      lengthIn: A.length / 0.0254,
      twistIn: W.twistInches,
      velocityFps: W.muzzleVelocity / 0.3048,
    });
    holdTable();
    this.dispersionMoa = A.dispersionSigmaMoa; // 시험에서 바꿔 볼 수 있게
    this.mvSD = A.muzzleVelocitySD;
    this.reset();
  }

  reset() {
    this.mag = W.magazineCapacity;
    this.spare = W.magazinesCarried - 1;
    this.chambered = true;
    this.reload = null; // {t, dur}
    this.raise = 0; // 0 낮춤 ~ 1 조준
    this.wantRaise = false;
    this.target = null; // {x,y,z, mode:'aimed'|'suppress', rangeBias, vx, vz}
    this.readyAt = Infinity; // 첫 발을 쏠 수 있는 시각(조준 시간)
    this.nextShot = 0;
    this.burst = 0;
    this.heart = H.rest + rng.range(0, 8);
    this.time = 0;
    this.shots = 0;
    this.lastShot = -100;
    this.swayMul = 1;
    this.rest = null;
    this.blocked = false;
    this.aim.hold.active = false;
  }

  get rounds() {
    return this.mag + (this.chambered ? 1 : 0);
  }
  get totalRounds() {
    return this.rounds + this.spare * W.magazineCapacity;
  }
  get reloading() {
    return !!this.reload;
  }
  get canShoot() {
    return this.chambered && !this.reload && this.raise > 0.95 && this.e.rifleHeld;
  }

  /** 재장전 시작(탄창 교환). 노리쇠 멈춤이 없어 빈 탄창이면 장전 손잡이까지 */
  startReload() {
    if (this.reload || this.spare <= 0) return false;
    const H2 = W.handling;
    let dur = H2.reload + (this.chambered ? 0 : H2.reloadEmptyExtra);
    if (this.e.stance === 'prone') dur *= H2.proneMultiplier;
    if (this.e.clutch === 'arm') dur *= 2.5;
    dur *= lerp(0.9, 1.25, (this.skill.reaction - 0.8) / 0.5);
    this.reload = { t: 0, dur, magOut: false };
    this.wantRaise = false;
    this.ctx.events.emit('enemy:reload', { enemy: this.e, duration: dur });
    return true;
  }

  /**
   * 조준점 지정. mode 'aimed'(보이는 표적) | 'suppress'(추정 위치로 제압)
   * firstSight: 이번에 처음 조준하는가(조준 시간 시작)
   */
  setTarget(t) {
    const prev = this.target;
    this.target = t;
    if (!t) {
      this.readyAt = Infinity;
      return;
    }
    if (!prev || Math.hypot(prev.x - t.x, prev.z - t.z) > 6 || prev.mode !== t.mode) {
      // 첫 발까지 조준 시간: 0.5~1.5 s + 거리(멀수록 길게), 반응 배율
      const d = Math.hypot(t.x - this.e.x, t.z - this.e.z);
      const base = rng.range(0.5, 1.0) + (d / 400) * rng.range(0.4, 0.9);
      this.readyAt = this.time + base * this.skill.reaction + (this.raise < 0.95 ? W.handling.raise : 0);
    }
  }

  /**
   * @param {number} dt
   * @param {object} s {stance:'stand'|'crouch'|'prone', speed, supp, rest, wound}
   */
  update(dt, s) {
    this.time += dt;
    // 심박: 뛰면 오르고, 멈추면 수십 초에 걸쳐 내려감(플레이어와 같은 수치)
    if (s.speed > 2.5) this.heart = Math.min(H.max, this.heart + H.sprintRise * 0.8 * dt);
    else if (s.speed > 1.2) this.heart = Math.min(128, this.heart + H.runRise * dt);
    else this.heart += (H.rest + 6 - this.heart) * (1 - Math.exp(-dt / H.tau));
    // 제압되면 심박도 오른다
    if (s.supp > 0.3) this.heart = Math.min(H.max, this.heart + 6 * s.supp * dt);
    const ex = clamp((this.heart - H.rest) / (H.max - H.rest), 0, 1);
    // 재장전
    if (this.reload) {
      const r = this.reload;
      r.t += dt;
      if (!r.magOut && r.t > r.dur * 0.25) {
        r.magOut = true;
        this.ctx.events.emit('enemy:handling', { enemy: this.e, type: 'magOut' });
      }
      if (r.t >= r.dur) {
        this.spare--;
        this.mag = W.magazineCapacity;
        if (!this.chambered) {
          this.mag--;
          this.chambered = true;
          this.ctx.events.emit('enemy:handling', { enemy: this.e, type: 'boltRelease' });
        } else this.ctx.events.emit('enemy:handling', { enemy: this.e, type: 'magSeat' });
        this.reload = null;
      }
    }
    // 총 들기
    const up = this.wantRaise && !this.reload && this.e.rifleHeld;
    this.raise = up ? Math.min(1, this.raise + dt / W.handling.raise) : Math.max(0, this.raise - dt / 0.35);
    this.swayMul = this.skill.sway * (1 + 1.6 * (s.supp || 0)) * (s.wound || 1);
    this.rest = s.rest || null;
    this.aim.update(dt, {
      stance: s.stance,
      ads: this.raise,
      exertion: ex,
      heartRate: this.heart,
      breathRate: 1 / lerp(MOVEMENT.breathing.restPeriod, MOVEMENT.breathing.minPeriod, Math.pow(ex, 0.8)),
      stamina: 1,
      speed: s.speed,
      rest: this.rest,
    });
    // 숨 참기: 조준 사격(멀리)일 때 첫 발 직전에
    const t = this.target;
    const want = !!(t && t.mode === 'aimed' && this.raise > 0.9 && this.time >= this.readyAt - 0.6 && Math.hypot(t.x - this.e.x, t.z - this.e.z) > 120);
    this.aim.setHoldBreath(want);
  }

  /**
   * 지금 쏠 수 있으면 한 발. 두뇌가 쏘라고 할 때 매 프레임 부른다.
   * @returns {object|null} 발사한 탄
   */
  tryFire(muzzleClear = true) {
    const t = this.target;
    if (!t || !this.canShoot || this.time < this.readyAt || this.time < this.nextShot) return null;
    if (!muzzleClear) {
      this.blocked = true;
      return null;
    }
    this.blocked = false;
    // 숨 참기 안정 구간 안에서(조준 사격, 멀리) — 안정되기 전이면 조금 기다림
    if (t.mode === 'aimed' && this.aim.hold.active && this.aim.hold.time < 0.4 && Math.hypot(t.x - this.e.x, t.z - this.e.z) > 120) return null;
    return this._fire(t);
  }

  _fire(t) {
    const e = this.e;
    const m = e.muzzleWorld(this._m || (this._m = { x: 0, y: 0, z: 0 }));
    let tx = t.x;
    let ty = t.y;
    let tz = t.z;
    const dx0 = tx - m.x;
    const dz0 = tz - m.z;
    const dh = Math.hypot(dx0, dz0) || 1;
    // 눈대중 거리(보이는 표적은 거리 오차 배율, 추정 위치는 그 추정 거리 그대로)
    const dEst = dh * (t.rangeBias || 1);
    // 움직이는 표적 앞에 겨눔(속도 추정 오차 ±30 %)
    if (t.vx || t.vz) {
      const lead = tofFor(dEst) * (1 + rng.gauss() * 0.3);
      tx += t.vx * lead;
      tz += t.vz * lead;
    }
    const dx = tx - m.x;
    const dy = ty - m.y;
    const dz = tz - m.z;
    const dhh = Math.hypot(dx, dz) || 1;
    let yaw = Math.atan2(dx, -dz);
    let pitch = Math.atan2(dy, dhh) + holdFor(dEst);
    // 사람 흔들림(같은 모델) × 숙련도·제압·부상
    yaw += this.aim.yaw * this.swayMul;
    pitch += this.aim.pitch * this.swayMul;
    // 총+탄 분산
    const sd = this.dispersionMoa * MOA;
    yaw += rng.gauss() * sd;
    pitch += rng.gauss() * sd;
    const cp = Math.cos(pitch);
    const dir = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
    const speed = W.muzzleVelocity + rng.gauss() * this.mvSD;
    const b = this.ctx.bullets.fire({ origin: { x: m.x, y: m.y, z: m.z }, dir, speed, ammo: A, shooter: e.id, spinSg: this.sg, rightHandTwist: W.rightHandTwist });
    b.aimMode = t.mode;
    // 디브리핑용: 쏠 때 이 적이 본 내 몸 비율, 알던 위치 오차, 안 지 얼마나
    const K = e.knowledge;
    b.exposure = e.vis ? e.vis.frac : 0;
    b.knownErr = K ? K.err : null;
    b.knownFor = K && K.firstAware >= 0 && this.ctx.time ? this.ctx.time() - K.firstAware : null;
    // 탄 소모
    if (this.mag > 0) this.mag--;
    else this.chambered = false;
    if (this.mag === 0 && this.chambered) {
      // 약실 마지막 한 발 남음
    }
    this.shots++;
    this.lastShot = this.time;
    const stance = e.stance === 'prone' ? 'prone' : e.stance === 'kneel' ? 'crouch' : 'stand';
    this.aim.shot(stance);
    // 연발(점사)·단발 간격
    if (this.burst > 1) {
      this.burst--;
      this.nextShot = this.time + 60 / W.rateOfFire;
    } else {
      this.burst = 0;
      this.nextShot = this.time + (t.mode === 'aimed' ? rng.range(0.9, 2.2) * (dh > 250 ? 1.5 : 1) : rng.range(2.5, 6));
    }
    this.ctx.events.emit('shot', {
      shooter: e.id,
      position: { x: m.x, y: m.y, z: m.z },
      direction: dir,
      weapon: W.id,
      stance,
      bulletId: b.id,
      mode: t.mode,
    });
    return b;
  }

  /** 점사 길이 지정(다음 발부터) */
  setBurst(n) {
    this.burst = n;
  }
}
