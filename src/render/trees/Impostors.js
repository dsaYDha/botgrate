// 임포스터 굽기: 템플릿마다 수평 방위 8곳에서 본 모습을 아틀라스(칸 96×192)에 한 번에 그린다.
// 아틀라스 공간(1 단위 = 1 화소)에 템플릿 사본 184개를 각 칸 자리·회전으로 놓고 정사영 카메라 하나로 렌더.
// 출력(MRT, 덮임으로 미리 곱한 값 → 밉맵이 가장자리를 검게 만들지 않음):
//   0: 명암 키, 재질(0 잎·0.5 껍질·1 열매), 물듦 문턱/1.4, 덮임
//   1: 법선(템플릿 공간)·0.5+0.5, 차폐
// 실행 중 셰이더가 인스턴스의 잎색·물듦·회전으로 다시 칠하고 빛을 준다(가까운 LOD와 같은 식).

import * as THREE from 'three';
import { IMP } from './treeShaders.js';

/** 템플릿 칸 크기(미터): 회전해도 들어가는 폭, 높이 */
export function impostorFrame(T) {
  const b = T.bbox;
  const wt = 2 * Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ)) * 1.04;
  const ht = (b.maxY - b.minY) * 1.02;
  const mpp = Math.max(wt / IMP.fw, ht / IMP.fh); // 화소당 미터
  return { mpp, ppm: 1 / mpp, w: IMP.fw * mpp, h: IMP.fh * mpp, minY: b.minY };
}

export function impostorGrid(nTemplates) {
  const cols = IMP.cols;
  const rows = Math.ceil((nTemplates * IMP.views) / cols);
  return { cols, rows, width: cols * IMP.fw, height: rows * IMP.fh };
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {Array<{meshes: THREE.Mesh[]}>} parts 템플릿별 굽기용 메시(인스턴스 8개씩, 데이터 표의 굽기 칸을 가리킴)
 * @param {{cols:number, rows:number, width:number, height:number}} grid
 */
export function bakeImpostors(renderer, parts, grid) {
  const rt = new THREE.WebGLRenderTarget(grid.width, grid.height, {
    count: 2,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
    stencilBuffer: false,
  });
  for (const t of rt.textures) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
  }
  const scene = new THREE.Scene();
  for (const p of parts) for (const m of p.meshes) scene.add(m);
  const cam = new THREE.OrthographicCamera(0, grid.width, grid.height, 0, 1, 4000);
  cam.position.set(0, 0, 2000);
  cam.updateMatrixWorld();
  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, false);
  // 렌더 한 번 → 끝에서 두 텍스처의 밉맵이 만들어진다
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  for (const p of parts) for (const m of p.meshes) scene.remove(m);
  return { target: rt, key: rt.textures[0], normal: rt.textures[1] };
}
