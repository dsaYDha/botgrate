// 개발용: 임포스터 아틀라스(키·법선)를 PNG로 저장 → shots/probe/imp-key.png, imp-nrm.png
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
const server = await createServer({ logLevel: 'error', server: { port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
await page.addInitScript(() => { try { localStorage.setItem('windbreak-fps-settings-v1', JSON.stringify({ quality: 'high', windMode: 'fixed', windSpeed: 5, windDir: 270, fov: 55 })); } catch {} });
await page.goto(`${server.resolvedUrls.local[0]}?autostart&testinput&cam=0,0,0,0,0,55`);
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 300000 });
fs.mkdirSync('shots/probe', { recursive: true });
const out = await page.evaluate(() => {
  const g = window.__game;
  const rt = g.trees.impostorTarget;
  const W = rt.width, H = rt.height;
  const res = [];
  for (let ti = 0; ti < 2; ti++) {
    const buf = new Uint8Array(W * H * 4);
    g.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf, undefined, ti);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4;
      const a = buf[s + 3];
      // 배경 회색 위에 표시
      for (let k = 0; k < 3; k++) img.data[d + k] = a ? buf[s + k] : 60;
      img.data[d + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    res.push(c.toDataURL('image/png'));
  }
  return res;
});
fs.writeFileSync('shots/probe/imp-key.png', Buffer.from(out[0].split(',')[1], 'base64'));
fs.writeFileSync('shots/probe/imp-nrm.png', Buffer.from(out[1].split(',')[1], 'base64'));
console.log('saved');
await browser.close();
await server.close();
