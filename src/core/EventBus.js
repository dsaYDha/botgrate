// 시스템 간 결합을 줄이는 간단한 발행/구독.
// 주요 이벤트:
//   'shot'            {shooter, position, direction, weapon}         총성 (2단계: 적 청각 인지)
//   'bullet:impact'   {position, normal, material, velocity, ...}   탄착
//   'bullet:nearMiss' {targetId, distance, point, direction}       근탄(제압)
//   'bullet:flyby'    {point, distance, velocity, shooter}         청자 근처 통과(2단계: 초음속 크랙)
//   'enemy:hit'       {enemy, part, distance, velocity, energy}   명중
//   'enemy:down'      {enemy}
//   'sound'           {type, position, loudness}                    AI 청각용 소리 사건(2단계)
export class EventBus {
  constructor() {
    this.map = new Map();
  }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    this.map.get(type)?.delete(fn);
  }
  emit(type, payload) {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}
