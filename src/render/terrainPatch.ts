import * as THREE from 'three';
import { type Body, bodyRotation, fromBodyFixed } from '../physics/bodies';
import { generatePatch, type PatchJob, type PatchResult } from './terrainGen';
import { ATMOSPHERE_GLSL } from './atmosphereGLSL';
import { LIGHT_GLSL, sharedUniforms } from './planets';
import type { PlanetMaps } from './planetBake';
import { groundDetail } from './textures';

/**
 * 近地表的高精度地形网格：以飞船正下方为中心的同心圆网格，
 * 半径按几何级数增长，越靠近中心越精细（天然的 LOD）。
 * 顶点在 CPU 上以双精度计算、相对网格中心存储，避免远离原点时的浮点抖动。
 */
export class TerrainPatch {
  mesh: THREE.Mesh;
  body: Body | null = null;
  active = false;
  centerDir = new THREE.Vector3(1, 0, 0);
  centerPoint = new THREE.Vector3();
  angularRadius = 0;
  private rings = 88;
  private segs = 112;
  private geo: THREE.BufferGeometry;
  private shownKey = '';
  private pendingKey: string | null = null;
  private pendingSince = 0;
  private jobId = 0;
  private worker: Worker | null = null;
  private earthMat: THREE.MeshStandardMaterial;
  private moonMat: THREE.MeshStandardMaterial;

  constructor(maps: PlanetMaps) {
    const nv = 1 + this.rings * this.segs;
    const idx: number[] = [];
    const S = this.segs;
    // 逆时针（从上方看）为正面
    for (let s = 0; s < S; s++) idx.push(0, 1 + s, 1 + ((s + 1) % S));
    for (let r = 0; r < this.rings - 1; r++) {
      const a = 1 + r * S;
      const b = 1 + (r + 1) * S;
      for (let s = 0; s < S; s++) {
        const s1 = (s + 1) % S;
        idx.push(a + s, b + s, a + s1);
        idx.push(a + s1, b + s, b + s1);
      }
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setIndex(idx);
    const dyn = (n: number) => new THREE.BufferAttribute(new Float32Array(nv * n), n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', dyn(3));
    this.geo.setAttribute('normal', dyn(3));
    this.geo.setAttribute('uv', dyn(2));
    this.geo.setAttribute('uv1', dyn(2));

    const grass = groundDetail('grass');
    const reg = groundDetail('regolith');
    this.earthMat = makeGroundMaterial(maps.earthColor, grass.albedo, grass.normal, true);
    this.moonMat = makeGroundMaterial(maps.moonColor, reg.albedo, reg.normal, false);
    this.mesh = new THREE.Mesh(this.geo, this.earthMat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.renderOrder = -5;

    // 地形网格在 Worker 中生成，避免月面低空飞行时主线程卡顿
    try {
      this.worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<PatchResult>) => this.apply(e.data);
      this.worker.onerror = () => {
        this.worker = null;
        this.pendingKey = null;
      };
    } catch {
      this.worker = null;
    }
  }

  /** 每帧调用。shipBf 为飞船在天体固连系中的位置。 */
  update(body: Body, t: number, shipBf: THREE.Vector3, radarAlt: number, origin: THREE.Vector3): void {
    const limit = body.id === 'earth' ? 60_000 : 45_000;
    this.active = radarAlt < limit;
    if (!this.active) {
      this.mesh.visible = false;
      this.angularRadius = 0;
      return;
    }
    if (this.body !== body) {
      this.body = body;
      this.mesh.material = body.id === 'earth' ? this.earthMat : this.moonMat;
      this.shownKey = '';
      this.pendingKey = null;
      this.angularRadius = 0;
    }
    const R = body.radius;
    const alt = Math.max(1, radarAlt);
    const d0 = Math.min(2048, Math.max(0.5, Math.pow(2, Math.round(Math.log2(alt * 0.02)))));
    const horizon = Math.sqrt(2 * R * Math.max(alt, 20));
    const rMaxRaw = Math.min(500_000, Math.max(25_000, horizon * 1.6 + 15_000));
    const rMax = Math.pow(2, Math.ceil(Math.log2(rMaxRaw)));
    const dir = shipBf.clone().normalize();
    const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const lon = Math.atan2(-dir.z, dir.x);
    const step = d0 / R;
    const latS = Math.round(lat / step) * step;
    const lonStep = step / Math.max(0.2, Math.cos(latS));
    const lonS = Math.round(lon / lonStep) * lonStep;
    const key = `${body.id}|${latS.toFixed(12)}|${lonS.toFixed(12)}|${d0}|${rMax}`;
    const now = performance.now();
    if (key !== this.shownKey && key !== this.pendingKey && (this.pendingKey === null || now - this.pendingSince > 1500)) {
      const aStep = 20_000 / R;
      const job: PatchJob = {
        id: ++this.jobId,
        bodyId: body.id,
        lat: latS,
        lon: lonS,
        d0,
        rMax,
        rings: this.rings,
        segs: this.segs,
        anchorLat: Math.round(latS / aStep) * aStep,
        anchorLon: Math.round(lonS / aStep) * aStep,
        tile: body.id === 'earth' ? 24 : 16,
      };
      this.pendingKey = key;
      this.pendingSince = now;
      if (this.worker) {
        this.worker.postMessage(job);
      } else {
        const r = generatePatch(job);
        this.apply({ ...r, key } as PatchResult, key);
      }
    }
    this.mesh.visible = this.shownKey !== '';
    const wp = fromBodyFixed(body, t, this.centerPoint, new THREE.Vector3());
    this.mesh.position.copy(wp.sub(origin));
    this.mesh.rotation.set(0, bodyRotation(body, t), 0);
  }

  private apply(r: PatchResult, keyOverride?: string): void {
    if (!this.body || r.bodyId !== this.body.id) return;
    const key = keyOverride ?? this.pendingKey ?? '';
    if (r.id !== this.jobId && !keyOverride) {
      // 过期结果：若尚未显示任何网格，仍然先用上
      if (this.shownKey !== '') return;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).set(r.pos);
    (this.geo.attributes.normal as THREE.BufferAttribute).set(r.normal);
    (this.geo.attributes.uv as THREE.BufferAttribute).set(r.uv);
    (this.geo.attributes.uv1 as THREE.BufferAttribute).set(r.uv1);
    for (const n of ['position', 'normal', 'uv', 'uv1']) this.geo.attributes[n].needsUpdate = true;
    this.centerPoint.set(r.center[0], r.center[1], r.center[2]);
    this.centerDir.set(r.centerDir[0], r.centerDir[1], r.centerDir[2]);
    this.angularRadius = r.angularRadius;
    this.shownKey = key;
    if (r.id === this.jobId) this.pendingKey = null;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

function makeGroundMaterial(map: THREE.Texture, detail: THREE.Texture, detailNormal: THREE.Texture, earth: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map,
    roughness: earth ? 0.95 : 0.97,
    metalness: 0,
    normalMap: detailNormal,
    normalScale: new THREE.Vector2(earth ? 0.6 : 1.0, earth ? 0.6 : 1.0),
  });
  // 烘焙贴图以 sRGB 编码存储在普通 RGBA8 渲染目标中：在着色器里手动解码
  detailNormal.channel = 1;
  const uniforms = {
    uDetail: { value: detail },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, sharedUniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosAtm;\nvarying float vDist;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvWorldPosAtm = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvDist = -mvPosition.z;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWorldPosAtm;\nvarying float vDist;\nuniform sampler2D uDetail;\n${earth ? ATMOSPHERE_GLSL + LIGHT_GLSL : ''}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float waterMask = ${earth ? 'sampledDiffuseColor.a' : '0.0'};
        diffuseColor.rgb = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(2.2));
        diffuseColor.a = 1.0;
        float detFade = 1.0 - smoothstep(300.0, 4000.0, vDist);
        vec2 duv = vNormalMapUv;
        vec3 det = texture2D(uDetail, duv).rgb * 1.45;
        vec3 det2 = texture2D(uDetail, mat2(0.866, 0.5, -0.5, 0.866) * duv * 0.071).rgb * 1.45;
        vec3 det3 = texture2D(uDetail, mat2(0.6, -0.8, 0.8, 0.6) * duv * 0.0061).rgb * 1.45;
        diffuseColor.rgb *= mix(vec3(1.0), det, detFade * (1.0 - waterMask));
        diffuseColor.rgb *= mix(vec3(1.0), det2, (0.35 + 0.4 * detFade) * (1.0 - waterMask));
        diffuseColor.rgb *= mix(vec3(1.0), det3, 0.55 * (1.0 - waterMask));
        ${earth ? '' : 'diffuseColor.rgb *= 1.05;'}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.08, waterMask);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        ${earth ? 'gl_FragColor.rgb = applyAtmo(gl_FragColor.rgb, vWorldPosAtm);' : ''}`,
      );
  };
  return m;
}
