import * as THREE from 'three';
import { type Body, bodyRotation, fromBodyFixed } from '../physics/bodies';
import { terrainHeight } from '../physics/terrain';
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
  private rings = 96;
  private segs = 128;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private uv: Float32Array;
  private uv1: Float32Array;
  private lastKey = '';
  private earthMat: THREE.MeshStandardMaterial;
  private moonMat: THREE.MeshStandardMaterial;
  private anchor = new THREE.Vector3();
  private anchorE1 = new THREE.Vector3();
  private anchorE2 = new THREE.Vector3();
  private anchorKey = '';

  constructor(maps: PlanetMaps) {
    const nv = 1 + this.rings * this.segs;
    this.pos = new Float32Array(nv * 3);
    this.uv = new Float32Array(nv * 2);
    this.uv1 = new Float32Array(nv * 2);
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
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv1', new THREE.BufferAttribute(this.uv1, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));

    const grass = groundDetail('grass');
    const reg = groundDetail('regolith');
    this.earthMat = makeGroundMaterial(maps.earthColor, grass.albedo, grass.normal, true);
    this.moonMat = makeGroundMaterial(maps.moonColor, reg.albedo, reg.normal, false);
    this.mesh = new THREE.Mesh(this.geo, this.earthMat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.renderOrder = -5;
  }

  /** 每帧调用。shipBf 为飞船在天体固连系中的位置。 */
  update(body: Body, t: number, shipBf: THREE.Vector3, radarAlt: number, origin: THREE.Vector3): void {
    const limit = body.id === 'earth' ? 60_000 : 45_000;
    this.active = radarAlt < limit;
    this.mesh.visible = this.active;
    if (!this.active) {
      this.angularRadius = 0;
      return;
    }
    if (this.body !== body) {
      this.body = body;
      this.mesh.material = body.id === 'earth' ? this.earthMat : this.moonMat;
      this.lastKey = '';
      this.anchorKey = '';
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
    const key = `${latS.toFixed(12)}|${lonS.toFixed(12)}|${d0}|${rMax}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.rebuild(body, latS, lonS, d0, rMax);
    }
    const wp = fromBodyFixed(body, t, this.centerPoint, new THREE.Vector3());
    this.mesh.position.copy(wp.sub(origin));
    this.mesh.rotation.set(0, bodyRotation(body, t), 0);
  }

  private rebuild(body: Body, lat: number, lon: number, d0: number, rMax: number): void {
    const R = body.radius;
    const cd = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    this.centerDir.copy(cd);
    const hC = terrainHeight(body, cd);
    this.centerPoint.copy(cd).multiplyScalar(R + hC);
    const e1 = new THREE.Vector3(cd.z, 0, -cd.x);
    if (e1.lengthSq() < 1e-12) e1.set(0, 0, 1);
    e1.normalize();
    const e2 = new THREE.Vector3().crossVectors(cd, e1);

    // 细节纹理锚点（每 20 km 更新一次）
    const aStep = 20_000 / R;
    const aLat = Math.round(lat / aStep) * aStep;
    const aLon = Math.round(lon / aStep) * aStep;
    const aKey = `${aLat}|${aLon}`;
    if (aKey !== this.anchorKey) {
      this.anchorKey = aKey;
      const ad = new THREE.Vector3(Math.cos(aLat) * Math.cos(aLon), Math.sin(aLat), -Math.cos(aLat) * Math.sin(aLon));
      this.anchor.copy(ad).multiplyScalar(R);
      this.anchorE1.set(ad.z, 0, -ad.x).normalize();
      this.anchorE2.crossVectors(ad, this.anchorE1);
    }
    const tile = body.id === 'earth' ? 24 : 16;

    // 环半径：r_j = d0 (k^j - 1)/(k - 1)，求 k 使最外环为 rMax
    const N = this.rings;
    let k = 1.1;
    for (let it = 0; it < 60; it++) {
      const f = (d0 * (Math.pow(k, N) - 1)) / (k - 1) - rMax;
      const df = (d0 * (N * Math.pow(k, N - 1) * (k - 1) - (Math.pow(k, N) - 1))) / ((k - 1) * (k - 1));
      const nk = k - f / df;
      k = Math.max(1.0001, nk);
      if (Math.abs(f) < 1) break;
    }
    this.angularRadius = rMax / R;
    const S = this.segs;
    const uC = lon / (2 * Math.PI) + 0.5;
    const tmp = new THREE.Vector3();
    const P = new THREE.Vector3();
    const pos = this.pos;
    const uv = this.uv;
    const uv1 = this.uv1;
    const writeVertex = (i: number, d: THREE.Vector3, minFeature: number) => {
      const h = terrainHeight(body, d, minFeature);
      P.copy(d).multiplyScalar(R + h);
      pos[i * 3] = P.x - this.centerPoint.x;
      pos[i * 3 + 1] = P.y - this.centerPoint.y;
      pos[i * 3 + 2] = P.z - this.centerPoint.z;
      const vl = Math.asin(Math.max(-1, Math.min(1, d.y)));
      let dl = Math.atan2(-d.z, d.x) - lon;
      dl -= Math.round(dl / (2 * Math.PI)) * 2 * Math.PI;
      uv[i * 2] = uC + dl / (2 * Math.PI);
      uv[i * 2 + 1] = vl / Math.PI + 0.5;
      tmp.copy(P).sub(this.anchor);
      uv1[i * 2] = tmp.dot(this.anchorE1) / tile;
      uv1[i * 2 + 1] = tmp.dot(this.anchorE2) / tile;
    };
    writeVertex(0, cd, 0);
    let rPrev = 0;
    let r = d0;
    let spacing = d0;
    const dir = new THREE.Vector3();
    for (let j = 0; j < N; j++) {
      const theta = r / R;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const circ = (2 * Math.PI * r) / S;
      const minFeature = Math.max(r - rPrev, circ) * 0.9;
      for (let s = 0; s < S; s++) {
        const phi = (s / S) * Math.PI * 2 + (j % 2) * (Math.PI / S);
        dir
          .copy(cd)
          .multiplyScalar(ct)
          .addScaledVector(e1, Math.cos(phi) * st)
          .addScaledVector(e2, Math.sin(phi) * st);
        writeVertex(1 + j * S + s, dir, minFeature);
      }
      rPrev = r;
      spacing *= k;
      r += spacing;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.attributes.uv1.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.attributes.normal.needsUpdate = true;
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
