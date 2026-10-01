import { EARTH } from '../physics/bodies';

/** 单次散射大气（瑞利 + 米氏），地球大气厚度 70 km，标高 7 km。 */
export const ATMO_R0 = EARTH.radius;
export const ATMO_R1 = EARTH.radius + 80_000;

export const ATMOSPHERE_GLSL = /* glsl */ `
const float ATM_R0 = ${ATMO_R0.toFixed(1)};
const float ATM_R1 = ${ATMO_R1.toFixed(1)};
const float ATM_HR = 7000.0;
const float ATM_HM = 1300.0;
const vec3 ATM_BR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float ATM_BM = 6.0e-6;
const float ATM_G = 0.78;
uniform float uSunIntensity;

vec2 atmRaySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float lr = length(ro);
  float c = (lr - r) * (lr + r);
  float d = b * b - c;
  if (d < 0.0) return vec2(1e30, -1e30);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}

// 从 ro 沿 rd 到 tMax 的散射光与透射率（ro 为相对地心的坐标）
vec3 atmScatter(vec3 ro, vec3 rd, float tMax, vec3 sunDir, out vec3 trans, const int NS, const int NL) {
  trans = vec3(1.0);
  vec2 ta = atmRaySphere(ro, rd, ATM_R1);
  if (ta.y < 0.0 || ta.x > ta.y) return vec3(0.0);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tMax);
  vec2 tp = atmRaySphere(ro, rd, ATM_R0);
  if (tp.x > 0.0) t1 = min(t1, tp.x);
  if (t1 <= t0) return vec3(0.0);
  float ds = (t1 - t0) / float(NS);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= NS) break;
    vec3 p = ro + rd * (t0 + ds * (float(i) + 0.5));
    float h = length(p) - ATM_R0;
    float dR = exp(-h / ATM_HR) * ds;
    float dM = exp(-h / ATM_HM) * ds;
    odR += dR;
    odM += dM;
    vec2 tl = atmRaySphere(p, sunDir, ATM_R1);
    float dsl = max(tl.y, 0.0) / float(NL);
    float lR = 0.0;
    float lM = 0.0;
    for (int j = 0; j < 8; j++) {
      if (j >= NL) break;
      vec3 pl = p + sunDir * (dsl * (float(j) + 0.5));
      float hl = length(pl) - ATM_R0;
      lR += exp(-hl / ATM_HR) * dsl;
      lM += exp(-hl / ATM_HM) * dsl;
    }
    // 地球本影
    vec2 tsh = atmRaySphere(p, sunDir, ATM_R0);
    float lit = (tsh.x > 0.0) ? 0.0 : 1.0;
    // 晨昏线附近柔化
    float sunH = dot(normalize(p), sunDir);
    lit *= smoothstep(-0.05, 0.02, sunH + 0.08);
    vec3 tau = ATM_BR * (odR + lR) + ATM_BM * 1.1 * (odM + lM);
    vec3 att = exp(-tau) * lit;
    sumR += dR * att;
    sumM += dM * att;
  }
  float mu = dot(rd, sunDir);
  float pR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
  float g2 = ATM_G * ATM_G;
  float pM = 3.0 / (8.0 * 3.14159265) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * ATM_G * mu, 1.5));
  trans = exp(-(ATM_BR * odR + ATM_BM * 1.1 * odM));
  // 多次散射的粗略补偿：少量环境天光
  vec3 amb = (sumR * ATM_BR) * 0.08;
  return uSunIntensity * (sumR * ATM_BR * pR + sumM * ATM_BM * pM + amb);
}
`;
