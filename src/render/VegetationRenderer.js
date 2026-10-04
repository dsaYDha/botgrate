// 지면 식생(밀 그루터기·휴경지 잡초·둑 풀·숲 바닥 풀·도로 가운데 풀).
// 16 m 타일마다 인스턴스 위치를 GPU에서 (타일, 인스턴스 번호) 해시로 만든다 → CPU 버퍼 없음.
// 타일별 개수는 화면 크기(거리 ÷ 배율)로 정하고, 앞 번호부터 쓰므로 밀도가 바뀌어도 위치가 안 튄다.
// 바람: 차폐 격자 + 돌풍 패치(world/Wind.js와 같은 식) → 풀 물결로 바람을 읽을 수 있다.

import * as THREE from 'three';
import { U, commonGLSL, GLSL_OUTPUT } from './shaderLib.js';

const TILE = 16;

function bladeGeometry(blades, segs) {
  const pos = [];
  const aB = [];
  const aS = [];
  const idx = [];
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI * 2 + b * 0.7;
    const off = 0.25 + 0.75 * ((b * 0.618) % 1);
    const hr = 0.65 + 0.35 * ((b * 0.371 + 0.3) % 1);
    const wr = 0.7 + 0.3 * ((b * 0.53 + 0.1) % 1);
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      if (s === segs) {
        pos.push(0, 0, 0);
        aB.push(ang, off, hr, wr);
        aS.push(t, 0);
      } else {
        for (const side of [-1, 1]) {
          pos.push(0, 0, 0);
          aB.push(ang, off, hr, wr);
          aS.push(t, side);
        }
      }
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      if (s === segs - 1) {
        idx.push(a, a + 1, a + 2);
      } else {
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(aB, 4));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 2));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

const VERT = /* glsl */ `
uniform vec4 uTile;     // x0, z0, 타일 키, 인스턴스 수
uniform vec4 uTileLod;  // 덩이 크기 배수, 밀도(0~1), 0, 0
uniform sampler2D uSurfA;
uniform sampler2D uSurfB;
attribute vec4 aB;
attribute vec2 aS;
varying vec3 vWP;
varying vec3 vCol;
varying float vT;
varying vec3 vNrm;
varying float vGY;
varying float vSunVis;
varying float vSkyVis;

vec4 surf(sampler2D t, vec2 p) {
  float N = uTerrainInfo.z;
  vec2 uv = ((p + uTerrainInfo.x) / uTerrainInfo.y + 0.5) / N;
  return textureLod(t, uv, 0.0);
}

void main() {
  int id = gl_InstanceID;
  int key = int(uTile.z);
  vec2 p = uTile.xy + vec2(hash2i(ivec2(id, key)), hash2i(ivec2(id + 7919, key ^ 0x5bd1))) * ${TILE.toFixed(1)};
  float r0 = hash2i(ivec2(id * 3 + 1, key + 17));
  float r1 = hash2i(ivec2(id * 5 + 2, key + 29));
  float r2 = hash2i(ivec2(id * 7 + 3, key + 41));

  bool inMap = abs(p.x) < uTerrainInfo.x - 2.0 && abs(p.y) < uTerrainInfo.x - 2.0;
  vec4 sa = inMap ? surf(uSurfA, p) : vec4(0.6, 0.2, 0.2, 0.0);
  vec4 sb = inMap ? surf(uSurfB, p) : vec4(0.0);
  vec2 hd0 = terrainHD(p);
  float rd = inMap ? hd0.y : 1000.0;
  float ard = abs(rd);
  float roadMask = smoothstep(1.45, 1.85, ard);
  float centerStrip = 1.0 - smoothstep(0.28, 0.42, ard);

  // 종류: 0 그루터기, 1 흙밭 잡초, 2 휴경지, 3 숲 바닥, 4 둑 풀, 5 도로 가운데 풀
  float w0 = sa.r * 1.0 * roadMask;
  float w1 = sa.g * 0.03 * roadMask;
  float w2 = sa.b * 0.9 * roadMask;
  float w3 = sa.a * 0.16 * roadMask;
  float w4 = sb.r * 1.0 * roadMask;
  float w5 = (1.0 - roadMask) * centerStrip * 0.9;
  float kind = -1.0;
  float acc = w0;
  if (r0 < acc) kind = 0.0;
  else if (r0 < (acc += w1)) kind = 1.0;
  else if (r0 < (acc += w2)) kind = 2.0;
  else if (r0 < (acc += w3)) kind = 3.0;
  else if (r0 < (acc += w4)) kind = 4.0;
  else if (r0 < (acc += w5)) kind = 5.0;

  float fade = 1.0 - smoothstep(uTile.w * 0.7, uTile.w, float(id));
  if (kind < 0.0 || fade <= 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }

  // 그루터기는 수확 줄에 맞춰 정렬
  if (kind < 0.5) {
    float dir = sb.g * 3.14159265;
    vec2 rowN = vec2(-sin(dir), cos(dir));
    float q = dot(p, rowN);
    float qs = (floor(q / 0.18) + 0.5) * 0.18;
    p += rowN * (qs - q);
  }

  float n1 = vnoise(p * 0.21 + 3.0);
  float n2 = vnoise(p * 1.3);
  float height, width, stiff, spread;
  vec3 colB, colT;
  if (kind < 0.5) {
    height = mix(0.13, 0.24, r1); width = 0.0045; stiff = 0.25; spread = 0.05;
    colB = vec3(0.42, 0.35, 0.22); colT = vec3(0.68, 0.58, 0.36);
  } else if (kind < 1.5) {
    height = mix(0.08, 0.28, r1); width = 0.012; stiff = 0.6; spread = 0.1;
    colB = vec3(0.16, 0.2, 0.08); colT = vec3(0.32, 0.34, 0.15);
  } else if (kind < 2.5) {
    height = mix(0.3, 1.05, pow(r1, 0.8)) * mix(0.7, 1.2, n1); width = mix(0.012, 0.034, r2 * r2); stiff = 1.0; spread = 0.22;
    vec3 green = vec3(0.17, 0.21, 0.08), straw = vec3(0.55, 0.47, 0.27), brown = vec3(0.3, 0.22, 0.13);
    colB = mix(green, brown, 0.3) * 0.7;
    colT = r2 < 0.45 ? mix(green, straw, n2 * 0.7) : (r2 < 0.85 ? straw : brown);
  } else if (kind < 3.5) {
    height = mix(0.15, 0.5, r1); width = 0.01; stiff = 0.8; spread = 0.12;
    colB = vec3(0.07, 0.09, 0.04); colT = vec3(0.16, 0.21, 0.08);
  } else if (kind < 4.5) {
    height = mix(0.22, 0.65, r1) * mix(0.8, 1.15, n1); width = 0.014; stiff = 1.0; spread = 0.18;
    colB = vec3(0.1, 0.14, 0.05); colT = mix(vec3(0.22, 0.28, 0.1), vec3(0.5, 0.45, 0.25), n2 * 0.55);
  } else {
    height = mix(0.1, 0.24, r1); width = 0.008; stiff = 0.7; spread = 0.08;
    colB = vec3(0.12, 0.15, 0.06); colT = vec3(0.3, 0.33, 0.15);
  }
  float lod = uTileLod.x;
  float t = aS.x;
  float bh = height * aB.z * mix(0.6, 1.0, fade);
  float bw = width * aB.w * lod;
  float ang = aB.x + r2 * 6.2831;
  vec2 bdir = vec2(cos(ang), sin(ang));
  vec2 basep = p + bdir * aB.y * spread * min(lod, 2.0);

  float gy = hd0.x + rutProfile(hd0.y);
  // 바람에 따른 휨(풀 높이 근처 바람, 강성 반영). 비용을 줄인 windAt: 차폐·난류 한 번, 돌풍 패치.
  vec2 shuv = (basep + uShelterInfo.x) / (uShelterInfo.y * (uShelterInfo.z - 1.0));
  shuv = shuv * (uShelterInfo.z - 1.0) / uShelterInfo.z + 0.5 / uShelterInfo.z;
  vec2 sht = textureLod(uShelterTex, shuv, 0.0).rg * vec2(1.2, 2.0);
  float ws = uWind.z * windProfile(max(bh * 0.7, 0.15)) * sht.x * windGust(basep, uWind.w, sht.y);
  vec2 wdir = uWind.xy;
  float flutter = sin(uTime * (3.0 + r1 * 2.5) + r2 * 30.0 + dot(basep, wdir) * 1.7) * 0.35;
  float bend = clamp(ws * ws * 0.012 * stiff, 0.0, 1.25) * (1.0 + flutter * 0.4) + 0.12 + 0.05 * flutter;
  float lean = bend * t * t;
  vec2 dirXZ = normalize(wdir * bend + bdir * 0.25);
  float side = aS.y;
  vec2 across = vec2(-dirXZ.y, dirXZ.x);
  vec3 wp;
  wp.xz = basep + dirXZ * bh * lean + across * side * bw * (1.0 - t * 0.85);
  wp.y = gy + bh * t * (1.0 - 0.35 * lean * lean) - 0.02;
  vWP = wp;
  vGY = gy;
  vT = t;
  vCol = mix(colB, colT, smoothstep(0.0, 0.85, t)) * (0.82 + 0.36 * r1);
  vNrm = normalize(vec3(dirXZ.x * 0.3 + across.x * side * 0.4, 1.0, dirXZ.y * 0.3 + across.y * side * 0.4));
  // 수관 그늘(풀용 간단판): 태양 쪽 7 m 위 수관 밀도 + 작은 햇빛 반점
  vec2 sp = basep + uSunDir.xz / max(uSunDir.y, 0.15) * 7.0;
  vec2 cd = canopySample(sp, 0.0);
  float fl = vnoise(sp * 2.6) * 0.6 + vnoise(sp * 7.9) * 0.4;
  vSunVis = (1.0 - smoothstep(fl - 0.1, fl + 0.1, cd.r * 1.45 - 0.08) * 0.95 * uCanopyStrength)
          * (1.0 - smoothstep(0.3, 0.8, canopySample(basep + uSunDir.xz / max(uSunDir.y, 0.15) * 1.2, 0.0).g) * 0.8 * uCanopyStrength);
  vSkyVis = 1.0 - canopySample(basep, 2.5).r * 0.7 * uCanopyStrength;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec3 vWP;
varying vec3 vCol;
varying float vT;
varying vec3 vNrm;
varying float vGY;
varying float vSunVis;
varying float vSkyVis;
void main() {
  vec3 N = normalize(vNrm);
  float ndl = max(dot(N, uSunDir), 0.0) * 0.7 + 0.3;
  vec3 V = normalize(vWP - cameraPosition);
  float trans = pow(max(dot(V, uSunDir), 0.0), 3.0) * 0.5 * vT;
  float ao = mix(0.35, 1.0, smoothstep(0.0, 0.7, vT));
  vec3 sun = uSunColor * uSunIntensity * (ndl + trans) * vSunVis * ao;
  vec3 hemi = mix(uHemiGround, uHemiSky, 0.75) * uHemiIntensity * ao * vSkyVis;
  vec3 col = vCol * (sun + hemi) * 0.3183;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

export class VegetationRenderer {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.geoNear = bladeGeometry(6, 3);
    this.geoFar = bladeGeometry(4, 1);
    this.pool = { near: [], far: [] };
    this.used = { near: 0, far: 0 };
    this.frustum = new THREE.Frustum();
    this.box = new THREE.Box3();
    this.tmpM = new THREE.Matrix4();
    this.baseMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uTile: { value: new THREE.Vector4() }, uTileLod: { value: new THREE.Vector4(1, 1, 0, 0) } },
      vertexShader: `${commonGLSL()}\n${VERT}`,
      fragmentShader: `${commonGLSL()}\n${FRAG}`,
      side: THREE.DoubleSide,
    });
    this.maxPerTile = Math.round(TILE * TILE * 11 * quality.grassDensity);
    this.totalInstances = 0;
  }

  _get(kind) {
    const pool = this.pool[kind];
    const i = this.used[kind]++;
    if (i < pool.length) return pool[i];
    const src = kind === 'near' ? this.geoNear : this.geoFar;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index;
    for (const k in src.attributes) geo.setAttribute(k, src.attributes[k]);
    geo.boundingSphere = src.boundingSphere;
    const mat = this.baseMat.clone();
    for (const k in U) mat.uniforms[k] = U[k];
    mat.uniforms.uTile = { value: new THREE.Vector4() };
    mat.uniforms.uTileLod = { value: new THREE.Vector4(1, 1, 0, 0) };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    pool.push(mesh);
    return mesh;
  }

  update(camera, zoom) {
    this.used.near = 0;
    this.used.far = 0;
    this.frustum.setFromProjectionMatrix(this.tmpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cp = camera.position;
    const z = Math.max(1, zoom);
    const range = this.quality.grassRange * Math.min(4, Math.pow(z, 0.85));
    const i0 = Math.floor((cp.x - range) / TILE);
    const i1 = Math.floor((cp.x + range) / TILE);
    const j0 = Math.floor((cp.z - range) / TILE);
    const j1 = Math.floor((cp.z + range) / TILE);
    let total = 0;
    const budget = 260000 * this.quality.grassDensity;
    const tiles = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x0 = i * TILE;
        const z0 = j * TILE;
        const nx = Math.max(x0, Math.min(cp.x, x0 + TILE));
        const nz = Math.max(z0, Math.min(cp.z, z0 + TILE));
        const d = Math.hypot(nx - cp.x, nz - cp.z, Math.max(0, cp.y - 1.0) * 0.5);
        if (d > range) continue;
        this.box.min.set(x0, cp.y - 30, z0);
        this.box.max.set(x0 + TILE, cp.y + 30, z0 + TILE);
        if (!this.frustum.intersectsBox(this.box)) continue;
        tiles.push([i, j, d]);
      }
    }
    tiles.sort((a, b) => a[2] - b[2]);
    for (const [i, j, d] of tiles) {
      const de = d / z;
      const dens = de < 9 ? 1 : Math.max(0.012, Math.pow(9 / de, 1.7));
      let n = Math.round(this.maxPerTile * dens);
      if (n < 8) continue;
      if (total + n > budget) n = Math.max(0, budget - total);
      if (n < 8) break;
      total += n;
      const lod = Math.min(3.2, Math.sqrt(1 / dens));
      const mesh = this._get(de < 22 ? 'near' : 'far');
      const u = mesh.material.uniforms;
      u.uTile.value.set(i * TILE, j * TILE, ((i * 73856093) ^ (j * 19349663)) & 0xffffff, n);
      u.uTileLod.value.set(lod, dens, 0, 0);
      mesh.geometry.instanceCount = n;
      mesh.visible = true;
    }
    for (const kind of ['near', 'far']) {
      const pool = this.pool[kind];
      for (let k = this.used[kind]; k < pool.length; k++) pool[k].visible = false;
    }
    this.totalInstances = total;
  }
}
