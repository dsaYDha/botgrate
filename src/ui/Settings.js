// 사용자 설정(로컬 저장). 저장 실패(사생활 보호 모드 등)해도 기본값으로 동작.

const KEY = 'windbreak-fps-settings-v1';

export const DEFAULTS = {
  sensitivity: 1.0,
  fov: 55, // 세로 시야각(도)
  realFov: 34, // 1배율 기준: 모니터가 실제로 눈에서 차지하는 세로 각도(도)
  zero: 100,
  windMode: 'random',
  windSpeed: 5,
  windDir: 270,
  quality: 'medium',
  adsToggle: false,
  volume: 0.85,
};

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.values, JSON.parse(raw));
    } catch {
      /* 저장소 없음 */
    }
    this.listeners = new Set();
  }
  get(k) {
    return this.values[k];
  }
  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch {
      /* 무시 */
    }
    for (const fn of this.listeners) fn(k, v);
  }
  onChange(fn) {
    this.listeners.add(fn);
  }
}
