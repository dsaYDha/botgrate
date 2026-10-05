// npm run test:perception
//
// 경계 중인 적이 그쪽을 볼 때, 조건별로 플레이어를 알아채기('의심')·알아보기('위치 파악')까지 걸리는 시간.
// 게임과 같은 지형·숲띠·땅 덮개(World), 같은 플레이어 몸(PlayerBody), 같은 인지 코드(Senses)를 쓴다.
// 관측자는 표적 쪽 ±12°를 훑어보고, 무엇인가 낌새를 채면 그 추정 위치를 집중해서 본다(두뇌가 하는 일과 같음).
//
// 조건(요청서):
//   1 들판에서 서서 이동, 300 m          → 몇 초 안
//   2 들판에서 서서 정지, 300 m
//   3 숲띠 안 잎 뒤에서 엎드려 정지, 150 m → 쏘지 않으면 탐지되지 않음
//   4 숲띠 안 잎 뒤에서 엎드려 사격 중, 150 m → 사격 횟수에 따라 위치 오차가 줄어듦
//   5 둔덕 위에 서서 하늘을 배경으로, 400 m → 몇 초 안
//      (이 지도의 지평선은 사방이 숲띠라 400 m 거리에서 실제로 하늘을 배경으로 서는 자리는 없다 —
//       실제 둔덕 자리의 크기·시선·조명은 그대로 두고 배경만 하늘로 놓아 계산한다. 실제 배경(숲띠)일 때도 함께 출력.)

import { World } from '../src/world/World.js';
import { Senses, VisualState } from '../src/ai/Senses.js';
import { ThreatKnowledge } from '../src/ai/Knowledge.js';
import { PlayerBody } from '../src/player/PlayerBody.js';
import { MOVEMENT } from '../src/data/movement.js';
import { EventBus } from '../src/core/EventBus.js';
import { rng } from '../src/core/Random.js';

const TRIALS = Number(process.env.PERC_TRIALS || 60);
const MAXT = 90; // s
const DT = 0.05;
const DEG = Math.PI / 180;

console.log('지형·숲띠를 만드는 중…');
const world = new World();
world.wind.set(3, 270);
const T = world.terrain;

// 플레이어(가짜 입력, 실제 몸 모델)
function makePlayer(x, z, stance, yaw) {
  return { x, z, y: T.heightAt(x, z), yaw, pitch: 0, eyeH: MOVEMENT.eyeHeight[stance], stance, transition: null, lean: 0, speed: 0 };
}
function eyeOf(p) {
  return { x: p.x, y: p.y + p.eyeH, z: p.z };
}

function makeObserver(x, z, eyeH, look) {
  const gy = T.heightAt(x, z);
  const a = {
    id: 'obs',
    pos: { x, z },
    knowledge: new ThreatKnowledge(),
    vis: new VisualState(),
    cracks: new Map(),
    rangeError: 0.15,
    visionScale: 1,
    t: 0,
    phase: rng.next() * 10,
    noticeT: -1,
    locT: -1,
    eye(out) {
      out.x = x;
      out.y = gy + eyeH;
      out.z = z;
      return out;
    },
    gaze(out) {
      // 낌새가 있으면 그 추정 위치, 없으면 표적 쪽 ±12° 훑기
      const K = a.knowledge;
      let yaw;
      if (K.has && K.suspicion > 0.3) yaw = Math.atan2(K.x - x, -(K.z - z)) + Math.sin(a.t * 1.7 + a.phase) * 2 * DEG;
      else yaw = Math.atan2(look.x - x, -(look.z - z)) + Math.sin(a.t * 0.5 + a.phase) * 12 * DEG;
      const ty = look.y - (gy + eyeH);
      const pitch = Math.atan2(ty, Math.hypot(look.x - x, look.z - z));
      out.x = Math.sin(yaw) * Math.cos(pitch);
      out.y = Math.sin(pitch);
      out.z = -Math.cos(yaw) * Math.cos(pitch);
      return out;
    },
    canPerceive: () => true,
    inShade: () => world.belts.canopyAt(x, z) > 0.35,
    onObservation(kind) {
      if ((kind === 'glimpse' || kind === 'sight') && a.noticeT < 0) a.noticeT = a.t;
      if (kind === 'sight' && a.locT < 0) a.locT = a.t;
    },
  };
  return a;
}

/**
 * 한 조건을 여러 번 시험
 * @param {object} c {player:{x,z,stance,yaw}, obs:{x,z,eyeH}, move:{vx,vz}, forceBg, fire:{every, n}}
 */
function run(c) {
  const res = { notice: [], located: [], errAfter: [] };
  for (let k = 0; k < TRIALS; k++) {
    const events = new EventBus();
    const p = makePlayer(c.player.x, c.player.z, c.player.stance, c.player.yaw);
    const body = new PlayerBody();
    const truth = { player: p, body, weapon: null };
    const senses = new Senses(world, events, truth);
    const look = { x: p.x, y: p.y + 1, z: p.z };
    const a = makeObserver(c.obs.x, c.obs.z, c.obs.eyeH, look);
    senses.register(a);
    if (c.forceBg) {
      // 배경만 바꿔 계산(위 설명)
      senses.sight.background = () => ({ kind: c.forceBg, dist: 1000 });
    }
    body.update(p, eyeOf(p));
    let t = 0;
    let nextShot = c.fire ? 2 : Infinity;
    let shots = 0;
    const errs = [];
    while (t < MAXT) {
      // 움직임(가로질러 왕복)
      if (c.move) {
        const ph = Math.sin((t / 20) * Math.PI * 2);
        p.x = c.player.x + c.move.vx * 20 / (2 * Math.PI) * ph;
        p.z = c.player.z + c.move.vz * 20 / (2 * Math.PI) * ph;
        p.y = T.heightAt(p.x, p.z);
        p.speed = Math.hypot(c.move.vx, c.move.vz) * Math.abs(Math.cos((t / 20) * Math.PI * 2));
      }
      body.update(p, eyeOf(p));
      // 사격
      if (t >= nextShot && shots < c.fire.n) {
        shots++;
        nextShot += c.fire.every;
        const e = eyeOf(p);
        const yaw = Math.atan2(a.pos.x - p.x, -(a.pos.z - p.z));
        const dir = { x: Math.sin(yaw), y: 0.002, z: -Math.cos(yaw) };
        const muzzle = { x: e.x + dir.x * 0.75, y: e.y - 0.05, z: e.z + dir.z * 0.75 };
        const id = 1000 + shots;
        events.emit('shot', { shooter: 'player', position: muzzle, direction: dir, stance: p.stance, bulletId: id });
        // 탄이 관측자 옆 4 m를 지나감 → '딱'
        const d = Math.hypot(a.pos.x - muzzle.x, a.pos.z - muzzle.z);
        const emit = { x: muzzle.x + dir.x * (d - 8), z: muzzle.z + dir.z * (d - 8) };
        senses.pending.push({ at: senses.time + d / 850, agent: a, fn: () => senses.crack(a, { shotId: id, distance: 4, emit, supersonic: true }) });
        // 이 발 뒤 오차를 다음 발 직전에 기록
      }
      senses.update(DT);
      a.t = t;
      t += DT;
      if (c.fire && shots > 0 && Math.abs(t - (2 + shots * c.fire.every - 0.05)) < DT / 2) {
        const K = a.knowledge;
        errs[shots - 1] = K.has ? Math.hypot(K.x - p.x, K.z - p.z) : Infinity;
        if (!errs.r) errs.r = [];
        errs.r[shots - 1] = K.err;
      }
      if (!c.fire && a.locT >= 0) break;
    }
    res.notice.push(a.noticeT < 0 ? Infinity : a.noticeT);
    res.located.push(a.locT < 0 ? Infinity : a.locT);
    res.errAfter.push(errs);
  }
  return res;
}

const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const fmtT = (x) => (x === Infinity ? '   없음' : `${x.toFixed(1).padStart(5)} s`);
const within = (arr, t) => arr.filter((x) => x <= t).length / arr.length;

// ---------------------------------------------------------------------------
// 자리 고르기
// 관측자: 가운데 숲띠 남쪽 가장자리 경계병. 가장자리 잡초(0.7~1.1 m) 너머를 보려고 서 있다(눈높이 1.62 m), 남쪽을 봄
const OBS = { x: 360, z: -80, eyeH: 1.62 };
// 1·2: 남쪽 그루터기 밭 300 m
const FIELD = { x: 360, z: -80 + 300, stance: 'stand', yaw: 0 };

// 3·4: 남쪽 숲띠 안, 북쪽 가장자리에서 3~6 m 들어간 잎 뒤(관측자 150 m 북쪽 들판, 엎드림 눈높이 0.35 m가 아니라
//      들판 경계병 무릎 1.0 m) — 엎드린 머리까지 투과율이 거의 0인 자리를 고른다
const senses0 = new Senses(world, new EventBus(), { player: makePlayer(0, 0, 'prone', 0), body: new PlayerBody(), weapon: null });
let HIDE = null;
for (let x = 300; x < 460 && !HIDE; x += 3) {
  for (let dz = 3; dz <= 6 && !HIDE; dz += 1) {
    const z = 248 + dz;
    const ox = x;
    const oz = z - 150;
    const p = makePlayer(x, z, 'prone', 0);
    const b = new PlayerBody();
    b.update(p, eyeOf(p));
    const gy = T.heightAt(ox, oz);
    const tr = [0, 0, 0, 0, 0];
    senses0.sight.transmissionMulti(ox, gy + 1.0, oz, b.samples, tr);
    const best = Math.max(...tr);
    // 잎 뒤(머리·어깨가 거의 안 보임)이지만 단단한 줄기 바로 뒤는 아닌 곳
    if (best < 0.03 && tr[0] > 0) HIDE = { x, z, ox, oz, best };
  }
}
if (!HIDE) {
  // 잎 투과율이 가장 낮은 자리라도
  HIDE = { x: 380, z: 252, ox: 380, oz: 102, best: NaN };
}

// 5: 둔덕(330, −89 근처가 아닌 들판 한가운데 둔덕) — 들판 둔덕(60, 70)에서 400 m 떨어진 엎드린 관측자
const BERM = world.data.berms.find((b) => b.x === 60 && b.z === 70);
const SKY = { x: BERM.x, z: BERM.z, stance: 'stand', yaw: Math.PI / 2 };
const SKY_OBS = { x: BERM.x + 400, z: BERM.z, eyeH: 0.35 };

console.log(`관측자: 경계 중, 표적 쪽 ±12° 훑어봄(낌새를 채면 그곳을 집중). 표본 ${TRIALS}회, 최대 ${MAXT} s, 바람 3 m/s`);
console.log(`숨은 자리(3·4): (${HIDE.x}, ${HIDE.z}) 숲띠 북쪽 가장자리 안, 관측자 (${HIDE.ox}, ${HIDE.oz}) 무릎 — 엎드린 몸 최대 투과율 ${HIDE.best.toFixed(3)}`);
console.log('');
console.log(`${'조건'.padEnd(36)} ${'알아챔(중앙)'.padStart(10)} ${'알아봄(중앙)'.padStart(10)}  10 s 안  60 s 안`);

const rows = [];
function row(name, c, expect) {
  const r = run(c);
  const n = median(r.notice);
  const l = median(r.located);
  const w10 = within(r.located, 10);
  const w60 = within(r.located, 60);
  rows.push({ name, n, l, w10, w60, r, expect });
  console.log(`${name.padEnd(36)} ${fmtT(n).padStart(10)} ${fmtT(l).padStart(10)}  ${(w10 * 100).toFixed(0).padStart(5)} %  ${(w60 * 100).toFixed(0).padStart(5)} %`);
  return r;
}

row('1 들판, 서서 이동(걷기), 300 m', { player: FIELD, obs: OBS, move: { vx: 1.5, vz: 0 } });
row('2 들판, 서서 정지, 300 m', { player: FIELD, obs: OBS });
row('  들판, 엎드려 정지, 300 m', { player: { ...FIELD, stance: 'prone' }, obs: OBS });
row('  들판, 엎드려 기어감, 300 m', { player: { ...FIELD, stance: 'prone' }, obs: OBS, move: { vx: 0.4, vz: 0 } });
row('3 숲띠 안 잎 뒤, 엎드려 정지, 150 m', { player: { x: HIDE.x, z: HIDE.z, stance: 'prone', yaw: 0 }, obs: { x: HIDE.ox, z: HIDE.oz, eyeH: 1.0 } });
row('5 둔덕 위 서서, 하늘 배경, 400 m', { player: SKY, obs: SKY_OBS, forceBg: 'sky' });
row('  둔덕 위 서서, 실제 배경(숲띠), 400 m', { player: SKY, obs: SKY_OBS });

// 4: 사격 중 — 쏠 때마다 위치 오차
console.log('');
console.log('4 숲띠 안 잎 뒤, 엎드려 사격 중, 150 m (4 s마다 한 발, 탄은 관측자 옆 4 m를 지나감)');
const N = 10;
const fireRes = run({ player: { x: HIDE.x, z: HIDE.z, stance: 'prone', yaw: 0 }, obs: { x: HIDE.ox, z: HIDE.oz, eyeH: 1.0 }, fire: { every: 4, n: N } });
const errLine = [];
const radLine = [];
for (let s = 0; s < N; s++) {
  const e = fireRes.errAfter.map((x) => x[s]).filter((v) => v !== undefined && v !== Infinity);
  const r = fireRes.errAfter.map((x) => (x.r ? x.r[s] : undefined)).filter((v) => v !== undefined && v !== Infinity);
  errLine.push(e.length ? median(e) : Infinity);
  radLine.push(r.length ? median(r) : Infinity);
}
console.log(`   사격 횟수      ${Array.from({ length: N }, (_, i) => String(i + 1).padStart(6)).join('')}`);
console.log(`   추정 오차(m)   ${errLine.map((v) => (v === Infinity ? '     -' : v.toFixed(0).padStart(6))).join('')}   (실제 위치와의 거리, 중앙값)`);
console.log(`   오차 반지름(m) ${radLine.map((v) => (v === Infinity ? '     -' : v.toFixed(0).padStart(6))).join('')}   (적이 아는 2σ 오차)`);
const locFire = median(fireRes.located);
console.log(`   눈으로 위치를 확인(섬광·먼지·풀잎 흔들림): 중앙 ${fmtT(locFire)}, ${MAXT} s 안 ${(within(fireRes.located, MAXT) * 100).toFixed(0)} %`);

// 판정
const by = (prefix) => rows.find((r) => r.name.startsWith(prefix));
const checks = [
  ['1 서서 이동 300 m: 알아봄 중앙값 10 s 이하', by('1 ').l <= 10],
  ['5 하늘 배경 400 m: 알아봄 중앙값 10 s 이하', by('5 ').l <= 10],
  ['3 잎 뒤 엎드려 정지: 90 s 안에 알아봄 5 % 이하', within(by('3 ').r.located, MAXT) <= 0.05],
  ['2 서서 정지가 1 서서 이동보다 늦음', by('2 ').l > by('1 ').l],
  ['4 사격 중: 추정 오차가 첫 발보다 마지막 발 뒤에 작음', errLine[N - 1] < errLine[0] && radLine[N - 1] < radLine[0]],
];
console.log('');
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? '통과' : '실패'}: ${label}`);
  ok = ok && pass;
}
process.exit(ok ? 0 : 1);
