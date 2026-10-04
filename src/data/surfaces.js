// 지면 종류: 이동 속도 배수, 발소리 종류, 식생, 색.
// 이동 속도는 전투 장비 착용 보병 기준값(movement.js)에 곱한다.

export const SURFACES = {
  stubble: {
    id: 0,
    name: '밀 그루터기',
    speed: 0.95,
    footstep: 'stubble',
    color: [0.62, 0.53, 0.33],
  },
  plowed: {
    id: 1,
    name: '갈아엎은 흙밭',
    speed: 0.7, // 흙덩이·이랑 때문에 느리고 힘듦
    footstep: 'plowed',
    staminaCost: 1.4,
    color: [0.3, 0.24, 0.18],
  },
  fallow: {
    id: 2,
    name: '휴경지(무릎~허리 높이 잡초)',
    speed: 0.8,
    footstep: 'weeds',
    color: [0.47, 0.45, 0.27],
  },
  forest: {
    id: 3,
    name: '숲 바닥(낙엽·잔가지)',
    speed: 0.88,
    footstep: 'leaves',
    color: [0.3, 0.25, 0.17],
  },
  road: {
    id: 4,
    name: '흙길',
    speed: 1.0,
    footstep: 'dirt',
    color: [0.55, 0.47, 0.36],
  },
  grass: {
    id: 5,
    name: '풀밭(둑·배수로)',
    speed: 0.9,
    footstep: 'grass',
    color: [0.36, 0.4, 0.2],
  },
};

export const SURFACE_LIST = ['stubble', 'plowed', 'fallow', 'forest', 'road', 'grass'];

// 덤불 속을 헤치고 지나갈 때 추가 배수
export const SHRUB_SPEED_FACTOR = 0.45;
