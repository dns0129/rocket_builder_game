import * as THREE from 'three';
import { BODY_BY_ID, type Body, type BodyId, positionInParent } from '../physics/bodies';
import type { PathSegment, PredEvent, PredEventType, Prediction } from '../game/predictor';
import { fmtDist } from '../ui/format';

/** 轨迹配色（线性空间）。 */
export const TRAJ = {
  earth: new THREE.Color(0x35d0ff),
  moon: new THREE.Color(0xc49bff),
  sun: new THREE.Color(0xffcf70),
  mercury: new THREE.Color(0xd8cfc0),
  venus: new THREE.Color(0xffe08a),
  mars: new THREE.Color(0xff7a4a),
  jupiter: new THREE.Color(0xffb27a),
  saturn: new THREE.Color(0xf2dd9a),
  node: new THREE.Color(0xffb040),
  impact: new THREE.Color(0xff3b30),
  ghost: new THREE.Color(0xffffff),
};

/** 幽灵轨迹落后当前轨迹的时间（真实秒）：机动时两条线分开，一眼就能看出轨迹在怎么变。 */
const GHOST_LAG = 1.2;

/** 记录最近几秒的预测轨迹，用来画“变化前”的幽灵轨迹、计算远/近拱点的变化量。 */
export class PredictionHistory {
  private hist: { at: number; pred: Prediction }[] = [];
  private last: Prediction | null = null;

  update(pred: Prediction | null, now: number): void {
    if (pred !== this.last) {
      this.last = pred;
      if (pred) this.hist.push({ at: now, pred });
      else this.hist = [];
    }
    while (this.hist.length > 2 && this.hist[1].at <= now - GHOST_LAG) this.hist.shift();
  }

  /** GHOST_LAG 秒前的预测（与当前相同时返回 null）。 */
  ghost(): Prediction | null {
    const g = this.hist[0]?.pred ?? null;
    return g && g !== this.last ? g : null;
  }
}

function firstEvent(pred: Prediction | null, type: PredEventType, body: Body, afterNode: boolean, tMin: number): PredEvent | null {
  if (!pred) return null;
  for (const e of pred.events) if (e.type === type && e.body === body && e.afterNode === afterNode && e.t > tMin) return e;
  return null;
}

/** 与幽灵轨迹相比的高度变化，返回带颜色箭头的 HTML（变化很小时为空）。 */
export function deltaHtml(cur: PredEvent, ghost: Prediction | null, tMin: number): string {
  const g = firstEvent(ghost, cur.type, cur.body, cur.afterNode, tMin);
  if (!g) return '';
  const d = cur.alt - g.alt;
  if (Math.abs(d) < Math.max(30, Math.abs(cur.alt) * 0.002)) return '';
  const up = d > 0;
  return ` <span class="${up ? 'd-up' : 'd-down'}">${up ? '▲' : '▼'} ${up ? '+' : '−'}${fmtDist(Math.abs(d))}</span>`;
}

/** 远地点 / 近月点 / 远日点 / 近火点…… */
export function apsisName(type: 'ap' | 'pe', body: Body): string {
  return `${type === 'ap' ? '远' : '近'}${body.apsisChar}点`;
}

/** 预测轨迹某点的颜色：机动后为橙色，月球附近为紫色，临近撞击的一段渐变为红色。 */
export function segColor(seg: PathSegment, i: number, impactT: number | null, out: THREE.Color): THREE.Color {
  out.copy(seg.afterNode ? TRAJ.node : TRAJ[seg.body.id]);
  if (impactT !== null) {
    const t0 = seg.times[0];
    const span = impactT - t0;
    if (span > 0) {
      const f = (seg.times[i] - t0) / span;
      if (f > 0.55) out.lerp(TRAJ.impact, Math.min(1, (f - 0.55) / 0.35));
    }
  }
  return out;
}

/** 撞击发生在这一段里时返回撞击时刻。 */
export function segImpactT(pred: Prediction, seg: PathSegment): number | null {
  const imp = pred.impact;
  if (!imp || imp.body !== seg.body) return null;
  const n = seg.times.length;
  return imp.t >= seg.times[0] && imp.t <= seg.times[n - 1] + 1e-6 ? imp.t : null;
}

/** 天体及其所有上级天体（月球 → 地球 → 太阳）。 */
export function bodyChain(b: Body): Set<BodyId> {
  const s = new Set<BodyId>();
  for (let c: Body | null = b; c; c = c.parent ? BODY_BY_ID[c.parent] : null) s.add(c.id);
  return s;
}

/**
 * 地图中预测轨迹段的锚定时刻：飞船当前所在天体及其上级天体的轨迹段跟随天体当前位置（返回 null）；
 * 将来才会进入的天体（如奔月时的月球、飞往火星时的火星），其轨迹段画在进入影响球那一刻
 * 该天体所在的位置，这样转移弹道与环绕段首尾相接。
 */
export function encounterAnchor(pred: Prediction, seg: PathSegment): number | null {
  const segs = pred.segments;
  if (!segs.length || bodyChain(segs[0].body).has(seg.body.id)) return null;
  let j = segs.indexOf(seg);
  if (j < 0) return null;
  while (j > 0 && segs[j - 1].body === seg.body) j--;
  return segs[j].times[0];
}

/** 一段预测轨迹在地图上的位置：画在 host 天体（当前位置）旁，偏移 off（惯性系）。 */
export interface SegPlacement {
  host: BodyId;
  off: THREE.Vector3;
  /** 锚定时刻（相遇时），null 表示跟随天体当前位置 */
  anchor: number | null;
}

/**
 * 计算每段预测轨迹的绘制位置。相遇天体的位置取进入其影响球时相对上级天体的位置；
 * 多级相遇（例如从日心轨道回到地球后再遇到月球）逐级叠加。
 */
export function placeSegments(pred: Prediction): SegPlacement[] {
  const segs = pred.segments;
  const out: SegPlacement[] = [];
  if (!segs.length) return out;
  const chain = bodyChain(segs[0].body);
  const last = new Map<BodyId, SegPlacement>();
  const placeOf = (b: Body, tEnt: number): SegPlacement => {
    if (chain.has(b.id)) return { host: b.id, off: new THREE.Vector3(), anchor: null };
    const prev = last.get(b.id);
    if (prev) return prev;
    // 上级天体还没有出现过：按同一时刻逐级换算
    const parent = placeOf(BODY_BY_ID[b.parent!], tEnt);
    return { host: parent.host, off: positionInParent(b, tEnt, new THREE.Vector3()).add(parent.off), anchor: tEnt };
  };
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const b = seg.body;
    if (chain.has(b.id)) {
      out.push({ host: b.id, off: new THREE.Vector3(), anchor: null });
      continue;
    }
    if (i > 0 && segs[i - 1].body === b) {
      out.push(out[i - 1]);
      continue;
    }
    const tEnt = seg.times[0];
    const parent = placeOf(BODY_BY_ID[b.parent!], tEnt);
    const pl: SegPlacement = { host: parent.host, off: positionInParent(b, tEnt, new THREE.Vector3()).add(parent.off), anchor: tEnt };
    last.set(b.id, pl);
    out.push(pl);
  }
  return out;
}

