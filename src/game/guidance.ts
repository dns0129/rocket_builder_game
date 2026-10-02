import { Vector3 } from 'three';
import { type Body, bodyPosition, bodyVelocity } from '../physics/bodies';
import { computeOrbit } from '../physics/orbit';
import { lambert } from './maneuver';

/**
 * 机动执行的闭环制导（兰伯特制导）。
 *
 * 规划出来的机动是“瞬时”的：节点时刻速度突变 Δv。实际发动机推力有限，要在节点前后烧几十秒到几分钟，
 * 期间飞船沿轨道转过一段弧，重力也一直在改变速度方向。按锁定的惯性方向烧完 Δv 会留下可观的误差——
 * 奔月时 1 m/s 的误差就让远地点偏差上千公里，足以从“近月点 60 km”变成撞月或擦肩而过。
 *
 * 做法：锁定节点时，在计划中机动后的轨道（相对节点所在天体的二体圆锥曲线）上，取节点之后约 120° 的一点 P
 * 作为目标，并记下计划轨道的能量。点火过程中每帧求解兰伯特问题：从飞船当前位置出发、以计划的能量经过 P
 * 所需的速度，它与当前速度之差就是“待增速度” v_g。沿 v_g 方向点火直到它归零，飞船就回到了计划中的轨道上——
 * 有限推力、点火偏早或偏晚、重力损失、分级停顿和沉底发动机的额外推力都会被自动补偿。
 * 只约束经过 P 和轨道能量、不约束到达时刻：点火位置与计划差几百米时，硬要按时到达 P 会改变轨道能量
 * （奔月时远地点会偏差上百公里），而到达时刻差零点几秒几乎没有影响。
 * 计划轨道和实际轨道都用同一个二体模型外推到 P，第三体摄动对两者几乎相同，因此不影响精度。
 */
export interface BurnTarget {
  body: Body;
  /** 到达目标点的时刻 */
  tP: number;
  /** 目标点（相对 body 中心，惯性坐标轴） */
  rP: Vector3;
  /** 计划轨道的角动量方向（决定兰伯特问题走“短程”还是“长程”） */
  hHat: Vector3;
  /** 节点到目标点的飞行时间 */
  span: number;
  /** 计划轨道的比机械能（相对 body） */
  energy: number;
}

/** 目标点在节点之后转过的真近点角 */
const SWEEP = (2 * Math.PI) / 3;
const TWO_PI = Math.PI * 2;

function mod2pi(x: number): number {
  x %= TWO_PI;
  return x < 0 ? x + TWO_PI : x;
}

/**
 * 由计划中的机动（节点时刻的惯性状态 r、v 与惯性系 Δv）生成制导目标；sweepMax 为目标点最多领先节点的真近点角。
 * 计划轨道退化（几乎径向、几乎抛物线）时返回 null，此时退回按固定惯性方向执行。
 */
export function makeBurnTarget(r: Vector3, v: Vector3, t: number, dvWorld: Vector3, body: Body, sweepMax = SWEEP): BurnTarget | null {
  const r0 = r.clone().sub(bodyPosition(body, t, new Vector3()));
  const v0 = v.clone().add(dvWorld).sub(bodyVelocity(body, t, new Vector3()));
  const mu = body.mu;
  const o = computeOrbit(r0, v0, body);
  const hl = o.h.length();
  if (!(hl > 1e-3 * r0.length()) || !isFinite(o.e) || Math.abs(o.e - 1) < 1e-4) return null;
  const e = o.e;
  // 近拱点方向（近圆轨道以当前位置为参考）
  let P: Vector3;
  let nu0: number;
  if (e < 1e-9) {
    P = r0.clone().normalize();
    nu0 = 0;
  } else {
    P = o.eVec.clone().divideScalar(e);
    nu0 = o.nu;
  }
  const hHat = o.h.clone().divideScalar(hl);
  const Q = new Vector3().crossVectors(hHat, P);
  const p = (hl * hl) / mu;
  let nu1: number;
  let tof: number;
  if (e < 1) {
    nu1 = nu0 + sweepMax;
    const a = p / (1 - e * e);
    const n = Math.sqrt(mu / (a * a * a));
    const meanAt = (nu: number) => {
      const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
      return E - e * Math.sin(E);
    };
    tof = mod2pi(meanAt(nu1) - meanAt(nu0)) / n;
  } else {
    // 双曲线：真近点角限制在渐近线以内
    const nuInf = Math.acos(-1 / e);
    const nuS = nu0 > Math.PI ? nu0 - TWO_PI : nu0;
    const sweep = Math.min(sweepMax, 0.75 * (nuInf - nuS));
    if (!(sweep > 0.15)) return null;
    nu1 = nuS + sweep;
    const aa = p / (e * e - 1);
    const n = Math.sqrt(mu / (aa * aa * aa));
    const k = Math.sqrt((e - 1) / (e + 1));
    const meanAt = (nu: number) => {
      const F = 2 * Math.atanh(Math.max(-0.999999999999, Math.min(0.999999999999, k * Math.tan(nu / 2))));
      return e * Math.sinh(F) - F;
    };
    tof = (meanAt(nu1) - meanAt(nuS)) / n;
  }
  if (!(tof > 1) || !isFinite(tof)) return null;
  const rr = p / (1 + e * Math.cos(nu1));
  const rP = P.clone().multiplyScalar(rr * Math.cos(nu1)).addScaledVector(Q, rr * Math.sin(nu1));
  return { body, tP: t + tof, rP, hHat, span: tof, energy: o.energy };
}

const _rel = new Vector3();
const _vrel = new Vector3();

/**
 * 待增速度 v_g（惯性系）：从当前状态出发、以计划的能量经过目标点所需的速度减去当前速度。
 * 目标点已经太近、转移角接近 180°（平面不确定）或求解失败时返回 null。
 */
export function velocityToGain(tgt: BurnTarget, r: Vector3, v: Vector3, t: number, out = new Vector3()): Vector3 | null {
  const tof0 = tgt.tP - t;
  if (!(tof0 > 0.25 * tgt.span)) return null;
  const b = tgt.body;
  const mu = b.mu;
  _rel.copy(r).sub(bodyPosition(b, t, out));
  _vrel.copy(v).sub(bodyVelocity(b, t, out));
  // 转移角：沿计划轨道的运动方向量
  const rl = _rel.length();
  const cosD = _rel.dot(tgt.rP) / (rl * tgt.rP.length());
  let dth = Math.acos(Math.max(-1, Math.min(1, cosD)));
  if (new Vector3().crossVectors(_rel, tgt.rP).dot(tgt.hHat) < 0) dth = TWO_PI - dth;
  if (dth < 0.05 || dth > Math.PI - 0.12) return null;
  const solve = (tof: number) => {
    const L = lambert(_rel, tgt.rP, tof, mu, tgt.hHat);
    if (!L || !isFinite(L.v1.x + L.v1.y + L.v1.z)) return null;
    return { v1: L.v1, de: L.v1.lengthSq() / 2 - mu / rl - tgt.energy };
  };
  let a = { tof: tof0, s: solve(tof0) };
  if (!a.s) return null;
  // 割线法调整飞行时间，使经过 P 的轨道能量等于计划值（到达时刻允许偏差几秒）
  const tol = 1e-10 * (Math.abs(tgt.energy) + mu / rl);
  let best = a;
  let bTof = tof0 * (1 + 1e-4);
  let bs = solve(bTof);
  if (bs && Math.abs(bs.de) < Math.abs(best.s!.de)) best = { tof: bTof, s: bs };
  for (let i = 0; i < 12 && bs && Math.abs(best.s!.de) > tol; i++) {
    const slope = (bs.de - a.s!.de) / (bTof - a.tof);
    if (!(Math.abs(slope) > 0) || !isFinite(slope)) break;
    const next = bTof - bs.de / slope;
    // 只在计划到达时刻附近找（远离时说明落到了另一支解上）
    if (!(next > 0.5 * tof0 && next < 2 * tof0)) break;
    a = { tof: bTof, s: bs };
    if (Math.abs(bs.de) < Math.abs(best.s!.de)) best = a;
    bTof = next;
    bs = solve(bTof);
    if (bs && Math.abs(bs.de) < Math.abs(best.s!.de)) best = { tof: bTof, s: bs };
  }
  return out.copy(best.s!.v1).sub(_vrel);
}
