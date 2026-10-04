// 시드 고정 난수(mulberry32). 월드 생성이 매번 같도록.
export class Random {
  constructor(seed = 1) {
    this.s = seed >>> 0;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p) {
    return this.next() < p;
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  // 표준정규분포 (Box-Muller)
  gauss() {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // 가중치 객체 {a:0.5, b:0.3} 에서 키 선택
  weighted(obj) {
    let total = 0;
    for (const k in obj) total += obj[k];
    let r = this.next() * total;
    for (const k in obj) {
      r -= obj[k];
      if (r <= 0) return k;
    }
    return Object.keys(obj)[0];
  }
}

// 런타임용 공용 난수(시드 무관)
export const rng = new Random((Date.now() ^ 0x5bd1e995) >>> 0);
