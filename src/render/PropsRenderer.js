// 들판 소품 렌더링: 원형 짚 더미(곡면 = 짚 질감 + 그물 포장 끈, 끝면 = 말린 나선 무늬, 윗면은 햇볕에 바래 회색빛).
// 모양·위치는 world/Props.js의 충돌 원기둥과 같다.

import * as THREE from 'three';
import { patchMaterial } from './shaderLib.js';
import { BALE } from '../world/Props.js';

function baleGeometry() {
  const R = BALE.radius;
  const H = BALE.width * 0.5;
  const e = 0.11;
  const pts = [new THREE.Vector2(0.001, -H)];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - e + Math.sin(a) * e, -H + e - Math.cos(a) * e));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - e + Math.cos(a) * e, H - e + Math.sin(a) * e));
  }
  pts.push(new THREE.Vector2(0.001, H));
  const g = new THREE.LatheGeometry(pts, 36);
  // 회전축(Y)을 X축으로: 국소 x = 더미의 축
  g.rotateZ(-Math.PI / 2);
  return g;
}

export class PropsRenderer {
  constructor(scene, world, groundTex) {
    const bales = world.props.bales;
    this.mesh = null;
    if (!bales.length) return;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    patchMaterial(mat, {
      key: 'bale',
      uniforms: { uGroundAlb: { value: groundTex.albedo } },
      vertexHeader: 'varying vec3 vLocal;\nvarying vec3 vLocalN;\nvarying vec3 vWN;',
      vertex: /* glsl */ `
        vec3 transformed = vec3(position);
        vLocal = position;
        vLocalN = normal;
        vWN = normalize(mat3(instanceMatrix) * normal);
      `,
      fragmentHeader: 'uniform highp sampler2DArray uGroundAlb;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\nvarying vec3 vWN;',
      fragmentColor: /* glsl */ `
        float r = length(vLocal.yz);
        float ang = atan(vLocal.z, vLocal.y);
        // 곡면: 둘레 방향으로 감긴 짚 + 그물 포장 끈(가는 대각선 줄)
        vec2 uvS = vec2(vLocal.x / 1.6, ang * ${BALE.radius.toFixed(2)} / 1.6);
        vec3 aS = texture(uGroundAlb, vec3(uvS, 3.0)).rgb;
        float netA = abs(fract(vLocal.x * 7.0 + ang * 1.2) - 0.5);
        float netB = abs(fract(vLocal.x * 7.0 - ang * 1.2) - 0.5);
        float net = (1.0 - smoothstep(0.02, 0.05, min(netA, netB))) * 0.45;
        aS = mix(aS, vec3(0.7, 0.72, 0.68), net);
        // 끝면: 말려 들어간 나선 무늬
        float spiral = fract(r * 8.5 + ang / 6.2831853);
        float rings = smoothstep(0.3, 0.5, spiral) * (1.0 - smoothstep(0.5, 0.7, spiral));
        vec3 aE = texture(uGroundAlb, vec3(vec2(ang * 0.35, r * 2.2), 3.0)).rgb * (0.76 + 0.34 * rings);
        float isEnd = smoothstep(0.6, 0.85, abs(vLocalN.x));
        vec3 alb = mix(aS, aE, isEnd);
        // 햇볕에 바랜 윗면, 습기 먹은 아랫면
        float up = vWN.y;
        float l = dot(alb, vec3(0.3, 0.55, 0.15));
        alb = mix(alb, vec3(l) * vec3(1.06, 1.02, 0.92) * 1.08, smoothstep(0.2, 0.9, up) * 0.4);
        alb *= mix(0.62, 1.0, smoothstep(-0.85, -0.15, up));
        diffuseColor.rgb = alb * vColor.rgb;
      `,
    });
    mat.vertexColors = false;
    const geo = baleGeometry();
    const mesh = new THREE.InstancedMesh(geo, mat, bales.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qa = new THREE.Quaternion();
    const tint = new THREE.Color();
    for (let i = 0; i < bales.length; i++) {
      const b = bales[i];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -b.ang);
      qa.setFromAxisAngle(new THREE.Vector3(1, 0, 0), b.seed * Math.PI * 2);
      q.multiply(qa);
      m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(i, m);
      const k = 0.88 + 0.22 * ((b.seed * 7.31) % 1);
      tint.setRGB(k, k * (0.97 + 0.05 * ((b.seed * 3.7) % 1)), k * 0.95);
      mesh.setColorAt(i, tint);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    this.mesh = mesh;
  }
}
