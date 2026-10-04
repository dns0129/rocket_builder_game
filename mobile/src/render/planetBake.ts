import * as THREE from 'three';
import { NOISE_GLSL } from '../physics/noise';
import { MOON_TERRAIN_GLSL } from '../physics/terrain';
import { EARTH, LAUNCH_SITE, MOON, dirFromLatLon } from '../physics/bodies';

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
/**
 * 真实月球贴图（2048×1024 等距柱状投影，北在上、经度 0 在图中央）：
 * Solar System Scope（CC BY 4.0），基于 NASA LRO 影像。加载失败时退回程序化月面。
 */
export const MOON_TEXTURE_FILE = 'textures/planets/moon.jpg';
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

const MOON_FRAG = /* glsl */ `
${COMMON}
${MOON_TERRAIN_GLSL}
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormal;
uniform int uMaxLevel;
// 真实月球贴图（有则取代程序化颜色）；uRelief 缩放法线起伏（贴图本身已带地形明暗，减弱一些）
uniform sampler2D uReal;
uniform float uUseReal;
uniform float uRelief;
uniform float uGain;

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
  vec3 n = normalize(vec3(-(hE - t.x) * uRelief / (dist * max(cos(lat), 0.05)), -(hN - t.x) * uRelief / dist, 1.0));
  oNormal = vec4(n * 0.5 + 0.5, 1.0);
  float mare = t.y;
  float hl = 0.5 + 0.07 * gnoise(d * 40.0, 91u) + 0.04 * gnoise(d * 160.0, 93u);
  vec3 high = vec3(hl) * vec3(1.0, 0.985, 0.96);
  vec3 low = vec3(0.24 + 0.04 * gnoise(d * 30.0, 97u)) * vec3(0.97, 0.98, 1.0);
  vec3 col = mix(high, low, mare);
  col += vec3(0.28) * clamp(t.z, 0.0, 1.2);
  col *= 0.92 + 0.08 * smoothstep(-2000.0, 3000.0, t.x);
  if (uUseReal > 0.5) col = pow(texture(uReal, uv).rgb, vec3(2.2)) * uGain;
  oColor = vec4(srgb(col), clamp(t.x / 8000.0 * 0.5 + 0.5, 0.0, 1.0));
}
`;

export interface PlanetMaps {
  earthColor: THREE.Texture;
  earthAux: THREE.Texture;
  earthNormal: THREE.Texture;
  moonColor: THREE.Texture;
  moonNormal: THREE.Texture;
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
  // 进度：前 35% 下载真实贴图（地球 4 张、月球 1 张，同时下载），其余为 GPU 烘焙
  let earthF = 0;
  let moonF = 0;
  const dlProgress = () => onProgress(((earthF * 4 + moonF) / 5) * 0.35);
  const [src, moonSrc] = await Promise.all([
    loadEarthSources((f) => {
      earthF = f;
      dlProgress();
    }),
    loadTexture(MOON_TEXTURE_FILE).then((t) => {
      moonF = 1;
      dlProgress();
      if (!t) console.warn(`月球贴图 ${MOON_TEXTURE_FILE} 加载失败，改用程序化生成的月面。`);
      return t;
    }),
  ]);
  const bakeProgress = (f: number) => onProgress(0.35 + f * 0.65);
  const maxTex = renderer.capabilities.maxTextureSize;
  const mw = quality === 'low' ? 1024 : 2048;
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
  const moonRT = makeTarget(mw, mw / 2, 2);
  jobs.push({
    rt: moonRT,
    w: mw,
    h: mw / 2,
    mat: new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: MOON_FRAG,
      uniforms: {
        uRes: { value: new THREE.Vector2(mw, mw / 2) },
        uMaxLevel: { value: quality === 'low' ? 3 : 4 },
        uReal: { value: moonSrc },
        uUseReal: { value: moonSrc ? 1 : 0 },
        uRelief: { value: moonSrc ? 0.45 : 1 },
        uGain: { value: 0.8 },
      },
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
  moonSrc?.dispose();

  const [moonColor, moonNormal] = moonRT.textures;
  return { earthColor, earthAux, earthNormal, moonColor, moonNormal, waterMask, waterW: readW, waterH: readH, realEarth: !!src };
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
