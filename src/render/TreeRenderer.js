// 방풍림 렌더링: 수종 템플릿(world/treeTemplates.js)을 인스턴싱한다.
//  - 인스턴스 정보(위치·크기·회전·기울기/휨·부러진 높이·잎색·물듦·줄기 굵기 …)는 데이터 텍스처 한 장에 고정,
//    프레임마다 LOD 묶음별로 (번호, 흐림)만 올린다.
//  - LOD: 가까이 = 잎 뭉치 카드 전부 + 가지 전부, 중간 = 카드 30 %(1.7배 크기) + 굵은 가지, 멀리 = 임포스터(8방위).
//    전환은 화면 디더로 두 LOD를 겹치지 않게 섞는다(튀지 않게). 거리 기준은 화면 크기(거리 ÷ 배율 ÷ 나무 크기).
//  - 그림자: 그림자 전용 묶음(시야 밖 나무 포함, 관찰자 둘레 그림자 거리 안) — 줄기 항상, 잎은 '높음'에서.
//  - 쓰러진 나무·그루터기 가지·뿌리판은 월드 좌표 정적 기하 하나.
// 화면 모양은 판정과 같은 데이터: 줄기 = stemShape(휨·기울기·가늘어짐·뿌리 퍼짐), 가지 = 템플릿 골격 × 같은 배율,
// 잎 = 같은 템플릿의 잎 뭉치(판정 볼륨은 그 뭉치들의 군집 타원체).

import * as THREE from 'three';
import { U } from './shaderLib.js';
import { templateCatalog } from '../world/treeTemplates.js';
import { makeLeafClusterAtlas, makeBarkTextures } from './treeTextures.js';
import { clusterGeometry, branchGeometry, trunkGeometry, impostorGeometry, tubeGeometry } from './trees/treeGeometry.js';
import { makeTreeMaterial, makeWoodMaterial, makeImpostorMaterial, speciesUniforms, SPECIES_INDEX, TREE_TEX_W, TEXELS, FLAG, IMP } from './trees/treeShaders.js';
import { bakeImpostors, impostorFrame, impostorGrid } from './trees/Impostors.js';
import { Random } from '../core/Random.js';

// LOD 경계(유효 거리 = 거리 ÷ (배율 × 품질 배수 × 크기 계수)), [시작, 끝] 사이는 디더 전환
const LOD = {
  tree: { a: [32, 40], b: [135, 165], trunk: [25, 80] },
  shrub: { a: [19, 25], b: [85, 105] },
  stumpCull: 120,
};

function shareGeometry(g) {
  const out = new THREE.InstancedBufferGeometry();
  out.setIndex(g.index);
  for (const k in g.attributes) out.setAttribute(k, g.attributes[k]);
  out.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  out.instanceCount = 0;
  return out;
}

/** 인스턴스 묶음: (번호, 흐림) 배열을 채워 한 번에 그린다. shadow = 그림자 전용(본 화면에는 0개) */
class Bucket {
  constructor(scene, geometry, material, capacity, opt = {}) {
    this.cap = Math.max(1, capacity);
    this.arr = new Float32Array(this.cap * 2);
    this.attr = new THREE.InstancedBufferAttribute(this.arr, 2);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geo = shareGeometry(geometry);
    this.geo.setAttribute('aInst', this.attr);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.shadow = !!opt.shadow;
    this.count = 0;
    this.n = 0;
    if (this.shadow) {
      this.mesh.castShadow = true;
      this.mesh.receiveShadow = false;
      this.mesh.customDepthMaterial = material;
      // 본 화면에서는 그리지 않고 그림자 패스에서만 그린다(그림자 패스의 레이어 판정은 본 카메라를 쓰므로)
      this.mesh.onBeforeRender = () => {
        this.geo.instanceCount = 0;
      };
      this.mesh.onBeforeShadow = () => {
        this.geo.instanceCount = this.n;
      };
    } else {
      this.mesh.castShadow = false;
      this.mesh.receiveShadow = true;
    }
    if (opt.order) this.mesh.renderOrder = opt.order;
    scene.add(this.mesh);
  }
  push(id, fade) {
    if (this.count >= this.cap) return;
    const k = this.count++ * 2;
    this.arr[k] = id;
    this.arr[k + 1] = fade;
  }
  finish() {
    this.n = this.count;
    this.geo.instanceCount = this.shadow ? 0 : this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.attr.clearUpdateRanges();
      this.attr.addUpdateRange(0, this.count * 2);
      this.attr.needsUpdate = true;
    }
    this.count = 0;
  }
}

export class TreeRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {object} world
   * @param {object} quality 품질 프리셋
   * @param {THREE.WebGLRenderer} renderer 임포스터 굽기용
   */
  constructor(scene, world, quality, renderer) {
    const t0 = performance.now();
    this.scene = scene;
    this.world = world;
    this.quality = quality;
    const belts = world.belts;
    const cat = templateCatalog();
    const T = cat.list;
    this.templates = T;
    this.atlas = makeLeafClusterAtlas(512);
    this.bark = makeBarkTextures(256, 512);

    // ---- 인스턴스 표 ----
    const trees = belts.trees;
    const shrubs = belts.shrubs;
    const stumps = belts.stumps;
    const nT = trees.length;
    const nS = shrubs.length;
    const nSt = stumps.length;
    const nInst = nT + nS + nSt;
    const bakeBase = nInst;
    const nAll = nInst + T.length * IMP.views;
    const rows = Math.ceil((nAll * TEXELS) / TREE_TEX_W);
    const D = new Float32Array(TREE_TEX_W * rows * 4);
    const put = (i, k, a, b, c, d) => {
      const o = (i * TEXELS + k) * 4;
      D[o] = a;
      D[o + 1] = b;
      D[o + 2] = c;
      D[o + 3] = d;
    };
    this.nInst = nInst;
    this.nTrees = nT;
    this.nShrubs = nS;
    // 컬링·LOD용 기록
    this.cx = new Float32Array(nInst);
    this.cy = new Float32Array(nInst);
    this.cz = new Float32Array(nInst);
    this.cr = new Float32Array(nInst);
    this.size = new Float32Array(nInst);
    this.kind = new Uint8Array(nInst); // 0 나무, 1 관목, 2 그루터기
    this.tpl = new Int16Array(nInst);
    this.leafy = new Uint8Array(nInst);
    this.dead = new Uint8Array(nInst);
    const capTpl = new Array(T.length).fill(0);

    for (let i = 0; i < nT; i++) {
      const t = trees[i];
      const Tt = T[t.tpl];
      let flags = 0;
      if (t.dead) flags |= FLAG.dead | FLAG.jagged;
      else if (t.broken) flags |= FLAG.jagged;
      if (t.sapling) flags |= FLAG.sapling;
      const cut = Number.isFinite(t.cut) ? t.cut : 1e6;
      put(i, 0, t.x, t.y0, t.z, t.s);
      put(i, 1, t.lx, t.lz, t.bx, t.bz);
      put(i, 2, Math.cos(t.yaw), Math.sin(t.yaw), cut, t.bScale);
      put(i, 3, t.tint[0], t.tint[1], t.tint[2], t.autumn);
      put(i, 4, t.top - t.y0, t.r0, t.r1, t.flare);
      put(i, 5, t.seed, SPECIES_INDEX[t.species], t.height, flags);
      // 어린나무: 잎 뭉치를 크기에 비례해 줄이지 않음(잎 크기는 어른 나무와 같다)
      const cardScale = t.s >= 0.6 ? 1 : Math.min(3.2, Math.max(1, (0.35 + 0.65 * t.s) / t.s));
      put(i, 6, t.tpl, cardScale, Math.max(1, Math.round((2 * Math.PI * t.r0) / 0.5)), 2.5 + ((t.seed * 37.1) % 1) * 3.5);
      const top = Math.min(t.y0 + Tt.bbox.maxY * t.s, cut);
      put(i, 7, top, t.sink ?? 0.12, 0, 0);
      const H = t.height;
      const ext = Math.max(Math.abs(Tt.bbox.minX), Math.abs(Tt.bbox.maxX), Math.abs(Tt.bbox.minZ), Math.abs(Tt.bbox.maxZ)) * t.s;
      const hm = H * 0.5;
      this.cx[i] = t.x + (t.lx + t.bx * hm) * hm;
      this.cz[i] = t.z + (t.lz + t.bz * hm) * hm;
      this.cy[i] = t.y0 + hm;
      this.cr[i] = Math.max(hm, ext) + 1 + (Math.abs(t.lx) + Math.abs(t.lz)) * hm;
      this.size[i] = Math.min(1.4, Math.max(0.45, Math.sqrt(H / 14)));
      this.kind[i] = 0;
      this.tpl[i] = t.tpl;
      this.leafy[i] = !t.dead && Tt.clusters.length > 0 ? 1 : 0;
      this.dead[i] = t.dead ? 1 : 0;
      capTpl[t.tpl]++;
    }
    for (let j = 0; j < nS; j++) {
      const i = nT + j;
      const sh = shrubs[j];
      const Tt = T[sh.tpl];
      const flags = FLAG.shrub | (sh.fruit ? FLAG.fruit : 0);
      put(i, 0, sh.x, sh.y0, sh.z, sh.s);
      put(i, 1, 0, 0, 0, 0);
      put(i, 2, Math.cos(sh.yaw), Math.sin(sh.yaw), 1e6, sh.s);
      put(i, 3, sh.tint[0], sh.tint[1], sh.tint[2], sh.autumn);
      put(i, 4, 0, 0, 0, 0);
      put(i, 5, sh.seed, SPECIES_INDEX[sh.species], sh.height, flags);
      put(i, 6, sh.tpl, 1, 1, 0);
      put(i, 7, sh.y0 + Tt.bbox.maxY * sh.s, 0.05, 0, 0);
      const ext = Math.max(Math.abs(Tt.bbox.minX), Math.abs(Tt.bbox.maxX), Math.abs(Tt.bbox.minZ), Math.abs(Tt.bbox.maxZ)) * sh.s;
      this.cx[i] = sh.x;
      this.cy[i] = sh.y0 + sh.height * 0.5;
      this.cz[i] = sh.z;
      this.cr[i] = Math.max(sh.height * 0.5, ext) + 0.5;
      this.size[i] = Math.min(1.25, Math.max(0.7, Math.sqrt(sh.height / 2.5)));
      this.kind[i] = 1;
      this.tpl[i] = sh.tpl;
      this.leafy[i] = 1;
      capTpl[sh.tpl]++;
    }
    for (let j = 0; j < nSt; j++) {
      const i = nT + nS + j;
      const st = stumps[j];
      const L = st.top - st.y0;
      put(i, 0, st.x, st.y0, st.z, 1);
      put(i, 1, 0, 0, 0, 0);
      put(i, 2, 1, 0, 1e6, 1);
      put(i, 3, 0.1, 0.1, 0.1, 0);
      put(i, 4, L, st.r0, st.r1, st.flare);
      put(i, 5, st.seed ?? 0.5, SPECIES_INDEX.snag, L, FLAG.dead | FLAG.still | (st.snapped ? FLAG.jagged : FLAG.sawn));
      put(i, 6, -1, 1, Math.max(1, Math.round((2 * Math.PI * st.r0) / 0.5)), 0);
      put(i, 7, st.top, st.sink ?? 0.1, 0, 0);
      this.cx[i] = st.x;
      this.cy[i] = st.y0 + L * 0.5;
      this.cz[i] = st.z;
      this.cr[i] = L * 0.5 + st.r0 * 2;
      this.size[i] = 1;
      this.kind[i] = 2;
      this.tpl[i] = -1;
    }
    // 굽기 칸: 템플릿 × 방위
    const grid = impostorGrid(T.length);
    const frames = T.map((Tt) => impostorFrame(Tt));
    const tplInfo = Array.from({ length: 24 }, () => new THREE.Vector4());
    for (let ti = 0; ti < T.length; ti++) {
      const Tt = T[ti];
      const fr = frames[ti];
      tplInfo[ti].set(fr.w, fr.h, fr.minY, 0);
      const sp = SPECIES_INDEX[Tt.species];
      let flags = FLAG.still;
      if (Tt.kind === 'snag') flags |= FLAG.dead | FLAG.jagged;
      if (Tt.kind === 'shrub') flags |= FLAG.shrub | FLAG.fruit;
      for (let k = 0; k < IMP.views; k++) {
        const i = bakeBase + ti * IMP.views + k;
        const f = ti * IMP.views + k;
        const col = f % grid.cols;
        const row = Math.floor(f / grid.cols);
        const ppm = fr.ppm;
        const psi = (k * Math.PI * 2) / IMP.views;
        put(i, 0, col * IMP.fw + IMP.fw / 2, row * IMP.fh - fr.minY * ppm, 0, ppm);
        put(i, 1, 0, 0, 0, 0);
        put(i, 2, Math.cos(psi), Math.sin(psi), 1e9, ppm);
        put(i, 3, 0.1, 0.15, 0.04, 0);
        const isShrub = Tt.kind === 'shrub';
        put(i, 4, isShrub ? 0 : Tt.stemTop * ppm, Tt.refStemR * 1.06 * ppm, Tt.stemTopR * ppm, isShrub ? 0 : 0.4);
        put(i, 5, 0.37 + ti * 0.013, sp, Tt.Href * ppm, flags);
        put(i, 6, ti, 1, Math.max(1, Math.round((2 * Math.PI * Tt.refStemR * 1.06) / 0.5)), 3.5 * ppm);
        put(i, 7, (fr.minY + fr.h) * ppm, 0.12 * ppm, 0, 0);
      }
    }
    const tex = new THREE.DataTexture(D, TREE_TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.dataTex = tex;

    this.shared = {
      uTreeData: { value: tex },
      uWindOn: { value: 1 },
      uLeafAtlas: { value: this.atlas },
      uBarkAlb: { value: this.bark.albedo },
      uBarkNrm: { value: this.bark.normal },
      ...speciesUniforms(this.bark.avg),
    };
    // 잎 그림자가 그림자 맵에 있으면, 그 거리 안에서는 수관 지도 햇빛 가림을 끈다(이중 그늘 방지)
    if (quality.leafShadows) U.uCanopyFade.value.set(quality.shadowDistance * 0.78, quality.shadowDistance * 0.96);
    else U.uCanopyFade.value.set(-2, -1);

    // ---- 머티리얼 ----
    const a2c = true;
    const mat = {
      leaf: makeTreeMaterial('leaf', 'main', this.shared, { a2c }),
      leafD: makeTreeMaterial('leaf', 'depth', this.shared),
      leafB: makeTreeMaterial('leaf', 'bake', this.shared),
      branch: makeTreeMaterial('branch', 'main', this.shared),
      branchD: makeTreeMaterial('branch', 'depth', this.shared),
      branchB: makeTreeMaterial('branch', 'bake', this.shared),
      trunk: makeTreeMaterial('trunk', 'main', this.shared),
      trunkD: makeTreeMaterial('trunk', 'depth', this.shared),
      trunkB: makeTreeMaterial('trunk', 'bake', this.shared),
    };
    this.mat = mat;

    // ---- 템플릿별 묶음 ----
    this.leaf0 = [];
    this.leaf1 = [];
    this.leafS = [];
    this.br0 = [];
    this.br1 = [];
    this.brS = [];
    const bakeParts = [];
    const trunkG0 = trunkGeometry(12, 14);
    const bakeInst = (ti) => {
      const a = new Float32Array(IMP.views * 2);
      for (let k = 0; k < IMP.views; k++) {
        a[k * 2] = bakeBase + ti * IMP.views + k;
        a[k * 2 + 1] = 1;
      }
      return new THREE.InstancedBufferAttribute(a, 2);
    };
    const bakeMesh = (g, m, ti) => {
      const bg = shareGeometry(g);
      bg.setAttribute('aInst', bakeInst(ti));
      bg.instanceCount = IMP.views;
      const mesh = new THREE.Mesh(bg, m);
      mesh.frustumCulled = false;
      return mesh;
    };
    let cards0 = 0;
    for (let ti = 0; ti < T.length; ti++) {
      const Tt = T[ti];
      const cap = capTpl[ti];
      const parts = { meshes: [] };
      if (Tt.clusters.length) {
        const g0 = clusterGeometry(Tt, 1, 1, 0);
        const g1 = clusterGeometry(Tt, 0.3, 1.7, 3);
        cards0 += g0.userData.cards;
        this.leaf0[ti] = new Bucket(scene, g0, mat.leaf, cap);
        this.leaf1[ti] = new Bucket(scene, g1, mat.leaf, cap);
        if (quality.leafShadows) this.leafS[ti] = new Bucket(scene, clusterGeometry(Tt, 0.14, 2.4, 7), mat.leafD, cap, { shadow: true });
        parts.meshes.push(bakeMesh(g0, mat.leafB, ti));
      }
      const gb0 = branchGeometry(Tt);
      const gb1 = branchGeometry(Tt, { levels: [0, 1], radial: () => 3, step: 2 });
      this.br0[ti] = new Bucket(scene, gb0, mat.branch, cap);
      this.br1[ti] = new Bucket(scene, gb1, mat.branch, cap);
      if (Tt.kind !== 'shrub') this.brS[ti] = new Bucket(scene, gb1, mat.branchD, cap, { shadow: true });
      parts.meshes.push(bakeMesh(gb0, mat.branchB, ti));
      if (Tt.kind !== 'shrub') parts.meshes.push(bakeMesh(trunkG0, mat.trunkB, ti));
      bakeParts.push(parts);
    }
    // 줄기(공용 단위 원기둥 LOD 3단계 + 그림자)
    const nTrunk = nT + nSt;
    this.trunk = [new Bucket(scene, trunkG0, mat.trunk, nTrunk), new Bucket(scene, trunkGeometry(7, 5), mat.trunk, nTrunk), new Bucket(scene, trunkGeometry(5, 2), mat.trunk, nTrunk)];
    this.trunkS = new Bucket(scene, trunkGeometry(6, 3), mat.trunkD, nTrunk, { shadow: true });

    // ---- 임포스터 굽기 ----
    this.shared.uWindOn.value = 0;
    const baked = bakeImpostors(renderer, bakeParts, grid);
    this.shared.uWindOn.value = 1;
    this.impostorTarget = baked.target;
    for (const p of bakeParts) for (const m of p.meshes) m.geometry.dispose();
    mat.leafB.dispose();
    mat.branchB.dispose();
    mat.trunkB.dispose();
    const impMat = makeImpostorMaterial(this.shared, baked.key, baked.normal, tplInfo, new THREE.Vector2(grid.cols, grid.rows), { a2c });
    this.imp = new Bucket(scene, impostorGeometry(), impMat, nT + nS);

    // ---- 쓰러진 나무·뿌리판 ----
    this._buildWood(scene);

    this._buildChunks();
    this.frustum = new THREE.Frustum();
    this.sphere = new THREE.Sphere();
    this.tmpM = new THREE.Matrix4();
    this.cullCam = new THREE.PerspectiveCamera();
    this.stats = { cards0, ms: performance.now() - t0 };
    console.info(`[trees] templates ${T.length}, instances ${nInst}, LOD0 cards/template ${(cards0 / T.length).toFixed(0)}, setup ${this.stats.ms.toFixed(0)} ms`);
  }

  /** 컬링 묶음: 48 m 칸마다 인스턴스 목록과 경계 구(칸 단위로 먼저 절두체 시험) */
  _buildChunks() {
    const CH = 48;
    const map = new Map();
    for (let i = 0; i < this.nInst; i++) {
      const key = (Math.floor(this.cx[i] / CH) + 512) * 1024 + (Math.floor(this.cz[i] / CH) + 512);
      let c = map.get(key);
      if (!c) map.set(key, (c = []));
      c.push(i);
    }
    this.chunks = [];
    for (const list of map.values()) {
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (const i of list) {
        const r = this.cr[i];
        x0 = Math.min(x0, this.cx[i] - r);
        x1 = Math.max(x1, this.cx[i] + r);
        y0 = Math.min(y0, this.cy[i] - r);
        y1 = Math.max(y1, this.cy[i] + r);
        z0 = Math.min(z0, this.cz[i] - r);
        z1 = Math.max(z1, this.cz[i] + r);
      }
      const sphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0));
      this.chunks.push({ idx: Int32Array.from(list), sphere });
    }
  }

  _buildWood(scene) {
    const belts = this.world.belts;
    const tubes = [];
    const terrain = this.world.terrain;
    for (const f of belts.fallen || []) {
      const layer = f.material === 'woodDead' ? SPECIES_INDEX.snag : SPECIES_INDEX.elm;
      tubes.push({ pts: f.pts, layer, moss: f.moss, rand: f.seed, capA: !f.rootPlate, capB: true });
      for (const s of f.stubs) tubes.push({ pts: [[s.ax, s.ay, s.az, s.r0], [s.bx, s.by, s.bz, s.r1]], layer: SPECIES_INDEX.snag, moss: f.moss * 0.5, rand: f.seed, capB: true, radial: 5 });
      const p = f.rootPlate;
      if (p) {
        tubes.push({ kind: 'plate', pts: [[p.ax, p.ay, p.az, p.r], [p.bx, p.by, p.bz, p.r]], layer: SPECIES_INDEX.snag, capA: true, capB: true, radial: 16 });
        // 바깥 면(통나무 반대쪽)에 뻗은 굵은 뿌리: 원판 반지름 안, 면에서 15 cm 이내로만 튀어나옴
        const rng = new Random(Math.floor(p.seed * 1e6) + 7);
        const ux = Math.cos(p.ang);
        const uz = Math.sin(p.ang);
        const v1 = [-uz, 0, ux];
        const fc = [p.ax - ux * 0.01, p.ay, p.az - uz * 0.01];
        const n = rng.int(7, 11);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const dir = [v1[0] * ca, sa, v1[2] * ca];
          const r0 = p.r * rng.range(0.12, 0.25);
          const r1 = p.r * rng.range(0.85, 1.0);
          const out = rng.range(0.03, 0.15);
          const A = [fc[0] + dir[0] * r0, fc[1] + dir[1] * r0, fc[2] + dir[2] * r0, rng.range(0.03, 0.05)];
          const M = [fc[0] + dir[0] * (r0 + r1) * 0.5 - ux * out, fc[1] + dir[1] * (r0 + r1) * 0.5, fc[2] + dir[2] * (r0 + r1) * 0.5 - uz * out, A[3] * 0.75];
          const B = [fc[0] + dir[0] * r1 - ux * out * 0.6, fc[1] + dir[1] * r1, fc[2] + dir[2] * r1 - uz * out * 0.6, A[3] * 0.4];
          const gy = terrain.heightAt(B[0], B[2]);
          if (B[1] < gy - 0.05) B[1] = gy - 0.05;
          tubes.push({ pts: [A, M, B], layer: SPECIES_INDEX.snag, moss: 0, rand: rng.next(), capB: false, radial: 5 });
        }
      }
    }
    if (!tubes.length) return;
    const geo = tubeGeometry(tubes);
    const mesh = new THREE.Mesh(geo, makeWoodMaterial(this.shared));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    this.woodMesh = mesh;
  }

  /** 그림자 전용 묶음: 관찰자 둘레(시야와 무관) */
  _updateCasters(focus) {
    const q = this.quality;
    const R = q.shadowDistance + 15;
    const R2 = R * R;
    const nearB2 = 45 * 45;
    const n = this.nInst;
    for (let i = 0; i < n; i++) {
      const dx = this.cx[i] - focus.x;
      const dz = this.cz[i] - focus.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      const kind = this.kind[i];
      const tpl = this.tpl[i];
      if (kind === 0) {
        this.trunkS.push(i, 1);
        if (this.leafy[i] && this.leafS[tpl]) this.leafS[tpl].push(i, 1);
        if ((d2 < nearB2 || this.dead[i]) && this.brS[tpl]) this.brS[tpl].push(i, 1);
      } else if (kind === 1) {
        if (this.leafS[tpl]) this.leafS[tpl].push(i, 1);
      } else if (d2 < 3600) this.trunkS.push(i, 1);
    }
    this.trunkS.finish();
    for (const b of this.leafS) b?.finish();
    for (const b of this.brS) b?.finish();
  }

  /**
   * @param {THREE.Camera} camera
   * @param {number} zoom 기준 시야 대비 배율(조준경 4배면 약 4)
   * @param {THREE.Vector3} focus 관찰자(그림자 중심)
   */
  update(camera, zoom, focus) {
    if (!this._sf || (focus.x - this._sf.x) ** 2 + (focus.z - this._sf.z) ** 2 > 4) {
      this._updateCasters(focus);
      this._sf = { x: focus.x, z: focus.z };
    }
    const last = this._last;
    const q = camera.quaternion;
    if (last && camera.position.distanceToSquared(last.pos) < 0.09 && Math.abs(q.dot(last.quat)) > 0.99995 && Math.abs(zoom / last.zoom - 1) < 0.02) return;
    this._last = { pos: camera.position.clone(), quat: q.clone(), zoom };
    // 컬링 절두체: 시야각을 조금 넓혀 작은 회전에도 빈틈이 없게
    const cc = this.cullCam;
    cc.fov = Math.min(170, camera.fov * 1.12 + 2);
    cc.aspect = camera.aspect;
    cc.near = camera.near;
    cc.far = camera.far;
    cc.updateProjectionMatrix();
    this.frustum.setFromProjectionMatrix(this.tmpM.multiplyMatrices(cc.projectionMatrix, camera.matrixWorldInverse));
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const zT = Math.max(1, zoom) * this.quality.treeLodScale;
    const zS = Math.max(1, zoom) * this.quality.shrubLodScale;
    const sph = this.sphere;
    for (const ch of this.chunks) {
      if (!this.frustum.intersectsSphere(ch.sphere)) continue;
      for (const i of ch.idx) this._lodInstance(i, cx, cy, cz, zT, zS, sph);
    }
    for (const b of this.leaf0) b?.finish();
    for (const b of this.leaf1) b?.finish();
    for (const b of this.br0) b?.finish();
    for (const b of this.br1) b?.finish();
    for (const b of this.trunk) b.finish();
    this.imp.finish();
  }

  /** 인스턴스 하나의 컬링·LOD 선택 */
  _lodInstance(i, cx, cy, cz, zT, zS, sph) {
    sph.center.set(this.cx[i], this.cy[i], this.cz[i]);
    sph.radius = this.cr[i];
    if (!this.frustum.intersectsSphere(sph)) return;
    const dx = this.cx[i] - cx;
    const dy = this.cy[i] - cy;
    const dz = this.cz[i] - cz;
    const dist = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - this.cr[i] * 0.3);
    const kind = this.kind[i];
    if (kind === 2) {
      const de = dist / zT;
      if (de > LOD.stumpCull) return;
      this.trunk[de < 20 ? 0 : de < 60 ? 1 : 2].push(i, 1);
      return;
    }
    const L = kind === 0 ? LOD.tree : LOD.shrub;
    const de = dist / ((kind === 0 ? zT : zS) * this.size[i]);
    const tpl = this.tpl[i];
    const wA = Math.min(1, Math.max(0, (de - L.a[0]) / (L.a[1] - L.a[0])));
    const wB = Math.min(1, Math.max(0, (de - L.b[0]) / (L.b[1] - L.b[0])));
    // 임포스터
    if (wB > 0) this.imp.push(i, wB >= 1 ? 1 : 2 - wB);
    if (wB >= 1) return;
    const geoF = 1 - wB; // 기하(가까운 LOD 전체)가 차지하는 몫
    // 가까운 LOD(0)·중간 LOD(1)의 흐림 값
    let f0 = 0;
    let f1 = 0;
    if (wA <= 0) f0 = 1;
    else if (wA >= 1) f1 = geoF;
    else {
      f0 = 1 - wA;
      f1 = 2 - wA;
    }
    if (this.leafy[i]) {
      if (f0 > 0) this.leaf0[tpl].push(i, f0);
      if (f1 > 0) this.leaf1[tpl].push(i, f1);
    }
    if (kind === 0) {
      if (f0 > 0) this.br0[tpl].push(i, f0);
      if (f1 > 0) this.br1[tpl].push(i, f1);
      const tl = de < LOD.tree.trunk[0] ? 0 : de < LOD.tree.trunk[1] ? 1 : 2;
      this.trunk[tl].push(i, geoF);
    } else if (f0 > 0) this.br0[tpl].push(i, f0);
  }
}
