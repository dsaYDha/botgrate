// F3 디버그 오버레이(현실성 검증용, 평소 숨김): FPS, 위치·속도·자세, 현재 위치 풍속,
// 조준(흔들림 MOA·탄 분산·총열 온도·거치), 조준점 아래 표적까지 실제 거리와 그 지점 풍속,
// 총알 궤적 선, 명중 로그(부위, 거리, 착탄 속도, 운동에너지),
// 적마다 인지 단계·추정 위치 오차(아는 오차 / 실제 오차)·제압·사기·행동, 'AI가 아는 위치 vs 실제' 기록 요약,
// 3차원: 적이 아는 추정 위치와 오차 원(바닥의 고리).
// F4: 적 시선(눈 → 내 몸, 초록 = 보임 / 빨강 = 막힘), 가시도 수치, 적 탄 궤적, 소리 사건('딱' 방출점 노랑, 적 총성 주황).
// F6(F3이 켜져 있을 때): 디버그 전용 무적.
// 게임 화면에는 거리 정보가 어디에도 없다 — 이 디버그 화면에서만 보인다.

import * as THREE from 'three';
import { WindField } from '../world/Wind.js';
import { STAGE_NAMES } from '../ai/Knowledge.js';

export class DebugOverlay {
  constructor(el, scene, events) {
    this.el = el;
    this.visible = false;
    this.fps = 60;
    this.frameMs = 16;
    this.hits = [];
    this.lines = new THREE.Group();
    this.lines.visible = false;
    scene.add(this.lines);
    this.lineObjs = new Map();
    this.lastText = 0;
    this.aiVisible = false;
    // 동적 선분(추정 원·시선·소리 사건)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 8000), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6 * 8000), 3));
    this.segs = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
    this.segs.frustumCulled = false;
    this.segs.renderOrder = 999;
    this.segs.visible = false;
    scene.add(this.segs);
    this.events = [];
    events.on('bullet:flyby', (e) => this.events.push({ t: performance.now(), x: e.emit.x, y: e.emit.y, z: e.emit.z, c: [1, 0.9, 0.2], r: e.supersonic ? 0.6 : 0.3 }));
    events.on('shot', (e) => {
      if (e.shooter !== 'player') this.events.push({ t: performance.now(), x: e.position.x, y: e.position.y, z: e.position.z, c: [1, 0.5, 0.1], r: 0.8 });
    });
    events.on('enemy:hit', (e) => {
      this.hits.unshift(
        `${e.enemy.id.padEnd(4)} ${e.partName.padEnd(10)} ${e.distance.toFixed(0).padStart(4)} m  ${e.speed.toFixed(0).padStart(4)} m/s  ${e.energy.toFixed(0).padStart(5)} J${e.through ? '  관통' : ''}`,
      );
      if (this.hits.length > 10) this.hits.pop();
    });
    events.on('bullet:impact', (e) => {
      if (e.kind === 'body') return;
      const what = e.kind === 'ground' ? `지면(${e.surface}${e.material === 'leafLitter' ? '·낙엽층' : ''})${e.ricochet ? ' 도탄' : ''}` : e.kind === 'trunk' ? `줄기(${e.material})${e.through ? ' 관통' : ''}` : e.kind === 'bale' ? `짚 더미${e.through ? ' 관통' : ''}` : e.kind === 'rootPlate' ? `뿌리판(흙)${e.through ? ' 관통' : ''}` : e.kind === 'log' ? `통나무(${e.material})${e.through ? ' 관통' : ''}` : e.kind;
      this.lastImpact = `${what} ${e.distance.toFixed(0)} m, ${e.speed.toFixed(0)} m/s`;
    });
  }

  /** F4: 적 시선·가시도·탄 궤적·소리 사건(3차원 표시) */
  toggleAI() {
    this.aiVisible = !this.aiVisible;
    this.lines.visible = this.visible || this.aiVisible;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
    this.lines.visible = this.visible || this.aiVisible;
  }

  update(dt, g) {
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * Math.min(1, dt * 3);
    this.frameMs += (dt * 1000 - this.frameMs) * Math.min(1, dt * 3);
    if (!this.visible && !this.aiVisible) {
      this.segs.visible = false;
      return;
    }
    this._lines(g.bullets);
    this._ai3d(g);
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastText < 120) return;
    this.lastText = now;
    const p = g.player;
    const w = g.world.wind;
    const out = { x: 0, y: 0, z: 0 };
    const eye = g.eyePos;
    const sp = w.sample(eye.x, eye.y, eye.z, g.time, out);
    const sp2 = w.sample(eye.x, p.y + 10, eye.z, g.time, { x: 0, y: 0, z: 0 });
    const dirFrom = ((Math.atan2(-out.x, out.z) * 180) / Math.PI + 360) % 360;
    const weap = g.weapon;
    const info = g.renderer.info;
    const lines = [
      `FPS ${this.fps.toFixed(0)}  (${this.frameMs.toFixed(1)} ms)  draw ${info.render.calls}  tri ${(info.render.triangles / 1000).toFixed(0)}k  풀 ${g.vegetation.totalInstances}`,
      `위치 x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  고도 ${p.y.toFixed(2)} m   눈높이 ${(eye.y - p.y).toFixed(2)} m`,
      `속도 ${p.speed.toFixed(2)} m/s   자세 ${p.stance}${p.transition ? ` → ${p.transition.to} (${(p.transition.t / p.transition.dur * 100).toFixed(0)}%)` : ''}${p.sprinting ? '  [질주]' : ''}${p.walkMode ? '  [걷기]' : ''}`,
      `지면 ${p.surface}  덤불 ${(p.inShrub * 100).toFixed(0)}%  수관 ${(p.forestCover * 100).toFixed(0)}%   스태미나 ${(p.stamina * 100).toFixed(0)}%  심박 ${p.heart.toFixed(0)}  숨참기 ${weap.aim.hold.active ? weap.aim.hold.time.toFixed(1) + ' s' : '-'}`,
      `바람(현재 위치 눈높이) ${sp.toFixed(1)} m/s, ${WindField.compass(dirFrom)}풍 ${dirFrom.toFixed(0)}°   10 m 높이 ${sp2.toFixed(1)} m/s   차폐 ${(w.shelterAt(p.x, p.z) * 100).toFixed(0)}%`,
      `기본 바람 ${w.speed.toFixed(1)} m/s, ${WindField.compass(w.fromDeg)}풍 ${w.fromDeg.toFixed(0)}°`,
      `조준 ${(weap.ads * 100).toFixed(0)}%  ${weap.sight.name}  영점 ${weap.zero} m  ${weap.fireMode === 'semi' ? '단발' : '연발'}  약실 ${weap.chambered ? 1 : 0} + 탄창 ${weap.magCount}  예비 ${weap.mags.pouch.map((m) => m.rounds).join('/')}`,
      `흔들림 영역 ${weap.aim.swayDiameterMoa.toFixed(1)} MOA(90 % 지름: 표류 σ ${weap.aim.wanderMoa.toFixed(2)}, 호흡 ±${weap.aim.breathMoa.toFixed(1)})  팔 피로 ×${weap.aim.fatigue.toFixed(2)}  거치 ${weap.rest ? weap.rest.name : '-'}   지금 ${(weap.aim.yaw / 2.909e-4).toFixed(1)}/${(weap.aim.pitch / 2.909e-4).toFixed(1)} MOA`,
      `탄 분산 σ ${weap.dispersionMoa.toFixed(2)} MOA   총열 ${weap.barrelTemp.toFixed(0)} °C   급한 격발 ${(weap.lastJerk * 100).toFixed(0)}%   눈 어긋남 ${(Math.hypot(weap.aim.eyeOff.x, weap.aim.eyeOff.y) * 1000).toFixed(1)} mm`,
      this._aimLine(g),
      `총 걸림: 후퇴 ${(weap.obs.retract * 100).toFixed(1)} cm  피치 ${(weap.obs.pitch * 57.3).toFixed(1)}°  요 ${(weap.obs.yaw * 57.3).toFixed(1)}°`,
      `비행 중 탄 ${g.bullets.bullets.length}   적 정상 ${g.enemies.aliveCount}/${g.enemies.enemies.length}   마지막 탄착: ${this.lastImpact || '-'}`,
      ``,
      `명중 로그 (적  부위  거리  착탄속도  운동에너지)`,
      ...this.hits,
      ``,
      ...this._aiLines(g),
    ];
    this.el.textContent = lines.join('\n');
  }

  /** 적 인지·전술 상태(F3) */
  _aiLines(g) {
    const em = g.enemies;
    const p = g.player;
    const h = g.health;
    const L = [];
    const ws = h.wounds.map((w) => w.name + (w.tq ? '(지혈)' : '')).join(', ');
    L.push(`몸: ${h.alive ? '생존' : '사망'}  혈액 ${(h.blood * 100).toFixed(0)} %  제압 ${h.supp.toFixed(2)}  부상 ${ws || '-'}${h.tq ? `  지혈대 ${(h.tq.t / h.tq.dur * 100).toFixed(0)} %` : ''}${h.godMode ? '  [무적]' : ''}`);
    L.push(`적 부대(시드 ${em.seed}): ` + em.units.map((u) => `${u.name} ${u.phase} 사기 ${u.morale.toFixed(2)}${u.plan ? ' ' + u.plan.kind : ''}`).join(' | '));
    L.push(`인지 평가 ${em.senses.stats.ms.toFixed(2)} ms/프레임  시선 광선 누적 ${em.senses.sight.stats.rays}  길찾기 ${em.nav.stats.solved}건(${em.nav.queue.length} 대기)`);
    L.push(`적       역할  단계        아는 오차/실제   제압  행동                 탄       가시(D/P/몸)`);
    for (const e of em.enemies) {
      const K = e.knowledge;
      const st = K.stage(em.time);
      const actual = K.has ? Math.hypot(K.x - p.x, K.z - p.z) : null;
      const kn = K.has ? `${K.err.toFixed(0).padStart(4)}/${actual.toFixed(0).padStart(4)} m` : '      -    ';
      const role = { leader: '분대장', teamLeader: '조장', rifleman: '소총' }[e.role] || '';
      const state = e.dead ? '사망' : e.state !== 'normal' ? (e.incapacitated ? '불능' : '부상') : e.withdrawn ? '철수' : '';
      const v = e.vis;
      L.push(`${e.id.padEnd(8)} ${role.padEnd(4)} ${(STAGE_NAMES[st] || st).padEnd(6)} ${kn}  ${e.supp.toFixed(2)}  ${(state || e.brain.status).padEnd(14)} ${String(e.shooter.rounds).padStart(2)}+${e.shooter.spare}  ${v ? `${v.D.toFixed(2)}/${v.P.toFixed(2)}/${(v.frac * 100).toFixed(0)}%` : ''}`);
    }
    const sum = em.senses.log.summary();
    if (sum.length) {
      L.push(`AI가 아는 위치 vs 실제(출처별: 건수, 실제 오차 평균 / 아는 오차 평균, 2σ 안 비율, 수상하게 정확)`);
      for (const r of sum) L.push(`  ${r.source.padEnd(9)} ${String(r.n).padStart(5)}  ${r.actual.toFixed(1).padStart(6)} / ${r.err.toFixed(1).padStart(6)} m  ${(r.within * 100).toFixed(0).padStart(3)} %  ${(r.tiny * 100).toFixed(1)} %`);
    }
    return L;
  }

  /** 3차원 디버그 선: F3 추정 원, F4 시선·소리 사건 */
  _ai3d(g) {
    const pos = this.segs.geometry.attributes.position.array;
    const col = this.segs.geometry.attributes.color.array;
    let n = 0;
    const cap = pos.length / 6;
    const seg = (ax, ay, az, bx, by, bz, c) => {
      if (n >= cap) return;
      const i = n * 6;
      pos[i] = ax;
      pos[i + 1] = ay;
      pos[i + 2] = az;
      pos[i + 3] = bx;
      pos[i + 4] = by;
      pos[i + 5] = bz;
      col[i] = col[i + 3] = c[0];
      col[i + 1] = col[i + 4] = c[1];
      col[i + 2] = col[i + 5] = c[2];
      n++;
    };
    const T = g.world.terrain;
    const em = g.enemies;
    const stageCol = { unaware: [0.5, 0.5, 0.5], suspicious: [0.9, 0.9, 0.3], searching: [1, 0.6, 0.2], located: [1, 0.3, 0.2], engaging: [1, 0.1, 0.6] };
    if (this.visible) {
      for (const e of em.enemies) {
        const K = e.knowledge;
        if (!K.has || !e.canPerceive()) continue;
        const r = Math.min(400, K.err);
        const c = stageCol[K.stage(em.time)] || [1, 1, 1];
        const N = 24;
        for (let k = 0; k < N; k++) {
          const a0 = (k / N) * Math.PI * 2;
          const a1 = ((k + 1) / N) * Math.PI * 2;
          const x0 = K.x + Math.cos(a0) * r;
          const z0 = K.z + Math.sin(a0) * r;
          const x1 = K.x + Math.cos(a1) * r;
          const z1 = K.z + Math.sin(a1) * r;
          seg(x0, T.heightAt(x0, z0) + 0.3, z0, x1, T.heightAt(x1, z1) + 0.3, z1, c);
        }
        const y = T.heightAt(K.x, K.z);
        seg(K.x, y, K.z, K.x, y + 2.5, K.z, c);
      }
    }
    if (this.aiVisible) {
      const b = g.playerBody;
      const eye = { x: 0, y: 0, z: 0 };
      for (const e of em.enemies) {
        if (!e.canPerceive() || !e.vis) continue;
        if (Math.hypot(e.x - g.player.x, e.z - g.player.z) > 450) continue;
        e.eye(eye);
        const v = Math.max(...e.vis.T);
        const c = e.knowledge.visible ? [0.2, 1, 0.3] : v > 0.05 ? [0.9, 0.8, 0.2] : [0.9, 0.2, 0.2];
        seg(eye.x, eye.y, eye.z, b.center.x, b.center.y, b.center.z, c);
      }
      // 소리 사건(3 s)
      const now = performance.now();
      this.events = this.events.filter((q) => now - q.t < 3000);
      for (const q of this.events) {
        const r = q.r;
        seg(q.x - r, q.y, q.z, q.x + r, q.y, q.z, q.c);
        seg(q.x, q.y - r, q.z, q.x, q.y + r, q.z, q.c);
        seg(q.x, q.y, q.z - r, q.x, q.y, q.z + r, q.c);
      }
    }
    this.segs.geometry.setDrawRange(0, n * 2);
    this.segs.geometry.attributes.position.needsUpdate = true;
    this.segs.geometry.attributes.color.needsUpdate = true;
    this.segs.visible = n > 0;
  }

  /** 조준점(화면 가운데) 아래 처음 닿는 물체까지 실제 거리와 그 지점 풍속(지면 위 1.2 m) */
  _aimLine(g) {
    const cam = g.camera;
    const d = this._dir || (this._dir = new THREE.Vector3());
    cam.getWorldDirection(d);
    const p = cam.position;
    const hit = g.bullets.rayProbe(p.x, p.y, p.z, d.x, d.y, d.z, 1500);
    if (!hit) return '조준점 아래: 1500 m 안에 없음';
    const names = { ground: '지면', trunk: '나무 줄기', limb: '가지', log: '통나무', bale: '짚 더미', rootPlate: '뿌리판', body: '적' };
    const w = g.world.wind;
    const out = { x: 0, y: 0, z: 0 };
    const gy = g.world.terrain.heightAt(hit.x, hit.z);
    const sp = w.sample(hit.x, gy + 1.2, hit.z, g.time, out, gy);
    const from = ((Math.atan2(-out.x, out.z) * 180) / Math.PI + 360) % 360;
    return `조준점 아래: ${names[hit.kind] || hit.kind}${hit.part ? `(${hit.part})` : ''} ${hit.dist.toFixed(1)} m   그 지점 풍속 ${sp.toFixed(1)} m/s ${WindField.compass(from)}풍`;
  }

  _lines(bullets) {
    const seen = new Set();
    for (const b of bullets.trails) {
      seen.add(b.id);
      let obj = this.lineObjs.get(b.id);
      const n = b.trail.length / 3;
      if (!obj) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4096), 3));
        const mat = new THREE.LineBasicMaterial({ color: b.shooter === 'player' ? 0xffd040 : 0xff4040, transparent: true, opacity: 0.85, depthTest: true });
        obj = new THREE.Line(geo, mat);
        obj.frustumCulled = false;
        this.lines.add(obj);
        this.lineObjs.set(b.id, obj);
      }
      const arr = obj.geometry.attributes.position.array;
      const m = Math.min(n, 4096);
      arr.set(b.trail.subarray ? b.trail.subarray(0, m * 3) : b.trail.slice(0, m * 3));
      obj.geometry.setDrawRange(0, m);
      obj.geometry.attributes.position.needsUpdate = true;
    }
    for (const [id, obj] of this.lineObjs) {
      if (!seen.has(id)) {
        this.lines.remove(obj);
        obj.geometry.dispose();
        this.lineObjs.delete(id);
      }
    }
  }
}
