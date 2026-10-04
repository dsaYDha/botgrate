// CPU와 GPU(GLSL, render/shaderLib.js)가 비트 단위로 같은 해시/값 노이즈를 쓴다.
// 바람 돌풍처럼 화면(풀 흔들림)과 탄도(총알)가 같은 값을 봐야 하는 곳에 사용.

export function hash2i(x, y) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

export function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2i(xi, yi);
  const b = hash2i(xi + 1, yi);
  const c = hash2i(xi, yi + 1);
  const d = hash2i(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, octaves = 4, lacunarity = 2.03, gain = 0.5) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x + i * 17.13, y - i * 9.71);
    norm += amp;
    x *= lacunarity;
    y *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}
