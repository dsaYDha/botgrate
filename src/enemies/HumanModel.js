// 관절형 인체 모델(원기둥·상자 조합, 강체 스키닝 SkinnedMesh). 실제 체형 치수.
// 위장복은 몸 좌표 기반 절차적 얼룩 무늬(배경 흙·풀 색과 섞이도록 탁한 색), 무광(반사 없음).
// 조끼·탄입대·허리 파우치·배낭·무릎 보호대·헬멧 커버 천 조각이 사람 윤곽(어깨·머리 선)을 깨뜨린다.
// 얼굴은 위장 크림(절반 정도)이나 그늘로 맨살 대비를 줄인다.

import * as THREE from 'three';
import { BODY } from '../data/anatomy.js';
import { patchMaterial } from '../render/shaderLib.js';

const BONE_NAMES = Object.keys(BODY.bones);

// 위장 팔레트 몇 종(초가을 스텝 지대에 맞는 흙·마른풀·짙은 녹색)
export const CAMO_PALETTES = [
  [[0.15, 0.17, 0.09], [0.22, 0.19, 0.12], [0.08, 0.1, 0.055], [0.06, 0.055, 0.045]],
  [[0.17, 0.17, 0.1], [0.12, 0.14, 0.075], [0.23, 0.2, 0.13], [0.065, 0.065, 0.05]],
  [[0.14, 0.16, 0.09], [0.2, 0.18, 0.12], [0.1, 0.1, 0.065], [0.055, 0.055, 0.045]],
];
export const GEAR_COLORS = [
  [0.19, 0.19, 0.13],
  [0.29, 0.25, 0.18],
  [0.15, 0.16, 0.11],
];

function partGeo(kind, dims) {
  let g;
  if (kind === 'box') g = new THREE.BoxGeometry(dims[0], dims[1], dims[2], 1, 1, 1);
  else if (kind === 'cylDown') {
    g = new THREE.CylinderGeometry(dims[0], dims[1], dims[2], 9, 2);
    g.translate(0, -dims[2] / 2, 0);
  } else if (kind === 'cylUp') {
    g = new THREE.CylinderGeometry(dims[1], dims[0], dims[2], 9, 1);
    g.translate(0, dims[2] / 2, 0);
  } else if (kind === 'sphere') {
    g = new THREE.SphereGeometry(1, 12, 9);
    g.scale(dims[0], dims[1], dims[2]);
  } else if (kind === 'helmet') {
    g = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
    g.scale(dims[0], dims[1], dims[2]);
  }
  return g.toNonIndexed();
}

export function createSkeleton() {
  const bones = {};
  const list = [];
  for (const name of BONE_NAMES) {
    const [parent, off] = BODY.bones[name];
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(off[0], off[1], off[2]);
    bones[name] = b;
    list.push(b);
    if (parent) bones[parent].add(b);
  }
  return { bones, list, root: bones.pelvis };
}

/** 몸 메시: [뼈, 종류, 치수, 위치오프셋, 재질id] */
const PARTS = [
  ['pelvis', 'box', [0.34, 0.2, 0.22], [0, -0.03, 0], 0],
  ['spine', 'box', [0.31, 0.24, 0.215], [0, 0.1, 0.008], 0],
  ['chest', 'box', [0.37, 0.27, 0.235], [0.005, 0.105, 0], 0],
  // 전투조끼 + 탄입대
  ['chest', 'box', [0.33, 0.24, 0.05], [0, 0.07, 0.13], 1],
  ['chest', 'box', [0.33, 0.22, 0.04], [0, 0.09, -0.135], 1],
  ['chest', 'box', [0.075, 0.09, 0.05], [0.09, 0.0, 0.17], 1],
  ['chest', 'box', [0.075, 0.09, 0.05], [0.0, 0.0, 0.17], 1],
  ['chest', 'box', [0.075, 0.09, 0.05], [-0.09, 0.0, 0.17], 1],
  ['neck', 'cylUp', [0.055, 0.05, 0.12], [0, 0, 0], 2],
  ['head', 'sphere', [0.077, 0.105, 0.097], [0, 0.085, 0.01], 2],
  ['head', 'helmet', [0.123, 0.115, 0.135], [0, 0.11, -0.005], 4],
  // 헬멧 커버 천 조각(윤곽을 흐트러뜨림)
  ['head', 'box', [0.05, 0.02, 0.09], [0.06, 0.21, 0.02], 4],
  ['head', 'box', [0.07, 0.02, 0.05], [-0.05, 0.205, -0.05], 4],
  ['head', 'box', [0.04, 0.03, 0.06], [0.0, 0.215, 0.07], 4],
  // 배낭(돌격 배낭)·허리 파우치
  ['chest', 'box', [0.28, 0.34, 0.13], [0.0, 0.08, -0.215], 1],
  ['chest', 'box', [0.2, 0.08, 0.1], [0.0, 0.29, -0.2], 1],
  ['pelvis', 'box', [0.07, 0.11, 0.13], [0.2, 0.0, 0.0], 1],
  ['pelvis', 'box', [0.07, 0.11, 0.12], [-0.2, 0.0, -0.02], 1],
  ['pelvis', 'box', [0.12, 0.08, 0.06], [0.08, 0.0, -0.13], 1],
  // 무릎 보호대
  ['shinL', 'box', [0.1, 0.09, 0.05], [0, -0.04, 0.055], 3],
  ['shinR', 'box', [0.1, 0.09, 0.05], [0, -0.04, 0.055], 3],
  ['upperArmL', 'cylDown', [0.053, 0.047, 0.3], [0, 0, 0], 0],
  ['upperArmR', 'cylDown', [0.053, 0.047, 0.3], [0, 0, 0], 0],
  ['foreArmL', 'cylDown', [0.045, 0.038, 0.27], [0, 0, 0], 0],
  ['foreArmR', 'cylDown', [0.045, 0.038, 0.27], [0, 0, 0], 0],
  ['handL', 'box', [0.05, 0.1, 0.09], [0, -0.05, 0.01], 3],
  ['handR', 'box', [0.05, 0.1, 0.09], [0, -0.05, 0.01], 3],
  ['thighL', 'cylDown', [0.085, 0.066, 0.44], [0, 0, 0], 0],
  ['thighR', 'cylDown', [0.085, 0.066, 0.44], [0, 0, 0], 0],
  ['shinL', 'cylDown', [0.064, 0.05, 0.43], [0, 0, 0], 0],
  ['shinR', 'cylDown', [0.064, 0.05, 0.43], [0, 0, 0], 0],
  ['shinL', 'box', [0.11, 0.16, 0.13], [0, -0.36, 0.01], 3],
  ['shinR', 'box', [0.11, 0.16, 0.13], [0, -0.36, 0.01], 3],
  ['footL', 'box', [0.105, 0.085, 0.27], [0, -0.035, 0.065], 3],
  ['footR', 'box', [0.105, 0.085, 0.27], [0, -0.035, 0.065], 3],
];

export function buildBodyGeometry(skel) {
  skel.root.updateMatrixWorld(true);
  const pos = [];
  const nor = [];
  const skinIndex = [];
  const skinWeight = [];
  const matId = [];
  const restPos = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const [bone, kind, dims, off, mid] of PARTS) {
    const g = partGeo(kind, dims);
    g.translate(off[0], off[1], off[2]);
    const b = skel.bones[bone];
    const bi = skel.list.indexOf(b);
    const m = b.matrixWorld;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const P = g.attributes.position;
    const N = g.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(m);
      n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      pos.push(v.x, v.y, v.z);
      nor.push(n.x, n.y, n.z);
      skinIndex.push(bi, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
      matId.push(mid);
      restPos.push(v.x, v.y, v.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geo.setAttribute('aMat', new THREE.Float32BufferAttribute(matId, 1));
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = 2.2;
  return geo;
}

export function bodyMaterial(palette, gear, skin, faceCamo = 0) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const u = {
    uCamo0: { value: new THREE.Color(...palette[0]) },
    uCamo1: { value: new THREE.Color(...palette[1]) },
    uCamo2: { value: new THREE.Color(...palette[2]) },
    uCamo3: { value: new THREE.Color(...palette[3]) },
    uGear: { value: new THREE.Color(...gear) },
    uSkin: { value: new THREE.Color(...skin) },
    uFaceCamo: { value: faceCamo },
  };
  patchMaterial(mat, {
    key: 'soldier',
    uniforms: u,
    vertexHeader: 'attribute float aMat;\nvarying float vMat;\nvarying vec3 vRest;',
    vertex: '#include <begin_vertex>\nvMat = aMat;\nvRest = position;',
    fragmentHeader: /* glsl */ `
      uniform vec3 uCamo0, uCamo1, uCamo2, uCamo3, uGear, uSkin;
      uniform float uFaceCamo;
      varying float vMat;
      varying vec3 vRest;
    `,
    fragmentColor: /* glsl */ `
      vec3 col;
      if (vMat < 0.5 || (vMat > 3.5)) {
        vec3 p = vRest * (vMat > 3.5 ? 14.0 : 9.0);
        float n1 = vnoise(p.xy + p.z * 0.7);
        float n2 = vnoise(p.zy * 1.3 + 7.1 + p.x);
        float n3 = vnoise(p.xz * 2.1 - 3.3 + p.y);
        col = uCamo0;
        col = mix(col, uCamo1, smoothstep(0.52, 0.58, n1));
        col = mix(col, uCamo2, smoothstep(0.55, 0.61, n2));
        col = mix(col, uCamo3, smoothstep(0.62, 0.67, n3));
      } else if (vMat < 1.5) {
        col = uGear * (0.9 + 0.2 * vnoise(vRest.xy * 30.0));
      } else if (vMat < 2.5) {
        // 얼굴: 위장 크림 줄무늬(갈색·녹색)로 맨살 대비를 줄임
        float st = smoothstep(0.45, 0.55, vnoise(vRest.xy * 38.0 + vRest.z * 11.0));
        vec3 paint = mix(uCamo2 * 1.3, uCamo1 * 1.1, st);
        col = mix(uSkin, paint, uFaceCamo);
      } else {
        col = vec3(0.13, 0.11, 0.09);
      }
      diffuseColor.rgb = col;
    `,
  });
  return mat;
}

/** 일반형 소총(적 무기) — 별도 메시(떨어뜨릴 수 있게) */
export function buildRifle() {
  const g = new THREE.Group();
  const black = new THREE.MeshLambertMaterial({ color: 0x1c1c1c });
  const wood = new THREE.MeshLambertMaterial({ color: 0x3b2a1c });
  patchMaterial(black, { key: 'erifle' });
  patchMaterial(wood, { key: 'erifle' });
  const add = (geo, m, x, y, z, rx = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rx;
    mesh.castShadow = true;
    g.add(mesh);
  };
  // 총 좌표: +z 총구 방향, 원점 = 권총손잡이 위
  add(new THREE.BoxGeometry(0.05, 0.065, 0.3), black, 0, 0.03, 0.08);
  add(new THREE.CylinderGeometry(0.009, 0.009, 0.42, 8).rotateX(Math.PI / 2), black, 0, 0.045, 0.43);
  add(new THREE.BoxGeometry(0.045, 0.05, 0.2), wood, 0, 0.025, 0.31);
  add(new THREE.BoxGeometry(0.04, 0.07, 0.25), wood, 0, 0.0, -0.18, 0.12);
  add(new THREE.BoxGeometry(0.03, 0.1, 0.04), black, 0, -0.05, 0.0, 0.3);
  const mag = new THREE.BoxGeometry(0.03, 0.18, 0.06);
  add(mag, black, 0, -0.08, 0.13, 0.35);
  return g;
}
