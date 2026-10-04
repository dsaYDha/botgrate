// 지면 세부 텍스처(런타임 절차 생성, 이음매 없이 반복). 외부 이미지 파일 없음.
// 층: 0 마른 흙, 1 갈아엎은 흙덩이, 2 낙엽층, 3 마른 풀, 4 그루터기(줄), 5 이끼·짧은 풀, 6 갈라진 진흙, 7 다져진 흙길
// 알베도 배열 텍스처(RGB = sRGB 색, A = 높이)와 법선 배열 텍스처(RG = 법선 xy, B = 틈새 그늘)를 만든다.

import * as THREE from 'three';
import { Random } from '../core/Random.js';

export const GROUND_LAYERS = { soil: 0, clods: 1, litter: 2, thatch: 3, stubble: 4, moss: 5, mud: 6, road: 7 };
// 각 층 타일 한 장의 실제 크기(m)
export const GROUND_TILE = [2.0, 2.0, 1.4, 1.6, 1.0, 1.5, 3.0, 2.2];

function hashI(x, y, s) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

/** 주기(period 칸)로 반복되는 값 노이즈 */
function pnoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const m = (a) => ((a % period) + period) % period;
  const a = hashI(m(xi), m(yi), seed);
  const b = hashI(m(xi + 1), m(yi), seed);
  const c = hashI(m(xi), m(yi + 1), seed);
  const d = hashI(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function pfbm(x, y, period, seed, oct = 4) {
  let s = 0;
  let a = 0.5;
  let n = 0;
  let p = period;
  for (let i = 0; i < oct; i++) {
    s += a * pnoise(x, y, p, seed + i * 31);
    n += a;
    x *= 2;
    y *= 2;
    p *= 2;
    a *= 0.5;
  }
  return s / n;
}

class Layer {
  constructor(size, seed) {
    this.size = size;
    this.rng = new Random(seed);
    this.seed = seed;
    this.col = document.createElement('canvas');
    this.col.width = this.col.height = size;
    this.hgt = document.createElement('canvas');
    this.hgt.width = this.hgt.height = size;
    this.c = this.col.getContext('2d');
    this.h = this.hgt.getContext('2d');
  }
  /** 배경: 노이즈 색 + 높이 */
  background(base, varAmt, cells, hBase = 0.5, hVar = 0.15, tint = null) {
    const S = this.size;
    const ci = this.c.createImageData(S, S);
    const hi = this.h.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * cells;
        const fy = (y / S) * cells;
        const n = pfbm(fx, fy, cells, this.seed, 4);
        const n2 = pfbm(fx * 4, fy * 4, cells * 4, this.seed + 7, 2);
        const k = 1 + (n - 0.5) * 2 * varAmt + (n2 - 0.5) * varAmt * 0.6;
        const i = (y * S + x) * 4;
        let r = base[0] * k;
        let g = base[1] * k;
        let b = base[2] * k;
        if (tint) {
          const t = pfbm(fx * 0.5 + 9, fy * 0.5 + 3, cells * 0.5, this.seed + 3, 2);
          r += (tint[0] - base[0]) * t;
          g += (tint[1] - base[1]) * t;
          b += (tint[2] - base[2]) * t;
        }
        ci.data[i] = r;
        ci.data[i + 1] = g;
        ci.data[i + 2] = b;
        ci.data[i + 3] = 255;
        const hv = Math.max(0, Math.min(1, hBase + (n - 0.5) * 2 * hVar + (n2 - 0.5) * hVar * 0.5)) * 255;
        hi.data[i] = hi.data[i + 1] = hi.data[i + 2] = hv;
        hi.data[i + 3] = 255;
      }
    }
    this.c.putImageData(ci, 0, 0);
    this.h.putImageData(hi, 0, 0);
  }
  /** 이음매 없이: 가장자리에 걸치는 도형은 반대편에도 그린다 */
  wrap(x, y, r, fn) {
    const S = this.size;
    for (const ox of [-S, 0, S]) {
      if (x + ox < -r || x + ox > S + r) continue;
      for (const oy of [-S, 0, S]) {
        if (y + oy < -r || y + oy > S + r) continue;
        fn(x + ox, y + oy);
      }
    }
  }
  rgb(c, a = 1) {
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  }
  gray(v, a = 1) {
    const g = Math.max(0, Math.min(255, v * 255)) | 0;
    return `rgba(${g},${g},${g},${a})`;
  }
}

function jitter(rng, c, amt) {
  const k = 1 + rng.range(-amt, amt);
  return [c[0] * k, c[1] * k, c[2] * k];
}

// ---------------------------------------------------------------------------
function drawSoil(L, base, crumb, pebbles) {
  const { rng, c, h, size: S } = L;
  L.background(base, 0.1, 6, 0.45, 0.12, [base[0] * 0.92, base[1] * 0.9, base[2] * 0.86]);
  // 부스러기·작은 흙덩이
  for (let i = 0; i < 2600; i++) {
    const x = rng.next() * S;
    const y = rng.next() * S;
    const r = rng.range(0.6, 2.4);
    const dark = rng.chance(0.5);
    const col = dark ? jitter(rng, crumb, 0.15) : jitter(rng, [base[0] * 1.12, base[1] * 1.1, base[2] * 1.08], 0.08);
    L.wrap(x, y, r, (px, py) => {
      c.fillStyle = L.rgb(col, 0.7);
      c.beginPath();
      c.arc(px, py, r, 0, Math.PI * 2);
      c.fill();
      h.fillStyle = L.gray(dark ? 0.38 : 0.6, 0.6);
      h.beginPath();
      h.arc(px, py, r, 0, Math.PI * 2);
      h.fill();
    });
  }
  // 자갈
  for (let i = 0; i < pebbles; i++) {
    const x = rng.next() * S;
    const y = rng.next() * S;
    const rx = rng.range(1.5, 5.5);
    const ry = rx * rng.range(0.6, 1);
    const a = rng.range(0, Math.PI);
    const col = jitter(rng, rng.chance(0.5) ? [150, 142, 128] : [118, 106, 92], 0.12);
    L.wrap(x, y, rx + 2, (px, py) => {
      c.fillStyle = 'rgba(40,30,22,0.35)';
      c.beginPath();
      c.ellipse(px + 1.2, py + 1.2, rx, ry, a, 0, Math.PI * 2);
      c.fill();
      const g = c.createRadialGradient(px - rx * 0.3, py - ry * 0.3, 0, px, py, rx);
      g.addColorStop(0, L.rgb([col[0] * 1.15, col[1] * 1.15, col[2] * 1.15]));
      g.addColorStop(1, L.rgb([col[0] * 0.8, col[1] * 0.8, col[2] * 0.8]));
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(px, py, rx, ry, a, 0, Math.PI * 2);
      c.fill();
      const hg = h.createRadialGradient(px, py, 0, px, py, rx);
      hg.addColorStop(0, L.gray(0.85));
      hg.addColorStop(1, L.gray(0.5));
      h.fillStyle = hg;
      h.beginPath();
      h.ellipse(px, py, rx, ry, a, 0, Math.PI * 2);
      h.fill();
    });
  }
}

function drawClods(L) {
  const { rng, c, h, size: S } = L;
  L.background([84, 66, 50], 0.12, 5, 0.35, 0.15, [72, 56, 44]);
  // 흙덩이: 불규칙한 덩어리, 위쪽(태양 무관한 위)은 마르고 밝게
  for (let i = 0; i < 520; i++) {
    const x = rng.next() * S;
    const y = rng.next() * S;
    const r = Math.pow(rng.next(), 1.8) * 22 + 4;
    const n = 7 + Math.floor(rng.next() * 4);
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = r * rng.range(0.65, 1.15);
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr * rng.range(0.7, 1)]);
    }
    const dryK = rng.range(0.95, 1.3);
    L.wrap(x, y, r * 1.3, (px, py) => {
      const path = () => {
        c.beginPath();
        pts.forEach(([u, v], k) => (k ? c.lineTo(px + u, py + v) : c.moveTo(px + u, py + v)));
        c.closePath();
      };
      c.save();
      c.translate(r * 0.18, r * 0.22);
      path();
      c.fillStyle = 'rgba(30,22,16,0.45)';
      c.fill();
      c.restore();
      path();
      const g = c.createRadialGradient(px - r * 0.3, py - r * 0.35, r * 0.1, px, py, r * 1.1);
      g.addColorStop(0, L.rgb([118 * dryK, 94 * dryK, 70 * dryK]));
      g.addColorStop(1, L.rgb([70, 54, 42]));
      c.fillStyle = g;
      c.fill();
      h.beginPath();
      pts.forEach(([u, v], k) => (k ? h.lineTo(px + u, py + v) : h.moveTo(px + u, py + v)));
      h.closePath();
      const hg = h.createRadialGradient(px, py, 0, px, py, r);
      hg.addColorStop(0, L.gray(0.55 + Math.min(0.4, r / 50)));
      hg.addColorStop(1, L.gray(0.42));
      h.fillStyle = hg;
      h.fill();
    });
  }
  // 짚 몇 가닥(갈아엎은 그루터기 흔적)
  for (let i = 0; i < 90; i++) straw(L, rng.next() * S, rng.next() * S, rng.range(8, 26), rng.range(0, Math.PI), [150, 128, 88], 1.2);
}

function straw(L, x, y, len, ang, col, w) {
  const { c, h } = L;
  const dx = Math.cos(ang) * len * 0.5;
  const dy = Math.sin(ang) * len * 0.5;
  L.wrap(x, y, len, (px, py) => {
    c.strokeStyle = 'rgba(40,30,20,0.35)';
    c.lineWidth = w + 1;
    c.beginPath();
    c.moveTo(px - dx + 1, py - dy + 1);
    c.lineTo(px + dx + 1, py + dy + 1);
    c.stroke();
    c.strokeStyle = L.rgb(col);
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(px - dx, py - dy);
    c.lineTo(px + dx, py + dy);
    c.stroke();
    h.strokeStyle = L.gray(0.7);
    h.lineWidth = w;
    h.beginPath();
    h.moveTo(px - dx, py - dy);
    h.lineTo(px + dx, py + dy);
    h.stroke();
  });
}

function leafShape(c, len, wid, kind) {
  c.beginPath();
  if (kind === 0) {
    c.ellipse(0, 0, len * 0.5, wid * 0.5, 0, 0, Math.PI * 2);
  } else if (kind === 1) {
    // 톱니 타원(느릅)
    const n = 12;
    for (let i = 0; i <= n * 2; i++) {
      const t = (i / (n * 2)) * Math.PI * 2;
      const r = i % 2 ? 0.92 : 1.0;
      const x = Math.cos(t) * len * 0.5 * r;
      const y = Math.sin(t) * wid * 0.5 * r;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
  } else {
    // 세모꼴(포플러)
    c.moveTo(-len * 0.5, 0);
    c.quadraticCurveTo(-len * 0.1, -wid * 0.75, len * 0.5, 0);
    c.quadraticCurveTo(-len * 0.1, wid * 0.75, -len * 0.5, 0);
  }
  c.closePath();
}

function drawLitter(L) {
  const { rng, c, h, size: S } = L;
  L.background([96, 74, 52], 0.1, 6, 0.3, 0.1, [80, 62, 44]);
  const pal = [
    [126, 92, 58],
    [150, 116, 74],
    [168, 138, 76],
    [92, 68, 46],
    [112, 98, 82],
    [140, 104, 52],
    [178, 152, 92],
    [104, 82, 54],
  ];
  // 잔가지
  for (let i = 0; i < 40; i++) {
    const x = rng.next() * S;
    const y = rng.next() * S;
    const len = rng.range(20, 90);
    const a = rng.range(0, Math.PI * 2);
    const w = rng.range(1.2, 3.2);
    L.wrap(x, y, len, (px, py) => {
      c.strokeStyle = 'rgba(30,22,16,0.4)';
      c.lineWidth = w + 1.5;
      c.beginPath();
      c.moveTo(px + 1, py + 1);
      c.quadraticCurveTo(px + Math.cos(a + 0.3) * len * 0.5 + 1, py + Math.sin(a + 0.3) * len * 0.5 + 1, px + Math.cos(a) * len + 1, py + Math.sin(a) * len + 1);
      c.stroke();
      c.strokeStyle = L.rgb(jitter(rng, [86, 70, 54], 0.2));
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(px, py);
      c.quadraticCurveTo(px + Math.cos(a + 0.3) * len * 0.5, py + Math.sin(a + 0.3) * len * 0.5, px + Math.cos(a) * len, py + Math.sin(a) * len);
      c.stroke();
      h.strokeStyle = L.gray(0.75);
      h.lineWidth = w;
      h.beginPath();
      h.moveTo(px, py);
      h.quadraticCurveTo(px + Math.cos(a + 0.3) * len * 0.5, py + Math.sin(a + 0.3) * len * 0.5, px + Math.cos(a) * len, py + Math.sin(a) * len);
      h.stroke();
    });
  }
  // 낙엽 여러 겹(아래 겹은 어둡고 삭음)
  for (let layer = 0; layer < 3; layer++) {
    const n = [700, 600, 420][layer];
    const dk = [0.62, 0.82, 1.0][layer];
    for (let i = 0; i < n; i++) {
      const x = rng.next() * S;
      const y = rng.next() * S;
      const len = rng.range(13, 30);
      const wid = len * rng.range(0.45, 0.75);
      const a = rng.range(0, Math.PI * 2);
      const kind = Math.floor(rng.next() * 3);
      const col = jitter(rng, pal[Math.floor(rng.next() * pal.length)], 0.1).map((v) => v * dk);
      const curl = rng.range(0.15, 0.45);
      L.wrap(x, y, len, (px, py) => {
        c.save();
        c.translate(px, py);
        c.rotate(a);
        c.save();
        c.translate(1.5, 1.8);
        leafShape(c, len, wid, kind);
        c.fillStyle = 'rgba(26,18,12,0.38)';
        c.fill();
        c.restore();
        leafShape(c, len, wid, kind);
        const g = c.createLinearGradient(0, -wid * 0.5, 0, wid * 0.5);
        g.addColorStop(0, L.rgb(col.map((v) => v * 1.08)));
        g.addColorStop(1, L.rgb(col.map((v) => v * 0.85)));
        c.fillStyle = g;
        c.fill();
        c.strokeStyle = L.rgb(col.map((v) => v * 0.7), 0.6);
        c.lineWidth = 0.8;
        c.beginPath();
        c.moveTo(-len * 0.5, 0);
        c.lineTo(len * 0.5, 0);
        c.stroke();
        c.restore();
        h.save();
        h.translate(px, py);
        h.rotate(a);
        leafShape(h, len, wid, kind);
        const hg = h.createLinearGradient(0, -wid * 0.5, 0, wid * 0.5);
        const base = 0.4 + layer * 0.13;
        hg.addColorStop(0, L.gray(base + curl));
        hg.addColorStop(0.5, L.gray(base));
        hg.addColorStop(1, L.gray(base + curl * 0.7));
        h.fillStyle = hg;
        h.fill();
        h.restore();
      });
    }
  }
}

function drawThatch(L) {
  const { rng, c, h, size: S } = L;
  L.background([92, 80, 56], 0.12, 5, 0.3, 0.1, [78, 70, 48]);
  const pal = [
    [178, 156, 108],
    [158, 140, 100],
    [136, 118, 82],
    [190, 172, 126],
    [120, 108, 80],
    [148, 140, 96],
  ];
  for (let layer = 0; layer < 3; layer++) {
    const dk = [0.6, 0.8, 1.0][layer];
    for (let i = 0; i < 1500; i++) {
      const x = rng.next() * S;
      const y = rng.next() * S;
      const len = rng.range(18, 70);
      const a = rng.range(-0.7, 0.7) + (rng.chance(0.5) ? 0 : Math.PI / 2) * 0.4 + rng.range(0, Math.PI);
      const bend = rng.range(-12, 12);
      const w = rng.range(0.8, 2.2);
      const col = jitter(rng, pal[Math.floor(rng.next() * pal.length)], 0.1).map((v) => v * dk);
      const ex = Math.cos(a) * len;
      const ey = Math.sin(a) * len;
      const mx = ex * 0.5 - Math.sin(a) * bend;
      const my = ey * 0.5 + Math.cos(a) * bend;
      L.wrap(x, y, len + 14, (px, py) => {
        c.strokeStyle = 'rgba(30,24,14,0.3)';
        c.lineWidth = w + 1.2;
        c.beginPath();
        c.moveTo(px + 1, py + 1);
        c.quadraticCurveTo(px + mx + 1, py + my + 1, px + ex + 1, py + ey + 1);
        c.stroke();
        c.strokeStyle = L.rgb(col);
        c.lineWidth = w;
        c.beginPath();
        c.moveTo(px, py);
        c.quadraticCurveTo(px + mx, py + my, px + ex, py + ey);
        c.stroke();
        h.strokeStyle = L.gray(0.42 + layer * 0.16);
        h.lineWidth = w;
        h.beginPath();
        h.moveTo(px, py);
        h.quadraticCurveTo(px + mx, py + my, px + ex, py + ey);
        h.stroke();
      });
    }
  }
}

function drawStubble(L) {
  // 1 m 타일에 수확 줄 6개(줄 간격 16.7 cm), 줄은 타일의 x축 방향으로 놓인다
  const { rng, c, h, size: S } = L;
  L.background([118, 98, 72], 0.1, 4, 0.35, 0.08, [104, 88, 66]);
  const rows = 6;
  const pitch = S / rows;
  // 줄 사이 짚 부스러기(줄 방향으로 누움)
  for (let i = 0; i < 1100; i++) {
    const x = rng.next() * S;
    const y = rng.next() * S;
    straw(L, x, y, rng.range(6, 30), rng.range(-0.35, 0.35) + (rng.chance(0.15) ? rng.range(0, Math.PI) : 0), jitter(rng, [196, 176, 124], 0.12), rng.range(0.8, 1.8));
  }
  // 그루터기: 줄을 따라 2~4 cm 간격, 잘린 줄기 단면(밝은 테두리 + 어두운 속)
  for (let r = 0; r < rows; r++) {
    const y0 = (r + 0.5) * pitch;
    let x = rng.range(0, 6);
    while (x < S) {
      const y = y0 + rng.gauss() * pitch * 0.09;
      const rad = rng.range(1.6, 2.6);
      const col = jitter(rng, [206, 186, 132], 0.08);
      L.wrap(x, y, rad + 4, (px, py) => {
        c.fillStyle = 'rgba(40,30,18,0.45)';
        c.beginPath();
        c.ellipse(px + 2.4, py + 1.4, rad * 1.4, rad, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = L.rgb(col);
        c.beginPath();
        c.arc(px, py, rad, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = 'rgba(100,84,56,0.9)';
        c.beginPath();
        c.arc(px, py, rad * 0.45, 0, Math.PI * 2);
        c.fill();
        h.fillStyle = L.gray(0.95);
        h.beginPath();
        h.arc(px, py, rad, 0, Math.PI * 2);
        h.fill();
      });
      x += rng.range(5, 13);
    }
  }
}

function drawMoss(L) {
  const { rng, c, h, size: S } = L;
  L.background([70, 78, 40], 0.16, 6, 0.4, 0.12, [86, 84, 46]);
  const pal = [
    [88, 100, 50],
    [104, 112, 56],
    [70, 82, 40],
    [130, 124, 72],
    [150, 138, 84],
  ];
  for (let i = 0; i < 4200; i++) {
    const x = rng.next() * S;
    const y = rng.next() * S;
    const len = rng.range(5, 18);
    const a = rng.range(0, Math.PI * 2);
    const col = jitter(rng, pal[Math.floor(rng.next() * pal.length)], 0.1);
    L.wrap(x, y, len, (px, py) => {
      c.strokeStyle = L.rgb(col, 0.9);
      c.lineWidth = rng.range(0.8, 1.6);
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
      c.stroke();
      h.strokeStyle = L.gray(0.55 + rng.next() * 0.3, 0.8);
      h.lineWidth = 1.2;
      h.beginPath();
      h.moveTo(px, py);
      h.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
      h.stroke();
    });
  }
}

function drawMud(L) {
  // 마른 웅덩이 자리: 보로노이 판 + 갈라진 틈(가장자리가 살짝 말려 올라감)
  const { rng, c, h, size: S } = L;
  L.background([142, 128, 108], 0.06, 4, 0.6, 0.05, [132, 118, 98]);
  const N = 90;
  const pts = [];
  for (let i = 0; i < N; i++) pts.push([rng.next() * S, rng.next() * S]);
  const ci = c.getImageData(0, 0, S, S);
  const hi = h.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = 1e9;
      let d2 = 1e9;
      for (const [px, py] of pts) {
        let dx = Math.abs(x - px);
        let dy = Math.abs(y - py);
        if (dx > S / 2) dx = S - dx;
        if (dy > S / 2) dy = S - dy;
        const d = dx * dx + dy * dy;
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) d2 = d;
      }
      const e = Math.sqrt(d2) - Math.sqrt(d1);
      const crack = 1 - Math.min(1, e / 3.2);
      const curl = Math.max(0, 1 - e / 14) * 0.25;
      const i = (y * S + x) * 4;
      const k = 1 - crack * 0.62 + curl * 0.15;
      ci.data[i] *= k;
      ci.data[i + 1] *= k;
      ci.data[i + 2] *= k * 0.96;
      const hv = Math.max(0, Math.min(255, (0.62 - crack * 0.5 + curl) * 255));
      hi.data[i] = hi.data[i + 1] = hi.data[i + 2] = hv;
    }
  }
  c.putImageData(ci, 0, 0);
  h.putImageData(hi, 0, 0);
}

function drawRoad(L) {
  drawSoil(L, [148, 130, 106], [104, 90, 72], 300);
  const { rng, c, size: S } = L;
  // 바퀴에 다져진 미세한 줄
  for (let i = 0; i < 120; i++) {
    const y = rng.next() * S;
    c.strokeStyle = `rgba(90,78,62,${rng.range(0.05, 0.14)})`;
    c.lineWidth = rng.range(1, 3);
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(S, y + rng.range(-3, 3));
    c.stroke();
  }
}

// ---------------------------------------------------------------------------
export function makeGroundTextures(size = 512) {
  const layers = [];
  const L0 = new Layer(size, 11);
  drawSoil(L0, [138, 112, 84], [92, 74, 56], 160);
  layers.push(L0);
  const L1 = new Layer(size, 23);
  drawClods(L1);
  layers.push(L1);
  const L2 = new Layer(size, 37);
  drawLitter(L2);
  layers.push(L2);
  const L3 = new Layer(size, 41);
  drawThatch(L3);
  layers.push(L3);
  const L4 = new Layer(size, 53);
  drawStubble(L4);
  layers.push(L4);
  const L5 = new Layer(size, 67);
  drawMoss(L5);
  layers.push(L5);
  const L6 = new Layer(size, 71);
  drawMud(L6);
  layers.push(L6);
  const L7 = new Layer(size, 83);
  drawRoad(L7);
  layers.push(L7);

  const n = layers.length;
  const S = size;
  const alb = new Uint8Array(S * S * 4 * n);
  const nrm = new Uint8Array(S * S * 4 * n);
  const hbuf = new Float32Array(S * S);
  for (let l = 0; l < n; l++) {
    const cd = layers[l].c.getImageData(0, 0, S, S).data;
    const hd = layers[l].h.getImageData(0, 0, S, S).data;
    const off = l * S * S * 4;
    for (let i = 0; i < S * S; i++) {
      alb[off + i * 4] = cd[i * 4];
      alb[off + i * 4 + 1] = cd[i * 4 + 1];
      alb[off + i * 4 + 2] = cd[i * 4 + 2];
      alb[off + i * 4 + 3] = hd[i * 4];
      hbuf[i] = hd[i * 4] / 255;
    }
    // 법선(소벨, 감싸기) + 틈새 그늘(주변보다 낮은 곳)
    const strength = [3.0, 4.0, 3.2, 3.0, 3.2, 2.5, 3.5, 2.5][l];
    for (let y = 0; y < S; y++) {
      const ym = ((y - 1 + S) % S) * S;
      const y0 = y * S;
      const yp = ((y + 1) % S) * S;
      for (let x = 0; x < S; x++) {
        const xm = (x - 1 + S) % S;
        const xp = (x + 1) % S;
        const gx = hbuf[ym + xp] + 2 * hbuf[y0 + xp] + hbuf[yp + xp] - hbuf[ym + xm] - 2 * hbuf[y0 + xm] - hbuf[yp + xm];
        const gy = hbuf[yp + xm] + 2 * hbuf[yp + x] + hbuf[yp + xp] - hbuf[ym + xm] - 2 * hbuf[ym + x] - hbuf[ym + xp];
        let nx = -gx * strength;
        let ny = -gy * strength;
        const nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        const avg = (hbuf[ym + x] + hbuf[yp + x] + hbuf[y0 + xm] + hbuf[y0 + xp]) * 0.25;
        const cav = Math.max(0, Math.min(1, 1 - (avg - hbuf[y0 + x]) * 4));
        const i = off + (y0 + x) * 4;
        nrm[i] = (nx * 0.5 + 0.5) * 255;
        nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
        nrm[i + 2] = cav * 255;
        nrm[i + 3] = 255;
      }
    }
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, S, S, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(alb, true), normal: mk(nrm, false), count: n };
}
