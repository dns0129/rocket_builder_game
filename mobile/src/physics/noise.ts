/**
 * 确定性整数哈希与梯度噪声。CPU（物理地形）与 GPU（贴图烘焙）使用完全相同的算法，
 * 保证从轨道上看到的地形与着陆时碰到的地形一致。
 */

export const NOISE_OFFSET = 65536;

export function lowbias32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash3(x: number, y: number, z: number, seed: number): number {
  const h = seed ^ Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f);
  return lowbias32(h >>> 0);
}

export function nextHash(h: number): number {
  return lowbias32((h + 0x9e3779b9) >>> 0);
}

export function hashToFloat(h: number): number {
  return (h >>> 8) / 16777216;
}

const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const GZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gdot(h: number, x: number, y: number, z: number): number {
  const i = h % 12;
  return GX[i] * x + GY[i] * y + GZ[i] * z;
}

/** 3D 梯度噪声，输出约在 [-1, 1]。 */
export function gnoise(x: number, y: number, z: number, seed: number): number {
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const fz0 = Math.floor(z);
  const fx = x - fx0;
  const fy = y - fy0;
  const fz = z - fz0;
  const ix = fx0 + NOISE_OFFSET;
  const iy = fy0 + NOISE_OFFSET;
  const iz = fz0 + NOISE_OFFSET;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const n000 = gdot(hash3(ix, iy, iz, seed), fx, fy, fz);
  const n100 = gdot(hash3(ix + 1, iy, iz, seed), fx - 1, fy, fz);
  const n010 = gdot(hash3(ix, iy + 1, iz, seed), fx, fy - 1, fz);
  const n110 = gdot(hash3(ix + 1, iy + 1, iz, seed), fx - 1, fy - 1, fz);
  const n001 = gdot(hash3(ix, iy, iz + 1, seed), fx, fy, fz - 1);
  const n101 = gdot(hash3(ix + 1, iy, iz + 1, seed), fx - 1, fy, fz - 1);
  const n011 = gdot(hash3(ix, iy + 1, iz + 1, seed), fx, fy - 1, fz - 1);
  const n111 = gdot(hash3(ix + 1, iy + 1, iz + 1, seed), fx - 1, fy - 1, fz - 1);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

/** GLSL 版本（WebGL2 / GLSL ES 3.0）。 */
export const NOISE_GLSL = /* glsl */ `
uint lowbias32(uint h) {
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return h;
}
uint hash3u(ivec3 c, uint seed) {
  uvec3 u = uvec3(c);
  uint h = seed ^ (u.x * 0x8da6b343u) ^ (u.y * 0xd8163841u) ^ (u.z * 0xcb1ab31fu);
  return lowbias32(h);
}
uint nextHash(uint h) { return lowbias32(h + 0x9e3779b9u); }
float hashToFloat(uint h) { return float(h >> 8u) / 16777216.0; }
float gdotN(uint h, vec3 p) {
  uint i = h % 12u;
  if (i < 4u) { return (i == 0u ? p.x + p.y : i == 1u ? -p.x + p.y : i == 2u ? p.x - p.y : -p.x - p.y); }
  if (i < 8u) { return (i == 4u ? p.x + p.z : i == 5u ? -p.x + p.z : i == 6u ? p.x - p.z : -p.x - p.z); }
  return (i == 8u ? p.y + p.z : i == 9u ? -p.y + p.z : i == 10u ? p.y - p.z : -p.y - p.z);
}
float gnoise(vec3 p, uint seed) {
  vec3 f0 = floor(p);
  vec3 f = p - f0;
  ivec3 i = ivec3(f0) + ivec3(${NOISE_OFFSET});
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = gdotN(hash3u(i, seed), f);
  float n100 = gdotN(hash3u(i + ivec3(1,0,0), seed), f - vec3(1,0,0));
  float n010 = gdotN(hash3u(i + ivec3(0,1,0), seed), f - vec3(0,1,0));
  float n110 = gdotN(hash3u(i + ivec3(1,1,0), seed), f - vec3(1,1,0));
  float n001 = gdotN(hash3u(i + ivec3(0,0,1), seed), f - vec3(0,0,1));
  float n101 = gdotN(hash3u(i + ivec3(1,0,1), seed), f - vec3(1,0,1));
  float n011 = gdotN(hash3u(i + ivec3(0,1,1), seed), f - vec3(0,1,1));
  float n111 = gdotN(hash3u(i + ivec3(1,1,1), seed), f - vec3(1,1,1));
  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
`;
