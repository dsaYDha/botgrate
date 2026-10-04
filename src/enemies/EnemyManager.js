// 적 생성·갱신, 시나리오 초기화(P), 탄 충돌 공급자, 근탄·근처 탄착·동료 피격 → 제압 반응 전달,
// 들판 횡단자 주기 생성.

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
    this.ctx = { world, events, scene };
    for (const def of SCENARIO.enemies) this._spawn(structuredClone(def));
    this.crossTimer = rng.range(SCENARIO.crossers.interval[0], SCENARIO.crossers.interval[1]);
    this.crosserCount = 0;

    bullets.addTargetProvider((x0, y0, z0, dx, dy, dz, hits) => {
      for (const e of this.enemies) e.intersect(x0, y0, z0, dx, dy, dz, hits);
    });
    // 근탄: 탄 선분이 머리·가슴에서 3 m 이내로 지나가면 제압 반응
    bullets.nearMissProvider = (b, x0, y0, z0, dx, dy, dz) => {
      for (const e of this.enemies) {
        if (e.state !== 'normal' || b.notified.includes(e.id)) continue;
        if (Math.abs(e.x - x0) > 40 || Math.abs(e.z - z0) > 40) continue;
        const c = e.chestWorld;
        const r = pointSegDistance(c.x, c.y, c.z, x0, y0, z0, dx, dy, dz);
        if (r.d < 3.0) {
          b.notified.push(e.id);
          const sp = Math.hypot(b.vx, b.vy, b.vz) || 1;
          e.brain.onSuppress({ type: 'nearMiss', distance: r.d, dir: { x: b.vx / sp, y: b.vy / sp, z: b.vz / sp } });
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
    e.brain = new Brain(e, { world: this.world, findCover: (en, threat, radius) => this.findCover(en, threat, radius) });
    this.enemies.push(e);
    return e;
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

  /** 위협 반대편의 굵은 나무(직경 ≥ 25 cm)·통나무·흙둔덕 뒤 위치 */
  findCover(e, threat, radius) {
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
        const def = { id: `x${++this.crosserCount}`, behavior: 'cross', waypoints: route, speed: rng.range(1.25, 1.6), spawned: true };
        this._spawn(def);
      }
    }
  }

  get aliveCount() {
    return this.enemies.filter((e) => e.state === 'normal').length;
  }
}
