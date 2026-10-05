// 적 부대 만들기·갱신. 시나리오(data/scenario.js)의 부대를 숲띠의 그럴듯한 자리 후보에서 시드로 뽑아 세운다.
// 인지(Senses)·엄폐 지도·길찾기·부대 지휘·병사 두뇌·소총을 묶고, 탄 판정(적 히트박스)·근탄('딱'·제압)·근처 탄착을 전달한다.
// 교전 종료: 모든 적이 전투 불능 또는 철수하면 'engagement:end'.
// 디버그 모드: 조준점에 적 소환(소환조 — 같은 인지·두뇌·소총), 더미(인지·두뇌·총 없이 서 있는 표적, 같은 부상 모델).

import { Enemy } from './Enemy.js';
import { Brain } from '../ai/Brain.js';
import { Shooter } from '../ai/Shooter.js';
import { Unit } from '../ai/Squad.js';
import { ThreatKnowledge } from '../ai/Knowledge.js';
import { Senses } from '../ai/Senses.js';
import { CoverMap } from '../ai/CoverMap.js';
import { NavGrid } from '../ai/NavGrid.js';
import { AILog } from '../ai/AILog.js';
import { SCENARIO } from '../data/scenario.js';
import { Random, rng } from '../core/Random.js';
import { pointSegDistance } from '../physics/intersect.js';
import { flybyGeometry, isSupersonic } from '../physics/BulletSystem.js';

export const SUPPRESSION = {
  // 근탄: 가까이 스칠수록 크게(초음속 '딱'), 근처 탄착
  nearMiss: [
    [1.0, 0.5],
    [3.0, 0.28],
    [8.0, 0.07],
  ],
  impact: { range: 2.5, amount: 0.35 },
  max: 1.6,
};

export class EnemyManager {
  /**
   * @param {object} truth {player, body, weapon} — 인지 시스템에만 넘긴다
   */
  constructor(scene, world, events, bullets, truth) {
    this.scene = scene;
    this.world = world;
    this.events = events;
    this.bullets = bullets;
    this.enemies = [];
    this.units = [];
    this.dummies = []; // 디버그 더미: 교전 집계·AI 밖, 탄 판정만
    this.time = 0;
    this.cover = new CoverMap(world);
    this.nav = new NavGrid(world);
    this.senses = new Senses(world, events, truth);
    this.senses.log = new AILog();
    console.info(`[ai] cover points ${this.cover.points.length} (${this.cover.buildMs.toFixed(0)} ms), nav ${this.nav.N}² (${this.nav.buildMs.toFixed(0)} ms)`);
    this.ctx = {
      world,
      events,
      scene,
      enemies: this.enemies,
      cover: this.cover,
      nav: this.nav,
      sight: this.senses.sight,
      time: () => this.time,
      others: (e) => this._others(e),
      muzzleClear: (e, p) => this._muzzleClear(e, p),
    };
    const qs = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.seed = Number(qs.get('seed')) || Date.now() % 1e9;
    // ?seed=… 이면 실행 중 난수도 고정(같은 상황 재현용)
    if (qs.get('seed')) rng.s = this.seed >>> 0;
    this._spawnAll();

    bullets.addTargetProvider((x0, y0, z0, dx, dy, dz, hits, b) => {
      for (const e of this.enemies) {
        // 쏜 사람 자기 몸은 총구에서 2.5 m까지 빼고
        if (b && b.shooter === e.id && b.dist < 2.5) continue;
        e.intersect(x0, y0, z0, dx, dy, dz, hits);
      }
      for (const d of this.dummies) d.intersect(x0, y0, z0, dx, dy, dz, hits);
    });
    bullets.nearMissProvider = (b, x0, y0, z0, dx, dy, dz) => this._nearMiss(b, x0, y0, z0, dx, dy, dz);
    events.on('bullet:impact', (ev) => {
      if (ev.kind === 'body' && ev.target) ev.target.lastHitDir = ev.dir;
      if (ev.shooter !== 'player') return;
      for (const e of this.enemies) {
        if (!e.canPerceive() || (ev.kind === 'body' && ev.target === e)) continue;
        const d = Math.hypot(e.x - ev.x, e.z - ev.z);
        if (d < SUPPRESSION.impact.range) {
          e.supp = Math.min(SUPPRESSION.max, e.supp + SUPPRESSION.impact.amount * (1 - d / SUPPRESSION.impact.range) + 0.1);
          e.brain.onSuppress({ type: 'impact', distance: d, dir: ev.dir });
        }
      }
    });
    events.on('enemy:hit', (ev) => {
      if (ev.enemy.dummy) return; // 더미가 맞은 것은 적에게 '동료 피격'이 아니다
      for (const e of this.enemies) {
        if (e === ev.enemy || !e.canPerceive()) continue;
        const d = Math.hypot(e.x - ev.enemy.x, e.z - ev.enemy.z);
        if (d < 25) {
          e.supp = Math.min(SUPPRESSION.max, e.supp + 0.25 * (1 - d / 25));
          e.brain.onSuppress({ type: 'allyHit', distance: d, dir: ev.enemy.lastHitDir || null });
        }
      }
    });
    events.on('enemy:down', (ev) => {
      const e = ev.enemy;
      if (e._casualty) return;
      e._casualty = true;
      e.unit?.onCasualty(e);
    });
  }

  // ---------------------------------------------------------------------------
  _spawnAll() {
    const R = new Random(this.seed >>> 0);
    this.rand = R;
    const layout = this.world.layout;
    for (const def of SCENARIO.units) {
      const unit = new Unit(def, this.ctx);
      this.units.push(unit);
      const belt = layout.beltById[def.belt];
      const sign = belt.sideSign(def.side);
      const size = def.teams.reduce((a, t) => a + t.size, 0) + (def.leader ? 1 : 0);
      const spread = def.kind === 'squad' ? 45 : 28;
      const u0 = R.range(def.u[0] + spread * 0.6, def.u[1] - spread * 0.6);
      // 바깥(플레이어 쪽) 방위
      const outN = { x: belt.n[0] * sign, z: belt.n[1] * sign };
      const look = Math.atan2(outN.x, -outN.z);
      const placed = [];
      const pickRole = (k) => {
        if (k < 2) return 'guard';
        return R.weighted(SCENARIO.startRoles);
      };
      let k = 0;
      const mk = (teamId, role, idx) => {
        const r = pickRole(k++);
        let pos = null;
        for (let tries = 0; tries < 40 && !pos; tries++) {
          const u = u0 + R.range(-spread, spread) + (teamId === 'A' ? -spread * 0.3 : teamId === 'B' ? spread * 0.3 : 0);
          const v = r === 'guard' ? sign * (belt.half - R.range(0.3, 1.8)) : sign * R.range(-belt.half * 0.5, belt.half * 0.6);
          const p = belt.toWorld(u, v);
          if (placed.every((q) => Math.hypot(q[0] - p.x, q[1] - p.z) > 5)) pos = [p.x, p.z];
        }
        if (!pos) {
          const p = belt.toWorld(u0 + R.range(-spread, spread), 0);
          pos = [p.x, p.z];
        }
        placed.push(pos);
        const id = `${def.id}-${teamId || 'L'}${idx}`;
        const edef = { id, pos, role: r, look: look + (r === 'guard' ? R.range(-0.3, 0.3) : R.range(-2, 2)), stance: 'kneel', speed: R.range(0.95, 1.25) };
        if (r === 'patrol') {
          const route = [];
          for (let q = 0; q < 4; q++) {
            const pp = belt.toWorld(u0 + R.range(-spread, spread), sign * R.range(-belt.half * 0.4, belt.half * 0.5));
            route.push([pp.x, pp.z]);
          }
          edef.route = route;
        }
        if (r === 'guard') edef.stance = this._guardStance(pos, look);
        const e = this._spawn(edef, R);
        unit.add(e, teamId, role);
        return e;
      };
      if (def.leader) mk(null, 'leader', 0);
      for (const t of def.teams) for (let q = 0; q < t.size; q++) mk(t.id, q === 0 ? 'teamLeader' : 'rifleman', q + 1);
      void size;
    }
    // 무전 상대
    for (const u of this.units) u.peers = (u.def.radio || []).map((id) => this.units.find((x) => x.id === id)).filter(Boolean);
  }

  /** 경계 자리 자세: 무릎 눈높이에서 바깥 80 m가 보이면 무릎, 아니면 서서(가장자리 풀·덤불 너머) */
  _guardStance(pos, look) {
    const T = this.world.terrain;
    const gy = T.heightAt(pos[0], pos[1]);
    const tx = pos[0] + Math.sin(look) * 80;
    const tz = pos[1] - Math.cos(look) * 80;
    const ty = T.heightAt(tx, tz) + 1.0;
    const s = this.senses.sight;
    if (s.transmission(pos[0], gy + 1.0, pos[1], tx, ty, tz) > 0.3) return 'kneel';
    return 'stand';
  }

  _spawn(def, R) {
    const e = new Enemy(def, this.ctx);
    const S = SCENARIO.skill;
    e.skill = {
      sway: R.range(S.sway[0], S.sway[1]),
      reaction: R.range(S.reaction[0], S.reaction[1]),
      rangeError: R.range(S.rangeError[0], S.rangeError[1]),
      vision: R.range(S.vision[0], S.vision[1]),
    };
    e.knowledge = new ThreatKnowledge();
    e.brain = new Brain(e, this.ctx);
    e.shooter = new Shooter(e, { bullets: this.bullets, events: this.events, time: () => this.time }, e.skill);
    this.senses.register(e);
    this.enemies.push(e);
    return e;
  }

  reset() {
    for (const e of this.enemies) {
      this.scene.remove(e.group);
      if (e.rifle.parent === this.scene) this.scene.remove(e.rifle);
      this.senses.unregister(e);
    }
    for (const d of this.dummies) {
      this.scene.remove(d.group);
      if (d.rifle.parent === this.scene) this.scene.remove(d.rifle);
    }
    this.enemies.length = 0;
    this.units.length = 0;
    this.dummies.length = 0;
    this._dbgUnit = null;
    this.cover.releaseAllOccupants?.();
    for (const p of this.cover.points) p.occ = null;
    this.nav.queue.length = 0;
    this.nav.active = null;
    this.senses.reset();
    this.senses.log.clear();
    this.time = 0;
    this.ended = false;
    this.seed = (this.seed * 1103515245 + 12345) % 1e9;
    this._spawnAll();
  }

  // ---------------------------------------------------------------------------
  // 디버그: 소환
  /** 적 한 명 소환(조준점). 소환조(부대)에 들어가 다른 적과 같은 인지·두뇌·소총으로 움직인다 — 처음엔 플레이어를 모른다. */
  spawnDebugEnemy(x, z, look) {
    if (!this._dbgUnit) {
      const def = { id: 'DBG', name: '소환조', kind: 'team', teams: [{ id: 'D', name: '소환조', size: 0 }], leader: false, withdrawBelt: 'N', radio: [] };
      this._dbgUnit = new Unit(def, this.ctx);
      this._dbgUnit.peers = [];
      this.units.push(this._dbgUnit);
    }
    const u = this._dbgUnit;
    const n = u.members.length + 1;
    const e = this._spawn({ id: `DBG-D${n}`, pos: [x, z], role: 'guard', look, stance: 'kneel', speed: 1.1 }, rng);
    u.add(e, 'D', n === 1 ? 'teamLeader' : 'rifleman');
    // 교전이 끝났다고 판정된 뒤라도 새 적이 있으면 다시 센다
    this.ended = false;
    return e;
  }

  /** 더미 생성(조준점): 서 있는 표적. 보지도 쏘지도 움직이지도 않고, 맞으면 적과 같은 부상 모델로 쓰러진다. */
  spawnDummy(x, z, look) {
    const n = this.dummies.length + 1;
    const d = new Enemy({ id: `더미${n}`, pos: [x, z], role: 'guard', look, stance: 'stand' }, this.ctx);
    d.dummy = true;
    this.dummies.push(d);
    return d;
  }

  _others(self) {
    const out = this._oth || (this._oth = []);
    out.length = 0;
    for (const e of this.enemies) {
      if (e === self || e.state === 'dead') continue;
      out.push({ x: e.x, z: e.z });
      if (e.brain.cover) out.push({ x: e.brain.cover.x, z: e.brain.cover.z });
      if (e.moveTarget) out.push({ x: e.moveTarget[0], z: e.moveTarget[1] });
    }
    return out;
  }

  /** 쏴도 되는가: 총구 앞 2.5 m가 단단한 물체(줄기·통나무·흙)에 막히지 않았고, 사선 위에 동료가 없다 */
  _muzzleClear(e, p) {
    if (e._mcT !== undefined && this.time - e._mcT < 0.25) return e._mcV;
    const m = e.muzzleWorld(this._mz || (this._mz = { x: 0, y: 0, z: 0 }));
    const dx = p.x - m.x;
    const dy = p.y - m.y;
    const dz = p.z - m.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const k = Math.min(2.5, l) / l;
    const T = this.senses.sight.transmission(m.x, m.y, m.z, m.x + dx * k, m.y + dy * k, m.z + dz * k, { skipLast: 0 });
    let ok = T > 0;
    // 사선 위 동료(가슴에서 1.3 m 안을 지나면 쏘지 않는다)
    if (ok) {
      for (const o of this.enemies) {
        if (o === e || o.state === 'dead' || o.withdrawn) continue;
        if (Math.abs(o.x - m.x) > l + 2 && Math.abs(o.z - m.z) > l + 2) continue;
        const c = o.chestWorld;
        const r = pointSegDistance(c.x, c.y, c.z, m.x, m.y, m.z, dx, dy, dz);
        if (r.d < 1.3 && r.t > 0.01 && r.t < 1) {
          ok = false;
          e._friendInLane = o;
          break;
        }
      }
    }
    e._mcT = this.time;
    e._mcV = ok;
    return ok;
  }

  /** 탄이 적 옆을 지남: 초음속이면 '딱'(인지: 방향 혼동·딱-쾅 거리), 가까우면 제압 */
  _nearMiss(b, x0, y0, z0, dx, dy, dz) {
    if (b.shooter !== 'player') return;
    const sp = Math.hypot(b.vx, b.vy, b.vz) || 1;
    for (const e of this.enemies) {
      if (!e.canPerceive() || b.notified.includes(e.id)) continue;
      if (Math.abs(e.x - x0) > 40 || Math.abs(e.z - z0) > 40) continue;
      const c = e.chestWorld;
      const r = pointSegDistance(c.x, c.y, c.z, x0, y0, z0, dx, dy, dz);
      if (!(r.t > 0 && r.t < 1) || r.d > 30) continue;
      b.notified.push(e.id);
      const g = flybyGeometry(x0 + dx * r.t, y0 + dy * r.t, z0 + dz * r.t, b.vx / sp, b.vy / sp, b.vz / sp, sp, r.d, c);
      if (g.supersonic) this.senses.crack(e, { shotId: b.id, distance: r.d, emit: g.emit, supersonic: true });
      // 제압: 가까울수록 크게(아음속 '휙'은 아주 가까울 때만)
      let s = 0;
      const tab = SUPPRESSION.nearMiss;
      if (r.d < tab[0][0]) s = tab[0][1];
      else if (r.d < tab[1][0]) s = tab[1][1] + (tab[0][1] - tab[1][1]) * (1 - (r.d - tab[0][0]) / (tab[1][0] - tab[0][0]));
      else if (r.d < tab[2][0] && isSupersonic(sp)) s = tab[2][1];
      if (s > 0) {
        e.supp = Math.min(SUPPRESSION.max, e.supp + s);
        e.brain.onSuppress({ type: 'nearMiss', distance: r.d, dir: { x: b.vx / sp, y: b.vy / sp, z: b.vz / sp } });
      }
    }
  }

  // ---------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    this.senses.update(dt);
    this.nav.update();
    for (const u of this.units) u.update(dt);
    this._casualtyAid();
    for (const e of this.enemies) {
      e.brain.update(dt);
      e.update(dt);
      const sh = e.shooter;
      const st = e.stance === 'prone' || e.state === 'down' ? 'prone' : e.stance === 'kneel' ? 'crouch' : 'stand';
      const c = e.brain.cover;
      const rested = c && Math.hypot(c.x - e.x, c.z - e.z) < 1.2 ? (c.kind === 'trunk' || c.kind === 'bale' ? 'trunk' : 'ground') : null;
      const wound = e.state === 'down' ? 2.3 : e.clutch === 'arm' ? 3 : e.clutch === 'chest' ? 2 : 1;
      sh.update(dt, { stance: st, speed: e.speed, supp: Math.min(1, e.supp), rest: rested, wound });
    }
    for (const d of this.dummies) d.update(dt);
    this._checkEnd();
  }

  /** 부상자 구조 배정: 위협에서 가려진 자리의 부상자, 제압당하지 않은 가장 가까운 동료 */
  _casualtyAid() {
    if (this.time - (this._aidT || 0) < 2) return;
    this._aidT = this.time;
    for (const cas of this.enemies) {
      if (cas.state !== 'down' || cas.dead || cas.dragged || cas.dragBy || !cas.unit) continue;
      const pic = cas.unit.picture();
      if (pic) {
        const k = this.nav.idx(cas.x, cas.z);
        if (k >= 0 && this.nav.exposure(k, pic) > 0.2) continue; // 보이는 자리면 위험
      }
      let best = null;
      let bd = 40;
      for (const m of cas.unit.alive) {
        if (m.supp > 0.4 || m.role === 'leader' || m.brain.task.type === 'aid' || m.brain.task.type === 'move') continue;
        const d = Math.hypot(m.x - cas.x, m.z - cas.z);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      if (best) {
        best.brain.task = { type: 'aid', casualty: cas };
        cas.dragBy = null;
      }
    }
  }

  _checkEnd() {
    if (this.ended) return;
    let active = 0;
    let down = 0;
    let withdrawn = 0;
    for (const e of this.enemies) {
      if (e.withdrawn) withdrawn++;
      else if (e.state === 'normal') active++;
      else if (e.state === 'down' && !e.incapacitated && !e.dead && e.rifleHeld) active++;
      else down++;
    }
    this.counts = { active, down, withdrawn, total: this.enemies.length };
    if (active === 0) {
      this.ended = true;
      this.events.emit('engagement:end', { reason: 'enemies', ...this.counts });
    }
  }

  get aliveCount() {
    return this.enemies.filter((e) => e.state === 'normal' && !e.withdrawn).length;
  }
}
