// 분대·사격조: 정보 공유(외침·무전), 사기, 계획(지휘).
//   외침: 같은 부대원에게 20~80 m 안에서(총성이 오가면 더 짧게), 0.6~1.5 s 뒤 + 거리/343 s. 말로 전하는 위치라 오차가 더 붙는다.
//         플레이어에게도 들린다('enemy:shout' — 합성한 짧은 사람 소리).
//   무전: 분대 ↔ 다른 부대, 3~8 s 늦게, 오차 ×1.5 + 15 m.
//   계획: 평시(경계·순찰·휴식) → 의심(멈춰서 관측) → 접촉(엄폐) → 교전(한 조 제압 사격 + 다른 조 측면 기동, 서로 엄호하며 번갈아)
//         → 사기가 꺾이면 철수(다음 숲띠 쪽으로, 역시 번갈아 엄호하며).
//   사기: 사상자(−0.2, 분대장 −0.3), 제압당한 시간, 사격이 멎으면 서서히 회복. 0.55 아래 소극적, 0.3 아래 철수.
// 지휘관이 아는 것도 인지 시스템을 거친 자기 지식 + 부하에게 들은 것뿐이다.

import { COMMS } from '../data/perception.js';
import { rng } from '../core/Random.js';
import { clamp } from '../core/math.js';

const C_SOUND = 343;

export const MORALE = {
  casualty: 0.2,
  leaderLoss: 0.3,
  suppressedPerSec: 0.012, // 제압당한 병사 1명당
  recoverPerSec: 0.004,
  shaken: 0.55,
  withdraw: 0.3,
};

export class Unit {
  /**
   * @param {object} def 시나리오 정의
   * @param {object} ctx {world, nav, cover, events, time()}
   */
  constructor(def, ctx) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.ctx = ctx;
    this.members = [];
    this.teams = new Map(); // teamId → [soldiers]
    this.leader = null;
    this.peers = []; // 무전 상대 부대
    this.reset();
  }

  reset() {
    this.phase = 'peace'; // peace | alert | contact | fight | withdraw | gone
    this.morale = 1;
    this.casualties = 0;
    this.leaderLost = false;
    this.plan = null; // {base:teamId, maneuver:teamId, dest:[x,z], kind:'flank'|'hold', since}
    this.planAt = -100;
    this.alertAt = -1;
    this.contactAt = -1;
    this.lastUnderFire = -100;
    this.pending = []; // 지연 전달 {at, fn}
    this.movePair = new Map(); // teamId → 지금 움직이는 짝(0/1)
    this.pairSince = new Map();
    this.withdrawDest = null;
    this.log = [];
  }

  add(soldier, teamId, role) {
    soldier.unit = this;
    soldier.teamId = teamId;
    soldier.role = role;
    this.members.push(soldier);
    if (teamId) {
      if (!this.teams.has(teamId)) this.teams.set(teamId, []);
      const t = this.teams.get(teamId);
      soldier.pair = t.length < 2 ? 0 : 1;
      t.push(soldier);
    }
    if (role === 'leader') this.leader = soldier;
  }

  get alive() {
    return this.members.filter((m) => m.state === 'normal');
  }

  /** 지휘하는 사람: 분대장, 없으면 살아 있는 조장, 그다음 아무나 */
  get commander() {
    if (this.leader && this.leader.state === 'normal') return this.leader;
    const tl = this.members.find((m) => m.state === 'normal' && m.role === 'teamLeader');
    return tl || this.alive[0] || null;
  }

  time() {
    return this.ctx.time();
  }

  // ---------------------------------------------------------------------------
  // 정보 공유
  /** 외침: from이 아는 위협 위치를 부대원에게 */
  shout(from, kind = 'contact') {
    const now = this.time();
    if (from._lastShout && now - from._lastShout < 4 && kind === from._lastShoutKind) return;
    from._lastShout = now;
    from._lastShoutKind = kind;
    const K = from.knowledge;
    const noisy = now - this.lastUnderFire < 3;
    const R = COMMS.shoutRange[1] * (noisy ? COMMS.shoutNoiseCut : 1);
    const delay = rng.range(COMMS.shoutDelay[0], COMMS.shoutDelay[1]);
    this.ctx.events.emit('enemy:shout', { enemy: from, kind, position: from.headWorld, delay });
    if (!K.has) return;
    const info = { x: K.x, z: K.z, err: K.err };
    const dThreat = Math.hypot(K.x - from.x, K.z - from.z);
    for (const m of this.members) {
      if (m === from || !m.canPerceive()) continue;
      const d = Math.hypot(m.x - from.x, m.z - from.z);
      if (d > R) continue;
      if (d > COMMS.shoutRange[0] && rng.next() > 1 - (d - COMMS.shoutRange[0]) / (R - COMMS.shoutRange[0])) continue;
      this._deliver(now + delay + d / C_SOUND, m, info, info.err + COMMS.shoutErrBase + COMMS.shoutErrPerMeter * dThreat, kind, 'shout');
    }
    // 분대장(지휘관)이 들었으면 무전으로 다른 부대에
    const cmd = this.commander;
    if (cmd && (cmd === from || Math.hypot(cmd.x - from.x, cmd.z - from.z) < R)) this._radio(info, now + delay + 1);
  }

  _radio(info, t0) {
    const now = this.time();
    if (this._lastRadio && now - this._lastRadio < 10) return;
    this._lastRadio = now;
    for (const u of this.peers) {
      if (u.phase === 'gone') continue;
      const at = t0 + rng.range(COMMS.radioDelay[0], COMMS.radioDelay[1]);
      const cmd = () => u.commander;
      const err = info.err * COMMS.radioErrMul + COMMS.radioErrAdd; // 전달된 오차 반지름(2σ)
      this.pending.push({
        at,
        fn: () => {
          const c = cmd();
          if (!c) return;
          // 무전을 받은 지휘관이 부대원에게 알림(외침 거리 안)
          this._apply(c, info, err, 'radio', 'contact');
          for (const m of u.members) if (m !== c && m.canPerceive() && Math.hypot(m.x - c.x, m.z - c.z) < 60) this._apply(m, info, err + 8, 'radio', 'contact');
          if (u.phase === 'peace' || u.phase === 'alert') u.setPhase('contact');
        },
      });
    }
  }

  _deliver(at, m, info, extra, kind, source) {
    this.pending.push({ at, fn: () => this._apply(m, info, extra, source, kind) });
  }

  /** 전해 들은 위치: errR = 전달 뒤 오차 반지름(2σ). 말로 전하며 생긴 오차만큼 위치도 어긋난다 */
  _apply(m, info, errR, source, kind) {
    if (!m.canPerceive()) return;
    const K = m.knowledge;
    if (K.visible) return; // 직접 보고 있으면 남의 말은 덜 믿는다
    const extraSig = Math.max(0, errR - info.err) / 2;
    const ex = info.x + rng.gauss() * extraSig;
    const ez = info.z + rng.gauss() * extraSig;
    const sig = Math.max(3, errR / 2);
    const ux = ex - m.x;
    const uz = ez - m.z;
    const l = Math.hypot(ux, uz) || 1;
    K.threat = K.threat || kind !== 'suspicious';
    K.suspicion = Math.max(K.suspicion, 0.6);
    K.observe(ex, ez, sig, sig, ux / l, uz / l, this.time(), source);
    m.brain?.onShared(source);
  }

  // ---------------------------------------------------------------------------
  setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    const now = this.time();
    if (p === 'alert' && this.alertAt < 0) this.alertAt = now;
    if ((p === 'contact' || p === 'fight') && this.contactAt < 0) this.contactAt = now;
    this.log.push({ t: now, phase: p });
    for (const m of this.members) m.brain?.onPhase(p);
  }

  onCasualty(m) {
    this.casualties++;
    this.morale -= MORALE.casualty;
    if (m === this.leader && !this.leaderLost) {
      this.leaderLost = true;
      this.morale -= MORALE.leaderLoss;
    }
    if (this.phase === 'peace' || this.phase === 'alert') this.setPhase('contact');
    this.lastUnderFire = this.time();
  }

  onUnderFire() {
    this.lastUnderFire = this.time();
    if (this.phase === 'peace' || this.phase === 'alert') this.setPhase('contact');
  }

  /** 지휘관이 아는 위협 위치(자기 눈·귀 + 부하에게 들은 것 + 무전) — 부하의 머릿속을 직접 읽지 않는다 */
  picture() {
    const c = this.commander;
    return c && c.knowledge.has ? c.knowledge : null;
  }

  // ---------------------------------------------------------------------------
  update(dt) {
    const now = this.time();
    if (this.pending.length) {
      const keep = [];
      for (const p of this.pending) {
        if (p.at <= now) p.fn();
        else keep.push(p);
      }
      this.pending = keep;
    }
    const alive = this.alive;
    if (!alive.length) {
      this.phase = 'gone';
      return;
    }
    // 사기
    let supp = 0;
    for (const m of alive) if (m.supp > 0.5) supp++;
    if (supp) this.morale -= MORALE.suppressedPerSec * supp * dt;
    else if (now - this.lastUnderFire > 10) this.morale += MORALE.recoverPerSec * dt;
    this.morale = clamp(this.morale, 0, 1);

    // 단계
    if (this.phase === 'withdraw' || this.phase === 'gone') {
      this._withdraw(now);
      return;
    }
    let anyThreat = false;
    let anySusp = false;
    for (const m of alive) {
      const K = m.knowledge;
      if (K.threat) anyThreat = true;
      else if (K.suspicion > 0.3 || K.has) anySusp = true;
    }
    if (anyThreat && (this.phase === 'peace' || this.phase === 'alert')) this.setPhase('contact');
    else if (anySusp && this.phase === 'peace') this.setPhase('alert');
    else if (this.phase === 'alert' && !anySusp && now - this.alertAt > 45) {
      this.setPhase('peace');
      this.alertAt = -1;
    }
    if (this.morale < MORALE.withdraw && (this.phase === 'contact' || this.phase === 'fight')) {
      this.setPhase('withdraw');
      this._planWithdraw();
      return;
    }
    if (this.phase === 'contact' || this.phase === 'fight') this._command(now);
  }

  /** 교전 지휘: 위치를 알면 한 조 제압 + 다른 조 기동 */
  _command(now) {
    const pic = this.picture();
    // 위치 파악: 지휘관이 아는 오차가 90 m 안(새 정보가 없으면 오차가 저절로 커진다)
    const located = pic && pic.err < 90;
    if (located && this.phase === 'contact') this.setPhase('fight');
    if (now - this.planAt < 12 && this.plan) return;
    this.planAt = now;
    const teams = [...this.teams.keys()].filter((t) => this.teams.get(t).some((m) => m.state === 'normal'));
    const shaken = this.morale < MORALE.shaken;
    const moving = this.plan && this.plan.dest && !this.plan.arrived && pic && pic.err < 250;
    if ((!located && !moving) || shaken) {
      // 위치를 모르거나 사기가 꺾이기 시작: 엄폐하고 관측, 보이면 쏨(아는 곳으로 제압은 가끔만)
      if (!this.plan || this.plan.kind !== 'hold') this.plan = { kind: 'hold', base: null, maneuver: null };
      this.plan.rate = shaken ? 'slow' : 'normal';
      for (const m of this.alive) m.brain?.setTask({ type: pic && pic.err < 150 && !shaken ? 'suppress' : 'hold', rate: 'slow' });
      return;
    }
    if (teams.length >= 2) {
      // 두 조: 한 조는 제압 사격(기지조), 다른 조는 숲띠를 따라 측면으로
      if (!this.plan || this.plan.kind !== 'fire-move') this.plan = { kind: 'fire-move', base: teams[0], maneuver: teams[1], dest: null, path: null, since: now, arrived: false };
      const P = this.plan;
      if (!teams.includes(P.base) || !teams.includes(P.maneuver)) {
        P.base = teams[0];
        P.maneuver = teams[1];
      }
      for (const m of this.teams.get(P.base)) if (m.state === 'normal') m.brain?.setTask({ type: 'suppress', rate: 'normal' });
      if (this.leader && this.leader.state === 'normal' && !this.leader.teamId) this.leader.brain?.setTask({ type: 'suppress', rate: 'slow' });
      if (P.arrived) {
        for (const m of this.teams.get(P.maneuver)) if (m.state === 'normal') m.brain?.setTask({ type: 'suppress', rate: 'normal' });
      } else {
        if (!P.dest && !P.searching && !(this.noFlankUntil > now)) this._findFlank(pic, P.maneuver);
        let order = 0;
        for (const m of this.teams.get(P.maneuver)) {
          if (m.state !== 'normal') continue;
          if (P.dest) m.brain?.setTask({ type: 'move', dest: P.dest, path: P.path, order: order++, mode: 'flank', team: P.maneuver });
          else m.brain?.setTask({ type: 'suppress', rate: 'normal' });
        }
      }
    } else {
      // 사격조 하나: 엄폐해서 쏘고, 더 가까운 숲 안 자리로 갈 숨겨진 길이 있으면 짝끼리 번갈아 다가감
      const t = teams[0];
      if (!this.plan || this.plan.kind !== 'team') this.plan = { kind: 'team', dest: this._closeDest(pic, t), since: now, arrived: false };
      const P = this.plan;
      for (const m of this.teams.get(t)) {
        if (m.state !== 'normal') continue;
        if (P.dest && !P.arrived) m.brain?.setTask({ type: 'move', dest: P.dest, mode: 'bound', team: t });
        else m.brain?.setTask({ type: 'suppress', rate: 'normal' });
      }
    }
  }

  /**
   * 측면 목적지: 위협에서 60~160 m, 기지조 사격선에서 50° 넘게 벌어진 숲띠(은폐) 안, 위협보다 가까운 쪽.
   * 후보 3곳까지 A*(노출 비용)로 길을 구해 '길이 + 노출 길이 × 8'이 가장 작은 곳. 숨겨진 길이 없으면 측면 기동 포기(1분).
   */
  _findFlank(pic, teamId) {
    const nav = this.ctx.nav;
    const team = this.teams.get(teamId).filter((m) => m.state === 'normal');
    if (!team.length) return;
    const cx = team.reduce((a, m) => a + m.x, 0) / team.length;
    const cz = team.reduce((a, m) => a + m.z, 0) / team.length;
    const base = this.teams.get(this.plan.base).filter((m) => m.state === 'normal');
    const bx = base.length ? base.reduce((a, m) => a + m.x, 0) / base.length : cx;
    const bz = base.length ? base.reduce((a, m) => a + m.z, 0) / base.length : cz;
    const baseBearing = Math.atan2(bx - pic.x, -(bz - pic.z));
    const dThreat = Math.hypot(cx - pic.x, cz - pic.z);
    const cand = [];
    for (let k = 0; k < 400 && cand.length < 40; k++) {
      const r = rng.range(60, 160);
      const a = rng.range(0, Math.PI * 2);
      const x = pic.x + Math.sin(a) * r;
      const z = pic.z - Math.cos(a) * r;
      const idx = nav.idx(x, z);
      if (idx < 0 || !nav.belt[idx]) continue;
      let dA = a - baseBearing;
      dA = Math.abs(Math.atan2(Math.sin(dA), Math.cos(dA)));
      if (dA < (50 * Math.PI) / 180) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d > dThreat - 20) continue; // 위협 너머로 돌아가지 않음
      cand.push({ x, z, s: d + r * 0.5 - dA * 20 });
    }
    cand.sort((p, q) => p.s - q.s);
    const pick = [];
    for (const c of cand) {
      if (pick.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > 40)) pick.push(c);
      if (pick.length >= 3) break;
    }
    if (!pick.length) {
      this.noFlankUntil = this.time() + 60;
      return;
    }
    this.plan.searching = true;
    const plan = this.plan;
    const results = [];
    for (const c of pick) {
      nav.request([cx, cz], [c.x, c.z], { x: pic.x, z: pic.z }, (path) => {
        results.push({ c, path });
        if (results.length < pick.length) return;
        plan.searching = false;
        let best = null;
        let bestS = Infinity;
        for (const r of results) {
          if (!r.path || r.path.partial) continue;
          let L = 0;
          for (let q = 1; q < r.path.length; q++) L += Math.hypot(r.path[q][0] - r.path[q - 1][0], r.path[q][1] - r.path[q - 1][1]);
          const ex = nav.exposedLength(r.path, pic);
          const sc = L + ex * 8;
          if (ex < 80 && sc < bestS) {
            bestS = sc;
            best = r;
          }
        }
        if (best) {
          plan.dest = [best.c.x, best.c.z];
          plan.path = best.path;
          this.planAt = -100; // 바로 배정
        } else this.noFlankUntil = this.time() + 60;
      }, { maxNodes: 150000, owner: this });
    }
  }

  /** 사격조 하나: 위협에 더 가까운 숲 안 엄폐 자리(40~110 m) */
  _closeDest(pic, teamId) {
    const nav = this.ctx.nav;
    const team = this.teams.get(teamId).filter((m) => m.state === 'normal');
    if (!team.length) return null;
    const cx = team.reduce((a, m) => a + m.x, 0) / team.length;
    const cz = team.reduce((a, m) => a + m.z, 0) / team.length;
    const d0 = Math.hypot(cx - pic.x, cz - pic.z);
    if (d0 < 110) return null;
    let best = null;
    let bestS = Infinity;
    for (let k = 0; k < 200; k++) {
      const r = rng.range(45, 110);
      const a = rng.range(0, Math.PI * 2);
      const x = pic.x + Math.sin(a) * r;
      const z = pic.z - Math.cos(a) * r;
      const idx = nav.idx(x, z);
      if (idx < 0 || !nav.belt[idx]) continue;
      const s = Math.hypot(x - cx, z - cz);
      if (s < bestS) {
        bestS = s;
        best = [x, z];
      }
    }
    return best;
  }

  /** 철수: 다음 숲띠 쪽으로, 짝끼리 번갈아 */
  _planWithdraw() {
    const belt = this.ctx.world.layout.beltById[this.def.withdrawBelt];
    const alive = this.alive;
    if (!belt || !alive.length) return;
    const cx = alive.reduce((a, m) => a + m.x, 0) / alive.length;
    const cz = alive.reduce((a, m) => a + m.z, 0) / alive.length;
    const loc = belt.toLocal(cx, cz);
    const u = clamp(loc.u, belt.from + 10, belt.to - 10);
    const p = belt.toWorld(u, 0);
    this.withdrawDest = [p.x, p.z];
    for (const m of alive) m.brain?.setTask({ type: 'move', dest: this.withdrawDest, mode: 'withdraw', team: m.teamId });
  }

  _withdraw(now) {
    if (!this.withdrawDest) this._planWithdraw();
    // 목적지 숲띠에 닿은 병사는 교전에서 빠짐
    for (const m of this.alive) {
      if (m.withdrawn) continue;
      if (this.withdrawDest && Math.hypot(m.x - this.withdrawDest[0], m.z - this.withdrawDest[1]) < 25) {
        m.withdrawn = true;
        m.brain?.setTask({ type: 'withdrawn' });
        this.ctx.events.emit('enemy:withdrawn', { enemy: m });
      }
    }
    if (this.alive.every((m) => m.withdrawn)) this.phase = 'gone';
    void now;
  }

  /** 짝 교대(번갈아 이동): 움직이는 짝이 한 번 약진을 마치면 다른 짝 차례 */
  pairMoving(teamId, pair) {
    const now = this.time();
    if (!this.movePair.has(teamId)) {
      this.movePair.set(teamId, 0);
      this.pairSince.set(teamId, now);
    }
    if (now - this.pairSince.get(teamId) > 7) {
      this.movePair.set(teamId, 1 - this.movePair.get(teamId));
      this.pairSince.set(teamId, now);
    }
    return this.movePair.get(teamId) === pair;
  }

  /** 기동조 도착 보고 */
  arrived(teamId) {
    if (this.plan && (this.plan.maneuver === teamId || this.plan.kind === 'team')) this.plan.arrived = true;
  }
}
