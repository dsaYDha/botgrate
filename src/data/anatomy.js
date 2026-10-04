// 인체 치수(키 약 1.75 m, 어깨폭 약 0.45 m)와 부위별 히트박스, 부상 효과.
// 뼈 국소 좌표: +y 뼈 진행 방향, 몸 기준 +x = 왼쪽, +z = 앞(정면).

export const BODY = {
  height: 1.75,
  pelvisHeight: 0.95,
  bones: {
    // name: [parent, offset(x,y,z) from parent]
    pelvis: [null, [0, 0.95, 0]],
    spine: ['pelvis', [0, 0.08, 0]],
    chest: ['spine', [0, 0.22, 0]],
    neck: ['chest', [0, 0.22, 0]],
    head: ['neck', [0, 0.11, 0.01]],
    shoulderL: ['chest', [0.19, 0.16, -0.01]],
    upperArmL: ['shoulderL', [0, 0, 0]],
    foreArmL: ['upperArmL', [0, -0.3, 0]],
    handL: ['foreArmL', [0, -0.27, 0]],
    shoulderR: ['chest', [-0.19, 0.16, -0.01]],
    upperArmR: ['shoulderR', [0, 0, 0]],
    foreArmR: ['upperArmR', [0, -0.3, 0]],
    handR: ['foreArmR', [0, -0.27, 0]],
    thighL: ['pelvis', [0.095, -0.05, 0]],
    shinL: ['thighL', [0, -0.44, 0]],
    footL: ['shinL', [0, -0.43, 0]],
    thighR: ['pelvis', [-0.095, -0.05, 0]],
    shinR: ['thighR', [0, -0.44, 0]],
    footR: ['shinR', [0, -0.43, 0]],
  },
};

// 히트박스: bone, zone, shape: box{c,h} | ellipsoid{c,r} | cyl{r,len,dir(-1이면 아래로)}
export const HITBOXES = [
  { bone: 'head', zone: 'head', shape: 'ellipsoid', c: [0, 0.09, 0.012], r: [0.078, 0.11, 0.098] },
  { bone: 'neck', zone: 'neck', shape: 'cyl', r: 0.056, len: 0.13, from: 0 },
  { bone: 'chest', zone: 'chestCenter', shape: 'box', c: [0.012, 0.1, 0.0], h: [0.052, 0.125, 0.112] },
  { bone: 'chest', zone: 'lungL', shape: 'box', c: [0.118, 0.1, 0.0], h: [0.054, 0.12, 0.108] },
  { bone: 'chest', zone: 'lungR', shape: 'box', c: [-0.096, 0.1, 0.0], h: [0.056, 0.12, 0.108] },
  { bone: 'spine', zone: 'spine', shape: 'box', c: [0, 0.1, -0.085], h: [0.03, 0.12, 0.025] },
  { bone: 'spine', zone: 'abdomen', shape: 'box', c: [0, 0.1, 0.01], h: [0.15, 0.115, 0.1] },
  { bone: 'pelvis', zone: 'pelvis', shape: 'box', c: [0, -0.02, 0], h: [0.17, 0.085, 0.11] },
  { bone: 'upperArmL', zone: 'armUpper', shape: 'cyl', r: 0.048, len: 0.29, from: -1 },
  { bone: 'upperArmR', zone: 'armUpper', shape: 'cyl', r: 0.048, len: 0.29, from: -1 },
  { bone: 'foreArmL', zone: 'armLower', shape: 'cyl', r: 0.04, len: 0.26, from: -1 },
  { bone: 'foreArmR', zone: 'armLower', shape: 'cyl', r: 0.04, len: 0.26, from: -1 },
  { bone: 'handL', zone: 'hand', shape: 'box', c: [0, -0.05, 0.01], h: [0.025, 0.05, 0.045] },
  { bone: 'handR', zone: 'hand', shape: 'box', c: [0, -0.05, 0.01], h: [0.025, 0.05, 0.045] },
  { bone: 'thighL', zone: 'thigh', shape: 'cyl', r: 0.078, len: 0.43, from: -1 },
  { bone: 'thighR', zone: 'thigh', shape: 'cyl', r: 0.078, len: 0.43, from: -1 },
  { bone: 'shinL', zone: 'shin', shape: 'cyl', r: 0.056, len: 0.42, from: -1 },
  { bone: 'shinR', zone: 'shin', shape: 'cyl', r: 0.056, len: 0.42, from: -1 },
  { bone: 'footL', zone: 'foot', shape: 'box', c: [0, -0.03, 0.07], h: [0.05, 0.04, 0.13] },
  { bone: 'footR', zone: 'foot', shape: 'box', c: [0, -0.03, 0.07], h: [0.05, 0.04, 0.13] },
];

// 부위 → 부상 범주. 어느 부위든 맞으면 정상 행동 불가.
export const WOUNDS = {
  head: { kind: 'incap', name: '머리' },
  neck: { kind: 'incap', name: '목' },
  chestCenter: { kind: 'incap', name: '흉부 중앙(심장·대혈관)' },
  spine: { kind: 'incap', name: '척추' },
  lungL: { kind: 'lung', name: '왼쪽 폐' },
  lungR: { kind: 'lung', name: '오른쪽 폐' },
  abdomen: { kind: 'abdomen', name: '복부' },
  pelvis: { kind: 'abdomen', name: '골반' },
  thigh: { kind: 'leg', name: '허벅지' },
  shin: { kind: 'leg', name: '정강이' },
  foot: { kind: 'leg', name: '발' },
  armUpper: { kind: 'arm', name: '위팔' },
  armLower: { kind: 'arm', name: '아래팔' },
  hand: { kind: 'arm', name: '손' },
};

export const WOUND_TIMING = {
  lungCollapse: [2.5, 7.0], // 폐: 몇 초 안에 쓰러짐
  abdomenCrawlDelay: [2.0, 4.5],
  crawlSpeed: [0.15, 0.3],
  crawlDuration: [15, 45],
  armDropChance: 0.65,
};
