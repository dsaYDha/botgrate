// 줄기(나무 기둥·두 갈래 줄기) 모양: 판정(CPU)과 렌더링(GPU)이 같은 식을 쓴다.
//   중심선(높이 h, 줄기 밑동 y0 기준): (x + (lx + bx·h)·h,  z + (lz + bz·h)·h)  → 기울기 + 완만한 휨
//   반지름: r0 → r1 로 가늘어짐(지수 0.8) × 뿌리 퍼짐(지면 위 높이 hg에서 1 + flare·e^(−hg/0.35))
// 수평 단면은 원(전단 변환) — 화면의 줄기 정점도 같은 방식으로 옮기므로 판정과 모양이 일치한다.

export const STEM_FLARE_SCALE = 0.35;

/** 줄기 밑동 기준 높이 h에서의 반지름 */
export function stemRadiusAt(o, h) {
  const L = o.top - o.y0;
  const t = Math.min(1, Math.max(0, h / L));
  let r = o.r0 + (o.r1 - o.r0) * Math.pow(t, 0.8);
  if (o.flare > 0) r *= 1 + o.flare * Math.exp(-Math.max(h - o.sink, 0) / STEM_FLARE_SCALE);
  return r;
}

/** 높이 h에서의 중심 xz */
export function stemCenterAt(o, h, out) {
  out.x = o.x + (o.lx + o.bx * h) * h;
  out.z = o.z + (o.lz + o.bz * h) * h;
  return out;
}

/** 높이 h에서의 축 기울기(dx/dh, dz/dh) */
export function stemSlopeAt(o, h, out) {
  out.x = o.lx + 2 * o.bx * h;
  out.z = o.lz + 2 * o.bz * h;
  return out;
}

// GLSL 쌍둥이(같은 식). lean = (lx, lz, bx, bz), shape = (L, r0, r1, flare), sink
export const STEM_GLSL = /* glsl */ `
vec2 stemOffset(float h, vec4 lean) { return (lean.xy + lean.zw * h) * h; }
vec2 stemSlope(float h, vec4 lean) { return lean.xy + 2.0 * lean.zw * h; }
float stemRadius(float h, vec4 shape, float sink) {
  float t = clamp(h / shape.x, 0.0, 1.0);
  float r = shape.y + (shape.z - shape.y) * pow(t, 0.8);
  if (shape.w > 0.0) r *= 1.0 + shape.w * exp(-max(h - sink, 0.0) / ${STEM_FLARE_SCALE.toFixed(3)});
  return r;
}
`;
