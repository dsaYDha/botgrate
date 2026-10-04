// 절차적 카빈 모델(14.5인치, 직선형 개머리판) + 장갑 낀 손.
// 좌표: 무기 좌표계(원점 = 개머리판 끝 중심, -z 총구, +y 위). 실제 치수(m).
// 철제 조준기: 접이식 가늠자(구경 1.8 mm) + 가늠쇠(폭 1.8 mm, 끝 높이 = 조준선 6.6 cm).

import * as THREE from 'three';
import { patchMaterial } from '../render/shaderLib.js';

function mat(color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.25, ...opts });
  patchMaterial(m, { key: 'weapon' });
  return m;
}

function box(w, h, d, m, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z);
  return mesh;
}

function cylZ(r0, r1, len, m, x, y, z0, seg = 16) {
  // z0에서 -z 방향으로 len 길이
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  g.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z0 - len / 2);
  return mesh;
}

export class WeaponModel {
  constructor(weaponData) {
    this.data = weaponData;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const black = mat(0x3a3c40, { roughness: 0.5, metalness: 0.2 });
    const poly = mat(0x3b3b39, { roughness: 0.8, metalness: 0.0 });
    const metal = mat(0x4a4c50, { roughness: 0.4, metalness: 0.35 });
    // 가늠자는 눈에 가까워 초점이 맞지 않는다 → 조준 시 반투명(유령 고리)
    this.rearMat = mat(0x2a2b2e, { roughness: 0.6, metalness: 0.2, transparent: true, opacity: 1 });
    const glove = mat(0x6b5d48, { roughness: 0.95, metalness: 0 });
    const sleeve = mat(0x4a4d36, { roughness: 0.95, metalness: 0 });
    const lens = new THREE.MeshLambertMaterial({ color: 0x0a0c10, emissive: 0x05070a });
    this.mats = { black, poly, metal, glove, sleeve };

    const b = this.body;
    // 개머리판(신축형, 중간 위치)
    b.add(box(0.044, 0.105, 0.018, poly, 0, -0.018, -0.009));
    b.add(box(0.04, 0.05, 0.16, poly, 0, 0.002, -0.085));
    b.add(box(0.036, 0.04, 0.12, poly, 0, -0.04, -0.07));
    b.add(cylZ(0.0146, 0.0146, 0.21, black, 0, 0, -0.045));
    // 하부 리시버 + 탄창 삽입구
    b.add(box(0.024, 0.05, 0.17, black, 0, -0.027, -0.335));
    b.add(box(0.03, 0.04, 0.07, black, 0, -0.06, -0.392));
    // 손잡이
    const grip = box(0.03, 0.105, 0.036, poly, 0, -0.1, -0.285);
    grip.rotation.x = -0.32;
    b.add(grip);
    // 방아쇠울
    b.add(box(0.012, 0.004, 0.07, black, 0, -0.068, -0.33));
    b.add(box(0.004, 0.012, 0.004, black, 0, -0.058, -0.335));
    // 상부 리시버 + 레일
    b.add(box(0.026, 0.042, 0.19, black, 0, 0.018, -0.335));
    b.add(box(0.021, 0.011, 0.19, metal, 0, 0.0445, -0.335));
    for (let i = 0; i < 14; i++) b.add(box(0.022, 0.003, 0.006, metal, 0, 0.051, -0.248 - i * 0.0128));
    // 장전손잡이, 전진기, 배출구 덮개
    b.add(box(0.05, 0.008, 0.016, black, 0, 0.033, -0.247));
    b.add(cylZ(0.006, 0.006, 0.03, metal, 0.018, 0.022, -0.29, 8));
    b.add(box(0.002, 0.022, 0.055, metal, 0.0135, 0.012, -0.36));
    // 총열 덮개(원형), 델타 링
    b.add(cylZ(0.0285, 0.0285, 0.175, poly, 0, 0.005, -0.432, 20));
    b.add(cylZ(0.031, 0.031, 0.012, black, 0, 0.005, -0.425, 20));
    for (let i = 0; i < 6; i++) b.add(cylZ(0.0292, 0.0292, 0.006, poly, 0, 0.005, -0.45 - i * 0.026, 20));
    // 총열
    b.add(cylZ(0.0095, 0.0095, 0.17, metal, 0, 0, -0.6, 12));
    // 가늠쇠 받침(삼각) + 보호 귀 + 가늠쇠
    const fsb = box(0.022, 0.03, 0.026, black, 0, 0.022, -0.627);
    b.add(fsb);
    b.add(box(0.004, 0.024, 0.012, black, 0.009, 0.052, -0.627));
    b.add(box(0.004, 0.024, 0.012, black, -0.009, 0.052, -0.627));
    b.add(box(0.0018, 0.03, 0.0035, black, 0, 0.051, -0.64)); // 가늠쇠: 끝 y = 0.066
    // 소염기(A2형)
    b.add(cylZ(0.011, 0.0105, 0.05, black, 0, 0, -0.75, 12));

    // 탄창(곡형 30발)
    this.mag = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const seg = box(0.024, 0.032, 0.062, metal, 0, -0.016 - i * 0.03, -0.004 - i * i * 0.0012 - i * 0.004);
      seg.rotation.x = 0.05 * i;
      this.mag.add(seg);
    }
    this.mag.add(box(0.027, 0.012, 0.066, poly, 0, -0.19, -0.05));
    this.magHome = new THREE.Vector3(0, -0.08, -0.392);
    this.mag.position.copy(this.magHome);
    this.body.add(this.mag);

    // 접이식 가늠자(철제 조준기용)
    this.rearSight = new THREE.Group();
    const base = box(0.022, 0.008, 0.03, this.rearMat, 0, 0.054, -0.27);
    this.rearSight.add(base);
    this.rearLeaf = new THREE.Group();
    this.rearLeaf.position.set(0, 0.058, -0.27);
    // 가늠자 판: 조준선 높이(0.066)에 구멍. 링 형태
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.0026, 0.0075, 28), this.rearMat);
    ring.position.set(0, 0.008, 0);
    this.rearLeaf.add(ring);
    const ringBack = ring.clone();
    ringBack.rotation.y = Math.PI;
    this.rearLeaf.add(ringBack);
    this.rearLeaf.add(box(0.016, 0.004, 0.004, this.rearMat, 0, 0.0, 0));
    this.rearLeaf.add(box(0.003, 0.012, 0.004, this.rearMat, 0.0065, 0.004, 0));
    this.rearLeaf.add(box(0.003, 0.012, 0.004, this.rearMat, -0.0065, 0.004, 0));
    this.rearSight.add(this.rearLeaf);
    this.body.add(this.rearSight);

    // 4배율 광학
    this.optic = new THREE.Group();
    this.optic.add(box(0.03, 0.012, 0.09, black, 0, 0.056, -0.33));
    this.optic.add(cylZ(0.019, 0.02, 0.06, poly, 0, 0.068, -0.258, 20));
    this.optic.add(box(0.04, 0.046, 0.06, poly, 0, 0.07, -0.345));
    this.optic.add(cylZ(0.021, 0.0235, 0.05, poly, 0, 0.068, -0.375, 20));
    const ocularLens = new THREE.Mesh(new THREE.CircleGeometry(0.016, 20), lens);
    ocularLens.position.set(0, 0.068, -0.2585);
    this.optic.add(ocularLens);
    const objLens = new THREE.Mesh(new THREE.CircleGeometry(0.02, 20), lens);
    objLens.rotation.y = Math.PI;
    objLens.position.set(0, 0.068, -0.4255);
    this.optic.add(objLens);
    this.body.add(this.optic);

    // 손과 팔: 아래팔은 손목과 팔꿈치(몸 쪽 고정점)를 잇는 원기둥으로 매 프레임 갱신
    this.rightHand = new THREE.Group();
    this.rightHand.add(box(0.034, 0.08, 0.095, glove, 0.014, -0.095, -0.285));
    this.rightHand.add(box(0.02, 0.022, 0.05, glove, 0.006, -0.05, -0.315)); // 검지
    this.body.add(this.rightHand);
    this.leftHand = new THREE.Group();
    this.leftHand.add(box(0.045, 0.034, 0.1, glove, -0.012, -0.034, 0));
    this.leftHand.add(box(0.034, 0.018, 0.085, glove, 0.016, 0.008, 0.0)); // 손가락이 총열 덮개를 감쌈
    this.leftHandHome = new THREE.Vector3(0, -0.005, -0.52);
    this.leftHand.position.copy(this.leftHandHome);
    this.body.add(this.leftHand);
    const limb = () => {
      const g = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
      g.translate(0, 0.5, 0);
      const m = new THREE.Mesh(g, sleeve);
      this.body.add(m);
      return m;
    };
    this.rForearm = limb();
    this.lForearm = limb();
    // 팔꿈치 위치(무기 좌표, 견착 자세 기준)
    this.rElbow = new THREE.Vector3(0.2, -0.24, -0.06);
    this.lElbow = new THREE.Vector3(-0.2, -0.22, -0.3);
    this.rWrist = new THREE.Vector3(0.025, -0.13, -0.255);
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._placeLimb(this.rForearm, this.rWrist, this.rElbow, 0.04, 0.047);

    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    this.setSight('optic4x');
  }

  setSight(kind) {
    this.sight = kind;
    this.optic.visible = kind === 'optic4x';
    // 광학 장착 시 가늠자는 접어 둔다
    this.rearLeaf.rotation.x = kind === 'optic4x' ? -Math.PI / 2 : 0;
  }

  /**
   * 재장전·탄창 확인 애니메이션
   * @param {object} a {magOffset: Vector3|null, magVisible, leftHandTo: Vector3|null, leftHandBlend, cant}
   */
  /** 조준 정도(0~1)에 따라 눈앞 가늠자를 흐리게 */
  setAds(ads) {
    const o = this.sight === 'iron' ? 1 - 0.72 * ads : 1;
    this.rearMat.opacity = o;
    this.rearMat.depthWrite = o > 0.95;
  }

  _placeLimb(mesh, a, b, r0, r1) {
    const d = this._v.copy(b).sub(a);
    const len = d.length();
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len));
    mesh.scale.set((r0 + r1) / 2, len, (r0 + r1) / 2);
  }

  animate(a) {
    if (a.magOffset) this.mag.position.copy(this.magHome).add(a.magOffset);
    else this.mag.position.copy(this.magHome);
    this.mag.visible = a.magVisible !== false;
    this.leftHand.position.copy(this.leftHandHome);
    if (a.leftHandTo) this.leftHand.position.lerp(a.leftHandTo, a.leftHandBlend || 0);
    this.body.rotation.set(a.tilt || 0, 0, a.cant || 0);
    const wrist = new THREE.Vector3(-0.03, -0.045, 0.045).add(this.leftHand.position);
    this._placeLimb(this.lForearm, wrist, this.lElbow, 0.038, 0.046);
  }
}
