// 원경: 플레이 구역 밖으로 지평선까지 이어지는 방풍림 격자(초원 농경지 특유의 경관).
// 멀리서만 보이므로 수관 윤곽(노이즈)으로 위쪽을 잘라낸 수직 띠 두 장으로 단순화, 대기 원근으로 흐려진다.

import * as THREE from 'three';
import { U, commonGLSL, GLSL_OUTPUT } from './shaderLib.js';
import { Random } from '../core/Random.js';
import { WORLD } from '../data/world.js';

export class DistantScenery {
  constructor(scene, terrainHeight) {
    const D = WORLD.distant;
    const rng = new Random(WORLD.seed ^ 0x77);
    const pos = [];
    const uv = [];
    const idx = [];
    const inner = WORLD.mapHalf + 60;
    const addWall = (x0, z0, x1, z1, h, off) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(2, Math.ceil(len / 40));
      const nx = -(z1 - z0) / len;
      const nz = (x1 - x0) / len;
      for (const side of [-1, 1]) {
        const base = pos.length / 3;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const x = x0 + (x1 - x0) * t + nx * side * 8;
          const z = z0 + (z1 - z0) * t + nz * side * 8;
          const y = terrainHeight(x, z) - 0.5;
          pos.push(x, y, z, x, y + h * 1.15, z);
          uv.push(t * len + off, 0, t * len + off, 1);
        }
        for (let i = 0; i < n; i++) {
          const a = base + i * 2;
          idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
      }
    };
    const E = D.extent;
    const spacing = D.spacing;
    // 동서 띠
    for (let z = -E; z <= E; z += spacing) {
      const zz = z + rng.range(-40, 40);
      let x = -E;
      while (x < E) {
        const seg = rng.range(500, 1300);
        const x1 = Math.min(E, x + seg);
        const h = D.height * rng.range(0.8, 1.2);
        // 플레이 구역과 겹치면 건너뜀
        const crosses = Math.abs(zz) < inner && x1 > -inner && x < inner;
        if (!crosses && rng.next() > 0.12) addWall(x, zz, x1, zz, h, rng.range(0, 1000));
        x = x1 + rng.range(30, 120);
      }
    }
    // 남북 연결 띠(드문드문)
    for (let x = -E; x <= E; x += spacing * 3.3) {
      const xx = x + rng.range(-60, 60);
      let z = -E;
      while (z < E) {
        const seg = rng.range(300, 900);
        const z1 = Math.min(E, z + seg);
        const crosses = Math.abs(xx) < inner && z1 > -inner && z < inner;
        if (!crosses && rng.next() > 0.45) addWall(xx, z, xx, z1, D.height * rng.range(0.8, 1.15), rng.range(0, 1000));
        z = z1 + rng.range(200, 700);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...U },
      vertexShader: /* glsl */ `
        ${commonGLSL()}
        varying vec2 vUv;
        varying vec3 vWP;
        void main() {
          vUv = uv;
          vWP = position;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${commonGLSL()}
        varying vec2 vUv;
        varying vec3 vWP;
        void main() {
          float s = vUv.x;
          // 수관 윤곽: 나무마다 둥근 꼭대기 + 높이 변화
          float crown = 0.72 + 0.16 * vnoise(vec2(s * 0.09, 3.1)) + 0.1 * vnoise(vec2(s * 0.35, 7.7)) + 0.05 * sin(s * 1.1);
          if (vUv.y > crown) discard;
          float n = vnoise(vec2(s * 0.5, vUv.y * 6.0)) * 0.5 + vnoise(vec2(s * 2.0, vUv.y * 20.0)) * 0.5;
          vec3 leaf = mix(vec3(0.07, 0.1, 0.035), vec3(0.16, 0.17, 0.06), n);
          leaf = mix(leaf, vec3(0.05, 0.05, 0.035), smoothstep(0.35, 0.0, vUv.y)); // 아래쪽(줄기·그늘)
          float lit = 0.45 + 0.55 * smoothstep(0.2, 0.9, vUv.y / crown);
          vec3 col = leaf * (uSunColor * uSunIntensity * 0.55 * lit + mix(uHemiGround, uHemiSky, 0.6) * uHemiIntensity) * 0.3183;
          gl_FragColor = vec4(col, 1.0);
          ${GLSL_OUTPUT}
        }`,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
}
