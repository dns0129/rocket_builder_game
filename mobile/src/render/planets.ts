import * as THREE from 'three';
import { EARTH, MOON } from '../physics/bodies';
import { ATMOSPHERE_GLSL } from './atmosphereGLSL';
import type { PlanetMaps } from './planetBake';

export const SUN_INTENSITY = 4.5; // 直射光照度（与 MeshStandardMaterial 的平行光一致）

/** 所有自定义着色器共享的大气/光照 uniform。 */
export const sharedUniforms = {
  uSunDir: { value: new THREE.Vector3(1, 0, 0) },
  uSunIntensity: { value: 9.0 }, // 散射计算用的太阳辐照度（≈2× 直射光，粗略补偿多次散射）
  uSunLight: { value: SUN_INTENSITY },
  uCamPos: { value: new THREE.Vector3() }, // 相机世界坐标（浮动原点系）
  uEarthCenter: { value: new THREE.Vector3() }, // 地心世界坐标
  uAtmoSamples: { value: 10 },
};

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
uniform vec3 uEarthCenter;
uniform int uAtmoSamples;
// 太阳光穿过大气后的透射率（Kasten-Young 大气质量近似）
vec3 sunTransmittance(float mu) {
  float am = 1.0 / (max(mu, 0.0) + 0.025 * exp(-11.0 * max(mu, -0.2)));
  return exp(-(vec3(5.8e-6, 13.5e-6, 33.1e-6) * 7000.0 + vec3(6.0e-6 * 1.1 * 1300.0)) * min(am, 40.0));
}
vec3 applyAtmo(vec3 col, vec3 worldPos) {
  vec3 ro = uCamPos - uEarthCenter;
  vec3 p = worldPos - uEarthCenter;
  vec3 dv = p - ro;
  float dist = length(dv);
  vec3 tr;
  vec3 ins = atmScatter(ro, dv / dist, dist, uSunDir, tr, uAtmoSamples, 4);
  return col * tr + ins;
}
`;

const EARTH_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
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
  vec3 L = uSunDir;
  float muS = dot(upW, L);
  vec3 sunT = sunTransmittance(muS) * smoothstep(-0.06, 0.03, muS);
  vec3 V = normalize(uCamPos - vWorldPos);
  float ndl = max(dot(n, L), 0.0);
  // 云影
  float cs = texture2D(uAux, vUv + vec2(uCloudOffset, 0.0)).g;
  float shadow = 1.0 - 0.45 * cs;
  vec3 skyAmb = vec3(0.03, 0.05, 0.09) * smoothstep(-0.2, 0.3, muS);
  vec3 col = albedo * (uSunLight * RECIPROCAL_PI * ndl * sunT * shadow + skyAmb);
  // 海面高光
  if (water > 0.01) {
    vec3 H = normalize(L + V);
    float nh = max(dot(upW, H), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    float spec = pow(nh, 400.0) * 60.0 + pow(nh, 60.0) * 1.2;
    col += water * spec * fres * sunT * uSunLight * shadow * step(0.0, dot(upW, L));
  }
  // 城市灯光
  float night = 1.0 - smoothstep(-0.12, 0.06, muS);
  col += aux.r * night * vec3(1.0, 0.7, 0.38) * 0.9;
  col = applyAtmo(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
uniform sampler2D uAux;
uniform mat3 uModelRot;
uniform float uCloudOffset;
uniform float uFade;
varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float cov = texture2D(uAux, vUv + vec2(uCloudOffset, 0.0)).g;
  if (cov < 0.02) discard;
  vec3 upW = normalize(uModelRot * normalize(vLocal));
  float muS = dot(upW, uSunDir);
  // 晨昏线附近的云只在很窄的一条带内被夕阳染色，且不过分饱和
  vec3 sunT = sunTransmittance(muS) * smoothstep(-0.02, 0.08, muS);
  sunT = mix(sunT, vec3(dot(sunT, vec3(0.2126, 0.7152, 0.0722))), 0.45);
  float lit = clamp(muS * 0.8 + 0.15, 0.0, 1.0);
  vec3 col = vec3(0.92) * (uSunLight * RECIPROCAL_PI * lit * sunT) + vec3(0.03, 0.04, 0.06) * smoothstep(-0.2, 0.3, muS);
  // 从云层下方看：云底较暗，越厚越暗
  float camR = length(uCamPos - uEarthCenter);
  float cloudR = length(vWorldPos - uEarthCenter);
  float below = step(camR, cloudR);
  col *= mix(1.0, 0.72 - 0.3 * cov, below);
  col = applyAtmo(col, vWorldPos);
  gl_FragColor = vec4(col, cov * 0.92 * uFade);
}
`;

const MOON_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
uniform sampler2D uColor;
uniform sampler2D uNormal;
uniform mat3 uModelRot;
uniform vec3 uPatchDir;
uniform float uPatchCos;
uniform float uUseAtmo;
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
  float ndl = max(dot(n, uSunDir), 0.0);
  float terminator = smoothstep(-0.02, 0.04, dot(upW, uSunDir));
  vec3 col = albedo * uSunLight * RECIPROCAL_PI * ndl * terminator + albedo * 0.0015;
  if (uUseAtmo > 0.5) col = applyAtmo(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
}
`;

const SKY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const SKY_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${LIGHT_GLSL}
varying vec3 vDir;
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vDir);
  vec3 ro = uCamPos - uEarthCenter;
  vec3 tr;
  vec3 col = atmScatter(ro, rd, 1e30, uSunDir, tr, uAtmoSamples + 4, 5);
  // 银河
  vec3 gN = normalize(vec3(0.35, 0.82, 0.45));
  float gb = exp(-pow(dot(rd, gN) / 0.16, 2.0));
  float gn = 0.55 + 0.45 * sin(dot(rd, vec3(13.1, 7.7, 9.3))) * sin(dot(rd, vec3(-5.3, 11.9, 3.1)));
  col += tr * vec3(0.55, 0.6, 0.75) * gb * gn * 0.012;
  // 太阳圆盘
  float sd = dot(rd, uSunDir);
  float disk = smoothstep(0.99996, 0.99998, sd);
  col += tr * vec3(1.0, 0.97, 0.92) * disk * 80.0;
  col += tr * vec3(1.0, 0.9, 0.75) * (pow(max(sd, 0.0), 4000.0) * 3.0 + pow(max(sd, 0.0), 300.0) * 0.12);
  gl_FragColor = vec4(col, 1.0);
}
`;

const STAR_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aMag;
attribute vec3 aColor;
varying vec3 vColor;
uniform float uStarVis;
uniform float uPixelRatio;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  float b = pow(2.512, -aMag) * 6.0;
  vColor = aColor * min(b, 3.0) * uStarVis;
  gl_PointSize = clamp(1.2 + b * 0.8, 1.0, 3.5) * uPixelRatio;
  #include <logdepthbuf_vertex>
}
`;

const STAR_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

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
  static CLOUD_ALT = 6000;

  constructor(maps: PlanetMaps) {
    const segW = 384;
    const segH = 192;
    const geo = new THREE.SphereGeometry(1, segW, segH);
    this.earthMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: EARTH_FRAG,
      uniforms: {
        ...sharedUniforms,
        uColor: { value: maps.earthColor },
        uAux: { value: maps.earthAux },
        uNormal: { value: maps.earthNormal },
        uModelRot: { value: new THREE.Matrix3() },
        uPatchDir: { value: new THREE.Vector3(1, 0, 0) },
        uPatchCos: { value: 2 },
        uCloudOffset: { value: 0 },
      },
    });
    this.earth = new THREE.Mesh(geo, this.earthMat);
    this.earth.scale.setScalar(EARTH.radius);
    this.earth.frustumCulled = false;
    this.earth.renderOrder = -10;

    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: {
        ...sharedUniforms,
        uAux: { value: maps.earthAux },
        uModelRot: { value: new THREE.Matrix3() },
        uCloudOffset: { value: 0 },
        uFade: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), this.cloudMat);
    this.clouds.scale.setScalar(EARTH.radius + Planets.CLOUD_ALT);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 5;

    this.moonMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: MOON_FRAG,
      uniforms: {
        ...sharedUniforms,
        uColor: { value: maps.moonColor },
        uNormal: { value: maps.moonNormal },
        uModelRot: { value: new THREE.Matrix3() },
        uPatchDir: { value: new THREE.Vector3(1, 0, 0) },
        uPatchCos: { value: 2 },
        uUseAtmo: { value: 1 },
      },
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), this.moonMat);
    this.moon.scale.setScalar(MOON.radius);
    this.moon.frustumCulled = false;
    this.moon.renderOrder = -10;

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { ...sharedUniforms },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.skyMat);
    this.sky.scale.setScalar(1e9);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;

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
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.sky, this.stars, this.earth, this.clouds, this.moon);
  }
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
