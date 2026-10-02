import { Vector3 } from 'three';
import { G0 } from '../physics/bodies';
import type { FlightSim } from './flight';
import { solveCircularize } from './maneuver';

export type APMode = 'off' | 'ascent' | 'node' | 'land';

const UP = new Vector3(0, 1, 0);

function fmtWait(s: number): string {
  s = Math.max(0, s);
  if (s < 120) return `${s.toFixed(0)} s`;
  if (s < 7200) return `${(s / 60).toFixed(0)} 分钟`;
  return s < 172_800 ? `${(s / 3600).toFixed(1)} 小时` : `${(s / 86_400).toFixed(1)} 天`;
}

/** 飞行辅助：自动入轨、自动执行机动节点、自动着陆（无大气天体）。 */
export class Autopilot {
  mode: APMode = 'off';
  status = '';
  targetDir: Vector3 | null = null;
  ascentAlt = 100_000;
  private phase = '';
  private stageCooldown = 0;
  private sim: FlightSim;
  private nodeStarted = false;

  constructor(sim: FlightSim) {
    this.sim = sim;
  }

  /** 飞行辅助正在负责执行第一个机动节点（“执行机动”或自动入轨的圆化阶段）。 */
  get executingNode(): boolean {
    return this.mode === 'node' || (this.mode === 'ascent' && this.phase === 'circ');
  }

  /** 负责的机动还没执行完时返回点火时刻：时间加速不得越过它；不需要限制时返回 null。 */
  burnWarpHold(): number | null {
    if (!this.executingNode) return null;
    const n = this.sim.nodes[0];
    if (!n || n.done) return null;
    return n.t - this.sim.nodeBurnLead();
  }

  engage(mode: APMode): void {
    const sim = this.sim;
    if (mode === 'land' && sim.telemetry.body.atmosphere) {
      sim.emit({ type: 'msg', msg: '自动着陆仅适用于无大气天体；在地球请使用降落伞。', level: 'warn' });
      return;
    }
    if (mode === 'node' && !sim.nodes.length) {
      sim.emit({ type: 'msg', msg: '没有机动节点', level: 'warn' });
      return;
    }
    if (mode === 'node') {
      const n = sim.nodes[0];
      const bt = sim.nodeBurnTime();
      if (!isFinite(bt)) {
        sim.emit({ type: 'msg', msg: '没有可用的发动机/燃料，无法执行机动', level: 'bad' });
        return;
      }
      if (sim.t > n.t + Math.max(120, bt)) {
        sim.emit({ type: 'msg', msg: '机动节点已经过去太久，请删除后重新规划', level: 'warn' });
        return;
      }
    }
    this.mode = mode;
    this.phase = mode === 'ascent' ? 'start' : '';
    this.nodeStarted = false;
    this.targetDir = null;
    sim.emit({ type: 'msg', msg: `飞行辅助：${mode === 'ascent' ? '自动入轨' : mode === 'node' ? '执行机动' : '自动着陆'}`, level: 'info' });
    if (mode === 'node') {
      // 节点还远：自动时间加速到点火前（随时可以按 / 恢复实时）
      const tStart = sim.nodes[0].t - sim.nodeBurnLead();
      if (tStart - sim.t > 90 && sim.autoWarpTo === null) {
        sim.warpToTime(tStart - 45);
        sim.emit({ type: 'msg', msg: '自动时间加速到点火前', level: 'info' });
      }
    }
  }

  disengage(msg?: string, keepThrottle = false): void {
    if (this.mode === 'off') return;
    this.mode = 'off';
    this.targetDir = null;
    this.status = '';
    if (!keepThrottle) this.sim.vessel.throttle = 0;
    if (msg) this.sim.emit({ type: 'msg', msg, level: 'good' });
  }

  private autoStage(dt: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    this.stageCooldown -= dt;
    if (this.stageCooldown > 0 || V.stageIndex >= V.stages.length) return;
    const next = V.stages[V.stageIndex];
    if (next.chutes.length && !next.ignite.length && next.decoupleSection === null) return;
    const active = V.activeEngines();
    let should = active.length === 0 && V.stages.slice(V.stageIndex).some((s) => s.ignite.length > 0);
    if (!should && (next.jettisonRadial.length || next.decoupleSection !== null)) {
      // 即将抛离的部分中有已熄火的发动机
      const doomed = V.parts.filter(
        (rp) =>
          rp.p.def.engine &&
          rp.ignited &&
          ((next.decoupleSection !== null && rp.p.section === next.decoupleSection) || (rp.p.radial && next.jettisonRadial.includes(rp.p.parentUid))),
      );
      if (doomed.length && doomed.every((rp) => rp.flameout)) should = true;
    }
    if (should) {
      sim.stage();
      this.stageCooldown = 0.8;
    }
  }

  update(dt: number): void {
    if (this.mode === 'off') return;
    const sim = this.sim;
    if (sim.destroyed) {
      this.mode = 'off';
      return;
    }
    if (this.mode === 'ascent') this.updateAscent(dt);
    else if (this.mode === 'node') this.updateNode(dt);
    else if (this.mode === 'land') this.updateLand(dt);
  }

  private updateAscent(dt: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    const target = this.ascentAlt;
    const atmo = tel.body.atmosphere?.height ?? 0;
    if (this.phase === 'start') {
      V.throttle = 1;
      if (!V.activeEngines().length) sim.stage();
      this.phase = 'climb';
      this.stageCooldown = 1;
    }
    if (this.phase === 'climb') {
      this.autoStage(dt);
      const alt = tel.alt;
      const turnStart = 900;
      const turnEnd = 48_000;
      let pitch = 90;
      if (alt > turnStart) pitch = 90 - 88 * Math.pow(Math.min(1, (alt - turnStart) / (turnEnd - turnStart)), 0.42);
      const pr = (pitch * Math.PI) / 180;
      const dir = tel.up.clone().multiplyScalar(Math.sin(pr)).addScaledVector(tel.east, Math.cos(pr)).normalize();
      // 大动压时限制攻角
      if (tel.dynPressure > 4000 && tel.surfSpeed > 50) {
        const pro = tel.vSurfVec.clone().normalize();
        const ang = dir.angleTo(pro);
        const lim = (4 * Math.PI) / 180;
        if (ang > lim) {
          const axis = new Vector3().crossVectors(pro, dir).normalize();
          dir.copy(pro).applyAxisAngle(axis, lim);
        }
      }
      this.targetDir = dir;
      // 限制加速度（减小气动损失与过载）
      const { thrust } = V.maxThrustVac();
      const maxAcc = 3.2 * G0;
      if (thrust > 0) V.setEffectiveThrottle(Math.min(1, (maxAcc * V.mass) / thrust));
      else V.throttle = 1;
      this.status = `上升段：俯仰 ${pitch.toFixed(0)}°，远地点 ${(tel.orbit.apAlt / 1000).toFixed(1)} / ${(target / 1000).toFixed(0)} km`;
      if (tel.orbit.apAlt >= target) {
        V.throttle = 0;
        this.phase = 'coast';
      }
    } else if (this.phase === 'coast') {
      this.autoStage(dt);
      this.targetDir = tel.vOrbVec.clone().normalize();
      V.throttle = tel.orbit.apAlt < target - 500 && tel.alt < atmo ? 0.3 : 0;
      this.status = `滑行至大气层外：高度 ${(tel.alt / 1000).toFixed(1)} km`;
      if (tel.alt > atmo + 500 || (tel.orbit.timeToAp < 40 && tel.alt > atmo)) {
        const res = solveCircularize({ r: V.r, v: V.v, t: sim.t }, 'ap');
        if (res.node) {
          sim.addNode(res.node);
          this.phase = 'circ';
          this.nodeStarted = false;
        } else {
          this.disengage(res.msg);
        }
      }
    } else if (this.phase === 'circ') {
      this.status = '圆化轨道';
      const done = this.execNode(dt);
      if (done) {
        this.disengage('自动入轨完成！');
      }
    }
  }

  private updateNode(dt: number): void {
    const done = this.execNode(dt);
    if (done) this.disengage('机动执行完毕');
  }

  /**
   * 执行第一个机动节点；返回是否完成。
   * 点火时刻以节点为中心；点火方向与剩余 Δv 由闭环制导（guidance.ts）每帧更新，
   * 关机由物理子步精确完成（node.done），这里只负责对准、油门和分级。
   */
  private execNode(dt: number): boolean {
    const sim = this.sim;
    const V = sim.vessel;
    const node = sim.nodes[0];
    if (!node) return true;
    if (node.done) {
      V.throttle = 0;
      sim.removeNode(false);
      return true;
    }
    const vec = sim.nodeBurnVector();
    if (!vec) return true;
    const tStart = node.t - sim.nodeBurnLead();
    const remain = vec.length();
    if (remain > 1e-6) this.targetDir = vec.clone().normalize();
    else if (!this.targetDir) this.targetDir = node.burnDir?.clone() ?? null;
    if (sim.t < tStart && !this.nodeStarted) {
      V.throttle = 0;
      this.status = `等待点火：${fmtWait(tStart - sim.t)}，Δv ${remain.toFixed(1)} m/s`;
      return false;
    }
    this.nodeStarted = true;
    if (!V.activeEngines().length) {
      if (V.stageIndex < V.stages.length && V.stages.slice(V.stageIndex).some((s) => s.ignite.length)) {
        this.autoStage(dt);
      } else {
        sim.emit({ type: 'msg', msg: '没有可用的发动机/燃料', level: 'bad' });
        return true;
      }
    } else this.autoStage(dt);
    const fwd = UP.clone().applyQuaternion(V.q);
    const align = this.targetDir ? fwd.angleTo(this.targetDir) : Math.PI;
    const { thrust } = V.maxThrustVac();
    const aMax = thrust / V.mass;
    // 对准后才点火；已经在烧时允许稍大的偏差（滞回），免得姿态一抖油门就反复开关
    const lim = ((V.throttle > 0 ? 9 : 4) * Math.PI) / 180;
    let thr = 0;
    // 最后约 0.25 s 逐渐收油门，配合子步关机得到精确的 Δv
    if (align < lim && aMax > 0) thr = Math.min(1, remain / (aMax * 0.25) + 0.01);
    V.setEffectiveThrottle(thr, true);
    this.status = align < lim || V.throttle > 0 ? `执行机动：剩余 Δv ${remain.toFixed(1)} m/s` : `对准点火方向：偏差 ${((align * 180) / Math.PI).toFixed(0)}°`;
    // 保护：已经“烧过头”（例如不能关机的固体发动机）或剩余量可以忽略
    if (node.remaining && node.burnDir && (node.remaining.dot(node.burnDir) <= 0 || remain < 0.01)) {
      V.throttle = 0;
      sim.removeNode(false);
      return true;
    }
    return false;
  }

  private updateLand(dt: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    if (sim.landed) {
      this.disengage('自动着陆完成');
      return;
    }
    this.autoStage(dt);
    if (tel.radarAlt < 3000 && !V.legsDeployed && V.hasLegs()) sim.toggleLegs();
    const g = tel.gLocal;
    const { thrust } = V.maxThrustVac();
    const aMax = thrust / V.mass;
    if (aMax < g * 1.1) {
      this.status = '推力不足，无法悬停！';
    }
    const h = Math.max(0, tel.radarAlt);
    const brake = Math.max(0.3, (aMax - g) * 0.55);
    let vTarget = -Math.min(1.0 + Math.min(Math.sqrt(2 * brake * h), h * 0.22), 400);
    if (h < 4) vTarget = -1.0;
    const vHorizVec = tel.vSurfVec.clone().addScaledVector(tel.up, -tel.vVert);
    const needV = g + (vTarget - tel.vVert) * 1.5;
    const horizGain = h < 30 ? 1.0 : 0.6;
    const needH = vHorizVec.clone().multiplyScalar(-horizGain);
    const hl = needH.length();
    const maxH = Math.max(0.5, aMax * 0.9);
    if (hl > maxH) needH.multiplyScalar(maxH / hl);
    const acc = tel.up.clone().multiplyScalar(Math.max(0, needV)).add(needH);
    // 限制倾角（接近地面时保持竖直）
    const tiltLim = h < 50 ? 0.25 : 1.2;
    const vertComp = acc.dot(tel.up);
    const horiz = acc.clone().addScaledVector(tel.up, -vertComp);
    const maxHoriz = Math.max(0.01, Math.max(vertComp, g * 0.3) * Math.tan(tiltLim));
    if (horiz.length() > maxHoriz) horiz.multiplyScalar(maxHoriz / horiz.length());
    const dir = tel.up.clone().multiplyScalar(Math.max(vertComp, g * 0.3)).add(horiz).normalize();
    this.targetDir = dir;
    const fwd = UP.clone().applyQuaternion(V.q);
    const along = acc.dot(fwd);
    let eff = aMax > 0 ? Math.max(0, along) / aMax : 0;
    // 仍在高空且下降速度低于目标时无需点火
    if (tel.vVert > vTarget + 3 && vHorizVec.length() < 3 && h > 50) eff = 0;
    V.setEffectiveThrottle(Math.min(1, eff));
    this.status = `自动着陆：离地 ${h.toFixed(0)} m，垂直速度 ${tel.vVert.toFixed(1)} m/s`;
  }
}
