// 사건 → 시각 효과: 탄착 흙먼지(300 m 이상에서도 조준경으로 보이는 크기), 나무 껍질 파편과 흰 생채기,
// 잎 흩날림, 피격 시 옷 먼지(과한 고어 없음), 총구 섬광·연기, 엎드려쏴 흙먼지, 탄피, 버린 탄창.

import * as THREE from 'three';
import { Particles, PK } from './Particles.js';
import { patchMaterial } from '../render/shaderLib.js';
import { rng } from '../core/Random.js';

// 엎드려쏴 총구 먼지가 이는 정도(지면 종류별): 마른 맨흙·흙길이 가장 크고, 풀밭·숲 바닥은 작다
const MUZZLE_DUST = { plowed: 1.2, road: 1.25, stubble: 1.0, sunflower: 0.7, forest: 0.55, fallow: 0.45, grass: 0.3 };

/**
 * 엎드려쏴 총구 먼지 세기(0~): 총구가 땅에 가까울수록, 마른 맨흙일수록 크다. 적의 시각(먼지가 보임)도 같은 값을 쓴다.
 * @returns {{k:number, surf:string, x:number, y:number, z:number}|null}
 */
export function proneMuzzleDust(world, m, d) {
  const gx = m.x + d.x * 0.35;
  const gz = m.z + d.z * 0.35;
  const gy = world.terrain.heightAt(gx, gz);
  const hgt = m.y - gy;
  if (hgt >= 0.55) return null;
  const surf = world.terrain.surfaceAt(gx, gz);
  const dusty = MUZZLE_DUST[surf] ?? 0.5;
  const k = dusty * (1 - hgt / 0.55);
  return k > 0.04 ? { k, surf, x: gx, y: gy, z: gz } : null;
}

const DUST_COLORS = {
  stubble: [0.63, 0.57, 0.45],
  plowed: [0.44, 0.37, 0.29],
  fallow: [0.52, 0.47, 0.36],
  forest: [0.38, 0.32, 0.24],
  road: [0.7, 0.62, 0.5],
  grass: [0.46, 0.43, 0.33],
};

class MarkPool {
  constructor(scene, cap, color, size, name) {
    const geo = new THREE.CircleGeometry(0.5, 10);
    const mat = new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    patchMaterial(mat, { key: `mark-${name}` });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    this.cap = cap;
    this.i = 0;
    this.size = size;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 0, 1);
  }
  add(p, n, s) {
    const k = this.i % this.cap;
    this.i++;
    const nv = new THREE.Vector3(n.x, n.y, n.z).normalize();
    this.q.setFromUnitVectors(this.up, nv);
    const rot = new THREE.Quaternion().setFromAxisAngle(nv, Math.random() * 6.28);
    this.q.premultiply(rot);
    const sz = (s || this.size) * (0.7 + Math.random() * 0.6);
    this.m.compose(new THREE.Vector3(p.x + nv.x * 0.004, p.y + nv.y * 0.004, p.z + nv.z * 0.004), this.q, new THREE.Vector3(sz, sz * (0.7 + Math.random() * 0.6), sz));
    this.mesh.setMatrixAt(k, this.m);
    this.mesh.count = Math.min(this.cap, this.i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

class Bodies {
  // 탄피·버린 탄창 같은 작은 강체(지면 반발·마찰)
  constructor(scene, world, geo, mat, cap, opts) {
    this.world = world;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = opts.castShadow || false;
    scene.add(this.mesh);
    this.items = [];
    this.cap = cap;
    this.opts = opts;
    this.m = new THREE.Matrix4();
  }
  add(pos, vel, quat, angVel) {
    if (this.items.length >= this.cap) this.items.shift();
    this.items.push({ p: pos.clone(), v: vel.clone(), q: quat.clone(), w: angVel.clone(), rest: false, landed: false, age: 0 });
  }
  update(dt, onLand) {
    const w = this.world;
    const tq = new THREE.Quaternion();
    let k = 0;
    for (const it of this.items) {
      it.age += dt;
      if (!it.rest) {
        it.v.y -= 9.81 * dt;
        it.p.addScaledVector(it.v, dt);
        const wl = it.w.length();
        if (wl > 1e-3) {
          tq.setFromAxisAngle(it.w.clone().divideScalar(wl), wl * dt);
          it.q.premultiply(tq);
        }
        const gy = w.terrain.heightAt(it.p.x, it.p.z) + this.opts.radius;
        if (it.p.y < gy) {
          it.p.y = gy;
          if (!it.landed) {
            it.landed = true;
            onLand?.(it);
          }
          if (Math.abs(it.v.y) < 0.6) {
            it.rest = it.v.length() < 0.4;
            it.v.multiplyScalar(0.4);
            it.v.y = 0;
            it.w.multiplyScalar(0.5);
          } else {
            it.v.y = -it.v.y * this.opts.restitution;
            it.v.x *= 0.55;
            it.v.z *= 0.55;
            it.w.multiplyScalar(0.7);
          }
        }
      }
      this.m.compose(it.p, it.q, this.opts.scale);
      this.mesh.setMatrixAt(k++, this.m);
    }
    this.mesh.count = k;
    if (k) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, world, events, audio) {
    this.scene = scene;
    this.world = world;
    this.events = events;
    this.audio = audio;
    this.particles = new Particles(scene, world);
    this.scars = new MarkPool(scene, 300, 0xc9b48c, 0.055, 'scar');
    this.groundMarks = new MarkPool(scene, 300, 0x2e261c, 0.14, 'ground');
    const brass = new THREE.MeshLambertMaterial({ color: 0xb08a3c, emissive: 0x1a1206 });
    patchMaterial(brass, { key: 'brass' });
    const caseGeo = new THREE.CylinderGeometry(0.0048, 0.0048, 0.045, 7);
    caseGeo.rotateZ(Math.PI / 2);
    this.casings = new Bodies(scene, world, caseGeo, brass, 160, { radius: 0.004, restitution: 0.3, scale: new THREE.Vector3(1, 1, 1) });
    const magMat = new THREE.MeshLambertMaterial({ color: 0x2a2b2d });
    patchMaterial(magMat, { key: 'magdrop' });
    const magGeo = new THREE.BoxGeometry(0.024, 0.19, 0.065);
    this.droppedMags = new Bodies(scene, world, magGeo, magMat, 12, { radius: 0.02, restitution: 0.15, scale: new THREE.Vector3(1, 1, 1), castShadow: true });
    this.time = 0;

    events.on('bullet:impact', (e) => this.onImpact(e));
    events.on('bullet:foliage', (e) => this.onFoliage(e));
    events.on('bullet:exit', (e) => this.onExit(e));
    events.on('shot', (e) => this.onShot(e));
    events.on('weapon:magDrop', (e) => this.onMagDrop(e));
  }

  _dust(x, y, z, col, scale, dir, count) {
    // 마른 흙에 소총탄이 박히면: 위로 솟는 짙은 먼지 기둥(1~2 m) + 낮게 퍼지는 먼지, 수 초간 바람에 흘러감.
    // 고운 먼지는 햇빛을 강하게 산란해 지면보다 밝게 보인다.
    const P = this.particles;
    for (let i = 0; i < count; i++) {
      const column = i < count * 0.45;
      const up = column ? 1.8 + rng.next() * 2.4 : 0.5 + rng.next() * 1.0;
      const out = column ? 0.2 + rng.next() * 0.5 : 0.6 + rng.next() * 1.4;
      const a = rng.next() * Math.PI * 2;
      const fwd = dir ? 0.6 + rng.next() * 1.0 : 0;
      const shade = 1.15 + rng.next() * 0.25;
      P.spawn({
        x: x + (rng.next() - 0.5) * 0.12,
        y: y + 0.04,
        z: z + (rng.next() - 0.5) * 0.12,
        vx: Math.cos(a) * out + (dir ? dir.x * fwd : 0),
        vy: up,
        vz: Math.sin(a) * out + (dir ? dir.z * fwd : 0),
        life: (2.6 + rng.next() * 2.2) * Math.min(1.2, scale + 0.2),
        size0: 0.14 * scale,
        size1: (column ? 0.75 + rng.next() * 0.5 : 0.9 + rng.next() * 0.7) * scale,
        r: Math.min(1, col[0] * shade),
        g: Math.min(1, col[1] * shade),
        b: Math.min(1, col[2] * shade),
        alpha: column ? 0.95 : 0.8,
        kind: PK.DUST,
        drag: column ? 1.9 : 2.6,
        gravity: 0.25,
        wind: 0.95,
      });
    }
  }

  /** 엎드려쏴 총구 먼지: 총구 앞 지면에서 옆·앞으로 퍼지는 낮은 먼지 구름(1~3 s) */
  _muzzleDust(x, y, z, col, k, d) {
    const P = this.particles;
    const n = Math.round(8 + 26 * k);
    const sx = -d.z;
    const sz = d.x;
    for (let i = 0; i < n; i++) {
      const side = (rng.next() - 0.5) * 2;
      const fwd = 0.6 + rng.next() * 2.4;
      const out = 1.2 + rng.next() * 3.2;
      const shade = 1.1 + rng.next() * 0.25;
      P.spawn({
        x: x + d.x * rng.next() * 0.6 + sx * side * 0.15,
        y: y + 0.03,
        z: z + d.z * rng.next() * 0.6 + sz * side * 0.15,
        vx: d.x * fwd + sx * side * out,
        vy: 0.25 + rng.next() * 1.1,
        vz: d.z * fwd + sz * side * out,
        life: (1.1 + rng.next() * 1.8) * (0.7 + 0.5 * k),
        size0: 0.12,
        size1: (0.7 + rng.next() * 0.8) * (0.6 + 0.6 * k),
        r: Math.min(1, col[0] * shade),
        g: Math.min(1, col[1] * shade),
        b: Math.min(1, col[2] * shade),
        alpha: 0.55 + 0.35 * k,
        kind: PK.DUST,
        drag: 3.2,
        gravity: 0.15,
        wind: 1.0,
      });
    }
  }

  _chips(x, y, z, col, n, speed, dir, size = 0.02, gravity = 9.8) {
    const P = this.particles;
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2;
      const s = speed * (0.4 + rng.next());
      P.spawn({
        x,
        y,
        z,
        vx: Math.cos(a) * s * 0.6 + (dir ? dir.x * s : 0),
        vy: 1 + rng.next() * speed,
        vz: Math.sin(a) * s * 0.6 + (dir ? dir.z * s : 0),
        life: 3 + rng.next() * 2,
        size0: size * (0.6 + rng.next() * 0.8),
        r: col[0] * (0.8 + rng.next() * 0.3),
        g: col[1] * (0.8 + rng.next() * 0.3),
        b: col[2] * (0.8 + rng.next() * 0.3),
        alpha: 1,
        kind: PK.CHIP,
        drag: 0.6,
        gravity,
        rotV: (rng.next() - 0.5) * 30,
        wind: 0.2,
      });
    }
  }

  _leaves(x, y, z, n) {
    const P = this.particles;
    for (let i = 0; i < n; i++) {
      const yellow = rng.next() < 0.25;
      P.spawn({
        x: x + (rng.next() - 0.5) * 0.4,
        y: y + (rng.next() - 0.5) * 0.4,
        z: z + (rng.next() - 0.5) * 0.4,
        vx: (rng.next() - 0.5) * 1.5,
        vy: rng.next() * 0.8,
        vz: (rng.next() - 0.5) * 1.5,
        life: 12,
        size0: 0.05 + rng.next() * 0.04,
        r: yellow ? 0.6 : 0.22,
        g: yellow ? 0.52 : 0.3,
        b: yellow ? 0.15 : 0.1,
        alpha: 1,
        kind: PK.LEAF,
        drag: 3.5,
        gravity: 1.6,
        rotV: (rng.next() - 0.5) * 8,
        wind: 1,
      });
    }
  }

  onImpact(e) {
    const dir = e.dir;
    if (e.kind === 'ground') {
      const col = DUST_COLORS[e.surface] || DUST_COLORS.stubble;
      const energyK = Math.min(1.25, Math.max(0.55, Math.sqrt(e.energy / 900)));
      this._dust(e.x, e.y, e.z, col, energyK * (e.ricochet ? 0.75 : 1), { x: dir.x * 0.6, z: dir.z * 0.6 }, e.ricochet ? 12 : 22);
      this._chips(e.x, e.y + 0.02, e.z, [col[0] * 0.55, col[1] * 0.5, col[2] * 0.45], 8, 3.2, { x: dir.x * 0.3, z: dir.z * 0.3 }, 0.025);
      if (e.surface === 'forest' || e.surface === 'grass' || e.surface === 'fallow') this._leaves(e.x, e.y + 0.1, e.z, 2);
      this.groundMarks.add({ x: e.x, y: e.y, z: e.z }, e.normal, 0.22);
    } else if (e.kind === 'trunk' || e.kind === 'log') {
      const back = { x: -dir.x, z: -dir.z };
      this._chips(e.x, e.y, e.z, [0.8, 0.72, 0.55], 8, 3.5, back, 0.022);
      this._chips(e.x, e.y, e.z, [0.25, 0.21, 0.17], 5, 2.5, back, 0.03);
      const P = this.particles;
      for (let i = 0; i < 4; i++)
        P.spawn({
          x: e.x,
          y: e.y,
          z: e.z,
          vx: back.x * 1.5 + (rng.next() - 0.5),
          vy: 0.3 + rng.next() * 0.5,
          vz: back.z * 1.5 + (rng.next() - 0.5),
          life: 0.9,
          size0: 0.04,
          size1: 0.28,
          r: 0.72,
          g: 0.65,
          b: 0.52,
          alpha: 0.6,
          kind: PK.DUST,
          drag: 3,
        });
      this.scars.add({ x: e.x, y: e.y, z: e.z }, e.normal, 0.06);
      if (e.y > 2.5) this._leaves(e.x, e.y + 1, e.z, 2);
    } else if (e.kind === 'rootPlate') {
      // 뿌리판: 흙덩이·먼지
      const back = { x: -dir.x, z: -dir.z };
      const col = DUST_COLORS.forest || DUST_COLORS.stubble;
      this._dust(e.x, e.y, e.z, col, 0.8, { x: back.x * 0.5, z: back.z * 0.5 }, 16);
      this._chips(e.x, e.y, e.z, [col[0] * 0.5, col[1] * 0.45, col[2] * 0.4], 8, 2.8, back, 0.025);
    } else if (e.kind === 'bale') {
      // 짚 부스러기 + 먼지
      const back = { x: -dir.x, z: -dir.z };
      this._chips(e.x, e.y, e.z, [0.78, 0.68, 0.42], 12, 2.6, back, 0.02);
      this._dust(e.x, e.y, e.z, [0.62, 0.56, 0.4], 0.55, { x: back.x * 0.5, z: back.z * 0.5 }, 10);
    } else if (e.kind === 'body') {
      // 옷 먼지(절제된 표현)
      const P = this.particles;
      for (let i = 0; i < 6; i++)
        P.spawn({
          x: e.x,
          y: e.y,
          z: e.z,
          vx: -dir.x * 0.6 + (rng.next() - 0.5) * 0.8,
          vy: 0.2 + rng.next() * 0.4,
          vz: -dir.z * 0.6 + (rng.next() - 0.5) * 0.8,
          life: 0.7,
          size0: 0.05,
          size1: 0.3,
          r: 0.46,
          g: 0.44,
          b: 0.36,
          alpha: 0.55,
          kind: PK.DUST,
          drag: 3,
        });
    }
  }

  onFoliage(e) {
    if (rng.next() < 0.75) this._leaves(e.x, e.y, e.z, 2 + Math.floor(rng.next() * 3) + e.strikes * 2);
  }

  onExit(e) {
    if (e.material && e.material.startsWith('wood')) this._chips(e.x, e.y, e.z, [0.8, 0.72, 0.55], 5, 4, null, 0.02);
  }

  onShot(e) {
    const P = this.particles;
    const m = e.position;
    const d = e.direction;
    P.spawn({ x: m.x + d.x * 0.04, y: m.y + d.y * 0.04, z: m.z + d.z * 0.04, life: 0.035, size0: 0.11 + rng.next() * 0.07, r: 1.0, g: 0.75, b: 0.4, alpha: 0.9, kind: PK.FLASH, drag: 0 });
    for (let i = 0; i < 3; i++)
      P.spawn({
        x: m.x + d.x * 0.1,
        y: m.y + d.y * 0.1,
        z: m.z + d.z * 0.1,
        vx: d.x * (2 + rng.next() * 3),
        vy: d.y * 2 + 0.2,
        vz: d.z * (2 + rng.next() * 3),
        life: 0.9 + rng.next() * 0.6,
        size0: 0.04,
        size1: 0.35,
        r: 0.78,
        g: 0.78,
        b: 0.76,
        alpha: 0.28,
        kind: PK.SMOKE,
        drag: 4,
        gravity: -0.15,
      });
    // 엎드려쏴: 총구 폭풍(소염기는 옆·위로 가스를 뿜는다)이 마른 흙·짚 부스러기를 일으켜 잠깐 시야를 가린다.
    // 총구가 땅에 가까울수록, 마른 맨흙일수록 크고, 바람에 흘러 흩어진다.
    if (e.stance === 'prone') {
      const pd = proneMuzzleDust(this.world, m, d);
      if (pd) this._muzzleDust(pd.x, pd.y, pd.z, DUST_COLORS[pd.surf] || DUST_COLORS.stubble, pd.k, d);
    }
    // 탄피 배출(플레이어 총만 — 적 탄피는 생략)
    if (!e.ejectDir) return;
    const ej = e.ejectDir;
    const speed = 3.6 * (0.85 + rng.next() * 0.3);
    const vel = new THREE.Vector3(ej.x, ej.y, ej.z).normalize().multiplyScalar(speed);
    vel.x += (rng.next() - 0.5) * 0.6;
    vel.y += rng.next() * 0.6;
    vel.z += (rng.next() - 0.5) * 0.6;
    const av = new THREE.Vector3((rng.next() - 0.5) * 60, (rng.next() - 0.5) * 60, (rng.next() - 0.5) * 60);
    this.casings.add(e.ejectPos, vel, e.weaponQuat, av);
  }

  onMagDrop(e) {
    const vel = new THREE.Vector3((rng.next() - 0.5) * 0.4, -0.5, (rng.next() - 0.5) * 0.4);
    const av = new THREE.Vector3((rng.next() - 0.5) * 6, (rng.next() - 0.5) * 6, (rng.next() - 0.5) * 6);
    this.droppedMags.add(e.position, vel, e.quat, av);
  }

  update(dt, time) {
    this.time = time;
    this.particles.update(dt, time);
    this.casings.update(dt, (it) => {
      const surf = this.world.terrain.surfaceAt(it.p.x, it.p.z);
      this.audio?.playCasing(it.p, surf);
    });
    this.droppedMags.update(dt, (it) => {
      const surf = this.world.terrain.surfaceAt(it.p.x, it.p.z);
      this.audio?.playMagDrop(it.p, surf);
    });
  }
}
