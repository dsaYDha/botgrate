// 적 인지(시각·청각·정보 공유) 수치. 근거와 타협은 REALISM_NOTES.md 5장.
//
// 시각 — 가시도 D(무차원):
//   D = Ω × C × L × M × 연무
//   Ω  겉보기 노출 면적(mrad²) = 몸 윤곽 면적(자세·보는 방향) × 부위별 시선 투과율 ÷ 거리²
//   C  배경 대비: 들판 1, 숲(어둡고 어수선) 0.6, 하늘(스카이라인 실루엣) 4
//   L  조명: 햇빛 1, 그늘은 관측자 눈이 밝은 곳에 적응해 있으면 0.28, 관측자도 그늘이면 0.55
//   M  움직임: 정지 1 < 기기 약 2 < 걷기 약 3.4 < 뛰기 약 4.6 < 질주 약 5.7
// 한 번 볼 때 알아챌 확률 P(D) = 1 / (1 + (D50/D)^k). 탐지 증거는 λ = 응시율 × P(D × 이심률 계수)로 쌓인다.
// 시선 투과율은 잎 볼륨(Beer–Lambert, 잎 면적 밀도는 탄도와 같은 볼륨 자료)·땅 덮개(그루터기·잡초·해바라기,
// 탄도와 같은 coverAt)·고체(지면·줄기·가지·통나무·짚 더미·뿌리판)로 계산한다.

export const VISION = {
  // 몸 윤곽: 몸통 경계 상자 투영 면적 × 채움 비율(사람 실루엣은 경계 상자의 약 65 %)
  bodyFill: 0.65,
  // 잎: T = exp(-G · LAD · L), 무작위(구형) 잎 방향의 투영 계수 G = 0.5.
  // 볼륨의 opacity는 treeTemplates.js에서 1 − exp(−LAD × 1.6)으로 만들었다 → LAD = −ln(1 − opacity) / 1.6
  leafG: 0.5,
  opacityPath: 1.6,
  // 땅 덮개 시선 소광 계수(1/m): 그루터기 줄기 n·d ≈ 400개/m² × 3.5 mm = 1.4 /m(탄도 표의 타격률과 같은 값),
  // 잡초(쑥·엉겅퀴·우엉 잎 면적 밀도 약 3 m²/m³ × G 0.5) 1.5 /m, 마른 해바라기(줄기 + 마른 잎) 0.6 /m
  coverExtinction: [1.4, 1.5, 0.6],
  // 가는 가지(반지름 6 cm 미만)는 표적 일부만 가린다
  thinLimbRadius: 0.06,
  thinLimbTransmission: 0.65,
  // 배경 대비
  contrast: { field: 1.0, forest: 0.6, sky: 4.0 },
  hazePerKm: 0.15, // 맑은 날 시정 약 20 km → 소광 0.2 /km 남짓
  // 조명(그늘): 관측자가 밝은 들판에 있으면 그늘 속은 거의 안 보이고, 관측자도 숲 안이면 눈이 적응해 덜 어둡다
  shadeOutside: 0.28,
  shadeInside: 0.55,
  // 움직임 배수 M(speed m/s) = 1 + 2(1 − e^(−v/0.8)) + 0.45 v
  motionA: 2.0,
  motionTau: 0.8,
  motionB: 0.45,
  // 자세를 바꾸거나 재장전하는 몸짓(제자리)
  fidget: 1.5,
  // 이심률: 중심 시야(시선 ±10°)는 1, 밖은 (10°/θ)²로 줄어든다. 움직이는 표적은 주변 시야에서도 잘 보인다.
  centralDeg: 10,
  peripheralLimitDeg: 110,
  movePeriphGain: 0.45,
  movePeriphFromDeg: 50,
  // 한 번 볼 때 탐지 확률: D50 = 27(서서 걷는 사람이 300 m 들판에서 한 번 볼 때 반반), 기울기 k = 2
  D50: 27,
  k: 2,
  // 응시율(초당, 표적 쪽을 한 번 보는 횟수): 보통 훑어볼 때 / 의심 가는 곳을 집중해서 볼 때
  glimpseRate: 1.0,
  focusedRate: 2.2,
  // 이미 위치를 아는 표적을 계속 보는 데 필요한 가시도는 처음 찾을 때의 1/4
  trackingScale: 0.25,
  // 탐지 단계: 증거가 문턱(평균 1, 지수분포)의 35 %면 '의심'(뭔가 움직였다), 100 %면 '위치 파악'(적을 알아봄)
  noticeFraction: 0.35,
  evidenceDecay: 0.06, // 1/s, 보이지 않으면 증거가 줄어든다
  // 눈으로 본 위치의 오차: 방위는 정확(0.004 rad), 거리는 눈대중(숙련도별 ±10~20 %)
  sightBearingSigma: 0.004,
  glimpseSigma: { base: 3, perMeter: 0.05 }, // '의심' 단계에서 본 위치 오차
  // 사격 순간: 총구 섬광·폭풍에 흔들리는 풀잎(한 번 보기), 엎드려쏴 먼지(1~3 s 보임)
  shotCueD: 30,
  dustD: 60,
  dustTau: 1.5,
};

// 청각. 방향 오차는 사람의 충격음 음원 방향 판단(열린 들판 ±20~30°, 잔향 많은 숲은 더 나쁨).
export const HEARING = {
  bangBearingSigmaDeg: 22,
  forestBearingMul: 1.35, // 듣는 사람이 숲띠 안이면 잔향 때문에
  crackConfusionMul: 1.5, // '딱'을 먼저 들으면 방향이 헷갈린다
  crackBiasWeight: [0.2, 0.5], // 쾅 방향이 딱 방향으로 끌려가는 정도
  // 거리 추정(로그정규 표준편차): 딱-쾅 시간차를 들으면 ±30 %, 소리 크기만으로는 ±50 %
  rangeSigmaCrackBang: 0.3,
  rangeSigmaLoudness: 0.5,
  maxBangRange: 1500, // m: 소총 총성은 이보다 멀어도 들리지만 위치 정보로는 쓸모없다
  // '딱': 초음속 탄이 이 거리 안을 지나면 듣는다
  crackRange: 30,
  // 발소리·덤불 헤치는 소리가 들리는 거리(m, 걷기 1.5 m/s 기준). 지면별
  stepRange: { stubble: 22, plowed: 14, fallow: 18, forest: 26, grass: 12, road: 12, sunflower: 20 },
  stepSpeedMul: { prone: 0.25, crouch: 0.5, walk: 1.0, run: 1.6, sprint: 2.2 },
  stepShrubGain: 1.5, // 덤불을 헤치면 1 + 1.5 × 덤불 밀도
  stepBearingSigmaDeg: 35,
  stepRangeSigma: 0.5,
  windMask: 6, // 바람 소리가 가림: 거리 × 1 / (1 + 풍속/6)
  // 총기 조작음(탄창 교환·노리쇠): 들리는 거리
  handlingRange: { magOut: 12, magIn: 12, magSeat: 15, boltRelease: 20, magRelease: 8, selector: 6, dryFire: 6, pouch: 6, pouchGrab: 5, magCheckOut: 5 },
  // 사람의 반응: 소리를 듣고 판단하기까지
  processDelay: [0.15, 0.5],
};

// 정보 공유
export const COMMS = {
  shoutRange: [20, 80], // 이 안이면 들림(20 m 안은 항상, 80 m에서 0)
  shoutNoiseCut: 0.7, // 총성이 오가는 중이면 들리는 거리 × 0.7
  shoutDelay: [0.6, 1.5], // 알아챈 뒤 외치기까지
  shoutErrBase: 4, // 말로 전하는 위치 오차(m) + 위협까지 거리의 10 %
  shoutErrPerMeter: 0.1,
  radioDelay: [3, 8], // 분대 간 무전
  radioErrMul: 1.5,
  radioErrAdd: 15,
};

// 위협 위치 추정(2차원 칼만): 안 보이는 동안 표적이 움직일 수 있는 속도(m/s)로 오차가 커진다
export const KNOWLEDGE = {
  processSpeed: 1.0,
  gateSigma2: 9, // 3σ 밖의 관측이면 '움직였다'로 보고 새 관측으로 바꾼다
  locatedSigma: 25, // 이보다 작으면 '위치 파악'
  forgetAfter: 180, // s: 이보다 오래 새 정보가 없으면 '수색'으로 내려간다
};
