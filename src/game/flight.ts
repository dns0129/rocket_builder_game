import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  AU,
  BODY_BY_ID,
  EARTH,
  MOON,
  SUN,
  type Body,
  type BodyId,
  G0,
  atmoDensity,
  atmoPressure,
  bodyPosition,
  bodyRotation,
  bodyVelocity,
  dirFromLatLon,
  dominantBody,
  fromBodyFixed,
  LAUNCH_SITE,
  gravityAccel,
  machDragFactor,
  speedOfSound,
  surfaceVelocity,
  toBodyFixed,
} from '../physics/bodies';
import { adaptiveStep, rk4Step } from '../physics/integrate';
import { computeOrbit, type OrbitInfo } from '../physics/orbit';
import { terrainHeight, terrainNormal } from '../physics/terrain';
import type { RocketDesign } from '../rocket/design';
import { Debris, Vessel, type RuntimePart } from './vessel';
import { predict, predictSteps, nodeDvWorld, type JumpCache, type NodeSpec, type Prediction, type PredictOptions } from './predictor';
import { burnLead, burnTime, solveTransfer } from './maneuver';
import { makeBurnTarget, velocityToGain, type BurnTarget } from './guidance';
import { Autopilot } from './autopilot';
import { MissionTracker } from './missions';
import { FlightTrail } from './trail';

export const WARP_LEVELS = [1, 2, 3, 4, 10, 50, 100, 1000, 10000, 100000, 1000000];
export const PHYS_WARP_MAX = 3;
/** 方向舵设定与实际倾角相差较大时，每次只朝设定方向领先这么多，让火箭在“竖直—正东”平面内转过去 */
const RUDDER_LEAD = (60 * Math.PI) / 180;
/** 机动节点在点火前多久锁定（开始闭环制导） */
const NODE_LOCK_LEAD = 20;
/** 自动执行机动时，时间加速在点火前多久停下（留出转向的时间） */
const BURN_WARP_MARGIN = 15;
/** 级间分离后上面级延迟点火的时间 s（期间沉底发动机工作，下面级靠反推火箭拉开距离） */
export const IGNITION_DELAY = 0.8;
/** 沉底发动机提供的加速度 m/s² */
const ULLAGE_ACC = 1.2;
/** 简化难度：零件耐撞速度放宽的倍数 */
const IMPACT_TOLERANCE_SCALE = 1.5;
/** 简化难度：再入热流的缩放 */
const HEAT_SCALE = 0.8;

/** 每帧推进不超过 remain/3 的最高时间加速档位。 */
function warpIndexWithin(remain: number, dtReal: number): number {
  for (let i = WARP_LEVELS.length - 1; i > 0; i--) if (WARP_LEVELS[i] * dtReal * 3 < remain) return i;
  return 0;
}

export type SasMode = 'stability' | 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radialOut' | 'radialIn' | 'maneuver' | 'rudder';
export type SpeedMode = 'auto' | 'surface' | 'orbit';
export type Scenario = 'pad' | 'leo' | 'llo' | 'lmo';

export interface FlightEvent {
  type: string;
  msg?: string;
  level?: 'info' | 'good' | 'warn' | 'bad';
  pos?: Vector3;
  size?: number;
  debrisId?: number;
}

export interface Telemetry {
  body: Body;
  alt: number;
  radarAlt: number;
  terrainH: number;
  vVert: number;
  vHoriz: number;
  surfSpeed: number;
  orbSpeed: number;
  speedModeUsed: 'surface' | 'orbit';
  orbit: OrbitInfo;
  pressure: number;
  density: number;
  dynPressure: number;
  mach: number;
  gforce: number;
  heatFlux: number;
  temp: number;
  tempMax: number;
  thrust: number;
  twr: number;
  gLocal: number;
  mass: number;
  stageDv: number;
  lat: number;
  lon: number;
  up: Vector3;
  north: Vector3;
  east: Vector3;
  vSurfVec: Vector3;
  vOrbVec: Vector3;
  suicideIn: number; // 距建议点火的秒数（NaN 表示无意义）
  timeToImpact: number;
  inAtmosphere: boolean;
}

export interface ManeuverNode extends NodeSpec {
  fixedDv: Vector3 | null; // 开始执行后锁定的惯性系 Δv 矢量
  /** 剩余（待增）Δv：锁定后由闭环制导每帧重新计算，点火时按推力积分 */
  remaining: Vector3 | null;
  /** 闭环制导的目标（计划轨道上的一点）；退化轨道为 null，按固定惯性方向执行 */
  target?: BurnTarget | null;
  /** 当前点火方向（单位矢量），用于判断是否已经“烧过头” */
  burnDir?: Vector3 | null;
  /** 临近关机：不再更新制导，只按推力积分 */
  frozen?: boolean;
  /** 飞行辅助已在物理子步内精确关机 */
  done?: boolean;
  /** 行星际转移：到这个时刻自动重新精确计算节点 */
  replanAt?: number | null;
  replanTarget?: BodyId;
}

const UP = new Vector3(0, 1, 0);

/** 把角度规整到 (-π, π]。 */
export function wrapAngle(a: number): number {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q1 = new Quaternion();

export class FlightSim {
  t = 0;
  met = 0;
  metStarted = false;
  vessel: Vessel;
  debris: Debris[] = [];
  events: FlightEvent[] = [];
  warpIndex = 0;
  input = { pitch: 0, yaw: 0, roll: 0 };
  controlCmd = new Vector3(); // 实际控制量（x 俯仰, y 滚转, z 偏航），用于喷管摆动显示
  sasOn = true;
  sasMode: SasMode = 'stability';
  /** 方向舵设定的倾角（弧度，-π..π，可以转满一圈）：0 竖直向上，正值向东，负值向西，±π 竖直向下 */
  rudderAngle = 0;
  /** 沉底发动机剩余工作时间 s */
  ullageT = 0;
  /** 上一次 update 实际推进的模拟时间 s（粒子特效与之同步） */
  lastSimDt = 0;
  private sasHold: Quaternion | null = null;
  speedMode: SpeedMode = 'auto';
  landed = false;
  private landedBody: Body = EARTH;
  private landedPos = new Vector3();
  private landedQ = new Quaternion();
  private settle = 0;
  touchingWater = false;
  destroyed = false;
  destroyReason = '';
  launched = false;
  body: Body = EARTH;
  telemetry!: Telemetry;
  nodes: ManeuverNode[] = [];
  /** 已飞过的轨迹 */
  trail = new FlightTrail();
  prediction: Prediction | null = null;
  predictionAge = 999;
  /**
   * 实时轨迹预测（由主循环调用 pumpPrediction 驱动）：分片计算，每帧在时间预算内推进，
   * 算完立即开始下一次，因此预测轨迹几乎每帧都在更新，又不会让某一帧卡顿。
   * 关闭时（测试、无主循环）按固定间隔整段计算。
   */
  livePrediction = false;
  private predJob: { it: Generator<void, Prediction, void>; ver: number } | null = null;
  /** 机动节点每次增删改都加一，丢弃按旧节点算出来的预测 */
  private nodesVer = 0;
  /** 飞船受到引力以外的力（推力、气动、接触、分离）时加一：滑行状态变了，远期节点的跳跃缓存随之失效 */
  private coastEpoch = 0;
  private jumpCache: { cache: JumpCache; epoch: number; nodeT: number } | null = null;
  autopilot: Autopilot;
  missions: MissionTracker;
  isWater: (body: Body, dirBf: Vector3) => boolean = () => false;
  maxG = 0;
  lastThrustAccel = new Vector3();
  heatFlux = 0;
  private overheatWarned = false;
  /** 太阳辐射热流 W/m²（靠近太阳时会把飞船烤化） */
  solarFlux = 0;
  private sunWarned = false;
  /** 已提示“正在精确计算”，下一帧再真正计算（让提示先显示出来） */
  private replanNotified = false;
  /** 机动规划中选择的目标行星（用于提示与捕获） */
  targetBody: BodyId | null = null;
  private lastNonGravAcc = 0;
  landedOnMoonOnce = false;
  paused = false;
  autoWarpTo: number | null = null;
  scenario: Scenario;
  /** 简化：当前级燃料耗尽（油门仍打开）时自动分级；飞行辅助工作时由它自己负责 */
  autoStaging = true;
  private autoStageCooldown = 0;
  contactCount = 0;
  tempLimit = 1500;
  private warnedFlameout = new Set<string>();

  constructor(design: RocketDesign, scenario: Scenario = 'pad') {
    this.vessel = new Vessel(design);
    this.scenario = scenario;
    this.autopilot = new Autopilot(this);
    this.missions = new MissionTracker(this);
    this.setupScenario(scenario);
    this.updateTelemetry();
  }

  get warp(): number {
    return WARP_LEVELS[this.warpIndex];
  }

  emit(e: FlightEvent): void {
    this.events.push(e);
  }

  drainEvents(): FlightEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------------------------------------------------------------- 场景初始化

  private setupScenario(sc: Scenario): void {
    const V = this.vessel;
    if (sc === 'pad') {
      // 发射场的当地地平坐标（惯性系，t = 0）
      const up = fromBodyFixed(EARTH, 0, dirFromLatLon(LAUNCH_SITE.lat, LAUNCH_SITE.lon)).normalize();
      const north = new Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
      const east = new Vector3().crossVectors(north, up).normalize();
      const west = east.clone().negate();
      const south = north.clone().negate();
      V.q.setFromRotationMatrix(new Matrix4().makeBasis(south, up, west));
      const b = V.bounds();
      V.r.copy(up).multiplyScalar(EARTH.radius + (V.com.y - b.minY) - 0.01);
      V.v.copy(surfaceVelocity(EARTH, 0, V.r));
      V.throttle = 1;
      this.body = EARTH;
      this.lockLanded(EARTH);
      this.landed = true;
    } else {
      const body = sc === 'leo' ? EARTH : sc === 'llo' ? MOON : BODY_BY_ID.mars;
      const alt = sc === 'leo' ? 100_000 : sc === 'llo' ? 22_000 : 80_000;
      const bp = bodyPosition(body, 0, new Vector3());
      const bv = bodyVelocity(body, 0, new Vector3());
      // 从日照面起步：沿轨道飞行一段后仍处在白天（地球附近太阳方位角约 0.75 rad）
      let az = sc === 'leo' ? 0.45 : -0.5;
      if (sc === 'lmo') {
        const sd = bodyPosition(SUN, 0, new Vector3()).sub(bp);
        az = Math.atan2(-sd.z, sd.x) - 0.4;
      }
      const dir = new Vector3(Math.cos(az), 0, -Math.sin(az));
      const rr = body.radius + alt;
      V.r.copy(bp).addScaledVector(dir, rr);
      const vc = Math.sqrt(body.mu / rr);
      const pro = new Vector3().crossVectors(new Vector3(0, 1, 0), dir).normalize();
      V.v.copy(bv).addScaledVector(pro, vc);
      // 机头指向逆行方向（准备减速）
      const fwd = pro.clone().negate();
      const top = dir.clone();
      const right = new Vector3().crossVectors(fwd, top).normalize();
      V.q.setFromRotationMatrix(new Matrix4().makeBasis(right, fwd, top));
      V.throttle = 0;
      this.launched = true;
      this.metStarted = true;
      this.body = body;
      // 预先激活第一级（点燃发动机，油门为零）。含固体助推器的级无法关机，留给玩家手动点火。
      const st0 = V.stages[0];
      const allThrottleable = st0 && st0.ignite.every((k) => V.byKey.get(k)?.p.def.engine?.throttleable);
      if (st0 && st0.ignite.length && st0.decoupleSection === null && allThrottleable) {
        V.activateStage();
      }
      this.sasMode = 'stability';
    }
  }

  // ---------------------------------------------------------------- 玩家操作

  stage(): void {
    if (this.destroyed) return;
    const V = this.vessel;
    const origin = V.r.clone().sub(V.com.clone().applyQuaternion(V.q));
    const res = V.activateStage();
    if (!res) return;
    this.coastEpoch++;
    const wasLanded = this.landed;
    if (this.landed) {
      this.landed = false;
      this.settle = 0;
    }
    if (!this.metStarted && res.action.ignite.length) {
      this.metStarted = true;
      this.met = 0;
    }
    const fwd = UP.clone().applyQuaternion(V.q);
    // 分离弹簧/推杆给残骸的冲量；反作用力由剩余箭体承受
    const impulse = new Vector3();
    for (const g of res.groups) {
      const d = new Debris(g);
      d.q.copy(V.q);
      d.w.copy(V.w);
      d.r.copy(origin).add(d.com.clone().applyQuaternion(V.q));
      d.v.copy(V.v);
      const dv = new Vector3();
      const radial = g[0].p.radial;
      if (radial) {
        // 捆绑助推器：推杆把它向外推开，头部分离火箭推力更大，所以机头先向外偏转
        d.kind = 'booster';
        const outL = new Vector3(g[0].p.x, 0, g[0].p.z).normalize();
        dv.copy(outL).applyQuaternion(V.q).multiplyScalar(2).addScaledVector(fwd, -0.4);
        d.w.add(new Vector3(outL.z, 0, -outL.x).multiplyScalar(0.35));
        d.motorDir.copy(outL);
        d.motorAcc = 9;
        d.motorT = 0.9;
      } else if (wasLanded) {
        // 在地面上分离（月面起飞）：下面级作为发射台留在原地
        d.kind = 'stage';
        const b = this.landedBody;
        d.rest = b;
        d.restPos.copy(toBodyFixed(b, this.t, d.r));
        d.restQ.copy(_q1.setFromAxisAngle(UP, -bodyRotation(b, this.t))).multiply(d.q);
        d.w.set(0, 0, 0);
      } else {
        // 下面级：分离弹簧 + 顶部反推火箭使其减速后退，并带一点随机翻滚
        d.kind = 'stage';
        dv.copy(fwd).multiplyScalar(-1.2);
        d.w.add(new Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.12));
        d.motorDir.set(0, -1, 0);
        d.motorAcc = 7;
        d.motorT = 1.2;
      }
      d.v.add(dv);
      impulse.addScaledVector(dv, d.mass);
      this.debris.push(d);
      this.emit({ type: 'decouple', debrisId: d.id, pos: d.r.clone() });
    }
    if (res.groups.length) V.v.addScaledVector(impulse, -1 / Math.max(1, V.mass));
    // 分离的同时点火：先由沉底发动机工作，拉开距离后主发动机再点火
    if (res.groups.length && res.action.ignite.length && !wasLanded) {
      for (const k of res.action.ignite) {
        const rp = V.byKey.get(k);
        if (rp && !rp.flameout) rp.igniteDelay = IGNITION_DELAY;
      }
      this.ullageT = IGNITION_DELAY + 0.25;
    } else if (res.action.ignite.length) this.emit({ type: 'ignite' });
    if (res.action.chutes.length) this.emit({ type: 'chuteArm', msg: '降落伞已启用：低于 7 km 且速度足够低时自动张开', level: 'info' });
    this.emit({ type: 'stage', msg: `第 ${V.stageIndex} 级：${res.action.label}`, level: 'info' });
  }

  toggleLegs(): void {
    if (!this.vessel.hasLegs()) {
      this.emit({ type: 'msg', msg: '没有着陆腿', level: 'warn' });
      return;
    }
    this.vessel.legsDeployed = !this.vessel.legsDeployed;
    this.emit({ type: 'legs', msg: this.vessel.legsDeployed ? '着陆腿放下' : '着陆腿收起', level: 'info' });
  }

  armChute(): void {
    const V = this.vessel;
    if (!V.chutePart()) {
      this.emit({ type: 'msg', msg: '没有降落伞', level: 'warn' });
      return;
    }
    if (V.chuteState === 'stowed') {
      V.chuteState = 'armed';
      this.emit({ type: 'chuteArm', msg: '降落伞已启用：低于 7 km 且速度足够低时自动张开', level: 'info' });
    }
  }

  setSas(mode: SasMode): void {
    this.sasOn = true;
    this.sasMode = mode;
    this.sasHold = null;
  }

  toggleSas(): void {
    this.sasOn = !this.sasOn;
    this.sasHold = null;
    this.emit({ type: 'msg', msg: this.sasOn ? '姿态稳定 SAS 开启' : 'SAS 关闭', level: 'info' });
  }

  /** 箭体在“竖直—正东”平面内的倾角（弧度）：0 竖直向上，正值偏东，负值偏西。 */
  tiltAngle(): number {
    const tel = this.telemetry;
    const fwd = UP.clone().applyQuaternion(this.vessel.q);
    return Math.atan2(fwd.dot(tel.east), fwd.dot(tel.up));
  }

  get rudderActive(): boolean {
    return this.sasOn && this.sasMode === 'rudder' && this.autopilot.mode === 'off';
  }

  /**
   * 方向舵：直接设定箭体倾角，可以转满一圈（0 竖直向上，+90° 水平向东，-90° 水平向西，±180° 竖直向下），
   * 姿态控制系统（喷管摆动 + 尾翼 + 姿控）自动把火箭转过去并保持。
   */
  setRudder(angle: number): void {
    if (this.destroyed) return;
    if (this.autopilot.mode !== 'off') this.autopilot.disengage('手动操纵方向舵，飞行辅助已关闭（油门保持不变）', true);
    this.rudderAngle = wrapAngle(angle);
    this.sasOn = true;
    this.sasMode = 'rudder';
    this.sasHold = null;
  }

  /** 在当前设定（或当前实际倾角）基础上增减方向舵角度。 */
  nudgeRudder(delta: number): void {
    const base = this.rudderActive ? this.rudderAngle : this.tiltAngle();
    this.setRudder(base + delta);
  }

  /**
   * 现在是否应该分级：没有工作中的发动机而后面还有发动机，
   * 或者下一级要抛离的部分里点燃过的发动机都已熄火（例如燃尽的助推器）。
   */
  stageWanted(): boolean {
    const V = this.vessel;
    if (V.stageIndex >= V.stages.length) return false;
    const next = V.stages[V.stageIndex];
    // 只含降落伞的一级留给玩家（或自动开伞）
    if (next.chutes.length && !next.ignite.length && next.decoupleSection === null) return false;
    if (V.activeEngines().length === 0 && V.stages.slice(V.stageIndex).some((s) => s.ignite.length > 0)) return true;
    if (next.jettisonRadial.length || next.decoupleSection !== null) {
      const doomed = V.parts.filter(
        (rp) =>
          rp.p.def.engine &&
          rp.ignited &&
          ((next.decoupleSection !== null && rp.p.section === next.decoupleSection) || (rp.p.radial && next.jettisonRadial.includes(rp.p.parentUid))),
      );
      if (doomed.length && doomed.every((rp) => rp.flameout)) return true;
    }
    return false;
  }

  private checkAutoStage(dt: number): void {
    this.autoStageCooldown -= dt;
    if (!this.autoStaging || this.autopilot.mode !== 'off' || this.landed || this.destroyed || this.autoStageCooldown > 0) return;
    const V = this.vessel;
    if (V.throttle <= 0 || !V.parts.some((rp) => rp.p.def.engine && rp.ignited && rp.flameout)) return;
    if (!this.stageWanted()) return;
    this.stage();
    this.autoStageCooldown = 1;
    this.emit({ type: 'msg', msg: '燃料耗尽，已自动分级', level: 'info' });
  }

  maxWarpIndex(): number {
    if (this.destroyed) return WARP_LEVELS.length - 1;
    if (this.landed) return WARP_LEVELS.length - 1;
    if (this.solarFlux > 20_000) return PHYS_WARP_MAX;
    const tel = this.telemetry;
    if (this.vessel.parts.some((rp) => rp.thrustNow > 0 || (rp.igniteDelay ?? 0) > 0) || this.ullageT > 0) return PHYS_WARP_MAX;
    if (this.autopilot.mode === 'ascent' || this.autopilot.mode === 'land') return PHYS_WARP_MAX;
    if (tel.inAtmosphere) return PHYS_WARP_MAX;
    const s = tel.body.radius / EARTH.radius;
    const a = tel.radarAlt;
    if (a < 3000 * s + 2000) return PHYS_WARP_MAX;
    if (a < 20_000 * s) return 5;
    if (a < 60_000 * s) return 6;
    // 等待奔月 / 行星际发射窗口可能需要数天到数十天，低轨道也允许 ×100000
    if (a < 2_000_000 * s) return 9;
    // 行星际巡航（日心轨道或远离行星）允许 ×1000000
    return tel.body.id === 'sun' || a > 60 * tel.body.radius ? WARP_LEVELS.length - 1 : 9;
  }

  setWarp(i: number): void {
    const max = this.maxWarpIndex();
    const ni = Math.max(0, Math.min(i, WARP_LEVELS.length - 1));
    if (ni > max) {
      this.warpIndex = max;
      const reason = this.vessel.parts.some((rp) => rp.thrustNow > 0)
        ? '发动机工作时只能使用 ×4 以内的物理加速'
        : this.telemetry.inAtmosphere
          ? '在大气层内只能使用 ×4 以内的物理加速'
          : '离地面太近，无法使用更高倍率';
      this.emit({ type: 'msg', msg: reason, level: 'warn' });
      return;
    }
    this.warpIndex = ni;
  }

  warpToTime(t: number): void {
    this.autoWarpTo = t;
  }

  // ---------------------------------------------------------------- 主循环

  update(dtReal: number): void {
    this.lastSimDt = 0;
    if (this.paused) return;
    dtReal = Math.min(dtReal, 0.05);
    // 自动时间加速
    if (this.autoWarpTo !== null) {
      const remain = this.autoWarpTo - this.t;
      if (remain <= 0.5) {
        this.autoWarpTo = null;
        this.warpIndex = 0;
      } else {
        this.warpIndex = Math.min(warpIndexWithin(remain, dtReal), this.maxWarpIndex());
      }
    }
    if (this.warpIndex > this.maxWarpIndex()) {
      this.warpIndex = this.maxWarpIndex();
    }
    // 飞行辅助负责的机动还没烧完：无论手动还是自动加速，“定轨”高倍加速都不能越过点火前 BURN_WARP_MARGIN 秒；
    // 之后（包括点火时还没对准、仍在转向）只允许 ×4 以内的物理加速
    const hold = this.autopilot.burnWarpHold();
    if (hold !== null) {
      const remain = hold - BURN_WARP_MARGIN - this.t;
      const cap = Math.max(Math.min(PHYS_WARP_MAX, this.warpIndex), remain > 0.5 ? warpIndexWithin(remain, dtReal) : 0);
      if (this.warpIndex > cap) {
        this.warpIndex = cap;
        if (this.autoWarpTo !== null && remain <= 0.5) this.autoWarpTo = null;
      }
    }
    const simDt = dtReal * this.warp;
    this.lastSimDt = simDt;
    this.autopilot.update(dtReal);

    if (this.warpIndex > PHYS_WARP_MAX && !this.landed && !this.destroyed) {
      this.stepRails(simDt);
    } else if (this.warpIndex > PHYS_WARP_MAX) {
      // 着陆状态（或已损毁）下的高倍时间加速：直接推进时间，不必逐小步积分
      this.t += simDt;
      this.coastEpoch++;
      if (this.landed && !this.destroyed) this.applyLanded();
    } else {
      const near = this.telemetry ? this.telemetry.radarAlt < 200 : true;
      const hMax = near ? 1 / 480 : 1 / 200;
      const n = Math.max(1, Math.ceil(simDt / hMax));
      const h = simDt / n;
      for (let i = 0; i < n; i++) this.stepPhysics(h);
    }
    if (this.metStarted) this.met += simDt;
    this.checkAutoStage(dtReal);
    this.updateDebris(simDt);
    this.updateTelemetry();
    this.checkSoi();
    this.missions.update();
    this.updateNodes();
    this.checkReplan();
    this.predictionAge += dtReal;
    if (!this.livePrediction) {
      const interval = this.maneuvering() ? 0.25 : this.warpIndex > PHYS_WARP_MAX ? 0.1 : 0.5;
      if (this.predictionAge > interval) this.refreshPrediction();
    }
  }

  /** 发动机（或沉底发动机）正在工作：轨迹时刻在变，需要连续刷新预测。 */
  private maneuvering(): boolean {
    return this.ullageT > 0 || this.vessel.parts.some((rp) => rp.thrustNow > 0);
  }

  /** 预测的起始状态；返回 null 表示此时不需要预测（已损毁、停在地面上、贴地低速）。 */
  private predictionInput(): { r: Vector3; v: Vector3; t: number; nodes: NodeSpec[]; opts: PredictOptions } | null {
    if (this.destroyed || (this.landed && this.nodes.length === 0)) return null;
    const V = this.vessel;
    const tel = this.telemetry;
    // 在地表附近低速飞行时轨迹没有意义
    if (tel && tel.radarAlt < 50 && tel.surfSpeed < 5) return null;
    // 行星际航行：预测要覆盖数月的日心轨道
    const o = tel.orbit;
    const far = tel.body.id === 'sun' || (tel.body.id !== 'moon' && (o.hyperbolic || o.ap > tel.body.soi * 0.8)) || this.nodes.length > 0;
    // 远期节点：节点前的滑行段用数值积分跳过，结果在飞船一直滑行、节点时刻不变时可以复用
    const n0 = this.nodes[0];
    let jump: JumpCache | undefined;
    if (n0) {
      const jc = this.jumpCache;
      if (!jc || jc.epoch !== this.coastEpoch || jc.nodeT !== n0.t) this.jumpCache = { cache: { state: null }, epoch: this.coastEpoch, nodeT: n0.t };
      jump = this.jumpCache!.cache;
    }
    return {
      r: V.r.clone(),
      v: V.v.clone(),
      t: this.t,
      // 快照：分片计算期间节点可能被修改
      nodes: this.nodes.map((n) => ({ t: n.t, dv: n.dv.clone() })),
      opts: far ? { maxSteps: 4000, eta: 0.02, maxTime: 9e7, jump } : { maxSteps: 2500, eta: 0.02, jump },
    };
  }

  /** 立即（同步）重新计算预测轨迹。 */
  refreshPrediction(): void {
    this.predictionAge = 0;
    this.predJob = null;
    const inp = this.predictionInput();
    this.prediction = inp ? predict(inp.r, inp.v, inp.t, inp.nodes, inp.opts) : null;
  }

  /**
   * 实时预测：在 budgetMs 毫秒内推进当前的分片计算；算完就换上新结果，下一帧接着从最新状态开始。
   * 发动机工作或高倍时间加速时连续刷新（通常每一两帧一次）；滑行时轨迹基本不变，每 0.1 s 刷新一次。
   */
  pumpPrediction(budgetMs: number): void {
    if (!this.livePrediction || this.paused) return;
    const t0 = performance.now();
    if (!this.predJob) {
      const busy = this.maneuvering() || this.warpIndex > PHYS_WARP_MAX || (this.autopilot.mode !== 'off' && this.autopilot.mode !== 'node');
      if (!busy && this.predictionAge < 0.1) return;
      const inp = this.predictionInput();
      this.predictionAge = 0;
      if (!inp) {
        this.prediction = null;
        return;
      }
      this.predJob = { it: predictSteps(inp.r, inp.v, inp.t, inp.nodes, inp.opts), ver: this.nodesVer };
    }
    const job = this.predJob;
    let res = job.it.next();
    while (!res.done && performance.now() - t0 < budgetMs) res = job.it.next();
    if (!res.done) return;
    this.predJob = null;
    if (job.ver === this.nodesVer) this.prediction = res.value;
  }

  private checkSoi(): void {
    const b = dominantBody(this.vessel.r, this.t);
    if (b !== this.body) {
      const old = this.body;
      const msg =
        b.parent === old.id
          ? `进入${b.name}引力影响球`
          : `离开${old.name}引力影响球，${b.id === 'sun' ? '进入环绕太阳的轨道' : `返回${b.name}轨道`}`;
      this.emit({ type: 'soi', msg, level: 'good' });
      this.body = b;
      this.predictionAge = 999;
    }
  }

  // ---------------------------------------------------------------- 着陆锁定

  private lockLanded(body: Body): void {
    const V = this.vessel;
    this.landedBody = body;
    this.landedPos.copy(toBodyFixed(body, this.t, V.r));
    const rot = _q1.setFromAxisAngle(UP, -bodyRotation(body, this.t));
    this.landedQ.copy(rot).multiply(V.q);
    V.w.set(0, 0, 0);
  }

  private applyLanded(): void {
    const V = this.vessel;
    const b = this.landedBody;
    fromBodyFixed(b, this.t, this.landedPos, V.r);
    surfaceVelocity(b, this.t, V.r, V.v);
    const rot = _q1.setFromAxisAngle(UP, bodyRotation(b, this.t));
    V.q.copy(rot).multiply(this.landedQ);
    V.w.set(0, 0, 0);
  }

  // ---------------------------------------------------------------- 物理步进

  private stepRails(dt: number): void {
    const V = this.vessel;
    let remaining = dt;
    let guard = 0;
    for (const rp of V.parts) {
      rp.thrustNow = 0;
      rp.throttleEff = 0;
    }
    while (remaining > 1e-6 && guard++ < 4000) {
      const h = Math.min(remaining, adaptiveStep(V.r, this.t, 0.008));
      rk4Step(V.r, V.v, this.t, h);
      this.t += h;
      remaining -= h;
      const b = dominantBody(V.r, this.t);
      this.trail.record(b, V.r, this.t, false);
      const alt = V.r.distanceTo(bodyPosition(b, this.t, _v1)) - b.radius;
      if (b.kind === 'star' && alt < 15 * b.radius) {
        this.warpIndex = 0;
        this.emit({ type: 'msg', msg: '太靠近太阳，时间加速已停止', level: 'warn' });
        break;
      }
      if (b.atmosphere && alt < b.atmosphere.height) {
        this.warpIndex = 0;
        this.emit({ type: 'msg', msg: '进入大气层，时间加速已停止', level: 'warn' });
        break;
      }
      if (alt < b.maxTerrain + 2500) {
        const th = terrainHeight(b, toBodyFixed(b, this.t, V.r, _v2).normalize(), 50);
        if (alt - th < 2500) {
          this.warpIndex = 0;
          this.emit({ type: 'msg', msg: '接近地表，时间加速已停止', level: 'warn' });
          break;
        }
      }
    }
    if (remaining > 1e-6 && this.warpIndex <= PHYS_WARP_MAX) {
      const n = Math.max(1, Math.ceil(remaining / (1 / 200)));
      const h = remaining / n;
      for (let i = 0; i < Math.min(n, 400); i++) this.stepPhysics(h);
    }
    // 定轨加速时直接对准 SAS（或飞行辅助）的目标，加速结束时已经指向点火方向
    if ((this.sasOn && this.sasMode !== 'stability') || (this.autopilot.mode !== 'off' && this.autopilot.targetDir)) {
      const d = this.sasTargetDir();
      if (d) {
        const fwd = UP.clone().applyQuaternion(V.q);
        _q1.setFromUnitVectors(fwd, d);
        V.q.premultiply(_q1).normalize();
      }
    }
    V.w.set(0, 0, 0);
  }

  private stepPhysics(h: number): void {
    const V = this.vessel;
    if (this.destroyed) {
      this.t += h;
      return;
    }
    // 着陆腿动画
    const legTarget = V.legsDeployed ? 1 : 0;
    V.legDeploy += Math.sign(legTarget - V.legDeploy) * Math.min(Math.abs(legTarget - V.legDeploy), h / 1.5);

    const inputActive = this.input.pitch !== 0 || this.input.yaw !== 0 || this.input.roll !== 0;
    if (this.landed) {
      const wantThrust = V.computeThrust(1, true) > 0;
      if (wantThrust || inputActive) {
        this.landed = false;
        this.settle = 0;
      } else {
        this.applyLanded();
        this.coastEpoch++;
        this.t += h;
        V.chuteDeploy = Math.max(0, V.chuteDeploy - h * 0.5);
        return;
      }
    }

    V.updateMassProps();
    const m = V.mass;
    const body = dominantBody(V.r, this.t);
    const bp = bodyPosition(body, this.t, _v1);
    const rel = _v2.subVectors(V.r, bp);
    const dist = rel.length();
    const up = rel.clone().divideScalar(dist);
    const alt = dist - body.radius;
    if (body.kind !== 'rocky' && alt < 0) {
      this.destroy(body.kind === 'gas' ? `坠入${body.name}的大气深处，被巨大的压力压碎` : '坠入太阳，瞬间汽化');
      return;
    }
    const pressure = atmoPressure(body, alt);
    const rho = atmoDensity(body, alt);
    // 太阳辐射：1361 W/m²（1 AU），按距离平方增长；约 35% 被船体吸收
    const dSun = V.r.distanceTo(bodyPosition(SUN, this.t, _v4));
    this.solarFlux = 1361 * 0.35 * (AU / dSun) ** 2;
    let lit = false;
    for (const rp of V.parts) {
      if (rp.igniteDelay && rp.igniteDelay > 0) {
        rp.igniteDelay -= h;
        if (rp.igniteDelay <= 0) {
          rp.igniteDelay = 0;
          lit = true;
        }
      }
    }
    if (lit) this.emit({ type: 'ignite' });
    let thrust = V.computeThrust(pressure / 101325, true);

    const F = new Vector3();
    const tauB = new Vector3();
    const fwd = UP.clone().applyQuaternion(V.q);
    const ullage = this.ullageT > 0 ? ULLAGE_ACC : 0;
    // 飞行辅助执行机动：在物理子步内精确关机（最后一个子步按比例缩小推力），不必等到下一帧再判断，
    // 否则在 ×4 物理加速下一帧就可能多烧零点几 m/s——奔月时这意味着远地点差出几百公里
    const node = this.nodes[0];
    if (thrust > 0 && node?.remaining && !node.done && this.autopilot.executingNode) {
      const along = node.remaining.dot(fwd);
      const dvStep = (thrust / m + ullage) * h;
      if (along <= dvStep) {
        const k = Math.max(0, along - ullage * h) / (dvStep - ullage * h);
        for (const rp of V.parts) {
          rp.thrustNow *= k;
          rp.throttleEff *= k;
        }
        thrust *= k;
        node.done = true;
        V.throttle = 0;
      }
    }
    F.addScaledVector(fwd, thrust);
    // 沉底发动机：小型固体火箭，给上面级一个向前的小加速度
    if (ullage > 0) {
      F.addScaledVector(fwd, m * ullage);
      this.ullageT = Math.max(0, this.ullageT - h);
    }
    // 计入沉底发动机：它同样改变速度，机动的剩余 Δv 要扣掉
    this.lastThrustAccel.copy(fwd).multiplyScalar(thrust / m + ullage);

    // ------------------------------------------------ 气动
    const vSurf = surfaceVelocity(body, this.t, V.r, _v3);
    const vAir = V.v.clone().sub(vSurf);
    const speed = vAir.length();
    let qdyn = 0;
    const qInv = V.q.clone().invert();
    if (rho > 0 && speed > 0.05) {
      qdyn = 0.5 * rho * speed * speed;
      const a = V.aero;
      const mach = speed / speedOfSound(alt);
      const mf = machDragFactor(mach);
      const vb = vAir.clone().applyQuaternion(qInv);
      const u = vb.y;
      const cdAx = u > 0 ? a.cdFront : a.cdBack;
      const fAx = -0.5 * rho * speed * u * cdAx * a.areaFront * mf;
      const nArea = a.areaSide * 0.9 + a.finArea * 2.5;
      const kN = -0.5 * rho * speed * nArea * mf;
      const fN = new Vector3(vb.x * kN, 0, vb.z * kN);
      const fB = new Vector3(fN.x, fAx, fN.z);
      // 法向力作用于压心
      const lever = new Vector3(0, a.copY - V.com.y, 0);
      tauB.add(lever.cross(fN));
      // 气动阻尼
      const b = V.bounds();
      const L = b.maxY - b.minY;
      const dampI = a.dampK * (L * L) / 12 + a.finArea * 2.5 * (a.finY - V.com.y) ** 2;
      const kd = 0.5 * rho * speed * dampI * 0.6;
      tauB.x -= V.w.x * kd;
      tauB.z -= V.w.z * kd;
      tauB.y -= V.w.y * kd * 0.05;
      F.add(fB.applyQuaternion(V.q));

      // 再入加热（Sutton-Graves）
      // 机头朝前（上升段，有整流/细长外形）时加热较弱；尾部/隔热罩朝前的钝体再入取全值
      const noseFirst = u > 0;
      this.heatFlux = HEAT_SCALE * 1.83e-4 * Math.sqrt(rho / a.noseRadius) * speed * speed * speed * (noseFirst ? 0.5 : 1);
    } else {
      this.heatFlux = 0;
    }

    // ------------------------------------------------ 降落伞
    const chute = V.chutePart();
    // 简化：在大气中下落时自动启用降落伞（真正张开仍要等高度和速度合适）
    if (chute && V.chuteState === 'stowed' && this.launched && rho > 0.01 && alt < 12_000 && vAir.dot(up) < -30) {
      V.chuteState = 'armed';
      this.emit({ type: 'chuteArm', msg: '正在下落：降落伞已自动启用', level: 'info' });
    }
    if (chute && V.chuteState !== 'stowed' && V.chuteState !== 'cut') {
      if (V.chuteState === 'armed' && rho > 0.02 && alt < 7000 && speed < 300) {
        V.chuteState = 'deploying';
        V.chuteDeploy = 0;
        this.emit({ type: 'chuteOpen', msg: '减速伞张开', level: 'good' });
      }
      if (V.chuteState === 'deploying' && speed < 90 && alt < 2500 + body.maxTerrain) {
        V.chuteState = 'deployed';
        this.emit({ type: 'chuteOpen', msg: '主伞张开', level: 'good' });
      }
      if (V.chuteState === 'deploying' || V.chuteState === 'deployed') {
        if (V.chuteState === 'deployed') V.chuteDeploy = Math.min(1, V.chuteDeploy + h / 4);
        const e = V.chuteDeploy;
        const area = chute.p.def.parachute!.cda * (V.chuteState === 'deploying' ? 0.04 : 0.04 + 0.96 * e * e);
        if (rho > 0 && speed > 0.1) {
          let f = 0.5 * rho * speed * speed * area;
          f = Math.min(f, 4.5 * G0 * m);
          const fW = vAir.clone().normalize().multiplyScalar(-f);
          F.add(fW);
          const fB = fW.clone().applyQuaternion(qInv);
          const pos = new Vector3(chute.p.x, chute.p.yTop + 1.5, chute.p.z).sub(V.com);
          tauB.add(pos.cross(fB));
          tauB.x -= V.w.x * V.inertia.x * 2;
          tauB.z -= V.w.z * V.inertia.z * 2;
        }
        if (speed > 380 && rho > 0) {
          V.chuteState = 'cut';
          this.emit({ type: 'msg', msg: '速度过快，降落伞被撕裂！', level: 'bad' });
        }
      }
    }

    // ------------------------------------------------ 地面接触
    this.contactCount = 0;
    const bodyDir = toBodyFixed(body, this.t, V.r).normalize();
    const hN = terrainHeight(body, bodyDir);
    const radar = alt - hN;
    const bnd = V.bounds();
    const reach = Math.max(bnd.maxY - V.com.y, V.com.y - bnd.minY, bnd.radius) + 3;
    let crash: RuntimePart | null = null;
    let crashSpeed = 0;
    this.touchingWater = false;
    if (radar < reach && body.kind === 'rocky') {
      const nBf = terrainNormal(body, bodyDir, new Vector3());
      const rotB = bodyRotation(body, this.t);
      const nW = nBf.clone().applyAxisAngle(UP, rotB);
      const water = body.hasOcean && this.isWater(body, bodyDir);
      this.touchingWater = water;
      const nHull = V.contacts.filter((c) => c.kind === 'hull').length || 1;
      const nLeg = V.contacts.filter((c) => c.kind === 'leg').length || 1;
      const pb = new Vector3();
      const arm = new Vector3();
      const pw = new Vector3();
      const vp = new Vector3();
      const vg = new Vector3();
      for (const c of V.contacts) {
        if (c.kind === 'leg' && V.legDeploy < 0.6) continue;
        V.contactPos(c, pb);
        arm.subVectors(pb, V.com);
        const armW = arm.clone().applyQuaternion(V.q);
        pw.copy(V.r).add(armW);
        const prel = pw.clone().sub(bp);
        const pd = prel.length();
        // 粗略筛选
        const approxAlt = pd - body.radius - hN;
        if (approxAlt > 4) continue;
        const pdir = prel.clone().divideScalar(pd);
        const pdirBf = pdir.clone().applyAxisAngle(UP, -rotB);
        const th = terrainHeight(body, pdirBf);
        const pen = body.radius + th - pd;
        if (pen <= 0) continue;
        this.contactCount++;
        vp.copy(V.w).cross(arm).applyQuaternion(V.q).add(V.v);
        surfaceVelocity(body, this.t, pw, vg);
        const vrel = vp.sub(vg);
        const vn = vrel.dot(nW);
        const isLeg = c.kind === 'leg';
        const tol = c.tolerance * (water ? 1.6 : 1) * IMPACT_TOLERANCE_SCALE;
        if (-vn > tol && -vn > crashSpeed) {
          crashSpeed = -vn;
          crash = V.byKey.get(c.partKey) ?? null;
        }
        const wn = isLeg ? 14 : 30;
        const nPts = isLeg ? nLeg : nHull;
        let k = (m * wn * wn) / nPts;
        let cd = (2 * 0.8 * m * wn) / nPts;
        if (water) {
          k *= 0.25;
          cd *= 1.5;
        }
        const fn = Math.max(0, k * Math.min(pen, 2) - cd * vn);
        const vt = vrel.addScaledVector(nW, -vn);
        const vtl = vt.length();
        const fc = new Vector3().addScaledVector(nW, fn);
        if (vtl > 1e-4) {
          const mu = water ? 0.15 : 0.9;
          const ft = Math.min(mu * fn, cd * 2 * vtl);
          fc.addScaledVector(vt, -ft / vtl);
        }
        F.add(fc);
        tauB.add(arm.clone().cross(fc.applyQuaternion(qInv)));
      }
    }
    if (crash) {
      this.destroy(`${crash.p.def.name} 以 ${crashSpeed.toFixed(1)} m/s 撞击${body.name}${this.touchingWater ? '海面' : '表面'}`);
      return;
    }

    // ------------------------------------------------ 控制力矩
    const tc = V.controlTorque(qdyn);
    const cmd = this.computeControl(tc.pitch, tc.roll);
    this.controlCmd.copy(cmd);
    tauB.x += cmd.x * tc.pitch;
    tauB.y += cmd.y * tc.roll;
    tauB.z += cmd.z * tc.pitch;

    // ------------------------------------------------ 积分
    const g = gravityAccel(V.r, this.t, new Vector3());
    const nonGrav = F.clone().divideScalar(m);
    this.lastNonGravAcc = nonGrav.length();
    if (this.lastNonGravAcc > 1e-9) this.coastEpoch++;
    V.v.addScaledVector(g, h).addScaledVector(nonGrav, h);
    V.r.addScaledVector(V.v, h);

    const I = V.inertia;
    const w = V.w;
    const Iw = new Vector3(I.x * w.x, I.y * w.y, I.z * w.z);
    const gyro = new Vector3().crossVectors(w, Iw);
    w.x += ((tauB.x - gyro.x) / I.x) * h;
    w.y += ((tauB.y - gyro.y) / I.y) * h;
    w.z += ((tauB.z - gyro.z) / I.z) * h;
    const wl = w.length();
    if (wl > 8) w.multiplyScalar(8 / wl);
    if (wl > 1e-9) {
      _q1.setFromAxisAngle(w.clone().divideScalar(wl), wl * h);
      V.q.multiply(_q1).normalize();
    }

    // 机动剩余 Δv
    for (const n of this.nodes) if (n.remaining) n.remaining.addScaledVector(this.lastThrustAccel, -h);

    // ------------------------------------------------ 燃料
    const fo = V.consumeFuel(h);
    for (const k of fo) {
      if (this.warnedFlameout.has(k)) continue;
      this.warnedFlameout.add(k);
      const rp = V.byKey.get(k);
      this.emit({ type: 'flameout', msg: `${rp?.p.def.name ?? '发动机'} 燃料耗尽`, level: 'warn' });
    }

    // ------------------------------------------------ 温度
    const a = V.aero;
    const vbDir = vAir.clone().applyQuaternion(qInv);
    const tailFirst = speed > 1 && vbDir.y < -0.6 * speed;
    const protectedByShield = tailFirst && a.shieldBottom;
    const leading = V.byKey.get(speed > 1 && vbDir.y < 0 ? a.bottomKey : a.topKey);
    const tMax = protectedByShield ? 3400 : (leading?.p.def.maxTemp ?? 1500);
    this.tempLimit = tMax;
    const sigma = 5.67e-8 * 0.85;
    const tAmb = 250;
    const dT = (this.heatFlux + this.solarFlux - sigma * (V.temperature ** 4 - tAmb ** 4)) / 11_000;
    V.temperature = Math.max(tAmb, V.temperature + dT * h);
    if (V.temperature > tMax * 0.85 && !this.overheatWarned) {
      this.overheatWarned = true;
      this.emit({ type: 'msg', msg: '警告：蒙皮温度接近极限！', level: 'bad' });
    }
    if (this.solarFlux > 60_000 && !this.sunWarned) {
      this.sunWarned = true;
      this.emit({ type: 'msg', msg: '警告：离太阳太近，船体正在被烤热！', level: 'bad' });
    }
    if (this.solarFlux < 30_000) this.sunWarned = false;
    if (V.temperature < tMax * 0.7) this.overheatWarned = false;
    if (V.temperature > tMax) {
      const bySun = this.solarFlux > this.heatFlux;
      this.destroy(
        bySun
          ? `离太阳太近，船体被烤化（${V.temperature.toFixed(0)} K）`
          : `${leading?.p.def.name ?? '船体'} 过热烧毁（${V.temperature.toFixed(0)} K）${a.shieldBottom ? '——再入时应让隔热罩朝前（逆行方向）' : ''}`,
      );
      return;
    }

    // G 力
    const gforce = this.lastNonGravAcc / G0;
    if (this.launched && this.contactCount === 0) this.maxG = Math.max(this.maxG, gforce);

    this.t += h;
    if (this.launched || radar > 0.5) this.trail.record(body, V.r, this.t, thrust > 0);

    // ------------------------------------------------ 着陆检测
    const vRelCom = V.v.clone().sub(surfaceVelocity(body, this.t, V.r, _v3)).length();
    if (!this.launched && radar > 3) {
      this.launched = true;
      this.emit({ type: 'liftoff', msg: '起飞！', level: 'good' });
    }
    if (this.contactCount > 0 && vRelCom < 0.35 && V.w.length() < 0.06 && thrust < 1) {
      this.settle += h;
      if (this.settle > 0.8) {
        this.landed = true;
        this.lockLanded(body);
        if (this.launched) this.onTouchdown(body, up);
      }
    } else {
      this.settle = 0;
    }
  }

  private onTouchdown(body: Body, up: Vector3): void {
    const V = this.vessel;
    const fwd = UP.clone().applyQuaternion(V.q);
    const upright = fwd.dot(up) > Math.cos((35 * Math.PI) / 180);
    const water = this.touchingWater;
    if (body.id === 'moon') {
      if (upright && V.hasPod()) {
        if (!this.landedOnMoonOnce) {
          this.landedOnMoonOnce = true;
          this.emit({ type: 'landed', msg: '月面着陆成功！“这是个人的一小步……”', level: 'good' });
        } else this.emit({ type: 'landed', msg: '已着陆', level: 'good' });
      } else if (!upright) {
        this.emit({ type: 'landed', msg: '着陆器倾覆了……很难再起飞', level: 'bad' });
      }
    } else if (body.id === 'earth') {
      this.emit({ type: 'landed', msg: water ? '溅落成功！' : '着陆成功！', level: 'good' });
    } else {
      this.emit({ type: 'landed', msg: upright ? `${body.name}着陆成功！` : `着陆器在${body.name}表面倾覆了……`, level: upright ? 'good' : 'bad' });
    }
    this.missions.onTouchdown(body, upright);
  }

  destroy(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyReason = reason;
    this.vessel.throttle = 0;
    this.autopilot.mode = 'off';
    this.warpIndex = 0;
    this.emit({ type: 'explosion', pos: this.vessel.r.clone(), size: Math.max(4, Math.cbrt(this.vessel.mass) * 0.8) });
    this.emit({ type: 'destroyed', msg: reason, level: 'bad' });
  }

  // ---------------------------------------------------------------- 残骸

  private updateDebris(dt: number): void {
    if (!this.debris.length) return;
    const V = this.vessel;
    const rails = this.warpIndex > PHYS_WARP_MAX;
    for (const d of this.debris) {
      if (!d.alive) continue;
      d.age += dt;
      if (d.rest) {
        // 静止在地面上：随天体自转
        fromBodyFixed(d.rest, this.t, d.restPos, d.r);
        surfaceVelocity(d.rest, this.t, d.r, d.v);
        d.q.copy(_q1.setFromAxisAngle(UP, bodyRotation(d.rest, this.t))).multiply(d.restQ);
        if (d.r.distanceTo(V.r) > 60_000) d.alive = false;
        continue;
      }
      if (rails || d.r.distanceTo(V.r) > 60_000 || d.age > 900) {
        d.alive = false;
        continue;
      }
      const n = Math.max(1, Math.ceil(dt / 0.02));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        const body = dominantBody(d.r, this.t);
        const bp = bodyPosition(body, this.t, _v1);
        const dist = d.r.distanceTo(bp);
        const alt = dist - body.radius;
        const rho = atmoDensity(body, alt);
        const g = gravityAccel(d.r, this.t, _v2);
        d.v.addScaledVector(g, h);
        if (d.motorT > 0) {
          d.v.addScaledVector(_v4.copy(d.motorDir).applyQuaternion(d.q), d.motorAcc * Math.min(h, d.motorT));
          d.motorT -= h;
        }
        if (rho > 0) {
          const vs = surfaceVelocity(body, this.t, d.r, _v3);
          const va = d.v.clone().sub(vs);
          const sp = va.length();
          if (sp > 0.01) d.v.addScaledVector(va, (-0.5 * rho * sp * 0.9 * d.area * h) / d.mass);
          d.w.multiplyScalar(1 - Math.min(0.5, rho * h * 0.5));
        }
        d.r.addScaledVector(d.v, h);
        const wl = d.w.length();
        if (wl > 1e-6) {
          _q1.setFromAxisAngle(d.w.clone().divideScalar(wl), wl * h);
          d.q.multiply(_q1).normalize();
        }
        if (alt < 40 + (body.id === 'earth' ? 0 : body.maxTerrain)) {
          const dir = toBodyFixed(body, this.t, d.r).normalize();
          const th = terrainHeight(body, dir);
          if (alt < th + 1) {
            d.alive = false;
            const sp = d.v.clone().sub(surfaceVelocity(body, this.t, d.r, _v3)).length();
            if (sp > 8) this.emit({ type: 'explosion', pos: d.r.clone(), size: Math.max(2, Math.cbrt(d.mass) * 0.6), debrisId: d.id });
            break;
          }
        }
      }
    }
    const dead = this.debris.filter((d) => !d.alive);
    for (const d of dead) this.emit({ type: 'debrisGone', debrisId: d.id });
    this.debris = this.debris.filter((d) => d.alive);
  }

  // ---------------------------------------------------------------- SAS / 控制

  sasTargetDir(): Vector3 | null {
    if (this.autopilot.mode !== 'off' && this.autopilot.targetDir) return this.autopilot.targetDir;
    const tel = this.telemetry;
    if (!tel) return null;
    const useSurf = tel.speedModeUsed === 'surface';
    const vel = useSurf ? tel.vSurfVec : tel.vOrbVec;
    const V = this.vessel;
    const bp = bodyPosition(tel.body, this.t, new Vector3());
    const rel = V.r.clone().sub(bp);
    const vOrb = tel.vOrbVec;
    switch (this.sasMode) {
      case 'prograde':
        return vel.length() > 0.5 ? vel.clone().normalize() : tel.up.clone();
      case 'retrograde':
        return vel.length() > 0.5 ? vel.clone().normalize().negate() : tel.up.clone();
      case 'normal':
        return new Vector3().crossVectors(rel, vOrb).normalize();
      case 'antinormal':
        return new Vector3().crossVectors(rel, vOrb).normalize().negate();
      case 'radialOut': {
        const n = new Vector3().crossVectors(rel, vOrb);
        return n.cross(vOrb).normalize();
      }
      case 'radialIn': {
        const n = new Vector3().crossVectors(rel, vOrb);
        return n.cross(vOrb).normalize().negate();
      }
      case 'maneuver': {
        const d = this.nodeBurnVector();
        return d && d.lengthSq() > 1e-6 ? d.clone().normalize() : null;
      }
      case 'rudder': {
        // 设定角与实际倾角相差很大（例如直接拖到背面）时，目标只领先实际姿态 RUDDER_LEAD，
        // 让火箭沿较短的方向在“竖直—正东”平面内转过去，而不是绕一个不确定的轴翻转
        let a = this.rudderAngle;
        const fwd = UP.clone().applyQuaternion(V.q);
        if (Math.abs(fwd.dot(tel.north)) < 0.7) {
          const cur = Math.atan2(fwd.dot(tel.east), fwd.dot(tel.up));
          const d = wrapAngle(a - cur);
          if (Math.abs(d) > RUDDER_LEAD) a = cur + Math.sign(d) * RUDDER_LEAD;
        }
        return tel.up.clone().multiplyScalar(Math.cos(a)).addScaledVector(tel.east, Math.sin(a)).normalize();
      }
      default:
        return null;
    }
  }

  private computeControl(tauPitch: number, tauRoll: number): Vector3 {
    const V = this.vessel;
    const cmd = new Vector3();
    const inp = this.input;
    const manual = inp.pitch !== 0 || inp.yaw !== 0 || inp.roll !== 0;
    const apActive = this.autopilot.mode !== 'off' && this.autopilot.targetDir !== null;
    if ((this.sasOn || apActive) && !this.destroyed) {
      const I = V.inertia;
      const w = V.w;
      const wDes = new Vector3();
      const aP = tauPitch / Math.max(I.x, I.z);
      const aR = tauRoll / I.y;
      const target = apActive ? this.autopilot.targetDir : this.sasMode === 'stability' ? null : this.sasTargetDir();
      if (target) {
        this.sasHold = null;
        const tb = target.clone().applyQuaternion(V.q.clone().invert());
        const axis = new Vector3().crossVectors(UP, tb);
        const s = axis.length();
        const c = UP.dot(tb);
        const ang = Math.atan2(s, c);
        if (s > 1e-6) axis.divideScalar(s);
        else axis.set(1, 0, 0);
        const wMag = Math.min(1.2, Math.sqrt(2 * aP * 0.6 * ang), ang * 4);
        wDes.copy(axis).multiplyScalar(wMag);
        wDes.y = 0;
      } else {
        if (!this.sasHold || manual) this.sasHold = V.q.clone();
        const qe = V.q.clone().invert().multiply(this.sasHold);
        if (qe.w < 0) qe.set(-qe.x, -qe.y, -qe.z, -qe.w);
        const sw = Math.sqrt(Math.max(0, 1 - qe.w * qe.w));
        const ang = 2 * Math.acos(Math.min(1, qe.w));
        if (sw > 1e-6) {
          const axis = new Vector3(qe.x / sw, qe.y / sw, qe.z / sw);
          const wp = Math.min(1.0, Math.sqrt(2 * aP * 0.6 * ang), ang * 4);
          const wr = Math.min(1.0, Math.sqrt(2 * aR * 0.6 * ang), ang * 4);
          wDes.set(axis.x * wp, axis.y * wr, axis.z * wp);
        }
      }
      const resp = 0.2;
      cmd.set(
        (I.x * (wDes.x - w.x)) / resp / Math.max(1, tauPitch),
        (I.y * (wDes.y - w.y)) / resp / Math.max(1, tauRoll),
        (I.z * (wDes.z - w.z)) / resp / Math.max(1, tauPitch),
      );
      cmd.x = Math.max(-1, Math.min(1, cmd.x));
      cmd.y = Math.max(-1, Math.min(1, cmd.y));
      cmd.z = Math.max(-1, Math.min(1, cmd.z));
    }
    if (inp.pitch !== 0) cmd.x = inp.pitch;
    if (inp.roll !== 0) cmd.y = inp.roll;
    if (inp.yaw !== 0) cmd.z = -inp.yaw;
    return cmd;
  }

  // ---------------------------------------------------------------- 机动节点

  addNode(n: NodeSpec, replan?: { at: number; target: BodyId } | null): void {
    this.nodes = [{ t: n.t, dv: n.dv.clone(), fixedDv: null, remaining: null, replanAt: replan?.at ?? null, replanTarget: replan?.target }];
    this.nodesVer++;
    this.predictionAge = 999;
    this.refreshPrediction();
  }

  /** 节点的 Δv 或时刻被手动修改：解除锁定，重新预测。 */
  nodeEdited(): void {
    const n = this.nodes[0];
    if (n) {
      n.fixedDv = null;
      n.remaining = null;
      n.target = null;
      n.burnDir = null;
      n.frozen = false;
      n.done = false;
    }
    this.nodesVer++;
    this.refreshPrediction();
  }

  /** 行星际转移的近似节点：飞到窗口前一天左右时用多体积分重新精确计算。 */
  private checkReplan(): void {
    const n = this.nodes[0];
    if (!n || n.replanAt == null || !n.replanTarget || this.t < n.replanAt || n.remaining) return;
    if (!this.replanNotified) {
      this.replanNotified = true;
      this.emit({ type: 'msg', msg: '临近转移窗口：正在用多体引力精确计算转移轨道……', level: 'info' });
      return;
    }
    this.replanNotified = false;
    n.replanAt = null;
    const res = solveTransfer({ r: this.vessel.r, v: this.vessel.v, t: this.t }, BODY_BY_ID[n.replanTarget]);
    if (res.node) {
      this.addNode(res.node, res.replanAt != null && res.target ? { at: res.replanAt, target: res.target.id } : null);
      // 正在“加速到节点前”时，改为加速到新的节点之前
      if (this.autoWarpTo !== null) this.autoWarpTo = Math.min(this.autoWarpTo, res.node.t - this.nodeBurnLead() - 60);
      this.emit({ type: 'msg', msg: `已重新精确计算：${res.msg}`, level: 'good' });
    } else this.emit({ type: 'msg', msg: res.msg, level: 'warn' });
  }

  /** 删除机动节点；stopAutopilot 为 false 时由飞行辅助自己收尾（显示“机动执行完毕”）。 */
  removeNode(stopAutopilot = true): void {
    this.nodes = [];
    this.nodesVer++;
    if (stopAutopilot && this.autopilot.mode === 'node') this.autopilot.disengage();
    this.predictionAge = 999;
  }

  /** 机动节点的惯性系 Δv（锁定后为闭环制导给出的剩余量）。 */
  nodeBurnVector(): Vector3 | null {
    const n = this.nodes[0];
    if (!n) return null;
    if (n.remaining) return n.remaining;
    const ns = this.prediction?.nodeState;
    if (ns && Math.abs(ns.t - n.t) < 1e-6) return nodeDvWorld(ns.r, ns.v, ns.t, n.dv, ns.body);
    return nodeDvWorld(this.vessel.r, this.vessel.v, this.t, n.dv, this.body);
  }

  nodeBurnTime(): number {
    return this.nodeBurnEstimate(burnTime);
  }

  /** 应该在节点前多久点火：使 Δv 的加权中心落在节点上（见 burnLead）。 */
  nodeBurnLead(): number {
    return this.nodeBurnEstimate(burnLead);
  }

  private nodeBurnEstimate(f: (dv: number, mass: number, thrust: number, mdot: number) => number): number {
    const n = this.nodes[0];
    if (!n) return 0;
    const dv = this.nodeBurnVector()?.length() ?? 0;
    const V = this.vessel;
    let { thrust, mdot } = V.maxThrustVac();
    if (thrust <= 0) {
      thrust = V.nextStageThrust();
      mdot = thrust / (320 * G0);
    }
    return f(dv, V.mass, thrust, mdot);
  }

  private updateNodes(): void {
    const n = this.nodes[0];
    if (!n) return;
    const bt = this.nodeBurnTime();
    if (!n.remaining && this.t > n.t - this.nodeBurnLead() - NODE_LOCK_LEAD) this.lockNode(n, bt);
    const byAutopilot = this.autopilot.executingNode;
    if (n.remaining && n.burnDir && !byAutopilot) {
      // 手动点火：烧过头或剩余量很小时结束（飞行辅助执行时由它在物理子步内精确关机）
      if (n.remaining.dot(n.burnDir) < 0 || n.remaining.length() < 0.2) {
        this.emit({ type: 'msg', msg: '机动完成', level: 'good' });
        this.removeNode();
        return;
      }
    }
    if (n.remaining) this.guideNode(n);
    if (this.t > n.t + Math.max(600, bt * 3) && !byAutopilot) this.removeNode();
  }

  /**
   * 锁定节点：从当前状态数值外推到节点时刻（不依赖可能已经过时的轨迹预测），
   * 求出惯性系 Δv，并生成闭环制导的目标（见 guidance.ts）。
   */
  private lockNode(n: ManeuverNode, bt: number): void {
    const r = this.vessel.r.clone();
    const v = this.vessel.v.clone();
    let t = this.t;
    // 节点已经过去时向后积分（只有引力，时间可逆）
    for (let guard = 0; Math.abs(n.t - t) > 1e-9 && guard < 20_000; guard++) {
      const h = Math.sign(n.t - t) * Math.min(Math.abs(n.t - t), adaptiveStep(r, t, 0.004));
      rk4Step(r, v, t, h);
      t += h;
    }
    const body = dominantBody(r, n.t);
    const dv = nodeDvWorld(r, v, n.t, n.dv, body);
    const l = dv.length();
    n.fixedDv = dv.clone();
    n.remaining = dv.clone();
    n.burnDir = l > 1e-9 ? dv.clone().divideScalar(l) : this.telemetry.vOrbVec.clone().normalize();
    n.frozen = false;
    n.done = false;
    // 目标点离节点多远：点火开始时飞船还在节点之前，要保证那时到目标点的转移角仍小于 180°
    const rel = r.clone().sub(bodyPosition(body, n.t, _v1));
    const vrel = v.clone().sub(bodyVelocity(body, n.t, _v2));
    const rate = Math.max(rel.clone().cross(vrel).length(), rel.clone().cross(vrel.add(dv)).length()) / rel.lengthSq();
    const sweep = Math.min((2 * Math.PI) / 3, (165 * Math.PI) / 180 - rate * (this.nodeBurnLead() + 5));
    n.target = l > 0.05 && sweep > (40 * Math.PI) / 180 ? makeBurnTarget(r, v, n.t, dv, body, sweep) : null;
    this.guideNode(n);
  }

  /** 闭环制导：按当前状态重新计算待增速度；临近关机时冻结方向，只按推力积分。 */
  private guideNode(n: ManeuverNode): void {
    if (!n.target || n.frozen || n.done || !n.remaining) return;
    const vg = velocityToGain(n.target, this.vessel.r, this.vessel.v, this.t, _v3);
    if (!vg) return;
    const fixed = n.fixedDv ? n.fixedDv.length() : 0;
    const l = vg.length();
    // 错过节点太久、兰伯特解已经不合理时，保留原来的积分值
    if (l > Math.max(2 * fixed, fixed + 100)) return;
    n.remaining.copy(vg);
    if (l > 1e-9) (n.burnDir ??= new Vector3()).copy(vg).divideScalar(l);
    const aMax = this.vessel.maxThrustVac().thrust / this.vessel.mass;
    if (this.maneuvering() && l < Math.max(0.3, aMax)) n.frozen = true;
  }

  // ---------------------------------------------------------------- 遥测

  updateTelemetry(): void {
    const V = this.vessel;
    const body = dominantBody(V.r, this.t);
    const bp = bodyPosition(body, this.t, new Vector3());
    const bv = bodyVelocity(body, this.t, new Vector3());
    const rel = V.r.clone().sub(bp);
    const vrel = V.v.clone().sub(bv);
    const dist = rel.length();
    const up = rel.clone().divideScalar(dist);
    const alt = dist - body.radius;
    const dirBf = toBodyFixed(body, this.t, V.r).normalize();
    const terrainH = terrainHeight(body, dirBf);
    const b = V.bounds();
    const radarAlt = alt - terrainH - (V.com.y - b.minY);
    let north = new Vector3(0, 1, 0).addScaledVector(up, -up.y);
    if (north.lengthSq() < 1e-8) north.set(1, 0, 0);
    north.normalize();
    const east = new Vector3().crossVectors(north, up).normalize();
    const vs = surfaceVelocity(body, this.t, V.r, new Vector3());
    const vSurfVec = V.v.clone().sub(vs);
    const vVert = vSurfVec.dot(up);
    const vHoriz = Math.sqrt(Math.max(0, vSurfVec.lengthSq() - vVert * vVert));
    const orbit = computeOrbit(rel, vrel, body);
    const pressure = atmoPressure(body, alt);
    const density = atmoDensity(body, alt);
    const surfSpeed = vSurfVec.length();
    const dynPressure = 0.5 * density * surfSpeed * surfSpeed;
    const mach = density > 0 ? surfSpeed / speedOfSound(alt) : 0;
    const gLocal = body.mu / (dist * dist);
    const thrust = V.parts.reduce((s, rp) => s + rp.thrustNow, 0);
    const lat = Math.asin(Math.max(-1, Math.min(1, dirBf.y)));
    const lon = Math.atan2(-dirBf.z, dirBf.x);
    const atmoTop = body.atmosphere?.height ?? 0;
    let speedModeUsed: 'surface' | 'orbit';
    if (this.speedMode === 'auto') {
      const thr = body.id === 'earth' ? 36_000 : body.atmosphere ? body.atmosphere.height * 0.5 : 8_000;
      speedModeUsed = alt < thr ? 'surface' : 'orbit';
    } else speedModeUsed = this.speedMode;
    // 着陆建议点火
    const { thrust: fMax } = V.maxThrustVac();
    const aMax = fMax / V.mass;
    let suicideIn = NaN;
    let timeToImpact = NaN;
    if (vVert < -0.5 && radarAlt > 0) {
      const disc = vVert * vVert + 2 * gLocal * radarAlt;
      timeToImpact = (vVert + Math.sqrt(disc)) / gLocal;
      if (aMax > gLocal * 1.05) {
        const vTot = surfSpeed;
        const stop = (vTot * vTot) / (2 * (aMax - gLocal));
        suicideIn = (radarAlt - stop) / Math.max(0.1, -vVert);
      }
    }
    const tempMax = this.tempLimit;
    this.telemetry = {
      body,
      alt,
      radarAlt,
      terrainH,
      vVert,
      vHoriz,
      surfSpeed,
      orbSpeed: vrel.length(),
      speedModeUsed,
      orbit,
      pressure,
      density,
      dynPressure,
      mach,
      gforce: this.landed ? gLocal / G0 : this.lastNonGravAcc / G0,
      heatFlux: this.heatFlux,
      temp: V.temperature,
      tempMax,
      thrust,
      twr: thrust / (V.mass * gLocal),
      gLocal,
      mass: V.mass,
      stageDv: V.stageDeltaV(),
      lat,
      lon,
      up,
      north,
      east,
      vSurfVec,
      vOrbVec: vrel,
      suicideIn,
      timeToImpact,
      inAtmosphere: alt < atmoTop,
    };
  }
}
