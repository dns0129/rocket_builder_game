import { BODY_BY_ID } from '../physics/bodies';
import type { FlightSim } from './flight';
import { compassName, fmtTime } from '../ui/format';

/** 上升段建议倾角（度，0 = 竖直），与自动入轨使用同一条重力转弯曲线。 */
export function suggestedTilt(alt: number): number {
  if (alt <= 900) return 0;
  return 88 * Math.pow(Math.min(1, (alt - 900) / (48_000 - 900)), 0.42);
}

export interface GuideStep {
  text: string;
  /** 'act' = 现在就该操作，'wait' = 等待/观察 */
  kind: 'act' | 'wait' | 'done';
}

const km = (m: number) => `${(m / 1000).toFixed(0)} km`;

/**
 * “下一步”提示：根据当前飞行阶段告诉玩家该做什么。
 * 整趟登月往返被拆成一句一句的小目标，新手照着做就能完成。
 */
export function nextStep(sim: FlightSim): GuideStep | null {
  if (sim.destroyed) return null;
  const tel = sim.telemetry;
  const o = tel.orbit;
  const done = sim.missions.done;
  const V = sim.vessel;
  const ap = sim.autopilot;
  const thrust = tel.thrust > 0;
  const body = tel.body;
  const earth = body.id === 'earth';
  const atmoTop = body.atmosphere?.height ?? 0;
  const inOrbit = !o.hyperbolic && o.peAlt > Math.max(atmoTop, earth ? 0 : 5_000) && o.ap < body.soi * 0.9;
  const tgt = sim.targetBody ? BODY_BY_ID[sim.targetBody] : null;
  // 去过其他天体（不再是从地面起飞的上升段）
  const fromAfar = done.has('moonSoi') || [...done].some((id) => id.endsWith('Soi')) || sim.scenario === 'lmo';

  // 方向舵的航向（默认正东）
  const dirName = compassName(sim.rudderHeading);

  if (ap.mode !== 'off') return { text: `飞行辅助工作中 —— ${ap.status || '请稍候'}（按 ← / → 可随时接管）`, kind: 'wait' };

  // 发射前
  if (sim.scenario === 'pad' && !sim.metStarted) return { text: '按 空格 点火升空（新手可点右下角“自动入轨”全程托管）', kind: 'act' };

  // 地球上升段
  if (earth && !done.has('return') && !inOrbit && !fromAfar && !o.hyperbolic && !sim.landed) {
    if (o.apAlt < 90_000 && thrust) {
      if (tel.alt < 900) return { text: `竖直爬升中……到 1 km 后按 → 让火箭向${dirName}倾斜`, kind: 'wait' };
      const want = suggestedTilt(tel.alt);
      const cur = (sim.tiltAngle() * 180) / Math.PI;
      const diff = want - cur;
      const hint = Math.abs(diff) < 4 ? '保持住' : diff > 0 ? `按 → 再向${dirName}倾斜` : '按 ← 回正一点';
      return { text: `重力转弯：建议倾角 ${want.toFixed(0)}°（当前 ${cur.toFixed(0)}°），${hint} · 远地点 ${km(o.apAlt)} / 目标 100 km`, kind: 'act' };
    }
    if (o.apAlt >= 90_000 && thrust && tel.alt < atmoTop) return { text: '远地点已够高：按 X 关机，滑行出大气层（看蓝色预测弹道的最高点）', kind: 'act' };
    if (o.apAlt >= 70_000 && !thrust) {
      if (sim.nodes.length) return { text: '已规划圆化机动：点“执行机动”自动点火（或 ⏩ 加速到节点前）', kind: 'act' };
      return { text: `滑行至远地点（${Math.max(0, o.timeToAp).toFixed(0)} 秒后）：按 N 打开机动规划 → “远拱点圆化” → “执行机动”`, kind: 'act' };
    }
    if (tel.vVert < 0 && o.apAlt < 70_000 && sim.launched) return { text: `弹道正在下落：继续点火并向${dirName}倾斜，把远地点抬到 100 km；无法入轨时准备降落伞 (P)`, kind: 'act' };
  }

  const node = sim.nodes[0];
  if (node && node.t - sim.t > 3600)
    return { text: `转移窗口在 ${fmtTime(node.t - sim.t)} 后：点机动规划里的“⏩ 加速到节点前”（临近时会自动重新精确计算），再点“执行机动”`, kind: 'act' };
  if (node) return { text: '有待执行的机动：点“执行机动”让飞行辅助自动点火，途中可随时加速时间', kind: 'act' };

  // 行星际航行
  const pred = sim.prediction;
  if (tgt && tgt.id !== 'moon' && body !== tgt) {
    const enc = pred?.events.find((e) => e.type === 'soiEnter' && e.body === tgt);
    if (body.id === 'sun') {
      if (enc) return { text: `日心巡航中，${fmtTime(enc.t - sim.t)} 后进入${tgt.name}影响球：放心加速时间（. 键），抵达后做“${tgt.id === 'earth' ? '修正再入角' : tgt.name + '捕获'}”`, kind: 'wait' };
      return { text: `日心轨道：目前不会与${tgt.name}相遇 —— 机动规划“中途修正”`, kind: 'act' };
    }
    if (body.id !== 'moon' && (o.hyperbolic || o.ap > body.soi * 0.9))
      return { text: `正在离开${body.name}，飞往${tgt.name}：放心加速时间，进入日心轨道后做一次“中途修正”`, kind: 'wait' };
    if (body.id !== 'moon' && inOrbit && !sim.landed) return { text: `目标${tgt.name}：按 N 打开机动规划 → “🚀 前往${tgt.name}” → 等待窗口后“执行机动”`, kind: 'act' };
  }
  if (body.id === 'sun') return { text: '日心轨道：按 N 打开机动规划，选一个目标行星，然后“中途修正”', kind: 'act' };

  // 在其他行星
  if (!earth && body.id !== 'moon') {
    const c = body.apsisChar;
    if (sim.landed) return { text: `${body.name}着陆成功！点“自动入轨”起飞，回到环绕轨道后在机动规划中选目标“地” → “🚀 前往地球”`, kind: 'act' };
    if (o.hyperbolic || o.ap > body.soi * 0.9)
      return { text: `即将飞掠${body.name}：机动规划“${body.name}捕获” → “执行机动”${body.kind === 'gas' ? '（气态巨行星没有地面，只能环绕，千万别掉进去）' : ''}`, kind: 'act' };
    if (inOrbit) {
      if (body.kind === 'gas') return { text: `环绕${body.name}！欣赏一下风景。返回：机动规划目标选“地” → “🚀 前往地球”`, kind: 'done' };
      return { text: `环绕${body.name}！着陆：机动规划“降低近${c}点” → 执行 → “自动着陆”；返回：目标选“地” → “🚀 前往地球”`, kind: 'act' };
    }
    if (tel.radarAlt < 6_000 && tel.vVert < 0) return { text: '着陆：放下着陆腿 (G)，按“建议点火”倒计时减速，触地前速度降到 3 m/s 以内（或点“自动着陆”）', kind: 'act' };
    return { text: `近${c}点很低：可以点“自动着陆”，或逆行减速手动着陆`, kind: 'act' };
  }

  // 地球轨道 -> 奔月
  if (earth && inOrbit && !done.has('moonSoi')) {
    if (o.ap > 30_000_000 || o.hyperbolic) return { text: '正在飞往月球：可以放心加速时间（. 键），途中用“修正近月点”微调', kind: 'wait' };
    return { text: '已进入地球轨道！按 M 打开地图 → 机动规划“🌙 奔月转移” → “执行机动”', kind: 'act' };
  }
  if (earth && !inOrbit && done.has('orbit') && !done.has('moonSoi') && o.ap > 30_000_000) return { text: '正在飞往月球：可以放心加速时间（. 键）', kind: 'wait' };

  // 月球
  if (body.id === 'moon') {
    if (sim.landed) {
      if (!done.has('moonLiftoff')) return { text: '月面着陆成功！点“自动入轨”起飞，回到环月轨道', kind: 'act' };
      return { text: '按 空格 / Shift 点火起飞', kind: 'act' };
    }
    if (o.hyperbolic || o.ap > tel.body.soi * 0.9) {
      if (done.has('moonLiftoff')) return { text: '正在离开月球：滑行返回地球，途中可“修正再入角”', kind: 'wait' };
      return { text: '即将飞掠月球：机动规划“月球捕获” → “执行机动”，进入环月轨道', kind: 'act' };
    }
    if (done.has('moonLiftoff') || done.has('moonLand')) return { text: '回到环月轨道：机动规划“🌍 返回地球” → “执行机动”', kind: 'act' };
    if (tel.radarAlt < 6_000 && tel.vVert < 0) return { text: '着陆：放下着陆腿 (G)，按“建议点火”倒计时减速，触地前速度降到 3 m/s 以内（或点“自动着陆”）', kind: 'act' };
    if (o.peAlt > 8_000) return { text: '环月轨道！机动规划“降低近月点” → 执行，然后点“自动着陆”', kind: 'act' };
    return { text: '近月点很低：可以点“自动着陆”，或逆行减速手动着陆', kind: 'act' };
  }

  // 从行星返回地球
  if (earth && fromAfar && !done.has('moonLand') && !inOrbit && !sim.landed) {
    if (o.peAlt > atmoTop) return { text: '回到地球附近：机动规划“修正再入角”把近地点压到 35 km 直接再入，或在近地点“近拱点圆化”入轨', kind: 'act' };
    return { text: '再入：分离不需要的级，点 SAS“逆行”让隔热罩朝前，降落伞会自动张开', kind: 'act' };
  }

  // 返回地球
  if (earth && done.has('moonLand')) {
    if (sim.landed) return { text: '欢迎回家！', kind: 'done' };
    if (o.peAlt > atmoTop) return { text: '返回途中：机动规划“修正再入角”，把近地点压到 35 km 左右', kind: 'act' };
    const staged = V.stageIndex >= V.stages.length - 1;
    if (!staged) return { text: '准备再入：按 空格 分离着陆级，只留下指令舱', kind: 'act' };
    return { text: '再入：点 SAS“逆行”让隔热罩朝前，降落伞会自动张开', kind: 'act' };
  }

  if (sim.landed && earth) return { text: '已着陆。可以返回总装车间改进火箭', kind: 'done' };
  return null;
}
