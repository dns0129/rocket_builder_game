import { Vector3 } from 'three';

/**
 * 天体与环境常量。
 *
 * 平衡说明：采用真实物理定律（牛顿引力、齐奥尔科夫斯基方程、指数大气、比冲随气压变化），
 * 但把地月系统按 1:10 缩小（类似《坎巴拉太空计划》的做法），这样入轨只需约 3.4 km/s，
 * 登月往返总计约 6.5 km/s，一枚几十吨的火箭就能完成完整的登月任务。
 * 表面重力保持真实值（地球 9.81、月球 1.62 m/s²），时间尺度相应缩放为 1/√10，
 * 因而轨道周期、自转周期之间的比例关系与真实地月系统一致。
 */

export const G0 = 9.80665; // 标准重力加速度，用于比冲换算
export const SIM_SCALE = 10;
export const TIME_SCALE = Math.sqrt(SIM_SCALE);

export interface AtmosphereDef {
  height: number; // 大气顶端高度 m
  scaleHeight: number; // 标高 m
  rho0: number; // 海平面密度 kg/m³
  p0: number; // 海平面气压 Pa
}

export type BodyId = 'sun' | 'mercury' | 'venus' | 'earth' | 'moon' | 'mars' | 'jupiter' | 'saturn';
/** star = 恒星，rocky = 岩质（可着陆），gas = 气态巨行星（没有固体表面） */
export type BodyKind = 'star' | 'rocky' | 'gas';

export interface Body {
  id: BodyId;
  name: string;
  radius: number;
  mu: number;
  surfaceGravity: number;
  rotationRate: number; // rad/s，绕 +Y 轴
  atmosphere: AtmosphereDef | null;
  soi: number;
  hasOcean: boolean;
  maxTerrain: number; // 地形最高点（相对基准半径）
  kind: BodyKind;
  /** 绕行的天体（太阳为 null） */
  parent: BodyId | null;
  /** 拱点名称用字：近“地”点、近“月”点、近“火”点…… */
  apsisChar: string;
  /** 地图与远景光点的颜色 */
  color: number;
}

const EARTH_R = 637_100;
const EARTH_G = 9.81;
const MOON_R = 173_710;
const MOON_G = 1.625;
/** 1 天文单位（已按 1:10 缩小） */
export const AU = 1.495_978_707e11 / SIM_SCALE;
/** 真实引力参数 GM 按 1:10 缩放：半径 /10、表面重力不变 → μ /100 */
const MU_SCALE = 1 / (SIM_SCALE * SIM_SCALE);
const SUN_MU = 1.327_124e20 * MU_SCALE;

function rocky(id: BodyId, name: string, radiusKm: number, gmReal: number, rotDaysSidereal: number, apsisChar: string, color: number, extra: Partial<Body> = {}): Body {
  const radius = (radiusKm * 1000) / SIM_SCALE;
  const mu = gmReal * MU_SCALE;
  return {
    id,
    name,
    radius,
    mu,
    surfaceGravity: mu / (radius * radius),
    rotationRate: rotDaysSidereal === 0 ? 0 : (2 * Math.PI) / ((rotDaysSidereal * 86_400) / TIME_SCALE),
    atmosphere: null,
    soi: Infinity,
    hasOcean: false,
    maxTerrain: 0,
    kind: 'rocky',
    parent: 'sun',
    apsisChar,
    color,
    ...extra,
  };
}

export const SUN: Body = {
  ...rocky('sun', '太阳', 695_700, 1.327_124e20, 25.38, '日', 0xffd27a),
  kind: 'star',
  parent: null,
};

export const EARTH: Body = {
  id: 'earth',
  name: '地球',
  radius: EARTH_R,
  mu: EARTH_G * EARTH_R * EARTH_R,
  surfaceGravity: EARTH_G,
  rotationRate: (2 * Math.PI) / (86_164.1 / TIME_SCALE),
  atmosphere: { height: 70_000, scaleHeight: 7_000, rho0: 1.225, p0: 101_325 },
  soi: Infinity,
  hasOcean: true,
  maxTerrain: 0,
  kind: 'rocky',
  parent: 'sun',
  apsisChar: '地',
  color: 0x6fb8ff,
};

const MOON_A = 38_440_000;
const MOON_MU = MOON_G * MOON_R * MOON_R;
const MOON_N = Math.sqrt((EARTH.mu + MOON_MU) / MOON_A ** 3);

export const MOON: Body = {
  id: 'moon',
  name: '月球',
  radius: MOON_R,
  mu: MOON_MU,
  surfaceGravity: MOON_G,
  rotationRate: MOON_N, // 潮汐锁定
  atmosphere: null,
  soi: MOON_A * Math.pow(MOON_MU / EARTH.mu, 0.4),
  hasOcean: false,
  maxTerrain: 6_000,
  kind: 'rocky',
  parent: 'earth',
  apsisChar: '月',
  color: 0xc8c8c8,
};

export const MERCURY = rocky('mercury', '水星', 2_439.7, 2.2032e13, 58.646, '水', 0xb4aca2, { maxTerrain: 5_500 });
export const VENUS = rocky('venus', '金星', 6_051.8, 3.248_59e14, -243.025, '金', 0xe9d4a2, {
  // 浓密的二氧化碳大气（为了可玩性比真实稀薄一些）
  atmosphere: { height: 100_000, scaleHeight: 9_000, rho0: 25, p0: 4_500_000 },
  maxTerrain: 4_500,
});
export const MARS = rocky('mars', '火星', 3_389.5, 4.282_837e13, 1.025_957, '火', 0xd0643c, {
  // 稀薄的大气（比真实略厚，降落伞能起一点作用）
  atmosphere: { height: 50_000, scaleHeight: 9_000, rho0: 0.05, p0: 1_500 },
  maxTerrain: 7_500,
});
export const JUPITER = rocky('jupiter', '木星', 69_911, 1.266_865e17, 0.413_54, '木', 0xd8b48e, {
  kind: 'gas',
  atmosphere: { height: 300_000, scaleHeight: 27_000, rho0: 0.16, p0: 100_000 },
});
export const SATURN = rocky('saturn', '土星', 58_232, 3.793_119e16, 0.444, '土', 0xe6d29c, {
  kind: 'gas',
  atmosphere: { height: 300_000, scaleHeight: 30_000, rho0: 0.19, p0: 140_000 },
});

/** 行星绕太阳的圆轨道（黄道面取 XZ 平面，与地球赤道面重合）。 */
export interface HelioOrbit {
  a: number;
  n: number;
  phase0: number;
  period: number;
}

const DEG = Math.PI / 180;
/** t=0 时地球的日心经度：让太阳位于发射场东侧（当地为上午） */
const EARTH_PHASE0 = Math.PI + 0.75;

function helioOrbit(body: Body, aAu: number, phaseFromEarthDeg: number): HelioOrbit {
  const a = aAu * AU;
  const n = Math.sqrt((SUN_MU + body.mu) / (a * a * a));
  return { a, n, phase0: EARTH_PHASE0 + phaseFromEarthDeg * DEG, period: (2 * Math.PI) / n };
}

/**
 * 各行星的初始相位不是真实星历，而是让每个行星的霍曼转移窗口都在开局后两周左右（游戏时间）出现，
 * 不用等上一年半载。
 */
export const HELIO: Partial<Record<BodyId, HelioOrbit>> = {
  mercury: helioOrbit(MERCURY, 0.3871, 79),
  venus: helioOrbit(VENUS, 0.7233, -74),
  earth: helioOrbit(EARTH, 1, 0),
  mars: helioOrbit(MARS, 1.5237, 64),
  jupiter: helioOrbit(JUPITER, 5.2038, 117),
  saturn: helioOrbit(SATURN, 9.537, 126),
};

// 引力影响球（拉普拉斯半径）
for (const b of [MERCURY, VENUS, EARTH, MARS, JUPITER, SATURN]) b.soi = HELIO[b.id]!.a * Math.pow(b.mu / SUN_MU, 0.4);

export const MOON_ORBIT = {
  a: MOON_A,
  n: MOON_N,
  period: (2 * Math.PI) / MOON_N,
  phase0: 1.9, // 游戏开始时月球的轨道相位角 (rad)
};

/** 所有天体（太阳、行星由内到外，月球紧跟地球）。 */
export const BODIES: Body[] = [SUN, MERCURY, VENUS, EARTH, MOON, MARS, JUPITER, SATURN];
export const BODY_BY_ID = Object.fromEntries(BODIES.map((b) => [b.id, b])) as Record<BodyId, Body>;
/** 绕太阳运行、拥有自己影响球的行星（不含地球，地球是模拟坐标系的原点）。 */
const OTHER_PLANETS: Body[] = [MERCURY, VENUS, MARS, JUPITER, SATURN];

/**
 * 发射场：海南文昌（取略靠内陆的位置，保证在 1:10 地球的贴图上落在陆地）。
 * 纬度 19.6°，向正东发射得到约 19.6° 倾角的停泊轨道。
 */
export const LAUNCH_SITE = { name: '文昌航天发射场', lat: 19.6 * DEG, lon: 110.8 * DEG };

/** 经纬度 -> 天体固连系单位向量（经度向东为正，对应 -Z 方向）。 */
export function dirFromLatLon(lat: number, lon: number, out = new Vector3()): Vector3 {
  return out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}

/** t=0 时地球的自转角：让发射场位于惯性系方位角 0 处。 */
const EARTH_ROT0 = -LAUNCH_SITE.lon;

export function moonAngle(t: number): number {
  return MOON_ORBIT.phase0 + MOON_ORBIT.n * t;
}

export function moonPosition(t: number, out = new Vector3()): Vector3 {
  const th = moonAngle(t);
  return out.set(MOON_A * Math.cos(th), 0, -MOON_A * Math.sin(th));
}

export function moonVelocity(t: number, out = new Vector3()): Vector3 {
  const th = moonAngle(t);
  const s = MOON_A * MOON_ORBIT.n;
  return out.set(-s * Math.sin(th), 0, -s * Math.cos(th));
}

/** 行星相对太阳的位置（日心惯性系）。 */
export function helioPosition(body: Body, t: number, out = new Vector3()): Vector3 {
  const o = HELIO[body.id];
  if (!o) return out.set(0, 0, 0);
  const th = o.phase0 + o.n * t;
  return out.set(o.a * Math.cos(th), 0, -o.a * Math.sin(th));
}

export function helioVelocity(body: Body, t: number, out = new Vector3()): Vector3 {
  const o = HELIO[body.id];
  if (!o) return out.set(0, 0, 0);
  const th = o.phase0 + o.n * t;
  const s = o.a * o.n;
  return out.set(-s * Math.sin(th), 0, -s * Math.cos(th));
}

const _eh = new Vector3();

/**
 * 天体位置。模拟采用地心坐标系（地球始终在原点，坐标轴不转），
 * 太阳与其他行星都在这个坐标系中运动；引力计算中加入相应的间接项。
 */
export function bodyPosition(body: Body, t: number, out = new Vector3()): Vector3 {
  switch (body.id) {
    case 'earth':
      return out.set(0, 0, 0);
    case 'moon':
      return moonPosition(t, out);
    case 'sun':
      return helioPosition(EARTH, t, out).negate();
    default:
      helioPosition(EARTH, t, _eh);
      return helioPosition(body, t, out).sub(_eh);
  }
}

export function bodyVelocity(body: Body, t: number, out = new Vector3()): Vector3 {
  switch (body.id) {
    case 'earth':
      return out.set(0, 0, 0);
    case 'moon':
      return moonVelocity(t, out);
    case 'sun':
      return helioVelocity(EARTH, t, out).negate();
    default:
      helioVelocity(EARTH, t, _eh);
      return helioVelocity(body, t, out).sub(_eh);
  }
}

/** 天体相对其母天体的位置（月球相对地球、行星相对太阳）。 */
export function positionInParent(body: Body, t: number, out = new Vector3()): Vector3 {
  if (body.id === 'moon') return moonPosition(t, out);
  return helioPosition(body, t, out);
}

/** 从某点看太阳的方向（单位向量）。 */
export function sunDirection(from: Vector3, t: number, out = new Vector3()): Vector3 {
  return bodyPosition(SUN, t, out).sub(from).normalize();
}

/** 天体自转角：天体固连系 -> 惯性系 为绕 Y 轴旋转该角度。 */
export function bodyRotation(body: Body, t: number): number {
  if (body.id === 'earth') return body.rotationRate * t + EARTH_ROT0;
  // 月球 +X 轴始终指向地球
  if (body.id === 'moon') return moonAngle(t) + Math.PI;
  return body.rotationRate * t;
}

/** 绕 Y 轴旋转（与 THREE 的 makeRotationY 一致）。 */
export function rotateY(v: Vector3, angle: number, out = new Vector3()): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = v.x * c + v.z * s;
  const z = -v.x * s + v.z * c;
  return out.set(x, v.y, z);
}

/** 惯性系位置 -> 天体固连系（相对天体中心）。 */
export function toBodyFixed(body: Body, t: number, rInertial: Vector3, out = new Vector3()): Vector3 {
  const c = bodyPosition(body, t, _tmpA);
  out.subVectors(rInertial, c);
  return rotateY(out, -bodyRotation(body, t), out);
}

/** 天体固连系 -> 惯性系。 */
export function fromBodyFixed(body: Body, t: number, rFixed: Vector3, out = new Vector3()): Vector3 {
  rotateY(rFixed, bodyRotation(body, t), out);
  return out.add(bodyPosition(body, t, _tmpA));
}

/** 天体表面随自转的速度（惯性系）：v_body + ω × (r - c)。 */
export function surfaceVelocity(body: Body, t: number, rInertial: Vector3, out = new Vector3()): Vector3 {
  const c = bodyPosition(body, t, _tmpA);
  const w = body.rotationRate;
  const rx = rInertial.x - c.x;
  const rz = rInertial.z - c.z;
  bodyVelocity(body, t, out);
  out.x += w * rz;
  out.z += -w * rx;
  return out;
}

const _tmpA = new Vector3();
const _mp = new Vector3();
const _bp = new Vector3();

/** 天体 b 对位于 r 的飞船的直接引力 + 间接项（地球本身受 b 吸引的加速度要减掉）。 */
function addBodyGravity(r: Vector3, b: Vector3, mu: number, out: Vector3): void {
  const dx = r.x - b.x;
  const dy = r.y - b.y;
  const dz = r.z - b.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const k = -mu / (d2 * Math.sqrt(d2));
  const b2 = b.x * b.x + b.y * b.y + b.z * b.z;
  const kI = -mu / (b2 * Math.sqrt(b2));
  out.x += k * dx + kI * b.x;
  out.y += k * dy + kI * b.y;
  out.z += k * dz + kI * b.z;
}

/**
 * 地心坐标系中的引力加速度：地球 + 月球 + 太阳 + 其他行星（含间接项），
 * 即以地球为参考点的受限多体问题。
 */
export function gravityAccel(r: Vector3, t: number, out = new Vector3()): Vector3 {
  const r2 = r.lengthSq();
  const kE = -EARTH.mu / (r2 * Math.sqrt(r2));
  out.set(kE * r.x, kE * r.y, kE * r.z);
  addBodyGravity(r, moonPosition(t, _mp), MOON.mu, out);
  addBodyGravity(r, bodyPosition(SUN, t, _bp), SUN.mu, out);
  for (const p of OTHER_PLANETS) addBodyGravity(r, bodyPosition(p, t, _bp), p.mu, out);
  return out;
}

/** 当前处于哪个天体的引力影响球（SOI）：太阳 > 行星 > 月球。 */
export function dominantBody(r: Vector3, t: number): Body {
  if (r.lengthSq() < EARTH.soi * EARTH.soi) {
    moonPosition(t, _mp);
    return r.distanceToSquared(_mp) < MOON.soi * MOON.soi ? MOON : EARTH;
  }
  for (const p of OTHER_PLANETS) {
    if (r.distanceToSquared(bodyPosition(p, t, _bp)) < p.soi * p.soi) return p;
  }
  return SUN;
}

/** 某天体影响球之下的天体（地球之下是月球，太阳之下是各行星）。 */
export function childrenOf(body: Body): Body[] {
  return BODIES.filter((b) => b.parent === body.id);
}

// ---------------------------------------------------------------- 大气

export function atmoDensity(body: Body, alt: number): number {
  const a = body.atmosphere;
  if (!a || alt >= a.height) return 0;
  const h = Math.max(alt, -500);
  // 在大气顶端平滑归零，避免数值突变
  const fade = Math.min(1, (a.height - h) / 3000);
  return a.rho0 * Math.exp(-h / a.scaleHeight) * fade;
}

export function atmoPressure(body: Body, alt: number): number {
  const a = body.atmosphere;
  if (!a || alt >= a.height) return 0;
  const h = Math.max(alt, -500);
  const fade = Math.min(1, (a.height - h) / 3000);
  return a.p0 * Math.exp(-h / a.scaleHeight) * fade;
}

/** 近似标准大气温度 (K)。 */
export function atmoTemperature(alt: number): number {
  if (alt < 11_000) return 288.15 - 0.0065 * alt;
  if (alt < 20_000) return 216.65;
  if (alt < 47_000) return 216.65 + 0.0028 * (alt - 20_000);
  return Math.max(190, 292 - 0.0025 * (alt - 47_000));
}

export function speedOfSound(alt: number): number {
  return Math.sqrt(1.4 * 287.05 * atmoTemperature(alt));
}

/** 跨音速阻力激增系数。 */
export function machDragFactor(mach: number): number {
  if (mach < 0.75) return 1;
  if (mach < 1.1) {
    const k = (mach - 0.75) / 0.35;
    return 1 + 1.1 * k * k * (3 - 2 * k);
  }
  if (mach < 5) return 1 + 1.1 * Math.exp(-(mach - 1.1) * 0.55);
  return 1.13;
}
