import { Game } from './core/Game.js';

const loadingText = document.getElementById('loading-text');

async function boot() {
  // 로딩 문구가 먼저 그려지도록 한 프레임 양보
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const game = new Game(document.getElementById('app'), (msg) => (loadingText.textContent = msg));
    await game.init();
    window.__game = game;
    document.getElementById('loading').classList.add('hidden');
    game.start();
  } catch (e) {
    console.error(e);
    loadingText.textContent = '초기화 실패: ' + (e && e.message ? e.message : e);
  }
}

boot();
