// 전장 배치 데이터. 좌표: x = 동(+), z = 남(+), 북쪽 = -z. 단위 m.
// 플레이 구역은 원점 중심 1.2 km × 1.2 km. 높이맵·지면맵은 그보다 넓은 1.4 km를 덮는다.

export const WORLD = {
  seed: 20240917,
  playHalf: 600, // 플레이 구역 반폭
  mapHalf: 700, // 높이맵/지면맵 반폭
  mapRes: 1.0, // m/텍셀

  terrain: {
    // 완만한 기복(±1~3 m): 큰 파장 + 중간 파장
    largeAmp: 2.4,
    largeScale: 340,
    midAmp: 0.55,
    midScale: 75,
    smallAmp: 0.08,
    smallScale: 9,
    plowRoughness: 0.05, // 갈아엎은 흙밭 흙덩이 요철(±m)
  },

  // 방풍림 띠. axis 'x' = 동서로 뻗은 띠(center는 z 좌표), 'z' = 남북 띠(center는 x 좌표).
  // from/to: 띠 축 방향 범위. gaps: 끊긴 구간 [시작, 끝].
  belts: [
    {
      id: 'S',
      name: '남쪽 숲띠(아군 위치)',
      axis: 'x',
      center: 260,
      from: -540,
      to: 469,
      width: 24,
      rows: 6,
      species: { poplar: 0.45, elm: 0.33, locust: 0.22 },
      gaps: [
        [-216, -174],
        [38, 80],
      ],
      edgeShrubDensity: 1.0,
      deadFraction: 0.06,
      fallenPer100m: 1.6,
    },
    {
      id: 'M',
      name: '가운데 숲띠(맞은편 300~400 m)',
      axis: 'x',
      center: -95,
      from: -560,
      to: 469,
      width: 20,
      rows: 5,
      species: { locust: 0.4, elm: 0.36, poplar: 0.24 },
      gaps: [
        [-216, -174],
        [176, 232],
      ],
      edgeShrubDensity: 1.0,
      deadFraction: 0.07,
      fallenPer100m: 1.8,
    },
    {
      id: 'N',
      name: '북쪽 숲띠',
      axis: 'x',
      center: -470,
      from: -500,
      to: 469,
      width: 16,
      rows: 4,
      species: { elm: 0.5, locust: 0.35, poplar: 0.15 },
      gaps: [
        [-216, -178],
        [-44, 2],
      ],
      edgeShrubDensity: 0.9,
      deadFraction: 0.08,
      fallenPer100m: 1.4,
    },
    {
      id: 'E',
      name: '동쪽 연결 숲띠(남북)',
      axis: 'z',
      center: 480,
      from: -482,
      to: 272,
      width: 22,
      rows: 6,
      species: { poplar: 0.4, elm: 0.38, locust: 0.22 },
      gaps: [[36, 74]],
      edgeShrubDensity: 1.0,
      deadFraction: 0.07,
      fallenPer100m: 1.8,
    },
  ],

  // 흙길(바퀴 자국). points: 중심선 꼭짓점 [x, z]
  roads: [
    { id: 'R1', points: [[-195, 720], [-195, -720]], width: 3.4 },
    { id: 'R2', points: [[-195, -78], [466, -78]], width: 3.2 },
    { id: 'R3', points: [[-195, 283], [460, 283]], width: 3.2 },
  ],
  rut: { gauge: 1.65, width: 0.36, depth: 0.11, centerRise: 0.035, sink: 0.05 },

  // 배수로: 띠 가장자리에서 바깥쪽으로 offset 만큼 떨어진 곳에 평행. side: 'north'|'south'|'east'|'west'
  ditches: [
    { belt: 'S', side: 'north', offset: 4.5, width: 2.6, depth: 0.75, spoil: 0.35 },
    { belt: 'M', side: 'south', offset: 4.0, width: 2.4, depth: 0.7, spoil: 0.4 },
    { belt: 'M', side: 'north', offset: 3.5, width: 2.2, depth: 0.55, spoil: 0.25 },
    { belt: 'E', side: 'west', offset: 4.0, width: 2.4, depth: 0.65, spoil: 0.35 },
    { belt: 'N', side: 'south', offset: 3.5, width: 2.2, depth: 0.55, spoil: 0.25 },
  ],

  // 흙둔덕(엄폐물): 중심, 길이, 폭, 높이, 방향(rad, 0 = 동서로 긺)
  berms: [
    { x: 395, z: 238, length: 7, width: 3.2, height: 0.75, angle: 0.15 },
    { x: 330, z: -89, length: 12, width: 3.6, height: 0.9, angle: 0.05 },
    { x: 250, z: -90, length: 8, width: 3.0, height: 0.7, angle: -0.1 },
    { x: 468, z: 150, length: 6, width: 3.0, height: 0.8, angle: 1.45 },
    { x: 486, z: 105, length: 9, width: 3.4, height: 1.0, angle: 1.6 },
    { x: 60, z: 70, length: 16, width: 4.0, height: 0.6, angle: 0.0 },
    { x: -60, z: -300, length: 14, width: 3.5, height: 0.7, angle: 0.4 },
  ],

  // 밭 구획. 사각형 [x0, z0, x1, z1]. type: stubble | plowed | fallow
  // dir: 이랑/그루터기 줄 방향(rad, 0 = 동서 방향으로 줄이 남)
  fields: [
    { rect: [-700, -85, -197, 248], type: 'plowed', dir: 0 },
    { rect: [-193, -85, 160, 248], type: 'fallow', dir: 0 },
    { rect: [160, -85, 469, 248], type: 'stubble', dir: Math.PI / 2 },
    { rect: [-700, -462, -197, -105], type: 'stubble', dir: 0 },
    { rect: [-193, -462, 200, -105], type: 'plowed', dir: Math.PI / 2 },
    { rect: [200, -462, 469, -105], type: 'fallow', dir: 0 },
    { rect: [-700, -720, -197, -478], type: 'fallow', dir: 0 },
    { rect: [-193, -720, 720, -478], type: 'stubble', dir: 0 },
    { rect: [-700, 272, -197, 720], type: 'stubble', dir: Math.PI / 2 },
    { rect: [-193, 272, 720, 720], type: 'plowed', dir: 0 },
    { rect: [491, -478, 720, 100], type: 'stubble', dir: Math.PI / 2 },
    { rect: [491, 100, 720, 272], type: 'plowed', dir: Math.PI / 2 },
  ],
  defaultField: 'stubble',
  marginWidth: 3.0, // 띠 가장자리 풀 띠 폭

  // 플레이어 시작: 남쪽 숲띠 북쪽 가장자리, 북쪽(-z)을 바라봄
  playerStart: { x: 418, z: 248.5, yaw: 0 },
  // 시작 위치 주변 덤불을 비워 시야 확보(반경 m)
  playerClearing: 2.6,

  // 원경: 플레이 구역 밖 숲띠 격자(지평선까지 이어지는 방풍림 경관)
  distant: { spacing: 420, extent: 6500, height: 15, width: 18 },
};
