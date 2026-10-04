// 적 판단. 1단계: 경계·순찰·들판 횡단 + 근탄·근처 탄착·동료 피격에 대한 반응(2단계의 사격·탐지는 없다).
// 노출을 짧게 하는 실제 보병 습관:
//   경계: 한 자리에 오래 서 있지 않는다. 근처 나무 옆 자리 몇 곳을 8~20 s마다 옮겨 다니며 대개 무릎·엎드려 관측.
//   순찰: 숲 안에서도 서서 오래 멈추지 않고, 멈출 때는 무릎. 구간마다 낮은 자세로 걷기도 한다.
//   들판 횡단: 직선 행군이 아니라 3~5 s 짧은 약진(질주) → 엎드리거나 무릎(2~6 s) → 다시 약진. 약진마다 옆으로 비틀고 속도가 다르다.
//   적끼리 5~6 m 이상 떨어진 자리를 고른다.
// 근탄(초음속 탄이 가까이 스치는 '딱')·근처 탄착·동료 피격 → 0.3~0.8 s 뒤 엎드리거나 가까운 엄폐물로.
// 탄이 도착하기 전에는 반응하지 못한다(첫 발이 가장 중요). 숨은 뒤에는 2~4 s씩 내다보고(줄기 반대쪽·다른 높이),
// 몇 번 내다본 뒤 수 m 옆 다른 엄폐물로 옮겨 다시 나온다.
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
// 반응·노출 시간(s)
export const BEHAVIOR = {
  reaction: [0.3, 0.8], // 근탄을 듣고 몸을 움직이기 시작할 때까지
  postObserve: [8, 20], // 경계 자리 한 곳에서 관측하는 시간
  rush: [3, 5], // 들판 약진 한 번
  rushSpeed: [3.6, 5.2], // m/s
  rushPause: [2, 6], // 약진 사이 엎드려/무릎
  hideFirst: [4, 9], // 숨고 처음 내다보기까지
  peek: [2, 4], // 내다보는 노출 시간
  peekGap: [4, 10], // 내다보기 사이
  peeks: [1, 3], // 옮기기 전 내다보는 횟수
  spacing: 5.5, // 적끼리 최소 간격(m)
};

export class Brain {
  constructor(enemy, ctx) {
    this.enemy = enemy;
    this.ctx = ctx; // {world, findCover(e, threat, radius, avoid), findPosts(e, center, look, n), clearOf(x, z, self, r), nearest(e, r)}
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
    this.reactAt = -1;
    this.hideUntil = 0;
    this.threat = null; // 위협 방향(적 → 사수, 수평 단위벡터)
    this.lookTimer = 0;
    this.lookTarget = 0;
    this.time = 0;
    this.pendingReaction = null;
    this.finished = false;
    this.posts = null;
    this.postIdx = 0;
    this.postUntil = rng.range(BEHAVIOR.postObserve[0], BEHAVIOR.postObserve[1]);
    this.rush = null; // 들판 약진 상태
    this.hide = null; // 숨기·내다보기 상태
    this.legStance = 'stand';
    this.onLeg = false;
    this.detour = null;
    this.yieldLeg = null;
  }

  get _lookDir() {
    const d = this.enemy.def;
    const look = d.look || [0, 360];
    const a = ((look[0] + look[1]) / 2) * DEG;
    return { x: Math.sin(a), z: -Math.cos(a) };
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
    if (this.mode === 'hide' || this.mode === 'toCover' || this.mode === 'down' || this.mode === 'relocate') {
      // 숨어 있는 중: 더 오래 숨고, 내다보던 중이면 바로 다시 숨는다
      if (this.hide) {
        this.hide.peeksLeft = Math.max(this.hide.peeksLeft, 1);
        if (this.hide.peeking) this._endPeek();
        this.hide.next = Math.max(this.hide.next, this.time + rng.range(6, 14));
      }
      this.hideUntil = Math.max(this.hideUntil, this.time + rng.range(10, 25));
      return;
    }
    if (!this.pendingReaction) {
      // 사람의 반응 시간(소리를 듣고 판단해 몸을 던지기까지)
      this.pendingReaction = { at: this.time + rng.range(BEHAVIOR.reaction[0], BEHAVIOR.reaction[1]), info };
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
        this.mode = 'down';
        e.setStance('prone');
        e.setMove(null, 0);
      }
      this.hide = null;
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
    const cover = rng.next() < 0.8 ? this.ctx.findCover(e, this.threat, 9) : null;
    this.rush = null;
    if (cover) {
      this.mode = 'toCover';
      this.coverPos = cover;
      e.setStance('crouchMove');
      e.setMove(cover, rng.range(3.8, 4.8));
    } else {
      // 엄폐물이 없으면 그 자리에 엎드린다(그루터기 밭이면 정면에서 거의 머리만 보인다)
      this.mode = 'down';
      e.setStance('prone');
      e.setMove(null, 0);
      this.downUntil = this.time + rng.range(6, 15);
    }
    this.hide = null;
    this.hideUntil = this.time + rng.range(15, 35);
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
        this._followPath(dt);
        break;
      case 'cross':
        this._cross(dt);
        break;
      case 'toCover':
        if (!e.moveTarget) this._startHide();
        this._faceThreat(dt);
        break;
      case 'down':
        this._faceThreat(dt);
        if (this.time > this.downUntil) {
          // 엎드린 자리에서 수 m 옆 엄폐물로 기어가거나, 횡단 중이면 비튼 방향으로 다시 약진
          if (this.home === 'cross') {
            this.mode = 'cross';
            this.rush = null;
            this.rushPause = 0;
          } else this._relocate(true);
        }
        break;
      case 'hide':
        this._hideUpdate(dt);
        break;
      case 'relocate':
        this._faceThreat(dt);
        if (!e.moveTarget) {
          this.mode = 'cautious';
          this.cautiousUntil = this.time + rng.range(20, 40);
          // 다시 나올 때는 다른 높이로
          e.setStance(this.coverPos && this.coverPos.low ? 'prone' : rng.next() < 0.7 ? 'kneel' : 'stand');
          if (this.home === 'guard') {
            e.def.pos = [e.x, e.z];
            this.posts = null;
          }
        }
        break;
      case 'cautious':
        // 조심스럽게: 낮은 자세로 원래 행동
        if (this.home === 'guard') this._guard(dt, true);
        else if (this.home === 'cross') this._cross(dt);
        else this._followPath(dt, 0.7, true);
        if (this.time > this.cautiousUntil) this.mode = this.home;
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // 경계: 근처 나무 옆 자리 몇 곳을 옮겨 다니며 관측(서서는 짧게)
  _guard(dt, cautious = false) {
    const e = this.enemy;
    const d = e.def;
    if (!this.posts) {
      const center = d.pos || [e.x, e.z];
      this.posts = [{ x: center[0], z: center[1], stance: d.pose === 'kneel' ? 'kneel' : 'stand' }, ...this.ctx.findPosts(e, center, this._lookDir, 3)];
      this.postIdx = 0;
    }
    const post = this.posts[this.postIdx];
    if (!e.moveTarget) {
      if (Math.hypot(e.x - post.x, e.z - post.z) > 0.6) {
        e.setStance('crouchMove');
        e.setMove([post.x, post.z], rng.range(1.1, 1.6));
      } else {
        e.setStance(cautious && post.stance === 'stand' ? 'kneel' : post.stance);
        this.postUntil -= dt;
        if (this.postUntil <= 0) {
          // 다른 자리로(다른 적과 겹치지 않게)
          let next = this.postIdx;
          for (let tries = 0; tries < 4; tries++) {
            const k = rng.int(0, this.posts.length - 1);
            if (k !== this.postIdx && this.ctx.clearOf(this.posts[k].x, this.posts[k].z, e, BEHAVIOR.spacing)) {
              next = k;
              break;
            }
          }
          this.postIdx = next;
          this.postUntil = rng.range(BEHAVIOR.postObserve[0], BEHAVIOR.postObserve[1]);
          const p = this.posts[next];
          p.stance = rng.weighted({ kneel: 0.55, stand: 0.28, prone: 0.17 });
        }
      }
    }
    // 머리만 돌리다가 크게 벗어나면 몸을 돌림
    const look = d.look || [0, 360];
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rng.range(2.5, 7);
      this.lookTarget = lerp(look[0], look[1], rng.next()) * DEG;
    }
    if (!e.moveTarget) {
      const rel = wrapAngle(this.lookTarget - e.heading);
      if (Math.abs(rel) > 0.9) e.heading += clamp(rel, -1.2 * dt, 1.2 * dt);
      e.lookYaw = lerp(e.lookYaw, clamp(-rel, -1.0, 1.0), 1 - Math.exp(-dt * 2));
      e.lookPitch = Math.sin(this.time * 0.3) * 0.05;
    }
  }

  // 순찰: 구간마다 서서 걷기 또는 낮은 자세, 멈출 때는 무릎. 다른 적과 붙으면 양보하거나 비켜 간다.
  _followPath(dt, speedMul = 1, low = false) {
    const e = this.enemy;
    const wps = e.def.waypoints;
    if (!wps) return;
    if (e.moveTarget) {
      this._keepApart();
      e.lookYaw = lerp(e.lookYaw, Math.sin(this.time * 0.4) * 0.5, 1 - Math.exp(-dt));
      return;
    }
    // 비켜 가기 끝 → 원래 목표로
    if (this.detour) {
      e.setStance(this.legStance);
      e.setMove(this.detour.resume, this.detour.speed);
      this.detour = null;
      return;
    }
    // 구간 끝: 가끔 무릎 꿇고 멈춰 관측
    if (this.onLeg) {
      this.onLeg = false;
      this.wait = rng.next() < 0.4 ? rng.range(2, 6) : 0;
    }
    if (this.wait > 0) {
      this.wait -= dt;
      e.setStance('kneel');
      e.lookYaw = Math.sin(this.time * 0.7) * 0.6;
      return;
    }
    // 양보하느라 멈췄던 구간 다시
    if (this.yieldLeg) {
      e.setStance(this.legStance);
      e.setMove(this.yieldLeg.target, this.yieldLeg.speed);
      this.yieldLeg = null;
      this.onLeg = true;
      return;
    }
    const target = wps[this.wp % wps.length];
    // 경로 위 같은 자리로 몰리지 않게 옆으로 조금
    const jx = target[0] + rng.range(-1.5, 1.5);
    const jz = target[1] + rng.range(-1.5, 1.5);
    this.legStance = low || rng.next() < 0.45 ? 'crouchMove' : 'stand';
    e.setStance(this.legStance);
    e.setMove([jx, jz], (e.def.speed || 1.1) * speedMul * (this.legStance === 'crouchMove' ? 0.8 : 1));
    this.onLeg = true;
    this.wp++;
  }

  /** 걷다가 다른 적과 4.5 m 안으로 붙으면: 둘 다 움직이면 한쪽이 무릎 꿇고 기다리고, 서 있는 적 옆이면 크게 돌아간다 */
  _keepApart() {
    const e = this.enemy;
    const o = this.ctx.nearest(e, 4.5);
    if (!o) return;
    if (o.moveTarget && e.id > o.id) {
      this.yieldLeg = { target: e.moveTarget, speed: e.moveSpeed };
      e.setMove(null, 0);
      this.onLeg = false;
      this.wait = rng.range(2.5, 4.5);
    } else if (!o.moveTarget && !this.detour) {
      const dx = e.moveTarget[0] - e.x;
      const dz = e.moveTarget[1] - e.z;
      const L = Math.hypot(dx, dz) || 1;
      if (L < 3) return;
      const nx = -dz / L;
      const nz = dx / L;
      const side = (o.x - e.x) * nx + (o.z - e.z) * nz > 0 ? -1 : 1;
      this.detour = { resume: e.moveTarget, speed: e.moveSpeed };
      e.setMove([o.x + nx * side * 6, o.z + nz * side * 6], e.moveSpeed);
    }
  }

  // 들판 횡단: 짧은 약진 → 엎드리거나 무릎 → 다시 약진
  _cross(dt) {
    const e = this.enemy;
    const wps = e.def.waypoints;
    if (!wps) return;
    if (this.rushPause > 0) {
      this.rushPause -= dt;
      e.lookYaw = Math.sin(this.time * 0.9) * 0.5;
      return;
    }
    if (!this.rush || !e.moveTarget) {
      if (this.rush) {
        // 약진 끝: 엎드리거나 무릎
        e.setStance(rng.next() < 0.6 ? 'prone' : 'kneel');
        e.setMove(null, 0);
        this.rushPause = rng.range(BEHAVIOR.rushPause[0], BEHAVIOR.rushPause[1]);
        this.rush = null;
        return;
      }
      if (this.wp >= wps.length) {
        // 횡단 끝: 경계 자세로
        this.mode = 'guard';
        this.home = 'guard';
        e.def.pos = [e.x, e.z];
        e.def.look = [((e.heading / DEG) - 60 + 360) % 360, ((e.heading / DEG) + 60 + 360) % 360];
        this.posts = null;
        return;
      }
      // 다음 약진: 경로 방향으로 3~5 s 거리, 옆으로 비틂
      const target = wps[this.wp];
      const dx = target[0] - e.x;
      const dz = target[1] - e.z;
      const dist = Math.hypot(dx, dz);
      const speed = rng.range(BEHAVIOR.rushSpeed[0], BEHAVIOR.rushSpeed[1]);
      const len = speed * rng.range(BEHAVIOR.rush[0], BEHAVIOR.rush[1]);
      let tx;
      let tz;
      if (dist <= len * 1.2) {
        tx = target[0];
        tz = target[1];
        this.wp++;
      } else {
        const ux = dx / dist;
        const uz = dz / dist;
        let side = rng.range(-1, 1) * len * 0.35;
        tx = e.x + ux * len - uz * side;
        tz = e.z + uz * len + ux * side;
        // 다른 적이 있는 쪽이면 반대로 비튼다
        if (!this.ctx.clearOf(tx, tz, e, BEHAVIOR.spacing)) {
          side = -side + Math.sign(-side || 1) * 3;
          tx = e.x + ux * len - uz * side;
          tz = e.z + uz * len + ux * side;
        }
      }
      e.setStance('stand');
      e.setMove([tx, tz], speed);
      this.rush = { until: this.time + len / speed + 1 };
    }
    e.lookYaw = lerp(e.lookYaw, 0, 1 - Math.exp(-dt * 3));
  }

  // ---------------------------------------------------------------------------
  // 숨기·내다보기
  _startHide() {
    const e = this.enemy;
    this.mode = 'hide';
    const low = !!(this.coverPos && this.coverPos.low);
    this.hide = {
      low,
      base: [e.x, e.z],
      peeking: false,
      next: this.time + rng.range(BEHAVIOR.hideFirst[0], BEHAVIOR.hideFirst[1]),
      peeksLeft: rng.int(BEHAVIOR.peeks[0], BEHAVIOR.peeks[1]),
      side: rng.next() < 0.5 ? -1 : 1,
    };
    // 나무 뒤에서는 무릎, 낮은 둔덕·통나무 뒤에서는 엎드림
    e.setStance(low ? 'prone' : 'kneel');
  }

  _hideUpdate(dt) {
    const e = this.enemy;
    const h = this.hide;
    this._faceThreat(dt);
    if (!h) {
      this._startHide();
      return;
    }
    // 반걸음 옮기는 동안은 웅크려 걷고, 닿으면 자세를 정한다
    if (h.pendingStance && !e.moveTarget) {
      e.setStance(h.pendingStance);
      h.pendingStance = null;
    }
    if (this.time < h.next) return;
    if (h.peeking) {
      this._endPeek();
      return;
    }
    if (h.peeksLeft <= 0 || this.time > this.hideUntil + 30) {
      this._relocate(false);
      return;
    }
    // 내다보기: 줄기 옆으로 반걸음(번갈아 반대쪽) 또는 높이를 바꿔(엎드림 → 무릎, 무릎 → 서기) 2~4 s
    h.peeking = true;
    h.peeksLeft--;
    h.next = this.time + rng.range(BEHAVIOR.peek[0], BEHAVIOR.peek[1]);
    const t = this.threat || { x: 0, z: 1 };
    if (h.low) {
      e.setStance('kneel');
    } else {
      h.side = -h.side;
      const off = rng.range(0.4, 0.65) * h.side;
      e.setMove([h.base[0] - t.z * off, h.base[1] + t.x * off], 0.9);
      e.setStance('crouchMove');
      h.pendingStance = rng.next() < 0.35 ? 'stand' : 'kneel';
    }
  }

  _endPeek() {
    const e = this.enemy;
    const h = this.hide;
    h.peeking = false;
    h.next = this.time + rng.range(BEHAVIOR.peekGap[0], BEHAVIOR.peekGap[1]);
    if (h.low) e.setStance('prone');
    else {
      e.setMove(h.base, 0.9);
      e.setStance('crouchMove');
      h.pendingStance = 'kneel';
    }
  }

  /** 수 m 옆 다른 엄폐물로 옮김(엎드려 있었으면 기어서) */
  _relocate(fromProne) {
    const e = this.enemy;
    const t = this.threat || { x: 0, z: 1 };
    const side = rng.next() < 0.5 ? -1 : 1;
    // 위협 방향에 수직으로 4~10 m 옆을 중심으로 엄폐물 찾기
    const off = rng.range(4, 10) * side;
    const probe = { x: e.x - t.z * off, z: e.z + t.x * off };
    const cover = this.ctx.findCover({ x: probe.x, z: probe.z, id: e.id }, this.threat, 7, e) || [probe.x, probe.z];
    this.coverPos = cover;
    this.mode = 'relocate';
    this.hide = null;
    if (fromProne || e.stance === 'prone') {
      e.setStance('prone');
      e.setMove(cover, 0.45);
    } else {
      e.setStance('crouchMove');
      e.setMove(cover, rng.range(2.2, 3.6));
    }
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
