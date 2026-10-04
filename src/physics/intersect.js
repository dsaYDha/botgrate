// 선분-형상 교차(탄도 충돌 검사용). 선분 P(t) = p0 + d·t, t∈[0,1].
// 반환값의 t0/t1은 무한 직선 기준 진입/진출 파라미터(현 길이 계산용).

/** 기울어진 수직 원기둥(줄기). 전단 변환으로 수직 원기둥 문제로 바꾼다. */
export function segTrunk(x0, y0, z0, dx, dy, dz, o, out) {
  // 줄기 축: (o.x + lx·h, y, o.z + lz·h), h = y - o.y0
  const ex = x0 - o.lx * (y0 - o.y0) - o.x;
  const ez = z0 - o.lz * (y0 - o.y0) - o.z;
  const ddx = dx - o.lx * dy;
  const ddz = dz - o.lz * dy;
  const a = ddx * ddx + ddz * ddz;
  if (a < 1e-12) return false;
  // 탄이 지나는 높이에서의 반지름(테이퍼)
  const ym = y0 + dy * 0.5;
  const hh = Math.max(0.01, o.top - o.y0);
  let k = (ym - o.y0) / hh;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  let r = o.r0 + (o.r1 - o.r0) * k;
  if (ym - o.y0 < 0.25) r *= 1 + 0.3 * (1 - (ym - o.y0) / 0.25); // 뿌리 부분 팽창
  const b = 2 * (ex * ddx + ez * ddz);
  const c = ex * ex + ez * ez - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t0 > 1 || t1 < 0) return false;
  const te = Math.max(0, t0);
  const yh = y0 + dy * te;
  if (yh < o.y0 || yh > o.top) return false;
  const nx = ex + ddx * te;
  const nz = ez + ddz * te;
  const nl = Math.hypot(nx, nz) || 1;
  out.t0 = te;
  out.t1 = t1;
  out.nx = nx / nl;
  out.ny = 0;
  out.nz = nz / nl;
  out.radius = r;
  return true;
}

/** 원기둥(통나무, 반지름은 평균) */
export function segCylinder(x0, y0, z0, dx, dy, dz, ax, ay, az, bx, by, bz, r, out) {
  let ux = bx - ax;
  let uy = by - ay;
  let uz = bz - az;
  const L = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= L;
  uy /= L;
  uz /= L;
  const wx = x0 - ax;
  const wy = y0 - ay;
  const wz = z0 - az;
  const dw = wx * ux + wy * uy + wz * uz;
  const dd = dx * ux + dy * uy + dz * uz;
  const nx = wx - dw * ux;
  const ny = wy - dw * uy;
  const nz = wz - dw * uz;
  const mx = dx - dd * ux;
  const my = dy - dd * uy;
  const mz = dz - dd * uz;
  const a = mx * mx + my * my + mz * mz;
  if (a < 1e-12) return false;
  const b = 2 * (nx * mx + ny * my + nz * mz);
  const c = nx * nx + ny * ny + nz * nz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t0 > 1 || t1 < 0) return false;
  const te = Math.max(0, t0);
  const axial = dw + dd * te;
  if (axial < 0 || axial > L) return false;
  const px = nx + mx * te;
  const py = ny + my * te;
  const pz = nz + mz * te;
  const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
  out.t0 = te;
  out.t1 = t1;
  out.nx = px / pl;
  out.ny = py / pl;
  out.nz = pz / pl;
  return true;
}

/** 축 정렬 타원체(잎 볼륨) */
export function segEllipsoid(x0, y0, z0, dx, dy, dz, cx, cy, cz, rx, ry, rz, out) {
  const qx = (x0 - cx) / rx;
  const qy = (y0 - cy) / ry;
  const qz = (z0 - cz) / rz;
  const vx = dx / rx;
  const vy = dy / ry;
  const vz = dz / rz;
  const a = vx * vx + vy * vy + vz * vz;
  if (a < 1e-14) return false;
  const b = 2 * (qx * vx + qy * vy + qz * vz);
  const c = qx * qx + qy * qy + qz * qz - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t0 > 1 || t1 < 0) return false;
  out.t0 = t0;
  out.t1 = t1;
  return true;
}

/** 원기둥(국소 y축, 0..len, 반지름 r) — 사지 히트박스. 국소 좌표의 선분을 받는다. */
export function segLocalCylinderY(x0, y0, z0, dx, dy, dz, r, len, out) {
  const a = dx * dx + dz * dz;
  if (a < 1e-14) return false;
  const b = 2 * (x0 * dx + z0 * dz);
  const c = x0 * x0 + z0 * z0 - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  let t0 = (-b - sq) / (2 * a);
  let t1 = (-b + sq) / (2 * a);
  // 길이 방향으로 자르기
  if (Math.abs(dy) > 1e-9) {
    let ya = (0 - y0) / dy;
    let yb = (len - y0) / dy;
    if (ya > yb) [ya, yb] = [yb, ya];
    t0 = Math.max(t0, ya);
    t1 = Math.min(t1, yb);
  } else if (y0 < 0 || y0 > len) return false;
  if (t0 >= t1 || t0 > 1 || t1 < 0) return false;
  out.t0 = Math.max(0, t0);
  out.t1 = t1;
  return true;
}

/** 국소 좌표 상자(중심 원점, 반폭 hx,hy,hz) — 슬랩 방식 */
export function segLocalBox(x0, y0, z0, dx, dy, dz, hx, hy, hz, out) {
  let t0 = -Infinity;
  let t1 = Infinity;
  const slab = (p, d, h) => {
    if (Math.abs(d) < 1e-12) return p >= -h && p <= h;
    let a = (-h - p) / d;
    let b = (h - p) / d;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return t0 <= t1;
  };
  if (!slab(x0, dx, hx) || !slab(y0, dy, hy) || !slab(z0, dz, hz)) return false;
  if (t0 > 1 || t1 < 0) return false;
  out.t0 = Math.max(0, t0);
  out.t1 = t1;
  return true;
}

/** 국소 좌표 타원체(중심 원점) */
export function segLocalEllipsoid(x0, y0, z0, dx, dy, dz, rx, ry, rz, out) {
  return segEllipsoid(x0, y0, z0, dx, dy, dz, 0, 0, 0, rx, ry, rz, out);
}

/** 점과 선분 사이 최근접 거리, 그리고 그 매개변수 */
export function pointSegDistance(px, py, pz, x0, y0, z0, dx, dy, dz) {
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy + (pz - z0) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x0 + dx * t - px;
  const cy = y0 + dy * t - py;
  const cz = z0 + dz * t - pz;
  return { d: Math.sqrt(cx * cx + cy * cy + cz * cz), t };
}
