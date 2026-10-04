// 개발용: 한 시점을 여러 조건으로 렌더해 비교(예: 식생 끄기). node tools/probe.mjs <name> <x> <z> <eye> <yaw> <pitch> [expr...]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
const [name, x, z, eye, yaw, pitch, ...exprs] = process.argv.slice(2);
const [W, H] = (process.env.SHOTS_SIZE || '960x540').split('x').map(Number);
const server = await createServer({ logLevel: 'error', server: { port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
await page.addInitScript((q) => { try { localStorage.setItem('windbreak-fps-settings-v1', JSON.stringify({ quality: q, windMode: 'fixed', windSpeed: 5, windDir: 270, fov: 55 })); } catch {} }, process.env.SHOTS_QUALITY || 'high');
await page.goto(`${server.resolvedUrls.local[0]}?autostart&testinput&cam=${x},0,${z},${yaw},${pitch},55`);
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 300000 });
fs.mkdirSync('shots/probe', { recursive: true });
const variants = exprs.length ? exprs : [''];
for (let i = 0; i < variants.length; i++) {
  const url = await page.evaluate(([c, ex]) => {
    const g = window.__game;
    g.time = 600;
    const y = g.world.terrain.heightAt(c.x, c.z) + c.eye;
    g.debugCam = { x: c.x, y, z: c.z, yaw: (c.yaw * Math.PI) / 180, pitch: (c.pitch * Math.PI) / 180, fov: +(c.fov || 55) };
    if (ex) (0, eval)(ex);
    g.frozen = true;
    for (let k = 0; k < 3; k++) { g.update(1 / 60); g.render(); }
    const u = g.renderer.domElement.toDataURL('image/jpeg', 0.9);
    g.frozen = false;
    return u;
  }, [{ x: +x, z: +z, eye: +eye, yaw: +yaw, pitch: +pitch, fov: process.env.FOV || 55 }, variants[i]]);
  const f = `shots/probe/${name}-${i}.jpg`;
  fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
  console.log('saved', f, variants[i]);
}
await browser.close();
await server.close();
