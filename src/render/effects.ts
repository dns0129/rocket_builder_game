import * as THREE from 'three';
import type { PlumeKind } from '../rocket/parts';
import { smokeSprite } from './textures';

// ---------------------------------------------------------------- 发动机尾焰

const PLUME_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uLen;
uniform float uR0;
uniform float uSpread;
varying float vS;
varying vec3 vN;
varying vec3 vV;
void main() {
  float s = -position.y; // 0 在喷口，1 在末端
  vS = s;
  float r = uR0 * (1.0 + (uSpread - 1.0) * pow(s, 0.65));
  vec3 p = vec3(position.x * r, -s * uLen, position.z * r);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelMatrix) * vec3(position.x, 0.0, position.z));
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const PLUME_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uIntensity;
uniform float uTime;
uniform float uDiamonds;
uniform float uVac;
uniform float uSeed;
varying float vS;
varying vec3 vN;
varying vec3 vV;
float h1(float x) { return fract(sin(x * 127.1 + uSeed) * 43758.5453); }
float n1(float x) { float i = floor(x); float f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  #include <logdepthbuf_fragment>
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float core = pow(facing, 1.5 + uVac * 1.5);
  float along = pow(1.0 - vS, 1.2 + uVac * 1.5);
  float flick = 0.82 + 0.18 * n1(uTime * 37.0 + vS * 9.0);
  float d = uDiamonds * pow(max(0.0, sin(vS * 3.14159 * 7.0 - 0.6)), 10.0) * smoothstep(0.75, 0.05, vS) * core;
  vec3 col = mix(uEdge, uCore, pow(core, 3.0) * (1.0 - vS * 0.8));
  col += vec3(1.0, 0.95, 0.85) * pow(core, 6.0) * smoothstep(0.3, 0.0, vS) * 0.8;
  float a = along * core * flick;
  vec3 outc = col * a * uIntensity + uCore * d * uIntensity * 1.4;
  outc *= smoothstep(0.0, 0.04, vS + 0.02);
  gl_FragColor = vec4(outc, 1.0);
}
`;

const PLUME_COLORS: Record<PlumeKind, { core: THREE.Color; edge: THREE.Color; diamonds: number; intensity: number }> = {
  kerolox: { core: new THREE.Color(1.0, 0.78, 0.42), edge: new THREE.Color(1.0, 0.36, 0.06), diamonds: 0.6, intensity: 1.7 },
  hydrolox: { core: new THREE.Color(0.7, 0.8, 1.0), edge: new THREE.Color(0.3, 0.42, 1.0), diamonds: 1.4, intensity: 1.0 },
  solid: { core: new THREE.Color(1.0, 0.86, 0.62), edge: new THREE.Color(1.0, 0.45, 0.12), diamonds: 0.25, intensity: 2.4 },
  lander: { core: new THREE.Color(1.0, 0.72, 0.55), edge: new THREE.Color(0.95, 0.38, 0.3), diamonds: 0.3, intensity: 1.1 },
};

const plumeGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 24, true).translate(0, -0.5, 0);

export class EnginePlume {
  group = new THREE.Group();
  private inner: THREE.Mesh;
  private outer: THREE.Mesh;
  private flare: THREE.Sprite;
  private mi: THREE.ShaderMaterial;
  private mo: THREE.ShaderMaterial;
  kind: PlumeKind;
  radius: number;

  constructor(kind: PlumeKind, radius: number) {
    this.kind = kind;
    this.radius = radius;
    const c = PLUME_COLORS[kind];
    const mk = (seed: number) =>
      new THREE.ShaderMaterial({
        vertexShader: PLUME_VERT,
        fragmentShader: PLUME_FRAG,
        uniforms: {
          uLen: { value: 10 },
          uR0: { value: radius },
          uSpread: { value: 2 },
          uCore: { value: c.core.clone() },
          uEdge: { value: c.edge.clone() },
          uIntensity: { value: 1 },
          uTime: { value: 0 },
          uDiamonds: { value: c.diamonds },
          uVac: { value: 0 },
          uSeed: { value: seed },
        },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        side: THREE.DoubleSide,
      });
    this.mi = mk(Math.random() * 100);
    this.mo = mk(Math.random() * 100);
    this.inner = new THREE.Mesh(plumeGeo, this.mi);
    this.outer = new THREE.Mesh(plumeGeo, this.mo);
    this.inner.frustumCulled = false;
    this.outer.frustumCulled = false;
    this.inner.renderOrder = 20;
    this.outer.renderOrder = 19;
    this.group.add(this.inner, this.outer);
    const spriteMat = new THREE.SpriteMaterial({ map: glowTexture(), color: c.core, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.flare = new THREE.Sprite(spriteMat);
    this.flare.renderOrder = 21;
    this.group.add(this.flare);
    this.group.visible = false;
  }

  /** throttle 0..1，pressure 0..1（相对海平面），time 秒。 */
  update(throttle: number, pressure: number, time: number): void {
    if (throttle <= 0.001) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const c = PLUME_COLORS[this.kind];
    const vac = 1 - Math.min(1, pressure);
    const r = this.radius;
    const len = r * (this.kind === 'solid' ? 16 : this.kind === 'hydrolox' ? 11 : this.kind === 'lander' ? 7 : 13) * (0.55 + 0.45 * throttle) * (1 + vac * 0.8);
    const spreadIn = 1.5 + vac * 2.2;
    const spreadOut = 2.6 + vac * 6;
    const inten = c.intensity * (0.4 + 0.6 * throttle) * (1 - vac * 0.55);
    this.mi.uniforms.uLen.value = len * 0.75;
    this.mi.uniforms.uSpread.value = spreadIn;
    this.mi.uniforms.uIntensity.value = inten * 1.3;
    this.mi.uniforms.uVac.value = vac;
    this.mi.uniforms.uDiamonds.value = c.diamonds * (1 - vac);
    this.mi.uniforms.uTime.value = time;
    this.mi.uniforms.uR0.value = r * 0.9;
    this.mo.uniforms.uLen.value = len * (1.1 + vac * 0.6);
    this.mo.uniforms.uSpread.value = spreadOut;
    this.mo.uniforms.uIntensity.value = inten * 0.35;
    this.mo.uniforms.uVac.value = vac;
    this.mo.uniforms.uDiamonds.value = 0;
    this.mo.uniforms.uTime.value = time + 3.3;
    this.mo.uniforms.uR0.value = r;
    this.flare.scale.setScalar(r * (2.2 + throttle * 1.2));
    this.flare.position.y = -r * 0.4;
    (this.flare.material as THREE.SpriteMaterial).opacity = 0.9;
    (this.flare.material as THREE.SpriteMaterial).color.copy(c.core).multiplyScalar(inten * 0.3);
  }
}

let glowTex: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  glowTex = new THREE.CanvasTexture(canvas);
  return glowTex;
}

// ---------------------------------------------------------------- 粒子系统（烟、火、爆炸）

const PART_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iCol;
attribute vec2 iSizeRot;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vUv = uv;
  vCol = iCol;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(iSizeRot.y);
  float s = sin(iSizeRot.y);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSizeRot.x;
  vec3 wp = iPos + camRight * p.x + camUp * p.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const PART_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uMap, vUv);
  gl_FragColor = vec4(vCol.rgb, vCol.a * t.a);
}
`;

export interface ParticleSpec {
  pos: THREE.Vector3; // 惯性系
  vel: THREE.Vector3;
  life: number;
  size0: number;
  size1: number;
  color: THREE.Color;
  alpha: number;
  drag: number; // 1/s，向环境风速靠拢
  glow?: boolean; // 发光（加色混合）
  cool?: boolean; // 由亮转暗（火焰）
}

class ParticlePool {
  max: number;
  count = 0;
  px: Float64Array;
  vx: Float32Array;
  age: Float32Array;
  life: Float32Array;
  s0: Float32Array;
  s1: Float32Array;
  col: Float32Array;
  alpha: Float32Array;
  drag: Float32Array;
  rot: Float32Array;
  cool: Uint8Array;
  mesh: THREE.InstancedMesh;
  aPos: THREE.InstancedBufferAttribute;
  aCol: THREE.InstancedBufferAttribute;
  aSR: THREE.InstancedBufferAttribute;

  constructor(max: number, additive: boolean) {
    this.max = max;
    this.px = new Float64Array(max * 3);
    this.vx = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.cool = new Uint8Array(max);
    const g = new THREE.PlaneGeometry(1, 1);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.aSR = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iSizeRot', this.aSR);
    const m = new THREE.ShaderMaterial({
      vertexShader: PART_VERT,
      fragmentShader: PART_FRAG,
      uniforms: { uMap: { value: smokeSprite() } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(g, m, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = additive ? 30 : 25;
  }

  add(p: ParticleSpec): void {
    let i: number;
    if (this.count < this.max) i = this.count++;
    else {
      // 替换最老的粒子
      i = Math.floor(Math.random() * this.max);
    }
    this.px[i * 3] = p.pos.x;
    this.px[i * 3 + 1] = p.pos.y;
    this.px[i * 3 + 2] = p.pos.z;
    this.vx[i * 3] = p.vel.x;
    this.vx[i * 3 + 1] = p.vel.y;
    this.vx[i * 3 + 2] = p.vel.z;
    this.age[i] = 0;
    this.life[i] = p.life;
    this.s0[i] = p.size0;
    this.s1[i] = p.size1;
    this.col[i * 3] = p.color.r;
    this.col[i * 3 + 1] = p.color.g;
    this.col[i * 3 + 2] = p.color.b;
    this.alpha[i] = p.alpha;
    this.drag[i] = p.drag;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.cool[i] = p.cool ? 1 : 0;
  }

  update(dt: number, origin: THREE.Vector3, windAt: (x: number, y: number, z: number, out: THREE.Vector3) => void, light: THREE.Color): void {
    const w = new THREE.Vector3();
    let j = 0;
    const pos = this.aPos.array as Float32Array;
    const colA = this.aCol.array as Float32Array;
    const sr = this.aSR.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      const k = i * 3;
      windAt(this.px[k], this.px[k + 1], this.px[k + 2], w);
      const f = Math.min(1, this.drag[i] * dt);
      this.vx[k] += (w.x - this.vx[k]) * f;
      this.vx[k + 1] += (w.y - this.vx[k + 1]) * f;
      this.vx[k + 2] += (w.z - this.vx[k + 2]) * f;
      this.px[k] += this.vx[k] * dt;
      this.px[k + 1] += this.vx[k + 1] * dt;
      this.px[k + 2] += this.vx[k + 2] * dt;
      // 压缩存活粒子
      if (j !== i) {
        this.px[j * 3] = this.px[k];
        this.px[j * 3 + 1] = this.px[k + 1];
        this.px[j * 3 + 2] = this.px[k + 2];
        this.vx[j * 3] = this.vx[k];
        this.vx[j * 3 + 1] = this.vx[k + 1];
        this.vx[j * 3 + 2] = this.vx[k + 2];
        this.age[j] = this.age[i];
        this.life[j] = this.life[i];
        this.s0[j] = this.s0[i];
        this.s1[j] = this.s1[i];
        this.col[j * 3] = this.col[k];
        this.col[j * 3 + 1] = this.col[k + 1];
        this.col[j * 3 + 2] = this.col[k + 2];
        this.alpha[j] = this.alpha[i];
        this.drag[j] = this.drag[i];
        this.rot[j] = this.rot[i];
        this.cool[j] = this.cool[i];
      }
      const t = this.age[j] / this.life[j];
      pos[j * 3] = this.px[j * 3] - origin.x;
      pos[j * 3 + 1] = this.px[j * 3 + 1] - origin.y;
      pos[j * 3 + 2] = this.px[j * 3 + 2] - origin.z;
      const fadeIn = Math.min(1, t * 12);
      const a = this.alpha[j] * fadeIn * (1 - t) * (1 - t * 0.3);
      let r = this.col[j * 3];
      let g = this.col[j * 3 + 1];
      let b = this.col[j * 3 + 2];
      if (this.cool[j]) {
        const c = Math.max(0, 1 - t * 2.2);
        r *= c * c;
        g *= c * c * c;
        b *= c * c * c * c;
      } else {
        r *= light.r;
        g *= light.g;
        b *= light.b;
      }
      colA[j * 4] = r;
      colA[j * 4 + 1] = g;
      colA[j * 4 + 2] = b;
      colA[j * 4 + 3] = a;
      sr[j * 2] = this.s0[j] + (this.s1[j] - this.s0[j]) * Math.sqrt(t);
      sr[j * 2 + 1] = this.rot[j] + t * 0.6;
      j++;
    }
    this.count = j;
    this.mesh.count = j;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSR.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.mesh.count = 0;
  }
}

export class Particles {
  smoke = new ParticlePool(2600, false);
  fire = new ParticlePool(1400, true);

  addTo(scene: THREE.Scene): void {
    scene.add(this.smoke.mesh, this.fire.mesh);
  }

  emit(p: ParticleSpec): void {
    if (p.glow) this.fire.add(p);
    else this.smoke.add(p);
  }

  update(dt: number, origin: THREE.Vector3, windAt: (x: number, y: number, z: number, out: THREE.Vector3) => void, light: THREE.Color): void {
    this.smoke.update(dt, origin, windAt, light);
    this.fire.update(dt, origin, windAt, light);
  }

  clear(): void {
    this.smoke.clear();
    this.fire.clear();
  }

  /** 爆炸：火球、烟团、火星。 */
  explode(pos: THREE.Vector3, baseVel: THREE.Vector3, size: number, inAir: boolean): void {
    const v = new THREE.Vector3();
    const rnd = () => new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    for (let i = 0; i < 70; i++) {
      v.copy(rnd()).multiplyScalar(size * (2 + Math.random() * 6)).add(baseVel);
      this.fire.add({ pos: pos.clone(), vel: v.clone(), life: 0.8 + Math.random() * 1.4, size0: size * 0.6, size1: size * (2 + Math.random() * 2), color: new THREE.Color(9, 4.5, 1.5), alpha: 1, drag: 1.5, cool: true });
    }
    for (let i = 0; i < 40; i++) {
      v.copy(rnd()).multiplyScalar(size * 18 * Math.random()).add(baseVel);
      this.fire.add({ pos: pos.clone(), vel: v.clone(), life: 1 + Math.random() * 2, size0: size * 0.08, size1: size * 0.04, color: new THREE.Color(12, 7, 3), alpha: 1, drag: inAir ? 0.4 : 0, cool: true });
    }
    if (inAir) {
      for (let i = 0; i < 45; i++) {
        v.copy(rnd()).multiplyScalar(size * (1 + Math.random() * 3)).add(baseVel);
        this.smoke.add({ pos: pos.clone(), vel: v.clone(), life: 6 + Math.random() * 8, size0: size * 1.2, size1: size * (4 + Math.random() * 3), color: new THREE.Color(0.18, 0.17, 0.16), alpha: 0.85, drag: 0.8 });
      }
    }
  }
}

// ---------------------------------------------------------------- 再入等离子体

const PLASMA_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uIntensity;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  #include <logdepthbuf_fragment>
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float front = smoothstep(-0.2, 1.0, vY);
  float flick = 0.85 + 0.15 * sin(uTime * 40.0 + vY * 20.0);
  vec3 col = mix(vec3(1.0, 0.35, 0.12), vec3(1.0, 0.75, 0.55), front);
  gl_FragColor = vec4(col * (0.25 + pow(f, 2.0)) * front * uIntensity * flick, 1.0);
}
`;

const PLASMA_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  vY = position.y;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

export class ReentryGlow {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      uniforms: { uIntensity: { value: 0 }, uTime: { value: 0 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    // 沿 +Y 为迎风方向的“弓形激波”壳
    const g = new THREE.SphereGeometry(1, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.62);
    g.scale(1, 0.8, 1);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
  }
}
