// 방풍림 수종·관목 데이터. 높이·흉고직경(DBH)은 m.
// penetration: 이 재질 줄기를 900 m/s 탄이 관통할 수 있는 깊이 (materials.js 참고)

export const TREE_SPECIES = {
  poplar: {
    name: '포플러',
    height: [14, 20],
    dbh: [0.2, 0.45],
    crownBase: [0.22, 0.34], // 높이 대비 수관 시작
    crownRadius: [1.3, 2.4], // 기둥형 수관
    crownShape: 'columnar',
    leafCards: 70,
    cardSize: [0.9, 1.4],
    bark: [0.44, 0.44, 0.39],
    barkDark: [0.26, 0.27, 0.23],
    leaf: [0.16, 0.24, 0.07],
    leafVar: 0.12,
    yellowFraction: 0.24, // 초가을: 일부만 노랗게
    yellow: [0.52, 0.44, 0.1],
    crownOpacity: 0.8,
    flutter: 1.0, // 잎 떨림(포플러는 잘 떨림)
    material: 'woodSoft',
    leafTexture: 0,
  },
  elm: {
    name: '느릅나무',
    height: [10, 15],
    dbh: [0.15, 0.4],
    crownBase: [0.18, 0.3],
    crownRadius: [2.3, 3.7],
    crownShape: 'round',
    leafCards: 80,
    cardSize: [1.0, 1.5],
    bark: [0.33, 0.29, 0.25],
    barkDark: [0.2, 0.17, 0.14],
    leaf: [0.1, 0.16, 0.05],
    leafVar: 0.1,
    yellowFraction: 0.1,
    yellow: [0.46, 0.4, 0.1],
    crownOpacity: 0.92,
    flutter: 0.6,
    material: 'woodMedium',
    leafTexture: 1,
  },
  locust: {
    name: '아카시아(아까시나무)',
    height: [10, 16],
    dbh: [0.1, 0.32],
    crownBase: [0.32, 0.48],
    crownRadius: [2.2, 3.5],
    crownShape: 'irregular',
    leafCards: 62,
    cardSize: [1.0, 1.5],
    bark: [0.27, 0.24, 0.21],
    barkDark: [0.14, 0.12, 0.1],
    leaf: [0.17, 0.24, 0.08],
    leafVar: 0.13,
    yellowFraction: 0.18,
    yellow: [0.5, 0.45, 0.13],
    crownOpacity: 0.68, // 성긴 수관
    flutter: 0.75,
    material: 'woodHard',
    leafTexture: 2,
  },
};

export const SNAG = {
  bark: [0.42, 0.4, 0.37],
  barkDark: [0.3, 0.28, 0.26],
  material: 'woodDead',
};

export const SHRUBS = {
  height: [1.5, 3.6],
  radius: [0.9, 2.0],
  interiorHeight: [0.6, 1.8],
  leaf: [0.12, 0.17, 0.06],
  leafVar: 0.16,
  yellowFraction: 0.12,
  yellow: [0.45, 0.36, 0.1],
  redFraction: 0.06, // 붉게 물든 관목 잎(산사·장미 계열)
  red: [0.36, 0.12, 0.05],
  cards: 26,
  cardSize: [0.6, 1.0],
  opacity: 0.92,
  leafTexture: 3,
};

// 줄 간격·나무 간격 등 띠 구조 공통값
export const BELT_STRUCTURE = {
  rowSpacing: 3.2, // 열 간격(2~4 m)
  rowJitter: 0.35,
  inRowSpacing: [2.0, 3.6],
  edgeZoneMin: 3.0, // 가장자리 관목대 최소 폭
  shrubStep: [0.7, 1.25], // 가장자리 관목 간격
  shrubOutset: 1.2, // 띠 경계 밖으로 뻗는 정도
  interiorShrubPerM2: 0.012,
  suppressedFraction: 0.12, // 피압된 가는 나무 비율
  suppressedDbh: [0.07, 0.12],
};
