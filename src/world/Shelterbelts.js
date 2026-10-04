// 방풍림 생성: 나무(열 구조·수종·크기), 가장자리 관목대, 고사목, 쓰러진 나무, 그루터기, 끊긴 틈.
// 결과는 렌더러(인스턴싱)와 물리(공간 해시 충돌체·잎 볼륨)가 함께 쓴다.

import { Random } from '../core/Random.js';
import { vnoise } from '../core/noise.js';
import { lerp, smoothstep } from '../core/math.js';
import { TREE_SPECIES, SNAG, SHRUBS, BELT_STRUCTURE } from '../data/trees.js';

export class Shelterbelts {
  constructor(world, layout, terrain) {
    this.world = world;
    this.layout = layout;
    this.terrain = terrain;
    this.rng = new Random(world.seed ^ 0xbeef);
    this.trees = [];
    this.shrubs = [];
    this.logs = [];
    this.stumps = [];
    for (const belt of layout.belts) this._generateBelt(belt);
    this._placeFallen();
  }

  _generateBelt(belt) {
    const rng = this.rng;
    const S = BELT_STRUCTURE;
    const rows = belt.rows;
    const span = (rows - 1) * S.rowSpacing;
    const edgeZone = Math.max(S.edgeZoneMin, belt.half - span / 2);
    const start = this.world.playerStart;
    const clear = this.world.playerClearing;

    // --- 나무 열 ---
    for (let r = 0; r < rows; r++) {
      const vRow = -span / 2 + r * S.rowSpacing;
      const centrality = rows > 1 ? 1 - Math.abs(r - (rows - 1) / 2) / ((rows - 1) / 2) : 1;
      const isEdgeRow = r === 0 || r === rows - 1;
      // 열마다 우점 수종
      const weights = {};
      for (const k in belt.species) {
        const w = belt.species[k];
        weights[k] = k === 'poplar' ? w * (0.6 + 0.8 * centrality) : w * (1.2 - 0.4 * centrality);
      }
      const dominant = rng.weighted(weights);
      let u = belt.from + rng.range(0.5, 2.5);
      while (u < belt.to - 0.5) {
        const step = rng.range(S.inRowSpacing[0], S.inRowSpacing[1]);
        const cov = belt.coverageDistance(u);
        if (cov > 0.6) {
          const v = vRow + rng.range(-S.rowJitter, S.rowJitter);
          const uu = u + rng.range(-0.4, 0.4);
          const { x, z } = belt.toWorld(uu, v);
          if (Math.hypot(x - start.x, z - start.z) > 1.4) {
            const species = rng.chance(0.75) ? dominant : rng.weighted(weights);
            this._addTree(belt, x, z, v, species, isEdgeRow, centrality, cov);
          }
        }
        u += step;
      }
    }

    // --- 가장자리 관목대 ---
    for (const side of [-1, 1]) {
      let u = belt.from - 1;
      while (u < belt.to + 1) {
        u += rng.range(S.shrubStep[0], S.shrubStep[1]);
        const cov = belt.coverageDistance(u);
        if (cov < -2.5) continue;
        // 관목대가 얇아지는 구간(안이 들여다보이는 곳)
        const thin = vnoise(u / 23 + belt.center * 0.01, side * 3.7);
        const keep = belt.edgeShrubDensity * (0.25 + 0.75 * smoothstep(0.12, 0.42, thin)) * (cov < 0 ? 0.35 : 1);
        if (!rng.chance(keep)) continue;
        const depth = Math.pow(rng.next(), 0.7); // 바깥쪽에 몰림
        const v = side * (belt.half - edgeZone + (edgeZone + S.shrubOutset) * depth);
        const { x, z } = belt.toWorld(u + rng.range(-0.4, 0.4), v);
        const h = rng.range(SHRUBS.height[0], SHRUBS.height[1]) * (0.75 + 0.4 * depth);
        const rad = rng.range(SHRUBS.radius[0], SHRUBS.radius[1]);
        if (Math.hypot(x - start.x, z - start.z) < clear + rad * 0.5) continue;
        this._addShrub(x, z, h, rad, belt);
      }
    }
    // --- 안쪽 드문 관목 ---
    const area = belt.length * (belt.width - 2 * edgeZone);
    const n = Math.floor(area * S.interiorShrubPerM2);
    for (let i = 0; i < n; i++) {
      const u = rng.range(belt.from, belt.to);
      if (belt.coverageDistance(u) < 1) continue;
      const v = rng.range(-belt.half + edgeZone, belt.half - edgeZone);
      const { x, z } = belt.toWorld(u, v);
      if (Math.hypot(x - start.x, z - start.z) < clear + 1) continue;
      const h = rng.range(SHRUBS.interiorHeight[0], SHRUBS.interiorHeight[1]);
      this._addShrub(x, z, h, rng.range(0.5, 1.1), belt);
    }

    // --- 그루터기 ---
    const nStumps = Math.floor((belt.length / 100) * 4);
    for (let i = 0; i < nStumps; i++) {
      const u = rng.range(belt.from, belt.to);
      if (belt.coverageDistance(u) < 0) continue;
      const v = rng.range(-span / 2, span / 2);
      const { x, z } = belt.toWorld(u, v);
      const y0 = this.terrain.heightAt(x, z);
      const r = rng.range(0.1, 0.22);
      this.stumps.push({
        kind: 'trunk',
        x,
        z,
        y0: y0 - 0.1,
        top: y0 + rng.range(0.25, 0.7),
        r0: r * 1.15,
        r1: r,
        lx: 0,
        lz: 0,
        material: 'woodDead',
        dead: true,
        stump: true,
        seed: rng.next(),
      });
    }
  }

  _addTree(belt, x, z, v, speciesKey, isEdgeRow, centrality, cov) {
    const rng = this.rng;
    const sp = TREE_SPECIES[speciesKey];
    const y0 = this.terrain.heightAt(x, z);
    const suppressed = !isEdgeRow && rng.chance(BELT_STRUCTURE.suppressedFraction);
    const hRank = rng.next();
    let H = lerp(sp.height[0], sp.height[1], hRank);
    let dbh = lerp(sp.dbh[0], sp.dbh[1], Math.min(1, hRank * 0.7 + rng.next() * 0.4));
    if (suppressed) {
      H = rng.range(6.5, 10.5);
      dbh = rng.range(BELT_STRUCTURE.suppressedDbh[0], BELT_STRUCTURE.suppressedDbh[1]);
    }
    // 바깥 열 나무는 빛을 향해 바깥으로 기울고 수관이 치우친다
    const outward = Math.sign(v) || 1;
    const leanMag = (isEdgeRow ? rng.range(0.02, 0.08) : rng.range(0, 0.035)) * (rng.chance(0.85) ? 1 : -1);
    const nx = belt.n[0] * outward;
    const nz = belt.n[1] * outward;
    const la = rng.range(-0.6, 0.6);
    const lx = leanMag * (nx * Math.cos(la) - nz * Math.sin(la)) + rng.range(-0.01, 0.01);
    const lz = leanMag * (nz * Math.cos(la) + nx * Math.sin(la)) + rng.range(-0.01, 0.01);

    const dead = rng.chance(belt.deadFraction);
    const r = dbh / 2;
    const tree = {
      kind: 'trunk',
      species: speciesKey,
      x,
      z,
      y0: y0 - 0.15,
      height: H,
      dbh,
      r0: r * 1.18,
      r1: r * 0.32,
      lx,
      lz,
      dead,
      suppressed,
      material: dead ? SNAG.material : sp.material,
      belt: belt.id,
      edge: isEdgeRow ? 1 : 0,
      seed: rng.next(),
      crown: null,
    };
    if (dead) {
      // 고사목: 윗부분이 부러져 있음
      const broken = rng.range(0.45, 0.92);
      tree.top = y0 + H * broken;
      tree.r1 = r * (1 - 0.6 * broken);
    } else {
      tree.top = y0 + H * 0.92;
      const cb = lerp(sp.crownBase[0], sp.crownBase[1], rng.next()) * (isEdgeRow ? 0.75 : 1);
      let R = lerp(sp.crownRadius[0], sp.crownRadius[1], rng.next());
      if (suppressed) R *= 0.55;
      const base = y0 + H * cb;
      const top = y0 + H;
      const shift = isEdgeRow ? rng.range(0.3, 1.0) : rng.range(0, 0.3);
      const ch = (base + top) / 2;
      tree.crown = {
        kind: 'foliage',
        material: 'foliage',
        tree,
        cx: x + lx * (ch - y0) + nx * shift,
        cy: ch,
        cz: z + lz * (ch - y0) + nz * shift,
        rx: R,
        ry: (top - base) / 2,
        rz: R,
        opacity: sp.crownOpacity * (suppressed ? 0.7 : 1),
        seed: tree.seed,
      };
    }
    this.trees.push(tree);
  }

  _addShrub(x, z, h, rad, belt) {
    const y0 = this.terrain.heightAt(x, z);
    this.shrubs.push({
      kind: 'foliage',
      material: 'shrub',
      cx: x,
      cy: y0 + h * 0.5,
      cz: z,
      rx: rad,
      ry: h * 0.5,
      rz: rad * this.rng.range(0.8, 1.2),
      y0,
      height: h,
      opacity: SHRUBS.opacity,
      seed: this.rng.next(),
      belt: belt.id,
    });
  }

  _placeFallen() {
    const rng = this.rng;
    const terrain = this.terrain;
    for (const belt of this.layout.belts) {
      const n = Math.round((belt.length / 100) * belt.fallenPer100m);
      for (let i = 0; i < n; i++) {
        const u = rng.range(belt.from + 8, belt.to - 8);
        if (belt.coverageDistance(u) < 4) continue;
        const v = rng.range(-belt.half + 2, belt.half - 2);
        const p = belt.toWorld(u, v);
        // 넘어진 방향: 띠를 가로지르거나 비스듬히
        const across = rng.chance(0.6);
        const base = across ? Math.atan2(belt.n[1], belt.n[0]) * (rng.chance(0.5) ? 1 : -1) : Math.atan2(belt.t[1], belt.t[0]);
        const ang = base + rng.range(-0.7, 0.7);
        const len = rng.range(7, 14);
        const r = rng.range(0.12, 0.21);
        const ax = p.x;
        const az = p.z;
        const bx = ax + Math.cos(ang) * len;
        const bz = az + Math.sin(ang) * len;
        const ay = terrain.heightAt(ax, az) + r * 0.85;
        const by = terrain.heightAt(bx, bz) + r * 0.5;
        const uprooted = rng.chance(0.5);
        const log = {
          kind: 'log',
          ax,
          ay: uprooted ? ay + 0.25 : ay,
          az,
          bx,
          by,
          bz,
          r,
          r2: r * 0.45,
          material: rng.chance(0.5) ? 'woodDead' : 'woodMedium',
          rootPlate: uprooted ? { x: ax - Math.cos(ang) * 0.3, z: az - Math.sin(ang) * 0.3, radius: rng.range(0.8, 1.3), ang } : null,
          seed: rng.next(),
        };
        this.logs.push(log);
        // 통나무와 겹치는 서 있는 나무 제거
        this.trees = this.trees.filter((t) => {
          const d = distPointSeg2(t.x, t.z, ax, az, bx, bz);
          return d > r + t.r0 + 0.25;
        });
        // 쓰러진 자리에는 그루터기(부러진 경우) 또는 뿌리판
        if (!uprooted) {
          this.stumps.push({
            kind: 'trunk',
            x: ax - Math.cos(ang) * 0.2,
            z: az - Math.sin(ang) * 0.2,
            y0: terrain.heightAt(ax, az) - 0.1,
            top: terrain.heightAt(ax, az) + rng.range(0.6, 1.4),
            r0: r * 1.2,
            r1: r,
            lx: 0,
            lz: 0,
            material: 'woodDead',
            dead: true,
            stump: true,
            seed: rng.next(),
          });
        }
      }
    }
    // 관목도 통나무와 너무 겹치면 줄인다
    this.shrubs = this.shrubs.filter((s) => {
      for (const l of this.logs) {
        if (distPointSeg2(s.cx, s.cz, l.ax, l.az, l.bx, l.bz) < 0.4) return false;
      }
      return true;
    });
  }

  /** 공간 해시에 충돌체·잎 볼륨 등록 */
  register(hash) {
    for (const t of this.trees) {
      const ext = t.r0 + Math.abs(t.lx) * (t.top - t.y0) + Math.abs(t.lz) * (t.top - t.y0);
      hash.insert(t, t.x - ext, t.z - ext, t.x + ext, t.z + ext);
      if (t.crown) {
        const c = t.crown;
        hash.insert(c, c.cx - c.rx, c.cz - c.rz, c.cx + c.rx, c.cz + c.rz);
      }
    }
    for (const s of this.stumps) hash.insert(s, s.x - s.r0, s.z - s.r0, s.x + s.r0, s.z + s.r0);
    for (const s of this.shrubs) hash.insert(s, s.cx - s.rx, s.cz - s.rz, s.cx + s.rx, s.cz + s.rz);
    for (const l of this.logs) {
      const pad = l.r + 0.2;
      hash.insert(l, Math.min(l.ax, l.bx) - pad, Math.min(l.az, l.bz) - pad, Math.max(l.ax, l.bx) + pad, Math.max(l.az, l.bz) + pad);
    }
  }

  /** 수관(R)·관목(G) 밀도 지도: 햇빛 얼룩·하늘빛 가림·숲 판정용. 1 m 해상도 */
  buildCanopyMap(half, res = 1) {
    const N = Math.round((2 * half) / res);
    const tR = new Float32Array(N * N).fill(1);
    const tG = new Float32Array(N * N).fill(1);
    const splat = (cx, cz, R, op, T) => {
      const i0 = Math.max(0, Math.floor((cx - R + half) / res));
      const i1 = Math.min(N - 1, Math.ceil((cx + R + half) / res));
      const j0 = Math.max(0, Math.floor((cz - R + half) / res));
      const j1 = Math.min(N - 1, Math.ceil((cz + R + half) / res));
      for (let j = j0; j <= j1; j++) {
        const z = -half + (j + 0.5) * res;
        for (let i = i0; i <= i1; i++) {
          const x = -half + (i + 0.5) * res;
          const q = ((x - cx) ** 2 + (z - cz) ** 2) / (R * R);
          if (q >= 1) continue;
          const c = op * Math.pow(1 - q, 0.6);
          T[j * N + i] *= 1 - c;
        }
      }
    };
    for (const t of this.trees) {
      if (t.crown) splat(t.crown.cx, t.crown.cz, t.crown.rx * 1.05, t.crown.opacity, tR);
      else if (t.dead && !t.stump) splat(t.x, t.z, 0.9, 0.25, tR); // 고사목 가지
    }
    for (const s of this.shrubs) splat(s.cx, s.cz, s.rx * 1.05, 0.85, tG);
    const data = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) {
      data[k * 4] = Math.round((1 - tR[k]) * 255);
      data[k * 4 + 1] = Math.round((1 - tG[k]) * 255);
      data[k * 4 + 2] = 0;
      data[k * 4 + 3] = 255;
    }
    this.canopy = { data, N, half, res };
    return this.canopy;
  }

  /** CPU 질의: 위치의 수관 밀도(0~1) */
  canopyAt(x, z) {
    const c = this.canopy;
    if (!c) return 0;
    const i = Math.floor((x + c.half) / c.res);
    const j = Math.floor((z + c.half) / c.res);
    if (i < 0 || j < 0 || i >= c.N || j >= c.N) return 0;
    return c.data[(j * c.N + i) * 4] / 255;
  }
}

function distPointSeg2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}
