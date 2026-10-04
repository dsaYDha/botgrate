// 손끝 감각을 대신하는 짧은 문구(조정간 위치, 탄창 확인 결과 등). 숫자 UI가 아니다.
export class Toast {
  constructor(el) {
    this.el = el;
    this.timer = null;
  }
  show(msg, ms = 1700) {
    this.el.textContent = msg;
    this.el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.el.classList.remove('show'), ms);
  }
}
