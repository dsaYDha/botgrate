// 엄폐 지점(미리 계산): 탄을 막아 주는 진짜 엄폐물 옆 자리와, 그 자리가 막아 주는 방향(방위 ± 반폭).
//   굵은 줄기(반지름 12 cm 이상): 둘레 6곳 — 줄기 쪽 방향을 줄기가 보이는 각만큼 막음(서서·무릎)
//   통나무: 양옆 1.2 m마다 — 수직 방향 ±70°(낮음: 엎드리거나 무릎)
//   흙둔덕: 양옆 1.5 m마다 — 수직 방향 ±70°(낮음)
//   배수로: 바닥 3 m마다 — 배수로를 가로지르는 양쪽 방향 ±75°(엎드려야 함)
//   짚 더미·뿌리판: 둘레 — 그쪽 방향(무릎)
// 질의: 위협 방위를 막아 주는 비어 있는 자리 중 점수가 가장 좋은 곳. 자리는 한 사람만 차지(다른 적과 간격 유지).

import { WORLD } from '../data/world.js';

const CELL = 8;

export class CoverMap {
  constructor(world) {
    this.world = world;
    this.points = [];
    this.half = world.data.mapHalf;
    this.n = Math.ceil((2 * this.half) / CELL);
    this.grid = new Array(this.n * this.n).fill(null);
    const t0 = performance.now();
    this._build();
    this.buildMs = performance.now() - t0;
  }

  _add(x, z, dir, half, kind, low, h, obj) {
    const T = this.world.terrain;
    if (!T.inMap(x, z)) return;
    const p = { x, z, dir, half, kind, low, h, obj, occ: null, id: this.points.length };
    this.points.push(p);
    const i = Math.floor((x + this.half) / CELL);
    const j = Math.floor((z + this.half) / CELL);
    const k = j * this.n + i;
    (this.grid[k] || (this.grid[k] = [])).push(p);
  }

  _build() {
    const w = this.world;
    const B = w.belts;
    const bearing = (fx, fz, tx, tz) => Math.atan2(tx - fx, -(tz - fz));
    // 줄기
    for (const t of B.trees) {
      if (t.r0 < 0.12 || t.top - t.y0 < 1.5) continue;
      const R = t.r0 + 0.45;
      const half = Math.atan2(t.r0 + 0.08, R);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + (t.seed || 0) * 6;
        const x = t.x + Math.cos(a) * R;
        const z = t.z + Math.sin(a) * R;
        this._add(x, z, bearing(x, z, t.x, t.z), half, 'trunk', false, t.top - t.y0, t);
      }
    }
    for (const s of B.stumps || []) {
      if (s.r0 < 0.15 || (s.top || 0) - (s.y0 || 0) < 0.4) continue;
      const R = s.r0 + 0.45;
      const half = Math.atan2(s.r0 + 0.05, R);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        const x = s.x + Math.cos(a) * R;
        const z = s.z + Math.sin(a) * R;
        this._add(x, z, bearing(x, z, s.x, s.z), half, 'stump', true, s.top - s.y0, s);
      }
    }
    // 통나무
    for (const l of B.logs) {
      const dx = l.bx - l.ax;
      const dz = l.bz - l.az;
      const L = Math.hypot(dx, dz);
      if (L < 1) continue;
      const ux = dx / L;
      const uz = dz / L;
      const r = (l.r + l.r2) * 0.5;
      if (r < 0.12) continue;
      for (let s = 0.6; s < L - 0.3; s += 1.2) {
        const cx = l.ax + ux * s;
        const cz = l.az + uz * s;
        for (const side of [-1, 1]) {
          const x = cx - uz * side * (r + 0.4);
          const z = cz + ux * side * (r + 0.4);
          this._add(x, z, bearing(x, z, cx, cz), 70 * (Math.PI / 180), 'log', true, 2 * r, l);
        }
      }
    }
    // 흙둔덕
    for (const b of WORLD.berms) {
      const ux = Math.cos(b.angle);
      const uz = Math.sin(b.angle);
      for (let s = -b.length / 2 + 0.75; s <= b.length / 2 - 0.5; s += 1.5) {
        const cx = b.x + ux * s;
        const cz = b.z + uz * s;
        for (const side of [-1, 1]) {
          const x = cx - uz * side * (b.width / 2 + 0.4);
          const z = cz + ux * side * (b.width / 2 + 0.4);
          this._add(x, z, bearing(x, z, cx, cz), 70 * (Math.PI / 180), 'berm', true, b.height, b);
        }
      }
    }
    // 배수로: 바닥에 엎드리면 양쪽 둑이 막아 준다
    for (const d of w.layout.ditches) {
      const b = d.beltRef;
      for (let u = b.from + 4; u <= b.to - 4; u += 3) {
        if (b.inGap && b.inGap(u)) continue;
        const p = b.toWorld(u, d.v);
        const nx = b.axis === 'x' ? 0 : 1;
        const nz = b.axis === 'x' ? 1 : 0;
        for (const side of [-1, 1]) this._add(p.x, p.z, Math.atan2(nx * side, -nz * side), 75 * (Math.PI / 180), 'ditch', true, d.depth, d);
      }
    }
    // 짚 더미·뿌리판
    for (const p of w.props.bales || []) {
      const R = p.r + p.w * 0.5 + 0.45;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const x = p.x + Math.cos(a) * R;
        const z = p.z + Math.sin(a) * R;
        this._add(x, z, bearing(x, z, p.x, p.z), 40 * (Math.PI / 180), 'bale', false, 2 * p.r, p);
      }
    }
    for (const p of B.rootPlates || []) {
      const ux = Math.cos(p.ang);
      const uz = Math.sin(p.ang);
      for (const side of [-1, 1]) {
        const x = p.x + ux * side * (p.w * 0.5 + 0.5);
        const z = p.z + uz * side * (p.w * 0.5 + 0.5);
        this._add(x, z, bearing(x, z, p.x, p.z), Math.atan2(p.r, 0.7), 'rootPlate', false, p.r * 1.6, p);
      }
    }
  }

  /** 이 자리가 방위 bearing에서 오는 탄을 막는가 */
  protects(p, fromX, fromZ) {
    const b = Math.atan2(fromX - p.x, -(fromZ - p.z));
    let d = b - p.dir;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs(d) <= p.half;
  }

  /** (x,z) 둘레 r 안 자리들 */
  near(x, z, r, out = []) {
    out.length = 0;
    const i0 = Math.max(0, Math.floor((x - r + this.half) / CELL));
    const i1 = Math.min(this.n - 1, Math.floor((x + r + this.half) / CELL));
    const j0 = Math.max(0, Math.floor((z - r + this.half) / CELL));
    const j1 = Math.min(this.n - 1, Math.floor((z + r + this.half) / CELL));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.grid[j * this.n + i];
        if (!c) continue;
        for (const p of c) if ((p.x - x) ** 2 + (p.z - z) ** 2 <= r2) out.push(p);
      }
    }
    return out;
  }

  /**
   * 가장 좋은 엄폐 자리.
   * @param {object} o {x, z, r, threat:{x,z}|null, self, spacing, score(p, d) 추가 점수(작을수록 좋음), allowLow}
   */
  find(o) {
    const c = this.near(o.x, o.z, o.r, this._tmp || (this._tmp = []));
    let best = null;
    let bestS = Infinity;
    const sp2 = (o.spacing ?? 4) ** 2;
    for (const p of c) {
      if (p.occ && p.occ !== o.self) continue;
      if (o.threat && !this.protects(p, o.threat.x, o.threat.z)) continue;
      if (o.allowLow === false && p.low) continue;
      if (o.taken) {
        let crowded = false;
        for (const q of o.taken) {
          if (q !== o.self && (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < sp2) {
            crowded = true;
            break;
          }
        }
        if (crowded) continue;
      }
      const d = Math.hypot(p.x - o.x, p.z - o.z);
      let s = d + (o.score ? o.score(p, d) : 0);
      if (p.kind === 'ditch' || p.kind === 'log' || p.kind === 'berm') s -= 0.5; // 몸 전체를 가리는 낮은 엄폐는 조금 우선
      if (s < bestS) {
        bestS = s;
        best = p;
      }
    }
    return best;
  }

  reserve(p, agent) {
    if (p.occ && p.occ !== agent) return false;
    p.occ = agent;
    return true;
  }

  release(p, agent) {
    if (p && p.occ === agent) p.occ = null;
  }

  releaseAll(agent) {
    for (const p of this.points) if (p.occ === agent) p.occ = null;
  }
}
