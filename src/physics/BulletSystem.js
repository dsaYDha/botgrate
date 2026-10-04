// 투사체 시스템(히트스캔 없음). 모든 탄은 1 ms 고정 서브스텝 RK4로 적분하고,
// 매 스텝 이전 위치 → 현재 위치 선분으로 충돌을 검사한다(얇은 물체를 건너뛰지 않음).
// 바람은 위치별 바람장(차폐·돌풍·높이 분포)에서 공기 대비 상대속도로 반영.
// 재질별 관통·편향은 data/materials.js. 사수(shooter)와 무관하게 동작 → 2단계 적 사격도 같은 경로.

import { BallisticModel, earthOmegaWorld, spinDriftAccelCoeff } from './ballistics.js';
import { segStem, segCylinder, segEllipsoid, segCappedCylinder, pointSegDistance } from './intersect.js';
import { coverAt, makeCoverSample, COVER_KINDS } from '../world/GroundCover.js';
import { MATERIALS } from '../data/materials.js';
import { ATMOSPHERE } from '../data/atmosphere.js';
import { rng } from '../core/Random.js';

const DT = 0.001;
const DEG = Math.PI / 180;
let nextId = 1;

export class BulletSystem {
  constructor(world, events) {
    this.world = world;
    this.events = events;
    this.bullets = [];
    this.acc = 0;
    this.time = 0;
    this.models = new Map();
    this.targetProviders = [];
    this.nearMissProvider = null;
    // 2단계: 청자(플레이어) 근처를 지나는 남의 탄 → 'bullet:flyby'(초음속 크랙). listener = () => {x,y,z}
    this.listener = null;
    this.trails = [];
    this.recordTrails = true;
    this._q = [];
    this._hit = { t0: 0, t1: 0, nx: 0, ny: 0, nz: 0, radius: 0 };
    this._wind = { x: 0, y: 0, z: 0 };
    this._hits = [];
    this._normal = [0, 1, 0];
    this.omega = earthOmegaWorld(ATMOSPHERE.latitudeDeg, ATMOSPHERE.earthRotation);
    this.stats = { steps: 0, maxActive: 0 };
  }

  /** 표적(적 히트박스 등) 등록: fn(x0,y0,z0,dx,dy,dz, hits[]) 가 {t0,t1,target,part,nx,ny,nz} 추가 */
  addTargetProvider(fn) {
    this.targetProviders.push(fn);
  }

  _model(ammo, sg, rh) {
    const key = `${ammo.id}:${sg.toFixed(2)}:${rh}`;
    let m = this.models.get(key);
    if (!m) {
      m = new BallisticModel({
        dragModel: ammo.dragModel,
        bc: ammo.bc,
        omega: this.omega,
        spinDriftCoeff: spinDriftAccelCoeff(sg) * (rh ? 1 : -1),
      });
      this.models.set(key, m);
    }
    return m;
  }

  fire({ origin, dir, speed, ammo, shooter, spinSg = 2.4, rightHandTwist = true }) {
    const b = {
      id: nextId++,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      vx: dir.x * speed,
      vy: dir.y * speed,
      vz: dir.z * speed,
      t: 0,
      dragMul: 1,
      spin: true,
      ammo,
      model: this._model(ammo, spinSg, rightHandTwist),
      shooter,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      v0: speed,
      alive: true,
      notified: [],
      trail: this.recordTrails ? [origin.x, origin.y, origin.z] : null,
      trailTick: 0,
      dist: 0,
      lastFoliage: null,
    };
    this.bullets.push(b);
    if (b.trail) {
      this.trails.push(b);
      if (this.trails.length > 24) this.trails.shift();
    }
    return b;
  }

  update(dt, time) {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.time = time - this.acc;
      for (let i = 0; i < this.bullets.length; i++) {
        const b = this.bullets[i];
        if (b.alive) this._step(b);
      }
      steps++;
      if (steps > 80) {
        this.acc = 0;
        break;
      }
    }
    if (this.bullets.length) {
      this.stats.maxActive = Math.max(this.stats.maxActive, this.bullets.length);
      this.bullets = this.bullets.filter((b) => b.alive);
    }
  }

  _step(b) {
    const w = this.world;
    const x0 = b.x;
    const y0 = b.y;
    const z0 = b.z;
    const gy0 = w.terrain.heightAt(x0, z0);
    w.wind.sample(x0, y0, z0, this.time, this._wind, gy0);
    b.model.step(b, DT, this._wind);
    this.stats.steps++;
    const dx = b.x - x0;
    const dy = b.y - y0;
    const dz = b.z - z0;
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    b.dist += segLen;

    if (b.trail) {
      b.trailTick++;
      if (b.trailTick % 4 === 0) b.trail.push(b.x, b.y, b.z);
    }

    // ---- 충돌 후보 ----
    const hits = this._hits;
    hits.length = 0;
    const h = this._hit;
    const q = this._q;
    w.hash.query(Math.min(x0, b.x) - 0.5, Math.min(z0, b.z) - 0.5, Math.max(x0, b.x) + 0.5, Math.max(z0, b.z) + 0.5, q);
    for (let k = 0; k < q.length; k++) {
      const o = q[k];
      if (o.kind === 'trunk') {
        if (segStem(x0, y0, z0, dx, dy, dz, o, h)) hits.push({ t0: h.t0, t1: h.t1, nx: h.nx, ny: h.ny, nz: h.nz, kind: 'trunk', obj: o, material: o.material });
      } else if (o.kind === 'limb') {
        if (segCappedCylinder(x0, y0, z0, dx, dy, dz, o.ax, o.ay, o.az, o.bx, o.by, o.bz, o.r, h))
          hits.push({ t0: h.t0, t1: h.t1, nx: h.nx, ny: h.ny, nz: h.nz, kind: 'trunk', obj: o, material: o.material });
      } else if (o.kind === 'log') {
        const r = (o.r + o.r2) * 0.5;
        if (segCylinder(x0, y0, z0, dx, dy, dz, o.ax, o.ay, o.az, o.bx, o.by, o.bz, r, h))
          hits.push({ t0: h.t0, t1: h.t1, nx: h.nx, ny: h.ny, nz: h.nz, kind: 'log', obj: o, material: o.material });
      } else if (o.kind === 'bale' || o.kind === 'rootPlate') {
        if (segCappedCylinder(x0, y0, z0, dx, dy, dz, o.ax, o.ay, o.az, o.bx, o.by, o.bz, o.r, h))
          hits.push({ t0: h.t0, t1: h.t1, nx: h.nx, ny: h.ny, nz: h.nz, kind: o.kind, obj: o, material: o.material });
      } else if (o.kind === 'foliage') {
        if (segEllipsoid(x0, y0, z0, dx, dy, dz, o.cx, o.cy, o.cz, o.rx, o.ry, o.rz, h))
          hits.push({ t0: Math.max(0, h.t0), t1: h.t1, kind: 'volume', obj: o, material: o.material });
      }
    }
    for (const fn of this.targetProviders) fn(x0, y0, z0, dx, dy, dz, hits);

    // 지면: 끝점이 땅 아래이거나, 지면 가까이에서 중간점이 땅 아래
    const gy1 = w.terrain.heightAt(b.x, b.z);
    let groundT = -1;
    if (b.y < gy1) {
      groundT = this._groundBisect(x0, y0, z0, dx, dy, dz, 0, 1);
    } else if (Math.min(y0 - gy0, b.y - gy1) < 0.4) {
      for (const tm of [0.25, 0.5, 0.75]) {
        const px = x0 + dx * tm;
        const pz = z0 + dz * tm;
        if (y0 + dy * tm < w.terrain.heightAt(px, pz)) {
          groundT = this._groundBisect(x0, y0, z0, dx, dy, dz, 0, tm);
          break;
        }
      }
    }
    if (groundT >= 0) hits.push({ t0: groundT, t1: groundT, kind: 'ground', material: 'soil' });
    // 지면 식생 덮개(그루터기·잡초·해바라기): 낮게 나는 탄만
    if (Math.min(y0 - gy0, b.y - gy1) < 2.3) this._cover(b, x0, y0, z0, dx, dy, dz, segLen, gy0, gy1, groundT);

    // 근탄(제압) 통지
    if (this.nearMissProvider) this.nearMissProvider(b, x0, y0, z0, dx, dy, dz);
    if (this.listener && b.shooter !== 'player' && !b.flybyDone) {
      const L = this.listener();
      const r = pointSegDistance(L.x, L.y, L.z, x0, y0, z0, dx, dy, dz);
      if (r.d < 15 && r.t > 0 && r.t < 1) {
        b.flybyDone = true;
        const sp = this._speed(b);
        this.events.emit('bullet:flyby', {
          x: x0 + dx * r.t,
          y: y0 + dy * r.t,
          z: z0 + dz * r.t,
          distance: r.d,
          speed: sp,
          supersonic: sp > ATMOSPHERE.speedOfSoundBallistic,
          shooter: b.shooter,
        });
      }
    }

    if (hits.length === 0) {
      this._checkEnd(b);
      return;
    }
    hits.sort((a, c) => a.t0 - c.t0);
    for (let k = 0; k < hits.length && b.alive; k++) {
      const hit = hits[k];
      if (hit.kind === 'volume') {
        this._volume(b, hit, x0, y0, z0, dx, dy, dz, segLen);
        continue;
      }
      // 고체: 진입점 처리 후 이번 스텝 종료(관통했으면 출구로 이동)
      this._solid(b, hit, x0, y0, z0, dx, dy, dz, segLen);
      break;
    }
    this._checkEnd(b);
  }

  /** 덮개 속을 지난 길이만큼 줄기 타격(포아송)으로 꺾고 느리게. 화면의 풀·잡초 높이와 같은 식(GroundCover). */
  _cover(b, x0, y0, z0, dx, dy, dz, segLen, gy0, gy1, groundT) {
    const t = this.world.terrain;
    const c = this._coverS || (this._coverS = makeCoverSample());
    const tEnd = groundT >= 0 ? groundT : 1;
    const n = Math.max(1, Math.ceil((segLen * tEnd) / 0.3));
    const L = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const tm = ((k + 0.5) / n) * tEnd;
      const px = x0 + dx * tm;
      const py = y0 + dy * tm;
      const pz = z0 + dz * tm;
      const gy = gy0 + (gy1 - gy0) * tm;
      if (py - gy > 2.3) continue;
      coverAt(t, px, pz, c);
      if (py - gy >= c.h) continue;
      const dl = (segLen * tEnd) / n;
      for (let q = 0; q < 3; q++) L[q] += dl * c.k[q];
    }
    let sp = this._speed(b);
    let ang = 0;
    let strikes = 0;
    let mat = null;
    for (let q = 0; q < 3; q++) {
      if (L[q] <= 0) continue;
      const m = MATERIALS[COVER_KINDS[q]];
      sp *= Math.exp(-m.lossPerMeter * L[q]);
      const lambda = m.twigRatePerMeter * L[q];
      let p = Math.exp(-lambda);
      let r = rng.next();
      let s = 0;
      while (r > p && s < 6) {
        s++;
        r -= p;
        p *= lambda / s;
      }
      for (let i = 0; i < s; i++) {
        ang += Math.abs(rng.gauss()) * m.twigDeflectDeg * DEG;
        sp *= 1 - m.twigSpeedLoss * (0.5 + rng.next());
      }
      if (s > 0) mat = COVER_KINDS[q];
      strikes += s;
    }
    if (ang > 0 || sp !== this._speed(b)) this._deflect(b, ang, sp);
    if (strikes > 0 && mat !== 'stubbleCover' && b.lastCoverFx !== this.stats.steps) {
      b.lastCoverFx = this.stats.steps;
      this.events.emit('bullet:foliage', { x: b.x, y: b.y, z: b.z, material: mat, speed: sp, strikes, shooter: b.shooter });
    }
  }

  _groundBisect(x0, y0, z0, dx, dy, dz, a, c) {
    const t = this.world.terrain;
    let lo = a;
    let hi = c;
    for (let i = 0; i < 18; i++) {
      const m = (lo + hi) * 0.5;
      const px = x0 + dx * m;
      const pz = z0 + dz * m;
      if (y0 + dy * m < t.heightAt(px, pz)) hi = m;
      else lo = m;
    }
    return (lo + hi) * 0.5;
  }

  _checkEnd(b) {
    const sp2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
    if (sp2 < 50 * 50 || b.t > 7 || Math.abs(b.x) > 4000 || Math.abs(b.z) > 4000 || b.y < -50 || b.y > 3000) b.alive = false;
  }

  _speed(b) {
    return Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  }

  /** 속도 벡터를 임의 방향으로 angle만큼 꺾고 크기를 newSpeed로 */
  _deflect(b, angle, newSpeed) {
    const sp = this._speed(b) || 1;
    let ux = b.vx / sp;
    let uy = b.vy / sp;
    let uz = b.vz / sp;
    if (angle > 0) {
      // 수직 기저
      let ax = Math.abs(uy) < 0.9 ? 0 : 1;
      let ay = Math.abs(uy) < 0.9 ? 1 : 0;
      let az = 0;
      let px = uy * az - uz * ay;
      let py = uz * ax - ux * az;
      let pz = ux * ay - uy * ax;
      const pl = Math.sqrt(px * px + py * py + pz * pz);
      px /= pl;
      py /= pl;
      pz /= pl;
      const qx = uy * pz - uz * py;
      const qy = uz * px - ux * pz;
      const qz = ux * py - uy * px;
      const phi = rng.next() * Math.PI * 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      ux = ux * ca + (px * c + qx * s) * sa;
      uy = uy * ca + (py * c + qy * s) * sa;
      uz = uz * ca + (pz * c + qz * s) * sa;
      ax = ay = az = 0;
    }
    b.vx = ux * newSpeed;
    b.vy = uy * newSpeed;
    b.vz = uz * newSpeed;
  }

  _volume(b, hit, x0, y0, z0, dx, dy, dz, segLen) {
    const m = MATERIALS[hit.material];
    const t0 = Math.max(0, hit.t0);
    const t1 = Math.min(1, hit.t1);
    if (t1 <= t0) return;
    const L = (t1 - t0) * segLen;
    const op = hit.obj.opacity || 1;
    let sp = this._speed(b) * Math.exp(-m.lossPerMeter * L * op);
    // 잔가지 타격(포아송)
    const lambda = m.twigRatePerMeter * L * op;
    let strikes = 0;
    let p = Math.exp(-lambda);
    let r = rng.next();
    while (r > p && strikes < 4) {
      strikes++;
      r -= p;
      p *= lambda / strikes;
    }
    let ang = 0;
    for (let i = 0; i < strikes; i++) {
      ang += Math.abs(rng.gauss()) * m.twigDeflectDeg * DEG;
      sp *= 1 - m.twigSpeedLoss * (0.5 + rng.next());
    }
    this._deflect(b, ang, sp);
    // 잎 볼륨에 처음 들어갈 때 효과(잎 흩날림)
    if (b.lastFoliage !== hit.obj && hit.t0 >= 0 && hit.t0 <= 1) {
      b.lastFoliage = hit.obj;
      const px = x0 + dx * hit.t0;
      const py = y0 + dy * hit.t0;
      const pz = z0 + dz * hit.t0;
      this.events.emit('bullet:foliage', { x: px, y: py, z: pz, material: hit.material, speed: sp, strikes, shooter: b.shooter });
    }
  }

  _solid(b, hit, x0, y0, z0, dx, dy, dz, segLen) {
    const px = x0 + dx * hit.t0;
    const py = y0 + dy * hit.t0;
    const pz = z0 + dz * hit.t0;
    const speed = this._speed(b);
    const ammo = b.ammo;
    const dirx = b.vx / speed;
    const diry = b.vy / speed;
    const dirz = b.vz / speed;
    const base = {
      x: px,
      y: py,
      z: pz,
      speed,
      energy: 0.5 * ammo.mass * speed * speed,
      dir: { x: dirx, y: diry, z: dirz },
      shooter: b.shooter,
      distance: Math.hypot(px - b.ox, py - b.oy, pz - b.oz),
      bulletId: b.id,
      time: this.time,
    };

    if (hit.kind === 'ground') {
      const n = this.world.terrain.normalAt(px, pz, this._normal);
      const dn = dirx * n[0] + diry * n[1] + dirz * n[2];
      const grazing = Math.asin(Math.min(1, Math.max(0, -dn))) / DEG;
      const mat = MATERIALS.soil;
      const crit = mat.ricochetCriticalDeg * (0.7 + 0.6 * rng.next());
      const surface = this.world.terrain.surfaceAt(px, pz);
      if (grazing < crit && speed > 150 && rng.next() < mat.ricochetChance) {
        // 도탄: 법선 성분 반사(감쇠), 접선 성분 감속, 텀블링
        const vn = dn * speed;
        const e = 0.2 + 0.15 * rng.next();
        b.vx = (b.vx - n[0] * vn) * 0.62 - n[0] * vn * e;
        b.vy = (b.vy - n[1] * vn) * 0.62 - n[1] * vn * e;
        b.vz = (b.vz - n[2] * vn) * 0.62 - n[2] * vn * e;
        this._deflect(b, (3 + rng.next() * 6) * DEG, this._speed(b));
        b.x = px + n[0] * 0.03;
        b.y = py + n[1] * 0.03;
        b.z = pz + n[2] * 0.03;
        b.dragMul = 3.5;
        b.spin = false;
        this.events.emit('bullet:impact', { ...base, kind: 'ground', material: 'soil', surface, normal: { x: n[0], y: n[1], z: n[2] }, ricochet: true });
        return;
      }
      b.alive = false;
      b.x = px;
      b.y = py;
      b.z = pz;
      this.events.emit('bullet:impact', { ...base, kind: 'ground', material: 'soil', surface, normal: { x: n[0], y: n[1], z: n[2] }, ricochet: false });
      return;
    }

    const mat = MATERIALS[hit.material];
    const chord = Math.max(0.001, (hit.t1 - hit.t0) * segLen);
    const P = mat.penetration * Math.pow(speed / ammo.penetrationRefVelocity, mat.exponent);
    const normal = { x: hit.nx || 0, y: hit.ny || 0, z: hit.nz || 0 };
    if (hit.kind === 'body') {
      const through = chord < P;
      const vOut = through ? ammo.penetrationRefVelocity * Math.pow((P - chord) / mat.penetration, 1 / mat.exponent) : 0;
      hit.target.onBulletHit?.({ ...base, part: hit.part, chord, through, exitSpeed: vOut, normal });
      this.events.emit('bullet:impact', { ...base, kind: 'body', material: 'flesh', part: hit.part, target: hit.target, through, normal });
      if (!through) {
        b.alive = false;
        return;
      }
      this._exit(b, x0, y0, z0, dx, dy, dz, hit.t1, vOut, mat, chord / P);
      return;
    }
    // 나무(줄기·통나무)
    if (chord < P) {
      const vOut = ammo.penetrationRefVelocity * Math.pow((P - chord) / mat.penetration, 1 / mat.exponent);
      this.events.emit('bullet:impact', { ...base, kind: hit.kind, material: hit.material, obj: hit.obj, normal, through: true, chord });
      this._exit(b, x0, y0, z0, dx, dy, dz, hit.t1, vOut, mat, chord / P);
      const ex = b.x;
      const ey = b.y;
      const ez = b.z;
      this.events.emit('bullet:exit', { x: ex, y: ey, z: ez, material: hit.material, speed: vOut, shooter: b.shooter });
    } else {
      b.alive = false;
      b.x = px;
      b.y = py;
      b.z = pz;
      this.events.emit('bullet:impact', { ...base, kind: hit.kind, material: hit.material, obj: hit.obj, normal, through: false, chord });
    }
  }

  _exit(b, x0, y0, z0, dx, dy, dz, t1, vOut, mat, frac) {
    b.x = x0 + dx * t1;
    b.y = y0 + dy * t1;
    b.z = z0 + dz * t1;
    const ang = mat.deflectionDeg * DEG * Math.sqrt(Math.min(1, frac)) * Math.abs(rng.gauss());
    this._deflect(b, ang, vOut);
    b.dragMul = Math.max(b.dragMul, mat.tumbleDrag || 2);
    b.spin = false;
  }

  /** 근탄 계산 도우미(공급자가 사용) */
  static closest(px, py, pz, x0, y0, z0, dx, dy, dz) {
    return pointSegDistance(px, py, pz, x0, y0, z0, dx, dy, dz);
  }
}
