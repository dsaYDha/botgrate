// 고정 카메라 스크린샷 + 렌더 통계.
//   npm run shots                 → shots/current/
//   npm run shots -- before       → shots/before/   (이름 지정)
//   SHOTS_SIZE=1280x720 npm run shots
//   SHOTS_GPU=1 npm run shots     → 소프트웨어 렌더러(SwiftShader) 대신 GPU 사용 시도
// 처음 한 번: npx playwright install chromium
// 같은 시점·같은 바람(고정 5 m/s, 서풍)·같은 시각으로 찍어 변경 전후를 비교한다.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const label = process.argv[2] || 'current';
const [W, H] = (process.env.SHOTS_SIZE || '1920x1080').split('x').map(Number);
const quality = process.env.SHOTS_QUALITY || 'high';
const outDir = path.resolve('shots', label);
fs.mkdirSync(outDir, { recursive: true });

// x 동(+), z 남(+). yaw: 0 = 북, 90 = 동, 180 = 남, -90 = 서. pitch: 위(+). eye: 지면 위 눈높이(m)
export const CAMS = [
  { id: '1-edge', name: '숲띠 가장자리(남쪽 띠 북면, 서쪽을 봄)', x: 380, z: 241.5, eye: 1.65, yaw: -96, pitch: 4 },
  { id: '2-field', name: '들판 건너 먼 숲띠(시작 위치, 북쪽)', x: 418, z: 248.5, eye: 1.65, yaw: 0, pitch: 1 },
  { id: '3-shrub', name: '덤불 근접(남쪽 띠 가장자리 관목)', x: 431, z: 246.2, eye: 1.5, yaw: 180, pitch: -3 },
  { id: '4-interior', name: '숲띠 내부(열 사이, 서쪽)', x: 300, z: 260, eye: 1.65, yaw: -90, pitch: 6 },
  { id: '5-end', name: '숲띠 끝 측면(남쪽 띠 서쪽 끝)', x: -478, z: 239.5, eye: 1.65, yaw: -96, pitch: 2 },
];

// SHOTS_ONLY=2-field,4-interior 처럼 일부만
const only = process.env.SHOTS_ONLY ? process.env.SHOTS_ONLY.split(',') : null;
const camList = only ? CAMS.filter((c) => only.some((o) => c.id.startsWith(o))) : CAMS;

// 파일 감시·HMR 끔: 촬영 중 소스를 고쳐도 페이지가 다시 로드되지 않게
const server = await createServer({ logLevel: 'error', server: { port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];

const args = ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
if (!process.env.SHOTS_GPU) args.push('--use-angle=swiftshader');
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
});
await page.addInitScript((q) => {
  try {
    localStorage.setItem(
      'windbreak-fps-settings-v1',
      JSON.stringify({ quality: q, windMode: 'fixed', windSpeed: 5, windDir: 270, fov: 55 }),
    );
  } catch {
    /* 무시 */
  }
}, quality);

const cam0 = camList[0];
await page.goto(`${base}?autostart&testinput&cam=${cam0.x},0,${cam0.z},${cam0.yaw},${cam0.pitch},55`);
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 300000 });
// 시각 고정(구름·바람 위상)
await page.evaluate(() => {
  const g = window.__game;
  g.time = 600;
  g._shots = { t: [] };
});

const report = { label, size: `${W}x${H}`, quality, renderer: process.env.SHOTS_GPU ? 'GPU' : 'SwiftShader(소프트웨어)', cams: [] };
for (const c of camList) {
  await page.evaluate((c) => {
    const g = window.__game;
    const y = g.world.terrain.heightAt(c.x, c.z) + c.eye;
    g.debugCam = { x: c.x, y, z: c.z, yaw: (c.yaw * Math.PI) / 180, pitch: (c.pitch * Math.PI) / 180, fov: 55 };
  }, c);
  // 인스턴스 갱신·그림자·셰이더 컴파일이 끝나도록 몇 프레임 진행
  await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const f = () => (++n >= 6 ? res() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
  );
  const stats = await page.evaluate(
    () =>
      new Promise((res) => {
        const g = window.__game;
        const times = [];
        let last = performance.now();
        let n = 0;
        const f = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          if (++n >= 8) {
            times.sort((a, b) => a - b);
            const info = g.renderer.info;
            res({
              frameMs: times[Math.floor(times.length / 2)],
              calls: info.render.calls,
              triangles: info.render.triangles,
              geometries: info.memory.geometries,
              textures: info.memory.textures,
            });
          } else requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      }),
  );
  // CPU 갱신 시간(렌더 제외): update()만 따로 20회
  const cpuMs = await page.evaluate(() => {
    const g = window.__game;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) g.update(1 / 60);
    return (performance.now() - t0) / 20;
  });
  // 렌더 루프를 멈추고 한 프레임을 직접 그린 뒤 같은 작업 안에서 캔버스를 읽는다(소프트웨어 렌더러에서도 안정적)
  const dataUrl = await page.evaluate(() => {
    const g = window.__game;
    g.frozen = true;
    g.update(1 / 60);
    g.render();
    const url = g.renderer.domElement.toDataURL('image/jpeg', 0.9);
    g.frozen = false;
    return url;
  });
  const file = path.join(outDir, `${c.id}.jpg`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  report.cams.push({ id: c.id, name: c.name, ...stats, cpuUpdateMs: +cpuMs.toFixed(2), file: path.relative(process.cwd(), file) });
  console.log(
    `${c.id.padEnd(11)} 그리기 ${String(stats.calls).padStart(4)}  삼각형 ${(stats.triangles / 1e6).toFixed(2)}M  프레임 ${stats.frameMs.toFixed(0)} ms  CPU 갱신 ${cpuMs.toFixed(2)} ms`,
  );
}
report.errors = errors;
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
if (errors.length) console.log('콘솔 오류:\n' + errors.join('\n'));
else console.log('콘솔 오류 없음');
console.log(`저장: ${path.relative(process.cwd(), outDir)}/`);
await browser.close();
await server.close();
