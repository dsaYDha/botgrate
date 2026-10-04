// 적 한 명: 몸(관절 애니메이션·이동·히트박스)과 부상 상태. 판단은 ai/Brain.js가 한다.
// 자세는 절차적으로 계산: 서기/걷기/뛰기(낮은 준비 자세), 무릎쏴, 엎드림·포복, 주저앉음, 쓰러짐(시간 연출), 누움.

import * as THREE from 'three';
import { createSkeleton, buildBodyGeometry, bodyMaterial, buildRifle, CAMO_PALETTES, GEAR_COLORS } from './HumanModel.js';
import { HITBOXES, WOUNDS, WOUND_TIMING } from '../data/anatomy.js';
import { segLocalBox, segLocalEllipsoid, segLocalCylinderY } from '../physics/intersect.js';
import { clamp, damp, lerp, smoothstep, wrapAngle } from '../core/math.js';
import { rng } from '../core/Random.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

// 누운 자세의 골반 회전: 몸 위쪽(+y)과 정면(+z)이 향할 방향(적 국소 좌표)
function lieQuat(up, front) {
  const y = new THREE.Vector3(...up).normalize();
  const z = new THREE.Vector3(...front).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const LIE = {
  front: lieQuat([0, 0, 1], [0, -1, 0]),
  back: lieQuat([0, 0, -1], [0, 1, 0]),
  left: lieQuat([1, 0, 0], [0, 0, 1]),
  right: lieQuat([-1, 0, 0], [0, 0, 1]),
};

// 들고 있는 소총의 가슴뼈 기준 위치(손잡이)·자세
const CARRY = {
  low: { pos: [-0.12, -0.12, 0.22], rot: [0.5, 0.28, 0.0] },
  ready: { pos: [-0.1, 0.02, 0.24], rot: [0.12, 0.1, 0.0] },
  prone: { pos: [-0.05, 0.42, 0.1], rot: [-1.45, 0.0, 0.0] },
};

function solveArm(shoulder, target, side) {
  const a = 0.3;
  const b = 0.27;
  const D = target.clone().sub(shoulder);
  const d = clamp(D.length(), Math.abs(a - b) + 0.01, a + b - 0.004);
  const dir = D.normalize();
  const pole = new THREE.Vector3(side * 0.45, -1, -0.35).normalize();
  const perp = pole.clone().addScaledVector(dir, -dir.dot(pole)).normalize();
  const alpha = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const u = dir.clone().multiplyScalar(Math.cos(alpha)).addScaledVector(perp, Math.sin(alpha)).normalize();
  const E = shoulder.clone().addScaledVector(u, a);
  const f = target.clone().sub(E).normalize();
  const q1 = new THREE.Quaternion().setFromUnitVectors(DOWN, u);
  const fl = f.clone().applyQuaternion(q1.clone().invert());
  const q2 = new THREE.Quaternion().setFromUnitVectors(DOWN, fl);
  return [q1, q2];
}

export class Enemy {
  constructor(def, ctx) {
    this.def = def;
    this.id = def.id;
    this.ctx = ctx; // {world, events, scene}
    const skel = createSkeleton();
    this.bones = skel.bones;
    this.boneList = skel.list;
    const geo = buildBodyGeometry(skel);
    const pal = CAMO_PALETTES[Math.floor(rng.next() * CAMO_PALETTES.length)];
    const gear = GEAR_COLORS[Math.floor(rng.next() * GEAR_COLORS.length)];
    const sk = 0.85 + rng.next() * 0.3;
    this.material = bodyMaterial(pal, gear, [0.24 * sk, 0.17 * sk, 0.12 * sk]);
    this.mesh = new THREE.SkinnedMesh(geo, this.material);
    this.mesh.add(skel.root);
    this.mesh.bind(new THREE.Skeleton(skel.list));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    ctx.scene.add(this.group);

    this.rifle = buildRifle();
    this.bones.chest.add(this.rifle);
    this.rifleBody = null;
    this.carry = 'low';

    // 히트박스 캐시
    this.hit = HITBOXES.map((h) => ({ ...h, boneRef: this.bones[h.bone], inv: new THREE.Matrix4() }));
    this._arms = {};
    for (const mode of Object.keys(CARRY)) this._arms[mode] = this._solveCarry(mode);

    this.tmpQ = new THREE.Quaternion();
    this.tmpE = new THREE.Euler();
    this.flinch = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    this._hb = { t0: 0, t1: 0 };
    this.reset();
  }

  reset() {
    const d = this.def;
    const p = d.pos || d.waypoints[0];
    this.x = p[0];
    this.z = p[1];
    this.y = this.ctx.world.terrain.heightAt(this.x, this.z);
    this.heading = d.look ? (((d.look[0] + d.look[1]) / 2) * Math.PI) / 180 : 0;
    if (d.waypoints && d.waypoints.length > 1) this.heading = Math.atan2(d.waypoints[1][0] - p[0], -(d.waypoints[1][1] - p[1]));
    this.speed = 0;
    this.moveTarget = null;
    this.moveSpeed = 0;
    this.stance = d.pose === 'kneel' ? 'kneel' : 'stand';
    this.stanceBlend = { stand: this.stance === 'stand' ? 1 : 0, kneel: this.stance === 'kneel' ? 1 : 0, prone: 0, sit: 0 };
    this.gait = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.wounds = [];
    this.state = 'normal'; // normal | collapsing | down | dead
    this.incapacitated = false;
    this.collapse = null;
    this.lying = null;
    this.clutch = null;
    this.alive = true;
    this.carry = 'low';
    this.rifleHeld = true;
    this.rifle.visible = true;
    if (this.rifle.parent !== this.bones.chest) {
      this.ctx.scene.remove(this.rifle);
      this.bones.chest.add(this.rifle);
    }
    this.rifleBody = null;
    this.pelvisH = 0.95;
    this.rootPitch = 0;
    this.flinch.x = this.flinch.y = this.flinch.z = 0;
    this.flinch.vx = this.flinch.vy = this.flinch.vz = 0;
    this.time = rng.next() * 10;
    this.group.visible = true;
    this.lastHitTime = -100;
    this.hitCount = 0;
    this._applyCarry(true);
    this._pose(0.016, true);
  }

  _solveCarry(mode) {
    const c = CARRY[mode];
    const rifleM = new THREE.Matrix4().compose(
      new THREE.Vector3(...c.pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(c.rot[0], c.rot[1], c.rot[2], 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    const grip = new THREE.Vector3(0, -0.04, 0.0).applyMatrix4(rifleM);
    const fore = new THREE.Vector3(0.0, 0.0, 0.32).applyMatrix4(rifleM);
    const sR = new THREE.Vector3(-0.19, 0.16, -0.01);
    const sL = new THREE.Vector3(0.19, 0.16, -0.01);
    return { R: solveArm(sR, grip, -1), L: solveArm(sL, fore, 1), rifleM };
  }

  _applyCarry(force) {
    const c = CARRY[this.carry] || CARRY.low;
    this.rifle.position.set(...c.pos);
    this.rifle.quaternion.setFromEuler(new THREE.Euler(c.rot[0], c.rot[1], c.rot[2], 'YXZ'));
  }

  get chestWorld() {
    return new THREE.Vector3().setFromMatrixPosition(this.bones.chest.matrixWorld);
  }
  get headWorld() {
    return new THREE.Vector3().setFromMatrixPosition(this.bones.head.matrixWorld);
  }

  // ---------------------------------------------------------------------------
  // 이동·자세 명령(두뇌가 호출)
  setMove(target, speed) {
    this.moveTarget = target;
    this.moveSpeed = speed;
  }
  setStance(s) {
    this.stance = s;
  }

  /** 맞음: 부위 → 부상 → 반응 */
  onBulletHit(info) {
    const w = WOUNDS[info.part] || WOUNDS.abdomen;
    this.hitCount++;
    this.lastHitTime = this.time;
    this.wounds.push({ part: info.part, kind: w.kind, time: this.time });
    // 맞는 순간 움찔(총알 진행 방향으로 짧은 꺾임)
    const dirLocal = new THREE.Vector3(info.dir.x, info.dir.y, info.dir.z).applyQuaternion(this.group.quaternion.clone().invert());
    const k = 2.2 + Math.min(2.5, info.energy / 500);
    this.flinch.vx += dirLocal.z * k * (rng.next() * 0.5 + 0.75);
    this.flinch.vz += -dirLocal.x * k * 0.8;
    this.flinch.vy += (rng.next() - 0.5) * k * 0.6;
    this.ctx.events.emit('enemy:hit', {
      enemy: this,
      part: info.part,
      partName: w.name,
      kind: w.kind,
      distance: info.distance,
      speed: info.speed,
      energy: info.energy,
      through: info.through,
      position: { x: info.x, y: info.y, z: info.z },
    });
    this.brain?.onWounded(w.kind, info);
    if (this.state === 'collapsing' || this.state === 'down') return;
    // 두 번째 이상 피격, 또는 치명 부위 → 즉시 무력화
    const severe = w.kind === 'incap' || (this.wounds.length >= 2 && w.kind !== 'arm') || this.wounds.length >= 3;
    if (severe) this.startCollapse(info, 'incap');
    else if (w.kind === 'leg') this.startCollapse(info, 'leg');
    else if (w.kind === 'abdomen') this.startCollapse(info, 'sit');
    else if (w.kind === 'lung') {
      this.lungTimer = lerp(WOUND_TIMING.lungCollapse[0], WOUND_TIMING.lungCollapse[1], rng.next());
      this.clutch = 'chest';
    } else if (w.kind === 'arm') {
      this.clutch = 'arm';
      if (rng.next() < WOUND_TIMING.armDropChance) this.dropRifle(0.15);
    }
  }

  dropRifle(delay = 0) {
    if (!this.rifleHeld) return;
    this.rifleHeld = false;
    this._dropDelay = delay;
  }

  _doDropRifle() {
    const r = this.rifle;
    r.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    r.matrixWorld.decompose(pos, quat, new THREE.Vector3());
    this.bones.chest.remove(r);
    r.position.copy(pos);
    r.quaternion.copy(quat);
    this.ctx.scene.add(r);
    this.rifleBody = {
      v: new THREE.Vector3((rng.next() - 0.5) * 0.8, 0.3, (rng.next() - 0.5) * 0.8),
      w: new THREE.Vector3((rng.next() - 0.5) * 5, (rng.next() - 0.5) * 3, (rng.next() - 0.5) * 5),
      rest: false,
    };
  }

  /** 쓰러짐 시작. mode: incap(그 자리에 힘이 빠지며), leg(다리 풀림 → 엎드려 기어감), sit(복부: 주저앉음) */
  startCollapse(info, mode) {
    if (this.state === 'collapsing' || this.state === 'down') return;
    const dirLocal = info ? new THREE.Vector3(info.dir.x, 0, info.dir.z).applyQuaternion(this.group.quaternion.clone().invert()) : new THREE.Vector3(0, 0, -1);
    let fall;
    if (mode === 'sit') fall = 'sit';
    else if (mode === 'leg') fall = 'front';
    else {
      // 힘이 빠지며 대개 앞으로 무너지거나 옆으로
      const r = rng.next();
      fall = r < 0.5 ? 'front' : r < 0.75 ? (dirLocal.x > 0 ? 'left' : 'right') : 'back';
    }
    this.state = 'collapsing';
    this.collapse = {
      t: 0,
      mode,
      fall,
      dur: mode === 'sit' ? 0.75 : this.stance === 'prone' ? 0.3 : 0.95 + rng.next() * 0.35,
      from: { pelvisH: this.pelvisH },
      soundDone: false,
    };
    if (mode === 'incap') {
      this.incapacitated = true;
      this.dropRifle(0.05 + rng.next() * 0.2);
    } else if (mode === 'leg' && rng.next() < 0.4) this.dropRifle(0.3);
    this.moveTarget = null;
    this.speed = 0;
    this.ctx.events.emit('enemy:down', { enemy: this, mode });
  }

  // ---------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    // 떨어뜨린 총
    if (!this.rifleHeld && this._dropDelay !== undefined) {
      this._dropDelay -= dt;
      if (this._dropDelay <= 0) {
        this._dropDelay = undefined;
        this._doDropRifle();
      }
    }
    if (this.rifleBody && !this.rifleBody.rest) this._updateRifleBody(dt);

    // 폐 손상: 몇 초 뒤 쓰러짐
    if (this.lungTimer !== undefined && this.state === 'normal') {
      this.lungTimer -= dt;
      if (this.lungTimer <= 0) {
        this.lungTimer = undefined;
        this.incapacitated = true;
        this.startCollapse(null, 'incap');
      }
    }

    if (this.state === 'normal') this._locomotion(dt);
    else if (this.state === 'collapsing') this._collapseUpdate(dt);
    else if (this.state === 'down') this._downUpdate(dt);
    this._pose(dt, false);
  }

  _locomotion(dt) {
    const w = this.ctx.world;
    let targetSpeed = 0;
    if (this.moveTarget) {
      const dx = this.moveTarget[0] - this.x;
      const dz = this.moveTarget[1] - this.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.25) {
        this.moveTarget = null;
      } else {
        let want = Math.atan2(dx, -dz);
        // 줄기 피하기
        want += this._avoid(want);
        const turn = wrapAngle(want - this.heading);
        const rate = this.stance === 'prone' ? 1.2 : 3.5;
        this.heading += clamp(turn, -rate * dt, rate * dt);
        targetSpeed = this.moveSpeed * (Math.abs(turn) > 1.2 ? 0.3 : 1);
        if (this.clutch === 'chest') targetSpeed *= 0.45;
        if (this.clutch === 'arm') targetSpeed *= 0.8;
      }
    }
    this.speed = damp(this.speed, targetSpeed, 6, dt);
    if (this.speed > 0.01) {
      this.x += Math.sin(this.heading) * this.speed * dt;
      this.z += -Math.cos(this.heading) * this.speed * dt;
    }
    this.y = w.terrain.heightAt(this.x, this.z);
    const strideLen = this.stance === 'prone' ? 0.55 : this.speed > 2.5 ? 2.2 : 1.45;
    this.gait += (this.speed / strideLen) * Math.PI * 2 * dt;
  }

  _avoid(want) {
    const q = [];
    const ax = this.x + Math.sin(want) * 1.0;
    const az = this.z - Math.cos(want) * 1.0;
    this.ctx.world.hash.query(ax - 1, az - 1, ax + 1, az + 1, q);
    let steer = 0;
    for (const o of q) {
      if (o.kind !== 'trunk') continue;
      const dx = o.x - this.x;
      const dz = o.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.6 || d < 0.01) continue;
      const ang = wrapAngle(Math.atan2(dx, -dz) - want);
      if (Math.abs(ang) < 0.9) steer += (ang > 0 ? -1 : 1) * (1.6 - d) * 0.9;
    }
    return clamp(steer, -1.2, 1.2);
  }

  _collapseUpdate(dt) {
    const c = this.collapse;
    c.t += dt;
    const k = clamp(c.t / c.dur, 0, 1);
    if (k >= 1) {
      this.state = 'down';
      this.lying = { fall: c.fall, mode: c.mode, t: 0, crawlDelay: c.mode === 'incap' ? Infinity : lerp(WOUND_TIMING.abdomenCrawlDelay[0], WOUND_TIMING.abdomenCrawlDelay[1], rng.next()) };
      if (!c.soundDone) this._fallSound(c.mode === 'sit' ? 0.6 : 1);
    } else if (!c.soundDone && k > 0.82 && c.mode !== 'sit') {
      c.soundDone = true;
      this._fallSound(1);
    }
    this.y = this.ctx.world.terrain.heightAt(this.x, this.z);
  }

  _fallSound(intensity) {
    const p = this.chestWorld;
    this.ctx.events.emit('enemy:fallSound', { position: { x: p.x, y: this.y + 0.2, z: p.z }, intensity });
  }

  _downUpdate(dt) {
    const L = this.lying;
    L.t += dt;
    // 기어가기(복부·다리 부상): 엄폐물 쪽으로 천천히
    if (!this.incapacitated && L.t > L.crawlDelay && L.mode !== 'incap') {
      if (!L.crawl) {
        L.crawl = { speed: lerp(WOUND_TIMING.crawlSpeed[0], WOUND_TIMING.crawlSpeed[1], rng.next()), left: lerp(WOUND_TIMING.crawlDuration[0], WOUND_TIMING.crawlDuration[1], rng.next()) };
        this.brain?.onCrawlStart();
        if (L.fall !== 'front') L.fall = 'front';
        L.mode = 'crawl';
      }
      L.crawl.left -= dt;
      if (L.crawl.left <= 0) {
        this.incapacitated = true;
        L.mode = 'incap';
      } else if (this.moveTarget) {
        const dx = this.moveTarget[0] - this.x;
        const dz = this.moveTarget[1] - this.z;
        if (Math.hypot(dx, dz) > 0.5) {
          const want = Math.atan2(dx, -dz);
          this.heading += clamp(wrapAngle(want - this.heading), -0.8 * dt, 0.8 * dt);
          const sp = L.crawl.speed * (0.5 + 0.5 * Math.max(0, Math.sin(this.time * 2.4)));
          this.x += Math.sin(this.heading) * sp * dt;
          this.z += -Math.cos(this.heading) * sp * dt;
          this.gait += sp * dt * 9;
        } else this.moveTarget = null;
      }
    }
    this.y = this.ctx.world.terrain.heightAt(this.x, this.z);
  }

  _updateRifleBody(dt) {
    const rb = this.rifleBody;
    const r = this.rifle;
    rb.v.y -= 9.81 * dt;
    r.position.addScaledVector(rb.v, dt);
    const wl = rb.w.length();
    if (wl > 0.01) r.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(rb.w.clone().divideScalar(wl), wl * dt));
    const gy = this.ctx.world.terrain.heightAt(r.position.x, r.position.z) + 0.03;
    if (r.position.y < gy) {
      r.position.y = gy;
      if (!rb.landed) {
        rb.landed = true;
        this.ctx.events.emit('enemy:rifleDrop', { position: { x: r.position.x, y: gy, z: r.position.z } });
      }
      rb.v.multiplyScalar(0.3);
      rb.v.y = Math.abs(rb.v.y) * 0.2;
      rb.w.multiplyScalar(0.4);
      // 땅에 눕히기
      const e = new THREE.Euler().setFromQuaternion(r.quaternion, 'YXZ');
      e.x = damp(e.x, 0, 8, dt);
      e.z = damp(e.z, Math.PI / 2 * Math.sign(e.z || 1), 8, dt);
      r.quaternion.setFromEuler(e);
      if (rb.v.length() < 0.15) rb.rest = true;
    }
  }

  // ---------------------------------------------------------------------------
  // 절차적 자세
  _pose(dt, snap) {
    const B = this.bones;
    const t = this.time;
    const rate = snap ? 1 : 1 - Math.exp(-dt * 9);
    // 움찔 스프링
    const f = this.flinch;
    for (const ax of ['x', 'y', 'z']) {
      const v = 'v' + ax;
      f[v] += (-f[ax] * 160 - f[v] * 14) * dt;
      f[ax] += f[v] * dt;
    }

    let pelvisH;
    let rootPitch = 0;
    let lieW = 0;
    let lieType = 'front';
    const E = {}; // bone → [x,y,z]
    const set = (n, x, y = 0, z = 0) => (E[n] = [x, y, z]);
    const mv = clamp(this.speed / 1.5, 0, 1.6);
    const ph = this.gait;
    let armsMode = this.rifleHeld ? this.carry : 'free';

    if (this.state === 'normal') {
      // 목표 자세 혼합
      const sb = this.stanceBlend;
      for (const k in sb) sb[k] = damp(sb[k], this.stance === k ? 1 : 0, 5, dt);
      const kneel = sb.kneel;
      const prone = sb.prone;
      // 서기/걷기
      const swing = 0.42 * mv;
      const bob = Math.abs(Math.cos(ph)) * 0.025 * mv;
      const crouch = this.stance === 'crouchMove' ? 1 : 0;
      pelvisH = lerp(0.95 - bob, 0.56, kneel);
      pelvisH = lerp(pelvisH, 0.16, prone);
      pelvisH -= crouch * 0.22;
      set('pelvis', 0, Math.sin(ph) * 0.06 * mv, 0);
      set('spine', 0.05 + 0.06 * mv + kneel * 0.1 + crouch * 0.35, -Math.sin(ph) * 0.05 * mv, 0);
      set('chest', 0.04 + (this.clutch ? 0.25 : 0), 0, 0);
      const legL = Math.sin(ph) * swing;
      const legR = Math.sin(ph + Math.PI) * swing;
      set('thighL', lerp(-legL - crouch * 0.6, -1.45, kneel), 0, 0.03);
      set('shinL', lerp(Math.max(0, Math.sin(ph + 1.8)) * 0.75 * mv + crouch * 1.0, 1.45, kneel));
      set('footL', lerp(0, -0.1, kneel));
      set('thighR', lerp(-legR - crouch * 0.6, 0.12, kneel), 0, -0.03);
      set('shinR', lerp(Math.max(0, Math.sin(ph + Math.PI + 1.8)) * 0.75 * mv + crouch * 1.0, 1.55, kneel));
      set('footR', lerp(0, 0.9, kneel));
      if (prone > 0.01) {
        lieW = prone;
        lieType = 'front';
        const cr = Math.sin(ph) * 0.35 * Math.min(1, this.speed * 3);
        for (const k of ['thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'spine', 'chest']) {
          const e = E[k] || [0, 0, 0];
          E[k] = [e[0] * (1 - prone), e[1] * (1 - prone), e[2] * (1 - prone)];
        }
        E.thighL[0] += -cr * prone;
        E.thighR[0] += cr * prone;
        E.shinL[0] += Math.max(0, cr) * prone;
        E.shinR[0] += Math.max(0, -cr) * prone;
        E.footL[0] += 1.2 * prone;
        E.footR[0] += 1.2 * prone;
        armsMode = this.rifleHeld ? 'prone' : 'free';
      }
      // 머리: 시선
      set('neck', -0.05 - prone * 0.95 + this.lookPitch * 0.4, this.lookYaw * 0.45, 0);
      set('head', this.lookPitch * 0.6, this.lookYaw * 0.55, 0);
    } else {
      // 쓰러짐/누움
      const c = this.collapse;
      const L = this.lying;
      const fall = (c && c.fall) || (L && L.fall) || 'front';
      const k = this.state === 'collapsing' ? clamp(c.t / c.dur, 0, 1) : 1;
      const knee = smoothstep(0, 0.35, k);
      const drop = k * k; // 중력처럼 가속
      if (fall === 'sit') {
        pelvisH = lerp(c ? c.from.pelvisH : 0.95, 0.17, smoothstep(0, 1, k));
        rootPitch = -0.25 * k;
        set('spine', 0.35 * k);
        set('chest', 0.3 * k);
        set('thighL', -1.35 * k, 0, 0.15 * k);
        set('thighR', -1.25 * k, 0, -0.15 * k);
        set('shinL', 1.2 * k);
        set('shinR', 1.0 * k);
        set('neck', 0.3 * k);
        set('head', 0.2 * k);
        armsMode = 'clutchBelly';
        if (L && (L.mode === 'crawl' || L.mode === 'incap') && L.t > 2) {
          // 결국 엎드려 눕거나 기어감
          lieW = 1;
          lieType = L.mode === 'crawl' ? 'front' : 'right';
          pelvisH = 0.14;
          armsMode = L.mode === 'crawl' ? 'crawl' : 'limp';
          set('spine', 0.05);
          set('chest', 0.0);
          set('thighL', -0.15, 0, 0.1);
          set('thighR', 0.1);
          set('shinL', 0.5);
          set('shinR', 0.2);
        }
      } else {
        const sgn = fall === 'back' ? -1 : 1;
        const side = fall === 'left' ? 1 : fall === 'right' ? -1 : 0;
        const startH = c ? c.from.pelvisH : 0.95;
        pelvisH = lerp(startH, 0.55, knee * 0.7) * (1 - drop) + (side ? 0.16 : 0.13) * drop;
        lieW = drop;
        lieType = fall;
        set('spine', 0.15 * knee * (1 - drop) + 0.1 * drop);
        set('chest', 0.2 * knee * (1 - drop));
        set('thighL', -0.7 * knee * (1 - drop) - 0.1 * drop, 0, 0.12 * drop);
        set('thighR', -0.5 * knee * (1 - drop) + 0.15 * drop, 0, -0.18 * drop);
        set('shinL', 1.2 * knee * (1 - drop) + 0.3 * drop);
        set('shinR', 0.9 * knee * (1 - drop) + 0.1 * drop);
        set('footL', 0.8 * drop);
        set('footR', 0.8 * drop);
        set('neck', (0.4 * knee - 0.4 * drop * sgn) * (fall === 'front' ? 1 : 0.5), 0.6 * drop * (side || 0.5));
        set('head', 0.2 * drop, 0.3 * drop);
        armsMode = 'limp';
        if (L && L.mode === 'crawl') {
          lieW = 1;
          lieType = 'front';
          const cr = Math.sin(this.gait) * 0.4;
          set('thighL', -cr);
          set('thighR', cr * 0.4);
          set('shinL', Math.max(0, cr));
          set('neck', -0.9);
          armsMode = 'crawl';
        }
      }
    }
    // 루트: 서 있는 골반(오일러) ↔ 누운 골반(기저 회전) 혼합
    this.pelvisH = snap ? pelvisH : damp(this.pelvisH, pelvisH, this.state === 'normal' ? 8 : 30, dt);
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(0, Math.PI - this.heading, 0);
    const pe = E.pelvis || [0, 0, 0];
    this.tmpE.set(pe[0] + rootPitch * (lieW > 0 ? 0 : 1) + f.x * 0.3, pe[1] + f.y * 0.2, pe[2] + f.z * 0.3, 'YXZ');
    const qStand = new THREE.Quaternion().setFromEuler(this.tmpE);
    const qLie = LIE[lieType] || LIE.front;
    const qT = qStand.clone().slerp(qLie, lieW);
    if (snap || this.state !== 'normal') B.pelvis.quaternion.copy(qT);
    else B.pelvis.quaternion.slerp(qT, rate);
    // 누우면 몸통 중심이 원래 서 있던 자리 근처에 오도록 골반을 머리 반대쪽으로
    const upDir = new THREE.Vector3(0, 1, 0).applyQuaternion(qLie);
    B.pelvis.position.x = -upDir.x * 0.3 * lieW;
    B.pelvis.position.z = -upDir.z * 0.3 * lieW;
    B.pelvis.position.y = this.pelvisH;

    for (const name of ['spine', 'chest', 'neck', 'head', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR']) {
      const e = E[name] || [0, 0, 0];
      let x = e[0];
      let y = e[1];
      let z = e[2];
      if (name === 'spine' || name === 'chest') {
        x += f.x * 0.5;
        y += f.y * 0.5;
        z += f.z * 0.5;
      }
      if (name === 'neck') x += f.x * 0.6;
      this.tmpE.set(x, y, z, 'YXZ');
      this.tmpQ.setFromEuler(this.tmpE);
      if (snap || this.state !== 'normal') B[name].quaternion.copy(this.tmpQ);
      else B[name].quaternion.slerp(this.tmpQ, rate);
    }
    this._poseArms(armsMode, rate, snap);
    this.group.updateMatrixWorld(true);
  }

  _poseArms(mode, rate, snap) {
    const B = this.bones;
    let qs;
    if (mode === 'low' || mode === 'ready' || mode === 'prone') {
      if (this.carry !== mode && (mode === 'prone' || this.carry === 'prone')) {
        this.carry = mode;
        this._applyCarry();
      }
      const a = this._arms[mode];
      qs = { upperArmR: a.R[0], foreArmR: a.R[1], upperArmL: a.L[0], foreArmL: a.L[1] };
      if (this.clutch === 'arm') qs.upperArmL = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0.2));
    } else {
      const e = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
      if (mode === 'clutchBelly') qs = { upperArmR: e(-0.5, 0, -0.25), foreArmR: e(-1.6, 0, 0), upperArmL: e(-0.4, 0, 0.3), foreArmL: e(-1.7, 0, 0) };
      else if (mode === 'crawl') {
        const c = Math.sin(this.gait) * 0.5;
        qs = { upperArmR: e(-2.4 + c, 0, -0.3), foreArmR: e(-0.6, 0, 0), upperArmL: e(-2.4 - c, 0, 0.3), foreArmL: e(-0.6, 0, 0) };
      } else if (mode === 'limp') qs = { upperArmR: e(-0.3, 0, -0.5), foreArmR: e(-0.3, 0, 0), upperArmL: e(-0.6, 0, 0.6), foreArmL: e(-0.4, 0, 0) };
      else if (this.clutch === 'chest') qs = { upperArmR: e(-0.6, 0, -0.2), foreArmR: e(-2.0, 0, 0), upperArmL: e(-0.2, 0, 0.2), foreArmL: e(-0.4, 0, 0) };
      else qs = { upperArmR: e(-0.15, 0, -0.08), foreArmR: e(-0.3, 0, 0), upperArmL: e(-0.15, 0, 0.08), foreArmL: e(-0.3, 0, 0) };
    }
    for (const n in qs) {
      if (snap || this.state !== 'normal') B[n].quaternion.slerp(qs[n], snap ? 1 : 0.25);
      else B[n].quaternion.slerp(qs[n], rate);
    }
  }

  // ---------------------------------------------------------------------------
  /** 탄 선분과 히트박스 교차 → hits에 추가 */
  intersect(x0, y0, z0, dx, dy, dz, hits) {
    if (!this.group.visible) return;
    // 넓은 판정: 몸 중심 구
    const c = this.chestWorld;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = ((c.x - x0) * dx + (c.y - y0) * dy + (c.z - z0) * dz) / len2;
    t = clamp(t, 0, 1);
    const ex = x0 + dx * t - c.x;
    const ey = y0 + dy * t - c.y;
    const ez = z0 + dz * t - c.z;
    if (ex * ex + ey * ey + ez * ez > 1.3 * 1.3) return;
    const p = new THREE.Vector3();
    const d = new THREE.Vector3();
    const o = this._hb;
    for (const h of this.hit) {
      h.inv.copy(h.boneRef.matrixWorld).invert();
      p.set(x0, y0, z0).applyMatrix4(h.inv);
      d.set(dx, dy, dz).transformDirection(h.inv).multiplyScalar(Math.sqrt(len2));
      let ok = false;
      if (h.shape === 'box') ok = segLocalBox(p.x - h.c[0], p.y - h.c[1], p.z - h.c[2], d.x, d.y, d.z, h.h[0], h.h[1], h.h[2], o);
      else if (h.shape === 'ellipsoid') ok = segLocalEllipsoid(p.x - h.c[0], p.y - h.c[1], p.z - h.c[2], d.x, d.y, d.z, h.r[0], h.r[1], h.r[2], o);
      else if (h.shape === 'cyl') ok = h.from < 0 ? segLocalCylinderY(p.x, -p.y, p.z, d.x, -d.y, d.z, h.r, h.len, o) : segLocalCylinderY(p.x, p.y, p.z, d.x, d.y, d.z, h.r, h.len, o);
      if (ok && o.t1 - o.t0 > 1e-5) {
        hits.push({ t0: o.t0, t1: o.t1, kind: 'body', material: 'flesh', target: this, part: h.zone, nx: 0, ny: 0, nz: 0 });
      }
    }
  }
}
