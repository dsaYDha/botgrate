// 7.62×39mm 탄도 검증 기준 자료(적 소총탄).

// [E] 제조사 공개 탄도표 — Sellier & Bellot 7.62×39 FMJ 124 gr(8.0 g), 제품 상세 페이지 공개값.
//     https://www.sellier-bellot.cz/en/products/rifle-ammunition/rifle-ammunition-training-fmj/detail/216/
//     열: 거리(m), 속도(m/s), 에너지(J). 공개 BC: G1 0.289, G7 0.149
export const SB_762x39 = {
  source: 'Sellier & Bellot 7.62x39 FMJ 124 gr (8.0 g) — 제조사 공개 탄도표',
  url: 'https://www.sellier-bellot.cz/en/products/rifle-ammunition/rifle-ammunition-training-fmj/detail/216/',
  bulletMassKg: 0.008,
  v0: 738,
  bcG1: 0.289,
  bcG7: 0.149,
  rows: [
    [0, 738, 2179],
    [100, 640, 1640],
    [200, 550, 1211],
    [300, 466, 870],
  ],
};

// [F] 7.62×39 돌격소총(AKM) 제원 총구속도 715 m/s(7.62 mm 1943년형 탄 7.9 g, 710~725 m/s)
export const AKM_MUZZLE_VELOCITY = 715;
