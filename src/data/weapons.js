// 무기 데이터. 새 무기는 이 형식으로 항목을 추가하면 WeaponSystem이 그대로 다룬다.
//
// 무기 좌표계(W): 원점 = 개머리판 끝(어깨 견착점, 총열 축 연장선 위)
//   +x 오른쪽, +y 위, -z 총구 방향(Three.js 관례). 단위 m.

export const WEAPONS = {
  carbine556: {
    id: 'carbine556',
    name: '5.56mm 카빈 (14.5인치 총열)',
    ammoId: '556x45_ball',

    // --- 탄도 관련 실측값 ---
    barrelLength: 0.368, // 14.5 in
    muzzleVelocity: 905, // m/s, 14.5in 총열 + 62gr 보통탄 (미 육군 M4 제원 2,970 ft/s)
    twistInches: 7, // 1:7 우선회
    rightHandTwist: true,

    // --- 작동 ---
    rateOfFire: 750, // 발/분
    fireModes: ['semi', 'auto'],
    magazineCapacity: 30,
    magazinesCarried: 7, // 기본 휴대량: 삽입된 1개 포함 7개(210발)
    mass: 3.45, // kg, 장전·광학 포함 근사

    // --- 형상(무기 좌표계) ---
    geometry: {
      muzzle: [0, 0, -0.80], // 소염기 끝
      chamber: [0, 0, -0.39],
      ejectionPort: [0.014, 0.012, -0.355],
      grip: [0, -0.085, -0.30],
      supportHand: [0, -0.03, -0.53],
      magwell: [0, -0.05, -0.385],
      length: 0.80, // 개머리판~총구
      // 비조준(견착, 고개 든 상태) 시 카메라 기준 개머리판 위치
      readyOffset: [0.165, -0.215, 0.03],
      // 비조준 시 총열 축이 시선과 만나는 거리(m) — 지향사격 감각
      readyConvergence: 25,
      // 전력질주 시 총을 내린 자세(카메라 기준 위치, 피치/요/롤 rad)
      loweredOffset: [0.16, -0.32, -0.02],
      loweredRotation: [-0.75, 0.55, 0.35],
    },

    sights: {
      iron: {
        type: 'iron',
        name: '철제 조준기',
        sightHeight: 0.066, // 총열 축 ~ 조준선 (2.6 in)
        eye: [0, 0.066, -0.19],
        rear: [0, 0.066, -0.27],
        front: [0, 0.066, -0.64], // 가늠쇠 끝
        frontPostWidth: 0.0018, // 표준 A2 가늠쇠 0.072 in — 눈에서 0.45 m라 4 mrad(14 MOA): 110 m 밖 상체 폭(45 cm)을 다 가린다
        // 접이식 가늠자 두 구멍(V로 바꿈): 작은 구멍 = 정밀 조준(300 m 이상), 큰 구멍(0~2) = 근거리·어두울 때
        apertures: [
          { name: '작은 가늠자 구멍', diameter: 0.00175 }, // 0.069 in
          { name: '큰 가늠자 구멍(0~2)', diameter: 0.0051 }, // 0.2 in
        ],
      },
      optic4x: {
        type: 'optic',
        name: '고정 4배율 광학(BDC)',
        sightHeight: 0.068,
        eye: [0, 0.068, -0.222], // 아이릴리프 38 mm
        ocular: [0, 0.068, -0.26],
        objective: [0, 0.068, -0.41],
        magnification: 4,
        trueFovDeg: 7.0, // 4x32급 실시야
        eyeBox: 0.006, // 눈-광축 허용 오차(m): 이 이상 어긋나면 스코프 그림자
        bdc: {
          designZero: 100, // 레티클 중심 = 100 m 영점
          ranges: [300, 400, 500, 600, 700, 800],
          stadiaWidth: 0.48, // 각 눈금 폭 = 해당 거리에서 어깨폭 19 in
        },
      },
    },
    defaultSight: 'optic4x',
    zeroOptions: [50, 100, 200, 300],
    defaultZero: 100,

    // --- 조작 시간(s) ---
    handling: {
      adsTime: 0.34,
      sprintToReady: 0.42, // 질주 정지 후 사격 자세까지
      fireModeSwitch: 0.22,
      magCheck: 1.8,
    },

    // 재장전 단계 타임라인. events의 t는 시작 시점부터 초. 소리와 탄창 상태가 이 시점에 맞춰 바뀐다.
    reloads: {
      // 약실에 탄이 있는 상태, 쓰던 탄창을 파우치에 넣음
      tactical: {
        duration: 2.5,
        events: [
          { t: 0.18, type: 'magRelease' },
          { t: 0.32, type: 'magOut' },
          { t: 0.95, type: 'magStow' },
          { t: 1.2, type: 'magGrab' },
          { t: 1.78, type: 'magIn' },
          { t: 1.9, type: 'magSeat' },
        ],
      },
      // 쓰던 탄창을 버림
      speed: {
        duration: 1.65,
        events: [
          { t: 0.12, type: 'magRelease' },
          { t: 0.2, type: 'magDrop' },
          { t: 0.25, type: 'magGrab' },
          { t: 1.02, type: 'magIn' },
          { t: 1.12, type: 'magSeat' },
        ],
      },
      // 노리쇠 후퇴 고정 상태(탄 소진) — 쓰던 탄창 보관
      emptyTactical: {
        duration: 2.95,
        events: [
          { t: 0.18, type: 'magRelease' },
          { t: 0.32, type: 'magOut' },
          { t: 0.95, type: 'magStow' },
          { t: 1.2, type: 'magGrab' },
          { t: 1.78, type: 'magIn' },
          { t: 1.9, type: 'magSeat' },
          { t: 2.32, type: 'boltRelease' },
        ],
      },
      // 탄 소진 — 빈 탄창을 떨어뜨림
      emptySpeed: {
        duration: 2.15,
        events: [
          { t: 0.12, type: 'magRelease' },
          { t: 0.2, type: 'magDrop' },
          { t: 0.25, type: 'magGrab' },
          { t: 1.02, type: 'magIn' },
          { t: 1.12, type: 'magSeat' },
          { t: 1.52, type: 'boltRelease' },
        ],
      },
      longPressThreshold: 0.32, // R을 이 시간 이상 누르면 급속 재장전
      proneMultiplier: 1.4,
      kneelMultiplier: 1.05,
    },

    // --- 반동(자세별) ---
    // 자유 반동 충격량 J = m_b·v0 + m_powder·v_gas (v_gas ≈ 1.75·v0)
    // 총구 들림 각충격량 = J · leverArm,  각속도 ω0 = 그 / inertia
    // 회복은 감쇠 스프링(사수가 자연조준점으로 되돌림). residual은 조준점에 남는 몫:
    //   발당 잔여 상승 = residual × ω0 / (2π·freq) → 서서 약 2.7, 무릎 약 1.3, 엎드려 약 0.3 mrad.
    //   연발 10발(0.8 s)이면 서서 스프링 누적(~21 mrad)과 합쳐 약 50 mrad(25 m에서 1.2 m) 상승.
    recoil: {
      gasVelocityFactor: 1.75,
      stances: {
        stand: { leverArm: 0.055, inertia: 0.52, freq: 3.2, damping: 0.72, residual: 0.08, yawRatio: 0.42, yawBias: 0.12 },
        crouch: { leverArm: 0.045, inertia: 0.6, freq: 3.6, damping: 0.75, residual: 0.06, yawRatio: 0.36, yawBias: 0.1 },
        prone: { leverArm: 0.03, inertia: 0.75, freq: 4.5, damping: 0.8, residual: 0.035, yawRatio: 0.3, yawBias: 0.06 },
      },
      // 시각용: 총 모델 후퇴(m)와 카메라 흔들림(rad)
      modelKick: 0.028,
      cameraShake: 0.006,
    },

    // --- 조준 흔들림(자세별). 단위 MOA(1 MOA = 0.291 mrad, 300 m에서 8.7 cm) ---
    // hold: 숨을 참거나 호흡 정지기에 쏠 때의 '흔들림 영역' — 느린 표류의 축별 표준편차.
    //   90 % 원 지름 ≈ 4.3 × hold(맥박·떨림 포함 실측은 test:accuracy) → 엎드려 약 3.6, 무릎 7, 서서 14.5 MOA.
    //   rested: 거치했을 때(엎드려 약 2, 무릎 4, 서서 6.5 MOA).
    //   근거: 사격 교육 기준(엎드려 2, 무릎·앉아 5(거치 3), 서서 7 MOA 안팎 — 숙련자)과 일반 병사 수준을 함께 본 값.
    // corr: 표류 상관 시간(s) — 서서는 빨리, 엎드려는 천천히 떠돈다.
    // breath: 숨 쉴 때 상하 진폭(MOA, 날숨 끝에 잠깐 멈춤). pulse: 맥박 튐 진폭. tremor: 미세 떨림.
    // fatigueRate: 거치 없이 fatigueOnset(10 s) 넘게 조준하면 초당 흔들림 증가율(팔 피로).
    sway: {
      stances: {
        stand: { hold: 3.25, rested: 1.45, corr: 0.7, breath: 3.2, pulse: 0.35, tremor: 0.25, fatigueRate: 0.04 },
        crouch: { hold: 1.55, rested: 0.88, corr: 0.9, breath: 2.0, pulse: 0.3, tremor: 0.15, fatigueRate: 0.025 },
        prone: { hold: 0.82, rested: 0.4, corr: 1.3, breath: 1.2, pulse: 0.28, tremor: 0.08, fatigueRate: 0 },
      },
      restedBreath: 0.55, // 거치하면 호흡이 총을 덜 움직인다
      fatigueOnset: 10, // s
      fatigueMax: 1.0, // 최대 +100 %
      fatigueRecover: 1.5, // 조준을 풀거나 거치하면 누적 시간이 초당 1.5 s씩 줄어듦
      exertion: 1.75, // 심박 상승(0~1)에 따른 배수 1 + 1.75·ex → 10 s 질주 직후(ex≈0.7) 약 2.2배, 최대 2.75배
      moving: 9, // 조준하고 걸을 때(1.5 m/s) 걸음 흔들림 진폭(MOA)
      notShouldered: 2.2, // 비조준(견착만) 시 배수
      holdBreath: {
        stableTime: 5.0, // 이 시간까지 안정
        maxTime: 11.0, // 이후 강제로 숨을 내쉼
        exertionCut: 0.55, // 숨이 찰수록 참을 수 있는 시간이 줄어듦(질주 직후 약 60 %)
        breathScale: 0.08, // 숨 참는 동안 남는 호흡 흔들림(가슴 움직임만 멈춘다)
        wanderOvertime: 1.6, // 한계 시간에 이르면 표류 배수(숨 참기는 표류를 없애지 못한다)
        overtimeTremor: 0.6, // 안정 시간 초과 후 떨림 증가율(MOA/s)
        recovery: 4.0, // 숨 참기 후 거친 호흡 지속(s)
      },
      // 급한 격발: 이전 발 뒤 hasteWindow 안에 방아쇠를 당기면 격발 때 총이 흔들림(침착하면 0)
      trigger: { hasteWindow: 0.45, jerk: { stand: 2.2, crouch: 1.4, prone: 0.9 }, restedScale: 0.6, biasLeft: 0.35, biasLow: 0.5 },
      // 눈 위치 어긋남(m, 광학 아이박스 6 mm 기준): 조준 직후·자세 전환·이동·반동·숨 가쁨
      eye: { settleStart: 0.009, settle: 0.32, settleProne: 0.22, move: 0.004, exertion: 0.0018, recoil: 0.007 },
    },

    // --- 총열 과열: 평균 온도 상승(°C)과 냉각, 분산·탄착점 변화 ---
    // 발당 약 2.6 °C(장약 에너지의 일부가 총열로, 14.5인치 총열 질량 기준 추정), 냉각 시정수 10분.
    // 50 °C 넘게 오르면 분산이 °C당 0.4 % 커지고(최대 +60 %) 탄착점이 °C당 0.005 MOA씩 한쪽으로 이동.
    barrel: { ambient: 15, heatPerShot: 2.6, coolTau: 600, dispersionFrom: 50, dispersionPerDeg: 0.004, dispersionMax: 0.6, shiftPerDeg: 0.005 },

    // --- 연출 ---
    muzzleFlash: { size: 0.09, duration: 0.03 },
    ejection: { speed: 3.6, spread: 0.35, direction: [0.85, 0.25, 0.2] }, // 무기 좌표계 방향
  },
};

export const DEFAULT_WEAPON = 'carbine556';
