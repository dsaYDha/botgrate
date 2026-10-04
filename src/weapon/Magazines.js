// 탄창별 잔탄 추적. 파우치는 순서가 있는 대기열: 꺼낼 때는 앞에서, 전술 재장전으로 넣은
// 반쯤 쓴 탄창은 뒤로 간다(실제 병사들의 습관). 빈 탄창은 덤프 파우치(재사용 안 함).

export class Magazines {
  constructor(capacity, count) {
    this.capacity = capacity;
    this.reset(count);
  }

  reset(count = 7) {
    let id = 1;
    this.inserted = { id: id++, rounds: this.capacity };
    this.pouch = [];
    for (let i = 1; i < count; i++) this.pouch.push({ id: id++, rounds: this.capacity });
    this.dump = [];
    this.dropped = [];
  }

  get hasSpare() {
    return this.pouch.length > 0;
  }

  /** 삽입된 탄창에서 한 발 꺼냄(약실 장전). 성공 여부 */
  feed() {
    if (this.inserted && this.inserted.rounds > 0) {
      this.inserted.rounds--;
      return true;
    }
    return false;
  }

  /** 탄창 빼기. mode: 'stow'(파우치 뒤로), 'dump'(덤프 파우치), 'drop'(버림) */
  remove(mode) {
    const m = this.inserted;
    this.inserted = null;
    if (!m) return null;
    if (mode === 'drop') this.dropped.push(m);
    else if (mode === 'dump' || m.rounds === 0) this.dump.push(m);
    else this.pouch.push(m);
    return m;
  }

  /** 파우치 앞의 탄창을 꺼내 삽입 */
  insertNext() {
    if (this.inserted || this.pouch.length === 0) return null;
    this.inserted = this.pouch.shift();
    return this.inserted;
  }

  totalRounds() {
    return (this.inserted ? this.inserted.rounds : 0) + this.pouch.reduce((s, m) => s + m.rounds, 0);
  }

  /** 탄창 확인 결과(감각적 표현) */
  static describe(rounds, capacity) {
    if (rounds <= 0) return '비었다';
    const f = rounds / capacity;
    if (f >= 0.92) return '가득';
    if (f >= 0.5) return '절반 이상';
    if (f >= 0.17) return '절반 미만';
    return '거의 없음';
  }
}
