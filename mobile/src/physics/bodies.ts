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

export type BodyId = 'earth' | 'moon';

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
}

const EARTH_R = 637_100;
const EARTH_G = 9.81;
const MOON_R = 173_710;
const MOON_G = 1.625;

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
};

export const MOON_ORBIT = {
  a: MOON_A,
  n: MOON_N,
  period: (2 * Math.PI) / MOON_N,
  phase0: 1.9, // 游戏开始时月球的轨道相位角 (rad)
};

export const BODIES: Body[] = [EARTH, MOON];

const DEG = Math.PI / 180;

/**
 * 发射场：海南文昌（取略靠内陆的位置，保证在 1:10 地球的贴图上落在陆地）。
 * 纬度 19.6°，向正东发射得到约 19.6° 倾角的停泊轨道。
 */
export const LAUNCH_SITE = { name: '文昌航天发射场', lat: 19.6 * DEG, lon: 110.8 * DEG };

/** 经纬度 -> 天体固连系单位向量（经度向东为正，对应 -Z 方向）。 */
export function dirFromLatLon(lat: number, lon: number, out = new Vector3()): Vector3 {
  return out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}

/** t=0 时地球的自转角：让发射场位于惯性系方位角 0 处（太阳位于其东侧，当地为上午）。 */
const EARTH_ROT0 = -LAUNCH_SITE.lon;

/** 太阳方向（惯性系，固定）。发射场在 t=0 时处于上午。 */
export const SUN_DIR = new Vector3(Math.cos(0.75), 0.18, -Math.sin(0.75)).normalize();

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

export function bodyPosition(body: Body, t: number, out = new Vector3()): Vector3 {
  return body.id === 'earth' ? out.set(0, 0, 0) : moonPosition(t, out);
}

export function bodyVelocity(body: Body, t: number, out = new Vector3()): Vector3 {
  return body.id === 'earth' ? out.set(0, 0, 0) : moonVelocity(t, out);
}

/** 天体自转角：天体固连系 -> 惯性系 为绕 Y 轴旋转该角度。 */
export function bodyRotation(body: Body, t: number): number {
  if (body.id === 'earth') return body.rotationRate * t + EARTH_ROT0;
  // 月球 +X 轴始终指向地球
  return moonAngle(t) + Math.PI;
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

/**
 * 以地心为原点的引力加速度（含月球引力与间接项，相当于受限三体问题）。
 */
export function gravityAccel(r: Vector3, t: number, out = new Vector3()): Vector3 {
  const r2 = r.lengthSq();
  const rl = Math.sqrt(r2);
  const kE = -EARTH.mu / (r2 * rl);
  moonPosition(t, _mp);
  const dx = r.x - _mp.x;
  const dy = r.y - _mp.y;
  const dz = r.z - _mp.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const dl = Math.sqrt(d2);
  const kM = -MOON.mu / (d2 * dl);
  const kI = -MOON.mu / (MOON_A * MOON_A * MOON_A);
  out.set(
    kE * r.x + kM * dx + kI * _mp.x,
    kE * r.y + kM * dy + kI * _mp.y,
    kE * r.z + kM * dz + kI * _mp.z,
  );
  return out;
}

/** 当前处于哪个天体的引力影响球（SOI）。 */
export function dominantBody(r: Vector3, t: number): Body {
  moonPosition(t, _mp);
  return r.distanceToSquared(_mp) < MOON.soi * MOON.soi ? MOON : EARTH;
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
