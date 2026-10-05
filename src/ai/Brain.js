// 적 병사 한 명의 판단(2단계). 아는 것은 인지 시스템을 거친 자기 지식(knowledge)과 부대에서 전해 들은 것뿐이다
// (플레이어의 실제 좌표를 읽지 않는다).
//
// 평시: 숲 가장자리 경계(맡은 방향 ±50° 훑어보기)·숲 안 순찰·휴식(덜 살핌).
// 의심: 멈춰서 낮은 자세로 그쪽을 집중해서 본다. 아무것도 없으면 다시 평시.
// 접촉(근탄 '딱'·근처 탄착·동료 피격·총성 확인): 0.3~0.8 s(숙련도) 뒤 엎드리거나 가장 가까운 진짜 엄폐물
//   (굵은 줄기·통나무·둔덕·배수로·짚 더미·뿌리판 — 위협 방위를 막아 주는 자리)로 → 방향 추정 → 반격.
// 엄폐 사격: 숨어 있다가(제압당하면 오래) 몸을 조금만 내밀고(줄기 옆 반걸음·낮은 엄폐 위로 무릎) 조준 시간 뒤 쏘고 숨는다.
//   다시 쏠 때는 가끔 몇 m 옆 다른 엄폐로 옮긴다.
//   보이면 조준 단발(가까우면 짧은 점사), 안 보이지만 위치를 알면 그 언저리로 제압 점사(2~5발, 간격을 두고).
// 이동(측면 기동·접근·철수): A* 길(지형·식생 + 아는 위협에서 보이는 곳은 비쌈)을 따라. 노출 구간은 3~5 s 약진 후 엎드림,
//   짝끼리 번갈아(한 짝이 움직이는 동안 다른 짝은 엄호).
// 부상자: 위험이 낮을 때(그 자리가 위협에서 가려져 있고 내가 제압당하지 않음) 끌어서 엄폐물 뒤로.
// 팔·다리 부상자는 엎드린 채 제한적으로(흔들림 2~3배) 계속 쏜다.

import { clamp, lerp, wrapAngle } from '../core/math.js';
import { rng } from '../core/Random.js';

const DEG = Math.PI / 180;

export const BEHAVIOR = {
  reaction: [0.3, 0.8], // 근탄을 듣고 몸을 움직이기 시작할 때까지(숙련도 배율)
  postObserve: [10, 25],
  hideTime: [2.5, 6], // 숨었다가 다시 내다보기까지
  exposeTime: [2.5, 5.5], // 내다보고 쏘는 시간
  relocateChance: 0.3,
  coverSearch: 14, // 엄폐물 찾는 반경(m)
  rush: [3, 5],
  rushPause: [2, 5],
  spacing: 4.5,
  suppressBurst: [2, 5],
  suppressGap: { slow: [6, 12], normal: [3.5, 7], rapid: [1.8, 3.5] },
  maxRange: 450, // 이보다 멀면 거의 쏘지 않음(조준 사격 유효 거리)
  suppressMaxErr: 70, // 이보다 오차가 크면 제압 사격도 안 함(탄 낭비)
  ammoReserve: 2, // 예비 탄창이 이만큼 남으면 제압 사격을 아낀다
};

export class Brain {
  constructor(enemy, ctx) {
    this.e = enemy;
    this.ctx = ctx; // {world, cover, nav, events, sight, time(), others()}
    this.reset();
  }

  reset() {
    const d = this.e.def;
    this.task = { type: 'peace', role: d.role };
    this.mode = 'peace';
    this.time = 0;
    this.cover = null;
    this.coverHidden = null; // 숨는 자리 [x,z]
    this.peek = null;
    this.path = null;
    this.pathIdx = 0;
    this.pathReq = null;
    this.pathDest = null;
    this.rush = null;
    this.reactAt = -1;
    this.reactInfo = null;
    this.lookTimer = 0;
    this.lookYawT = 0;
    this.postUntil = rng.range(BEHAVIOR.postObserve[0], BEHAVIOR.postObserve[1]);
    this.alertSince = -1;
    this.nextSuppress = 0;
    this.lastHit = -100;
    this.aid = null;
    this.dragging = null;
    this.wp = 0;
    this.wait = 0;
    this.supT = null;
    this.departAt = 0;
    this.status = '평시';
  }

  // ---------------------------------------------------------------------------
  // 바깥에서 오는 일
  setTask(t) {
    const cur = this.task;
    if (cur.type === 'withdrawn') return;
    if (cur.type === 'aid' && t.type !== 'move') return; // 부상자 구조 중에는 계속
    if (cur.type === t.type && cur.type === 'move' && cur.dest && t.dest && Math.hypot(cur.dest[0] - t.dest[0], cur.dest[1] - t.dest[1]) < 5) {
      cur.mode = t.mode;
      return;
    }
    if (cur.type === t.type && cur.type !== 'move') {
      Object.assign(cur, t);
      return;
    }
    this.task = { ...t };
    this.supT = null;
    if (t.type === 'move') {
      this.path = null;
      this.pathDest = null;
      this.departAt = 0;
      this._releaseCover();
    }
  }

  onPhase(p) {
    if (p === 'contact' && this.task.type === 'peace') this.task = { type: 'hold' };
    if (p === 'alert' && this.task.type === 'peace') this.task = { type: 'alert' };
    if (p === 'peace' && (this.task.type === 'alert' || this.task.type === 'hold')) this.task = { type: 'peace', role: this.e.def.role };
  }

  onShared() {
    if (this.task.type === 'peace') this.task = { type: 'alert' };
  }

  /** 인지 시스템 알림 */
  onObservation(kind) {
    const e = this.e;
    if (kind === 'sight') {
      e.unit?.shout(e, 'contact');
      if (this.task.type === 'peace' || this.task.type === 'alert') this._startReaction({ type: 'seen' }, 0.6);
    } else if (kind === 'bang' || kind === 'flash') {
      e.unit?.onUnderFire();
      if (this.task.type === 'peace' || this.task.type === 'alert') this.task = { type: 'hold' };
      // 어디서 쏘는지 짐작이 서면 외친다("정면 300, 숲띠 가장자리!")
      if (kind === 'flash' || e.knowledge.err < 150) e.unit?.shout(e, 'contact');
    } else if (kind === 'glimpse' || kind === 'step' || kind === 'handling') {
      if (this.task.type === 'peace') this.task = { type: 'alert' };
      if (kind === 'glimpse' && rng.next() < 0.5) e.unit?.shout(e, 'suspicious');
    } else if (kind === 'allyShot') {
      if (this.task.type === 'peace') this.task = { type: 'alert' };
    }
  }

  /** 근탄·근처 탄착·동료 피격 */
  onSuppress(info) {
    const e = this.e;
    e.unit?.onUnderFire();
    if (info.dir) {
      // 탄이 날아온 방향: 탄 경로를 거슬러 올라간 쪽(정확한 사수 위치는 모른다)
      this.fireDir = { x: -info.dir.x, z: -info.dir.z, t: this.time };
    }
    if (!this.reactInfo || this.time > this.reactAt + 2) this._startReaction(info, 1);
  }

  _startReaction(info, mul) {
    const sk = this.e.skill;
    this.reactAt = this.time + rng.range(BEHAVIOR.reaction[0], BEHAVIOR.reaction[1]) * sk.reaction * mul * (this.task.role === 'rest' ? 1.5 : 1);
    this.reactInfo = info;
  }

  onWounded(kind) {
    this.reactInfo = null;
    this.lastHit = this.time;
    if (kind === 'arm' || kind === 'lung') {
      // 몸을 숨기러
      this.task = { type: 'hold' };
      this.cover = null;
    }
  }

  onCrawlStart() {
    const e = this.e;
    const th = this._threatPoint();
    const c = this.ctx.cover.find({ x: e.x, z: e.z, r: 15, threat: th, self: e, spacing: 0 });
    if (c) e.setMove([c.x, c.z], 0);
  }

  // ---------------------------------------------------------------------------
  /** 내가 생각하는 위협 위치(지식 > 탄이 온 방향 > 없음) */
  _threatPoint() {
    const K = this.e.knowledge;
    if (K.has && K.threat) return { x: K.x, z: K.z };
    if (this.fireDir && this.time - this.fireDir.t < 60) return { x: this.e.x + this.fireDir.x * 200, z: this.e.z + this.fireDir.z * 200 };
    if (K.has) return { x: K.x, z: K.z };
    const u = this.e.unit?.picture();
    if (u) return { x: u.x, z: u.z };
    return null;
  }

  update(dt) {
    this.time += dt;
    const e = this.e;
    if (e.state === 'dead') return;
    if (e.state !== 'normal') {
      this._wounded(dt);
      return;
    }
    if (this.task.type === 'withdrawn') {
      this._withdrawn(dt);
      this._weapon(dt, null);
      return;
    }
    // 반응(엎드림·엄폐)
    if (this.reactInfo && this.time >= this.reactAt) {
      const info = this.reactInfo;
      this.reactInfo = null;
      if (this.task.type === 'peace' || this.task.type === 'alert') this.task = { type: 'hold' };
      this._takeCover(info.type === 'seen' ? 0.4 : 1);
    }
    let fire = null;
    switch (this.task.type) {
      case 'peace':
        this._peace(dt);
        break;
      case 'alert':
        this._alert(dt);
        break;
      case 'hold':
        fire = this._fight(dt, false);
        break;
      case 'suppress':
        fire = this._fight(dt, true);
        break;
      case 'move':
        fire = this._move(dt);
        break;
      case 'aid':
        this._aid(dt);
        break;
      default:
        break;
    }
    this._weapon(dt, fire);
  }

  // ---------------------------------------------------------------------------
  // 평시
  _peace(dt) {
    const e = this.e;
    const d = e.def;
    this.status = d.role === 'guard' ? '경계' : d.role === 'patrol' ? '순찰' : '휴식';
    if (d.role === 'patrol' && d.route) {
      if (!e.moveTarget) {
        if (this.wait > 0) {
          this.wait -= dt;
          e.setStance('kneel');
        } else {
          const p = d.route[this.wp % d.route.length];
          this.wp++;
          e.setStance('stand');
          e.setMove([p[0] + rng.range(-1, 1), p[1] + rng.range(-1, 1)], d.speed || 1.1);
          this.wait = rng.next() < 0.5 ? rng.range(3, 8) : 0;
        }
      }
      this._scan(dt, e.heading, 35 * DEG, 0.35);
      return;
    }
    if (d.role === 'rest') {
      e.setStance('kneel');
      this._scan(dt, d.look || e.heading, 70 * DEG, 0.6, -0.25);
      return;
    }
    // 경계: 자리에서 맡은 방향을 훑는다(자세는 시작 때 정한 것: 가장자리 풀 너머가 보이는 높이)
    if (!e.moveTarget && Math.hypot(e.x - d.pos[0], e.z - d.pos[1]) > 1.2) {
      e.setStance('crouchMove');
      e.setMove([d.pos[0], d.pos[1]], 1.2);
    } else if (!e.moveTarget) e.setStance(d.stance || 'kneel');
    this._scan(dt, d.look, 50 * DEG, 0.45);
  }

  /** 시선: 기준 방위 ± 반폭을 1~3 s마다 옮겨 보며 훑기 */
  _scan(dt, center, half, rate, pitch = 0) {
    const e = this.e;
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rng.range(1.0, 3.0);
      this.lookYawT = center + rng.range(-half, half);
    }
    this._lookToward(this.lookYawT, dt, rate, pitch);
  }

  /** 방위 b(rad)를 보도록 머리(필요하면 몸)를 돌림 */
  _lookToward(b, dt, rate = 2, pitch = 0) {
    const e = this.e;
    const rel = wrapAngle(b - e.heading);
    if (!e.moveTarget && Math.abs(rel) > 0.85) e.heading += clamp(rel, -1.6 * dt, 1.6 * dt);
    const want = clamp(-wrapAngle(b - e.heading), -1.0, 1.0);
    e.lookYaw += (want - e.lookYaw) * (1 - Math.exp(-dt * 4 * rate));
    e.lookPitch += (pitch - e.lookPitch) * (1 - Math.exp(-dt * 3));
  }

  _lookAt(x, z, dt, rate = 2) {
    const e = this.e;
    this._lookToward(Math.atan2(x - e.x, -(z - e.z)), dt, rate);
  }

  // ---------------------------------------------------------------------------
  // 의심: 멈춰서 낮은 자세로 집중해서 본다
  _alert(dt) {
    const e = this.e;
    this.status = '의심';
    if (this.alertSince < 0) this.alertSince = this.time;
    if (e.moveTarget && !this.cover) e.setMove(null, 0);
    if (e.stance === 'stand' && (e.def.stance || 'kneel') !== 'stand') e.setStance('kneel');
    const K = e.knowledge;
    if (K.has) {
      // 오차 범위 안을 천천히 훑으며
      const b = Math.atan2(K.x - e.x, -(K.z - e.z));
      const spread = clamp(Math.atan2(K.err, Math.hypot(K.x - e.x, K.z - e.z)), 3 * DEG, 25 * DEG);
      this._scan(dt, b, spread, 1.2);
    } else this._scan(dt, e.def.look ?? e.heading, 40 * DEG, 0.8);
    if (this.time - this.alertSince > 50 && K.suspicion < 0.2) {
      this.task = { type: 'peace', role: e.def.role };
      this.alertSince = -1;
    }
  }

  // ---------------------------------------------------------------------------
  // 엄폐
  _releaseCover() {
    if (this.cover) this.ctx.cover.release(this.cover, this.e);
    this.cover = null;
    this.peek = null;
  }

  /** 위협을 막는 가장 가까운 엄폐로(없으면 그 자리에 엎드림). urgency 1 = 탄이 날아옴 */
  _takeCover(urgency) {
    const e = this.e;
    const th = this._threatPoint();
    const taken = this.ctx.others(e);
    const c = th ? this.ctx.cover.find({ x: e.x, z: e.z, r: BEHAVIOR.coverSearch, threat: th, self: e, taken, spacing: BEHAVIOR.spacing }) : null;
    this._releaseCover();
    if (c && this.ctx.cover.reserve(c, e)) {
      this.cover = c;
      const d = Math.hypot(c.x - e.x, c.z - e.z);
      if (d > 0.5) {
        e.setStance(urgency > 0.7 && d < 3 ? 'prone' : 'crouchMove');
        e.setMove([c.x, c.z], urgency > 0.7 ? rng.range(3.8, 4.8) : 2.4);
      }
      this.peek = { phase: 'go', until: this.time + rng.range(BEHAVIOR.hideTime[0], BEHAVIOR.hideTime[1]) };
    } else {
      e.setMove(null, 0);
      e.setStance('prone');
      this.peek = { phase: 'hidden', until: this.time + rng.range(BEHAVIOR.hideTime[0], BEHAVIOR.hideTime[1]) * 1.5, open: true };
    }
  }

  /** 엄폐가 지금 위협을 막아 주는가 */
  _coverGood() {
    const th = this._threatPoint();
    if (!this.cover) return false;
    if (!th) return true;
    return this.ctx.cover.protects(this.cover, th.x, th.z);
  }

  /** 숨는 자세: 낮은 엄폐는 엎드림, 줄기·짚 더미 뒤는 무릎 */
  _hideStance() {
    const c = this.cover;
    if (!c) return 'prone';
    if (c.low || this.e.supp > 0.6) return 'prone';
    return 'kneel';
  }

  /**
   * 교전(엄폐 사격). suppress: 안 보여도 아는 위치로 제압 사격.
   * @returns {object|null} 사격 의도 {mode, point, burst}
   */
  _fight(dt, suppress) {
    const e = this.e;
    const K = e.knowledge;
    const th = this._threatPoint();
    if (th) this._lookAt(K.has ? K.x : th.x, K.has ? K.z : th.z, dt, 1.5);
    // 엄폐가 없거나 위협을 못 막으면 옮김
    if (!this.peek || (!this.cover && !this.peek.open) || (this.cover && !this._coverGood() && !e.moveTarget)) {
      this._takeCover(0.6);
    }
    const p = this.peek;
    const supp = e.supp;
    this.status = supp > 0.7 ? '제압당함(엄폐에 붙음)' : suppress ? '제압 사격' : '엄폐 사격';
    if (p.phase === 'go') {
      if (e.moveTarget && this.cover && Math.hypot(this.cover.x - e.x, this.cover.z - e.z) < 0.9) e.setMove(null, 0);
      if (!e.moveTarget) {
        p.phase = 'hidden';
        p.until = this.time + rng.range(BEHAVIOR.hideTime[0], BEHAVIOR.hideTime[1]) * 0.6;
        e.setStance(this._hideStance());
        this.coverHidden = [e.x, e.z];
      }
      return null;
    }
    if (p.phase === 'hidden') {
      e.setStance(this._hideStance());
      // 제압당하면 내다보지 않는다
      if (supp > 0.7) {
        p.until = Math.max(p.until, this.time + 1.5);
        return null;
      }
      if (this.time < p.until) return K.visible && !this.cover?.low ? this._fireIntent(suppress, true) : null;
      // 내다보기
      p.phase = 'expose';
      p.until = this.time + rng.range(BEHAVIOR.exposeTime[0], BEHAVIOR.exposeTime[1]) * (1 - 0.4 * supp) * (e.unit && e.unit.morale < 0.55 ? 0.6 : 1);
      this._expose();
      return null;
    }
    if (p.phase === 'expose') {
      if (this.time > p.until || supp > 0.75) {
        // 숨기(가끔 옆 엄폐로 옮김)
        p.phase = 'hidden';
        p.until = this.time + rng.range(BEHAVIOR.hideTime[0], BEHAVIOR.hideTime[1]) * (1 + supp * 1.5);
        if (this.coverHidden) {
          e.setStance('crouchMove');
          e.setMove(this.coverHidden, 1.0);
        }
        if (rng.next() < BEHAVIOR.relocateChance) this._relocate();
        else e.setStance(this._hideStance());
        return null;
      }
      // 총구가 줄기·흙에 막혔으면 일어서거나 옆 엄폐로
      if (e.shooter.blocked) {
        e.shooter.blocked = false;
        if (e.stance !== 'stand' && !e.moveTarget && rng.next() < 0.5) e.setStance(e.stance === 'prone' ? 'kneel' : 'stand');
        else this._relocate();
      }
      if (p.pending && !e.moveTarget) {
        e.setStance(p.pending);
        p.pending = null;
      }
      return this._fireIntent(suppress, false);
    }
    return null;
  }

  /** 엄폐에서 몸을 조금 내밈: 줄기·짚 더미는 옆으로 반걸음(위협 방향에 수직), 낮은 엄폐는 무릎(배수로는 둑 쪽으로) */
  _expose() {
    const e = this.e;
    const c = this.cover;
    const th = this._threatPoint();
    if (!c || !th) {
      e.setStance(e.stance === 'prone' && this.peek.open ? 'prone' : 'kneel');
      return;
    }
    const tx = th.x - c.x;
    const tz = th.z - c.z;
    const l = Math.hypot(tx, tz) || 1;
    if (c.kind === 'trunk' || c.kind === 'bale' || c.kind === 'rootPlate') {
      const side = rng.next() < 0.5 ? -1 : 1;
      const off = 0.55 + (c.obj && c.obj.r0 ? c.obj.r0 : 0.3);
      e.setStance('crouchMove');
      e.setMove([c.x - (tz / l) * off * side, c.z + (tx / l) * off * side], 1.0);
      this.peek.pending = rng.next() < 0.3 ? 'stand' : 'kneel';
    } else if (c.kind === 'ditch') {
      e.setStance('prone');
      e.setMove([c.x + (tx / l) * 0.9, c.z + (tz / l) * 0.9], 0.4);
      this.peek.pending = 'prone';
    } else {
      e.setStance('kneel');
      this.peek.pending = 'kneel';
    }
  }

  _relocate() {
    const e = this.e;
    const th = this._threatPoint();
    if (!th) return;
    const taken = this.ctx.others(e);
    const c = this.ctx.cover.find({
      x: e.x,
      z: e.z,
      r: 10,
      threat: th,
      self: e,
      taken,
      spacing: BEHAVIOR.spacing,
      score: (q, d) => (d < 3 ? 50 : 0) + (q === this.cover ? 100 : 0),
    });
    if (c && this.ctx.cover.reserve(c, e)) {
      this.ctx.cover.release(this.cover, e);
      this.cover = c;
      e.setStance(c.low ? 'prone' : 'crouchMove');
      e.setMove([c.x, c.z], c.low ? 0.45 : 2.2);
      this.peek = { phase: 'go', until: this.time + 2 };
    }
  }

  /** 사격 의도: 보이면 조준 사격, 아니면(제압 임무 + 위치를 앎) 그 언저리로 점사 */
  _fireIntent(suppress, fromHide) {
    const e = this.e;
    const K = e.knowledge;
    const sh = e.shooter;
    if (!sh || !e.rifleHeld) return null;
    if (K.visible && K.seenPoint) {
      const sp = K.seenPoint;
      const d = Math.hypot(sp.x - e.x, sp.z - e.z);
      if (d > BEHAVIOR.maxRange && !suppress) return null;
      const burst = d < 60 ? rng.int(2, 4) : d < 150 && rng.next() < 0.35 ? 2 : 1;
      return { mode: 'aimed', point: sp, burst, vx: K.vx, vz: K.vz, rangeBias: K.rangeBias || 1 };
    }
    if (fromHide || !suppress || !K.has) return null;
    // 진행 중인 제압 점사(조준점을 정하면 그 점사를 다 쏠 때까지 유지)
    const st = this.supT;
    if (st) {
      if (sh.shots - st.shots0 >= st.burst || this.time > st.until) {
        this.supT = null;
        const rate = this.task.rate || 'normal';
        const gap = BEHAVIOR.suppressGap[rate] || BEHAVIOR.suppressGap.normal;
        this.nextSuppress = this.time + rng.range(gap[0], gap[1]);
        return null;
      }
      return { mode: 'suppress', point: st.point, burst: st.burst };
    }
    if (K.err > BEHAVIOR.suppressMaxErr) return null;
    if (sh.spare <= BEHAVIOR.ammoReserve && rng.next() < 0.7) return null;
    const d = Math.hypot(K.x - e.x, K.z - e.z);
    if (d > BEHAVIOR.maxRange * 1.2) return null;
    if (this.time < this.nextSuppress) return null;
    // 제압: 오차 분포에서 한 점, 지면 위 0.3~1 m
    const q = K.sample(rng, 0.6);
    const gy = this.ctx.world.terrain.heightAt(q.x, q.z);
    const burst = rng.int(BEHAVIOR.suppressBurst[0], BEHAVIOR.suppressBurst[1]);
    this.supT = { point: { x: q.x, y: gy + rng.range(0.3, 1.0), z: q.z }, burst, shots0: sh.shots, until: this.time + 4 + burst * 0.2 };
    return { mode: 'suppress', point: this.supT.point, burst };
  }

  // ---------------------------------------------------------------------------
  // 이동(측면 기동·접근·철수)
  _move(dt) {
    const e = this.e;
    const t = this.task;
    const unit = e.unit;
    const th = this._threatPoint();
    this.status = t.mode === 'withdraw' ? '철수' : t.mode === 'flank' ? '측면 기동' : '접근';
    if (!this.path && !this.pathReq && t.path && !t.pathTaken) {
      // 부대가 찾은 길을 따라감(조원마다 시차를 두고 출발 — 숲 안에서는 한 줄로)
      t.pathTaken = true;
      this.path = t.path.map((q) => [q[0], q[1]]);
      this.pathIdx = 0;
      this.departAt = this.time + (t.order || 0) * 2.5;
    }
    if (this.departAt && this.time < this.departAt) {
      e.setStance('kneel');
      if (th) this._lookAt(th.x, th.z, dt);
      return this._fireIntent(true, false);
    }
    if (!this.path && !this.pathReq) {
      const dest = [t.dest[0] + rng.range(-6, 6), t.dest[1] + rng.range(-6, 6)];
      this.pathDest = dest;
      this.pathThreat = th ? { x: th.x, z: th.z } : null;
      this.pathReq = this.ctx.nav.request([e.x, e.z], dest, th, (p) => {
        this.pathReq = null;
        if (p && !p.partial) {
          this.path = p;
          this.pathIdx = 0;
          return;
        }
        // 숨겨진 길이 없음: 제자리에서 엄호 사격
        this.task = { type: 'suppress', rate: 'normal' };
      }, { owner: e, exposureWeight: t.mode === 'withdraw' ? 8 : 6, maxNodes: 150000 });
    }
    if (!this.path) {
      if (th) this._lookAt(th.x, th.z, dt);
      return null;
    }
    // 목적지 도착
    if (this.pathIdx >= this.path.length) {
      e.setMove(null, 0);
      unit?.arrived(t.team);
      if (t.mode === 'withdraw') {
        e.setStance('kneel');
        return null;
      }
      this.task = { type: 'suppress', rate: 'normal' };
      this.peek = null;
      return null;
    }
    const wp = this.path[this.pathIdx];
    // 노출 구간인가(아는 위협에서 보이는 열린 땅)
    const k = this.ctx.nav.idx(e.x, e.z);
    const exposed = th && k >= 0 && this.ctx.nav.exposure(k, th) > 0.25;
    const sup = e.supp;
    if (exposed) {
      // 짝 교대 약진: 내 짝 차례가 아니면 엎드려 엄호
      const myTurn = !unit || unit.pairMoving(e.teamId, e.pair);
      if (!this.rush) {
        if (!myTurn || sup > 0.6 || (this.rushPauseUntil && this.time < this.rushPauseUntil)) {
          e.setMove(null, 0);
          e.setStance('prone');
          if (th) this._lookAt(th.x, th.z, dt);
          return this._fireIntent(true, false);
        }
        this.rush = { until: this.time + rng.range(BEHAVIOR.rush[0], BEHAVIOR.rush[1]) };
      }
      if (this.time > this.rush.until) {
        this.rush = null;
        this.rushPauseUntil = this.time + rng.range(BEHAVIOR.rushPause[0], BEHAVIOR.rushPause[1]);
        e.setMove(null, 0);
        e.setStance(rng.next() < 0.7 ? 'prone' : 'kneel');
        return null;
      }
      e.setStance('stand');
      e.setMove(wp, rng.range(3.8, 5.0));
    } else {
      // 숲 안(가려진 길): 낮은 자세로 빠르게, 끊김 없이
      this.rush = null;
      e.setStance(t.mode === 'withdraw' ? 'crouchMove' : 'crouchMove');
      if (!e.moveTarget || Math.hypot(e.moveTarget[0] - wp[0], e.moveTarget[1] - wp[1]) > 0.5) e.setMove(wp, sup > 0.5 ? 1.2 : 2.3);
      e.lookYaw += (Math.sin(this.time * 0.7) * 0.5 - e.lookYaw) * (1 - Math.exp(-dt * 2));
    }
    if (Math.hypot(e.x - wp[0], e.z - wp[1]) < 1.6) this.pathIdx++;
    return null;
  }

  // ---------------------------------------------------------------------------
  // 부상자 끌기
  _aid(dt) {
    const e = this.e;
    const a = this.task;
    const cas = a.casualty;
    this.status = '부상자 구조';
    if (!cas || cas.state === 'normal' || cas.dead || e.supp > 0.6) {
      if (cas) cas.dragBy = null;
      this.task = { type: 'hold' };
      return;
    }
    if (!a.phase) a.phase = 'reach';
    if (a.phase === 'reach') {
      const d = Math.hypot(cas.x - e.x, cas.z - e.z);
      if (d > 1.0) {
        e.setStance('crouchMove');
        e.setMove([cas.x, cas.z], 2.2);
        return;
      }
      a.phase = 'drag';
      const th = this._threatPoint();
      const c = this.ctx.cover.find({ x: cas.x, z: cas.z, r: 18, threat: th, self: e, spacing: 0, score: (q, dd) => (dd < 3 ? 20 : 0) });
      a.to = c ? [c.x, c.z] : null;
      if (!a.to) {
        this.task = { type: 'hold' };
        return;
      }
      cas.dragBy = e;
    }
    if (a.phase === 'drag') {
      e.setStance('crouchMove');
      e.setMove(a.to, 0.7);
      if (Math.hypot(e.x - a.to[0], e.z - a.to[1]) < 1.2) {
        cas.dragBy = null;
        cas.dragged = true;
        this.task = { type: 'hold' };
        e.unit?.shout(e, 'casualty');
      }
    }
    void dt;
  }

  // ---------------------------------------------------------------------------
  // 부상: 쓰러져 있어도 팔다리 부상이고 총이 있으면 엎드린 채 제한적으로 쏜다
  _wounded(dt) {
    const e = this.e;
    this.status = e.dead ? '사망' : e.incapacitated ? '전투 불능' : '부상';
    const sh = e.shooter;
    if (!sh) return;
    const canFire = e.state === 'down' && !e.incapacitated && e.rifleHeld && e.lying && e.lying.mode !== 'incap';
    if (!canFire) {
      sh.wantRaise = false;
      sh.setTarget(null);
      return;
    }
    const K = e.knowledge;
    let intent = null;
    if (K.visible && K.seenPoint && Math.hypot(K.seenPoint.x - e.x, K.seenPoint.z - e.z) < 250) intent = { mode: 'aimed', point: K.seenPoint, burst: 1, rangeBias: K.rangeBias || 1 };
    this._weapon(dt, intent, true);
  }

  _withdrawn(dt) {
    const e = this.e;
    this.status = '철수 완료';
    e.setMove(null, 0);
    e.setStance('kneel');
    void dt;
  }

  // ---------------------------------------------------------------------------
  // 총: 사격 의도에 따라 들고, 조준점·점사 지정, 쏘기. 탄창이 비면 재장전(숨어서)
  _weapon(dt, intent, wounded = false) {
    const e = this.e;
    const sh = e.shooter;
    if (!sh) return;
    // 숨은 채로 재장전: 비었거나, 쏠 일이 없고 탄이 적으면
    if (!sh.reloading && sh.spare > 0 && (sh.rounds === 0 || (!intent && sh.mag < 8 && this.peek && this.peek.phase === 'hidden'))) {
      sh.startReload();
      if (sh.rounds === 0) e.unit?.shout(e, 'reloading');
    }
    if (intent && !sh.reloading) {
      sh.wantRaise = true;
      e.aimAt = intent.point;
      sh.setTarget({ x: intent.point.x, y: intent.point.y, z: intent.point.z, mode: intent.mode, rangeBias: intent.rangeBias || 1, vx: intent.vx || 0, vz: intent.vz || 0 });
      if (sh.burst === 0 && sh.time >= sh.nextShot) sh.setBurst(intent.burst || 1);
      const clear = this.ctx.muzzleClear(e, intent.point);
      const b = sh.tryFire(clear);
      if (b) {
        e.knowledge.firing = true;
        this.lastShotT = this.time;
        if (intent.mode === 'aimed') b.sawTarget = true;
      }
    } else {
      e.aimAt = null;
      sh.setTarget(null);
      sh.wantRaise = !!(this.task.type === 'hold' || this.task.type === 'suppress') && this.peek && this.peek.phase === 'expose';
      if (this.time - (this.lastShotT || -100) > 6) e.knowledge.firing = false;
    }
    void dt;
    void wounded;
  }
}
