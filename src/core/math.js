export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a, b, x) => {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// 프레임 독립 지수 감쇠 보간
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** 구간별 선형 보간 표: [[x,y],...] */
export function interpTable(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** 2차 감쇠 스프링(질량 1): x'' = -k x - c x' */
export class Spring {
  constructor(freqHz = 3, damping = 0.7) {
    this.x = 0;
    this.v = 0;
    this.set(freqHz, damping);
  }
  set(freqHz, damping) {
    const w = 2 * Math.PI * freqHz;
    this.k = w * w;
    this.c = 2 * damping * w;
  }
  impulse(dv) {
    this.v += dv;
  }
  update(dt, target = 0) {
    // 반암시적 오일러, 큰 dt에서 안정하도록 분할
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - target) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}
