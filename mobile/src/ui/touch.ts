import { h } from './dom';

/**
 * 触屏控件：虚拟摇杆、油门滑杆、按住生效的按钮，以及画面上的单指旋转 / 双指缩放手势。
 * 全部基于 Pointer Events + setPointerCapture，因此可以多指同时操作（例如一手推油门、一手拨摇杆）。
 */

/** 虚拟摇杆：输出 x（右为正）与 y（下为正），范围 -1..1，松手自动回中。 */
export class Joystick {
  el: HTMLDivElement;
  x = 0;
  y = 0;
  active = false;
  private knob: HTMLDivElement;
  private pid: number | null = null;
  onStart: () => void = () => {};

  constructor(label = '') {
    this.knob = h('div', { class: 'stick-knob' });
    this.el = h('div', { class: 'stick' }, h('div', { class: 'stick-cross' }), label ? h('div', { class: 'stick-lbl' }, label) : null, this.knob);
    const move = (e: PointerEvent) => {
      const r = this.el.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - (r.left + R)) / (R * 0.72);
      let dy = (e.clientY - (r.top + R)) / (R * 0.72);
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      this.knob.style.transform = `translate(${dx * R * 0.72}px, ${dy * R * 0.72}px)`;
      // 死区 + 二次曲线：中间细调，推到底全力
      const shape = (v: number) => {
        const a = Math.abs(v);
        if (a < 0.12) return 0;
        const t = (a - 0.12) / 0.88;
        return Math.sign(v) * t * (0.35 + 0.65 * t);
      };
      this.x = shape(dx);
      this.y = shape(dy);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pid) return;
      this.pid = null;
      this.active = false;
      this.x = 0;
      this.y = 0;
      this.knob.style.transform = '';
      this.el.classList.remove('on');
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (this.pid !== null) return;
      e.preventDefault();
      this.pid = e.pointerId;
      this.el.setPointerCapture(e.pointerId);
      this.active = true;
      this.el.classList.add('on');
      this.onStart();
      move(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pid) move(e);
    });
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);
  }

  reset(): void {
    this.pid = null;
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = '';
    this.el.classList.remove('on');
  }
}

/** 按住生效的按钮（例如滚转）。 */
export class HoldButton {
  el: HTMLButtonElement;
  down = false;
  private pid: number | null = null;

  constructor(label: string, cls = '') {
    this.el = h('button', { class: `hold ${cls}` }, label);
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pid) return;
      this.pid = null;
      this.down = false;
      this.el.classList.remove('on');
    };
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.pid = e.pointerId;
      this.el.setPointerCapture(e.pointerId);
      this.down = true;
      this.el.classList.add('on');
    });
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset(): void {
    this.pid = null;
    this.down = false;
    this.el.classList.remove('on');
  }
}

/** 竖直油门滑杆：按住拖动设定 0..1，相对拖动（按下的位置不会让油门跳变）。 */
export class ThrottleSlider {
  el: HTMLDivElement;
  private fill: HTMLDivElement;
  private thumb: HTMLDivElement;
  private label: HTMLDivElement;
  private pid: number | null = null;
  private startY = 0;
  private startV = 0;
  onInput: (v: number) => void = () => {};
  get: () => number = () => 0;

  constructor() {
    this.fill = h('div', { class: 'thr-fill' });
    this.thumb = h('div', { class: 'thr-thumb' });
    this.label = h('div', { class: 'thr-val' });
    const track = h('div', { class: 'thr-track' }, this.fill, this.thumb);
    this.el = h('div', { class: 'thr' }, track, this.label);
    const move = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const v = this.startV - (e.clientY - this.startY) / r.height;
      this.onInput(Math.max(0, Math.min(1, v)));
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.pid = e.pointerId;
      track.setPointerCapture(e.pointerId);
      const r = track.getBoundingClientRect();
      const cur = this.get();
      const thumbY = r.bottom - cur * r.height;
      // 点在滑块附近：相对拖动；点在别处：直接跳到该位置
      if (Math.abs(e.clientY - thumbY) > 28) {
        const v = Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height));
        this.onInput(v);
        this.startV = v;
      } else this.startV = cur;
      this.startY = e.clientY;
      track.classList.add('on');
    });
    track.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pid) move(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pid) return;
      this.pid = null;
      track.classList.remove('on');
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  update(v: number): void {
    const pct = `${(v * 100).toFixed(1)}%`;
    this.fill.style.height = pct;
    this.thumb.style.bottom = pct;
    const t = `${Math.round(v * 100)}%`;
    if (this.label.textContent !== t) this.label.textContent = t;
  }
}

export interface GestureHandlers {
  rotate(dx: number, dy: number): void;
  /** factor > 1 表示拉远 */
  zoom(factor: number): void;
  enabled(): boolean;
}

/** 画面手势：单指拖动旋转视角，双指捏合缩放（同时双指平移也会旋转）。 */
export function bindCanvasGestures(el: HTMLElement, g: GestureHandlers): void {
  const pts = new Map<number, { x: number; y: number }>();
  let lastDist = 0;
  let lastMid = { x: 0, y: 0 };
  const mid = () => {
    const a = [...pts.values()];
    return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
  };
  const dist = () => {
    const a = [...pts.values()];
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  };
  el.addEventListener('pointerdown', (e) => {
    if (!g.enabled()) return;
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      lastDist = dist();
      lastMid = mid();
    }
  });
  el.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p || !g.enabled()) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size === 1) {
      g.rotate(dx, dy);
    } else if (pts.size === 2) {
      const d = dist();
      const m = mid();
      if (lastDist > 10 && d > 10) g.zoom(lastDist / d);
      g.rotate((m.x - lastMid.x) * 0.5, (m.y - lastMid.y) * 0.5);
      lastDist = d;
      lastMid = m;
    }
  });
  const end = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size === 2) {
      lastDist = dist();
      lastMid = mid();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener(
    'wheel',
    (e) => {
      if (!g.enabled()) return;
      g.zoom(Math.exp(e.deltaY * 0.0012));
      e.preventDefault();
    },
    { passive: false },
  );
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** 轻微震动反馈（仅部分安卓浏览器支持；iOS 会静默忽略）。 */
export function haptic(ms: number | number[]): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* 忽略 */
  }
}
