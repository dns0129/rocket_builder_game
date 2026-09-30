import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

export interface FadeLineParams {
  width: number;
  opacity?: number;
  depthTest?: boolean;
  additive?: boolean;
  dashed?: boolean;
}

/**
 * 粗线材质（屏幕像素宽度）+ 逐顶点颜色 + 逐顶点透明度。
 * 透明度通过额外的 instanceAlphaStart/End 属性传入，用来让轨迹线由近及远渐隐。
 */
export function fadeLineMaterial(p: FadeLineParams): LineMaterial {
  const m = new LineMaterial({
    color: 0xffffff,
    linewidth: p.width,
    worldUnits: false,
    vertexColors: true,
    transparent: true,
    opacity: p.opacity ?? 1,
    depthTest: p.depthTest ?? true,
    depthWrite: false,
    dashed: p.dashed ?? false,
  });
  if (p.additive) m.blending = THREE.AdditiveBlending;
  m.vertexShader = m.vertexShader.replace(
    'void main() {',
    'attribute float instanceAlphaStart;\nattribute float instanceAlphaEnd;\nvarying float vFade;\nvoid main() {\n\tvFade = ( position.y < 0.5 ) ? instanceAlphaStart : instanceAlphaEnd;',
  );
  m.fragmentShader = m.fragmentShader
    .replace('void main() {', 'varying float vFade;\nvoid main() {')
    .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );', 'gl_FragColor = vec4( diffuseColor.rgb, alpha * vFade );');
  return m;
}

/**
 * 可频繁更新的折线：预先分配缓冲区，每次 set() 只改写数据，不产生新的 GPU 对象。
 * 同一份几何体可以挂多种材质（例如细亮的芯线 + 宽而淡的光晕）。
 */
export class DynLine {
  geo = new LineSegmentsGeometry();
  objects: LineSegments2[] = [];
  private cap = 0;
  private pos!: Float32Array;
  private col!: Float32Array;
  private alp!: Float32Array;
  private dist!: Float32Array;
  private bufs: THREE.InstancedInterleavedBuffer[] = [];

  constructor(materials: LineMaterial[], renderOrder = 50) {
    this.ensure(64);
    for (const m of materials) {
      const o = new LineSegments2(this.geo, m);
      o.frustumCulled = false;
      o.renderOrder = renderOrder++;
      o.visible = false;
      this.objects.push(o);
    }
  }

  addTo(parent: THREE.Object3D): void {
    for (const o of this.objects) parent.add(o);
  }

  set visible(v: boolean) {
    for (const o of this.objects) o.visible = v;
  }

  get visible(): boolean {
    return this.objects[0].visible;
  }

  get position(): THREE.Vector3 {
    return this.objects[0].position;
  }

  setPosition(p: THREE.Vector3): void {
    for (const o of this.objects) o.position.copy(p);
  }

  private ensure(segs: number): void {
    if (segs <= this.cap) return;
    let cap = Math.max(64, this.cap);
    while (cap < segs) cap *= 2;
    this.cap = cap;
    this.pos = new Float32Array(cap * 6);
    this.col = new Float32Array(cap * 6);
    this.alp = new Float32Array(cap * 2);
    this.dist = new Float32Array(cap * 2);
    // three.js 在首次绑定时缓存最大实例数，扩容后必须换一个新的几何体
    const old = this.geo;
    const g = (this.geo = new LineSegmentsGeometry());
    for (const o of this.objects) o.geometry = g;
    old.dispose();
    const mk = (arr: Float32Array, stride: number) => {
      const b = new THREE.InstancedInterleavedBuffer(arr, stride, 1);
      b.setUsage(THREE.DynamicDrawUsage);
      return b;
    };
    const pb = mk(this.pos, 6);
    const cb = mk(this.col, 6);
    const ab = mk(this.alp, 2);
    const db = mk(this.dist, 2);
    g.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(pb, 3, 0));
    g.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(pb, 3, 3));
    g.setAttribute('instanceColorStart', new THREE.InterleavedBufferAttribute(cb, 3, 0));
    g.setAttribute('instanceColorEnd', new THREE.InterleavedBufferAttribute(cb, 3, 3));
    g.setAttribute('instanceAlphaStart', new THREE.InterleavedBufferAttribute(ab, 1, 0));
    g.setAttribute('instanceAlphaEnd', new THREE.InterleavedBufferAttribute(ab, 1, 1));
    g.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(db, 1, 0));
    g.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(db, 1, 1));
    this.bufs = [pb, cb, ab, db];
  }

  /**
   * 设置折线的 n 个顶点：pts 为 (x,y,z)*n，col 为 (r,g,b)*n，alpha 为 n 个值。
   * n < 2 时隐藏。
   */
  set(n: number, pts: ArrayLike<number>, col: ArrayLike<number>, alpha: ArrayLike<number>): void {
    const segs = n - 1;
    if (segs < 1) {
      this.visible = false;
      return;
    }
    this.ensure(segs);
    const P = this.pos;
    const C = this.col;
    const A = this.alp;
    const D = this.dist;
    let d = 0;
    for (let i = 0; i < segs; i++) {
      const a = i * 3;
      const b = a + 3;
      const o = i * 6;
      P[o] = pts[a];
      P[o + 1] = pts[a + 1];
      P[o + 2] = pts[a + 2];
      P[o + 3] = pts[b];
      P[o + 4] = pts[b + 1];
      P[o + 5] = pts[b + 2];
      C[o] = col[a];
      C[o + 1] = col[a + 1];
      C[o + 2] = col[a + 2];
      C[o + 3] = col[b];
      C[o + 4] = col[b + 1];
      C[o + 5] = col[b + 2];
      A[i * 2] = alpha[i];
      A[i * 2 + 1] = alpha[i + 1];
      const dx = pts[b] - pts[a];
      const dy = pts[b + 1] - pts[a + 1];
      const dz = pts[b + 2] - pts[a + 2];
      D[i * 2] = d;
      d += Math.sqrt(dx * dx + dy * dy + dz * dz);
      D[i * 2 + 1] = d;
    }
    for (const b of this.bufs) {
      b.clearUpdateRanges();
      b.addUpdateRange(0, segs * b.stride);
      b.needsUpdate = true;
    }
    this.geo.instanceCount = segs;
    this.visible = true;
  }

  dispose(): void {
    for (const o of this.objects) o.removeFromParent();
    this.geo.dispose();
  }
}

/** 构建折线数据的小工具：逐点追加位置、颜色、透明度。 */
export class PolyBuilder {
  pts: number[] = [];
  col: number[] = [];
  alpha: number[] = [];
  get n(): number {
    return this.alpha.length;
  }
  clear(): this {
    this.pts.length = 0;
    this.col.length = 0;
    this.alpha.length = 0;
    return this;
  }
  push(x: number, y: number, z: number, c: THREE.Color, a: number): void {
    this.pts.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.alpha.push(a);
  }
  flush(line: DynLine): void {
    line.set(this.n, this.pts, this.col, this.alpha);
  }
}
