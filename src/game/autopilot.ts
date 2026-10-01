import { Vector3 } from 'three';
import { G0, type Body } from '../physics/bodies';
import type { FlightSim } from './flight';
import { solveCircularize } from './maneuver';

export type APMode = 'off' | 'ascent' | 'node' | 'land';

/** 各天体的默认入轨高度：高于大气层顶端约 30 km；无大气天体 20 km。 */
export function defaultAscentAlt(body: Body): number {
  if (body.id === 'earth') return 100_000;
  if (body.atmosphere) return body.atmosphere.height + 30_000;
  return 20_000;
}

const UP = new Vector3(0, 1, 0);

/** 飞行辅助：自动入轨、自动执行机动节点、自动着陆（无大气天体）。 */
export class Autopilot {
  mode: APMode = 'off';
  status = '';
  targetDir: Vector3 | null = null;
  ascentAlt = 100_000;
  /** 外部（测试或界面）指定了入轨高度时为 true，不再按天体自动选择 */
  ascentAltLocked = false;
  private phase = '';
  private stageCooldown = 0;
  private sim: FlightSim;
  private nodeStarted = false;

  constructor(sim: FlightSim) {
    this.sim = sim;
  }

  engage(mode: APMode): void {
    const sim = this.sim;
    const body = sim.telemetry.body;
    if (mode === 'land' && body.atmosphere && body.atmosphere.rho0 > 0.2) {
      sim.emit({ type: 'msg', msg: `自动着陆仅适用于大气稀薄的天体；在${body.name}请使用降落伞。`, level: 'warn' });
      return;
    }
    if (mode === 'land' && body.kind !== 'rocky') {
      sim.emit({ type: 'msg', msg: `${body.name}没有可以着陆的表面。`, level: 'warn' });
      return;
    }
    if (mode === 'ascent' && !this.ascentAltLocked) this.ascentAlt = defaultAscentAlt(body);
    if (mode === 'node' && !sim.nodes.length) {
      sim.emit({ type: 'msg', msg: '没有机动节点', level: 'warn' });
      return;
    }
    this.mode = mode;
    this.phase = mode === 'ascent' ? 'start' : '';
    this.nodeStarted = false;
    this.targetDir = null;
    sim.emit({ type: 'msg', msg: `飞行辅助：${mode === 'ascent' ? '自动入轨' : mode === 'node' ? '执行机动' : '自动着陆'}`, level: 'info' });
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
    this.stageCooldown -= dt;
    if (this.stageCooldown > 0) return;
    if (this.sim.stageWanted()) {
      this.sim.stage();
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
      // 重力转弯在大气层约 2/3 高度处结束（地球 48 km）；无大气天体沿用同一曲线
      const turnEnd = tel.body.atmosphere ? (tel.body.atmosphere.height * 48) / 70 : 48_000;
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

  /** 执行第一个机动节点；返回是否完成。 */
  private execNode(dt: number): boolean {
    const sim = this.sim;
    const V = sim.vessel;
    const node = sim.nodes[0];
    if (!node) return true;
    const vec = sim.nodeBurnVector();
    if (!vec) return true;
    const bt = sim.nodeBurnTime();
    const tStart = node.t - bt / 2;
    const remain = vec.length();
    this.targetDir = remain > 1e-3 ? vec.clone().normalize() : this.targetDir;
    if (sim.t < tStart && !this.nodeStarted) {
      V.throttle = 0;
      this.status = `等待点火：${Math.max(0, tStart - sim.t).toFixed(0)} s，Δv ${remain.toFixed(1)} m/s`;
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
    let thr = 0;
    if (align < (6 * Math.PI) / 180 && aMax > 0) thr = Math.min(1, remain / (aMax * 1.2) + 0.02);
    V.setEffectiveThrottle(thr, remain > 0.15);
    this.status = `执行机动：剩余 Δv ${remain.toFixed(1)} m/s`;
    if (node.remaining && node.fixedDv && (node.remaining.dot(node.fixedDv) <= 0 || remain < 0.15)) {
      V.throttle = 0;
      sim.removeNode();
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
