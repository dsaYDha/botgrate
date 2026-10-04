// 적 판단. 1단계: 경계·순찰·들판 횡단 + 근탄·근처 탄착·동료 피격에 대한 기초 반응
// (즉시 엎드리거나 가까운 굵은 나무·둔덕·통나무 뒤로 이동 → 10~30 s 숨기 → 조심스럽게 재개).
//
// 2단계(적 AI·반격)를 붙일 자리:
//   Perception.canSee/onSound  — 시야·청각(총성 'shot' 이벤트, 탄 스침 'bullet:flyby')
//   Brain.combat               — 사격 결정. 적 사격은 BulletSystem.fire({shooter: this.enemy.id, ...})를 그대로 쓰면 된다.
//   Brain.squad                — 분대 전술(엄호·기동).

import { clamp, lerp, wrapAngle } from '../core/math.js';
import { rng } from '../core/Random.js';

export class Perception {
  constructor(enemy) {
    this.enemy = enemy;
  }
  /** 2단계: 시선 검사(풀·잎 은폐, 거리, 조명). 1단계는 항상 못 봄. */
  canSee(/* target */) {
    return false;
  }
  /** 2단계: 소리 인지(총성 방향 추정 등). 1단계는 무시. */
  onSound(/* ev */) {}
}

const DEG = Math.PI / 180;

export class Brain {
  constructor(enemy, ctx) {
    this.enemy = enemy;
    this.ctx = ctx; // {world, findCover}
    this.perception = new Perception(enemy);
    this.combat = null; // 2단계
    this.reset();
  }

  reset() {
    const d = this.enemy.def;
    this.mode = d.behavior; // guard | patrol | cross
    this.home = d.behavior;
    this.wp = 1 % ((d.waypoints && d.waypoints.length) || 1);
    this.wait = rng.range(0, 3);
    this.alertUntil = 0;
    this.reactAt = -1;
    this.hideUntil = 0;
    this.threat = null; // 위협 방향(적 → 사수, 수평 단위벡터)
    this.lookTimer = 0;
    this.lookTarget = 0;
    this.time = 0;
    this.pendingReaction = null;
    this.finished = false;
  }

  /** 근탄·근처 탄착·동료 피격 */
  onSuppress(info) {
    const e = this.enemy;
    if (e.state !== 'normal') return;
    // 위협 방향: 탄이 날아온 반대 방향
    if (info.dir) {
      const l = Math.hypot(info.dir.x, info.dir.z) || 1;
      this.threat = { x: -info.dir.x / l, z: -info.dir.z / l };
    }
    if (this.mode === 'hide' || this.mode === 'toCover' || this.mode === 'dropping') {
      this.hideUntil = Math.max(this.hideUntil, this.time + rng.range(10, 30));
      return;
    }
    if (!this.pendingReaction) {
      // 사람의 반응 시간
      this.pendingReaction = { at: this.time + rng.range(0.18, 0.55), info };
    }
  }

  onWounded(kind) {
    this.pendingReaction = null;
    const e = this.enemy;
    if (kind === 'arm' || kind === 'lung') {
      // 정상 행동 불가: 엄폐물 쪽으로 몸을 숨기러 감
      const cover = this.ctx.findCover(e, this.threat, 12);
      if (cover) {
        this.mode = 'toCover';
        this.coverPos = cover;
        e.setStance('stand');
        e.setMove(cover, kind === 'lung' ? 1.4 : 3.0);
      } else {
        this.mode = 'dropping';
        e.setStance('prone');
        e.setMove(null, 0);
      }
      this.hideUntil = this.time + 1e6;
    }
  }

  onCrawlStart() {
    const e = this.enemy;
    const cover = this.ctx.findCover(e, this.threat, 15);
    if (cover) e.setMove(cover, 0);
  }

  _react() {
    const e = this.enemy;
    const cover = rng.next() < 0.75 ? this.ctx.findCover(e, this.threat, 9) : null;
    if (cover) {
      this.mode = 'toCover';
      this.coverPos = cover;
      e.setStance('crouchMove');
      e.setMove(cover, 4.2);
    } else {
      this.mode = 'dropping';
      e.setStance('prone');
      e.setMove(null, 0);
    }
    this.hideUntil = this.time + rng.range(10, 30);
  }

  update(dt) {
    this.time += dt;
    const e = this.enemy;
    if (e.state !== 'normal') return;
    if (this.pendingReaction && this.time >= this.pendingReaction.at) {
      this.pendingReaction = null;
      this._react();
    }
    switch (this.mode) {
      case 'guard':
        this._guard(dt);
        break;
      case 'patrol':
      case 'cross':
        this._followPath(dt);
        break;
      case 'toCover':
        if (!e.moveTarget) {
          this.mode = 'hide';
          // 나무 뒤에서는 무릎, 낮은 둔덕·통나무 뒤에서는 엎드림
          e.setStance(this.coverPos && this.coverPos.low ? 'prone' : 'kneel');
        }
        this._faceThreat(dt);
        break;
      case 'dropping':
        this.mode = 'hide';
        break;
      case 'hide':
        this._faceThreat(dt);
        if (this.time > this.hideUntil) {
          this.mode = 'cautious';
          this.cautiousUntil = this.time + rng.range(20, 40);
          e.setStance('stand');
        }
        break;
      case 'cautious':
        // 조심스럽게: 낮은 자세로 천천히 원래 행동
        if (this.home === 'guard') {
          e.setStance('kneel');
          this._guard(dt);
        } else {
          e.setStance('crouchMove');
          this._followPath(dt, 0.6);
        }
        if (this.time > this.cautiousUntil) {
          this.mode = this.home;
          e.setStance(this.home === 'guard' ? e.def.pose || 'stand' : 'stand');
        }
        break;
      default:
        break;
    }
  }

  _guard(dt) {
    const e = this.enemy;
    const d = e.def;
    const look = d.look || [0, 360];
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rng.range(2.5, 7);
      this.lookTarget = lerp(look[0], look[1], rng.next()) * DEG;
    }
    const rel = wrapAngle(this.lookTarget - e.heading);
    // 머리만 돌리다가 크게 벗어나면 몸을 돌림
    if (Math.abs(rel) > 0.9) e.heading += clamp(rel, -1.2 * dt, 1.2 * dt);
    e.lookYaw = lerp(e.lookYaw, clamp(-rel, -1.0, 1.0), 1 - Math.exp(-dt * 2));
    e.lookPitch = Math.sin(this.time * 0.3) * 0.05;
    if (d.pos && Math.hypot(e.x - d.pos[0], e.z - d.pos[1]) > 0.5 && !e.moveTarget && this.mode === 'guard') e.setMove(d.pos, 1.0);
  }

  _followPath(dt, speedMul = 1) {
    const e = this.enemy;
    const wps = e.def.waypoints;
    if (!wps) return;
    if (this.wait > 0) {
      this.wait -= dt;
      e.lookYaw = Math.sin(this.time * 0.7) * 0.6;
      return;
    }
    if (!e.moveTarget) {
      if (this.mode === 'cross' && this.wp >= wps.length) {
        // 횡단 끝: 경계 자세로
        this.mode = 'guard';
        this.home = 'guard';
        e.def.pos = [e.x, e.z];
        e.def.look = [((e.heading / DEG) - 60 + 360) % 360, ((e.heading / DEG) + 60 + 360) % 360];
        return;
      }
      const target = wps[this.wp % wps.length];
      e.setMove(target, (e.def.speed || 1.1) * speedMul);
      this.wp++;
      if (this.mode === 'patrol') this.wait = rng.next() < 0.35 ? rng.range(2, 8) : 0;
    }
    e.lookYaw = lerp(e.lookYaw, Math.sin(this.time * 0.4) * 0.5, 1 - Math.exp(-dt));
  }

  _faceThreat(dt) {
    const e = this.enemy;
    if (!this.threat) return;
    const want = Math.atan2(this.threat.x, -this.threat.z);
    const rel = wrapAngle(want - e.heading);
    if (!e.moveTarget) e.heading += clamp(rel, -1.5 * dt, 1.5 * dt);
    e.lookYaw = lerp(e.lookYaw, 0, 1 - Math.exp(-dt * 3));
  }
}
