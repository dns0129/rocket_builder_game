import { Vector3 } from 'three';
import { EARTH, MOON, MOON_ORBIT, type Body, bodyPosition, bodyVelocity, dominantBody, moonPosition, moonVelocity } from '../physics/bodies';
import { adaptiveStep, rk4Step } from '../physics/integrate';
import { computeOrbit, visViva } from '../physics/orbit';
import { predict, virtualPeAlt, type NodeSpec, type PredEvent } from './predictor';

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

/**
 * 奔月转移（地月转移轨道注入）。
 * 1. 发射窗口：月球在赤道面内公转，而从文昌发射的停泊轨道有约 19.6° 倾角，
 *    所以必须在轨道与赤道面的交点（节点）附近点火，并且此时月球恰好运行到对面。
 *    在未来一个月球周期内扫描，找到最早满足条件的时刻（赤道轨道每圈都有窗口）。
 * 2. 从窗口前半圈的状态出发，用三体数值积分精修点火时刻、顺行与法向 Δv，使近月点高度约为 targetAlt。
 */
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
  const Ts = (2 * Math.PI) / nS;
  const target = MOON.radius + targetAlt;

  // ---- 1. 发射窗口扫描（停泊轨道按圆轨道近似）
  const hHat = o.h.clone().normalize();
  const rHat = r.clone().normalize();
  const qHat = new Vector3().crossVectors(hHat, rHat);
  const mp = new Vector3();
  const errAt = (tb: number) => {
    const a = nS * tb;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // 点火点对面的方向（霍曼转移的远地点方向）
    const ax = -(rHat.x * c + qHat.x * sn);
    const ay = -(rHat.y * c + qHat.y * sn);
    const az = -(rHat.z * c + qHat.z * sn);
    moonPosition(s.t + tb + tTrans, mp).normalize();
    return Math.acos(Math.max(-1, Math.min(1, ax * mp.x + ay * mp.y + az * mp.z)));
  };
  const step = Ts / 360;
  const tEnd = MOON_ORBIT.period + 2 * Ts;
  const thr = (2.5 * Math.PI) / 180;
  let bestTb = -1;
  let bestErr = Infinity;
  let firstTb = -1;
  let prev = errAt(120);
  for (let tb = 120 + step; tb < tEnd; tb += step) {
    const e = errAt(tb);
    if (e < bestErr) {
      bestErr = e;
      bestTb = tb;
    }
    // 第一个足够好的局部极小值
    if (firstTb < 0 && prev < thr && e > prev) firstTb = tb - step;
    if (firstTb >= 0) break;
    prev = e;
  }
  const tb0 = firstTb >= 0 ? firstTb : bestTb;

  // ---- 2. 数值推进到窗口前约半圈
  const lead = Math.min(tb0 - 1, 0.35 * Ts);
  const t1 = s.t + tb0 - lead;
  const r1 = s.r.clone();
  const v1 = s.v.clone();
  let t = s.t;
  for (let guard = 0; t < t1 - 1e-6 && guard < 2_000_000; guard++) {
    const h = Math.min(t1 - t, adaptiveStep(r1, t, 0.01));
    rk4Step(r1, v1, t, h);
    t += h;
  }
  const rb = r1.clone().sub(bodyPosition(EARTH, t, new Vector3())).length();
  const dv0 = Math.sqrt(EARTH.mu * (2 / rb - 1 / aT)) - Math.sqrt(EARTH.mu / rb);

  // ---- 3. 三体精修：点火时刻、顺行 Δv、法向 Δv
  const cost = (dtb: number, dv: number, dn: number) => {
    const p = predict(r1, v1, t, [{ t: t + lead + dtb, dv: new Vector3(dv, dn, 0) }], { maxSteps: 1500, eta: 0.03, maxTime: lead + dtb + tTrans * 1.8 });
    let c = Math.abs(p.moonMinDist - target);
    if (p.moonMinDist < MOON.radius) c += 3e6; // 撞月
    return c + Math.abs(dn) * 30;
  };
  let bT = 0;
  let bDv = dv0;
  let bN = 0;
  let best = cost(bT, bDv, bN);
  let sT = 240;
  let sDv = 24;
  let sN = 30;
  for (let iter = 0; iter < 8; iter++) {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 30) {
      improved = false;
      for (const [dT, dD, dN] of [
        [sT, 0, 0],
        [-sT, 0, 0],
        [0, sDv, 0],
        [0, -sDv, 0],
        [sT, sDv, 0],
        [-sT, -sDv, 0],
        [sT, -sDv, 0],
        [-sT, sDv, 0],
        [0, 0, sN],
        [0, 0, -sN],
      ]) {
        const nt = bT + dT;
        if (lead + nt < 30) continue;
        const c = cost(nt, bDv + dD, bN + dN);
        if (c < best) {
          best = c;
          bT = nt;
          bDv += dD;
          bN += dN;
          improved = true;
        }
      }
    }
    sT /= 2.5;
    sDv /= 2.5;
    sN /= 2.5;
  }
  const nodeT = t + lead + bT;
  const miss = best - Math.abs(bN) * 30;
  const ok = miss < 400_000;
  const wait = nodeT - s.t;
  const waitTxt = wait > 1.5 * Ts ? `，发射窗口在 ${fmtWait(wait)} 后（可用时间加速）` : '';
  return {
    node: { t: nodeT, dv: new Vector3(bDv, bN, 0) },
    msg: ok
      ? `奔月转移：Δv ${Math.hypot(bDv, bN).toFixed(0)} m/s，预计近月点 ${((miss + target - MOON.radius) / 1000).toFixed(0)} km${waitTxt}`
      : `未找到精确的月球交会，已给出近似方案，请手动微调${waitTxt}。`,
  };
}

function fmtWait(s: number): string {
  const h = s / 3600;
  return h >= 24 ? `${(h / 24).toFixed(1)} 天` : h >= 1 ? `${h.toFixed(1)} 小时` : `${(s / 60).toFixed(0)} 分钟`;
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

/**
 * 返回地球：从环月轨道出发，使地球近地点落在大气层内（约 35 km）。
 * 1. 逃逸渐近线需大致指向月球公转速度的反方向（相对地球几乎“停住”，才会落回地球）。
 *    环月轨道有倾角时，这个方向大约每半个月才落进轨道面一次，所以先扫描返回窗口。
 * 2. 从窗口前约 1/3 圈的数值状态出发，用三体积分精修点火时刻、顺行与法向 Δv。
 */
export function solveReturn(s: StateVec, targetAlt = 35_000): SolveResult {
  const body = dominantBody(s.r, s.t);
  if (body.id !== 'moon') return { node: null, msg: '需要先处于环月轨道上。' };
  const { r, v } = relState(s, MOON);
  const o = computeOrbit(r, v, MOON);
  if (o.hyperbolic) return { node: null, msg: '当前已是逃逸轨道。' };
  const T = o.period;
  // 所需双曲线剩余速度：月球轨道速度减去“远地点在月球轨道、近地点在大气层”的椭圆远地点速度
  const rpE = EARTH.radius + targetAlt;
  const vMoon = Math.sqrt(EARTH.mu / MOON_ORBIT.a);
  const vApo = Math.sqrt((2 * EARTH.mu * rpE) / (MOON_ORBIT.a * (MOON_ORBIT.a + rpE)));
  const vInf = vMoon - vApo;
  const rr = r.length();
  const dvEst = Math.sqrt((2 * MOON.mu) / rr + vInf * vInf) - v.length();
  // 渐近线位于点火点前方 nuInf 处；飞出影响球期间月球继续公转
  const nuInf = Math.acos(-1 / (1 + (rr * vInf * vInf) / MOON.mu));
  const tExit = (0.8 * MOON.soi) / vInf;
  const cosNu = Math.cos(nuInf);
  const sinNu = Math.sin(nuInf);
  const mv = new Vector3();
  /** 以 (rHat, qHat) 所在平面的圆轨道近似，返回 tb 后点火时渐近线与理想方向的夹角。 */
  const makeErr = (rHat: Vector3, qHat: Vector3, n: number, tRef: number) => (tb: number) => {
    const a = n * tb;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // 点火点 p = r̂c + q̂s；h×p = q̂c − r̂s；渐近线 = p·cosν + (h×p)·sinν
    const ax = (rHat.x * c + qHat.x * sn) * cosNu + (qHat.x * c - rHat.x * sn) * sinNu;
    const ay = (rHat.y * c + qHat.y * sn) * cosNu + (qHat.y * c - rHat.y * sn) * sinNu;
    const az = (rHat.z * c + qHat.z * sn) * cosNu + (qHat.z * c - rHat.z * sn) * sinNu;
    moonVelocity(tRef + tb + tExit, mv).normalize();
    return Math.acos(Math.max(-1, Math.min(1, -(ax * mv.x + ay * mv.y + az * mv.z))));
  };

  // ---- 1. 返回窗口扫描（最多约半个月）
  const hHat = o.h.clone().normalize();
  const rHat0 = r.clone().normalize();
  const errAt = makeErr(rHat0, new Vector3().crossVectors(hHat, rHat0), (2 * Math.PI) / T, s.t);
  const step = T / 180;
  const tEnd = MOON_ORBIT.period * 0.55 + 2 * T;
  const thr = (8 * Math.PI) / 180;
  let bestTb = 60;
  let bestErr = Infinity;
  let firstTb = -1;
  let prev = errAt(60);
  for (let tb = 60 + step; tb < tEnd; tb += step) {
    const e = errAt(tb);
    if (e < bestErr) {
      bestErr = e;
      bestTb = tb;
    }
    if (prev < thr && e > prev) {
      firstTb = tb - step;
      break;
    }
    prev = e;
  }
  const tb0 = firstTb >= 0 ? firstTb : bestTb;

  // ---- 2. 数值推进到窗口前约 1/3 圈，再用当地的密切轨道重新对准点火时刻
  const t1 = s.t + Math.max(0, tb0 - 0.35 * T);
  const r1 = s.r.clone();
  const v1 = s.v.clone();
  let t = s.t;
  for (let guard = 0; t < t1 - 1e-6 && guard < 3_000_000; guard++) {
    const h = Math.min(t1 - t, adaptiveStep(r1, t, 0.01));
    rk4Step(r1, v1, t, h);
    t += h;
  }
  const loc = relState({ r: r1, v: v1, t }, MOON);
  const o1 = computeOrbit(loc.r, loc.v, MOON);
  const rHat1 = loc.r.clone().normalize();
  const err1 = makeErr(rHat1, new Vector3().crossVectors(o1.h.clone().normalize(), rHat1), (2 * Math.PI) / o1.period, t);
  let lead = 30;
  let e1 = Infinity;
  for (let tb = 30; tb < 30 + o1.period; tb += o1.period / 720) {
    const e = err1(tb);
    if (e < e1) {
      e1 = e;
      lead = tb;
    }
  }

  // ---- 3. 三体精修
  // 能命中再入走廊的（点火时刻, Δv）有一整族：点火早一点或晚一点，多烧一点也能把近地点压到目标高度。
  // 对每个点火时刻，用割线法求出使近地点正好在目标高度的顺行 Δv；再在点火时刻上找 Δv 最小的那个。
  // （直接在二维里做模式搜索容易卡在一条斜着的窄谷里，多花几十 m/s。）
  // 返回地球约需 1.6 天：预测到第一个地球近地点为止，最长约 4.6 天（太短的话有些几何下还没到近地点就截止了）
  const untilEarthPe = (e: PredEvent) => e.type === 'pe' && e.afterNode && e.body.id === 'earth';
  const horizon = 4e5;
  /** 近地点高度与目标之差（m）；撞月等无效方案返回 null */
  const peErr = (dtb: number, dv: number, dn: number): number | null => {
    const p = predict(r1, v1, t, [{ t: t + lead + dtb, dv: new Vector3(dv, dn, 0) }], { maxSteps: 3000, eta: 0.03, maxTime: lead + dtb + horizon, until: untilEarthPe });
    if (p.impact && p.impact.body.id === 'moon') return null;
    if (p.earthPeAfterMoon) return p.earthPeAfterMoon.alt - targetAlt;
    // 还没到近地点就撞上了：用撞击时刻的二体近地点（已包含途中所有摄动）衡量差多少
    if (p.impact && p.impact.body.id === 'earth' && p.impact.afterNode) return virtualPeAlt(p.impact) - targetAlt;
    // 预测截止前还没到近地点：用飞出月球影响球时的二体近地点近似
    const ex = p.events.find((e) => e.type === 'soiExit' && e.afterNode && e.vel);
    return ex && ex.vel ? computeOrbit(ex.pos, ex.vel, EARTH).pe - rpE : null;
  };
  /** 给定点火时刻（与法向分量），求命中目标近地点的顺行 Δv */
  const solveDv = (dtb: number, dn: number, dv0: number): { dv: number; err: number } | null => {
    let a = dv0;
    let fa = peErr(dtb, a, dn);
    if (fa === null) return null;
    // 顺行 Δv 越大，相对地球越“停得住”，近地点越低
    let b = dv0 + (fa > 0 ? 6 : -6);
    let fb = peErr(dtb, b, dn);
    if (fb === null) return null;
    for (let i = 0; i < 14 && Math.abs(fb) > 30; i++) {
      const slope = (fb - fa) / (b - a);
      if (!isFinite(slope) || slope === 0) break;
      const c = Math.max(b - 60, Math.min(b + 60, b - fb / slope));
      a = b;
      fa = fb;
      b = c;
      const fc = peErr(dtb, b, dn);
      if (fc === null) return null;
      fb = fc;
    }
    return { dv: b, err: Math.abs(fb) };
  };
  // 窗口就在眼前时没有向前调整的余地：改用下一圈的同一位置
  if (lead < T / 4 + 30) lead += T;
  let bT = 0;
  let bDv = dvEst;
  let bN = 0;
  let bErr = Infinity;
  const consider = (dtb: number, r: { dv: number; err: number } | null) => {
    if (!r) return Infinity;
    // 先保证命中，再比 Δv
    const score = Math.abs(r.dv) + Math.max(0, r.err - 2_000) * 0.05;
    const bScore = Math.abs(bDv) + Math.max(0, bErr - 2_000) * 0.05;
    if (score < bScore || !isFinite(bErr)) {
      bT = dtb;
      bDv = r.dv;
      bErr = r.err;
    }
    return score;
  };
  const span = T / 24;
  for (let k = -6; k <= 6; k++) consider(k * span, solveDv(k * span, 0, dvEst));
  // 黄金分割细化点火时刻
  let lo = bT - span;
  let hi = bT + span;
  const gr = (Math.sqrt(5) - 1) / 2;
  const evalAt = (x: number) => {
    const r = solveDv(x, 0, bDv);
    const sc = consider(x, r);
    return sc;
  };
  let x1 = hi - gr * (hi - lo);
  let x2 = lo + gr * (hi - lo);
  let f1 = evalAt(x1);
  let f2 = evalAt(x2);
  for (let i = 0; i < 9; i++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - gr * (hi - lo);
      f1 = evalAt(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + gr * (hi - lo);
      f2 = evalAt(x2);
    }
  }
  // 收尾：在最终点火时刻把近地点再对准一些
  const fin = solveDv(bT, bN, bDv);
  if (fin && fin.err < bErr) {
    bDv = fin.dv;
    bErr = fin.err;
  }
  const nodeT = t + lead + bT;
  const dvTot = Math.hypot(bDv, bN);
  const wait = nodeT - s.t;
  const waitTxt = wait > 1.5 * T ? `，返回窗口在 ${fmtWait(wait)} 后（可用时间加速）` : '';
  // 用更精细的积分核对结果，报告实际预计的再入近地点（而不是目标值）
  const check = predict(r1, v1, t, [{ t: nodeT, dv: new Vector3(bDv, bN, 0) }], { maxSteps: 12000, eta: 0.01, maxTime: lead + bT + horizon, until: untilEarthPe });
  const peEv = check.earthPeAfterMoon ? check.earthPeAfterMoon.alt : check.impact && check.impact.body.id === 'earth' ? virtualPeAlt(check.impact) : null;
  const ok = peEv !== null && Math.abs(peEv - targetAlt) < 15_000 && dvTot < dvEst + 300;
  return {
    node: { t: nodeT, dv: new Vector3(bDv, bN, 0) },
    msg: ok
      ? `返回地球：Δv ${dvTot.toFixed(0)} m/s，预计再入近地点 ${(peEv! / 1000).toFixed(0)} km${waitTxt}`
      : `未找到理想返回轨道，已给出近似方案（预计近地点 ${peEv === null ? '—' : `${(peEv / 1000).toFixed(0)} km`}），途中请用“修正再入角”${waitTxt}。`,
  };
}

/**
 * 中途修正：在 delay 秒后做一次小规模三维机动。
 * target = 'moon'：使近月点高度为 targetAlt；'earth'：使地球近地点高度为 targetAlt（再入走廊）。
 */
export function solveCorrection(s: StateVec, target: 'moon' | 'earth', targetAlt: number, delay = 120): SolveResult {
  const tb = s.t + delay;
  const until = target === 'earth' ? (e: PredEvent) => e.type === 'pe' && e.afterNode && e.body.id === 'earth' : undefined;
  const cost = (dv: Vector3) => {
    const p = predict(s.r, s.v, s.t, [{ t: tb, dv }], { maxSteps: 2500, eta: 0.03, maxTime: delay + 4e5, until });
    let c: number;
    if (target === 'moon') {
      c = Math.abs(p.moonMinDist - (MOON.radius + targetAlt));
      if (p.moonMinDist < MOON.radius) c += 2e6;
    } else {
      const pe = p.events.find((e) => e.afterNode && e.type === 'pe' && e.body.id === 'earth');
      const imp = p.impact && p.impact.body.id === 'earth' ? p.impact : null;
      if (pe) c = Math.abs(pe.alt - targetAlt);
      else if (imp) c = Math.abs(virtualPeAlt(imp) - targetAlt); // 直接撞击：近地点在地下多深
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

/**
 * 从点火到“Δv 加权中心”的时间：在这个时刻之前点火，有限推力烧完后的位置与瞬时机动完全一致。
 * 质量越烧越轻、加速度越来越大，所以它比燃烧时间的一半略长（奔月时约晚 0.7 s，对应近千米的位置偏差）。
 */
export function burnLead(dv: number, mass: number, thrust: number, mdot: number): number {
  if (thrust <= 0 || mdot <= 0) return Infinity;
  const ve = thrust / mdot;
  const L = Math.abs(dv) / ve;
  if (L <= 0) return 0;
  const U = -Math.expm1(-L);
  return ((mass * ve) / thrust) * (1 - U / L);
}

// ================================================================ 兰伯特问题（闭环制导用）

/** Stumpff 函数 C(z)、S(z)。 */
function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + (z * z) / 720;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

const Y_AXIS = new Vector3(0, 1, 0);

/**
 * 兰伯特问题（普适变量法，单圈、顺行）：已知两点位置与飞行时间，求两端速度。
 * 顺行指角动量与 hRef 同向（默认 +Y，即与行星公转方向一致）。
 */
export function lambert(r1: Vector3, r2: Vector3, tof: number, mu: number, hRef: Vector3 = Y_AXIS): { v1: Vector3; v2: Vector3 } | null {
  if (!(tof > 0)) return null;
  const r1n = r1.length();
  const r2n = r2.length();
  const cosD = Math.max(-1, Math.min(1, r1.dot(r2) / (r1n * r2n)));
  let dth = Math.acos(cosD);
  if (new Vector3().crossVectors(r1, r2).dot(hRef) < 0) dth = 2 * Math.PI - dth;
  const A = Math.sin(dth) * Math.sqrt((r1n * r2n) / (1 - cosD));
  if (!isFinite(A) || Math.abs(A) < 1e-9) return null;
  const y = (z: number) => r1n + r2n + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const F = (z: number) => {
    const yz = y(z);
    if (yz < 0) return -Infinity;
    return Math.pow(yz / stumpffC(z), 1.5) * stumpffS(z) + A * Math.sqrt(yz) - Math.sqrt(mu) * tof;
  };
  // F(z) 随 z 单调递增：先找到 y>0 的下界，再二分
  let lo = -4 * Math.PI * Math.PI;
  // 飞行时间很短的双曲线弧（例如逃逸点火）需要更小的 z
  for (let k = 0; k < 40 && y(lo) >= 0 && F(lo) > 0 && lo > -1e5; k++) lo *= 2;
  if (y(lo) < 0) {
    // y(0) ≥ 0（转移角小于 180°），在 [lo, 0] 内二分出 y = 0 的边界
    let a = lo;
    let b = 0;
    if (y(b) < 0) return null;
    for (let i = 0; i < 60; i++) {
      const m = (a + b) / 2;
      if (y(m) < 0) a = m;
      else b = m;
    }
    lo = b;
  }
  let hi = 4 * Math.PI * Math.PI - 1e-6;
  if (!(F(lo) < 0) || !(F(hi) > 0)) return null;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (F(mid) > 0) hi = mid;
    else lo = mid;
  }
  const z = (lo + hi) / 2;
  const yz = y(z);
  const f = 1 - yz / r1n;
  const g = A * Math.sqrt(yz / mu);
  const gd = 1 - yz / r2n;
  const v1 = r2.clone().addScaledVector(r1, -f).divideScalar(g);
  const v2 = r2.clone().multiplyScalar(gd).sub(r1).divideScalar(g);
  return { v1, v2 };
}
