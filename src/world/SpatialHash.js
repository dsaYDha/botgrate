// xz 평면 균일 격자 공간 해시. 정적 충돌체(줄기·통나무·그루터기)와 잎 볼륨(수관·덤불)을 등록.
// 질의 시 중복 제거를 위해 객체마다 stamp를 쓴다.

export class SpatialHash {
  constructor(half, cell = 4) {
    this.half = half;
    this.cell = cell;
    this.inv = 1 / cell;
    this.n = Math.ceil((2 * half) / cell);
    this.cells = new Array(this.n * this.n).fill(null);
    this.stamp = 1;
    this.count = 0;
  }

  _ci(x) {
    return Math.floor((x + this.half) * this.inv);
  }

  insert(obj, minX, minZ, maxX, maxZ) {
    const i0 = Math.max(0, this._ci(minX));
    const j0 = Math.max(0, this._ci(minZ));
    const i1 = Math.min(this.n - 1, this._ci(maxX));
    const j1 = Math.min(this.n - 1, this._ci(maxZ));
    obj._stamp = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.n + i;
        (this.cells[k] || (this.cells[k] = [])).push(obj);
      }
    }
    this.count++;
  }

  /** AABB와 겹치는 셀의 객체를 out 배열에 모은다(중복 없음). */
  query(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    const s = ++this.stamp;
    const i0 = Math.max(0, this._ci(minX));
    const j0 = Math.max(0, this._ci(minZ));
    const i1 = Math.min(this.n - 1, this._ci(maxX));
    const j1 = Math.min(this.n - 1, this._ci(maxZ));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.cells[j * this.n + i];
        if (!c) continue;
        for (let k = 0; k < c.length; k++) {
          const o = c[k];
          if (o._stamp !== s) {
            o._stamp = s;
            out.push(o);
          }
        }
      }
    }
    return out;
  }
}
