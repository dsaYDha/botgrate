// 탄약 데이터. 새 탄종은 여기에 항목만 추가하면 된다.
// 단위: SI (m, kg, s). BC는 관례대로 lb/in².

export const AMMO = {
  '556x45_ball': {
    id: '556x45_ball',
    name: '5.56×45mm 62gr 보통탄 (SS109/M855 계열)',
    diameter: 0.00570,
    mass: 0.0040176, // 62 gr
    massGrains: 62,
    length: 0.0230, // 0.906 in
    dragModel: 'G7',
    bc: 0.151, // G7, Litz(Applied Ballistics) 측정값 — README 출처 참고
    powderMass: 0.0018, // RWS 공개 자료: 장약량 약 1.8 g
    // 실탄 산포(총+탄): 평균 반경(MOA). 보통탄 기준 대략 2~4 MOA 군집.
    dispersionMRMoa: 1.1,
    // 탄간 총구속도 표준편차(m/s)
    muzzleVelocitySD: 9,
    // 관통 기준 속도(이 속도에서의 재질별 관통 깊이가 materials.js에 정의됨)
    penetrationRefVelocity: 900,
    tracer: false,
  },
};
