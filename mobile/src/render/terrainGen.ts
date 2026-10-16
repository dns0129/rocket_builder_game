import { EARTH, MOON } from '../physics/bodies';
import { terrainHeight } from '../physics/terrain';
import { Vector3 } from 'three';

/** 地形补丁网格生成（在 Worker 中运行，也可在主线程回退调用）。 */

export interface PatchJob {
  id: number;
  bodyId: 'earth' | 'moon';
  lat: number;
  lon: number;
  d0: number;
  rMax: number;
  rings: number;
  segs: number;
  anchorLat: number;
  anchorLon: number;
  tile: number;
}

export interface PatchResult {
  id: number;
  bodyId: 'earth' | 'moon';
  key: string;
  center: [number, number, number];
  centerDir: [number, number, number];
  angularRadius: number;
  pos: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  uv1: Float32Array;
}

function dirOf(lat: number, lon: number): Vector3 {
  return new Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}

export function generatePatch(job: PatchJob): PatchResult {
  const body = job.bodyId === 'moon' ? MOON : EARTH;
  const R = body.radius;
  const { rings: N, segs: S, d0, rMax, lat, lon } = job;
  const cd = dirOf(lat, lon);
  const hC = terrainHeight(body, cd);
  const C = cd.clone().multiplyScalar(R + hC);
  const e1 = new Vector3(cd.z, 0, -cd.x);
  if (e1.lengthSq() < 1e-12) e1.set(0, 0, 1);
  e1.normalize();
  const e2 = new Vector3().crossVectors(cd, e1);
  const ad = dirOf(job.anchorLat, job.anchorLon);
  const anchor = ad.clone().multiplyScalar(R);
  const aE1 = new Vector3(ad.z, 0, -ad.x).normalize();
  const aE2 = new Vector3().crossVectors(ad, aE1);

  // 环半径 r_j = d0 (k^j - 1)/(k - 1)，求 k 使最外环为 rMax
  let k = 1.1;
  for (let it = 0; it < 60; it++) {
    const f = (d0 * (Math.pow(k, N) - 1)) / (k - 1) - rMax;
    const df = (d0 * (N * Math.pow(k, N - 1) * (k - 1) - (Math.pow(k, N) - 1))) / ((k - 1) * (k - 1));
    k = Math.max(1.0001, k - f / df);
    if (Math.abs(f) < 1) break;
  }
  const nv = 1 + N * S;
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const uv1 = new Float32Array(nv * 2);
  const normal = new Float32Array(nv * 3);
  const uC = lon / (2 * Math.PI) + 0.5;
  const P = new Vector3();
  const tmp = new Vector3();
  const d = new Vector3();
  const write = (i: number, dir: Vector3, minFeature: number) => {
    const h = terrainHeight(body, dir, minFeature);
    P.copy(dir).multiplyScalar(R + h);
    pos[i * 3] = P.x - C.x;
    pos[i * 3 + 1] = P.y - C.y;
    pos[i * 3 + 2] = P.z - C.z;
    const vl = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    let dl = Math.atan2(-dir.z, dir.x) - lon;
    dl -= Math.round(dl / (2 * Math.PI)) * 2 * Math.PI;
    uv[i * 2] = uC + dl / (2 * Math.PI);
    uv[i * 2 + 1] = vl / Math.PI + 0.5;
    tmp.copy(P).sub(anchor);
    uv1[i * 2] = tmp.dot(aE1) / job.tile;
    uv1[i * 2 + 1] = tmp.dot(aE2) / job.tile;
  };
  write(0, cd, 0);
  let rPrev = 0;
  let r = d0;
  let spacing = d0;
  for (let j = 0; j < N; j++) {
    const theta = r / R;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const circ = (2 * Math.PI * r) / S;
    const minFeature = Math.max(r - rPrev, circ) * 0.9;
    for (let s = 0; s < S; s++) {
      const phi = (s / S) * Math.PI * 2 + (j % 2) * (Math.PI / S);
      d.copy(cd).multiplyScalar(ct).addScaledVector(e1, Math.cos(phi) * st).addScaledVector(e2, Math.sin(phi) * st);
      write(1 + j * S + s, d, minFeature);
    }
    rPrev = r;
    spacing *= k;
    r += spacing;
  }

  // 法线：极坐标网格上的中心差分
  const get = (i: number, out: Vector3) => out.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const a = new Vector3();
  const b = new Vector3();
  const tr = new Vector3();
  const tp = new Vector3();
  const nrm = new Vector3();
  normal[0] = cd.x;
  normal[1] = cd.y;
  normal[2] = cd.z;
  for (let j = 0; j < N; j++) {
    for (let s = 0; s < S; s++) {
      const i = 1 + j * S + s;
      const inner = j === 0 ? 0 : 1 + (j - 1) * S + s;
      const outer = j === N - 1 ? i : 1 + (j + 1) * S + s;
      get(outer, a);
      get(inner, b);
      tr.subVectors(a, b);
      get(1 + j * S + ((s + 1) % S), a);
      get(1 + j * S + ((s - 1 + S) % S), b);
      tp.subVectors(a, b);
      nrm.crossVectors(tr, tp).normalize();
      if (nrm.dot(cd) < 0) nrm.negate();
      normal[i * 3] = nrm.x;
      normal[i * 3 + 1] = nrm.y;
      normal[i * 3 + 2] = nrm.z;
    }
  }
  return {
    id: job.id,
    bodyId: job.bodyId,
    key: '',
    center: [C.x, C.y, C.z],
    centerDir: [cd.x, cd.y, cd.z],
    angularRadius: rMax / R,
    pos,
    normal,
    uv,
    uv1,
  };
}
