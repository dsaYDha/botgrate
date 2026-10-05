// 2단계 시나리오: 플레이어는 남쪽 숲띠 북쪽 가장자리(418, 248.5)에서 북쪽을 본다.
// 적: 북쪽 맞은편 숲띠(가운데 숲띠 M, 300~400 m)에 1개 분대(분대장 + 4명 사격조 2개 = 9명),
//     동쪽 연결 숲띠(E, 50~200 m)에 사격조 1개(4명). 처음에는 아군이 있는 줄 모르고 경계·순찰·휴식 중.
// 시작 위치는 '그럴듯한 자리 후보'(숲 가장자리 경계 자리, 숲 안 휴식 자리, 순찰 구간) 중에서 시드로 뽑는다(매번 다름).
//
// belt: 숲띠 id, u: 띠 축 방향 범위, side: 플레이어 쪽 가장자리, withdraw: 사기가 꺾이면 물러날 방향의 숲띠

export const SCENARIO = {
  units: [
    {
      id: 'S1',
      name: '1분대',
      kind: 'squad',
      belt: 'M',
      u: [262, 455], // 플레이어 정면 ±100 m 남짓
      side: 'south',
      teams: [
        { id: 'A', name: '1사격조', size: 4 },
        { id: 'B', name: '2사격조', size: 4 },
      ],
      leader: true,
      withdrawBelt: 'N',
      radio: ['T3'],
    },
    {
      id: 'T3',
      name: '3사격조',
      kind: 'team',
      belt: 'E',
      u: [110, 228],
      side: 'west',
      teams: [{ id: 'C', name: '3사격조', size: 4 }],
      leader: false,
      withdrawBelt: 'M',
      radio: ['S1'],
    },
  ],
  // 병사 숙련도 범위(요청서): 흔들림 배율, 반응 시간 배율, 거리 눈대중 오차
  skill: {
    sway: [0.8, 1.5],
    reaction: [0.8, 1.3],
    rangeError: [0.1, 0.2],
    vision: [0.85, 1.15],
  },
  // 시작 행동 비율(숲 가장자리 경계 / 숲 안 순찰 / 숲 안 휴식)
  startRoles: { guard: 0.45, patrol: 0.25, rest: 0.3 },
};
