// 방풍림 렌더링: 수관(잎 카드 템플릿)·줄기·가지·관목을 인스턴싱하고, 매 프레임 나무별로
// 화면 크기 기준 LOD(거리 ÷ 배율)와 시야 절두체 컬링을 해 인스턴스 버퍼를 채운다.
// 잎 그늘은 그림자 맵 대신 수관 지도(shaderLib canopySun)로 처리 → 먼 숲도 어둡고 얼룩지게.

import * as THREE from 'three';
import { U, patchMaterial, commonGLSL, GLSL_OUTPUT } from './shaderLib.js';
import { makeLeafAtlas, atlasTile } from './textures.js';
import { Random } from '../core/Random.js';
import { TREE_SPECIES, SNAG, SHRUBS } from '../data/trees.js';

const SPECIES = ['poplar', 'elm', 'locust'];
const VARIANTS = 3;
// 템플릿 기준 수관 크기(m): 반지름, 반높이
const REF = {
  poplar: { R: 1.9, HH: 5.5, shape: 'columnar' },
  elm: { R: 3.0, HH: 3.3, shape: 'round' },
  locust: { R: 2.9, HH: 3.0, shape: 'irregular' },
  shrub: { R: 1.2, HH: 1.0, shape: 'shrub' },
};
// LOD 경계(유효 거리 = 실제 거리 ÷ 배율 ÷ 품질 배수)
const LEAF_LOD = [36, 150];
const TRUNK_LOD = [32, 130];
const SHRUB_LOD = [28, 110];
const BRANCH_DIST = 42;

// ---------------------------------------------------------------------------
// 템플릿 기하
// ---------------------------------------------------------------------------
function randUnit(rng) {
  const z = rng.range(-1, 1);
  const t = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return new THREE.Vector3(r * Math.cos(t), z, r * Math.sin(t));
}

function crownTemplate(kind, cards, cardSize, sizeMul, tile, rng) {
  const ref = REF[kind];
  const pos = [];
  const nor = [];
  const uv = [];
  const card = [];
  const idx = [];
  const lobes = [];
  if (ref.shape === 'irregular') {
    const n = 3 + Math.floor(rng.next() * 2);
    for (let i = 0; i < n; i++) lobes.push(randUnit(rng).multiplyScalar(0.45).setY(rng.range(-0.3, 0.5)));
  }
  const [tu, tv] = atlasTile(tile);
  for (let c = 0; c < cards; c++) {
    const dir = randUnit(rng);
    let r = Math.pow(rng.next(), 0.42);
    let p = dir.clone().multiplyScalar(r);
    if (ref.shape === 'columnar') {
      p.x *= 1 - 0.35 * Math.max(p.y, 0);
      p.z *= 1 - 0.35 * Math.max(p.y, 0);
    } else if (ref.shape === 'round') {
      p.y *= 0.92;
    } else if (ref.shape === 'irregular') {
      const L = lobes[c % lobes.length];
      p = L.clone().add(dir.multiplyScalar(Math.pow(rng.next(), 0.5) * 0.62));
    } else if (ref.shape === 'shrub') {
      if (p.y < -0.35) p.y = -0.35 + (p.y + 0.35) * 0.3;
    }
    const radial = p.clone();
    const local = new THREE.Vector3(p.x * ref.R, p.y * ref.HH, p.z * ref.R);
    const n = radial.clone().normalize().multiplyScalar(0.75).add(randUnit(rng).multiplyScalar(0.6)).normalize();
    const t1 = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
    const rot = rng.range(0, Math.PI * 2);
    const a1 = t1.clone().multiplyScalar(Math.cos(rot)).add(t2.clone().multiplyScalar(Math.sin(rot)));
    const a2 = new THREE.Vector3().crossVectors(n, a1);
    const s = rng.range(cardSize[0], cardSize[1]) * sizeMul * 0.5;
    const base = pos.length / 3;
    const corners = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
    const rnd = rng.next();
    for (const [cx, cy, u, v] of corners) {
      const q = local.clone().addScaledVector(a1, cx * s).addScaledVector(a2, cy * s);
      pos.push(q.x, q.y, q.z);
      nor.push(n.x, n.y, n.z);
      uv.push(tu + u * 0.5, tv + v * 0.5);
      card.push(radial.x, radial.y, radial.z, rnd);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aCard', new THREE.Float32BufferAttribute(card, 4));
  g.setIndex(idx);
  return g;
}

function trunkGeometry(radial, rings) {
  const g = new THREE.CylinderGeometry(1, 1, 1, radial, rings, true);
  g.translate(0, 0.5, 0);
  return g;
}

// 가지 묶음(기준 나무 높이 14 m, 줄기 축 기준 m 단위)
function branchTemplate(rng, dead) {
  const geos = [];
  const n = dead ? 7 : 6;
  for (let i = 0; i < n; i++) {
    const y = dead ? rng.range(3, 9) : rng.range(4.5, 11);
    const len = dead ? rng.range(0.8, 2.6) : rng.range(1.6, 3.2);
    const r = dead ? rng.range(0.02, 0.05) : rng.range(0.018, 0.045);
    const c = new THREE.CylinderGeometry(r * 0.35, r, len, 5, 1, false);
    c.translate(0, len / 2, 0);
    const tilt = dead ? rng.range(0.6, 1.1) : rng.range(0.45, 0.85);
    const az = rng.range(0, Math.PI * 2);
    c.rotateZ(-tilt);
    c.rotateY(az);
    c.translate(0, y, 0);
    geos.push(c);
  }
  return mergeGeos(geos);
}

function mergeGeos(geos) {
  let nv = 0;
  let ni = 0;
  for (const g of geos) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    const gi = g.index ? g.index.array : [...Array(g.attributes.position.count).keys()];
    for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// ---------------------------------------------------------------------------
// 매 프레임 인스턴스 버퍼 채우기
// ---------------------------------------------------------------------------
class DynamicInstances {
  /**
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {number} capacity
   * @param {object} attrs {name: itemSize}
   */
  constructor(geometry, material, capacity, attrs) {
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.attrs = {};
    for (const name in attrs) {
      const size = attrs[name];
      const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      this.attrs[name] = a;
    }
    this.count = 0;
  }
  push(srcMatrix, srcAttrs, i) {
    const k = this.count++;
    this.mesh.instanceMatrix.array.set(srcMatrix.subarray(i * 16, i * 16 + 16), k * 16);
    for (const name in this.attrs) {
      const a = this.attrs[name];
      const s = a.itemSize;
      a.array.set(srcAttrs[name].subarray(i * s, i * s + s), k * s);
    }
  }
  finish() {
    const m = this.mesh;
    m.count = this.count;
    m.visible = this.count > 0;
    if (this.count > 0) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, this.count * 16);
      m.instanceMatrix.needsUpdate = true;
      for (const name in this.attrs) {
        const a = this.attrs[name];
        a.clearUpdateRanges();
        a.addUpdateRange(0, this.count * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// 셰이더
// ---------------------------------------------------------------------------
const SWAY_GLSL = /* glsl */ `
// 나무 전체 흔들림: 수관 높이 바람의 제곱에 비례, 고유 진동 + 돌풍
vec2 treeSway(vec3 base, float H, float phase, float y) {
  vec2 w = windAt(base.xz, H * 0.8, 10.0) * 0.8;
  float ws = length(w);
  vec2 dir = ws > 0.01 ? w / ws : vec2(1.0, 0.0);
  float osc = sin(uTime * (1.3 + 0.35 * phase) + phase * 6.2831) * 0.55 + sin(uTime * 2.7 + phase * 11.0) * 0.18;
  float amp = ws * ws * 0.0042 * (H / 14.0) * (0.8 + 0.45 * osc);
  float h = clamp((y - base.y) / H, 0.0, 1.3);
  vec2 perp = vec2(-dir.y, dir.x) * sin(uTime * 0.9 + phase * 4.0) * 0.18;
  return (dir + perp) * amp * h * h;
}
`;

function leafMaterial(atlas, yellow, flutterScale) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      uAtlas: { value: atlas },
      uYellow: { value: new THREE.Color(...yellow) },
      uRed: { value: new THREE.Color(...SHRUBS.red) },
    },
    vertexShader: /* glsl */ `
      ${commonGLSL()}
      ${SWAY_GLSL}
      attribute vec4 aCard;
      attribute vec4 aTreeA; // 줄기 밑동 xyz, 나무 높이
      attribute vec4 aTreeB; // lean x, lean z, phase, flutter
      attribute vec3 aTint;
      attribute vec4 aTreeC; // 노란 잎 비율, 수관 꼭대기 y, 수관 아래 y, 붉은 잎 비율
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vCrownN;
      varying vec3 vWP;
      varying vec3 vTint;
      varying vec2 vColorF;
      varying float vAO;
      varying float vSunVis;
      varying float vSkyVis;
      void main() {
        vec4 wp = instanceMatrix * vec4(position, 1.0);
        wp.xz += treeSway(aTreeA.xyz, aTreeA.w, aTreeB.z, wp.y);
        // 잎 떨림
        vec2 w = windAt(aTreeA.xz, aTreeA.w * 0.7, 10.0);
        float ws = length(w);
        float fl = aTreeB.w * ${flutterScale.toFixed(3)} * (0.004 + ws * 0.0085) * sin(uTime * (7.0 + aCard.w * 5.0) + aCard.w * 40.0);
        vec3 nW = normalize(mat3(instanceMatrix) * normal);
        wp.xyz += nW * fl;
        vWP = wp.xyz;
        vN = nW;
        vCrownN = normalize(mat3(instanceMatrix) * aCard.xyz + vec3(0.0, 0.25, 0.0));
        vUv = uv;
        vTint = aTint;
        vColorF = aTreeC.xw;
        // 수관 안쪽/아래쪽은 어둡다
        float outer = smoothstep(0.15, 1.0, length(aCard.xyz));
        vAO = mix(0.3, 1.0, outer) * mix(0.72, 1.0, aCard.y * 0.5 + 0.5);
        // 태양 반대편 잎은 자기 수관 그늘
        float selfSun = smoothstep(-0.7, 0.5, dot(normalize(aCard.xyz + 1e-4), normalize(inverse(mat3(instanceMatrix)) * uSunDir)));
        // 이웃 수관 그늘: 태양 쪽으로 수관 꼭대기까지 올라간 지점의 밀도
        float dy = max(aTreeC.y - wp.y, 0.0);
        vec2 sp = wp.xz + uSunDir.xz / max(uSunDir.y, 0.15) * dy;
        float dens = canopySample(sp, 1.0).r;
        float nb = 1.0 - dens * 0.9 * smoothstep(0.0, 6.0, dy) * uCanopyStrength;
        vSunVis = mix(0.18, 1.0, selfSun * outer) * nb;
        vSkyVis = 1.0 - canopySample(wp.xz, 2.5).r * 0.45 * smoothstep(aTreeC.y, aTreeC.z, wp.y) * uCanopyStrength;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${commonGLSL()}
      uniform sampler2D uAtlas;
      uniform vec3 uYellow;
      uniform vec3 uRed;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vCrownN;
      varying vec3 vWP;
      varying vec3 vTint;
      varying vec2 vColorF;
      varying float vAO;
      varying float vSunVis;
      varying float vSkyVis;
      void main() {
        vec4 t = texture(uAtlas, vUv);
        vec2 sz = vec2(textureSize(uAtlas, 0));
        vec2 dx = dFdx(vUv * sz), dy = dFdy(vUv * sz);
        float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
        float a = t.a * (1.0 + mip * 0.28);
        if (a < 0.42) discard;
        vec3 leaf = vTint;
        if (t.b < vColorF.x) leaf = mix(leaf, uYellow * (0.85 + 0.3 * t.b / max(vColorF.x, 0.01)), 0.88);
        else if (t.b > 1.0 - vColorF.y) leaf = mix(leaf, uRed, 0.8);
        leaf *= 0.55 + 0.6 * t.r;
        vec3 albedo = mix(leaf, vec3(0.22, 0.18, 0.13), t.g * 0.9);
        vec3 N = normalize(mix(gl_FrontFacing ? vN : -vN, vCrownN, 0.65));
        float ndl = dot(N, uSunDir);
        float diff = max(ndl * 0.6 + 0.4, 0.0);
        vec3 V = normalize(vWP - cameraPosition);
        float trans = pow(max(dot(V, uSunDir), 0.0), 4.0) * 0.6;
        vec3 sun = uSunColor * uSunIntensity * (diff + trans) * vSunVis * vAO;
        vec3 hemi = mix(uHemiGround, uHemiSky, N.y * 0.5 + 0.5) * uHemiIntensity * (0.35 + 0.65 * vAO) * vSkyVis;
        vec3 col = albedo * (sun + hemi) * 0.3183;
        gl_FragColor = vec4(col, 1.0);
        ${GLSL_OUTPUT}
      }`,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
  });
}

function trunkMaterial(depth = false) {
  const mat = depth ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }) : new THREE.MeshLambertMaterial({ color: 0xffffff });
  patchMaterial(mat, {
    key: depth ? 'trunkDepth' : 'trunk',
    header: SWAY_GLSL,
    vertexHeader: /* glsl */ `
      attribute vec4 aTrunk;  // taper, leanX, leanZ, phase
      attribute vec4 aTrunkB; // 나무 높이, 밑동 y, 껍질 시드, 고사목
      varying vec3 vBark;
    `,
    vertex: /* glsl */ `
      float yN = position.y;
      float flare = 1.0 + 0.4 * pow(max(0.0, 1.0 - yN * 16.0), 2.0);
      vec3 transformed = vec3(position.x * mix(1.0, aTrunk.x, yN) * flare, position.y, position.z * mix(1.0, aTrunk.x, yN) * flare);
      vBark = vec3(atan(position.z, position.x), yN, aTrunkB.z);
    `,
    project: /* glsl */ `
      vec4 wpos = instanceMatrix * vec4(transformed, 1.0);
      float hb = wpos.y - aTrunkB.y;
      wpos.xz += aTrunk.yz * hb;
      wpos.xz += treeSway(vec3(instanceMatrix[3].x, aTrunkB.y, instanceMatrix[3].z), aTrunkB.x, aTrunk.w, wpos.y);
      vWP = wpos.xyz;
      vec4 mvPosition = viewMatrix * wpos;
      gl_Position = projectionMatrix * mvPosition;
      vBark.y *= instanceMatrix[1].y;
    `,
    fragmentHeader: 'varying vec3 vBark;',
    fragmentColor: depth
      ? ''
      : /* glsl */ `
      // 세로 골 무늬 껍질
      float circ = vBark.x * 0.6;
      float f1 = vnoise(vec2(circ * 4.0 + vBark.z * 50.0, vBark.y * 0.9));
      float f2 = vnoise(vec2(circ * 11.0, vBark.y * 3.0 + vBark.z * 20.0));
      float furrow = smoothstep(0.35, 0.75, f1 * 0.7 + f2 * 0.3);
      diffuseColor.rgb *= mix(0.55, 1.15, furrow);
      diffuseColor.rgb *= 0.8 + 0.25 * smoothstep(0.0, 0.4, vBark.y);
    `,
  });
  return mat;
}

// ---------------------------------------------------------------------------
export class TreeRenderer {
  constructor(scene, world, quality) {
    this.scene = scene;
    this.world = world;
    this.quality = quality;
    this.atlas = makeLeafAtlas(1024);
    const rng = new Random(4242);
    const belts = world.belts;
    this.frustum = new THREE.Frustum();
    this.sphere = new THREE.Sphere();
    this.tmpM = new THREE.Matrix4();

    // ---- 나무 정적 데이터 ----
    const trees = belts.trees;
    const nT = trees.length;
    this.trees = trees;
    this.crownMat = new Float32Array(nT * 16);
    this.trunkMat = new Float32Array(nT * 16);
    const crownAttrs = {
      aTreeA: new Float32Array(nT * 4),
      aTreeB: new Float32Array(nT * 4),
      aTint: new Float32Array(nT * 3),
      aTreeC: new Float32Array(nT * 4),
    };
    const trunkAttrs = { aTrunk: new Float32Array(nT * 4), aTrunkB: new Float32Array(nT * 4), instanceColor: new Float32Array(nT * 3) };
    this.crownAttrs = crownAttrs;
    this.trunkAttrs = trunkAttrs;
    this.treeSphere = new Float32Array(nT * 4);
    this.treeVariant = new Uint8Array(nT);
    this.treeSpecies = new Uint8Array(nT);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < nT; i++) {
      const t = trees[i];
      const sp = TREE_SPECIES[t.species];
      const si = SPECIES.indexOf(t.species);
      this.treeSpecies[i] = si;
      this.treeVariant[i] = Math.floor(t.seed * 997) % VARIANTS;
      const phase = (t.seed * 13.7) % 1;
      // 줄기
      const len = t.top - t.y0;
      m.compose(new THREE.Vector3(t.x, t.y0, t.z), q.identity(), new THREE.Vector3(t.r0, len, t.r0));
      m.toArray(this.trunkMat, i * 16);
      trunkAttrs.aTrunk.set([t.r1 / t.r0, t.lx, t.lz, phase], i * 4);
      trunkAttrs.aTrunkB.set([t.height, t.y0, t.seed, t.dead ? 1 : 0], i * 4);
      const bark = t.dead ? SNAG.bark : sp.bark;
      const bv = 0.85 + 0.3 * ((t.seed * 7.3) % 1);
      trunkAttrs.instanceColor.set([bark[0] * bv, bark[1] * bv, bark[2] * bv], i * 3);
      // 수관
      if (t.crown) {
        const c = t.crown;
        const ref = REF[t.species];
        q.setFromAxisAngle(up, t.seed * Math.PI * 2);
        m.compose(new THREE.Vector3(c.cx, c.cy, c.cz), q, new THREE.Vector3(c.rx / ref.R, c.ry / ref.HH, c.rz / ref.R));
        m.toArray(this.crownMat, i * 16);
        crownAttrs.aTreeA.set([t.x, t.y0, t.z, t.height], i * 4);
        crownAttrs.aTreeB.set([t.lx, t.lz, phase, sp.flutter], i * 4);
        const v = 1 + (rng.next() - 0.5) * 2 * sp.leafVar;
        const g = 1 + (rng.next() - 0.5) * sp.leafVar;
        crownAttrs.aTint.set([sp.leaf[0] * v, sp.leaf[1] * v * g, sp.leaf[2] * v], i * 3);
        const yf = sp.yellowFraction * (rng.chance(0.15) ? rng.range(2, 3.5) : rng.range(0.3, 1.3));
        crownAttrs.aTreeC.set([Math.min(0.95, yf), c.cy + c.ry, c.cy - c.ry, 0], i * 4);
        this.treeSphere.set([c.cx, (t.y0 + c.cy + c.ry) / 2, c.cz, Math.max(c.rx, (c.cy + c.ry - t.y0) / 2) + 0.5], i * 4);
      } else {
        this.treeSphere.set([t.x, (t.y0 + t.top) / 2, t.z, (t.top - t.y0) / 2 + 1], i * 4);
      }
    }

    // ---- 메시: 수관 (수종 × 변형 × LOD) ----
    this.crownMeshes = [];
    const cardLod = [
      { mul: 1, frac: 1 },
      { mul: 1.85, frac: 0.25 },
      { mul: 2.9, frac: 0.1 },
    ];
    for (let s = 0; s < SPECIES.length; s++) {
      const key = SPECIES[s];
      const sp = TREE_SPECIES[key];
      const mat = leafMaterial(this.atlas, sp.yellow, sp.flutter);
      const count = trees.filter((t, i) => this.treeSpecies[i] === s && t.crown).length;
      const perVariant = [];
      for (let v = 0; v < VARIANTS; v++) {
        const lods = [];
        for (let L = 0; L < 3; L++) {
          const n = Math.max(4, Math.round(sp.leafCards * cardLod[L].frac));
          const geo = crownTemplate(key, n, sp.cardSize, cardLod[L].mul, sp.leafTexture, new Random(1000 + s * 100 + v * 10));
          const di = new DynamicInstances(geo, mat, count, { aTreeA: 4, aTreeB: 4, aTint: 3, aTreeC: 4 });
          di.mesh.castShadow = false;
          di.mesh.receiveShadow = false;
          scene.add(di.mesh);
          lods.push(di);
        }
        perVariant.push(lods);
      }
      this.crownMeshes.push(perVariant);
    }

    // ---- 줄기 LOD ----
    const tMat = trunkMaterial(false);
    const tDepth = trunkMaterial(true);
    this.trunkMeshes = [
      [10, 8],
      [7, 3],
      [5, 1],
    ].map(([r, h]) => {
      const di = new DynamicInstances(trunkGeometry(r, h), tMat, nT, { aTrunk: 4, aTrunkB: 4 });
      di.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nT * 3), 3);
      di.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      di.attrs.instanceColor = di.mesh.instanceColor;
      di.mesh.castShadow = false;
      di.mesh.receiveShadow = true;
      scene.add(di.mesh);
      return di;
    });
    // 그림자 전용 줄기(시야 밖 나무 그림자도 들어오도록, 레이어 1에서만 그림)
    this.shadowTrunks = new DynamicInstances(trunkGeometry(6, 3), tMat, nT, { aTrunk: 4, aTrunkB: 4 });
    this.shadowTrunks.mesh.castShadow = true;
    this.shadowTrunks.mesh.customDepthMaterial = tDepth;
    this.shadowTrunks.mesh.layers.set(1);
    scene.add(this.shadowTrunks.mesh);

    // ---- 가지(가까운 나무만) ----
    const bLive = branchTemplate(new Random(31), false);
    const bDead = branchTemplate(new Random(57), true);
    const bMat = new THREE.MeshLambertMaterial({ color: 0x4a443c });
    patchMaterial(bMat, {
      key: 'branch',
      header: SWAY_GLSL,
      vertexHeader: 'attribute vec4 aBr; // 밑동 y, 나무 높이, phase, 0\nattribute vec2 aBrL; // 기울기',
      project: /* glsl */ `
        vec4 wpos = instanceMatrix * vec4(transformed, 1.0);
        wpos.xz += aBrL * (wpos.y - aBr.x);
        wpos.xz += treeSway(vec3(instanceMatrix[3].x, aBr.x, instanceMatrix[3].z), aBr.y, aBr.z, wpos.y);
        vWP = wpos.xyz;
        vec4 mvPosition = viewMatrix * wpos;
        gl_Position = projectionMatrix * mvPosition;
      `,
    });
    this.branchMat = new Float32Array(nT * 16);
    this.branchAttrs = { aBr: new Float32Array(nT * 4), aBrL: new Float32Array(nT * 2) };
    for (let i = 0; i < nT; i++) {
      const t = trees[i];
      const sc = t.height / 14;
      q.setFromAxisAngle(up, t.seed * 17.0);
      m.compose(new THREE.Vector3(t.x, t.y0, t.z), q, new THREE.Vector3(sc, sc, sc));
      m.toArray(this.branchMat, i * 16);
      this.branchAttrs.aBr.set([t.y0, t.height, (t.seed * 13.7) % 1, 0], i * 4);
      this.branchAttrs.aBrL.set([t.lx, t.lz], i * 2);
    }
    this.branchLive = new DynamicInstances(bLive, bMat, nT, { aBr: 4, aBrL: 2 });
    this.branchDead = new DynamicInstances(bDead, bMat, nT, { aBr: 4, aBrL: 2 });
    for (const b of [this.branchLive, this.branchDead]) {
      b.mesh.castShadow = false;
      b.mesh.receiveShadow = true;
      scene.add(b.mesh);
    }

    // ---- 관목 ----
    const shrubs = belts.shrubs;
    const nS = shrubs.length;
    this.shrubs = shrubs;
    this.shrubMat = new Float32Array(nS * 16);
    this.shrubAttrs = {
      aTreeA: new Float32Array(nS * 4),
      aTreeB: new Float32Array(nS * 4),
      aTint: new Float32Array(nS * 3),
      aTreeC: new Float32Array(nS * 4),
    };
    this.shrubSphere = new Float32Array(nS * 4);
    this.shrubVariant = new Uint8Array(nS);
    for (let i = 0; i < nS; i++) {
      const s = shrubs[i];
      const ref = REF.shrub;
      q.setFromAxisAngle(up, s.seed * Math.PI * 2);
      m.compose(new THREE.Vector3(s.cx, s.cy, s.cz), q, new THREE.Vector3(s.rx / ref.R, s.ry / ref.HH, s.rz / ref.R));
      m.toArray(this.shrubMat, i * 16);
      this.shrubAttrs.aTreeA.set([s.cx, s.y0, s.cz, s.height * 2.5], i * 4);
      this.shrubAttrs.aTreeB.set([0, 0, (s.seed * 9.1) % 1, 1.2], i * 4);
      const v = 1 + (rng.next() - 0.5) * 2 * SHRUBS.leafVar;
      this.shrubAttrs.aTint.set([SHRUBS.leaf[0] * v, SHRUBS.leaf[1] * v, SHRUBS.leaf[2] * v], i * 3);
      const red = rng.chance(0.2) ? SHRUBS.redFraction * rng.range(2, 6) : 0;
      this.shrubAttrs.aTreeC.set([SHRUBS.yellowFraction * rng.range(0.3, 1.6), s.cy + s.ry, s.cy - s.ry, Math.min(0.5, red)], i * 4);
      this.shrubSphere.set([s.cx, s.cy, s.cz, Math.max(s.rx, s.ry) + 0.3], i * 4);
      this.shrubVariant[i] = Math.floor(s.seed * 991) % VARIANTS;
    }
    const shMat = leafMaterial(this.atlas, SHRUBS.yellow, 1.0);
    this.shrubMeshes = [];
    for (let v = 0; v < VARIANTS; v++) {
      const lods = [];
      for (let L = 0; L < 2; L++) {
        const n = L === 0 ? SHRUBS.cards : 9;
        const geo = crownTemplate('shrub', n, SHRUBS.cardSize, L === 0 ? 1 : 1.8, SHRUBS.leafTexture, new Random(5000 + v * 10 + L));
        const di = new DynamicInstances(geo, shMat, nS, { aTreeA: 4, aTreeB: 4, aTint: 3, aTreeC: 4 });
        scene.add(di.mesh);
        lods.push(di);
      }
      this.shrubMeshes.push(lods);
    }

    // ---- 쓰러진 나무·그루터기·뿌리판(정적) ----
    this._buildStatic(scene);
  }

  _buildStatic(scene) {
    const geos = [];
    const colors = [];
    const rng = new Random(99);
    const addGeo = (g, col) => {
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) c.set(col, k * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      geos.push(g);
      colors.push(col);
    };
    for (const l of this.world.belts.logs) {
      const a = new THREE.Vector3(l.ax, l.ay, l.az);
      const b = new THREE.Vector3(l.bx, l.by, l.bz);
      const len = a.distanceTo(b);
      const g = new THREE.CylinderGeometry(l.r2, l.r, len, 9, 4, false);
      g.translate(0, len / 2, 0);
      const dir = b.clone().sub(a).normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.applyQuaternion(quat);
      g.translate(a.x, a.y, a.z);
      const dead = l.material === 'woodDead';
      const col = dead ? SNAG.bark : [0.38, 0.33, 0.28];
      addGeo(g, col.map((x) => x * rng.range(0.85, 1.1)));
      // 부러진 가지 그루터기
      for (let k = 0; k < 4; k++) {
        const t = rng.range(0.25, 0.95);
        const p = a.clone().lerp(b, t);
        const bl = rng.range(0.4, 1.2);
        const bg = new THREE.CylinderGeometry(0.015, 0.04, bl, 5);
        bg.translate(0, bl / 2, 0);
        bg.rotateZ(rng.range(-1.2, 1.2));
        bg.rotateY(rng.range(0, Math.PI * 2));
        bg.translate(p.x, p.y + l.r * 0.5, p.z);
        addGeo(bg, [0.36, 0.31, 0.26]);
      }
      if (l.rootPlate) {
        const rp = l.rootPlate;
        const g2 = new THREE.CylinderGeometry(rp.radius, rp.radius * 0.85, 0.35, 12, 1);
        g2.rotateZ(Math.PI / 2);
        g2.rotateY(-rp.ang);
        const y = this.world.terrain.heightAt(rp.x, rp.z);
        g2.translate(rp.x, y + rp.radius * 0.7, rp.z);
        addGeo(g2, [0.33, 0.27, 0.2]);
      }
    }
    for (const s of this.world.belts.stumps) {
      const h = s.top - s.y0;
      const g = new THREE.CylinderGeometry(s.r1, s.r0, h, 8, 1, false);
      g.translate(s.x, s.y0 + h / 2, s.z);
      addGeo(g, SNAG.bark.map((x) => x * 0.9));
    }
    if (!geos.length) return;
    // 병합
    let nv = 0;
    let ni = 0;
    for (const g of geos) {
      nv += g.attributes.position.count;
      ni += g.index.count;
    }
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const idx = new Uint32Array(ni);
    let vo = 0;
    let io = 0;
    for (const g of geos) {
      pos.set(g.attributes.position.array, vo * 3);
      nor.set(g.attributes.normal.array, vo * 3);
      col.set(g.attributes.color.array, vo * 3);
      const gi = g.index.array;
      for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
      vo += g.attributes.position.count;
      io += gi.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchMaterial(mat, { key: 'logs' });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    this.staticMesh = mesh;
  }

  /**
   * @param {THREE.Camera} camera
   * @param {number} zoom 기준 시야 대비 배율(조준경 4배면 약 4)
   * @param {THREE.Vector3} shadowFocus 그림자 상자 중심
   */
  update(camera, zoom, shadowFocus, shadowExtent) {
    // 카메라가 거의 그대로면 인스턴스 버퍼를 다시 만들지 않는다(조준 흔들림 정도는 넓힌 절두체로 흡수)
    const last = this._last;
    const q = camera.quaternion;
    if (
      last &&
      camera.position.distanceToSquared(last.pos) < 0.09 &&
      Math.abs(q.dot(last.quat)) > 0.99991 &&
      Math.abs(zoom / last.zoom - 1) < 0.02 &&
      Math.abs(shadowFocus.x - last.sx) < 2 &&
      Math.abs(shadowFocus.z - last.sz) < 2
    )
      return;
    this._last = { pos: camera.position.clone(), quat: q.clone(), zoom, sx: shadowFocus.x, sz: shadowFocus.z };
    // 컬링용 절두체: 시야각을 조금 넓혀 작은 회전에도 빈틈이 없게
    if (!this.cullCam) this.cullCam = new THREE.PerspectiveCamera();
    const cc = this.cullCam;
    cc.fov = Math.min(170, camera.fov * 1.12 + 2);
    cc.aspect = camera.aspect;
    cc.near = camera.near;
    cc.far = camera.far;
    cc.updateProjectionMatrix();
    this.frustum.setFromProjectionMatrix(this.tmpM.multiplyMatrices(cc.projectionMatrix, camera.matrixWorldInverse));
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const lodK = 1 / (Math.max(1, zoom) * this.quality.treeLodScale);
    const shK = 1 / (Math.max(1, zoom) * this.quality.shrubLodScale);
    const sph = this.sphere;
    const trees = this.trees;
    const ts = this.treeSphere;
    const sx = shadowFocus.x;
    const sz = shadowFocus.z;
    const sExt = shadowExtent + 25;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const k4 = i * 4;
      // 그림자 줄기
      if (Math.abs(t.x - sx) < sExt && Math.abs(t.z - sz) < sExt) this.shadowTrunks.push(this.trunkMat, this.trunkAttrs, i);
      sph.center.set(ts[k4], ts[k4 + 1], ts[k4 + 2]);
      sph.radius = ts[k4 + 3];
      if (!this.frustum.intersectsSphere(sph)) continue;
      const dx = ts[k4] - cx;
      const dy = ts[k4 + 1] - cy;
      const dz = ts[k4 + 2] - cz;
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - ts[k4 + 3] * 0.5) * lodK;
      const tl = d < TRUNK_LOD[0] ? 0 : d < TRUNK_LOD[1] ? 1 : 2;
      this.trunkMeshes[tl].push(this.trunkMat, this.trunkAttrs, i);
      if (t.crown) {
        const ll = d < LEAF_LOD[0] ? 0 : d < LEAF_LOD[1] ? 1 : 2;
        this.crownMeshes[this.treeSpecies[i]][this.treeVariant[i]][ll].push(this.crownMat, this.crownAttrs, i);
        if (d < BRANCH_DIST) this.branchLive.push(this.branchMat, this.branchAttrs, i);
      } else if (t.dead && d < BRANCH_DIST * 3) {
        this.branchDead.push(this.branchMat, this.branchAttrs, i);
      }
    }
    const ss = this.shrubSphere;
    for (let i = 0; i < this.shrubs.length; i++) {
      const k4 = i * 4;
      sph.center.set(ss[k4], ss[k4 + 1], ss[k4 + 2]);
      sph.radius = ss[k4 + 3];
      if (!this.frustum.intersectsSphere(sph)) continue;
      const dx = ss[k4] - cx;
      const dy = ss[k4 + 1] - cy;
      const dz = ss[k4 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * shK;
      const l = d < SHRUB_LOD[0] ? 0 : 1;
      this.shrubMeshes[this.shrubVariant[i]][l].push(this.shrubMat, this.shrubAttrs, i);
    }
    for (const sv of this.crownMeshes) for (const v of sv) for (const di of v) di.finish();
    for (const di of this.trunkMeshes) di.finish();
    for (const v of this.shrubMeshes) for (const di of v) di.finish();
    this.shadowTrunks.finish();
    this.branchLive.finish();
    this.branchDead.finish();
  }
}
