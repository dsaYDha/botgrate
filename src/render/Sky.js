// 하늘 돔, 태양, 조명(태양 직사광 + 하늘/지면 반구광), 그림자 카메라 추적.
// 초가을 오후: 태양 고도 약 31°, 방위 약 222°(남서).

import * as THREE from 'three';
import { U, commonGLSL } from './shaderLib.js';

export const SUN = {
  elevationDeg: 31,
  azimuthDeg: 222, // 북=0, 시계방향
  color: new THREE.Color(1.0, 0.9, 0.78),
  intensity: 3.6,
  skyColor: new THREE.Color(0.56, 0.66, 0.88),
  groundColor: new THREE.Color(0.4, 0.34, 0.24),
  hemiIntensity: 0.8,
};

export function sunDirection() {
  const el = (SUN.elevationDeg * Math.PI) / 180;
  const az = (SUN.azimuthDeg * Math.PI) / 180;
  // 나침반 방위 → 월드(x 동, z 남): 수평 성분 (sin az, -cos az)
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
}

export class Sky {
  constructor(scene, quality) {
    this.scene = scene;
    const dir = sunDirection();
    U.uSunDir.value.copy(dir);
    U.uSunColor.value.copy(SUN.color);

    // 하늘 돔
    const geo = new THREE.SphereGeometry(20000, 48, 24);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...U },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        ${commonGLSL()}
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = skyColor(d);
          // 태양 원반
          float sd = dot(d, uSunDir);
          c += uSunColor * smoothstep(0.99996, 0.99999, sd) * 40.0;
          // 높은 권적운 몇 조각
          if (d.y > 0.02) {
            vec2 p = d.xz / (d.y + 0.08) * 1.6 + vec2(uTime * 0.0015, 0.0);
            float n = fbmN(p * 1.3, 4);
            float cl = smoothstep(0.58, 0.78, n) * smoothstep(0.02, 0.25, d.y);
            vec3 cc = mix(vec3(0.82, 0.84, 0.86), vec3(1.0, 0.97, 0.92), clamp(dot(d, uSunDir) * 0.5 + 0.5, 0.0, 1.0));
            c = mix(c, cc, cl * 0.75);
          }
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    // 조명
    this.sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
    this.sun.position.copy(dir).multiplyScalar(200);
    this.sun.castShadow = true;
    const sm = quality.shadowMapSize;
    this.sun.shadow.mapSize.set(sm, sm);
    const ext = quality.shadowExtent;
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.shadowExtent = ext;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(SUN.skyColor, SUN.groundColor, SUN.hemiIntensity);
    scene.add(this.hemi);
    this.dir = dir;
  }

  /** 그림자 카메라를 관찰자 주변에 맞추되 텍셀 단위로 고정해 떨림 방지 */
  update(focus) {
    const ext = this.shadowExtent;
    const texel = (2 * ext) / this.sun.shadow.mapSize.x;
    // 빛 공간 기저
    const d = this.dir;
    const up = Math.abs(d.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, d).normalize();
    const up2 = new THREE.Vector3().crossVectors(d, right).normalize();
    let a = focus.dot(right);
    let b = focus.dot(up2);
    const c = focus.dot(d);
    a = Math.round(a / texel) * texel;
    b = Math.round(b / texel) * texel;
    const center = new THREE.Vector3().addScaledVector(right, a).addScaledVector(up2, b).addScaledVector(d, c);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(d, 250);
    this.sun.target.updateMatrixWorld();
    this.dome.position.set(focus.x, 0, focus.z);
  }
}
