import * as THREE from 'three';
import { World } from '../world/World.js';
import { Sky, SUN } from '../render/Sky.js';
import { TerrainRenderer } from '../render/TerrainRenderer.js';
import { TreeRenderer } from '../render/TreeRenderer.js';
import { VegetationRenderer } from '../render/VegetationRenderer.js';
import { DistantScenery } from '../render/DistantScenery.js';
import { baseHeight } from '../world/Terrain.js';
import { U } from '../render/shaderLib.js';
import { QUALITY } from '../data/quality.js';
import { DEFAULT_WEAPON } from '../data/weapons.js';
import { Settings } from '../ui/Settings.js';
import { Menu } from '../ui/Menu.js';
import { Toast } from '../ui/Toast.js';
import { DebugOverlay } from '../ui/DebugOverlay.js';
import { Input, KEYS } from './Input.js';
import { EventBus } from './EventBus.js';
import { rng } from './Random.js';
import { smoothstep, lerp } from './math.js';
import { Player } from '../player/Player.js';
import { WeaponSystem } from '../weapon/WeaponSystem.js';
import { WeaponModel } from '../weapon/WeaponModel.js';
import { OpticOverlay } from '../weapon/OpticOverlay.js';
import { BulletSystem } from '../physics/BulletSystem.js';
import { EnemyManager } from '../enemies/EnemyManager.js';
import { Effects } from '../effects/Effects.js';
import { AudioEngine } from '../audio/AudioEngine.js';

export class Game {
  constructor(container, progress) {
    this.container = container;
    this.progress = progress || (() => {});
    this.settings = new Settings();
    this.quality = QUALITY[this.settings.get('quality')] || QUALITY.medium;
    this.events = new EventBus();
    this.time = 0;
    this.paused = true;
    this.started = false;
    this.zoom = 1;
    this.eyePos = new THREE.Vector3();
    this.params = new URLSearchParams(location.search);
  }

  async init() {
    const step = async (msg) => {
      this.progress(msg);
      await new Promise((r) => setTimeout(r, 0));
    };
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1) * this.quality.pixelRatio);
    // 표시 크기는 CSS(화면 가득)가 정하고, 그리기 버퍼만 맞춘다(틀 크기가 바뀌어도 빈 공간이 생기지 않게)
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    this._vw = window.innerWidth;
    this._vh = window.innerHeight;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.get('fov'), window.innerWidth / window.innerHeight, 0.12, 30000);
    this.weaponScene = new THREE.Scene();
    this.weaponCamera = new THREE.PerspectiveCamera(this.settings.get('fov'), window.innerWidth / window.innerHeight, 0.01, 6);

    await step('지형과 방풍림을 만드는 중…');
    this.world = new World();
    this.world.time = 0;
    console.info(`[world] build ${this.world.buildMs.toFixed(0)} ms, trees ${this.world.belts.trees.length}, shrubs ${this.world.belts.shrubs.length}`);

    await step('하늘과 지형을 준비하는 중…');
    this.sky = new Sky(this.scene, this.quality);
    this.terrainRenderer = new TerrainRenderer(this.scene, this.quality.terrainLevels);
    await step('나무를 심는 중…');
    this.trees = new TreeRenderer(this.scene, this.world, this.quality);
    this.sky.sun.shadow.camera.layers.enable(1);
    this.vegetation = new VegetationRenderer(this.scene, this.quality);
    this.distant = new DistantScenery(this.scene, (x, z) => baseHeight(x, z, this.world.data.terrain));

    // 무기 장면 조명(본 장면과 같은 태양·하늘빛)
    const wsun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
    wsun.position.copy(this.sky.dir);
    this.weaponScene.add(wsun);
    this.weaponScene.add(new THREE.HemisphereLight(SUN.skyColor, SUN.groundColor, SUN.hemiIntensity));

    await step('사수와 소총을 준비하는 중…');
    this.input = new Input(renderer.domElement);
    this.toast = new Toast(document.getElementById('toast'));
    const toast = (m) => this.toast.show(m);
    this.audio = new AudioEngine(this.events, this.world, this.settings);
    this.bullets = new BulletSystem(this.world, this.events);
    this.player = new Player(this.world, this.input, this.settings, this.events);
    this.weapon = new WeaponSystem({
      weaponId: DEFAULT_WEAPON,
      player: this.player,
      world: this.world,
      bullets: this.bullets,
      events: this.events,
      settings: this.settings,
      input: this.input,
      toast,
    });
    this.weaponModel = new WeaponModel(this.weapon.data);
    this.weaponScene.add(this.weaponModel.root);
    this.optic = new OpticOverlay(document.getElementById('optic'));
    this.effects = new Effects(this.scene, this.world, this.events, this.audio);

    await step('적을 배치하는 중…');
    this.enemies = new EnemyManager(this.scene, this.world, this.events, this.bullets);
    this.bullets.listener = () => this.eyePos;
    this.debug = new DebugOverlay(document.getElementById('debug'), this.scene, this.events);

    // 바람
    this._applyWind(true);
    this.settings.onChange((k, v) => {
      if (k === 'windMode' || k === 'windSpeed' || k === 'windDir') this._applyWind(false);
      if (k === 'fov') this.baseFov = v;
      if (k === 'quality') this.toast.show('그래픽 품질은 새로고침하면 적용됩니다');
    });
    this.baseFov = this.settings.get('fov');

    // 메뉴·포인터 잠금
    this.menu = new Menu(this.settings, () => this.startPlay());
    this.input.onLockChange = (locked) => {
      if (!locked && this.started && !this.autostart) this.pause();
    };
    window.addEventListener('resize', () => this.onResize());
    this.autostart = this.params.has('autostart');
    if (this.autostart) {
      this.started = true;
      this.paused = false;
      this.menu.hide();
    } else this.menu.show(false);

    // 디버그 카메라(?cam=x,y,z,yaw,pitch,fov) — 스크린샷 확인용
    const cam = this.params.get('cam');
    if (cam) {
      const [x, y, z, yaw, pitch, fov] = cam.split(',').map(Number);
      this.debugCam = { x, y, z, yaw: (yaw * Math.PI) / 180, pitch: (pitch * Math.PI) / 180, fov: fov || this.baseFov };
    }
    this.ready = true;
  }

  _applyWind(initial) {
    const w = this.world.wind;
    if (this.settings.get('windMode') === 'fixed') w.set(this.settings.get('windSpeed'), this.settings.get('windDir'));
    else if (initial || this._windRandomized !== true) {
      w.randomize(rng);
      this._windRandomized = true;
    }
  }

  startPlay() {
    if (!this.audio.ready) this.audio.init();
    this.audio.resume();
    this.input.requestLock();
    this.menu.hide();
    this.paused = false;
    this.started = true;
  }

  pause() {
    this.paused = true;
    this.audio.suspend();
    this.menu.show(true);
  }

  reset() {
    this.player.reset();
    this.weapon.reset();
    this.enemies.reset();
    this.bullets.bullets.length = 0;
    if (this.settings.get('windMode') === 'random') this.world.wind.randomize(rng);
    this.toast.show('시나리오 초기화');
  }

  start() {
    this.last = performance.now();
    const loop = (t) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0, (t - this.last) / 1000));
      this.last = t;
      if (!this.paused) this.update(dt);
      else this.updatePaused();
      this.render();
      this.debug.update(dt, this);
    };
    requestAnimationFrame(loop);
  }

  /** 시험용: 렌더 없이 시뮬레이션을 빨리 진행 */
  simulate(seconds, step = 1 / 60) {
    const n = Math.round(seconds / step);
    for (let i = 0; i < n; i++) this.update(step);
  }

  updatePaused() {
    this.input.consumeMouse();
    this.input.endFrame();
  }

  update(dt) {
    this.time += dt;
    this.world.time = this.time;
    U.uTime.value = this.time;
    this.world.syncWind(this.time);
    const inp = this.input;
    const [mdx, mdy] = inp.consumeMouse();
    if (inp.wasPressed(KEYS.debug)) this.debug.toggle();
    if (inp.wasPressed(KEYS.reset)) this.reset();

    // 플레이어·무기
    this.player.update(dt, { ads: this.weapon.ads, adsHeld: this.weapon.adsWanted, lookDX: mdx, lookDY: mdy, zoom: this.zoom });
    this.weapon.update(dt, this.time);
    this.player.eye(this.eyePos);
    const pose = this.weapon.computePose(this.eyePos, this.player.yaw, this.player.pitch, this.player.roll, dt);
    const cam = this.camera;
    if (this.debugCam) {
      const c = this.debugCam;
      cam.position.set(c.x, c.y, c.z);
      cam.quaternion.setFromEuler(new THREE.Euler(c.pitch, -c.yaw, 0, 'YXZ'));
    } else {
      cam.position.copy(pose.camPos);
      cam.quaternion.copy(pose.camQuat);
    }
    // 시야각: 조준(철제) 시 '1배율 기준 시야각'(모니터의 실제 각도 → 실물 크기),
    // 4배율 광학은 그 기준의 정확히 4배. 비조준 시는 사용자 시야각(주변 시야).
    const base = this.debugCam ? this.debugCam.fov : this.baseFov;
    const real = Math.min(base, this.settings.get('realFov') || 34);
    const S = this.weapon.sight;
    let fov = base;
    const a = this.weapon.adsEased;
    const tb = Math.tan((base * Math.PI) / 360);
    const tr = Math.tan((real * Math.PI) / 360);
    if (S.type === 'optic') {
      const k = smoothstep(0.55, 1.0, a);
      fov = (Math.atan(lerp(tb, tr / S.magnification, k)) * 360) / Math.PI;
    } else fov = (Math.atan(lerp(tb, tr, smoothstep(0, 1, a))) * 360) / Math.PI;
    if (Math.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this.zoom = Math.tan((this.baseFov * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
    this.weaponCamera.position.copy(cam.position);
    this.weaponCamera.quaternion.copy(cam.quaternion);
    if (this.weaponCamera.fov !== fov || this.weaponCamera.aspect !== cam.aspect) {
      this.weaponCamera.fov = fov;
      this.weaponCamera.aspect = cam.aspect;
      this.weaponCamera.updateProjectionMatrix();
    }
    this.weaponCamera.updateMatrixWorld();

    // 무기 모델
    const wm = this.weaponModel;
    if (wm.sight !== this.weapon.sightKey) wm.setSight(this.weapon.sightKey);
    wm.root.position.copy(pose.weaponPos);
    wm.root.quaternion.copy(pose.weaponQuat);
    wm.animate(this.weapon.anim);
    wm.setAds(this.weapon.adsEased);
    const opticAlpha = S.type === 'optic' ? smoothstep(0.82, 0.98, a) : 0;
    wm.root.visible = opticAlpha < 0.6 && !this.debugCam;

    // 세계
    this.enemies.update(dt);
    this.bullets.update(dt, this.time);
    this.effects.update(dt, this.time);

    // 렌더 준비
    this.sky.update(this.eyePos);
    this.terrainRenderer.update(cam.position);
    this.trees.update(cam, this.zoom, this.eyePos, this.sky.shadowExtent);
    this.vegetation.update(cam, this.zoom);

    // 소리
    this.audio.update(dt, cam.position, cam.quaternion, this.time);
    this._breathing();

    // 조준경
    const kick = this.weapon.aim.modelKick;
    this.optic.draw({
      alpha: this.debugCam ? 0 : opticAlpha,
      fovDeg: fov,
      trueFovDeg: S.trueFovDeg || 7,
      bdc: this.weapon.bdc,
      offsetX: this.weapon.aim.cameraShakeRoll * 900 + this.weapon.obs.yaw * 300,
      offsetY: -kick * 700 + this.weapon.aim.cameraShakePitch * 600,
    });
    inp.endFrame();
  }

  _breathing() {
    const p = this.player;
    if (this.weapon.aim.hold.active) return;
    const ph = this.weapon.aim.breathPhase % 1;
    const prev = this._lastBreathPh ?? ph;
    this._lastBreathPh = ph;
    if (prev > ph) this.audio.breathe(true, p.exertion);
    else if (prev < 0.42 && ph >= 0.42) this.audio.breathe(false, p.exertion);
  }

  render() {
    // 공유 페이지 틀처럼 resize 이벤트 없이 크기가 바뀌는 경우도 매 프레임 확인
    if (window.innerWidth !== this._vw || window.innerHeight !== this._vh) this.onResize();
    const r = this.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);
    if (this.weaponModel.root.visible) {
      r.clearDepth();
      r.render(this.weaponScene, this.weaponCamera);
    }
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!w || !h) return;
    this._vw = w;
    this._vh = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.weaponCamera.aspect = w / h;
    this.weaponCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }
}
