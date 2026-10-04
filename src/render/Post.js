// HDR 후처리: 장면(선형 HDR, MSAA) → 아주 약한 블룸 → 노출·톤매핑(AgX)·색보정·디더링 → 화면.
// 품질 '낮음'에서는 쓰지 않고 바로 화면에 그린다(셰이더 안에서 톤매핑).

import * as THREE from 'three';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 첫 축소: 부드러운 문턱 + Karis 평균(밝은 점 하나가 번쩍이는 것 방지), 13탭
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform vec4 uThreshold; // 문턱, 무릎, 전체 번짐 비율, 0
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
float lumi(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 prefilter(vec3 c) {
  float l = lumi(c);
  float knee = uThreshold.y;
  float soft = clamp(l - uThreshold.x + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, l - uThreshold.x) / max(l, 1e-4);
  return c * max(w, uThreshold.z);
}
void main() {
  vec3 a = tap(vec2(-2.0, -2.0)), b = tap(vec2(0.0, -2.0)), c = tap(vec2(2.0, -2.0));
  vec3 d = tap(vec2(-1.0, -1.0)), e = tap(vec2(1.0, -1.0));
  vec3 f = tap(vec2(-2.0, 0.0)), g = tap(vec2(0.0, 0.0)), h = tap(vec2(2.0, 0.0));
  vec3 i = tap(vec2(-1.0, 1.0)), j = tap(vec2(1.0, 1.0));
  vec3 k = tap(vec2(-2.0, 2.0)), l = tap(vec2(0.0, 2.0)), m = tap(vec2(2.0, 2.0));
  vec3 col;
  if (uFirst > 0.5) {
    // Karis 평균: 각 2×2 묶음을 1/(1+휘도)로 가중
    vec3 g0 = (d + e + i + j) * 0.25;
    vec3 g1 = (a + b + f + g) * 0.25;
    vec3 g2 = (b + c + g + h) * 0.25;
    vec3 g3 = (f + g + k + l) * 0.25;
    vec3 g4 = (g + h + l + m) * 0.25;
    float w0 = 0.5 / (1.0 + lumi(g0));
    float w1 = 0.125 / (1.0 + lumi(g1));
    float w2 = 0.125 / (1.0 + lumi(g2));
    float w3 = 0.125 / (1.0 + lumi(g3));
    float w4 = 0.125 / (1.0 + lumi(g4));
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    col = prefilter(min(col, vec3(60.0)));
  } else {
    col = (d + e + i + j) * 0.125 + (a + c + k + m) * 0.03125 + (b + f + h + l) * 0.0625 + g * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// 확대: 3×3 텐트 필터를 위 단계에 더한다
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += (texture2D(tSrc, vUv + vec2(-t.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb
      + texture2D(tSrc, vUv + vec2(0.0, -t.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  c += texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb
     + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}`;

// 빛줄기(산란광 기둥): 해 둘레의 밝은 하늘을 화소에서 해 쪽으로 따라가며 모은다(1/4 해상도).
// 나뭇잎·줄기 사이로 하늘이 보이는 곳에서만 생기므로 숲 속에서 해를 볼 때 줄기 사이로 빛이 뻗는다.
const RAYS_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec3 uSun;     // 화면 uv, 세기(해가 카메라 앞에 있을 때)
uniform float uAspect;
uniform float uThr;
varying vec2 vUv;
float lumi(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec2 d = uSun.xy - vUv;
  vec2 da = vec2(d.x * uAspect, d.y);
  float dist = length(da);
  const int N = 40;
  vec2 stepv = d / float(N) * min(1.0, 0.75 / max(dist, 1e-3));
  vec2 uv = vUv;
  vec3 acc = vec3(0.0);
  float decay = 1.0;
  for (int i = 0; i < N; i++) {
    uv += stepv;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    vec3 c = texture2D(tSrc, uv).rgb;
    float m = smoothstep(uThr, uThr * 1.8, lumi(c));
    acc += min(c, vec3(uThr * 4.0)) * m * decay;
    decay *= 0.96;
  }
  float fall = exp(-dist * 2.2);
  gl_FragColor = vec4(acc / float(N) * fall * uSun.z, 1.0);
}`;

// 가벼운 SSAO(반 해상도, 10표본): 깊이에서 위치·법선을 복원해 주변이 가리는 정도. 0.6 m 반경, 80 m 밖은 끔.
// 직사광까지 조금 어둡게 하는 근사라 세기는 약하게(인스턴스별 차폐 — 수관 안쪽·줄기 밑동·풀 밑동 — 가 주된 차폐).
const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform vec4 uCam; // near, far, proj[0][0], proj[1][1]
uniform float uRadius;
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float linZ(float d) {
  float ndc = d * 2.0 - 1.0;
  return 2.0 * uCam.x * uCam.y / (uCam.y + uCam.x - ndc * (uCam.y - uCam.x));
}
vec3 viewPos(vec2 uv) {
  float z = linZ(texture2D(tDepth, uv).r);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * z / uCam.z, ndc.y * z / uCam.w, -z);
}
void main() {
  float d = texture2D(tDepth, vUv).r;
  if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 Px = viewPos(vUv + vec2(1.0 / uRes.x, 0.0));
  vec3 Py = viewPos(vUv + vec2(0.0, 1.0 / uRes.y));
  vec3 N = normalize(cross(Px - P, Py - P));
  if (N.z < 0.0) N = -N;
  float far = smoothstep(50.0, 80.0, -P.z);
  if (far >= 1.0) { gl_FragColor = vec4(1.0); return; }
  float occ = 0.0;
  float ang = ign(gl_FragCoord.xy) * 6.2831853;
  const int NS = 10;
  for (int i = 0; i < NS; i++) {
    float fi = (float(i) + 0.5) / float(NS);
    float a = ang + float(i) * 2.3999632;
    vec3 S = P + vec3(cos(a), sin(a), 0.0) * sqrt(fi) * uRadius;
    vec2 suv = vec2(S.x * uCam.z / -S.z, S.y * uCam.w / -S.z) * 0.5 + 0.5;
    vec3 Q = viewPos(suv);
    vec3 v = Q - P;
    float dist = length(v);
    occ += max(0.0, dot(v / max(dist, 1e-3), N) - 0.15) * (1.0 - smoothstep(uRadius, uRadius * 2.5, dist));
  }
  float ao = clamp(1.0 - occ / float(NS) * 1.4, 0.0, 1.0);
  gl_FragColor = vec4(vec3(mix(ao, 1.0, far)), 1.0);
}`;

// 철제 조준기 초점 흐림: 눈이 가늠쇠(0.45 m)에 초점을 맞추면 먼 풍경이 흐려진다. 반 해상도 분리 가우시안.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir; // 표본 간격(uv)
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270;
  c += (texture2D(tSrc, vUv + uDir * 1.3846).rgb + texture2D(tSrc, vUv - uDir * 1.3846).rgb) * 0.3162;
  c += (texture2D(tSrc, vUv + uDir * 3.2308).rgb + texture2D(tSrc, vUv - uDir * 3.2308).rgb) * 0.0703;
  gl_FragColor = vec4(c, 1.0);
}`;
// 흐린 장면을 원래 장면 위에 섞어 그림(총을 그리기 전에 — 가늠쇠는 선명하게)
const MIX_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uAmount;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, uAmount);
}`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uExposure;
uniform vec3 uWhite;       // 화이트 밸런스(선형 곱)
uniform vec4 uGrade;       // 채도, 대비, 그림자 차갑게, 밝은 곳 따뜻하게
uniform float uVignette;
uniform float uHasBloom;
uniform sampler2D tRays;
uniform float uRays;
uniform sampler2D tAO;
uniform float uAO;
uniform vec2 uAOTexel;
varying vec2 vUv;

float lumi(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  if (uAO > 0.0) {
    // 반 해상도 차폐를 4표본으로 부드럽게
    float ao = (texture2D(tAO, vUv + uAOTexel * vec2(-0.75, -0.25)).r + texture2D(tAO, vUv + uAOTexel * vec2(0.75, 0.25)).r
              + texture2D(tAO, vUv + uAOTexel * vec2(-0.25, 0.75)).r + texture2D(tAO, vUv + uAOTexel * vec2(0.25, -0.75)).r) * 0.25;
    c *= mix(1.0, ao, uAO);
  }
  if (uHasBloom > 0.5) c += texture2D(tBloom, vUv).rgb * uBloom;
  if (uRays > 0.0) c += texture2D(tRays, vUv).rgb * uRays * vec3(1.0, 0.93, 0.8);
  c *= uExposure * uWhite;
  // 비네팅(아주 약하게: 렌즈가 아니라 눈의 주변 시야 정도)
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 1.6;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  // 톤매핑 뒤(표시 선형): 채도·대비·분할 색조
  vec3 t = clamp(gl_FragColor.rgb, 0.0, 1.0);
  float l = lumi(t);
  t = mix(vec3(l), t, uGrade.x);
  vec3 p = pow(t, vec3(1.0 / 2.2));
  p = mix(p, p * p * (3.0 - 2.0 * p), uGrade.y);
  t = pow(max(p, 0.0), vec3(2.2));
  float lw = smoothstep(0.0, 0.5, l);
  t *= mix(vec3(1.0 - uGrade.z * 0.6, 1.0, 1.0 + uGrade.z), vec3(1.0 + uGrade.w, 1.0 + uGrade.w * 0.4, 1.0 - uGrade.w), lw);
  gl_FragColor.rgb = t;
  #include <colorspace_fragment>
  // 디더링(하늘 계조 띠 방지)
  gl_FragColor.rgb += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
}`;

export class Post {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} quality {post, msaa, bloom}
   */
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.enabled = !!quality.post;
    this.bloomOn = !!quality.bloom;
    this.params = {
      exposure: 1.0,
      bloom: 0.045,
      threshold: 1.6,
      knee: 0.8,
      spread: 0.004, // 문턱 아래도 아주 조금 번지게(공기 산란 느낌)
      white: new THREE.Vector3(1.0, 0.995, 0.985),
      saturation: 0.96,
      contrast: 0.12,
      coolShadows: 0.025,
      warmHighlights: 0.015,
      vignette: 0.12,
      rays: 0.55,
      raysThreshold: 1.1,
      ao: 0.55,
      aoRadius: 0.6,
    };
    this.sun = new THREE.Vector3(0.5, 0.5, 0);
    if (!this.enabled) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.scene = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: quality.msaa || 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.scene.texture.minFilter = THREE.LinearFilter;
    this.scene.texture.generateMipmaps = false;
    this.aoOn = !!quality.ssao;
    if (this.aoOn) {
      // MSAA 깊이를 풀어 받은 깊이 텍스처(SSAO용)
      this.scene.depthTexture = new THREE.DepthTexture(size.x, size.y);
      this.scene.depthTexture.type = THREE.UnsignedIntType;
    }
    this.levels = [];
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.tri = new THREE.BufferGeometry();
    this.tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const mk = (frag, uniforms, extra = {}) =>
      new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
    this.downMat = mk(DOWN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uFirst: { value: 0 },
      uThreshold: { value: new THREE.Vector4() },
    });
    this.upMat = mk(
      UP_FRAG,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
      { blending: THREE.AdditiveBlending, transparent: true },
    );
    this.finalMat = mk(FINAL_FRAG, {
      tScene: { value: this.scene.texture },
      tBloom: { value: null },
      uBloom: { value: 0 },
      uExposure: { value: 1 },
      uWhite: { value: new THREE.Vector3(1, 1, 1) },
      uGrade: { value: new THREE.Vector4() },
      uVignette: { value: 0 },
      uHasBloom: { value: 0 },
      tRays: { value: null },
      uRays: { value: 0 },
      tAO: { value: null },
      uAO: { value: 0 },
      uAOTexel: { value: new THREE.Vector2() },
    });
    this.aoMat = mk(AO_FRAG, { tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector4() }, uRadius: { value: 0.6 } });
    this.blurMat = mk(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.mixMat = mk(MIX_FRAG, { tSrc: { value: null }, uAmount: { value: 0 } }, { transparent: true, blending: THREE.NormalBlending });
    this.raysOn = !!quality.bloom;
    this.raysMat = mk(RAYS_FRAG, { tSrc: { value: null }, uSun: { value: new THREE.Vector3() }, uAspect: { value: 1 }, uThr: { value: 1 } });
    this.finalMat.toneMapped = true;
    this.quad = new THREE.Mesh(this.tri, this.downMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this._allocBloom(size.x, size.y);
  }

  _allocBloom(w, h) {
    for (const l of this.levels) l.dispose();
    this.levels = [];
    if (this.raysRT) this.raysRT.dispose();
    this.raysRT = null;
    if (this.aoRT) this.aoRT.dispose();
    this.aoRT = null;
    for (const t of this.blurRT || []) t.dispose();
    this.blurRT = [0, 1].map(() => {
      const t = new THREE.WebGLRenderTarget(Math.max(4, w >> 1), Math.max(4, h >> 1), { type: THREE.HalfFloatType, depthBuffer: false });
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      t.texture.generateMipmaps = false;
      return t;
    });
    if (this.aoOn) {
      this.aoRT = new THREE.WebGLRenderTarget(Math.max(4, w >> 1), Math.max(4, h >> 1), { depthBuffer: false });
      this.aoRT.texture.minFilter = THREE.LinearFilter;
      this.aoRT.texture.magFilter = THREE.LinearFilter;
      this.aoRT.texture.generateMipmaps = false;
    }
    if (this.raysOn) {
      this.raysRT = new THREE.WebGLRenderTarget(Math.max(4, w >> 2), Math.max(4, h >> 2), { type: THREE.HalfFloatType, depthBuffer: false });
      this.raysRT.texture.minFilter = THREE.LinearFilter;
      this.raysRT.texture.magFilter = THREE.LinearFilter;
      this.raysRT.texture.generateMipmaps = false;
    }
    if (!this.bloomOn) return;
    let lw = Math.max(1, w >> 1);
    let lh = Math.max(1, h >> 1);
    for (let i = 0; i < 6 && lw >= 4 && lh >= 4; i++) {
      const rt = new THREE.WebGLRenderTarget(lw, lh, { type: THREE.HalfFloatType, depthBuffer: false });
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.generateMipmaps = false;
      this.levels.push(rt);
      lw >>= 1;
      lh >>= 1;
    }
  }

  setSize(w, h) {
    if (!this.enabled) return;
    this.scene.setSize(w, h);
    this._allocBloom(w, h);
  }

  /** 장면을 그릴 대상(후처리 끄면 null = 화면) */
  get target() {
    return this.enabled ? this.scene : null;
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.cam);
  }

  /** 장면(총 제외)을 그린 직후: 깊이로 SSAO(1인칭 총을 그리기 전에 — 총이 깊이를 덮어쓰므로) */
  computeAO(camera) {
    if (!this.enabled || !this.aoRT) return;
    const m = this.aoMat.uniforms;
    m.tDepth.value = this.scene.depthTexture;
    m.uRes.value.set(this.aoRT.width, this.aoRT.height);
    const pm = camera.projectionMatrix.elements;
    m.uCam.value.set(camera.near, camera.far, pm[0], pm[5]);
    m.uRadius.value = this.params.aoRadius;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    r.autoClear = false;
    this._pass(this.aoMat, this.aoRT);
    r.setRenderTarget(prev);
    r.autoClear = autoClear;
    this._aoReady = true;
  }

  /**
   * 초점 흐림(철제 조준기): 장면(총 제외)을 반 해상도로 흐려 amount(0~1)만큼 덮는다. 총을 그리기 전에 호출.
   * @param {number} amount 섞는 정도
   * @param {number} radiusPx 흐림 반경(전체 해상도 화소, 대략)
   */
  focusBlur(amount, radiusPx = 3) {
    if (!this.enabled || amount <= 0.01) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const autoClear = r.autoClear;
    r.autoClear = false;
    const [a, b] = this.blurRT;
    const k = radiusPx / 4.5; // 반 해상도 표본 간격
    this.blurMat.uniforms.tSrc.value = this.scene.texture;
    this.blurMat.uniforms.uDir.value.set(k / a.width, 0);
    this._pass(this.blurMat, a);
    this.blurMat.uniforms.tSrc.value = a.texture;
    this.blurMat.uniforms.uDir.value.set(0, k / b.height);
    this._pass(this.blurMat, b);
    this.mixMat.uniforms.tSrc.value = b.texture;
    this.mixMat.uniforms.uAmount.value = Math.min(1, amount);
    this._pass(this.mixMat, this.scene);
    r.setRenderTarget(prev);
    r.autoClear = autoClear;
  }

  /** 해의 화면 위치(uv)와 세기(카메라가 해를 향한 정도) */
  setSun(u, v, k) {
    this.sun.set(u, v, k);
  }

  /** 장면 렌더 뒤 호출: 블룸 → 빛줄기 → 최종 합성 */
  finish() {
    if (!this.enabled) return;
    const r = this.renderer;
    const P = this.params;
    const autoClear = r.autoClear;
    r.autoClear = false;
    if (this.bloomOn && this.levels.length) {
      const dm = this.downMat.uniforms;
      dm.uThreshold.value.set(P.threshold, P.knee, P.spread, 0);
      let src = this.scene.texture;
      let sw = this.scene.width;
      let sh = this.scene.height;
      for (let i = 0; i < this.levels.length; i++) {
        dm.tSrc.value = src;
        dm.uTexel.value.set(1 / sw, 1 / sh);
        dm.uFirst.value = i === 0 ? 1 : 0;
        this._pass(this.downMat, this.levels[i]);
        src = this.levels[i].texture;
        sw = this.levels[i].width;
        sh = this.levels[i].height;
      }
      const um = this.upMat.uniforms;
      for (let i = this.levels.length - 1; i > 0; i--) {
        um.tSrc.value = this.levels[i].texture;
        um.uTexel.value.set(1 / this.levels[i].width, 1 / this.levels[i].height);
        um.uRadius.value = 1;
        this._pass(this.upMat, this.levels[i - 1]);
      }
    }
    const fm = this.finalMat.uniforms;
    // 해가 화면 근처(앞쪽)에 있을 때만 빛줄기
    const sunK = this.raysRT ? Math.max(0, Math.min(1, (this.sun.z - 0.35) / 0.4)) * P.rays : 0;
    if (sunK > 0.001) {
      const rm = this.raysMat.uniforms;
      rm.tSrc.value = this.scene.texture;
      rm.uSun.value.set(this.sun.x, this.sun.y, 1);
      rm.uAspect.value = this.scene.width / this.scene.height;
      rm.uThr.value = P.raysThreshold;
      this._pass(this.raysMat, this.raysRT);
      fm.tRays.value = this.raysRT.texture;
    }
    fm.uRays.value = sunK;
    fm.uAO.value = this.aoRT && this._aoReady ? P.ao : 0;
    if (this.aoRT) {
      fm.tAO.value = this.aoRT.texture;
      fm.uAOTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
    }
    this._aoReady = false;
    fm.tBloom.value = this.levels.length ? this.levels[0].texture : null;
    fm.uHasBloom.value = this.bloomOn && this.levels.length ? 1 : 0;
    fm.uBloom.value = P.bloom;
    fm.uExposure.value = P.exposure;
    fm.uWhite.value.copy(P.white);
    fm.uGrade.value.set(P.saturation, P.contrast, P.coolShadows, P.warmHighlights);
    fm.uVignette.value = P.vignette;
    this._pass(this.finalMat, null);
    r.autoClear = autoClear;
  }
}
