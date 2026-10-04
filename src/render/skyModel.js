// 하늘·햇빛·대기 원근의 해석 모델(CPU 쪽). 같은 식이 shaderLib.js의 GLSL에도 있다.
//
// 단일 산란 근사: 레일리(파장^-4) + 미(에어로졸, 헨예-그린스타인 위상), 공기 질량은 Kasten–Young 식.
//   L(d) = E_sun_ground · [ (K_R τ_R P_R(γ) + K_M τ_M P_M(γ)) / τ · (1 − e^{−τ m_v}) + K_ms (1 − e^{−τ m_v}) · tint ]
//   그리고 지평선 근처는 다중 산란으로 흰빛이 돌도록 탈채도.
// E_sun_ground = 대기를 통과한 직사광(머리 위 태양을 흰색 기준으로 정규화한 색 × 세기).
// 이 파일은 셰이더 유니폼 값, 태양 색, 하늘빛 구면조화(SH) 계수를 만든다.

import * as THREE from 'three';

export const SKY = {
  // 북위 48°, 9월 말 오후 3시 무렵(태양시): 고도 약 25.5°, 방위 약 235°(남서~서남서)
  sunElevationDeg: 25.5,
  sunAzimuthDeg: 235,
  // 수직 입사 직사광 세기(렌더 단위, 휘도 기준). 노출은 후처리에서 맞춘다.
  sunIlluminance: 3.3,
  // 수직 광학 두께: 레일리(R,G,B 대표 파장 680/550/440 nm 근처), 미(가을 오후 약한 연무)
  tauR: [0.0464, 0.108, 0.2648],
  tauM: 0.14,
  mieG: 0.78,
  // 다중 산란 보정 이득
  kR: 4.1,
  kM: 0.7,
  kMs: 0.015,
  msTint: [0.75, 0.85, 1.0],
  horizonDesat: 0.78,
  // 지면 반사(하늘빛 SH의 아래 반구): 그루터기·흙·풀 평균 반사율
  groundAlbedo: [0.2, 0.17, 0.12],
  // 대기 원근(지표 연무): 소산 계수(1/m, 녹색 기준)와 색별 배수, 고도 척도
  hazeSigma: 0.00066,
  hazeTint: [0.86, 1.0, 1.16],
  hazeScaleHeight: 1200,
  // 적운층(구름 그림자와 같은 함수): 높이, 크기 척도, 덮임 문턱, 불투명도, 바람 대비 속도
  cumulus: { height: 1500, scale: 820, coverage: 0.6, opacity: 0.85, speedFactor: 2.2 },
  cirrus: { height: 8000, scale: 5200, opacity: 0.16 },
};

const DEG = Math.PI / 180;

export function sunDirection() {
  const el = SKY.sunElevationDeg * DEG;
  const az = SKY.sunAzimuthDeg * DEG;
  // 나침반 방위 → 월드(x 동, z 남)
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
}

export function airmass(sinH) {
  const s = Math.max(sinH, 0);
  const hdeg = Math.asin(Math.min(1, s)) / DEG;
  return 1 / (s + 0.50572 * Math.pow(hdeg + 6.07995, -1.6364));
}

/** 지면에 닿는 직사광(색 × 세기, 휘도 = sunIlluminance) */
export function sunIrradiance() {
  const s = sunDirection();
  const m = airmass(s.y);
  const t = SKY.tauR.map((r) => Math.exp(-(r + SKY.tauM) * (m - 1)));
  const lum = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  const k = SKY.sunIlluminance / lum;
  return t.map((x) => x * k);
}

/** 하늘 복사휘도(구름 제외). d: 단위 벡터 */
export function skyRadiance(d, sun, Esun, out = [0, 0, 0]) {
  const mu = d.x * sun.x + d.y * sun.y + d.z * sun.z;
  const mv = airmass(d.y);
  const g = SKY.mieG;
  const pR = 0.0596831 * (1 + mu * mu);
  const pM = (0.0795775 * (1 - g * g)) / Math.pow(1 + g * g - 2 * g * mu, 1.5);
  for (let i = 0; i < 3; i++) {
    const tau = SKY.tauR[i] + SKY.tauM;
    const col = 1 - Math.exp(-tau * mv);
    const scat = (SKY.kR * SKY.tauR[i] * pR + SKY.kM * SKY.tauM * pM) / tau;
    out[i] = Esun[i] * (scat * col + SKY.kMs * col * SKY.msTint[i]);
  }
  // 지평선 탈채도
  const hz = 1 - smooth(0, 0.25, Math.max(d.y, 0));
  const l = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  const tint = [0.92, 0.97, 1.08];
  for (let i = 0; i < 3; i++) out[i] += (l * tint[i] - out[i]) * hz * SKY.horizonDesat;
  return out;
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 하늘빛 + 지면 반사광의 복사휘도를 2차 구면조화(SH9)로 투영.
 * three.js LightProbe와 같은 규약(복사휘도 계수; 셰이더가 코사인 컨볼루션을 적용해 조도를 얻는다).
 */
export function bakeSkySH() {
  const sun = sunDirection();
  const Esun = sunIrradiance();
  const sh = new THREE.SphericalHarmonics3();
  const basis = new Array(9).fill(0);
  const N = 6000;
  const L = [0, 0, 0];
  const d = new THREE.Vector3();
  // 1) 하늘의 수평면 조도(지면 반사광 계산용)
  const Esky = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const z = 1 - (i + 0.5) / N;
    const r = Math.sqrt(1 - z * z);
    const t = i * 2.399963229728653;
    d.set(r * Math.cos(t), z, r * Math.sin(t));
    skyRadiance(d, sun, Esun, L);
    for (let k = 0; k < 3; k++) Esky[k] += L[k] * z * ((2 * Math.PI) / N);
  }
  const Eground = Esun.map((e, k) => e * Math.max(sun.y, 0) + Esky[k]);
  const Lground = Eground.map((e, k) => (SKY.groundAlbedo[k] * e) / Math.PI);
  // 2) 전 방향 투영
  const c = sh.coefficients;
  const M = 8000;
  for (let i = 0; i < M; i++) {
    const y = 1 - (2 * (i + 0.5)) / M;
    const r = Math.sqrt(1 - y * y);
    const t = i * 2.399963229728653;
    d.set(r * Math.cos(t), y, r * Math.sin(t));
    if (y > 0) skyRadiance(d, sun, Esun, L);
    else {
      // 지평선 바로 아래는 연무 낀 먼 땅: 하늘색과 섞는다
      const k = Math.min(1, -y / 0.08);
      skyRadiance(d.set(d.x, 0.0, d.z).normalize(), sun, Esun, L);
      for (let q = 0; q < 3; q++) L[q] = L[q] * (1 - k) + Lground[q] * k;
      d.set(r * Math.cos(t), y, r * Math.sin(t));
    }
    THREE.SphericalHarmonics3.getBasisAt(d, basis);
    const w = (4 * Math.PI) / M;
    for (let j = 0; j < 9; j++) {
      c[j].x += basis[j] * L[0] * w;
      c[j].y += basis[j] * L[1] * w;
      c[j].z += basis[j] * L[2] * w;
    }
  }
  return { sh, Esky, Eground, Lground };
}
