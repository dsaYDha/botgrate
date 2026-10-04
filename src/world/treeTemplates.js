// 수종별 절차 나무·관목 템플릿: 가지 골격(휘고 갈라지고 끝으로 가늘어짐) + 잎 뭉치 카드 + 잎 볼륨(판정용).
// 템플릿 좌표: 밑동 = 원점, 줄기 = +y 직선(기준 높이 Href, m). 실제 나무는 크기·회전과 함께
// 각 가지가 붙은 높이(hA)에서의 줄기 중심 변위(기울기·휨)를 그대로 따라간다(렌더링·판정 공통).
// 렌더러는 이 데이터로 기하를 만들고, 숲띠 생성기는 같은 데이터로 잎 볼륨·굵은 가지 충돌체를 만든다.

import { Random } from '../core/Random.js';

const TAU = Math.PI * 2;

// 수종별 생장 모양 매개변수
const GROWTH = {
  poplar: {
    Href: 22,
    crownBase: 0.24,
    R: 2.4,
    limbs: 34,
    angle: [0.32, 0.5], // 줄기에서 벌어진 각(rad, 아래→위)
    upCurve: 0.16, // 마디마다 위로 휘는 정도
    droop: 0,
    wobble: 0.12,
    limbR: 0.045,
    sec: [2, 4],
    secLen: [0.35, 0.6],
    perSec: [5, 8],
    clusterSize: [0.8, 1.2],
    profile: (u) => 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, u * 0.95 + 0.08)) - 0.35 * Math.max(0, u - 0.8),
    epicormic: 60, // 줄기 가까이 붙은 잔가지 잎 뭉치(포플러 기둥형 수관)
  },
  locust: {
    Href: 15,
    crownBase: 0.42,
    R: 3.4,
    limbs: 9,
    angle: [0.55, 0.95],
    upCurve: 0.05,
    droop: 0.0,
    wobble: 0.35, // 지그재그(가짜 축분지)
    limbR: 0.09,
    sec: [3, 5],
    secLen: [0.35, 0.65],
    perSec: [3, 6],
    clusterSize: [0.9, 1.35],
    profile: () => 1,
    irregular: 0.45,
  },
  elm: {
    Href: 12.5,
    crownBase: 0.25,
    R: 3.8,
    limbs: 15,
    angle: [0.75, 1.05],
    upCurve: 0.08,
    droop: 0.12, // 가지 끝이 처짐
    wobble: 0.15,
    limbR: 0.085,
    sec: [3, 6],
    secLen: [0.3, 0.55],
    perSec: [7, 10],
    clusterSize: [0.72, 1.05],
    profile: (u) => Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.9 + 0.1)), 0.6),
  },
  maple: {
    Href: 9,
    crownBase: 0.25,
    R: 3.1,
    limbs: 10,
    angle: [0.8, 1.2],
    upCurve: 0.1,
    droop: 0.04,
    wobble: 0.28,
    limbR: 0.07,
    sec: [2, 4],
    secLen: [0.35, 0.6],
    perSec: [6, 9],
    clusterSize: [0.8, 1.15],
    profile: (u) => 1 - 0.45 * u,
    irregular: 0.3,
  },
  ash: {
    Href: 13.5,
    crownBase: 0.34,
    R: 3.0,
    limbs: 13,
    angle: [0.5, 0.75],
    upCurve: 0.12,
    droop: 0.0,
    wobble: 0.14,
    limbR: 0.075,
    sec: [2, 4],
    secLen: [0.35, 0.6],
    perSec: [5, 8],
    clusterSize: [0.85, 1.25],
    profile: (u) => Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.95 + 0.05)), 0.7),
  },
};

const SHRUB_GROWTH = {
  elder: { H: 3.2, R: 1.7, stems: [5, 9], arch: 0.35, spread: 0.75, clusters: 165, clusterSize: [0.62, 0.95], twigs: [2, 4] },
  rose: { H: 1.9, R: 1.4, stems: [9, 14], arch: 0.85, spread: 0.85, clusters: 145, clusterSize: [0.46, 0.74], twigs: [1, 3] },
  blackthorn: { H: 2.4, R: 1.5, stems: [11, 18], arch: 0.2, spread: 0.65, clusters: 195, clusterSize: [0.52, 0.8], twigs: [2, 4] },
  oleaster: { H: 4.0, R: 2.1, stems: [3, 5], arch: 0.3, spread: 0.7, clusters: 150, clusterSize: [0.68, 1.05], twigs: [3, 5] },
};

// ---------------------------------------------------------------------------
function v3(x, y, z) {
  return [x, y, z];
}
function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function len(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function norm(a) {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function randUnit(rng) {
  const z = rng.range(-1, 1);
  const t = rng.range(0, TAU);
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), z, r * Math.sin(t)];
}
/** a를 b 쪽으로 각 ang만큼 돌린 단위 벡터 */
function bendToward(a, b, ang) {
  const c = norm(cross(a, b));
  if (len(cross(a, b)) < 1e-6) return a;
  return rotAxis(a, c, ang);
}
function rotAxis(v, k, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return norm([v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c), v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c), v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c)]);
}
function perp(d, rng) {
  const p = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = norm(cross(d, p));
  const b = cross(d, a);
  const t = rng.range(0, TAU);
  return norm(add(scale(a, Math.cos(t)), scale(b, Math.sin(t))));
}

class Builder {
  constructor(rng) {
    this.rng = rng;
    this.branches = [];
    this.clusters = [];
    this.nextId = 1;
  }
  /** 다마디 가지: start에서 dir로 length, 마디 n. 반환: 점 목록 [x,y,z,r] */
  grow(start, dir, length, r0, r1, n, { upCurve = 0, droop = 0, wobble = 0.1, hA = 0, level = 1, dead = false } = {}) {
    const rng = this.rng;
    const pts = [[start[0], start[1], start[2], r0]];
    let d = norm(dir);
    let p = start;
    const seg = length / n;
    for (let i = 1; i <= n; i++) {
      // 위로 휨(광굴성) / 끝 처짐 / 흔들림
      if (upCurve > 0) d = bendToward(d, [0, 1, 0], upCurve * (1 - Math.abs(d[1])));
      if (droop > 0 && i > n * 0.4) d = bendToward(d, [0, -1, 0], droop);
      if (wobble > 0) d = rotAxis(d, perp(d, rng), rng.gauss() * wobble);
      p = add(p, scale(d, seg));
      const t = i / n;
      pts.push([p[0], p[1], p[2], r0 + (r1 - r0) * Math.pow(t, 0.9)]);
    }
    const br = { pts, level, hA, id: this.nextId++, rand: rng.next(), dead };
    this.branches.push(br);
    return br;
  }
  /** 가지 점 목록에서 매개 t(0~1) 위치와 방향 */
  along(br, t) {
    const pts = br.pts;
    const f = t * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(f));
    const k = f - i;
    const a = pts[i];
    const b = pts[i + 1];
    return {
      p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k],
      r: a[3] + (b[3] - a[3]) * k,
      d: norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]),
    };
  }
  cluster(c, outward, size, tile, hA, br, opts = {}) {
    const rng = this.rng;
    // 카드 법선: 바깥 + 위쪽 + 무작위(잎이 하늘을 향하는 경향)
    let n = norm(add(add(scale(norm(outward), 0.65), [0, 0.45, 0]), scale(randUnit(rng), 0.55)));
    if (opts.normal) n = opts.normal;
    const t = perp(n, rng);
    this.clusters.push({ c, n, t, s: size, tile, hA, br: br ? br.rand : rng.next(), brId: br ? br.id : 0, fruit: opts.fruit || 0 });
  }
}

// 잎 뭉치 카드 한 장에서 잎이 실제로 덮는 비율(render/treeTextures.js 아틀라스 실측 평균 0.36~0.49)
export const LEAF_COVER = 0.42;

/** 군집(k-평균)으로 잎 볼륨(타원체) 몇 개를 만든다 */
function makeLobes(clusters, k, rng) {
  if (!clusters.length) return [];
  k = Math.max(1, Math.min(k, clusters.length));
  const cents = [];
  for (let i = 0; i < k; i++) cents.push(clusters[Math.floor(rng.next() * clusters.length)].c.slice());
  const assign = new Array(clusters.length).fill(0);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < clusters.length; i++) {
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dx = clusters[i].c[0] - cents[j][0];
        const dy = (clusters[i].c[1] - cents[j][1]) * 1.4;
        const dz = clusters[i].c[2] - cents[j][2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      assign[i] = best;
    }
    for (let j = 0; j < k; j++) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let n = 0;
      for (let i = 0; i < clusters.length; i++) {
        if (assign[i] !== j) continue;
        sx += clusters[i].c[0];
        sy += clusters[i].c[1];
        sz += clusters[i].c[2];
        n++;
      }
      if (n) cents[j] = [sx / n, sy / n, sz / n];
    }
  }
  const lobes = [];
  for (let j = 0; j < k; j++) {
    const mem = clusters.filter((_, i) => assign[i] === j);
    if (mem.length < 3) continue;
    const c = cents[j];
    let vh = 0;
    let vy = 0;
    let area = 0;
    let hA = 0;
    let sMax = 0;
    for (const m of mem) {
      vh += (m.c[0] - c[0]) ** 2 + (m.c[2] - c[2]) ** 2;
      vy += (m.c[1] - c[1]) ** 2;
      area += m.s * m.s * LEAF_COVER;
      hA += m.hA;
      sMax = Math.max(sMax, m.s);
    }
    vh /= mem.length;
    vy /= mem.length;
    const rh = Math.sqrt(vh) * 1.55 + sMax * 0.45;
    const ry = Math.sqrt(vy) * 1.7 + sMax * 0.45;
    const vol = (4 / 3) * Math.PI * rh * rh * ry;
    // 잎 면적 밀도(m²/m³) → 시야·탄도 볼륨의 불투명도 근사(0~1)
    const dens = area / vol;
    lobes.push({ c, rh, ry, dens, opacity: Math.min(0.95, 1 - Math.exp(-dens * 1.6)), hA: hA / mem.length });
  }
  return lobes;
}

function finish(T, rng) {
  const cl = T.clusters;
  // 수관 중심·반지름(구형 법선과 안쪽 그늘용)
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const ext = (p, pad) => {
    minX = Math.min(minX, p[0] - pad);
    maxX = Math.max(maxX, p[0] + pad);
    minY = Math.min(minY, p[1] - pad);
    maxY = Math.max(maxY, p[1] + pad);
    minZ = Math.min(minZ, p[2] - pad);
    maxZ = Math.max(maxZ, p[2] + pad);
  };
  for (const c of cl) ext(c.c, c.s * 0.6);
  for (const b of T.branches) for (const p of b.pts) ext(p, p[3]);
  ext([0, 0, 0], 0.5);
  T.bbox = { minX, maxX, minY, maxY, minZ, maxZ };
  if (cl.length) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const c of cl) {
      cx += c.c[0];
      cy += c.c[1];
      cz += c.c[2];
    }
    cx /= cl.length;
    cy /= cl.length;
    cz /= cl.length;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    for (const c of cl) {
      rx = Math.max(rx, Math.abs(c.c[0] - cx));
      ry = Math.max(ry, Math.abs(c.c[1] - cy));
      rz = Math.max(rz, Math.abs(c.c[2] - cz));
    }
    T.crownCenter = [cx, cy, cz];
    T.crownRadii = [Math.max(0.5, rx), Math.max(0.5, ry), Math.max(0.5, rz)];
    let ylo = Infinity;
    let yhi = -Infinity;
    for (const c of cl) {
      ylo = Math.min(ylo, c.c[1]);
      yhi = Math.max(yhi, c.c[1]);
    }
    for (const c of cl) {
      const q = [(c.c[0] - cx) / T.crownRadii[0], (c.c[1] - cy) / T.crownRadii[1], (c.c[2] - cz) / T.crownRadii[2]];
      const rr = Math.min(1, len(q));
      c.radial = q;
      c.depth = 1 - rr; // 0 바깥 ~ 1 안쪽
      c.h01 = (c.c[1] - ylo) / Math.max(0.1, yhi - ylo);
      c.phase = rng.next();
    }
  } else {
    T.crownCenter = [0, (minY + maxY) / 2, 0];
    T.crownRadii = [1, 1, 1];
  }
  T.lobes = makeLobes(cl, T.kind === 'shrub' ? 2 : Math.max(2, Math.min(6, Math.round(cl.length / 55))), rng);
  return T;
}

// ---------------------------------------------------------------------------
export function buildTreeTemplate(key, variant, tile, forked = false) {
  const G = GROWTH[key];
  const rng = new Random(7001 + variant * 131 + key.length * 17 + key.charCodeAt(0) * 3);
  const B = new Builder(rng);
  const H = G.Href;
  const hb = G.crownBase * H;
  const n = G.limbs + Math.floor(rng.range(-2, 3));
  const stemR = 0.16; // 템플릿 기준 줄기 반지름(가지 시작점을 줄기 표면 근처로)
  // 두 갈래 줄기: 갈라지는 높이에서 두 원줄기(템플릿의 일부, 위쪽 가지는 이 원줄기에 붙는다)
  let leaders = null;
  let forkH = 0;
  if (forked) {
    forkH = H * rng.range(0.38, 0.55);
    const az0 = rng.range(0, TAU);
    leaders = [];
    for (let k = 0; k < 2; k++) {
      const az = az0 + k * Math.PI + rng.range(-0.3, 0.3);
      const div = rng.range(0.22, 0.42);
      const d = [Math.sin(div) * Math.cos(az), Math.cos(div), Math.sin(div) * Math.sin(az)];
      const ld = B.grow([0, forkH, 0], d, (H - forkH) * rng.range(0.88, 1.0), stemR * 0.62, 0.02, 6, { upCurve: 0.05, wobble: 0.04, hA: forkH, level: 0 });
      leaders.push(ld);
    }
  }
  for (let i = 0; i < n; i++) {
    const u = Math.min(1, Math.max(0, (i + rng.range(0, 0.7)) / n));
    let hA = hb + u * (H * 0.95 - hb);
    const az = i * 2.39996 + rng.range(-0.6, 0.6);
    let env = G.profile(u);
    if (G.irregular) env *= 1 - G.irregular * 0.5 + rng.next() * G.irregular;
    const elev = G.angle[0] + (G.angle[1] - G.angle[0]) * (1 - u) + rng.range(-0.15, 0.15);
    const dir = [Math.sin(elev) * Math.cos(az), Math.cos(elev), Math.sin(elev) * Math.sin(az)];
    // 수평으로 수관 반지름만큼 뻗되, 나무 꼭대기를 넘지 않게
    let L = Math.max(0.6, (G.R * env * rng.range(0.85, 1.2)) / Math.max(0.35, Math.sin(elev)));
    L = Math.min(L, ((H * 1.02 - hA) / Math.max(0.25, Math.cos(elev))) * 1.08 + 0.6);
    const rT = stemR * Math.pow(1 - u * 0.75, 0.9);
    let start = [Math.cos(az) * rT * 0.6, hA, Math.sin(az) * rT * 0.6];
    if (leaders && hA > forkH + 0.3) {
      // 갈라진 위쪽 가지는 가까운 원줄기에서 나온다(변위 기준 높이는 갈라진 곳)
      const ld = leaders[i % 2];
      const t = Math.min(0.95, (hA - forkH) / (H - forkH));
      const at = B.along(ld, t);
      start = add(at.p, [Math.cos(az) * at.r * 0.6, 0, Math.sin(az) * at.r * 0.6]);
      hA = forkH;
    }
    const limb = B.grow(start, dir, L, G.limbR * Math.sqrt(L / G.R) * rng.range(0.8, 1.15), 0.012, 5, {
      upCurve: G.upCurve,
      droop: G.droop,
      wobble: G.wobble,
      hA,
      level: 1,
    });
    // 아래쪽 마른 가지(죽은 가지가 짧게 남음)
    const nSec = rng.int(G.sec[0], G.sec[1]);
    for (let k = 0; k < nSec; k++) {
      const t = rng.range(0.32, 0.92);
      const at = B.along(limb, t);
      const sd = norm(add(rotAxis(at.d, perp(at.d, rng), rng.range(0.45, 0.95)), [0, 0.25, 0]));
      const sl = L * rng.range(G.secLen[0], G.secLen[1]);
      const sec = B.grow(at.p, sd, sl, Math.max(0.012, at.r * 0.55), 0.006, 3, { upCurve: G.upCurve * 0.6, droop: G.droop * 1.3, wobble: G.wobble, hA, level: 2 });
      const nc = rng.int(G.perSec[0], G.perSec[1]);
      for (let q = 0; q < nc; q++) {
        const tt = 0.35 + (0.65 * (q + rng.next() * 0.6)) / nc;
        const c = B.along(sec, tt);
        const out = [c.p[0], 0, c.p[2]];
        B.cluster(add(c.p, scale(randUnit(rng), 0.12)), len(out) > 0.01 ? out : randUnit(rng), rng.range(G.clusterSize[0], G.clusterSize[1]), tile, hA, sec);
      }
    }
    // 가지 끝 뭉치
    const nTip = rng.int(2, 3);
    for (let q = 0; q < nTip; q++) {
      const c = B.along(limb, rng.range(0.82, 1.0));
      B.cluster(add(c.p, scale(randUnit(rng), 0.18)), [c.p[0], 0.2, c.p[2]], rng.range(G.clusterSize[0], G.clusterSize[1]) * 1.05, tile, hA, limb);
    }
  }
  // 수관 아래 줄기의 죽은 가지와 가지 그루터기(햇빛을 못 받아 말라 죽은 아래 가지)
  const nStub = rng.int(4, 8);
  for (let i = 0; i < nStub; i++) {
    const hA = rng.range(1.6, Math.max(2.0, hb * 0.98));
    const az = rng.range(0, TAU);
    const elev = rng.range(0.9, 1.5);
    const d = [Math.sin(elev) * Math.cos(az), Math.cos(elev), Math.sin(elev) * Math.sin(az)];
    const Ls = rng.chance(0.6) ? rng.range(0.12, 0.45) : rng.range(0.6, 1.8);
    B.grow([Math.cos(az) * 0.1, hA, Math.sin(az) * 0.1], d, Ls, rng.range(0.012, 0.03), 0.008, Ls > 0.5 ? 3 : 1, { droop: 0.08, wobble: 0.25, hA, level: 3, dead: true });
  }
  // 줄기에 붙은 잔가지 뭉치(포플러 기둥형 수관 속을 채움)
  for (let i = 0; i < (G.epicormic || 0); i++) {
    const hA = hb + rng.next() * (H * 0.97 - hb);
    const az = rng.range(0, TAU);
    const rr = rng.range(0.3, 1.0);
    const p = [Math.cos(az) * rr, hA, Math.sin(az) * rr];
    B.cluster(p, [Math.cos(az), 0.3, Math.sin(az)], rng.range(G.clusterSize[0], G.clusterSize[1]) * 0.9, tile, hA, null);
  }
  // 꼭대기 끝순(갈라지지 않은 나무)
  if (!leaders) {
    const topLimb = B.grow([0, H * 0.94, 0], norm([rng.range(-0.15, 0.15), 1, rng.range(-0.15, 0.15)]), H * 0.08, 0.03, 0.008, 3, { wobble: 0.08, hA: H * 0.94, level: 2 });
    for (let q = 0; q < 3; q++) {
      const c = B.along(topLimb, rng.range(0.4, 1));
      B.cluster(c.p, [rng.range(-1, 1), 0.6, rng.range(-1, 1)], G.clusterSize[1], tile, H * 0.94, topLimb);
    }
  }
  // 줄기 끝: 갈라지지 않으면 끝순 높이까지(끝 반지름 2.5 cm), 갈라지면 갈라진 곳(원줄기 굵기에 맞춤)
  const stemTop = leaders ? forkH : H * 0.95;
  const stemTopR = leaders ? (stemR * 0.62) / 0.72 : 0.025;
  const T = { key, kind: 'tree', Href: H, crownBase: hb, branches: B.branches, clusters: B.clusters, stemTop, stemTopR, refStemR: stemR, forked: !!leaders };
  return finish(T, rng);
}

/** 고사목: 잎 없이 부러진 가지만(아래쪽은 그루터기만 남음) */
export function buildSnagTemplate(variant) {
  const rng = new Random(9101 + variant * 57);
  const B = new Builder(rng);
  const H = 16;
  const n = 14 + variant * 3;
  for (let i = 0; i < n; i++) {
    const u = (i + rng.next() * 0.7) / n;
    const hA = H * (0.18 + u * 0.7);
    const az = i * 2.39996 + rng.range(-0.5, 0.5);
    const elev = rng.range(0.6, 1.25);
    const dir = [Math.sin(elev) * Math.cos(az), Math.cos(elev), Math.sin(elev) * Math.sin(az)];
    // 대부분 부러져 짧다
    const broken = rng.chance(0.55);
    const L = (broken ? rng.range(0.3, 1.2) : rng.range(1.5, 3.8)) * (1 - u * 0.4);
    const limb = B.grow([Math.cos(az) * 0.08, hA, Math.sin(az) * 0.08], dir, L, rng.range(0.035, 0.075), broken ? 0.03 : 0.01, broken ? 2 : 4, {
      upCurve: 0.05,
      droop: 0.05,
      wobble: 0.25,
      hA,
      level: 1,
      dead: true,
    });
    if (!broken && rng.chance(0.7)) {
      const at = B.along(limb, rng.range(0.4, 0.8));
      B.grow(at.p, rotAxis(at.d, perp(at.d, rng), 0.7), L * 0.45, at.r * 0.5, 0.006, 2, { wobble: 0.3, hA, level: 2, dead: true });
    }
  }
  const T = { key: 'snag', kind: 'snag', Href: H, crownBase: H * 0.2, branches: B.branches, clusters: [], stemTop: H * 0.92, stemTopR: 0.05, refStemR: 0.12, forked: false };
  return finish(T, rng);
}

/** 관목: 밑동에서 여러 줄기가 아치 모양으로 뻗고 잎 뭉치가 촘촘 */
export function buildShrubTemplate(key, variant, tile) {
  const G = SHRUB_GROWTH[key];
  const rng = new Random(5003 + variant * 71 + key.charCodeAt(0) * 11 + key.length);
  const B = new Builder(rng);
  const nStems = rng.int(G.stems[0], G.stems[1]);
  const stems = [];
  for (let i = 0; i < nStems; i++) {
    const az = (i / nStems) * TAU + rng.range(-0.4, 0.4);
    const out = rng.range(0.15, 0.6) * G.spread;
    const dir = norm([Math.cos(az) * out, 1, Math.sin(az) * out]);
    const L = G.H * rng.range(0.75, 1.2);
    const st = B.grow([Math.cos(az) * rng.range(0, 0.25), 0, Math.sin(az) * rng.range(0, 0.25)], dir, L, rng.range(0.012, 0.03), 0.005, 5, {
      upCurve: 0.02,
      droop: G.arch * 0.22,
      wobble: 0.14,
      hA: 0,
      level: 1,
    });
    stems.push(st);
    const nt = rng.int(G.twigs[0], G.twigs[1]);
    for (let k = 0; k < nt; k++) {
      const at = B.along(st, rng.range(0.35, 0.85));
      B.grow(at.p, rotAxis(at.d, perp(at.d, rng), rng.range(0.4, 0.9)), L * rng.range(0.25, 0.45), at.r * 0.6, 0.004, 2, { droop: G.arch * 0.2, wobble: 0.2, hA: 0, level: 2 });
    }
  }
  // 잎 뭉치: 줄기·잔가지 위쪽 2/3에 촘촘히(바깥쪽이 더 많음)
  const all = B.branches.slice();
  for (let i = 0; i < G.clusters; i++) {
    const br = all[Math.floor(rng.next() * all.length)];
    const at = B.along(br, Math.pow(rng.next(), 0.6) * 0.75 + 0.25);
    const out = [at.p[0], 0.25, at.p[2]];
    B.cluster(add(at.p, scale(randUnit(rng), 0.15)), out, rng.range(G.clusterSize[0], G.clusterSize[1]), tile, 0, br, { fruit: rng.chance(0.35) ? 1 : 0 });
  }
  const T = { key, kind: 'shrub', Href: G.H, R: G.R, crownBase: 0, branches: B.branches, clusters: B.clusters, stemTop: 0, stemTopR: 0.01, refStemR: 0.02, forked: false };
  return finish(T, rng);
}

export { GROWTH, SHRUB_GROWTH };

// ---------------------------------------------------------------------------
// 전체 템플릿 목록(숲띠 생성기와 렌더러가 같은 순서로 공유)
import { TREE_SPECIES, TREE_KEYS, SNAG, SHRUB_SPECIES, SHRUB_KEYS } from '../data/trees.js';

let _catalog = null;
export function templateCatalog() {
  if (_catalog) return _catalog;
  const list = [];
  const bySpecies = {};
  for (const k of TREE_KEYS) {
    const sp = TREE_SPECIES[k];
    bySpecies[k] = [];
    for (let v = 0; v < sp.templates; v++) {
      // 갈라지기 잘하는 수종은 마지막 변형을 두 갈래로
      const forked = sp.fork >= 0.2 && v === sp.templates - 1;
      const T = buildTreeTemplate(k, v, sp.leafTile, forked);
      T.index = list.length;
      T.species = k;
      list.push(T);
      bySpecies[k].push(T.index);
    }
  }
  bySpecies.snag = [];
  for (let v = 0; v < SNAG.templates; v++) {
    const T = buildSnagTemplate(v);
    T.index = list.length;
    T.species = 'snag';
    list.push(T);
    bySpecies.snag.push(T.index);
  }
  for (const k of SHRUB_KEYS) {
    const sp = SHRUB_SPECIES[k];
    bySpecies[k] = [];
    for (let v = 0; v < sp.templates; v++) {
      const T = buildShrubTemplate(k, v, sp.leafTile);
      T.index = list.length;
      T.species = k;
      list.push(T);
      bySpecies[k].push(T.index);
    }
  }
  _catalog = { list, bySpecies };
  return _catalog;
}
