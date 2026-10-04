// 탄 관통·편향 재질 표.
//
// solid(고체): 관통 능력 P(v) = penetration × (v / vRef)^exponent  [m]
//   경로 길이 L(현 길이)이 P(v)보다 작으면 관통, 잔여 능력으로 출구 속도 역산:
//   v_out = vRef × ((P(v_in) − L) / penetration)^(1/exponent)
//   관통 후 무작위 편향(deflectionDeg × (L/P)^0.5)과 요동(텀블링: 이후 항력 배수 증가)
// volume(잎·덤불 볼륨): 1 m 당 속도 손실 + 잔가지 타격(포아송 과정) 시 편향·감속
//
// 수치 근거와 타협은 REALISM_NOTES.md 참고.

export const MATERIALS = {
  soil: {
    kind: 'solid',
    penetration: 0.35,
    exponent: 1.0,
    deflectionDeg: 0,
    ricochetCriticalDeg: 7.5, // 이보다 얕은 각도로 맞으면 도탄 가능
    ricochetChance: 0.75,
    effect: 'dust',
    sound: 'impactDirt',
  },
  woodSoft: {
    // 포플러: 무르고 함수율 높은 생목
    kind: 'solid',
    penetration: 0.15,
    exponent: 1.5,
    deflectionDeg: 9,
    tumbleDrag: 2.6,
    effect: 'bark',
    sound: 'impactWood',
  },
  woodMedium: {
    // 느릅나무
    kind: 'solid',
    penetration: 0.12,
    exponent: 1.5,
    deflectionDeg: 10,
    tumbleDrag: 2.6,
    effect: 'bark',
    sound: 'impactWood',
  },
  woodHard: {
    // 아까시나무: 단단하고 치밀
    kind: 'solid',
    penetration: 0.1,
    exponent: 1.5,
    deflectionDeg: 11,
    tumbleDrag: 2.6,
    effect: 'bark',
    sound: 'impactWood',
  },
  woodDead: {
    // 마르고 갈라진 고사목
    kind: 'solid',
    penetration: 0.18,
    exponent: 1.5,
    deflectionDeg: 8,
    tumbleDrag: 2.4,
    effect: 'bark',
    sound: 'impactWood',
  },
  flesh: {
    // 연조직: 소총탄은 요동하며 대략 일정한 깊이를 관통
    kind: 'solid',
    penetration: 0.42,
    exponent: 1.0,
    deflectionDeg: 7,
    tumbleDrag: 3.0,
    effect: 'hit',
    sound: 'impactBody',
  },
  hay: {
    // 둥글게 꽉 말린 짚 더미(밀도 약 120~180 kg/m³). 실제 사례: 5.56은 작은 사각 짚단(45 cm)은 뚫고
    // 큰 원형 더미(지름 1.5 m)는 가운데에서 대개 멈춘다. 7.62 보통탄은 원형 더미 하나를 관통.
    // → 900 m/s 관통 1.25 m: 가운데(1.5 m)는 막히고, 가장자리 현은 느려져서 나간다.
    kind: 'solid',
    penetration: 1.25,
    exponent: 1.2,
    deflectionDeg: 6,
    tumbleDrag: 3.0,
    effect: 'straw',
    sound: 'impactDirt',
  },
  foliage: {
    // 수관(잎·잔가지)
    kind: 'volume',
    lossPerMeter: 0.0035,
    twigRatePerMeter: 0.16,
    twigDeflectDeg: 1.6,
    twigSpeedLoss: 0.05,
    effect: 'leaves',
    sound: 'impactLeaves',
  },
  stubbleCover: {
    // 밀 그루터기(줄기 지름 3~4 mm, 약 400개/m², 높이 10~20 cm): n·d ≈ 1.4회/m, 맞아도 거의 안 꺾임
    kind: 'volume',
    lossPerMeter: 0.002,
    twigRatePerMeter: 1.4,
    twigDeflectDeg: 0.15,
    twigSpeedLoss: 0.002,
    effect: 'straw',
    sound: 'impactLeaves',
  },
  weeds: {
    // 휴경지·숲 가장자리 잡초(줄기 5~10 mm, 수십 개/m²)
    kind: 'volume',
    lossPerMeter: 0.003,
    twigRatePerMeter: 0.25,
    twigDeflectDeg: 0.5,
    twigSpeedLoss: 0.005,
    effect: 'leaves',
    sound: 'impactLeaves',
  },
  sunflower: {
    // 마른 해바라기(줄기 지름 2.5~3 cm, 줄 간격 70 cm × 포기 간격 30 cm ≈ 4.8포기/m²): n·d ≈ 0.14회/m
    kind: 'volume',
    lossPerMeter: 0.004,
    twigRatePerMeter: 0.14,
    twigDeflectDeg: 2.0,
    twigSpeedLoss: 0.03,
    effect: 'leaves',
    sound: 'impactLeaves',
  },
  shrub: {
    // 관목·덤불: 줄기가 촘촘
    kind: 'volume',
    lossPerMeter: 0.006,
    twigRatePerMeter: 0.45,
    twigDeflectDeg: 2.2,
    twigSpeedLoss: 0.06,
    effect: 'leaves',
    sound: 'impactLeaves',
  },
};
