// 무기 시스템: 사격 통제(단발/연발, 발사 속도), 약실·탄창, 재장전(전술/급속/탄 소진),
// 탄창 확인, 조정간, 조준기 교체, 조준(ADS) 전환, 질주 시 총 내림, 총 길이에 의한 걸림.
// 탄은 총열 방향(조준선 + 영점 앙각)으로, 실제 총구 위치에서 나간다(크로스헤어 없음).
// 거치: 총 앞손 받침 바로 밑에 흙(둔덕·배수로 둑)·통나무·뿌리판·짚 더미가 있거나 옆에 줄기가 닿으면 흔들림이 줄어든다.
// 총열 과열: 발마다 온도가 오르고 천천히 식는다. 뜨거우면 분산이 커지고 탄착점이 조금 이동한다.

import * as THREE from 'three';
import { stemCenterAt, stemRadiusAt } from '../world/stemShape.js';
import { WEAPONS } from '../data/weapons.js';
import { AMMO } from '../data/ammo.js';
import { ATMOSPHERE } from '../data/atmosphere.js';
import { KEYS } from '../core/Input.js';
import { clamp, damp, lerp, smoothstep } from '../core/math.js';
import { rng } from '../core/Random.js';
import { Magazines } from './Magazines.js';
import { AimModel } from './AimModel.js';
import { pointSegDistance } from '../physics/intersect.js';
import {
  BallisticModel,
  solveZeroElevation,
  holdForRange,
  millerStability,
  aeroJumpMoaPerMph,
} from '../physics/ballistics.js';

const MOA = (Math.PI / (180 * 60));
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class WeaponSystem {
  constructor({ weaponId, player, world, bullets, events, settings, input, toast }) {
    this.data = WEAPONS[weaponId];
    this.ammo = AMMO[this.data.ammoId];
    this.player = player;
    this.world = world;
    this.bullets = bullets;
    this.events = events;
    this.settings = settings;
    this.input = input;
    this.toast = toast;
    this.aim = new AimModel(this.data, this.ammo, events);
    this.mags = new Magazines(this.data.magazineCapacity, this.data.magazinesCarried);
    this.ballistic = new BallisticModel({ dragModel: this.ammo.dragModel, bc: this.ammo.bc });
    const sg = millerStability({
      massGrains: this.ammo.massGrains,
      diameterIn: this.ammo.diameter / 0.0254,
      lengthIn: this.ammo.length / 0.0254,
      twistIn: this.data.twistInches,
      velocityFps: this.data.muzzleVelocity / 0.3048,
    });
    this.sg = sg;
    this.ajMoaPerMph = aeroJumpMoaPerMph(sg, this.ammo.length / this.ammo.diameter) * (this.data.rightHandTwist ? 1 : -1);

    this.sightKey = this.data.defaultSight;
    this.zero = settings.get('zero') || this.data.defaultZero;
    this.zeroEl = {};
    this._solveZeros();
    this._computeBDC();
    settings.onChange((k, v) => {
      if (k === 'zero') {
        this.zero = v;
        this._solveZeros();
      }
    });

    // 포즈 계산용 임시 객체
    this.qLook = new THREE.Quaternion();
    this.qAim = new THREE.Quaternion();
    this.qTmp = new THREE.Quaternion();
    this.qW = new THREE.Quaternion();
    this.posW = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.camQuat = new THREE.Quaternion();
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.v1 = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
    this.muzzleWorld = new THREE.Vector3();
    this.boreDir = new THREE.Vector3();
    this._q = [];
    this.reset();
  }

  reset() {
    this.mags.reset(this.data.magazinesCarried);
    this.chambered = true;
    this.boltLocked = false;
    this.fireMode = 'semi';
    this.action = null;
    this.ads = 0;
    this.adsWanted = false;
    this.lowered = 0;
    this.raiseBlock = 0;
    this.nextShot = 0;
    this.time = 0;
    this.obs = { pitch: 0, yaw: 0, retract: 0, tp: 0, ty: 0, tr: 0 };
    this.anim = { magOffset: null, magVisible: true, leftHandTo: null, leftHandBlend: 0, cant: 0, tilt: 0 };
    this.rPressAt = -1;
    this.shotsFired = 0;
    this.lastShotTime = -10;
    this.aperture = 0;
    this.rest = null; // {kind, name} — 거치 중이면
    this.barrelHeat = 0; // 주위 온도보다 높은 정도(°C)
    const a = rng.range(-0.6, 0.6) + Math.PI / 2; // 과열 탄착점 이동 방향(총마다, 대개 위쪽)
    this.heatShiftDir = [Math.cos(a), Math.sin(a)];
    this.lastJerk = 0;
  }

  get sight() {
    return this.data.sights[this.sightKey];
  }

  _geomFor(sight) {
    const eye = sight.eye;
    const muzzle = this.data.geometry.muzzle;
    return { sightHeight: sight.sightHeight, muzzleForward: eye[2] - muzzle[2] };
  }

  _solveZeros() {
    for (const k in this.data.sights) {
      const s = this.data.sights[k];
      const g = this._geomFor(s);
      this.zeroEl[k] = solveZeroElevation(this.ballistic, {
        muzzleVelocity: this.data.muzzleVelocity,
        sightHeight: g.sightHeight,
        muzzleForward: g.muzzleForward,
        zeroRange: this.zero,
      });
    }
  }

  /** BDC 눈금: 설계 영점(100 m)에서 이 게임의 실제 탄도로 계산(레티클에 새겨진 값) */
  _computeBDC() {
    const s = this.data.sights.optic4x;
    const g = this._geomFor(s);
    const el = solveZeroElevation(this.ballistic, {
      muzzleVelocity: this.data.muzzleVelocity,
      sightHeight: g.sightHeight,
      muzzleForward: g.muzzleForward,
      zeroRange: s.bdc.designZero,
    });
    this.bdc = s.bdc.ranges.map((range) => ({
      range,
      hold: holdForRange(this.ballistic, {
        muzzleVelocity: this.data.muzzleVelocity,
        sightHeight: g.sightHeight,
        muzzleForward: g.muzzleForward,
        zeroElevation: el,
        range,
      }),
      halfWidth: s.bdc.stadiaWidth / 2 / range,
    }));
  }

  // -------------------------------------------------------------------------
  /** V: 광학 → 철제(작은 구멍) → 철제(큰 구멍) → 광학 */
  switchSight() {
    const ap = this.data.sights.iron.apertures;
    if (this.sightKey === 'optic4x') {
      this.sightKey = 'iron';
      this.aperture = 0;
    } else if (this.aperture < ap.length - 1) this.aperture++;
    else {
      this.sightKey = 'optic4x';
      this.aperture = 0;
    }
    this.toast(this.sightKey === 'iron' ? `조준기: ${this.sight.name} · ${ap[this.aperture].name}` : `조준기: ${this.sight.name}`);
    this.events.emit('weapon:sight', { sight: this.sightKey, aperture: this.aperture });
  }

  get apertureDiameter() {
    return this.data.sights.iron.apertures[this.aperture].diameter;
  }

  /** 총열 과열에 따른 분산 배수 */
  get heatDispersionMul() {
    const B = this.data.barrel;
    return 1 + Math.min(B.dispersionMax, Math.max(0, this.barrelHeat - B.dispersionFrom) * B.dispersionPerDeg);
  }

  /** 현재 총+탄 분산(축별 표준편차, MOA) */
  get dispersionMoa() {
    return this.ammo.dispersionSigmaMoa * this.heatDispersionMul;
  }

  get barrelTemp() {
    return this.data.barrel.ambient + this.barrelHeat;
  }

  _startAction(type, kind, dur, events = []) {
    this.action = { type, kind, t: 0, dur, events: events.map((e) => ({ ...e, done: false })) };
    this.adsWanted = false;
    if (this.aim.hold.active) this.aim.setHoldBreath(false);
  }

  _reload(speed) {
    if (this.action) return;
    if (!this.mags.hasSpare) {
      this.toast('예비 탄창이 없다');
      this.events.emit('weapon:sound', { type: 'pouchEmpty' });
      return;
    }
    if (this.mags.inserted && this.mags.inserted.rounds === this.data.magazineCapacity && this.chambered) {
      this.toast('탄창이 가득 차 있다');
      return;
    }
    const R = this.data.reloads;
    const empty = this.boltLocked || !this.chambered;
    const kind = empty ? (speed ? 'emptySpeed' : 'emptyTactical') : speed ? 'speed' : 'tactical';
    let mul = 1;
    if (this.player.stance === 'prone') mul = R.proneMultiplier;
    else if (this.player.stance === 'crouch') mul = R.kneelMultiplier;
    const def = R[kind];
    this._startAction(
      'reload',
      kind,
      def.duration * mul,
      def.events.map((e) => ({ ...e, t: e.t * mul })),
    );
    this.events.emit('weapon:reloadStart', { kind, duration: def.duration * mul });
  }

  _onActionEvent(ev) {
    const a = this.action;
    switch (ev.type) {
      case 'magRelease':
        this.events.emit('weapon:sound', { type: 'magRelease' });
        break;
      case 'magOut': {
        const m = this.mags.remove(a.kind === 'tactical' ? 'stow' : 'dump');
        this.events.emit('weapon:sound', { type: 'magOut', rounds: m ? m.rounds : 0 });
        break;
      }
      case 'magDrop': {
        const m = this.mags.remove('drop');
        this.events.emit('weapon:sound', { type: 'magOut', rounds: m ? m.rounds : 0 });
        this.events.emit('weapon:magDrop', { position: this._worldPoint(this.data.geometry.magwell, this.v1).clone(), quat: this.qW.clone() });
        break;
      }
      case 'magStow':
        this.events.emit('weapon:sound', { type: 'pouch' });
        break;
      case 'magGrab':
        this.events.emit('weapon:sound', { type: 'pouchGrab' });
        break;
      case 'magIn':
        this.mags.insertNext();
        this.events.emit('weapon:sound', { type: 'magIn' });
        break;
      case 'magSeat':
        this.events.emit('weapon:sound', { type: 'magSeat' });
        break;
      case 'boltRelease':
        if (!this.chambered && this.mags.feed()) this.chambered = true;
        this.boltLocked = false;
        this.events.emit('weapon:sound', { type: 'boltRelease' });
        break;
      case 'checkPull':
        this.events.emit('weapon:sound', { type: 'magCheckOut' });
        break;
      case 'checkResult': {
        const r = this.mags.inserted ? this.mags.inserted.rounds : 0;
        this.toast(`탄창: ${this.mags.inserted ? Magazines.describe(r, this.data.magazineCapacity) : '없음'}`);
        break;
      }
      case 'checkIn':
        this.events.emit('weapon:sound', { type: 'magSeat' });
        break;
      case 'selector':
        this.fireMode = this.fireMode === 'semi' ? 'auto' : 'semi';
        this.events.emit('weapon:sound', { type: 'selector' });
        this.toast(`조정간: ${this.fireMode === 'semi' ? '단발' : '연발'}`);
        break;
      default:
        break;
    }
  }

  _worldPoint(local, out) {
    return out.set(local[0], local[1], local[2]).applyQuaternion(this.qW).add(this.posW);
  }

  // -------------------------------------------------------------------------
  /**
   * 입력·상태 갱신(포즈 계산 전에 호출)
   */
  update(dt, now) {
    this.time = now;
    const inp = this.input;
    const p = this.player;
    const H = this.data.handling;

    // 조준 입력
    const adsToggle = this.settings.get('adsToggle');
    if (adsToggle) {
      if (inp.mousePressed(2)) this.adsWanted = !this.adsWanted;
    } else {
      this.adsWanted = inp.mouseHeld(2);
    }
    const obstructed = Math.abs(this.obs.pitch) > 0.035 || Math.abs(this.obs.yaw) > 0.035 || this.obs.retract > 0.06;
    const canAds = !p.sprinting && !p.transition && !(this.action && this.action.type !== 'selector') && !obstructed && this.lowered < 0.3;
    const adsTarget = this.adsWanted && canAds ? 1 : 0;
    const adsRate = 1 / H.adsTime;
    this.ads = adsTarget > this.ads ? Math.min(1, this.ads + dt * adsRate) : Math.max(0, this.ads - dt * adsRate * 1.25);
    this.adsEased = smoothstep(0, 1, this.ads);

    // 숨 참기: 조준 중 Shift
    this.aim.setHoldBreath(this.ads > 0.6 && inp.held(KEYS.sprint));

    // 질주 시 총 내림
    const lowerTarget = p.sprinting || (p.transition && (p.transition.to === 'prone' || p.transition.from === 'prone')) ? 1 : 0;
    if (lowerTarget > this.lowered) this.lowered = Math.min(1, this.lowered + dt / 0.28);
    else if (this.lowered > 0) {
      this.lowered = Math.max(0, this.lowered - dt / H.sprintToReady);
      this.raiseBlock = 0.06;
    }
    if (this.raiseBlock > 0 && this.lowered <= 0) this.raiseBlock -= dt;

    // 행동 진행
    if (this.action) {
      const a = this.action;
      a.t += dt;
      for (const ev of a.events) {
        if (!ev.done && a.t >= ev.t) {
          ev.done = true;
          this._onActionEvent(ev);
        }
      }
      if (a.t >= a.dur) {
        this.action = null;
        this.events.emit('weapon:actionDone', { type: a.type, kind: a.kind });
      }
    }

    // 재장전 R: 짧게 = 전술, 길게 = 급속
    const R = this.data.reloads;
    if (inp.wasPressed(KEYS.reload)) this.rPressAt = now;
    if (this.rPressAt >= 0) {
      const held = now - this.rPressAt;
      if (inp.wasReleased(KEYS.reload) && held < R.longPressThreshold) {
        this.rPressAt = -1;
        if (!p.transition) this._reload(false);
      } else if (held >= R.longPressThreshold && inp.held(KEYS.reload)) {
        this.rPressAt = -1;
        if (!p.transition) this._reload(true);
      } else if (!inp.held(KEYS.reload)) this.rPressAt = -1;
    }
    if (inp.wasPressed(KEYS.magCheck) && !this.action && !p.transition) {
      if (!this.mags.inserted) this.toast('탄창이 꽂혀 있지 않다');
      else
        this._startAction('magcheck', 'check', H.magCheck, [
          { t: 0.4, type: 'checkPull' },
          { t: 0.95, type: 'checkResult' },
          { t: 1.38, type: 'checkIn' },
        ]);
    }
    if (inp.wasPressed(KEYS.fireMode) && !this.action) this._startAction('selector', 'sel', H.fireModeSwitch, [{ t: 0.08, type: 'selector' }]);
    if (inp.wasPressed(KEYS.switchSight) && !this.action) this.switchSight();

    // 사격
    const ready = !this.action && !p.transition && this.lowered <= 0.02 && this.raiseBlock <= 0;
    const pressed = inp.mousePressed(0);
    const held = inp.mouseHeld(0);
    if (ready && now >= this.nextShot) {
      if ((this.fireMode === 'semi' && pressed) || (this.fireMode === 'auto' && held)) this._pullTrigger(now, pressed);
    } else if (pressed && !this.action && !this.chambered) {
      // 노리쇠가 닫힌 빈 약실에서 방아쇠
    }

    // 총열 냉각
    this.barrelHeat *= Math.exp(-dt / this.data.barrel.coolTau);

    // 거치
    const rest = this._detectRest();
    if ((rest && rest.kind) !== (this.rest && this.rest.kind)) {
      this.rest = rest;
      if (rest && this.ads > 0.5) this.events.emit('weapon:rest', { kind: rest.kind });
    }

    // 반동·흔들림
    this.aim.update(dt, {
      stance: p.transition ? p.transition.to : p.stance,
      transition: !!p.transition,
      ads: this.ads,
      exertion: p.exertion,
      heartRate: p.heart,
      breathRate: p.breathRate,
      stamina: p.stamina,
      speed: p.speed,
      rest: this.rest && this.ads > 0.3 ? this.rest.kind : null,
    });
    const [ry, rp] = this.aim.consumeResidual();
    p.yaw += ry;
    p.pitch += rp;

    // 재장전 애니메이션 값
    this._animate(dt);
  }

  _pullTrigger(now, edge) {
    if (!this.chambered) {
      if (edge && !this.boltLocked) {
        this.events.emit('weapon:sound', { type: 'dryFire' });
        this.toast('철컥 — 약실이 비어 있다');
      }
      this.nextShot = now + 0.25;
      return;
    }
    this.nextShot = now + 60 / this.data.rateOfFire;
    this._fire();
    this.chambered = false;
    if (this.mags.feed()) this.chambered = true;
    else if (this.mags.inserted) this.boltLocked = true; // 마지막 탄 후 노리쇠 후퇴 고정
  }

  _fire() {
    const stance = this.player.stance;
    // 총구 위치·총열 방향(조준선 대비 영점 앙각)
    const muzzle = this._worldPoint(this.data.geometry.muzzle, this.muzzleWorld);
    const el = this.zeroEl[this.sightKey];
    // 산포(총+탄): 축별 정규분포, 총열이 달아오르면 커지고 탄착점이 한쪽으로 이동
    const B = this.data.barrel;
    const sigma = this.dispersionMoa * MOA;
    const shift = Math.max(0, this.barrelHeat - B.dispersionFrom) * B.shiftPerDeg * MOA;
    // 급한 격발(단발로 이전 발 직후 방아쇠를 서둘러 당김): 격발 순간 총이 흔들린다
    const T = this.data.sway.trigger;
    const haste = this.fireMode === 'semi' ? clamp(1 - (this.time - this.lastShotTime) / T.hasteWindow, 0, 1) : 0;
    const [jy, jp] = this.aim.triggerJerk(stance, haste, !!this.rest);
    this.lastJerk = haste;
    const dp = el + rng.gauss() * sigma + shift * this.heatShiftDir[1] + jp;
    const dy = rng.gauss() * sigma + shift * this.heatShiftDir[0] + jy;
    this.barrelHeat += B.heatPerShot;
    // 공력 도약: 총구에서의 횡풍 성분
    const wind = { x: 0, y: 0, z: 0 };
    this.world.wind.sample(muzzle.x, muzzle.y, muzzle.z, this.world.time || 0, wind);
    const right = this.v2.set(1, 0, 0).applyQuaternion(this.qW);
    const crossMph = (wind.x * right.x + wind.z * right.z) / 0.44704;
    const aj = this.ajMoaPerMph * crossMph * MOA;
    const dir = this.boreDir.set(Math.sin(dy) * Math.cos(dp + aj), Math.sin(dp + aj), -Math.cos(dp + aj) * Math.cos(dy)).normalize();
    dir.applyQuaternion(this.qW);
    const v0 = this.data.muzzleVelocity + rng.gauss() * this.ammo.muzzleVelocitySD;
    this.bullets.fire({
      origin: muzzle,
      dir,
      speed: v0,
      ammo: this.ammo,
      shooter: 'player',
      spinSg: this.sg,
      rightHandTwist: this.data.rightHandTwist,
    });
    this.aim.shot(stance);
    this.shotsFired++;
    this.lastShotTime = this.time;
    const ejectLocal = this.data.geometry.ejectionPort;
    this.events.emit('shot', {
      shooter: 'player',
      position: muzzle.clone(),
      direction: dir.clone(),
      weapon: this.data.id,
      stance,
      ejectPos: this._worldPoint(ejectLocal, new THREE.Vector3()),
      ejectDir: this.v1.set(...this.data.ejection.direction).applyQuaternion(this.qW).clone(),
      weaponQuat: this.qW.clone(),
      lastRound: !this.mags.inserted || this.mags.inserted.rounds === 0,
    });
  }

  /**
   * 거치 판정: 앞손 받침(총 좌표 supportHand) 바로 밑에 흙·통나무·뿌리판·짚 더미가 있거나(위에 얹힘),
   * 옆에 나무 줄기가 닿으면(기대기) 거치. 움직이거나 자세를 바꾸는 중에는 안 됨.
   */
  _detectRest() {
    const p = this.player;
    if (p.transition || p.speed > 0.35 || this.lowered > 0.1 || this.action) return null;
    const S = this._worldPoint(this.data.geometry.supportHand, this._restP || (this._restP = new THREE.Vector3()));
    const w = this.world;
    // 받침과 손 사이 허용 간격: 엎드려는 거의 닿아야 하고, 무릎·서서는 받침 높이에 맞춰 몸을 낮추거나 숙인다고 본다
    const reach = p.stance === 'prone' ? 0.09 : p.stance === 'crouch' ? 0.3 : 0.2;
    // 흙(둔덕 위·배수로 둑 턱): 엎드려 평지에서는 손 받침이 지면 위 약 0.17 m라 걸치지 않는다
    const clear = S.y - w.terrain.heightAt(S.x, S.z);
    if (clear > -0.03 && clear < reach) return { kind: 'ground', name: '흙' };
    const out = this._q;
    w.hash.query(S.x - 1.2, S.z - 1.2, S.x + 1.2, S.z + 1.2, out);
    for (const o of out) {
      if (o.kind === 'log' || o.kind === 'bale' || o.kind === 'rootPlate' || (o.kind === 'limb' && o.r >= 0.05)) {
        const r = pointSegDistance(S.x, S.y, S.z, o.ax, o.ay, o.az, o.bx - o.ax, o.by - o.ay, o.bz - o.az);
        const cy = o.ay + (o.by - o.ay) * r.t;
        const rad = o.kind === 'log' ? lerp(o.r, o.r2, r.t) : o.r;
        const d = r.d - rad;
        if (d > -0.03 && d < reach && S.y > cy) return { kind: o.kind, name: o.kind === 'bale' ? '짚 더미' : o.kind === 'rootPlate' ? '뿌리판' : '통나무' };
      } else if (o.kind === 'trunk') {
        const hb = S.y - o.y0;
        if (hb < 0.05 || hb > o.top - o.y0) continue;
        const c = stemCenterAt(o, hb, this._sc || (this._sc = { x: 0, z: 0 }));
        const d = Math.hypot(S.x - c.x, S.z - c.z) - stemRadiusAt(o, hb);
        if (d > -0.03 && d < 0.13) return { kind: 'trunk', name: '나무 줄기' };
      }
    }
    return null;
  }

  _animate(dt) {
    const a = this.action;
    const an = this.anim;
    let cant = 0;
    let tilt = 0;
    an.magOffset = null;
    an.magVisible = !!this.mags.inserted || (a && a.type === 'reload');
    an.leftHandTo = null;
    an.leftHandBlend = 0;
    if (a && a.type === 'reload') {
      const t = a.t;
      const D = a.dur;
      const env = smoothstep(0, 0.25, t) * smoothstep(D, D - 0.35, t);
      cant = 0.42 * env;
      tilt = 0.12 * env;
      const evT = (type) => (a.events.find((e) => e.type === type) || {}).t;
      const outT = evT('magOut') ?? evT('magDrop') ?? 0.3;
      const inT = evT('magIn') ?? D * 0.7;
      const magwell = new THREE.Vector3(0, -0.1, -0.39);
      if (t < outT) {
        an.leftHandTo = magwell;
        an.leftHandBlend = smoothstep(0.0, outT, t);
      } else if (t < inT) {
        const k = (t - outT) / (inT - outT);
        // 빠지는 탄창: 아래로 사라짐
        an.magOffset = new THREE.Vector3(0, -0.25 * smoothstep(0, 0.35, k) - 0.4 * smoothstep(0.35, 0.5, k), 0.02);
        if (k > 0.55) an.magOffset = new THREE.Vector3(0, -0.3 * (1 - smoothstep(0.55, 1, k)), 0.03 * (1 - k));
        an.magVisible = k < 0.4 || k > 0.55;
        an.leftHandTo = new THREE.Vector3(-0.05, -0.32 + 0.22 * smoothstep(0.55, 1, k), -0.25 - 0.14 * smoothstep(0.55, 1, k));
        an.leftHandBlend = 1;
      } else {
        const back = smoothstep(inT + 0.1, Math.min(D, inT + 0.55), t);
        const boltT = evT('boltRelease');
        if (boltT && t < boltT + 0.15) {
          an.leftHandTo = new THREE.Vector3(-0.025, -0.0, -0.33);
          an.leftHandBlend = smoothstep(inT, boltT - 0.05, t);
        } else {
          an.leftHandTo = magwell;
          an.leftHandBlend = 1 - back;
        }
      }
    } else if (a && a.type === 'magcheck') {
      const t = a.t;
      const env = smoothstep(0, 0.3, t) * smoothstep(a.dur, a.dur - 0.35, t);
      cant = 0.6 * env;
      tilt = 0.18 * env;
      const pull = smoothstep(0.3, 0.5, t) * (1 - smoothstep(1.25, 1.4, t));
      an.magOffset = new THREE.Vector3(0, -0.045 * pull, 0);
      an.leftHandTo = new THREE.Vector3(0, -0.12, -0.39);
      an.leftHandBlend = env;
    } else if (this.boltLocked) {
      tilt = 0;
    }
    an.cant = damp(an.cant, cant, 14, dt);
    an.tilt = damp(an.tilt, tilt, 14, dt);
  }

  // -------------------------------------------------------------------------
  /**
   * 무기·카메라 포즈 계산.
   * @param {THREE.Vector3} eye 머리(눈) 위치
   * @param {number} yaw 시선 방위
   * @param {number} pitch 시선 앙각
   * @param {number} roll 기울이기 롤
   */
  computePose(eye, yaw, pitch, roll, dt) {
    const G = this.data.geometry;
    const S = this.sight;
    const a = this.adsEased;
    const low = smoothstep(0, 1, this.lowered);
    this.euler.set(pitch, -yaw, roll, 'YXZ');
    this.qLook.setFromEuler(this.euler);

    // 흔들림·반동 오프셋(조준 시 그대로, 비조준 시는 AimModel이 이미 키움)
    this.euler.set(this.aim.pitch, -this.aim.yaw, 0, 'YXZ');
    this.qTmp.setFromEuler(this.euler);
    this.qAim.copy(this.qLook).multiply(this.qTmp);

    // 조준 자세: 조준기 눈 위치가 눈에 오도록
    const eyeW = this.v1.set(S.eye[0], S.eye[1], S.eye[2]);
    const posAds = this.v2.copy(eyeW).applyQuaternion(this.qAim).multiplyScalar(-1).add(eye);
    const qAds = this.qAim.clone();

    // 견착(비조준): 시선 아래 오른쪽, 총열이 약 25 m에서 시선과 만남
    const ro = G.readyOffset;
    const conv = G.readyConvergence;
    this.euler.set(Math.atan(-ro[1] / conv), Math.atan(ro[0] / conv), 0, 'YXZ');
    const qReady = this.qAim.clone().multiply(new THREE.Quaternion().setFromEuler(this.euler));
    const posReady = new THREE.Vector3(ro[0], ro[1], ro[2]).applyQuaternion(this.qLook).add(eye);

    // 질주: 총 내림
    const lr = G.loweredRotation;
    this.euler.set(lr[0], lr[1], lr[2], 'YXZ');
    const qLow = this.qLook.clone().multiply(new THREE.Quaternion().setFromEuler(this.euler));
    const lo = G.loweredOffset;
    const posLow = new THREE.Vector3(lo[0], lo[1], lo[2]).applyQuaternion(this.qLook).add(eye);

    this.qW.copy(qReady).slerp(qAds, a).slerp(qLow, low);
    this.posW.copy(posReady).lerp(posAds, a).lerp(posLow, low);

    // 총 길이 걸림(나무·통나무·지면)
    this._obstruction(dt);
    if (this.obs.retract !== 0 || this.obs.pitch !== 0 || this.obs.yaw !== 0) {
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(this.qW);
      this.posW.addScaledVector(fwd, -this.obs.retract);
      this.euler.set(this.obs.pitch, this.obs.yaw, 0, 'YXZ');
      this.qW.multiply(this.qTmp.setFromEuler(this.euler));
    }

    // 반동 시 모델 후퇴(시각)
    const kick = this.aim.modelKick;
    const back = this.v1.set(0, 0, 1).applyQuaternion(this.qW);
    this.posW.addScaledVector(back, -kick);

    // 카메라: 조준 시 조준기 시선, 아니면 머리 시선 + 흔들림
    const sightEye = new THREE.Vector3(S.eye[0], S.eye[1], S.eye[2]).applyQuaternion(this.qW).add(this.posW);
    // 반동으로 총이 뒤로 밀리면 볼(뺨)도 같이 밀린다
    this.camPos.copy(eye).lerp(sightEye, a);
    this.euler.set(this.aim.cameraShakePitch * (1 - a * 0.5), 0, this.aim.cameraShakeRoll, 'YXZ');
    const qShake = new THREE.Quaternion().setFromEuler(this.euler);
    this.camQuat.copy(this.qLook).slerp(this.qW, a).multiply(qShake);
    return { camPos: this.camPos, camQuat: this.camQuat, weaponPos: this.posW, weaponQuat: this.qW };
  }

  /** 총구~개머리판 선분이 나무·통나무·지면에 걸리는지 검사하고 밀어냄 */
  _obstruction(dt) {
    const L = this.data.geometry.length + 0.03;
    const o = this.obs;
    const test = (pitch, yaw, retract) => {
      const q = this.qTmp.copy(this.qW);
      this.euler.set(pitch, yaw, 0, 'YXZ');
      q.multiply(new THREE.Quaternion().setFromEuler(this.euler));
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const start = this.posW.clone().addScaledVector(fwd, -retract + 0.25);
      const len = L - 0.25;
      return this._segmentHit(start, fwd, len);
    };
    const hit = test(o.pitch, o.yaw, o.retract);
    if (hit) {
      const pen = hit.pen;
      // 먼저 뒤로 당기고(최대 13 cm), 남으면 장애물 반대쪽으로 비튼다
      o.tr = Math.min(0.13, o.retract + pen + 0.01);
      const rest = Math.max(0, o.retract + pen - 0.13);
      const ang = Math.min(1.1, rest / 0.55 + (rest > 0 ? 0.03 : 0));
      if (hit.kind === 'ground') {
        o.tp = Math.max(o.tp, o.pitch + ang);
      } else {
        o.ty = o.ty + (hit.side > 0 ? ang : -ang);
        o.tp = Math.max(o.tp, o.pitch + ang * 0.25);
      }
    } else {
      // 풀어도 걸리지 않으면 서서히 원위치
      const rp = o.pitch * 0.8;
      const ry = o.yaw * 0.8;
      const rr = o.retract * 0.8;
      if (!test(rp, ry, rr)) {
        o.tp = rp;
        o.ty = ry;
        o.tr = rr;
      }
    }
    o.tp = clamp(o.tp, 0, 1.2);
    o.ty = clamp(o.ty, -1.2, 1.2);
    const rateIn = 30;
    const rateOut = 8;
    o.retract = damp(o.retract, o.tr, o.tr > o.retract ? rateIn : rateOut, dt);
    o.pitch = damp(o.pitch, o.tp, Math.abs(o.tp) > Math.abs(o.pitch) ? rateIn : rateOut, dt);
    o.yaw = damp(o.yaw, o.ty, Math.abs(o.ty) > Math.abs(o.yaw) ? rateIn : rateOut, dt);
    if (Math.abs(o.pitch) < 1e-4) o.pitch = 0;
    if (Math.abs(o.yaw) < 1e-4) o.yaw = 0;
    if (o.retract < 1e-4) o.retract = 0;
  }

  /** start에서 dir로 len 만큼의 선분이 처음 걸리는 지점: {pen, kind, side} */
  _segmentHit(start, dir, len) {
    const out = this._q;
    const end = start.clone().addScaledVector(dir, len);
    const w = this.world;
    w.hash.query(Math.min(start.x, end.x) - 1, Math.min(start.z, end.z) - 1, Math.max(start.x, end.x) + 1, Math.max(start.z, end.z) + 1, out);
    let best = null;
    const right = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    for (const o of out) {
      if (o.kind === 'trunk') {
        // 선분 위 여러 점에서 줄기 축까지 수평 거리
        for (let k = 0; k <= 8; k++) {
          const s = k / 8;
          const px = start.x + dir.x * len * s;
          const py = start.y + dir.y * len * s;
          const pz = start.z + dir.z * len * s;
          if (py < o.y0 || py > o.top) continue;
          const hb = py - o.y0;
          const sc = stemCenterAt(o, hb, this._sc || (this._sc = { x: 0, z: 0 }));
          const tx = sc.x;
          const tz = sc.z;
          const r = stemRadiusAt(o, hb) + 0.012;
          const d = Math.hypot(px - tx, pz - tz);
          if (d < r) {
            const pen = (1 - s) * len + (r - d);
            if (!best || pen > best.pen) {
              const side = (tx - start.x) * right.x + (tz - start.z) * right.z;
              best = { pen, kind: 'trunk', side };
            }
            break;
          }
        }
      } else if (o.kind === 'log' || o.kind === 'bale' || o.kind === 'limb' || o.kind === 'rootPlate') {
        for (let k = 0; k <= 8; k++) {
          const s = k / 8;
          const p = start.clone().addScaledVector(dir, len * s);
          const ax = o.bx - o.ax;
          const ay = o.by - o.ay;
          const az = o.bz - o.az;
          const l2 = ax * ax + ay * ay + az * az;
          let t = ((p.x - o.ax) * ax + (p.y - o.ay) * ay + (p.z - o.az) * az) / l2;
          t = clamp(t, 0, 1);
          const cx = o.ax + ax * t;
          const cy = o.ay + ay * t;
          const cz = o.az + az * t;
          const r = (o.kind === 'log' ? lerp(o.r, o.r2, t) : o.r) + 0.012;
          const d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
          if (d < r) {
            const pen = (1 - s) * len + (r - d);
            if (!best || pen > best.pen) best = { pen, kind: p.y > cy ? 'ground' : 'trunk', side: (cx - start.x) * right.x + (cz - start.z) * right.z };
            break;
          }
        }
      }
    }
    // 지면
    for (let k = 2; k <= 10; k++) {
      const s = k / 10;
      const px = start.x + dir.x * len * s;
      const py = start.y + dir.y * len * s;
      const pz = start.z + dir.z * len * s;
      const gy = w.terrain.heightAt(px, pz) + 0.03;
      if (py < gy) {
        const pen = (1 - s) * len + (gy - py);
        if (!best || pen > best.pen) best = { pen, kind: 'ground', side: 0 };
        break;
      }
    }
    return best;
  }

  get magCount() {
    return this.mags.inserted ? this.mags.inserted.rounds : 0;
  }
}

export { ATMOSPHERE };
