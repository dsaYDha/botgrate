// 적 생성·갱신, 시나리오 초기화(P), 탄 충돌 공급자, 근탄·근처 탄착·동료 피격 → 제압 반응 전달,
// 들판 횡단자 주기 생성, 엄폐물·경계 자리 찾기(적끼리 간격 유지).
// 근탄: 초음속 탄이 4 m 안을 지나면 반드시, 4~12 m는 거리에 따라 확률로 '딱' 소리에 반응한다.

import { Enemy } from './Enemy.js';
import { Brain } from '../ai/Brain.js';
import { SCENARIO } from '../data/scenario.js';
import { WORLD } from '../data/world.js';
import { rng } from '../core/Random.js';
import { pointSegDistance } from '../physics/intersect.js';

export class EnemyManager {
  constructor(scene, world, events, bullets) {
    this.scene = scene;
    this.world = world;
    this.events = events;
    this.enemies = [];
    this.ctx = { world, events, scene, enemies: this.enemies };
    for (const def of SCENARIO.enemies) this._spawn(structuredClone(def));
    this.crossTimer = rng.range(SCENARIO.crossers.interval[0], SCENARIO.crossers.interval[1]);
    this.crosserCount = 0;

    bullets.addTargetProvider((x0, y0, z0, dx, dy, dz, hits) => {
      for (const e of this.enemies) e.intersect(x0, y0, z0, dx, dy, dz, hits);
    });
    // 근탄: 초음속 탄 선분이 가슴에서 4 m 안을 지나면 반드시, 4~12 m는 거리에 따라 확률로 반응('딱' 소리).
    // 탄이 지나간 그 순간에 알게 된다(탄보다 먼저 반응할 수 없음). 아음속으로 느려진 탄은 '딱' 소리가 없다.
    bullets.nearMissProvider = (b, x0, y0, z0, dx, dy, dz) => {
      const sp = Math.hypot(b.vx, b.vy, b.vz) || 1;
      if (sp < 345) return;
      for (const e of this.enemies) {
        if (e.state !== 'normal' || b.notified.includes(e.id)) continue;
        if (Math.abs(e.x - x0) > 50 || Math.abs(e.z - z0) > 50) continue;
        const c = e.chestWorld;
        const r = pointSegDistance(c.x, c.y, c.z, x0, y0, z0, dx, dy, dz);
        if (r.d < 12 && r.t > 0 && r.t < 1) {
          b.notified.push(e.id);
          const p = r.d < 4 ? 1 : 0.85 * (1 - (r.d - 4) / 8);
          if (rng.next() < p) e.brain.onSuppress({ type: 'nearMiss', distance: r.d, dir: { x: b.vx / sp, y: b.vy / sp, z: b.vz / sp } });
        }
      }
    };
    events.on('bullet:impact', (ev) => {
      for (const e of this.enemies) {
        if (e.state !== 'normal') continue;
        if (ev.kind === 'body' && ev.target === e) continue;
        const d = Math.hypot(e.x - ev.x, e.z - ev.z);
        if (d < 3.0) e.brain.onSuppress({ type: 'impact', distance: d, dir: ev.dir });
      }
    });
    events.on('enemy:hit', (ev) => {
      for (const e of this.enemies) {
        if (e === ev.enemy || e.state !== 'normal') continue;
        const d = Math.hypot(e.x - ev.enemy.x, e.z - ev.enemy.z);
        if (d < 22) e.brain.onSuppress({ type: 'allyHit', distance: d, dir: ev.enemy.lastHitDir || null });
      }
    });
    events.on('bullet:impact', (ev) => {
      if (ev.kind === 'body' && ev.target) ev.target.lastHitDir = ev.dir;
    });
  }

  _spawn(def) {
    const e = new Enemy(def, this.ctx);
    e.brain = new Brain(e, {
      world: this.world,
      findCover: (en, threat, radius, self) => this.findCover(en, threat, radius, self || en),
      findPosts: (en, center, look, n) => this.findPosts(en, center, look, n),
      clearOf: (x, z, self, r) => this.clearOf(x, z, self, r),
      nearest: (en, r) => this.nearest(en, r),
    });
    this.enemies.push(e);
    return e;
  }

  /** e에서 r 안의 가장 가까운 다른 적(정상 상태) */
  nearest(e, r) {
    let best = null;
    let bd = r;
    for (const o of this.enemies) {
      if (o === e || o.state !== 'normal') continue;
      const d = Math.hypot(o.x - e.x, o.z - e.z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** (x, z)에서 r 안에 다른 적(서 있는 자리·가는 곳)이 없는가 */
  clearOf(x, z, self, r) {
    for (const o of this.enemies) {
      if (o === self || o.state === 'dead') continue;
      if (Math.hypot(o.x - x, o.z - z) < r) return false;
      if (o.moveTarget && Math.hypot(o.moveTarget[0] - x, o.moveTarget[1] - z) < r) return false;
    }
    return true;
  }

  /** 경계 자리: center 둘레 radius 안 나무(지름 ≥ 20 cm) 뒤(바라보는 방향 반대편) 자리 n곳 */
  findPosts(e, center, look, n, radius = 9) {
    const q = [];
    this.world.hash.query(center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius, q);
    const c = [];
    for (const o of q) {
      if (o.kind !== 'trunk' || o.stump || o.r0 < 0.1) continue;
      const d = Math.hypot(o.x - center[0], o.z - center[1]);
      if (d < 2 || d > radius) continue;
      // 관측하려면 숲 가장자리를 따라(옆으로) 옮긴다: 바라보는 방향으로 3.5 m 넘게 깊이 들어가지 않음
      const along = (o.x - center[0]) * look.x + (o.z - center[1]) * look.z;
      if (along < -3.5 || along > 2) continue;
      const px = o.x - look.x * (o.r0 + 0.5);
      const pz = o.z - look.z * (o.r0 + 0.5);
      if (!this.world.terrain.inMap(px, pz)) continue;
      c.push({ x: px, z: pz, stance: rng.weighted({ kneel: 0.55, stand: 0.28, prone: 0.17 }), d });
    }
    c.sort(() => rng.next() - 0.5);
    const out = [];
    for (const p of c) {
      if (out.length >= n) break;
      if (out.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > 3)) out.push(p);
    }
    return out;
  }

  reset() {
    // 횡단자로 추가된 적 제거
    for (const e of this.enemies.filter((x) => x.def.spawned)) {
      this.scene.remove(e.group);
      if (e.rifle.parent === this.scene) this.scene.remove(e.rifle);
    }
    this.enemies = this.enemies.filter((x) => !x.def.spawned);
    const defs = new Map(SCENARIO.enemies.map((d) => [d.id, d]));
    for (const e of this.enemies) {
      e.def = structuredClone(defs.get(e.id));
      if (e.rifle.parent === this.scene) this.scene.remove(e.rifle);
      e.reset();
      e.brain.reset();
    }
    this.crossTimer = rng.range(SCENARIO.crossers.interval[0], SCENARIO.crossers.interval[1]);
  }

  /** 위협 반대편의 굵은 나무(직경 ≥ 25 cm)·통나무·흙둔덕 뒤 위치(다른 적과 5.5 m 이상 떨어진 곳) */
  findCover(e, threat, radius, self = e) {
    const q = [];
    this.world.hash.query(e.x - radius, e.z - radius, e.x + radius, e.z + radius, q);
    const tx = threat ? threat.x : 0;
    const tz = threat ? threat.z : -1;
    let best = null;
    let bestScore = Infinity;
    const consider = (cx, cz, r, low) => {
      // 위협 반대편으로 비켜선 자리
      const px = cx - tx * (r + 0.45);
      const pz = cz - tz * (r + 0.45);
      const d = Math.hypot(px - e.x, pz - e.z);
      if (d > radius) return;
      if (!this.clearOf(px, pz, self, 5.5)) return;
      const score = d + (low ? 1.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = [px, pz];
        best.low = low;
      }
    };
    for (const o of q) {
      if (o.kind === 'trunk' && !o.stump && o.r0 >= 0.125) consider(o.x, o.z, o.r0, false);
      else if (o.kind === 'log') consider((o.ax + o.bx) / 2, (o.az + o.bz) / 2, o.r + 0.1, true);
      else if (o.kind === 'bale') consider(o.x, o.z, o.r + 0.15, false);
      else if (o.kind === 'rootPlate') consider(o.x, o.z, o.r * 0.8, false);
    }
    for (const b of WORLD.berms) {
      if (Math.hypot(b.x - e.x, b.z - e.z) < radius + b.length / 2) consider(b.x, b.z, b.width / 2, true);
    }
    return best;
  }

  update(dt) {
    for (const e of this.enemies) {
      e.brain.update(dt);
      e.update(dt);
    }
    // 들판 횡단자
    this.crossTimer -= dt;
    if (this.crossTimer <= 0) {
      this.crossTimer = rng.range(SCENARIO.crossers.interval[0], SCENARIO.crossers.interval[1]);
      const active = this.enemies.filter((e) => e.brain.mode === 'cross' && e.state === 'normal').length;
      if (active < SCENARIO.crossers.maxConcurrent && this.enemies.length < 24) {
        const route = rng.pick(SCENARIO.crossers.routes);
        // 출발점에 다른 적이 있으면 이번에는 건너뜀(몰려 나오지 않게)
        if (this.clearOf(route[0][0], route[0][1], null, 12)) {
          const def = { id: `x${++this.crosserCount}`, behavior: 'cross', waypoints: route, speed: rng.range(1.25, 1.6), spawned: true };
          this._spawn(def);
        }
      }
    }
  }

  get aliveCount() {
    return this.enemies.filter((e) => e.state === 'normal').length;
  }
}
