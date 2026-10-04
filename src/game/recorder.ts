import { Matrix4, Quaternion, Vector3 } from 'three';
import { BODIES, bodyPosition, bodyRotation, bodyVelocity, toBodyFixed, type BodyId } from '../physics/bodies';
import { cloneDesign } from '../rocket/design';
import type { FlightEvent, FlightSim } from './flight';
import { DEMO_VERSION, FRAME_DEAD, FRAME_LANDED, FRAME_THRUST, FRAME_WATER, demoBytes, type DemoData, type DemoEvent, type DemoOutcome } from './demo';

const UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
/** 关键帧上限（约 30 MB）：超过后停止记录，避免挂机数天把内存占满 */
const MAX_FRAMES = 400_000;

/** 可增长的定型数组。 */
class Grow<T extends Float64Array | Float32Array | Uint8Array | Int8Array> {
  a: T;
  n = 0;
  constructor(private make: (n: number) => T) {
    this.a = make(1024);
  }
  push(...xs: number[]): void {
    if (this.n + xs.length > this.a.length) {
      const b = this.make(Math.max(this.a.length * 2, this.n + xs.length));
      b.set(this.a);
      this.a = b;
    }
    for (const x of xs) this.a[this.n++] = x;
  }
  slice(): T {
    return this.a.slice(0, this.n) as T;
  }
}

interface Snap {
  t: number;
  real: number;
  mode: 'L' | 'D' | 'C';
  body: number;
  warp: number;
  flags: number;
  pos: Vector3;
  vel: Vector3;
  q: Quaternion;
  /** 姿态相对轨道坐标系（径向、顺行、法向）的四元数，用于判断“随轨道保持”的姿态 */
  rel: Quaternion;
  thr: number;
  heat: number;
  temp: number;
  cmd: Vector3;
}

/** 轨道坐标系（x 径向外，y 顺行，z 法向）到惯性系的旋转。 */
export function orbitalFrame(rel: Vector3, vrel: Vector3, out: Quaternion): Quaternion {
  const x = rel.clone().normalize();
  const z = new Vector3().crossVectors(rel, vrel);
  if (z.lengthSq() < 1e-12) z.set(0, 1, 0).cross(x);
  if (z.lengthSq() < 1e-12) z.set(1, 0, 0);
  z.normalize();
  const y = new Vector3().crossVectors(z, x).normalize();
  return out.setFromRotationMatrix(_m4.makeBasis(x, y, z));
}

const _m4 = new Matrix4();

/**
 * 飞行记录仪：每次 FlightSim.update 之后取样，自适应地保存关键帧。
 * - 发动机工作、在大气层内或贴近地面：每 0.5~2 s 一帧（回放时三次埃尔米特插值）；
 * - 真空滑行：大约每 1/3 圈一帧（回放时用两端的开普勒轨道外推再混合），
 *   姿态既不随惯性系也不随轨道保持时（例如正在转向）立即补帧；
 * - 着陆：天体固连坐标，状态改变时才记录。
 * 分级、着陆腿、降落伞、SAS、飞行辅助、机动节点等离散状态与当时弹出的提示另存为事件。
 */
export class FlightRecorder {
  readonly sim: FlightSim;
  readonly startedAt = Date.now();
  private F = {
    t: new Grow((n) => new Float64Array(n)),
    real: new Grow((n) => new Float64Array(n)),
    pos: new Grow((n) => new Float64Array(n)),
    vel: new Grow((n) => new Float32Array(n)),
    q: new Grow((n) => new Float32Array(n)),
    thr: new Grow((n) => new Float32Array(n)),
    heat: new Grow((n) => new Float32Array(n)),
    temp: new Grow((n) => new Float32Array(n)),
    info: new Grow((n) => new Uint8Array(n)),
    cmd: new Grow((n) => new Int8Array(n)),
  };
  private fuelT = new Grow((n) => new Float64Array(n));
  private fuelF = new Grow((n) => new Float32Array(n));
  readonly fuelKeys: string[];
  private lastFuel: number[] = [];
  private lastFuelT = -Infinity;
  events: DemoEvent[] = [];
  private last: Snap | null = null;
  private pending: Snap | null = null;
  private force = false;
  private stage0: number;
  /** 累计的真实时间（暂停时不计） */
  private realT = 0;
  private designCopy;
  // 上一次取样时的离散状态
  private st = {
    legs: false,
    chute: '',
    sasOn: true,
    sasMode: '',
    rudder: 0,
    hdg: 0,
    ap: 'off',
    apStatus: '',
    apStatusT: -Infinity,
    node: '',
    burning: false,
    target: null as BodyId | null,
    met: false,
    dead: false,
    speed: '',
    inf: false,
  };
  private bodiesSeen: BodyId[] = [];
  maxAlt = 0;
  victory = false;
  truncated = false;
  /** 已保存过的 demo（再次保存时覆盖同一条记录） */
  savedId: string | null = null;
  savedAtT = -Infinity;
  /** 是否已经问过玩家要不要保存 */
  asked = false;

  constructor(sim: FlightSim) {
    this.sim = sim;
    const V = sim.vessel;
    this.designCopy = cloneDesign(V.design);
    this.stage0 = V.stageIndex;
    this.fuelKeys = V.parts.filter((rp) => rp.fuelMax > 0).map((rp) => rp.key);
    this.st.legs = V.legsDeployed;
    this.st.chute = V.chuteState;
    this.st.sasOn = sim.sasOn;
    this.st.sasMode = sim.sasMode;
    this.st.speed = sim.speedMode;
    this.sample();
  }

  get frameCount(): number {
    return this.F.t.n;
  }

  get lastT(): number {
    return this.F.t.n ? this.F.t.a[this.F.t.n - 1] : 0;
  }

  get firstT(): number {
    return this.F.t.n ? this.F.t.a[0] : 0;
  }

  /** 是否值得保存：已经点火起飞（或非发射台场景飞了一会儿）。 */
  hasContent(): boolean {
    const sim = this.sim;
    return (sim.metStarted && sim.met > 3) || (sim.scenario !== 'pad' && this.lastT - this.firstT > 30);
  }

  /** 保存之后又飞了一段（值得再次询问）。 */
  get changedSinceSave(): boolean {
    return this.lastT - this.savedAtT > 1;
  }

  private push(e: DemoEvent): void {
    this.events.push(e);
  }

  /** 电脑演示的解说字幕。 */
  caption(msg: string): void {
    this.push({ t: this.sim.t, k: 'cap', msg });
  }

  /** FlightSim.emit 的钩子。 */
  onEvent(e: FlightEvent): void {
    // 残骸相关的事件由回放时重新模拟的残骸自己产生
    if (e.type === 'decouple' || e.type === 'debrisGone' || (e.type === 'explosion' && e.debrisId !== undefined)) return;
    const t = this.sim.t;
    const ev: DemoEvent = { t, k: 'ev', type: e.type };
    if (e.msg) ev.msg = e.msg;
    if (e.level) ev.level = e.level;
    if (e.size !== undefined) ev.size = e.size;
    if (e.id !== undefined) ev.id = e.id;
    if (e.pos) ev.pos = [e.pos.x, e.pos.y, e.pos.z];
    this.push(ev);
    if (e.type === 'stage') {
      this.push({ t, k: 'stage', i: this.sim.vessel.stageIndex });
      this.force = true;
    } else if (e.type === 'legs') {
      this.st.legs = this.sim.vessel.legsDeployed;
      this.push({ t, k: 'legs', on: this.st.legs });
    } else if (e.type === 'flameout' && e.id) {
      this.push({ t, k: 'flame', key: e.id });
      this.force = true;
    } else if (e.type === 'victory') this.victory = true;
    else if (e.type === 'destroyed') this.force = true;
  }

  // ---------------------------------------------------------------- 取样

  private snap(): Snap {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    const body = tel.body;
    const t = sim.t;
    const landed = sim.landed;
    const thrusting = tel.thrust > 0 || sim.ullageT > 0 || V.parts.some((rp) => (rp.igniteDelay ?? 0) > 0);
    const near = body.kind === 'rocky' && tel.radarAlt < 300;
    const mode: Snap['mode'] = landed ? 'L' : thrusting || tel.inAtmosphere || near || sim.contactCount > 0 || sim.destroyed ? 'D' : 'C';
    const origin = V.r.clone().sub(V.com.clone().applyQuaternion(V.q));
    const q = V.q.clone();
    const rel = new Quaternion();
    const bp = bodyPosition(body, t, new Vector3());
    const bv = bodyVelocity(body, t, new Vector3());
    orbitalFrame(V.r.clone().sub(bp), V.v.clone().sub(bv), rel).invert().multiply(q);
    let pos = origin;
    let qs = q;
    if (landed) {
      pos = toBodyFixed(body, t, origin);
      qs = new Quaternion().setFromAxisAngle(UP, -bodyRotation(body, t)).multiply(q);
    }
    let flags = 0;
    if (landed) flags |= FRAME_LANDED;
    if (sim.touchingWater) flags |= FRAME_WATER;
    if (sim.destroyed) flags |= FRAME_DEAD;
    if (thrusting) flags |= FRAME_THRUST;
    return {
      t,
      real: this.realT,
      mode,
      body: BODIES.indexOf(body),
      warp: sim.warpIndex,
      flags,
      pos,
      vel: V.v.clone(),
      q: qs,
      rel,
      thr: V.throttle,
      heat: sim.heatFlux,
      temp: V.temperature,
      cmd: sim.controlCmd.clone(),
    };
  }

  private commit(s: Snap): void {
    if (this.F.t.n >= MAX_FRAMES) {
      this.truncated = true;
      return;
    }
    if (this.last && s.t <= this.last.t) return;
    const F = this.F;
    F.t.push(s.t);
    F.real.push(s.real);
    F.pos.push(s.pos.x, s.pos.y, s.pos.z);
    F.vel.push(s.vel.x, s.vel.y, s.vel.z);
    F.q.push(s.q.x, s.q.y, s.q.z, s.q.w);
    F.thr.push(s.thr);
    F.heat.push(s.heat);
    F.temp.push(s.temp);
    F.info.push(s.flags, (s.body << 4) | Math.min(15, s.warp));
    const c = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 127);
    F.cmd.push(c(s.cmd.x), c(s.cmd.y), c(s.cmd.z));
    const modeChanged = !this.last || this.last.mode !== s.mode;
    this.last = s;
    if (this.pending === s) this.pending = null;
    this.sampleFuel(s.t, modeChanged || this.force);
  }

  private sampleFuel(t: number, force: boolean): void {
    const V = this.sim.vessel;
    const cur = this.fuelKeys.map((k) => {
      const rp = V.byKey.get(k);
      return rp ? rp.fuel : NaN;
    });
    const changed = cur.some((x, i) => !Object.is(x, this.lastFuel[i]) && !(Math.abs(x - this.lastFuel[i]) < 0.05));
    if (!changed) return;
    if (!force && t - this.lastFuelT < 2) return;
    this.fuelT.push(t);
    this.fuelF.push(...cur);
    this.lastFuel = cur;
    this.lastFuelT = t;
  }

  /** 每次 FlightSim.update 之后调用；dtReal 为这一帧的真实时间。 */
  sample(dtReal = 0): void {
    const sim = this.sim;
    this.realT += dtReal;
    if (this.st.dead && this.last?.flags && this.last.flags & FRAME_DEAD) return;
    this.trackState();
    const s = this.snap();
    const tel = sim.telemetry;
    if (tel.body.id === 'earth') this.maxAlt = Math.max(this.maxAlt, tel.alt);
    const bid = tel.body.id;
    if (this.bodiesSeen[this.bodiesSeen.length - 1] !== bid) this.bodiesSeen.push(bid);
    const last = this.last;
    const commitPending = () => {
      const p = this.pending;
      if (p && last && p.t > last.t) this.commit(p);
    };
    if (!last) {
      this.commit(s);
    } else if (this.force || s.mode !== last.mode || s.body !== last.body || (s.flags & ~FRAME_THRUST) !== (last.flags & ~FRAME_THRUST)) {
      commitPending();
      this.commit(s);
    } else {
      const dt = s.t - last.t;
      let interval: number;
      if (s.mode === 'D') {
        const near = tel.body.kind === 'rocky' && tel.radarAlt < 300;
        interval = s.flags & FRAME_THRUST || near ? 0.5 : tel.dynPressure > 1000 ? 1 : 2;
      } else if (s.mode === 'L') interval = 86_400;
      else {
        const o = tel.orbit;
        const T = !o.hyperbolic && isFinite(o.period) && o.ap < tel.body.soi ? o.period / 3 : (0.3 * (o.a ? Math.abs(o.a) : 1e6)) / Math.max(1, tel.orbSpeed);
        interval = Math.max(10, Math.min(86_400, T));
      }
      if (dt >= interval) this.commit(s);
      else if (s.mode === 'C' && attitudeDrift(s, last) > 3 * DEG) {
        commitPending();
        this.commit(s);
      } else if (s.warp !== last.warp) {
        // 时间加速改变：回放按记录时的倍率控制节奏
        commitPending();
        this.commit(s);
      } else this.pending = s;
    }
    this.force = false;
  }

  /** 记录离散状态的变化（每次取样时比较）。 */
  private trackState(): void {
    const sim = this.sim;
    const V = sim.vessel;
    const t = sim.t;
    const S = this.st;
    if (V.legsDeployed !== S.legs) {
      S.legs = V.legsDeployed;
      this.push({ t, k: 'legs', on: S.legs });
    }
    if (V.chuteState !== S.chute) {
      S.chute = V.chuteState;
      this.push({ t, k: 'chute', s: S.chute });
    }
    const rud = sim.sasMode === 'rudder' ? sim.rudderAngle : 0;
    // 方向舵的航向（自动入轨也沿它转弯）：变化时一并记录
    const hdg = sim.rudderHeading;
    if (sim.sasOn !== S.sasOn || sim.sasMode !== S.sasMode || Math.abs(rud - S.rudder) > 0.5 * DEG || Math.abs(hdg - S.hdg) > 0.5 * DEG) {
      S.sasOn = sim.sasOn;
      S.sasMode = sim.sasMode;
      S.rudder = rud;
      S.hdg = hdg;
      this.push({ t, k: 'sas', on: S.sasOn, mode: S.sasMode, rud, hdg });
    }
    const ap = sim.autopilot;
    const prefix = (s: string) => s.split(/[：:]/)[0];
    if (ap.mode !== S.ap || (ap.mode !== 'off' && ap.status !== S.apStatus && (t - S.apStatusT >= 2 || prefix(ap.status) !== prefix(S.apStatus)))) {
      S.ap = ap.mode;
      S.apStatus = ap.status;
      S.apStatusT = t;
      this.push({ t, k: 'ap', mode: ap.mode, s: ap.mode === 'off' ? '' : ap.status });
    }
    const n = sim.nodes[0];
    const nk = n ? `${n.t.toFixed(3)}|${n.dv.x.toFixed(3)}|${n.dv.y.toFixed(3)}|${n.dv.z.toFixed(3)}` : '';
    if (nk !== S.node) {
      S.node = nk;
      S.burning = false;
      this.push(n ? { t, k: 'node', nt: n.t, dv: [n.dv.x, n.dv.y, n.dv.z] } : { t, k: 'node', nt: null });
    }
    if (n && n.remaining && !S.burning) {
      S.burning = true;
      this.push({ t, k: 'burn' });
    }
    if (sim.targetBody !== S.target) {
      S.target = sim.targetBody;
      this.push({ t, k: 'target', b: S.target });
    }
    if (sim.metStarted && !S.met) {
      S.met = true;
      this.push({ t, k: 'met', t0: t - sim.met });
    }
    if (V.infiniteFuel !== S.inf) {
      S.inf = V.infiniteFuel;
      this.push({ t, k: 'inf', on: S.inf });
    }
    if (sim.speedMode !== S.speed) {
      S.speed = sim.speedMode;
      this.push({ t, k: 'spd', m: S.speed });
    }
    if (sim.destroyed && !S.dead) {
      S.dead = true;
      this.push({ t, k: 'dead', reason: sim.destroyReason });
      this.force = true;
    }
  }

  // ---------------------------------------------------------------- 打包

  /** 打包成 DemoData（不影响继续记录）。 */
  finish(name: string, extra: { id?: string; builtin?: string } = {}): DemoData {
    // 把最后一个未提交的状态也带上
    if (this.pending && this.last && this.pending.t > this.last.t) this.commit(this.pending);
    const sim = this.sim;
    const F = this.F;
    const tel = sim.telemetry;
    const o = tel.orbit;
    let outcome: DemoOutcome;
    let text: string;
    if (sim.destroyed) {
      outcome = 'crashed';
      text = sim.destroyReason;
    } else if (this.victory) {
      outcome = 'victory';
      text = '任务完成，安全返回地球';
    } else if (sim.landed) {
      outcome = 'landed';
      text = `${tel.body.name}表面`;
    } else if (!o.hyperbolic && o.peAlt > (tel.body.atmosphere?.height ?? 5_000) && o.ap < tel.body.soi) {
      outcome = 'orbit';
      text = `${tel.body.name}轨道`;
    } else {
      outcome = 'flying';
      text = tel.body.id === 'sun' ? '行星际巡航' : `${tel.body.name}附近`;
    }
    const data: DemoData = {
      v: DEMO_VERSION,
      meta: {
        id: extra.id ?? `demo-${this.startedAt.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        name,
        createdAt: Date.now(),
        builtin: extra.builtin,
        designName: this.designCopy.name,
        scenario: sim.scenario,
        duration: this.lastT - this.firstT,
        metEnd: sim.met,
        outcome,
        outcomeText: text,
        maxAlt: this.maxAlt,
        bodies: [...new Set(this.bodiesSeen)],
        missions: [...sim.missions.done],
        frames: F.t.n,
        bytes: 0,
      },
      design: cloneDesign(this.designCopy),
      stage0: this.stage0,
      fuelKeys: [...this.fuelKeys],
      frames: {
        t: F.t.slice(),
        real: F.real.slice(),
        pos: F.pos.slice(),
        vel: F.vel.slice(),
        q: F.q.slice(),
        thr: F.thr.slice(),
        heat: F.heat.slice(),
        temp: F.temp.slice(),
        info: F.info.slice(),
        cmd: F.cmd.slice(),
      },
      fuel: { t: this.fuelT.slice(), f: this.fuelF.slice() },
      events: this.events.map((e) => ({ ...e })),
    };
    if (!this.bodiesSeen.length) data.meta.bodies = [];
    data.meta.bytes = demoBytes(data);
    return data;
  }
}

/** 当前姿态与“惯性保持”“随轨道保持”两种假设中较接近者的夹角。 */
function attitudeDrift(s: Snap, last: Snap): number {
  if (s.mode !== 'C' || last.mode !== 'C') return 0;
  const a = s.q.angleTo(last.q);
  const b = s.rel.angleTo(last.rel);
  return Math.min(a, b);
}
