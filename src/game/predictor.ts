import { Vector3 } from 'three';
import { EARTH, MOON, MOON_ORBIT, type Body, bodyPosition, bodyVelocity, dominantBody } from '../physics/bodies';
import { adaptiveStep, rk4Step } from '../physics/integrate';
import { computeOrbit } from '../physics/orbit';

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
  earthPeAfterMoon: { t: number; alt: number } | null;
  impact: PredEvent | null;
  endT: number;
}

export interface PredictOptions {
  maxSteps?: number;
  eta?: number;
  maxTime?: number;
}

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

export function nodeDvWorld(r: Vector3, v: Vector3, t: number, dv: Vector3, body: Body): Vector3 {
  const f = nodeFrame(r, v, t, body);
  return new Vector3().addScaledVector(f.pro, dv.x).addScaledVector(f.nor, dv.y).addScaledVector(f.rad, dv.z);
}

function horizonFor(r: Vector3, v: Vector3, t: number, body: Body, maxTime: number): number {
  bodyPosition(body, t, _bp);
  bodyVelocity(body, t, _bv);
  _rel.subVectors(r, _bp);
  _vrel.subVectors(v, _bv);
  const o = computeOrbit(_rel, _vrel, body);
  const limit = body.id === 'moon' ? MOON.soi : MOON_ORBIT.a - MOON.soi * 1.5;
  if (!o.hyperbolic && o.ap < limit && isFinite(o.period)) return Math.min(maxTime, o.period * 1.01);
  return maxTime;
}

export function predict(r0: Vector3, v0: Vector3, t0: number, nodes: NodeSpec[], opts: PredictOptions = {}): Prediction {
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
  const needAfterNode = pending.length > 0;
  const _mpos = new Vector3();

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

  for (let step = 0; step < maxSteps; step++) {
    let h = adaptiveStep(r, t, eta);
    h = Math.min(h, Math.max(1, horizon / 60));
    let hitNode = false;
    if (pending.length && t + h >= pending[0].t) {
      h = Math.max(0, pending[0].t - t);
      hitNode = true;
    }
    if (h > 0) rk4Step(r, v, t, h);
    t += h;
    sinceNodeOrSoi++;

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
      events.push({ type: nb.id === 'moon' ? 'soiEnter' : 'soiExit', t, body: nb, pos: _rel.clone(), alt: dist - nb.radius, afterNode });
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
      impact = { type: 'impact', t, body, pos: _rel.clone(), alt: 0, afterNode };
      events.push(impact);
      break;
    }

    // 拱点检测
    const rdot = _rel.dot(_vrel);
    if (!isNaN(prevRdot) && sinceNodeOrSoi > 1 && apsisCount < 4) {
      if (prevRdot < 0 && rdot >= 0) {
        events.push({ type: 'pe', t, body, pos: _rel.clone(), vel: _vrel.clone(), alt: dist - body.radius, afterNode });
        apsisCount++;
        if (body.id === 'earth' && visitedMoon && !earthPeAfterMoon) earthPeAfterMoon = { t, alt: dist - body.radius };
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
    earthPeAfterMoon,
    impact,
    endT: t,
  };
}

export { EARTH };
