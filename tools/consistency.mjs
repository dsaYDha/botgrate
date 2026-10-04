// 판정-화면 일치 검사: 화면(GPU 셰이더)이 쓰는 지형 높이·풀/잡초/해바라기 덮개 높이·줄기 모양을
// 판정(CPU: 탄착·이동·덮개 통과)이 쓰는 값과 같은 지점에서 비교한다.
//   npm run test:consistency
// 화면 쪽 값은 렌더러가 실제로 쓰는 GLSL 함수(terrainHeight, coverAtG, stemOffset/stemRadius + 인스턴스 표)를
// 부동소수 렌더 타깃에 그려 읽는다. 바람 흔들림·밑동 뿌리 덩이(±8 %)처럼 화면에만 있는 부분은 REALISM_NOTES.md 3-1.

import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ logLevel: 'error', server: { port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];
const args = ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
if (!process.env.SHOTS_GPU) args.push('--use-angle=swiftshader');
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  try {
    localStorage.setItem('windbreak-fps-settings-v1', JSON.stringify({ quality: 'low', windMode: 'fixed', windSpeed: 5, windDir: 270 }));
  } catch {
    /* 무시 */
  }
});
await page.goto(`${base}?autostart&testinput`);
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 300000 });

const res = await page.evaluate(async () => {
  const url = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('/.vite/deps/three.js'));
  const THREE = await import(url);
  const { U, commonGLSL } = await import('/src/render/shaderLib.js');
  const { COVER_GLSL, coverAt, makeCoverSample } = await import('/src/world/GroundCover.js');
  const g = window.__game;
  const terrain = g.world.terrain;

  // 표본: 지도 전체 균일 + 숲띠 가장자리(덮개 경계가 많은 곳)
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const half = terrain.half - 4;
  const pts = [];
  while (pts.length < 6000) pts.push([(rnd() * 2 - 1) * half, (rnd() * 2 - 1) * half]);
  for (const t of g.world.belts.trees.filter((_, i) => i % 3 === 0)) {
    if (pts.length >= 8192) break;
    const a = rnd() * Math.PI * 2;
    const r = 2 + rnd() * 14;
    pts.push([t.x + Math.cos(a) * r, t.z + Math.sin(a) * r]);
  }
  const N = pts.length;
  const W = 1024;
  const H = Math.ceil(N / W);
  const data = new Float32Array(W * H * 4);
  pts.forEach((p, i) => {
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
  });
  const ptsTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  ptsTex.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uPts: { value: ptsTex } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      #include <common>
      ${commonGLSL()}
      ${COVER_GLSL}
      uniform sampler2D uPts;
      void main() {
        vec2 p = texelFetch(uPts, ivec2(gl_FragCoord.xy), 0).xy;
        Cover c = coverAtG(p);
        float h = 0.0, ws = 0.0;
        if (c.wStub > 0.01) { h += c.hStub * c.wStub; ws += c.wStub; }
        if (c.wFal > 0.01) { h += c.hFal * c.wFal; ws += c.wFal; }
        if (c.wGrass > 0.01) { h += c.hGrass * c.wGrass; ws += c.wGrass; }
        if (c.wSun > 0.01) { h += c.hSun * c.wSun; ws += c.wSun; }
        if (c.wFor > 0.01) { h += c.hFor * c.wFor; ws += c.wFor; }
        if (c.wRoad > 0.01) { h += c.hRoad * c.wRoad; ws += c.wRoad; }
        gl_FragColor = vec4(terrainHeight(p), ws > 0.05 ? h / ws : 0.0, c.wSun, c.wFor);
      }`,
  });
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const r = g.renderer;
  const prev = r.getRenderTarget();
  r.setRenderTarget(rt);
  r.render(scene, cam);
  const out = new Float32Array(W * H * 4);
  r.readRenderTargetPixels(rt, 0, 0, W, H, out);
  r.setRenderTarget(prev);

  const c = makeCoverSample();
  const P = (await import('/src/world/GroundCover.js')).coverParts;
  const parts = {};
  const dH = [];
  const dC = [];
  const dSun = [];
  let worstH = null;
  let worstC = null;
  for (let i = 0; i < N; i++) {
    const [x, z] = pts[i];
    const hCpu = terrain.heightAt(x, z);
    coverAt(terrain, x, z, c);
    P(terrain, x, z, parts);
    const eh = Math.abs(out[i * 4] - hCpu);
    const ec = Math.abs(out[i * 4 + 1] - c.h);
    dH.push(eh);
    dC.push(ec);
    dSun.push(Math.abs(out[i * 4 + 2] - parts.wSun));
    if (!worstH || eh > worstH.e) worstH = { e: eh, x, z, gpu: out[i * 4], cpu: hCpu };
    if (!worstC || ec > worstC.e) worstC = { e: ec, x, z, gpu: out[i * 4 + 1], cpu: c.h };
  }
  const stat = (a) => {
    const b = [...a].sort((p, q) => p - q);
    return { mean: b.reduce((p, q) => p + q, 0) / b.length, p99: b[Math.floor(b.length * 0.99)], max: b[b.length - 1] };
  };
  rt.dispose();
  mat.dispose();
  ptsTex.dispose();

  // 줄기: 화면 줄기 셰이더가 읽는 인스턴스 표(uTreeData) + GLSL 줄기 식 vs 판정 줄기(같은 나무 객체 + JS 식)
  const { STEM_GLSL, stemCenterAt, stemRadiusAt } = await import('/src/world/stemShape.js');
  const { TREE_TEX_W, TEXELS } = await import('/src/render/trees/treeShaders.js');
  const TR = g.trees;
  const belts = g.world.belts;
  const stems = [];
  belts.trees.forEach((t, i) => {
    if (i % 5 === 0) stems.push([i, t]);
  });
  belts.stumps.forEach((t, j) => stems.push([belts.trees.length + belts.shrubs.length + j, t]));
  const qs = [];
  for (const [id, t] of stems) {
    const L = t.top - t.y0;
    for (const h of [0.02, 0.15, 0.4, 1.0, 1.65, L * 0.5, L * 0.95]) if (h <= L) qs.push([id, h, t]);
  }
  const M = qs.length;
  const H2 = Math.ceil(M / W);
  const qd = new Float32Array(W * H2 * 4);
  qs.forEach((q, i) => {
    qd[i * 4] = q[0];
    qd[i * 4 + 1] = q[1];
  });
  const qTex = new THREE.DataTexture(qd, W, H2, THREE.RGBAFormat, THREE.FloatType);
  qTex.needsUpdate = true;
  const mat2 = new THREE.ShaderMaterial({
    uniforms: { uTreeData: TR.shared.uTreeData, uQ: { value: qTex } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D uTreeData;
      uniform sampler2D uQ;
      vec4 tFetch(int id, int k) { int t = id * ${TEXELS} + k; return texelFetch(uTreeData, ivec2(t % ${TREE_TEX_W}, t / ${TREE_TEX_W}), 0); }
      ${STEM_GLSL}
      void main() {
        vec4 q = texelFetch(uQ, ivec2(gl_FragCoord.xy), 0);
        int id = int(q.x + 0.5);
        float h = q.y;
        vec4 t0 = tFetch(id, 0);
        vec4 t1 = tFetch(id, 1);
        vec4 t4 = tFetch(id, 4);
        vec4 t7 = tFetch(id, 7);
        vec2 off = stemOffset(h, t1);
        gl_FragColor = vec4(t0.x + off.x, t0.y + h, t0.z + off.y, stemRadius(h, vec4(t4.x, t4.y, t4.z, t4.w), t7.y));
      }`,
  });
  quad.material = mat2;
  const rt2 = new THREE.WebGLRenderTarget(W, H2, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
  r.setRenderTarget(rt2);
  r.render(scene, cam);
  const o2 = new Float32Array(W * H2 * 4);
  r.readRenderTargetPixels(rt2, 0, 0, W, H2, o2);
  r.setRenderTarget(prev);
  const cc = { x: 0, z: 0 };
  const dPos = [];
  const dRad = [];
  let worstS = null;
  qs.forEach(([, h, t], i) => {
    stemCenterAt(t, h, cc);
    const ep = Math.hypot(o2[i * 4] - cc.x, o2[i * 4 + 1] - (t.y0 + h), o2[i * 4 + 2] - cc.z);
    const er = Math.abs(o2[i * 4 + 3] - stemRadiusAt(t, h));
    dPos.push(Number.isFinite(ep) ? ep : 1e9);
    dRad.push(Number.isFinite(er) ? er : 1e9);
    if (!worstS || er > worstS.e || !Number.isFinite(er)) worstS = { e: er, h, gpuR: o2[i * 4 + 3], cpuR: stemRadiusAt(t, h) };
  });
  rt2.dispose();
  mat2.dispose();
  qTex.dispose();
  return {
    N,
    terrain: stat(dH),
    cover: stat(dC),
    sun: stat(dSun),
    worstH,
    worstC,
    stems: { n: stems.length, q: M, pos: stat(dPos), rad: stat(dRad), worst: worstS },
  };
});

const cm = (v) => `${(v * 100).toFixed(2)} cm`;
console.log(`표본 ${res.N}곳 (지도 전체 + 숲띠 가장자리)`);
console.log(`지형 높이   화면 vs 판정: 평균 ${cm(res.terrain.mean)}, 99% ${cm(res.terrain.p99)}, 최대 ${cm(res.terrain.max)}`);
console.log(`덮개 높이   화면 vs 판정: 평균 ${cm(res.cover.mean)}, 99% ${cm(res.cover.p99)}, 최대 ${cm(res.cover.max)}`);
console.log(`해바라기 비중 화면 vs 판정: 최대 차 ${res.sun.max.toFixed(4)}`);
console.log(`줄기 ${res.stems.n}그루(그루터기 포함) × 높이 ${res.stems.q}곳  화면 vs 판정: 중심 최대 ${cm(res.stems.pos.max)}, 반지름 최대 ${cm(res.stems.rad.max)}`);
if (res.terrain.max > 0.02) console.log('  최악 지형', res.worstH);
if (res.stems.rad.max > 0.001) console.log('  최악 줄기', res.stems.worst);
if (res.cover.max > 0.05) console.log('  최악 덮개', res.worstC);
// 허용: 지형 2 cm(반정밀도 텍스처·하드웨어 필터 정밀도), 덮개 평균 높이 5 cm(풀 높이 수십 cm 대비)
// 줄기: 같은 수치·같은 식이므로 1 mm 이내(부동소수 오차)
const ok = res.terrain.max < 0.02 && res.cover.p99 < 0.05 && res.stems.pos.max < 0.001 && res.stems.rad.max < 0.001 && errors.length === 0;
if (errors.length) console.log('페이지 오류:', errors.slice(0, 5));
console.log(ok ? '통과: 화면과 판정이 같은 지형·덮개·줄기를 쓴다.' : '실패: 화면과 판정 값이 다르다.');
await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
