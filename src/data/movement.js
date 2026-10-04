// 플레이어(전투 장비 착용 보병) 이동·자세·생리 데이터.

export const MOVEMENT = {
  eyeHeight: { stand: 1.65, crouch: 1.1, prone: 0.3 },
  speeds: {
    walk: 1.5,
    run: 3.5,
    sprint: 6.0,
    crouch: 1.0,
    prone: 0.4,
  },
  backwardFactor: 0.65,
  strafeFactor: 0.85,
  accel: 7.0, // 속도 변화 반응(1/s)
  // 자세 전환 시간(s)
  stanceTimes: {
    'stand>crouch': 0.45,
    'crouch>stand': 0.55,
    'crouch>prone': 0.75,
    'prone>crouch': 0.95,
    'stand>prone': 1.0,
    'prone>stand': 1.45,
  },
  // 기울이기: 머리 옆 이동(m), 롤(rad)
  lean: {
    stand: { offset: 0.3, roll: 0.2 },
    crouch: { offset: 0.26, roll: 0.18 },
    prone: { offset: 0.14, roll: 0.08 },
    time: 0.32,
  },
  capsuleRadius: 0.3,
  stepHeight: 0.45,
  // 엎드린 자세: 몸 방향 회전 속도 제한과 조준 범위
  proneTurnRate: 1.1, // rad/s
  pitchLimits: {
    stand: [-1.35, 1.35],
    crouch: [-1.3, 1.3],
    prone: [-0.3, 0.42],
  },
  stamina: {
    sprintSeconds: 13, // 완충 상태에서 전력질주 지속(10~15 s)
    regenPerSec: 1 / 24,
    regenStillPerSec: 1 / 14,
    minToSprint: 0.12,
  },
  heart: {
    rest: 72,
    max: 178,
    sprintRise: 7.5, // bpm/s
    runRise: 1.4,
    crawlRise: 0.9,
    tau: 38, // 회복 시정수(s) — 수십 초
  },
  breathing: {
    restPeriod: 4.0, // s
    minPeriod: 1.6,
  },
  headBob: {
    walk: 0.018,
    run: 0.035,
    sprint: 0.05,
  },
};
