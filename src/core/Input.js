// 키보드·마우스 입력. 물리 키 코드(event.code)를 써서 한글 자판에서도 동작한다.

export const KEYS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft', // 조준 중에는 숨 참기
  crouch: 'KeyC',
  prone: 'KeyZ',
  leanLeft: 'KeyQ',
  leanRight: 'KeyE',
  reload: 'KeyR',
  fireMode: 'KeyB',
  magCheck: 'KeyT',
  switchSight: 'KeyV',
  reset: 'KeyP',
  tourniquet: 'KeyH',
  debug: 'F3',
  debugAI: 'F4',
  god: 'F6', // 디버그 전용 무적(F3 화면이 켜져 있을 때만)
};

export class Input {
  constructor(element) {
    this.el = element;
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.pressTime = new Map();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = 0;
    this.buttonPressed = 0;
    this.locked = false;
    this.fallback = false;
    // 자동 시험용(?testinput): 포인터 잠금 없이 마우스 입력 허용
    this.forceLocked = new URLSearchParams(location.search).has('testinput');
    if (this.forceLocked) this.locked = true;
    this.onLockChange = null;
    this._onKeyDown = (e) => {
      if (e.code === 'F3' || e.code === 'F4' || e.code === 'F6' || e.code === 'Tab' || (this.locked && e.code === 'Space')) e.preventDefault();
      if (e.repeat) return;
      if (this.fallback && this.locked && e.code === 'Escape') {
        this._setFallbackLock(false);
        return;
      }
      if (e.code === 'ShiftRight') this._press('ShiftLeft');
      this._press(e.code);
    };
    this._onKeyUp = (e) => {
      if (e.code === 'ShiftRight') this._release('ShiftLeft');
      this._release(e.code);
    };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      const bit = 1 << e.button;
      this.buttons |= bit;
      this.buttonPressed |= bit;
      e.preventDefault();
    };
    this._onMouseUp = (e) => {
      this.buttons &= ~(1 << e.button);
    };
    this._onBlur = () => {
      this.down.clear();
      this.buttons = 0;
    };
    this._onLock = () => {
      this.locked = this.forceLocked || document.pointerLockElement === this.el;
      if (!this.locked) {
        this.down.clear();
        this.buttons = 0;
      }
      this.onLockChange?.(this.locked);
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this._onLock);
    document.addEventListener('pointerlockerror', () => this._lockFailed());
  }

  _press(code) {
    if (!this.down.has(code)) {
      this.down.add(code);
      this.pressed.add(code);
      this.pressTime.set(code, performance.now());
    }
  }
  _release(code) {
    if (this.down.has(code)) {
      this.down.delete(code);
      this.released.add(code);
    }
  }

  requestLock() {
    if (this.fallback) {
      this._setFallbackLock(true);
      return;
    }
    try {
      if (!this.el.requestPointerLock) return this._lockFailed();
      const p = this.el.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch)
        p.catch(() => {
          try {
            const q = this.el.requestPointerLock();
            if (q && q.catch) q.catch(() => this._lockFailed());
          } catch {
            this._lockFailed();
          }
        });
    } catch {
      this._lockFailed();
    }
  }

  // 포인터 잠금이 막힌 환경(공유 페이지 틀 등): 커서가 보이는 채로 마우스 이동량을 그대로 시점에 쓴다.
  _lockFailed() {
    if (document.pointerLockElement === this.el) return;
    this.fallback = true;
    this._setFallbackLock(true);
  }
  _setFallbackLock(on) {
    if (this.locked === on) return;
    this.locked = on;
    if (!on) {
      this.down.clear();
      this.buttons = 0;
    }
    this.onLockChange?.(on);
  }

  held(code) {
    return this.down.has(code);
  }
  wasPressed(code) {
    return this.pressed.has(code);
  }
  wasReleased(code) {
    return this.released.has(code);
  }
  /** 누르고 있는 시간(s), 안 누르면 0 */
  heldFor(code) {
    if (!this.down.has(code)) return 0;
    return (performance.now() - this.pressTime.get(code)) / 1000;
  }
  mouseHeld(button) {
    return (this.buttons & (1 << button)) !== 0;
  }
  mousePressed(button) {
    return (this.buttonPressed & (1 << button)) !== 0;
  }
  consumeMouse() {
    const d = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonPressed = 0;
  }
}
