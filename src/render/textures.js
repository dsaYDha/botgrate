// 절차적 텍스처: 잎 카드 아틀라스(2×2 타일: 포플러/느릅/아까시/관목).
// 채널: R = 잎 명암, G = 잔가지 마스크, B = 잎마다 다른 난수(노랗게 물든 잎 선택용), A = 덮임.

import * as THREE from 'three';
import { Random } from '../core/Random.js';

function leafPath(ctx, kind, len, wid) {
  ctx.beginPath();
  if (kind === 'poplar') {
    // 마름모-삼각형 잎
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(wid * 0.9, len * 0.35, wid * 0.25, len * 0.85);
    ctx.lineTo(0, len);
    ctx.lineTo(-wid * 0.25, len * 0.85);
    ctx.quadraticCurveTo(-wid * 0.9, len * 0.35, 0, 0);
  } else if (kind === 'elm') {
    // 비대칭 타원 + 잔 톱니
    ctx.moveTo(0, 0);
    const n = 9;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const w = wid * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (i % 2 ? 1.08 : 0.94);
      ctx.lineTo(w, len * t);
    }
    for (let i = n - 1; i >= 0; i--) {
      const t = i / n;
      const w = wid * 0.45 * Math.sin(Math.PI * Math.pow(t, 0.85)) * (i % 2 ? 1.08 : 0.94);
      ctx.lineTo(-w, len * t);
    }
  } else {
    // 작은 타원 소엽
    ctx.ellipse(0, len * 0.5, wid * 0.5, len * 0.5, 0, 0, Math.PI * 2);
  }
  ctx.closePath();
}

function drawTile(ctx, ox, oy, size, kind, rng) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, size, size);
  ctx.clip();
  const twig = (x0, y0, x1, y1, w) => {
    ctx.strokeStyle = `rgba(40,255,0,1)`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2 + rng.range(-12, 12), (y0 + y1) / 2 + rng.range(-12, 12), x1, y1);
    ctx.stroke();
  };
  const leaf = (x, y, ang, len, wid, k = kind) => {
    const shade = Math.floor(rng.range(135, 245));
    const id = Math.floor(rng.range(0, 255));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    // 잎자루
    ctx.strokeStyle = `rgba(60,255,${id},1)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.18);
    ctx.lineTo(0, 0);
    ctx.stroke();
    // 잎몸: 밑에서 끝으로 밝기 변화 + 가장자리 어둡게(R=명암, B=잎 번호)
    const g = ctx.createLinearGradient(-wid * 0.5, 0, wid * 0.5, len);
    const d = Math.max(0, shade - 55);
    g.addColorStop(0, `rgb(${d},0,${id})`);
    g.addColorStop(0.45, `rgb(${shade},0,${id})`);
    g.addColorStop(1, `rgb(${Math.max(0, shade - 30)},0,${id})`);
    ctx.fillStyle = g;
    leafPath(ctx, k, len, wid);
    ctx.fill();
    // 잎맥: 주맥 + 측맥
    ctx.strokeStyle = `rgba(${Math.min(255, shade + 25)},0,${id},0.85)`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, len * 0.92);
    const nv = k === 'locust' ? 3 : 5;
    for (let v = 1; v <= nv; v++) {
      const t = v / (nv + 1);
      const w = wid * 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.1));
      ctx.moveTo(0, len * t);
      ctx.lineTo(w, len * (t + 0.12));
      ctx.moveTo(0, len * t);
      ctx.lineTo(-w, len * (t + 0.12));
    }
    ctx.stroke();
    // 그늘진 가장자리 선
    ctx.strokeStyle = `rgba(${Math.max(0, shade - 80)},0,${id},0.6)`;
    ctx.lineWidth = 1.1;
    leafPath(ctx, k, len, wid);
    ctx.stroke();
    ctx.restore();
  };
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  if (kind === 'locust') {
    // 깃꼴 겹잎: 잎자루 + 소엽 여러 쌍
    for (let c = 0; c < 26; c++) {
      const x0 = cx + rng.range(-size * 0.42, size * 0.42);
      const y0 = cy + rng.range(-size * 0.42, size * 0.42);
      const a = rng.range(0, Math.PI * 2);
      const L = rng.range(70, 120);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      twig(x0, y0, x0 + dx * L, y0 + dy * L, 1.5);
      const pairs = Math.floor(rng.range(4, 7));
      for (let p = 0; p < pairs; p++) {
        const t = (p + 0.6) / (pairs + 0.5);
        const px = x0 + dx * L * t;
        const py = y0 + dy * L * t;
        for (const side of [-1, 1]) leaf(px, py, a + side * 1.35 + rng.range(-0.2, 0.2) - Math.PI / 2, rng.range(17, 23), rng.range(10, 13));
      }
      leaf(x0 + dx * L, y0 + dy * L, a - Math.PI / 2, 20, 12);
    }
  } else {
    // 잔가지 + 잎 다발
    const branches = kind === 'shrub' ? 16 : 11;
    for (let b = 0; b < branches; b++) {
      const x0 = cx + rng.range(-size * 0.45, size * 0.45);
      const y0 = cy + rng.range(-size * 0.45, size * 0.45);
      const a = rng.range(0, Math.PI * 2);
      const L = rng.range(90, 170);
      twig(x0, y0, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L, 2.2);
    }
    const n = kind === 'poplar' ? 120 : kind === 'elm' ? 230 : 260;
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(rng.next()) * size * 0.48;
      const t = rng.range(0, Math.PI * 2);
      const x = cx + Math.cos(t) * r;
      const y = cy + Math.sin(t) * r;
      let len;
      let wid;
      let k = kind;
      if (kind === 'poplar') {
        len = rng.range(30, 44);
        wid = len * rng.range(0.8, 1.0);
      } else if (kind === 'elm') {
        len = rng.range(20, 30);
        wid = len * rng.range(0.55, 0.7);
      } else {
        // 관목: 여러 모양 섞임
        k = rng.chance(0.5) ? 'elm' : 'locust';
        len = rng.range(16, 26);
        wid = len * rng.range(0.55, 0.75);
      }
      leaf(x, y, rng.range(0, Math.PI * 2), len, wid, k);
    }
  }
  ctx.restore();
}

export function makeLeafAtlas(size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = new Random(77);
  const t = size / 2;
  drawTile(ctx, 0, 0, t, 'poplar', rng);
  drawTile(ctx, t, 0, t, 'elm', rng);
  drawTile(ctx, 0, t, t, 'locust', rng);
  drawTile(ctx, t, t, t, 'shrub', rng);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.premultiplyAlpha = false;
  return tex;
}

/** 아틀라스 타일 uv 오프셋 (0: 포플러, 1: 느릅, 2: 아까시, 3: 관목) */
export function atlasTile(i) {
  return [(i % 2) * 0.5, i < 2 ? 0.5 : 0.0];
}
