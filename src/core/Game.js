import * as THREE from 'three';
import { World } from '../world/World.js';
import { Sky } from '../render/Sky.js';
import { Post } from '../render/Post.js';
import { TerrainRenderer } from '../render/TerrainRenderer.js';
import { TreeRenderer } from '../render/TreeRenderer.js';
import { VegetationRenderer } from '../render/VegetationRenderer.js';
import { DistantScenery } from '../render/DistantScenery.js';
import { PropsRenderer } from '../render/PropsRenderer.js';
import { AtmosphereFX } from '../effects/AtmosphereFX.js';
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
import { PlayerBody } from '../player/PlayerBody.js';
import { PlayerHealth } from '../player/PlayerHealth.js';
import { Effects } from '../effects/Effects.js';
import { AudioEngine } from '../audio/AudioEngine.js';

// 노출(AgX 톤매핑 전 곱). 하늘 모델의 렌더 단위에 맞춘 값
const EXPOSURE = 1.05;

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
    // 후처리를 쓰면 MSAA는 HDR 렌더 타깃에서 하므로 화면 버퍼는 단일 샘플
    const renderer = new THREE.WebGLRenderer({ antialias: !this.quality.post, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1) * this.quality.pixelRatio);
    // 표시 크기는 CSS(화면 가득)가 정하고, 그리기 버퍼만 맞춘다(틀 크기가 바뀌어도 빈 공간이 생기지 않게)
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    this._vw = window.innerWidth;
    this._vh = window.innerHeight;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.post = new Post(renderer, this.quality);

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
    this.sky.setupWeaponScene(renderer, this.weaponScene);
    this.terrainRenderer = new TerrainRenderer(this.scene, this.quality.terrainLevels);
    this.propsRenderer = new PropsRenderer(this.scene, this.world, this.terrainRenderer.groundTex);
    await step('나무를 심는 중…');
    this.trees = new TreeRenderer(this.scene, this.world, this.quality, renderer);
    this.vegetation = new VegetationRenderer(this.scene, this.world, this.quality);
    this.distant = new DistantScenery(this.scene, (x, z) => baseHeight(x, z, this.world.data.terrain), this.trees.impostorInfo);
    this.atmosphere = new AtmosphereFX(this.scene, this.world);


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
    this.restMark = document.getElementById('rest-mark');
    this.effects = new Effects(this.scene, this.world, this.events, this.audio);

    await step('적을 배치하는 중…');
    // 플레이어의 몸(그리지 않음): 적 탄 판정·적 시각의 표적
    this.playerBody = new PlayerBody();
    this.player.eye(this.eyePos);
    this.playerBody.update(this.player, this.eyePos);
    this.enemies = new EnemyManager(this.scene, this.world, this.events, this.bullets, { player: this.player, body: this.playerBody, weapon: this.weapon });
    this.bullets.listener = () => this.eyePos;
    this.bullets.addTargetProvider((x0, y0, z0, dx, dy, dz, hits, b) => {
      if (b && b.shooter === 'player') return;
      this.playerBody.intersect(x0, y0, z0, dx, dy, dz, hits, this.playerTarget);
    });
    this.playerTarget = {
      onBulletHit: (info) => this.onPlayerHit(info),
    };
    this.health = new PlayerHealth(this);
    this.player.health = this.health;
    this.weapon.health = this.health;
    this.bodyOverlay = this.quality.post ? null : document.getElementById('body-overlay');
    this.endscreen = document.getElementById('endscreen');
    this._trackStats();
    this.events.on('player:cannotStand', () => this.toast.show('다쳐서 일어설 수 없다 — 엎드려 기고 쏠 수만 있다'));
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
    this.health.reset();
    this.playerBody.alive = true;
    this.enemies.reset();
    this.bullets.bullets.length = 0;
    this.stats = { start: -1, shots: 0, hits: 0, enemyShots: 0, end: -1 };
    this.endscreen.classList.add('hidden');
    this._endShown = false;
    this._endAt = -1;
    if (this.settings.get('windMode') === 'random') this.world.wind.randomize(rng);
    this.toast.show('시나리오 초기화');
  }

  start() {
    this.last = performance.now();
    const loop = (t) => {
      requestAnimationFrame(loop);
      if (this.frozen) return; // 스크린샷 도구가 프레임을 직접 그릴 때
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
    if (inp.wasPressed(KEYS.debugAI)) this.debug.toggleAI();
    if (inp.wasPressed(KEYS.reset)) this.reset();
    if (inp.wasPressed(KEYS.tourniquet)) this.health.toggleTourniquet();
    if (inp.wasPressed(KEYS.god) && this.debug.visible) {
      this.health.godMode = !this.health.godMode;
      this.toast.show(`디버그 무적: ${this.health.godMode ? '켜짐' : '꺼짐'}`);
    }

    // 플레이어·무기
    this.player.update(dt, { ads: this.weapon.ads, adsHeld: this.weapon.adsWanted, lookDX: mdx, lookDY: mdy, zoom: this.zoom });
    this.weapon.update(dt, this.time);
    this.player.eye(this.eyePos);
    this.playerBody.update(this.player, this.eyePos);
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
    if (wm.sight !== this.weapon.sightKey || wm.apertureD !== this.weapon.apertureDiameter) wm.setSight(this.weapon.sightKey, this.weapon.apertureDiameter);
    wm.root.position.copy(pose.weaponPos);
    wm.root.quaternion.copy(pose.weaponQuat);
    wm.animate(this.weapon.anim);
    wm.setAds(this.weapon.adsEased);
    const opticAlpha = S.type === 'optic' ? smoothstep(0.82, 0.98, a) : 0;
    wm.root.visible = opticAlpha < 0.6 && !this.debugCam;
    // 철제 조준기: 눈이 가늠쇠에 초점 → 먼 풍경이 약간 흐림
    this._focus = S.type === 'iron' && !this.debugCam ? smoothstep(0.45, 1, a) * 0.85 : 0;
    // 거치 표시(아주 작게)
    const restOn = !!this.weapon.rest && a > 0.5 && !this.debugCam;
    if (restOn !== this._restShown) {
      this._restShown = restOn;
      this.restMark.classList.toggle('hidden', !restOn);
    }

    // 몸 상태(부상·출혈·제압)
    this.health.update(dt);
    // 맞거나 탄이 스칠 때 짧은 움찔(카메라)
    if (Math.abs(this.health.flinchP) + Math.abs(this.health.flinchY) > 1e-5) {
      const fq = this._fq || (this._fq = new THREE.Quaternion());
      fq.setFromEuler(new THREE.Euler(this.health.flinchP, this.health.flinchY, 0, 'YXZ'));
      cam.quaternion.multiply(fq);
      cam.updateMatrixWorld();
      this.weaponCamera.quaternion.copy(cam.quaternion);
      this.weaponCamera.updateMatrixWorld();
    }
    // 세계
    this.enemies.update(dt);
    this.bullets.update(dt, this.time);
    this.effects.update(dt, this.time);

    // 렌더 준비
    this.sky.update(this.eyePos, dt, this.world.wind);
    this.terrainRenderer.update(cam.position);
    this.trees.update(cam, this.zoom, this.eyePos, this.sky.shadowExtent);
    this.vegetation.update(cam, this.zoom);
    this.atmosphere.update(dt, this.time, cam, this.renderer.domElement.height);

    // 소리
    this.audio.update(dt, cam.position, cam.quaternion, this.time);
    this._breathing();
    // 심장 박동: 피를 잃었거나 몹시 긴장했을 때만 들린다
    const h = this.health;
    const hbI = h.alive ? Math.max((1 - h.blood) / 0.4, h.supp - 0.35, (this.player.heart - 145) / 40, h.lungTimer >= 0 ? 0.8 : 0) : 0;
    this.audio.heartbeatTick(dt, this.player.heart, hbI);

    // 조준경: 눈이 광축에서 벗어난 정도(아이박스 대비) → 가장자리 그림자·좁아지는 시야
    const kick = this.weapon.aim.modelKick;
    const eyeBox = S.eyeBox || 0.006;
    this.optic.draw({
      alpha: this.debugCam ? 0 : opticAlpha,
      fovDeg: fov,
      trueFovDeg: S.trueFovDeg || 7,
      bdc: this.weapon.bdc,
      eyeX: this.weapon.aim.eyeOff.x / eyeBox + this.weapon.obs.yaw * 20,
      eyeY: this.weapon.aim.eyeOff.y / eyeBox - kick * 25,
    });
    this._checkEnd();
    inp.endFrame();
  }

  /** 교전 통계(결과 화면용 — 게임 중에는 보이지 않는다) */
  _trackStats() {
    this.stats = { start: -1, shots: 0, hits: 0, enemyShots: 0, end: -1 };
    this.events.on('shot', (e) => {
      if (this.stats.start < 0) this.stats.start = this.time;
      if (e.shooter === 'player') this.stats.shots++;
      else this.stats.enemyShots++;
    });
    this.events.on('bullet:impact', (e) => {
      if (e.kind === 'body' && e.shooter === 'player' && e.target && e.target.id) this.stats.hits++;
    });
    this.events.on('engagement:end', () => {
      if (this._endAt < 0) this._endAt = this.time + 4;
    });
    this.events.on('player:dead', () => {
      if (this._endAt < 0) this._endAt = this.time + 3;
    });
    this._endAt = -1;
  }

  _checkEnd() {
    if (this._endShown || this._endAt < 0 || this.time < this._endAt) return;
    this._endShown = true;
    const st = this.stats;
    const h = this.health;
    const c = this.enemies.counts || { down: 0, withdrawn: 0, total: 0 };
    const dur = st.start >= 0 ? this.time - st.start : 0;
    const mmss = (t) => `${Math.floor(t / 60)}분 ${Math.floor(t % 60)}초`;
    const lines = [];
    if (!h.alive) lines.push(...h.debrief(), '');
    lines.push(`교전 시간 ${mmss(dur)}`);
    lines.push(`발사 ${st.shots}발, 적에게 명중 ${st.hits}발${st.shots ? ` (${Math.round((st.hits / st.shots) * 100)} %)` : ''}`);
    lines.push(`무력화한 적 ${c.down}명 / 철수한 적 ${c.withdrawn}명 / 전체 ${c.total}명`);
    const ws = h.wounds.map((w) => `${w.name}${w.tq ? '(지혈대)' : ''}`);
    // 즉사가 아니면 '전투 불능'(출혈·폐 손상으로 쓰러짐 — 처치 없이는 살기 어렵지만 그 자리에서 죽은 것은 아니다)
    const killed = !h.alive && (!h.fatal || h.fatal.cause === '즉사');
    const down = !h.alive ? (killed ? '사망' : `전투 불능 — ${h.fatal.cause}`) : null;
    lines.push(`플레이어: ${down || (ws.length ? `부상 — ${ws.join(', ')}` : '다치지 않음')}`);
    document.getElementById('end-title').textContent = !h.alive ? (killed ? '전사' : '전투 불능') : '교전 종료';
    document.getElementById('end-text').textContent = lines.join('\n');
    this.endscreen.classList.remove('hidden');
  }

  /** 플레이어 피격(부상 모델은 PlayerHealth) */
  onPlayerHit(info) {
    if (this.health) this.health.onHit(info);
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
    // 빛줄기: 해의 화면 위치(카메라 앞쪽일 때만)
    const sd = U.uSunDir.value;
    const sp = this._sunP || (this._sunP = new THREE.Vector3());
    sp.copy(this.camera.position).addScaledVector(sd, 1000).project(this.camera);
    const fwd = this._fwd || (this._fwd = new THREE.Vector3());
    this.camera.getWorldDirection(fwd);
    this.post.setSun(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5, Math.max(0, fwd.dot(sd)));
    r.setRenderTarget(this.post.target);
    r.clear();
    r.render(this.scene, this.camera);
    this.post.computeAO(this.camera);
    this.post.focusBlur(this._focus || 0, 2.6 * (this.renderer.domElement.height / 1080));
    r.setRenderTarget(this.post.target);
    if (this.weaponModel.root.visible) {
      r.clearDepth();
      r.render(this.weaponScene, this.weaponCamera);
    }
    this.post.finish();
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
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.setSize(size.x, size.y);
  }
}
