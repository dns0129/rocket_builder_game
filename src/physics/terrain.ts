import { Vector3 } from 'three';
import { EARTH, MARS, MERCURY, MOON, VENUS, type Body, type BodyId, dirFromLatLon } from './bodies';
import { gnoise, hash3, hashToFloat, nextHash, NOISE_OFFSET, NOISE_GLSL } from './noise';

/**
 * 岩质天体地形：低频丘陵 + 低地（月海 / 火星北部低地）+ 十个尺度层级的撞击坑（半径 20 km 到 5 m）
 * + 可选的盾状火山。每个撞击坑层级把空间划分为三维网格，每个格子中至多一个撞击坑，只需检查最近的 2×2×2 个格子。
 * 月球、水星、金星、火星使用同一套函数、不同参数；CPU（碰撞）与 GPU（贴图）结果一致。
 */

export const CRATER_RMAX = [20000, 8000, 3200, 1300, 520, 210, 85, 34, 14, 5.5];
export const CRATER_PROB = [0.35, 0.42, 0.5, 0.55, 0.55, 0.6, 0.6, 0.62, 0.62, 0.62];
export const CRATER_CELL_K = 2.3;

export interface RockyTerrainDef {
  craterSeed: number;
  hillSeed: number;
  mareSeed: number;
  /** 低地（月海）噪声的特征尺度 m */
  mareScale: number;
  /** 低地遮罩的强度（0..1） */
  mareAmount: number;
  /** 低地下沉深度 m */
  mareDepth: number;
  hillWl: number;
  hillAmp: number;
  /** 撞击坑出现概率的倍数 */
  craterProb: number;
  /** 撞击坑层级数（浓密大气会烧掉小陨石，金星只有大坑） */
  craterLevels: number;
  /** 盾状火山（带破火山口） */
  volcanoes?: VolcanoDef[];
  /** 峡谷：沿大圆弧的长条凹陷，平底、陡壁、边缘参差 */
  canyons?: CanyonDef[];
}

export interface VolcanoDef {
  lat: number;
  lon: number;
  height: number;
  radius: number;
}

export interface CanyonDef {
  lat0: number;
  lon0: number;
  lat1: number;
  lon1: number;
  /** 半宽 m */
  halfWidth: number;
  depth: number;
  seed: number;
}

const DEG = Math.PI / 180;

export const TERRAIN: Partial<Record<BodyId, RockyTerrainDef>> = {
  moon: { craterSeed: 7331, hillSeed: 1201, mareSeed: 911, mareScale: 150_000, mareAmount: 1, mareDepth: 900, hillWl: 50_000, hillAmp: 1300, craterProb: 1, craterLevels: 10 },
  mercury: { craterSeed: 1307, hillSeed: 2203, mareSeed: 1913, mareScale: 200_000, mareAmount: 0.5, mareDepth: 400, hillWl: 40_000, hillAmp: 900, craterProb: 1.15, craterLevels: 10 },
  venus: { craterSeed: 4409, hillSeed: 3301, mareSeed: 2917, mareScale: 300_000, mareAmount: 0.7, mareDepth: 900, hillWl: 90_000, hillAmp: 1400, craterProb: 0.12, craterLevels: 3 },
  mars: {
    craterSeed: 5519,
    hillSeed: 4421,
    mareSeed: 3907,
    mareScale: 600_000,
    mareAmount: 1,
    mareDepth: 1800,
    hillWl: 80_000,
    hillAmp: 2000,
    craterProb: 0.45,
    craterLevels: 9,
    // 奥林帕斯山与塔尔西斯三火山（阿尔西亚、帕弗尼斯、艾斯克雷尔斯），均按 1:10 缩小
    volcanoes: [
      { lat: 18.65 * DEG, lon: -133.8 * DEG, height: 2200, radius: 30_000 },
      { lat: -8.26 * DEG, lon: -120.09 * DEG, height: 1600, radius: 21_000 },
      { lat: 1.48 * DEG, lon: -112.96 * DEG, height: 1300, radius: 18_000 },
      { lat: 11.92 * DEG, lon: -104.08 * DEG, height: 1700, radius: 22_000 },
    ],
    // 水手号峡谷：主峡谷与北侧一条较窄的平行峡谷
    canyons: [
      { lat0: -7 * DEG, lon0: -96 * DEG, lat1: -12 * DEG, lon1: -42 * DEG, halfWidth: 9_000, depth: 700, seed: 3911 },
      { lat0: -4.5 * DEG, lon0: -88 * DEG, lat1: -7.5 * DEG, lon1: -64 * DEG, halfWidth: 4_500, depth: 450, seed: 3923 },
    ],
  },
};

const BODY_R: Partial<Record<BodyId, number>> = { moon: MOON.radius, mercury: MERCURY.radius, venus: VENUS.radius, mars: MARS.radius };

function smoothMax(a: number, b: number, k: number): number {
  const d = a - b;
  return 0.5 * (a + b + Math.sqrt(d * d + k * k));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function craterProfile(x: number, r: number): number {
  if (x >= 1.6) return 0;
  const dr = r < 750 ? 0.38 : 0.38 * Math.pow(750 / r, 0.45);
  const depth = dr * r;
  const rimH = depth * 0.28;
  if (x < 1) {
    let h = (x * x - 1) * depth + rimH * x * x * x * x;
    if (r > 1500) h = smoothMax(h, -depth * 0.72, depth * 0.12);
    return h;
  }
  const t = (x - 1) / 0.6;
  return rimH * (1 - t) * (1 - t);
}

/** 单个尺度层级的撞击坑高度贡献（P 为天体中心坐标，单位 m）。 */
export function craterLevel(px: number, py: number, pz: number, level: number, craterSeed = 7331, probScale = 1): number {
  const rmax = CRATER_RMAX[level];
  const cell = rmax * CRATER_CELL_K;
  const prob = CRATER_PROB[level] * probScale;
  const gx = px / cell - 0.5;
  const gy = py / cell - 0.5;
  const gz = pz / cell - 0.5;
  const bx = Math.floor(gx);
  const by = Math.floor(gy);
  const bz = Math.floor(gz);
  const seed = (craterSeed + level * 101) >>> 0;
  let sum = 0;
  for (let k = 0; k < 8; k++) {
    const cx = bx + (k & 1);
    const cy = by + ((k >> 1) & 1);
    const cz = bz + ((k >> 2) & 1);
    let h = hash3(cx + NOISE_OFFSET, cy + NOISE_OFFSET, cz + NOISE_OFFSET, seed);
    if (hashToFloat(h) >= prob) continue;
    h = nextHash(h);
    const rr = hashToFloat(h);
    const r = rmax * (0.35 + 0.65 * rr * rr);
    h = nextHash(h);
    const ox = (cx + 0.25 + 0.5 * hashToFloat(h)) * cell;
    h = nextHash(h);
    const oy = (cy + 0.25 + 0.5 * hashToFloat(h)) * cell;
    h = nextHash(h);
    const oz = (cz + 0.25 + 0.5 * hashToFloat(h)) * cell;
    const dx = px - ox;
    const dy = py - oy;
    const dz = pz - oz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const lim = 1.6 * r;
    if (d2 >= lim * lim) continue;
    sum += craterProfile(Math.sqrt(d2) / r, r);
  }
  return sum;
}

/** 低地遮罩（0 = 高地，1 = 月海 / 低地）。 */
export function mareMask(T: RockyTerrainDef, R: number, dx: number, dy: number, dz: number): number {
  const s = R / T.mareScale;
  const n = gnoise(dx * s, dy * s, dz * s, T.mareSeed) + 0.5 * gnoise(dx * s * 2.1, dy * s * 2.1, dz * s * 2.1, T.mareSeed + 1);
  return T.mareAmount * smoothstep(0.12, -0.12, n + 0.42);
}

const _vd = new Vector3();

/** 盾状火山（带破火山口）的高度。 */
function volcanoHeight(v: VolcanoDef, R: number, dx: number, dy: number, dz: number): number {
  dirFromLatLon(v.lat, v.lon, _vd);
  const ang = Math.acos(Math.max(-1, Math.min(1, dx * _vd.x + dy * _vd.y + dz * _vd.z)));
  const x = (ang * R) / v.radius;
  if (x > 4) return 0;
  return v.height * (Math.exp(-x * x) - 0.22 * Math.exp(-x * x * 40));
}

/** 峡谷的几何：两端点 A、B、大圆的法向 N、弧长对应的角度 */
interface CanyonGeom {
  a: Vector3;
  b: Vector3;
  n: Vector3;
  span: number;
}
const canyonCache = new WeakMap<CanyonDef, CanyonGeom>();
function canyonGeom(c: CanyonDef): CanyonGeom {
  let g = canyonCache.get(c);
  if (!g) {
    const a = dirFromLatLon(c.lat0, c.lon0, new Vector3());
    const b = dirFromLatLon(c.lat1, c.lon1, new Vector3());
    const n = new Vector3().crossVectors(a, b).normalize();
    g = { a, b, n, span: Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) };
    canyonCache.set(c, g);
  }
  return g;
}

/**
 * 峡谷深度（负值）。到大圆弧的距离（两端按到端点的距离，自然收成圆头）与半宽之比决定剖面：
 * 平底 + 陡壁；半宽随位置用噪声扰动，壁面参差不齐。
 */
function canyonHeight(c: CanyonDef, R: number, dx: number, dy: number, dz: number): number {
  const g = canyonGeom(c);
  const sn = dx * g.n.x + dy * g.n.y + dz * g.n.z;
  // 投影到大圆所在平面后，相对 A 的角度
  const qx = dx - g.n.x * sn;
  const qy = dy - g.n.y * sn;
  const qz = dz - g.n.z * sn;
  const cx = g.a.y * qz - g.a.z * qy;
  const cy = g.a.z * qx - g.a.x * qz;
  const cz = g.a.x * qy - g.a.y * qx;
  const ta = Math.atan2(cx * g.n.x + cy * g.n.y + cz * g.n.z, g.a.x * qx + g.a.y * qy + g.a.z * qz);
  let ang: number;
  if (ta >= 0 && ta <= g.span) ang = Math.abs(Math.asin(Math.max(-1, Math.min(1, sn))));
  else {
    const da = Math.acos(Math.max(-1, Math.min(1, dx * g.a.x + dy * g.a.y + dz * g.a.z)));
    const db = Math.acos(Math.max(-1, Math.min(1, dx * g.b.x + dy * g.b.y + dz * g.b.z)));
    ang = Math.min(da, db);
  }
  const dist = ang * R;
  if (dist > c.halfWidth * 2) return 0;
  const k = R / (c.halfWidth * 3);
  const w = c.halfWidth * (1 + 0.28 * gnoise(dx * k, dy * k, dz * k, c.seed));
  const x = dist / w;
  return -c.depth * (1 - smoothstep(0.55, 1.0, x));
}

/**
 * 岩质天体表面高度（相对基准半径，米）。(dx, dy, dz) 为天体固连系单位向量。
 * minFeature：小于此尺度的细节被省略（用于远处网格的 LOD）。
 */
export function rockyHeight(T: RockyTerrainDef, R: number, dx: number, dy: number, dz: number, minFeature = 0): number {
  const px = dx * R;
  const py = dy * R;
  const pz = dz * R;
  const mare = mareMask(T, R, dx, dy, dz);
  // 丘陵：从基准波长起，逐级减半
  let hills = 0;
  let wl = T.hillWl;
  let amp = T.hillAmp;
  for (let o = 0; o < 6; o++) {
    if (wl * 0.5 < minFeature) break;
    hills += amp * gnoise(px / wl, py / wl, pz / wl, T.hillSeed + o);
    wl *= 0.5;
    amp *= 0.45;
  }
  let h = hills * (1 - 0.75 * mare) - T.mareDepth * mare;
  for (let l = 0; l < T.craterLevels; l++) {
    if (CRATER_RMAX[l] < minFeature * 1.2) break;
    const c = craterLevel(px, py, pz, l, T.craterSeed, T.craterProb);
    h += l < 3 ? c * (1 - 0.6 * mare) : c;
  }
  if (T.volcanoes) for (const v of T.volcanoes) h += volcanoHeight(v, R, dx, dy, dz);
  if (T.canyons) for (const c of T.canyons) h += canyonHeight(c, R, dx, dy, dz);
  return h;
}

/** 月面高度（保留旧接口）。 */
export function moonHeight(dx: number, dy: number, dz: number, minFeature = 0): number {
  return rockyHeight(TERRAIN.moon!, MOON.radius, dx, dy, dz, minFeature);
}

export function terrainHeight(body: Body, dir: Vector3, minFeature = 0): number {
  const T = TERRAIN[body.id];
  if (!T) return 0;
  return rockyHeight(T, BODY_R[body.id]!, dir.x, dir.y, dir.z, minFeature);
}

/** 地形法线（天体固连系），用有限差分。 */
export function terrainNormal(body: Body, dir: Vector3, out = new Vector3()): Vector3 {
  if (!TERRAIN[body.id]) return out.copy(dir);
  const R = body.radius;
  const eps = 0.5;
  // 构造切向基
  const t1 = Math.abs(dir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  t1.sub(dir.clone().multiplyScalar(t1.dot(dir))).normalize();
  const t2 = new Vector3().crossVectors(dir, t1);
  const h0 = terrainHeight(body, dir);
  const d1 = dir.clone().addScaledVector(t1, eps / R).normalize();
  const d2 = dir.clone().addScaledVector(t2, eps / R).normalize();
  const h1 = terrainHeight(body, d1);
  const h2 = terrainHeight(body, d2);
  out.copy(dir).multiplyScalar(eps);
  out.addScaledVector(t1, -(h1 - h0));
  out.addScaledVector(t2, -(h2 - h0));
  return out.normalize();
}

// ------------------------------------------------------------------ GLSL

/** 各岩质天体共用的 GLSL：撞击坑剖面、撞击坑层级、低地遮罩、火山。 */
export const ROCKY_COMMON_GLSL = /* glsl */ `
${NOISE_GLSL}
const float CRATER_RMAX[10] = float[10](${CRATER_RMAX.map((v) => v.toFixed(2)).join(',')});
const float CRATER_PROB[10] = float[10](${CRATER_PROB.map((v) => v.toFixed(3)).join(',')});

float smoothMaxF(float a, float b, float k) { float d = a - b; return 0.5 * (a + b + sqrt(d * d + k * k)); }

float craterProfile(float x, float r) {
  if (x >= 1.6) return 0.0;
  float dr = r < 750.0 ? 0.38 : 0.38 * pow(750.0 / r, 0.45);
  float depth = dr * r;
  float rimH = depth * 0.28;
  if (x < 1.0) {
    float h = (x * x - 1.0) * depth + rimH * x * x * x * x;
    if (r > 1500.0) h = smoothMaxF(h, -depth * 0.72, depth * 0.12);
    return h;
  }
  float t = (x - 1.0) / 0.6;
  return rimH * (1.0 - t) * (1.0 - t);
}

// 返回 x = 高度贡献, y = 新鲜撞击坑亮度
vec2 craterLevel(vec3 p, int level, int craterSeed, float probScale) {
  float rmax = CRATER_RMAX[level];
  float cell = rmax * ${CRATER_CELL_K.toFixed(2)};
  float prob = CRATER_PROB[level] * probScale;
  vec3 g = p / cell - 0.5;
  ivec3 b = ivec3(floor(g));
  uint seed = uint(craterSeed + level * 101);
  vec2 sum = vec2(0.0);
  for (int k = 0; k < 8; k++) {
    ivec3 c = b + ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    uint h = hash3u(c + ivec3(${NOISE_OFFSET}), seed);
    if (hashToFloat(h) >= prob) continue;
    h = nextHash(h);
    float rr = hashToFloat(h);
    float r = rmax * (0.35 + 0.65 * rr * rr);
    h = nextHash(h); float ox = (float(c.x) + 0.25 + 0.5 * hashToFloat(h)) * cell;
    h = nextHash(h); float oy = (float(c.y) + 0.25 + 0.5 * hashToFloat(h)) * cell;
    h = nextHash(h); float oz = (float(c.z) + 0.25 + 0.5 * hashToFloat(h)) * cell;
    vec3 d = p - vec3(ox, oy, oz);
    float dist = length(d);
    if (dist >= 1.6 * r) continue;
    float x = dist / r;
    sum.x += craterProfile(x, r);
    h = nextHash(h);
    float fresh = hashToFloat(h);
    if (fresh < 0.18) sum.y += (1.0 - fresh / 0.18) * (1.0 - smoothstep(0.6, 1.6, x)) * 0.5;
  }
  return sum;
}
`;

/** 生成某个岩质天体的地形函数：vec3 fn(vec3 d, int maxLevel) 返回 (高度, 低地遮罩, 新鲜撞击坑亮度)。 */
export function rockyTerrainGLSL(id: BodyId, fn: string): string {
  const T = TERRAIN[id]!;
  const R = BODY_R[id]!;
  const f = (x: number) => x.toFixed(4);
  const volcanoGLSL = (T.volcanoes ?? [])
    .map((v) => {
      const vd = dirFromLatLon(v.lat, v.lon, new Vector3());
      return `  {
    float ang = acos(clamp(dot(d, vec3(${f(vd.x)}, ${f(vd.y)}, ${f(vd.z)})), -1.0, 1.0));
    float x = ang * ${f(R)} / ${f(v.radius)};
    if (x < 4.0) h += ${f(v.height)} * (exp(-x * x) - 0.22 * exp(-x * x * 40.0));
  }`;
    })
    .join('\n');
  const canyonGLSL = (T.canyons ?? [])
    .map((c) => {
      const g = canyonGeom(c);
      const v3 = (v: Vector3) => `vec3(${v.x.toFixed(6)}, ${v.y.toFixed(6)}, ${v.z.toFixed(6)})`;
      return `  {
    vec3 cA = ${v3(g.a)}; vec3 cB = ${v3(g.b)}; vec3 cN = ${v3(g.n)};
    float sn = dot(d, cN);
    vec3 q = d - cN * sn;
    float ta = atan(dot(cross(cA, q), cN), dot(cA, q));
    float ang = (ta >= 0.0 && ta <= ${g.span.toFixed(6)}) ? abs(asin(clamp(sn, -1.0, 1.0))) : min(acos(clamp(dot(d, cA), -1.0, 1.0)), acos(clamp(dot(d, cB), -1.0, 1.0)));
    float dist = ang * ${f(R)};
    if (dist < ${f(c.halfWidth * 2)}) {
      float k = ${f(R / (c.halfWidth * 3))};
      float w = ${f(c.halfWidth)} * (1.0 + 0.28 * gnoise(d * k, ${c.seed}u));
      h -= ${f(c.depth)} * (1.0 - smoothstep(0.55, 1.0, dist / w));
    }
  }`;
    })
    .join('\n');
  return /* glsl */ `
float ${fn}_mare(vec3 d) {
  float s = ${f(R)} / ${f(T.mareScale)};
  float n = gnoise(d * s, ${T.mareSeed}u) + 0.5 * gnoise(d * s * 2.1, ${T.mareSeed + 1}u);
  return ${f(T.mareAmount)} * smoothstep(0.12, -0.12, n + 0.42);
}
vec3 ${fn}(vec3 d, int maxLevel) {
  vec3 p = d * ${f(R)};
  float mare = ${fn}_mare(d);
  float hills = 0.0;
  float wl = ${f(T.hillWl)};
  float amp = ${f(T.hillAmp)};
  for (int o = 0; o < 6; o++) {
    hills += amp * gnoise(p / wl, uint(${T.hillSeed} + o));
    wl *= 0.5; amp *= 0.45;
  }
  float h = hills * (1.0 - 0.75 * mare) - ${f(T.mareDepth)} * mare;
  float fresh = 0.0;
  for (int l = 0; l < ${T.craterLevels}; l++) {
    if (l > maxLevel) break;
    vec2 c = craterLevel(p, l, ${T.craterSeed}, ${f(T.craterProb)});
    h += l < 3 ? c.x * (1.0 - 0.6 * mare) : c.x;
    fresh += c.y;
  }
${volcanoGLSL}
${canyonGLSL}
  return vec3(h, mare, fresh);
}
`;
}

export const MOON_TERRAIN_GLSL = ROCKY_COMMON_GLSL + `const float MOON_R = ${MOON.radius.toFixed(1)};\n` + rockyTerrainGLSL('moon', 'moonTerrain');

export { EARTH };
