// 4배율 광학 조준경 화면 표시: 접안부 시야 원(실시야 7°) 밖은 경통 그림자,
// 레티클(중앙 갈매기형 = 100 m 영점, BDC 눈금)은 이 게임 탄도로 계산한 각도에 정확히 그린다.
// 각 눈금 폭 = 그 거리에서 어깨폭 0.48 m (거리 측정용).

export class OpticOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.visible = false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
  }

  /**
   * @param {object} o {alpha, fovDeg(세로), trueFovDeg, bdc:[{range,hold,halfWidth}], eyeX, eyeY(눈 위치 어긋남 / 아이박스)}
   * 아이박스: 눈이 광축에서 아이박스(6 mm)만큼 벗어나면 가장자리에 그림자 초승달이 뚜렷해지고 보이는 원이 좁아진다.
   */
  draw(o) {
    const c = this.canvas;
    if (o.alpha <= 0.01) {
      if (this.visible) {
        c.style.display = 'none';
        this.visible = false;
      }
      return;
    }
    if (!this.visible) {
      c.style.display = 'block';
      this.visible = true;
    }
    if (window.innerWidth !== this.w || window.innerHeight !== this.h) this.resize();
    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.w;
    const H = this.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = o.alpha;
    const tanHalf = Math.tan((o.fovDeg * Math.PI) / 360);
    const pxPerTan = H / 2 / tanHalf;
    const cx = W / 2;
    const cy = H / 2;
    const R0 = Math.tan((o.trueFovDeg * Math.PI) / 360) * pxPerTan;
    const k = R0 * 0.12; // 아이박스 1만큼 어긋날 때 화소
    const offX = (o.eyeX || 0) * k;
    const offY = (o.eyeY || 0) * k;
    const ratio = Math.hypot(o.eyeX || 0, o.eyeY || 0);
    const R = R0 * (1 - 0.2 * Math.min(1.5, ratio));
    const ex = cx + offX;
    const ey = cy + offY;

    // 경통 그림자(눈이 광축에서 벗어나면 초승달 그림자)
    ctx.save();
    ctx.fillStyle = '#050505';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(ex, ey, R, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    const g = ctx.createRadialGradient(ex, ey, R * 0.82, ex, ey, R * 1.01);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.75, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ex, ey, R * 1.01, 0, Math.PI * 2);
    ctx.fill();
    if (ratio > 0.05) {
      // 그림자 초승달: 보이는 원 안에서, 어긋난 쪽 가장자리부터 어둡게 밀려 들어온다
      const sx = cx - offX * 2.2;
      const sy = cy - offY * 2.2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(ex, ey, R * 1.01, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.92, ratio * 0.8)})`;
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(sx, sy, R * 1.02, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.restore();
    }
    ctx.restore();

    // 레티클(광축 = 화면 중심에 고정)
    ctx.save();
    ctx.globalAlpha = o.alpha;
    ctx.beginPath();
    ctx.arc(ex, ey, R * 0.995, 0, Math.PI * 2);
    ctx.clip();
    const lw = Math.max(1, 1.2 * (H / 1080));
    ctx.strokeStyle = 'rgba(8,8,8,0.92)';
    ctx.fillStyle = 'rgba(8,8,8,0.92)';
    ctx.lineWidth = lw;
    const px = (rad) => Math.tan(rad) * pxPerTan;
    // 위·좌·우 굵은 기둥(중심 근처는 비움)
    const gap = px(0.006);
    ctx.lineWidth = lw * 2.4;
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx - gap * 2.2, cy);
    ctx.moveTo(cx + gap * 2.2, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy - gap * 2.2);
    ctx.stroke();
    // 아래 세로선(BDC 눈금을 잇는 선)
    ctx.lineWidth = lw;
    const last = o.bdc[o.bdc.length - 1];
    ctx.beginPath();
    ctx.moveTo(cx, cy + gap * 0.9);
    ctx.lineTo(cx, cy + px(last.hold) + px(0.004));
    ctx.stroke();
    // 중앙 갈매기형(꼭짓점 = 100 m 조준점), 붉은 조명
    const chev = px(0.0018);
    ctx.strokeStyle = 'rgba(200,30,20,0.95)';
    ctx.lineWidth = lw * 1.6;
    ctx.beginPath();
    ctx.moveTo(cx - chev * 2.2, cy + chev * 2.6);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + chev * 2.2, cy + chev * 2.6);
    ctx.stroke();
    // BDC 눈금
    ctx.strokeStyle = 'rgba(8,8,8,0.92)';
    ctx.lineWidth = lw;
    ctx.font = `${Math.round(Math.max(10, 11 * (H / 1080)))}px sans-serif`;
    ctx.textBaseline = 'middle';
    for (const m of o.bdc) {
      const y = cy + px(m.hold);
      const hw = Math.max(px(m.halfWidth), 2.5);
      ctx.lineWidth = lw * 1.3;
      ctx.beginPath();
      ctx.moveTo(cx - hw, y);
      ctx.lineTo(cx + hw, y);
      ctx.stroke();
      // 짝수 눈금만 숫자(4, 6, 8)
      if ((m.range / 100) % 2 === 0) ctx.fillText(String(m.range / 100), cx + hw + 4, y);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
