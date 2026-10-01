import { Quaternion, Vector3 } from 'three';
import { G0, type Body } from '../physics/bodies';
import { getPart } from '../rocket/parts';
import type { Layout, PlacedPart, RocketDesign, StagePlan } from '../rocket/design';
import { layoutDesign, nodeMasses } from '../rocket/design';
import { enginePoolKey, poolKey } from '../rocket/analysis';

export interface RuntimePart {
  p: PlacedPart;
  key: string;
  fuel: number;
  fuelMax: number;
  dry: number;
  ignited: boolean;
  flameout: boolean;
  throttleEff: number; // 当前实际节流 0..1
  thrustNow: number; // 当前推力 N
  center: Vector3; // 船体系质心位置
  igniteDelay?: number; // 分离后延迟点火的剩余时间 s（先让废弃级拉开距离）
}

export interface ContactPoint {
  pos: Vector3; // 船体系
  kind: 'leg' | 'hull';
  tolerance: number;
  partKey: string;
  stiffScale: number;
}

export type ChuteState = 'stowed' | 'armed' | 'deploying' | 'deployed' | 'cut';

export interface AeroProps {
  areaFront: number;
  cdFront: number;
  cdBack: number;
  areaSide: number;
  copY: number; // 压心（船体系 y）
  dampK: number; // Σ Cn·A·y² 的辅助量（相对原点，运行时换算）
  finArea: number;
  finY: number;
  finR: number;
  noseRadius: number;
  topKey: string;
  bottomKey: string;
  shieldBottom: boolean;
}

export class Vessel {
  design: RocketDesign;
  layout: Layout;
  parts: RuntimePart[] = [];
  byKey = new Map<string, RuntimePart>();
  stageIndex = 0;

  // 状态（惯性系，地心为原点）
  r = new Vector3(); // 质心位置
  v = new Vector3();
  q = new Quaternion(); // 船体 -> 惯性
  w = new Vector3(); // 角速度（船体系）

  throttle = 0;
  legsDeployed = false;
  legDeploy = 0; // 0..1 动画
  chuteState: ChuteState = 'stowed';
  chuteDeploy = 0;
  temperature = 250; // 迎风面蒙皮温度 K

  mass = 0;
  com = new Vector3();
  inertia = new Vector3(1, 1, 1);
  torqueWheel = 0;
  aero!: AeroProps;
  contacts: ContactPoint[] = [];
  crew = 0;
  dirty = true;

  constructor(design: RocketDesign) {
    this.design = design;
    this.layout = layoutDesign(design);
    for (const p of this.layout.parts) {
      const rp: RuntimePart = {
        p,
        key: p.key,
        fuel: p.fuelMax,
        fuelMax: p.fuelMax,
        dry: p.dryMass,
        ignited: false,
        flameout: false,
        throttleEff: 0,
        thrustNow: 0,
        center: new Vector3(p.x, (p.yBottom + p.yTop) / 2, p.z),
      };
      this.parts.push(rp);
      this.byKey.set(rp.key, rp);
    }
    this.refresh();
  }

  get stages(): StagePlan[] {
    return this.layout.stages;
  }

  /** 附着零件变化后重新计算气动、接触点、力矩等。 */
  refresh(): void {
    this.computeMassProps();
    this.computeAero();
    this.computeContacts();
    this.torqueWheel = 0;
    this.crew = 0;
    for (const rp of this.parts) {
      this.torqueWheel += rp.p.def.torque ?? 0;
      this.crew += rp.p.def.crew ?? 0;
    }
    this.dirty = false;
  }

  computeMassProps(): void {
    let m = 0;
    const c = new Vector3();
    for (const rp of this.parts) {
      const pm = rp.dry + rp.fuel;
      m += pm;
      c.addScaledVector(rp.center, pm);
    }
    if (m <= 0) {
      this.mass = 1;
      return;
    }
    c.divideScalar(m);
    let ix = 0;
    let iy = 0;
    let iz = 0;
    for (const rp of this.parts) {
      const pm = rp.dry + rp.fuel;
      const r = Math.max(0.2, rp.p.radius);
      const h = rp.p.def.height;
      const dx = rp.center.x - c.x;
      const dy = rp.center.y - c.y;
      const dz = rp.center.z - c.z;
      const it = (pm * (3 * r * r + h * h)) / 12;
      const ia = 0.5 * pm * r * r;
      ix += it + pm * (dy * dy + dz * dz);
      iy += ia + pm * (dx * dx + dz * dz);
      iz += it + pm * (dx * dx + dy * dy);
    }
    this.mass = m;
    this.com.copy(c);
    this.inertia.set(Math.max(ix, 1), Math.max(iy, 1), Math.max(iz, 1));
  }

  /** 质心变化时，保持船体几何在世界中不动。 */
  updateMassProps(): void {
    const old = this.com.clone();
    this.computeMassProps();
    const d = this.com.clone().sub(old).applyQuaternion(this.q);
    this.r.add(d);
  }

  computeAero(): void {
    const main = this.parts.filter((rp) => !rp.p.radial);
    let areaFront = 0;
    let maxR = 0;
    for (const rp of main) maxR = Math.max(maxR, rp.p.radius);
    areaFront += Math.PI * maxR * maxR;
    const radialSeen = new Set<string>();
    for (const rp of this.parts) {
      if (!rp.p.radial) continue;
      const gk = `${rp.p.parentUid}_${rp.p.radialIndex}`;
      if (radialSeen.has(gk)) continue;
      radialSeen.add(gk);
      const r = Math.max(...this.parts.filter((q) => q.p.radial && `${q.p.parentUid}_${q.p.radialIndex}` === gk).map((q) => q.p.radius));
      areaFront += Math.PI * r * r;
    }
    let areaSide = 0;
    let copW = 0;
    let dampK = 0;
    let finArea = 0;
    let finY = 0;
    let finR = 0;
    for (const rp of this.parts) {
      const d = rp.p.def;
      const a = d.height * Math.max(d.diameter, d.bottomDiameter) * (d.noseCone ? 0.6 : 1);
      const k = d.noseCone ? 1.6 : d.category === 'pod' ? 1.3 : 1;
      areaSide += a;
      copW += a * k * rp.center.y;
      dampK += a * k;
      const acc = rp.p.node.acc;
      if (acc) {
        const ad = getPart(acc.part);
        if (ad.accessory?.kind === 'fins') {
          const fa = (ad.accessory.finArea ?? 0) * acc.count;
          const fy = rp.p.yBottom + ad.height * 0.45;
          finArea += fa;
          finY += fa * fy;
          finR += fa * (rp.p.radius + ad.accessory.reach * 0.5);
        }
      }
    }
    // 尾翼的法向力系数较高（有效面积 ×2.5）
    const finEff = finArea * 2.5;
    const totalW = dampK + finEff;
    const copY = totalW > 0 ? (copW + (finArea > 0 ? finEff * (finY / finArea) : 0)) / totalW : this.com.y;
    const sorted = [...main].sort((a, b) => b.p.yTop - a.p.yTop);
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];
    let cdFront = 0.9;
    if (top) {
      const d = top.p.def;
      if (d.noseCone) cdFront = 0.28;
      else if (d.category === 'pod' || d.parachute) cdFront = 0.5;
    }
    const shieldBottom = !!bottom?.p.def.heatShield;
    const cdBack = shieldBottom ? 1.3 : bottom?.p.def.engine ? 0.9 : 1.0;
    this.aero = {
      areaFront,
      cdFront,
      cdBack,
      areaSide,
      copY,
      dampK: totalW,
      finArea,
      finY: finArea > 0 ? finY / finArea : 0,
      finR: finArea > 0 ? finR / finArea : 0,
      noseRadius: Math.max(0.3, maxR),
      topKey: top?.key ?? '',
      bottomKey: bottom?.key ?? '',
      shieldBottom,
    };
  }

  computeContacts(): void {
    const cps: ContactPoint[] = [];
    const main = this.parts.filter((rp) => !rp.p.radial);
    if (!main.length) {
      this.contacts = cps;
      return;
    }
    let minY = Infinity;
    let maxY = -Infinity;
    for (const rp of this.parts) {
      minY = Math.min(minY, rp.p.yBottom);
      maxY = Math.max(maxY, rp.p.yTop);
    }
    // 底部一圈
    const bottomParts = this.parts.filter((rp) => rp.p.yBottom <= minY + 0.05);
    for (const rp of bottomParts) {
      const d = rp.p.def;
      const br = (d.engine ? d.engine.bellRadius * (d.engine.cluster ? 2.2 : 1) : d.bottomDiameter / 2) * 0.9;
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        cps.push({
          pos: new Vector3(rp.p.x + br * Math.cos(a), rp.p.yBottom, rp.p.z + br * Math.sin(a)),
          kind: 'hull',
          tolerance: d.impact,
          partKey: rp.key,
          stiffScale: 1,
        });
      }
    }
    // 着陆腿
    for (const rp of this.parts) {
      const acc = rp.p.node.acc;
      if (!acc) continue;
      const ad = getPart(acc.part);
      if (ad.accessory?.kind !== 'legs') continue;
      for (let i = 0; i < acc.count; i++) {
        const a = (i / acc.count) * Math.PI * 2 + Math.PI / 4;
        const rr = rp.p.radius + ad.accessory.reach;
        cps.push({
          pos: new Vector3(rp.p.x + rr * Math.cos(a), rp.p.yBottom - ad.accessory.drop, rp.p.z + rr * Math.sin(a)),
          kind: 'leg',
          tolerance: ad.accessory.tolerance ?? 12,
          partKey: rp.key,
          stiffScale: 1,
        });
      }
    }
    // 侧面与顶部（用于翻倒检测）
    const top = main.reduce((a, b) => (a.p.yTop > b.p.yTop ? a : b));
    const rTop = Math.max(0.2, top.p.def.diameter / 2);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      cps.push({ pos: new Vector3(rTop * Math.cos(a), maxY, rTop * Math.sin(a)), kind: 'hull', tolerance: top.p.def.impact, partKey: top.key, stiffScale: 1 });
    }
    const midY = (minY + maxY) / 2;
    const midPart = main.find((rp) => rp.p.yBottom <= midY && rp.p.yTop >= midY) ?? main[0];
    const rMid = midPart.p.radius;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      cps.push({ pos: new Vector3(rMid * Math.cos(a), midY, rMid * Math.sin(a)), kind: 'hull', tolerance: midPart.p.def.impact, partKey: midPart.key, stiffScale: 1 });
    }
    this.contacts = cps;
  }

  hasLegs(): boolean {
    return this.contacts.some((c) => c.kind === 'leg');
  }

  /** 着陆腿足垫的当前位置（考虑收放动画）。 */
  contactPos(c: ContactPoint, out: Vector3): Vector3 {
    out.copy(c.pos);
    if (c.kind === 'leg') {
      const rp = this.byKey.get(c.partKey)!;
      const k = this.legDeploy;
      // 收起时足垫贴近箱体并位于零件中部
      const ax = rp.p.x;
      const az = rp.p.z;
      const dx = out.x - ax;
      const dz = out.z - az;
      const dl = Math.hypot(dx, dz);
      const rIn = rp.p.radius + 0.12;
      const rr = rIn + (dl - rIn) * k;
      out.x = ax + (dx / dl) * rr;
      out.z = az + (dz / dl) * rr;
      const yStow = rp.p.yBottom + rp.p.def.height * 0.3;
      out.y = yStow + (c.pos.y - yStow) * k;
    }
    return out;
  }

  // ------------------------------------------------------------ 推进

  pools(): Map<string, RuntimePart[]> {
    const m = new Map<string, RuntimePart[]>();
    for (const rp of this.parts) {
      if (rp.fuelMax <= 0) continue;
      const k = poolKey(rp.p);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(rp);
    }
    return m;
  }

  poolFuel(key: string): number {
    let f = 0;
    for (const rp of this.parts) if (rp.fuelMax > 0 && poolKey(rp.p) === key) f += rp.fuel;
    return f;
  }

  activeEngines(): RuntimePart[] {
    return this.parts.filter((rp) => rp.p.def.engine && rp.ignited && !rp.flameout);
  }

  /** 按当前节流和气压计算各发动机推力与流量；返回总推力 N。 */
  computeThrust(pressureRatio: number, enabled: boolean): number {
    let total = 0;
    for (const rp of this.parts) {
      const e = rp.p.def.engine;
      rp.thrustNow = 0;
      rp.throttleEff = 0;
      if (!e || !rp.ignited || rp.flameout || !enabled || (rp.igniteDelay ?? 0) > 0) continue;
      let thr: number;
      if (!e.throttleable) thr = 1;
      else thr = this.throttle <= 0 ? 0 : e.minThrottle + (1 - e.minThrottle) * this.throttle;
      if (thr <= 0) continue;
      const isp = e.ispVac + (e.ispSL - e.ispVac) * Math.min(1, pressureRatio);
      rp.throttleEff = thr;
      rp.thrustNow = thr * e.thrustVac * (isp / e.ispVac);
      total += rp.thrustNow;
    }
    return total;
  }

  /** 消耗推进剂；返回是否有发动机因燃料耗尽而熄火。 */
  consumeFuel(dt: number): string[] {
    const flameouts: string[] = [];
    const demand = new Map<string, number>();
    for (const rp of this.parts) {
      const e = rp.p.def.engine;
      if (!e || rp.throttleEff <= 0) continue;
      const md = (rp.throttleEff * e.thrustVac) / (e.ispVac * G0);
      const k = enginePoolKey(rp.p);
      demand.set(k, (demand.get(k) ?? 0) + md * dt);
    }
    if (!demand.size) return flameouts;
    const pools = this.pools();
    for (const [k, dm] of demand) {
      const members = pools.get(k);
      const total = members ? members.reduce((s, x) => s + x.fuel, 0) : 0;
      if (!members || total <= 1e-9) continue;
      const take = Math.min(dm, total);
      for (const rp of members) rp.fuel = Math.max(0, rp.fuel - (take * rp.fuel) / total);
    }
    for (const rp of this.parts) {
      const e = rp.p.def.engine;
      if (!e || !rp.ignited || rp.flameout) continue;
      if (this.poolFuel(enginePoolKey(rp.p)) <= 1e-6) {
        rp.flameout = true;
        flameouts.push(rp.key);
      }
    }
    return flameouts;
  }

  /** 把期望的实际推力比例（0..1）换算成油门位置（考虑最小节流）。 */
  setEffectiveThrottle(e: number, allowMin = false): void {
    const eng = this.activeEngines().find((rp) => rp.p.def.engine!.throttleable);
    const minT = eng ? eng.p.def.engine!.minThrottle : 0;
    if (e <= 0) this.throttle = 0;
    else if (e <= minT) this.throttle = allowMin || e > minT * 0.5 ? 0.0001 : 0;
    else this.throttle = Math.min(1, (e - minT) / (1 - minT));
  }

  /** 当前级剩余 Δv（真空），用于 HUD。 */
  stageDeltaV(): number {
    const act = this.activeEngines();
    if (!act.length) return 0;
    let fv = 0;
    let md = 0;
    const keys = new Set<string>();
    for (const e of act) {
      const s = e.p.def.engine!;
      fv += s.thrustVac;
      md += s.thrustVac / (s.ispVac * G0);
      keys.add(enginePoolKey(e.p));
    }
    let fuel = 0;
    for (const k of keys) fuel += this.poolFuel(k);
    const m0 = this.mass;
    const m1 = Math.max(1, m0 - fuel);
    return (fv / md) * Math.log(m0 / m1);
  }

  /** 最大推力（真空，全节流），用于燃烧时间估算。 */
  maxThrustVac(): { thrust: number; mdot: number } {
    let thrust = 0;
    let mdot = 0;
    for (const e of this.activeEngines()) {
      const s = e.p.def.engine!;
      thrust += s.thrustVac;
      mdot += s.thrustVac / (s.ispVac * G0);
    }
    return { thrust, mdot };
  }

  /** 如果当前没有点燃的发动机，预估下一级。 */
  nextStageThrust(): number {
    let t = 0;
    for (const st of this.stages.slice(this.stageIndex)) {
      for (const k of st.ignite) {
        const rp = this.byKey.get(k);
        if (rp?.p.def.engine) t += rp.p.def.engine.thrustVac;
      }
      if (t > 0) break;
    }
    return t;
  }

  /** 最大俯仰/偏航控制力矩（反作用轮 + 发动机矢量 + 尾翼）。 */
  controlTorque(q: number): { pitch: number; roll: number } {
    let gimbal = 0;
    let rollG = 0;
    for (const rp of this.parts) {
      const e = rp.p.def.engine;
      if (!e || rp.thrustNow <= 0) continue;
      const s = Math.sin((e.gimbal * Math.PI) / 180);
      gimbal += rp.thrustNow * s * Math.abs(this.com.y - rp.p.yBottom);
      rollG += rp.thrustNow * s * Math.hypot(rp.p.x, rp.p.z);
    }
    const fin = q * this.aero.finArea * 0.35;
    return {
      pitch: this.torqueWheel + gimbal + fin * Math.abs(this.com.y - this.aero.finY),
      roll: this.torqueWheel * 0.7 + rollG + fin * this.aero.finR,
    };
  }

  totalFuel(): { fuel: number; max: number } {
    let f = 0;
    let m = 0;
    for (const rp of this.parts) {
      f += rp.fuel;
      m += rp.fuelMax;
    }
    return { fuel: f, max: m };
  }

  /** 当前级（点燃的发动机所用燃料池）的燃料比例。 */
  stageFuelFraction(): number {
    const keys = new Set<string>();
    for (const e of this.activeEngines()) keys.add(enginePoolKey(e.p));
    if (!keys.size) {
      const st = this.stages[this.stageIndex];
      if (st) for (const k of st.ignite) {
        const rp = this.byKey.get(k);
        if (rp) keys.add(enginePoolKey(rp.p));
      }
    }
    let f = 0;
    let m = 0;
    for (const rp of this.parts) {
      if (rp.fuelMax > 0 && keys.has(poolKey(rp.p))) {
        f += rp.fuel;
        m += rp.fuelMax;
      }
    }
    return m > 0 ? f / m : 0;
  }

  // ------------------------------------------------------------ 分级

  /** 执行下一级动作，返回被抛离的零件分组（每组生成一个残骸）。 */
  activateStage(): { groups: RuntimePart[][]; action: StagePlan } | null {
    const st = this.stages[this.stageIndex];
    if (!st) return null;
    this.stageIndex++;
    const groups: RuntimePart[][] = [];
    if (st.decoupleSection !== null) {
      const ds = st.decoupleSection;
      const main = this.parts.filter((rp) => rp.p.section === ds && !rp.p.radial);
      if (main.length) groups.push(main);
      // 仍附着在该级上的捆绑组，按副本分组
      const rad = this.parts.filter((rp) => rp.p.section === ds && rp.p.radial);
      groups.push(...groupRadial(rad));
    }
    if (st.jettisonRadial.length) {
      const rad = this.parts.filter((rp) => rp.p.radial && st.jettisonRadial.includes(rp.p.parentUid));
      groups.push(...groupRadial(rad));
    }
    const removed = new Set(groups.flat().map((rp) => rp.key));
    if (removed.size) {
      this.parts = this.parts.filter((rp) => !removed.has(rp.key));
      this.byKey = new Map(this.parts.map((rp) => [rp.key, rp]));
    }
    for (const k of st.ignite) {
      const rp = this.byKey.get(k);
      if (rp) {
        rp.ignited = true;
        rp.flameout = this.poolFuel(enginePoolKey(rp.p)) <= 1e-6;
      }
    }
    if (st.chutes.length && this.chuteState === 'stowed') this.chuteState = 'armed';
    if (removed.size) {
      this.updateMassProps();
      this.computeAero();
      this.computeContacts();
      this.refreshTorque();
    }
    return { groups, action: st };
  }

  refreshTorque(): void {
    this.torqueWheel = 0;
    this.crew = 0;
    for (const rp of this.parts) {
      this.torqueWheel += rp.p.def.torque ?? 0;
      this.crew += rp.p.def.crew ?? 0;
    }
  }

  chutePart(): RuntimePart | undefined {
    return this.parts.find((rp) => rp.p.def.parachute);
  }

  hasPod(): boolean {
    return this.parts.some((rp) => rp.p.def.category === 'pod');
  }

  bounds(): { minY: number; maxY: number; radius: number } {
    let minY = Infinity;
    let maxY = -Infinity;
    let radius = 0;
    for (const rp of this.parts) {
      minY = Math.min(minY, rp.p.yBottom);
      maxY = Math.max(maxY, rp.p.yTop);
      radius = Math.max(radius, Math.hypot(rp.p.x, rp.p.z) + rp.p.radius);
    }
    if (!isFinite(minY)) return { minY: 0, maxY: 1, radius: 1 };
    // 着陆腿
    for (const c of this.contacts) if (c.kind === 'leg') minY = Math.min(minY, c.pos.y);
    return { minY, maxY, radius };
  }
}

function groupRadial(parts: RuntimePart[]): RuntimePart[][] {
  const m = new Map<string, RuntimePart[]>();
  for (const rp of parts) {
    const k = `${rp.p.parentUid}_${rp.p.radialIndex}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(rp);
  }
  return [...m.values()];
}

/** 抛离的残骸：简单刚体（引力 + 阻力 + 撞地销毁）。 */
export class Debris {
  parts: RuntimePart[];
  r = new Vector3();
  v = new Vector3();
  q = new Quaternion();
  w = new Vector3();
  com = new Vector3();
  mass = 0;
  area = 1;
  age = 0;
  alive = true;
  id: number;
  /** stage：级间分离的下面级；booster：捆绑助推器 */
  kind: 'stage' | 'booster' = 'stage';
  /** 分离火箭：剩余工作时间 s、加速度 m/s²、推力方向（残骸船体系） */
  motorT = 0;
  motorAcc = 0;
  motorDir = new Vector3(0, -1, 0);
  /** 在地面上分离（例如月面起飞）时，下面级静止在原地：天体固连坐标与姿态 */
  rest: Body | null = null;
  restPos = new Vector3();
  restQ = new Quaternion();
  static nextId = 1;
  constructor(parts: RuntimePart[]) {
    this.parts = parts;
    this.id = Debris.nextId++;
    let m = 0;
    const c = new Vector3();
    let area = 0;
    for (const rp of parts) {
      const pm = rp.dry + rp.fuel;
      m += pm;
      c.addScaledVector(rp.center, pm);
      area += rp.p.def.height * Math.max(rp.p.def.diameter, rp.p.def.bottomDiameter) * 0.6;
    }
    this.mass = Math.max(1, m);
    this.com.copy(c.divideScalar(Math.max(1, m)));
    this.area = Math.max(0.5, area);
  }
}

export { nodeMasses };
