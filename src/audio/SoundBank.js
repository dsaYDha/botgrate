// 합성 음원 모음. 시작 시 한 번 샘플을 만들어 AudioBuffer로 보관한다.

import { SR, buf, noise, setSeed, biquad, addNoiseBurst, addTone, addMetal, softClip, normalize, fade, makeIR } from './dsp.js';

function gunshot(variant) {
  setSeed(1000 + variant * 77);
  const j = (a) => a * (0.92 + 0.16 * ((variant * 0.37) % 1));
  const out = buf(0.7);
  // 1) 충격파(N파, 약 1 ms)
  const nN = Math.floor(0.0011 * SR);
  for (let i = 0; i < nN; i++) out[i] += 1.15 * (1 - (2 * i) / nN);
  // 2) 폭발 노이즈
  addNoiseBurst(out, 0.0, 0.0002, j(0.0055), 1.0, [['highpass', 280]]);
  // 3) 몸통 울림
  addNoiseBurst(out, 0.0004, 0.0006, j(0.024), 0.62, [['bandpass', j(950), 0.6]]);
  addNoiseBurst(out, 0.0004, 0.0008, j(0.045), 0.18, [['bandpass', 3400, 1.2]]);
  // 4) 저음 충격
  addTone(out, 0.0, 115, j(0.07), 0.55, 42);
  addTone(out, 0.0, 62, 0.11, 0.22, 35);
  // 5) 노리쇠 뭉치 작동음(후퇴·완충 스프링·전진 폐쇄)
  addMetal(out, j(0.011), 0.12, [2400, 3700, 5200], 0.01);
  addTone(out, 0.02, 1460, 0.08, 0.025, 1390);
  addMetal(out, j(0.046), 0.17, [1800, 2950, 4300], 0.014);
  softClip(out, 2.4);
  biquad(out, 'peak', 2600, 0.8, 2);
  normalize(out, 0.97);
  return fade(out, 0.0, 0.05);
}

function crack() {
  setSeed(42);
  const out = buf(0.25);
  const n = Math.floor(0.0005 * SR);
  for (let i = 0; i < n; i++) out[i] += 1 - (2 * i) / n;
  addNoiseBurst(out, 0, 0.0001, 0.004, 0.5, [['highpass', 1500]]);
  addNoiseBurst(out, 0.003, 0.002, 0.04, 0.12, [['bandpass', 2500, 0.8]]);
  return normalize(out, 0.9);
}

function metalClip(type, variant) {
  setSeed(2000 + variant * 13 + type.length * 101);
  let out;
  switch (type) {
    case 'magRelease':
      out = buf(0.12);
      addMetal(out, 0.004, 0.5, [3100, 4800, 6200], 0.008);
      addNoiseBurst(out, 0.01, 0.002, 0.02, 0.15, [['bandpass', 2500, 1]]);
      break;
    case 'magOut':
      out = buf(0.3);
      addNoiseBurst(out, 0.0, 0.01, 0.05, 0.35, [['bandpass', 2600, 0.9]]);
      addMetal(out, 0.07, 0.35, [1900, 3300], 0.012);
      break;
    case 'magIn':
      out = buf(0.3);
      addNoiseBurst(out, 0.0, 0.01, 0.035, 0.3, [['bandpass', 2200, 0.9]]);
      addMetal(out, 0.06, 0.9, [2200, 3500, 5100], 0.012);
      addNoiseBurst(out, 0.06, 0.0005, 0.012, 0.5, [['lowpass', 900]]);
      break;
    case 'magSeat':
      out = buf(0.2);
      addNoiseBurst(out, 0.0, 0.0008, 0.012, 0.8, [['lowpass', 700]]);
      addMetal(out, 0.002, 0.35, [2600, 4100], 0.01);
      break;
    case 'boltRelease':
      out = buf(0.35);
      addMetal(out, 0.0, 0.5, [3500, 5200], 0.006);
      addMetal(out, 0.028, 1.0, [1500, 2600, 4100, 5600], 0.018);
      addNoiseBurst(out, 0.028, 0.0005, 0.02, 0.8, [['lowpass', 1200]]);
      addTone(out, 0.03, 1320, 0.07, 0.04, 1250);
      break;
    case 'selector':
      out = buf(0.1);
      addMetal(out, 0.002, 0.6, [4200, 6100], 0.006);
      break;
    case 'dryFire':
      out = buf(0.15);
      addMetal(out, 0.002, 0.7, [3800, 5600], 0.008);
      addNoiseBurst(out, 0.002, 0.0005, 0.01, 0.3, [['lowpass', 1200]]);
      break;
    case 'magCheckOut':
      out = buf(0.25);
      addNoiseBurst(out, 0.0, 0.01, 0.04, 0.25, [['bandpass', 2400, 0.9]]);
      addMetal(out, 0.05, 0.25, [2600, 3900], 0.01);
      break;
    case 'pouch':
      out = buf(0.4);
      for (let i = 0; i < 5; i++) addNoiseBurst(out, 0.03 + i * 0.05 + Math.random() * 0.02, 0.01, 0.03, 0.25, [['bandpass', 1800 + Math.random() * 900, 0.7]]);
      addNoiseBurst(out, 0.2, 0.002, 0.03, 0.35, [['lowpass', 500]]);
      break;
    case 'pouchGrab': {
      out = buf(0.35);
      // 찍찍이 뜯는 소리: 빠르게 진폭이 떨리는 노이즈
      const n = Math.floor(0.22 * SR);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const am = 0.5 + 0.5 * Math.sign(Math.sin(t * 2 * Math.PI * (90 + 40 * Math.sin(t * 20))));
        out[i + Math.floor(0.02 * SR)] += noise() * am * Math.exp(-t / 0.12) * 0.5;
      }
      biquad(out, 'bandpass', 2600, 0.6);
      break;
    }
    case 'pouchEmpty':
      out = buf(0.25);
      addNoiseBurst(out, 0.0, 0.005, 0.04, 0.3, [['bandpass', 1500, 0.7]]);
      break;
    default:
      out = buf(0.05);
  }
  normalize(out, 0.85);
  return fade(out, 0, 0.01);
}

function casing(hard, variant) {
  setSeed(3000 + variant * 7 + (hard ? 500 : 0));
  const out = buf(0.35);
  if (hard) {
    for (const [t, a] of [[0, 1], [0.07 + variant * 0.01, 0.5], [0.12 + variant * 0.012, 0.25]]) {
      addTone(out, t, 5300 + variant * 250, 0.035, 0.5 * a);
      addTone(out, t, 7900 + variant * 300, 0.025, 0.35 * a);
      addTone(out, t, 9600, 0.015, 0.2 * a);
      addNoiseBurst(out, t, 0.0002, 0.002, 0.3 * a, [['highpass', 3000]]);
    }
  } else {
    addNoiseBurst(out, 0, 0.0005, 0.006, 0.6, [['bandpass', 2200, 1.0]]);
    addTone(out, 0, 4700 + variant * 300, 0.008, 0.2);
    addNoiseBurst(out, 0.01, 0.005, 0.04, 0.15, [['bandpass', 3500, 0.8]]);
  }
  return normalize(out, 0.8);
}

function impact(type, variant) {
  setSeed(4000 + variant * 31 + type.length * 7);
  let out;
  switch (type) {
    case 'dirt':
      out = buf(0.4);
      addNoiseBurst(out, 0, 0.0008, 0.022, 0.9, [['lowpass', 650]]);
      addTone(out, 0, 140 + variant * 15, 0.03, 0.4);
      addNoiseBurst(out, 0.004, 0.004, 0.07, 0.35, [['bandpass', 2400, 0.7]]);
      break;
    case 'wood':
      out = buf(0.35);
      addNoiseBurst(out, 0, 0.0002, 0.003, 0.7, [['highpass', 2000]]);
      addTone(out, 0, 480 + variant * 60, 0.018, 0.8);
      addTone(out, 0, 910 + variant * 80, 0.012, 0.45);
      addTone(out, 0, 1750, 0.006, 0.25);
      addNoiseBurst(out, 0.002, 0.001, 0.03, 0.25, [['bandpass', 1200, 0.9]]);
      break;
    case 'leaves':
      out = buf(0.3);
      for (let i = 0; i < 6; i++) addNoiseBurst(out, Math.random() * 0.08, 0.004, 0.02, 0.3, [['highpass', 2500]]);
      break;
    case 'body':
      out = buf(0.35);
      addNoiseBurst(out, 0, 0.0008, 0.016, 0.9, [['lowpass', 520]]);
      addTone(out, 0, 155 + variant * 12, 0.03, 0.55);
      addNoiseBurst(out, 0.0, 0.0005, 0.008, 0.3, [['bandpass', 1300, 1.0]]);
      break;
    case 'ricochet': {
      out = buf(0.8);
      const f0 = 3000 + variant * 400;
      addTone(out, 0.0, f0, 0.32, 0.45, 850 + variant * 120);
      addTone(out, 0.0, f0 * 1.51, 0.2, 0.15, 1300);
      addNoiseBurst(out, 0, 0.002, 0.18, 0.18, [['bandpass', 2500, 0.8]]);
      addNoiseBurst(out, 0, 0.0005, 0.01, 0.5, [['highpass', 1500]]);
      break;
    }
    case 'fall':
      out = buf(0.9);
      addNoiseBurst(out, 0, 0.003, 0.05, 0.9, [['lowpass', 260]]);
      addTone(out, 0, 75, 0.09, 0.6, 55);
      addNoiseBurst(out, 0.0, 0.01, 0.12, 0.3, [['bandpass', 900, 0.6]]);
      for (let i = 0; i < 6; i++) addMetal(out, 0.02 + Math.random() * 0.3, 0.12, [2400 + Math.random() * 2000, 4000 + Math.random() * 2000], 0.01);
      break;
    case 'rifleDrop':
      out = buf(0.6);
      addMetal(out, 0, 0.6, [1700, 2900, 4400], 0.02);
      addNoiseBurst(out, 0, 0.001, 0.03, 0.6, [['lowpass', 700]]);
      addMetal(out, 0.09, 0.3, [2200, 3600], 0.015);
      break;
    default:
      out = buf(0.05);
  }
  normalize(out, 0.9);
  return fade(out, 0, 0.02);
}

function footstep(surface, variant) {
  setSeed(5000 + variant * 17 + surface.length * 131);
  const out = buf(0.4);
  const r = () => Math.random();
  switch (surface) {
    case 'stubble':
      addNoiseBurst(out, 0, 0.004, 0.02, 0.5, [['lowpass', 320]]);
      for (let i = 0; i < 18; i++) addNoiseBurst(out, 0.005 + r() * 0.13, 0.0002, 0.003 + r() * 0.004, 0.35 * r(), [['highpass', 3000 + r() * 3000]]);
      break;
    case 'plowed':
      addNoiseBurst(out, 0, 0.006, 0.045, 0.8, [['lowpass', 220]]);
      addNoiseBurst(out, 0.01, 0.01, 0.07, 0.18, [['bandpass', 750, 0.7]]);
      break;
    case 'weeds':
      addNoiseBurst(out, 0, 0.03, 0.11, 0.5, [['bandpass', 3400, 0.7]]);
      addNoiseBurst(out, 0.02, 0.004, 0.025, 0.3, [['lowpass', 300]]);
      break;
    case 'leaves':
      addNoiseBurst(out, 0, 0.004, 0.025, 0.35, [['lowpass', 300]]);
      for (let i = 0; i < 26; i++) addNoiseBurst(out, r() * 0.16, 0.0005, 0.004 + r() * 0.006, 0.4 * r(), [['bandpass', 2000 + r() * 4500, 1.2]]);
      if (variant === 2) {
        addNoiseBurst(out, 0.06, 0.0002, 0.004, 0.8, [['highpass', 1500]]);
        addTone(out, 0.06, 1800, 0.01, 0.3);
      }
      break;
    case 'dirt':
      addNoiseBurst(out, 0, 0.003, 0.025, 0.6, [['lowpass', 400]]);
      for (let i = 0; i < 10; i++) addNoiseBurst(out, 0.003 + r() * 0.06, 0.0005, 0.006, 0.3 * r(), [['bandpass', 1300 + r() * 1500, 1.0]]);
      break;
    case 'grass':
    default:
      addNoiseBurst(out, 0, 0.02, 0.07, 0.4, [['bandpass', 2600, 0.7]]);
      addNoiseBurst(out, 0.01, 0.004, 0.025, 0.35, [['lowpass', 280]]);
      break;
  }
  normalize(out, 0.8);
  return fade(out, 0, 0.03);
}

function gear(variant) {
  setSeed(6000 + variant * 3);
  const out = buf(0.3);
  for (let i = 0; i < 4; i++) addMetal(out, Math.random() * 0.15, 0.25 * Math.random() + 0.05, [3000 + Math.random() * 3000], 0.008);
  addNoiseBurst(out, 0, 0.02, 0.06, 0.2, [['bandpass', 1600, 0.6]]);
  return normalize(out, 0.6);
}

function breath(type) {
  setSeed(7000 + type.length * 9);
  let out;
  if (type === 'inhale') {
    out = buf(0.8);
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out[i] = noise() * Math.sin(Math.PI * t) * (0.4 + 0.6 * t);
    }
    biquad(out, 'bandpass', 1300, 0.5);
  } else if (type === 'exhale') {
    out = buf(0.9);
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out[i] = noise() * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.4)), 0.8) * (1 - t * 0.5);
    }
    biquad(out, 'bandpass', 850, 0.5);
    biquad(out, 'lowpass', 2200);
  } else {
    // 숨 몰아쉬기
    out = buf(0.6);
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out[i] = noise() * Math.min(1, t * 12) * Math.exp(-t * 3);
    }
    biquad(out, 'bandpass', 1500, 0.6);
  }
  return normalize(out, 0.7);
}

function windLoop() {
  setSeed(8000);
  const out = buf(8);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = noise();
    // 핑크 노이즈 근사
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = b0 + b1 + b2 + w * 0.1848;
  }
  biquad(out, 'lowpass', 900, 0.5);
  normalize(out, 0.9);
  // 루프 이음매
  const xf = Math.floor(0.4 * SR);
  for (let i = 0; i < xf; i++) {
    const k = i / xf;
    out[i] = out[i] * k + out[out.length - xf + i] * (1 - k);
  }
  return out.subarray(0, out.length - xf);
}

function leavesLoop() {
  setSeed(8100);
  const out = buf(6);
  for (let i = 0; i < out.length; i++) out[i] = noise();
  biquad(out, 'highpass', 2200, 0.6);
  biquad(out, 'lowpass', 9000, 0.6);
  // 불규칙 진폭(잎들이 부딪히는 소리)
  let env = 0;
  for (let i = 0; i < out.length; i++) {
    if (Math.random() < 0.0009) env = 0.6 + Math.random() * 0.4;
    env *= 0.9996;
    out[i] *= 0.25 + env;
  }
  normalize(out, 0.8);
  const xf = Math.floor(0.3 * SR);
  for (let i = 0; i < xf; i++) {
    const k = i / xf;
    out[i] = out[i] * k + out[out.length - xf + i] * (1 - k);
  }
  return out.subarray(0, out.length - xf);
}

function cricketsLoop() {
  setSeed(8200);
  const out = buf(7);
  for (let c = 0; c < 3; c++) {
    const f = 4300 + c * 350;
    let t = Math.random() * 0.5;
    while (t < 6.8) {
      // 짧은 울음 3~4개 묶음
      const pulses = 3 + Math.floor(Math.random() * 2);
      for (let p = 0; p < pulses; p++) addTone(out, t + p * 0.032, f, 0.006, 0.12 / (c + 1));
      t += 0.35 + Math.random() * 0.5;
    }
  }
  return normalize(out, 0.5);
}

export function buildSoundBank(ctx) {
  const make = (data) => {
    const b = ctx.createBuffer(1, data.length, SR);
    b.copyToChannel(data instanceof Float32Array ? data : new Float32Array(data), 0);
    return b;
  };
  const bank = {
    gunshot: [0, 1, 2, 3].map((v) => make(gunshot(v))),
    crack: [make(crack())],
    casingHard: [0, 1, 2].map((v) => make(casing(true, v))),
    casingSoft: [0, 1, 2].map((v) => make(casing(false, v))),
    impact: {},
    step: {},
    gear: [0, 1, 2].map((v) => make(gear(v))),
    breath: { inhale: make(breath('inhale')), exhale: make(breath('exhale')), gasp: make(breath('gasp')) },
    windLoop: make(windLoop()),
    leavesLoop: make(leavesLoop()),
    cricketsLoop: make(cricketsLoop()),
    mech: {},
  };
  for (const t of ['dirt', 'wood', 'leaves', 'body', 'ricochet', 'fall', 'rifleDrop']) bank.impact[t] = [0, 1, 2].map((v) => make(impact(t, v)));
  for (const s of ['stubble', 'plowed', 'weeds', 'leaves', 'dirt', 'grass']) bank.step[s] = [0, 1, 2].map((v) => make(footstep(s, v)));
  for (const m of ['magRelease', 'magOut', 'magIn', 'magSeat', 'boltRelease', 'selector', 'dryFire', 'magCheckOut', 'pouch', 'pouchGrab', 'pouchEmpty'])
    bank.mech[m] = [0, 1].map((v) => make(metalClip(m, v)));
  // 잔향 임펄스 응답: 들판(짧고 성김, 지면 반사) / 숲띠 안(줄기 반사로 길고 촘촘)
  const toStereo = ([L, R]) => {
    const b = ctx.createBuffer(2, L.length, SR);
    b.copyToChannel(L, 0);
    b.copyToChannel(R, 1);
    return b;
  };
  bank.irField = toStereo(makeIR(1.4, 0.75, 0.35, 5000, 1200, [[0.006, 0.6, 0], [0.021, 0.25, -0.4], [0.034, 0.2, 0.5]]));
  bank.irForest = toStereo(
    makeIR(2.6, 1.7, 1.0, 6500, 1400, [
      [0.008, 0.5, -0.6],
      [0.013, 0.45, 0.7],
      [0.019, 0.4, -0.2],
      [0.027, 0.35, 0.4],
      [0.035, 0.3, -0.7],
      [0.046, 0.25, 0.2],
    ]),
  );
  return bank;
}
