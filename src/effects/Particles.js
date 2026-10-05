// CPU 물리 + GPU 인스턴스 빌보드 입자(흙먼지, 나무 파편, 잎, 연기).
// 먼지 퍼프는 햇빛을 받아 밝게, 숲 그늘 안에서는 어둡게(수관 그늘 함수 공유).

import * as THREE from 'three';
import { U, commonGLSL, GLSL_OUTPUT } from '../render/shaderLib.js';

const CAP = 6000;

export const PK = { DUST: 0, CHIP: 1, LEAF: 2, SMOKE: 3, FLASH: 4 };

export class Particles {
  constructor(scene, world) {
    this.world = world;
    this.n = 0;
    this.px = new Float32Array(CAP);
    this.py = new Float32Array(CAP);
    this.pz = new Float32Array(CAP);
    this.vx = new Float32Array(CAP);
    this.vy = new Float32Array(CAP);
    this.vz = new Float32Array(CAP);
    this.life = new Float32Array(CAP);
    this.maxLife = new Float32Array(CAP);
    this.s0 = new Float32Array(CAP);
    this.s1 = new Float32Array(CAP);
    this.cr = new Float32Array(CAP);
    this.cg = new Float32Array(CAP);
    this.cb = new Float32Array(CAP);
    this.a0 = new Float32Array(CAP);
    this.kind = new Uint8Array(CAP);
    this.drag = new Float32Array(CAP);
    this.grav = new Float32Array(CAP);
    this.rot = new Float32Array(CAP);
    this.rotV = new Float32Array(CAP);
    this.windK = new Float32Array(CAP);
    this.rest = new Uint8Array(CAP);

    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); // xyz, size
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); // rgb, alpha
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2); // rot, kind
    for (const a of [this.aPos, this.aCol, this.aMisc]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aCol', this.aCol);
    geo.setAttribute('aMisc', this.aMisc);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...U },
      vertexShader: /* glsl */ `
        ${commonGLSL()}
        attribute vec4 aPos;
        attribute vec4 aCol;
        attribute vec2 aMisc;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vKind;
        varying vec3 vWP;
        varying float vLight;
        void main() {
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float c = cos(aMisc.x), s = sin(aMisc.x);
          vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
          float kind = aMisc.y;
          vec2 scale = kind > 1.5 && kind < 2.5 ? vec2(1.0, 0.62) : vec2(1.0);
          vec3 wp = aPos.xyz + (camR * q.x * scale.x + camU * q.y * scale.y) * aPos.w;
          vWP = wp;
          vUv = uv;
          vCol = aCol;
          vKind = kind;
          float gy = terrainHeight(aPos.xz);
          float sun = canopySun(aPos.xyz, gy);
          float sky = canopySky(aPos.xyz, gy);
          vLight = sun;
          vCol.rgb *= 1.0;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          // 카메라 코앞(1 m 안팎)의 먼지·연기는 초점이 안 맞아 흐릿한 막일 뿐: 빌보드 한 장이 화면을 덮지 않게 흐리게
          if (kind < 0.5 || (kind > 2.5 && kind < 3.5)) {
            float camD = length(aPos.xyz - cameraPosition);
            vCol.a *= smoothstep(0.35, 0.6 + aPos.w * 1.2, camD);
          }
          vCol.rgb = vCol.rgb * (uSunColor * uSunIntensity * (0.55 + 0.45 * sun) * sun + mix(uHemiGround, uHemiSky, 0.7) * uHemiIntensity * sky) * 0.3183;
          if (kind > 3.5) vCol.rgb = aCol.rgb * 3.0;
        }`,
      fragmentShader: /* glsl */ `
        ${commonGLSL()}
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vKind;
        varying vec3 vWP;
        varying float vLight;
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(d) * 2.0;
          float a;
          if (vKind < 0.5 || (vKind > 2.5 && vKind < 3.5)) {
            // 부드러운 먼지/연기 덩어리(가장자리 노이즈)
            float n = vnoise(vUv * 5.0 + vWP.xz * 0.7) * 0.5 + vnoise(vUv * 11.0 - vWP.y) * 0.5;
            a = (1.0 - smoothstep(0.35, 1.0, r + (n - 0.5) * 0.45)) * vCol.a;
          } else if (vKind < 1.5) {
            a = (abs(d.x) < 0.42 && abs(d.y) < 0.3) ? vCol.a : 0.0;
          } else if (vKind < 2.5) {
            a = (r < 0.95 && abs(d.y) < 0.5 * sqrt(max(0.0, 1.0 - d.x * d.x * 4.0))) ? vCol.a : 0.0;
          } else {
            // 총구 섬광: 별 모양
            float star = max(1.0 - smoothstep(0.0, 0.5, abs(d.x) * 6.0 + r * 0.5), 1.0 - smoothstep(0.0, 0.5, abs(d.y) * 6.0 + r * 0.5));
            a = max(star, 1.0 - smoothstep(0.0, 0.6, r)) * vCol.a;
          }
          if (a < 0.01) discard;
          gl_FragColor = vec4(vCol.rgb, a);
          if (vKind < 3.5) {
            ${GLSL_OUTPUT}
          } else {
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
  }

  spawn(o) {
    if (this.n >= CAP) return -1;
    const i = this.n++;
    this.px[i] = o.x;
    this.py[i] = o.y;
    this.pz[i] = o.z;
    this.vx[i] = o.vx || 0;
    this.vy[i] = o.vy || 0;
    this.vz[i] = o.vz || 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life || 1;
    this.s0[i] = o.size0 ?? 0.1;
    this.s1[i] = o.size1 ?? this.s0[i];
    this.cr[i] = o.r;
    this.cg[i] = o.g;
    this.cb[i] = o.b;
    this.a0[i] = o.alpha ?? 1;
    this.kind[i] = o.kind ?? PK.DUST;
    this.drag[i] = o.drag ?? 1;
    this.grav[i] = o.gravity ?? 0;
    this.rot[i] = o.rot ?? Math.random() * 6.28;
    this.rotV[i] = o.rotV ?? 0;
    this.windK[i] = o.wind ?? 1;
    this.rest[i] = 0;
    return i;
  }

  update(dt, time) {
    const w = this.world;
    const wind = { x: 0, y: 0, z: 0 };
    let k = 0;
    const P = this.aPos.array;
    const C = this.aCol.array;
    const M = this.aMisc.array;
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) continue;
      // 이동(공기 저항 + 바람 + 중력)
      if (!this.rest[i]) {
        w.wind.sample(this.px[i], this.py[i], this.pz[i], time, wind);
        const dr = this.drag[i];
        const wk = this.windK[i];
        this.vx[i] += ((wind.x * wk - this.vx[i]) * dr - 0) * dt;
        this.vz[i] += ((wind.z * wk - this.vz[i]) * dr) * dt;
        this.vy[i] += (-this.vy[i] * dr - this.grav[i]) * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        this.rot[i] += this.rotV[i] * dt;
        const gy = w.terrain.heightAt(this.px[i], this.pz[i]);
        const kind = this.kind[i];
        if ((kind === PK.CHIP || kind === PK.LEAF) && this.py[i] < gy + 0.02) {
          this.py[i] = gy + 0.02;
          this.rest[i] = 1;
          this.maxLife[i] = Math.min(this.maxLife[i], this.life[i] + (kind === PK.LEAF ? 25 : 12));
        } else if (this.py[i] < gy + 0.05 && kind === PK.DUST) {
          this.py[i] = gy + 0.05;
          this.vy[i] = Math.abs(this.vy[i]) * 0.2;
        }
      }
      // 압축 저장
      if (k !== i) {
        this.px[k] = this.px[i];
        this.py[k] = this.py[i];
        this.pz[k] = this.pz[i];
        this.vx[k] = this.vx[i];
        this.vy[k] = this.vy[i];
        this.vz[k] = this.vz[i];
        this.life[k] = this.life[i];
        this.maxLife[k] = this.maxLife[i];
        this.s0[k] = this.s0[i];
        this.s1[k] = this.s1[i];
        this.cr[k] = this.cr[i];
        this.cg[k] = this.cg[i];
        this.cb[k] = this.cb[i];
        this.a0[k] = this.a0[i];
        this.kind[k] = this.kind[i];
        this.drag[k] = this.drag[i];
        this.grav[k] = this.grav[i];
        this.rot[k] = this.rot[i];
        this.rotV[k] = this.rotV[i];
        this.windK[k] = this.windK[i];
        this.rest[k] = this.rest[i];
      }
      const f = this.life[k] / this.maxLife[k];
      const kind = this.kind[k];
      let size = this.s0[k] + (this.s1[k] - this.s0[k]) * (kind === PK.DUST || kind === PK.SMOKE ? 1 - Math.pow(1 - f, 2.2) : f);
      let alpha = this.a0[k];
      if (kind === PK.DUST || kind === PK.SMOKE) alpha *= Math.min(1, this.life[k] / 0.05) * Math.pow(1 - f, 0.85);
      else if (kind === PK.FLASH) alpha *= 1 - f;
      else alpha *= f > 0.85 ? (1 - f) / 0.15 : 1;
      P[k * 4] = this.px[k];
      P[k * 4 + 1] = this.py[k];
      P[k * 4 + 2] = this.pz[k];
      P[k * 4 + 3] = size;
      C[k * 4] = this.cr[k];
      C[k * 4 + 1] = this.cg[k];
      C[k * 4 + 2] = this.cb[k];
      C[k * 4 + 3] = alpha;
      M[k * 2] = this.rot[k];
      M[k * 2 + 1] = kind;
      k++;
    }
    this.n = k;
    this.geo.instanceCount = k;
    if (k > 0) {
      for (const a of [this.aPos, this.aCol, this.aMisc]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, k * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }
}
