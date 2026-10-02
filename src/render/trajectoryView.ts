import * as THREE from 'three';
import { BODY_BY_ID, type Body, type BodyId, bodyPosition, bodyRotation, positionInParent, rotateY } from '../physics/bodies';
import type { FlightSim } from '../game/flight';
import type { PathSegment, PredEvent, PredEventType, Prediction } from '../game/predictor';
import { DynLine, PolyBuilder, fadeLineMaterial } from './lines';
import { ScreenLabels } from './labels';
import { fmtDist, fmtTime } from '../ui/format';

/** 轨迹配色（线性空间）。 */
export const TRAJ = {
  powered: new THREE.Color(0xff8a2a),
  coast: new THREE.Color(0x9fc8ff),
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

export function firstEvent(pred: Prediction | null, type: PredEventType, body: Body, afterNode: boolean, tMin: number): PredEvent | null {
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

/** 包含某时刻、属于某天体的预测轨迹段。 */
export function segmentAt(pred: Prediction, t: number, body: Body): PathSegment | null {
  for (const s of pred.segments) if (s.body === body && t >= s.times[0] - 1e-6 && t <= s.times[s.times.length - 1] + 1e-6) return s;
  return null;
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * 飞行视图中的轨迹：
 * - 已飞过的航迹（橙色 = 发动机工作，淡蓝 = 滑行），
 * - 从火箭出发的预测弹道（蓝色，将要撞地的一段变红），
 * - 1 秒多以前的“幽灵”弹道（白色），操纵时两条线分开，
 * - 远地点 / 落点标签及其变化量。
 * 都换算到随天体自转的坐标系，因此与地面、发射台对得上（BODY_ROTATION 关闭时即惯性系）。
 */
export class FlightTrajectory {
  group = new THREE.Group();
  private trail: DynLine;
  private pred: DynLine;
  private ghost: DynLine;
  private labels: ScreenLabels;
  private pb = new PolyBuilder();
  visible = true;

  constructor(overlay: HTMLElement) {
    this.trail = new DynLine([fadeLineMaterial({ width: 2.4 })], 40);
    this.ghost = new DynLine([fadeLineMaterial({ width: 1.8 })], 42);
    this.pred = new DynLine([fadeLineMaterial({ width: 5, opacity: 0.12 }), fadeLineMaterial({ width: 2.2 })], 44);
    for (const l of [this.trail, this.ghost, this.pred]) l.addTo(this.group);
    this.labels = new ScreenLabels(overlay);
  }

  setResolution(w: number, h: number): void {
    for (const l of [this.trail, this.ghost, this.pred]) for (const o of l.objects) o.material.resolution.set(w, h);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.group.visible = v;
    if (!v) {
      this.labels.begin();
    }
  }

  update(sim: FlightSim, ghost: Prediction | null, origin: THREE.Vector3, camera: THREE.Camera, w: number, h: number): void {
    this.labels.begin();
    if (!this.visible) return;
    const tel = sim.telemetry;
    const body = tel.body;
    const t = sim.t;
    const th = bodyRotation(body, t);
    const bp = bodyPosition(body, t, new THREE.Vector3()).sub(origin);
    const V = sim.vessel;
    const vesselRel = V.r.clone().sub(origin);
    // 相对天体中心的惯性位置（时刻 ti）-> 当前时刻随天体转动后的位置（浮动原点系）
    const place = (x: number, y: number, z: number, ti: number, out: THREE.Vector3) => {
      _q.set(x, y, z);
      rotateY(_q, th - bodyRotation(body, ti), out);
      return out.add(bp);
    };

    // ---------------------------------------------------------------- 航迹
    const pb = this.pb.clear();
    const seg = sim.trail.last;
    if (seg && seg.body === body) {
      // 最近 300 个点逐点画，更早的隔点抽稀（远处看不出差别，每帧少算很多）
      const n = seg.times.length;
      const i0 = Math.max(0, n - 1500);
      const dense = Math.max(i0, n - 300);
      for (let i = i0; i < n; i += i < dense ? 3 : 1) {
        place(seg.pts[i * 3], seg.pts[i * 3 + 1], seg.pts[i * 3 + 2], seg.times[i], _p);
        const f = (i - i0) / Math.max(1, n - i0);
        pb.push(_p.x, _p.y, _p.z, seg.powered[i] ? TRAJ.powered : TRAJ.coast, 0.2 + 0.75 * f);
      }
      if (n) pb.push(vesselRel.x, vesselRel.y, vesselRel.z, tel.thrust > 0 ? TRAJ.powered : TRAJ.coast, 0.95);
    }
    pb.flush(this.trail);

    // ---------------------------------------------------------------- 预测弹道与幽灵
    const pred = sim.destroyed || sim.landed ? null : sim.prediction;
    this.buildPrediction(pred, body, t, vesselRel, place, 1, this.pred);
    this.buildPrediction(ghost && pred ? ghost : null, body, t, vesselRel, place, 0.45, this.ghost, true);

    // ---------------------------------------------------------------- 标签
    if (pred) {
      const ap = firstEvent(pred, 'ap', body, false, t);
      if (ap) {
        place(ap.pos.x, ap.pos.y, ap.pos.z, ap.t, _p);
        this.labels.add(_p, `<b>${apsisName('ap', body)}</b> ${fmtDist(ap.alt)}${deltaHtml(ap, ghost, t)}<br><small>${fmtTime(ap.t - t)} 后</small>`, 'mk-ap fl');
      }
      const imp = pred.impact && pred.impact.body === body && !pred.impact.afterNode ? pred.impact : null;
      if (imp) {
        place(imp.pos.x, imp.pos.y, imp.pos.z, imp.t, _p);
        this.labels.add(_p, `<b>✖ 预计落点</b><br><small>${fmtTime(imp.t - t)} 后</small>`, 'mk-impact fl');
      } else {
        const pe = firstEvent(pred, 'pe', body, false, t);
        if (pe) {
          place(pe.pos.x, pe.pos.y, pe.pos.z, pe.t, _p);
          this.labels.add(_p, `<b>${apsisName('pe', body)}</b> ${fmtDist(pe.alt)}${deltaHtml(pe, ghost, t)}<br><small>${fmtTime(pe.t - t)} 后</small>`, 'mk-pe fl');
        }
      }
    }
    this.labels.layout(camera, w, h);
  }

  /** 从火箭当前位置开始画预测轨迹（丢弃已经飞过的点），只画当前天体的部分。 */
  private buildPrediction(
    pred: Prediction | null,
    body: Body,
    t: number,
    start: THREE.Vector3,
    place: (x: number, y: number, z: number, ti: number, out: THREE.Vector3) => THREE.Vector3,
    alpha: number,
    line: DynLine,
    flat = false,
  ): void {
    const pb = this.pb.clear();
    if (!pred) {
      line.visible = false;
      return;
    }
    // 点数多时隔点抽稀，但火箭附近的前 150 个点保持逐点
    let total = 0;
    for (const seg of pred.segments) {
      if (seg.body !== body) break;
      total += seg.times.length;
    }
    const stride = Math.max(1, Math.ceil(total / 900));
    let budget = 1200;
    let first = true;
    for (const seg of pred.segments) {
      if (seg.body !== body || budget <= 0) break;
      const n = seg.times.length;
      if (seg.times[n - 1] <= t) continue;
      let k = 0;
      while (k < n && seg.times[k] <= t) k++;
      const impactT = segImpactT(pred, seg);
      if (first) {
        segColor(seg, k, impactT, _c);
        pb.push(start.x, start.y, start.z, flat ? TRAJ.ghost : _c, alpha);
        first = false;
      } else if (pb.n) {
        // 不连续的两段之间插入透明连接，避免画出多余的弦
        const L = pb.n - 1;
        pb.push(pb.pts[L * 3], pb.pts[L * 3 + 1], pb.pts[L * 3 + 2], _c, 0);
        place(seg.pts[k * 3], seg.pts[k * 3 + 1], seg.pts[k * 3 + 2], seg.times[k], _p);
        pb.push(_p.x, _p.y, _p.z, _c, 0);
      }
      for (let i = k; i < n && budget > 0; ) {
        place(seg.pts[i * 3], seg.pts[i * 3 + 1], seg.pts[i * 3 + 2], seg.times[i], _p);
        segColor(seg, i, impactT, _c);
        pb.push(_p.x, _p.y, _p.z, flat ? TRAJ.ghost : _c, alpha);
        budget--;
        i = i === n - 1 ? n : Math.min(n - 1, i + (pb.n < 150 ? 1 : stride));
      }
    }
    // 由近及远渐隐
    const N = pb.n;
    for (let i = 0; i < N; i++) if (pb.alpha[i] > 0) pb.alpha[i] *= 1 - 0.65 * (i / Math.max(1, N - 1));
    pb.flush(line);
  }

  dispose(): void {
    for (const l of [this.trail, this.ghost, this.pred]) l.dispose();
    this.labels.dispose();
  }
}
