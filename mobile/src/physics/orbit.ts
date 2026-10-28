import { Vector3 } from 'three';
import type { Body } from './bodies';

/** 由状态矢量计算的密切轨道根数。 */
export interface OrbitInfo {
  body: Body;
  mu: number;
  a: number;
  e: number;
  inc: number; // rad，相对赤道面
  pe: number; // 近拱点半径
  ap: number; // 远拱点半径（逃逸时为 Infinity）
  peAlt: number;
  apAlt: number;
  period: number; // 逃逸轨道为 Infinity
  energy: number;
  h: Vector3;
  eVec: Vector3;
  nu: number; // 真近点角
  timeToPe: number;
  timeToAp: number; // 逃逸轨道为 NaN
  hyperbolic: boolean;
}

const TWO_PI = Math.PI * 2;

function mod2pi(x: number): number {
  x %= TWO_PI;
  return x < 0 ? x + TWO_PI : x;
}

export function computeOrbit(r: Vector3, v: Vector3, body: Body): OrbitInfo {
  const mu = body.mu;
  const rl = r.length();
  const v2 = v.lengthSq();
  const h = new Vector3().crossVectors(r, v);
  const hl = h.length();
  const energy = v2 / 2 - mu / rl;
  const eVec = new Vector3().crossVectors(v, h).divideScalar(mu).sub(r.clone().divideScalar(rl));
  let e = eVec.length();
  const hyperbolic = energy >= 0 && e >= 1 - 1e-9;
  let a = -mu / (2 * energy);
  if (!isFinite(a)) a = Infinity;
  const p = (hl * hl) / mu;
  const pe = p / (1 + e);
  const ap = e < 1 ? p / (1 - e) : Infinity;
  const inc = hl > 0 ? Math.acos(Math.max(-1, Math.min(1, h.y / hl))) : 0;

  let nu: number;
  if (e < 1e-8) {
    // 近圆轨道：以升交点方向为参考（这里取 X 轴投影）
    e = 0;
    nu = Math.atan2(r.z, r.x);
  } else {
    const c = eVec.dot(r) / (e * rl);
    nu = Math.acos(Math.max(-1, Math.min(1, c)));
    if (r.dot(v) < 0) nu = TWO_PI - nu;
  }

  let period = Infinity;
  let timeToPe = NaN;
  let timeToAp = NaN;
  if (!hyperbolic && e < 1) {
    const n = Math.sqrt(mu / (a * a * a));
    period = TWO_PI / n;
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const M = mod2pi(E - e * Math.sin(E));
    timeToPe = mod2pi(TWO_PI - M) / n;
    timeToAp = mod2pi(Math.PI - M) / n;
    if (e === 0) {
      timeToPe = 0;
      timeToAp = period / 2;
    }
  } else if (e > 1) {
    const aa = -a; // a<0
    const n = Math.sqrt(mu / (aa * aa * aa));
    let nuS = nu > Math.PI ? nu - TWO_PI : nu;
    const tH = Math.sqrt((e - 1) / (e + 1)) * Math.tan(nuS / 2);
    const F = 2 * Math.atanh(Math.max(-0.999999999, Math.min(0.999999999, tH)));
    const M = e * Math.sinh(F) - F;
    timeToPe = -M / n; // 已经过近拱点则为负
  }

  return {
    body,
    mu,
    a,
    e,
    inc,
    pe,
    ap,
    peAlt: pe - body.radius,
    apAlt: ap - body.radius,
    period,
    energy,
    h,
    eVec,
    nu,
    timeToPe,
    timeToAp,
    hyperbolic: e >= 1,
  };
}

/** 轨道上真近点角 nu 处的位置（相对天体中心）。 */
export function orbitPositionAt(o: OrbitInfo, nu: number, out = new Vector3()): Vector3 {
  const p = o.pe * (1 + o.e);
  const r = p / (1 + o.e * Math.cos(nu));
  const P = o.e > 1e-8 ? o.eVec.clone().normalize() : new Vector3(1, 0, 0);
  const Q = new Vector3().crossVectors(o.h, P).normalize();
  return out.copy(P).multiplyScalar(r * Math.cos(nu)).addScaledVector(Q, r * Math.sin(nu));
}

/**
 * 二体开普勒外推（仅椭圆轨道），原地更新相对中心天体的 r, v。
 * 用于把轨迹预测快速推进到很远之后的机动节点（地图显示用）。
 */
export function keplerPropagate(r: Vector3, v: Vector3, mu: number, dt: number): boolean {
  const rl = r.length();
  const h = new Vector3().crossVectors(r, v);
  const hl = h.length();
  const energy = v.lengthSq() / 2 - mu / rl;
  if (energy >= 0 || hl < 1e-6) return false;
  const a = -mu / (2 * energy);
  const eVec = new Vector3().crossVectors(v, h).divideScalar(mu).sub(r.clone().divideScalar(rl));
  let e = eVec.length();
  let P: Vector3;
  let nu0: number;
  if (e < 1e-7) {
    e = 0;
    P = r.clone().divideScalar(rl);
    nu0 = 0;
  } else {
    P = eVec.clone().divideScalar(e);
    nu0 = Math.acos(Math.max(-1, Math.min(1, P.dot(r) / rl)));
    if (r.dot(v) < 0) nu0 = 2 * Math.PI - nu0;
  }
  const Q = new Vector3().crossVectors(h, P).normalize();
  const n = Math.sqrt(mu / (a * a * a));
  const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
  const M = E0 - e * Math.sin(E0) + n * dt;
  let E = M;
  for (let i = 0; i < 30; i++) {
    const f = E - e * Math.sin(E) - M;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const p = (hl * hl) / mu;
  const rr = a * (1 - e * Math.cos(E));
  const vk = Math.sqrt(mu / p);
  r.copy(P).multiplyScalar(rr * Math.cos(nu)).addScaledVector(Q, rr * Math.sin(nu));
  v.copy(P).multiplyScalar(-vk * Math.sin(nu)).addScaledVector(Q, vk * (e + Math.cos(nu)));
  return true;
}

/** 圆轨道速度。 */
export function circularSpeed(mu: number, r: number): number {
  return Math.sqrt(mu / r);
}

/** 活力公式：给定半长轴的速度。 */
export function visViva(mu: number, r: number, a: number): number {
  return Math.sqrt(Math.max(0, mu * (2 / r - 1 / a)));
}
