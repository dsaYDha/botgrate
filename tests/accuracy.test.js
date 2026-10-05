// npm run test:accuracy
//
// '완벽한 조준 의도'(거리·바람·리드를 정확히 아는 가상 사수)에 게임의 사람 흔들림(src/weapon/AimModel.js)과
// 총+탄 분산(ammo.dispersionSigmaMoa, 탄간 총구속도 편차)만 적용해, 정지한 상체 크기 표적(폭 45 cm × 높이 50 cm)
// 명중률을 자세 × 거리 표로 출력한다.
//
// 가상 사수의 사격 절차(게임 조작과 같은 순서):
//   조준(0.34 s, 질주 직후는 총을 드는 0.42 s 추가) → 숨 고르기 → 숨 참기(Shift) →
//   숨 참기 안정 구간 안 무작위 순간에 격발. 흔들림이 표적을 지나는 순간을 노려 서둘러 당기지 않는다(= 방아쇠 흔들림 없음).
// 이 표는 '완벽한 판단' 기준이다. 실제 플레이어는 거리 추정·바람·리드·노출 시간 때문에 훨씬 낮다.
//
// 대략 목표(요청서): 엎드려 거치 300 m 80~90 % 안팎, 서서 300 m 30 % 안팎 이하, 질주 직후 서서 300 m 10 % 안팎.

import { AimModel, MOA } from '../src/weapon/AimModel.js';
import { WEAPONS, DEFAULT_WEAPON } from '../src/data/weapons.js';
import { AMMO } from '../src/data/ammo.js';
import { MOVEMENT } from '../src/data/movement.js';
import { BallisticModel, computeTrajectory, solveZeroElevation } from '../src/physics/ballistics.js';
import { rng } from '../src/core/Random.js';
import { Shooter, holdFor } from '../src/ai/Shooter.js';

const W = WEAPONS[DEFAULT_WEAPON];
const A = AMMO[W.ammoId];
const RANGES = [100, 200, 300, 400];
const TARGET = { w: 0.45, h: 0.5 };
const N = Number(process.env.ACC_TRIALS || 4000);
const DT = 1 / 120;
rng.s = 20261004; // 같은 결과가 나오게

const H = MOVEMENT.heart;
const exertionOf = (hr) => Math.min(1, Math.max(0, (hr - H.rest) / (H.max - H.rest)));
const breathRateOf = (ex) => 1 / (MOVEMENT.breathing.restPeriod + (MOVEMENT.breathing.minPeriod - MOVEMENT.breathing.restPeriod) * Math.pow(ex, 0.8));
// 10 s 질주 직후 심박: 휴식 72 + 7.5 bpm/s × 10 s
const SPRINT_HR = H.rest + H.sprintRise * 10;

const CONDS = [
  { name: '엎드려 거치', stance: 'prone', rest: 'ground' },
  { name: '엎드려', stance: 'prone' },
  { name: '무릎', stance: 'crouch' },
  { name: '서서', stance: 'stand' },
  { name: '질주 직후 서서', stance: 'stand', hr0: SPRINT_HR, raise: W.handling.sprintToReady },
];
// 비교용(300 m): 숨 참기·팔 피로·급한 연속 사격의 효과
const EXTRA = [
  { name: '엎드려, 숨 참지 않음', stance: 'prone', noHold: true },
  { name: '서서, 숨 참지 않음', stance: 'stand', noHold: true },
  { name: '서서, 25 s 조준 유지(팔 피로)', stance: 'stand', hold0: 25 },
  { name: '엎드려, 0.15 s 간격 연속 격발', stance: 'prone', haste: 1 - 0.15 / W.sway.trigger.hasteWindow },
];

// 총구속도 편차 → 거리별 상하 변화(m per m/s)
const model = new BallisticModel({ dragModel: A.dragModel, bc: A.bc });
const geom = { sightHeight: W.sights.optic4x.sightHeight, muzzleForward: W.sights.optic4x.eye[2] - W.geometry.muzzle[2] };
const el = solveZeroElevation(model, { muzzleVelocity: W.muzzleVelocity, ...geom, zeroRange: 100 });
const yAt = (v) => computeTrajectory(model, { muzzleVelocity: v, elevation: el, ...geom, ranges: RANGES, spin: false }).map((r) => r.y);
const y0 = yAt(W.muzzleVelocity);
const y1 = yAt(W.muzzleVelocity + 10);
const dydv = y0.map((y, i) => (y1[i] - y) / 10);

/** 한 발: 사람 흔들림 + 총·탄 분산을 합친 각도 오차(rad)와 총구속도 편차(m/s) */
function shoot(c) {
  const aim = new AimModel(W, A, null);
  const hr0 = c.hr0 || H.rest + 4;
  const raise = c.raise || 0;
  const adsTime = W.handling.adsTime;
  const holdStart = raise + adsTime + (c.hr0 ? 0.6 : 1.0) + rng.range(0, 0.6);
  aim.aimTime = c.hold0 || 0; // 이미 오래 조준하고 있었던 경우(팔 피로)
  let fireAt;
  let t = 0;
  for (let guard = 0; guard < 4000; guard++) {
    const hr = H.rest + (hr0 - H.rest) * Math.exp(-t / H.tau);
    const ex = exertionOf(hr);
    const ads = Math.min(1, Math.max(0, (t - raise) / adsTime));
    if (!c.noHold && t >= holdStart && !aim.hold.active && fireAt === undefined) {
      aim.setHoldBreath(true);
      // 안정 구간(숨이 찰수록 짧다) 안 무작위 순간
      const stable = W.sway.holdBreath.stableTime * (1 - W.sway.holdBreath.exertionCut * ex);
      fireAt = t + rng.range(Math.min(1.0, stable * 0.4), Math.max(Math.min(4.0, stable) - 0.1, Math.min(1.0, stable * 0.4) + 0.2));
    }
    if (c.noHold && fireAt === undefined && t >= holdStart) fireAt = t + rng.range(0, 1 / breathRateOf(ex));
    aim.update(DT, {
      stance: c.stance,
      ads,
      exertion: ex,
      heartRate: hr,
      breathRate: breathRateOf(ex),
      stamina: 1,
      speed: 0,
      rest: c.rest || null,
    });
    t += DT;
    if (fireAt !== undefined && t >= fireAt) break;
  }
  let yaw = aim.yaw;
  let pitch = aim.pitch;
  if (c.haste) {
    const [jy, jp] = aim.triggerJerk(c.stance, c.haste, !!c.rest);
    yaw += jy;
    pitch += jp;
  }
  const sd = A.dispersionSigmaMoa * MOA;
  return { yaw: yaw + rng.gauss() * sd, pitch: pitch + rng.gauss() * sd, dv: rng.gauss() * A.muzzleVelocitySD, holdYaw: aim.yaw, holdPitch: aim.pitch };
}

function run(c) {
  const shots = [];
  for (let i = 0; i < N; i++) shots.push(shoot(c));
  const hits = RANGES.map((R, i) => {
    let n = 0;
    for (const s of shots) {
      const x = s.yaw * R;
      const y = s.pitch * R + s.dv * dydv[i];
      if (Math.abs(x) <= TARGET.w / 2 && Math.abs(y) <= TARGET.h / 2) n++;
    }
    return n / shots.length;
  });
  // 흔들림 영역(사람만): 축별 표준편차와 90 % 원 지름(MOA)
  const my = shots.reduce((a, s) => a + s.holdYaw, 0) / N;
  const mp = shots.reduce((a, s) => a + s.holdPitch, 0) / N;
  const sy = Math.sqrt(shots.reduce((a, s) => a + (s.holdYaw - my) ** 2, 0) / N) / MOA;
  const sp = Math.sqrt(shots.reduce((a, s) => a + (s.holdPitch - mp) ** 2, 0) / N) / MOA;
  const rr = shots.map((s) => Math.hypot(s.holdYaw - my, s.holdPitch - mp) / MOA).sort((a, b) => a - b);
  const d90 = 2 * rr[Math.floor(N * 0.9)];
  return { hits, sy, sp, d90 };
}

const pct = (v) => `${(v * 100).toFixed(0)}%`.padStart(5);
console.log(`명중률 — 정지한 상체 표적 ${TARGET.w * 100}×${TARGET.h * 100} cm, 완벽한 거리·바람·리드 판단, 표본 ${N}발`);
console.log(`총+탄 분산 축별 ${A.dispersionSigmaMoa} MOA(5발 군집 평균 ${(A.dispersionSigmaMoa * 3.08).toFixed(1)} MOA), 총구속도 편차 ${A.muzzleVelocitySD} m/s\n`);
console.log(`${'자세'.padEnd(14)}  흔들림 영역(90 % 지름)   ${RANGES.map((r) => `${r} m`.padStart(6)).join('')}`);
const results = {};
for (const c of CONDS) {
  const r = run(c);
  results[c.name] = r;
  console.log(`${c.name.padEnd(14)}  ${r.d90.toFixed(1).padStart(5)} MOA (σ ${r.sy.toFixed(2)}/${r.sp.toFixed(2)})   ${r.hits.map((h) => pct(h).padStart(6)).join('')}`);
}
console.log('\n비교(300 m)');
for (const c of EXTRA) {
  const r = run(c);
  console.log(`  ${c.name.padEnd(28)}  흔들림 ${r.d90.toFixed(1).padStart(5)} MOA   명중 ${pct(r.hits[2])}`);
}

// ---------------------------------------------------------------------------
// 적 사수: 게임의 적 소총 코드(src/ai/Shooter.js)를 그대로 쓴다 — 같은 AimModel(같은 자세별 흔들림 표)
// × 숙련도 배율, 총+탄 분산, 조준 시간 뒤 격발(멀면 숨 참기). 거리·바람·리드는 완벽하다고 둔다(rangeBias 1).
const E_RANGES = RANGES;
const W762 = WEAPONS.rifle762;
const A762 = AMMO[W762.ammoId];
const m762 = new BallisticModel({ dragModel: A762.dragModel, bc: A762.bc });
const dydv762 = (() => {
  const yv = (v) => E_RANGES.map((R) => {
    const el = solveZeroElevation(m762, { muzzleVelocity: W762.muzzleVelocity, sightHeight: 0, zeroRange: R });
    return computeTrajectory(m762, { muzzleVelocity: v, elevation: el, sightHeight: 0, ranges: [R], spin: false })[0].y;
  });
  const a = yv(W762.muzzleVelocity);
  const b = yv(W762.muzzleVelocity + 10);
  return a.map((y, i) => (b[i] - y) / 10);
})();

/** 적 한 발: 발사 방향과 이상적 방향(정확히 겨눈 방향)의 차이(rad)와 총구속도 편차 */
function enemyShot(stance, R, skillSway, dispersionMoa, mvSD) {
  const enemy = { x: 0, z: 0, y: 0, stance: stance === 'crouch' ? 'kneel' : stance, rifleHeld: true, clutch: null, muzzleWorld: (o) => ((o.x = 0), (o.y = 1.5), (o.z = 0), o) };
  let fired = null;
  const bullets = { fire: (o) => ((fired = o), { id: 1 }) };
  const sh = new Shooter(enemy, { bullets, events: { emit() {} } }, { sway: skillSway, reaction: 1 });
  sh.dispersionMoa = dispersionMoa;
  sh.mvSD = mvSD;
  sh.heart = H.rest + 4;
  sh.wantRaise = true;
  sh.setTarget({ x: 0, y: 1.5, z: -R, mode: 'aimed', rangeBias: 1 });
  for (let k = 0; k < 2000 && !fired; k++) {
    sh.update(DT, { stance, speed: 0, supp: 0, rest: null, wound: 1 });
    sh.time += 0; // update가 시간을 진행
    sh.tryFire(true);
  }
  if (!fired) return null;
  const d = fired.dir;
  const yaw = Math.atan2(d.x, -d.z);
  const pitch = Math.asin(d.y) - holdFor(R);
  return { yaw, pitch, dv: fired.speed - W762.muzzleVelocity, swayY: sh.aim.yaw * sh.swayMul, swayP: sh.aim.pitch * sh.swayMul };
}

function enemyRun(stance, skillSway, dispersionMoa, mvSD, dydvTab) {
  const n = Math.max(500, Math.floor(N / 2));
  const shots = [];
  for (let i = 0; i < n; i++) {
    const s = enemyShot(stance, 300, skillSway, dispersionMoa, mvSD);
    if (s) shots.push(s);
  }
  const hits = E_RANGES.map((R, i) => {
    let k = 0;
    for (const s of shots) {
      const x = s.yaw * R;
      const y = s.pitch * R + s.dv * dydvTab[i];
      if (Math.abs(x) <= TARGET.w / 2 && Math.abs(y) <= TARGET.h / 2) k++;
    }
    return k / shots.length;
  });
  const my = shots.reduce((a, s) => a + s.swayY, 0) / shots.length;
  const mp = shots.reduce((a, s) => a + s.swayP, 0) / shots.length;
  const rr = shots.map((s) => Math.hypot(s.swayY - my, s.swayP - mp) / MOA).sort((a, b) => a - b);
  return { hits, d90: 2 * rr[Math.floor(rr.length * 0.9)] };
}

console.log('\n적 사수 — 게임 적 소총 코드(src/ai/Shooter.js), 같은 사람 흔들림 표 × 숙련도 배율, 완벽한 판단');
console.log(`  같은 모델 확인: 적(숙련 1.0)에게 플레이어 총+탄 분산(${A.dispersionSigmaMoa} MOA)을 주면 플레이어 표와 같아야 한다`);
console.log(`${'자세'.padEnd(10)} 흔들림 Ø90 플레이어/적   ${E_RANGES.map((r) => `${r} m`.padStart(6)).join('')}   (플레이어 → 적, 명중률)`);
const eqChecks = [];
const stanceRows = [
  ['엎드려', 'prone', '엎드려'],
  ['무릎', 'crouch', '무릎'],
  ['서서', 'stand', '서서'],
];
for (const [label, st, key] of stanceRows) {
  const pr = results[key];
  const er = enemyRun(st, 1.0, A.dispersionSigmaMoa, A.muzzleVelocitySD, dydv);
  eqChecks.push({ label, pr, er });
  console.log(`${label.padEnd(10)} ${pr.d90.toFixed(1).padStart(5)} / ${er.d90.toFixed(1).padStart(5)} MOA     ${E_RANGES.map((_, i) => `${pct(pr.hits[i])}→${pct(er.hits[i]).trim()}`.padStart(12)).join('')}`);
}
console.log(`\n  적 소총(${A762.name}, 축별 ${A762.dispersionSigmaMoa} MOA) — 숙련도 배율별 명중률`);
console.log(`${'자세'.padEnd(10)} ${'숙련(흔들림 배율)'.padEnd(14)} ${E_RANGES.map((r) => `${r} m`.padStart(6)).join('')}`);
const skillRows = {};
for (const [label, st] of stanceRows) {
  for (const sk of [0.8, 1.0, 1.5]) {
    const er = enemyRun(st, sk, A762.dispersionSigmaMoa, A762.muzzleVelocitySD, dydv762);
    skillRows[`${label}${sk}`] = er;
    console.log(`${label.padEnd(10)} ${('×' + sk.toFixed(1)).padEnd(14)} ${er.hits.map((h) => pct(h).padStart(6)).join('')}`);
  }
}

// 판정(요청서 대략 목표, '안팎'을 넓게 봄)
const i300 = RANGES.indexOf(300);
const checks = [
  ['엎드려 거치 300 m가 80~95 %', results['엎드려 거치'].hits[i300] >= 0.8 && results['엎드려 거치'].hits[i300] <= 0.95],
  ['서서 300 m가 35 % 이하', results['서서'].hits[i300] <= 0.35],
  ['질주 직후 서서 300 m가 5~15 %', results['질주 직후 서서'].hits[i300] >= 0.05 && results['질주 직후 서서'].hits[i300] <= 0.15],
  ['자세 순서(거치 > 엎드려 > 무릎 > 서서 > 질주 직후)', RANGES.every((_, i) => CONDS.every((c, k) => k === 0 || results[CONDS[k - 1].name].hits[i] >= results[c.name].hits[i] - 0.02))],
  ['적(숙련 1.0, 같은 분산) 흔들림 Ø90이 플레이어와 같음(±12 %)', eqChecks.every((q) => Math.abs(q.er.d90 / q.pr.d90 - 1) <= 0.12)],
  ['적(숙련 1.0, 같은 분산) 명중률이 플레이어와 같음(±6 %p)', eqChecks.every((q) => q.pr.hits.every((h, i) => Math.abs(h - q.er.hits[i]) <= 0.06))],
  ['적 명중률은 숙련도 순서(×0.8 ≥ ×1.0 ≥ ×1.5)', stanceRows.every(([l]) => E_RANGES.every((_, i) => skillRows[l + 0.8].hits[i] >= skillRows[l + 1].hits[i] - 0.03 && skillRows[l + 1].hits[i] >= skillRows[l + 1.5].hits[i] - 0.03))],
];
console.log('');
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? '통과' : '실패'}: ${label}`);
  ok = ok && pass;
}
process.exit(ok ? 0 : 1);
