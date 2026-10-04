// 방풍림 수종·관목 데이터(수십 년 된 온대 평원 방풍림). 길이 단위 m.
// height: 나무 높이, dbh: 흉고직경, crownR: 수관 반지름, crownBase: 높이 대비 수관 시작
// material: 줄기 관통 재질(materials.js), bark: 껍질 텍스처 층, leafTile: 잎 뭉치 아틀라스 칸
// leaf: 여름 잎색(선형), autumn: 물든 잎색, autumnChance/autumnAmount: 일부 나무만 일찍 물듦
// fork: 두 갈래 줄기 확률, lean: 기울기(도) 범위

export const TREE_SPECIES = {
  poplar: {
    name: '포플러',
    height: [19, 25],
    dbh: [0.3, 0.55],
    crownR: [1.8, 3.0],
    crownBase: [0.2, 0.3],
    shape: 'columnar',
    material: 'woodSoft',
    bark: 'poplar',
    leafTile: 0,
    leaf: [0.075, 0.13, 0.035],
    autumn: [0.42, 0.36, 0.06],
    autumnChance: 0.25,
    flutter: 1.0,
    fork: 0.08,
    lean: [0, 3],
    templates: 3,
  },
  locust: {
    name: '아카시아(아까시나무)',
    height: [13, 18],
    dbh: [0.2, 0.42],
    crownR: [2.5, 4.4],
    crownBase: [0.35, 0.5],
    shape: 'irregular',
    material: 'woodHard',
    bark: 'locust',
    leafTile: 1,
    leaf: [0.085, 0.14, 0.04],
    autumn: [0.36, 0.34, 0.08],
    autumnChance: 0.12,
    flutter: 0.75,
    fork: 0.3,
    lean: [1, 6],
    templates: 3,
  },
  elm: {
    name: '시베리아느릅나무',
    height: [10, 15],
    dbh: [0.2, 0.45],
    crownR: [2.8, 4.8],
    crownBase: [0.2, 0.3],
    shape: 'round',
    material: 'woodMedium',
    bark: 'elm',
    leafTile: 2,
    leaf: [0.055, 0.095, 0.03],
    autumn: [0.33, 0.3, 0.07],
    autumnChance: 0.1,
    flutter: 0.55,
    fork: 0.25,
    lean: [0, 4],
    templates: 3,
  },
  maple: {
    name: '네군도단풍(하층목)',
    height: [7, 11],
    dbh: [0.12, 0.3],
    crownR: [2.4, 4.0],
    crownBase: [0.18, 0.32],
    shape: 'spreading',
    material: 'woodMedium',
    bark: 'maple',
    leafTile: 3,
    leaf: [0.09, 0.15, 0.045],
    autumn: [0.4, 0.37, 0.09],
    autumnChance: 0.25,
    flutter: 0.7,
    fork: 0.45,
    lean: [2, 12],
    templates: 2,
  },
  ash: {
    name: '푸른물푸레(하층·중층)',
    height: [11, 16],
    dbh: [0.18, 0.38],
    crownR: [2.4, 3.8],
    crownBase: [0.28, 0.4],
    shape: 'oval',
    material: 'woodHard',
    bark: 'ash',
    leafTile: 4,
    leaf: [0.07, 0.12, 0.035],
    autumn: [0.46, 0.42, 0.08], // 물푸레는 일찍 노랗게 물든다
    autumnChance: 0.35,
    flutter: 0.7,
    fork: 0.2,
    lean: [0, 4],
    templates: 2,
  },
};

export const TREE_KEYS = ['poplar', 'locust', 'elm', 'maple', 'ash'];

// 고사목(잎 없는 회색 나무, 꼭대기가 부러짐)
export const SNAG = {
  bark: 'dead',
  material: 'woodDead',
  templates: 2,
};

export const SHRUB_SPECIES = {
  elder: {
    name: '딱총나무',
    height: [2.2, 4.0],
    radius: [1.2, 2.2],
    leafTile: 5,
    leaf: [0.06, 0.1, 0.03],
    fruit: [0.02, 0.015, 0.02], // 검은 열매
    fruitChance: 0.5,
    stems: [5, 9],
    arch: 0.35,
    templates: 2,
  },
  rose: {
    name: '들장미',
    height: [1.2, 2.4],
    radius: [1.0, 1.8],
    leafTile: 6,
    leaf: [0.07, 0.1, 0.035],
    fruit: [0.45, 0.04, 0.02], // 붉은 열매(로즈힙)
    fruitChance: 0.8,
    stems: [8, 14],
    arch: 0.8,
    templates: 2,
  },
  blackthorn: {
    name: '가시자두',
    height: [1.6, 3.0],
    radius: [1.0, 2.0],
    leafTile: 7,
    leaf: [0.045, 0.075, 0.03],
    fruit: [0.06, 0.07, 0.12], // 검푸른 열매
    fruitChance: 0.6,
    stems: [10, 18],
    arch: 0.25,
    templates: 2,
  },
  oleaster: {
    name: '보리수(은빛 잎)',
    height: [2.8, 5.0],
    radius: [1.5, 2.6],
    leafTile: 8,
    leaf: [0.16, 0.18, 0.13], // 은회색 잎
    fruit: [0.3, 0.25, 0.1],
    fruitChance: 0.3,
    stems: [3, 6],
    arch: 0.3,
    templates: 2,
  },
};

export const SHRUB_KEYS = ['elder', 'rose', 'blackthorn', 'oleaster'];

// 띠 구조 공통값
export const BELT_STRUCTURE = {
  rowSpacing: 3.2, // 열 간격(2~4 m)
  rowJitter: 0.45,
  rowWave: 0.6, // 열이 길게 굽이치는 정도(m)
  inRowSpacing: [2.2, 3.4],
  missing: 0.09, // 심은 자리가 빈 비율
  missingRun: 0.25, // 빈자리가 이어질 확률
  volunteerPer100m2: 1.6, // 열 사이 저절로 자란 나무
  saplingPer100m2: 2.2, // 어린나무·맹아
  suppressedFraction: 0.12,
  brokenTop: 0.04,
  leaning: 0.03, // 크게 기운 나무
  edgeZoneMin: 3.0,
  shrubBand: [2.0, 4.5], // 띠 밖으로 나온 관목대 폭
  shrubStep: [0.9, 1.6],
  interiorShrubPerM2: 0.01,
  endTaper: [18, 32], // 띠 끝이 낮아지는 구간 길이
};
