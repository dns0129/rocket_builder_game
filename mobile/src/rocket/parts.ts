/**
 * 零件目录。数据参考真实火箭（如梅林、RL10、J-2、RS-25、阿波罗登月舱下降发动机），
 * 并按 1:10 地月系统做了适当调整。所有质量单位 kg，推力 N，长度 m。
 */

export type Propellant = 'kerolox' | 'hydrolox' | 'solid';
export type SizeClass = 'S' | 'M' | 'L';
export type PartCategory = 'pod' | 'tank' | 'engine' | 'booster' | 'structure' | 'utility' | 'accessory';

export const PROPELLANTS: Record<'kerolox' | 'hydrolox', { name: string; short: string; density: number; tankDryPerM3: number }> = {
  kerolox: { name: '液氧煤油', short: '煤油', density: 1030, tankDryPerM3: 80 },
  hydrolox: { name: '液氢液氧', short: '氢氧', density: 360, tankDryPerM3: 45 },
};

export const SIZE_DIAMETER: Record<SizeClass, number> = { S: 1.25, M: 2.5, L: 3.75 };

export type PlumeKind = 'kerolox' | 'hydrolox' | 'solid' | 'lander';

export interface EngineSpec {
  thrustVac: number;
  ispVac: number;
  ispSL: number;
  gimbal: number; // 度
  minThrottle: number;
  throttleable: boolean;
  propellant: Propellant;
  bellRadius: number; // 喷管出口半径
  plume: PlumeKind;
  cluster?: number; // 集束发动机数量（仅影响外观）
}

export interface AccessorySpec {
  kind: 'legs' | 'fins';
  reach: number; // 腿：足垫相对零件外壁伸出距离；翼：展长
  drop: number; // 腿：足垫低于零件底部的距离
  stiffness?: number; // 腿：弹簧刚度 N/m
  finArea?: number; // 单片翼面积 m²
  tolerance?: number;
}

export interface PartDef {
  id: string;
  name: string;
  category: PartCategory;
  desc: string;
  size: SizeClass;
  diameter: number; // 顶部连接直径
  bottomDiameter: number; // 底部直径
  height: number;
  dryMass: number;
  tankVolume?: number;
  engine?: EngineSpec;
  solidFuel?: number;
  crew?: number;
  torque?: number;
  decoupler?: boolean;
  heatShield?: boolean;
  parachute?: { cda: number; canopyDiameter: number };
  noseCone?: boolean;
  adapter?: boolean;
  accessory?: AccessorySpec;
  maxTemp: number;
  impact: number;
}

function tankVol(d: number, h: number): number {
  return 0.85 * Math.PI * (d / 2) * (d / 2) * h;
}

function tank(id: string, name: string, size: SizeClass, h: number): PartDef {
  const d = SIZE_DIAMETER[size];
  return {
    id,
    name,
    category: 'tank',
    desc: `容积 ${tankVol(d, h).toFixed(1)} m³，可装液氧煤油或液氢液氧（点击零件后切换）。`,
    size,
    diameter: d,
    bottomDiameter: d,
    height: h,
    dryMass: 0,
    tankVolume: tankVol(d, h),
    maxTemp: 1300,
    impact: 8,
  };
}

export const PARTS: PartDef[] = [
  // ------------------------------------------------------------ 指令舱
  {
    id: 'pod_s',
    name: '曙光-1 单人指令舱',
    category: 'pod',
    desc: '可载 1 名航天员，内置姿态控制系统。返回地球时需要隔热罩与降落伞。',
    size: 'S',
    diameter: 0.6,
    bottomDiameter: 1.25,
    height: 1.35,
    dryMass: 950,
    crew: 1,
    torque: 6000,
    maxTemp: 1400,
    impact: 14,
  },
  {
    id: 'pod_m',
    name: '远航-3 三人指令舱',
    category: 'pod',
    desc: '可载 3 名航天员，姿态控制力矩更大。',
    size: 'M',
    diameter: 1.0,
    bottomDiameter: 2.5,
    height: 2.1,
    dryMass: 3600,
    crew: 3,
    torque: 22000,
    maxTemp: 1600,
    impact: 14,
  },
  {
    id: 'probe_s',
    name: '哨兵 无人探测核心',
    category: 'pod',
    desc: '轻巧的无人控制核心，适合做实验性飞行。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 1.25,
    height: 0.45,
    dryMass: 180,
    torque: 2500,
    maxTemp: 1400,
    impact: 10,
  },
  // ------------------------------------------------------------ 燃料箱
  tank('tank_s1', 'S 型燃料箱·短', 'S', 1.0),
  tank('tank_s2', 'S 型燃料箱·中', 'S', 2.0),
  tank('tank_s4', 'S 型燃料箱·长', 'S', 4.0),
  tank('tank_m1', 'M 型燃料箱·短', 'M', 1.5),
  tank('tank_m2', 'M 型燃料箱·中', 'M', 3.0),
  tank('tank_m4', 'M 型燃料箱·长', 'M', 6.0),
  tank('tank_l2', 'L 型燃料箱·中', 'L', 4.0),
  tank('tank_l4', 'L 型燃料箱·长', 'L', 8.0),
  // ------------------------------------------------------------ 发动机
  {
    id: 'eng_lander',
    name: '萤火 LE-45 着陆发动机',
    category: 'engine',
    desc: '深度节流（10%~100%），推力小而精准，月面着陆首选。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 0.8,
    height: 0.9,
    dryMass: 180,
    engine: { thrustVac: 45_000, ispVac: 315, ispSL: 230, gimbal: 6, minThrottle: 0.1, throttleable: true, propellant: 'kerolox', bellRadius: 0.36, plume: 'lander' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_m_lander',
    name: '萤火-4 集束着陆发动机',
    category: 'engine',
    desc: '四台 LE-45 集束，适合大型着陆器。',
    size: 'M',
    diameter: 2.5,
    bottomDiameter: 2.2,
    height: 1.0,
    dryMass: 800,
    engine: { thrustVac: 180_000, ispVac: 315, ispSL: 230, gimbal: 6, minThrottle: 0.1, throttleable: true, propellant: 'kerolox', bellRadius: 0.36, plume: 'lander', cluster: 4 },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_s_vac',
    name: '雨燕 KV-90 真空发动机',
    category: 'engine',
    desc: '大面积比喷管，真空比冲高，海平面推力损失严重。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 1.1,
    height: 1.5,
    dryMass: 350,
    engine: { thrustVac: 90_000, ispVac: 340, ispSL: 190, gimbal: 4, minThrottle: 0.4, throttleable: true, propellant: 'kerolox', bellRadius: 0.52, plume: 'kerolox' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_s_boost',
    name: '雷霆 K-240 助推发动机',
    category: 'engine',
    desc: '小型一级发动机，海平面性能良好。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 1.0,
    height: 1.4,
    dryMass: 500,
    engine: { thrustVac: 240_000, ispVac: 310, ispSL: 285, gimbal: 5, minThrottle: 0.5, throttleable: true, propellant: 'kerolox', bellRadius: 0.45, plume: 'kerolox' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_m_boost',
    name: '天鹰 K-900 主发动机',
    category: 'engine',
    desc: '主力一级发动机，推重比高。',
    size: 'M',
    diameter: 2.5,
    bottomDiameter: 2.0,
    height: 2.2,
    dryMass: 1200,
    engine: { thrustVac: 900_000, ispVac: 311, ispSL: 282, gimbal: 5, minThrottle: 0.4, throttleable: true, propellant: 'kerolox', bellRadius: 0.9, plume: 'kerolox' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_m_vac',
    name: '天鹰 K-900V 真空版',
    category: 'engine',
    desc: 'K-900 的真空优化型号，用于二级。',
    size: 'M',
    diameter: 2.5,
    bottomDiameter: 2.4,
    height: 3.0,
    dryMass: 1300,
    engine: { thrustVac: 950_000, ispVac: 345, ispSL: 150, gimbal: 4, minThrottle: 0.4, throttleable: true, propellant: 'kerolox', bellRadius: 1.15, plume: 'kerolox' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_l_boost',
    name: '巨神 K-3000 重型发动机',
    category: 'engine',
    desc: '重型运载火箭的心脏。',
    size: 'L',
    diameter: 3.75,
    bottomDiameter: 3.2,
    height: 3.2,
    dryMass: 4000,
    engine: { thrustVac: 3_000_000, ispVac: 312, ispSL: 285, gimbal: 4, minThrottle: 0.5, throttleable: true, propellant: 'kerolox', bellRadius: 1.45, plume: 'kerolox' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_s_hydro',
    name: '星尘 H-110 氢氧真空发动机',
    category: 'engine',
    desc: '液氢液氧，真空比冲高达 455 s，适合奔月转移级。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 1.15,
    height: 1.9,
    dryMass: 300,
    engine: { thrustVac: 110_000, ispVac: 455, ispSL: 180, gimbal: 4, minThrottle: 0.2, throttleable: true, propellant: 'hydrolox', bellRadius: 0.56, plume: 'hydrolox' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_m_hydro',
    name: '极光 H-1000 氢氧上面级发动机',
    category: 'engine',
    desc: '大推力氢氧发动机，二级/三级首选。',
    size: 'M',
    diameter: 2.5,
    bottomDiameter: 2.3,
    height: 3.0,
    dryMass: 1600,
    engine: { thrustVac: 1_000_000, ispVac: 425, ispSL: 280, gimbal: 4, minThrottle: 0.5, throttleable: true, propellant: 'hydrolox', bellRadius: 1.05, plume: 'hydrolox' },
    maxTemp: 1800,
    impact: 7,
  },
  {
    id: 'eng_l_hydro',
    name: '神火 H-2200 氢氧主发动机',
    category: 'engine',
    desc: '高性能氢氧主发动机，海平面比冲 365 s。',
    size: 'L',
    diameter: 3.75,
    bottomDiameter: 3.0,
    height: 4.0,
    dryMass: 3500,
    engine: { thrustVac: 2_200_000, ispVac: 452, ispSL: 365, gimbal: 8, minThrottle: 0.6, throttleable: true, propellant: 'hydrolox', bellRadius: 1.2, plume: 'hydrolox' },
    maxTemp: 1800,
    impact: 7,
  },
  // ------------------------------------------------------------ 固体助推器
  {
    id: 'srb_s',
    name: '烈焰 SRB-S 固体助推器',
    category: 'booster',
    desc: '一旦点燃无法关闭或节流，约燃烧 40 秒。常作为捆绑助推器。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 1.1,
    height: 6.5,
    dryMass: 1100,
    solidFuel: 6900,
    engine: { thrustVac: 400_000, ispVac: 240, ispSL: 215, gimbal: 0, minThrottle: 1, throttleable: false, propellant: 'solid', bellRadius: 0.5, plume: 'solid' },
    maxTemp: 1800,
    impact: 8,
  },
  {
    id: 'srb_m',
    name: '怒火 SRB-M 大型固体助推器',
    category: 'booster',
    desc: '巨大的推力，约燃烧 53 秒。',
    size: 'M',
    diameter: 2.5,
    bottomDiameter: 2.2,
    height: 11,
    dryMass: 4000,
    solidFuel: 31000,
    engine: { thrustVac: 1_500_000, ispVac: 262, ispSL: 230, gimbal: 3, minThrottle: 1, throttleable: false, propellant: 'solid', bellRadius: 1.0, plume: 'solid' },
    maxTemp: 1800,
    impact: 8,
  },
  // ------------------------------------------------------------ 结构
  {
    id: 'dec_s',
    name: 'S 型级间分离器',
    category: 'structure',
    desc: '分离下面级。分离器会与下面级一起被抛弃。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 1.25,
    height: 0.25,
    dryMass: 60,
    decoupler: true,
    maxTemp: 1500,
    impact: 8,
  },
  {
    id: 'dec_m',
    name: 'M 型级间分离器',
    category: 'structure',
    desc: '分离下面级。',
    size: 'M',
    diameter: 2.5,
    bottomDiameter: 2.5,
    height: 0.35,
    dryMass: 180,
    decoupler: true,
    maxTemp: 1500,
    impact: 8,
  },
  {
    id: 'dec_l',
    name: 'L 型级间分离器',
    category: 'structure',
    desc: '分离下面级。',
    size: 'L',
    diameter: 3.75,
    bottomDiameter: 3.75,
    height: 0.45,
    dryMass: 400,
    decoupler: true,
    maxTemp: 1500,
    impact: 8,
  },
  {
    id: 'adapt_ms',
    name: 'M→S 转接段',
    category: 'structure',
    desc: '上端 1.25 m，下端 2.5 m。',
    size: 'M',
    diameter: 1.25,
    bottomDiameter: 2.5,
    height: 1.0,
    dryMass: 220,
    adapter: true,
    maxTemp: 1500,
    impact: 8,
  },
  {
    id: 'adapt_lm',
    name: 'L→M 转接段',
    category: 'structure',
    desc: '上端 2.5 m，下端 3.75 m。',
    size: 'L',
    diameter: 2.5,
    bottomDiameter: 3.75,
    height: 1.4,
    dryMass: 550,
    adapter: true,
    maxTemp: 1500,
    impact: 8,
  },
  {
    id: 'nose_s',
    name: 'S 型整流鼻锥',
    category: 'structure',
    desc: '显著降低气动阻力。',
    size: 'S',
    diameter: 0,
    bottomDiameter: 1.25,
    height: 1.3,
    dryMass: 70,
    noseCone: true,
    maxTemp: 1700,
    impact: 8,
  },
  {
    id: 'nose_m',
    name: 'M 型整流鼻锥',
    category: 'structure',
    desc: '显著降低气动阻力。',
    size: 'M',
    diameter: 0,
    bottomDiameter: 2.5,
    height: 2.4,
    dryMass: 260,
    noseCone: true,
    maxTemp: 1700,
    impact: 8,
  },
  {
    id: 'nose_l',
    name: 'L 型整流鼻锥',
    category: 'structure',
    desc: '显著降低气动阻力。',
    size: 'L',
    diameter: 0,
    bottomDiameter: 3.75,
    height: 3.4,
    dryMass: 600,
    noseCone: true,
    maxTemp: 1700,
    impact: 8,
  },
  // ------------------------------------------------------------ 功能件
  {
    id: 'shield_s',
    name: 'S 型烧蚀隔热罩',
    category: 'utility',
    desc: '装在指令舱底部。以底部朝前再入大气时可承受 3400 K 高温。',
    size: 'S',
    diameter: 1.25,
    bottomDiameter: 1.25,
    height: 0.22,
    dryMass: 220,
    heatShield: true,
    maxTemp: 3400,
    impact: 14,
  },
  {
    id: 'shield_m',
    name: 'M 型烧蚀隔热罩',
    category: 'utility',
    desc: '装在指令舱底部。以底部朝前再入大气时可承受 3400 K 高温。',
    size: 'M',
    diameter: 2.5,
    bottomDiameter: 2.5,
    height: 0.32,
    dryMass: 750,
    heatShield: true,
    maxTemp: 3400,
    impact: 14,
  },
  {
    id: 'chute_s',
    name: 'S 型降落伞',
    category: 'utility',
    desc: '伞径 14 m。启用后先在 7 km 以下张开减速伞，2.5 km 以下且速度低于 90 m/s 时张开主伞。',
    size: 'S',
    diameter: 0.4,
    bottomDiameter: 0.6,
    height: 0.35,
    dryMass: 100,
    parachute: { cda: 1.5 * Math.PI * 7 * 7, canopyDiameter: 14 },
    maxTemp: 1500,
    impact: 12,
  },
  {
    id: 'chute_m',
    name: 'M 型降落伞',
    category: 'utility',
    desc: '伞径 25 m，适合三人舱。',
    size: 'M',
    diameter: 0.7,
    bottomDiameter: 1.0,
    height: 0.5,
    dryMass: 320,
    parachute: { cda: 1.5 * Math.PI * 12.5 * 12.5, canopyDiameter: 25 },
    maxTemp: 1500,
    impact: 12,
  },
  // ------------------------------------------------------------ 附件（环绕安装在选中零件上）
  {
    id: 'legs_s',
    name: 'LT-1 着陆腿',
    category: 'accessory',
    desc: '环绕安装（3 或 4 条）。按 G 收放。可承受 12 m/s 的触地速度。',
    size: 'S',
    diameter: 0,
    bottomDiameter: 0,
    height: 1.6,
    dryMass: 60,
    accessory: { kind: 'legs', reach: 1.0, drop: 1.3, stiffness: 60_000, tolerance: 12 },
    maxTemp: 1400,
    impact: 12,
  },
  {
    id: 'legs_m',
    name: 'LT-2 重型着陆腿',
    category: 'accessory',
    desc: '适合大型着陆器。',
    size: 'M',
    diameter: 0,
    bottomDiameter: 0,
    height: 2.4,
    dryMass: 150,
    accessory: { kind: 'legs', reach: 1.6, drop: 1.6, stiffness: 240_000, tolerance: 12 },
    maxTemp: 1400,
    impact: 12,
  },
  {
    id: 'fins_s',
    name: 'FN-1 尾翼',
    category: 'accessory',
    desc: '环绕安装。把气动压心后移，让火箭在大气中更稳定，并提供气动操控力矩。',
    size: 'S',
    diameter: 0,
    bottomDiameter: 0,
    height: 1.2,
    dryMass: 40,
    accessory: { kind: 'fins', reach: 0.8, drop: 0, finArea: 0.8 },
    maxTemp: 1500,
    impact: 8,
  },
  {
    id: 'fins_m',
    name: 'FN-2 大型尾翼',
    category: 'accessory',
    desc: '大型尾翼，适合 M/L 型火箭。',
    size: 'M',
    diameter: 0,
    bottomDiameter: 0,
    height: 2.2,
    dryMass: 110,
    accessory: { kind: 'fins', reach: 1.5, drop: 0, finArea: 2.2 },
    maxTemp: 1500,
    impact: 8,
  },
];

export const PART_MAP: Record<string, PartDef> = Object.fromEntries(PARTS.map((p) => [p.id, p]));

export function getPart(id: string): PartDef {
  const p = PART_MAP[id];
  if (!p) throw new Error(`未知零件 ${id}`);
  return p;
}

export const CATEGORY_NAMES: Record<PartCategory, string> = {
  pod: '指令舱',
  tank: '燃料箱',
  engine: '液体发动机',
  booster: '固体助推器',
  structure: '结构件',
  utility: '功能件',
  accessory: '环绕附件',
};

/** 燃料箱在指定推进剂下的推进剂质量与干重。 */
export function tankMasses(def: PartDef, prop: 'kerolox' | 'hydrolox'): { fuel: number; dry: number } {
  const v = def.tankVolume ?? 0;
  const P = PROPELLANTS[prop];
  return { fuel: v * P.density, dry: v * P.tankDryPerM3 };
}
