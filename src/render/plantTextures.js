// 풀·잡초·그루터기·해바라기 카드 아틀라스(런타임 절차 생성, 9월 말 초원 농경지).
// 칸 256×512(폭×높이, 밑 = 땅), 8열 × 2행. RGB = sRGB 색, A = 덮임. 색은 실제 반사율에 가깝게(어둡게) 칠하고
// 셰이더가 인스턴스마다 마름 정도·밝기를 조금씩 바꾼다.

import * as THREE from 'three';
import { Random } from '../core/Random.js';
import { dilateColors } from './treeTextures.js';

export const PLANT_TILES = {
  grassGreen: 0,
  grassDry: 1,
  wormwood: 2,
  thistle: 3,
  burdock: 4,
  nettle: 5,
  stubble: 6,
  sunflower: 7,
  grassMixed: 8,
  grassTall: 9,
  wormwood2: 10,
  thistle2: 11,
  burdock2: 12,
  tansy: 13,
  stubble2: 14,
  sunflower2: 15,
};
export const PLANT_TILE_W = 256;
export const PLANT_TILE_H = 512;

const rgb = (r, g, b, k = 1) => `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
function lerpC(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const C = {
  green: [74, 92, 42],
  greenDark: [50, 68, 30],
  yellowing: [150, 138, 74],
  straw: [184, 164, 108],
  strawPale: [205, 190, 140],
  brown: [112, 88, 56],
  wormLeaf: [132, 142, 116],
  wormStem: [118, 106, 78],
  thistleLeaf: [76, 90, 58],
  pappus: [222, 218, 206],
  purple: [118, 66, 104],
  burdockLeaf: [66, 84, 44],
  burr: [96, 72, 44],
  nettle: [44, 66, 30],
  sunStalk: [128, 108, 70],
  sunLeafDry: [104, 80, 48],
  sunHead: [86, 66, 42],
  seed: [40, 32, 24],
  tansy: [150, 120, 50],
};

class Tile {
  constructor(ctx, ox, oy, rng) {
    this.c = ctx;
    this.ox = ox;
    this.oy = oy;
    this.rng = rng;
    this.W = PLANT_TILE_W;
    this.H = PLANT_TILE_H;
  }
  X(x) {
    return this.ox + x;
  }
  Y(y) {
    return this.oy + y;
  }
  /** 풀잎: 밑(x0, 바닥)에서 위로 len, 끝이 lean만큼 휘어짐 */
  blade(x0, y0, len, w, lean, col) {
    const c = this.c;
    const tipX = x0 + lean;
    const tipY = y0 - len;
    const mx = x0 + lean * 0.25;
    const my = y0 - len * 0.55;
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(this.X(x0 - w / 2), this.Y(y0));
    c.quadraticCurveTo(this.X(mx - w * 0.35), this.Y(my), this.X(tipX), this.Y(tipY));
    c.quadraticCurveTo(this.X(mx + w * 0.35), this.Y(my), this.X(x0 + w / 2), this.Y(y0));
    c.closePath();
    c.fill();
  }
  stem(pts, w, col) {
    const c = this.c;
    c.strokeStyle = col;
    c.lineWidth = w;
    c.lineCap = 'round';
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(this.X(x), this.Y(y)) : c.moveTo(this.X(x), this.Y(y))));
    c.stroke();
  }
  /** 잎(타원·피침형·톱니) */
  leaf(x, y, ang, L, W, col, kind = 'lance') {
    const c = this.c;
    c.save();
    c.translate(this.X(x), this.Y(y));
    c.rotate(ang);
    c.fillStyle = col;
    c.beginPath();
    if (kind === 'lobed') {
      const n = 7;
      c.moveTo(0, 0);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const w = W * 0.5 * Math.sin(Math.PI * t) * (i % 2 ? 1.25 : 0.55);
        c.lineTo(w, -L * t);
      }
      for (let i = n - 1; i >= 0; i--) {
        const t = i / n;
        const w = W * 0.5 * Math.sin(Math.PI * t) * (i % 2 ? 1.25 : 0.55);
        c.lineTo(-w, -L * t);
      }
    } else if (kind === 'cordate') {
      c.moveTo(0, 0);
      c.bezierCurveTo(W * 0.7, L * 0.15, W * 0.6, -L * 0.75, 0, -L);
      c.bezierCurveTo(-W * 0.6, -L * 0.75, -W * 0.7, L * 0.15, 0, 0);
    } else if (kind === 'serrate') {
      const n = 12;
      c.moveTo(0, 0);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        c.lineTo(W * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (i % 2 ? 1.1 : 0.9), -L * t);
      }
      for (let i = n - 1; i >= 0; i--) {
        const t = i / n;
        c.lineTo(-W * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (i % 2 ? 1.1 : 0.9), -L * t);
      }
    } else {
      c.moveTo(0, 0);
      c.quadraticCurveTo(W * 0.6, -L * 0.4, 0, -L);
      c.quadraticCurveTo(-W * 0.6, -L * 0.4, 0, 0);
    }
    c.closePath();
    c.fill();
    c.restore();
  }
  dot(x, y, r, col) {
    const c = this.c;
    c.fillStyle = col;
    c.beginPath();
    c.arc(this.X(x), this.Y(y), r, 0, Math.PI * 2);
    c.fill();
  }
  ellipse(x, y, rx, ry, a, col) {
    const c = this.c;
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(this.X(x), this.Y(y), rx, ry, a, 0, Math.PI * 2);
    c.fill();
  }
  /** 볏과 이삭(원추꽃차례): 휜 축을 따라 작은 이삭이 달림 */
  panicle(x, y, len, lean, col, spread = 1) {
    const rng = this.rng;
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push([x + lean * t * t, y - len * t]);
    }
    this.stem(pts, 1.2, col);
    for (let i = 2; i <= 8; i++) {
      const [px, py] = pts[i];
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const a = rng.range(-1.3, 1.3) * spread;
        const l = rng.range(8, 22) * (1 - i / 12);
        const ex = px + Math.sin(a) * l;
        const ey = py - Math.cos(a) * l * 0.6;
        this.stem([[px, py], [ex, ey]], 0.8, col);
        this.ellipse(ex, ey, 1.6, 3.4, a, col);
      }
    }
  }
}

// ---------------------------------------------------------------------------
function grassTuft(T, rng, { n, hMin, hMax, dryness, heads, wMax = 5, tall = false }) {
  const W = T.W;
  const H = T.H;
  for (let i = 0; i < n; i++) {
    const x0 = W * 0.5 + rng.gauss() * W * 0.1;
    const len = H * rng.range(hMin, hMax);
    const lean = rng.gauss() * W * 0.18;
    const d = Math.min(1, Math.max(0, dryness + rng.gauss() * 0.25));
    const col = d < 0.5 ? lerpC(C.green, C.yellowing, d * 2) : lerpC(C.yellowing, rng.chance(0.3) ? C.brown : C.straw, (d - 0.5) * 2);
    const k = rng.range(0.8, 1.15);
    T.blade(x0, H, len, rng.range(2.5, wMax), lean, rgb(...col, k));
  }
  for (let i = 0; i < heads; i++) {
    const x0 = W * 0.5 + rng.gauss() * W * 0.08;
    const len = H * rng.range(tall ? 0.75 : 0.6, 0.98);
    const lean = rng.gauss() * W * 0.15;
    const stemTop = [x0 + lean * 0.8, H - len * 0.72];
    T.stem([[x0, H], [x0 + lean * 0.3, H - len * 0.4], stemTop], 1.4, rgb(...C.straw, rng.range(0.85, 1.05)));
    const pc = rng.chance(0.25) ? lerpC(C.straw, C.purple, 0.25) : C.strawPale;
    T.panicle(stemTop[0], stemTop[1], len * 0.28, lean * 0.2, rgb(...pc, rng.range(0.85, 1.05)), tall ? 0.6 : 1);
  }
}

function wormwood(T, rng, tall) {
  const W = T.W;
  const H = T.H;
  const nStem = rng.int(4, 7);
  for (let s = 0; s < nStem; s++) {
    const x0 = W * 0.5 + rng.gauss() * W * 0.07;
    const len = H * rng.range(0.7, 0.98);
    const lean = rng.gauss() * W * 0.12;
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push([x0 + lean * (i / 8) ** 1.5, H - len * (i / 8)]);
    T.stem(pts, 2.4, rgb(...C.wormStem));
    // 깃꼴로 잘게 갈라진 회녹색 잎(아래 크고 위로 작게) + 위쪽 작은 꽃송이(마른 노란 갈색)
    for (let i = 1; i <= 8; i++) {
      const [px, py] = pts[i];
      const sz = (1 - i / 10) * rng.range(18, 30);
      for (const side of [-1, 1]) {
        const a = side * rng.range(0.7, 1.3);
        for (let f = 0; f < 4; f++) T.leaf(px, py, a + rng.range(-0.5, 0.5), sz * rng.range(0.5, 1), sz * 0.22, rgb(...C.wormLeaf, rng.range(0.85, 1.1)), 'lance');
      }
      if (i >= (tall ? 4 : 5)) {
        for (let k = 0; k < 8; k++) T.dot(px + rng.range(-16, 16), py + rng.range(-10, 6), rng.range(1.0, 1.7), rgb(...lerpC(C.tansy, C.brown, rng.next() * 0.6)));
      }
    }
  }
}

function thistle(T, rng, pappus) {
  const W = T.W;
  const H = T.H;
  // 바닥 근처 가시 돋친 잎
  for (let i = 0; i < 9; i++) {
    const a = rng.range(-1.4, 1.4);
    T.leaf(W * 0.5 + rng.gauss() * 10, H, a, rng.range(60, 110), rng.range(26, 40), rgb(...lerpC(C.thistleLeaf, C.brown, rng.next() * 0.45)), 'lobed');
  }
  const nStem = rng.int(2, 4);
  for (let s = 0; s < nStem; s++) {
    const x0 = W * 0.5 + rng.gauss() * W * 0.06;
    const len = H * rng.range(0.65, 0.95);
    const lean = rng.gauss() * W * 0.1;
    const top = [x0 + lean, H - len];
    T.stem([[x0, H], [x0 + lean * 0.5, H - len * 0.5], top], 3, rgb(...lerpC(C.thistleLeaf, C.straw, 0.4)));
    for (let i = 1; i < 5; i++) {
      const t = i / 6;
      const px = x0 + lean * t;
      const py = H - len * t;
      T.leaf(px, py, (i % 2 ? 1 : -1) * rng.range(0.6, 1.1), rng.range(34, 52) * (1 - t * 0.5), 18, rgb(...lerpC(C.thistleLeaf, C.brown, rng.next() * 0.5)), 'lobed');
    }
    // 꽃송이: 가시 돋친 작은 총포 + (흰 갓털 실 / 보랏빛 꽃술 / 마른 갈색)
    const nh = rng.int(1, 3);
    for (let h = 0; h < nh; h++) {
      const hx = top[0] + rng.range(-18, 18);
      const hy = top[1] + rng.range(0, 30);
      T.stem([[top[0], top[1] + 20], [hx, hy]], 1.6, rgb(...C.straw, 0.9));
      T.ellipse(hx, hy, 5.5, 6.5, 0, rgb(...C.burr, rng.range(0.8, 1.05)));
      for (let k = 0; k < 9; k++) {
        const a = rng.range(-Math.PI, Math.PI);
        T.stem([[hx, hy], [hx + Math.cos(a) * 8, hy + Math.sin(a) * 8]], 0.8, rgb(...C.straw, 0.75));
      }
      const mode = pappus ? (rng.chance(0.55) ? 1 : 0) : rng.chance(0.18) ? 1 : rng.chance(0.4) ? 2 : 0;
      if (mode === 1) {
        // 씨앗이 익어 터진 갓털: 가는 흰 실이 부채꼴로
        for (let k = 0; k < 28; k++) {
          const a = -Math.PI / 2 + rng.range(-1.25, 1.25);
          const l = rng.range(7, 15);
          T.stem([[hx, hy - 4], [hx + Math.cos(a) * l, hy - 4 + Math.sin(a) * l]], 0.7, `rgba(${C.pappus.join(',')},0.7)`);
        }
      } else if (mode === 2) {
        for (let k = 0; k < 14; k++) {
          const a = -Math.PI / 2 + rng.range(-0.6, 0.6);
          const l = rng.range(4, 8);
          T.stem([[hx, hy - 4], [hx + Math.cos(a) * l, hy - 4 + Math.sin(a) * l]], 1.1, rgb(...C.purple, rng.range(0.7, 0.95)));
        }
      }
    }
  }
}

function burdock(T, rng, tallStem) {
  const W = T.W;
  const H = T.H;
  // 큰 염통 모양 잎(9월 말: 벌레 먹고 찢기고 가장자리부터 누렇게·갈색으로)
  for (let i = 0; i < 6; i++) {
    const a = rng.range(-1.3, 1.3);
    const col = lerpC(C.burdockLeaf, rng.chance(0.45) ? C.brown : C.yellowing, rng.range(0.2, 0.7));
    const lx = W * 0.5 + rng.gauss() * 14;
    const ly = H - rng.range(0, 30);
    const L = rng.range(110, 170);
    T.leaf(lx, ly, a, L, rng.range(90, 130), rgb(...col), 'cordate');
    // 잎맥(밝은 줄)
    T.stem([[lx, ly], [lx + Math.sin(a) * L * 0.9, ly - Math.cos(a) * L * 0.9]], 1.6, rgb(...lerpC(col, C.straw, 0.5)));
    // 벌레 먹은 구멍(불규칙한 모양) + 가장자리 뜯김
    const c = T.c;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    const blob = (bx, by, r) => {
      const n = rng.int(5, 8);
      c.beginPath();
      for (let k = 0; k < n; k++) {
        const q = (k / n) * Math.PI * 2;
        const rr = r * rng.range(0.45, 1.15);
        c[k ? 'lineTo' : 'moveTo'](T.X(bx + Math.cos(q) * rr * 1.3), T.Y(by + Math.sin(q) * rr));
      }
      c.closePath();
      c.fill();
    };
    for (let k = 0; k < 4; k++) {
      const t = rng.range(0.2, 0.9);
      blob(lx + Math.sin(a) * L * t + rng.range(-28, 28), ly - Math.cos(a) * L * t + rng.range(-18, 18), rng.range(2.5, 7));
    }
    for (let k = 0; k < 3; k++) {
      const t = rng.range(0.35, 0.95);
      const side = rng.chance(0.5) ? 1 : -1;
      const w = rng.range(30, 50);
      blob(lx + Math.sin(a) * L * t + Math.cos(a) * w * side, ly - Math.cos(a) * L * t + Math.sin(a) * w * side, rng.range(6, 12));
    }
    c.restore();
  }
  if (tallStem || rng.chance(0.6)) {
    const len = H * rng.range(0.75, 0.95);
    const x0 = W * 0.5;
    const pts = [
      [x0, H],
      [x0 + rng.range(-10, 10), H - len * 0.5],
      [x0 + rng.range(-20, 20), H - len],
    ];
    T.stem(pts, 4, rgb(104, 72, 50));
    for (let b = 0; b < 4; b++) {
      const bx = pts[2][0] + rng.range(-60, 60);
      const by = pts[2][1] + rng.range(0, 90);
      T.stem([[pts[1][0], pts[1][1] - 40], [bx, by]], 2, rgb(104, 72, 50));
      for (let k = 0; k < 5; k++) burr(T, rng, bx + rng.range(-14, 14), by + rng.range(-10, 10), rng.range(3, 4.2));
    }
  }
}

// 우엉 열매(가시 공): 마른 갈색 몸통 + 끝이 갈고리진 총포 조각이 사방으로(끝은 바랜 짚색)
function burr(T, rng, x, y, r) {
  const k = rng.range(0.8, 1.1);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rng.range(-0.15, 0.15);
    const l = r * rng.range(1.6, 2.2);
    const ex = x + Math.cos(a) * l;
    const ey = y + Math.sin(a) * l;
    T.stem([[x, y], [ex, ey]], 0.9, rgb(...C.burr, k * 0.95));
    T.stem([[ex, ey], [ex + Math.cos(a + 1.6) * 1.4, ey + Math.sin(a + 1.6) * 1.4]], 0.7, rgb(...C.straw, 0.8));
  }
  T.dot(x, y, r, rgb(...C.burr, k * 0.85));
  T.dot(x - r * 0.3, y - r * 0.3, r * 0.45, rgb(...lerpC(C.burr, C.straw, 0.35), k));
}

function nettle(T, rng) {
  const W = T.W;
  const H = T.H;
  const nStem = rng.int(5, 8);
  for (let s = 0; s < nStem; s++) {
    const x0 = W * 0.5 + rng.gauss() * W * 0.12;
    const len = H * rng.range(0.6, 0.97);
    const lean = rng.gauss() * W * 0.08;
    T.stem([[x0, H], [x0 + lean, H - len]], 2.2, rgb(70, 84, 40));
    for (let i = 1; i <= 7; i++) {
      const t = i / 8;
      const px = x0 + lean * t;
      const py = H - len * t;
      const sz = rng.range(26, 40) * (1 - t * 0.45);
      for (const side of [-1, 1]) T.leaf(px, py, side * rng.range(0.8, 1.2), sz, sz * 0.55, rgb(...lerpC(C.nettle, C.yellowing, rng.next() * 0.2), rng.range(0.85, 1.1)), 'serrate');
      if (i > 3 && rng.chance(0.5)) T.stem([[px, py], [px + rng.range(-20, 20), py + rng.range(10, 30)]], 1, rgb(110, 118, 70));
    }
  }
}

function stubble(T, rng, volunteers) {
  const W = T.W;
  const H = T.H;
  // 밀 그루터기: 속 빈 짚 줄기(지름 3~4 mm — 카드 폭 0.3 m에서 약 3 화소), 포기마다 몇 줄기씩 모여 비스듬히 잘림,
  // 높이 10~20 cm(칸 높이 = 그루터기 높이). 일부는 콤바인 바퀴에 눌려 기울었다
  for (let p = 0; p < 9; p++) {
    const px = rng.range(16, W - 16);
    const n = rng.int(2, 5);
    const tilt = rng.chance(0.2) ? rng.range(-90, 90) : 0;
    for (let i = 0; i < n; i++) {
      const x0 = px + rng.range(-7, 7);
      const len = H * rng.range(0.6, 1.0) * (tilt ? 0.8 : 1);
      const lean = rng.gauss() * 10 + tilt;
      const k = rng.range(0.8, 1.1);
      T.stem([[x0, H], [x0 + lean, H - len]], rng.range(2.4, 3.4), rgb(...lerpC(C.straw, C.brown, rng.next() * 0.35), k));
      T.ellipse(x0 + lean, H - len, 2, 1.2, 0, rgb(...C.strawPale, k));
    }
  }
  // 떨어진 짚 몇 가닥(낮게 눕음)
  for (let i = 0; i < 8; i++) {
    const x0 = rng.range(0, W);
    const y0 = H - rng.range(0, 40);
    T.stem([[x0, y0], [x0 + rng.range(-90, 90), y0 - rng.range(0, 30)]], 3, rgb(...C.straw, 0.95));
  }
  if (volunteers) for (let i = 0; i < 10; i++) T.blade(rng.range(20, W - 20), H, H * rng.range(0.3, 0.75), rng.range(4, 7), rng.gauss() * 30, rgb(...C.green, rng.range(0.9, 1.2)));
}

function sunflower(T, rng, variant) {
  const W = T.W;
  const H = T.H;
  // 거두지 않은 마른 해바라기: 굵은 줄기, 고개 숙인 갈색 꽃판(뒷면이 보임), 말라 오그라든 갈색 잎
  const x0 = W * 0.5 + rng.range(-8, 8);
  const lean = rng.range(-14, 14);
  const top = [x0 + lean, H * 0.1];
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push([x0 + lean * t * t, H - (H - top[1]) * t]);
  }
  T.stem(pts, 9, rgb(...C.sunStalk));
  for (let i = 1; i <= 7; i++) {
    const t = i / 9;
    const [px, py] = pts[Math.round(t * 10)];
    const side = i % 2 ? 1 : -1;
    const dry = rng.range(0.5, 1);
    const col = lerpC(lerpC(C.greenDark, C.yellowing, 0.4), C.sunLeafDry, dry);
    // 처진 잎(잎자루 + 아래로 처진 잎몸)
    const a = side * rng.range(1.6, 2.4);
    T.leaf(px, py, a, rng.range(55, 90), rng.range(30, 50), rgb(...col, rng.range(0.85, 1.05)), 'cordate');
  }
  // 꽃판: 줄기 끝에서 아래로 굽어 땅을 봄
  const hx = top[0] + (variant ? -28 : 28);
  const hy = top[1] + 34;
  T.stem([[top[0], top[1] + 10], [top[0] + (variant ? -10 : 10), top[1] - 6], [hx, hy - 24]], 7, rgb(...C.sunStalk, 0.95));
  T.ellipse(hx, hy, 40, 30, variant ? 0.5 : -0.5, rgb(...C.sunHead));
  T.ellipse(hx, hy + 6, 34, 18, variant ? 0.5 : -0.5, rgb(...C.seed));
  // 마른 꽃잎 테두리
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2;
    T.ellipse(hx + Math.cos(a) * 40, hy + Math.sin(a) * 28, 6, 2.5, a, rgb(...C.brown, rng.range(0.8, 1.1)));
  }
}

function drawPlantTile(ctx, i, key, rng) {
  const ox = (i % 8) * PLANT_TILE_W;
  const oy = Math.floor(i / 8) * PLANT_TILE_H;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, PLANT_TILE_W, PLANT_TILE_H);
  ctx.clip();
  const T = new Tile(ctx, ox, oy, rng);
  switch (key) {
    case 'grassGreen':
      grassTuft(T, rng, { n: 70, hMin: 0.35, hMax: 0.9, dryness: 0.25, heads: 3 });
      break;
    case 'grassDry':
      grassTuft(T, rng, { n: 55, hMin: 0.3, hMax: 0.85, dryness: 0.85, heads: 9 });
      break;
    case 'grassMixed':
      grassTuft(T, rng, { n: 65, hMin: 0.3, hMax: 0.9, dryness: 0.55, heads: 6 });
      break;
    case 'grassTall':
      grassTuft(T, rng, { n: 45, hMin: 0.5, hMax: 0.95, dryness: 0.7, heads: 8, wMax: 7, tall: true });
      break;
    case 'wormwood':
      wormwood(T, rng, false);
      break;
    case 'wormwood2':
      wormwood(T, rng, true);
      break;
    case 'thistle':
      thistle(T, rng, false);
      break;
    case 'thistle2':
      thistle(T, rng, true);
      break;
    case 'burdock':
      burdock(T, rng, false);
      break;
    case 'burdock2':
      burdock(T, rng, true);
      break;
    case 'nettle':
      nettle(T, rng);
      break;
    case 'tansy':
      grassTuft(T, rng, { n: 25, hMin: 0.25, hMax: 0.6, dryness: 0.5, heads: 0 });
      for (let s = 0; s < 4; s++) {
        const x0 = PLANT_TILE_W * 0.5 + rng.gauss() * 20;
        const top = [x0 + rng.gauss() * 20, PLANT_TILE_H * rng.range(0.08, 0.25)];
        T.stem([[x0, PLANT_TILE_H], top], 2.6, rgb(96, 100, 56));
        for (let k = 0; k < 6; k++) T.leaf(x0 + (top[0] - x0) * (k / 7), PLANT_TILE_H - (PLANT_TILE_H - top[1]) * (k / 7), (k % 2 ? 1 : -1) * 1.1, 40, 18, rgb(...C.greenDark), 'lobed');
        for (let k = 0; k < 16; k++) {
          const hx = top[0] + rng.range(-24, 24);
          const hy = top[1] + rng.range(-4, 9) + Math.abs(hx - top[0]) * 0.12;
          const r = rng.range(1.8, 2.8);
          T.stem([[top[0], top[1] + 14], [hx, hy]], 0.8, rgb(96, 100, 56));
          const col = lerpC(C.tansy, C.brown, rng.next() * 0.7);
          T.dot(hx, hy, r, rgb(...col));
          T.dot(hx, hy, r * 0.45, rgb(...col, 0.7));
        }
      }
      break;
    case 'stubble':
      stubble(T, rng, false);
      break;
    case 'stubble2':
      stubble(T, rng, true);
      break;
    case 'sunflower':
      sunflower(T, rng, 0);
      break;
    case 'sunflower2':
      sunflower(T, rng, 1);
      break;
  }
  ctx.restore();
}

export function makePlantAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = PLANT_TILE_W * 8;
  canvas.height = PLANT_TILE_H * 2;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rng = new Random(6151);
  for (const [k, i] of Object.entries(PLANT_TILES)) drawPlantTile(ctx, i, k, rng);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  dilateColors(img.data, canvas.width, canvas.height);
  const tex = new THREE.DataTexture(img.data, canvas.width, canvas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** 칸 i의 uv 원점(왼쪽 위, flipY=false) */
export function plantTileUV(i) {
  return [(i % 8) / 8, Math.floor(i / 8) / 2];
}
