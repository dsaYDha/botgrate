// Web Audio 엔진: 합성 음원 재생, 음속 지연(343 m/s), 거리 감쇠·공기 흡수(고음 감쇠),
// 숲띠 통과 감쇠(띠 안을 지난 길이만큼 작고 둔하게), 바람(풍하측으로 잘 들림), HRTF 공간화,
// 환경 잔향(들판: 짧고 성김 + 숲띠 메아리, 숲띠 안: 줄기 반사로 길게), 배경음(바람·잎·풀벌레).
// 적 총성: 사수 위치에서 거리/343 s 뒤 + 둘레 숲띠 가장자리에서 돌아오는 메아리.
// 탄 스침: 초음속이면 '딱' — 사수 쪽이 아니라 마하 원뿔이 나온 탄 경로 위 점에서, 스친 거리가 가까울수록 날카롭고 크게.
//         아음속이면 '휙'. 그래서 '딱'만으로는 사수 방향을 알 수 없고, 뒤이은 '쾅'과의 시간차로 거리를 가늠한다.

import * as THREE from 'three';
import { buildSoundBank } from './SoundBank.js';
import { ATMOSPHERE } from '../data/atmosphere.js';
import { rng } from '../core/Random.js';

const C = ATMOSPHERE.soundSpeed;

export class AudioEngine {
  constructor(events, world, settings) {
    this.events = events;
    this.world = world;
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    this.listener = new THREE.Vector3();
    this.listenerQuat = new THREE.Quaternion();
    this.forest = 0;
    this.voices = 0;
    this.maxVoices = 56;
    this.lastStepSound = 0;
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 44100 });
    const ctx = this.ctx;
    this.bank = buildSoundBank(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.get('volume');
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -8;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.15;
    this.master.connect(this.comp).connect(ctx.destination);
    // 잔향 버스
    this.revField = ctx.createConvolver();
    this.revField.buffer = this.bank.irField;
    this.revForest = ctx.createConvolver();
    this.revForest.buffer = this.bank.irForest;
    this.revFieldGain = ctx.createGain();
    this.revForestGain = ctx.createGain();
    this.revSend = ctx.createGain();
    this.revSend.connect(this.revField);
    this.revSend.connect(this.revForest);
    this.revField.connect(this.revFieldGain).connect(this.master);
    this.revForest.connect(this.revForestGain).connect(this.master);
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    this._setupAmbience();
    this.settings.onChange((k, v) => {
      if (k === 'volume' && this.master) this.master.gain.value = v;
    });
    this._bindEvents();
    this.ready = true;
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  _setupAmbience() {
    const ctx = this.ctx;
    const loop = (buffer, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 800;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(this.master);
      src.start(ctx.currentTime + Math.random() * 0.1, Math.random() * 2);
      return { src, f, g };
    };
    this.ambWind = loop(this.bank.windLoop, 0);
    this.ambWind2 = loop(this.bank.windLoop, 0);
    this.ambWind2.src.playbackRate.value = 0.62;
    this.ambLeaves = loop(this.bank.leavesLoop, 0);
    this.ambLeaves.f.type = 'highpass';
    this.ambLeaves.f.frequency.value = 1800;
    this.ambCrickets = loop(this.bank.cricketsLoop, 0.0);
    this.ambCrickets.f.type = 'highpass';
    this.ambCrickets.f.frequency.value = 3000;
  }

  /** 매 프레임: 청자 위치·방향, 환경(숲 덮임), 바람 */
  update(dt, camPos, camQuat, time) {
    if (!this.ready) return;
    const ctx = this.ctx;
    this.listener.copy(camPos);
    this.listenerQuat.copy(camQuat);
    const L = ctx.listener;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camQuat);
    if (L.positionX) {
      L.positionX.value = camPos.x;
      L.positionY.value = camPos.y;
      L.positionZ.value = camPos.z;
      L.forwardX.value = fwd.x;
      L.forwardY.value = fwd.y;
      L.forwardZ.value = fwd.z;
      L.upX.value = up.x;
      L.upY.value = up.y;
      L.upZ.value = up.z;
    } else {
      L.setPosition(camPos.x, camPos.y, camPos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
    // 숲 덮임 정도(주변 평균)
    let f = 0;
    for (const [ox, oz] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) f += this.world.belts.canopyAt(camPos.x + ox, camPos.z + oz);
    this.forest += (f / 5 - this.forest) * Math.min(1, dt * 2);
    this.revFieldGain.gain.value = 0.32 * (1 - this.forest);
    this.revForestGain.gain.value = 0.55 * this.forest;

    // 바람 소리: 귀 높이 바람 + 돌풍
    const w = this.world.wind;
    const out = { x: 0, y: 0, z: 0 };
    const gy = this.world.terrain.heightAt(camPos.x, camPos.z);
    const sp = w.sample(camPos.x, camPos.y, camPos.z, time, out, gy);
    const k = Math.min(1.4, sp / 8);
    const t = ctx.currentTime;
    this.ambWind.g.gain.setTargetAtTime(0.06 + 0.42 * Math.pow(k, 1.6), t, 0.25);
    this.ambWind.f.frequency.setTargetAtTime(300 + 1100 * k, t, 0.3);
    this.ambWind2.g.gain.setTargetAtTime(0.05 + 0.25 * k, t, 0.4);
    this.ambWind2.f.frequency.setTargetAtTime(180 + 400 * k, t, 0.4);
    // 잎 스치는 소리: 주변 수관(나무 꼭대기는 띠 안에서도 바람을 받음)
    const canopyWind = w.speed * w.gust(camPos.x, camPos.z, time) * 0.8;
    let near = 0;
    for (const [ox, oz] of [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10], [20, 0], [-20, 0], [0, 20], [0, -20]]) near += this.world.belts.canopyAt(camPos.x + ox, camPos.z + oz);
    near /= 9;
    this.ambLeaves.g.gain.setTargetAtTime(Math.min(0.5, near * 0.06 * canopyWind), t, 0.3);
    this.ambCrickets.g.gain.setTargetAtTime(0.045 * Math.max(0, 1 - sp / 7) * (1 - this.forest * 0.5), t, 1.0);
  }

  _pick(arr) {
    return arr[Math.floor(rng.next() * arr.length)];
  }

  /** 두 점 사이 2차원 경로가 숲띠(수관·덤불 지도)를 지나는 길이(m) */
  _beltPath(ax, az, bx, bz) {
    const c = this.world.canopy;
    if (!c) return 0;
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.min(400, Math.ceil(L / 2));
    let len = 0;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const i = Math.floor((ax + (bx - ax) * t + c.half) / c.res);
      const j = Math.floor((az + (bz - az) * t + c.half) / c.res);
      if (i < 0 || j < 0 || i >= c.N || j >= c.N) continue;
      const q = (j * c.N + i) * 4;
      if (c.data[q] > 90 || c.data[q + 1] > 120) len += L / n;
    }
    return len;
  }

  /**
   * 위치 있는 소리 재생. 음속 지연·거리 감쇠·공기 흡수·바람 방향 효과.
   * @param {AudioBuffer} buffer
   * @param {{x,y,z}} pos
   * @param {object} o {gain(1 m 기준), ref(기준 거리), rate, reverb(0~1), delay(추가), noDelay}
   */
  propagate(buffer, pos, o = {}) {
    if (!this.ready || this.voices >= this.maxVoices) return;
    const ctx = this.ctx;
    const dx = pos.x - this.listener.x;
    const dy = pos.y - this.listener.y;
    const dz = pos.z - this.listener.z;
    const d = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const ref = o.ref || 1;
    let gain = (o.gain ?? 1) * Math.min(1, ref / d);
    // 바람 방향 굴절(풍하측으로 잘 퍼지고 풍상측은 약해짐)
    const w = this.world.wind;
    const along = d > 1 ? (w.dirX * (-dx / d) + w.dirZ * (-dz / d)) : 0;
    gain *= 1 + Math.max(-0.5, Math.min(0.35, along * (w.speed / 8) * Math.min(1, d / 250) * 0.45));
    // 숲띠를 지나면: 띠 안 1 m당 약 0.12 dB 감쇠, 고음이 더 깎임
    let beltLen = 0;
    if (o.belts !== false && d > 25) beltLen = this._beltPath(this.listener.x, this.listener.z, pos.x, pos.z);
    if (beltLen > 0) gain *= Math.pow(10, (-0.12 * beltLen) / 20);
    if (gain < 0.0004) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate || 1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // 공기 흡수(거리) + 숲띠 통과
    lp.frequency.value = Math.max(500, Math.min(20000, 20000 * Math.pow(40 / Math.max(40, d), 0.75) * Math.exp(-beltLen / 45) * (o.lowpass || 1)));
    const g = ctx.createGain();
    g.gain.value = gain;
    const pan = ctx.createPanner();
    pan.panningModel = o.hrtf === false ? 'equalpower' : 'HRTF';
    pan.distanceModel = 'linear';
    pan.refDistance = 1;
    pan.maxDistance = 1e6;
    pan.rolloffFactor = 0;
    if (pan.positionX) {
      pan.positionX.value = pos.x;
      pan.positionY.value = pos.y;
      pan.positionZ.value = pos.z;
    } else pan.setPosition(pos.x, pos.y, pos.z);
    src.connect(lp).connect(g).connect(pan);
    pan.connect(this.dry);
    const rev = o.reverb ?? 0.35;
    if (rev > 0) {
      const sg = ctx.createGain();
      sg.gain.value = rev;
      pan.connect(sg).connect(this.revSend);
    }
    const delay = (o.noDelay ? 0 : d / C) + (o.delay || 0);
    src.start(ctx.currentTime + Math.max(0, delay));
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
    };
    return d;
  }

  /** 청자 머리 기준(무기·장비·호흡) 소리 */
  playLocal(buffer, gain = 0.5, o = {}) {
    if (!this.ready || this.voices >= this.maxVoices) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate || 1;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.dry);
    if (o.reverb) {
      const sg = ctx.createGain();
      sg.gain.value = o.reverb;
      g.connect(sg).connect(this.revSend);
    }
    src.start(ctx.currentTime + (o.delay || 0));
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
    };
  }

  // ---------------------------------------------------------------------------
  _bindEvents() {
    const ev = this.events;
    ev.on('shot', (e) => this.onShot(e));
    ev.on('bullet:impact', (e) => this.onImpact(e));
    ev.on('bullet:foliage', (e) => {
      if (!this.ready) return;
      // 잎을 찢는 소리: 가까이(25 m 안) 날아든 남의 탄은 언제나, 그 밖은 반쯤
      const near = e.shooter !== 'player' && Math.hypot(e.x - this.listener.x, e.z - this.listener.z) < 25;
      if (near || rng.next() < 0.5) this.propagate(this._pick(this.bank.impact.leaves), e, { gain: near ? 1.0 : 0.5, ref: 3, reverb: 0.1 });
    });
    ev.on('weapon:sound', (e) => this.onWeaponSound(e));
    // 거치: 총을 통나무·흙·줄기에 걸칠 때 작게 스치는 소리
    ev.on('weapon:rest', () => {
      if (this.ready) this.playLocal(this._pick(this.bank.gear), 0.09, { rate: 1.25 });
    });
    ev.on('player:step', (e) => this.onStep(e));
    ev.on('player:stance', (e) => {
      const s = this.bank.step[e.to === 'prone' || e.from === 'prone' ? 'grass' : 'dirt'];
      this.playLocal(this._pick(s), 0.25, { rate: 0.8 });
      this.playLocal(this._pick(this.bank.gear), 0.2);
    });
    ev.on('player:stanceDone', (e) => {
      if (e.stance === 'prone') this.playLocal(this._pick(this.bank.impact.fall), 0.18, { rate: 1.3 });
    });
    ev.on('breath', (e) => {
      if (e.type === 'hold') this.playLocal(this.bank.breath.inhale, 0.16, { rate: 1.2 });
      else if (e.type === 'exhale') this.playLocal(this.bank.breath.exhale, 0.16);
      else if (e.type === 'gasp') this.playLocal(this.bank.breath.gasp, 0.3);
    });
    // 남의 탄이 스침: 초음속 '딱'(마하 원뿔 방출점에서), 아음속 '휙'
    ev.on('bullet:flyby', (e) => this.playFlyby(e));
    ev.on('enemy:shout', (e) => {
      if (!this.ready) return;
      const bank = this.bank.shout[e.kind] || this.bank.shout.contact;
      const loud = e.kind === 'suspicious' ? 1.2 : 9;
      this.propagate(this._pick(bank), e.position, { gain: loud, ref: 1, reverb: 0.5, delay: e.delay || 0, rate: 0.95 + rng.next() * 0.1 });
    });
    ev.on('enemy:handling', (e) => {
      if (!this.ready) return;
      const m = this.bank.mech[e.type];
      if (m) this.propagate(this._pick(m), e.enemy.chestWorld, { gain: 1.0, ref: 1, reverb: 0.15 });
    });
    ev.on('enemy:reload', (e) => {
      if (!this.ready) return;
      this.propagate(this._pick(this.bank.mech.magRelease), e.enemy.chestWorld, { gain: 0.8, ref: 1, reverb: 0.15 });
    });
    ev.on('player:hit', () => {
      if (!this.ready) return;
      this.playLocal(this._pick(this.bank.impact.body), 0.9, { rate: 0.8 });
      this.playLocal(this.bank.breath.gasp, 0.45, { rate: 0.85 });
    });
    ev.on('player:tourniquet', (e) => {
      if (!this.ready) return;
      if (e.phase === 'start') this.playLocal(this.bank.tq.rip, 0.35);
      else if (e.phase === 'turn' || e.phase === 'done') this.playLocal(this.bank.tq.click, 0.3, { rate: 0.9 + rng.next() * 0.2 });
    });
    ev.on('enemy:fallSound', (e) => this.propagate(this._pick(this.bank.impact.fall), e.position, { gain: 2.2 * (e.intensity || 1), ref: 2, reverb: 0.25 }));
    ev.on('enemy:rifleDrop', (e) => this.propagate(this._pick(this.bank.impact.rifleDrop), e.position, { gain: 1.4, ref: 2, reverb: 0.2 }));
  }

  /** 총성: 근거리 원음 + 환경 잔향 + 숲띠 가장자리에서 돌아오는 메아리 */
  onShot(e) {
    if (!this.ready) return;
    const isPlayer = e.shooter === 'player';
    const buffer = this._pick(this.bank.gunshot);
    const p = e.position;
    if (isPlayer) {
      this.playLocal(buffer, 0.95, { reverb: 0.9, rate: 0.97 + rng.next() * 0.06 });
    } else {
      // 적 총성(7.62×39는 조금 낮고 굵게) — 거리/343 s 뒤, 숲띠를 지나면 작고 둔하게
      this.propagate(buffer, p, { gain: 60, ref: 1, reverb: 0.8, rate: 0.9 + rng.next() * 0.05 });
    }
    // 메아리: 숲띠 가장자리(직선 가장자리를 거울로 본 상(像) 음원 → 청자)
    const L = this.listener;
    for (const b of this.world.layout.belts) {
      for (const sgn of [-1, 1]) {
        const edge = sgn * b.half;
        const sl = b.toLocal(p.x, p.z);
        const ll = b.toLocal(L.x, L.z);
        // 음원·청자가 이 가장자리의 바깥 같은 쪽에 있어야 반사
        if ((sl.v - edge) * sgn <= 4 || (ll.v - edge) * sgn <= 0) continue;
        const sv = sl.v - edge;
        const lv = ll.v - edge;
        // 반사점(가장자리 위): 거울상 음원과 청자를 잇는 선이 가장자리와 만나는 곳
        const t = sv / (sv + lv);
        const u = sl.u + (ll.u - sl.u) * t;
        if (u < b.from || u > b.to || b.inGap(u)) continue;
        const R = b.toWorld(u, edge);
        const d1 = Math.hypot(R.x - p.x, R.z - p.z);
        const d2 = Math.hypot(R.x - L.x, R.z - L.z);
        const direct = Math.hypot(L.x - p.x, L.z - p.z);
        if (d1 + d2 - direct < 15 || d1 + d2 > 1400) continue;
        const pos = { x: R.x, y: p.y + 4, z: R.z };
        const g = (isPlayer ? 2.3 : 60 * 0.3) * Math.min(1, 1 / Math.max(1, d1 / 40));
        this.propagate(buffer, pos, { gain: g, ref: 1, reverb: 0.6, delay: d1 / C, rate: 0.9, lowpass: 0.5, belts: false });
      }
    }
  }

  onImpact(e) {
    if (!this.ready) return;
    const b = this.bank.impact;
    if (e.kind === 'ground') {
      this.propagate(this._pick(b.dirt), e, { gain: 2.4, ref: 1.5, reverb: 0.3 });
      if (e.ricochet) this.propagate(this._pick(b.ricochet), e, { gain: 2.0, ref: 2, reverb: 0.2, rate: 0.9 + rng.next() * 0.2 });
    } else if (e.kind === 'trunk' || e.kind === 'log') {
      this.propagate(this._pick(b.wood), e, { gain: 3.0, ref: 1.5, reverb: 0.35 });
    } else if (e.kind === 'rootPlate') {
      this.propagate(this._pick(b.dirt), e, { gain: 2.2, ref: 1.5, reverb: 0.3 });
    } else if (e.kind === 'bale') {
      // 짚 더미: 둔하고 짧은 소리
      this.propagate(this._pick(b.dirt), e, { gain: 1.8, ref: 1.5, reverb: 0.2, rate: 0.8 });
    } else if (e.kind === 'body') {
      // 명중음: 둔탁한 타격음(거리만큼 늦게 도착)
      this.propagate(this._pick(b.body), e, { gain: 4.5, ref: 1.5, reverb: 0.3 });
    }
  }

  onWeaponSound(e) {
    if (!this.ready) return;
    const m = this.bank.mech[e.type];
    if (m) this.playLocal(this._pick(m), e.type === 'boltRelease' ? 0.6 : 0.42, { reverb: 0.15 });
  }

  onStep(e) {
    if (!this.ready) return;
    const map = { stubble: 'stubble', plowed: 'plowed', fallow: 'weeds', forest: 'leaves', road: 'dirt', grass: 'grass' };
    const s = this.bank.step[map[e.surface] || 'grass'];
    const loud = e.stance === 'prone' ? 0.12 : e.sprint ? 0.42 : e.speed > 2.2 ? 0.32 : e.stance === 'crouch' ? 0.14 : 0.2;
    this.playLocal(this._pick(s), loud * (0.85 + rng.next() * 0.3), { rate: 0.9 + rng.next() * 0.2 });
    if (e.shrub > 0.2) this.playLocal(this._pick(this.bank.step.weeds), 0.3 * e.shrub, { rate: 0.8 + rng.next() * 0.3 });
    if (e.speed > 2.2 && rng.next() < 0.6) this.playLocal(this._pick(this.bank.gear), e.sprint ? 0.12 : 0.07);
  }

  playCasing(pos, surface) {
    if (!this.ready) return;
    const hard = surface === 'road';
    this.propagate(this._pick(hard ? this.bank.casingHard : this.bank.casingSoft), pos, { gain: hard ? 0.5 : 0.35, ref: 1, reverb: 0.1, noDelay: false });
  }

  playMagDrop(pos, surface) {
    if (!this.ready) return;
    this.propagate(this._pick(this.bank.impact.rifleDrop), pos, { gain: 0.25, ref: 1, reverb: 0.1, rate: 1.5 });
  }

  /**
   * 탄 스침: 초음속이면 '딱'을 마하 원뿔 방출점(탄 경로 위, 최근접점보다 사수 쪽)에서, 충격파가 닿는 시각에.
   * N파(Whitham): 과압 ∝ (M²−1)^(1/8) · r^(−3/4), 길이 ∝ M · r^(1/4) / (M²−1)^(3/8).
   * 가까울수록, 빠를수록 짧고 날카롭다. 음속에 가까워진 탄(먼 거리)은 약하고 둔하다. 아음속이면 '휙'(가까울 때만).
   */
  playFlyby(e) {
    if (!this.ready) return;
    const r = Math.max(0.3, e.distance);
    if (e.supersonic) {
      const M = Math.max(1.0005, e.speed / C);
      const m2 = M * M - 1;
      // N파 길이(마하 2·1 m 기준 1): 1.19 이하 '가까이', 1.78 이하 '중간'(마하 2에서 2 m·10 m에 해당)
      const len = (M * Math.pow(r, 0.25)) / Math.pow(m2, 0.375) / 1.32;
      const buf = len < 1.19 ? this.bank.crack.near : len < 1.78 ? this.bank.crack.mid : this.bank.crack.far;
      const gain = Math.min(6, 9 * Math.pow(1 / r, 0.75) * (Math.pow(m2, 0.125) / 1.03));
      this.propagate(buf, e.emit, { gain, ref: 1, reverb: 0.35, noDelay: true, delay: e.delay, belts: false });
    } else if (r < 6) {
      this.propagate(this.bank.whiz, e.emit, { gain: 1.4 / Math.max(0.5, r), ref: 1, reverb: 0.1, noDelay: true, delay: e.delay, rate: 0.9 + rng.next() * 0.2, belts: false });
    }
  }

  /** 심장 박동: 다쳤거나 몹시 긴장(제압)했을 때, 심박에 맞춰 */
  heartbeatTick(dt, heart, intensity) {
    if (!this.ready || intensity <= 0.02) {
      this._hbT = 0;
      return;
    }
    this._hbT = (this._hbT || 0) + dt;
    const period = 60 / Math.max(50, heart);
    if (this._hbT >= period) {
      this._hbT -= period;
      this.playLocal(this.bank.heartbeat, 0.12 + 0.45 * Math.min(1, intensity), { rate: 0.95 + rng.next() * 0.05 });
    }
  }

  /** 거친 호흡(질주 후): Game이 호흡 위상에 맞춰 호출 */
  breathe(inhale, exertion) {
    if (!this.ready || exertion < 0.15) return;
    this.playLocal(inhale ? this.bank.breath.inhale : this.bank.breath.exhale, 0.05 + 0.25 * exertion, { rate: 0.9 + exertion * 0.25 });
  }
}
