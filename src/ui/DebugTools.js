// 디버그 모드(` 키로 켜고 끔, 기본 꺼짐 — 주소에 ?debug를 붙이면 켜진 채 시작). 켜진 동안만 아래 키가 동작한다.
//   F2  적 위치 표시: 모든 적·더미에 가려져도 보이는 표식과 이름·거리·상태
//   F3  조준점(화면 가운데가 처음 닿는 곳, 400 m 안 — 없으면 앞 40 m)에 적 소환. 다른 적과 같은 인지·두뇌·소총,
//       처음엔 플레이어를 모른다(소환조 부대).
//   F4  조준점에 더미 생성: 서 있는 표적. 보지도 쏘지도 움직이지도 않고, 맞으면 적과 같은 부상 모델로 쓰러진다.
//   F6  무적   F8  정보 오버레이   F9  AI 시선·소리 사건
// 디버그 모드를 끄면 표시와 무적은 모두 꺼진다. 소환한 적과 더미는 P(초기화)로 사라진다.

import * as THREE from 'three';
import { KEYS } from '../core/Input.js';

const MAX_MARK = 64;

export class DebugTools {
  constructor(g) {
    this.g = g;
    this.on = g.params.has('debug');
    this.markers = false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_MARK * 14 * 6), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_MARK * 14 * 6), 3));
    this.segs = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.segs.frustumCulled = false;
    this.segs.renderOrder = 1000;
    this.segs.visible = false;
    g.scene.add(this.segs);
    this.labelBox = document.createElement('div');
    this.labelBox.id = 'debug-labels';
    document.body.appendChild(this.labelBox);
    this.labels = [];
    this._v = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  handleInput(inp) {
    const g = this.g;
    if (inp.wasPressed(KEYS.debugMode)) this.setMode(!this.on);
    if (!this.on) return;
    if (inp.wasPressed(KEYS.debugMarkers)) {
      this.markers = !this.markers;
      g.toast.show(`적 위치 표시: ${this.markers ? '켜짐' : '꺼짐'}`);
    }
    if (inp.wasPressed(KEYS.spawnEnemy)) this._spawn('enemy');
    if (inp.wasPressed(KEYS.spawnDummy)) this._spawn('dummy');
    if (inp.wasPressed(KEYS.god)) {
      g.health.godMode = !g.health.godMode;
      g.toast.show(`디버그 무적: ${g.health.godMode ? '켜짐' : '꺼짐'}`);
    }
    if (inp.wasPressed(KEYS.debug)) g.debug.toggle();
    if (inp.wasPressed(KEYS.debugAI)) g.debug.toggleAI();
  }

  setMode(on) {
    const g = this.g;
    this.on = on;
    if (!on) {
      this.markers = false;
      if (g.debug.visible) g.debug.toggle();
      if (g.debug.aiVisible) g.debug.toggleAI();
      g.health.godMode = false;
    }
    g.toast.show(on ? '디버그 모드 켜짐 — F2 적 위치 · F3 적 소환 · F4 더미 · F6 무적 · F8 정보 · F9 AI 시선' : '디버그 모드 꺼짐');
  }

  /** 조준점: 화면 가운데에서 나간 광선이 처음 닿는 고체(지면·줄기·통나무·몸…), 400 m 안. 없으면 앞 40 m의 지면. */
  aimPoint() {
    const g = this.g;
    const cam = g.camera;
    const d = this._dir;
    cam.getWorldDirection(d);
    const p = cam.position;
    const hit = g.bullets.rayProbe(p.x, p.y, p.z, d.x, d.y, d.z, 400);
    const hl = Math.hypot(d.x, d.z) || 1;
    const hx = d.x / hl;
    const hz = d.z / hl;
    let x;
    let z;
    if (hit) {
      // 줄기·몸에 닿았으면 그 앞(플레이어 쪽) 0.8 m에 세운다
      const back = hit.kind === 'ground' ? 0 : 0.8;
      x = hit.x - hx * back;
      z = hit.z - hz * back;
    } else {
      x = p.x + hx * 40;
      z = p.z + hz * 40;
    }
    // 너무 가까우면 3 m 앞
    const dist = Math.hypot(x - p.x, z - p.z);
    if (dist < 3) {
      x = p.x + hx * 3;
      z = p.z + hz * 3;
    }
    const half = g.world.terrain.half || 1e9;
    if (Math.abs(x) > half - 5 || Math.abs(z) > half - 5) return null;
    return { x, z, dist: Math.hypot(x - p.x, z - p.z) };
  }

  _spawn(kind) {
    const g = this.g;
    const a = this.aimPoint();
    if (!a) {
      g.toast.show('조준점이 전장 밖이다');
      return;
    }
    const p = g.player;
    const look = Math.atan2(p.x - a.x, -(p.z - a.z)); // 플레이어 쪽을 보고 선다
    const e = kind === 'enemy' ? g.enemies.spawnDebugEnemy(a.x, a.z, look) : g.enemies.spawnDummy(a.x, a.z, look);
    g.toast.show(`${kind === 'enemy' ? '적 소환' : '더미 생성'}: ${e.id}, ${a.dist.toFixed(0)} m`);
  }

  update() {
    const show = this.on && this.markers;
    this.segs.visible = show;
    this.labelBox.style.display = show ? '' : 'none';
    if (!show) return;
    const g = this.g;
    const em = g.enemies;
    const list = em.enemies.concat(em.dummies);
    const pos = this.segs.geometry.attributes.position.array;
    const col = this.segs.geometry.attributes.color.array;
    let n = 0;
    const seg = (x0, y0, z0, x1, y1, z1, c) => {
      const i = n * 6;
      pos[i] = x0;
      pos[i + 1] = y0;
      pos[i + 2] = z0;
      pos[i + 3] = x1;
      pos[i + 4] = y1;
      pos[i + 5] = z1;
      col[i] = col[i + 3] = c[0];
      col[i + 1] = col[i + 4] = c[1];
      col[i + 2] = col[i + 5] = c[2];
      n++;
    };
    const cam = g.camera;
    const W = g.renderer.domElement.clientWidth || innerWidth;
    const H = g.renderer.domElement.clientHeight || innerHeight;
    const eye = g.eyePos;
    // 가까운 것부터 그려, 이름표가 겹치면 위로 한 줄씩 쌓는다(먼 숲띠의 분대원 여럿이 한 점에 몰려도 읽히게)
    const sorted = list.slice(0, MAX_MARK).sort((a, b) => Math.hypot(a.x - eye.x, a.z - eye.z) - Math.hypot(b.x - eye.x, b.z - eye.z));
    const placed = [];
    let k = 0;
    for (const e of sorted) {
      const c = this._color(e);
      const top = e.y + (e.state !== 'normal' || e.stance === 'prone' ? 0.5 : e.stance === 'kneel' ? 1.25 : 1.85);
      const r = 0.35;
      // 발밑 십자 + 머리까지 세로선 + 머리 위 마름모
      seg(e.x - r, e.y + 0.05, e.z, e.x + r, e.y + 0.05, e.z, c);
      seg(e.x, e.y + 0.05, e.z - r, e.x, e.y + 0.05, e.z + r, c);
      seg(e.x, e.y + 0.05, e.z, e.x, top, e.z, c);
      const hy = top + 0.45;
      const q = 0.22;
      seg(e.x - q, hy, e.z, e.x, hy + q, e.z, c);
      seg(e.x, hy + q, e.z, e.x + q, hy, e.z, c);
      seg(e.x + q, hy, e.z, e.x, hy - q, e.z, c);
      seg(e.x, hy - q, e.z, e.x - q, hy, e.z, c);
      // 이름표(화면 좌표)
      const v = this._v.set(e.x, hy + 0.35, e.z).project(cam);
      let el = this.labels[k];
      if (!el) {
        el = document.createElement('div');
        el.className = 'dbg-label';
        this.labelBox.appendChild(el);
        this.labels[k] = el;
      }
      k++;
      if (v.z > 1 || v.z < -1) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      const d = Math.hypot(e.x - eye.x, e.z - eye.z);
      const text = `${e.id} ${d.toFixed(0)} m ${this._status(e)}`.trim();
      if (el.textContent !== text) el.textContent = text;
      let w = 6;
      for (const ch of text) w += ch.charCodeAt(0) > 0x1100 ? 11 : 6.6;
      const sx = ((v.x + 1) / 2) * W;
      let sy = ((1 - v.y) / 2) * H;
      for (let row = 0; row < 12; row++) {
        const hit = placed.some((r) => Math.abs(r.x - sx) < (r.w + w) / 2 && Math.abs(r.y - sy) < 13);
        if (!hit) break;
        sy -= 13;
      }
      placed.push({ x: sx, y: sy, w });
      el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      el.style.color = `rgb(${(c[0] * 255) | 0}, ${(c[1] * 255) | 0}, ${(c[2] * 255) | 0})`;
    }
    for (let i = k; i < this.labels.length; i++) this.labels[i].style.display = 'none';
    const geo = this.segs.geometry;
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  _color(e) {
    if (e.dummy) return e.state === 'normal' ? [1, 0.9, 0.25] : [0.6, 0.55, 0.3];
    if (e.withdrawn) return [0.35, 0.6, 1];
    if (e.dead || e.incapacitated) return [0.55, 0.55, 0.55];
    if (e.state !== 'normal') return [1, 0.6, 0.15];
    return [1, 0.22, 0.18];
  }

  _status(e) {
    if (e.dead) return '사망';
    if (e.dummy) return e.state === 'normal' ? '' : '쓰러짐';
    if (e.withdrawn) return '철수';
    if (e.state !== 'normal') return e.incapacitated ? '불능' : '부상';
    return e.brain ? e.brain.status : '';
  }
}
