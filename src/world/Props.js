// 들판 소품: 원형 짚 더미(지름 1.5 m, 폭 1.2 m, 곡면이 바닥에 닿게 누움).
// 베일러가 지나간 줄을 따라 몇 개씩 떨어져 있다(축은 진행 방향에 수직).
// 충돌(이동·총 걸림)·탄도(재질 'hay')·렌더링이 같은 원기둥을 쓴다.

import { Random } from '../core/Random.js';

export const BALE = { radius: 0.75, width: 1.2 };

export class Props {
  constructor(world, layout, terrain) {
    this.world = world;
    this.terrain = terrain;
    this.bales = [];
    const rng = new Random(world.seed ^ 0xba1e);
    const start = world.playerStart;
    // 그루터기 밭 중 몇 곳에 베일러 줄
    const plans = [
      { rect: [160, -85, 469, 248], lines: 2, perLine: [3, 5] },
      { rect: [-700, -462, -197, -105], lines: 2, perLine: [2, 4] },
      { rect: [-193, -720, 720, -478], lines: 1, perLine: [3, 4] },
      { rect: [-700, 272, -197, 720], lines: 1, perLine: [2, 3] },
    ];
    for (const plan of plans) {
      const f = world.fields.find((ff) => ff.rect.join() === plan.rect.join());
      if (!f || f.type !== 'stubble') continue;
      const [x0, z0, x1, z1] = f.rect;
      const dir = f.dir; // 줄 방향(베일러 진행 방향)
      const tx = Math.cos(dir);
      const tz = Math.sin(dir);
      for (let l = 0; l < plan.lines; l++) {
        // 줄 위치: 밭 안쪽(가장자리·숲띠에서 25 m 이상)
        const cx = x0 + 30 + rng.next() * (x1 - x0 - 60);
        const cz = z0 + 30 + rng.next() * (z1 - z0 - 60);
        const n = rng.int(plan.perLine[0], plan.perLine[1]);
        let s = -rng.range(10, 40);
        for (let k = 0; k < n; k++) {
          s += rng.range(14, 38);
          const x = cx + tx * s + rng.range(-1.5, 1.5);
          const z = cz + tz * s + rng.range(-1.5, 1.5);
          if (x < x0 + 18 || x > x1 - 18 || z < z0 + 18 || z > z1 - 18) continue;
          if (Math.hypot(x - start.x, z - start.z) < 45) continue;
          if (layout.beltAt(x, z, 22)) continue;
          // 축: 진행 방향에 수직 + 약간 틀어짐
          const ang = dir + Math.PI / 2 + rng.range(-0.25, 0.25);
          this._add(x, z, ang, rng);
        }
      }
    }
  }

  _add(x, z, ang, rng) {
    const R = BALE.radius;
    const W = BALE.width;
    const ux = Math.cos(ang);
    const uz = Math.sin(ang);
    // 접지: 바닥면(곡면 아래쪽)이 닿는 지면 높이 중 가장 낮은 곳 + 약간 눌림
    let gmin = Infinity;
    let gavg = 0;
    for (const s of [-0.5, 0, 0.5]) {
      for (const q of [-0.35, 0, 0.35]) {
        const gx = x + ux * s * W - uz * q;
        const gz = z + uz * s * W + ux * q;
        const g = this.terrain.heightAt(gx, gz);
        gmin = Math.min(gmin, g);
        gavg += g / 9;
      }
    }
    const y = (gmin + gavg) * 0.5 + R - 0.06;
    const ax = x - ux * W * 0.5;
    const az = z - uz * W * 0.5;
    const bx = x + ux * W * 0.5;
    const bz = z + uz * W * 0.5;
    this.bales.push({
      kind: 'bale',
      material: 'hay',
      x,
      z,
      y,
      ang,
      ax,
      ay: y,
      az,
      bx,
      by: y,
      bz,
      r: R,
      w: W,
      seed: rng.next(),
    });
  }

  register(hash) {
    for (const b of this.bales) {
      const e = BALE.radius + BALE.width * 0.5 + 0.2;
      hash.insert(b, b.x - e, b.z - e, b.x + e, b.z + e);
    }
  }
}
