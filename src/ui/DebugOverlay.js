// F3 디버그 오버레이(현실성 검증용, 평소 숨김): FPS, 위치·속도·자세, 현재 위치 풍속,
// 총알 궤적 선, 명중 로그(부위, 거리, 착탄 속도, 운동에너지).

import * as THREE from 'three';
import { WindField } from '../world/Wind.js';

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

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
    this.lines.visible = this.visible;
  }

  update(dt, g) {
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * Math.min(1, dt * 3);
    this.frameMs += (dt * 1000 - this.frameMs) * Math.min(1, dt * 3);
    if (!this.visible) return;
    this._lines(g.bullets);
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
      `총 걸림: 후퇴 ${(weap.obs.retract * 100).toFixed(1)} cm  피치 ${(weap.obs.pitch * 57.3).toFixed(1)}°  요 ${(weap.obs.yaw * 57.3).toFixed(1)}°   흔들림 ${(weap.aim.yaw * 1000).toFixed(2)}/${(weap.aim.pitch * 1000).toFixed(2)} mrad`,
      `비행 중 탄 ${g.bullets.bullets.length}   적 정상 ${g.enemies.aliveCount}/${g.enemies.enemies.length}   마지막 탄착: ${this.lastImpact || '-'}`,
      ``,
      `명중 로그 (적  부위  거리  착탄속도  운동에너지)`,
      ...this.hits,
    ];
    this.el.textContent = lines.join('\n');
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
