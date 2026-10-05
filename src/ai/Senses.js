// 인지 시스템: 적이 플레이어에 대해 아는 것은 전부 여기를 거친다.
// 이 모듈만 플레이어의 실제 상태(몸 위치·자세·속도·총성)를 읽고, 적 두뇌에는 '관측'(추정 위치 + 오차)만 넘긴다.
//   시각: Sight로 부위별 시선 투과율 → 가시도 D → 응시율 × 탐지 확률로 증거가 쌓임(모름 → 의심 → 위치 파악)
//   청각: 총구 폭음(거리/343 s 뒤, 방향 ±20~30°), 초음속 탄 '딱'(방향 혼동, 딱-쾅 시간차로 거리), 발소리·덤불·총기 조작음
//   사격 순간: 총구 섬광·폭풍에 흔들리는 풀잎(한 번 보기), 엎드려쏴 먼지(1~3 s 보임)
// 갱신은 프레임 예산 안에서 적마다 순번으로(가까운 적은 자주, 먼 적은 드물게).

import { VISION, HEARING } from '../data/perception.js';
import { ATMOSPHERE } from '../data/atmosphere.js';
import { rng } from '../core/Random.js';
import { clamp, smoothstep } from '../core/math.js';
import { Sight } from './Sight.js';
import { proneMuzzleDust } from '../effects/Effects.js';

const DEG = Math.PI / 180;
const C_SOUND = ATMOSPHERE.soundSpeed;

/** 움직임 배수 */
export function motionFactor(speed) {
  return 1 + VISION.motionA * (1 - Math.exp(-speed / VISION.motionTau)) + VISION.motionB * speed;
}

/** 이심률 계수: 시선과 표적 방향 사이 각 θ(rad), 움직이는가 */
export function eccentricity(theta, moving) {
  const deg = theta / DEG;
  if (deg > VISION.peripheralLimitDeg) return 0;
  let e = deg <= VISION.centralDeg ? 1 : (VISION.centralDeg / deg) ** 2;
  if (moving) e = Math.max(e, VISION.movePeriphGain * smoothstep(VISION.peripheralLimitDeg, VISION.movePeriphFromDeg, deg));
  return e;
}

/** 한 번 볼 때 탐지 확률 */
export function glimpseP(D, D50 = VISION.D50) {
  if (D <= 0) return 0;
  return 1 / (1 + Math.pow(D50 / D, VISION.k));
}

/** 시각 상태(적 한 명) */
export class VisualState {
  constructor() {
    this.reset();
  }
  reset() {
    this.evidence = 0;
    this._draw();
    this.lastEval = -1;
    this.D = 0;
    this.Deff = 0;
    this.P = 0;
    this.frac = 0;
    this.T = [0, 0, 0, 0, 0];
    this.bg = 'field';
    this.lit = 1;
  }
  _draw() {
    let u = rng.next();
    while (u <= 1e-6) u = rng.next();
    const X = -Math.log(u);
    this.thrId = X;
    this.thrNotice = X * VISION.noticeFraction;
  }
}

/**
 * 표적 몸(PlayerBody)과 관측자 눈·시선으로 가시도를 계산(시험에서도 그대로 쓴다).
 * @param {Sight} sight
 * @param {import('../player/PlayerBody.js').PlayerBody} body
 * @param {{x,y,z}} eye
 * @param {{x,y,z}} gaze 단위벡터
 * @param {object} s 표적 상태 {speed, fidget, sunlit, canopy, bg, dustArea, dustPoint}
 * @param {object} o {observerInShade}
 * @param {object} out 결과(재사용)
 */
export function computeVisibility(sight, body, eye, gaze, s, o, out) {
  const pts = body.samples;
  const n = pts.length / 3;
  const T = out.T || (out.T = new Array(n).fill(0));
  sight.transmissionMulti(eye.x, eye.y, eye.z, pts, T);
  const c = body.center;
  let vx = c.x - eye.x;
  let vy = c.y - eye.y;
  let vz = c.z - eye.z;
  const d = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  vx /= d;
  vy /= d;
  vz /= d;
  const w = body.sampleWeights(vx, vy, vz);
  let sw = 0;
  let swt = 0;
  let best = -1;
  let bestV = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i];
    const v = w[i] * T[i];
    swt += v;
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  const frac = sw > 0 ? swt / sw : 0;
  const area = body.silhouetteArea(vx, vy, vz) * frac;
  // 겉보기 면적(mrad²)
  const omega = (area / (d * d)) * 1e6;
  const C = VISION.contrast[s.bg === 'sky' ? 'sky' : s.bg === 'forest' || s.bg === 'far' ? 'forest' : 'field'];
  const shadeBase = o.observerInShade ? VISION.shadeInside : VISION.shadeOutside;
  const shade = Math.min(0.8, shadeBase * (1 + 0.6 * (1 - (s.canopy || 0))));
  const L = s.sunlit + (1 - s.sunlit) * shade;
  let M = motionFactor(s.speed || 0);
  if (s.fidget) M = Math.max(M, VISION.fidget);
  const haze = Math.exp((-d / 1000) * VISION.hazePerKm);
  let D = omega * C * L * M * haze;
  // 엎드려쏴 먼지(밝은 먼지 구름, 몇 초)
  let Tdust = 0;
  if (s.dustArea > 0.01 && s.dustPoint) {
    Tdust = sight.transmission(eye.x, eye.y, eye.z, s.dustPoint.x, s.dustPoint.y, s.dustPoint.z, { skipLast: 0.5 });
    D += ((s.dustArea * Tdust) / (d * d)) * 1e6 * 1.5 * haze;
  }
  // 이심률
  const cosT = clamp(vx * gaze.x + vy * gaze.y + vz * gaze.z, -1, 1);
  const theta = Math.acos(cosT);
  const E = eccentricity(theta, (s.speed || 0) > 0.25);
  out.d = d;
  out.frac = frac;
  out.area = area;
  out.omega = omega;
  out.C = C;
  out.L = L;
  out.M = M;
  out.D = D;
  out.E = E;
  out.theta = theta;
  out.Deff = D * E;
  out.best = best;
  out.Tdust = Tdust;
  return out;
}

export class Senses {
  /**
   * @param {object} world
   * @param {import('../core/EventBus.js').EventBus} events
   * @param {object} truth {player, body, weapon} — 플레이어 실제 상태(이 모듈 밖으로 나가지 않는다)
   */
  constructor(world, events, truth) {
    this.world = world;
    this.events = events;
    this.truth = truth;
    this.sight = new Sight(world);
    this.agents = [];
    this.pending = []; // 지연 도착하는 소리 {at, agent, fn}
    this.time = 0;
    this.budgetEvals = 4; // 프레임당 시각 평가 수
    this._res = {};
    this._target = { speed: 0, fidget: false, sunlit: 1, canopy: 0, bg: 'field', dustArea: 0, dustPoint: null };
    this._lit = { t: -10, x: 1e9, z: 1e9, sunlit: 1, canopy: 0 };
    this._dust = null; // {t0, k, point}
    this.shotIndex = 0;
    this.lastShots = []; // 플레이어 사격 기록(디브리핑: 같은 자리에서 쏜 횟수)
    this.log = null; // AILog
    this.stats = { evals: 0, ms: 0 };
    this._bind();
  }

  register(agent) {
    agent.vis = agent.vis || new VisualState();
    agent.cracks = agent.cracks || new Map();
    this.agents.push(agent);
  }

  unregister(agent) {
    this.agents = this.agents.filter((a) => a !== agent);
  }

  reset() {
    this.pending.length = 0;
    this._dust = null;
    this.lastShots.length = 0;
    for (const a of this.agents) {
      a.vis.reset();
      a.cracks.clear();
    }
  }

  _bind() {
    const ev = this.events;
    ev.on('shot', (e) => {
      if (e.shooter === 'player') this._onPlayerShot(e);
      else this._onAllyShot(e);
    });
    ev.on('player:step', (e) => this._onStep(e));
    ev.on('weapon:sound', (e) => this._onHandling(e));
  }

  /**
   * 눈으로 본 위치의 거리 보정: 사람은 '저 숲띠 가장자리'처럼 지형지물에 기대어 위치를 잡는다.
   * 관측 방위선이 눈대중 거리 ±30 % 안에서 숲띠(수관·덤불 지도)로 들어가면 그 가장자리(+2 m)로, 거리 오차는 6 m로.
   * @returns {{d:number, sRad:number}|null}
   */
  _edgeRange(ex, ez, hx, hz, dEst) {
    const nav = this.nav;
    const c = this.world.canopy;
    if (!c) return null;
    const lo = dEst * 0.7;
    const hi = dEst * 1.3;
    let inside = this._dense(ex + hx * lo, ez + hz * lo);
    for (let s = lo; s <= hi; s += 2) {
      const now = this._dense(ex + hx * s, ez + hz * s);
      if (now && !inside) return { d: s + 2, sRad: 6 };
      inside = now;
    }
    void nav;
    return null;
  }

  _dense(x, z) {
    const c = this.world.canopy;
    const i = Math.floor((x + c.half) / c.res);
    const j = Math.floor((z + c.half) / c.res);
    if (i < 0 || j < 0 || i >= c.N || j >= c.N) return false;
    const k = (j * c.N + i) * 4;
    return c.data[k] > 90 || c.data[k + 1] > 120;
  }

  _later(at, agent, fn) {
    this.pending.push({ at, agent, fn });
  }

  /** 듣는 사람이 숲 안인가(잔향) */
  _inForest(a) {
    return this.world.belts.canopyAt(a.pos.x, a.pos.z) > 0.35;
  }

  // ---------------------------------------------------------------------------
  // 청각
  _onPlayerShot(e) {
    const p = e.position;
    const now = this.time;
    const shotId = e.bulletId ?? -++this.shotIndex;
    this.lastShots.push({ t: now, x: p.x, z: p.z });
    if (this.lastShots.length > 60) this.lastShots.shift();
    // 엎드려쏴 먼지: 화면 효과와 같은 식(총구 높이·지면 종류)
    if (e.stance === 'prone') {
      const pd = proneMuzzleDust(this.world, p, e.direction);
      if (pd) this._dust = { t0: now, k: pd.k, point: { x: pd.x, y: pd.y + 0.35, z: pd.z } };
    }
    for (const a of this.agents) {
      if (!a.canPerceive()) continue;
      const d = Math.hypot(p.x - a.pos.x, p.z - a.pos.z);
      if (d > HEARING.maxBangRange) continue;
      this._later(now + d / C_SOUND, a, () => this._hearBang(a, p, d, shotId));
      // 섬광·폭풍: 지금 그쪽을 보고 있으면 한 번 보기
      this._shotGlimpse(a, p, e.direction, d);
    }
  }

  _hearBang(a, p, d, shotId) {
    const K = a.knowledge;
    const now = this.time;
    const forest = this._inForest(a);
    let sig = HEARING.bangBearingSigmaDeg * DEG * (forest ? HEARING.forestBearingMul : 1);
    const crack = a.cracks.get(shotId);
    let bearing = Math.atan2(p.x - a.pos.x, -(p.z - a.pos.z));
    let rangeSigma = HEARING.rangeSigmaLoudness;
    if (crack) {
      sig *= HEARING.crackConfusionMul;
      // 쾅 방향이 딱 방향으로 끌려감
      const wgt = rng.range(HEARING.crackBiasWeight[0], HEARING.crackBiasWeight[1]);
      let diff = crack.bearing - bearing;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      bearing += diff * wgt;
      rangeSigma = HEARING.rangeSigmaCrackBang;
      a.cracks.delete(shotId);
    }
    bearing += rng.gauss() * sig;
    const dEst = clamp(d * Math.exp(rng.gauss() * rangeSigma - (rangeSigma * rangeSigma) / 2), 15, 1200);
    const ux = Math.sin(bearing);
    const uz = -Math.cos(bearing);
    const sLat = Math.max(4, dEst * Math.tan(Math.min(sig, 1.2)));
    const sRad = Math.max(4, dEst * rangeSigma);
    const ox = a.pos.x + ux * dEst;
    const oz = a.pos.z + uz * dEst;
    this._afterProcess(a, () => {
      K.threat = true;
      K.observe(ox, oz, sLat, sRad, ux, uz, now, 'bang');
      a.onObservation?.('bang', { x: ox, z: oz, d: dEst });
      this._logKnowledge(a, 'bang');
    });
  }

  /** 탄이 지나간 소리('딱'): BulletSystem 근탄 검사에서 호출. 방향은 마하 원뿔이 나온 탄 경로 위 점 */
  crack(a, info) {
    // info: {shotId, distance, emit:{x,z}, supersonic}
    if (!a.canPerceive() || !info.supersonic || info.distance > HEARING.crackRange) return;
    const bearing = Math.atan2(info.emit.x - a.pos.x, -(info.emit.z - a.pos.z)) + rng.gauss() * 15 * DEG;
    a.cracks.set(info.shotId, { t: this.time, bearing });
    if (a.cracks.size > 32) a.cracks.delete(a.cracks.keys().next().value);
    a.knowledge.threat = true;
  }

  _onAllyShot(e) {
    // 아군 총성: 교전이 시작됐다 → 경계(위치 정보는 없음)
    for (const a of this.agents) {
      if (!a.canPerceive() || a.id === e.shooter) continue;
      const d = Math.hypot(e.position.x - a.pos.x, e.position.z - a.pos.z);
      if (d > 900) continue;
      this._later(this.time + d / C_SOUND, a, () => {
        if (!a.knowledge.threat) {
          a.knowledge.suspicion = Math.max(a.knowledge.suspicion, 0.6);
          a.onObservation?.('allyShot', { x: e.position.x, z: e.position.z });
        }
      });
    }
  }

  _onStep(e) {
    const H = HEARING;
    const base = H.stepRange[e.surface] || 14;
    const mode = e.stance === 'prone' ? 'prone' : e.sprint ? 'sprint' : e.speed > 2.2 ? 'run' : e.stance === 'crouch' ? 'crouch' : 'walk';
    const w = this.world.wind;
    const R = (base * H.stepSpeedMul[mode] * (1 + H.stepShrubGain * (e.shrub || 0))) / (1 + w.speed / H.windMask);
    for (const a of this.agents) {
      if (!a.canPerceive() || a.knowledge.visible) continue;
      const d = Math.hypot(e.x - a.pos.x, e.z - a.pos.z);
      if (d > R) continue;
      // 가까울수록 확실히 들림
      if (rng.next() > 1 - (d / R) ** 2) continue;
      this._hearSoft(a, e.x, e.z, d, H.stepBearingSigmaDeg, H.stepRangeSigma, 'step');
    }
  }

  _onHandling(e) {
    const R0 = HEARING.handlingRange[e.type];
    if (!R0 || !this.truth.player) return;
    const p = this.truth.player;
    const w = this.world.wind;
    const R = R0 / (1 + w.speed / HEARING.windMask);
    for (const a of this.agents) {
      if (!a.canPerceive() || a.knowledge.visible) continue;
      const d = Math.hypot(p.x - a.pos.x, p.z - a.pos.z);
      if (d > R) continue;
      this._hearSoft(a, p.x, p.z, d, 30, 0.45, 'handling');
    }
  }

  /** 작은 소리: 방향 σ(도), 거리 로그 σ */
  _hearSoft(a, x, z, d, sigDeg, rSig, source) {
    const now = this.time;
    const bearing = Math.atan2(x - a.pos.x, -(z - a.pos.z)) + rng.gauss() * sigDeg * DEG;
    const dEst = clamp(d * Math.exp(rng.gauss() * rSig), 2, 200);
    const ux = Math.sin(bearing);
    const uz = -Math.cos(bearing);
    const ox = a.pos.x + ux * dEst;
    const oz = a.pos.z + uz * dEst;
    this._afterProcess(a, () => {
      const K = a.knowledge;
      K.suspicion = Math.min(1, K.suspicion + 0.35);
      K.observe(ox, oz, Math.max(2, dEst * Math.tan(sigDeg * DEG)), Math.max(2, dEst * rSig), ux, uz, now, source);
      a.onObservation?.(source, { x: ox, z: oz, d: dEst });
      this._logKnowledge(a, source);
    });
  }

  _afterProcess(a, fn) {
    this._later(this.time + rng.range(HEARING.processDelay[0], HEARING.processDelay[1]), a, fn);
  }

  // ---------------------------------------------------------------------------
  // 시각
  _targetState() {
    const tr = this.truth;
    const p = tr.player;
    const s = this._target;
    s.speed = p.speed;
    s.fidget = !!(p.transition || (tr.weapon && tr.weapon.action));
    // 햇빛·수관(1 s마다 또는 1 m 넘게 움직이면)
    const L = this._lit;
    const c = tr.body.center;
    if (this.time - L.t > 1 || Math.hypot(c.x - L.x, c.z - L.z) > 1) {
      L.t = this.time;
      L.x = c.x;
      L.z = c.z;
      L.sunlit = this.sight.sunlit(c.x, c.y + 0.2, c.z);
      L.canopy = this.world.belts.canopyAt(c.x, c.z);
    }
    s.sunlit = L.sunlit;
    s.canopy = L.canopy;
    // 먼지
    const dst = this._dust;
    if (dst) {
      const age = this.time - dst.t0;
      const k = dst.k * Math.exp(-age / VISION.dustTau);
      if (k < 0.03) this._dust = null;
      s.dustArea = 1.2 * k;
      s.dustPoint = dst.point;
    } else s.dustArea = 0;
    return s;
  }

  /** 사격 순간 한 번 보기 */
  _shotGlimpse(a, p, dir, d) {
    a.eye(this._eye || (this._eye = { x: 0, y: 0, z: 0 }));
    a.gaze(this._gz || (this._gz = { x: 0, y: 0, z: 0 }));
    const e = this._eye;
    const g = this._gz;
    // 섬광·폭풍에 흔들리는 풀잎: 총구 앞 0.5 m
    const cx = p.x + dir.x * 0.5;
    const cy = p.y + dir.y * 0.5;
    const cz = p.z + dir.z * 0.5;
    const T = this.sight.transmission(e.x, e.y, e.z, cx, cy, cz, { skipLast: 0.4 });
    if (T < 0.01) return;
    let vx = cx - e.x;
    let vy = cy - e.y;
    let vz = cz - e.z;
    const L = Math.hypot(vx, vy, vz) || 1;
    vx /= L;
    vy /= L;
    vz /= L;
    const theta = Math.acos(clamp(vx * g.x + vy * g.y + vz * g.z, -1, 1));
    const E = eccentricity(theta, true);
    const D = VISION.shotCueD * T * (150 / Math.max(20, d)) ** 2 * E;
    if (rng.next() < glimpseP(D)) {
      const now = this.time;
      const K = a.knowledge;
      const hl = Math.hypot(vx, vz) || 1;
      const hx = vx / hl;
      const hz = vz / hl;
      const ex = e.x;
      const ez = e.z;
      const dh = Math.hypot(cx - ex, cz - ez);
      const re = a.rangeError || 0.15;
      let dEst = dh * (1 + rng.gauss() * re);
      const sLat = 1 + dh * VISION.sightBearingSigma * 2;
      let sRad = Math.max(2, dh * re);
      const edge = this._edgeRange(ex, ez, hx, hz, dEst);
      if (edge) {
        dEst = edge.d;
        sRad = edge.sRad;
      }
      this._afterProcess(a, () => {
        K.threat = true;
        K.observe(ex + hx * dEst, ez + hz * dEst, sLat, sRad, hx, hz, now, 'flash');
        a.onObservation?.('flash', { x: ex + hx * dEst, z: ez + hz * dEst, d: dEst });
        this._logKnowledge(a, 'flash');
      });
    }
  }

  /** 적 한 명의 시각 평가 */
  evaluate(a) {
    const now = this.time;
    const vis = a.vis;
    const dt = vis.lastEval < 0 ? 0.1 : Math.min(1.0, now - vis.lastEval);
    vis.lastEval = now;
    const tr = this.truth;
    if (!tr.body.alive) return;
    const s = this._targetState();
    a.eye(this._eye || (this._eye = { x: 0, y: 0, z: 0 }));
    a.gaze(this._gz || (this._gz = { x: 0, y: 0, z: 0 }));
    const e = this._eye;
    // 배경(머리 쪽): 관측자·표적이 크게 움직였을 때만 다시
    const bgKey = `${Math.round(e.x / 3)},${Math.round(e.z / 3)},${Math.round(e.y * 2)},${Math.round(tr.body.center.x / 2)},${Math.round(tr.body.center.z / 2)},${Math.round(tr.body.samples[1] * 4)}`;
    if (vis.bgKey !== bgKey) {
      vis.bgKey = bgKey;
      const hp = tr.body.samples;
      vis.bg = this.sight.background(e.x, e.y, e.z, hp[0], hp[1], hp[2]).kind;
    }
    s.bg = vis.bg;
    const r = computeVisibility(this.sight, tr.body, e, this._gz, s, { observerInShade: a.inShade() }, this._res);
    vis.D = r.D;
    vis.Deff = r.Deff;
    vis.frac = r.frac;
    vis.lit = r.L;
    for (let i = 0; i < r.T.length; i++) vis.T[i] = r.T[i];
    const K = a.knowledge;
    // 의심 가는 곳을 집중해서 보고 있는가
    let focused = false;
    if (K.has && K.err < 0.6 * r.d + 30) {
      const ex = K.x - e.x;
      const ez = K.z - e.z;
      const g = this._gz;
      const hl = Math.hypot(ex, ez) || 1;
      const gl = Math.hypot(g.x, g.z) || 1;
      const cosA = (ex * g.x + ez * g.z) / (hl * gl);
      focused = cosA > Math.cos(Math.max(8 * DEG, Math.atan2(K.err, hl)));
    }
    const tracking = K.visible || (focused && K.err < 15 && now - K.lastObs < 4);
    const D50 = VISION.D50 * (tracking ? VISION.trackingScale : 1) * (a.visionScale || 1);
    const P = glimpseP(r.Deff, D50);
    vis.P = P;
    const R = focused ? VISION.focusedRate : VISION.glimpseRate;
    const lambda = R * P;
    if (K.visible) {
      // 계속 보는 중: 충분히 보이면 위치 갱신, 아니면 놓침
      if (P >= 0.15) this._seen(a, r, e, true);
      else {
        K.visible = false;
        a.onObservation?.('lost', {});
      }
      return;
    }
    vis.evidence += lambda * dt;
    if (lambda < 0.005) vis.evidence = Math.max(0, vis.evidence - VISION.evidenceDecay * dt * (vis.evidence + 0.05));
    if (vis.evidence <= 0.001 && vis.thrId < 0.05) vis._draw();
    if (vis.evidence >= vis.thrId) {
      this._seen(a, r, e, false);
      vis.evidence = 0;
      vis._draw();
    } else if (vis.evidence >= vis.thrNotice && !vis.noticed) {
      vis.noticed = true;
      // '뭔가 움직였다': 본 방향은 맞지만 오차가 크다
      const c = tr.body.center;
      const sg = VISION.glimpseSigma;
      const sLat = sg.base + r.d * sg.perMeter;
      const dEst = r.d * (1 + rng.gauss() * 0.25);
      const ux = (c.x - e.x) / (Math.hypot(c.x - e.x, c.z - e.z) || 1);
      const uz = (c.z - e.z) / (Math.hypot(c.x - e.x, c.z - e.z) || 1);
      K.suspicion = Math.min(1, K.suspicion + 0.5);
      K.observe(e.x + ux * dEst, e.z + uz * dEst, sLat, Math.max(sLat, r.d * 0.25), ux, uz, now, 'glimpse');
      a.onObservation?.('glimpse', {});
      this._logKnowledge(a, 'glimpse');
    }
    if (vis.evidence < vis.thrNotice * 0.5) vis.noticed = false;
  }

  /** 알아봄/계속 봄: 본 부위 위치(조준점), 위치 추정 갱신 */
  _seen(a, r, e, continuing) {
    const now = this.time;
    const tr = this.truth;
    const K = a.knowledge;
    const b = tr.body;
    const i = r.best >= 0 ? r.best : 1;
    const px = b.samples[i * 3];
    const py = b.samples[i * 3 + 1];
    const pz = b.samples[i * 3 + 2];
    // 눈으로 본 방향은 정확(작은 각 오차), 거리는 눈대중(숙련도별)
    const ang = VISION.sightBearingSigma;
    const hx0 = px - e.x;
    const hz0 = pz - e.z;
    const hd = Math.hypot(hx0, hz0) || 1;
    const ux = hx0 / hd;
    const uz = hz0 / hd;
    if (!continuing || !K.rangeBias || now - K.rangeBiasT > 20) {
      K.rangeBias = 1 + rng.gauss() * (a.rangeError || 0.15);
      K.rangeBiasT = now;
    }
    const nAng = rng.gauss() * ang;
    const cs = Math.cos(nAng);
    const sn = Math.sin(nAng);
    const vx = ux * cs - uz * sn;
    const vz = ux * sn + uz * cs;
    // 본 점(조준용): 각 오차만 — 거리 오차는 조준 앙각(사수 쪽)에서 따로 다룬다
    const seen = K.seenPoint || (K.seenPoint = { x: 0, y: 0, z: 0, d: 0, part: '' });
    seen.x = e.x + vx * hd;
    seen.z = e.z + vz * hd;
    seen.y = py + rng.gauss() * ang * hd;
    seen.d = hd;
    seen.part = b.groups[i].name;
    seen.t = now;
    // 속도 추정(연속 관측 차분, 오차 있음)
    if (continuing && K.prevSeen && now - K.prevSeen.t > 0.05) {
      const dtp = now - K.prevSeen.t;
      const k = Math.min(1, dtp / 0.6);
      K.vx += ((seen.x - K.prevSeen.x) / dtp - K.vx) * k;
      K.vz += ((seen.z - K.prevSeen.z) / dtp - K.vz) * k;
    } else {
      K.vx = 0;
      K.vz = 0;
    }
    K.prevSeen = { x: seen.x, z: seen.z, t: now };
    let dEst = hd * K.rangeBias;
    let sRad = Math.max(1, hd * Math.abs(K.rangeBias - 1) + hd * 0.03);
    const edge = this._edgeRange(e.x, e.z, vx, vz, dEst);
    if (edge) {
      dEst = edge.d;
      sRad = Math.min(sRad, edge.sRad);
    }
    if (!K.visible) {
      K.visible = true;
      K.visibleSince = now;
    }
    K.threat = true;
    K.suspicion = 1;
    K.observe(e.x + vx * dEst, e.z + vz * dEst, 0.5 + hd * ang * 2, sRad, vx, vz, now, 'sight');
    if (!continuing) a.onObservation?.('sight', {});
    this._logKnowledge(a, 'sight');
  }

  _logKnowledge(a, source) {
    if (!this.log) return;
    const p = this.truth.player;
    this.log.record(this.time, a, source, p.x, p.z);
  }

  /** 매 프레임: 소리 도착 처리, 시각 평가(예산 안에서 순번) */
  update(dt) {
    this.time += dt;
    const now = this.time;
    // 지연된 소리
    if (this.pending.length) {
      const keep = [];
      for (const ev of this.pending) {
        if (ev.at <= now) {
          if (ev.agent.canPerceive()) ev.fn();
        } else keep.push(ev);
      }
      this.pending = keep;
    }
    for (const a of this.agents) a.knowledge.grow(dt);
    // 시각: 갱신 주기가 지난 적 중 오래 기다린 순서로
    const tr = this.truth;
    if (!tr.body.alive) return;
    const c = tr.body.center;
    let budget = this.budgetEvals;
    const due = [];
    for (const a of this.agents) {
      if (!a.canPerceive()) continue;
      const d = Math.hypot(a.pos.x - c.x, a.pos.z - c.z);
      const period = a.knowledge.visible ? 0.12 : d < 150 ? 0.18 : d < 350 ? 0.3 : 0.6;
      const wait = now - a.vis.lastEval;
      if (wait >= period) due.push([wait / period, a]);
    }
    due.sort((x, y) => y[0] - x[0]);
    const t0 = performance.now();
    for (const [, a] of due) {
      if (budget-- <= 0) break;
      this.evaluate(a);
      this.stats.evals++;
    }
    this.stats.ms = performance.now() - t0;
  }
}
