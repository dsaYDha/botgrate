// 방풍림 생성: 심은 열(간격 오차·빈자리·굽이) + 열 사이 자생목 + 어린나무·맹아 + 고사목·부러진 꼭대기·크게 기운 나무
// + 가장자리 관목대(수종별 덤불 무리) + 쓰러진 나무(뿌리판) + 그루터기. 띠 끝과 틈은 어린나무·관목으로 점점 낮아진다.
// 각 나무는 수종 템플릿(treeTemplates.js) 하나를 크기·회전·기울기·휨으로 변형한 것이고,
// 렌더러와 판정(줄기·굵은 가지·죽은 가지 그루터기·잎 볼륨·수관 지도)이 같은 데이터를 쓴다.

import { Random } from '../core/Random.js';
import { vnoise } from '../core/noise.js';
import { lerp, smoothstep, clamp } from '../core/math.js';
import { TREE_SPECIES, SNAG, SHRUB_SPECIES, BELT_STRUCTURE } from '../data/trees.js';
import { templateCatalog } from './treeTemplates.js';
import { stemCenterAt } from './stemShape.js';

const DEG = Math.PI / 180;

export class Shelterbelts {
  constructor(world, layout, terrain) {
    this.world = world;
    this.layout = layout;
    this.terrain = terrain;
    this.rng = new Random(world.seed ^ 0xbeef);
    this.catalog = templateCatalog();
    this.trees = []; // 나무(줄기 판정 객체 겸 렌더 인스턴스)
    this.shrubs = []; // 관목 렌더 인스턴스
    this.volumes = []; // 잎 볼륨(판정): 수관·관목
    this.limbs = []; // 굵은 가지·원줄기·죽은 가지(판정)
    this.logs = [];
    this.stumps = [];
    this._c = { x: 0, z: 0 };
    for (const belt of layout.belts) this._generateBelt(belt);
    this._placeFallen();
    for (const t of this.trees) this._finalizeTree(t);
    for (const s of this.shrubs) this._finalizeShrub(s);
  }

  // ---------------------------------------------------------------------------
  /** 띠 끝·틈에서의 성숙도(0 = 끝 바깥, 1 = 완전한 숲). 끝 근처는 어린나무·관목으로 낮아진다 */
  _maturity(belt, u) {
    const cov = belt.coverageDistance(u);
    const taper = this._taper[belt.id];
    return smoothstep(-2, taper, cov);
  }

  _generateBelt(belt) {
    const rng = this.rng;
    const S = BELT_STRUCTURE;
    const rows = belt.rows;
    const span = (rows - 1) * S.rowSpacing;
    const start = this.world.playerStart;
    const clear = this.world.playerClearing;
    this._taper = this._taper || {};
    this._taper[belt.id] = rng.range(S.endTaper[0], S.endTaper[1]);
    const species = belt.species;
    const ok = (x, z, r) => Math.hypot(x - start.x, z - start.z) > clear + r;

    // --- 심은 열 ---
    for (let r = 0; r < rows; r++) {
      const vRow = -span / 2 + r * S.rowSpacing;
      const centrality = rows > 1 ? 1 - Math.abs(r - (rows - 1) / 2) / ((rows - 1) / 2) : 1;
      const isEdgeRow = r === 0 || r === rows - 1;
      // 열마다 우점 수종: 가운데 열은 키 큰 수종(포플러·물푸레), 가장자리 열은 느릅·아카시아·단풍
      const w = {};
      for (const k in species) {
        const tallK = k === 'poplar' || k === 'ash' ? 0.5 + 1.0 * centrality : 1.25 - 0.6 * centrality;
        w[k] = species[k] * tallK;
      }
      const dominant = rng.weighted(w);
      const phase = rng.range(0, 100);
      let u = belt.from - 4 + rng.range(0, 2);
      let missRun = 0;
      while (u < belt.to + 4) {
        u += rng.range(S.inRowSpacing[0], S.inRowSpacing[1]);
        const mat = this._maturity(belt, u);
        if (mat <= 0.02) continue;
        if (missRun > 0) {
          missRun--;
          continue;
        }
        if (rng.chance(S.missing)) {
          if (rng.chance(S.missingRun)) missRun = rng.int(1, 3);
          continue;
        }
        const wave = (vnoise(u * 0.012 + phase, r * 3.1) - 0.5) * 2 * S.rowWave;
        const v = vRow + wave + rng.range(-S.rowJitter, S.rowJitter);
        const uu = u + rng.range(-0.35, 0.35);
        const { x, z } = belt.toWorld(uu, v);
        if (!ok(x, z, 0.8)) continue;
        const sp = rng.chance(0.78) ? dominant : rng.weighted(species);
        // 끝으로 갈수록 어리고 낮음, 끝 바깥쪽 몇 m는 어린나무만
        const young = mat < 0.999 ? mat : 1;
        this._addTree(belt, x, z, v, sp, { edge: isEdgeRow, centrality, maturity: young });
      }
    }

    // --- 열 사이 자생목·어린나무·맹아 ---
    const area = belt.length * belt.width;
    const nVol = Math.round((area / 100) * S.volunteerPer100m2);
    const volSpecies = { elm: 0.4, maple: 0.3, ash: 0.2, locust: 0.1 };
    for (let i = 0; i < nVol; i++) {
      const u = rng.range(belt.from - 2, belt.to + 2);
      const mat = this._maturity(belt, u);
      if (mat < 0.2) continue;
      const v = rng.range(-belt.half + 1.5, belt.half - 1.5);
      const { x, z } = belt.toWorld(u, v);
      if (!ok(x, z, 0.6)) continue;
      this._addTree(belt, x, z, v, rng.weighted(volSpecies), { volunteer: true, maturity: mat * rng.range(0.4, 0.8) });
    }
    const nSap = Math.round((area / 100) * S.saplingPer100m2);
    for (let i = 0; i < nSap; i++) {
      const u = rng.range(belt.from - 10, belt.to + 10);
      const cov = belt.coverageDistance(u);
      if (cov < -10) continue;
      // 끝 바깥·틈에는 어린나무가 더 많이(숲이 넓어지는 쪽)
      const v = rng.range(-belt.half - 1, belt.half + 1) * (cov < 0 ? 0.7 : 1);
      const { x, z } = belt.toWorld(u, v);
      if (!ok(x, z, 0.5)) continue;
      const sp = rng.weighted({ elm: 0.35, maple: 0.25, locust: 0.2, ash: 0.15, poplar: 0.05 });
      const n = rng.chance(0.3) ? rng.int(2, 5) : 1; // 맹아 무리
      for (let k = 0; k < n; k++) {
        const a = rng.range(0, Math.PI * 2);
        const rr = k ? rng.range(0.15, 0.6) : 0;
        this._addTree(belt, x + Math.cos(a) * rr, z + Math.sin(a) * rr, v, sp, { sapling: true, maturity: 0.15 });
      }
    }

    // --- 가장자리 관목대(수종별 덤불 무리, 띠 밖으로 나옴) ---
    const shrubW = belt.shrubs;
    for (const side of [-1, 1]) {
      let u = belt.from - 14;
      while (u < belt.to + 14) {
        u += rng.range(S.shrubStep[0], S.shrubStep[1]);
        const cov = belt.coverageDistance(u);
        if (cov < -14) continue;
        // 관목대가 얇아져 안이 들여다보이는 구간
        const thin = vnoise(u / 23 + belt.center * 0.01, side * 3.7);
        const keep = belt.edgeShrubDensity * (0.3 + 0.7 * smoothstep(0.12, 0.42, thin)) * (cov < 0 ? smoothstep(-14, 0, cov) : 1);
        if (!rng.chance(keep)) continue;
        // 덤불 무리: 낮은 주파수 노이즈로 수종을 고름(같은 종끼리 모여 자람)
        const pick = vnoise(u / 31 + side * 7.7, belt.center * 0.013);
        const keys = Object.keys(shrubW);
        let acc = 0;
        let spk = keys[0];
        const tot = keys.reduce((s, k) => s + shrubW[k], 0);
        for (const k of keys) {
          acc += shrubW[k] / tot;
          if (pick * 1.08 - 0.04 < acc) {
            spk = k;
            break;
          }
        }
        const band = rng.range(S.shrubBand[0], S.shrubBand[1]);
        const depth = Math.pow(rng.next(), 0.8);
        const v = side * (belt.half - 1.0 + band * depth);
        const { x, z } = belt.toWorld(u + rng.range(-0.4, 0.4), v);
        const sh = SHRUB_SPECIES[spk];
        const hsz = rng.range(sh.height[0], sh.height[1]) * (0.75 + 0.35 * (1 - depth)) * (cov < 0 ? 0.8 : 1);
        if (!ok(x, z, hsz * 0.4)) continue;
        this._addShrub(x, z, spk, hsz, belt);
      }
    }
    // --- 안쪽 드문 관목 ---
    const nIn = Math.floor(area * S.interiorShrubPerM2);
    for (let i = 0; i < nIn; i++) {
      const u = rng.range(belt.from, belt.to);
      if (belt.coverageDistance(u) < 2) continue;
      const v = rng.range(-belt.half + 2.5, belt.half - 2.5);
      const { x, z } = belt.toWorld(u, v);
      if (!ok(x, z, 1)) continue;
      const spk = rng.chance(0.6) ? 'elder' : 'blackthorn';
      this._addShrub(x, z, spk, rng.range(1.2, 2.4), belt);
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
      this.stumps.push(this._stem({ x, z, y0: y0 - 0.1, top: y0 + rng.range(0.25, 0.7), r0: r * 1.1, r1: r, flare: 0.25, material: 'woodDead', dead: true, stump: true, seed: rng.next() }));
    }
  }

  _stem(o) {
    return Object.assign({ kind: 'trunk', lx: 0, lz: 0, bx: 0, bz: 0, flare: 0, sink: 0.1, r1: o.r0 }, o);
  }

  /** 나무 하나 */
  _addTree(belt, x, z, v, speciesKey, opt) {
    const rng = this.rng;
    const S = BELT_STRUCTURE;
    const sp = TREE_SPECIES[speciesKey];
    const y0g = this.terrain.heightAt(x, z);
    const mat = opt.maturity ?? 1;
    let H;
    let dbh;
    let dead = false;
    let broken = 1; // 살아 있는 나무의 꼭대기 부러짐(1 = 온전)
    const hRank = rng.next();
    if (opt.sapling) {
      H = rng.range(1.6, 5.5);
      dbh = rng.range(0.02, 0.07);
    } else {
      H = lerp(sp.height[0], sp.height[1], hRank);
      dbh = lerp(sp.dbh[0], sp.dbh[1], Math.min(1, hRank * 0.65 + rng.next() * 0.4));
      if (opt.volunteer) {
        H *= rng.range(0.45, 0.75);
        dbh *= rng.range(0.4, 0.7);
      } else if (!opt.edge && rng.chance(S.suppressedFraction)) {
        // 피압목: 가늘고 낮다
        H *= rng.range(0.45, 0.7);
        dbh = rng.range(0.07, 0.14);
      }
      if (opt.edge) dbh *= 1.12;
      // 띠 끝으로 갈수록 어리고 낮다
      if (mat < 1) {
        H *= 0.35 + 0.65 * mat;
        dbh *= 0.4 + 0.6 * mat;
      }
      dead = rng.chance(belt.deadFraction) && H > 7;
      if (!dead && rng.chance(S.brokenTop) && H > 9) broken = rng.range(0.55, 0.8);
    }
    const cat = this.catalog;
    const tplList = dead ? cat.bySpecies.snag : cat.bySpecies[speciesKey];
    const T = cat.list[tplList[Math.floor(rng.next() * tplList.length)]];
    // 크기: 템플릿 실제 꼭대기(가지·잎 포함)를 나무 높이에 맞춤
    const s = H / T.bbox.maxY;
    const rScale = Math.max(0.08, dbh / 2 / T.refStemR);
    // 기울기: 수종 범위, 가장자리 열은 빛 쪽(바깥)으로, 일부는 크게 기움
    const outward = Math.sign(v) || 1;
    let leanDeg = rng.range(sp.lean[0], sp.lean[1]);
    let leanAz;
    if (opt.edge && !opt.sapling) {
      leanDeg += rng.range(1.5, 5);
      leanAz = Math.atan2(belt.n[1] * outward, belt.n[0] * outward) + rng.range(-0.6, 0.6);
    } else leanAz = rng.range(0, Math.PI * 2);
    if (!opt.sapling && rng.chance(S.leaning)) leanDeg = rng.range(10, 22);
    const lt = Math.tan(leanDeg * DEG);
    const lx = Math.cos(leanAz) * lt;
    const lz = Math.sin(leanAz) * lt;
    // 휨: 줄기 높이에 걸쳐 0.2~0.7 m(굽은 쪽은 기울기와 대략 반대 → 다시 빛 쪽으로 서는 모양)
    const stemTopH = T.stemTop * s;
    const bowM = rng.range(0.15, 0.7) * Math.min(1, H / 12);
    const bowAz = leanAz + Math.PI + rng.range(-1.2, 1.2);
    const bk = bowM / Math.max(1, stemTopH * stemTopH);
    const bx = Math.cos(bowAz) * bk;
    const bz = Math.sin(bowAz) * bk;
    const sink = 0.12;
    const y0 = y0g - sink;
    let top = y0 + stemTopH;
    if (broken < 1) top = y0 + Math.min(stemTopH, H * broken);
    if (dead) top = y0 + H * rng.range(0.55, 0.95);
    const r0 = (dbh / 2) * 1.06;
    let r1 = Math.min(r0 * 0.9, T.stemTopR * s * rScale);
    if (dead || broken < 1) r1 = Math.max(r1, r0 * (1 - 0.75 * ((top - y0) / Math.max(1, stemTopH))));
    const tree = this._stem({
      x,
      z,
      y0,
      top,
      r0,
      r1,
      lx,
      lz,
      bx,
      bz,
      flare: opt.sapling ? 0.1 : rng.range(0.28, 0.55) * Math.min(1, dbh / 0.25),
      sink,
      material: dead ? SNAG.material : sp.material,
      dead,
    });
    Object.assign(tree, {
      species: dead ? 'snag' : speciesKey,
      tpl: T.index,
      s,
      yaw: rng.range(0, Math.PI * 2),
      rScale,
      height: H,
      dbh,
      cut: broken < 1 || dead ? top + 0.2 : Infinity, // 이 높이 위 수관·가지 없음(부러진 꼭대기·고사목)
      broken: broken < 1 || dead,
      belt: belt.id,
      edge: opt.edge ? 1 : 0,
      sapling: !!opt.sapling,
      seed: rng.next(),
      bark: dead ? SNAG.bark : sp.bark,
    });
    // 잎색: 나무 단위로 조금씩 다르고, 일부 나무만 일찍 물든다
    const vv = 1 + rng.range(-0.12, 0.12);
    const gg = 1 + rng.range(-0.08, 0.08);
    tree.tint = [sp.leaf[0] * vv, sp.leaf[1] * vv * gg, sp.leaf[2] * vv];
    tree.autumn = rng.chance(sp.autumnChance) ? rng.range(0.25, 0.7) : rng.range(0.0, 0.18);
    this.trees.push(tree);
    return tree;
  }

  _addShrub(x, z, key, h, belt) {
    const rng = this.rng;
    const sp = SHRUB_SPECIES[key];
    const cat = this.catalog;
    const list = cat.bySpecies[key];
    const T = cat.list[list[Math.floor(rng.next() * list.length)]];
    const y0 = this.terrain.heightAt(x, z) - 0.05;
    const s = h / T.bbox.maxY;
    const vv = 1 + rng.range(-0.12, 0.12);
    this.shrubs.push({
      kind: 'shrubInst',
      species: key,
      tpl: T.index,
      x,
      z,
      y0,
      s,
      yaw: rng.range(0, Math.PI * 2),
      height: h,
      tint: [sp.leaf[0] * vv, sp.leaf[1] * vv, sp.leaf[2] * vv],
      fruit: rng.chance(sp.fruitChance) ? 1 : 0,
      autumn: rng.chance(0.12) ? rng.range(0.2, 0.5) : rng.range(0, 0.12),
      seed: rng.next(),
      belt: belt.id,
    });
  }

  /** 템플릿을 인스턴스 좌표로: 가지가 붙은 높이 hA에서의 줄기 변위 + 회전·크기 */
  _toWorld(t, p, hA, out) {
    const c = Math.cos(t.yaw);
    const sn = Math.sin(t.yaw);
    const s = t.s;
    const lx = p[0] * s;
    const lz = p[2] * s;
    stemCenterAt(t, hA * s, this._c);
    out[0] = this._c.x + lx * c - lz * sn;
    out[1] = t.y0 + p[1] * s;
    out[2] = this._c.z + lx * sn + lz * c;
    return out;
  }

  /** 잎 볼륨·굵은 가지·죽은 가지 판정 객체 만들기 */
  _finalizeTree(t) {
    const T = this.catalog.list[t.tpl];
    const tmp = [0, 0, 0];
    const tmp2 = [0, 0, 0];
    // 잎 볼륨(수관 덩이)
    t.volumes = [];
    if (!t.dead) {
      for (const L of T.lobes) {
        this._toWorld(t, L.c, L.hA, tmp);
        const ry = L.ry * t.s;
        if (tmp[1] - ry > t.cut) continue;
        const vol = {
          kind: 'foliage',
          material: 'foliage',
          tree: t,
          cx: tmp[0],
          cy: tmp[1],
          cz: tmp[2],
          rx: L.rh * t.s,
          ry,
          rz: L.rh * t.s,
          opacity: L.opacity * (t.sapling ? 0.6 : 1),
          seed: t.seed,
        };
        t.volumes.push(vol);
        this.volumes.push(vol);
      }
    }
    // 판정 가지: 원줄기(두 갈래)·굵은 가지 밑부분(지름 12 cm 이상)·사람 키 높이의 죽은 가지(지름 2.8 cm 이상).
    // 더 가는 가지는 잎 볼륨의 잔가지 타격(통계)으로 다룬다.
    t.limbs = [];
    const rs = t.s * Math.sqrt(t.rScale); // 가지 굵기 배율(렌더러와 같음): 줄기 굵기만큼 비례하진 않는다
    t.bScale = rs;
    for (const br of T.branches) {
      if (br.level === 2) continue;
      const minR = br.level === 3 ? 0.014 : br.level === 0 ? 0.03 : 0.06;
      const maxSeg = br.level === 1 ? 1 : 99;
      // 두 갈래 원줄기는 줄기와 같은 굵기 배율(갈라진 곳에서 줄기 끝과 굵기가 이어지게)
      const rsb = br.level === 0 ? t.s * t.rScale : rs;
      for (let i = 0; i < Math.min(br.pts.length - 1, maxSeg); i++) {
        const a = br.pts[i];
        const b = br.pts[i + 1];
        const ra = a[3] * rsb;
        const rb = b[3] * rsb;
        if (Math.max(ra, rb) < minR) break;
        this._toWorld(t, a, br.hA, tmp);
        this._toWorld(t, b, br.hA, tmp2);
        if (tmp[1] > t.cut) break;
        if (br.level === 3 && tmp[1] - t.y0 > 4.2) break;
        const limb = {
          kind: 'limb',
          ax: tmp[0],
          ay: tmp[1],
          az: tmp[2],
          bx: tmp2[0],
          by: tmp2[1],
          bz: tmp2[2],
          r: (ra + rb) * 0.5,
          material: br.dead || t.dead ? 'woodDead' : t.material,
          tree: t,
        };
        t.limbs.push(limb);
        this.limbs.push(limb);
      }
    }
  }

  _finalizeShrub(sh) {
    const T = this.catalog.list[sh.tpl];
    const c = Math.cos(sh.yaw);
    const sn = Math.sin(sh.yaw);
    sh.volumes = [];
    for (const L of T.lobes) {
      const lx = L.c[0] * sh.s;
      const lz = L.c[2] * sh.s;
      const vol = {
        kind: 'foliage',
        material: 'shrub',
        shrub: sh,
        cx: sh.x + lx * c - lz * sn,
        cy: sh.y0 + L.c[1] * sh.s,
        cz: sh.z + lx * sn + lz * c,
        rx: L.rh * sh.s,
        ry: L.ry * sh.s,
        rz: L.rh * sh.s,
        opacity: Math.min(0.95, L.opacity),
        seed: sh.seed,
      };
      sh.volumes.push(vol);
      this.volumes.push(vol);
    }
  }

  _placeFallen() {
    const rng = this.rng;
    const terrain = this.terrain;
    this.fallen = []; // 렌더용 쓰러진 나무(마디 점 목록·그루터기 가지·뿌리판)
    this.rootPlates = [];
    for (const belt of this.layout.belts) {
      const n = Math.round((belt.length / 100) * belt.fallenPer100m);
      for (let i = 0; i < n; i++) {
        const u = rng.range(belt.from + 8, belt.to - 8);
        if (belt.coverageDistance(u) < 4) continue;
        const v = rng.range(-belt.half + 2, belt.half - 2);
        const p = belt.toWorld(u, v);
        const across = rng.chance(0.6);
        const base = across ? Math.atan2(belt.n[1], belt.n[0]) * (rng.chance(0.5) ? 1 : -1) : Math.atan2(belt.t[1], belt.t[0]);
        const ang = base + rng.range(-0.7, 0.7);
        const len = rng.range(7, 15);
        const r = rng.range(0.12, 0.22);
        const r2 = r * 0.45;
        const ux = Math.cos(ang);
        const uz = Math.sin(ang);
        const ax = p.x;
        const az = p.z;
        const uprooted = rng.chance(0.5);
        const material = rng.chance(0.5) ? 'woodDead' : 'woodMedium';
        // 마디 점: 땅 높이를 따라 놓이고(약간 묻힘), 뿌리째 뽑힌 나무는 밑동이 뿌리판에 들려 있다
        const SEG = 3;
        const sideBow = rng.range(-0.25, 0.25);
        const pts = [];
        for (let k = 0; k <= SEG; k++) {
          const t = k / SEG;
          const bow = sideBow * Math.sin(Math.PI * t);
          const x = ax + ux * len * t - uz * bow;
          const z = az + uz * len * t + ux * bow;
          const rr = r + (r2 - r) * Math.pow(t, 0.9);
          let y = terrain.heightAt(x, z) + rr * 0.82;
          if (uprooted) y += 0.32 * Math.pow(1 - t, 2);
          pts.push([x, y, z, rr]);
        }
        const seed = rng.next();
        const segs = [];
        for (let k = 0; k < SEG; k++) {
          const a = pts[k];
          const b = pts[k + 1];
          const seg = { kind: 'log', ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], r: a[3], r2: b[3], material, seed };
          segs.push(seg);
          this.logs.push(seg);
        }
        // 부러진 가지 그루터기(지름 3~8 cm): 판정 가지로도 등록
        const stubs = [];
        const nStub = rng.int(3, 6);
        for (let k = 0; k < nStub; k++) {
          const t = rng.range(0.2, 0.95);
          const f = t * SEG;
          const j = Math.min(SEG - 1, Math.floor(f));
          const q = f - j;
          const A = pts[j];
          const B = pts[j + 1];
          const cx = A[0] + (B[0] - A[0]) * q;
          const cy = A[1] + (B[1] - A[1]) * q;
          const cz = A[2] + (B[2] - A[2]) * q;
          const cr = A[3] + (B[3] - A[3]) * q;
          // 위·옆으로 뻗은 것만 남는다(아래로 난 가지는 땅에 눌려 부러짐)
          const roll = rng.range(-1.3, 1.3);
          const dy = Math.cos(roll);
          const ds = Math.sin(roll);
          const tilt = rng.range(-0.5, 0.5);
          const dx = -uz * ds + ux * tilt;
          const dz = ux * ds + uz * tilt;
          const dl = Math.hypot(dx, dy, dz);
          const bl = rng.chance(0.65) ? rng.range(0.25, 0.7) : rng.range(0.8, 1.6);
          const br = Math.min(cr * 0.45, rng.range(0.015, 0.04));
          const s0 = [cx + (dx / dl) * cr * 0.7, cy + (dy / dl) * cr * 0.7, cz + (dz / dl) * cr * 0.7];
          const stub = {
            kind: 'limb',
            ax: s0[0],
            ay: s0[1],
            az: s0[2],
            bx: s0[0] + (dx / dl) * bl,
            by: s0[1] + (dy / dl) * bl,
            bz: s0[2] + (dz / dl) * bl,
            r: br * 0.8,
            r0: br,
            r1: br * 0.55,
            material: 'woodDead',
          };
          stubs.push(stub);
          this.limbs.push(stub);
        }
        // 뿌리판: 통나무 축 방향 두께 0.36 m의 흙·뿌리 원판(세워진 채). 판정은 짧은 원기둥(흙)
        let plate = null;
        if (uprooted) {
          const R = rng.range(0.8, 1.3);
          const cx = ax - ux * 0.25;
          const cz = az - uz * 0.25;
          const gy = terrain.heightAt(cx, cz);
          const cy = gy + R * 0.62;
          const hw = 0.18;
          plate = {
            kind: 'rootPlate',
            x: cx,
            y: cy,
            z: cz,
            ang,
            r: R,
            w: hw * 2,
            ax: cx - ux * hw,
            ay: cy,
            az: cz - uz * hw,
            bx: cx + ux * hw,
            by: cy,
            bz: cz + uz * hw,
            material: 'soil',
            seed,
          };
          this.rootPlates.push(plate);
        }
        this.fallen.push({ pts, segs, stubs, rootPlate: plate, material, seed, moss: rng.range(0.2, 0.8) });
        // 통나무와 겹치는 서 있는 나무 제거
        const ex = ax + ux * len;
        const ez = az + uz * len;
        this.trees = this.trees.filter((t) => distPointSeg2(t.x, t.z, ax, az, ex, ez) > r + t.r0 + 0.35);
        if (!uprooted) {
          this.stumps.push(
            this._stem({
              x: ax - ux * 0.2,
              z: az - uz * 0.2,
              y0: terrain.heightAt(ax, az) - 0.1,
              top: terrain.heightAt(ax, az) + rng.range(0.6, 1.4),
              r0: r * 1.2,
              r1: r,
              flare: 0.3,
              material: 'woodDead',
              dead: true,
              stump: true,
              snapped: true, // 꺾여 부러진 그루터기(꼭대기가 들쭉날쭉)
              seed: rng.next(),
            }),
          );
        }
      }
    }
    this.shrubs = this.shrubs.filter((s) => {
      for (const l of this.logs) if (distPointSeg2(s.x, s.z, l.ax, l.az, l.bx, l.bz) < 0.5) return false;
      return true;
    });
  }

  /** 공간 해시에 충돌체·잎 볼륨 등록 */
  register(hash) {
    for (const t of this.trees) {
      const L = t.top - t.y0;
      const ext = t.r0 * 1.6 + Math.abs(t.lx) * L + Math.abs(t.lz) * L + (Math.abs(t.bx) + Math.abs(t.bz)) * L * L;
      hash.insert(t, t.x - ext, t.z - ext, t.x + ext, t.z + ext);
    }
    for (const l of this.limbs) {
      const pad = l.r + 0.05;
      hash.insert(l, Math.min(l.ax, l.bx) - pad, Math.min(l.az, l.bz) - pad, Math.max(l.ax, l.bx) + pad, Math.max(l.az, l.bz) + pad);
    }
    for (const v of this.volumes) hash.insert(v, v.cx - v.rx, v.cz - v.rz, v.cx + v.rx, v.cz + v.rz);
    for (const s of this.stumps) hash.insert(s, s.x - s.r0 * 1.4, s.z - s.r0 * 1.4, s.x + s.r0 * 1.4, s.z + s.r0 * 1.4);
    for (const l of this.logs) {
      const pad = l.r + 0.2;
      hash.insert(l, Math.min(l.ax, l.bx) - pad, Math.min(l.az, l.bz) - pad, Math.max(l.ax, l.bx) + pad, Math.max(l.az, l.bz) + pad);
    }
    for (const p of this.rootPlates) hash.insert(p, p.x - p.r - 0.2, p.z - p.r - 0.2, p.x + p.r + 0.2, p.z + p.r + 0.2);
  }

  /** 수관(R)·관목(G) 밀도 지도: 햇빛 얼룩·하늘빛 가림·숲 판정용. 1 m 해상도. 잎 볼륨과 같은 모양 */
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
    for (const v of this.volumes) {
      if (v.material === 'shrub') splat(v.cx, v.cz, v.rx * 1.05, 0.85, tG);
      else splat(v.cx, v.cz, v.rx * 1.05, v.opacity, tR);
    }
    for (const t of this.trees) if (t.dead) splat(t.x, t.z, 1.2, 0.2, tR); // 고사목 가지
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

export { clamp };
