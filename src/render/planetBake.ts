import * as THREE from 'three';
import { NOISE_GLSL, NOISE_OFFSET } from '../physics/noise';
import { CRATER_CELL_K, MOON_TERRAIN_GLSL, ROCKY_COMMON_GLSL, TERRAIN, rockyTerrainGLSL } from '../physics/terrain';
import { EARTH, LAUNCH_SITE, MOON, type BodyId, dirFromLatLon } from '../physics/bodies';

/**
 * 在 GPU 上一次性烘焙程序化星球贴图（等距柱状投影）。
 * 地球：反照率 + 水体遮罩、城市灯光 + 云 + 高程、法线。
 * 月球：反照率、法线（与物理地形使用同一个撞击坑函数）。
 */

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
uniform vec2 uRes;
const float PI = 3.14159265358979;
vec3 dirFromLatLon(float lat, float lon) {
  return vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
}
vec3 srgb(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
`;

const FBM_GLSL = /* glsl */ `
float fbm(vec3 p, int oct, uint seed) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    s += a * gnoise(p, seed + uint(i) * 7u);
    p = p * 2.03 + vec3(0.31, 0.17, 0.43);
    a *= 0.5;
  }
  return s;
}
// 发射场坐标系：发射场方向旋转到 (1,0,0)
uniform mat3 uSiteRot;
// 程序化云层（赤道辐合带、副热带少云、西风带多云），发射场上空较晴朗
float cloudCover(vec3 d, float alat) {
  vec3 wq = vec3(fbm(d * 2.2, 3, 501u), fbm(d * 2.2 + vec3(7.1), 3, 503u), fbm(d * 2.2 + vec3(3.3), 3, 507u));
  float cn = fbm(d * 3.2 + wq * 1.6, 8, 511u) * 0.5 + 0.5;
  float band = 0.5 + 0.22 * exp(-pow(alat / 0.12, 2.0)) - 0.2 * exp(-pow((alat - 0.42) / 0.14, 2.0)) + 0.14 * exp(-pow((alat - 0.95) / 0.2, 2.0));
  float cov = smoothstep(0.62 - band * 0.28, 0.8 - band * 0.2, cn);
  vec3 kk = uSiteRot * d - vec3(1.0, 0.0, 0.0);
  return cov * (1.0 - 0.85 * exp(-dot(kk, kk) / 0.05));
}
`;

const EARTH_FRAG = /* glsl */ `
${COMMON}
${NOISE_GLSL}
${FBM_GLSL}
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oAux;
layout(location = 2) out vec4 oNormal;

// 发射场周边：小范围整平
float launchMask(vec3 d) {
  vec3 k = uSiteRot * d - vec3(1.0, 0.0, 0.0);
  return exp(-dot(k, k) / 0.004);
}
// 发射场以西的大陆（发射场位于东海岸，残骸落入东边的海洋）
float homeContinent(vec3 d) {
  vec3 c = dirFromLatLon(0.05, -0.12);
  vec3 k = uSiteRot * d - c;
  return exp(-dot(k, k) / 0.07);
}

float elevation(vec3 d) {
  vec3 q = d * 1.25;
  vec3 w = vec3(fbm(q, 4, 11u), fbm(q + vec3(5.2, 1.3, 2.8), 4, 23u), fbm(q + vec3(1.7, 9.2, 3.4), 4, 37u));
  float c = fbm(q * 1.15 + w * 1.1, 8, 101u);
  float e = c * 1.25 - 0.05;
  e += 0.6 * homeContinent(d);
  // 发射场以东保证是海
  vec3 ke = uSiteRot * d - dirFromLatLon(0.0, 0.2);
  e -= 0.4 * exp(-dot(ke, ke) / 0.01);
  float lm = launchMask(d);
  e = mix(e, 0.05, lm * 0.97);
  float ridge = 1.0 - abs(fbm(d * 5.0 + w * 2.0, 6, 211u) * 1.6);
  ridge = ridge * ridge * ridge;
  float land = smoothstep(0.0, 0.12, e);
  e += land * ridge * 0.55 * (1.0 - lm);
  return e;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 d = dirFromLatLon(lat, lon);
  float e = elevation(d);
  float alat = abs(lat);
  float lm = launchMask(d);

  // 法线（东、北方向的有限差分）
  float eps = 2.0 * PI / uRes.x;
  vec3 dE = dirFromLatLon(lat, lon + eps);
  vec3 dN = dirFromLatLon(lat + eps, lon);
  float eE = elevation(dE);
  float eN = elevation(dN);
  float hScale = 5200.0;
  float hs0 = max(e, 0.0) * hScale;
  float hsE = max(eE, 0.0) * hScale;
  float hsN = max(eN, 0.0) * hScale;
  float dist = eps * ${EARTH.radius.toFixed(1)};
  vec3 n = normalize(vec3(-(hsE - hs0) / (dist * max(cos(lat), 0.05)), -(hsN - hs0) / dist, 1.0));
  oNormal = vec4(n * 0.5 + 0.5, 1.0);

  // 气候
  float temp = 1.0 - pow(alat / (0.5 * PI), 1.3) * 1.05 - max(e, 0.0) * 0.55 + fbm(d * 4.0, 3, 301u) * 0.18;
  float moist = fbm(d * 2.6 + vec3(3.0), 5, 331u) * 1.2 + 0.6;
  // 副热带高压带（沙漠）
  moist -= 0.28 * exp(-pow((alat - 0.42) / 0.12, 2.0));
  moist += 0.2 * exp(-pow(alat / 0.15, 2.0));
  // 发射场周边保持温润（草地/森林），但保留自然的斑块变化
  moist = mix(moist, max(moist, 0.58), lm);
  temp = mix(temp, clamp(temp, 0.55, 0.85), lm);

  vec3 col;
  float water = 0.0;
  if (e < 0.0) {
    water = 1.0;
    float depth = clamp(-e * 3.0, 0.0, 1.0);
    vec3 shallow = vec3(0.035, 0.16, 0.22);
    vec3 deep = vec3(0.008, 0.03, 0.085);
    col = mix(shallow, deep, smoothstep(0.0, 0.5, depth));
    // 海冰
    float ice = smoothstep(0.08, -0.05, temp + fbm(d * 8.0, 3, 351u) * 0.12);
    col = mix(col, vec3(0.86, 0.9, 0.95), ice);
    water = 1.0 - ice;
  } else {
    vec3 desert = vec3(0.76, 0.62, 0.42);
    vec3 steppe = vec3(0.5, 0.52, 0.27);
    vec3 grass = vec3(0.26, 0.42, 0.13);
    vec3 forest = vec3(0.1, 0.24, 0.07);
    vec3 jungle = vec3(0.06, 0.2, 0.045);
    vec3 tundra = vec3(0.4, 0.38, 0.31);
    vec3 rock = vec3(0.36, 0.32, 0.28);
    vec3 snow = vec3(0.93, 0.95, 0.98);
    vec3 wet = mix(forest, jungle, smoothstep(0.65, 0.85, temp));
    vec3 veg = mix(grass, wet, smoothstep(0.52, 0.7, moist));
    col = mix(steppe, veg, smoothstep(0.38, 0.52, moist));
    col = mix(desert, col, smoothstep(0.24, 0.4, moist + (1.0 - temp) * 0.3));
    col = mix(tundra, col, smoothstep(0.22, 0.38, temp));
    col = mix(rock, col, smoothstep(0.5, 0.3, e));
    col = mix(col, snow, smoothstep(0.14, 0.04, temp));
    // 海滩
    col = mix(vec3(0.72, 0.66, 0.5), col, smoothstep(0.0, 0.02, e));
    col *= 0.82 + 0.36 * (fbm(d * 40.0, 3, 371u) + 0.5 * fbm(d * 160.0, 3, 373u));
    // 农田/林地斑块
    float patchN = fbm(d * 320.0, 2, 377u);
    col = mix(col, col * vec3(1.15, 1.08, 0.8), smoothstep(0.05, 0.2, patchN) * 0.6);
  }
  oColor = vec4(srgb(col), water);

  // 城市灯光
  float lights = 0.0;
  if (e > 0.0) {
    float hab = smoothstep(0.35, 0.55, temp) * smoothstep(0.25, 0.45, moist) * smoothstep(0.35, 0.02, e);
    float cl = fbm(d * 60.0, 4, 401u) * 0.5 + 0.5;
    float big = fbm(d * 9.0, 3, 431u) * 0.5 + 0.5;
    lights = hab * smoothstep(0.55, 0.8, cl * 0.6 + big * 0.55);
    lights = max(lights, lm * 0.6);
  }
  float cov = cloudCover(d, alat);
  float hn = max(e, 0.0);
  oAux = vec4(lights, cov, clamp(hn, 0.0, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------- 真实地球贴图

/** 反照率 + 水体遮罩（来自 NASA Blue Marble 与水体遮罩图）。 */
const EARTH_REAL_COLOR_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uDay;
uniform sampler2D uWater;
uniform float uWaterIsWhite;
layout(location = 0) out vec4 oColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uDay, uv).rgb;
  float w = texture(uWater, uv).r;
  if (uWaterIsWhite < 0.5) w = 1.0 - w;
  float wm = smoothstep(0.3, 0.7, w);
  // 蓝色大理石中植被区域偏暗，线性空间里只提亮暗色陆地（沙漠、冰原保持原样）
  vec3 lin = pow(c, vec3(2.2));
  float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin *= mix(1.0, 1.6, (1.0 - smoothstep(0.06, 0.3, l)) * (1.0 - wm));
  c = pow(lin, vec3(1.0 / 2.2));
  oColor = vec4(c, wm);
}
`;

/** 城市灯光（NASA Black Marble）、云（程序化）、高程与法线（地形起伏图）。 */
const EARTH_REAL_AUX_FRAG = /* glsl */ `
${COMMON}
${NOISE_GLSL}
${FBM_GLSL}
uniform sampler2D uNight;
uniform sampler2D uTopo;
uniform vec2 uTopoRes;
uniform float uHScale;
layout(location = 0) out vec4 oAux;
layout(location = 1) out vec4 oNormal;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 d = dirFromLatLon(lat, lon);
  vec3 nl = texture(uNight, uv).rgb;
  // 城市灯光偏暖黄；夜图中陆地的暗蓝底色不算灯光
  float lum = max(nl.r, nl.g) - nl.b * 0.35;
  float lights = smoothstep(0.1, 0.65, lum);
  float cov = cloudCover(d, abs(lat));
  vec2 tx = 1.0 / uTopoRes;
  float e = texture(uTopo, uv).r;
  float eE = texture(uTopo, uv + vec2(tx.x, 0.0)).r;
  float eW = texture(uTopo, uv - vec2(tx.x, 0.0)).r;
  float eN = texture(uTopo, uv + vec2(0.0, tx.y)).r;
  float eS = texture(uTopo, uv - vec2(0.0, tx.y)).r;
  float dx = 2.0 * (2.0 * PI * ${EARTH.radius.toFixed(1)} / uTopoRes.x) * max(cos(lat), 0.05);
  float dy = 2.0 * (PI * ${EARTH.radius.toFixed(1)} / uTopoRes.y);
  vec3 n = normalize(vec3(-(eE - eW) * uHScale / dx, -(eN - eS) * uHScale / dy, 1.0));
  oNormal = vec4(n * 0.5 + 0.5, 1.0);
  oAux = vec4(lights, cov, e, 1.0);
}
`;

interface EarthSources {
  day: THREE.Texture;
  night: THREE.Texture;
  water: THREE.Texture;
  topo: THREE.Texture;
}

/** 真实地球贴图的相对路径（开发时位于 public/，构建后与页面同目录）。 */
export const EARTH_TEXTURE_FILES = {
  day: 'textures/earth/day.jpg',
  night: 'textures/earth/night.jpg',
  water: 'textures/earth/water.png',
  topo: 'textures/earth/topo.png',
};
/** 水体遮罩中水面为白色。 */
const WATER_IS_WHITE = true;

function loadTexture(url: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (t) => {
        t.colorSpace = THREE.NoColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = 8;
        resolve(t);
      },
      undefined,
      () => resolve(null),
    );
  });
}

async function loadEarthSources(onProgress: (f: number) => void): Promise<EarthSources | null> {
  let done = 0;
  const entries = Object.entries(EARTH_TEXTURE_FILES) as [keyof EarthSources, string][];
  const results = await Promise.all(
    entries.map(async ([k, url]) => {
      const t = await loadTexture(url);
      onProgress(++done / entries.length);
      return [k, t] as const;
    }),
  );
  const out: Partial<EarthSources> = {};
  for (const [k, t] of results) {
    if (!t) {
      console.warn(`地球贴图 ${EARTH_TEXTURE_FILES[k]} 加载失败，改用程序化生成的地球。`);
      for (const [, t2] of results) t2?.dispose();
      return null;
    }
    out[k] = t;
  }
  return out as EarthSources;
}

/** 发射场坐标系旋转矩阵：把发射场方向转到 (1,0,0)，北向转到 (0,1,0)。 */
function siteRotation(): THREE.Matrix3 {
  const up = dirFromLatLon(LAUNCH_SITE.lat, LAUNCH_SITE.lon);
  const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
  const east = new THREE.Vector3().crossVectors(north, up).normalize();
  return new THREE.Matrix3().set(up.x, up.y, up.z, north.x, north.y, north.z, -east.x, -east.y, -east.z);
}

/**
 * 新鲜撞击坑的辐射纹（只画在贴图上）：按与 craterLevel 相同的哈希顺序找到同一批撞击坑，
 * 只有最新鲜的一小部分带辐射纹——长短不一的亮条从坑缘向外延伸约 3 倍半径，沿径向断断续续。
 * 搜索范围是周围 4×4×4 个格子，保证辐射纹不会在格子边界被截断。
 */
const RAYS_GLSL = /* glsl */ `
float craterRays(vec3 p, int craterSeed, float probScale) {
  float sum = 0.0;
  for (int level = 0; level < 3; level++) {
    float rmax = CRATER_RMAX[level];
    float cell = rmax * ${CRATER_CELL_K.toFixed(2)};
    float prob = CRATER_PROB[level] * probScale;
    vec3 g = p / cell - 0.5;
    ivec3 b = ivec3(floor(g));
    uint seed = uint(craterSeed + level * 101);
    for (int k = 0; k < 64; k++) {
      ivec3 c = b + ivec3(k & 3, (k >> 2) & 3, (k >> 4) & 3) - ivec3(1);
      uint h = hash3u(c + ivec3(${NOISE_OFFSET}), seed);
      if (hashToFloat(h) >= prob) continue;
      h = nextHash(h);
      float rr = hashToFloat(h);
      float r = rmax * (0.35 + 0.65 * rr * rr);
      h = nextHash(h); float ox = (float(c.x) + 0.25 + 0.5 * hashToFloat(h)) * cell;
      h = nextHash(h); float oy = (float(c.y) + 0.25 + 0.5 * hashToFloat(h)) * cell;
      h = nextHash(h); float oz = (float(c.z) + 0.25 + 0.5 * hashToFloat(h)) * cell;
      h = nextHash(h);
      float fresh = hashToFloat(h);
      if (fresh >= 0.1) continue;
      vec3 cp = vec3(ox, oy, oz);
      vec3 dp = p - cp;
      float x = length(dp) / r;
      if (x < 0.9 || x > 3.2) continue;
      vec3 cn = normalize(cp);
      vec3 t1 = normalize(cross(cn, abs(cn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 t2 = cross(cn, t1);
      float th = atan(dot(dp, t2), dot(dp, t1));
      float ph = hashToFloat(nextHash(h)) * 50.0;
      float a = gnoise(vec3(cos(th) * 6.0, sin(th) * 6.0, ph), seed + 77u) + 0.5 * gnoise(vec3(cos(th) * 17.0, sin(th) * 17.0, ph), seed + 79u);
      float ray = smoothstep(0.12, 0.55, a);
      float fall = smoothstep(0.9, 1.25, x) * pow(1.0 - (x - 1.0) / 2.2, 1.6);
      float brk = 0.55 + 0.45 * gnoise(vec3(th * 4.0, x * 3.0, ph), seed + 91u);
      sum += ray * max(fall, 0.0) * brk * (1.0 - fresh / 0.1);
    }
  }
  return sum;
}
`;

const MOON_FRAG = /* glsl */ `
${COMMON}
${MOON_TERRAIN_GLSL}
${RAYS_GLSL}
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;
uniform int uMaxLevel;

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 d = dirFromLatLon(lat, lon);
  vec3 t = moonTerrain(d, uMaxLevel);
  float eps = 2.0 * PI / uRes.x;
  float hE = moonTerrain(dirFromLatLon(lat, lon + eps), uMaxLevel).x;
  float hN = moonTerrain(dirFromLatLon(lat + eps, lon), uMaxLevel).x;
  float dist = eps * MOON_R;
  vec3 n = normalize(vec3(-(hE - t.x) / (dist * max(cos(lat), 0.05)), -(hN - t.x) / dist, 1.0));
  oNormal = vec4(n * 0.5 + 0.5, 1.0);
  float mare = t.y;
  float hl = 0.5 + 0.07 * gnoise(d * 40.0, 91u) + 0.04 * gnoise(d * 160.0, 93u);
  vec3 high = vec3(hl) * vec3(1.0, 0.985, 0.96);
  vec3 low = vec3(0.24 + 0.04 * gnoise(d * 30.0, 97u)) * vec3(0.97, 0.98, 1.0);
  vec3 col = mix(high, low, mare);
  col += vec3(0.28) * clamp(t.z, 0.0, 1.2);
  col *= 0.92 + 0.08 * smoothstep(-2000.0, 3000.0, t.x);
  // 辐射纹（在月海的暗底上更显眼）
  col += vec3(0.2, 0.2, 0.19) * clamp(craterRays(d * MOON_R, ${TERRAIN.moon!.craterSeed}, ${TERRAIN.moon!.craterProb.toFixed(3)}), 0.0, 1.0);
  oColor = vec4(srgb(col), clamp(t.x / 8000.0 * 0.5 + 0.5, 0.0, 1.0));
}
`;


// ---------------------------------------------------------------- 其他行星

/** 岩质行星（水星、金星表面、火星）：与物理地形相同的撞击坑、低地与火山，再按行星上色。 */
function rockyFrag(id: BodyId, colorGLSL: string, extraGLSL = ''): string {
  return /* glsl */ `
${COMMON}
${ROCKY_COMMON_GLSL}
${rockyTerrainGLSL(id, 'terr')}
${extraGLSL}
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;
uniform int uMaxLevel;
uniform float uRadius;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 d = dirFromLatLon(lat, lon);
  vec3 t = terr(d, uMaxLevel);
  float eps = 2.0 * PI / uRes.x;
  float hE = terr(dirFromLatLon(lat, lon + eps), uMaxLevel).x;
  float hN = terr(dirFromLatLon(lat + eps, lon), uMaxLevel).x;
  float dist = eps * uRadius;
  vec3 n = normalize(vec3(-(hE - t.x) / (dist * max(cos(lat), 0.05)), -(hN - t.x) / dist, 1.0));
  oNormal = vec4(n * 0.5 + 0.5, 1.0);
  vec3 col;
  ${colorGLSL}
  oColor = vec4(srgb(col), clamp(t.x / 8000.0 * 0.5 + 0.5, 0.0, 1.0));
}
`;
}

const MERCURY_COLOR = /* glsl */ `
  float hl = 0.3 + 0.06 * gnoise(d * 40.0, 191u) + 0.03 * gnoise(d * 160.0, 193u) + 0.02 * gnoise(d * 640.0, 195u);
  vec3 high = vec3(hl) * vec3(1.0, 0.94, 0.86);
  vec3 low = vec3(0.21 + 0.03 * gnoise(d * 30.0, 197u)) * vec3(0.95, 0.91, 0.87);
  col = mix(high, low, t.y);
  col += vec3(0.3) * clamp(t.z, 0.0, 1.2);
  col *= 0.92 + 0.08 * smoothstep(-2000.0, 3000.0, t.x);
  // 水星的辐射纹又亮又长
  col += vec3(0.24, 0.23, 0.21) * clamp(craterRays(d * uRadius, ${TERRAIN.mercury!.craterSeed}, ${TERRAIN.mercury!.craterProb.toFixed(3)}), 0.0, 1.0);
`;

const MARS_COLOR = /* glsl */ `
  float n1 = gnoise(d * 6.0, 211u) * 0.5 + gnoise(d * 24.0, 213u) * 0.25 + gnoise(d * 96.0, 217u) * 0.12 + gnoise(d * 384.0, 219u) * 0.06;
  vec3 wq = vec3(gnoise(d * 3.0, 241u), gnoise(d * 3.0 + 5.3, 243u), gnoise(d * 3.0 + 9.1, 245u));
  float dk = gnoise(d * 4.0 + wq * 1.4, 247u) + 0.5 * gnoise(d * 9.0 + wq, 249u);
  vec3 rust = vec3(0.6, 0.27, 0.12);
  vec3 ochre = vec3(0.74, 0.46, 0.25);
  vec3 butter = vec3(0.78, 0.56, 0.35);
  vec3 dark = vec3(0.3, 0.16, 0.09);
  vec3 basalt = vec3(0.36, 0.22, 0.15);
  col = mix(rust, ochre, smoothstep(-0.3, 0.5, n1));
  col = mix(col, butter, smoothstep(0.35, 0.7, n1 + 0.2 * dk) * 0.5);
  // 经典的暗色反照率区（类似大瑟提斯、子午湾）：边缘较清晰，带风蚀的条纹
  float darkA = smoothstep(0.12, 0.5, dk + 0.25 * t.y) * (1.0 - smoothstep(1.0, 1.25, abs(lat)));
  float streak = gnoise(d * vec3(40.0, 8.0, 40.0) + wq * 3.0, 251u);
  col = mix(col, mix(dark, basalt, 0.5 + 0.5 * streak), darkA * 0.62);
  // 北部低地
  col = mix(col, dark * 1.2, smoothstep(0.25, 0.8, t.y + n1 * 0.35) * 0.45);
  col += vec3(0.12, 0.08, 0.05) * clamp(t.z, 0.0, 1.0);
  col *= 0.88 + 0.12 * smoothstep(-3000.0, 3000.0, t.x);
  // 极冠：边缘有螺旋状的槽沟与层状纹理
  float pa = atan(d.z, d.x);
  float spiral = sin(pa * 3.0 + (1.5708 - abs(lat)) * 40.0 + n1 * 4.0);
  float capEdge = abs(lat) + n1 * 0.08 + 0.015 * spiral;
  float cap = smoothstep(1.2, 1.28, capEdge);
  vec3 ice = vec3(0.93, 0.92, 0.9) * (0.92 + 0.08 * spiral);
  col = mix(col, ice, cap);
  col = mix(col, vec3(0.75, 0.62, 0.5), smoothstep(1.12, 1.2, capEdge) * (1.0 - cap) * 0.35);
`;

const VENUS_SURFACE_COLOR = /* glsl */ `
  float n1 = gnoise(d * 10.0, 231u) * 0.5 + gnoise(d * 40.0, 233u) * 0.25 + gnoise(d * 160.0, 237u) * 0.1;
  vec3 basalt = vec3(0.3, 0.24, 0.19);
  vec3 plains = vec3(0.45, 0.35, 0.25);
  col = mix(basalt, plains, smoothstep(-0.4, 0.4, n1 + t.y * 0.5));
  col *= 0.9 + 0.1 * smoothstep(-2000.0, 3000.0, t.x);
`;

/** 金星云层：黄白色的带状云与 Y 形图案。 */
const VENUS_CLOUD_FRAG = /* glsl */ `
${COMMON}
${NOISE_GLSL}
${FBM_GLSL}
layout(location = 0) out vec4 oColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 d = dirFromLatLon(lat, lon);
  float w = fbm(d * 2.5, 4, 601u);
  vec3 wq = vec3(w, fbm(d * 2.5 + 3.7, 4, 603u), fbm(d * 2.5 + 8.1, 4, 605u));
  float sw = fbm(d * vec3(3.0, 9.0, 3.0) + wq * 1.5, 6, 607u);
  // 斜向的条纹（超级自转的风把云拉成长条，向两极呈“V”形）
  float streaks = fbm(d * vec3(6.0, 40.0, 6.0) + wq * 2.0 + vec3(0.0, abs(lat) * 2.0, 0.0), 5, 611u);
  float bands = sin(lat * 10.0 + sw * 3.0 + lon * 0.6 * cos(lat));
  vec3 c1 = vec3(0.96, 0.91, 0.76);
  vec3 c2 = vec3(0.8, 0.67, 0.45);
  vec3 col = mix(c2, c1, bands * 0.3 + 0.5 + sw * 0.3);
  col *= 0.9 + 0.16 * streaks;
  // 极地的冷色云环
  col = mix(col, vec3(0.86, 0.84, 0.78), exp(-pow((abs(lat) - 1.15) / 0.08, 2.0)) * 0.4);
  // 赤道附近的“Y”形暗纹
  float y = exp(-pow(lat / 0.35, 2.0)) * smoothstep(0.1, 0.5, sin(lon * 1.0 + abs(lat) * 2.5 + w));
  col *= 1.0 - 0.18 * y;
  col *= mix(1.0, 0.9, smoothstep(1.0, 1.4, abs(lat)));
  oColor = vec4(srgb(col), 1.0);
}
`;

interface GasLook {
  seed: number;
  zone: string;
  belt: string;
  beltDark: string;
  accent: string;
  polar: string;
  bandFreq: number;
  turb: number;
  redSpot: boolean;
  hexagon: boolean;
  /** 白色卵形风暴所在的纬度（弧度）、每圈个数、大小（弧度）、出现概率 */
  ovals: [number, number, number, number][];
}

/**
 * 气态巨行星：随纬度交替的亮带（zone）与暗带（belt）。
 * 多尺度湍流（纬向拉伸的域扭曲）、带边缘的剪切波、细丝、白色卵形风暴、
 * 木星的大红斑（螺旋结构）、斑驳的极区与土星北极六边形。
 */
function gasFrag(g: GasLook): string {
  const S = g.seed;
  const f = (x: number) => x.toFixed(4);
  const ovalCalls = g.ovals
    .map(([lat0, n, size, prob], i) => `  ov = max(ov, ovals(lon, lat, ${f(lat0)}, ${n.toFixed(1)}, ${f(size)}, ${f(prob)}, ${S + 40 + i * 3}u, w.x));`)
    .join('\n');
  return /* glsl */ `
${COMMON}
${NOISE_GLSL}
${FBM_GLSL}
layout(location = 0) out vec4 oColor;
// 沿某一纬度排成一串的卵形风暴：返回 x = 覆盖度，y = 暗边
vec2 ovals(float lon, float lat, float lat0, float n, float size, float prob, uint seed, float jit) {
  vec2 res = vec2(0.0);
  float cellW = 6.2831853 / n;
  float c0 = floor((lon + 3.14159265) / cellW);
  for (int k = -1; k <= 1; k++) {
    float c = c0 + float(k);
    uint h = hash3u(ivec3(int(c) + 1000, int(lat0 * 100.0) + 1000, 7), seed);
    if (hashToFloat(h) > prob) continue;
    h = nextHash(h);
    float cx = (c + 0.25 + 0.5 * hashToFloat(h)) * cellW - 3.14159265;
    h = nextHash(h);
    float sz = size * (0.55 + 0.6 * hashToFloat(h));
    h = nextHash(h);
    float cy = lat0 + (hashToFloat(h) - 0.5) * size * 0.8 + jit * 0.01;
    float dl = lon - cx;
    dl -= 6.2831853 * floor((dl + 3.14159265) / 6.2831853);
    float e = pow(dl * cos(lat) / (sz * 1.6), 2.0) + pow((lat - cy) / sz, 2.0);
    res.x = max(res.x, 1.0 - smoothstep(0.55, 1.0, e));
    res.y = max(res.y, smoothstep(0.8, 1.05, e) * (1.0 - smoothstep(1.05, 1.6, e)));
  }
  return res;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 d = dirFromLatLon(lat, lon);
  float alat = abs(lat);
  // 大尺度扰动（纬向拉伸的域扭曲）
  vec3 q = d * vec3(2.5, 11.0, 2.5);
  vec3 w = vec3(fbm(q, 4, ${S}u), fbm(q + vec3(5.2, 1.3, 2.8), 4, ${S + 1}u), fbm(q + vec3(1.7, 9.2, 3.4), 4, ${S + 2}u));
  // 多次迭代的流场扭曲：沿经度（东西向）的位移远大于南北向，云带边缘被卷成涡旋
  vec3 east = vec3(-sin(lon), 0.0, -cos(lon));
  vec3 north = vec3(-sin(lat) * cos(lon), cos(lat), sin(lat) * sin(lon));
  vec3 pw = d;
  for (int i = 0; i < 3; i++) {
    float k = float(i + 1);
    vec3 qq = pw * vec3(3.0, 16.0, 3.0) * k;
    float a = fbm(qq, 4, ${S + 30}u + uint(i) * 5u);
    float b = fbm(qq + vec3(7.3, 2.1, 4.4), 4, ${S + 33}u + uint(i) * 5u);
    pw = normalize(pw + (east * a * 0.07 + north * b * ${f(g.turb * 0.35)}) / k);
  }
  float latW = asin(clamp(pw.y, -1.0, 1.0));
  // 细丝：更细、沿经度拉得更长（在扭曲后的坐标里）
  float fil = fbm(pw * vec3(12.0, 80.0, 12.0) + w * 1.6, 7, ${S + 3}u);
  float fil2 = fbm(pw * vec3(30.0, 200.0, 30.0) + w * 2.4 + fil, 5, ${S + 4}u);
  float y = latW + ${f(g.turb)} * w.x + ${f(g.turb * 0.45)} * fil;
  float F = ${f(g.bandFreq)};
  float b = sin(y * F) + 0.4 * sin(y * F * 2.3 + 1.3) + 0.18 * sin(y * F * 4.7 + 0.4);
  float zoneMix = smoothstep(-0.45, 0.45, b);
  vec3 col = mix(${g.belt}, ${g.zone}, zoneMix);
  // 暗带中心更深更红，亮带中心更白
  col = mix(col, ${g.beltDark}, smoothstep(-0.55, -1.25, b) * 0.65);
  col = mix(col, ${g.zone} * 1.04, smoothstep(0.7, 1.3, b) * 0.4);
  // 带边缘的剪切波（开尔文-亥姆霍兹不稳定）：卷起的波纹
  float edge = 1.0 - smoothstep(0.0, 0.32, abs(b));
  float kh = sin(lon * 34.0 + fil * 7.0 + w.y * 9.0 + y * 60.0);
  col = mix(col, mix(${g.beltDark}, ${g.zone}, 0.5 + 0.5 * kh), edge * 0.38);
  // 细丝与更细的纹理
  col *= 0.86 + 0.2 * (fil * 0.5 + 0.5) + 0.08 * fil2;
  // 色调变化（暗带里偏蓝灰的“彩饰”）
  col = mix(col, ${g.accent}, smoothstep(0.15, 0.55, fbm(d * vec3(5.0, 26.0, 5.0) + w * 1.2, 4, ${S + 5}u)) * 0.3 * (1.0 - zoneMix));
  // 白色卵形风暴
  vec2 ov = vec2(0.0);
${ovalCalls}
  col = mix(col, ${g.beltDark} * 0.9, ov.y * 0.35);
  col = mix(col, ${g.zone} * 1.06 * (0.94 + 0.08 * fil), ov.x * 0.85);
  ${
    g.redSpot
      ? `{
    // 大红斑：椭圆涡旋，内部是螺旋状的云，外面一圈浅色的环
    float dl = lon - 0.6;
    dl -= 6.2831853 * floor((dl + 3.14159265) / 6.2831853);
    vec2 e2 = vec2(dl / 0.17, (lat + 0.39) / 0.08);
    float e = dot(e2, e2);
    float ang = atan(e2.y, e2.x);
    float spiral = sin(ang * 2.0 + sqrt(e) * 9.0 + fil * 2.0) * 0.5 + 0.5;
    float swirl = fbm(vec3(e2 * 3.0, e * 2.0), 4, ${S + 23}u);
    vec3 red = mix(vec3(0.66, 0.3, 0.2), vec3(0.85, 0.48, 0.32), spiral * 0.6 + swirl * 0.4);
    red = mix(red, vec3(0.9, 0.62, 0.45), smoothstep(0.35, 0.0, e) * 0.5);
    col = mix(col, red, (1.0 - smoothstep(0.6, 1.0, e)) * 0.92);
    col = mix(col, vec3(0.96, 0.9, 0.82), smoothstep(1.0, 1.15, e) * (1.0 - smoothstep(1.15, 1.7, e)) * 0.45);
  }`
      : ''
  }
  // 极区：颜色转灰蓝，布满小气旋
  float pole = smoothstep(1.0, 1.3, alat);
  float mott = fbm(d * 16.0 + w * 2.0, 5, ${S + 7}u);
  vec3 pc = ${g.polar} * (0.82 + 0.36 * (mott * 0.5 + 0.5));
  vec2 cy = vec2(0.0);
  cy = max(cy, ovals(lon, lat, 1.36, 9.0, 0.035, 0.8, ${S + 61}u, 0.0));
  cy = max(cy, ovals(lon, lat, -1.36, 9.0, 0.035, 0.8, ${S + 67}u, 0.0));
  pc = mix(pc, pc * 1.15, cy.x * 0.6);
  pc = mix(pc, pc * 0.75, cy.y * 0.5);
  col = mix(col, pc, pole);
  ${
    g.hexagon
      ? `{
    // 土星北极六边形
    float rho = 1.5707963 - lat;
    float a = mod(lon + 0.2, 1.0471976) - 0.5235988;
    float hexR = rho * cos(a) / 0.8660254;
    float ring = exp(-pow((hexR - 0.24) / 0.018, 2.0));
    col = mix(col, ${g.polar} * vec3(0.78, 0.86, 0.95), smoothstep(0.26, 0.2, hexR) * 0.55);
    col = mix(col, ${g.polar} * 0.7, ring * 0.6);
    col = mix(col, ${g.polar} * 0.55, exp(-pow(rho / 0.03, 2.0)) * 0.8);
  }`
      : ''
  }
  oColor = vec4(srgb(col), 1.0);
}
`;
}

/**
 * 土星环：一维的径向密度与颜色（半径以土星半径为单位，1.24 .. 2.27）。
 * C 环（灰褐、稀薄、有“平台”）、B 环（明亮、偏暖、内疏外密）、卡西尼缝（几条暗淡的小环）、
 * A 环（中等亮度，有恩克缝与基勒缝），再叠加多个尺度的细密小环。
 */
function saturnRingTexture(): THREE.Texture {
  const W = 4096;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = 2;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(W, 2);
  // 一维值噪声（固定种子，保证每次一样）
  let seed = 9177;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const tables = [64, 256, 1024, 3000].map((n) => Array.from({ length: n + 1 }, rnd));
  const vnoise = (x: number, k: number) => {
    const t = tables[k];
    const n = t.length - 1;
    const f = x * n;
    const i = Math.min(n - 1, Math.floor(f));
    const u = f - i;
    const s = u * u * (3 - 2 * u);
    return t[i] * (1 - s) + t[i + 1] * s;
  };
  const sm = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < W; i++) {
    const u = i / (W - 1);
    const r = 1.24 + u * (2.27 - 1.24);
    const fine = (vnoise(u, 1) - 0.5) * 0.5 + (vnoise(u, 2) - 0.5) * 0.35 + (vnoise(u, 3) - 0.5) * 0.3;
    let a: number;
    let c: [number, number, number];
    if (r < 1.527) {
      // C 环：稀薄，有几处较亮的“平台”，麦克斯韦缝
      const plateau = sm(0.62, 0.7, vnoise(u * 3.1, 0)) * 0.12;
      a = 0.1 + plateau + 0.06 * fine;
      if (r > 1.448 && r < 1.456) a *= 0.2;
      c = [0.62, 0.58, 0.52];
    } else if (r < 1.951) {
      // B 环：由内向外越来越密，最亮
      const k = (r - 1.527) / (1.951 - 1.527);
      a = 0.62 + 0.3 * sm(0.0, 0.5, k) + 0.12 * fine;
      const warm = 0.9 + 0.1 * vnoise(u * 2.0, 0);
      c = [0.95 * warm, 0.86 * warm, 0.68 * warm];
    } else if (r < 2.025) {
      // 卡西尼缝：几乎是空的，只有几条暗淡的小环
      a = 0.035 + 0.05 * Math.max(0, Math.sin((r - 1.951) * 420)) * (0.5 + fine);
      c = [0.6, 0.57, 0.52];
    } else {
      // A 环：中等亮度，外缘渐暗；恩克缝、基勒缝
      a = 0.5 + 0.1 * fine - 0.18 * sm(2.18, 2.267, r);
      if (r > 2.211 && r < 2.217) a = 0.04;
      if (r > 2.262 && r < 2.264) a = 0.06;
      c = [0.86, 0.8, 0.68];
    }
    // 内外边缘柔化
    a *= sm(1.24, 1.25, r) * (1 - sm(2.262, 2.27, r));
    const lum = 0.92 + 0.16 * fine;
    for (let y = 0; y < 2; y++) {
      const k = (y * W + i) * 4;
      img.data[k] = Math.round(Math.min(1, c[0] * lum) * 255);
      img.data[k + 1] = Math.round(Math.min(1, c[1] * lum) * 255);
      img.data[k + 2] = Math.round(Math.min(1, c[2] * lum) * 255);
      img.data[k + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  return t;
}

export interface BodyMaps {
  color: THREE.Texture;
  normal?: THREE.Texture;
  /** 金星：浓密的云层 */
  clouds?: THREE.Texture;
}

/** 烘焙贴图包含的撞击坑层级（0 = 半径 20 km 起）；更小的撞击坑由星球着色器在近处实时计算 */
export const BAKE_CRATER_LEVEL = 3;

export interface PlanetMaps {
  earthColor: THREE.Texture;
  earthAux: THREE.Texture;
  earthNormal: THREE.Texture;
  moonColor: THREE.Texture;
  moonNormal: THREE.Texture;
  /** 其他行星的贴图（程序化烘焙） */
  bodies: Partial<Record<BodyId, BodyMaps>>;
  /** 土星环的径向密度/颜色（一维） */
  saturnRings: THREE.Texture;
  waterMask: Uint8Array;
  waterW: number;
  waterH: number;
}

function makeTarget(w: number, h: number, count: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    anisotropy: 8,
  } as THREE.RenderTargetOptions);
  for (const t of rt.textures) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
  }
  return rt;
}

/** 分条带渲染，避免单帧 GPU 负载过高；onProgress 用于加载进度条。 */
export async function bakePlanets(
  renderer: THREE.WebGLRenderer,
  quality: 'low' | 'medium' | 'high',
  onProgress: (f: number) => void,
): Promise<PlanetMaps & { realEarth: boolean }> {
  // 进度：前 35% 下载真实地球贴图，其余为 GPU 烘焙
  const src = await loadEarthSources((f) => onProgress(f * 0.35));
  const bakeProgress = (f: number) => onProgress(0.35 + f * 0.65);
  const maxTex = renderer.capabilities.maxTextureSize;
  const mw = Math.min(quality === 'low' ? 1024 : quality === 'medium' ? 2048 : 4096, maxTex);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const siteRot = { value: siteRotation() };

  const jobs: { rt: THREE.WebGLRenderTarget; mat: THREE.RawShaderMaterial; w: number; h: number }[] = [];
  let earthColor: THREE.Texture;
  let earthAux: THREE.Texture;
  let earthNormal: THREE.Texture;
  let readSource: THREE.Texture;
  if (src) {
    // 真实地球：颜色分辨率跟随原图（受画质与显卡上限约束），辅助图用一半分辨率
    const srcW = (src.day.image as { width: number }).width;
    const cw = Math.min(srcW, maxTex, quality === 'low' ? 2048 : 4096);
    const colorW = Math.pow(2, Math.floor(Math.log2(cw)));
    const auxW = Math.max(1024, colorW / 2);
    const topoImg = src.topo.image as { width: number; height: number };
    const colorRT = makeTarget(colorW, colorW / 2, 1);
    const auxRT = makeTarget(auxW, auxW / 2, 2);
    jobs.push({
      rt: colorRT,
      w: colorW,
      h: colorW / 2,
      mat: new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: EARTH_REAL_COLOR_FRAG,
        uniforms: {
          uRes: { value: new THREE.Vector2(colorW, colorW / 2) },
          uDay: { value: src.day },
          uWater: { value: src.water },
          uWaterIsWhite: { value: WATER_IS_WHITE ? 1 : 0 },
        },
      }),
    });
    jobs.push({
      rt: auxRT,
      w: auxW,
      h: auxW / 2,
      mat: new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: EARTH_REAL_AUX_FRAG,
        uniforms: {
          uRes: { value: new THREE.Vector2(auxW, auxW / 2) },
          uNight: { value: src.night },
          uTopo: { value: src.topo },
          uTopoRes: { value: new THREE.Vector2(topoImg.width, topoImg.height) },
          uHScale: { value: 2500 },
          uSiteRot: siteRot,
        },
      }),
    });
    earthColor = colorRT.textures[0];
    [earthAux, earthNormal] = auxRT.textures;
    readSource = earthColor;
  } else {
    const ew = quality === 'high' ? 4096 : quality === 'medium' ? 2048 : 1024;
    const earthRT = makeTarget(ew, ew / 2, 3);
    jobs.push({
      rt: earthRT,
      w: ew,
      h: ew / 2,
      mat: new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: EARTH_FRAG,
        uniforms: { uRes: { value: new THREE.Vector2(ew, ew / 2) }, uSiteRot: siteRot },
      }),
    });
    [earthColor, earthAux, earthNormal] = earthRT.textures;
    readSource = earthColor;
  }
  // ---- 其他行星
  // 分辨率：低画质 1024，中 2048，高画质的火星、月球与气态巨行星 4096（4096 受显卡上限约束）
  const cap = (w: number) => Math.min(w, maxTex);
  const pw = cap(quality === 'low' ? 1024 : 2048);
  const marsW = cap(quality === 'low' ? 1024 : quality === 'medium' ? 2048 : 4096);
  const gasW = cap(quality === 'low' ? 1024 : quality === 'medium' ? 2048 : 4096);
  const bodies: Partial<Record<BodyId, BodyMaps>> = {};
  const rockyJob = (id: BodyId, w: number, color: string, radius: number, extra = '') => {
    const rt = makeTarget(w, w / 2, 2);
    jobs.push({
      rt,
      w,
      h: w / 2,
      mat: new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: rockyFrag(id, color, extra),
        uniforms: { uRes: { value: new THREE.Vector2(w, w / 2) }, uMaxLevel: { value: BAKE_CRATER_LEVEL }, uRadius: { value: radius } },
      }),
    });
    bodies[id] = { color: rt.textures[0], normal: rt.textures[1] };
  };
  const colorJob = (w: number, frag: string): THREE.Texture => {
    const rt = makeTarget(w, w / 2, 1);
    jobs.push({
      rt,
      w,
      h: w / 2,
      mat: new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms: { uRes: { value: new THREE.Vector2(w, w / 2) } } }),
    });
    return rt.textures[0];
  };
  rockyJob('mercury', pw, MERCURY_COLOR, 243_970, RAYS_GLSL);
  rockyJob('venus', pw, VENUS_SURFACE_COLOR, 605_180);
  bodies.venus!.clouds = colorJob(pw, VENUS_CLOUD_FRAG);
  rockyJob('mars', marsW, MARS_COLOR, 338_950);
  bodies.jupiter = {
    color: colorJob(
      gasW,
      gasFrag({
        seed: 701,
        zone: 'vec3(0.96, 0.92, 0.84)',
        belt: 'vec3(0.64, 0.43, 0.28)',
        beltDark: 'vec3(0.44, 0.26, 0.16)',
        accent: 'vec3(0.5, 0.52, 0.6)',
        polar: 'vec3(0.62, 0.61, 0.6)',
        bandFreq: 15,
        turb: 0.06,
        redSpot: true,
        hexagon: false,
        ovals: [
          [-0.58, 9, 0.022, 0.8],
          [0.36, 7, 0.016, 0.5],
          [-0.75, 6, 0.02, 0.5],
          [0.62, 8, 0.015, 0.45],
        ],
      }),
    ),
  };
  bodies.saturn = {
    color: colorJob(
      gasW,
      gasFrag({
        seed: 733,
        zone: 'vec3(0.93, 0.86, 0.66)',
        belt: 'vec3(0.82, 0.71, 0.5)',
        beltDark: 'vec3(0.72, 0.6, 0.41)',
        accent: 'vec3(0.86, 0.8, 0.62)',
        polar: 'vec3(0.66, 0.68, 0.66)',
        bandFreq: 19,
        turb: 0.025,
        redSpot: false,
        hexagon: true,
        ovals: [[0.7, 5, 0.014, 0.35]],
      }),
    ),
  };

  const moonRT = makeTarget(mw, mw / 2, 2);
  jobs.push({
    rt: moonRT,
    w: mw,
    h: mw / 2,
    mat: new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: MOON_FRAG,
      uniforms: { uRes: { value: new THREE.Vector2(mw, mw / 2) }, uMaxLevel: { value: BAKE_CRATER_LEVEL } },
    }),
  });

  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  const strips = quality === 'low' ? 4 : 16;
  const total = jobs.length * strips;
  let done = 0;
  for (const job of jobs) {
    quad.material = job.mat;
    for (let s = 0; s < strips; s++) {
      const y0 = Math.floor((job.h * s) / strips);
      const y1 = Math.floor((job.h * (s + 1)) / strips);
      renderer.setRenderTarget(job.rt);
      job.rt.scissor.set(0, y0, job.w, y1 - y0);
      job.rt.scissorTest = true;
      renderer.render(scene, cam);
      done++;
      bakeProgress(done / total);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    job.rt.scissorTest = false;
  }
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;

  // 读回水体遮罩（降采样）供物理判断溅落
  const readW = 2048;
  const readH = readW / 2;
  const small = new THREE.WebGLRenderTarget(readW, readH, { type: THREE.UnsignedByteType, depthBuffer: false });
  const copyMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: readSource } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.0,1.0); }',
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map, vUv); }',
  });
  quad.material = copyMat;
  renderer.setRenderTarget(small);
  renderer.render(scene, cam);
  const px = new Uint8Array(readW * readH * 4);
  renderer.readRenderTargetPixels(small, 0, 0, readW, readH, px);
  renderer.setRenderTarget(prevTarget);
  const waterMask = new Uint8Array(readW * readH);
  for (let i = 0; i < readW * readH; i++) waterMask[i] = px[i * 4 + 3];
  small.dispose();
  copyMat.dispose();
  for (const j of jobs) j.mat.dispose();
  quad.geometry.dispose();
  if (src) for (const t of Object.values(src)) t.dispose();

  const [moonColor, moonNormal] = moonRT.textures;
  bodies.moon = { color: moonColor, normal: moonNormal };
  return { earthColor, earthAux, earthNormal, moonColor, moonNormal, bodies, saturnRings: saturnRingTexture(), waterMask, waterW: readW, waterH: readH, realEarth: !!src };
}

export function sampleWater(maps: PlanetMaps, dir: THREE.Vector3): boolean {
  const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  const lon = Math.atan2(-dir.z, dir.x);
  const u = lon / (2 * Math.PI) + 0.5;
  const v = lat / Math.PI + 0.5;
  const x = Math.min(maps.waterW - 1, Math.max(0, Math.floor(u * maps.waterW)));
  const y = Math.min(maps.waterH - 1, Math.max(0, Math.floor(v * maps.waterH)));
  return maps.waterMask[y * maps.waterW + x] > 127;
}

export { MOON };
