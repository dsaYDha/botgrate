// 길찾기: 2 m 격자 A*. 칸 비용 = 지형·식생(밭 종류, 덤불, 해바라기) + 위협 비용(아는 적 위치에서 보이는 열린 칸).
//   위협 노출: 위협 추정 위치에서 그 칸까지 2차원 시선이 숲띠(수관·덤불 지도)를 6 m 넘게 지나면 가려진 것으로 본다.
//   은폐(수관·덤불·해바라기·배수로) 칸은 노출되어도 덜 비싸다.
// 요청은 큐에 넣고 프레임마다 정해진 수의 노드만 펼쳐 여러 프레임에 나눠 계산한다.

const CELL = 2;
const SQ2 = Math.SQRT2;

class MinHeap {
  constructor(cap) {
    this.k = new Float32Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  clear() {
    this.n = 0;
  }
  push(key, val) {
    if (this.n >= this.k.length) {
      const k2 = new Float32Array(this.k.length * 2);
      k2.set(this.k);
      const v2 = new Int32Array(this.v.length * 2);
      v2.set(this.v);
      this.k = k2;
      this.v = v2;
    }
    let i = this.n++;
    const K = this.k;
    const V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = key;
    V[i] = val;
  }
  pop() {
    const K = this.k;
    const V = this.v;
    const top = V[0];
    const lastK = K[--this.n];
    const lastV = V[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && K[c + 1] < K[c]) c++;
      if (K[c] >= lastK) break;
      K[i] = K[c];
      V[i] = V[c];
      i = c;
    }
    K[i] = lastK;
    V[i] = lastV;
    return top;
  }
}

export class NavGrid {
  constructor(world) {
    this.world = world;
    this.half = world.data.playHalf + 40;
    this.N = Math.ceil((2 * this.half) / CELL);
    const N = this.N;
    this.cost = new Float32Array(N * N);
    this.conceal = new Uint8Array(N * N); // 0~255 은폐
    this.belt = new Uint8Array(N * N); // 숲띠(시선 차단) 여부
    const t0 = performance.now();
    this._build();
    this.buildMs = performance.now() - t0;
    this.g = new Float32Array(N * N);
    this.from = new Int32Array(N * N);
    this.stamp = new Uint32Array(N * N);
    this.closed = new Uint32Array(N * N);
    this.curStamp = 0;
    this.heap = new MinHeap(1 << 16);
    this.queue = [];
    this.active = null;
    this.budget = 4000; // 프레임당 펼칠 노드 수(약 1 ms)
    this._exp = new Map();
    this.stats = { solved: 0, expanded: 0 };
  }

  _build() {
    const w = this.world;
    const T = w.terrain;
    const N = this.N;
    const c = w.canopy;
    const surfCost = [1.0, 1.25, 1.15, 1.1, 1.0, 0.9, 1.6]; // 그루터기, 흙밭, 휴경지, 숲, 풀, 흙길, 해바라기
    for (let j = 0; j < N; j++) {
      const z = -this.half + (j + 0.5) * CELL;
      for (let i = 0; i < N; i++) {
        const x = -this.half + (i + 0.5) * CELL;
        const k = j * N + i;
        const sw = T.surfaceWeights(x, z);
        let sc = 0;
        for (let q = 0; q < 7; q++) sc += sw[q] * surfCost[q];
        // 수관·덤불(수관 지도 R·G)
        const ci = Math.min(c.N - 1, Math.max(0, Math.floor((x + c.half) / c.res)));
        const cj = Math.min(c.N - 1, Math.max(0, Math.floor((z + c.half) / c.res)));
        const crown = c.data[(cj * c.N + ci) * 4] / 255;
        const shrub = c.data[(cj * c.N + ci) * 4 + 1] / 255;
        sc += shrub * 1.6;
        this.cost[k] = Math.max(0.8, sc);
        let conc = Math.max(crown * 0.9, shrub, sw[6] * 0.85);
        // 배수로(지면이 주변보다 낮다)
        const h = T.macroHeightAt(x, z);
        const hn = (T.macroHeightAt(x + 3, z) + T.macroHeightAt(x - 3, z) + T.macroHeightAt(x, z + 3) + T.macroHeightAt(x, z - 3)) / 4;
        if (hn - h > 0.3) conc = Math.max(conc, 0.7);
        this.conceal[k] = Math.round(Math.min(1, conc) * 255);
        this.belt[k] = crown > 0.35 || shrub > 0.5 ? 1 : 0;
      }
    }
  }

  idx(x, z) {
    const i = Math.floor((x + this.half) / CELL);
    const j = Math.floor((z + this.half) / CELL);
    if (i < 0 || j < 0 || i >= this.N || j >= this.N) return -1;
    return j * this.N + i;
  }

  cx(k) {
    return -this.half + ((k % this.N) + 0.5) * CELL;
  }
  cz(k) {
    return -this.half + (Math.floor(k / this.N) + 0.5) * CELL;
  }

  /** 위협(tx,tz)에서 칸까지 2차원 시선이 숲띠를 얼마나 지나는가 → 노출 0~1 (8 m 단위 기억) */
  exposure(k, threat) {
    if (!threat) return 0;
    const x = this.cx(k);
    const z = this.cz(k);
    const d = Math.hypot(x - threat.x, z - threat.z);
    if (d > 650) return 0;
    const key = (Math.floor((x + this.half) / 8) << 10) | Math.floor((z + this.half) / 8);
    let e = this._exp.get(key);
    if (e === undefined) {
      // 시선 따라 2 m마다. 위협 바로 앞 10 m는 뺀다(숲 가장자리에서 밖을 내다보며 쏘는 자리)
      const n = Math.ceil(d / CELL);
      let blocked = 0;
      for (let s = Math.ceil(10 / CELL); s < n - 1; s++) {
        const t = s / n;
        const kk = this.idx(threat.x + (x - threat.x) * t, threat.z + (z - threat.z) * t);
        if (kk >= 0 && this.belt[kk]) blocked += CELL;
        if (blocked > 6) break;
      }
      e = blocked > 6 ? 0 : Math.max(0.15, 1 - d / 650);
      this._exp.set(key, e);
    }
    return e * (1 - this.conceal[k] / 255);
  }

  /**
   * 길 요청: 끝나면 cb(path[[x,z],...] | null). threat: {x,z} 알고 있는 위협 위치(노출 비용), w: 노출 가중
   */
  request(from, to, threat, cb, o = {}) {
    const req = { from, to, threat, cb, w: o.exposureWeight ?? 6, maxNodes: o.maxNodes ?? 40000, owner: o.owner };
    this.queue.push(req);
    return req;
  }

  cancel(owner) {
    this.queue = this.queue.filter((r) => r.owner !== owner);
    if (this.active && this.active.req.owner === owner) this.active.cancelled = true;
  }

  update() {
    let budget = this.budget;
    while (budget > 0) {
      if (!this.active) {
        const req = this.queue.shift();
        if (!req) return;
        this._start(req);
        if (!this.active) continue;
      }
      budget = this._step(budget);
    }
  }

  _start(req) {
    const s = this.idx(req.from[0], req.from[1]);
    const t = this.idx(req.to[0], req.to[1]);
    if (s < 0 || t < 0) {
      req.cb(null);
      return;
    }
    if (this._threatKey !== (req.threat ? `${Math.round(req.threat.x / 8)},${Math.round(req.threat.z / 8)}` : '')) {
      this._threatKey = req.threat ? `${Math.round(req.threat.x / 8)},${Math.round(req.threat.z / 8)}` : '';
      this._exp.clear();
    }
    this.curStamp++;
    this.heap.clear();
    this.g[s] = 0;
    this.from[s] = -1;
    this.stamp[s] = this.curStamp;
    this.heap.push(this._h(s, t), s);
    this.active = { req, s, t, expanded: 0, best: s, bestH: Infinity };
  }

  _h(k, t) {
    const dx = Math.abs((k % this.N) - (t % this.N));
    const dz = Math.abs(Math.floor(k / this.N) - Math.floor(t / this.N));
    return (Math.max(dx, dz) + (SQ2 - 1) * Math.min(dx, dz)) * CELL * 0.85;
  }

  _step(budget) {
    const A = this.active;
    const { req, t } = A;
    const N = this.N;
    const H = this.heap;
    const stamp = this.curStamp;
    while (budget-- > 0) {
      if (A.cancelled || H.n === 0 || A.expanded > req.maxNodes) {
        this.active = null;
        if (!A.cancelled) {
          if (A.expanded > req.maxNodes) {
            const p = this._path(A.best, req, true);
            p.partial = true;
            req.cb(p);
          } else req.cb(null);
        }
        return budget;
      }
      const k = H.pop();
      if (this.closed[k] === stamp) continue;
      this.closed[k] = stamp;
      A.expanded++;
      this.stats.expanded++;
      if (k === t) {
        this.active = null;
        this.stats.solved++;
        req.cb(this._path(k, req));
        return budget;
      }
      const hk = this._h(k, t);
      if (hk < A.bestH) {
        A.bestH = hk;
        A.best = k;
      }
      const i = k % N;
      const j = (k - i) / N;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= N) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di;
          if (ii < 0 || ii >= N) continue;
          const n = jj * N + ii;
          if (this.closed[n] === stamp) continue;
          const step = di && dj ? SQ2 * CELL : CELL;
          const c = this.cost[n] + req.w * this.exposure(n, req.threat);
          const g = this.g[k] + step * c;
          if (this.stamp[n] !== stamp || g < this.g[n]) {
            this.stamp[n] = stamp;
            this.g[n] = g;
            this.from[n] = k;
            H.push(g + this._h(n, t), n);
          }
        }
      }
    }
    return 0;
  }

  _path(k, req, partial = false) {
    const pts = [];
    let c = k;
    let guard = 0;
    while (c >= 0 && guard++ < 100000) {
      pts.push(c);
      c = this.from[c];
    }
    pts.reverse();
    // 4칸마다 + 끝점(국소 회피가 줄기를 비켜 간다)
    const out = [];
    for (let q = 0; q < pts.length; q += 4) out.push([this.cx(pts[q]), this.cz(pts[q])]);
    if (!partial) out.push([req.to[0], req.to[1]]);
    return out;
  }

  /** 디버그: 경로의 노출 길이(m) */
  exposedLength(path, threat) {
    let L = 0;
    for (let q = 1; q < path.length; q++) {
      const k = this.idx(path[q][0], path[q][1]);
      if (k >= 0 && this.exposure(k, threat) > 0.3) L += Math.hypot(path[q][0] - path[q - 1][0], path[q][1] - path[q - 1][1]);
    }
    return L;
  }
}
