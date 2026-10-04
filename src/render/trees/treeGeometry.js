// 템플릿(world/treeTemplates.js) → GPU 기하.
//  - 잎 뭉치 카드: LOD0(전부), LOD1(약 28%를 1.75배 크기로), 그림자용(약 9%를 3배 크기로)
//  - 가지 관: LOD0(원줄기·굵은 가지 5각, 잔가지 3각), LOD1(원줄기·굵은 가지만 3각)
//  - 줄기: 단위 원기둥(높이 0~1, 반지름은 셰이더가 stemRadius로) — 밑동 쪽 고리가 촘촘
// 정점 좌표는 템플릿 공간(밑동 원점, m). 셰이더가 인스턴스 크기·회전·줄기 변위(가지가 붙은 높이 hA)를 적용한다.

import * as THREE from 'three';
import { leafTileUV } from '../treeTextures.js';

function hash1(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 잎 뭉치 카드 기하
 * @param {object} T 템플릿
 * @param {number} keep 남길 비율(0~1), sizeMul 크기 배수
 */
export function clusterGeometry(T, keep = 1, sizeMul = 1, seed = 0) {
  const pos = [];
  const nor = [];
  const uv = [];
  const c1 = []; // 수관 중심 기준 방향(정규화 좌표) xyz, 안쪽 깊이
  const c2 = []; // 붙은 높이 hA, 가지 난수, 수관 안 높이(0~1), 떨림 위상
  const c3 = []; // 카드 중심 xyz, 열매 표시
  const idx = [];
  const R = T.crownRadii || [1, 1, 1];
  let k = 0;
  for (const c of T.clusters) {
    k++;
    if (keep < 1 && hash1(k * 3.17 + seed) > keep) continue;
    const s = c.s * sizeMul * 0.5;
    const n = c.n;
    const t = c.t;
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const [tu, tv] = leafTileUV(c.tile);
    // 수관 타원체의 바깥 방향(기울기 = q / 반지름): 구형 법선·자체 그늘에 씀
    const q = c.radial || [0, 1, 0];
    let gx = q[0] / R[0];
    let gy = q[1] / R[1];
    let gz = q[2] / R[2];
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 1e-5) {
      gx = 0;
      gy = 1;
      gz = 0;
    } else {
      gx /= gl;
      gy /= gl;
      gz /= gl;
    }
    const base = pos.length / 3;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      pos.push(c.c[0] + (t[0] * sx + b[0] * sy) * s, c.c[1] + (t[1] * sx + b[1] * sy) * s, c.c[2] + (t[2] * sx + b[2] * sy) * s);
      nor.push(n[0], n[1], n[2]);
      // +b 방향이 그림의 위쪽(잎 끝)
      uv.push(tu + ((sx * 0.5 + 0.5) * 0.98 + 0.01) / 3, tv + ((0.5 - sy * 0.5) * 0.98 + 0.01) / 3);
      c1.push(gx, gy, gz, c.depth ?? 0.5);
      c2.push(c.hA, c.br, c.h01 ?? 0.5, c.phase ?? 0);
      c3.push(c.c[0], c.c[1], c.c[2], c.fruit || 0);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aC1', new THREE.Float32BufferAttribute(c1, 4));
  g.setAttribute('aC2', new THREE.Float32BufferAttribute(c2, 4));
  g.setAttribute('aC3', new THREE.Float32BufferAttribute(c3, 4));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  g.userData.cards = idx.length / 6;
  return g;
}

/**
 * 가지 관 기하. levels: 포함할 가지 단계, radial(level) → 각 수, step: 점 건너뛰기
 */
export function branchGeometry(T, { levels = [0, 1, 2, 3], radial = (lv) => (lv <= 1 ? 5 : 3), step = 1 } = {}) {
  const pos = [];
  const nor = [];
  const uv = [];
  const axis = [];
  const ab = []; // hA, 단계, 붙은 곳에서 거리, 가지 난수
  const idx = [];
  for (const br of T.branches) {
    if (!levels.includes(br.level)) continue;
    const R = radial(br.level);
    const pts = br.pts.filter((p, i) => i % step === 0 || i === br.pts.length - 1);
    if (pts.length < 2) continue;
    // 둘레 방향 껍질 반복 수(가지 굵기에 맞춤, 늘어나지 않게)
    const wrap = Math.max(1, Math.round((2 * Math.PI * pts[0][3]) / 0.5));
    let along = 0;
    let prevFrameX = null;
    const ringStart = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[Math.min(pts.length - 1, i + 1)];
      const o = pts[Math.max(0, i - 1)];
      const d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      d[0] /= dl;
      d[1] /= dl;
      d[2] /= dl;
      // 이음매가 꼬이지 않게 이전 고리의 기준축을 이어 씀(평행 이동 틀)
      let fx = prevFrameX || (Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
      const dd = fx[0] * d[0] + fx[1] * d[1] + fx[2] * d[2];
      fx = [fx[0] - d[0] * dd, fx[1] - d[1] * dd, fx[2] - d[2] * dd];
      const fl = Math.hypot(fx[0], fx[1], fx[2]) || 1;
      fx = [fx[0] / fl, fx[1] / fl, fx[2] / fl];
      prevFrameX = fx;
      const fy = [d[1] * fx[2] - d[2] * fx[1], d[2] * fx[0] - d[0] * fx[2], d[0] * fx[1] - d[1] * fx[0]];
      if (i > 0) along += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]);
      ringStart.push(pos.length / 3);
      const r = Math.max(0.003, p[3]);
      for (let k = 0; k <= R; k++) {
        const a = (k / R) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const nx = fx[0] * ca + fy[0] * sa;
        const ny = fx[1] * ca + fy[1] * sa;
        const nz = fx[2] * ca + fy[2] * sa;
        pos.push(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r);
        nor.push(nx, ny, nz);
        uv.push((k / R) * wrap, along / 1.0);
        axis.push(p[0], p[1], p[2]);
        ab.push(br.hA, br.level, along, br.rand);
      }
    }
    // 고리 방향(fy = d × fx)이 시계 방향이라 바깥면이 앞면이 되도록 감는 순서를 맞춤
    for (let i = 0; i < pts.length - 1; i++) {
      const a0 = ringStart[i];
      const b0 = ringStart[i + 1];
      for (let k = 0; k < R; k++) idx.push(a0 + k, a0 + k + 1, b0 + k, a0 + k + 1, b0 + k + 1, b0 + k);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aAxis', new THREE.Float32BufferAttribute(axis, 3));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(ab, 4));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

/**
 * 단위 줄기: t∈[0,1] 고리(밑동 쪽 촘촘), 각 radial개. position = (cosθ, t, sinθ).
 * 위 마개는 고리를 따로 한 벌 더(y = 1.0001, 가운데 y = 1.0002) — 셰이더가 마개를 알아보고
 * 톱으로 자른 면(나이테) 또는 부러진 면(들쭉날쭉)으로 그린다. 밑은 땅에 묻혀 막지 않는다.
 */
export function trunkGeometry(radial, rings) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= rings; i++) {
    const t = Math.pow(i / rings, 1.7);
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      pos.push(Math.cos(a), t, Math.sin(a));
      uv.push(k / radial, t);
    }
  }
  for (let i = 0; i < rings; i++) {
    const a0 = i * (radial + 1);
    const b0 = (i + 1) * (radial + 1);
    for (let k = 0; k < radial; k++) idx.push(a0 + k, b0 + k, a0 + k + 1, a0 + k + 1, b0 + k, b0 + k + 1);
  }
  const capRing = pos.length / 3;
  for (let k = 0; k <= radial; k++) {
    const a = (k / radial) * Math.PI * 2;
    pos.push(Math.cos(a), 1.0001, Math.sin(a));
    uv.push(k / radial, 1);
  }
  const top = pos.length / 3;
  pos.push(0, 1.0002, 0);
  uv.push(0.5, 1);
  for (let k = 0; k < radial; k++) idx.push(capRing + k, top, capRing + k + 1);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

/**
 * 월드 좌표 관(쓰러진 나무·그루터기 가지·뿌리판): tubes = [{pts: [[x,y,z,r]...], layer, moss, rand, capA, capB, kind}]
 * aWood = (껍질 층, 이끼, 난수, 면 종류: 0 껍질, 1 나이테 마개, 2 뿌리판 흙)
 */
export function tubeGeometry(tubes, radialFor = (r) => (r > 0.1 ? 10 : r > 0.04 ? 6 : 4)) {
  const pos = [];
  const nor = [];
  const uv = [];
  const wood = [];
  const idx = [];
  for (const tb of tubes) {
    const pts = tb.pts;
    if (pts.length < 2) continue;
    const R = tb.radial || radialFor(pts[0][3]);
    const wrap = Math.max(1, Math.round((2 * Math.PI * pts[0][3]) / 0.5));
    const face = tb.kind === 'plate' ? 2 : 0;
    let along = 0;
    let prevX = null;
    const rings = [];
    const frames = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[Math.min(pts.length - 1, i + 1)];
      const o = pts[Math.max(0, i - 1)];
      const d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      d[0] /= dl;
      d[1] /= dl;
      d[2] /= dl;
      let fx = prevX || (Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
      const dd = fx[0] * d[0] + fx[1] * d[1] + fx[2] * d[2];
      fx = [fx[0] - d[0] * dd, fx[1] - d[1] * dd, fx[2] - d[2] * dd];
      const fl = Math.hypot(fx[0], fx[1], fx[2]) || 1;
      fx = [fx[0] / fl, fx[1] / fl, fx[2] / fl];
      prevX = fx;
      const fy = [d[1] * fx[2] - d[2] * fx[1], d[2] * fx[0] - d[0] * fx[2], d[0] * fx[1] - d[1] * fx[0]];
      frames.push({ d, fx, fy });
      if (i > 0) along += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]);
      rings.push(pos.length / 3);
      for (let k = 0; k <= R; k++) {
        const a = (k / R) * Math.PI * 2;
        const nx = fx[0] * Math.cos(a) + fy[0] * Math.sin(a);
        const ny = fx[1] * Math.cos(a) + fy[1] * Math.sin(a);
        const nz = fx[2] * Math.cos(a) + fy[2] * Math.sin(a);
        pos.push(p[0] + nx * p[3], p[1] + ny * p[3], p[2] + nz * p[3]);
        nor.push(nx, ny, nz);
        uv.push((k / R) * wrap, along);
        wood.push(tb.layer, tb.moss || 0, tb.rand || 0, face);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a0 = rings[i];
      const b0 = rings[i + 1];
      for (let k = 0; k < R; k++) idx.push(a0 + k, a0 + k + 1, b0 + k, a0 + k + 1, b0 + k + 1, b0 + k);
    }
    // 마개(나이테 또는 뿌리판 면)
    const cap = (i, sign) => {
      const p = pts[i];
      const { d, fx, fy } = frames[i];
      const n = [d[0] * sign, d[1] * sign, d[2] * sign];
      const c0 = pos.length / 3;
      pos.push(p[0], p[1], p[2]);
      nor.push(...n);
      uv.push(0, 0);
      wood.push(tb.layer, tb.moss || 0, tb.rand || 0, face === 2 ? 2 : 1);
      for (let k = 0; k <= R; k++) {
        const a = (k / R) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        pos.push(p[0] + (fx[0] * ca + fy[0] * sa) * p[3], p[1] + (fx[1] * ca + fy[1] * sa) * p[3], p[2] + (fx[2] * ca + fy[2] * sa) * p[3]);
        nor.push(...n);
        // 마개 uv = 단면 좌표(반지름 m) → 나이테
        uv.push(ca * p[3], sa * p[3]);
        wood.push(tb.layer, tb.moss || 0, tb.rand || 0, face === 2 ? 2 : 1);
      }
      for (let k = 0; k < R; k++) {
        if (sign > 0) idx.push(c0, c0 + 1 + k, c0 + 2 + k);
        else idx.push(c0, c0 + 2 + k, c0 + 1 + k);
      }
    };
    if (tb.capA) cap(0, -1);
    if (tb.capB) cap(pts.length - 1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWood', new THREE.Float32BufferAttribute(wood, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** 임포스터 사각형(인스턴스마다 카메라 쪽으로 세움) */
export function impostorGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}
