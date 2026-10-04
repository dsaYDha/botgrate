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

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uExposure;
uniform vec3 uWhite;       // 화이트 밸런스(선형 곱)
uniform vec4 uGrade;       // 채도, 대비, 그림자 차갑게, 밝은 곳 따뜻하게
uniform float uVignette;
uniform float uHasBloom;
varying vec2 vUv;

float lumi(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  if (uHasBloom > 0.5) c += texture2D(tBloom, vUv).rgb * uBloom;
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
    };
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
    });
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

  /** 장면 렌더 뒤 호출: 블룸 → 최종 합성 */
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
