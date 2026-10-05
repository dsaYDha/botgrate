// 'AI가 아는 위치 vs 실제 위치' 기록: 인지 시스템이 적의 지식을 바꿀 때마다(본 것·들은 것·전해 들은 것)
// 적이 아는 추정 위치·오차와 그 순간 플레이어의 실제 위치를 남긴다. 적이 반칙(실제 좌표 읽기)을 하면
// 오차가 비정상적으로 작거나(말로 들은 위치인데 정확히 맞음) 2σ 밖이 거의 없어진다 — 여기서 확인한다.
//   F3 화면에 요약, 콘솔에서 __game.enemies.senses.log.dump()로 전체(최근 3000건).

export class AILog {
  constructor() {
    this.rows = [];
    this.max = 3000;
    this.bySource = new Map();
  }

  /** @param {object} a 적, @param {string} source 관측 종류 */
  record(t, a, source, px, pz) {
    const K = a.knowledge;
    if (!K.has) return;
    const actual = Math.hypot(K.x - px, K.z - pz);
    const row = { t: +t.toFixed(2), id: a.id, source, kx: +K.x.toFixed(1), kz: +K.z.toFixed(1), err: +K.err.toFixed(1), px: +px.toFixed(1), pz: +pz.toFixed(1), actual: +actual.toFixed(1), d: +Math.hypot(a.x - px, a.z - pz).toFixed(0) };
    this.rows.push(row);
    if (this.rows.length > this.max) this.rows.shift();
    let s = this.bySource.get(source);
    if (!s) this.bySource.set(source, (s = { n: 0, within: 0, sumActual: 0, sumErr: 0, tiny: 0 }));
    s.n++;
    if (actual <= K.err) s.within++;
    s.sumActual += actual;
    s.sumErr += K.err;
    // 소리·전해 들은 정보인데 1 m 안으로 정확하면 이상하다(우연히도 드물어야 함)
    if (source !== 'sight' && actual < 1 && row.d > 30) s.tiny++;
  }

  /** 출처별 요약: 건수, 실제 오차 평균, 아는 오차(2σ) 평균, 실제가 2σ 안에 든 비율, 수상하게 정확한 비율 */
  summary() {
    const out = [];
    for (const [src, s] of this.bySource) {
      out.push({ source: src, n: s.n, actual: s.sumActual / s.n, err: s.sumErr / s.n, within: s.within / s.n, tiny: s.tiny / s.n });
    }
    return out.sort((a, b) => b.n - a.n);
  }

  dump() {
    console.table(this.rows.slice(-200));
    console.table(this.summary());
    return this.rows;
  }

  clear() {
    this.rows.length = 0;
    this.bySource.clear();
  }
}
