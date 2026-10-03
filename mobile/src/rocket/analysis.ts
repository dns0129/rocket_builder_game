import { G0, EARTH, MOON } from '../physics/bodies';
import type { Layout, PlacedPart } from './design';

export interface StageStats {
  index: number;
  label: string;
  dv: number; // 真空 Δv
  dvSL: number; // 海平面 Δv
  twrSL: number; // 地球海平面推重比
  twrVac: number;
  twrMoon: number;
  burnTime: number;
  m0: number;
  m1: number;
  engines: number;
}

export interface DesignStats {
  stages: StageStats[];
  totalDv: number;
  mass: number;
  dryMass: number;
  crew: number;
  height: number;
  errors: string[];
  warnings: string[];
  hints: string[];
}

export function poolKey(p: PlacedPart): string {
  return `${p.fuelGroup}:${p.prop}`;
}

export function enginePoolKey(p: PlacedPart): string {
  const e = p.def.engine!;
  return `${p.fuelGroup}:${e.propellant}`;
}

export function analyzeDesign(layout: Layout): DesignStats {
  const attached = new Set(layout.parts.map((p) => p.key));
  const pools = new Map<string, number>();
  const poolOwners = new Map<string, PlacedPart[]>();
  for (const p of layout.parts) {
    if (p.fuelMax > 0) {
      const k = poolKey(p);
      pools.set(k, (pools.get(k) ?? 0) + p.fuelMax);
      if (!poolOwners.has(k)) poolOwners.set(k, []);
      poolOwners.get(k)!.push(p);
    }
  }
  const ignited = new Set<string>();

  const mass = () => {
    let m = 0;
    for (const p of layout.parts) if (attached.has(p.key)) m += p.dryMass;
    for (const [k, v] of pools) {
      const owners = poolOwners.get(k)!;
      if (owners.some((o) => attached.has(o.key))) m += v;
    }
    return m;
  };

  const removeParts = (pred: (p: PlacedPart) => boolean) => {
    const removed: PlacedPart[] = [];
    for (const p of layout.parts) if (attached.has(p.key) && pred(p)) removed.push(p);
    return removed;
  };

  const totalMass = mass();
  const stages: StageStats[] = [];
  for (let si = 0; si < layout.stages.length; si++) {
    const st = layout.stages[si];
    if (st.decoupleSection !== null) {
      const ds = st.decoupleSection;
      for (const p of removeParts((q) => q.section === ds)) attached.delete(p.key);
    }
    if (st.jettisonRadial.length) {
      for (const p of removeParts((q) => q.radial && st.jettisonRadial.includes(q.parentUid))) attached.delete(p.key);
    }
    for (const k of st.ignite) ignited.add(k);

    const activeEngines = () =>
      layout.parts.filter((p) => p.def.engine && ignited.has(p.key) && attached.has(p.key) && (pools.get(enginePoolKey(p)) ?? 0) > 1e-9);

    const next = layout.stages[si + 1];
    const toRemove = new Set<string>();
    if (next) {
      if (next.decoupleSection !== null) for (const p of layout.parts) if (p.section === next.decoupleSection) toRemove.add(p.key);
      for (const p of layout.parts) if (p.radial && next.jettisonRadial.includes(p.parentUid)) toRemove.add(p.key);
    }

    let m = mass();
    const m0 = m;
    const start = activeEngines();
    let fVac0 = 0;
    let fSL0 = 0;
    for (const e of start) {
      fVac0 += e.def.engine!.thrustVac;
      fSL0 += (e.def.engine!.thrustVac * e.def.engine!.ispSL) / e.def.engine!.ispVac;
    }
    let dv = 0;
    let dvSL = 0;
    let burn = 0;
    for (let guard = 0; guard < 64; guard++) {
      const act = activeEngines();
      if (!act.length) break;
      const watch = act.filter((e) => toRemove.has(e.key));
      const watched = watch.length ? watch : act;
      const drain = new Map<string, number>();
      let mdot = 0;
      let fVac = 0;
      let fSL = 0;
      for (const e of act) {
        const s = e.def.engine!;
        const md = s.thrustVac / (s.ispVac * G0);
        const k = enginePoolKey(e);
        drain.set(k, (drain.get(k) ?? 0) + md);
        mdot += md;
        fVac += s.thrustVac;
        fSL += (s.thrustVac * s.ispSL) / s.ispVac;
      }
      let dt = Infinity;
      for (const [k, md] of drain) dt = Math.min(dt, (pools.get(k) ?? 0) / md);
      const dm = mdot * dt;
      const ratio = m / Math.max(1e-6, m - dm);
      dv += (fVac / mdot) * Math.log(ratio);
      dvSL += (fSL / mdot) * Math.log(ratio);
      for (const [k, md] of drain) {
        const left = (pools.get(k) ?? 0) - md * dt;
        pools.set(k, left < 1e-6 ? 0 : left);
      }
      m -= dm;
      burn += dt;
      const done = watched.every((e) => (pools.get(enginePoolKey(e)) ?? 0) <= 1e-9);
      if (done) break;
    }
    stages.push({
      index: si,
      label: st.label,
      dv,
      dvSL,
      twrSL: fSL0 / (m0 * EARTH.surfaceGravity),
      twrVac: fVac0 / (m0 * EARTH.surfaceGravity),
      twrMoon: fVac0 / (m0 * MOON.surfaceGravity),
      burnTime: burn,
      m0,
      m1: m,
      engines: start.length,
    });
  }

  let dryMass = 0;
  let crew = 0;
  for (const p of layout.parts) {
    dryMass += p.dryMass;
    crew += p.def.crew ?? 0;
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const hints: string[] = [];
  const hasControl = layout.parts.some((p) => p.def.category === 'pod');
  if (!layout.parts.length) errors.push('火箭是空的：从左侧零件库添加零件。');
  else if (!hasControl) errors.push('缺少指令舱或无人控制核心。');
  const first = stages.find((s) => s.engines > 0);
  if (layout.parts.length && (!stages.length || stages[0].engines === 0)) errors.push('第一级没有发动机，无法起飞。');
  else if (first && first.twrSL < 1) warnings.push(`起飞推重比仅 ${first.twrSL.toFixed(2)}，小于 1，火箭无法离开发射台。`);
  else if (first && first.twrSL < 1.2) warnings.push(`起飞推重比 ${first.twrSL.toFixed(2)} 偏低，重力损失会很大（建议 1.3~2.0）。`);

  for (const p of layout.parts) {
    if (!p.def.engine || p.def.engine.propellant === 'solid') continue;
    const k = enginePoolKey(p);
    const have = layout.parts.some((q) => q.fuelMax > 0 && poolKey(q) === k);
    if (!have) {
      const pn = p.def.engine.propellant === 'hydrolox' ? '液氢液氧' : '液氧煤油';
      warnings.push(`${p.def.name} 所在的级没有${pn}燃料箱（燃料不能跨分离器输送）。`);
    }
  }
  const topMain = layout.parts.find((p) => !p.radial);
  if (topMain && !topMain.def.noseCone && !topMain.def.parachute && topMain.def.category !== 'pod') {
    hints.push('顶部没有鼻锥或指令舱，气动阻力较大。');
  }
  if (crew > 0 && !layout.parts.some((p) => p.def.parachute)) warnings.push('没有降落伞，航天员无法安全返回地球。');
  if (crew > 0 && !layout.parts.some((p) => p.def.heatShield)) hints.push('没有隔热罩：从月球返回时以约 3 km/s 再入大气会过热。');
  if (!layout.parts.some((p) => p.node.acc && p.node.acc.part.startsWith('legs'))) hints.push('没有着陆腿：月面着陆会很困难。');
  const totalDv = stages.reduce((s, x) => s + x.dv, 0);
  if (totalDv < 3400 && layout.parts.length) hints.push('总 Δv 低于约 3400 m/s，可能无法进入地球轨道。');
  else if (totalDv < 6300 && layout.parts.length) hints.push('登月并返回约需 6300 m/s 的 Δv（含余量）。');

  return {
    stages,
    totalDv,
    mass: totalMass,
    dryMass,
    crew,
    height: layout.height,
    errors,
    warnings,
    hints,
  };
}
