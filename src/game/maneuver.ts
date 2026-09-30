import { Vector3 } from 'three';
import { EARTH, MOON, MOON_ORBIT, type Body, bodyPosition, bodyVelocity, dominantBody, moonPosition, moonVelocity } from '../physics/bodies';
import { adaptiveStep, rk4Step } from '../physics/integrate';
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

  // ---- 3. 三体精修：点火时刻、顺行 Δv、法向 Δv
  const cost = (dtb: number, dv: number, dn: number) => {
    const p = predict(r1, v1, t, [{ t: t + lead + dtb, dv: new Vector3(dv, dn, 0) }], { maxSteps: 2000, eta: 0.03, maxTime: lead + dtb + (5 * 86400) / 3.16 });
    if (p.impact && p.impact.body.id === 'moon') return 5e7;
    let c: number;
    if (p.earthPeAfterMoon) {
      c = Math.abs(p.earthPeAfterMoon.alt - targetAlt);
    } else {
      // 尚未到达近地点（或直接撞地）：用飞出月球影响球时的二体近地点作为连续代价
      const ex = p.events.find((e) => e.type === 'soiExit' && e.afterNode && e.vel);
      if (!ex || !ex.vel) return 4e7 + Math.abs(dv - dvEst) * 1e4;
      c = Math.abs(computeOrbit(ex.pos, ex.vel, EARTH).pe - rpE);
    }
    return c + Math.abs(dn) * 30;
  };
  let bT = 0;
  let bDv = dvEst;
  let bN = 0;
  let best = Infinity;
  for (const dT of [-T / 8, -T / 16, 0, T / 16, T / 8]) {
    if (lead + dT < 20) continue;
    for (const dD of [-30, 0, 30, 80]) {
      for (const dN of [-60, 0, 60]) {
        const c = cost(dT, dvEst + dD, dN);
        if (c < best) {
          best = c;
          bT = dT;
          bDv = dvEst + dD;
          bN = dN;
        }
      }
    }
  }
  let sT = T / 32;
  let sDv = 16;
  let sN = 24;
  for (let iter = 0; iter < 9; iter++) {
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
        if (lead + nt < 20) continue;
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
  const dvTot = Math.hypot(bDv, bN);
  const ok = miss < 30_000 && dvTot < dvEst + 300;
  const wait = nodeT - s.t;
  const waitTxt = wait > 1.5 * T ? `，返回窗口在 ${fmtWait(wait)} 后（可用时间加速）` : '';
  return {
    node: { t: nodeT, dv: new Vector3(bDv, bN, 0) },
    msg: ok
      ? `返回地球：Δv ${dvTot.toFixed(0)} m/s，再入近地点约 ${(targetAlt / 1000).toFixed(0)} km${waitTxt}`
      : `未找到理想返回轨道，已给出近似方案，请手动微调${waitTxt}。`,
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
