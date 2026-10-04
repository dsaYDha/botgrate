// 1단계 테스트 시나리오. 플레이어는 남쪽 숲띠 북쪽 가장자리(418, 248.5)에서 북쪽을 본다.
// behavior: guard(경계, look: 바라보는 방위° 범위), patrol(waypoints 순회), cross(들판 횡단)
// pose: stand | kneel

export const SCENARIO = {
  enemies: [
    // --- 맞은편(가운데) 숲띠: 300~400 m ---
    { id: 'm1', behavior: 'guard', pos: [262, -87.5], look: [150, 210], pose: 'stand' },
    { id: 'm2', behavior: 'guard', pos: [331, -90.5], look: [160, 200], pose: 'kneel' }, // 흙둔덕 뒤
    { id: 'm3', behavior: 'guard', pos: [398, -88.0], look: [170, 230], pose: 'stand' },
    { id: 'm4', behavior: 'guard', pos: [446, -87.0], look: [140, 200], pose: 'kneel' },
    { id: 'm5', behavior: 'patrol', waypoints: [[245, -96], [330, -97], [420, -95], [455, -96]], speed: 1.1 },
    { id: 'm6', behavior: 'patrol', waypoints: [[440, -100], [360, -99], [290, -101]], speed: 1.0 },
    { id: 'm7', behavior: 'patrol', waypoints: [[300, -91], [370, -92]], speed: 0.9 },
    { id: 'm8', behavior: 'guard', pos: [355, -94], look: [120, 240], pose: 'stand' },
    // --- 동쪽 연결 숲띠 안: 50~150 m ---
    { id: 'e1', behavior: 'patrol', waypoints: [[478, 228], [482, 175], [476, 130], [481, 175]], speed: 1.0 },
    { id: 'e2', behavior: 'patrol', waypoints: [[485, 140], [474, 200], [486, 232]], speed: 1.1 },
    { id: 'e3', behavior: 'guard', pos: [471.5, 196], look: [200, 280], pose: 'kneel' },
    { id: 'e4', behavior: 'guard', pos: [472.0, 158], look: [230, 300], pose: 'stand' },
    { id: 'e5', behavior: 'patrol', waypoints: [[479, 182], [487, 122], [481, 155]], speed: 0.9 },
    // --- 들판 횡단 ---
    { id: 'c1', behavior: 'cross', waypoints: [[466, 30], [330, 34], [190, 40], [150, 60]], speed: 1.45 },
  ],
  // 가끔 새로 들판을 가로지르는 적(동시 최대 2명)
  crossers: {
    interval: [70, 140],
    maxConcurrent: 2,
    routes: [
      [[466, 40], [320, 45], [170, 52]],
      [[300, -82], [312, 30], [330, 120], [356, 200]],
      [[160, -80], [240, 20], [380, 70], [466, 90]],
      [[466, 120], [380, 115], [240, 95], [120, 80]],
    ],
  },
};
