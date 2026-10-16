import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { MOON, MOON_ORBIT, bodyPosition } from '../physics/bodies';
import type { Prediction } from '../game/predictor';
import { fmtDist, fmtTime } from '../ui/format';

interface Marker {
  el: HTMLDivElement;
  pos: THREE.Vector3; // 世界坐标（相对原点）
  visible: boolean;
}

/** 地图视图：轨迹线、月球轨道、拱点与交会标记。 */
export class MapView {
  group = new THREE.Group();
  private lines: Line2[] = [];
  private mats: Record<string, LineMaterial> = {};
  private moonOrbit: THREE.LineLoop;
  private soiRing: THREE.LineLoop;
  private overlay: HTMLDivElement;
  private markers: Marker[] = [];
  private markerPool: HTMLDivElement[] = [];
  private lastPred: Prediction | null = null;
  visible = false;

  constructor(overlay: HTMLDivElement) {
    this.overlay = overlay;
    const mk = (color: number, width: number, dashed = false) => {
      const m = new LineMaterial({ color, linewidth: width, worldUnits: false, dashed, transparent: true, opacity: 0.95, depthTest: true });
      m.dashSize = 3e5;
      m.gapSize = 2e5;
      return m;
    };
    this.mats = {
      earth: mk(0x57c7ff, 2.2),
      moon: mk(0xc49bff, 2.2),
      node: mk(0xffb040, 2.2),
      nodeMoon: mk(0xff8a3d, 2.2),
    };
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.moonOrbit = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x8a8f99, transparent: true, opacity: 0.45 }));
    this.moonOrbit.scale.setScalar(MOON_ORBIT.a);
    this.moonOrbit.frustumCulled = false;
    this.soiRing = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xc49bff, transparent: true, opacity: 0.25 }));
    this.soiRing.scale.setScalar(MOON.soi);
    this.soiRing.frustumCulled = false;
    this.group.add(this.moonOrbit, this.soiRing);
    this.group.visible = false;
  }

  setResolution(w: number, h: number): void {
    for (const m of Object.values(this.mats)) m.resolution.set(w, h);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.group.visible = v;
    this.overlay.style.display = v ? 'block' : 'none';
  }

  private line(i: number): Line2 {
    while (this.lines.length <= i) {
      const l = new Line2(new LineGeometry(), this.mats.earth);
      l.frustumCulled = false;
      l.renderOrder = 50;
      this.group.add(l);
      this.lines.push(l);
    }
    return this.lines[i];
  }

  update(pred: Prediction | null, t: number, origin: THREE.Vector3, vesselPos: THREE.Vector3, camera: THREE.Camera, w: number, h: number): void {
    if (!this.visible) return;
    const earthW = new THREE.Vector3().sub(origin);
    const moonW = bodyPosition(MOON, t, new THREE.Vector3()).sub(origin);
    this.moonOrbit.position.copy(earthW);
    this.soiRing.position.copy(moonW);
    let li = 0;
    this.clearMarkers();
    if (pred) {
      const rebuild = pred !== this.lastPred;
      this.lastPred = pred;
      for (const seg of pred.segments) {
        const base = seg.body.id === 'moon' ? moonW : earthW;
        const n = seg.pts.length / 3;
        if (n < 2) continue;
        const l = this.line(li++);
        l.visible = true;
        l.position.copy(base);
        if (rebuild) {
          const arr: number[] = [];
          const stride = Math.max(1, Math.floor(n / 1500));
          for (let i = 0; i < n; i += stride) arr.push(seg.pts[i * 3], seg.pts[i * 3 + 1], seg.pts[i * 3 + 2]);
          if ((n - 1) % stride !== 0) arr.push(seg.pts[(n - 1) * 3], seg.pts[(n - 1) * 3 + 1], seg.pts[(n - 1) * 3 + 2]);
          const g = new LineGeometry();
          g.setPositions(arr);
          l.geometry.dispose();
          l.geometry = g;
          l.material = seg.afterNode ? (seg.body.id === 'moon' ? this.mats.nodeMoon : this.mats.node) : seg.body.id === 'moon' ? this.mats.moon : this.mats.earth;
        }
      }
      const seen = new Set<string>();
      for (const e of pred.events) {
        const base = e.body.id === 'moon' ? moonW : earthW;
        const p = e.pos.clone().add(base);
        const key = `${e.type}-${e.body.id}-${e.afterNode}`;
        if (e.type === 'ap' || e.type === 'pe') {
          if (seen.has(key)) continue;
          seen.add(key);
          const nm = e.body.id === 'moon' ? (e.type === 'ap' ? '远月点' : '近月点') : e.type === 'ap' ? '远地点' : '近地点';
          this.addMarker(p, `<b>${nm}</b> ${fmtDist(e.alt)}<br><small>${fmtTime(e.t - t)}</small>`, e.afterNode ? 'mk-node' : e.type === 'ap' ? 'mk-ap' : 'mk-pe');
        } else if (e.type === 'soiEnter') {
          this.addMarker(p, `<b>进入月球 SOI</b><br><small>${fmtTime(e.t - t)}</small>`, 'mk-soi');
        } else if (e.type === 'soiExit') {
          this.addMarker(p, `<b>离开月球 SOI</b>`, 'mk-soi');
        } else if (e.type === 'impact') {
          this.addMarker(p, `<b>✖ 撞击${e.body.name}</b><br><small>${fmtTime(e.t - t)}</small>`, 'mk-impact');
        } else if (e.type === 'node') {
          this.addMarker(p, `<b>◆ 机动节点</b><br><small>${fmtTime(e.t - t)}</small>`, 'mk-nodept');
        }
      }
    }
    for (let i = li; i < this.lines.length; i++) this.lines[i].visible = false;
    this.addMarker(vesselPos.clone(), '▲', 'mk-vessel');
    this.addMarker(earthW.clone(), '地球', 'mk-body');
    this.addMarker(moonW.clone(), '月球', 'mk-body');
    this.layoutMarkers(camera, w, h);
  }

  private clearMarkers(): void {
    for (const m of this.markers) {
      m.el.style.display = 'none';
      this.markerPool.push(m.el);
    }
    this.markers = [];
  }

  private addMarker(pos: THREE.Vector3, html: string, cls: string): void {
    const el = this.markerPool.pop() ?? document.createElement('div');
    if (!el.parentElement) this.overlay.appendChild(el);
    el.className = `map-marker ${cls}`;
    if (el.innerHTML !== html) el.innerHTML = html;
    this.markers.push({ el, pos, visible: true });
  }

  private layoutMarkers(camera: THREE.Camera, w: number, h: number): void {
    const v = new THREE.Vector3();
    for (const m of this.markers) {
      v.copy(m.pos).project(camera);
      if (v.z > 1 || v.z < -1) {
        m.el.style.display = 'none';
        continue;
      }
      m.el.style.display = 'block';
      m.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }
}
