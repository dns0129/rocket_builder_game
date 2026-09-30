import { Vector3 } from 'three';
import { EARTH, MOON, MOON_ORBIT, type Body, bodyPosition, bodyVelocity, dominantBody, moonAngle } from '../physics/bodies';
import { computeOrbit, visViva } from '../physics/orbit';
import { predict, type NodeSpec } from './predictor';

export interface StateVec {
  r: Vector3;
  v: Vector3;
  t: number;
}

export interface SolveResult {
  node: NodeSpec | null;
  msg: string;
}

function relState(s: StateVec, body: Body) {
  const r = s.r.clone().sub(bodyPosition(body, s.t, new Vector3()));
  const v = s.v.clone().sub(bodyVelocity(body, s.t, new Vector3()));
  return { r, v };
}

/** 在远/近拱点处圆化轨道。 */
export function solveCircularize(s: StateVec, where: 'ap' | 'pe'): SolveResult {
  const body = dominantBody(s.r, s.t);
  const { r, v } = relState(s, body);
  const o = computeOrbit(r, v, body);
  if (where === 'ap') {
    if (o.hyperbolic || !isFinite(o.ap)) return { node: null, msg: '当前为逃逸轨道，没有远拱点。' };
    const vAt = visViva(body.mu, o.ap, o.a);
    const vc = Math.sqrt(body.mu / o.ap);
    return { node: { t: s.t + o.timeToAp, dv: new Vector3(vc - vAt, 0, 0) }, msg: `在远${body.id === 'moon' ? '月' : '地'}点圆化` };
  }
  if (o.timeToPe < 0) return { node: null, msg: '已经飞过近拱点。' };
  if (o.peAlt < 0) return { node: null, msg: '近拱点在地表以下。' };
  const vAt = o.hyperbolic ? Math.sqrt(body.mu * (2 / o.pe - 1 / o.a)) : visViva(body.mu, o.pe, o.a);
  const vc = Math.sqrt(body.mu / o.pe);
  return { node: { t: s.t + o.timeToPe, dv: new Vector3(vc - vAt, 0, 0) }, msg: `在近${body.id === 'moon' ? '月' : '地'}点圆化` };
}

/** 调整另一侧拱点高度：在远拱点调整近拱点，或在近拱点调整远拱点。 */
export function solveChangeApsis(s: StateVec, at: 'ap' | 'pe', targetAlt: number): SolveResult {
  const body = dominantBody(s.r, s.t);
  const { r, v } = relState(s, body);
  const o = computeOrbit(r, v, body);
  if (o.hyperbolic) return { node: null, msg: '当前为逃逸轨道。' };
  const rBurn = at === 'ap' ? o.ap : o.pe;
  const tBurn = at === 'ap' ? o.timeToAp : o.timeToPe;
  const rOther = body.radius + targetAlt;
  const aNew = (rBurn + rOther) / 2;
  const dv = visViva(body.mu, rBurn, aNew) - visViva(body.mu, rBurn, o.a);
  return { node: { t: s.t + tBurn, dv: new Vector3(dv, 0, 0) }, msg: '调整轨道高度' };
}

function angleOf(p: Vector3): number {
  return Math.atan2(-p.z, p.x);
}

function wrap2pi(x: number): number {
  const T = Math.PI * 2;
  x %= T;
  return x < 0 ? x + T : x;
}

/** 奔月转移（地月转移轨道注入）：先用霍曼转移估算，再用三体数值积分精修，使近月点高度约为 targetAlt。 */
export function solveTLI(s: StateVec, targetAlt = 60_000): SolveResult {
  const body = dominantBody(s.r, s.t);
  if (body.id !== 'earth') return { node: null, msg: '需要先处于地球轨道上。' };
  const { r, v } = relState(s, EARTH);
  const o = computeOrbit(r, v, EARTH);
  if (o.hyperbolic || o.peAlt < 60_000) return { node: null, msg: '请先进入稳定的地球轨道（近地点高于 60 km）。' };
  if (o.ap > MOON_ORBIT.a * 0.5) return { node: null, msg: '轨道已经很高，请手动规划。' };
  const r0 = r.length();
  const aT = (r0 + MOON_ORBIT.a) / 2;
  const tTrans = Math.PI * Math.sqrt((aT * aT * aT) / EARTH.mu);
  const nS = Math.sqrt(EARTH.mu / (o.a * o.a * o.a));
  const nM = MOON_ORBIT.n;
  const th0 = angleOf(r);
  const thM0 = moonAngle(s.t);
  const synodic = (2 * Math.PI) / (nS - nM);
  let dt = wrap2pi(thM0 + nM * tTrans - Math.PI - th0) / (nS - nM);
  while (dt < 90) dt += synodic;
  const dv0 = Math.sqrt(EARTH.mu * (2 / r0 - 1 / aT)) - v.length();
  const target = MOON.radius + targetAlt;

  const cost = (tb: number, dv: number) => {
    const p = predict(s.r, s.v, s.t, [{ t: s.t + tb, dv: new Vector3(dv, 0, 0) }], { maxSteps: 1500, eta: 0.03, maxTime: tTrans * 1.8 + tb });
    let c = Math.abs(p.moonMinDist - target);
    if (p.moonMinDist < MOON.radius) c += 3e6; // 撞月
    return c;
  };
  let bestT = dt;
  let bestDv = dv0;
  let best = cost(bestT, bestDv);
  let stepT = 240;
  let stepDv = 24;
  for (let iter = 0; iter < 7; iter++) {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 30) {
      improved = false;
      for (const [dT, dD] of [
        [stepT, 0],
        [-stepT, 0],
        [0, stepDv],
        [0, -stepDv],
        [stepT, stepDv],
        [-stepT, -stepDv],
        [stepT, -stepDv],
        [-stepT, stepDv],
      ]) {
        const nt = bestT + dT;
        if (nt < 60) continue;
        const c = cost(nt, bestDv + dD);
        if (c < best) {
          best = c;
          bestT = nt;
          bestDv += dD;
          improved = true;
        }
      }
    }
    stepT /= 2.5;
    stepDv /= 2.5;
  }
  const ok = best < 400_000;
  return {
    node: { t: s.t + bestT, dv: new Vector3(bestDv, 0, 0) },
    msg: ok ? `奔月转移：Δv ${bestDv.toFixed(0)} m/s，预计近月点 ${((best + target - MOON.radius) / 1000).toFixed(0)} km` : '未找到精确的月球交会，已给出近似方案，请手动微调。',
  };
}

/** 月球捕获：在近月点减速进入环月轨道。 */
export function solveCapture(s: StateVec, currentPrediction?: { events: { type: string; body: Body; t: number; pos: Vector3; vel?: Vector3 }[] }): SolveResult {
  const body = dominantBody(s.r, s.t);
  // 优先使用三体数值预测得到的近月点（远离月球时二体近似误差较大）
  {
    const p = predict(s.r, s.v, s.t, [], { maxSteps: 2500, eta: 0.01, maxTime: 3 * 86400 / 3.16 });
    const ev = p.events.find((e) => e.type === 'pe' && e.body.id === 'moon' && e.vel);
    if (ev && ev.vel && ev.t > s.t + 5) {
      if (ev.alt < 3000) return { node: null, msg: '近月点过低，将撞击月面！请先做中途修正抬高近月点。' };
      const rp = ev.pos.length();
      const vPe = ev.vel.length();
      const vc = Math.sqrt(MOON.mu / rp);
      return { node: { t: ev.t, dv: new Vector3(vc - vPe, 0, 0) }, msg: `月球捕获：在近月点减速 ${(vPe - vc).toFixed(0)} m/s` };
    }
  }
  if (body.id === 'moon') {
    const { r, v } = relState(s, MOON);
    const o = computeOrbit(r, v, MOON);
    if (o.timeToPe < 0 || isNaN(o.timeToPe)) return { node: null, msg: '已飞过近月点。' };
    if (o.peAlt < 3000) return { node: null, msg: '近月点过低，将撞击月面！请先抬高近月点。' };
    const vPe = Math.sqrt(MOON.mu * (2 / o.pe - 1 / o.a));
    const vc = Math.sqrt(MOON.mu / o.pe);
    return { node: { t: s.t + o.timeToPe, dv: new Vector3(vc - vPe, 0, 0) }, msg: `月球捕获：在近月点减速 ${(vPe - vc).toFixed(0)} m/s` };
  }
  const ev = currentPrediction?.events.find((e) => e.type === 'pe' && e.body.id === 'moon' && e.vel);
  if (!ev || !ev.vel) return { node: null, msg: '当前轨迹未与月球交会。' };
  const rp = ev.pos.length();
  const vPe = ev.vel.length();
  const vc = Math.sqrt(MOON.mu / rp);
  return { node: { t: ev.t, dv: new Vector3(vc - vPe, 0, 0) }, msg: `月球捕获：在近月点减速 ${(vPe - vc).toFixed(0)} m/s` };
}

/** 返回地球：从环月轨道出发，使地球近地点落在大气层内（约 35 km）。 */
export function solveReturn(s: StateVec, targetAlt = 35_000): SolveResult {
  const body = dominantBody(s.r, s.t);
  if (body.id !== 'moon') return { node: null, msg: '需要先处于环月轨道上。' };
  const { r, v } = relState(s, MOON);
  const o = computeOrbit(r, v, MOON);
  if (o.hyperbolic) return { node: null, msg: '当前已是逃逸轨道。' };
  const period = o.period;
  const rr = r.length();
  const vInf = 262;
  const dvEst = Math.sqrt((2 * MOON.mu) / rr + vInf * vInf) - v.length();
  const cost = (tb: number, dv: number) => {
    const p = predict(s.r, s.v, s.t, [{ t: s.t + tb, dv: new Vector3(dv, 0, 0) }], { maxSteps: 1800, eta: 0.03, maxTime: tb + 5 * 86400 / 3.16 });
    if (p.impact && p.impact.body.id === 'moon') return 5e7;
    if (!p.earthPeAfterMoon) {
      // 未返回：按与地球的最近距离给出连续代价
      return 2e7 + (p.impact ? 0 : 1e6);
    }
    return Math.abs(p.earthPeAfterMoon.alt - targetAlt);
  };
  let best = Infinity;
  let bestT = 0;
  let bestDv = dvEst;
  const N = 24;
  for (let i = 0; i < N; i++) {
    const tb = 60 + (period * i) / N;
    for (const k of [-40, 0, 40, 80, 140]) {
      const c = cost(tb, dvEst + k);
      if (c < best) {
        best = c;
        bestT = tb;
        bestDv = dvEst + k;
      }
    }
  }
  let stepT = period / N / 2;
  let stepDv = 20;
  for (let iter = 0; iter < 8; iter++) {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 30) {
      improved = false;
      for (const [dT, dD] of [
        [stepT, 0],
        [-stepT, 0],
        [0, stepDv],
        [0, -stepDv],
      ]) {
        const nt = bestT + dT;
        if (nt < 30) continue;
        const c = cost(nt, bestDv + dD);
        if (c < best) {
          best = c;
          bestT = nt;
          bestDv += dD;
          improved = true;
        }
      }
    }
    stepT /= 2.5;
    stepDv /= 2.5;
  }
  const ok = best < 30_000;
  return {
    node: { t: s.t + bestT, dv: new Vector3(bestDv, 0, 0) },
    msg: ok ? `返回地球：Δv ${bestDv.toFixed(0)} m/s，再入近地点约 ${((targetAlt + (best < 1e6 ? 0 : 0)) / 1000).toFixed(0)} km` : '未找到理想返回轨道，已给出近似方案，请手动微调。',
  };
}

/**
 * 中途修正：在 delay 秒后做一次小规模三维机动。
 * target = 'moon'：使近月点高度为 targetAlt；'earth'：使地球近地点高度为 targetAlt（再入走廊）。
 */
export function solveCorrection(s: StateVec, target: 'moon' | 'earth', targetAlt: number, delay = 120): SolveResult {
  const tb = s.t + delay;
  const cost = (dv: Vector3) => {
    const p = predict(s.r, s.v, s.t, [{ t: tb, dv }], { maxSteps: 1800, eta: 0.03, maxTime: delay + 6 * 86400 / 3.16 });
    let c: number;
    if (target === 'moon') {
      c = Math.abs(p.moonMinDist - (MOON.radius + targetAlt));
      if (p.moonMinDist < MOON.radius) c += 2e6;
    } else {
      const pe = p.events.find((e) => e.afterNode && e.type === 'pe' && e.body.id === 'earth');
      const imp = p.impact && p.impact.body.id === 'earth' ? p.impact : null;
      if (pe) c = Math.abs(pe.alt - targetAlt);
      else if (imp) c = targetAlt + 50_000; // 直接撞击：说明近地点过低
      else c = 5e7;
      if (p.impact && p.impact.body.id === 'moon') c += 5e7;
    }
    return c + dv.length() * 20;
  };
  const dv = new Vector3();
  let best = cost(dv);
  const base = best;
  let step = 8;
  const dirs = [
    new Vector3(1, 0, 0),
    new Vector3(-1, 0, 0),
    new Vector3(0, 1, 0),
    new Vector3(0, -1, 0),
    new Vector3(0, 0, 1),
    new Vector3(0, 0, -1),
  ];
  for (let iter = 0; iter < 9; iter++) {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 25) {
      improved = false;
      for (const d of dirs) {
        const cand = dv.clone().addScaledVector(d, step);
        const c = cost(cand);
        if (c < best) {
          best = c;
          dv.copy(cand);
          improved = true;
        }
      }
    }
    step /= 2.2;
  }
  if (dv.length() < 0.05) return { node: null, msg: base < 5000 ? '轨道已经很准确，无需修正。' : '找不到有效的修正方案。' };
  return { node: { t: tb, dv }, msg: `中途修正：Δv ${dv.length().toFixed(1)} m/s` };
}

/** 燃烧时间估算（齐奥尔科夫斯基）。 */
export function burnTime(dv: number, mass: number, thrust: number, mdot: number): number {
  if (thrust <= 0 || mdot <= 0) return Infinity;
  const ve = thrust / mdot;
  return ((mass * ve) / thrust) * (1 - Math.exp(-Math.abs(dv) / ve));
}
