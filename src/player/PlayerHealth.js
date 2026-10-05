// 플레이어 몸 상태: 부상(적과 같은 부위·부상 범주), 출혈과 지혈대, 제압. 체력바 없이 몸으로만 드러난다.
//   제압(적과 같은 규칙): 1~3 m 안을 스치는 탄·근처 탄착 → 짧은 움찔(카메라·총), 심박 상승(흔들림↑), 거친 숨, 시야 가장자리 살짝 좁아짐.
//   부상: 즉사(머리·목·흉부 중앙·척추) / 폐(3~10 s 안에 쓰러짐) / 복부·골반(엎드려 기며 사격, 1~3분 뒤 전투 불능)
//         / 다리(엎드려 기기·사격만) / 팔(흔들림 3배, 재장전 2.5배). 팔다리는 지혈대(H, 20~40 s, 그동안 사격 불가, H로 중단).
//   연출: 시야 어두워짐·채도 감소, 심장 박동·숨소리, 움직임 둔화. 피로 화면을 덮지 않는다.
// 치명상 기록(디브리핑): 쏜 적, 방향·거리, 그 적이 나를 실제로 봤는가/추정 위치로 제압 사격했는가, 맞을 때 내 자세·노출.

import { WOUNDS, PLAYER_WOUNDS } from '../data/anatomy.js';
import { MOVEMENT } from '../data/movement.js';
import { SUPPRESSION } from '../enemies/EnemyManager.js';
import { rng } from '../core/Random.js';
import { clamp, lerp } from '../core/math.js';

const LIMB_PARTS = new Set(['thigh', 'shin', 'foot', 'armUpper', 'armLower', 'hand']);

export class PlayerHealth {
  /**
   * @param {object} g Game
   */
  constructor(g) {
    this.g = g;
    this.reset();
    const ev = g.events;
    ev.on('bullet:flyby', (e) => this._onFlyby(e));
    ev.on('bullet:impact', (e) => this._onImpact(e));
  }

  reset() {
    this.alive = true;
    this.incapacitated = false;
    this.wounds = [];
    this.blood = 1;
    this.supp = 0;
    this.lungTimer = -1;
    this.lungT = 0;
    this.lungDur = 0;
    this.tq = null; // 지혈대 감는 중 {t, dur, wound}
    this.fatal = null; // 치명상 기록
    this.hitLog = [];
    this.flinchP = 0;
    this.flinchY = 0;
    this.deathT = -1;
    this.godMode = this.godMode || false;
    this.fade = 0;
    this.pending = [];
  }

  get forcedProne() {
    return this.wounds.some((w) => w.kind === 'leg' || w.kind === 'abdomen');
  }
  get armWounded() {
    return this.wounds.some((w) => w.kind === 'arm');
  }
  get swayMul() {
    return this.armWounded ? PLAYER_WOUNDS.armSway : 1;
  }
  get reloadMul() {
    return this.armWounded ? PLAYER_WOUNDS.armReload : 1;
  }
  /** 총을 쓸 수 없음(지혈대 감는 중·쓰러짐) */
  get busy() {
    return !!this.tq || !this.alive || this.incapacitated;
  }
  get bleeding() {
    return this.wounds.some((w) => w.rate > 0 && !w.tq);
  }

  // ---------------------------------------------------------------------------
  /** 탄 명중(BulletSystem → PlayerBody 판정 → 여기) */
  onHit(info) {
    const g = this.g;
    if (!this.alive) return;
    const w = WOUNDS[info.part] || WOUNDS.abdomen;
    const now = g.time;
    const rec = this._record(info, w);
    this.hitLog.push(rec);
    if (this.godMode) {
      g.toast.show(`(무적) 피격: ${w.name}`);
      return;
    }
    // 맞는 순간: 큰 움찔
    this._flinch(2.2);
    g.player.heart = Math.min(MOVEMENT.heart.max, g.player.heart + 25);
    const wound = { part: info.part, kind: w.kind, name: w.name, time: now, rate: 0, tq: false, record: rec };
    this.wounds.push(wound);
    g.events.emit('player:hit', { part: info.part, kind: w.kind, name: w.name });
    if (w.kind === 'incap') {
      this._die(rec, '즉사');
      return;
    }
    if (w.kind === 'lung') {
      // 폐: 시야가 빠르게 어두워지고 수 초 안에 쓰러짐
      if (this.lungTimer < 0) {
        this.lungDur = rng.range(PLAYER_WOUNDS.lungCollapse[0], PLAYER_WOUNDS.lungCollapse[1]);
        this.lungTimer = this.lungDur;
        this.lungRec = rec;
      }
      return;
    }
    if (w.kind === 'abdomen') {
      const tInc = rng.range(PLAYER_WOUNDS.abdomenIncap[0], PLAYER_WOUNDS.abdomenIncap[1]);
      wound.rate = (1 - PLAYER_WOUNDS.incapBlood) / tInc;
      this._fallProne();
      return;
    }
    // 팔다리: 부위별 출혈(지혈대로 멈춤)
    const bo = PLAYER_WOUNDS.bleedOut[info.part] || [300, 600];
    wound.rate = (1 - PLAYER_WOUNDS.incapBlood) / rng.range(bo[0], bo[1]);
    if (w.kind === 'leg') this._fallProne();
  }

  _record(info, w) {
    const g = this.g;
    const em = g.enemies;
    const shooter = em.enemies.find((e) => e.id === info.shooter);
    const b = info.bullet;
    const p = g.player;
    // 같은 자리(5 m 안)에서 최근 60 s 동안 쏜 횟수
    const shots = em.senses.lastShots.filter((s) => g.time - s.t < 60 && Math.hypot(s.x - p.x, s.z - p.z) < 5).length;
    const bearing = shooter ? Math.atan2(shooter.x - p.x, -(shooter.z - p.z)) : null;
    return {
      t: g.time,
      part: info.part,
      partName: w.name,
      kind: w.kind,
      shooter: info.shooter,
      shooterRole: shooter ? shooter.role : null,
      bearing,
      distance: info.distance,
      aimMode: b ? b.aimMode : null, // 'aimed' = 나를 보고 조준, 'suppress' = 추정 위치로 제압 사격
      knownErr: b ? b.knownErr : null,
      knownFor: b ? b.knownFor : null,
      exposure: b ? b.exposure : null, // 쏜 적에게 보인 몸 비율(시선 투과율 가중)
      stance: p.stance,
      moving: p.speed > 0.3,
      sprinting: p.sprinting,
      shotsHere: shots,
      speed: info.speed,
    };
  }

  _fallProne() {
    const p = this.g.player;
    if (p.stance !== 'prone' && !(p.transition && p.transition.to === 'prone')) {
      p.transition = null;
      p.stance = p.stance === 'stand' ? 'stand' : p.stance;
      p.setStance('prone');
      if (p.transition) p.transition.dur = 0.55; // 다리가 풀려 쓰러짐
    }
  }

  _die(rec, cause) {
    if (!this.alive) return;
    this.alive = false;
    this.incapacitated = true;
    this.fatal = { ...rec, cause };
    this.deathT = this.g.time;
    this.tq = null;
    this.g.playerBody.alive = false;
    this.g.events.emit('player:dead', { record: this.fatal });
  }

  // ---------------------------------------------------------------------------
  // 제압(적과 같은 표: EnemyManager.SUPPRESSION)
  _onFlyby(e) {
    if (!this.alive || e.shooter === 'player') return;
    const r = e.distance;
    const tab = SUPPRESSION.nearMiss;
    let s = 0;
    if (r < tab[0][0]) s = tab[0][1];
    else if (r < tab[1][0]) s = tab[1][1] + (tab[0][1] - tab[1][1]) * (1 - (r - tab[0][0]) / (tab[1][0] - tab[0][0]));
    else if (r < tab[2][0] && e.supersonic) s = tab[2][1];
    if (s <= 0) return;
    // 소리가 닿는 순간에 맞춰(마하 원뿔 도착)
    const apply = () => {
      this.supp = Math.min(SUPPRESSION.max, this.supp + s);
      if (r < 3) this._flinch(r < 1 ? 1.0 : 0.6);
      const p = this.g.player;
      p.heart = Math.min(MOVEMENT.heart.max, p.heart + 14 * s + (r < 3 ? 4 : 0));
    };
    if (e.delay > 0.002) this.pending.push({ at: this.g.time + e.delay, fn: apply });
    else apply();
  }

  _onImpact(e) {
    if (!this.alive || e.shooter === 'player') return;
    const p = this.g.player;
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    const R = SUPPRESSION.impact.range;
    if (d > R) return;
    this.supp = Math.min(SUPPRESSION.max, this.supp + SUPPRESSION.impact.amount * (1 - d / R) + 0.1);
    this._flinch(0.5);
    p.heart = Math.min(MOVEMENT.heart.max, p.heart + 6);
  }

  /** 짧고 날카로운 움찔: 카메라·총에 작은 튐(0.15 s 안에 멎음) */
  _flinch(k) {
    const a = this.g.weapon.aim;
    const mag = 0.004 * k;
    this.flinchP += mag * (0.6 + rng.next() * 0.6);
    this.flinchY += mag * rng.gauss() * 0.7;
    a.pitchSpring.impulse(mag * 6 * (0.5 + rng.next()));
    a.yawSpring.impulse(mag * 4 * rng.gauss());
  }

  // ---------------------------------------------------------------------------
  /** H: 지혈대 감기 시작/중단 */
  toggleTourniquet() {
    const g = this.g;
    if (!this.alive || this.incapacitated) return;
    if (this.tq) {
      this.tq = null;
      g.toast.show('지혈대 감기를 멈췄다');
      g.events.emit('player:tourniquet', { phase: 'stop' });
      return;
    }
    const target = this.wounds.find((w) => LIMB_PARTS.has(w.part) && !w.tq && w.rate > 0);
    if (!target) {
      const torso = this.wounds.some((w) => (w.kind === 'abdomen' || w.kind === 'lung') && w.rate >= 0);
      g.toast.show(torso ? '몸통 상처는 지혈대로 막을 수 없다' : '지혈대를 감을 팔다리 상처가 없다');
      return;
    }
    const T = PLAYER_WOUNDS.tourniquet;
    const dur = rng.range(T[0], T[1]) + (this.armWounded ? PLAYER_WOUNDS.tourniquetOneHand : 0);
    this.tq = { t: 0, dur, wound: target };
    g.toast.show(`지혈대를 감는다(${target.name}) — 그동안 쏠 수 없다, H로 중단`);
    g.events.emit('player:tourniquet', { phase: 'start', duration: dur });
  }

  // ---------------------------------------------------------------------------
  update(dt) {
    const g = this.g;
    const p = g.player;
    if (this.pending.length) {
      const keep = [];
      for (const q of this.pending) (q.at <= g.time ? q.fn() : keep.push(q));
      this.pending = keep;
    }
    // 제압은 사격이 멎으면 서서히(약 6 s)
    this.supp *= Math.exp(-dt / 6);
    // 움찔 감쇠(짧게)
    const k = Math.exp(-dt / 0.06);
    this.flinchP *= k;
    this.flinchY *= k;
    if (!this.alive) {
      this.fade = Math.min(1, this.fade + dt / 2.5);
      this._effects();
      return;
    }
    // 지혈대
    if (this.tq) {
      this.tq.t += dt;
      if (Math.floor(this.tq.t / 2.2) !== Math.floor((this.tq.t - dt) / 2.2)) g.events.emit('player:tourniquet', { phase: 'turn' });
      if (this.tq.t >= this.tq.dur) {
        this.tq.wound.tq = true;
        g.toast.show(`지혈대를 감았다(${this.tq.wound.name}) — 출혈이 멎었다`);
        g.events.emit('player:tourniquet', { phase: 'done' });
        this.tq = null;
      }
    }
    // 출혈
    let rate = 0;
    for (const w of this.wounds) if (!w.tq) rate += w.rate;
    this.blood = Math.max(0, this.blood - rate * dt);
    // 피를 잃으면 심장이 빨리 뛴다(보상성 빈맥)
    const loss = clamp((1 - this.blood) / (1 - PLAYER_WOUNDS.incapBlood), 0, 1);
    p.heart = Math.max(p.heart, MOVEMENT.heart.rest + 70 * loss);
    // 폐
    if (this.lungTimer >= 0) {
      this.lungTimer -= dt;
      this.lungT = 1 - this.lungTimer / this.lungDur;
      // 숨이 모자라 심장이 빨리 뛴다
      p.heart = Math.max(p.heart, MOVEMENT.heart.rest + 80 * this.lungT);
      if (this.lungTimer <= 0) this._die(this.lungRec, '폐 손상으로 쓰러짐');
    }
    if (this.alive && this.blood <= PLAYER_WOUNDS.incapBlood) {
      const last = this.wounds[this.wounds.length - 1];
      this._die(last ? last.record : null, '출혈로 쓰러짐');
    }
    this._effects();
  }

  /** 화면 연출(후처리 uBody) */
  _effects() {
    const g = this.g;
    const loss = clamp((1 - this.blood) / (1 - PLAYER_WOUNDS.incapBlood), 0, 1);
    let darken = 0.45 * loss * loss;
    let desat = 0.75 * loss;
    if (this.lungTimer >= 0) {
      darken = Math.max(darken, 0.95 * Math.pow(this.lungT, 1.4));
      desat = Math.max(desat, 0.8 * this.lungT);
    }
    if (!this.alive) {
      darken = lerp(Math.max(darken, 0.6), 1, this.fade);
      desat = 1;
    }
    const tunnel = Math.min(0.42, this.supp * 0.38);
    g.post.body.set(darken, desat, tunnel, 0);
    if (g.bodyOverlay) {
      // 후처리를 쓰지 않는 품질: CSS 덮개로 어둡게만
      const o = Math.min(1, darken + tunnel * 0.4);
      if (Math.abs(o - (this._ov || 0)) > 0.01) {
        this._ov = o;
        g.bodyOverlay.style.opacity = o.toFixed(2);
      }
    }
  }

  /** 디브리핑 문장들 */
  debrief() {
    const f = this.fatal;
    if (!f) return [];
    const L = [];
    const compass = (b) => {
      const deg = ((b * 180) / Math.PI + 360) % 360;
      const names = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
      return `${names[Math.round(deg / 45) % 8]}(${deg.toFixed(0)}°)`;
    };
    L.push(`치명상: ${f.partName} — ${f.cause}`);
    if (f.shooter) {
      L.push(`쏜 적: ${f.shooter}${f.shooterRole === 'leader' ? '(분대장)' : ''} — ${f.bearing !== null ? compass(f.bearing) : '?'} 방향, ${f.distance.toFixed(0)} m`);
      if (f.aimMode === 'aimed') L.push(`그 적은 당신을 직접 보고 조준해 쐈다(보인 몸 비율 약 ${Math.round((f.exposure || 0) * 100)} %).`);
      else if (f.aimMode === 'suppress') L.push(`그 적은 당신을 보지 못했다 — 추정 위치(오차 약 ${f.knownErr ? f.knownErr.toFixed(0) : '?'} m)로 쏜 제압 사격에 맞았다.`);
      if (f.knownFor) L.push(`적이 당신의 위치를 안 지 ${f.knownFor.toFixed(0)} s 지났다.`);
    }
    const st = { stand: '서 있었다', crouch: '앉아쏴 자세였다', prone: '엎드려 있었다' }[f.stance] || f.stance;
    L.push(`맞을 때 당신은 ${st}${f.sprinting ? '(질주 중)' : f.moving ? '(움직이는 중)' : '(정지)'}.`);
    if (f.shotsHere >= 3) L.push(`같은 자리에서 최근 1분 동안 ${f.shotsHere}발을 쐈다 — 총성과 섬광으로 위치가 좁혀졌다.`);
    return L;
  }
}
