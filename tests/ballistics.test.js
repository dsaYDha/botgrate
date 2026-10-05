// npm run test:ballistics
//
// 게임 탄도 엔진(src/physics/ballistics.js)을 그대로 불러 100~600 m 사거리표를 출력하고,
// 공개 자료와 비교해 오차 10% 이내인지 확인한다.
//
// 기준 자료
//  [A] RWS SS109 62gr 제조사 공개 탄도표(속도·비행시간, v0 925 m/s) — 직접 비교
//  [A'] 같은 표에서 고전 평사(flat-fire) 외탄도 항등식으로 유도한 낙차·편류 — 아래 설명
//  [C] 14.5in 총열 총구속도 905 m/s 조건: 질점 모델에서 속도-거리 관계는 자율계(dv/dx = -f(v))이므로
//      905 m/s 탄은 925 m/s 탄이 905 m/s까지 느려진 지점부터의 궤적과 같다 → [A] 표를 이동시켜 기준값 생성.
//
// 평사 항등식(McCoy, Modern Exterior Ballistics, 1999, 평사 근사 장):
//   발사선 기준 낙차 D(x) = g ∫₀ˣ (x − η) / u(η)² dη       (u: 수평 속도 ≈ 탄속)
//   횡풍 편류 Z(x) = W · (t(x) − x / V₀)                    (Didion의 지연시간 공식)

import {
  BallisticModel,
  computeTrajectory,
  solveZeroElevation,
  holdForRange,
  millerStability,
  spinDriftAccelCoeff,
  earthOmegaWorld,
} from '../src/physics/ballistics.js';
import { ATMOSPHERE } from '../src/data/atmosphere.js';
import { AMMO } from '../src/data/ammo.js';
import { WEAPONS } from '../src/data/weapons.js';
import { RWS_SS109, PUBLISHED_BC_G7, M4_MUZZLE_VELOCITY, PY_BALLISTICCALC_905 } from './reference/published556.js';
import { SB_762x39, AKM_MUZZLE_VELOCITY } from './reference/published762.js';
import { BulletSystem, isSupersonic } from '../src/physics/BulletSystem.js';
import { EventBus } from '../src/core/EventBus.js';

const TOL = 0.10; // 10%
const RANGES = [100, 200, 300, 400, 500, 600];
const CROSSWIND = 5.0; // m/s
const g = ATMOSPHERE.gravity;

let failures = 0;
const fails = [];

function check(label, sim, ref, { absTol = 0 } = {}) {
  const err = sim - ref;
  const rel = Math.abs(ref) > 1e-9 ? Math.abs(err / ref) : Infinity;
  const ok = Math.abs(err) <= absTol || rel <= TOL;
  if (!ok) {
    failures++;
    fails.push(`${label}: sim=${sim.toFixed(4)} ref=${ref.toFixed(4)} (${(rel * 100).toFixed(1)}%)`);
  }
  return { ok, rel, err };
}

// ---------------------------------------------------------------------------
// 공개 표 보간 (구간별 지수 보간: v(x) = v_i · (v_{i+1}/v_i)^((x−x_i)/Δx))
// ---------------------------------------------------------------------------
const pubX = RWS_SS109.rows.map((r) => r[0]);
const pubV = RWS_SS109.rows.map((r) => r[1]);
const pubT = RWS_SS109.rows.map((r) => r[3] / 1000);

function pubVelocity(x) {
  let i = 0;
  while (i < pubX.length - 2 && x > pubX[i + 1]) i++;
  // 600 m를 넘으면 마지막 구간의 감속률로 외삽
  const x0 = pubX[i];
  const x1 = pubX[i + 1];
  const k = Math.log(pubV[i + 1] / pubV[i]) / (x1 - x0);
  return pubV[i] * Math.exp(k * (x - x0));
}

// 1/v 적분으로 비행시간(공개 표 속도 곡선과 일관)
function pubTimeOfFlight(x, step = 0.05) {
  let t = 0;
  for (let s = 0; s < x; s += step) {
    const h = Math.min(step, x - s);
    t += (h / 6) * (1 / pubVelocity(s) + 4 / pubVelocity(s + h / 2) + 1 / pubVelocity(s + h));
  }
  return t;
}

// 거리 x0만큼 이동한 곡선(초속 v(x0)인 탄)에 대한 기준값
function derivedReference(x0, ranges, sightHeight, zeroRange) {
  const V0 = pubVelocity(x0);
  const t0 = pubTimeOfFlight(x0);
  const u = (x) => pubVelocity(x0 + x);
  const tof = (x) => pubTimeOfFlight(x0 + x) - t0;
  // D(x) = g ∫0^x (x−η)/u(η)² dη  (심프슨 적분)
  const drop = (x) => {
    const n = Math.max(200, Math.ceil(x / 0.5));
    const h = x / n;
    let sum = 0;
    for (let i = 0; i <= n; i++) {
      const eta = i * h;
      const f = (x - eta) / (u(eta) * u(eta));
      sum += f * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
    }
    return (g * h * sum) / 3;
  };
  const dz = drop(zeroRange);
  const slope = (sightHeight + dz) / zeroRange;
  return {
    V0,
    rows: ranges.map((x) => {
      const t = tof(x);
      const d = drop(x);
      return {
        range: x,
        v: u(x),
        t,
        drop: d,
        path: -sightHeight + slope * x - d,
        drift: CROSSWIND * (t - x / V0),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 엔진 설정
// ---------------------------------------------------------------------------
const ammo = AMMO['556x45_ball'];
const weapon = WEAPONS.carbine556;
if (Math.abs(ammo.bc - PUBLISHED_BC_G7) > 1e-9) {
  failures++;
  fails.push(`ammo.bc(${ammo.bc}) != 공개 G7 BC ${PUBLISHED_BC_G7}`);
}
if (Math.abs(weapon.muzzleVelocity - M4_MUZZLE_VELOCITY) > 1e-9) {
  failures++;
  fails.push(`weapon.muzzleVelocity(${weapon.muzzleVelocity}) != 공개값 ${M4_MUZZLE_VELOCITY}`);
}

const model = new BallisticModel({ dragModel: ammo.dragModel, bc: ammo.bc });
const windLeft = { x: 0, y: 0, z: CROSSWIND }; // 로컬 좌표 +z = 오른쪽: 왼쪽에서 불어오는 바람

function simulate(mv, sightHeight, zeroRange, wind = null, dt = 0.001) {
  const el = solveZeroElevation(model, { muzzleVelocity: mv, sightHeight, zeroRange, dt });
  const noWind = computeTrajectory(model, { muzzleVelocity: mv, elevation: el, sightHeight, ranges: RANGES, dt, spin: false });
  const withWind = computeTrajectory(model, {
    muzzleVelocity: mv,
    elevation: el,
    sightHeight,
    ranges: RANGES,
    dt,
    spin: false,
    wind: wind || windLeft,
  });
  return { el, rows: noWind.map((r, i) => ({ ...r, drift: withWind[i].z })) };
}

const pad = (s, n) => String(s).padStart(n);
const fmt = (x, d = 1) => (x >= 0 ? ' ' : '') + x.toFixed(d);
const pct = (r) => (r === Infinity ? '   -  ' : pad((r * 100).toFixed(1) + '%', 6));

// ---------------------------------------------------------------------------
// 1) 공개 탄도표 직접 비교 (v0 925 m/s)
// ---------------------------------------------------------------------------
console.log('\n=== [1] 제조사 공개 탄도표 직접 비교: RWS SS109 62gr, v0 925 m/s, G7 BC 0.151, ICAO 표준 대기 ===');
console.log(`    출처: ${RWS_SS109.source}`);
const SH = weapon.sights.iron.sightHeight;
const simRws = simulate(RWS_SS109.v0, SH, 100);
console.log(' 거리 |  속도 sim  공개   오차 | 비행시간 sim   공개    오차');
for (const r of simRws.rows) {
  const idx = pubX.indexOf(r.range);
  const cv = check(`[1] ${r.range}m 속도`, r.v, pubV[idx]);
  const ct = check(`[1] ${r.range}m 비행시간`, r.t, pubT[idx]);
  console.log(
    `${pad(r.range, 4)}m | ${pad(r.v.toFixed(0), 5)} ${pad(pubV[idx], 5)} ${pct(cv.rel)} |  ${r.t.toFixed(3)}s  ${pubT[idx].toFixed(3)}s ${pct(ct.rel)}`,
  );
}

// ---------------------------------------------------------------------------
// 2) 공개 표에서 유도한 낙차·편류 비교 (v0 925 m/s)
// ---------------------------------------------------------------------------
console.log('\n=== [2] 공개 표 + 평사 항등식으로 유도한 낙차·편류 비교 (v0 925, 영점 100 m, 조준선 높이 6.6 cm, 횡풍 5 m/s) ===');
const refRws = derivedReference(0, RANGES, SH, 100);
console.log(' 거리 | 조준선기준 탄착(cm) sim   기준   오차 | 발사선기준 낙차(cm) sim  기준  오차 | 편류(cm) sim  기준  오차');
for (let i = 0; i < RANGES.length; i++) {
  const s = simRws.rows[i];
  const r = refRws.rows[i];
  const cp = check(`[2] ${r.range}m 탄착점`, s.y * 100, r.path * 100, { absTol: 1.0 });
  const cd = check(`[2] ${r.range}m 낙차`, s.drop * 100, r.drop * 100);
  const cz = check(`[2] ${r.range}m 편류`, s.drift * 100, r.drift * 100);
  console.log(
    `${pad(r.range, 4)}m |        ${pad(fmt(s.y * 100), 7)} ${pad(fmt(r.path * 100), 7)} ${pct(cp.rel)} |      ${pad(fmt(s.drop * 100), 7)} ${pad(fmt(r.drop * 100), 7)} ${pct(cd.rel)} | ${pad(fmt(s.drift * 100), 6)} ${pad(fmt(r.drift * 100), 6)} ${pct(cz.rel)}`,
  );
}

// ---------------------------------------------------------------------------
// 3) 게임 소총(14.5in, 905 m/s) 사거리표 + 기준 비교
// ---------------------------------------------------------------------------
const MV = weapon.muzzleVelocity;
const optic = weapon.sights.optic4x;
// v_RWS(x0) = 905 인 x0
let lo = 0, hi = 100;
for (let i = 0; i < 60; i++) {
  const m = (lo + hi) / 2;
  if (pubVelocity(m) > MV) lo = m; else hi = m;
}
const x0 = (lo + hi) / 2;
const refGame = derivedReference(x0, RANGES, optic.sightHeight, 100);
const simGame = simulate(MV, optic.sightHeight, 100);
// BDC 눈금(조준선 대비 아래 각, mrad) — 게임과 같은 총구 앞쪽 거리 포함
const muzzleForward = -weapon.geometry.muzzle[2] - -optic.eye[2];
const zeroEl = solveZeroElevation(model, { muzzleVelocity: MV, sightHeight: optic.sightHeight, muzzleForward, zeroRange: 100 });

console.log(`\n=== [3] 게임 소총 사거리표: ${weapon.name}, 초속 ${MV} m/s, 62gr G7 0.151, 영점 100 m, 조준선 높이 ${(optic.sightHeight * 100).toFixed(1)} cm ===`);
console.log(`    기준값: [A] 표를 x0 = ${x0.toFixed(1)} m 이동(초속 ${MV} m/s 지점부터) + 평사 항등식`);
console.log(' 거리 | 탄착(cm, 조준선 기준)      | 비행시간(s)            | 잔존속도(m/s)      | 에너지 |  횡풍 5 m/s 편류(cm)      | 편류   | BDC');
console.log('      |   sim    기준    오차      |  sim    기준    오차   | sim  기준   오차   |  (J)   |  sim    기준    오차      | (mrad) | (mrad)');
for (let i = 0; i < RANGES.length; i++) {
  const s = simGame.rows[i];
  const r = refGame.rows[i];
  const cp = check(`[3] ${r.range}m 탄착점`, s.y * 100, r.path * 100, { absTol: 1.0 });
  const ct = check(`[3] ${r.range}m 비행시간`, s.t, r.t);
  const cv = check(`[3] ${r.range}m 잔존속도`, s.v, r.v);
  const cz = check(`[3] ${r.range}m 편류`, s.drift * 100, r.drift * 100);
  const e = 0.5 * ammo.mass * s.v * s.v;
  const hold = holdForRange(model, { muzzleVelocity: MV, sightHeight: optic.sightHeight, muzzleForward, zeroElevation: zeroEl, range: r.range });
  console.log(
    `${pad(r.range, 4)}m | ${pad(fmt(s.y * 100), 7)} ${pad(fmt(r.path * 100), 7)} ${pct(cp.rel)}   | ${s.t.toFixed(3)}  ${r.t.toFixed(3)} ${pct(ct.rel)}  | ${pad(s.v.toFixed(0), 4)} ${pad(r.v.toFixed(0), 4)} ${pct(cv.rel)} | ${pad(e.toFixed(0), 5)}  | ${pad(fmt(s.drift * 100), 6)} ${pad(fmt(r.drift * 100), 6)} ${pct(cz.rel)}   | ${pad((s.drift / r.range * 1000).toFixed(2), 5)}  | ${pad((hold * 1000).toFixed(2), 5)}`,
  );
}

// ---------------------------------------------------------------------------
// 3b) 독립 솔버 교차 검증(엄격 기준 2%, 0.5 cm)
// ---------------------------------------------------------------------------
console.log(`\n=== [3b] 독립 솔버 교차 검증: ${PY_BALLISTICCALC_905.source} ===`);
console.log(' 거리 | 탄착(cm) sim  py-bc | 비행시간 sim  py-bc | 속도 sim  py-bc | 편류(cm) sim  py-bc');
for (let i = 0; i < RANGES.length; i++) {
  const s = simGame.rows[i];
  const [R, py, pt, pv, pz] = PY_BALLISTICCALC_905.rows[i];
  const strict = (label, a, b, abs) => {
    const ok = Math.abs(a - b) <= abs || Math.abs((a - b) / b) <= 0.02;
    if (!ok) {
      failures++;
      fails.push(`[3b] ${R}m ${label}: sim=${a.toFixed(3)} py-bc=${b}`);
    }
  };
  strict('탄착', s.y * 100, py, 0.5);
  strict('비행시간', s.t, pt, 0.002);
  strict('속도', s.v, pv, 1);
  strict('편류', s.drift * 100, pz, 0.5);
  console.log(
    `${pad(R, 4)}m | ${pad(fmt(s.y * 100), 7)} ${pad(fmt(py), 7)} |   ${s.t.toFixed(3)}  ${pt.toFixed(3)} | ${pad(s.v.toFixed(1), 6)} ${pad(pv.toFixed(1), 6)} | ${pad(fmt(s.drift * 100), 7)} ${pad(fmt(pz), 7)}`,
  );
}

// ---------------------------------------------------------------------------
// 4) 수치 검증: 스텝 수렴, 영점 교차
// ---------------------------------------------------------------------------
console.log('\n=== [4] 수치 검증 ===');
const fine = simulate(MV, optic.sightHeight, 100, null, 0.00025);
let maxDiff = 0;
for (let i = 0; i < RANGES.length; i++) maxDiff = Math.max(maxDiff, Math.abs(fine.rows[i].y - simGame.rows[i].y));
console.log(`  dt 1 ms vs 0.25 ms 최대 탄착 차이: ${(maxDiff * 1000).toFixed(3)} mm`);
if (maxDiff > 0.001) {
  failures++;
  fails.push(`적분 수렴 실패: ${maxDiff} m`);
}
const z100 = computeTrajectory(model, { muzzleVelocity: MV, elevation: simGame.el, sightHeight: optic.sightHeight, ranges: [100], spin: false })[0].y;
console.log(`  100 m 영점 교차 오차: ${(z100 * 1000).toFixed(4)} mm, 총열 앙각 ${(simGame.el * 1000).toFixed(3)} mrad`);
if (Math.abs(z100) > 0.0005) {
  failures++;
  fails.push('영점 해 오차');
}

// ---------------------------------------------------------------------------
// 5) 참고: 게임 내 추가 효과(코리올리 + 스핀 드리프트), 북쪽 사격 기준
// ---------------------------------------------------------------------------
const sg = millerStability({
  massGrains: ammo.massGrains,
  diameterIn: ammo.diameter / 0.0254,
  lengthIn: ammo.length / 0.0254,
  twistIn: weapon.twistInches,
  velocityFps: MV / 0.3048,
});
const full = new BallisticModel({
  dragModel: ammo.dragModel,
  bc: ammo.bc,
  // 로컬 좌표(+x 사거리=북, +y 위, +z 오른쪽=동) 기준 자전 벡터: ENU (동,북,위) → (북, 위, 동)
  omega: (() => {
    const w = earthOmegaWorld(ATMOSPHERE.latitudeDeg, ATMOSPHERE.earthRotation); // (동, 위, 남)
    return [-w[2], w[1], w[0]];
  })(),
  spinDriftCoeff: spinDriftAccelCoeff(sg),
});
const fullRows = computeTrajectory(full, { muzzleVelocity: MV, elevation: simGame.el, sightHeight: optic.sightHeight, ranges: RANGES, spin: true });
console.log(`\n=== [5] 참고: 무풍, 북쪽 사격 시 코리올리(북위 ${ATMOSPHERE.latitudeDeg}°) + 스핀 드리프트(Sg ${sg.toFixed(2)}, 1:${weapon.twistInches} 우선회) ===`);
console.log(' 거리 | 수평 편차(cm, +오른쪽) | 수직 변화(cm)');
for (let i = 0; i < RANGES.length; i++) {
  console.log(`${pad(RANGES[i], 4)}m |        ${pad(fmt(fullRows[i].z * 100, 2), 7)}         | ${pad(fmt((fullRows[i].y - simGame.rows[i].y) * 100, 2), 7)}`);
}

// ---------------------------------------------------------------------------
// 6) 적 소총탄 7.62×39: 제조사 공개 탄도표 직접 비교(v0 738 m/s, G7 0.149)
// ---------------------------------------------------------------------------
const ammo762 = AMMO['762x39_ps'];
const rifle762 = WEAPONS.rifle762;
if (Math.abs(ammo762.bc - SB_762x39.bcG7) > 1e-9) {
  failures++;
  fails.push(`ammo762.bc(${ammo762.bc}) != 공개 G7 BC ${SB_762x39.bcG7}`);
}
if (Math.abs(rifle762.muzzleVelocity - AKM_MUZZLE_VELOCITY) > 1e-9) {
  failures++;
  fails.push(`rifle762.muzzleVelocity(${rifle762.muzzleVelocity}) != 제원 ${AKM_MUZZLE_VELOCITY}`);
}
const m762 = new BallisticModel({ dragModel: ammo762.dragModel, bc: ammo762.bc });
const R762 = [100, 200, 300, 400, 500, 600];
const sbX = SB_762x39.rows.map((r) => r[0]);
const sbV = SB_762x39.rows.map((r) => r[1]);
const sbVel = (x) => {
  let i = 0;
  while (i < sbX.length - 2 && x > sbX[i + 1]) i++;
  const k = Math.log(sbV[i + 1] / sbV[i]) / (sbX[i + 1] - sbX[i]);
  return sbV[i] * Math.exp(k * (x - sbX[i]));
};
const sbTof = (x, step = 0.05) => {
  let t = 0;
  for (let q = 0; q < x; q += step) {
    const h = Math.min(step, x - q);
    t += (h / 6) * (1 / sbVel(q) + 4 / sbVel(q + h / 2) + 1 / sbVel(q + h));
  }
  return t;
};
console.log(`\n=== [6] 적 소총탄 공개 탄도표 직접 비교: ${SB_762x39.source}, v0 ${SB_762x39.v0} m/s, G7 ${ammo762.bc} ===`);
console.log(`    출처: ${SB_762x39.url}`);
{
  const el = solveZeroElevation(m762, { muzzleVelocity: SB_762x39.v0, sightHeight: 0.055, zeroRange: 100 });
  const rows = computeTrajectory(m762, { muzzleVelocity: SB_762x39.v0, elevation: el, sightHeight: 0.055, ranges: [100, 200, 300], spin: false });
  console.log(' 거리 |  속도 sim  공개   오차 | 비행시간 sim  공개(속도 곡선 적분)  오차');
  for (const r of rows) {
    const ref = sbVel(r.range);
    const cv = check(`[6] ${r.range}m 속도`, r.v, ref);
    const ct = check(`[6] ${r.range}m 비행시간`, r.t, sbTof(r.range));
    console.log(`${pad(r.range, 4)}m | ${pad(r.v.toFixed(0), 5)} ${pad(ref.toFixed(0), 5)} ${pct(cv.rel)} |  ${r.t.toFixed(3)}s  ${sbTof(r.range).toFixed(3)}s ${pct(ct.rel)}`);
  }
}

// ---------------------------------------------------------------------------
// 7) 적 소총(715 m/s) 사거리표 + 음속 아래로 떨어지는 거리('딱'이 없어지는 거리)
// ---------------------------------------------------------------------------
{
  const MV7 = rifle762.muzzleVelocity;
  // 공개 표(738)를 715 m/s 지점부터 이동(자율계)한 기준: 738 → 715가 되는 거리 x0
  let lo7 = 0;
  let hi7 = 100;
  for (let i = 0; i < 60; i++) {
    const m = (lo7 + hi7) / 2;
    if (sbVel(m) > MV7) lo7 = m;
    else hi7 = m;
  }
  const x07 = (lo7 + hi7) / 2;
  const el = solveZeroElevation(m762, { muzzleVelocity: MV7, sightHeight: rifle762.sightHeight, zeroRange: rifle762.battleZero });
  const rows = computeTrajectory(m762, { muzzleVelocity: MV7, elevation: el, sightHeight: rifle762.sightHeight, ranges: R762, spin: false });
  const wind = computeTrajectory(m762, { muzzleVelocity: MV7, elevation: el, sightHeight: rifle762.sightHeight, ranges: R762, spin: false, wind: windLeft });
  console.log(`\n=== [7] 적 소총 사거리표: ${rifle762.name}, ${ammo762.name}, 초속 ${MV7} m/s, 전투 영점 ${rifle762.battleZero} m ===`);
  console.log(`    공개 표 비교 구간(300 m까지)은 [E] 표를 x0 = ${x07.toFixed(1)} m 이동한 기준(초속 ${MV7} m/s 지점부터)`);
  console.log(' 거리 | 탄착(cm, 조준선) | 비행시간 | 속도 sim  기준  오차 | 에너지(J) | 횡풍 5 m/s 편류(cm) | 초음속');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let refTxt = '   -    ';
    if (r.range + x07 <= 300) {
      const ref = sbVel(r.range + x07);
      const cv = check(`[7] ${r.range}m 속도`, r.v, ref);
      refTxt = `${pad(ref.toFixed(0), 4)} ${pct(cv.rel)}`;
    }
    const e = 0.5 * ammo762.mass * r.v * r.v;
    console.log(`${pad(r.range, 4)}m |      ${pad(fmt(r.y * 100), 7)}     |  ${r.t.toFixed(3)}s | ${pad(r.v.toFixed(0), 4)} ${refTxt} |  ${pad(e.toFixed(0), 6)}   |        ${pad(fmt(wind[i].z * 100), 6)}       |  ${isSupersonic(r.v) ? '예' : '아니오'}`);
  }
  // 음속 아래로 떨어지는 거리
  let tLo = 100;
  let tHi = 900;
  for (let i = 0; i < 40; i++) {
    const m = (tLo + tHi) / 2;
    const v = computeTrajectory(m762, { muzzleVelocity: MV7, elevation: el, sightHeight: rifle762.sightHeight, ranges: [m], spin: false })[0].v;
    if (isSupersonic(v)) tLo = m;
    else tHi = m;
  }
  const transonic = (tLo + tHi) / 2;
  console.log(`  음속(${ATMOSPHERE.speedOfSoundBallistic.toFixed(1)} m/s) 아래로 떨어지는 거리: ${transonic.toFixed(0)} m — 이보다 먼 곳을 지나는 탄은 '딱' 소리가 없다`);

  // 게임 탄 시스템(BulletSystem)으로 실제 확인: 청자 옆 3 m를 지나는 탄의 'bullet:flyby' 초음속 판정
  const fakeWorld = {
    terrain: { heightAt: () => -1000, normalAt: (x, z, o = [0, 1, 0]) => o, surfaceAt: () => 'stubble' },
    hash: { query: (a, b, c, d, out) => ((out.length = 0), out) },
    wind: { sample: (x, y, z, t, out) => ((out.x = out.y = out.z = 0), 0) },
  };
  console.log('  게임 탄 시스템으로 확인(청자 옆 3 m 통과):');
  const probes = [100, 300, Math.round(transonic - 30), Math.round(transonic + 30), 600];
  for (const D of probes) {
    const ev = new EventBus();
    const bs = new BulletSystem(fakeWorld, ev);
    bs.recordTrails = false;
    let got = null;
    ev.on('bullet:flyby', (f) => (got = f));
    bs.listener = () => ({ x: D, y: 1.5, z: 3 });
    // 거리 D에서 탄 높이가 청자 높이 근처가 되도록 앙각
    const elD = solveZeroElevation(m762, { muzzleVelocity: MV7, sightHeight: 0, zeroRange: D });
    bs.fire({ origin: { x: 0, y: 1.5, z: 0 }, dir: { x: Math.cos(elD), y: Math.sin(elD), z: 0 }, speed: MV7, ammo: ammo762, shooter: 'e1', spinSg: 1.6 });
    for (let k = 0; k < 4000 && !got; k++) bs.update(0.001, k * 0.001);
    const expect = D < transonic;
    const ok = got && got.supersonic === expect;
    if (!ok) {
      failures++;
      fails.push(`[7] ${D} m 통과 탄 초음속 판정 ${got ? got.supersonic : '없음'}, 기대 ${expect}`);
    }
    console.log(`    ${pad(D, 4)} m: 속도 ${got ? got.speed.toFixed(0) : '-'} m/s → ${got ? (got.supersonic ? "'딱'(초음속)" : "'휙'(아음속)") : '통과 안 함'}  ${ok ? '맞음' : '틀림'}`);
  }
}

console.log('');
if (failures > 0) {
  console.log(`실패 ${failures}건:`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('통과: 모든 항목이 공개 자료 기준 오차 10% 이내(5.56×45, 7.62×39).');
}
