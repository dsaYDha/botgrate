// 전장 배치(띠·도로·밭·배수로)의 기하 질의. 월드 데이터(src/data/world.js)를 해석한다.

export class Belt {
  constructor(def) {
    Object.assign(this, def);
    this.half = def.width / 2;
    // 축 방향 단위벡터(t)와 가로 방향 단위벡터(n, +v 방향)
    if (def.axis === 'x') {
      this.t = [1, 0];
      this.n = [0, 1]; // +v = 남쪽
    } else {
      this.t = [0, 1];
      this.n = [1, 0]; // +v = 동쪽
    }
    this.length = def.to - def.from;
  }
  toLocal(x, z) {
    return this.axis === 'x' ? { u: x, v: z - this.center } : { u: z, v: x - this.center };
  }
  toWorld(u, v) {
    return this.axis === 'x' ? { x: u, z: this.center + v } : { x: this.center + v, z: u };
  }
  inGap(u) {
    for (const g of this.gaps) if (u >= g[0] && u <= g[1]) return true;
    return false;
  }
  /** u가 숲으로 덮인 구간이면 경계(끝·틈)까지의 거리(+), 틈/바깥이면 음수 거리 */
  coverageDistance(u) {
    let d = Math.min(u - this.from, this.to - u);
    for (const g of this.gaps) {
      if (u >= g[0] && u <= g[1]) {
        d = Math.min(d, -Math.min(u - g[0], g[1] - u));
      } else {
        d = Math.min(d, u < g[0] ? g[0] - u : u - g[1]);
      }
    }
    return d;
  }
  /** side 이름 → v 부호 */
  sideSign(side) {
    if (this.axis === 'x') return side === 'north' ? -1 : 1;
    return side === 'west' ? -1 : 1;
  }
}

export class Road {
  constructor(def) {
    Object.assign(this, def);
    this.half = def.width / 2;
    this.segs = [];
    for (let i = 0; i < def.points.length - 1; i++) {
      const [ax, az] = def.points[i];
      const [bx, bz] = def.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      this.segs.push({ ax, az, dx: dx / len, dz: dz / len, len });
    }
  }
  /** 중심선까지 부호 있는 거리(진행 방향 왼쪽 +), 구간 끝 밖이면 큰 값 */
  signedDistance(x, z) {
    let best = Infinity;
    let sign = 1;
    for (const s of this.segs) {
      const px = x - s.ax;
      const pz = z - s.az;
      let t = px * s.dx + pz * s.dz;
      let d;
      if (t < 0 || t > s.len) {
        t = Math.max(0, Math.min(s.len, t));
        d = Math.hypot(px - s.dx * t, pz - s.dz * t);
      } else {
        d = Math.abs(px * s.dz - pz * s.dx);
      }
      if (d < best) {
        best = d;
        sign = px * s.dz - pz * s.dx >= 0 ? 1 : -1;
      }
    }
    return best * sign;
  }
}

export class Layout {
  constructor(world) {
    this.world = world;
    this.belts = world.belts.map((b) => new Belt(b));
    this.beltById = Object.fromEntries(this.belts.map((b) => [b.id, b]));
    this.roads = world.roads.map((r) => new Road(r));
    this.ditches = world.ditches.map((d) => {
      const belt = this.beltById[d.belt];
      const v = belt.sideSign(d.side) * (belt.half + d.offset);
      return { ...d, beltRef: belt, v, sign: belt.sideSign(d.side) };
    });
  }

  /** 가장 가까운 도로 중심선까지 부호 있는 거리와 그 도로 */
  roadDistance(x, z) {
    let best = Infinity;
    let road = null;
    for (const r of this.roads) {
      const d = r.signedDistance(x, z);
      if (Math.abs(d) < Math.abs(best)) {
        best = d;
        road = r;
      }
    }
    return { d: best, road };
  }

  fieldAt(x, z) {
    for (const f of this.world.fields) {
      const [x0, z0, x1, z1] = f.rect;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return f;
    }
    return null;
  }

  /** 띠 안이면 {belt, u, v} (틈 포함), 아니면 null */
  beltAt(x, z, pad = 0) {
    for (const b of this.belts) {
      const { u, v } = b.toLocal(x, z);
      if (u >= b.from - pad && u <= b.to + pad && Math.abs(v) <= b.half + pad) return { belt: b, u, v };
    }
    return null;
  }
}
