import * as THREE from 'three';

interface Label {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  rot: number | null;
}

/** 投影到屏幕上的 HTML 标签（对象池，避免每帧创建 DOM）。 */
export class ScreenLabels {
  private labels: Label[] = [];
  private pool: HTMLDivElement[] = [];
  private v = new THREE.Vector3();
  constructor(private container: HTMLElement) {}

  begin(): void {
    for (const l of this.labels) {
      l.el.style.display = 'none';
      this.pool.push(l.el);
    }
    this.labels = [];
  }

  /** pos：世界坐标（浮动原点系）；rot：可选的旋转角（度，顺时针），用于箭头类图标。 */
  add(pos: THREE.Vector3, html: string, cls: string, rot: number | null = null): void {
    const el = this.pool.pop() ?? document.createElement('div');
    if (!el.parentElement) this.container.appendChild(el);
    const c = `map-marker ${cls}`;
    if (el.className !== c) el.className = c;
    if (el.innerHTML !== html) el.innerHTML = html;
    this.labels.push({ el, pos: pos.clone(), rot });
  }

  layout(camera: THREE.Camera, w: number, h: number): void {
    const v = this.v;
    for (const l of this.labels) {
      v.copy(l.pos).project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) {
        l.el.style.display = 'none';
        continue;
      }
      l.el.style.display = 'block';
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (l.rot !== null) {
        const icon = l.el.firstElementChild as HTMLElement | null;
        if (icon) icon.style.transform = `rotate(${l.rot.toFixed(1)}deg)`;
      }
    }
  }

  dispose(): void {
    for (const l of this.labels) l.el.remove();
    for (const el of this.pool) el.remove();
    this.labels = [];
    this.pool = [];
  }
}
