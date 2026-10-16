import * as THREE from 'three';

/** 方向轴上的一根轴：正方向画实线和实心圆，负方向画空心圆。 */
export interface GizmoAxis {
  /** 世界坐标中的方向（单位向量） */
  dir: THREE.Vector3;
  label: string;
  /** 负方向的标签（为空时只画圆） */
  negLabel?: string;
  color: string;
}

/** 方向轴端点在屏幕上的位置（CSS 像素，相对画布左上角）；depth > 0 表示朝向观察者。 */
export interface GizmoEnd {
  x: number;
  y: number;
  depth: number;
  axis: number;
  sign: 1 | -1;
}

/**
 * 把各轴的正负两端投影到方向轴画布上（从远到近排序，便于按顺序绘制遮挡关系）。
 * camQ 为相机朝向：相机局部 +X 为屏幕右、+Y 为屏幕上、+Z 指向观察者。
 */
export function projectGizmo(axes: GizmoAxis[], camQ: THREE.Quaternion, size: number, radius: number): GizmoEnd[] {
  const inv = camQ.clone().invert();
  const v = new THREE.Vector3();
  const c = size / 2;
  const out: GizmoEnd[] = [];
  axes.forEach((a, i) => {
    v.copy(a.dir).normalize().applyQuaternion(inv);
    for (const sign of [1, -1] as const) out.push({ x: c + sign * v.x * radius, y: c - sign * v.y * radius, depth: sign * v.z, axis: i, sign });
  });
  return out.sort((p, q) => p.depth - q.depth);
}

const SIZE = 88;
const RADIUS = 30;
const END_R = 9;

/**
 * 方向轴：画面角落里随视角转动的小坐标轴（类似三维软件的视图方位指示器），
 * 一眼就能看出屏幕上哪边是东、哪边是北、哪边朝上。点击某个轴端，相机转到从该方向看过去。
 */
export class AxisGizmo {
  el: HTMLDivElement;
  /** 点击轴端：dir 为该轴端的世界方向（相机要移到这一侧） */
  onPick: (dir: THREE.Vector3) => void = () => {};
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private axes: GizmoAxis[] = [];
  private ends: GizmoEnd[] = [];
  private hover: GizmoEnd | null = null;
  private sig = '';
  private dpr = 0;

  constructor(title = '') {
    this.el = document.createElement('div');
    this.el.className = 'axis-gizmo';
    this.el.title = title;
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = this.canvas.style.height = `${SIZE}px`;
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const pick = (e: PointerEvent): GizmoEnd | null => {
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * SIZE;
      const y = ((e.clientY - r.top) / r.height) * SIZE;
      // 从近到远找第一个命中的端点（近处的盖住远处的）
      for (let i = this.ends.length - 1; i >= 0; i--) {
        const p = this.ends[i];
        if (Math.hypot(p.x - x, p.y - y) <= END_R + 2) return p;
      }
      return null;
    };
    this.canvas.addEventListener('pointermove', (e) => {
      const p = pick(e);
      if (p !== this.hover) {
        this.hover = p;
        this.canvas.style.cursor = p ? 'pointer' : '';
        this.sig = '';
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.sig = '';
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const p = pick(e);
      if (!p) return;
      this.onPick(this.axes[p.axis].dir.clone().normalize().multiplyScalar(p.sign));
    });
  }

  setTitle(t: string): void {
    if (this.el.title !== t) this.el.title = t;
  }

  /** 每帧调用：视角或坐标轴没有明显变化时不重画。 */
  update(camQ: THREE.Quaternion, axes: GizmoAxis[]): void {
    this.axes = axes;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const r = (x: number) => x.toFixed(3);
    const inv = camQ.clone().invert();
    const v = new THREE.Vector3();
    let sig = `${dpr}|${this.hover ? `${this.hover.axis}${this.hover.sign}` : ''}`;
    for (const a of axes) {
      v.copy(a.dir).applyQuaternion(inv);
      sig += `|${a.label}${r(v.x)},${r(v.y)},${r(v.z)}`;
    }
    if (sig === this.sig) return;
    this.sig = sig;
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.canvas.width = this.canvas.height = Math.round(SIZE * dpr);
    }
    const hoverKey = this.hover ? `${this.hover.axis}${this.hover.sign}` : '';
    this.ends = projectGizmo(axes, camQ, SIZE, RADIUS);
    this.hover = this.ends.find((p) => `${p.axis}${p.sign}` === hoverKey) ?? null;
    this.draw();
  }

  private draw(): void {
    const g = this.ctx;
    const c = SIZE / 2;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, SIZE, SIZE);
    // 底盘
    g.beginPath();
    g.arc(c, c, c - 1.5, 0, Math.PI * 2);
    g.fillStyle = 'rgba(10, 16, 24, 0.55)';
    g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    g.lineWidth = 1;
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const p of this.ends) {
      const a = this.axes[p.axis];
      const hot = p === this.hover;
      // 朝向屏幕里的一端稍暗，增加立体感
      const dim = 0.62 + 0.38 * (p.depth * 0.5 + 0.5);
      g.globalAlpha = hot ? 1 : dim;
      if (p.sign > 0) {
        g.beginPath();
        g.moveTo(c, c);
        g.lineTo(p.x, p.y);
        g.strokeStyle = a.color;
        g.lineWidth = 2.4;
        g.stroke();
        g.beginPath();
        g.arc(p.x, p.y, hot ? END_R + 1.5 : END_R, 0, Math.PI * 2);
        g.fillStyle = a.color;
        g.fill();
        if (hot) {
          g.strokeStyle = '#fff';
          g.lineWidth = 1.5;
          g.stroke();
        }
        g.fillStyle = '#0b0f15';
        g.font = `700 ${a.label.length > 1 ? 9 : 11}px system-ui, sans-serif`;
        g.fillText(a.label, p.x, p.y + 0.5);
      } else {
        g.beginPath();
        g.moveTo(c, c);
        g.lineTo(p.x, p.y);
        g.strokeStyle = a.color;
        g.globalAlpha *= 0.35;
        g.lineWidth = 1.2;
        g.stroke();
        g.globalAlpha = hot ? 1 : dim;
        g.beginPath();
        g.arc(p.x, p.y, hot ? END_R : END_R - 1.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(11, 15, 21, 0.85)';
        g.fill();
        g.strokeStyle = a.color;
        g.lineWidth = hot ? 2 : 1.4;
        g.stroke();
        if (a.negLabel) {
          g.fillStyle = a.color;
          g.font = `600 ${a.negLabel.length > 1 ? 8.5 : 10}px system-ui, sans-serif`;
          g.fillText(a.negLabel, p.x, p.y + 0.5);
        }
      }
    }
    g.globalAlpha = 1;
    // 中心点
    g.beginPath();
    g.arc(c, c, 2.2, 0, Math.PI * 2);
    g.fillStyle = 'rgba(230, 237, 245, 0.8)';
    g.fill();
  }

  dispose(): void {
    this.el.remove();
  }
}
