import { Vector3 } from 'three';
import { BODIES, EARTH, MOON, MOON_ORBIT, type Body, type BodyId, bodyPosition, bodyVelocity, dominantBody } from '../physics/bodies';
import { adaptiveStep, rk4Step } from '../physics/integrate';
import { computeOrbit, keplerPropagate } from '../physics/orbit';

export interface NodeSpec {
  t: number;
  dv: Vector3; // x = 顺行, y = 法向, z = 径向
}

export interface PathSegment {
  body: Body;
  pts: number[]; // 相对该天体的位置 (x,y,z)，惯性坐标轴
  times: number[];
  afterNode: boolean;
}

export type PredEventType = 'soiEnter' | 'soiExit' | 'impact' | 'pe' | 'ap' | 'node';

export interface PredEvent {
  type: PredEventType;
  t: number;
  body: Body;
  pos: Vector3; // 相对天体
  vel?: Vector3; // 相对天体
  alt: number;
  afterNode: boolean;
}

export interface Prediction {
  segments: PathSegment[];
  events: PredEvent[];
  nodeState: { r: Vector3; v: Vector3; t: number; body: Body; dvWorld: Vector3 } | null;
  moonClosest: { t: number; dist: number; afterNode: boolean } | null;
  moonMinDist: number; // 整条轨迹（节点之后）与月心的最近距离
  /** 整条轨迹（有节点时为节点之后）与各天体中心的最近距离（步内线性插值） */
  minDist: Partial<Record<BodyId, { dist: number; t: number }>>;
  earthPeAfterMoon: { t: number; alt: number } | null;
  impact: PredEvent | null;
  endT: number;
}

export interface PredictOptions {
  maxSteps?: number;
  eta?: number;
  maxTime?: number;
  /**
   * 远期节点的“跳跃”缓存：节点在很多圈之后时，只画一圈当前轨道，然后直接跳到节点前半圈。
   * 提供缓存时用数值积分（含月球、太阳等的摄动）跳过去，结果存进缓存，只要飞船一直在滑行、
   * 节点不变，下次预测就能直接复用；不提供时退回二体开普勒外推（快，但几天后会差出几十公里）。
   */
  jump?: JumpCache;
  /** 产生某个事件后提前结束（规划器只关心第一个近地点之类的结果时，省掉后面的积分） */
  until?: (e: PredEvent) => boolean;
}

export interface JumpCache {
  state: { t: number; r: Vector3; v: Vector3 } | null;
}

/** 数值跳跃最多积分这么多圈，更远的部分先用开普勒外推（到时会自然越来越准） */
const JUMP_MAX_ORBITS = 40;

const _rel = new Vector3();
const _vrel = new Vector3();
const _bp = new Vector3();
const _bv = new Vector3();

/** 机动节点的局部坐标系：顺行、法向、径向（相对当前主导天体）。 */
export function nodeFrame(r: Vector3, v: Vector3, t: number, body: Body) {
  const rel = r.clone().sub(bodyPosition(body, t, new Vector3()));
  const vrel = v.clone().sub(bodyVelocity(body, t, new Vector3()));
  const pro = vrel.clone().normalize();
  const nor = new Vector3().crossVectors(rel, vrel).normalize();
  const rad = new Vector3().crossVectors(nor, pro).normalize();
  return { pro, nor, rad };
}

/** 撞击事件的“虚拟近拱点”高度（撞击时刻的二体轨道近拱点，负值表示在地下多深）；其他事件返回其高度。 */
export function virtualPeAlt(e: PredEvent): number {
  return e.type === 'impact' && e.vel ? computeOrbit(e.pos, e.vel, e.body).peAlt : e.alt;
}

export function nodeDvWorld(r: Vector3, v: Vector3, t: number, dv: Vector3, body: Body): Vector3 {
  const f = nodeFrame(r, v, t, body);
  return new Vector3().addScaledVector(f.pro, dv.x).addScaledVector(f.nor, dv.y).addScaledVector(f.rad, dv.z);
}

/** 轨道完全落在这个半径以内时视为“闭合轨道”，预测一圈即可。 */
function closedLimit(body: Body): number {
  if (body.id === 'earth') return MOON_ORBIT.a - MOON.soi * 1.5;
  if (body.id === 'sun') return 2e12;
  return body.soi * 0.9;
}

function horizonFor(r: Vector3, v: Vector3, t: number, body: Body, maxTime: number): number {
  bodyPosition(body, t, _bp);
  bodyVelocity(body, t, _bv);
  _rel.subVectors(r, _bp);
  _vrel.subVectors(v, _bv);
  const o = computeOrbit(_rel, _vrel, body);
  if (!o.hyperbolic && o.ap < closedLimit(body) && isFinite(o.period)) return Math.min(maxTime, o.period * 1.01);
  return maxTime;
}

/** 一次算完整条预测轨迹。 */
export function predict(r0: Vector3, v0: Vector3, t0: number, nodes: NodeSpec[], opts: PredictOptions = {}): Prediction {
  const it = predictSteps(r0, v0, t0, nodes, opts);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
  }
}

/** 分片计算时每积分这么多步让出一次 */
const YIELD_EVERY = 48;

/**
 * 可分片执行的轨迹预测：每积分 YIELD_EVERY 步让出一次，主循环可以在每帧的时间预算内推进它，
 * 不必让某一帧停下来等整条轨迹算完。注意：输入在第一次 next() 时才被读取，调用方应传入快照。
 */
export function* predictSteps(r0: Vector3, v0: Vector3, t0: number, nodes: NodeSpec[], opts: PredictOptions = {}): Generator<void, Prediction, void> {
  const maxSteps = opts.maxSteps ?? 3000;
  const eta = opts.eta ?? 0.02;
  const maxTime = opts.maxTime ?? 14 * 86400 / 3.16;
  const r = r0.clone();
  const v = v0.clone();
  let t = t0;
  let body = dominantBody(r, t);
  const pending = nodes.filter((n) => n.t >= t0).sort((a, b) => a.t - b.t);
  const segments: PathSegment[] = [];
  const events: PredEvent[] = [];
  let afterNode = false;
  let seg: PathSegment = { body, pts: [], times: [], afterNode };
  segments.push(seg);
  let nodeState: Prediction['nodeState'] = null;
  let moonClosest: Prediction['moonClosest'] = null;
  let earthPeAfterMoon: Prediction['earthPeAfterMoon'] = null;
  let impact: PredEvent | null = null;
  let visitedMoon = body.id === 'moon';
  let moonMinDist = Infinity;
  const minDist: Prediction['minDist'] = {};
  const needAfterNode = pending.length > 0;
  const _mpos = new Vector3();
  const _bvel = new Vector3();
  const _pr = new Vector3();
  const _pv = new Vector3();
  /** 一步之内与各天体的最近距离：用步首的相对位置、相对速度做线性插值（远距离巡航时步长很大） */
  const trackClosest = (r0: Vector3, v0: Vector3, t0: number, h: number) => {
    for (const b of BODIES) {
      if (b.id === 'sun') continue;
      bodyPosition(b, t0, _mpos);
      bodyVelocity(b, t0, _bvel);
      _pr.subVectors(r0, _mpos);
      _pv.subVectors(v0, _bvel);
      const vv = _pv.lengthSq();
      let tc = vv > 0 ? -_pr.dot(_pv) / vv : 0;
      tc = Math.max(0, Math.min(h, tc));
      const d = _pr.addScaledVector(_pv, tc).length();
      const cur = minDist[b.id];
      if (!cur || d < cur.dist) minDist[b.id] = { dist: d, t: t0 + tc };
    }
  };
  const _r0 = new Vector3();
  const _v0 = new Vector3();

  const pushPoint = () => {
    bodyPosition(seg.body, t, _bp);
    seg.pts.push(r.x - _bp.x, r.y - _bp.y, r.z - _bp.z);
    seg.times.push(t);
  };
  pushPoint();

  let horizonStart = t;
  let horizon = horizonFor(r, v, t, body, maxTime);
  let prevRdot = NaN;
  let apsisCount = 0;
  let sinceNodeOrSoi = 0;
  // 远期机动节点：先画一整圈当前轨道，再用开普勒外推跳到节点前半圈
  const tStart = t;
  const closedPeriod = (() => {
    bodyPosition(body, t, _bp);
    bodyVelocity(body, t, _bv);
    const o = computeOrbit(_rel.subVectors(r, _bp), _vrel.subVectors(v, _bv), body);
    return !o.hyperbolic && o.ap < closedLimit(body) ? o.period : Infinity;
  })();
  let jumped = false;

  for (let step = 0; step < maxSteps; step++) {
    if (step % YIELD_EVERY === YIELD_EVERY - 1) yield;
    if (!jumped && pending.length && isFinite(closedPeriod) && t - tStart >= closedPeriod && pending[0].t - t > 0.6 * closedPeriod) {
      jumped = true;
      const target = pending[0].t - 0.5 * closedPeriod;
      const cached = opts.jump?.state;
      let ok = false;
      if (cached && cached.t > t && cached.t < pending[0].t) {
        r.copy(cached.r);
        v.copy(cached.v);
        t = cached.t;
        ok = true;
      } else {
        // 太远的部分先用开普勒外推，最后 JUMP_MAX_ORBITS 圈（或全部）数值积分
        const tNum = opts.jump ? Math.max(t, target - JUMP_MAX_ORBITS * closedPeriod) : target;
        ok = true;
        if (tNum > t) {
          bodyPosition(body, t, _bp);
          bodyVelocity(body, t, _bv);
          const rr = r.clone().sub(_bp);
          const vv = v.clone().sub(_bv);
          ok = keplerPropagate(rr, vv, body.mu, tNum - t);
          if (ok) {
            t = tNum;
            bodyPosition(body, t, _bp);
            bodyVelocity(body, t, _bv);
            r.copy(rr).add(_bp);
            v.copy(vv).add(_bv);
          }
        }
        if (ok && opts.jump) {
          for (let k = 1; t < target - 1e-9; k++) {
            const hj = Math.min(target - t, adaptiveStep(r, t, 0.02));
            rk4Step(r, v, t, hj);
            t += hj;
            if (k % (YIELD_EVERY * 4) === 0) yield;
          }
          opts.jump.state = { t, r: r.clone(), v: v.clone() };
        }
      }
      if (ok) {
        seg = { body, pts: [], times: [], afterNode };
        segments.push(seg);
        pushPoint();
        prevRdot = NaN;
        sinceNodeOrSoi = 0;
        continue;
      }
    }
    let h = adaptiveStep(r, t, eta);
    h = Math.min(h, Math.max(1, horizon / 60));
    let hitNode = false;
    if (pending.length && t + h >= pending[0].t) {
      h = Math.max(0, pending[0].t - t);
      hitNode = true;
    }
    const t0 = t;
    if (!needAfterNode || afterNode) {
      _r0.copy(r);
      _v0.copy(v);
    }
    if (h > 0) rk4Step(r, v, t, h);
    t += h;
    sinceNodeOrSoi++;
    if (!needAfterNode || afterNode) trackClosest(_r0, _v0, t0, h);

    const nb = dominantBody(r, t);
    bodyPosition(nb, t, _bp);
    bodyVelocity(nb, t, _bv);
    _rel.subVectors(r, _bp);
    _vrel.subVectors(v, _bv);
    const dist = _rel.length();
    if (!needAfterNode || afterNode) {
      const md = r.distanceTo(bodyPosition(MOON, t, _mpos));
      if (md < moonMinDist) moonMinDist = md;
    }

    if (nb !== body) {
      pushPoint();
      events.push({ type: nb.parent === body.id ? 'soiEnter' : 'soiExit', t, body: nb, pos: _rel.clone(), vel: _vrel.clone(), alt: dist - nb.radius, afterNode });
      body = nb;
      if (nb.id === 'moon') visitedMoon = true;
      seg = { body, pts: [], times: [], afterNode };
      segments.push(seg);
      pushPoint();
      horizonStart = t;
      horizon = horizonFor(r, v, t, body, maxTime);
      prevRdot = NaN;
      apsisCount = 0;
      sinceNodeOrSoi = 0;
      continue;
    }

    if (body.id === 'moon') {
      if (!moonClosest || dist < moonClosest.dist) moonClosest = { t, dist, afterNode };
    }

    if (dist < body.radius) {
      pushPoint();
      impact = { type: 'impact', t, body, pos: _rel.clone(), vel: _vrel.clone(), alt: 0, afterNode };
      events.push(impact);
      // 撞击时刻的二体近拱点（在地下）：规划器把它当作“最近距离”，代价因此是连续的，
      // 知道还差多少才能擦过去，而不是一撞上就失去方向
      if (!needAfterNode || afterNode) {
        const vpe = computeOrbit(_rel, _vrel, body).pe;
        const cur = minDist[body.id];
        if (!cur || vpe < cur.dist) minDist[body.id] = { dist: vpe, t };
        if (body.id === 'moon' && vpe < moonMinDist) moonMinDist = vpe;
      }
      break;
    }

    // 拱点检测
    const rdot = _rel.dot(_vrel);
    if (!isNaN(prevRdot) && sinceNodeOrSoi > 1 && apsisCount < 4) {
      if (prevRdot < 0 && rdot >= 0) {
        events.push({ type: 'pe', t, body, pos: _rel.clone(), vel: _vrel.clone(), alt: dist - body.radius, afterNode });
        apsisCount++;
        if (body.id === 'earth' && visitedMoon && !earthPeAfterMoon) earthPeAfterMoon = { t, alt: dist - body.radius };
        if (opts.until?.(events[events.length - 1])) {
          pushPoint();
          break;
        }
      } else if (prevRdot > 0 && rdot <= 0) {
        events.push({ type: 'ap', t, body, pos: _rel.clone(), alt: dist - body.radius, afterNode });
        apsisCount++;
      }
    }
    prevRdot = rdot;

    pushPoint();

    if (hitNode) {
      const n = pending.shift()!;
      const dvw = nodeDvWorld(r, v, t, n.dv, body);
      if (!nodeState) nodeState = { r: r.clone(), v: v.clone(), t, body, dvWorld: dvw.clone() };
      events.push({ type: 'node', t, body, pos: _rel.clone(), alt: dist - body.radius, afterNode });
      v.add(dvw);
      afterNode = true;
      seg = { body, pts: [], times: [], afterNode };
      segments.push(seg);
      pushPoint();
      horizonStart = t;
      horizon = horizonFor(r, v, t, body, maxTime);
      prevRdot = NaN;
      apsisCount = 0;
      sinceNodeOrSoi = 0;
      continue;
    }

    if (t - horizonStart >= horizon && !pending.length) break;
  }

  return {
    segments: segments.filter((s) => s.pts.length >= 6),
    events,
    nodeState,
    moonClosest,
    moonMinDist,
    minDist,
    earthPeAfterMoon,
    impact,
    endT: t,
  };
}

export { EARTH };
