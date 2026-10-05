// 플레이어: 자세(서기/앉아쏴/엎드려)와 전환 시간, 이동 속도(자세·지면·덤불), 스태미나, 심박, 호흡,
// 기울이기, 나무 줄기·통나무 충돌. 무기 조작은 weapon/WeaponSystem.js.
// 2단계에서 피격(PlayerHealth)이 붙을 자리: this.health (현재 비어 있음).

import { MOVEMENT } from '../data/movement.js';
import { SURFACES, SHRUB_SPEED_FACTOR } from '../data/surfaces.js';
import { KEYS } from '../core/Input.js';
import { clamp, damp, smoothstep, lerp } from '../core/math.js';
import { stemCenterAt, stemRadiusAt } from '../world/stemShape.js';

const SURF_ORDER = ['stubble', 'plowed', 'fallow', 'forest', 'grass', 'road', 'sunflower'];

export class Player {
  constructor(world, input, settings, events) {
    this.world = world;
    this.input = input;
    this.settings = settings;
    this.events = events;
    this.health = null; // 2단계: 피격 모델
    this.reset();
  }

  reset() {
    const ps = this.world.data.playerStart;
    this.x = ps.x;
    this.z = ps.z;
    this.y = this.world.terrain.heightAt(this.x, this.z);
    this.yaw = ps.yaw || 0;
    this.pitch = 0.0;
    this.vx = 0;
    this.vz = 0;
    this.stance = 'stand';
    this.transition = null; // {from, to, t, dur}
    this.eyeH = MOVEMENT.eyeHeight.stand;
    this.lean = 0;
    this.leanTarget = 0;
    this.walkMode = false;
    this.sprinting = false;
    this.stamina = 1;
    this.heart = MOVEMENT.heart.rest;
    this.exertion = 0;
    this.breathPhase = 0;
    this.breathRate = 1 / MOVEMENT.breathing.restPeriod;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.speed = 0;
    this.moveIntent = 0;
    this.surface = 'stubble';
    this.inShrub = 0;
    this.lastStep = 0;
    this.stepSide = 1;
    this.forestCover = 0;
    this.adsBlocksSprint = false;
    this._q = [];
  }

  get canAct() {
    return !this.transition;
  }

  /** 시선 원점(눈) 월드 좌표 */
  eye(out) {
    const lp = MOVEMENT.lean[this.stance] || MOVEMENT.lean.stand;
    const off = this.lean * lp.offset;
    const rx = Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    out.x = this.x + rx * off;
    out.z = this.z + rz * off;
    const bob = Math.sin(this.bobPhase * 2) * this.bobAmp;
    out.y = this.y + this.eyeH + bob - Math.abs(this.lean) * lp.offset * 0.18;
    return out;
  }

  get roll() {
    const lp = MOVEMENT.lean[this.stance] || MOVEMENT.lean.stand;
    return -this.lean * lp.roll;
  }

  setStance(target) {
    if (this.transition || target === this.stance) return;
    if (this.health && this.health.forcedProne && target !== 'prone') {
      this.events.emit('player:cannotStand', {});
      return;
    }
    if (this.health && !this.health.alive) return;
    const key = `${this.stance}>${target}`;
    const dur = MOVEMENT.stanceTimes[key];
    if (!dur) return;
    this.transition = { from: this.stance, to: target, t: 0, dur };
    this.sprinting = false;
    this.events.emit('player:stance', { from: this.stance, to: target, dur });
  }

  /**
   * @param {number} dt
   * @param {object} ctx {ads: 0~1, weaponBusy, lookDX, lookDY, zoom}
   */
  update(dt, ctx) {
    const inp = this.input;
    // ---- 시선 ----
    const sens = 0.0021 * this.settings.get('sensitivity') / Math.max(1, ctx.zoom);
    let dYaw = ctx.lookDX * sens;
    let dPitch = -ctx.lookDY * sens;
    if (this.stance === 'prone' || this.transition?.to === 'prone') {
      const maxTurn = MOVEMENT.proneTurnRate * dt;
      dYaw = clamp(dYaw, -maxTurn, maxTurn);
    }
    this.yaw += dYaw;
    const lim = MOVEMENT.pitchLimits[this.transition ? this.transition.to : this.stance];
    this.pitch = clamp(this.pitch + dPitch, lim[0], lim[1]);

    // ---- 자세 ----
    if (inp.wasPressed(KEYS.crouch)) {
      if (this.stance === 'stand') this.setStance('crouch');
      else if (this.stance === 'crouch') this.setStance('stand');
      else if (this.stance === 'prone') this.setStance('crouch');
    }
    if (inp.wasPressed(KEYS.prone)) {
      if (this.stance === 'prone') this.setStance('stand');
      else this.setStance('prone');
    }
    if (inp.wasPressed('CapsLock')) this.walkMode = !this.walkMode;
    if (this.transition) {
      const tr = this.transition;
      tr.t += dt;
      const k = clamp(tr.t / tr.dur, 0, 1);
      const h0 = MOVEMENT.eyeHeight[tr.from];
      const h1 = MOVEMENT.eyeHeight[tr.to];
      // 엎드릴 때는 무릎을 꿇었다가 앞으로 눕는다(초반 빠르게, 끝에 툭)
      const e = tr.to === 'prone' ? 1 - Math.pow(1 - k, 1.6) : k * k * (3 - 2 * k);
      this.eyeH = lerp(h0, h1, e);
      if (k >= 1) {
        this.stance = tr.to;
        this.transition = null;
        this.eyeH = h1;
        this.events.emit('player:stanceDone', { stance: this.stance });
      }
    }

    // ---- 기울이기 ----
    this.leanTarget = (inp.held(KEYS.leanRight) ? 1 : 0) - (inp.held(KEYS.leanLeft) ? 1 : 0);
    if (this.transition) this.leanTarget = 0;
    if (this.leanTarget !== 0 && this._leanBlocked(this.leanTarget)) this.leanTarget *= 0.35;
    this.lean = damp(this.lean, this.leanTarget, 1 / (MOVEMENT.lean.time * 0.45), dt);

    // ---- 이동 ----
    let fx = 0;
    let fz = 0;
    if (inp.held(KEYS.forward)) fz -= 1;
    if (inp.held(KEYS.back)) fz += 1;
    if (inp.held(KEYS.left)) fx -= 1;
    if (inp.held(KEYS.right)) fx += 1;
    let moving = fx !== 0 || fz !== 0;
    // 지혈대를 감는 중·쓰러짐: 움직이지 못함
    if (this.health && (this.health.tq || !this.health.alive)) {
      moving = false;
      fx = fz = 0;
    }
    const len = Math.hypot(fx, fz) || 1;
    fx /= len;
    fz /= len;

    // 지면·덤불
    const sw = this.world.terrain.surfaceWeights(this.x, this.z);
    let sf = 0;
    let best = 0;
    for (let k = 0; k < SURF_ORDER.length; k++) {
      sf += sw[k] * SURFACES[SURF_ORDER[k]].speed;
      if (sw[k] > sw[best]) best = k;
    }
    this.surface = SURF_ORDER[best];
    this.inShrub = this._shrubDensity();
    this.forestCover = this.world.belts.canopyAt(this.x, this.z);
    const shrubF = lerp(1, SHRUB_SPEED_FACTOR, this.inShrub);

    // 질주 조건
    const wantSprint = inp.held(KEYS.sprint) && fz < 0 && !ctx.adsHeld && this.stance === 'stand' && !this.transition;
    const S = MOVEMENT.stamina;
    if (wantSprint && moving && this.stamina > (this.sprinting ? 0.0 : S.minToSprint)) this.sprinting = true;
    if (!wantSprint || !moving || this.stamina <= 0) this.sprinting = false;

    let base;
    if (this.stance === 'prone') base = MOVEMENT.speeds.prone * (this.health && this.health.forcedProne ? 0.6 : 1);
    else if (this.stance === 'crouch') base = MOVEMENT.speeds.crouch;
    else if (this.sprinting) base = MOVEMENT.speeds.sprint;
    else if (this.walkMode || ctx.ads > 0.3) base = MOVEMENT.speeds.walk;
    else base = MOVEMENT.speeds.run;
    if (ctx.ads > 0.3 && this.stance === 'crouch') base *= 0.8;
    if (this.transition) base *= this.transition.to === 'prone' || this.transition.from === 'prone' ? 0 : 0.4;
    const dirF = fz > 0 ? MOVEMENT.backwardFactor : 1;
    const strafeF = fz === 0 && fx !== 0 ? MOVEMENT.strafeFactor : 1;
    const target = moving ? base * sf * shrubF * dirF * strafeF : 0;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    // 로컬(fx 오른쪽, fz 뒤) → 월드
    const wx = fx * c - fz * s;
    const wz = fx * s + fz * c;
    const tvx = wx * target;
    const tvz = wz * target;
    const acc = this.stance === 'prone' ? 4 : MOVEMENT.accel;
    this.vx = damp(this.vx, tvx, acc, dt);
    this.vz = damp(this.vz, tvz, acc, dt);
    const nx = this.x + this.vx * dt;
    const nz = this.z + this.vz * dt;
    const res = this._collide(nx, nz);
    const ox = this.x;
    const oz = this.z;
    this.x = res[0];
    this.z = res[1];
    const half = this.world.data.playHalf + 60;
    this.x = clamp(this.x, -half, half);
    this.z = clamp(this.z, -half, half);
    this.y = this.world.terrain.heightAt(this.x, this.z);
    this.speed = Math.hypot(this.x - ox, this.z - oz) / Math.max(dt, 1e-4);
    this.moveIntent = moving ? 1 : 0;

    // ---- 스태미나·심박·호흡 ----
    const surfCost = SURFACES[this.surface].staminaCost || 1;
    if (this.sprinting) this.stamina -= (dt / S.sprintSeconds) * surfCost;
    else this.stamina += dt * (this.speed < 0.2 ? S.regenStillPerSec : S.regenPerSec);
    this.stamina = clamp(this.stamina, 0, 1);
    const H = MOVEMENT.heart;
    let rise = 0;
    let ceiling = H.rest + 8;
    if (this.sprinting) {
      rise = H.sprintRise * surfCost;
      ceiling = H.max;
    } else if (this.speed > 2.5) {
      rise = H.runRise * surfCost;
      ceiling = 128;
    } else if (this.stance === 'prone' && this.speed > 0.1) {
      rise = H.crawlRise;
      ceiling = 118;
    } else if (this.speed > 0.6) {
      rise = 0.4;
      ceiling = 96;
    }
    if (this.heart < ceiling && rise > 0) this.heart = Math.min(ceiling, this.heart + rise * dt);
    else this.heart += (H.rest - this.heart) * (1 - Math.exp(-dt / H.tau)) * (this.heart > ceiling || rise === 0 ? 1 : 0);
    this.exertion = clamp((this.heart - H.rest) / (H.max - H.rest), 0, 1);
    const B = MOVEMENT.breathing;
    const period = lerp(B.restPeriod, B.minPeriod, Math.pow(this.exertion, 0.8));
    this.breathRate = 1 / period;

    // ---- 머리 흔들림·발소리 ----
    let cadence = 0;
    let bob = 0;
    const sp = this.speed;
    if (sp > 0.15) {
      if (this.stance === 'prone') {
        cadence = 0.9;
        bob = 0.012;
      } else if (this.sprinting) {
        cadence = 3.1;
        bob = MOVEMENT.headBob.sprint;
      } else if (sp > 2.2) {
        cadence = 2.6;
        bob = MOVEMENT.headBob.run;
      } else {
        cadence = this.stance === 'crouch' ? 1.5 : 1.85;
        bob = MOVEMENT.headBob.walk;
      }
    }
    this.bobAmp = damp(this.bobAmp, bob * (1 - ctx.ads * 0.6), 6, dt);
    if (cadence > 0) {
      const prev = this.bobPhase;
      this.bobPhase += dt * cadence * Math.PI;
      if (Math.floor(prev / Math.PI) !== Math.floor(this.bobPhase / Math.PI)) {
        this.stepSide = -this.stepSide;
        this.events.emit('player:step', {
          surface: this.surface,
          shrub: this.inShrub,
          speed: sp,
          stance: this.stance,
          sprint: this.sprinting,
          x: this.x,
          z: this.z,
          side: this.stepSide,
        });
      }
    }
  }

  _shrubDensity() {
    const out = this._q;
    this.world.hash.query(this.x - 0.5, this.z - 0.5, this.x + 0.5, this.z + 0.5, out);
    let d = 0;
    for (const o of out) {
      if (o.kind !== 'foliage' || o.material !== 'shrub') continue;
      const dx = (this.x - o.cx) / o.rx;
      const dz = (this.z - o.cz) / o.rz;
      const q = dx * dx + dz * dz;
      if (q < 1) d = Math.max(d, 1 - q);
    }
    return smoothstep(0, 0.6, d);
  }

  _leanBlocked(dir) {
    const lp = MOVEMENT.lean[this.stance] || MOVEMENT.lean.stand;
    const px = this.x + Math.cos(this.yaw) * lp.offset * dir;
    const pz = this.z + Math.sin(this.yaw) * lp.offset * dir;
    const r = this._collide(px, pz, 0.12);
    return Math.hypot(r[0] - px, r[1] - pz) > 0.02;
  }

  /** 원(반지름 r)으로 줄기·그루터기·통나무 밀어내기 */
  _collide(nx, nz, radius = MOVEMENT.capsuleRadius) {
    const out = this._q;
    const feet = this.world.terrain.heightAt(nx, nz);
    for (let iter = 0; iter < 3; iter++) {
      this.world.hash.query(nx - 1.5, nz - 1.5, nx + 1.5, nz + 1.5, out);
      let moved = false;
      for (const o of out) {
        if (o.kind === 'trunk') {
          // 몸통 높이(발 위 0.5~1 m)의 줄기 중심·반지름(휨·뿌리 퍼짐 포함, 화면 모양과 같은 식)
          if (o.top < feet + 0.3) continue;
          const hb = Math.min(o.top - o.y0, feet + (this.stance === 'prone' ? 0.25 : 0.8) - o.y0);
          const c = stemCenterAt(o, hb, this._sc || (this._sc = { x: 0, z: 0 }));
          const tx = c.x;
          const tz = c.z;
          const rr = stemRadiusAt(o, hb) + radius;
          const dx = nx - tx;
          const dz = nz - tz;
          const d2 = dx * dx + dz * dz;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 1e-4;
            nx = tx + (dx / d) * rr;
            nz = tz + (dz / d) * rr;
            moved = true;
          }
        } else if (o.kind === 'bale' || o.kind === 'rootPlate') {
          // 원형 짚 더미·뿌리판: 바닥 투영은 축 방향 폭 × 지름 직사각형
          const ux = Math.cos(o.ang);
          const uz = Math.sin(o.ang);
          const dx = nx - o.x;
          const dz = nz - o.z;
          let a = dx * ux + dz * uz;
          let bb = -dx * uz + dz * ux;
          const ha = o.w * 0.5;
          const hb = o.r;
          const ea = a - clamp(a, -ha, ha);
          const eb = bb - clamp(bb, -hb, hb);
          const d = Math.hypot(ea, eb);
          if (d < radius) {
            if (d > 1e-4) {
              const k = (radius - d) / d;
              a += ea * k;
              bb += eb * k;
            } else {
              const pa = ha - Math.abs(a);
              const pb = hb - Math.abs(bb);
              if (pa < pb) a = Math.sign(a || 1) * (ha + radius);
              else bb = Math.sign(bb || 1) * (hb + radius);
            }
            nx = o.x + a * ux - bb * uz;
            nz = o.z + a * uz + bb * ux;
            moved = true;
          }
        } else if (o.kind === 'log') {
          // 발보다 충분히 높으면 막힘(낮은 통나무는 넘어감)
          const lx = o.bx - o.ax;
          const lz = o.bz - o.az;
          const l2 = lx * lx + lz * lz;
          let t = ((nx - o.ax) * lx + (nz - o.az) * lz) / l2;
          t = clamp(t, 0, 1);
          const top = lerp(o.ay, o.by, t) + lerp(o.r, o.r2, t);
          if (top - feet < 0.5 && this.stance !== 'prone') continue;
          const px = o.ax + lx * t;
          const pz = o.az + lz * t;
          const rr = lerp(o.r, o.r2, t) + radius;
          const dx = nx - px;
          const dz = nz - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 1e-4;
            nx = px + (dx / d) * rr;
            nz = pz + (dz / d) * rr;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return [nx, nz];
  }
}
