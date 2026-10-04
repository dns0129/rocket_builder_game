import { Vector3 } from 'three';
import { type Body, bodyPosition } from '../physics/bodies';

/** 一段飞行轨迹：点都相对同一个天体（惯性坐标轴），进出月球影响球时换段。 */
export interface TrailSegment {
  body: Body;
  /** 相对天体中心的位置 (x,y,z)，惯性坐标轴 */
  pts: number[];
  times: number[];
  /** 该点处发动机是否在工作（1 = 动力段，0 = 滑行） */
  powered: number[];
}

const _bp = new Vector3();

/**
 * 已飞过的轨迹。按距离抽样（越高越稀），动力/滑行切换处一定取点，
 * 点数超过上限时把较早的部分隔点抽稀，所以整趟登月往返都能完整保留。
 */
export class FlightTrail {
  segments: TrailSegment[] = [];
  /** 每次增删点都会递增，渲染层据此决定是否重建几何体 */
  version = 0;
  count = 0;
  static MAX_POINTS = 6000;
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private lastPowered = -1;
  private lt = -Infinity;

  get last(): TrailSegment | null {
    return this.segments.length ? this.segments[this.segments.length - 1] : null;
  }

  record(body: Body, r: Vector3, t: number, powered: boolean): void {
    bodyPosition(body, t, _bp);
    const x = r.x - _bp.x;
    const y = r.y - _bp.y;
    const z = r.z - _bp.z;
    const p = powered ? 1 : 0;
    let seg = this.last;
    if (!seg || seg.body !== body) {
      seg = { body, pts: [], times: [], powered: [] };
      this.segments.push(seg);
    } else {
      const dist = Math.sqrt(x * x + y * y + z * z);
      const alt = dist - body.radius;
      // 低空取点密（起飞段也能看清），高空按弧长约 0.3° 取点
      const spacing = Math.min(Math.max(2, 2 + alt * 0.02), dist * 0.006);
      const dx = x - this.lx;
      const dy = y - this.ly;
      const dz = z - this.lz;
      // 发射台附近惯性系速度约 200 m/s（地球自转），再加一个最小时间间隔，避免点过密
      if (p === this.lastPowered && (dx * dx + dy * dy + dz * dz < spacing * spacing || t - this.lt < 0.25)) return;
    }
    seg.pts.push(x, y, z);
    seg.times.push(t);
    seg.powered.push(p);
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.lastPowered = p;
    this.lt = t;
    this.count++;
    this.version++;
    if (this.count > FlightTrail.MAX_POINTS) this.thin();
  }

  /** 把较早的 2/3 轨迹隔点抽稀（保留每段首尾与动力/滑行切换点）。 */
  private thin(): void {
    let budget = Math.floor(this.count * 0.66);
    let removed = 0;
    for (const s of this.segments) {
      if (budget <= 0) break;
      const n = s.times.length;
      const lim = Math.min(n - 1, budget);
      const pts: number[] = [];
      const times: number[] = [];
      const pw: number[] = [];
      for (let i = 0; i < n; i++) {
        const keep = i === 0 || i >= lim || i % 2 === 0 || s.powered[i] !== s.powered[i - 1] || (i + 1 < n && s.powered[i + 1] !== s.powered[i]);
        if (keep) {
          pts.push(s.pts[i * 3], s.pts[i * 3 + 1], s.pts[i * 3 + 2]);
          times.push(s.times[i]);
          pw.push(s.powered[i]);
        } else removed++;
      }
      budget -= n;
      s.pts = pts;
      s.times = times;
      s.powered = pw;
    }
    this.count -= removed;
    this.version++;
  }
}
