// 나무 텍스처(런타임 절차 생성):
//  1) 잎 뭉치 아틀라스(3×3 칸, 칸마다 잔가지에 달린 잎 다발 한 덩이)
//     R = 잎 명암(잎맥·가장자리), G = 잎 아닌 것(잔가지·열매) 표시, B = 잎마다 조금 다른 값(잎이면) / 열매 표시(잎 아니면), A = 덮임
//  2) 껍질 배열 텍스처(층: 포플러 아래·포플러 위·아카시아·느릅·단풍·물푸레·고사목) — 색(sRGB)+높이, 법선(높이에서)

import * as THREE from 'three';
import { Random } from '../core/Random.js';

export const LEAF_TILES = { poplar: 0, locust: 1, elm: 2, maple: 3, ash: 4, elder: 5, rose: 6, blackthorn: 7, oleaster: 8 };
export const BARK_LAYERS = { poplar: 0, poplarUpper: 1, locust: 2, elm: 3, maple: 4, ash: 5, dead: 6 };
// 껍질 한 장의 실제 크기(둘레 방향 m, 높이 방향 m)
export const BARK_TILE = [0.5, 1.0];

// ---------------------------------------------------------------------------
// 잎 그리기 도우미: 잎 모양 경로(원점 = 잎자루 끝, +y = 잎끝 방향)
function leafPath(c, kind, L, W) {
  c.beginPath();
  if (kind === 'delta') {
    // 세모꼴(포플러): 넓은 밑, 뾰족한 끝
    c.moveTo(0, 0);
    c.bezierCurveTo(W * 0.75, L * 0.05, W * 0.6, L * 0.55, 0, L);
    c.bezierCurveTo(-W * 0.6, L * 0.55, -W * 0.75, L * 0.05, 0, 0);
  } else if (kind === 'oval') {
    c.ellipse(0, L * 0.5, W * 0.5, L * 0.5, 0, 0, Math.PI * 2);
  } else if (kind === 'serrate') {
    // 톱니 타원(느릅): 밑이 비대칭
    const n = 14;
    c.moveTo(0, 0);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const w = W * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.85)) * (i % 2 ? 1.08 : 0.93);
      c.lineTo(w, L * t);
    }
    for (let i = n - 1; i >= 0; i--) {
      const t = i / n;
      const w = W * 0.44 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (i % 2 ? 1.08 : 0.93);
      c.lineTo(-w, L * t);
    }
  } else if (kind === 'lance') {
    // 피침형(물푸레·보리수)
    c.moveTo(0, 0);
    c.quadraticCurveTo(W * 0.62, L * 0.35, 0, L);
    c.quadraticCurveTo(-W * 0.62, L * 0.35, 0, 0);
  } else if (kind === 'toothed') {
    // 거친 톱니(네군도단풍 작은잎)
    const n = 8;
    c.moveTo(0, 0);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const w = W * 0.5 * Math.sin(Math.PI * t) * (i % 2 ? 1.18 : 0.82);
      c.lineTo(w, L * t);
    }
    for (let i = n - 1; i >= 0; i--) {
      const t = i / n;
      const w = W * 0.5 * Math.sin(Math.PI * t) * (i % 2 ? 1.18 : 0.82);
      c.lineTo(-w, L * t);
    }
  }
  c.closePath();
}

class LeafTile {
  constructor(ctx, ox, oy, size, rng) {
    this.c = ctx;
    this.ox = ox;
    this.oy = oy;
    this.S = size;
    this.rng = rng;
  }
  twig(pts, w) {
    const c = this.c;
    c.strokeStyle = 'rgba(120,255,0,1)';
    c.lineCap = 'round';
    c.lineWidth = w;
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(this.ox + x, this.oy + y) : c.moveTo(this.ox + x, this.oy + y)));
    c.stroke();
  }
  /** 잎 한 장: (x, y)에서 각 ang 방향으로 */
  leaf(x, y, ang, L, W, kind, petiole = 0) {
    const c = this.c;
    const rng = this.rng;
    const id = Math.floor(rng.range(10, 245));
    const shade = Math.floor(rng.range(170, 235));
    c.save();
    c.translate(this.ox + x, this.oy + y);
    c.rotate(ang);
    if (petiole > 0) {
      c.strokeStyle = 'rgba(110,255,0,1)';
      c.lineWidth = Math.max(1, L * 0.035);
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(0, petiole);
      c.stroke();
      c.translate(0, petiole);
    }
    // 잎몸: 가운데 밝고 가장자리 어둡게, 잎맥 어둡게(잎이 휜 느낌)
    const g = c.createLinearGradient(-W * 0.5, 0, W * 0.5, 0);
    g.addColorStop(0, `rgb(${shade - 60},0,${id})`);
    g.addColorStop(0.42, `rgb(${shade},0,${id})`);
    g.addColorStop(0.58, `rgb(${shade - 12},0,${id})`);
    g.addColorStop(1, `rgb(${shade - 45},0,${id})`);
    c.fillStyle = g;
    leafPath(c, kind, L, W);
    c.fill();
    c.strokeStyle = `rgba(${shade - 70},0,${id},0.55)`;
    c.lineWidth = Math.max(0.8, L * 0.022);
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(0, L * 0.93);
    const nv = kind === 'lance' ? 4 : 5;
    for (let v = 1; v <= nv; v++) {
      const t = v / (nv + 1);
      const w = W * 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.05));
      c.moveTo(0, L * t);
      c.lineTo(w, L * (t + 0.1));
      c.moveTo(0, L * t);
      c.lineTo(-w, L * (t + 0.1));
    }
    c.stroke();
    c.restore();
  }
  fruit(x, y, r) {
    const c = this.c;
    c.fillStyle = 'rgba(200,255,255,1)';
    c.beginPath();
    c.arc(this.ox + x, this.oy + y, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,1)';
    c.beginPath();
    c.arc(this.ox + x - r * 0.3, this.oy + y - r * 0.3, r * 0.35, 0, Math.PI * 2);
    c.fill();
  }
  /** 깃꼴 겹잎: 잎자루 + 작은잎 쌍 + 끝 작은잎 */
  pinnate(x, y, ang, len, pairs, lL, lW, kind) {
    const rng = this.rng;
    const dx = Math.sin(ang);
    const dy = -Math.cos(ang);
    const bend = rng.range(-0.25, 0.25);
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const a = ang + bend * t;
      pts.push([x + Math.sin(a) * len * t, y - Math.cos(a) * len * t]);
    }
    this.twig(pts, Math.max(1.2, lW * 0.12));
    for (let p = 0; p < pairs; p++) {
      const t = 0.18 + (0.78 * (p + 0.5)) / pairs;
      const a = ang + bend * t;
      const px = x + Math.sin(a) * len * t;
      const py = y - Math.cos(a) * len * t;
      for (const side of [-1, 1]) this.leaf(px, py, a + Math.PI + side * rng.range(1.05, 1.45), lL * rng.range(0.85, 1.1), lW * rng.range(0.85, 1.1), kind, lL * 0.06);
    }
    this.leaf(x + dx * len, y + dy * len, ang + Math.PI + bend, lL * 1.05, lW, kind, lL * 0.08);
  }
}

// 수종별 잎 뭉치 모양(타일 512 화소 기준). 카드 실제 크기(템플릿 clusterSize)에 맞춘 실제 잎 크기:
//  포플러 잎몸 7~9 cm·잎자루 4~6 cm, 아카시아 작은잎 2.5~4.5 cm(깃꼴 7~19장), 시베리아느릅 2~6 cm(지그재그 두 줄),
//  네군도단풍 작은잎 5~10 cm(3~5장), 물푸레 작은잎 5~12 cm(5~9장), 딱총 5~12 cm, 들장미 1.5~4 cm, 가시자두 2~4 cm, 보리수 4~8 × 1~2.5 cm
// target: 타일 덮임(멀리서 수관이 성글지 않도록 실제 잔가지 다발처럼 빽빽하게)
const LEAF_STYLE = {
  poplar: { mode: 'alt', kind: 'delta', L: [40, 54], W: [36, 48], pet: [20, 32], step: 0.75, twigW: 3, len: [0.32, 0.55], spread: 0.55, target: 0.44 },
  locust: { mode: 'pinnate', kind: 'oval', L: [15, 22], W: [9, 13], pairs: [4, 8], rachis: [95, 140], twigW: 2.2, len: [0.25, 0.45], spread: 0.9, target: 0.4 },
  elm: { mode: 'zigzag', kind: 'serrate', L: [20, 32], W: [11, 16], pet: [2, 4], step: 0.95, twigW: 1.8, len: [0.3, 0.5], spread: 0.8, target: 0.46 },
  maple: { mode: 'tri', kind: 'toothed', L: [32, 48], W: [20, 30], pet: [30, 50], twigW: 2.4, len: [0.2, 0.35], spread: 0.9, target: 0.42 },
  ash: { mode: 'pinnate', kind: 'lance', L: [30, 44], W: [11, 16], pairs: [2, 4], rachis: [110, 170], twigW: 2.6, len: [0.25, 0.4], spread: 0.75, target: 0.42 },
  elder: { mode: 'pinnate', kind: 'serrate', L: [40, 56], W: [17, 23], pairs: [2, 3], rachis: [110, 160], twigW: 3, len: [0.25, 0.4], spread: 0.85, target: 0.45, fruit: 'umbel' },
  rose: { mode: 'pinnate', kind: 'serrate', L: [15, 24], W: [10, 15], pairs: [2, 3], rachis: [55, 85], twigW: 2, len: [0.3, 0.5], spread: 1.1, target: 0.4, fruit: 'hips' },
  blackthorn: { mode: 'alt', kind: 'oval', L: [18, 28], W: [10, 14], pet: [3, 6], step: 0.7, twigW: 2.2, len: [0.25, 0.5], spread: 1.0, target: 0.42, spines: true, fruit: 'sloe' },
  oleaster: { mode: 'alt', kind: 'lance', L: [30, 46], W: [8, 12], pet: [3, 5], step: 0.45, twigW: 2.2, len: [0.3, 0.55], spread: 0.7, target: 0.4 },
};

/** 잔가지 하나와 거기 달린 잎(종별 배열 방식) */
function drawShoot(T, st, rng, S, x0, y0, a0, len) {
  const L = () => rng.range(st.L[0], st.L[1]);
  const W = () => rng.range(st.W[0], st.W[1]);
  const pts = [[x0, y0]];
  const nSeg = 8;
  let a = a0;
  const bend = rng.range(-0.35, 0.35);
  for (let i = 1; i <= nSeg; i++) {
    a += (bend / nSeg) + (st.mode === 'zigzag' ? (i % 2 ? 0.22 : -0.22) : rng.range(-0.06, 0.06));
    const p = pts[i - 1];
    pts.push([p[0] + Math.sin(a) * (len / nSeg), p[1] - Math.cos(a) * (len / nSeg)]);
  }
  T.twig(pts, st.twigW);
  const at = (t) => {
    const f = t * nSeg;
    const i = Math.min(nSeg - 1, Math.floor(f));
    const k = f - i;
    const A = pts[i];
    const B = pts[i + 1];
    return [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, Math.atan2(B[0] - A[0], -(B[1] - A[1]))];
  };
  if (st.mode === 'alt' || st.mode === 'zigzag') {
    const meanL = (st.L[0] + st.L[1]) * 0.5;
    const n = Math.max(3, Math.floor(len / (meanL * st.step)));
    for (let i = 0; i < n; i++) {
      const t = 0.12 + (0.88 * (i + rng.next() * 0.3)) / n;
      const [px, py, ta] = at(t);
      const side = i % 2 ? 1 : -1;
      const la = ta + side * rng.range(st.mode === 'zigzag' ? 1.0 : 0.55, st.mode === 'zigzag' ? 1.4 : 1.15);
      T.leaf(px, py, la + Math.PI, L(), W(), st.kind, rng.range(st.pet[0], st.pet[1]));
      if (st.spines && rng.chance(0.25)) {
        const sa = ta - side * rng.range(0.6, 1.1);
        T.twig([[px, py], [px + Math.sin(sa) * 14, py - Math.cos(sa) * 14]], 1.4);
      }
    }
    // 끝잎
    const [ex, ey, ea] = at(1);
    T.leaf(ex, ey, ea + Math.PI, L() * 0.9, W() * 0.9, st.kind, rng.range(st.pet[0], st.pet[1]));
  } else if (st.mode === 'pinnate') {
    // 잔가지 마디마다 깃꼴 겹잎(어긋나기·마주나기)
    const n = Math.max(2, Math.floor(len / (st.rachis[0] * 0.55)));
    for (let i = 0; i < n; i++) {
      const t = 0.2 + (0.8 * (i + rng.next() * 0.4)) / n;
      const [px, py, ta] = at(t);
      const side = i % 2 ? 1 : -1;
      const ra = ta + side * rng.range(0.5, 1.0);
      T.pinnate(px, py, ra, rng.range(st.rachis[0], st.rachis[1]), rng.int(st.pairs[0], st.pairs[1]), L(), W(), st.kind);
    }
    const [ex, ey, ea] = at(1);
    T.pinnate(ex, ey, ea, rng.range(st.rachis[0], st.rachis[1]), rng.int(st.pairs[0], st.pairs[1]), L(), W(), st.kind);
  } else if (st.mode === 'tri') {
    // 네군도단풍: 마주난 잎자루 끝에 작은잎 3(~5)장
    const n = Math.max(2, Math.floor(len / 70));
    for (let i = 0; i < n; i++) {
      const t = 0.25 + (0.75 * (i + rng.next() * 0.3)) / n;
      const [px, py, ta] = at(t);
      for (const side of [-1, 1]) {
        const pa = ta + side * rng.range(0.6, 1.0);
        const pl = rng.range(st.pet[0], st.pet[1]);
        const tx = px + Math.sin(pa) * pl;
        const ty = py - Math.cos(pa) * pl;
        T.twig([[px, py], [tx, ty]], 1.6);
        const k = rng.chance(0.7) ? 3 : 5;
        for (let j = 0; j < k; j++) {
          const sa = pa + (j - (k - 1) / 2) * 0.7;
          T.leaf(tx, ty, sa + Math.PI, L() * (j === (k - 1) / 2 ? 1.1 : 0.9), W(), st.kind, 4);
        }
      }
    }
  }
}

function drawLeafTile(ctx, ox, oy, S, key, rng) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, S, S);
  ctx.clip();
  const T = new LeafTile(ctx, ox, oy, S, rng);
  const st = LEAF_STYLE[key];
  const coverage = () => {
    const d = ctx.getImageData(ox, oy, S, S).data;
    let sum = 0;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 5) {
      sum += d[i];
      n++;
    }
    return sum / n / 255;
  };
  // 밑동(아래 가운데)에서 부채꼴로 뻗는 잔가지 + 안쪽에서 갈라진 잔가지로 타원형 다발을 채운다
  for (let k = 0; k < 80; k++) {
    let x0;
    let y0;
    let a0;
    if (k < 4 || rng.chance(0.45)) {
      x0 = S * 0.5 + rng.gauss() * S * 0.08;
      y0 = S * 0.97;
      a0 = rng.gauss() * st.spread * 0.6;
    } else {
      // 다발 안쪽 임의 점(타원)에서 바깥쪽으로
      const r = Math.sqrt(rng.next()) * 0.26 * S;
      const t = rng.range(0, Math.PI * 2);
      x0 = S * 0.5 + Math.cos(t) * r;
      y0 = S * 0.56 + Math.sin(t) * r;
      a0 = Math.atan2(x0 - S * 0.5, S * 0.97 - y0) + rng.gauss() * 0.4;
    }
    // 다발 바깥 원(반지름 0.47 S) 안에서 끝나게: 카드 테두리에서 잎이 잘려 네모난 윤곽이 보이지 않도록
    let len = S * rng.range(st.len[0], st.len[1]);
    const dxs = Math.sin(a0);
    const dys = -Math.cos(a0);
    const qx = x0 - S * 0.5;
    const qy = y0 - S * 0.52;
    const Rm = S * 0.47 - (st.L[1] + (st.rachis ? st.rachis[1] * 0.5 : 0) + (st.pet ? st.pet[1] : 0)) * 0.6;
    const b = qx * dxs + qy * dys;
    const cc = qx * qx + qy * qy - Rm * Rm;
    const disc = b * b - cc;
    const tMax = disc > 0 ? -b + Math.sqrt(disc) : 0;
    len = Math.min(len, Math.max(S * 0.08, tMax));
    drawShoot(T, st, rng, S, x0, y0, a0, len);
    if (k >= 3 && k % 3 === 0 && coverage() >= st.target) break;
  }
  // 열매
  if (st.fruit === 'umbel') {
    for (let u = 0; u < 2; u++) {
      const fx = S * 0.5 + rng.range(-120, 120);
      const fy = S * 0.5 + rng.range(-60, 120);
      for (let i = 0; i < 70; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * 42;
        T.fruit(fx + Math.cos(a) * r, fy + Math.sin(a) * r * 0.55, rng.range(3.5, 5));
      }
    }
  } else if (st.fruit === 'hips') {
    const c = T.c;
    for (let i = 0; i < 14; i++) {
      const x = S * 0.5 + rng.range(-200, 200);
      const y = S * 0.5 + rng.range(-180, 150);
      c.fillStyle = 'rgba(200,255,255,1)';
      c.beginPath();
      c.ellipse(ox + x, oy + y, 8, 12, rng.range(-0.6, 0.6), 0, Math.PI * 2);
      c.fill();
    }
  } else if (st.fruit === 'sloe') {
    for (let i = 0; i < 16; i++) T.fruit(S * 0.5 + rng.range(-200, 200), S * 0.5 + rng.range(-190, 160), rng.range(6, 8));
  }
  ctx.restore();
}

export function makeLeafClusterAtlas(tile = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = tile * 3;
  canvas.height = tile * 3;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rng = new Random(4711);
  const keys = Object.keys(LEAF_TILES);
  for (const k of keys) {
    const i = LEAF_TILES[k];
    drawLeafTile(ctx, (i % 3) * tile, Math.floor(i / 3) * tile, tile, k, rng);
  }
  // 투명한 곳의 색을 주변 잎 값으로 채움(밉맵에서 가장자리가 검게 섞여 먼 수관이 어두워지는 것 방지)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  dilateColors(img.data, canvas.width, canvas.height);
  const tex = new THREE.DataTexture(img.data, canvas.width, canvas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.flipY = false;
  return tex;
}

/** 밀고 당기기(push-pull) 채움: 덮임이 거의 없는 화소의 RGB를 가까운 불투명 화소 평균으로 */
export function dilateColors(d, W, H) {
  const levels = [];
  let w = W;
  let h = H;
  let col = new Float32Array(W * H * 3);
  let wt = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (d[i * 4 + 3] > 24) {
      wt[i] = 1;
      col[i * 3] = d[i * 4];
      col[i * 3 + 1] = d[i * 4 + 1];
      col[i * 3 + 2] = d[i * 4 + 2];
    }
  }
  levels.push({ w, h, col, wt });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const nc = new Float32Array(nw * nh * 3);
    const nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sw = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const xx = Math.min(w - 1, x * 2 + dx);
            const yy = Math.min(h - 1, y * 2 + dy);
            const k = yy * w + xx;
            const ww = wt[k];
            if (ww > 0) {
              sr += col[k * 3] * ww;
              sg += col[k * 3 + 1] * ww;
              sb += col[k * 3 + 2] * ww;
              sw += ww;
            }
          }
        }
        const o = y * nw + x;
        if (sw > 0) {
          nc[o * 3] = sr / sw;
          nc[o * 3 + 1] = sg / sw;
          nc[o * 3 + 2] = sb / sw;
          nwt[o] = 1;
        }
      }
    }
    w = nw;
    h = nh;
    col = nc;
    wt = nwt;
    levels.push({ w, h, col, wt });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l];
    const P = levels[l + 1];
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const k = y * L.w + x;
        if (L.wt[k] > 0) continue;
        const pk = Math.min(P.h - 1, y >> 1) * P.w + Math.min(P.w - 1, x >> 1);
        L.col[k * 3] = P.col[pk * 3];
        L.col[k * 3 + 1] = P.col[pk * 3 + 1];
        L.col[k * 3 + 2] = P.col[pk * 3 + 2];
        L.wt[k] = 1;
      }
    }
  }
  const L0 = levels[0];
  for (let i = 0; i < W * H; i++) {
    if (d[i * 4 + 3] > 24) continue;
    d[i * 4] = L0.col[i * 3];
    d[i * 4 + 1] = L0.col[i * 3 + 1];
    d[i * 4 + 2] = L0.col[i * 3 + 2];
  }
}

/** 아틀라스 칸 i의 uv 원점(왼쪽 위 기준, flipY=false) */
export function leafTileUV(i) {
  return [(i % 3) / 3, Math.floor(i / 3) / 3];
}

// ---------------------------------------------------------------------------
// 껍질
function hashI(x, y, s) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}
function pnoise(x, y, px, py, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const mx = (a) => ((a % px) + px) % px;
  const my = (a) => ((a % py) + py) % py;
  const a = hashI(mx(xi), my(yi), seed);
  const b = hashI(mx(xi + 1), my(yi), seed);
  const c = hashI(mx(xi), my(yi + 1), seed);
  const d = hashI(mx(xi + 1), my(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function pfbm(x, y, px, py, seed, oct) {
  let s = 0;
  let a = 0.5;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * pnoise(x, y, px, py, seed + i * 13);
    n += a;
    x *= 2;
    y *= 2;
    px *= 2;
    py *= 2;
    a *= 0.5;
  }
  return s / n;
}
// 세로로 길게 갈라진 골: 1 = 능선, 0 = 골
function ridges(x, y, cellsX, cellsY, seed, warp) {
  const w = (pfbm(x * cellsX * 0.5, y * cellsY * 0.5, cellsX * 0.5, cellsY * 0.5, seed + 99, 3) - 0.5) * warp;
  const n = pfbm((x + w) * cellsX, y * cellsY, cellsX, cellsY, seed, 3);
  return 1 - Math.abs(n * 2 - 1);
}
// 보로노이 거리(가장 가까운 두 점 차이) — 그물·덩이 무늬
function voronoiEdge(x, y, nx, ny, seed) {
  const fx = x * nx;
  const fy = y * ny;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let d1 = 9;
  let d2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i;
      const cy = iy + j;
      const wx = ((cx % nx) + nx) % nx;
      const wy = ((cy % ny) + ny) % ny;
      const px = cx + hashI(wx, wy, seed);
      const py = cy + hashI(wx, wy, seed + 7);
      const d = Math.hypot(fx - px, (fy - py) * 0.7);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) d2 = d;
    }
  }
  return d2 - d1;
}

function barkPixel(layer, u, v, out) {
  // u: 둘레(0~1), v: 높이(0~1). out = [r,g,b,h] (0~1, 색은 sRGB)
  let r;
  let g;
  let b;
  let h;
  const fine = pfbm(u * 16, v * 32, 16, 32, 11 + layer, 3);
  if (layer === 0) {
    // 포플러 아래: 짙은 회색, 깊게 갈라진 세로 골
    const rd = ridges(u, v, 7, 3, 21, 1.2);
    const deep = Math.pow(rd, 1.6);
    h = deep * 0.85 + fine * 0.15;
    const k = 0.35 + 0.55 * deep + (fine - 0.5) * 0.2;
    r = 0.4 * k + 0.05;
    g = 0.39 * k + 0.05;
    b = 0.36 * k + 0.04;
  } else if (layer === 1) {
    // 포플러 위: 회백색 매끈한 껍질 + 검은 마름모 껍질눈, 가로 껍질눈 줄
    const base = 0.72 + (pfbm(u * 4, v * 6, 4, 6, 33, 3) - 0.5) * 0.18;
    let k = base + (fine - 0.5) * 0.06;
    h = 0.6 + (fine - 0.5) * 0.1;
    // 마름모: 격자 셀마다 하나
    const cx = 5;
    const cy = 5;
    const ix = Math.floor(u * cx);
    const iy = Math.floor(v * cy);
    const ox = hashI(ix, iy, 41);
    const oy = hashI(ix, iy, 43);
    if (ox > 0.35) {
      const px = (ix + 0.3 + ox * 0.4) / cx;
      const py = (iy + 0.3 + oy * 0.4) / cy;
      const dd = Math.abs(u - px) * cx * 2.6 + Math.abs(v - py) * cy * 1.6;
      if (dd < 1) {
        k *= 0.18 + 0.4 * dd;
        h = 0.35 + 0.2 * dd;
      }
    }
    const streak = Math.pow(Math.abs(Math.sin(v * Math.PI * 22 + pnoise(u * 8, v * 8, 8, 8, 5) * 3)), 18) * (pfbm(u * 6, v * 3, 6, 3, 9, 2) > 0.55 ? 1 : 0);
    k *= 1 - streak * 0.4;
    r = k * 0.86;
    g = k * 0.88;
    b = k * 0.84;
  } else if (layer === 2) {
    // 아카시아: 깊게 얽힌 세로 골, 갈색
    const rd = ridges(u, v, 6, 2, 51, 2.2);
    const rd2 = ridges(u + 0.37, v, 9, 3, 52, 1.6);
    const deep = Math.pow(Math.max(rd, rd2 * 0.85), 2.2);
    h = deep * 0.9 + fine * 0.1;
    const k = 0.25 + 0.6 * deep;
    r = 0.42 * k + 0.05;
    g = 0.33 * k + 0.04;
    b = 0.25 * k + 0.03;
  } else if (layer === 3) {
    // 느릅: 회갈색 거친 그물 무늬(코르크 덩이)
    const e = voronoiEdge(u, v, 9, 7, 61);
    const crack = Math.min(1, e / 0.18);
    h = 0.3 + 0.6 * crack * (0.8 + fine * 0.4);
    const k = 0.3 + 0.55 * crack + (fine - 0.5) * 0.2;
    r = 0.4 * k + 0.04;
    g = 0.35 * k + 0.04;
    b = 0.29 * k + 0.03;
  } else if (layer === 4) {
    // 네군도단풍: 연회갈색 얕은 골
    const rd = ridges(u, v, 8, 4, 71, 1.0);
    const deep = Math.pow(rd, 0.9);
    h = 0.4 + deep * 0.4 + fine * 0.2;
    const k = 0.55 + 0.35 * deep + (fine - 0.5) * 0.15;
    r = 0.47 * k;
    g = 0.43 * k;
    b = 0.37 * k;
  } else if (layer === 5) {
    // 물푸레: 회색, 규칙적인 마름모 골(두 대각 능선이 엇갈림)
    // 비스듬한 능선: 높이 한 장(1 m)마다 둘레 한 장만큼 밀려 위아래로도 이음매 없이 반복
    const a1 = ridges(u + v, v, 10, 2, 81, 0.4);
    const a2 = ridges(u - v, v, 10, 2, 82, 0.4);
    const deep = Math.pow(Math.max(a1, a2), 1.8);
    h = deep * 0.8 + fine * 0.2;
    const k = 0.32 + 0.55 * deep;
    r = 0.44 * k + 0.05;
    g = 0.43 * k + 0.05;
    b = 0.4 * k + 0.05;
  } else {
    // 고사목: 껍질이 벗겨진 은회색 목질 + 세로 균열, 남은 껍질 조각
    const grain = pfbm(u * 40, v * 3, 40, 3, 91, 3);
    const crack = Math.pow(Math.abs(Math.sin((u + (grain - 0.5) * 0.05) * Math.PI * 14)), 40);
    const patch = pfbm(u * 3, v * 2, 3, 2, 93, 3) > 0.62;
    let k = 0.62 + (grain - 0.5) * 0.25 - crack * 0.5;
    h = 0.55 + (grain - 0.5) * 0.3 - crack * 0.4;
    if (patch) {
      k = 0.25 + fine * 0.15;
      h = 0.75;
    }
    r = k * 0.88;
    g = k * 0.86;
    b = k * 0.8;
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
  out[3] = h;
}

export function makeBarkTextures(W = 256, H = 512) {
  const n = 7;
  const alb = new Uint8Array(W * H * 4 * n);
  const nrm = new Uint8Array(W * H * 4 * n);
  const hb = new Float32Array(W * H);
  const px = [0, 0, 0, 0];
  for (let l = 0; l < n; l++) {
    const off = l * W * H * 4;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        barkPixel(l, x / W, y / H, px);
        const i = off + (y * W + x) * 4;
        // barkPixel 색은 이미 sRGB 값 → 그대로 저장(텍스처가 sRGB로 풀어 선형으로 읽힌다)
        alb[i] = Math.max(0, Math.min(255, px[0] * 255));
        alb[i + 1] = Math.max(0, Math.min(255, px[1] * 255));
        alb[i + 2] = Math.max(0, Math.min(255, px[2] * 255));
        alb[i + 3] = Math.max(0, Math.min(255, px[3] * 255));
        hb[y * W + x] = px[3];
      }
    }
    const strength = [5, 2, 6, 5, 3, 5, 3][l];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const xm = (x - 1 + W) % W;
        const xp = (x + 1) % W;
        const ym = (y - 1 + H) % H;
        const yp = (y + 1) % H;
        const gx = hb[y * W + xp] - hb[y * W + xm];
        const gy = hb[yp * W + x] - hb[ym * W + x];
        let nx = -gx * strength;
        let ny = -gy * strength;
        const len = Math.hypot(nx, ny, 1);
        nx /= len;
        ny /= len;
        const i = off + (y * W + x) * 4;
        nrm[i] = (nx * 0.5 + 0.5) * 255;
        nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
        nrm[i + 2] = Math.max(0, Math.min(255, (0.35 + hb[y * W + x] * 0.65) * 255)); // 골 그늘
        nrm[i + 3] = 255;
      }
    }
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, W, H, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  const avg = [];
  for (let l = 0; l < n; l++) {
    const off = l * W * H * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < W * H; i += 7) {
      r += Math.pow(alb[off + i * 4] / 255, 2.2);
      g += Math.pow(alb[off + i * 4 + 1] / 255, 2.2);
      b += Math.pow(alb[off + i * 4 + 2] / 255, 2.2);
    }
    const c = Math.ceil((W * H) / 7);
    avg.push([r / c, g / c, b / c]);
  }
  return { albedo: mk(alb, true), normal: mk(nrm, false), avg };
}
