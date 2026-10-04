// Web Audio 엔진: 합성 음원 재생, 음속 지연(343 m/s), 거리 감쇠·공기 흡수(고음 감쇠),
// 환경 잔향(들판: 짧고 성김 + 숲띠 메아리, 숲띠 안: 줄기 반사로 길게), 배경음(바람·잎·풀벌레).
// 같은 전파 경로(propagate)에 2단계의 적 총성·초음속 탄 스침 소리를 얹을 수 있다.

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
    if (gain < 0.0004) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate || 1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(900, Math.min(20000, 20000 * Math.pow(40 / Math.max(40, d), 0.75)));
    const g = ctx.createGain();
    g.gain.value = gain;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
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
    src.start(ctx.currentTime + delay);
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
      if (this.ready && rng.next() < 0.5) this.propagate(this._pick(this.bank.impact.leaves), e, { gain: 0.5, ref: 3, reverb: 0.1 });
    });
    ev.on('weapon:sound', (e) => this.onWeaponSound(e));
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
    ev.on('enemy:fallSound', (e) => this.propagate(this._pick(this.bank.impact.fall), e.position, { gain: 2.2 * (e.intensity || 1), ref: 2, reverb: 0.25 }));
    ev.on('enemy:rifleDrop', (e) => this.propagate(this._pick(this.bank.impact.rifleDrop), e.position, { gain: 1.4, ref: 2, reverb: 0.2 }));
  }

  /** 총성: 근거리 원음 + 환경 잔향 + 주변 숲띠에서 돌아오는 메아리 */
  onShot(e) {
    if (!this.ready) return;
    const isPlayer = e.shooter === 'player';
    const buffer = this._pick(this.bank.gunshot);
    if (isPlayer) {
      this.playLocal(buffer, 0.95, { reverb: 0.9, rate: 0.97 + rng.next() * 0.06 });
    } else {
      // 2단계: 적 총성 — 거리 지연 포함
      this.propagate(buffer, e.position, { gain: 60, ref: 1, reverb: 0.8 });
    }
    // 숲띠 메아리: 들판에서 총성이 띠에 맞고 되돌아오는 소리(왕복 거리 / 음속)
    const p = e.position;
    for (const b of this.world.layout.belts) {
      const { u, v } = b.toLocal(p.x, p.z);
      if (u < b.from - 50 || u > b.to + 50) continue;
      const dEdge = Math.abs(v) - b.half;
      if (dEdge < 8 || dEdge > 650) continue;
      const refl = b.toWorld(Math.max(b.from, Math.min(b.to, u)), Math.sign(v) * b.half);
      const pos = { x: refl.x, y: p.y + 4, z: refl.z };
      const g = 0.9 * Math.min(1, 120 / dEdge);
      this.propagate(buffer, pos, { gain: g * 2.5, ref: 1, reverb: 0.6, delay: dEdge / C, rate: 0.92 });
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

  /** 2단계: 초음속 탄이 청자 근처를 지날 때 크랙(마하 원뿔 도달 시각에 맞춰) */
  playCrack(point, distance) {
    if (!this.ready) return;
    this.propagate(this.bank.crack[0], point, { gain: Math.min(3, 8 / Math.max(1, distance)), ref: 1, reverb: 0.4 });
  }

  /** 거친 호흡(질주 후): Game이 호흡 위상에 맞춰 호출 */
  breathe(inhale, exertion) {
    if (!this.ready || exertion < 0.15) return;
    this.playLocal(inhale ? this.bank.breath.inhale : this.bank.breath.exhale, 0.05 + 0.25 * exertion, { rate: 0.9 + exertion * 0.25 });
  }
}
