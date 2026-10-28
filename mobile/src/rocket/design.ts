import { getPart, type PartDef, type Propellant, tankMasses } from './parts';

/** 火箭设计：主堆叠（自上而下）+ 每个零件可带环绕附件与捆绑助推器组。 */
export interface PartNode {
  uid: number;
  part: string;
  prop?: 'kerolox' | 'hydrolox';
  acc?: { part: string; count: number };
  radial?: RadialGroup;
}

export interface RadialGroup {
  count: number;
  stack: PartNode[];
}

export interface RocketDesign {
  name: string;
  stack: PartNode[];
}

export const RADIAL_DECOUPLER_MASS = 50;

export interface PlacedPart {
  key: string;
  node: PartNode;
  def: PartDef;
  yBottom: number;
  yTop: number;
  x: number;
  z: number;
  angle: number;
  radial: boolean;
  parentUid: number; // 捆绑组所属的主堆叠零件 uid（主堆叠零件为自身 uid）
  radialIndex: number;
  section: number;
  fuelGroup: string;
  prop: Propellant | null;
  fuelMax: number;
  dryMass: number; // 含附件与捆绑分离器
  radius: number;
}

export interface StagePlan {
  ignite: string[];
  decoupleSection: number | null;
  jettisonRadial: number[];
  chutes: string[];
  label: string;
}

export interface Layout {
  parts: PlacedPart[];
  byKey: Map<string, PlacedPart>;
  sections: number;
  height: number;
  maxRadius: number;
  stages: StagePlan[];
}

function partRadius(def: PartDef): number {
  return Math.max(def.diameter, def.bottomDiameter) / 2;
}

export function nodeMasses(node: PartNode, def: PartDef): { dry: number; fuel: number; prop: Propellant | null } {
  let dry = def.dryMass;
  let fuel = 0;
  let prop: Propellant | null = null;
  if (def.tankVolume) {
    const p = node.prop ?? 'kerolox';
    const m = tankMasses(def, p);
    dry += m.dry;
    fuel = m.fuel;
    prop = p;
  } else if (def.solidFuel) {
    fuel = def.solidFuel;
    prop = 'solid';
  }
  if (node.acc) {
    const a = getPart(node.acc.part);
    dry += a.dryMass * node.acc.count;
  }
  return { dry, fuel, prop };
}

export function layoutDesign(design: RocketDesign): Layout {
  const parts: PlacedPart[] = [];
  const stack = design.stack;
  let y = 0;
  let section = 0;
  const mainPlaced: PlacedPart[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const node = stack[i];
    const def = getPart(node.part);
    const m = nodeMasses(node, def);
    const p: PlacedPart = {
      key: `${node.uid}`,
      node,
      def,
      yBottom: y,
      yTop: y + def.height,
      x: 0,
      z: 0,
      angle: 0,
      radial: false,
      parentUid: node.uid,
      radialIndex: 0,
      section,
      fuelGroup: def.solidFuel ? `b${node.uid}` : `s${section}`,
      prop: m.prop,
      fuelMax: m.fuel,
      dryMass: m.dry,
      radius: partRadius(def),
    };
    y += def.height;
    if (def.decoupler) section++;
    mainPlaced.push(p);
  }
  mainPlaced.reverse();
  parts.push(...mainPlaced);
  const sections = section + 1;
  let maxRadius = 0;
  for (const p of mainPlaced) maxRadius = Math.max(maxRadius, p.radius);

  // 捆绑助推器组
  for (const mp of mainPlaced) {
    const g = mp.node.radial;
    if (!g || g.stack.length === 0 || g.count < 1) continue;
    const secBottom = Math.min(...mainPlaced.filter((q) => q.section === mp.section).map((q) => q.yBottom));
    const gr = Math.max(...g.stack.map((n) => partRadius(getPart(n.part))));
    const dist = mp.radius + gr + 0.08;
    for (let k = 0; k < g.count; k++) {
      const angle = (2 * Math.PI * k) / g.count;
      let gy = secBottom;
      const copy: PlacedPart[] = [];
      for (let i = g.stack.length - 1; i >= 0; i--) {
        const node = g.stack[i];
        const def = getPart(node.part);
        const m = nodeMasses(node, def);
        const p: PlacedPart = {
          key: `${node.uid}_${k}`,
          node,
          def,
          yBottom: gy,
          yTop: gy + def.height,
          x: dist * Math.cos(angle),
          z: dist * Math.sin(angle),
          angle,
          radial: true,
          parentUid: mp.node.uid,
          radialIndex: k,
          section: mp.section,
          fuelGroup: def.solidFuel ? `b${node.uid}_${k}` : `r${mp.node.uid}_${k}`,
          prop: m.prop,
          fuelMax: m.fuel,
          dryMass: m.dry,
          radius: partRadius(def),
        };
        gy += def.height;
        copy.push(p);
      }
      // 捆绑分离器质量计入该组最上方零件
      copy[copy.length - 1].dryMass += RADIAL_DECOUPLER_MASS;
      parts.push(...copy.reverse());
      maxRadius = Math.max(maxRadius, dist + gr);
    }
  }

  const byKey = new Map(parts.map((p) => [p.key, p]));
  const height = mainPlaced.length ? mainPlaced[0].yTop : 0;
  const layout: Layout = { parts, byKey, sections, height, maxRadius, stages: [] };
  layout.stages = buildStages(layout);
  return layout;
}

function buildStages(layout: Layout): StagePlan[] {
  const stages: StagePlan[] = [];
  for (let s = 0; s < layout.sections; s++) {
    const inSec = layout.parts.filter((p) => p.section === s);
    const engines = inSec.filter((p) => p.def.engine).map((p) => p.key);
    const radialParents = [...new Set(inSec.filter((p) => p.radial).map((p) => p.parentUid))];
    if (s === 0) {
      if (engines.length) stages.push({ ignite: engines, decoupleSection: null, jettisonRadial: [], chutes: [], label: '点火' });
    } else {
      stages.push({
        ignite: engines,
        decoupleSection: s - 1,
        jettisonRadial: [],
        chutes: [],
        label: engines.length ? '分离 + 点火' : '分离',
      });
    }
    if (radialParents.length) {
      stages.push({ ignite: [], decoupleSection: null, jettisonRadial: radialParents, chutes: [], label: '抛离助推器' });
    }
  }
  const chutes = layout.parts.filter((p) => p.def.parachute).map((p) => p.key);
  if (chutes.length) stages.push({ ignite: [], decoupleSection: null, jettisonRadial: [], chutes, label: '启用降落伞' });
  return stages;
}

// ------------------------------------------------------------------ 设计工具

export function maxUid(design: RocketDesign): number {
  let m = 0;
  const visit = (nodes: PartNode[]) => {
    for (const n of nodes) {
      m = Math.max(m, n.uid);
      if (n.radial) visit(n.radial.stack);
    }
  };
  visit(design.stack);
  return m;
}

export function cloneDesign(d: RocketDesign): RocketDesign {
  return JSON.parse(JSON.stringify(d));
}

/** 根据简洁描述构造设计（自动分配 uid）。 */
type NodeSpec = string | { part: string; prop?: 'kerolox' | 'hydrolox'; acc?: [string, number]; radial?: { count: number; stack: NodeSpec[] } };

function buildDesign(name: string, specs: NodeSpec[]): RocketDesign {
  let uid = 1;
  const make = (s: NodeSpec): PartNode => {
    if (typeof s === 'string') return { uid: uid++, part: s };
    const n: PartNode = { uid: uid++, part: s.part };
    if (s.prop) n.prop = s.prop;
    if (s.acc) n.acc = { part: s.acc[0], count: s.acc[1] };
    if (s.radial) n.radial = { count: s.radial.count, stack: s.radial.stack.map(make) };
    return n;
  };
  return { name, stack: specs.map(make) };
}

export const TEMPLATES: { id: string; desc: string; design: RocketDesign }[] = [
  {
    id: 'sounding',
    desc: '单级探空火箭：适合熟悉操作，能轻松飞出大气层（70 km），技术好甚至能入轨。',
    design: buildDesign('小白鼠 探空火箭', [
      'chute_s',
      'pod_s',
      'shield_s',
      'dec_s',
      { part: 'tank_s4', acc: ['fins_s', 4] },
      'eng_s_boost',
    ]),
  },
  {
    id: 'orbiter',
    desc: '两级入轨火箭：第一级送出大气，第二级完成入轨与离轨。',
    design: buildDesign('先锋 轨道火箭', [
      'chute_s',
      'pod_s',
      'shield_s',
      'dec_s',
      'tank_s2',
      'eng_s_vac',
      'dec_s',
      'tank_s4',
      { part: 'tank_s4', acc: ['fins_s', 4] },
      'eng_s_boost',
    ]),
  },
  {
    id: 'lunar',
    desc: '三级登月火箭：一级入轨，氢氧二级奔月，着陆级完成月球捕获、着陆、起飞与返回。',
    design: buildDesign('登月者 L-1', [
      'chute_s',
      'pod_s',
      'shield_s',
      'dec_s',
      { part: 'tank_s2', acc: ['legs_s', 4] },
      'eng_lander',
      'dec_s',
      { part: 'tank_s4', prop: 'hydrolox' },
      'eng_s_hydro',
      'dec_s',
      'adapt_ms',
      { part: 'tank_m4', acc: ['fins_m', 4] },
      'eng_m_boost',
    ]),
  },
  {
    id: 'heavy',
    desc: '重型运载：L 型芯级 + 两枚大型固体助推器，三人舱登月，Δv 极为充裕。',
    design: buildDesign('巨神 重型运载', [
      'chute_m',
      'pod_m',
      'shield_m',
      'dec_m',
      { part: 'tank_m2', acc: ['legs_m', 4] },
      'eng_m_lander',
      'dec_m',
      { part: 'tank_m4', prop: 'hydrolox' },
      'eng_m_hydro',
      'dec_m',
      'adapt_lm',
      {
        part: 'tank_l4',
        acc: ['fins_m', 4],
        radial: { count: 2, stack: ['nose_m', 'srb_m'] },
      },
      'eng_l_boost',
    ]),
  },
  {
    id: 'lander',
    desc: '仅着陆器 + 指令舱。选择“环月轨道起步”即可直接练习月面着陆。',
    design: buildDesign('月面着陆器 练习型', [
      'chute_s',
      'pod_s',
      'shield_s',
      'dec_s',
      { part: 'tank_s2', acc: ['legs_s', 4] },
      'eng_lander',
    ]),
  },
];

export function templateDesign(id: string): RocketDesign {
  const t = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0];
  return cloneDesign(t.design);
}
