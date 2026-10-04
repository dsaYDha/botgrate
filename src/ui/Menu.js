// 시작/일시정지 메뉴와 설정 입력 연결.

export class Menu {
  constructor(settings, onStart) {
    this.settings = settings;
    this.el = document.getElementById('menu');
    this.onStart = onStart;
    const $ = (id) => document.getElementById(id);
    const bindRange = (id, key, label, fmt = (v) => v) => {
      const input = $(id);
      const out = $(label);
      input.value = settings.get(key);
      out.textContent = fmt(settings.get(key));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        settings.set(key, v);
        out.textContent = fmt(v);
      });
    };
    bindRange('s-sens', 'sensitivity', 'v-sens', (v) => Number(v).toFixed(2));
    bindRange('s-fov', 'fov', 'v-fov', (v) => `${v}°`);
    bindRange('s-realfov', 'realFov', 'v-realfov', (v) => `${v}°`);
    bindRange('s-wspd', 'windSpeed', 'v-wspd', (v) => Number(v).toFixed(1));
    bindRange('s-wdir', 'windDir', 'v-wdir', (v) => v);
    bindRange('s-vol', 'volume', 'v-vol', (v) => `${Math.round(v * 100)}%`);
    const bindSelect = (id, key, num = false) => {
      const s = $(id);
      s.value = String(settings.get(key));
      s.addEventListener('change', () => settings.set(key, num ? Number(s.value) : s.value));
    };
    bindSelect('s-zero', 'zero', true);
    bindSelect('s-wind-mode', 'windMode');
    bindSelect('s-quality', 'quality');
    const adsT = $('s-adstoggle');
    adsT.checked = !!settings.get('adsToggle');
    adsT.addEventListener('change', () => settings.set('adsToggle', adsT.checked));
    const updWind = () => ($('wind-fixed').style.display = settings.get('windMode') === 'fixed' ? 'grid' : 'none');
    updWind();
    settings.onChange((k) => {
      if (k === 'windMode') updWind();
    });
    $('btn-start').addEventListener('click', () => this.onStart());
    this.btn = $('btn-start');
  }
  show(started) {
    this.btn.textContent = started ? '계속하기' : '클릭해서 시작';
    this.el.classList.remove('hidden');
  }
  hide() {
    this.el.classList.add('hidden');
  }
}
