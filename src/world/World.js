// 월드 조립: 배치 → 지형 → 방풍림 → 공간 해시 → 수관 지도 → 바람장, 그리고 GPU 텍스처.

import * as THREE from 'three';
import { WORLD } from '../data/world.js';
import { Layout } from './Layout.js';
import { Terrain } from './Terrain.js';
import { Shelterbelts } from './Shelterbelts.js';
import { SpatialHash } from './SpatialHash.js';
import { WindField } from './Wind.js';
import { Props } from './Props.js';
import { U } from '../render/shaderLib.js';

export class World {
  constructor() {
    const t0 = performance.now();
    this.data = WORLD;
    this.layout = new Layout(WORLD);
    this.terrain = new Terrain(WORLD, this.layout);
    this.belts = new Shelterbelts(WORLD, this.layout, this.terrain);
    this.hash = new SpatialHash(WORLD.mapHalf, 4);
    this.belts.register(this.hash);
    this.props = new Props(WORLD, this.layout, this.terrain);
    this.props.register(this.hash);
    this.canopy = this.belts.buildCanopyMap(WORLD.mapHalf, 1);
    // 숲 바닥 식생(빛 드는 곳)의 판정이 수관 지도를 쓴다(GroundCover.coverAt)
    this.terrain.canopy = this.canopy;
    const beltHeights = {};
    for (const b of this.layout.belts) {
      const ts = this.belts.trees.filter((t) => t.belt === b.id && !t.dead && !t.sapling);
      beltHeights[b.id] = ts.length ? ts.reduce((s, t) => s + t.height, 0) / ts.length : 15;
    }
    this.beltHeights = beltHeights;
    this.wind = new WindField(WORLD, this.layout, this.terrain, beltHeights);
    this.wind.set(5, 300);
    this.buildMs = performance.now() - t0;
    this._makeTextures();
    this._windVersion = -1;
  }

  _makeTextures() {
    const t = this.terrain;
    // 높이·도로 거리: 반정밀도 RG 텍스처(쌍선형 필터 가능) — CPU 값도 같은 반정밀도로 반올림돼 있다
    const half = new Uint16Array(t.hd.length);
    for (let i = 0; i < t.hd.length; i++) half[i] = THREE.DataUtils.toHalfFloat(t.hd[i]);
    const hd = new THREE.DataTexture(half, t.N, t.N, THREE.RGFormat, THREE.HalfFloatType);
    hd.minFilter = THREE.LinearFilter;
    hd.magFilter = THREE.LinearFilter;
    hd.generateMipmaps = false;
    hd.wrapS = hd.wrapT = THREE.ClampToEdgeWrapping;
    hd.needsUpdate = true;
    U.uTerrainHD.value = hd;
    U.uTerrainInfo.value.set(t.half, t.res, t.N, 0);
    const T = WORLD.terrain;
    U.uTerrainP0.value.set(T.largeAmp, T.largeScale, T.midAmp, T.midScale);
    U.uTerrainP1.value.set(T.smallAmp, T.smallScale, 0, 0);
    const R = WORLD.rut;
    U.uRut.value.set(R.gauge, R.width, R.depth, R.centerRise);

    const mk = (data, N) => {
      const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      return tex;
    };
    // 지면 종류: 정점·충돌과 같은 쌍선형 값을 쓰도록 밉맵 없이 선형 필터
    const mkLin = (data, N) => {
      const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      return tex;
    };
    U.uSurfA.value = mkLin(t.surfA, t.N);
    U.uSurfB.value = mkLin(t.surfB, t.N);
    const sc = new THREE.DataTexture(t.surfC, t.N, t.N, THREE.RGBAFormat, THREE.UnsignedByteType);
    sc.minFilter = THREE.NearestFilter;
    sc.magFilter = THREE.NearestFilter;
    sc.generateMipmaps = false;
    sc.needsUpdate = true;
    U.uSurfC.value = sc;
    const c = this.canopy;
    U.uCanopyTex.value = mk(c.data, c.N);
    U.uCanopyInfo.value.set(c.half, c.res, c.N, 0);
  }

  /** 바람 차폐 격자가 바뀌었으면 텍스처 갱신 */
  syncWind(time) {
    const w = this.wind;
    U.uWind.value.set(w.dirX, w.dirZ, w.speed, time);
    if (this._windVersion !== w.version) {
      this._windVersion = w.version;
      const data = w.textureData();
      if (this.shelterTex) this.shelterTex.dispose();
      const tex = new THREE.DataTexture(data, w.N, w.N, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.shelterTex = tex;
      U.uShelterTex.value = tex;
      U.uShelterInfo.value.set(w.half, w.res, w.N, 0);
    }
  }
}
