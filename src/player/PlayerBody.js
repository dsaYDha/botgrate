// 플레이어의 몸(화면에는 그리지 않음): 적과 같은 뼈대·히트박스(data/anatomy.js)를 플레이어 자세에 맞춰 세운다.
//   - 적 탄의 명중 판정(같은 부위·같은 부상 모델)
//   - 적 시각의 표적: 부위별 시선 표본 점과 보는 방향에 따른 몸 윤곽 면적
// 자세(서기/앉아쏴/엎드림, 전환 중 섞임)·기울이기·방향을 따르고, 머리(눈)가 카메라 눈 위치에 오도록 몸 전체를 맞춘다.

import * as THREE from 'three';
import { createSkeleton } from '../enemies/HumanModel.js';
import { HITBOXES } from '../data/anatomy.js';
import { MOVEMENT } from '../data/movement.js';
import { LIE, CARRY, solveArm } from '../enemies/Enemy.js';
import { segLocalBox, segLocalEllipsoid, segLocalCylinderY } from '../physics/intersect.js';
import { clamp, lerp } from '../core/math.js';
import { VISION } from '../data/perception.js';

// 시선 표본 묶음: 이름, 뼈, 국소 위치, 정면에서 본 면적(m²) — 서 있는 사람 정면 기준
const GROUPS = [
  { name: 'head', bone: 'head', p: [0, 0.09, 0.02], area: 0.045 },
  { name: 'chest', bone: 'chest', p: [0, 0.1, 0.02], area: 0.15 },
  { name: 'belly', bone: 'spine', p: [0, 0.05, 0.02], area: 0.13 },
  { name: 'thighs', bone: 'thighL', p: [-0.095, -0.22, 0], area: 0.12 },
  { name: 'shins', bone: 'shinL', p: [-0.095, -0.22, 0], area: 0.1 },
];
const EYE_LOCAL = [0, 0.1, 0.085]; // 머리뼈 기준 눈 위치

export class PlayerBody {
  constructor() {
    const skel = createSkeleton();
    this.bones = skel.bones;
    this.group = new THREE.Group();
    this.group.add(skel.root);
    this.hit = HITBOXES.map((h) => ({ ...h, boneRef: this.bones[h.bone], inv: new THREE.Matrix4() }));
    this._hb = { t0: 0, t1: 0 };
    this._v = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._arms = {};
    for (const mode of ['ready', 'prone']) this._arms[mode] = this._solveCarry(mode);
    // 시선 표본(월드 좌표) — update에서 갱신
    this.samples = new Float32Array(GROUPS.length * 3);
    this.weights = new Float32Array(GROUPS.length);
    this.groups = GROUPS;
    this.up = new THREE.Vector3(0, 1, 0);
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.center = new THREE.Vector3();
    this.extent = [0.25, 0.875, 0.15]; // 반폭(좌우), 반길이(몸 축), 반두께
    this.prone = 0;
    this.stance = 'stand';
    this.alive = true;
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
    return { R: solveArm(new THREE.Vector3(-0.19, 0.16, -0.01), grip, -1), L: solveArm(new THREE.Vector3(0.19, 0.16, -0.01), fore, 1) };
  }

  /**
   * @param {object} p Player
   * @param {THREE.Vector3} eye 카메라 눈 위치(흔들림 포함)
   */
  update(p, eye) {
    const B = this.bones;
    // 자세 섞임: 눈높이로(전환 중에도 연속)
    const H = MOVEMENT.eyeHeight;
    const eh = p.eyeH;
    const proneW = clamp((H.crouch - eh) / (H.crouch - H.prone), 0, 1);
    const kneelW = clamp((H.stand - eh) / (H.stand - H.crouch), 0, 1) * (1 - proneW);
    this.prone = proneW;
    this.stance = p.transition ? p.transition.to : p.stance;
    const set = (b, x, y = 0, z = 0) => {
      this._e.set(x, y, z, 'YXZ');
      B[b].quaternion.setFromEuler(this._e);
    };
    // 다리
    set('thighL', lerp(lerp(0, -1.45, kneelW), 0, proneW), 0, 0.03);
    set('shinL', lerp(lerp(0, 1.45, kneelW), 0, proneW));
    set('footL', lerp(lerp(0, -0.1, kneelW), 1.2, proneW));
    set('thighR', lerp(lerp(0, 0.12, kneelW), 0, proneW), 0, -0.03);
    set('shinR', lerp(lerp(0, 1.55, kneelW), 0, proneW));
    set('footR', lerp(lerp(0, 0.9, kneelW), 1.2, proneW));
    // 몸통: 기울이기(옆으로 굽힘)
    const lean = p.lean || 0;
    const leanRoll = lean * (proneW > 0.5 ? 0.15 : 0.42);
    set('spine', 0.05 + kneelW * 0.1, 0, leanRoll * 0.5);
    set('chest', 0.04, 0, leanRoll * 0.5);
    set('neck', -0.05 - proneW * 0.95 - p.pitch * 0.3, 0, -leanRoll * 0.3);
    set('head', -p.pitch * 0.5);
    // 팔: 총을 든 자세
    const a = this._arms[proneW > 0.5 ? 'prone' : 'ready'];
    B.upperArmR.quaternion.copy(a.R[0]);
    B.foreArmR.quaternion.copy(a.R[1]);
    B.upperArmL.quaternion.copy(a.L[0]);
    B.foreArmL.quaternion.copy(a.L[1]);
    // 골반: 서기 ↔ 무릎 ↔ 엎드림(누운 자세는 기저 회전)
    const pelvisH = lerp(lerp(0.95, 0.56, kneelW), 0.16, proneW);
    this._e.set(0, 0, 0, 'YXZ');
    const qStand = this._q.setFromEuler(this._e);
    B.pelvis.quaternion.copy(qStand).slerp(LIE.front, proneW);
    B.pelvis.position.set(0, pelvisH, 0);
    const g = this.group;
    g.rotation.set(0, Math.PI - p.yaw, 0);
    g.position.set(p.x, p.y, p.z);
    g.updateMatrixWorld(true);
    // 눈이 카메라 눈 위치에 오도록 몸 전체를 옮김
    const e = this._v.set(EYE_LOCAL[0], EYE_LOCAL[1], EYE_LOCAL[2]).applyMatrix4(B.head.matrixWorld);
    g.position.x += eye.x - e.x;
    g.position.y += eye.y - e.y;
    g.position.z += eye.z - e.z;
    g.updateMatrixWorld(true);

    // 시선 표본·가중
    for (let i = 0; i < GROUPS.length; i++) {
      const G = GROUPS[i];
      const v = this._v.set(G.p[0], G.p[1], G.p[2]).applyMatrix4(B[G.bone].matrixWorld);
      this.samples[i * 3] = v.x;
      this.samples[i * 3 + 1] = v.y;
      this.samples[i * 3 + 2] = v.z;
    }
    // 허벅지·정강이 표본은 두 다리 가운데(왼쪽 뼈 기준에서 오른쪽으로 옮김)
    for (const [i, bL, bR] of [[3, 'thighL', 'thighR'], [4, 'shinL', 'shinR']]) {
      const vl = this._v.set(0, -0.22, 0).applyMatrix4(B[bL].matrixWorld);
      const lx = vl.x;
      const ly = vl.y;
      const lz = vl.z;
      const vr = this._v.set(0, -0.22, 0).applyMatrix4(B[bR].matrixWorld);
      this.samples[i * 3] = (lx + vr.x) / 2;
      this.samples[i * 3 + 1] = (ly + vr.y) / 2;
      this.samples[i * 3 + 2] = (lz + vr.z) / 2;
    }
    // 몸 축(발 → 머리)과 경계 상자
    const head = this._v.set(0, 0.09, 0).applyMatrix4(B.head.matrixWorld);
    const hx = head.x;
    const hy = head.y;
    const hz = head.z;
    const foot = this._v.set(0, -0.03, 0.07).applyMatrix4(B.footL.matrixWorld);
    const fr = new THREE.Vector3(0, -0.03, 0.07).applyMatrix4(B.footR.matrixWorld);
    const fx = (foot.x + fr.x) / 2;
    const fy = (foot.y + fr.y) / 2;
    const fz = (foot.z + fr.z) / 2;
    this.up.set(hx - fx, hy - fy, hz - fz);
    const len = this.up.length();
    this.up.divideScalar(len || 1);
    this.center.set((hx + fx) / 2, (hy + fy) / 2 + 0.06, (hz + fz) / 2);
    this.right.set(Math.cos(p.yaw), 0, Math.sin(p.yaw));
    this.fwd.crossVectors(this.up, this.right).normalize();
    this.extent[0] = 0.25;
    this.extent[1] = Math.max(0.3, (len + 0.2) / 2);
    this.extent[2] = lerp(0.15, 0.24, kneelW);
  }

  /** 보는 방향(관측자 → 몸, 단위벡터)에서 본 몸 윤곽 면적(m²): 경계 상자 투영 × 채움 */
  silhouetteArea(vx, vy, vz) {
    const [a, b, c] = this.extent;
    const r = this.right;
    const u = this.up;
    const f = this.fwd;
    const pr = Math.abs(vx * r.x + vy * r.y + vz * r.z);
    const pu = Math.abs(vx * u.x + vy * u.y + vz * u.z);
    const pf = Math.abs(vx * f.x + vy * f.y + vz * f.z);
    return VISION.bodyFill * 4 * (b * c * pr + a * c * pu + a * b * pf);
  }

  /** 부위 표본 가중: 정면 면적 × (몸 축 방향으로 볼 때 뒤쪽 부위는 앞 부위에 가림) */
  sampleWeights(vx, vy, vz, out = this.weights) {
    const u = this.up;
    const along = vx * u.x + vy * u.y + vz * u.z; // +: 발 → 머리 방향으로 봄(머리가 뒤)
    for (let i = 0; i < GROUPS.length; i++) {
      let w = GROUPS[i].area;
      // 엎드린 사람을 머리 쪽에서 보면 다리는 몸 뒤에 숨는다
      const rank = i / (GROUPS.length - 1); // 0 머리 … 1 정강이
      const hide = along < 0 ? -along * rank : along * (1 - rank);
      w *= 1 - 0.85 * hide;
      out[i] = w;
    }
    return out;
  }

  /** 탄 선분과 히트박스 교차(적과 같은 부위·형상) */
  intersect(x0, y0, z0, dx, dy, dz, hits, target) {
    if (!this.alive) return;
    const c = this.center;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = ((c.x - x0) * dx + (c.y - y0) * dy + (c.z - z0) * dz) / len2;
    t = clamp(t, 0, 1);
    const ex = x0 + dx * t - c.x;
    const ey = y0 + dy * t - c.y;
    const ez = z0 + dz * t - c.z;
    if (ex * ex + ey * ey + ez * ez > 1.4 * 1.4) return;
    const p = this._v;
    const d = this._d;
    const o = this._hb;
    for (const h of this.hit) {
      h.inv.copy(h.boneRef.matrixWorld).invert();
      p.set(x0, y0, z0).applyMatrix4(h.inv);
      d.set(dx, dy, dz).transformDirection(h.inv).multiplyScalar(Math.sqrt(len2));
      let ok = false;
      if (h.shape === 'box') ok = segLocalBox(p.x - h.c[0], p.y - h.c[1], p.z - h.c[2], d.x, d.y, d.z, h.h[0], h.h[1], h.h[2], o);
      else if (h.shape === 'ellipsoid') ok = segLocalEllipsoid(p.x - h.c[0], p.y - h.c[1], p.z - h.c[2], d.x, d.y, d.z, h.r[0], h.r[1], h.r[2], o);
      else if (h.shape === 'cyl') ok = h.from < 0 ? segLocalCylinderY(p.x, -p.y, p.z, d.x, -d.y, d.z, h.r, h.len, o) : segLocalCylinderY(p.x, p.y, p.z, d.x, d.y, d.z, h.r, h.len, o);
      if (ok && o.t1 - o.t0 > 1e-5) hits.push({ t0: o.t0, t1: o.t1, kind: 'body', material: 'flesh', target, part: h.zone, nx: 0, ny: 0, nz: 0 });
    }
  }
}
