import { BODY_BY_ID, MOON, type Body } from '../physics/bodies';
import { templateDesign } from '../rocket/design';
import { fmtDist, fmtTime } from '../ui/format';
import { FlightSim } from './flight';
import { solveCapture, solveCaptureAt, solveChangeApsis, solveCorrection, solvePlanetCorrection, solveReturn, solveTLI, solveTransfer, type SolveResult } from './maneuver';
import { FlightRecorder } from './recorder';
import type { DemoData } from './demo';

/** 默认火箭：总装车间第一次打开时的预设“登月者 L-1”。 */
export const DEMO_DESIGN = 'lunar';

/** 电脑演示的帧间隔（与 30 帧/秒的游戏一样逐帧调用 FlightSim.update）。 */
const DT = 1 / 30;

export type DemoTarget = 'moon' | 'mars' | 'jupiter';

/**
 * 电脑飞行员：像玩家一样操作——点“自动入轨”、在机动规划里算转移、
 * “⏩ 加速到节点前”、“执行机动”、中途修正、捕获、自动着陆……
 * 每一步都写一条解说字幕，飞行全程由 FlightRecorder 记录成 demo。
 */
export class ComputerPilot {
  readonly sim: FlightSim;
  readonly rec: FlightRecorder;
  log: (...a: unknown[]) => void;

  constructor(sim: FlightSim, log: (...a: unknown[]) => void = () => {}) {
    this.sim = sim;
    this.rec = new FlightRecorder(sim);
    sim.recorder = this.rec;
    this.log = log;
  }

  say(msg: string): void {
    this.rec.caption(msg);
    this.log(`[${fmtTime(this.sim.t)}] ${msg}`);
  }

  /** 逐帧推进，最多 seconds 秒真实时间，until 成立或飞行器损毁时提前结束。 */
  run(seconds: number, until?: () => boolean): void {
    const n = Math.ceil(seconds / DT);
    for (let i = 0; i < n; i++) {
      this.sim.update(DT);
      this.sim.drainEvents();
      if (this.sim.destroyed) throw new Error(`飞行器损毁：${this.sim.destroyReason}`);
      if (until && until()) return;
    }
    if (until) throw new Error(`等待超时（t = ${this.sim.t.toFixed(0)} s）`);
  }

  /** 以时间加速等待到模拟时间 t（游戏里的“⏩ 加速到节点前”）。 */
  warpTo(t: number, msg?: string): void {
    if (msg) this.say(msg);
    this.sim.warpToTime(t);
    this.run(20_000, () => this.sim.autoWarpTo === null);
  }

  /** 在固定的时间加速档位下滑行，直到条件满足。 */
  coast(warp: number, until: () => boolean, seconds = 20_000): void {
    this.run(seconds, () => {
      // 不超过当前允许的最高倍率（否则 setWarp 会不停弹出提示）
      const w = Math.min(warp, this.sim.maxWarpIndex());
      if (this.sim.warpIndex !== w) this.sim.setWarp(w);
      return until();
    });
    this.sim.setWarp(0);
  }

  state() {
    const V = this.sim.vessel;
    return { r: V.r, v: V.v, t: this.sim.t };
  }

  /** 把规划结果设为机动节点；失败时抛出。 */
  plan(res: SolveResult, what: string, replan?: { at: number | null; target: Body | null }): void {
    if (!res.node) throw new Error(`${what}失败：${res.msg}`);
    this.say(`机动规划 → ${what}：${res.msg}`);
    this.sim.addNode(res.node, replan?.at != null && replan.target ? { at: replan.at, target: replan.target.id } : null);
  }

  /** 中途修正：轨道已经足够准确时规划器不给节点，直接跳过。 */
  correct(res: SolveResult, what: string, lead = 20): void {
    if (!res.node) {
      this.say(`${what}：${res.msg}`);
      return;
    }
    this.plan(res, what);
    this.execNode(what, lead);
  }

  /** 加速到节点前，然后“执行机动”（飞行辅助自动对准、点火、关机）。 */
  execNode(what: string, lead = 60): void {
    const sim = this.sim;
    const n = sim.nodes[0];
    if (!n) throw new Error('没有机动节点');
    const wait = n.t - sim.nodeBurnTime() / 2 - lead - sim.t;
    if (wait > 5) this.warpTo(n.t - sim.nodeBurnTime() / 2 - lead, `时间加速到点火前（还有 ${fmtTime(wait)}）`);
    sim.setSas('maneuver');
    this.say(`执行机动：${what}（Δv ${(sim.nodeBurnVector()?.length() ?? 0).toFixed(0)} m/s，飞行辅助自动点火）`);
    sim.autopilot.engage('node');
    this.run(1200, () => sim.autopilot.mode === 'off');
    sim.refreshPrediction();
  }

  ascent(alt?: number): void {
    const sim = this.sim;
    if (alt) {
      sim.autopilot.ascentAlt = alt;
      sim.autopilot.ascentAltLocked = true;
    }
    sim.autopilot.engage('ascent');
    this.run(1500, () => sim.autopilot.mode === 'off');
    sim.autopilot.ascentAltLocked = false;
    const o = sim.telemetry.orbit;
    this.say(`入轨完成：远${sim.telemetry.body.apsisChar}点 ${fmtDist(o.apAlt)}，近${sim.telemetry.body.apsisChar}点 ${fmtDist(o.peAlt)}`);
  }

  /** 抛掉还挂着的氢氧转移级，只留着陆级。 */
  dropTransferStage(): void {
    const sim = this.sim;
    if (!sim.vessel.parts.some((p) => p.p.def.id === 'eng_s_hydro')) return;
    this.say('抛掉氢氧转移级，只保留着陆级');
    for (let i = 0; i < 4 && sim.vessel.parts.some((p) => p.p.def.id === 'eng_s_hydro'); i++) {
      sim.stage();
      this.run(1.5);
    }
  }

  land(where: string): void {
    const sim = this.sim;
    this.say(`飞行辅助“自动着陆”：减速下降，放下着陆腿，以 1 m/s 触地（${where}）`);
    sim.autopilot.engage('land');
    this.run(2400, () => sim.landed || sim.autopilot.mode === 'off');
    this.run(3);
    if (!sim.landed) throw new Error('着陆失败');
  }

  /** 在 SOI 内正常滑行到某个天体的近拱点捕获。 */
  capture(target: Body): void {
    const sim = this.sim;
    const res = target === MOON ? solveCapture(this.state()) : solveCaptureAt(this.state(), target);
    this.plan(res, `${target.name}捕获`);
    this.execNode(`${target.name}捕获`, 90);
    const o = sim.telemetry.orbit;
    this.say(`进入环绕${target.name}的轨道：近${target.apsisChar}点 ${fmtDist(o.peAlt)}，远${target.apsisChar}点 ${fmtDist(o.apAlt)}`);
  }
}

// ------------------------------------------------------------------ 三个任务

function flyMoon(p: ComputerPilot): void {
  const sim = p.sim;
  p.say('电脑驾驶“登月者 L-1”：发射入轨 → 奔月 → 月面着陆 → 返回地球');
  p.run(2);
  p.say('点火升空：飞行辅助“自动入轨”（竖直爬升，约 1 km 后开始重力转弯，目标 100 km 圆轨道）');
  p.ascent();
  // 奔月
  p.plan(solveTLI(p.state()), '奔月转移');
  p.execNode('奔月转移入射');
  sim.refreshPrediction();
  p.say(`奔月途中：预计近月点 ${fmtDist((sim.prediction?.moonMinDist ?? 0) - MOON.radius)}`);
  const tc = sim.t + 20_000;
  p.coast(8, () => sim.t > tc);
  p.correct(solveCorrection(p.state(), 'moon', 40_000, 60), '修正近月点');
  p.say('滑行进入月球引力影响球');
  p.coast(9, () => sim.telemetry.body.id === 'moon');
  p.capture(MOON);
  // 着陆
  p.dropTransferStage();
  p.land('月面');
  p.say('月面停留片刻，准备起飞');
  p.run(4);
  sim.setWarp(6);
  p.run(10);
  sim.setWarp(0);
  p.say('月面起飞：飞行辅助“自动入轨”，目标 20 km 环月轨道');
  p.ascent(20_000);
  // 返回
  p.plan(solveReturn(p.state()), '返回地球');
  p.execNode('月地转移入射');
  p.say('飞出月球影响球，返回地球');
  p.coast(8, () => sim.telemetry.body.id === 'earth', 200);
  p.correct(solveCorrection(p.state(), 'earth', 35_000, 90), '修正再入角', 30);
  p.say('滑行返回地球，准备再入');
  p.coast(9, () => sim.telemetry.body.id === 'earth' && sim.telemetry.alt < 200_000);
  p.say('分离着陆级，只留指令舱；SAS 逆行：隔热罩朝前再入大气层');
  while (sim.vessel.stageIndex < sim.vessel.stages.length) {
    sim.stage();
    p.run(1);
  }
  sim.setSas('retrograde');
  p.run(4000, () => sim.telemetry.alt < 60_000);
  p.say('再入大气层：等离子体包裹着指令舱，过载升高');
  p.run(4000, () => sim.vessel.chuteState === 'deploying' || sim.vessel.chuteState === 'deployed' || sim.landed);
  p.say('降落伞自动张开（先减速伞，后主伞）');
  p.run(4000, () => sim.landed);
  p.run(4);
  p.say(sim.touchingWater ? '溅落成功！登月往返任务完成' : '着陆成功！登月往返任务完成');
}

/** 行星际转移：从当前停泊轨道出发，到达目标行星的影响球。 */
function interplanetary(p: ComputerPilot, target: Body): void {
  const sim = p.sim;
  sim.targetBody = target.id;
  const plan = solveTransfer(p.state(), target);
  p.plan(plan, `前往${target.name}`, { at: plan.replanAt, target: plan.target });
  if (plan.replanAt != null) {
    // 窗口还远：先加速到窗口前，飞行器会自动用多体引力重新精确计算节点
    p.warpTo(plan.node!.t - 120, '时间加速，等待转移窗口（临近窗口时会自动精确计算）');
    p.run(5, () => sim.nodes[0]?.replanAt == null);
  }
  p.execNode(`${target.name}转移入射（逃逸地球）`);
  const md = sim.prediction?.minDist[target.id];
  p.say(`进入日心转移轨道：预计 ${md ? fmtTime(md.t - sim.t) : '?'} 后到达${target.name}，最近距离 ${md ? fmtDist(md.dist - target.radius) : '?'}`);
  // 巡航几天后第一次中途修正
  p.say('巡航中：飞出地球影响球');
  const t1 = sim.t + 5 * 86_400;
  p.coast(10, () => sim.t > t1);
  p.correct(solvePlanetCorrection(p.state(), target), '第一次中途修正');
  // 抵达前几天再修正一次
  sim.refreshPrediction();
  const arrive = sim.prediction?.minDist[target.id]?.t ?? sim.t;
  const lead = target.kind === 'gas' ? 12 * 86_400 : 4 * 86_400;
  if (arrive - lead > sim.t) {
    p.say(`日心巡航：约 ${fmtTime(arrive - sim.t)} 后抵达${target.name}`);
    p.coast(10, () => sim.t > arrive - lead);
    p.correct(solvePlanetCorrection(p.state(), target), '第二次中途修正');
  }
  p.say(`滑行进入${target.name}引力影响球`);
  p.coast(10, () => sim.telemetry.body === target, 30_000);
  // 影响球很大时（木星）太阳摄动明显，用完整预测的最近距离而不是瞬时二体轨道
  sim.refreshPrediction();
  const close = sim.prediction?.minDist[target.id];
  const pe = close ? close.dist - target.radius : sim.telemetry.orbit.peAlt;
  p.say(`进入${target.name}影响球：预计近${target.apsisChar}点 ${fmtDist(pe)}`);
}

/** 返回是否稳稳立在火星表面（着陆点碰上陡坡时着陆器会翻倒）。brakeLead：在近火点前多少秒开始减速。 */
function flyMars(p: ComputerPilot, windowT: number, brakeLead = 20): boolean {
  const sim = p.sim;
  const MARS = BODY_BY_ID.mars;
  p.say('电脑驾驶“登月者 L-1”：飞向火星并着陆');
  p.run(2);
  // 在发射台上等到窗口前一天半再发射，停泊轨道上就不用等太久
  const launchAt = windowT - 1.5 * 86_400 - 400;
  if (launchAt > sim.t + 3600) {
    p.say(`火星发射窗口约在 ${fmtTime(windowT - sim.t)} 后：在发射台上时间加速等待`);
    p.coast(10, () => sim.t > launchAt, 30_000);
    p.run(2);
  }
  p.say('点火升空：飞行辅助“自动入轨”（目标 100 km 停泊轨道）');
  p.ascent();
  interplanetary(p, MARS);
  p.capture(MARS);
  p.dropTransferStage();
  // 先在远火点把近火点降到 35 km（再低的话稀薄大气的阻力会让轨道直接衰减到地面），
  // 在近火点附近做重力转弯减速（SAS 逆行 + 全推力），低速之后再交给“自动着陆”完成触地
  p.plan(solveChangeApsis(p.state(), 'ap', 35_000), '降低近火点');
  p.execNode('降低近火点到 35 km', 30);
  const tPe = sim.t + sim.telemetry.orbit.timeToPe;
  p.warpTo(tPe - 120, '滑行到近火点附近');
  sim.setSas('retrograde');
  p.say('SAS 逆行：机头对准地表速度的反方向，准备减速');
  p.run(120, () => sim.t > tPe - brakeLead);
  p.say('全推力逆行减速（重力转弯着陆）：先减掉约 1 km/s 的水平速度');
  sim.vessel.throttle = 1;
  p.run(600, () => {
    const tl = sim.telemetry;
    return tl.vHoriz < 40 || tl.surfSpeed < 70 || tl.radarAlt < 2500;
  });
  sim.vessel.throttle = 0;
  p.land('火星表面：剩下的速度交给自动着陆');
  if (!sim.missions.done.has('marsLand')) return false;
  p.say(`火星着陆成功！着陆级还剩 Δv ${sim.telemetry.stageDv.toFixed(0)} m/s`);
  p.run(5);
  return true;
}

function flyJupiter(p: ComputerPilot): void {
  const sim = p.sim;
  const JUP = BODY_BY_ID.jupiter;
  p.say('电脑驾驶“登月者 L-1”：飞向木星（气态巨行星没有地面，只能环绕）');
  p.run(2);
  p.say('点火升空：飞行辅助“自动入轨”（目标 100 km 停泊轨道）');
  p.ascent();
  interplanetary(p, JUP);
  p.capture(JUP);
  // 绕木星飞过近木点之后再结束
  p.say('环绕木星：大椭圆轨道，远木点约为影响球的 40%');
  const tEnd = sim.t + 3 * 86_400;
  p.coast(9, () => sim.t > tEnd, 30_000);
  p.run(3);
}

/** 先模拟一次入轨，求出火星转移窗口的出发时刻（用于在发射台上等待）。 */
export function marsWindow(): number {
  const sim = new FlightSim(templateDesign(DEMO_DESIGN));
  sim.autopilot.engage('ascent');
  for (let i = 0; i < 40_000 && sim.autopilot.mode !== 'off'; i++) {
    sim.update(DT);
    sim.drainEvents();
  }
  const plan = solveTransfer({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t }, BODY_BY_ID.mars);
  if (!plan.node) throw new Error(plan.msg);
  return plan.node.t;
}

export const DEMO_NAMES: Record<DemoTarget, string> = {
  moon: '电脑演示：登月往返',
  mars: '电脑演示：飞向火星',
  jupiter: '电脑演示：飞向木星',
};

/**
 * 火星减速点火时刻的候选（近火点前多少秒）：着陆点恰好落在陡坡上时会翻倒，
 * 换一个时刻重飞，着陆点沿地面轨迹前后移动几十公里。
 */
const MARS_BRAKE_LEADS = [20, 35, 5, 50, -10];

/** 用默认火箭飞一次完整任务，返回录下的 demo。 */
export function flyDemo(target: DemoTarget, log: (...a: unknown[]) => void = () => {}): DemoData {
  let p: ComputerPilot | null = null;
  if (target === 'mars') {
    const windowT = marsWindow();
    for (const lead of MARS_BRAKE_LEADS) {
      const cand = new ComputerPilot(new FlightSim(templateDesign(DEMO_DESIGN)), log);
      if (flyMars(cand, windowT, lead)) {
        p = cand;
        break;
      }
      log(`近火点前 ${lead} 秒开始减速：着陆点坡度太陡，着陆器翻倒，换一个减速时刻重飞`);
    }
    if (!p) throw new Error('火星着陆多次翻倒');
  } else {
    p = new ComputerPilot(new FlightSim(templateDesign(DEMO_DESIGN)), log);
    if (target === 'moon') flyMoon(p);
    else flyJupiter(p);
  }
  const d = p.rec.finish(DEMO_NAMES[target], { id: `builtin-${target}`, builtin: target });
  d.meta.createdAt = 0;
  return d;
}
