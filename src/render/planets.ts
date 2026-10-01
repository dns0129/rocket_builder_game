import * as THREE from 'three';
import { AU, BODIES, EARTH, MARS, SATURN, SUN, VENUS, type Body, type BodyId, bodyPosition, bodyRotation } from '../physics/bodies';
import { NOISE_GLSL } from '../physics/noise';
import { ATMOSPHERE_GLSL } from './atmosphereGLSL';
import type { PlanetMaps } from './planetBake';

export const SUN_INTENSITY = 4.5; // 直射光照度（与 MeshStandardMaterial 的平行光一致）

/** 有大气的天体的散射参数（1:10 尺度下的大气厚度）。 */
export interface AtmoLook {
  r0: number;
  r1: number;
  hr: number;
  hm: number;
  br: [number, number, number];
  bm: [number, number, number];
  g: number;
}

export const ATMO_LOOK: Partial<Record<BodyId, AtmoLook>> = {
  earth: { r0: EARTH.radius, r1: EARTH.radius + 80_000, hr: 7000, hm: 1300, br: [5.8e-6, 13.5e-6, 33.1e-6], bm: [6e-6, 6e-6, 6e-6], g: 0.78 },
  // 火星：稀薄、多尘，白天天空呈奶油黄褐色，日落时偏蓝
  mars: { r0: MARS.radius, r1: MARS.radius + 60_000, hr: 9000, hm: 5000, br: [4.2e-6, 3.0e-6, 2.1e-6], bm: [2.2e-5, 1.6e-5, 1.1e-5], g: 0.6 },
  // 金星：浓密的硫酸云，昏黄
  venus: { r0: VENUS.radius, r1: VENUS.radius + 110_000, hr: 10_000, hm: 6000, br: [1.1e-5, 1.2e-5, 1.0e-5], bm: [4.0e-5, 3.6e-5, 2.4e-5], g: 0.75 },
};

/** 所有自定义着色器共享的大气/光照 uniform。 */
export const sharedUniforms = {
  uSunDir: { value: new THREE.Vector3(1, 0, 0) },
  uSunIntensity: { value: 9.0 }, // 散射计算用的太阳辐照度（≈2× 直射光，粗略补偿多次散射）
  uSunLight: { value: SUN_INTENSITY },
  uCamPos: { value: new THREE.Vector3() }, // 相机世界坐标（浮动原点系）
  uAtmoCenter: { value: new THREE.Vector3() }, // 当前启用的大气所属天体中心（世界坐标）
  uAtmoSamples: { value: 10 },
  uAtmR0: { value: EARTH.radius },
  uAtmR1: { value: EARTH.radius + 80_000 },
  uAtmHR: { value: 7000 },
  uAtmHM: { value: 1300 },
  uAtmBR: { value: new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6) },
  uAtmBM: { value: new THREE.Vector3(6e-6, 6e-6, 6e-6) },
  uAtmG: { value: 0.78 },
  uTime: { value: 0 },
};

/**
 * 每帧只启用一个天体的大气（离相机最近的那个）；id 为 null 时关闭（大气球半径设为 1 m，光线不会命中）。
 * 系数仍保留地球的值，供地球表面的阳光透射率估算使用。
 */
export function setActiveAtmosphere(id: BodyId | null, center: THREE.Vector3): void {
  const look = (id && ATMO_LOOK[id]) || ATMO_LOOK.earth!;
  const u = sharedUniforms;
  u.uAtmoCenter.value.copy(center);
  u.uAtmR0.value = id ? look.r0 : 1;
  u.uAtmR1.value = id ? look.r1 : 1;
  u.uAtmHR.value = look.hr;
  u.uAtmHM.value = look.hm;
  u.uAtmBR.value.set(...look.br);
  u.uAtmBM.value.set(...look.bm);
  u.uAtmG.value = look.g;
}

const PLANET_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec2 vUv;
void main() {
  vLocal = position;
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const LIGHT_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform float uSunLight;
uniform vec3 uCamPos;
uniform vec3 uAtmoCenter;
uniform int uAtmoSamples;
uniform float uTime;
// 太阳光穿过大气后的透射率（Kasten-Young 大气质量近似）
vec3 sunTransmittance(float mu) {
  float am = 1.0 / (max(mu, 0.0) + 0.025 * exp(-11.0 * max(mu, -0.2)));
  return exp(-(ATM_BR * ATM_HR + ATM_BM * 1.1 * ATM_HM) * min(am, 40.0));
}
vec3 applyAtmo(vec3 col, vec3 worldPos) {
  vec3 ro = uCamPos - uAtmoCenter;
  vec3 p = worldPos - uAtmoCenter;
  vec3 dv = p - ro;
  float dist = length(dv);
  vec3 tr;
  vec3 ins = atmScatter(ro, dv / dist, dist, uSunDir, tr, uAtmoSamples, 4);
  return col * tr + ins;
}
`;

/** 用屏幕空间导数做凹凸：h 为高度（米），返回扰动后的法线。 */
const BUMP_GLSL = /* glsl */ `
vec3 bumpNormal(vec3 n, vec3 pos, float h) {
  vec3 dpx = dFdx(pos);
  vec3 dpy = dFdy(pos);
  float dhx = dFdx(h);
  float dhy = dFdy(h);
  vec3 r1 = cross(dpy, n);
  vec3 r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  if (abs(det) < 1e-12) return n;
  vec3 g = (dhx * r1 + dhy * r2) / det;
  return normalize(n - g);
}
`;

/**
 * 地球：NASA 贴图 + 程序化细节。
 * 近处叠加多尺度噪声（地表颜色斑块与起伏、高山积雪），海面有随时间流动的波浪法线和近岸浅水色，
 * 细节随像素覆盖的地面尺寸淡入淡出，远看与原图一致、不闪烁。
 */
const EARTH_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
${NOISE_GLSL}
${BUMP_GLSL}
uniform sampler2D uColor;
uniform sampler2D uAux;
uniform sampler2D uNormal;
uniform mat3 uModelRot;
uniform vec3 uPatchDir;
uniform float uPatchCos;
uniform float uCloudOffset;
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec2 vUv;
const float ER = ${EARTH.radius.toFixed(1)};
void main() {
  #include <logdepthbuf_fragment>
  vec3 up = normalize(vLocal);
  vec3 upW = normalize(uModelRot * up);
  if (dot(upW, uPatchDir) > uPatchCos) discard;
  vec4 c = texture2D(uColor, vUv);
  vec3 albedo = pow(c.rgb, vec3(2.2));
  float water = c.a;
  vec4 aux = texture2D(uAux, vUv);
  vec3 nt = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
  vec3 east = normalize(vec3(up.z, 0.0, -up.x) + vec3(1e-6, 0.0, 0.0));
  vec3 north = cross(up, east);
  vec3 nObj = normalize(mix(east * nt.x + north * nt.y + up * nt.z, up, water));
  vec3 n = normalize(uModelRot * nObj);

  // 每个像素覆盖的地面尺寸（米），决定细节层级的可见度
  float px = length(fwidth(vWorldPos));
  vec3 P = up * ER;
  float land = 1.0 - water;
  // 地表颜色斑块：30 km / 8 km / 2 km 三层
  // 层数随画质（DETAIL = 1~3）；完全淡出的层不计算
  float f1 = 1.0 - smoothstep(4000.0, 12000.0, px);
  float f2 = DETAIL >= 2 ? 1.0 - smoothstep(1000.0, 3200.0, px) : 0.0;
  float f3 = DETAIL >= 3 ? 1.0 - smoothstep(250.0, 800.0, px) : 0.0;
  float d1 = f1 > 0.0 ? gnoise(P / 30000.0, 811u) : 0.0;
  float d2 = f2 > 0.0 ? gnoise(P / 8000.0, 813u) : 0.0;
  float d3 = f3 > 0.0 ? gnoise(P / 2000.0, 817u) : 0.0;
  float detail = d1 * 0.5 * f1 + d2 * 0.35 * f2 + d3 * 0.25 * f3;
  albedo *= 1.0 + detail * 0.32 * land;
  // 起伏：由同一组噪声给出高度，用屏幕空间导数做凹凸，低太阳角时山脊更立体
  float elev = aux.b;
  float relief = (d1 * 900.0 * f1 + d2 * 380.0 * f2 + d3 * 120.0 * f3) * (0.35 + 1.6 * elev) * land;
  n = bumpNormal(n, vWorldPos, relief);
  // 高山积雪
  float snow = smoothstep(0.5, 0.75, elev + d2 * 0.12 * f2 + d3 * 0.05 * f3) * land;
  albedo = mix(albedo, vec3(0.85, 0.88, 0.92), snow * 0.85);

  vec3 L = uSunDir;
  float muS = dot(upW, L);
  vec3 sunT = sunTransmittance(muS) * smoothstep(-0.06, 0.03, muS);
  vec3 V = normalize(uCamPos - vWorldPos);
  // 海面：近岸浅水（用模糊后的水体遮罩判断离岸远近）与流动的波浪
  if (water > 0.01) {
    float blurW = texture2D(uColor, vUv, 3.0).a;
    float shallow = clamp((1.0 - blurW) * 2.2, 0.0, 1.0) * water;
    albedo = mix(albedo, vec3(0.02, 0.13, 0.15), shallow * 0.75);
    float wf = 1.0 - smoothstep(60.0, 600.0, px);
    if (wf > 0.0) {
      float wv = gnoise(P / 900.0 + vec3(uTime * 0.05, 0.0, uTime * 0.03), 901u) * 2.5;
      if (DETAIL >= 3) wv += gnoise(P / 260.0 - vec3(0.0, uTime * 0.08, uTime * 0.06), 907u) * 1.2;
      n = normalize(mix(n, bumpNormal(n, vWorldPos, wv * wf), water));
    }
  }
  float ndl = max(dot(n, L), 0.0);
  // 云影
  float cs = texture2D(uAux, vUv + vec2(uCloudOffset, 0.0)).g;
  float shadow = 1.0 - 0.45 * cs;
  vec3 skyAmb = vec3(0.03, 0.05, 0.09) * smoothstep(-0.2, 0.3, muS);
  vec3 col = albedo * (uSunLight * RECIPROCAL_PI * ndl * sunT * shadow + skyAmb);
  // 海面高光（波浪让太阳倒影碎成闪烁的光斑）
  if (water > 0.01) {
    vec3 nw = normalize(mix(upW, n, 0.6));
    vec3 H = normalize(L + V);
    float nh = max(dot(nw, H), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    float spec = pow(nh, 400.0) * 60.0 + pow(nh, 60.0) * 1.2;
    col += water * spec * fres * sunT * uSunLight * shadow * step(0.0, dot(upW, L));
  }
  // 城市灯光
  float night = 1.0 - smoothstep(-0.12, 0.06, muS);
  col += aux.r * night * vec3(1.0, 0.7, 0.38) * 0.9 * (1.0 + d3 * 0.6 * f3);
  col = applyAtmo(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
${NOISE_GLSL}
uniform sampler2D uAux;
uniform mat3 uModelRot;
uniform float uCloudOffset;
uniform float uFade;
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec2 vUv;
const float ER = ${EARTH.radius.toFixed(1)};
void main() {
  #include <logdepthbuf_fragment>
  float cov = texture2D(uAux, vUv + vec2(uCloudOffset, 0.0)).g;
  if (cov < 0.01) discard;
  // 云的细节：边缘被小尺度噪声侵蚀，近看是一团团的积云而不是模糊的色块
  vec3 P = normalize(vLocal) * ER;
  float px = length(fwidth(vWorldPos));
  float f = DETAIL >= 2 ? 1.0 - smoothstep(1500.0, 6000.0, px) : 0.0;
  float nd = 0.0;
  if (f > 0.0) nd = gnoise(P / 6000.0 + vec3(uTime * 0.002), 951u) * (DETAIL >= 3 ? 0.6 : 1.0);
  if (f > 0.0 && DETAIL >= 3) nd += gnoise(P / 1800.0, 953u) * 0.4;
  cov = clamp(mix(cov, smoothstep(0.15, 0.85, cov + nd * 0.45), f), 0.0, 1.0);
  if (cov < 0.02) discard;
  vec3 upW = normalize(uModelRot * normalize(vLocal));
  float muS = dot(upW, uSunDir);
  // 晨昏线附近的云只在很窄的一条带内被夕阳染色，且不过分饱和
  vec3 sunT = sunTransmittance(muS) * smoothstep(-0.02, 0.08, muS);
  sunT = mix(sunT, vec3(dot(sunT, vec3(0.2126, 0.7152, 0.0722))), 0.45);
  float lit = clamp(muS * 0.8 + 0.15, 0.0, 1.0);
  vec3 col = vec3(0.92) * (uSunLight * RECIPROCAL_PI * lit * sunT) * (0.85 + 0.15 * nd * f) + vec3(0.03, 0.04, 0.06) * smoothstep(-0.2, 0.3, muS);
  // 从云层下方看：云底较暗，越厚越暗
  float camR = length(uCamPos - uAtmoCenter);
  float cloudR = length(vWorldPos - uAtmoCenter);
  float below = step(camR, cloudR);
  col *= mix(1.0, 0.72 - 0.3 * cov, below);
  col = applyAtmo(col, vWorldPos);
  gl_FragColor = vec4(col, cov * 0.92 * uFade);
}
`;

/** 岩质天体（月球、水星、金星、火星）：贴图 + 法线贴图；金星从云层上方看到的是云顶。 */
const ROCKY_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
uniform sampler2D uColor;
uniform sampler2D uNormal;
uniform sampler2D uClouds;
uniform float uCloudMix;
uniform mat3 uModelRot;
uniform vec3 uPatchDir;
uniform float uPatchCos;
uniform float uUseAtmo;
uniform float uAmbient;
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec3 up = normalize(vLocal);
  vec3 upW = normalize(uModelRot * up);
  if (dot(upW, uPatchDir) > uPatchCos) discard;
  vec3 albedo = pow(texture2D(uColor, vUv).rgb, vec3(2.2));
  vec3 nt = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
  vec3 east = normalize(vec3(up.z, 0.0, -up.x) + vec3(1e-6, 0.0, 0.0));
  vec3 north = cross(up, east);
  vec3 n = normalize(uModelRot * normalize(east * nt.x + north * nt.y + up * nt.z));
  if (uCloudMix > 0.0) {
    vec3 cl = pow(texture2D(uClouds, vUv).rgb, vec3(2.2));
    albedo = mix(albedo, cl, uCloudMix);
    n = normalize(mix(n, upW, uCloudMix));
  }
  float ndl = max(dot(n, uSunDir), 0.0);
  float terminator = smoothstep(-0.02, 0.04, dot(upW, uSunDir));
  vec3 col = albedo * uSunLight * RECIPROCAL_PI * ndl * terminator + albedo * uAmbient;
  if (uUseAtmo > 0.5) col = applyAtmo(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** 气态巨行星：带状云 + 临边昏暗 + 一圈淡淡的大气辉光。 */
const GAS_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
uniform sampler2D uColor;
uniform vec3 uCenter;
uniform vec3 uRim;
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vWorldPos - uCenter);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 albedo = pow(texture2D(uColor, vUv).rgb, vec3(2.2));
  float ndl = dot(n, uSunDir);
  float lit = smoothstep(-0.08, 0.25, ndl) * (0.35 + 0.65 * max(ndl, 0.0));
  float mu = max(dot(n, V), 0.0);
  float limb = 0.55 + 0.45 * pow(mu, 0.4);
  vec3 col = albedo * uSunLight * RECIPROCAL_PI * lit * limb;
  col += uRim * pow(1.0 - mu, 3.0) * smoothstep(-0.2, 0.3, ndl) * 0.6;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** 太阳：临边昏暗 + 米粒组织，HDR 亮度交给泛光；在大气中看时同样受散射与消光影响。 */
const SUN_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
${NOISE_GLSL}
uniform vec3 uCenter;
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vLocal);
  vec3 nw = normalize(vWorldPos - uCenter);
  vec3 V = normalize(uCamPos - vWorldPos);
  float mu = max(dot(nw, V), 0.0);
  float limb = 1.0 - 0.62 * (1.0 - mu) - 0.2 * (1.0 - mu * mu);
  float g = gnoise(n * 220.0 + vec3(0.0, uTime * 0.02, 0.0), 977u) * 0.5 + gnoise(n * 55.0 - vec3(uTime * 0.01), 979u) * 0.5;
  vec3 col = vec3(1.0, 0.86, 0.62) * (0.9 + 0.12 * g) * limb * 34.0;
  col = applyAtmo(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
}
`;

const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorldPos;
varying vec2 vRing;
void main() {
  vRing = position.xy;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

/** 土星环：径向密度贴图；被太阳照亮的一面更亮，并带有土星投下的阴影。 */
const RING_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uRings;
uniform vec3 uSunDir;
uniform float uSunLight;
uniform vec3 uCenter;
uniform float uPlanetR;
uniform vec3 uNormalW;
uniform vec3 uCamPos;
varying vec3 vWorldPos;
varying vec2 vRing;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vRing);
  float u = (r - 1.24) / (2.27 - 1.24);
  if (u < 0.0 || u > 1.0) discard;
  vec4 t = texture2D(uRings, vec2(u, 0.5));
  // 土星的阴影：从环上的点朝太阳看，是否被行星挡住
  vec3 p = vWorldPos - uCenter;
  float b = dot(p, uSunDir);
  float c = dot(p, p) - uPlanetR * uPlanetR;
  float shadow = (b < 0.0 && b * b - c > 0.0) ? 0.08 : 1.0;
  float sunSide = sign(dot(uNormalW, uSunDir));
  float camSide = sign(dot(uNormalW, uCamPos - vWorldPos));
  float lit = sunSide == camSide ? 1.0 : 0.35;
  float inc = abs(dot(uNormalW, uSunDir));
  vec3 col = pow(t.rgb, vec3(2.2)) * uSunLight * RECIPROCAL_PI * (0.25 + 0.75 * inc) * lit * shadow;
  gl_FragColor = vec4(col, t.a * 0.95);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w * 0.99999;
}
`;

// 天空最后绘制并固定在远平面（不写 gl_FragDepth），被天体、地面、火箭挡住的像素
// 可以被显卡的提前深度测试直接剔除，不再执行昂贵的大气散射计算
const SKY_FRAG = /* glsl */ `
#include <common>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
varying vec3 vDir;
uniform float uAureole;
void main() {
  vec3 rd = normalize(vDir);
  vec3 ro = uCamPos - uAtmoCenter;
  vec3 tr;
  vec3 col = atmScatter(ro, rd, 1e30, uSunDir, tr, uAtmoSamples + 3, 4);
  // 银河
  vec3 gN = normalize(vec3(0.35, 0.82, 0.45));
  float gb = exp(-pow(dot(rd, gN) / 0.16, 2.0));
  float gn = 0.55 + 0.45 * sin(dot(rd, vec3(13.1, 7.7, 9.3))) * sin(dot(rd, vec3(-5.3, 11.9, 3.1)));
  col += tr * vec3(0.55, 0.6, 0.75) * gb * gn * 0.012;
  // 太阳周围的光晕（日面本身由太阳模型绘制）
  float sd = dot(rd, uSunDir);
  col += tr * vec3(1.0, 0.9, 0.75) * (pow(max(sd, 0.0), 4000.0) * 3.0 + pow(max(sd, 0.0), 300.0) * 0.12) * uAureole;
  gl_FragColor = vec4(col, 1.0);
}
`;

const STAR_VERT = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
varying vec3 vColor;
uniform float uStarVis;
uniform float uPixelRatio;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w * 0.99999;
  float b = pow(2.512, -aMag) * 6.0;
  vColor = aColor * min(b, 3.0) * uStarVis;
  gl_PointSize = clamp(1.2 + b * 0.8, 1.0, 3.5) * uPixelRatio;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/** 远处的行星：圆盘不到一两个像素时画成一颗亮星。 */
const POINT_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
uniform float uPixelRatio;
void main() {
  vColor = aColor;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_PointSize = aSize * uPixelRatio;
  #include <logdepthbuf_vertex>
}
`;

const POINT_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a + smoothstep(0.12, 0.0, d);
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/** 远景光点的亮度（相对） */
const POINT_BRIGHT: Partial<Record<BodyId, number>> = { mercury: 0.8, venus: 2.4, earth: 1.8, moon: 1.3, mars: 1.3, jupiter: 2.0, saturn: 1.3 };
/** 气态巨行星的转轴倾角（只影响外观） */
const AXIAL_TILT: Partial<Record<BodyId, number>> = { jupiter: 0.054, saturn: 0.4665 };

export interface BodyVisual {
  body: Body;
  /** 位于天体中心的组：位置每帧更新，倾角固定 */
  group: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** 该天体自己的太阳方向（从天体中心看） */
  sunDir: { value: THREE.Vector3 };
  /** 该天体处的阳光强度（随离太阳的距离变化） */
  sunLight: { value: number };
}

export class Planets {
  earth: THREE.Mesh;
  clouds: THREE.Mesh;
  moon: THREE.Mesh;
  sky: THREE.Mesh;
  stars: THREE.Points;
  earthMat: THREE.ShaderMaterial;
  cloudMat: THREE.ShaderMaterial;
  moonMat: THREE.ShaderMaterial;
  skyMat: THREE.ShaderMaterial;
  starMat: THREE.ShaderMaterial;
  visuals = new Map<BodyId, BodyVisual>();
  sunGlow: THREE.Sprite;
  private rings: THREE.Mesh;
  private ringMat: THREE.ShaderMaterial;
  private points: THREE.Points;
  private pointBodies: Body[];
  private pointMat: THREE.ShaderMaterial;
  static CLOUD_ALT = 6000;

  /** quality：画质，决定地球近景程序化细节的层数 */
  constructor(maps: PlanetMaps, quality: 'low' | 'medium' | 'high' = 'high') {
    const detail = { DETAIL: quality === 'low' ? 1 : quality === 'medium' ? 2 : 3 };
    const own = () => ({ value: new THREE.Vector3(1, 0, 0) });
    const sphere = (seg: number) => new THREE.SphereGeometry(1, seg, seg / 2);
    const addVisual = (body: Body, mat: THREE.ShaderMaterial, seg: number, sunDir: { value: THREE.Vector3 }) => {
      const sunLight = { value: SUN_INTENSITY };
      if (mat.uniforms.uSunLight) mat.uniforms.uSunLight = sunLight;
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(sphere(seg), mat);
      mesh.scale.setScalar(body.radius);
      mesh.frustumCulled = false;
      mesh.renderOrder = -10;
      group.rotation.x = AXIAL_TILT[body.id] ?? 0;
      group.add(mesh);
      this.visuals.set(body.id, { body, group, mesh, mat, sunDir, sunLight });
      return mesh;
    };

    // 地球
    const earthSun = own();
    this.earthMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: EARTH_FRAG,
      defines: detail,
      uniforms: {
        ...sharedUniforms,
        uSunDir: earthSun,
        uColor: { value: maps.earthColor },
        uAux: { value: maps.earthAux },
        uNormal: { value: maps.earthNormal },
        uModelRot: { value: new THREE.Matrix3() },
        uPatchDir: { value: new THREE.Vector3(1, 0, 0) },
        uPatchCos: { value: 2 },
        uCloudOffset: { value: 0 },
      },
      extensions: { derivatives: true } as unknown as THREE.ShaderMaterial['extensions'],
    });
    this.earth = addVisual(EARTH, this.earthMat, 384, earthSun);

    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: CLOUD_FRAG,
      defines: detail,
      uniforms: {
        ...sharedUniforms,
        uSunDir: earthSun,
        uAux: { value: maps.earthAux },
        uModelRot: { value: new THREE.Matrix3() },
        uCloudOffset: { value: 0 },
        uFade: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.cloudMat.uniforms.uSunLight = this.visuals.get('earth')!.sunLight;
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), this.cloudMat);
    this.clouds.scale.setScalar((EARTH.radius + Planets.CLOUD_ALT) / EARTH.radius);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 5;
    this.visuals.get('earth')!.group.add(this.clouds);

    // 岩质天体：月球、水星、金星、火星
    const rockyMat = (body: Body, sunDir: { value: THREE.Vector3 }) =>
      new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT,
        fragmentShader: ROCKY_FRAG,
        uniforms: {
          ...sharedUniforms,
          uSunDir: sunDir,
          uColor: { value: maps.bodies[body.id]!.color },
          uNormal: { value: maps.bodies[body.id]!.normal },
          uClouds: { value: maps.bodies[body.id]!.clouds ?? maps.bodies[body.id]!.color },
          uCloudMix: { value: maps.bodies[body.id]!.clouds ? 1 : 0 },
          uModelRot: { value: new THREE.Matrix3() },
          uPatchDir: { value: new THREE.Vector3(1, 0, 0) },
          uPatchCos: { value: 2 },
          uUseAtmo: { value: 1 },
          uAmbient: { value: body.id === 'venus' ? 0.02 : 0.0015 },
        },
      });
    for (const b of BODIES) {
      if (b.kind !== 'rocky' || b.id === 'earth') continue;
      const sd = own();
      addVisual(b, rockyMat(b, sd), b.id === 'moon' || b.id === 'mars' ? 256 : 160, sd);
    }
    this.moon = this.visuals.get('moon')!.mesh;
    this.moonMat = this.visuals.get('moon')!.mat;

    // 气态巨行星
    for (const b of BODIES) {
      if (b.kind !== 'gas') continue;
      const sd = own();
      const mat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT,
        fragmentShader: GAS_FRAG,
        uniforms: {
          ...sharedUniforms,
          uSunDir: sd,
          uColor: { value: maps.bodies[b.id]!.color },
          uCenter: { value: new THREE.Vector3() },
          uRim: { value: new THREE.Color(b.id === 'jupiter' ? 0x9fb8e8 : 0xd8c79a) },
        },
      });
      addVisual(b, mat, 128, sd);
    }
    // 土星环
    const sat = this.visuals.get('saturn')!;
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uRings: { value: maps.saturnRings },
        uSunDir: sat.sunDir,
        uSunLight: sat.sunLight,
        uCenter: { value: new THREE.Vector3() },
        uPlanetR: { value: SATURN.radius },
        uNormalW: { value: new THREE.Vector3(0, 1, 0) },
        uCamPos: sharedUniforms.uCamPos,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.rings = new THREE.Mesh(new THREE.RingGeometry(1.2, 2.3, 256, 1), this.ringMat);
    this.rings.rotation.x = -Math.PI / 2;
    this.rings.scale.setScalar(SATURN.radius);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 6;
    sat.group.add(this.rings);

    // 太阳
    const sunDummy = own();
    const sunMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: SUN_FRAG,
      uniforms: { ...sharedUniforms, uCenter: { value: new THREE.Vector3() } },
    });
    addVisual(SUN, sunMat, 96, sunDummy);
    this.sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(3.2, 2.6, 1.9), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.sunGlow.renderOrder = 40;

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { ...sharedUniforms, uAureole: { value: 1 } },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.skyMat);
    this.sky.scale.setScalar(1e9);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 1000; // 不透明物体中最后绘制

    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uStarVis: { value: 1 }, uPixelRatio: { value: 1 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
    });
    this.stars = makeStars(this.starMat);
    this.stars.renderOrder = -999;

    // 远处行星的光点
    this.pointBodies = BODIES.filter((b) => b.kind !== 'star');
    const pg = new THREE.BufferGeometry();
    const n = this.pointBodies.length;
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { uPixelRatio: { value: 1 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(pg, this.pointMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 35;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.sky, this.stars, this.sunGlow, this.points);
    for (const v of this.visuals.values()) scene.add(v.group);
  }

  /** 每帧更新所有天体的位置、自转与各自的太阳方向（浮动原点系）。 */
  updateBodies(t: number, origin: THREE.Vector3): void {
    const sunW = bodyPosition(SUN, t, _sunW).sub(origin);
    for (const v of this.visuals.values()) {
      const b = v.body;
      bodyPosition(b, t, v.group.position).sub(origin);
      const rot = bodyRotation(b, t);
      v.mesh.rotation.set(0, rot, 0);
      if (b.id === 'earth') this.clouds.rotation.set(0, rot, 0);
      const toSun = v.sunDir.value.copy(sunW).sub(v.group.position);
      const d = toSun.length();
      if (d > 0) toSun.divideScalar(d);
      v.sunLight.value = SUN_INTENSITY * sunlightFactor(d);
      const u = v.mat.uniforms;
      if (u.uModelRot) u.uModelRot.value.setFromMatrix4(_m4.makeRotationY(rot));
      if (u.uCenter) u.uCenter.value.copy(v.group.position);
    }
    const sat = this.visuals.get('saturn')!;
    sat.group.updateMatrixWorld(true);
    this.ringMat.uniforms.uCenter.value.copy(sat.group.position);
    this.ringMat.uniforms.uNormalW.value.set(0, 1, 0).applyQuaternion(sat.group.quaternion);
    sharedUniforms.uTime.value = t;
  }

  /**
   * 相机确定之后调用：太阳光晕的大小、远处行星的光点。
   * camPos：相机（浮动原点系）；pxPerRad：每弧度对应的屏幕像素数；glow：光晕颜色（大气中受消光影响）。
   */
  updateView(camPos: THREE.Vector3, near: number, pxPerRad: number, pixelRatio: number, glow: THREE.Color): void {
    const tmp = _tmp;
    // 太阳光晕：角大小约为日面的 10 倍（远处至少 1°）。
    // 光晕面片不放在太阳处（离原点上百亿米，部分显卡上精度不够会画坏），
    // 而是沿太阳方向放在较近的固定距离上，角大小不变
    const sv = this.visuals.get('sun')!;
    const toSun = tmp.copy(sv.group.position).sub(camPos);
    const dSun = toSun.length();
    const ang = THREE.MathUtils.clamp((SUN.radius / dSun) * 10, 0.017, 0.5);
    const D = Math.min(dSun, Math.max(near * 3, 1e8));
    this.sunGlow.position.copy(camPos).addScaledVector(toSun, D / dSun);
    this.sunGlow.scale.setScalar(2 * D * Math.tan(ang / 2));
    (this.sunGlow.material as THREE.SpriteMaterial).color.copy(glow);
    // 光点
    const pos = this.points.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.points.geometry.attributes.aColor as THREE.BufferAttribute;
    const size = this.points.geometry.attributes.aSize as THREE.BufferAttribute;
    const c = _col;
    this.pointBodies.forEach((b, i) => {
      const v = this.visuals.get(b.id)!;
      const rel = tmp.copy(v.group.position).sub(camPos);
      const d = rel.length();
      const appPx = (b.radius / d) * pxPerRad;
      // 圆盘超过约 2 像素就交给模型本身
      const fade = 1 - THREE.MathUtils.smoothstep(appPx, 0.8, 2.5);
      const phase = 0.35 + (0.65 * (1 - v.sunDir.value.dot(rel) / d)) / 2;
      const k = Math.max(0.6, (POINT_BRIGHT[b.id] ?? 1) * phase) * 2.2 * fade;
      // 太远的光点拉近到 1e12 m 以内（方向不变），避免超出远裁剪面
      const far = Math.min(d, 1e12);
      rel.multiplyScalar(far / d).add(camPos);
      pos.setXYZ(i, rel.x, rel.y, rel.z);
      c.set(b.color);
      col.setXYZ(i, c.r * k, c.g * k, c.b * k);
      size.setX(i, fade > 0.01 ? 4 + Math.min(3, k) : 0);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
    size.needsUpdate = true;
    this.pointMat.uniforms.uPixelRatio.value = pixelRatio;
  }

  /** 近地表地形网格所在的天体：在该天体的球面上挖掉网格覆盖的区域。 */
  setPatch(bodyId: BodyId | null, dir: THREE.Vector3, cosA: number): void {
    for (const v of this.visuals.values()) {
      const u = v.mat.uniforms;
      if (!u.uPatchCos) continue;
      if (v.body.id === bodyId) {
        u.uPatchDir.value.copy(dir);
        u.uPatchCos.value = cosA;
      } else u.uPatchCos.value = 2;
    }
  }

  /** 金星：相机在云层以下时显示地表，否则显示云顶。 */
  setVenusCloudMix(v: number): void {
    this.visuals.get('venus')!.mat.uniforms.uCloudMix.value = v;
  }
}

const _sunW = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();

/**
 * 离太阳远近对光照的影响。真实的照度与距离平方成反比（土星只有地球的 1/90），
 * 游戏里只用平方根并加上下限，外行星暗一些但仍看得清。
 */
export function sunlightFactor(distToSun: number): number {
  return THREE.MathUtils.clamp(Math.sqrt(AU / Math.max(distToSun, 1)), 0.32, 1.6);
}

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  // 近似指数衰减，避免出现明显的圆盘边缘
  for (const [r, a] of [[0, 1], [0.04, 0.62], [0.1, 0.3], [0.2, 0.12], [0.35, 0.045], [0.55, 0.014], [0.8, 0.003], [1, 0]]) g.addColorStop(r, `rgba(255,255,255,${a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  glowTex = new THREE.CanvasTexture(cv);
  return glowTex;
}

function makeStars(mat: THREE.ShaderMaterial): THREE.Points {
  const N = 7000;
  const pos = new Float32Array(N * 3);
  const mag = new Float32Array(N);
  const col = new Float32Array(N * 3);
  let s = 12345;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const gN = new THREE.Vector3(0.35, 0.82, 0.45).normalize();
  for (let i = 0; i < N; i++) {
    let v: THREE.Vector3;
    // 部分恒星集中在银河带附近
    for (;;) {
      v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      const l = v.length();
      if (l > 1 || l < 0.1) continue;
      v.divideScalar(l);
      const band = Math.exp(-Math.pow(v.dot(gN) / 0.25, 2));
      if (rnd() < 0.45 + 0.55 * band) break;
    }
    pos.set([v.x * 5e8, v.y * 5e8, v.z * 5e8], i * 3);
    // 星等分布：暗星远多于亮星
    mag[i] = 6.5 - Math.pow(rnd(), 3.2) * 8;
    const t = rnd();
    const c = t < 0.15 ? [0.7, 0.8, 1.0] : t < 0.7 ? [1.0, 0.98, 0.95] : t < 0.9 ? [1.0, 0.88, 0.7] : [1.0, 0.72, 0.55];
    col.set(c, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

export { ATMOSPHERE_GLSL, LIGHT_GLSL };
