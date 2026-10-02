import { Quaternion, Vector3 } from 'three';
import { BODIES, type Body, type BodyId, atmoPressure, bodyPosition, bodyRotation, bodyVelocity, dominantBody, fromBodyFixed, surfaceVelocity } from '../physics/bodies';
import { cloneDesign } from '../rocket/design';
import { FRAME_DEAD, FRAME_LANDED, FRAME_THRUST, FRAME_WATER, type DemoData, type DemoEvent } from './demo';
import { FlightSim, PHYS_WARP_MAX, RUDDER_HEADING_EAST, WARP_LEVELS, type SasMode, type SpeedMode } from './flight';
import { orbitalFrame } from './recorder';
import { FlightTrail } from './trail';
import { Vessel, type ChuteState, type RuntimePart } from './vessel';
import type { APMode } from './autopilot';

const UP = new Vector3(0, 1, 0);

// ------------------------------------------------------------------ 万有变量开普勒外推

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

/**
 * 二体问题外推（万有变量法，椭圆 / 抛物线 / 双曲线都适用，dt 可以为负）。
 * r0、v0 为相对中心天体的状态；结果写入 outR、outV。失败（数值发散）时返回 false。
 */
export function keplerUniversal(r0: Vector3, v0: Vector3, mu: number, dt: number, outR: Vector3, outV: Vector3): boolean {
  const r0l = r0.length();
  if (r0l < 1 || mu <= 0) return false;
  if (dt === 0) {
    outR.copy(r0);
    outV.copy(v0);
    return true;
  }
  const smu = Math.sqrt(mu);
  const sigma0 = r0.dot(v0) / smu;
  const alpha = 2 / r0l - v0.lengthSq() / mu;
  // 初值
  let x: number;
  if (alpha > 1e-12) x = smu * dt * alpha;
  else if (alpha < -1e-12) {
    const a = 1 / alpha;
    const sgn = Math.sign(dt);
    const arg = (-2 * mu * alpha * dt) / (r0.dot(v0) + sgn * Math.sqrt(-mu * a) * (1 - r0l * alpha));
    x = arg > 0 ? sgn * Math.sqrt(-a) * Math.log(arg) : (smu * dt) / r0l;
  } else x = (smu * dt) / r0l;
  // 拉盖尔-康威迭代（比牛顿法稳健）
  let ok = false;
  for (let i = 0; i < 60; i++) {
    const z = alpha * x * x;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F = sigma0 * x * x * C + (1 - alpha * r0l) * x * x * x * S + r0l * x - smu * dt;
    const dF = sigma0 * x * (1 - z * S) + (1 - alpha * r0l) * x * x * C + r0l;
    const ddF = sigma0 * (1 - z * C) + (1 - alpha * r0l) * x * (1 - z * S);
    const n = 5;
    const disc = Math.sqrt(Math.abs((n - 1) * (n - 1) * dF * dF - n * (n - 1) * F * ddF));
    const den = dF + Math.sign(dF) * disc;
    if (!isFinite(den) || den === 0) break;
    const dx = (n * F) / den;
    x -= dx;
    if (!isFinite(x)) break;
    if (Math.abs(dx) < 1e-10 * Math.max(1, Math.abs(x))) {
      ok = true;
      break;
    }
  }
  if (!ok) return false;
  const z = alpha * x * x;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - ((x * x) / r0l) * C;
  const g = dt - ((x * x * x) / smu) * S;
  outR.copy(r0).multiplyScalar(f).addScaledVector(v0, g);
  const rl = outR.length();
  const fd = (smu / (rl * r0l)) * (alpha * x * x * x * S - x);
  const gd = 1 - ((x * x) / rl) * C;
  outV.copy(r0).multiplyScalar(fd).addScaledVector(v0, gd);
  return isFinite(outR.x) && isFinite(outV.x);
}

// ------------------------------------------------------------------ 关键帧插值

export interface TrackState {
  /** 箭体几何原点（惯性系） */
  origin: Vector3;
  v: Vector3;
  q: Quaternion;
  thr: number;
  heat: number;
  temp: number;
  cmd: Vector3;
  landed: boolean;
  water: boolean;
  dead: boolean;
  thrust: boolean;
  warp: number;
}

export function newTrackState(): TrackState {
  return { origin: new Vector3(), v: new Vector3(), q: new Quaternion(), thr: 0, heat: 0, temp: 250, cmd: new Vector3(), landed: false, water: false, dead: false, thrust: false, warp: 0 };
}

/** 短于这个间隔的两帧之间用三次埃尔米特插值，更长的（真空滑行）用开普勒外推混合。 */
const HERMITE_MAX = 5;

const _rA = new Vector3();
const _vA = new Vector3();
const _rB = new Vector3();
const _vB = new Vector3();
const _qA = new Quaternion();
const _qB = new Quaternion();
const _p1 = new Vector3();
const _p2 = new Vector3();
const _u1 = new Vector3();
const _u2 = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _f1 = new Quaternion();
const _f2 = new Quaternion();
const _rot = new Quaternion();

export class DemoTrack {
  readonly d: DemoData;
  readonly n: number;
  readonly t0: number;
  readonly t1: number;
  private hint = 0;
  private fuelHint = 0;

  constructor(d: DemoData) {
    this.d = d;
    this.n = d.frames.t.length;
    this.t0 = d.frames.t[0];
    this.t1 = d.frames.t[this.n - 1];
  }

  /** 满足 t[i] <= t 的最大 i（夹在 [0, n-1]）。 */
  index(t: number): number {
    const T = this.d.frames.t;
    let i = this.hint;
    if (i >= this.n) i = this.n - 1;
    if (T[i] <= t && (i + 1 >= this.n || T[i + 1] > t)) return i;
    if (i + 1 < this.n && T[i + 1] <= t && (i + 2 >= this.n || T[i + 2] > t)) return (this.hint = i + 1);
    let lo = 0;
    let hi = this.n - 1;
    if (t <= T[0]) return (this.hint = 0);
    if (t >= T[hi]) return (this.hint = hi);
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    return (this.hint = lo);
  }

  frameTime(i: number): number {
    return this.d.frames.t[i];
  }

  flags(i: number): number {
    return this.d.frames.info[2 * i];
  }

  body(i: number): Body {
    return BODIES[this.d.frames.info[2 * i + 1] >> 4] ?? BODIES[3];
  }

  warp(i: number): number {
    return Math.min(WARP_LEVELS.length - 1, this.d.frames.info[2 * i + 1] & 15);
  }

  warpAt(t: number): number {
    return this.warp(this.index(t));
  }

  /** 模拟时间 t 对应的记录时真实时间。 */
  realAt(t: number): number {
    const F = this.d.frames;
    const i = this.index(t);
    if (i + 1 >= this.n || t <= F.t[i]) return F.real[i];
    const s = (t - F.t[i]) / (F.t[i + 1] - F.t[i]);
    return F.real[i] + s * (F.real[i + 1] - F.real[i]);
  }

  /** 记录时真实时间 r 对应的模拟时间（从第 i0 帧往后找）。 */
  timeAtReal(r: number, i0: number): number {
    const F = this.d.frames;
    let i = Math.max(0, Math.min(i0, this.n - 1));
    while (i + 1 < this.n && F.real[i + 1] <= r) i++;
    if (i + 1 >= this.n) return F.t[this.n - 1];
    const dr = F.real[i + 1] - F.real[i];
    const s = dr > 0 ? Math.max(0, Math.min(1, (r - F.real[i]) / dr)) : 1;
    return F.t[i] + s * (F.t[i + 1] - F.t[i]);
  }

  /** 第 i 帧的惯性系状态（着陆帧由天体固连坐标换算）。 */
  frameInertial(i: number, r: Vector3, v: Vector3, q: Quaternion): void {
    const F = this.d.frames;
    const t = F.t[i];
    r.set(F.pos[3 * i], F.pos[3 * i + 1], F.pos[3 * i + 2]);
    q.set(F.q[4 * i], F.q[4 * i + 1], F.q[4 * i + 2], F.q[4 * i + 3]).normalize();
    if (F.info[2 * i] & FRAME_LANDED) {
      const b = this.body(i);
      fromBodyFixed(b, t, r, r);
      surfaceVelocity(b, t, r, v);
      q.premultiply(_rot.setFromAxisAngle(UP, bodyRotation(b, t)));
    } else v.set(F.vel[3 * i], F.vel[3 * i + 1], F.vel[3 * i + 2]);
  }

  stateAt(t: number, out: TrackState): TrackState {
    const F = this.d.frames;
    const i = this.index(t);
    const j = Math.min(i + 1, this.n - 1);
    const tA = F.t[i];
    const tB = F.t[j];
    const fa = F.info[2 * i];
    const fb = F.info[2 * j];
    out.warp = this.warp(i);
    out.water = !!(fa & FRAME_WATER);
    out.dead = !!(fa & FRAME_DEAD);
    out.thrust = !!(fa & FRAME_THRUST);
    if (j === i || t <= tA) {
      this.frameInertial(i, out.origin, out.v, out.q);
      out.landed = !!(fa & FRAME_LANDED);
      out.thr = F.thr[i];
      out.heat = F.heat[i];
      out.temp = F.temp[i];
      out.cmd.set(F.cmd[3 * i], F.cmd[3 * i + 1], F.cmd[3 * i + 2]).multiplyScalar(1 / 127);
      return out;
    }
    const dt = tB - tA;
    const s = Math.min(1, Math.max(0, (t - tA) / dt));
    const short = dt <= HERMITE_MAX;
    const bA = this.body(i);
    const bB = this.body(j);
    out.landed = !!(fa & FRAME_LANDED) && !!(fb & FRAME_LANDED);
    if (out.landed && bA === bB) {
      // 两帧都着陆：在天体固连系中插值
      _p1.set(F.pos[3 * i], F.pos[3 * i + 1], F.pos[3 * i + 2]);
      _p2.set(F.pos[3 * j], F.pos[3 * j + 1], F.pos[3 * j + 2]);
      _p1.lerp(_p2, s);
      fromBodyFixed(bA, t, _p1, out.origin);
      surfaceVelocity(bA, t, out.origin, out.v);
      _qA.set(F.q[4 * i], F.q[4 * i + 1], F.q[4 * i + 2], F.q[4 * i + 3]);
      _qB.set(F.q[4 * j], F.q[4 * j + 1], F.q[4 * j + 2], F.q[4 * j + 3]);
      out.q.slerpQuaternions(_qA, _qB, s).normalize().premultiply(_rot.setFromAxisAngle(UP, bodyRotation(bA, t)));
    } else {
      this.frameInertial(i, _rA, _vA, _qA);
      this.frameInertial(j, _rB, _vB, _qB);
      let done = false;
      if (!short) done = this.keplerBlend(t, tA, tB, bA, bB, s, out);
      if (!done) hermite(_rA, _vA, _rB, _vB, dt, s, out.origin, out.v);
      if (short || !done) out.q.slerpQuaternions(_qA, _qB, s).normalize();
      else this.blendAttitude(t, tA, tB, bA, bB, s, out);
    }
    const lerp = (a: number, b: number) => a + (b - a) * s;
    out.thr = short ? lerp(F.thr[i], F.thr[j]) : F.thr[i];
    out.heat = lerp(F.heat[i], F.heat[j]);
    out.temp = lerp(F.temp[i], F.temp[j]);
    out.cmd.set(lerp(F.cmd[3 * i], F.cmd[3 * j]), lerp(F.cmd[3 * i + 1], F.cmd[3 * j + 1]), lerp(F.cmd[3 * i + 2], F.cmd[3 * j + 2])).multiplyScalar(1 / 127);
    return out;
  }

  /** 两端各自沿开普勒轨道外推到 t，再用平滑权重混合（消除摄动带来的差异）。 */
  private keplerBlend(t: number, tA: number, tB: number, bA: Body, bB: Body, s: number, out: TrackState): boolean {
    // A 端
    bodyPosition(bA, tA, _t1);
    bodyVelocity(bA, tA, _t2);
    _u1.subVectors(_rA, _t1);
    _u2.subVectors(_vA, _t2);
    if (!keplerUniversal(_u1, _u2, bA.mu, t - tA, _p1, _p2)) return false;
    _p1.add(bodyPosition(bA, t, _t1));
    _p2.add(bodyVelocity(bA, t, _t2));
    const pAx = _p1.x, pAy = _p1.y, pAz = _p1.z;
    const vAx = _p2.x, vAy = _p2.y, vAz = _p2.z;
    // B 端
    bodyPosition(bB, tB, _t1);
    bodyVelocity(bB, tB, _t2);
    _u1.subVectors(_rB, _t1);
    _u2.subVectors(_vB, _t2);
    if (!keplerUniversal(_u1, _u2, bB.mu, t - tB, _p1, _p2)) return false;
    _p1.add(bodyPosition(bB, t, _t1));
    _p2.add(bodyVelocity(bB, t, _t2));
    const w = s * s * (3 - 2 * s);
    const dw = (6 * s * (1 - s)) / (tB - tA);
    const dx = _p1.x - pAx, dy = _p1.y - pAy, dz = _p1.z - pAz;
    out.origin.set(pAx + w * dx, pAy + w * dy, pAz + w * dz);
    out.v.set(vAx + w * (_p2.x - vAx) + dw * dx, vAy + w * (_p2.y - vAy) + dw * dy, vAz + w * (_p2.z - vAz) + dw * dz);
    return true;
  }

  /** 长间隔的姿态：两帧之间更像“惯性保持”就在惯性系插值，更像“随轨道保持”（顺行等）就在轨道坐标系插值。 */
  private blendAttitude(t: number, tA: number, tB: number, bA: Body, bB: Body, s: number, out: TrackState): void {
    orbitalFrame(_t1.subVectors(_rA, bodyPosition(bA, tA, _u1)), _t2.subVectors(_vA, bodyVelocity(bA, tA, _u2)), _f1);
    const relA = _f1.invert().multiply(_qA);
    orbitalFrame(_t1.subVectors(_rB, bodyPosition(bB, tB, _u1)), _t2.subVectors(_vB, bodyVelocity(bB, tB, _u2)), _f2);
    const relB = _f2.invert().multiply(_qB);
    if (_qA.angleTo(_qB) <= relA.angleTo(relB) + 1e-4) {
      out.q.slerpQuaternions(_qA, _qB, s).normalize();
      return;
    }
    const b = s < 0.5 ? bA : bB;
    const rel = new Quaternion().slerpQuaternions(relA, relB, s);
    orbitalFrame(_t1.subVectors(out.origin, bodyPosition(b, t, _u1)), _t2.subVectors(out.v, bodyVelocity(b, t, _u2)), out.q);
    out.q.multiply(rel).normalize();
  }

  /** 燃料快照插值，写入 fuel[k]（按 fuelKeys 顺序，NaN 表示该零件已分离）。 */
  fuelAt(t: number, fuel: number[]): void {
    const T = this.d.fuel.t;
    const Fv = this.d.fuel.f;
    const m = this.d.fuelKeys.length;
    const n = T.length;
    if (!n || !m) return;
    let k = Math.min(this.fuelHint, n - 1);
    if (T[k] > t) k = 0;
    while (k + 1 < n && T[k + 1] <= t) k++;
    this.fuelHint = k;
    const k2 = Math.min(k + 1, n - 1);
    const s = k2 === k || t <= T[k] ? 0 : Math.min(1, (t - T[k]) / (T[k2] - T[k]));
    for (let i = 0; i < m; i++) {
      const a = Fv[k * m + i];
      const b = Fv[k2 * m + i];
      fuel[i] = isNaN(b) ? a : isNaN(a) ? b : a + (b - a) * s;
    }
  }
}

function hermite(rA: Vector3, vA: Vector3, rB: Vector3, vB: Vector3, dt: number, s: number, outR: Vector3, outV: Vector3): void {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  const ax = rA.x, ay = rA.y, az = rA.z;
  outR.set(
    h00 * ax + h10 * dt * vA.x + h01 * rB.x + h11 * dt * vB.x,
    h00 * ay + h10 * dt * vA.y + h01 * rB.y + h11 * dt * vB.y,
    h00 * az + h10 * dt * vA.z + h01 * rB.z + h11 * dt * vB.z,
  );
  outV.set(
    (d00 * ax + d10 * dt * vA.x + d01 * rB.x + d11 * dt * vB.x) / dt,
    (d00 * ay + d10 * dt * vA.y + d01 * rB.y + d11 * dt * vB.y) / dt,
    (d00 * az + d10 * dt * vA.z + d01 * rB.z + d11 * dt * vB.z) / dt,
  );
}

// ------------------------------------------------------------------ 回放驱动

/** 操作记录面板里的一条。 */
export interface LogEntry {
  t: number;
  text: string;
  kind: 'cap' | 'act' | 'good' | 'warn' | 'bad' | 'info';
}

const SAS_NAMES: Record<string, string> = {
  stability: '保持',
  prograde: '顺行',
  retrograde: '逆行',
  normal: '法向',
  antinormal: '反法向',
  radialOut: '径向外',
  radialIn: '径向内',
  maneuver: '机动方向',
  rudder: '方向舵',
};

const AP_NAMES: Record<string, string> = { ascent: '自动入轨', node: '执行机动', land: '自动着陆' };

/**
 * 回放：不做物理积分，而是把记录的关键帧插值出来的状态直接写进一个 FlightSim，
 * 照常交给 FlightScene / FlightHUD 渲染。分级、着陆腿、SAS、飞行辅助、机动节点等
 * 离散状态按时间重放；当时弹出的提示也原样重新弹出，所以能看到电脑（或玩家）每一步在做什么。
 */
export class ReplayPlayer {
  readonly data: DemoData;
  readonly track: DemoTrack;
  sim!: FlightSim;
  /** 当前回放到的模拟时间 */
  t: number;
  /** 回放速度（相对记录时的时间加速） */
  speed = 1;
  playing = true;
  /** 当前的电脑解说 / 飞行辅助状态 */
  caption = '';
  /** 操作记录（解说 + 关键操作），用于时间轴标记和操作面板 */
  readonly log: LogEntry[];
  private evIdx = 0;
  private metT0: number | null = null;
  private st = newTrackState();
  private fuel: number[];
  private fuelParts: (RuntimePart | undefined)[] = [];

  constructor(data: DemoData) {
    this.data = data;
    this.track = new DemoTrack(data);
    this.t = this.track.t0;
    this.fuel = new Array(data.fuelKeys.length).fill(NaN);
    this.log = buildLog(data.events);
  }

  get t0(): number {
    return this.track.t0;
  }

  get t1(): number {
    return this.track.t1;
  }

  get ended(): boolean {
    return this.t >= this.track.t1;
  }

  /** 为回放新建一个 FlightSim（与记录时同一设计与场景）。 */
  static createSim(data: DemoData): FlightSim {
    const sim = new FlightSim(cloneDesign(data.design), data.meta.scenario);
    return sim;
  }

  /** 绑定一个全新的 FlightSim，并定位到起点。 */
  attach(sim: FlightSim): void {
    this.sim = sim;
    this.resetSim();
    this.applyState(this.t0, 0);
    sim.updateTelemetry();
    sim.refreshPrediction();
  }

  /** 把 sim 恢复到起飞前（用于向后拖动时间轴）。场景需要另外重建箭体模型。 */
  resetSim(): void {
    const sim = this.sim;
    const V = new Vessel(cloneDesign(this.data.design));
    // 非发射台场景会在构造时预先激活第一级
    while (V.stageIndex < this.data.stage0 && V.activateStage());
    sim.vessel = V;
    sim.debris = [];
    sim.events = [];
    sim.trail = new FlightTrail();
    sim.nodes = [];
    sim.prediction = null;
    sim.invalidatePrediction();
    sim.destroyed = false;
    sim.destroyReason = '';
    sim.launched = this.data.meta.scenario !== 'pad';
    sim.metStarted = this.data.meta.scenario !== 'pad';
    sim.met = 0;
    sim.targetBody = null;
    sim.autopilot.mode = 'off';
    sim.autopilot.status = '';
    sim.autopilot.targetDir = null;
    sim.autoStaging = false;
    sim.autoWarpTo = null;
    sim.sasOn = true;
    sim.sasMode = 'stability';
    sim.speedMode = 'auto';
    sim.ullageT = 0;
    sim.missions.done.clear();
    sim.maxG = 0;
    this.evIdx = 0;
    this.metT0 = sim.metStarted ? this.t0 : null;
    this.t = this.t0;
    this.caption = '';
    this.fuelParts = this.data.fuelKeys.map((k) => V.byKey.get(k));
  }

  /** 时间加速下的回放步进：dtReal 为真实时间。 */
  advance(dtReal: number): void {
    const sim = this.sim;
    sim.lastSimDt = 0;
    if (!this.playing || sim.paused || this.ended) {
      this.applyState(this.t, 0);
      return;
    }
    // 按记录时的真实时间推进：1× 时节奏与当时一致（包括当时用的时间加速）
    const r = this.track.realAt(this.t) + Math.min(dtReal, 0.1) * this.speed;
    const t = this.track.timeAtReal(r, this.track.index(this.t));
    this.moveTo(Math.max(this.t, Math.min(t, this.t1)), dtReal, false);
  }

  /** 清掉所有残骸（跳转之后调用；先让场景处理完分离事件，再处理随之产生的 debrisGone）。 */
  clearDebris(): void {
    for (const d of this.sim.debris) d.alive = false;
    this.sim.updateDebris(0);
  }

  /**
   * 跳到时间 T（不弹提示、不播放特效）。返回 false 表示需要倒退：
   * 调用方先 resetSim 并重建场景里的箭体，再调用 seek，之后 clearDebris。
   */
  seek(T: number): boolean {
    T = Math.max(this.t0, Math.min(this.t1, T));
    if (T < this.t) return false;
    this.moveTo(T, 0, true);
    return true;
  }

  private moveTo(T: number, dtReal: number, silent: boolean): void {
    const sim = this.sim;
    const from = this.t;
    const ev = this.data.events;
    // 先记录航迹（使用分级前的状态即可）
    this.recordTrail(from, T, silent ? 20_000 : 400);
    while (this.evIdx < ev.length && ev[this.evIdx].t <= T) {
      const e = ev[this.evIdx++];
      if (e.k === 'stage') this.applyState(e.t, 0);
      this.applyEvent(e, silent);
    }
    const simDt = T - from;
    this.t = T;
    if (silent) {
      for (const rp of sim.vessel.parts) rp.igniteDelay = 0;
      sim.ullageT = 0;
    }
    this.applyState(T, simDt);
    sim.lastSimDt = silent ? 0 : simDt;
    if (!silent && simDt > 0) sim.updateDebris(simDt);
    sim.updateTelemetry();
    sim.body = sim.telemetry.body;
    sim.predictionAge += dtReal;
    if (silent) {
      sim.invalidatePrediction();
      sim.refreshPrediction();
    } else if (!sim.livePrediction) {
      // 没有主循环逐帧推进预测时（测试），按固定间隔整段计算
      const interval = this.st.thrust ? 0.25 : sim.warpIndex > PHYS_WARP_MAX ? 0.1 : 0.5;
      if (sim.predictionAge > interval) sim.refreshPrediction();
    }
  }

  /** 把 t 时刻的插值状态写进 sim。 */
  private applyState(t: number, simDt: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    const s = this.track.stateAt(t, this.st);
    // 燃料 → 质量、质心
    this.track.fuelAt(t, this.fuel);
    for (let i = 0; i < this.fuel.length; i++) {
      const rp = this.fuelParts[i];
      const f = this.fuel[i];
      if (rp && !isNaN(f)) rp.fuel = Math.max(0, Math.min(rp.fuelMax, f));
    }
    V.computeMassProps();
    V.q.copy(s.q);
    V.r.copy(V.com).applyQuaternion(V.q).add(s.origin);
    V.v.copy(s.v);
    V.w.set(0, 0, 0);
    V.throttle = s.thr;
    V.temperature = s.temp;
    sim.heatFlux = s.heat;
    sim.controlCmd.copy(s.cmd);
    sim.landed = s.landed;
    sim.touchingWater = s.water;
    sim.warpIndex = s.warp;
    sim.t = t;
    if (this.metT0 !== null) {
      sim.metStarted = true;
      sim.met = Math.max(0, t - this.metT0);
    }
    // 动画与推力（仅用于显示）
    if (simDt > 0) {
      for (const rp of V.parts) if (rp.igniteDelay && rp.igniteDelay > 0) rp.igniteDelay = Math.max(0, rp.igniteDelay - simDt);
      sim.ullageT = Math.max(0, sim.ullageT - simDt);
      const legT = V.legsDeployed ? 1 : 0;
      V.legDeploy += Math.sign(legT - V.legDeploy) * Math.min(Math.abs(legT - V.legDeploy), simDt / 1.5);
      if (V.chuteState === 'deployed') V.chuteDeploy = Math.min(1, V.chuteDeploy + simDt / 4);
    }
    const body = dominantBody(V.r, t);
    const alt = V.r.distanceTo(bodyPosition(body, t, _u1)) - body.radius;
    V.computeThrust(atmoPressure(body, alt) / 101325, !sim.destroyed && s.thrust);
    let thrust = 0;
    for (const rp of V.parts) thrust += rp.thrustNow;
    sim.lastThrustAccel.copy(UP).applyQuaternion(V.q).multiplyScalar(thrust / Math.max(1, V.mass));
  }

  private recordTrail(from: number, to: number, maxPts: number): void {
    if (to <= from) return;
    const sim = this.sim;
    const st = newTrackState();
    const r = new Vector3();
    const com = sim.vessel.com;
    const minStep = (to - from) / maxPts;
    // 采样步长随轨道尺度变化：真空滑行一圈约 120 个点，动力段、大气层内与贴地飞行更密
    const stepFor = (t: number): number => {
      if (st.thrust || st.landed) return 0.5;
      const body = dominantBody(st.origin, t);
      const rel = _t1.subVectors(st.origin, bodyPosition(body, t, _u1));
      const vr = _t2.subVectors(st.v, bodyVelocity(body, t, _u2)).length();
      const alt = rel.length() - body.radius;
      const low = alt < (body.atmosphere?.height ?? 0) + 10_000 || alt < 20_000;
      const k = (0.05 * rel.length()) / Math.max(1, vr);
      return Math.max(0.5, low ? Math.min(k, 2) : k);
    };
    let t = from;
    this.track.stateAt(t, st);
    for (let n = 0; t < to && n < maxPts; n++) {
      t = Math.min(to, t + Math.max(stepFor(t), minStep));
      this.track.stateAt(t, st);
      r.copy(com).applyQuaternion(st.q).add(st.origin);
      if (!st.landed || sim.launched) sim.trail.record(dominantBody(r, t), r, t, st.thrust);
    }
  }

  private applyEvent(e: DemoEvent, silent: boolean): void {
    const sim = this.sim;
    const V = sim.vessel;
    switch (e.k) {
      case 'ev': {
        const type = e.type as string;
        if (type === 'mission' && e.id) sim.missions.done.add(e.id as string);
        if (type === 'liftoff') sim.launched = true;
        if (silent) break;
        const p = e.pos as number[] | undefined;
        sim.emit({
          type,
          // 回放不算“首次”达成
          msg: (e.msg as string | undefined)?.replace('（首次！）', ''),
          level: e.level as 'info' | 'good' | 'warn' | 'bad' | undefined,
          size: e.size as number | undefined,
          id: e.id as string | undefined,
          pos: p ? new Vector3(p[0], p[1], p[2]) : undefined,
        });
        break;
      }
      case 'stage': {
        const want = e.i as number;
        let guard = 0;
        while (V.stageIndex < want && guard++ < 20) {
          const before = V.stageIndex;
          sim.stage(true);
          if (V.stageIndex === before) break;
        }
        this.fuelParts = this.data.fuelKeys.map((k) => sim.vessel.byKey.get(k));
        break;
      }
      case 'legs':
        V.legsDeployed = !!e.on;
        if (silent) V.legDeploy = V.legsDeployed ? 1 : 0;
        break;
      case 'chute': {
        const s = e.s as ChuteState;
        if (s !== 'deployed' || V.chuteState !== 'deployed') V.chuteDeploy = s === 'deployed' && silent ? 1 : 0;
        V.chuteState = s;
        break;
      }
      case 'sas':
        sim.sasOn = !!e.on;
        sim.sasMode = e.mode as SasMode;
        sim.rudderAngle = (e.rud as number) ?? 0;
        // 加入航向轴之前录制的 Demo 没有 hdg：方向舵只能朝正东
        sim.rudderHeading = (e.hdg as number) ?? RUDDER_HEADING_EAST;
        break;
      case 'ap':
        sim.autopilot.mode = e.mode as APMode;
        sim.autopilot.status = (e.s as string) ?? '';
        break;
      case 'node': {
        const dv = e.dv as number[] | undefined;
        sim.nodes = e.nt != null && dv ? [{ t: e.nt as number, dv: new Vector3(dv[0], dv[1], dv[2]), fixedDv: null, remaining: null }] : [];
        sim.invalidatePrediction();
        break;
      }
      case 'burn':
        // 开始点火后节点交给实际轨迹显示（避免预测重复计入已完成的 Δv）
        sim.nodes = [];
        sim.invalidatePrediction();
        break;
      case 'inf':
        V.infiniteFuel = !!e.on;
        break;
      case 'target':
        sim.targetBody = (e.b as BodyId | null) ?? null;
        break;
      case 'met':
        this.metT0 = e.t0 as number;
        break;
      case 'flame': {
        const rp = V.byKey.get(e.key as string);
        if (rp) rp.flameout = true;
        break;
      }
      case 'dead':
        sim.destroyed = true;
        sim.destroyReason = (e.reason as string) ?? '';
        break;
      case 'spd':
        sim.speedMode = e.m as SpeedMode;
        break;
      case 'cap':
        this.caption = e.msg as string;
        break;
    }
  }

  /** 引导栏显示的文字：电脑解说 + 飞行辅助状态。 */
  currentCaption(): string {
    const sim = this.sim;
    const ap = sim.autopilot.mode !== 'off' && sim.autopilot.status ? `🤖 ${sim.autopilot.status}` : '';
    if (this.caption && ap) return `${this.caption}　｜　${ap}`;
    return this.caption || ap;
  }

  /** 下一个 / 上一个操作记录的时间。 */
  nextLogTime(dir: 1 | -1): number | null {
    const L = this.log;
    if (dir > 0) {
      for (const e of L) if (e.t > this.t + 0.5) return e.t;
      return null;
    }
    for (let i = L.length - 1; i >= 0; i--) if (L[i].t < this.t - 2) return L[i].t;
    return this.t0;
  }
}

/** 从事件中整理出操作记录：电脑解说、分级、飞行辅助、机动规划、SAS 与关键提示。 */
export function buildLog(events: DemoEvent[]): LogEntry[] {
  const out: LogEntry[] = [];
  let lastAp = 'off';
  let lastSas = '';
  for (const e of events) {
    switch (e.k) {
      case 'cap':
        out.push({ t: e.t, text: e.msg as string, kind: 'cap' });
        break;
      case 'ev': {
        const type = e.type as string;
        const msg = (e.msg as string | undefined)?.replace('（首次！）', '');
        if (!msg) break;
        // 太琐碎的提示不进操作记录
        if (type === 'msg' && /时间加速|物理加速|没有|离地面太近/.test(msg)) break;
        if (type === 'stage') out.push({ t: e.t, text: `⏏ ${msg}`, kind: 'act' });
        else if (['mission', 'landed', 'soi', 'liftoff', 'victory', 'chuteOpen'].includes(type)) out.push({ t: e.t, text: msg, kind: (e.level as LogEntry['kind']) === 'bad' ? 'bad' : 'good' });
        else if (type === 'destroyed') out.push({ t: e.t, text: `💥 ${msg}`, kind: 'bad' });
        else if (type === 'flameout') out.push({ t: e.t, text: msg, kind: 'warn' });
        // “飞行辅助：xxx”已由 ap 事件记录
        else if (!/^飞行辅助：/.test(msg) && /飞行辅助|机动|节点|计算/.test(msg)) out.push({ t: e.t, text: msg, kind: 'info' });
        break;
      }
      case 'ap':
        if (e.mode !== lastAp && e.mode !== 'off') out.push({ t: e.t, text: `🤖 飞行辅助：${AP_NAMES[e.mode as string] ?? e.mode}`, kind: 'act' });
        lastAp = e.mode as string;
        break;
      case 'node': {
        const dv = e.dv as number[] | undefined;
        if (e.nt != null && dv) out.push({ t: e.t, text: `📐 规划机动：Δv ${Math.hypot(dv[0], dv[1], dv[2]).toFixed(1)} m/s`, kind: 'act' });
        break;
      }
      case 'burn':
        out.push({ t: e.t, text: '🔥 开始执行机动', kind: 'act' });
        break;
      case 'sas': {
        const k = `${e.on}|${e.mode}`;
        if (k !== lastSas && e.on && e.mode !== 'rudder' && e.mode !== 'stability' && lastAp === 'off') out.push({ t: e.t, text: `🧭 SAS：${SAS_NAMES[e.mode as string] ?? e.mode}`, kind: 'act' });
        lastSas = k;
        break;
      }
      case 'legs':
        out.push({ t: e.t, text: e.on ? '🦵 放下着陆腿' : '收起着陆腿', kind: 'act' });
        break;
      case 'target':
        if (e.b) out.push({ t: e.t, text: `🎯 目标：${BODIES.find((b) => b.id === e.b)?.name ?? e.b}`, kind: 'act' });
        break;
    }
  }
  // 同一时刻的重复提示只留一条
  return out.filter((e, i) => i === 0 || e.text !== out[i - 1].text || e.t - out[i - 1].t > 5);
}
