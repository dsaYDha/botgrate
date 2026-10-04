// 소리 합성용 간단한 DSP(오프라인으로 샘플 배열 생성). 외부 음원 파일 없이 모든 소리를 만든다.

export const SR = 44100;

export function buf(seconds) {
  return new Float32Array(Math.max(1, Math.round(seconds * SR)));
}

let seed = 12345;
export function noise() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
}
export function setSeed(s) {
  seed = s >>> 0;
}

/** RBJ 바이쿼드 필터(제자리 처리) */
export function biquad(x, type, freq, q = 0.707, gainDb = 0) {
  const w0 = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const alpha = sn / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cs) / 2;
      b1 = 1 - cs;
      b2 = (1 - cs) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cs;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cs) / 2;
      b1 = -(1 + cs);
      b2 = (1 + cs) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cs;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cs;
      a2 = 1 - alpha;
      break;
    case 'peak':
      b0 = 1 + alpha * A;
      b1 = -2 * cs;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cs;
      a2 = 1 - alpha / A;
      break;
    default:
      return x;
  }
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    x[i] = yi;
  }
  return x;
}

/** 지수 감쇠 노이즈 버스트를 out에 더함 */
export function addNoiseBurst(out, start, attack, decay, amp, filt) {
  const n = Math.min(out.length - Math.floor(start * SR), Math.floor((attack + decay * 7) * SR));
  if (n <= 0) return out;
  const tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < attack ? t / attack : Math.exp(-(t - attack) / decay);
    tmp[i] = noise() * env;
  }
  if (filt) for (const f of filt) biquad(tmp, f[0], f[1], f[2] || 0.707, f[3] || 0);
  const s = Math.floor(start * SR);
  for (let i = 0; i < n; i++) out[s + i] += tmp[i] * amp;
  return out;
}

/** 감쇠 사인(공명) */
export function addTone(out, start, freq, decay, amp, sweepTo = null, phase = 0) {
  const s = Math.floor(start * SR);
  const n = Math.min(out.length - s, Math.floor(decay * 7 * SR));
  let ph = phase;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = sweepTo ? freq + (sweepTo - freq) * (1 - Math.exp(-t / (decay * 0.8))) : freq;
    ph += (2 * Math.PI * f) / SR;
    out[s + i] += Math.sin(ph) * Math.exp(-t / decay) * amp;
  }
  return out;
}

/** 금속성 클릭: 짧은 충격 + 여러 공명 */
export function addMetal(out, start, amp, freqs, decay = 0.012) {
  addNoiseBurst(out, start, 0.0003, 0.0015, amp, [['highpass', 1500]]);
  for (const f of freqs) addTone(out, start, f * (0.97 + Math.random() * 0.06), decay * (0.7 + Math.random() * 0.6), amp * 0.35);
  return out;
}

export function softClip(x, drive = 1) {
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / Math.tanh(drive);
  return x;
}

export function normalize(x, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

export function fade(x, fadeIn = 0.001, fadeOut = 0.01) {
  const a = Math.floor(fadeIn * SR);
  const b = Math.floor(fadeOut * SR);
  for (let i = 0; i < a && i < x.length; i++) x[i] *= i / a;
  for (let i = 0; i < b && i < x.length; i++) x[x.length - 1 - i] *= i / b;
  return x;
}

/** 잔향 임펄스 응답(스테레오): 시간에 따라 고음이 먼저 줄어드는 지수 감쇠 노이즈 + 이른 반사 */
export function makeIR(seconds, t60, density, lowpassStart, lowpassEnd, early = []) {
  const L = buf(seconds);
  const R = buf(seconds);
  const k = Math.log(1000) / t60;
  for (let i = 0; i < L.length; i++) {
    const t = i / SR;
    const env = Math.exp(-k * t);
    const on = density >= 1 || Math.random() < density ? 1 : 0;
    L[i] = noise() * env * on;
    R[i] = noise() * env * on;
  }
  // 시간 가변 저역통과 근사: 구간별로 필터
  const segs = 6;
  for (const ch of [L, R]) {
    const n = ch.length;
    for (let s = 0; s < segs; s++) {
      const a = Math.floor((s / segs) * n);
      const b = Math.floor(((s + 1) / segs) * n);
      const part = ch.subarray(a, b);
      const f = lowpassStart + (lowpassEnd - lowpassStart) * (s / (segs - 1));
      biquad(part, 'lowpass', f, 0.6);
    }
  }
  for (const [t, g, pan] of early) {
    const i = Math.floor(t * SR);
    if (i < L.length) {
      L[i] += g * (pan <= 0 ? 1 : 1 - pan);
      R[i] += g * (pan >= 0 ? 1 : 1 + pan);
    }
  }
  normalize(L, 0.9);
  normalize(R, 0.9);
  return [L, R];
}
