// 탄도 검증 기준 자료. 출처와 수치는 README.md "탄도 검증" 절에도 같은 내용으로 적어 둔다.

// [A] 제조사 공개 탄도표 — RWS(구 RUAG Ammotec) 5.56x45 NATO BALL (SS109) 62gr, 제품번호 2422469.
//     https://www.rws-technology.com/en/armed-forces-law-enforcement/product/556x45-nato-ball-ss109-62gr-2422469
//     돌격소총(assault rifle) 탄도, 508 mm 시험 총열, 탄두 4.0 g.
//     열: 거리(m), 속도(m/s), 에너지(J), 비행시간(ms)
export const RWS_SS109 = {
  source: 'RWS 5.56x45 NATO BALL (SS109) 62gr, Art. 2422469 — 제조사 공개 탄도표',
  url: 'https://www.rws-technology.com/en/armed-forces-law-enforcement/product/556x45-nato-ball-ss109-62gr-2422469',
  bulletMassKg: 0.0040,
  v0: 925,
  testBarrelMm: 508,
  rows: [
    [0, 925, 1711, 0],
    [25, 898, 1613, 27],
    [100, 818, 1338, 115],
    [200, 719, 1034, 245],
    [300, 626, 784, 395],
    [400, 538, 579, 567],
    [500, 451, 407, 770],
    [600, 379, 287, 1012],
  ],
};

// [B] 공개 탄도계수 — M855/SS109 62gr G7 BC 0.151 (Bryan Litz, Applied Ballistics 측정값;
//     RWS 제품 페이지에도 G7 0.151로 표기).
export const PUBLISHED_BC_G7 = 0.151;

// [C] 14.5in(M4 계열) 총열에서의 M855 총구속도 — 미 육군 M4 카빈 제원 2,970 ft/s (905 m/s).
export const M4_MUZZLE_VELOCITY = 905;

// [D] 독립 오픈소스 솔버 교차 검증값 — py-ballisticcalc 3.0.0 (RK4, G7 표, ICAO 표준 대기)
//     입력: G7 0.151, 62gr, 초속 905 m/s, 조준선 높이 6.8 cm, 영점 100 m, 횡풍 5 m/s, 스핀 드리프트 없음.
//     열: 거리(m), 조준선 기준 탄착(cm), 비행시간(s), 속도(m/s), 편류(cm)
export const PY_BALLISTICCALC_905 = {
  source: 'py-ballisticcalc 3.0.0 (https://github.com/o-murphy/py-ballisticcalc), 개발 중 직접 실행한 결과',
  rows: [
    [100, -0.0, 0.117, 801.0, 3.5],
    [200, -8.6, 0.251, 703.7, 14.8],
    [300, -37.1, 0.403, 613.6, 35.7],
    [400, -91.9, 0.578, 530.0, 68.1],
    [500, -182.0, 0.783, 451.8, 115.0],
    [600, -320.6, 1.024, 379.5, 180.6],
  ],
};
