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

// 판정(요청서 대략 목표, '안팎'을 넓게 봄)
const i300 = RANGES.indexOf(300);
const checks = [
  ['엎드려 거치 300 m가 80~95 %', results['엎드려 거치'].hits[i300] >= 0.8 && results['엎드려 거치'].hits[i300] <= 0.95],
  ['서서 300 m가 35 % 이하', results['서서'].hits[i300] <= 0.35],
  ['질주 직후 서서 300 m가 5~15 %', results['질주 직후 서서'].hits[i300] >= 0.05 && results['질주 직후 서서'].hits[i300] <= 0.15],
  ['자세 순서(거치 > 엎드려 > 무릎 > 서서 > 질주 직후)', RANGES.every((_, i) => CONDS.every((c, k) => k === 0 || results[CONDS[k - 1].name].hits[i] >= results[c.name].hits[i] - 0.02))],
];
console.log('');
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? '통과' : '실패'}: ${label}`);
  ok = ok && pass;
}
process.exit(ok ? 0 : 1);
