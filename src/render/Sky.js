// 하늘 돔(해석적 산란 모델 + 적운·권운 + 태양 원반), 햇빛(2단 캐스케이드 그림자), 하늘빛(SH 라이트프로브),
// 무기용 환경 반사(PMREM). 북위 48°, 9월 말 오후 3시 무렵: 태양 고도 25.5°, 방위 235°.
// 하늘·안개·구름 그림자는 shaderLib.js의 같은 GLSL 함수를 쓰므로 서로 어긋나지 않는다.

import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { U, commonGLSL } from './shaderLib.js';
import { SKY, sunDirection, sunIrradiance, bakeSkySH } from './skyModel.js';

export { SKY, sunDirection };

// 이전 코드 호환(무기 장면 조명 등)
export const SUN = {
  get elevationDeg() {
    return SKY.sunElevationDeg;
  },
  get azimuthDeg() {
    return SKY.sunAzimuthDeg;
  },
};

const DOME_FRAG = /* glsl */ `
uniform float uSunDisk;
varying vec3 vDir;

vec4 cumulusAt(vec3 d) {
  if (d.y < 0.012) return vec4(0.0);
  float t = (uCloud.x - cameraPosition.y) / d.y;
  vec2 p = cameraPosition.xz + d.xz * t;
  float dens = cloudDensity(p);
  if (dens < 0.002) return vec4(0.0);
  // 태양 쪽 밀도로 자체 그늘, 앞쪽 산란으로 가장자리 밝힘
  vec2 sxz = normalize(uSunDir.xz + 1e-4);
  float dl = cloudDensity(p + sxz * 140.0);
  float lit = 1.0 - 0.72 * dl;
  float fwd = pow(max(dot(d, uSunDir), 0.0), 7.0);
  float edge = (1.0 - dens) * 0.8;
  vec3 col = sunE() * (0.1 + 0.3 * lit + 0.55 * fwd * (0.4 + edge)) + shIrradiance(vec3(0.0, -1.0, 0.0)) * 0.35 + shIrradiance(vec3(0.0, 1.0, 0.0)) * 0.08;
  // 멀수록 지평선 하늘빛에 묻힘
  float far = 1.0 - exp(-t / 32000.0);
  col = mix(col, skyRadiance(normalize(vec3(d.x, 0.02, d.z))), far * 0.85);
  float a = dens * uCloud.w * smoothstep(0.012, 0.09, d.y);
  return vec4(col, a);
}

vec4 cirrusAt(vec3 d) {
  if (d.y < 0.02) return vec4(0.0);
  float t = (uCloud2.x - cameraPosition.y) / d.y;
  vec2 p = (cameraPosition.xz + d.xz * t + uCirrusOffset) / uCloud2.y;
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p;
  float n = vnoise(vec2(q.x * 0.7, q.y * 4.2)) * 0.6 + vnoise(vec2(q.x * 1.9 + 3.0, q.y * 9.5)) * 0.4;
  float m = vnoise(p * 0.33 + 7.0) * 0.7 + vnoise(p * 0.9 - 3.0) * 0.3;
  float a = smoothstep(0.52, 0.88, n) * smoothstep(0.42, 0.72, m) * uCloud2.z * smoothstep(0.02, 0.22, d.y);
  vec3 col = sunE() * 0.3 + skyRadiance(d) * 0.75;
  return vec4(col, a);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 c = skyRadiance(d.y < 0.0 ? normalize(vec3(d.x, 0.0, d.z)) : d);
  float cloudA = 0.0;
  if (d.y > 0.0) {
    vec4 ci = cirrusAt(d);
    c = mix(c, ci.rgb, ci.a);
    vec4 cu = cumulusAt(d);
    c = mix(c, cu.rgb, cu.a);
    cloudA = max(cu.a, ci.a * 0.5);
  }
  // 태양 원반(시반지름 0.267°) — 구름에 가려진다
  float sd = dot(d, uSunDir);
  float disk = smoothstep(0.999987, 0.9999925, sd);
  c += sunE() * disk * 1800.0 * uSunDisk * (1.0 - cloudA);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function domeMaterial(sunDisk) {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, uSunDisk: { value: sunDisk } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: `${commonGLSL()}\n${DOME_FRAG}`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
}

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {object} quality 품질 프리셋(shadowMapSize, shadowDistance, shadowRadius)
   */
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    const dir = sunDirection();
    this.dir = dir;
    const E = sunIrradiance();
    U.uSunDir.value.copy(dir);
    U.uSunIntensity.value = SKY.sunIlluminance;
    U.uSunColor.value.setRGB(E[0] / SKY.sunIlluminance, E[1] / SKY.sunIlluminance, E[2] / SKY.sunIlluminance);
    U.uSkyTauR.value.set(...SKY.tauR);
    U.uSkyP.value.set(SKY.tauM, SKY.mieG, SKY.kR, SKY.kM);
    U.uSkyP2.value.set(SKY.kMs, SKY.horizonDesat, 0, 0);
    U.uHaze.value.set(SKY.hazeSigma, SKY.hazeScaleHeight, 0, 0);
    U.uHazeTint.value.set(...SKY.hazeTint);
    const cu = SKY.cumulus;
    U.uCloud.value.set(cu.height, cu.scale, cu.coverage, cu.opacity);
    U.uCloud2.value.set(SKY.cirrus.height, SKY.cirrus.scale, SKY.cirrus.opacity, 0);
    // 시작 구름 배치(시드처럼 고정)
    U.uCloudOffset.value.set(3712, -2241);
    U.uCirrusOffset.value.set(-9100, 4400);

    // 하늘빛 SH → 모든 셰이더의 산란광(그늘이 하늘빛을 받는다)
    const bake = bakeSkySH();
    this.sh = bake.sh;
    for (let i = 0; i < 9; i++) U.uSH.value[i].copy(bake.sh.coefficients[i]);
    const shAt = (n) => {
      const out = new THREE.Vector3();
      const c = bake.sh.coefficients;
      const [x, y, z] = n;
      out.copy(c[0]).multiplyScalar(0.886227);
      out.addScaledVector(c[1], 2 * 0.511664 * y).addScaledVector(c[2], 2 * 0.511664 * z).addScaledVector(c[3], 2 * 0.511664 * x);
      out.addScaledVector(c[4], 2 * 0.429043 * x * y).addScaledVector(c[5], 2 * 0.429043 * y * z);
      out.addScaledVector(c[6], 0.743125 * z * z - 0.247708).addScaledVector(c[7], 2 * 0.429043 * x * z).addScaledVector(c[8], 0.429043 * (x * x - y * y));
      return out;
    };
    const up = shAt([0, 1, 0]);
    const dn = shAt([0, -1, 0]);
    U.uHemiSky.value.setRGB(up.x, up.y, up.z);
    U.uHemiGround.value.setRGB(dn.x, dn.y, dn.z);
    U.uHemiIntensity.value = 1;
    this.skyIrradianceUp = up;
    this.probe = new THREE.LightProbe(this.sh, 1);
    scene.add(this.probe);

    // 하늘 돔
    const geo = new THREE.SphereGeometry(20000, 48, 24);
    this.dome = new THREE.Mesh(geo, domeMaterial(1));
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    // 햇빛: 2단 캐스케이드 그림자(근거리 선명, 원거리까지 이어짐)
    this.sun = new SunLight(U.uSunColor.value.clone(), SKY.sunIlluminance);
    this.sun.position.copy(dir);
    this.sun.castShadow = true;
    const sm = quality.shadowMapSize;
    this.sun.shadow.mapSize.set(sm, sm);
    this.sun.shadow.camera.near = 2;
    this.sun.shadow.camera.far = quality.shadowDistance;
    this.sun.shadow.bias = -0.00004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = quality.shadowRadius;
    scene.add(this.sun);
    this.shadowExtent = quality.shadowDistance;
  }

  /** 무기 장면용: 같은 하늘빛 SH + 햇빛(그림자 없음) + 하늘 환경 반사 */
  setupWeaponScene(renderer, weaponScene) {
    weaponScene.add(new THREE.LightProbe(this.sh, 1));
    const wsun = new THREE.DirectionalLight(U.uSunColor.value.clone(), SKY.sunIlluminance);
    wsun.position.copy(this.dir);
    weaponScene.add(wsun);
    // PMREM: 태양 원반 없는 하늘(구름 포함)을 큐브맵으로 구워 거친 반사용으로 미리 흐림
    const bakeScene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), domeMaterial(0));
    dome.frustumCulled = false;
    bakeScene.add(dome);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(bakeScene, 0, 0.1, 100);
    weaponScene.environment = env.texture;
    weaponScene.environmentIntensity = 0.6;
    pmrem.dispose();
    dome.geometry.dispose();
    this.envRT = env;
  }

  /**
   * @param {THREE.Vector3} focus 관찰자 위치
   * @param {number} dt
   * @param {{dirX:number, dirZ:number, speed:number}} wind 지표 바람(구름은 같은 방향으로 더 빠르게)
   */
  update(focus, dt = 0, wind = null) {
    this.dome.position.set(focus.x, 0, focus.z);
    if (wind && dt > 0) {
      const v = Math.max(4, wind.speed * SKY.cumulus.speedFactor);
      U.uCloudOffset.value.x -= wind.dirX * v * dt;
      U.uCloudOffset.value.y -= wind.dirZ * v * dt;
      U.uCirrusOffset.value.x -= wind.dirX * v * 1.6 * dt;
      U.uCirrusOffset.value.y -= wind.dirZ * v * 1.6 * dt;
    }
  }
}
