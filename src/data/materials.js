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
