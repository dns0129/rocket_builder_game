import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BODIES, BODY_BY_ID, HELIO, MOON_ORBIT, type Body, type BodyId, bodyPosition } from '../physics/bodies';
import type { FlightSim } from '../game/flight';
import type { Prediction } from '../game/predictor';
import { DynLine, PolyBuilder, RingLine, fadeLineMaterial } from './lines';
import { ScreenLabels } from './labels';
import { TRAJ, apsisName, deltaHtml, placeSegments, segColor, segImpactT, type SegPlacement } from './trajectoryView';
import { fmtDist, fmtTime } from '../ui/format';

/** 二维地图的视平面：right/up 为屏幕方向，normal 指向观察者；extent 为半个屏幕高度对应的距离（米）。 */
export interface MapBasis {
  right: THREE.Vector3;
  up: THREE.Vector3;
  normal: THREE.Vector3;
  extent: number;
}

export type MapFocus = BodyId | 'vessel';

const BODY_IDS: BodyId[] = BODIES.map((b) => b.id);
/** 绕上级天体的轨道半径（圆轨道） */
function orbitRadius(b: Body): number {
  return b.id === 'moon' ? MOON_ORBIT.a : (HELIO[b.id]?.a ?? 0);
}
/** 圆在屏幕上的半径（像素）合适时才显示：太小挤成一团，太大则近似直线横穿画面 */
function ringAlpha(rPx: number, max: number): number {
  return THREE.MathUtils.clamp((rPx - 6) / 30, 0, 1) * (1 - THREE.MathUtils.smoothstep(rPx, 2e4, 1e5)) * max;
}
const UP = new THREE.Vector3(0, 1, 0);

/** 屏幕空间星空（二维地图的背景，叠加在大气散射天空上）。 */
const STAR_FRAG = /* glsl */ `
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec3 col = vec3(0.0);
  for (int l = 0; l < 2; l++) {
    float s = l == 0 ? 3.0 : 7.0;
    vec2 q = gl_FragCoord.xy / s;
    vec2 cell = floor(q);
    float h = hash(cell + float(l) * 17.0);
    if (h > (l == 0 ? 0.965 : 0.992)) {
      vec2 c = vec2(hash(cell + 3.1), hash(cell + 7.7));
      float d = length(fract(q) - c) * s;
      float b = pow(hash(cell + 11.3), 3.0) * (l == 0 ? 0.35 : 1.4);
      vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), hash(cell + 5.9));
      col += tint * b * smoothstep(1.3, 0.0, d);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 二维地图：相机始终垂直于飞船的轨道平面俯视，只能平移与缩放（不再三维旋转），
 * 但地球、月球、大气辉光仍用飞行视图同一套三维着色器渲染，保持原来的质感。
 * 画面内容：飞船当前的预测轨迹（带流动光点，不画已飞过的航迹）、1 秒前的幽灵轨迹、月球轨道、影响球、大气层边界，
 * 以及远/近拱点（含变化量）、落点、进出影响球、机动节点等标记。
 */
export class MapView {
  group = new THREE.Group();
  private overlay: HTMLDivElement;
  private labels: ScreenLabels;
  private pb = new PolyBuilder();
  private pred: Record<BodyId, DynLine>;
  private ghost: Record<BodyId, DynLine>;
  private flowMats: LineMaterial[] = [];
  private flowOffset = 0;
  private orbits = new Map<BodyId, RingLine>();
  private soiRings = new Map<BodyId, RingLine>();
  private atmoRings = new Map<BodyId, RingLine>();
  private encRings: RingLine[] = [];
  private allRings: RingLine[] = [];
  private placements: SegPlacement[] = [];
  private stars: THREE.Mesh;
  private lastPred: Prediction | null | undefined = undefined;
  private lastGhost: Prediction | null | undefined = undefined;
  private toolbar: HTMLDivElement;
  private scaleBar: HTMLDivElement;
  private scaleText: HTMLSpanElement;
  private focusBtns = new Map<MapFocus | 'auto', HTMLButtonElement>();
  onFocus: (f: MapFocus | 'auto') => void = () => {};
  onToggle3d: () => void = () => {};
  /** 三维游览模式（围绕天体旋转观察） */
  is3d = false;
  private btn3d!: HTMLButtonElement;
  private hint!: HTMLSpanElement;
  visible = false;

  constructor(overlay: HTMLDivElement) {
    this.overlay = overlay;
    this.labels = new ScreenLabels(overlay);
    const mkSet = (make: () => DynLine) => Object.fromEntries(BODY_IDS.map((id) => [id, make()])) as Record<BodyId, DynLine>;
    // 线宽含两侧各约 1 像素的抗锯齿渐变；流动光点亮度低于泛光阈值，避免泛光把细线糊成一串方块
    this.ghost = mkSet(() => new DynLine([fadeLineMaterial({ width: 1.8, depthTest: false })], 52));
    this.pred = mkSet(() => {
      const flow = fadeLineMaterial({ width: 2.4, depthTest: false, dashed: true });
      flow.color.setScalar(1.35);
      this.flowMats.push(flow);
      return new DynLine([fadeLineMaterial({ width: 6, opacity: 0.1, depthTest: false }), fadeLineMaterial({ width: 2.2, depthTest: false }), flow], 54);
    });
    for (const id of BODY_IDS) for (const l of [this.ghost[id], this.pred[id]]) l.addTo(this.group);

    // 天体轨道（黄道面 / 地球赤道面内的圆）：抗锯齿细线
    const add = (r: RingLine) => {
      r.addTo(this.group);
      this.allRings.push(r);
      return r;
    };
    for (const b of BODIES) {
      const a = orbitRadius(b);
      if (!a) continue;
      const c = new THREE.Color(b.color).lerp(new THREE.Color(0x8a8f99), 0.5);
      const o = add(new RingLine(720, 'xz', c, { width: 1.5 }));
      o.object.scale.setScalar(a);
      this.orbits.set(b.id, o);
    }
    // 影响球与大气层的轮廓：画在视平面内的圆（球体从任何方向看都是圆）
    for (const b of BODIES) {
      if (isFinite(b.soi) && b.parent) {
        const r = add(new RingLine(256, 'xy', b.id === 'moon' ? 0xc49bff : b.color, { width: 1.4, dashed: true }));
        r.object.scale.setScalar(b.soi);
        this.soiRings.set(b.id, r);
      }
      if (b.atmosphere) {
        const r = add(new RingLine(256, 'xy', 0x6fb8ff, { width: 1.4, dashed: true }));
        r.object.scale.setScalar(b.radius + b.atmosphere.height);
        this.atmoRings.set(b.id, r);
      }
    }
    // 相遇时目标天体的位置（虚线圆）
    for (let i = 0; i < 3; i++) this.encRings.push(add(new RingLine(128, 'xy', 0xc49bff, { width: 1.6, dashed: true })));

    const starMat = new THREE.ShaderMaterial({
      // 放在远平面并做深度测试：只出现在没有星球遮挡的地方
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.99999, 1.0); }',
      fragmentShader: STAR_FRAG,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    this.stars = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999.5;
    this.group.add(this.stars);
    this.group.visible = false;

    // 工具栏：切换焦点 + 比例尺
    const btn = (f: MapFocus | 'auto', label: string, title: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => this.onFocus(f));
      this.focusBtns.set(f, b);
      return b;
    };
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'map-toolbar panel';
    this.toolbar.append(btn('auto', '自动', '自动缩放，始终框住整条预测轨迹'), btn('vessel', '飞船', '跟随飞船'));
    const bodies = document.createElement('span');
    bodies.className = 'map-bodies';
    for (const b of BODIES) {
      const e = btn(b.id, b.apsisChar, `以${b.name}为中心（Tab 切换）`);
      e.style.setProperty('--bc', `#${new THREE.Color(b.color).getHexString()}`);
      bodies.append(e);
    }
    this.toolbar.append(bodies);
    this.scaleBar = document.createElement('div');
    this.scaleBar.className = 'map-scale';
    this.scaleText = document.createElement('span');
    const sw = document.createElement('div');
    sw.className = 'map-scale-wrap';
    sw.append(this.scaleBar, this.scaleText);
    this.toolbar.append(sw);
    this.btn3d = document.createElement('button');
    this.btn3d.className = 'map-3d';
    this.btn3d.textContent = '3D';
    this.btn3d.title = '三维游览：拖动旋转、滚轮缩放（点选天体时自动进入）';
    this.btn3d.addEventListener('click', () => this.onToggle3d());
    this.toolbar.append(this.btn3d);
    const hint = (this.hint = document.createElement('span'));
    hint.className = 'map-hint';
    hint.textContent = '拖动平移 · 滚轮缩放';
    this.toolbar.append(hint);
    overlay.appendChild(this.toolbar);
  }

  setResolution(w: number, h: number): void {
    for (const set of [this.ghost, this.pred]) for (const id of BODY_IDS) for (const o of set[id].objects) o.material.resolution.set(w, h);
    for (const r of this.allRings) r.mat.resolution.set(w, h);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.group.visible = v;
    this.overlay.style.display = v ? 'block' : 'none';
    if (!v) this.labels.begin();
  }

  /**
   * 切换三维游览：屏幕空间的星点换成随视角转动的三维星空；
   * 轨迹线与轨道圈参与深度测试，转到星球背面时被星球挡住。
   */
  set3d(on: boolean): void {
    this.is3d = on;
    this.stars.visible = !on;
    this.btn3d.classList.toggle('on', on);
    this.hint.textContent = on ? '拖动旋转 · 滚轮缩放' : '拖动平移 · 滚轮缩放';
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && o !== this.stars) m.depthTest = on;
    });
  }

  setFocusButton(f: MapFocus | 'auto'): void {
    for (const [k, b] of this.focusBtns) b.classList.toggle('on', k === f);
  }

  // ---------------------------------------------------------------- 重建几何（数据变化时）

  private rebuildPred(pred: Prediction | null, lines: Record<BodyId, DynLine>, alpha: number, flat: boolean): void {
    const c = new THREE.Color();
    const place = pred ? placeSegments(pred) : [];
    if (!flat) this.placements = place;
    for (const id of BODY_IDS) {
      const pb = this.pb.clear();
      if (pred) {
        pred.segments.forEach((seg, si) => {
          // 将来才会进入的天体（相遇）：画在相遇时该天体所在的位置
          const { host, off } = place[si];
          if (host !== id) return;
          const n = seg.times.length;
          const impactT = segImpactT(pred, seg);
          const stride = Math.max(1, Math.floor(n / 2000));
          for (let i = 0; i < n; i = i === n - 1 ? n : Math.min(n - 1, i + stride)) {
            segColor(seg, i, impactT, c);
            if (flat) c.copy(TRAJ.ghost);
            if (i === 0 && pb.n) {
              const L = pb.n - 1;
              pb.push(pb.pts[L * 3], pb.pts[L * 3 + 1], pb.pts[L * 3 + 2], c, 0);
              pb.push(seg.pts[0] + off.x, seg.pts[1] + off.y, seg.pts[2] + off.z, c, 0);
            }
            pb.push(seg.pts[i * 3] + off.x, seg.pts[i * 3 + 1] + off.y, seg.pts[i * 3 + 2] + off.z, c, alpha);
          }
        });
        const N = pb.n;
        for (let i = 0; i < N; i++) if (pb.alpha[i] > 0) pb.alpha[i] *= 1 - 0.5 * (i / Math.max(1, N - 1));
      }
      pb.flush(lines[id]);
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(sim: FlightSim, ghost: Prediction | null, origin: THREE.Vector3, camera: THREE.Camera, w: number, h: number, view: MapBasis, dt: number): void {
    this.labels.begin();
    if (!this.visible) return;
    const t = sim.t;
    const pred = sim.destroyed ? null : sim.prediction;
    const bodyW = Object.fromEntries(BODIES.map((b) => [b.id, bodyPosition(b, t, new THREE.Vector3()).sub(origin)])) as Record<BodyId, THREE.Vector3>;

    if (pred !== this.lastPred) {
      this.lastPred = pred;
      this.rebuildPred(pred, this.pred, 1, false);
    }
    const g = pred ? ghost : null;
    if (g !== this.lastGhost) {
      this.lastGhost = g;
      this.rebuildPred(g, this.ghost, 0.45, true);
    }
    for (const id of BODY_IDS) for (const set of [this.ghost, this.pred]) set[id].setPosition(bodyW[id]);
    const V = sim.vessel;
    const vesselW = V.r.clone().sub(origin);

    // 预测轨迹上流动的光点，指示运动方向
    const ext = view.extent;
    const period = ext * 0.1;
    this.flowOffset = (this.flowOffset - ext * 0.12 * dt) % period;
    for (const m of this.flowMats) {
      m.dashSize = ext * 0.014;
      m.gapSize = period - ext * 0.014;
      m.dashOffset = this.flowOffset;
    }

    // 天体轨道、影响球、大气层边界（按屏幕上的大小淡入淡出）
    const mpp = (2 * ext) / Math.max(1, h); // 每像素米数
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(view.right, view.up, view.normal));
    for (const [id, o] of this.orbits) {
      const b = BODY_BY_ID[id];
      o.object.position.copy(bodyW[b.parent!]);
      o.opacity = ringAlpha(orbitRadius(b) / mpp, b.id === sim.targetBody ? 0.75 : 0.4);
    }
    for (const [id, r] of this.soiRings) {
      r.object.position.copy(bodyW[id]);
      r.object.quaternion.copy(q);
      r.opacity = ringAlpha(BODY_BY_ID[id].soi / mpp, 0.4);
    }
    for (const [id, r] of this.atmoRings) {
      const b = BODY_BY_ID[id];
      r.object.position.copy(bodyW[id]);
      r.object.quaternion.copy(q);
      // 放大到能分辨出大气层时才显示其边界
      r.opacity = THREE.MathUtils.clamp(((b.atmosphere?.height ?? 0) / mpp - 3) / 10, 0, 0.5) * (1 - THREE.MathUtils.smoothstep(b.radius / mpp, 2e4, 1e5));
    }
    // 相遇：每个将要进入的天体画一个虚线圆（太小时放大到能看见）
    const place = pred ? this.placements : [];
    const encs: { body: Body; pos: THREE.Vector3; t: number }[] = [];
    if (pred) {
      pred.segments.forEach((sg, i) => {
        const pl = place[i];
        if (!pl || pl.anchor === null || encs.length >= this.encRings.length) return;
        if (i > 0 && pred.segments[i - 1].body === sg.body) return;
        encs.push({ body: sg.body, pos: pl.off.clone().add(bodyW[pl.host]), t: pl.anchor });
      });
    }
    this.encRings.forEach((r, i) => {
      const e = encs[i];
      r.opacity = e ? 0.8 : 0;
      if (!e) return;
      r.object.position.copy(e.pos);
      r.object.quaternion.copy(q);
      r.object.scale.setScalar(Math.max(e.body.radius, mpp * 9));
      r.mat.color.copy(TRAJ[e.body.id]);
    });

    // ---------------------------------------------------------------- 标记
    if (pred) {
      const seen = new Set<string>();
      // 事件位置：所在轨迹段的绘制位置 + 相对天体的位置
      const posOf = (body: Body, time: number, rel: THREE.Vector3) => {
        let k = -1;
        for (let i = 0; i < pred.segments.length; i++) {
          const s = pred.segments[i];
          if (s.body === body && time >= s.times[0] - 1e-6 && time <= s.times[s.times.length - 1] + 1e-6) {
            k = i;
            break;
          }
        }
        const pl = place[k];
        return pl ? rel.clone().add(pl.off).add(bodyW[pl.host]) : rel.clone().add(bodyW[body.id]);
      };
      for (const e of pred.events) {
        const p = posOf(e.body, e.t, e.pos);
        const key = `${e.type}-${e.body.id}-${e.afterNode}`;
        if (e.type === 'ap' || e.type === 'pe') {
          if (seen.has(key)) continue;
          seen.add(key);
          // 轨道在屏幕上缩成一团时不标拱点（例如日心视图中的近地轨道）
          if (e.pos.length() / mpp < 14) continue;
          const d = e.afterNode ? '' : deltaHtml(e, g, t);
          this.labels.add(p, `<b>${apsisName(e.type, e.body)}</b> ${fmtDist(e.alt)}${d}<br><small>${fmtTime(e.t - t)}</small>`, e.afterNode ? 'mk-node' : e.type === 'ap' ? 'mk-ap' : 'mk-pe');
        } else if (e.type === 'soiEnter') {
          this.labels.add(p, `<b>进入${e.body.name}影响球</b><br><small>${fmtTime(e.t - t)}</small>`, 'mk-soi');
        } else if (e.type === 'soiExit') {
          const k = pred.segments.findIndex((s) => s.body === e.body && Math.abs(s.times[0] - e.t) < 1e-3);
          const from = k > 0 ? pred.segments[k - 1].body : null;
          this.labels.add(p, `<b>离开${from ? from.name : ''}影响球</b><br><small>${fmtTime(e.t - t)}</small>`, 'mk-soi');
        } else if (e.type === 'impact') {
          this.labels.add(p, `<b>✖ 撞击${e.body.name}</b><br><small>${fmtTime(e.t - t)}</small>`, 'mk-impact');
        } else if (e.type === 'node') {
          this.labels.add(p, `<b>◆ 机动节点</b><br><small>${fmtTime(e.t - t)}</small>`, 'mk-nodept');
        }
      }
    }
    // 飞船图标：箭头指向机头方向（机头垂直于屏幕时改用速度方向）
    const fwd = UP.clone().applyQuaternion(V.q);
    let sx = fwd.dot(view.right);
    let sy = fwd.dot(view.up);
    if (Math.hypot(sx, sy) < 0.25) {
      const vr = sim.telemetry.vOrbVec;
      sx = vr.dot(view.right);
      sy = vr.dot(view.up);
    }
    const rot = (Math.atan2(sx, sy) * 180) / Math.PI;
    this.labels.add(vesselW, '<svg viewBox="-12 -12 24 24"><path d="M0,-10 L6,7 L0,3.5 L-6,7 Z"/></svg>', 'mk-vessel', rot);
    // 天体名称：与上级天体在屏幕上挤在一起时省略
    for (const b of BODIES) {
      if (b.parent && bodyW[b.id].distanceTo(bodyW[b.parent]) / mpp < 26) continue;
      const tgt = b.id === sim.targetBody;
      const off = Math.max(b.radius * 1.15, mpp * 12);
      this.labels.add(bodyW[b.id].clone().addScaledVector(view.up, -off), tgt ? `◎ ${b.name}` : b.name, tgt ? 'mk-body mk-target' : 'mk-body');
    }
    for (const e of encs) this.labels.add(e.pos.clone().addScaledVector(view.up, Math.max(e.body.radius * 1.3, mpp * 13)), `${e.body.name}（相遇时）<br><small>${fmtTime(e.t - t)} 后</small>`, 'mk-body mk-enc');
    // 三维游览：被星球挡住的标签不显示
    let hidden: ((p: THREE.Vector3) => boolean) | undefined;
    if (this.is3d) {
      const c = camera.position;
      const dir = new THREE.Vector3();
      const oc = new THREE.Vector3();
      const big = BODIES.filter((b) => bodyW[b.id].distanceTo(c) < b.radius * 400);
      hidden = (p) => {
        dir.subVectors(p, c);
        const L = dir.length();
        dir.divideScalar(L);
        for (const b of big) {
          const R = b.radius * 0.995;
          oc.subVectors(c, bodyW[b.id]);
          const bb = oc.dot(dir);
          const disc = bb * bb - (oc.lengthSq() - R * R);
          if (disc <= 0) continue;
          const t0 = -bb - Math.sqrt(disc);
          if (t0 > 0 && t0 < L - R * 0.01) return true;
        }
        return false;
      };
    }
    this.labels.layout(camera, w, h, hidden);

    // 比例尺
    const target = mpp * 110;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((k) => k * pow).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    this.scaleBar.style.width = `${(nice / mpp).toFixed(0)}px`;
    this.scaleText.textContent = fmtDist(nice).replace('.00', '');
  }

  dispose(): void {
    for (const id of BODY_IDS) for (const set of [this.ghost, this.pred]) set[id].dispose();
    for (const r of this.allRings) r.dispose();
    this.labels.dispose();
    this.toolbar.remove();
  }
}
