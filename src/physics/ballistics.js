// 질점(point-mass) 외탄도 모델. 브라우저와 Node(테스트) 양쪽에서 같은 코드를 쓴다.
//
// 가속도 = 중력 + 항력 + (선택) 코리올리. (선택) 스핀 드리프트는 Litz 경험식대로 위치 이동으로 더한다.
//   항력: a = -(π ρ / 8 BC) · Cd_ref(M) · |v_rel| · v_rel,  v_rel = v - 바람
//   BC는 lb/in² 단위 G7 탄도계수를 kg/m²로 환산해 쓴다.
// 적분: 고정 서브스텝 RK4. 바람은 스텝 시작 위치에서 한 번 평가해 스텝 동안 고정.
//
// 좌표계는 호출자가 정한다(게임: x 동, y 위, z 남). 코리올리는 그 좌표계 기준
// 지구 자전축 벡터를 받아 계산한다.

import { DRAG_TABLES } from '../data/dragTables.js';
import { ATMOSPHERE } from '../data/atmosphere.js';

export const LBIN2_TO_KGM2 = 0.45359237 / (0.0254 * 0.0254); // 703.0696
export const GRAIN_TO_KG = 6.479891e-5;
export const INCH = 0.0254;

// ---------------------------------------------------------------------------
// 항력 곡선: 표준표를 단조 3차(PCHIP) 보간으로 촘촘한 균일 격자에 미리 펼쳐 둔다.
// 런타임 조회는 균일 격자 선형 보간 한 번이라 빠르다.
// ---------------------------------------------------------------------------
function pchipSlopes(xs, ys) {
  const n = xs.length;
  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const m = new Float64Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return m;
}

export class DragCurve {
  constructor(table, step = 0.002, maxMach = 5.0) {
    const xs = table.map((p) => p[0]);
    const ys = table.map((p) => p[1]);
    const m = pchipSlopes(xs, ys);
    this.step = step;
    this.inv = 1 / step;
    this.n = Math.ceil(maxMach / step) + 2;
    this.values = new Float64Array(this.n);
    let seg = 0;
    for (let i = 0; i < this.n; i++) {
      const x = Math.min(i * step, xs[xs.length - 1]);
      while (seg < xs.length - 2 && x > xs[seg + 1]) seg++;
      const x0 = xs[seg];
      const x1 = xs[seg + 1];
      const hh = x1 - x0;
      const t = (x - x0) / hh;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      this.values[i] = h00 * ys[seg] + h10 * hh * m[seg] + h01 * ys[seg + 1] + h11 * hh * m[seg + 1];
    }
  }

  cd(mach) {
    const f = mach * this.inv;
    let i = f | 0;
    if (i < 0) return this.values[0];
    if (i >= this.n - 1) return this.values[this.n - 1];
    const t = f - i;
    return this.values[i] + (this.values[i + 1] - this.values[i]) * t;
  }
}

const curveCache = new Map();
export function getDragCurve(name) {
  let c = curveCache.get(name);
  if (!c) {
    const table = DRAG_TABLES[name];
    if (!table) throw new Error(`unknown drag table ${name}`);
    c = new DragCurve(table);
    curveCache.set(name, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// 자이로 안정도(Miller 공식)와 스핀 드리프트(Litz 경험식)
// ---------------------------------------------------------------------------
export function millerStability({ massGrains, diameterIn, lengthIn, twistIn, velocityFps = 2800 }) {
  const t = twistIn / diameterIn; // 구경 단위 강선 피치
  const l = lengthIn / diameterIn; // 구경 단위 탄두 길이
  const sg = (30 * massGrains) / (t * t * diameterIn ** 3 * l * (1 + l * l));
  return sg * Math.cbrt(velocityFps / 2800);
}

// Litz 경험식: SD[in] = 1.25 (Sg + 1.2) t^1.83.
// 측정된 최종 편차를 그대로 재현하도록 속도가 아닌 위치 이동으로 적용한다(항력 감쇠를 받지 않음).
export function spinDriftAccelCoeff(sg) {
  return 1.25 * (sg + 1.2) * INCH; // × t^1.83 [m]
}

// Litz: 공력 도약(aerodynamic jump) [MOA / (mph 횡풍)].
export function aeroJumpMoaPerMph(sg, lengthCal) {
  return 0.01 * sg - 0.0024 * lengthCal + 0.032;
}

// ---------------------------------------------------------------------------
// 탄도 모델
// ---------------------------------------------------------------------------
export class BallisticModel {
  /**
   * @param {object} o
   * @param {string} o.dragModel  'G7' | 'G1'
   * @param {number} o.bc         lb/in²
   * @param {object} [o.atmosphere]
   * @param {number[]} [o.omega]  좌표계 기준 지구 자전 각속도 벡터(rad/s). 없으면 코리올리 무시.
   * @param {number} [o.spinDriftCoeff] spinDriftAccelCoeff() 값[m/s^1.83]. 0이면 무시. 우선회 강선은 양수.
   */
  constructor({ dragModel = 'G7', bc, atmosphere = ATMOSPHERE, omega = null, spinDriftCoeff = 0 }) {
    this.curve = getDragCurve(dragModel);
    this.bc = bc;
    this.rho = atmosphere.density;
    this.c = atmosphere.speedOfSoundBallistic;
    this.g = atmosphere.gravity;
    this.invC = 1 / this.c;
    this.kDrag = (Math.PI * this.rho) / (8 * bc * LBIN2_TO_KGM2);
    this.omega = omega;
    this.spinDriftCoeff = spinDriftCoeff;
    // RK4 임시 버퍼
    this._k = new Float64Array(24);
  }

  /** 항력 감속도 계수 k(v): a = -k·v_rel (벡터). dragMul은 텀블링 등으로 늘어난 항력 배수. */
  dragK(speedRel, dragMul = 1) {
    return this.kDrag * dragMul * this.curve.cd(speedRel * this.invC) * speedRel;
  }

  // out[o..o+5] = (vx,vy,vz, ax,ay,az)
  _deriv(vx, vy, vz, t, wx, wy, wz, dragMul, out, o) {
    const rx = vx - wx;
    const ry = vy - wy;
    const rz = vz - wz;
    const sp = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const k = this.kDrag * dragMul * this.curve.cd(sp * this.invC) * sp;
    let ax = -k * rx;
    let ay = -k * ry - this.g;
    let az = -k * rz;
    const om = this.omega;
    if (om) {
      // a = -2 Ω × v
      ax -= 2 * (om[1] * vz - om[2] * vy);
      ay -= 2 * (om[2] * vx - om[0] * vz);
      az -= 2 * (om[0] * vy - om[1] * vx);
    }
    out[o] = vx;
    out[o + 1] = vy;
    out[o + 2] = vz;
    out[o + 3] = ax;
    out[o + 4] = ay;
    out[o + 5] = az;
  }

  /**
   * RK4 한 스텝. s = {x,y,z,vx,vy,vz,t, dragMul?, spin?}
   * wind = {x,y,z} (스텝 동안 고정)
   */
  step(s, dt, wind) {
    const k = this._k;
    const wx = wind ? wind.x : 0;
    const wy = wind ? wind.y : 0;
    const wz = wind ? wind.z : 0;
    const dm = s.dragMul || 1;
    const h2 = dt * 0.5;
    this._deriv(s.vx, s.vy, s.vz, s.t, wx, wy, wz, dm, k, 0);
    this._deriv(s.vx + h2 * k[3], s.vy + h2 * k[4], s.vz + h2 * k[5], s.t + h2, wx, wy, wz, dm, k, 6);
    this._deriv(s.vx + h2 * k[9], s.vy + h2 * k[10], s.vz + h2 * k[11], s.t + h2, wx, wy, wz, dm, k, 12);
    this._deriv(s.vx + dt * k[15], s.vy + dt * k[16], s.vz + dt * k[17], s.t + dt, wx, wy, wz, dm, k, 18);
    const d6 = dt / 6;
    s.x += d6 * (k[0] + 2 * k[6] + 2 * k[12] + k[18]);
    s.y += d6 * (k[1] + 2 * k[7] + 2 * k[13] + k[19]);
    s.z += d6 * (k[2] + 2 * k[8] + 2 * k[14] + k[20]);
    s.vx += d6 * (k[3] + 2 * k[9] + 2 * k[15] + k[21]);
    s.vy += d6 * (k[4] + 2 * k[10] + 2 * k[16] + k[22]);
    s.vz += d6 * (k[5] + 2 * k[11] + 2 * k[17] + k[23]);
    const t0 = s.t;
    s.t += dt;
    if (this.spinDriftCoeff !== 0 && s.spin !== false) {
      // 스핀 드리프트: 진행 방향 기준 수평 오른쪽(v × up)으로 위치 이동
      const hx = -s.vz;
      const hz = s.vx;
      const hl = Math.sqrt(hx * hx + hz * hz);
      if (hl > 1e-6) {
        const d = this.spinDriftCoeff * (Math.pow(s.t, 1.83) - Math.pow(t0, 1.83)) / hl;
        s.x += d * hx;
        s.z += d * hz;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 사거리표 계산 (테스트·BDC·영점용). 평탄 지면, 조준선 수평 가정.
// 로컬 좌표: +x 사거리 방향, +y 위, +z 오른쪽.
// 조준선 원점 = 눈(조준기) 위치. 총구는 조준선 아래 sightHeight, 앞쪽 muzzleForward.
// ---------------------------------------------------------------------------
function hermite(p0, v0, p1, v1, dt, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * dt * v0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * dt * v1;
}

/**
 * @returns {Array<{range,t,v,y,yWorld,z,drop}>}
 *   y: 조준선 기준 탄 높이(m, +위, 조준선에 수직), yWorld: 눈높이 수평면 기준 높이,
 *   z: 횡편류(m, +오른쪽), drop: 발사선(총열 연장선) 기준 낙차(m, 양수=아래)
 */
export function computeTrajectory(model, opts) {
  const {
    muzzleVelocity,
    elevation = 0, // 조준선 대비 총열 앙각(rad)
    losAngle = 0, // 조준선 자체의 앙각(rad)
    sightHeight = 0,
    muzzleForward = 0,
    ranges,
    rangeMode = 'los', // 'los': 조준선 따라 잰 거리, 'horizontal': 수평거리
    wind = null, // {x,y,z} 고정
    dt = 0.001,
    maxTime = 6,
    spin = true,
  } = opts;
  const ang = losAngle + elevation;
  const cl = Math.cos(losAngle);
  const sl = Math.sin(losAngle);
  // 총구: 조준선 원점(눈)에서 조준선 방향으로 muzzleForward, 조준선에 수직 아래로 sightHeight
  const s = {
    x: muzzleForward * cl + sightHeight * sl,
    y: muzzleForward * sl - sightHeight * cl,
    z: 0,
    vx: muzzleVelocity * Math.cos(ang),
    vy: muzzleVelocity * Math.sin(ang),
    vz: 0,
    t: 0,
    dragMul: 1,
    spin,
  };
  const x0 = s.x;
  const y0 = s.y;
  const tanA = Math.tan(ang);
  const measure = rangeMode === 'horizontal' ? (x, y) => x : (x, y) => x * cl + y * sl;
  const sorted = [...ranges].sort((a, b) => a - b);
  const rows = [];
  let ri = 0;
  while (ri < sorted.length && s.t < maxTime) {
    const px = s.x, py = s.y, pz = s.z, pvx = s.vx, pvy = s.vy, pvz = s.vz, pt = s.t;
    model.step(s, dt, wind);
    const m1 = measure(s.x, s.y);
    while (ri < sorted.length && m1 >= sorted[ri]) {
      const R = sorted[ri];
      let lo = 0, hi = 1;
      for (let it = 0; it < 48; it++) {
        const u = (lo + hi) * 0.5;
        const xu = hermite(px, pvx, s.x, s.vx, dt, u);
        const yu = hermite(py, pvy, s.y, s.vy, dt, u);
        if (measure(xu, yu) < R) lo = u; else hi = u;
      }
      const u = (lo + hi) * 0.5;
      const xu = hermite(px, pvx, s.x, s.vx, dt, u);
      const yu = hermite(py, pvy, s.y, s.vy, dt, u);
      const zu = hermite(pz, pvz, s.z, s.vz, dt, u);
      const vxu = pvx + (s.vx - pvx) * u;
      const vyu = pvy + (s.vy - pvy) * u;
      const vzu = pvz + (s.vz - pvz) * u;
      rows.push({
        range: R,
        t: pt + dt * u,
        v: Math.sqrt(vxu * vxu + vyu * vyu + vzu * vzu),
        y: -xu * sl + yu * cl,
        yWorld: yu,
        z: zu,
        drop: y0 + (xu - x0) * tanA - yu,
      });
      ri++;
    }
    if (s.vx <= 0) break;
  }
  return rows;
}

/** 조준선이 zeroRange에서 탄도와 만나도록 하는 총열 앙각(rad)을 찾는다(먼 쪽 교차점). */
export function solveZeroElevation(model, { muzzleVelocity, sightHeight, muzzleForward = 0, zeroRange, dt = 0.001 }) {
  const f = (el) =>
    computeTrajectory(model, { muzzleVelocity, elevation: el, sightHeight, muzzleForward, ranges: [zeroRange], dt, spin: false })[0].y;
  const tof = zeroRange / muzzleVelocity;
  let a = (sightHeight + 0.5 * model.g * tof * tof) / zeroRange;
  let b = a * 1.2;
  let fa = f(a);
  let fb = f(b);
  for (let i = 0; i < 40 && Math.abs(fb) > 1e-8; i++) {
    const c = b - (fb * (b - a)) / (fb - fa);
    a = b;
    fa = fb;
    b = c;
    fb = f(b);
  }
  return b;
}

/**
 * BDC 눈금 각도: 수평 거리 R, 눈높이에 있는 표적을 맞히려면 조준선을 얼마나(δ rad) 더
 * 들어야 하는가. 눈금은 레티클 중심에서 δ만큼 아래에 그린다.
 */
export function holdForRange(model, { muzzleVelocity, sightHeight, muzzleForward = 0, zeroElevation, range, dt = 0.001 }) {
  const g = (delta) =>
    computeTrajectory(model, {
      muzzleVelocity,
      elevation: zeroElevation,
      losAngle: delta,
      sightHeight,
      muzzleForward,
      ranges: [range],
      rangeMode: 'horizontal',
      dt,
      spin: false,
    })[0].yWorld;
  let a = 0;
  let fa = g(a);
  let b = Math.max(1e-5, -fa / range);
  let fb = g(b);
  for (let i = 0; i < 40 && Math.abs(fb) > 1e-8; i++) {
    const c = b - (fb * (b - a)) / (fb - fa);
    a = b;
    fa = fb;
    b = c;
    fb = g(b);
  }
  return b;
}

/** 좌표계(x 동, y 위, z 남)에서 지구 자전 벡터. */
export function earthOmegaWorld(latDeg, omega) {
  const p = (latDeg * Math.PI) / 180;
  // ENU에서 Ω = ω(0, cosφ, sinφ). 게임 좌표: x=동, y=위, z=남(= -북)
  return [0, omega * Math.sin(p), -omega * Math.cos(p)];
}
