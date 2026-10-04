// 분위기 효과(관찰자 둘레):
//  - 떨어지는 잎: 수관 아래(수관 지도 밀도로 위치를 고름)에서 생겨 바람(world/Wind.js와 같은 바람장)에 날리며
//    빙글빙글 떨어진다. 9월 말이라 노란 잎·마른 갈색 잎이 많고 초록 잎도 섞인다.
//  - 떠다니는 씨앗 갓털·먼지: 들판·숲 가장자리 공기 중에 바람 따라 흐르고, 해를 등진 쪽에서 보면 반짝인다.
// 둘 다 화면 장식일 뿐 판정에는 영향이 없다(크기 수 mm~수 cm).

import * as THREE from 'three';
import { U, commonGLSL } from '../render/shaderLib.js';
import { Random } from '../core/Random.js';

const LEAF_N = 200;
const MOTE_N = 220;
const RANGE = 26;

const LEAF_VS = /* glsl */ `
#include <common>
${commonGLSL()}
attribute vec4 iA; // 위치 xyz, 크기
attribute vec4 iB; // 회전 사원수
attribute vec3 iC; // 색
varying vec2 vUv;
varying vec3 vN;
varying vec3 vCol;
varying vec3 vWP;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vUv = uv;
  vec3 p = qrot(iB, position * iA.w);
  vN = qrot(iB, vec3(0.0, 0.0, 1.0));
  vCol = iC;
  vWP = iA.xyz + p;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWP, 1.0);
}
`;

const LEAF_FS = /* glsl */ `
#include <common>
${commonGLSL()}
varying vec2 vUv;
varying vec3 vN;
varying vec3 vCol;
varying vec3 vWP;
void main() {
  // 잎 모양(끝이 뾰족한 타원) + 잎자루
  vec2 q = vUv * 2.0 - 1.0;
  float w = 0.55 * (1.0 - q.y * q.y) * (1.0 - 0.35 * max(q.y, 0.0));
  if (abs(q.x) > w && !(abs(q.x) < 0.04 && q.y < -0.85)) discard;
  vec3 N = normalize(gl_FrontFacing ? vN : -vN);
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWP);
  float sunVis = canopySun(vWP, terrainHeight(vWP.xz)) * cloudShadow(vWP);
  float diff = abs(dot(N, L)) * 0.7 + 0.3;
  float trans = pow(max(dot(-V, L), 0.0), 4.0) * 0.8;
  float vein = 1.0 - 0.25 * smoothstep(0.06, 0.0, abs(q.x));
  vec3 alb = vCol * vein;
  vec3 col = alb * RECIPROCAL_PI * (sunE() * (diff + trans) * sunVis + shIrradiance(N) * canopySky(vWP, terrainHeight(vWP.xz)));
  gl_FragColor = vec4(applyFog(col, vWP), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const MOTE_VS = /* glsl */ `
#include <common>
${commonGLSL()}
attribute float aSize;
attribute float aKind;
varying float vBright;
varying vec3 vWP;
varying float vKind;
void main() {
  vWP = position;
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // 실제 크기(갓털 약 1.5 cm, 먼지 2~3 mm) → 화소, 너무 작으면 1.5 화소로 두고 밝기를 줄임
  float px = aSize * projectionMatrix[1][1] * 0.5 * ${'${H}'} / -mv.z;
  gl_PointSize = clamp(px, 1.5, 24.0);
  // 눈앞 1 m 안을 지나는 것은 초점이 맞지 않아 거의 보이지 않는다 → 흐려지며 사라짐(화면을 가리는 큰 원판 방지)
  vBright = min(1.0, px / 1.5) * smoothstep(0.4, 1.2, -mv.z);
  vKind = aKind;
}
`;

const MOTE_FS = /* glsl */ `
#include <common>
${commonGLSL()}
varying float vBright;
varying vec3 vWP;
varying float vKind;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0) discard;
  vec3 V = normalize(cameraPosition - vWP);
  // 앞쪽 산란: 해를 마주 보는 쪽에서 크게 밝아진다(역광 속 먼지·갓털)
  float fwd = pow(max(dot(-V, uSunDir), 0.0), 6.0);
  float sunVis = canopySun(vWP, terrainHeight(vWP.xz)) * cloudShadow(vWP);
  vec3 alb = vKind > 0.5 ? vec3(0.8, 0.78, 0.72) : vec3(0.5, 0.45, 0.36);
  vec3 col = alb * RECIPROCAL_PI * (sunE() * (0.35 + 3.0 * fwd) * sunVis + shIrradiance(vec3(0.0, 1.0, 0.0)) * 0.6);
  float a = (1.0 - r) * vBright * (vKind > 0.5 ? 0.9 : 0.5);
  gl_FragColor = vec4(applyFog(col, vWP), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class AtmosphereFX {
  constructor(scene, world) {
    this.world = world;
    this.rng = new Random(9137);
    this.tmp = { x: 0, y: 0, z: 0 };
    // ---- 잎 ----
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('uv', base.attributes.uv);
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(LEAF_N * 4), 4);
    this.iB = new THREE.InstancedBufferAttribute(new Float32Array(LEAF_N * 4), 4);
    this.iC = new THREE.InstancedBufferAttribute(new Float32Array(LEAF_N * 3), 3);
    for (const a of [this.iA, this.iB]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.iA);
    g.setAttribute('iB', this.iB);
    g.setAttribute('iC', this.iC);
    g.instanceCount = LEAF_N;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const lm = new THREE.ShaderMaterial({ uniforms: { ...U }, vertexShader: LEAF_VS, fragmentShader: LEAF_FS, side: THREE.DoubleSide });
    lm.name = 'falling-leaves';
    this.leafMesh = new THREE.Mesh(g, lm);
    this.leafMesh.frustumCulled = false;
    scene.add(this.leafMesh);
    this.leaves = [];
    const cols = [
      [0.42, 0.34, 0.06],
      [0.36, 0.3, 0.08],
      [0.2, 0.13, 0.06],
      [0.14, 0.11, 0.06],
      [0.09, 0.13, 0.04],
    ];
    for (let i = 0; i < LEAF_N; i++) {
      const c = cols[Math.min(cols.length - 1, Math.floor(this.rng.next() * cols.length))].map((x) => x * this.rng.range(0.85, 1.15));
      this.iC.array.set(c, i * 3);
      this.leaves.push({ active: false, x: 0, y: -1e4, z: 0, vy: 0, size: this.rng.range(0.035, 0.07), spin: this.rng.range(1.5, 5), ax: [0, 1, 0], phase: this.rng.next() * 10, ang: 0 });
    }
    // ---- 갓털·먼지 ----
    const mg = new THREE.BufferGeometry();
    this.mPos = new THREE.BufferAttribute(new Float32Array(MOTE_N * 3), 3);
    this.mPos.setUsage(THREE.DynamicDrawUsage);
    const size = new Float32Array(MOTE_N);
    const kind = new Float32Array(MOTE_N);
    this.motes = [];
    for (let i = 0; i < MOTE_N; i++) {
      const fluff = this.rng.chance(0.4);
      size[i] = fluff ? this.rng.range(0.012, 0.02) : this.rng.range(0.002, 0.004);
      kind[i] = fluff ? 1 : 0;
      this.motes.push({ x: 0, y: -1e4, z: 0, fluff, rise: this.rng.range(-0.08, 0.12), phase: this.rng.next() * 10 });
    }
    mg.setAttribute('position', this.mPos);
    mg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    mg.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    mg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.moteUniform = { value: 1080 };
    const mm = new THREE.ShaderMaterial({
      uniforms: { ...U, uViewH: this.moteUniform },
      vertexShader: MOTE_VS.replace('${H}', 'uViewH').replace('attribute float aSize;', 'uniform float uViewH;\nattribute float aSize;'),
      fragmentShader: MOTE_FS,
      transparent: true,
      depthWrite: false,
    });
    mm.name = 'motes';
    this.moteMesh = new THREE.Points(mg, mm);
    this.moteMesh.frustumCulled = false;
    scene.add(this.moteMesh);
    this.q = new THREE.Quaternion();
    this.axis = new THREE.Vector3();
  }

  _spawnLeaf(L, cx, cz) {
    const w = this.world;
    for (let k = 0; k < 6; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * RANGE;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (w.belts.canopyAt(x, z) < 0.3) continue;
      const gy = w.terrain.heightAt(x, z);
      L.x = x;
      L.z = z;
      L.y = gy + this.rng.range(2.5, 14);
      L.vy = -this.rng.range(0.6, 1.2);
      const ax = [this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)];
      const l = Math.hypot(...ax) || 1;
      L.ax = ax.map((v) => v / l);
      L.active = true;
      return;
    }
    L.active = false;
    L.y = -1e4;
  }

  _spawnMote(M, cx, cz, cy) {
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(this.rng.next()) * 18;
    M.x = cx + Math.cos(a) * r;
    M.z = cz + Math.sin(a) * r;
    M.y = this.world.terrain.heightAt(M.x, M.z) + this.rng.range(0.3, 4.5) + Math.max(0, cy - 2) * 0.2;
  }

  update(dt, time, camera, viewH) {
    const w = this.world;
    const cp = camera.position;
    this.moteUniform.value = viewH;
    const t = this.tmp;
    // 잎: 1초에 몇 장씩 새로(모두 한꺼번에 생기지 않게)
    const A = this.iA.array;
    const B = this.iB.array;
    for (let i = 0; i < LEAF_N; i++) {
      const L = this.leaves[i];
      const far = (L.x - cp.x) ** 2 + (L.z - cp.z) ** 2 > (RANGE + 8) ** 2;
      if (!L.active || far) {
        if (this.rng.next() < dt * 0.6) this._spawnLeaf(L, cp.x, cp.z);
      } else {
        const gy = w.terrain.heightAt(L.x, L.z);
        if (L.y <= gy + 0.02) {
          // 땅에 닿으면 잠시 뒤 다시
          if (this.rng.next() < dt * 0.4) this._spawnLeaf(L, cp.x, cp.z);
        } else {
          w.wind.sample(L.x, L.y, L.z, time, t, gy);
          L.phase += dt * L.spin;
          const flut = Math.sin(L.phase * 1.7);
          L.x += (t.x * 0.8 + Math.cos(L.phase) * 0.35) * dt;
          L.z += (t.z * 0.8 + Math.sin(L.phase * 0.9) * 0.35) * dt;
          L.y += (L.vy + 0.45 * flut) * dt;
          L.ang += dt * L.spin * (1 + 0.5 * flut);
        }
      }
      this.axis.set(L.ax[0], L.ax[1], L.ax[2]);
      this.q.setFromAxisAngle(this.axis, L.ang);
      A[i * 4] = L.x;
      A[i * 4 + 1] = L.active ? L.y : -1e4;
      A[i * 4 + 2] = L.z;
      A[i * 4 + 3] = L.size;
      B[i * 4] = this.q.x;
      B[i * 4 + 1] = this.q.y;
      B[i * 4 + 2] = this.q.z;
      B[i * 4 + 3] = this.q.w;
    }
    this.iA.needsUpdate = true;
    this.iB.needsUpdate = true;
    // 갓털·먼지
    const P = this.mPos.array;
    for (let i = 0; i < MOTE_N; i++) {
      const M = this.motes[i];
      const d2 = (M.x - cp.x) ** 2 + (M.z - cp.z) ** 2;
      if (d2 > 22 * 22 || M.y < -1e3) this._spawnMote(M, cp.x, cp.z, cp.y);
      else {
        const gy = w.terrain.heightAt(M.x, M.z);
        w.wind.sample(M.x, M.y, M.z, time, t, gy);
        M.phase += dt;
        const k = M.fluff ? 0.95 : 1.0;
        M.x += (t.x * k + Math.sin(M.phase * 1.3) * 0.08) * dt;
        M.z += (t.z * k + Math.cos(M.phase * 1.1) * 0.08) * dt;
        M.y += (M.rise + Math.sin(M.phase * 0.7) * 0.06) * dt;
        if (M.y < gy + 0.05 || M.y > gy + 8) this._spawnMote(M, cp.x, cp.z, cp.y);
      }
      P[i * 3] = M.x;
      P[i * 3 + 1] = M.y;
      P[i * 3 + 2] = M.z;
    }
    this.mPos.needsUpdate = true;
  }
}
