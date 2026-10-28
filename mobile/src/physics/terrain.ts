import { Vector3 } from 'three';
import { EARTH, MOON, type Body } from './bodies';
import { gnoise, hash3, hashToFloat, nextHash, NOISE_OFFSET, NOISE_GLSL } from './noise';

/**
 * 月面地形：低频丘陵 + 月海 + 十个尺度层级的撞击坑（半径 20 km 到 5 m）。
 * 每个层级把空间划分为三维网格，每个格子中至多一个撞击坑，只需检查最近的 2×2×2 个格子。
 */

export const CRATER_RMAX = [20000, 8000, 3200, 1300, 520, 210, 85, 34, 14, 5.5];
export const CRATER_PROB = [0.35, 0.42, 0.5, 0.55, 0.55, 0.6, 0.6, 0.62, 0.62, 0.62];
export const CRATER_CELL_K = 2.3;
const CRATER_SEED = 7331;
const HILL_SEED = 1201;
const MARE_SEED = 911;

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

/** 单个尺度层级的撞击坑高度贡献（P 为月心坐标，单位 m）。 */
export function craterLevel(px: number, py: number, pz: number, level: number): number {
  const rmax = CRATER_RMAX[level];
  const cell = rmax * CRATER_CELL_K;
  const prob = CRATER_PROB[level];
  const gx = px / cell - 0.5;
  const gy = py / cell - 0.5;
  const gz = pz / cell - 0.5;
  const bx = Math.floor(gx);
  const by = Math.floor(gy);
  const bz = Math.floor(gz);
  const seed = (CRATER_SEED + level * 101) >>> 0;
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

/** 月海遮罩（0 = 高地，1 = 月海）。 */
export function moonMare(dx: number, dy: number, dz: number): number {
  const s = MOON.radius / 150000;
  const n = gnoise(dx * s, dy * s, dz * s, MARE_SEED) + 0.5 * gnoise(dx * s * 2.1, dy * s * 2.1, dz * s * 2.1, MARE_SEED + 1);
  return smoothstep(0.12, -0.12, n + 0.42);
}

/**
 * 月面高度（相对基准半径，米）。dir 为月球固连系单位向量。
 * minFeature：小于此尺度的细节被省略（用于远处网格的 LOD）。
 */
export function moonHeight(dx: number, dy: number, dz: number, minFeature = 0): number {
  const R = MOON.radius;
  const px = dx * R;
  const py = dy * R;
  const pz = dz * R;
  const mare = moonMare(dx, dy, dz);
  // 丘陵：波长 50 km 起，逐级减半
  let hills = 0;
  let wl = 50000;
  let amp = 1300;
  for (let o = 0; o < 6; o++) {
    if (wl * 0.5 < minFeature) break;
    hills += amp * gnoise(px / wl, py / wl, pz / wl, HILL_SEED + o);
    wl *= 0.5;
    amp *= 0.45;
  }
  let h = hills * (1 - 0.75 * mare) - 900 * mare;
  for (let l = 0; l < CRATER_RMAX.length; l++) {
    if (CRATER_RMAX[l] < minFeature * 1.2) break;
    const c = craterLevel(px, py, pz, l);
    h += l < 3 ? c * (1 - 0.6 * mare) : c;
  }
  return h;
}

export function terrainHeight(body: Body, dir: Vector3, minFeature = 0): number {
  if (body.id === 'moon') return moonHeight(dir.x, dir.y, dir.z, minFeature);
  return 0;
}

/** 地形法线（天体固连系），用有限差分。 */
export function terrainNormal(body: Body, dir: Vector3, out = new Vector3()): Vector3 {
  if (body.id !== 'moon') return out.copy(dir);
  const R = body.radius;
  const eps = 0.5;
  // 构造切向基
  const t1 = Math.abs(dir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  t1.sub(dir.clone().multiplyScalar(t1.dot(dir))).normalize();
  const t2 = new Vector3().crossVectors(dir, t1);
  const h0 = moonHeight(dir.x, dir.y, dir.z);
  const d1 = dir.clone().addScaledVector(t1, eps / R).normalize();
  const d2 = dir.clone().addScaledVector(t2, eps / R).normalize();
  const h1 = moonHeight(d1.x, d1.y, d1.z);
  const h2 = moonHeight(d2.x, d2.y, d2.z);
  out.copy(dir).multiplyScalar(eps);
  out.addScaledVector(t1, -(h1 - h0));
  out.addScaledVector(t2, -(h2 - h0));
  return out.normalize();
}

// ------------------------------------------------------------------ GLSL

export const MOON_TERRAIN_GLSL = /* glsl */ `
${NOISE_GLSL}
const float MOON_R = ${MOON.radius.toFixed(1)};
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
vec2 craterLevel(vec3 p, int level) {
  float rmax = CRATER_RMAX[level];
  float cell = rmax * ${CRATER_CELL_K.toFixed(2)};
  float prob = CRATER_PROB[level];
  vec3 g = p / cell - 0.5;
  ivec3 b = ivec3(floor(g));
  uint seed = uint(${CRATER_SEED} + level * 101);
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

float moonMare(vec3 d) {
  float s = MOON_R / 150000.0;
  float n = gnoise(d * s, ${MARE_SEED}u) + 0.5 * gnoise(d * s * 2.1, ${MARE_SEED + 1}u);
  return smoothstep(0.12, -0.12, n + 0.42);
}

// 返回 x = 高度, y = 月海遮罩, z = 新鲜撞击坑亮度
vec3 moonTerrain(vec3 d, int maxLevel) {
  vec3 p = d * MOON_R;
  float mare = moonMare(d);
  float hills = 0.0;
  float wl = 50000.0;
  float amp = 1300.0;
  for (int o = 0; o < 6; o++) {
    hills += amp * gnoise(p / wl, uint(${HILL_SEED} + o));
    wl *= 0.5; amp *= 0.45;
  }
  float h = hills * (1.0 - 0.75 * mare) - 900.0 * mare;
  float fresh = 0.0;
  for (int l = 0; l < 10; l++) {
    if (l > maxLevel) break;
    vec2 c = craterLevel(p, l);
    h += l < 3 ? c.x * (1.0 - 0.6 * mare) : c.x;
    fresh += c.y;
  }
  return vec3(h, mare, fresh);
}
`;

export { EARTH };
