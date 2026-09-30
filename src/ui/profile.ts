import * as THREE from 'three';
import type { FlightSim } from '../game/flight';
import type { Prediction } from '../game/predictor';
import { bodyPosition, bodyVelocity } from '../physics/bodies';
import { fmtDist } from './format';
import { h } from './dom';

const W = 300;
const H = 158;
const PAD_L = 42;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 16;

interface Pt {
  x: number; // 沿轨道平面的航程（m，负值为已飞过）
  y: number; // 高度 m
  p: number; // 1 = 动力段
  t: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * 弹道剖面图：横轴为沿轨道平面的航程，纵轴为高度。
 * 已飞过的航迹（橙 = 动力段，淡蓝 = 滑行）、预测弹道（青色，将要撞地的一段变红）、
 * 1 秒前的幽灵弹道（白色）、大气层边界与目标轨道高度都画在同一张图上，
 * 转向、点火时弹道的变化一目了然。
 */
export class TrajectoryProfile {
  el: HTMLDivElement;
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private title: HTMLElement;
  private normal = new THREE.Vector3(0, 1, 0);
  private timer = 0;
  private yMaxS = 0;
  private wS = 0;

  constructor() {
    this.cv = h('canvas', { class: 'profile-canvas' });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = W * dpr;
    this.cv.height = H * dpr;
    this.cv.style.width = `${W}px`;
    this.cv.style.height = `${H}px`;
    this.ctx = this.cv.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.el = h(
      'div',
      { class: 'profile panel' },
      h(
        'div',
        { class: 'profile-head' },
        (this.title = h('span', { class: 'profile-title' }, '弹道剖面')),
        h('span', { class: 'lg' }, h('i', { class: 'c-pw' }), '动力', h('i', { class: 'c-co' }), '滑行', h('i', { class: 'c-pr' }), '预测', h('i', { class: 'c-gh' }), '1 秒前'),
      ),
      this.cv,
    );
  }

  update(sim: FlightSim, ghost: Prediction | null, dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.05;
    const tel = sim.telemetry;
    const body = tel.body;
    const R = body.radius;
    const t = sim.t;
    const V = sim.vessel;
    const far = tel.alt > R * 1.6 && !sim.landed;
    this.el.classList.toggle('far', far);
    if (far) return;
    this.title.textContent = `弹道剖面 · ${body.name}`;

    // 轨道平面法向（相对天体），用于把三维轨迹展开成“航程-高度”
    const rNow = V.r.clone().sub(bodyPosition(body, t, _a));
    const vRel = V.v.clone().sub(bodyVelocity(body, t, _b));
    const hv = _c.crossVectors(rNow, vRel);
    if (hv.length() > 0.02 * rNow.length() * Math.max(1, vRel.length())) this.normal.copy(hv).normalize();
    const n = this.normal;
    const dAng = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      _a.set(ax, ay, az);
      _b.set(bx, by, bz);
      return Math.atan2(_c.crossVectors(_a, _b).dot(n), _a.dot(_b));
    };
    const altOf = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z) - R;

    // 已飞过的航迹：从当前位置往回累加角度
    const past: Pt[] = [];
    const seg = sim.trail.last;
    if (seg && seg.body === body) {
      let px = rNow.x;
      let py = rNow.y;
      let pz = rNow.z;
      let th = 0;
      for (let i = seg.times.length - 1, k = 0; i >= 0 && k < 3000; i--, k++) {
        const x = seg.pts[i * 3];
        const y = seg.pts[i * 3 + 1];
        const z = seg.pts[i * 3 + 2];
        th -= dAng(x, y, z, px, py, pz);
        past.push({ x: th * R, y: altOf(x, y, z), p: seg.powered[i], t: seg.times[i] });
        px = x;
        py = y;
        pz = z;
        if (th < -Math.PI * 2) break;
      }
    }
    // 预测弹道
    const future = (pred: Prediction | null): { pts: Pt[]; impact: boolean } => {
      const out: Pt[] = [];
      let impact = false;
      if (!pred || sim.landed) return { pts: out, impact };
      let px = rNow.x;
      let py = rNow.y;
      let pz = rNow.z;
      let th = 0;
      out.push({ x: 0, y: tel.alt, p: 0, t });
      for (const s of pred.segments) {
        if (s.body !== body) break;
        const nn = s.times.length;
        for (let i = 0; i < nn; i++) {
          if (s.times[i] <= t) continue;
          const x = s.pts[i * 3];
          const y = s.pts[i * 3 + 1];
          const z = s.pts[i * 3 + 2];
          th += dAng(px, py, pz, x, y, z);
          out.push({ x: th * R, y: altOf(x, y, z), p: s.afterNode ? 1 : 0, t: s.times[i] });
          px = x;
          py = y;
          pz = z;
          if (th > Math.PI * 2) return { pts: out, impact };
        }
      }
      impact = !!pred.impact && pred.impact.body === body;
      return { pts: out, impact };
    };
    const fut = future(sim.destroyed ? null : sim.prediction);
    const gh = future(ghost);

    // 视窗：当前位置放在 35% 处；高度至少包含目标轨道（地球上升段）
    const fx = fut.pts.length ? Math.max(...fut.pts.map((p) => p.x)) : 0;
    const px0 = past.length ? -Math.min(...past.map((p) => p.x)) : 0;
    let wv = Math.max(20_000, fx / 0.65, Math.min(px0, fx * 0.6 + 20_000) / 0.35);
    wv = Math.min(wv, Math.PI * 2 * R * 1.08);
    const x0 = -0.35 * wv;
    const x1 = 0.65 * wv;
    let ymax = Math.max(4_000, tel.alt * 1.15);
    for (const p of fut.pts) if (p.x <= x1) ymax = Math.max(ymax, p.y * 1.12);
    for (const p of past) if (p.x >= x0) ymax = Math.max(ymax, p.y * 1.12);
    const ascent = body.id === 'earth' && !sim.missions.done.has('orbit') && sim.scenario === 'pad';
    if (ascent) ymax = Math.max(ymax, 118_000);
    // 平滑缩放，避免图像跳动
    this.yMaxS = this.yMaxS ? this.yMaxS + (ymax - this.yMaxS) * 0.2 : ymax;
    this.wS = this.wS ? this.wS + (wv - this.wS) * 0.2 : wv;
    ymax = this.yMaxS;
    const ww = this.wS;
    const X0 = -0.35 * ww;
    const sx = (x: number) => PAD_L + ((x - X0) / ww) * (W - PAD_L - PAD_R);
    const sy = (y: number) => H - PAD_B - (Math.max(-ymax * 0.05, y) / ymax) * (H - PAD_T - PAD_B);

    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const gy = sy(0);
    // 大气（渐变）与地面
    const atmo = body.atmosphere?.height ?? 0;
    if (atmo) {
      const top = sy(atmo);
      const g = c.createLinearGradient(0, gy, 0, top);
      g.addColorStop(0, 'rgba(80,150,255,0.30)');
      g.addColorStop(1, 'rgba(80,150,255,0)');
      c.fillStyle = g;
      c.fillRect(PAD_L, Math.max(PAD_T, top), W - PAD_L - PAD_R, gy - Math.max(PAD_T, top));
    }
    const gg = c.createLinearGradient(0, gy, 0, H);
    gg.addColorStop(0, body.id === 'earth' ? '#3d6b45' : '#77736c');
    gg.addColorStop(1, body.id === 'earth' ? '#1b2a1e' : '#2e2c29');
    c.fillStyle = gg;
    c.fillRect(PAD_L, gy, W - PAD_L - PAD_R, H - gy);
    // 高度刻度
    c.font = '9px ui-monospace, Menlo, monospace';
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    const step = niceStep(ymax / 3.2);
    for (let y = step; y < ymax; y += step) {
      const yy = sy(y);
      c.strokeStyle = 'rgba(255,255,255,0.07)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(PAD_L, yy);
      c.lineTo(W - PAD_R, yy);
      c.stroke();
      c.fillStyle = 'rgba(200,215,235,0.55)';
      c.fillText(fmtAxis(y), PAD_L - 4, yy);
    }
    const hline = (y: number, color: string, label: string, dash: number[]) => {
      if (y >= ymax) return;
      const yy = sy(y);
      c.setLineDash(dash);
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(PAD_L, yy);
      c.lineTo(W - PAD_R, yy);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = color;
      c.textAlign = 'left';
      c.fillText(label, PAD_L + 4, yy - 6);
      c.textAlign = 'right';
    };
    if (atmo) hline(atmo, 'rgba(120,190,255,0.75)', `大气层边界 ${fmtAxis(atmo)}`, [4, 3]);
    if (ascent) hline(100_000, 'rgba(82,224,138,0.8)', '目标轨道 100 km', [2, 3]);

    // 航程刻度（当前位置处的竖线）
    c.strokeStyle = 'rgba(255,227,74,0.25)';
    c.beginPath();
    c.moveTo(sx(0), PAD_T);
    c.lineTo(sx(0), gy);
    c.stroke();
    c.fillStyle = 'rgba(200,215,235,0.55)';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillText(`← ${fmtAxis(-X0)}`, PAD_L + 2, H - 4);
    c.textAlign = 'right';
    c.fillText(`${fmtAxis(ww + X0)} →`, W - PAD_R - 2, H - 4);

    c.save();
    c.beginPath();
    c.rect(PAD_L, 0, W - PAD_L - PAD_R, H);
    c.clip();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    // 幽灵弹道
    if (gh.pts.length > 1) {
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.lineWidth = 1.5;
      c.setLineDash([3, 3]);
      poly(c, gh.pts, sx, sy);
      c.stroke();
      c.setLineDash([]);
    }
    // 已飞过的航迹（按动力/滑行分色）
    if (past.length) {
      c.lineWidth = 2.4;
      let i = 0;
      while (i < past.length - 1) {
        const pw = past[i].p;
        c.beginPath();
        c.moveTo(sx(past[i].x), sy(past[i].y));
        let j = i + 1;
        while (j < past.length && past[j - 1].p === pw) {
          c.lineTo(sx(past[j].x), sy(past[j].y));
          j++;
        }
        c.strokeStyle = pw ? '#ff8a2a' : '#9fc8ff';
        c.shadowColor = pw ? 'rgba(255,138,42,0.8)' : 'rgba(159,200,255,0.6)';
        c.shadowBlur = 6;
        c.stroke();
        i = j - 1;
      }
      c.shadowBlur = 0;
      // 从最后一个记录点连到当前位置
      c.strokeStyle = tel.thrust > 0 ? '#ff8a2a' : '#9fc8ff';
      c.beginPath();
      c.moveTo(sx(past[0].x), sy(past[0].y));
      c.lineTo(sx(0), sy(tel.alt));
      c.stroke();
    }
    // 预测弹道：临近撞击的一段变红
    if (fut.pts.length > 1) {
      const pts = fut.pts;
      const n = pts.length;
      c.lineWidth = 2.4;
      c.shadowBlur = 8;
      for (let i = 0; i < n - 1; i++) {
        const f = fut.impact ? i / (n - 1) : 0;
        const red = fut.impact && f > 0.55 ? Math.min(1, (f - 0.55) / 0.35) : 0;
        const col = pts[i].p ? '255,176,64' : `${Math.round(53 + red * 202)},${Math.round(208 - red * 149)},${Math.round(255 - red * 207)}`;
        c.strokeStyle = `rgb(${col})`;
        c.shadowColor = `rgba(${col},0.8)`;
        c.beginPath();
        c.moveTo(sx(pts[i].x), sy(pts[i].y));
        c.lineTo(sx(pts[i + 1].x), sy(pts[i + 1].y));
        c.stroke();
      }
      c.shadowBlur = 0;
      // 最高点
      let top = pts[0];
      for (const p of pts) if (p.y > top.y) top = p;
      if (top !== pts[0] && top.x < ww + X0) {
        c.fillStyle = '#7fd6ff';
        c.beginPath();
        c.arc(sx(top.x), sy(top.y), 3, 0, Math.PI * 2);
        c.fill();
        c.font = 'bold 10px ui-monospace, Menlo, monospace';
        c.textAlign = sx(top.x) > W - 70 ? 'right' : 'left';
        c.textBaseline = 'bottom';
        c.fillText(`最高 ${fmtDist(top.y)}`, sx(top.x) + (c.textAlign === 'right' ? -4 : 4), sy(top.y) - 2);
      }
      if (fut.impact) {
        const last = pts[n - 1];
        const x = sx(last.x);
        c.strokeStyle = '#ff5a4a';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(x - 4, gy - 4);
        c.lineTo(x + 4, gy + 4);
        c.moveTo(x + 4, gy - 4);
        c.lineTo(x - 4, gy + 4);
        c.stroke();
      }
    }
    // 飞船：沿速度方向（图上的方向）的小三角
    const vx = Math.max(1e-3, tel.vHoriz) / ww;
    const vy = tel.vVert / ymax;
    const ang = Math.atan2(-vy * (H - PAD_T - PAD_B), vx * (W - PAD_L - PAD_R));
    const cx = sx(0);
    const cy = sy(tel.alt);
    c.save();
    c.translate(cx, cy);
    c.rotate(sim.landed ? -Math.PI / 2 : ang);
    c.fillStyle = '#ffe34a';
    c.shadowColor = 'rgba(255,227,74,0.9)';
    c.shadowBlur = 8;
    c.beginPath();
    c.moveTo(7, 0);
    c.lineTo(-5, 4.5);
    c.lineTo(-3, 0);
    c.lineTo(-5, -4.5);
    c.closePath();
    c.fill();
    c.restore();
    c.restore();
  }
}

function poly(c: CanvasRenderingContext2D, pts: Pt[], sx: (x: number) => number, sy: (y: number) => number): void {
  c.beginPath();
  c.moveTo(sx(pts[0].x), sy(pts[0].y));
  for (let i = 1; i < pts.length; i++) c.lineTo(sx(pts[i].x), sy(pts[i].y));
}

function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function fmtAxis(m: number): string {
  const a = Math.abs(m);
  if (a < 1000) return `${m.toFixed(0)} m`;
  if (a < 10_000) return `${(m / 1000).toFixed(1)} km`;
  if (a < 10_000_000) return `${(m / 1000).toFixed(0)} km`;
  return `${(m / 1e7).toFixed(1)}万km`;
}
