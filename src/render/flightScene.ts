import * as THREE from 'three';
import { AU, BODIES, BODY_BY_ID, EARTH, HELIO, MOON_ORBIT, SUN, VENUS, type Body, type BodyId, atmoDensity, bodyPosition, bodyRotation, bodyVelocity, dominantBody, sunDirection, surfaceVelocity, toBodyFixed } from '../physics/bodies';
import type { FlightSim, FlightEvent } from '../game/flight';
import type { Prediction } from '../game/predictor';
import { ATMO_LOOK, NIGHT_LIGHT, NIGHT_TINT, Planets, SUN_INTENSITY, setActiveAtmosphere, sharedUniforms, sunlightFactor } from './planets';
import type { PlanetMaps } from './planetBake';
import { TerrainPatch } from './terrainPatch';
import { LaunchPad } from './launchpad';
import { VesselView } from './vesselView';
import { Particles, ReentryGlow } from './effects';
import { SeparationFx } from './separation';
import { MapView, type MapBasis, type MapFocus } from './mapView';
import { FlightTrajectory, PredictionHistory, bodyChain, placeSegments } from './trajectoryView';
import type { RenderEngine } from './engine';

export type CamMode = 'orbit' | 'chase' | 'free';

/** 太阳光晕的基础颜色（HDR） */
const GLOW_BASE = new THREE.Color(3.2, 2.6, 1.9);

/** 半球光：各天体的天空色与地面反照色 */
const HEMI_LOOK: Partial<Record<BodyId, { sky: THREE.Color; ground: THREE.Color; k: number }>> = {
  earth: { sky: new THREE.Color(0.35, 0.5, 0.85), ground: new THREE.Color(0.25, 0.3, 0.38), k: 0.15 },
  moon: { sky: new THREE.Color(0, 0, 0), ground: new THREE.Color(0.35, 0.35, 0.34), k: 0.25 },
  mercury: { sky: new THREE.Color(0, 0, 0), ground: new THREE.Color(0.36, 0.34, 0.32), k: 0.25 },
  mars: { sky: new THREE.Color(0.75, 0.55, 0.4), ground: new THREE.Color(0.45, 0.24, 0.14), k: 0.2 },
  venus: { sky: new THREE.Color(0.8, 0.62, 0.36), ground: new THREE.Color(0.45, 0.32, 0.18), k: 0.25 },
};

const UP = new THREE.Vector3(0, 1, 0);
/** 二维地图相机的基准视场角：远处的长焦相机近似正投影，但保留大气辉光等透视效果 */
const MAP_FOV = (10 * Math.PI) / 180;
const MAP_MIN_EXTENT = 1_500;
const MAP_MAX_EXTENT = 2.5e11;

/** 飞行场景：浮动原点、相机、光照、特效与地图视图。 */
export class FlightScene {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 0.3, 1e13);
  planets: Planets;
  patch: TerrainPatch;
  pad: LaunchPad | null = null;
  vesselView: VesselView;
  debrisViews = new Map<number, THREE.Group>();
  particles: Particles;
  glow = new ReentryGlow();
  sepFx: SeparationFx;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  engineLight: THREE.PointLight;
  map: MapView;
  traj: FlightTrajectory;
  history = new PredictionHistory();
  private trajOverlay: HTMLDivElement;
  mode: 'flight' | 'map' = 'flight';
  camMode: CamMode = 'orbit';
  origin = new THREE.Vector3();
  camYaw = 2.4;
  camPitch = 0.12;
  camDist = 30;
  /** 二维地图：半个屏幕高度对应的距离（米）、平移量（视平面坐标）、视平面基向量 */
  mapExtent = 3e6;
  mapPan = new THREE.Vector2();
  mapFocus: 'auto' | MapFocus = 'auto';
  /** 地图中的三维游览：围绕焦点天体旋转观察（拖动旋转、滚轮缩放）。在地图里选中某个天体时默认开启 */
  map3d = false;
  private orbYaw = 0;
  private orbPitch = 0.4;
  private orbDist = 1;
  private orbDistTarget = 1;
  private mapNormal = new THREE.Vector3(0, 1, 0);
  private mapRight = new THREE.Vector3(1, 0, 0);
  private mapUp = new THREE.Vector3(0, 0, -1);
  private mapSnap = true;
  /** 自动视图：平移/缩放自动框住预测轨迹（手动拖动或缩放后关闭） */
  private mapAutoFit = true;
  /** 自动视图下的屏幕“上”方向（打开地图时飞船的当地竖直方向），为 null 时太阳在右侧 */
  private mapUpRef: THREE.Vector3 | null = null;
  private fitPred: Prediction | null | undefined = undefined;
  private fitPan = new THREE.Vector2();
  private fitExtent = 0;
  private mapBasis: MapBasis | null = null;
  time = 0;
  private sim: FlightSim;
  private engine: RenderEngine;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envMat: THREE.ShaderMaterial;
  private envTimer = 99;
  private envSig: number[] | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private emitAcc = new Map<string, number>();
  /** 上一帧正在工作的发动机（用于点火闪光） */
  private firing = new Set<string>();
  private vesselHidden = false;
  shake = 0;

  constructor(engine: RenderEngine, maps: PlanetMaps, sim: FlightSim, mapOverlay: HTMLDivElement) {
    this.engine = engine;
    this.sim = sim;
    this.particles = new Particles(engine.quality);
    this.planets = new Planets(maps, engine.quality);
    this.planets.addTo(this.scene);
    this.patch = new TerrainPatch(maps);
    this.scene.add(this.patch.mesh);
    const b = sim.vessel.bounds();
    const height = b.maxY - b.minY;
    if (sim.scenario === 'pad') {
      this.pad = new LaunchPad(height, b.radius);
      this.scene.add(this.pad.group);
    }
    this.vesselView = new VesselView(sim.vessel.layout);
    this.scene.add(this.vesselView.group);
    this.particles.addTo(this.scene);
    this.sepFx = new SeparationFx(this.scene, this.particles, sim);
    this.scene.add(this.glow.mesh);
    this.camDist = Math.max(12, height * 1.6);

    this.sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
    this.sun.castShadow = engine.quality !== 'low';
    this.sun.shadow.mapSize.setScalar(engine.quality === 'high' ? 4096 : 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x8fb4ff, 0x4a4036, 0.4);
    this.scene.add(this.hemi);
    this.engineLight = new THREE.PointLight(0xffa050, 0, 400, 2);
    this.scene.add(this.engineLight);

    this.map = new MapView(mapOverlay);
    this.map.onFocus = (f) => this.setMapFocus(f);
    this.map.onToggle3d = () => this.toggleMap3d();
    this.scene.add(this.map.group);
    // 飞行视图的轨迹标签（远地点、落点）放在界面层之下
    this.trajOverlay = document.createElement('div');
    this.trajOverlay.className = 'traj-overlay';
    mapOverlay.parentElement?.insertBefore(this.trajOverlay, mapOverlay.nextSibling);
    this.traj = new FlightTrajectory(this.trajOverlay);
    this.scene.add(this.traj.group);
    engine.onResize((w, h) => {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.map.setResolution(w, h);
      this.traj.setResolution(w, h);
    });

    // 环境反射：天空/地面渐变
    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uSky: { value: new THREE.Color() }, uGround: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() }, uUp: { value: new THREE.Vector3(0, 1, 0) } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 uSky; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uUp; varying vec3 vD; void main(){ float h = dot(normalize(vD), uUp); vec3 c = mix(uGround, uSky, smoothstep(-0.08, 0.12, h)); c += uSunCol * pow(max(dot(normalize(vD), uSunDir), 0.0), 600.0) * 40.0; gl_FragColor = vec4(c, 1.0); }',
    });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.envMat));
  }

  // ---------------------------------------------------------------- 事件

  handleEvents(events: FlightEvent[]): void {
    const sim = this.sim;
    for (const e of events) {
      if (e.type === 'decouple' && e.debrisId !== undefined) {
        const d = sim.debris.find((x) => x.id === e.debrisId);
        if (d) {
          const g = this.vesselView.detach(d.parts.map((p) => p.key));
          this.scene.add(g);
          this.debrisViews.set(d.id, g);
          this.sepFx.onDecouple(d, g, this.vesselView);
        }
        this.shake = Math.max(this.shake, 0.45);
      } else if (e.type === 'debrisGone' && e.debrisId !== undefined) {
        const g = this.debrisViews.get(e.debrisId);
        if (g) {
          this.scene.remove(g);
          this.debrisViews.delete(e.debrisId);
        }
        this.sepFx.onDebrisGone(e.debrisId);
      } else if (e.type === 'explosion' && e.pos) {
        const body = dominantBody(e.pos, sim.t);
        const alt = e.pos.distanceTo(bodyPosition(body, sim.t, new THREE.Vector3())) - body.radius;
        const vel = surfaceVelocity(body, sim.t, e.pos, new THREE.Vector3());
        const d = e.debrisId !== undefined ? sim.debris.find((x) => x.id === e.debrisId) : null;
        this.particles.explode(e.pos, vel, e.size ?? 4, atmoDensity(body, alt) > 0.001);
        if (e.debrisId !== undefined) {
          const g = this.debrisViews.get(e.debrisId);
          if (g) g.visible = false;
        }
        if (!d && e.debrisId === undefined) {
          this.vesselView.group.visible = false;
          this.vesselHidden = true;
        }
        this.shake = Math.max(this.shake, 1.2);
      }
    }
  }

  // ---------------------------------------------------------------- 输入

  orbitCamera(dx: number, dy: number): void {
    if (this.mode === 'map' && this.map3d) {
      // 三维游览：拖动旋转视角
      this.orbYaw += dx * 0.006;
      this.orbPitch = Math.max(-1.5, Math.min(1.5, this.orbPitch + dy * 0.006));
    } else if (this.mode === 'map') {
      // 二维地图：拖动即平移
      const mpp = (2 * this.mapExtent) / Math.max(1, this.engine.height);
      this.mapPan.x -= dx * mpp;
      this.mapPan.y += dy * mpp;
      if (dx || dy) this.mapAutoFit = false;
    } else {
      this.camYaw -= dx * 0.005;
      this.camPitch = Math.max(-1.45, Math.min(1.45, this.camPitch + dy * 0.005));
    }
  }

  /** 滚轮缩放；地图中以光标所在点为中心缩放。 */
  zoom(delta: number, sx?: number, sy?: number): void {
    const f = Math.exp(delta * 0.0012);
    if (this.mode === 'map' && this.map3d) {
      this.orbDistTarget = Math.max(this.orbMinDist(), Math.min(MAP_MAX_EXTENT * 4, this.orbDistTarget * f));
    } else if (this.mode === 'map') {
      const e0 = this.mapExtent;
      const e1 = Math.max(MAP_MIN_EXTENT, Math.min(MAP_MAX_EXTENT, e0 * f));
      if (sx !== undefined && sy !== undefined) {
        const w = this.engine.width;
        const h = this.engine.height;
        const u = ((sx / w) * 2 - 1) * e0 * (w / h);
        const v = (1 - (sy / h) * 2) * e0;
        const k = e1 / e0;
        this.mapPan.x += u * (1 - k);
        this.mapPan.y += v * (1 - k);
      }
      this.mapExtent = e1;
      this.mapAutoFit = false;
    } else {
      const b = this.sim.vessel.bounds();
      const size = Math.max(b.maxY - b.minY, b.radius * 2);
      this.camDist = Math.max(size * 0.6, Math.min(20_000, this.camDist * f));
    }
  }

  mapFocusBody(): MapFocus {
    if (this.mapFocus !== 'auto') return this.mapFocus;
    return this.sim.telemetry.body.id;
  }

  cycleMapFocus(): void {
    // 当前天体 → 目标天体 → 太阳 → 飞船 → 当前天体……
    const tel = this.sim.telemetry;
    const order: MapFocus[] = [tel.body.id];
    const tgt = this.sim.targetBody;
    if (tgt && !order.includes(tgt)) order.push(tgt);
    if (!order.includes('sun')) order.push('sun');
    order.push('vessel');
    const i = order.indexOf(this.mapFocusBody());
    this.setMapFocus(order[(i + 1) % order.length]);
  }

  /** 是否在天体表面附近做亚轨道飞行（上升段、再入、着陆）。 */
  private nearGround(): boolean {
    const tel = this.sim.telemetry;
    return tel.orbit.peAlt < (tel.body.atmosphere?.height ?? 8_000) && tel.alt < tel.body.radius * 0.6 && !tel.orbit.hyperbolic;
  }

  /** 三维游览时相机离焦点的最近距离（不钻进星球里） */
  private orbMinDist(): number {
    const f = this.mapFocusBody();
    return f === 'vessel' ? 30 : BODY_BY_ID[f].radius * 1.12;
  }

  /** 二维地图 ↔ 三维游览。自动视图下切到三维时，以飞船所在的天体为焦点。 */
  toggleMap3d(): void {
    this.setMapFocus(this.mapFocusBody(), !this.map3d);
  }

  /** 进入三维游览：从太阳一侧斜着看过去（大半个星球是亮的），星球约占画面高度的六成。 */
  private initOrbit(): void {
    const sim = this.sim;
    const f = this.mapFocusBody();
    const center = f === 'vessel' ? sim.vessel.r.clone() : bodyPosition(BODY_BY_ID[f], sim.t, new THREE.Vector3());
    const sd = f === 'sun' ? new THREE.Vector3(1, 0, 0) : sunDirection(center, sim.t, new THREE.Vector3());
    // 从太阳一侧偏开约 60°：大半个星球是亮的，一侧露出晨昏线，低角度的光让地形起伏更立体
    this.orbYaw = Math.atan2(sd.z, sd.x) - 1.05;
    this.orbPitch = 0.38;
    // 星球约占画面高度的 60%，四周留出星空背景；土星要把光环也框进来
    const k = f === 'saturn' ? 7.5 : f === 'sun' ? 5 : 4.6;
    const d = f === 'vessel' ? Math.max(200, this.defaultMapExtent('vessel') * 2.2) : BODY_BY_ID[f].radius * k;
    this.orbDist = this.orbDistTarget = d;
  }

  /** 切换地图焦点；'auto' 为自动视图：始终框住整条预测轨迹。view3d 不给时，选中天体进入三维游览，其余为二维地图。 */
  setMapFocus(f: MapFocus | 'auto', view3d?: boolean): void {
    this.mapPan.set(0, 0);
    this.fitPred = undefined;
    if (f === 'auto') {
      this.mapFocus = 'auto';
      this.mapAutoFit = true;
      // 上升段：让打开地图时的当地竖直方向朝上，弹道像二维火箭游戏一样从地平线升起
      const tel = this.sim.telemetry;
      this.mapUpRef = this.nearGround() ? tel.up.clone() : null;
    } else {
      this.mapFocus = f;
      this.mapAutoFit = false;
      this.mapUpRef = null;
    }
    this.mapExtent = this.defaultMapExtent(this.mapFocusBody());
    this.map3d = view3d ?? (f !== 'auto' && f !== 'vessel');
    if (this.map3d) {
      // 三维游览没有“自动”视图
      if (f === 'auto') {
        this.mapFocus = this.mapFocusBody();
        this.mapAutoFit = false;
      }
      this.initOrbit();
    }
    this.map.set3d(this.map3d);
  }

  /** 自动视图的目标：框住飞船、预测轨迹（上升段还包括已飞过的航迹）。 */
  private computeFit(): void {
    const sim = this.sim;
    const t = sim.t;
    const f = this.mapFocusBody();
    const center = f === 'vessel' ? sim.vessel.r.clone() : bodyPosition(BODY_BY_ID[f], t, new THREE.Vector3());
    const R = this.mapRight;
    const U = this.mapUp;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const add = (x: number, y: number, z: number) => {
      const dx = x - center.x;
      const dy = y - center.y;
      const dz = z - center.z;
      const u = dx * R.x + dy * R.y + dz * R.z;
      const v = dx * U.x + dy * U.y + dz * U.z;
      x0 = Math.min(x0, u);
      x1 = Math.max(x1, u);
      y0 = Math.min(y0, v);
      y1 = Math.max(y1, v);
    };
    const V = sim.vessel.r;
    add(V.x, V.y, V.z);
    const base = new THREE.Vector3();
    const pred = sim.destroyed ? null : sim.prediction;
    if (pred && pred.segments.length) {
      const place = placeSegments(pred);
      const chain = bodyChain(pred.segments[0].body);
      let visited = false;
      for (let si = 0; si < pred.segments.length; si++) {
        const seg = pred.segments[si];
        // 飞往其他天体途中：框到相遇段为止（之后的飞掠弹道不计入）
        if (visited && chain.has(seg.body.id)) break;
        if (!chain.has(seg.body.id)) visited = true;
        const pl = place[si];
        bodyPosition(BODY_BY_ID[pl.host], t, base).add(pl.off);
        const n = seg.times.length;
        const stride = Math.max(1, Math.floor(n / 400));
        for (let i = 0; i < n; i += stride) add(seg.pts[i * 3] + base.x, seg.pts[i * 3 + 1] + base.y, seg.pts[i * 3 + 2] + base.z);
      }
    }
    const tr = sim.trail.last;
    if (tr && this.nearGround() && tr.body === sim.telemetry.body) {
      bodyPosition(tr.body, t, base);
      const n = tr.times.length;
      const stride = Math.max(1, Math.floor(n / 400));
      for (let i = 0; i < n; i += stride) add(tr.pts[i * 3] + base.x, tr.pts[i * 3 + 1] + base.y, tr.pts[i * 3 + 2] + base.z);
    }
    const aspect = this.engine.width / Math.max(1, this.engine.height);
    // 屏幕四周都有界面面板，多留一些边距
    const ext = Math.max((y1 - y0) / 2, (x1 - x0) / 2 / aspect) * 1.6;
    const min = sim.landed ? 60_000 : 20_000;
    this.fitExtent = Math.max(min, Math.min(MAP_MAX_EXTENT, ext));
    this.fitPan.set((x0 + x1) / 2, (y0 + y1) / 2);
  }

  private defaultMapExtent(f: MapFocus): number {
    const tel = this.sim.telemetry;
    if (f === 'vessel') {
      const top = Math.max(tel.alt, isFinite(tel.orbit.apAlt) && tel.orbit.apAlt > 0 ? tel.orbit.apAlt : 0);
      return Math.max(25_000, Math.min(tel.body.radius * 1.2, top * 1.4 + 30_000));
    }
    const body = BODY_BY_ID[f];
    const o = tel.orbit;
    if (tel.body === body && !o.hyperbolic && isFinite(o.ap)) return Math.max(body.radius * 1.35, Math.min(MAP_MAX_EXTENT, o.ap * 1.2));
    if (f === 'sun') {
      // 太阳：框住飞船与目标行星的轨道
      const tgt = this.sim.targetBody ? HELIO[this.sim.targetBody]?.a ?? 0 : 0;
      const ship = this.sim.vessel.r.distanceTo(bodyPosition(SUN, this.sim.t, new THREE.Vector3()));
      return Math.min(MAP_MAX_EXTENT, Math.max(tgt, ship, AU * 0.5) * 1.25);
    }
    if (f === 'earth' && (tel.body.id === 'moon' || o.hyperbolic || o.ap > MOON_ORBIT.a * 0.3)) return MOON_ORBIT.a * 1.15;
    return body.radius * (f === 'earth' ? 1.6 : 3);
  }

  setMode(m: 'flight' | 'map'): void {
    this.mode = m;
    this.map.setVisible(m === 'map');
    this.traj.setVisible(m === 'flight');
    if (m === 'map') {
      this.mapSnap = true;
      this.setMapFocus('auto');
    }
  }

  /** 地图视平面：法向取飞船相对焦点天体的轨道角动量方向（平滑过渡），屏幕“上”方向随焦点而定。 */
  private updateMapBasis(dt: number): MapBasis {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    const f = this.mapFocusBody();
    const ref = f === 'vessel' ? tel.body : BODY_BY_ID[f];
    const rel = V.r.clone().sub(bodyPosition(ref, sim.t, new THREE.Vector3()));
    const vrel = V.v.clone().sub(bodyVelocity(ref, sim.t, new THREE.Vector3()));
    const hv = rel.clone().cross(vrel);
    const n = this.mapNormal;
    const snap = this.mapSnap;
    const target = n.clone();
    if (vrel.length() > 1 && hv.length() > 0.05 * rel.length() * vrel.length()) {
      target.copy(hv).normalize();
      if (!snap && target.dot(n) < 0) target.negate();
    } else if (snap && Math.abs(n.y) < 0.5) target.set(0, 1, 0);
    const k = snap ? 1 : 1 - Math.exp(-dt * 2.5);
    n.applyQuaternion(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(n, target), k)).normalize();
    // 屏幕右方：跟随飞船时让当地“上”朝上；自动视图的上升段保持打开地图时的竖直方向；看天体时让太阳在右侧
    const want = new THREE.Vector3();
    if (f === 'vessel') want.copy(rel).normalize().cross(n);
    else if (this.mapUpRef) want.copy(this.mapUpRef).cross(n);
    else if (ref.id === 'sun') want.set(1, 0, 0);
    else sunDirection(bodyPosition(ref, sim.t, new THREE.Vector3()), sim.t, want);
    want.addScaledVector(n, -want.dot(n));
    if (want.lengthSq() < 0.01) want.set(1, 0, 0).addScaledVector(n, -n.x);
    want.normalize();
    const r = this.mapRight.addScaledVector(n, -this.mapRight.dot(n));
    if (r.lengthSq() < 1e-6 || snap) r.copy(want);
    else {
      r.normalize();
      const ang = Math.atan2(new THREE.Vector3().crossVectors(r, want).dot(n), r.dot(want));
      r.applyAxisAngle(n, ang * (1 - Math.exp(-dt * 3)));
    }
    r.normalize();
    this.mapUp.crossVectors(n, r).normalize();
    // 自动视图：预测轨迹更新时重新计算目标，平滑地移过去
    if (this.mapAutoFit) {
      const pred = this.sim.prediction;
      if (pred !== this.fitPred || snap) {
        this.fitPred = pred;
        this.computeFit();
      }
      const kf = snap ? 1 : 1 - Math.exp(-dt * 2.5);
      this.mapPan.lerp(this.fitPan, kf);
      this.mapExtent += (this.fitExtent - this.mapExtent) * kf;
    }
    this.map.setFocusButton(this.mapAutoFit ? 'auto' : this.mapFocusBody());
    this.mapSnap = false;
    return { right: this.mapRight, up: this.mapUp, normal: n, extent: this.mapExtent };
  }

  // ---------------------------------------------------------------- 每帧

  update(dtReal: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    const t = sim.t;
    this.time += dtReal;
    // 粒子与模拟使用同一时间步长（低帧率时模拟会限制步长，否则烟雾会跑到火箭前面）
    const fxDt = Math.min(sim.lastSimDt, 0.25);

    // 浮动原点
    if (this.mode === 'map') {
      const f = this.mapFocusBody();
      if (f === 'vessel') this.origin.copy(V.r);
      else bodyPosition(BODY_BY_ID[f], t, this.origin);
    } else {
      this.origin.copy(V.r);
    }
    const origin = this.origin;

    // 天体
    this.planets.updateBodies(t, origin);
    this.planets.cloudMat.uniforms.uModelRot.value.copy(this.planets.earthMat.uniforms.uModelRot.value);
    const cloudOff = (t * 2e-6) % 1;
    this.planets.earthMat.uniforms.uCloudOffset.value = cloudOff;
    this.planets.cloudMat.uniforms.uCloudOffset.value = cloudOff;

    // 地形补丁
    const body = tel.body;
    if (this.mode === 'flight' && body.kind === 'rocky') {
      const shipBf = toBodyFixed(body, t, V.r);
      this.patch.update(body, t, shipBf, Math.max(0, tel.radarAlt), origin);
    } else {
      this.patch.mesh.visible = false;
      this.patch.active = false;
    }
    const pdir = new THREE.Vector3();
    if (this.patch.active && this.patch.body) {
      pdir.copy(this.patch.centerDir).applyAxisAngle(UP, bodyRotation(this.patch.body, t));
      this.planets.setPatch(this.patch.body.id, pdir, Math.cos(this.patch.angularRadius * 0.97));
    } else this.planets.setPatch(null, pdir, 2);
    if (this.pad) {
      this.pad.update(t, origin);
      const padDist = this.pad.group.position.length();
      this.pad.group.visible = padDist < 400_000 && this.mode === 'flight';
    }

    // 飞船
    const vOrigin = V.r.clone().sub(V.com.clone().applyQuaternion(V.q));
    this.vesselView.group.position.copy(vOrigin).sub(origin);
    this.vesselView.group.quaternion.copy(V.q);
    this.vesselView.group.visible = !this.vesselHidden && !sim.destroyed;
    this.vesselView.group.updateMatrixWorld(true);
    this.vesselView.setLegs(V.legDeploy);
    const vAir = V.v.clone().sub(surfaceVelocity(body, t, V.r, new THREE.Vector3()));
    this.vesselView.setChute(V.chuteState, V.chuteDeploy, sim.landed ? null : vAir, V.q);
    if (sim.landed) {
      for (const pv of this.vesselView.parts.values()) if (pv.visual.canopy) pv.visual.canopy.visible = false;
    }
    for (const d of sim.debris) {
      const g = this.debrisViews.get(d.id);
      if (!g) continue;
      const o = d.r.clone().sub(d.com.clone().applyQuaternion(d.q));
      g.position.copy(o).sub(origin);
      g.quaternion.copy(d.q);
    }
    this.sepFx.update(fxDt, this.time, origin);

    // 尾焰、灯光、烟
    const pAlt = tel.alt;
    const pRatio = body.atmosphere ? Math.exp(-pAlt / body.atmosphere.scaleHeight) * (pAlt < body.atmosphere.height ? 1 : 0) : 0;
    let totalThrust = 0;
    const lightPos = new THREE.Vector3();
    let lightW = 0;
    const tmp = new THREE.Vector3();
    const cmd = sim.controlCmd;
    for (const [key, pv] of this.vesselView.parts) {
      const rp = V.byKey.get(key);
      if (!rp) continue;
      const eng = rp.p.def.engine;
      const thr = rp.thrustNow > 0 ? rp.throttleEff : 0;
      // 尾翼方向舵随控制指令偏转（最大 20°）
      if (pv.visual.flaps.length) {
        const off = pv.placed.radial ? pv.placed.angle : 0;
        const k = Math.min(1, dtReal * 12);
        for (const f of pv.visual.flaps) {
          const a = f.angle + off;
          const target = 0.35 * Math.max(-1, Math.min(1, -(cmd.x * Math.cos(a) + cmd.z * Math.sin(a)) - 0.5 * cmd.y));
          f.rot.rotation.x += (target - f.rot.rotation.x) * k;
        }
      }
      // 点火瞬间的闪光
      if (thr > 0 && !this.firing.has(key)) this.ignitionFlash(pv, rp.thrustNow, V.v, body);
      if (thr > 0) this.firing.add(key);
      else this.firing.delete(key);
      for (let i = 0; i < pv.plumes.length; i++) {
        pv.plumes[i].update(thr, pRatio, this.time + i * 1.7);
        const bell = pv.visual.bells[i];
        if (eng && eng.gimbal > 0) {
          const g = (eng.gimbal * Math.PI) / 180;
          bell.pivot.rotation.set(-cmd.x * g * 0.8, 0, cmd.z * g * 0.8);
        }
        if (thr > 0) {
          bell.pivot.getWorldPosition(tmp);
          lightPos.addScaledVector(tmp, rp.thrustNow);
          lightW += rp.thrustNow;
        }
      }
      totalThrust += rp.thrustNow;
      if (thr > 0 && eng) this.emitExhaust(key, rp.thrustNow, eng.plume, pv, fxDt, body);
    }
    if (lightW > 0) {
      lightPos.divideScalar(lightW);
      const down = UP.clone().applyQuaternion(V.q).multiplyScalar(-4);
      this.engineLight.position.copy(lightPos).add(down);
      this.engineLight.intensity = 900 * Math.sqrt(totalThrust / 1e6) * (0.9 + 0.2 * Math.random());
    } else this.engineLight.intensity = 0;

    // 再入等离子体
    const heat = sim.telemetry.heatFlux;
    const gi = Math.max(0, Math.min(2.5, (heat - 25_000) / 120_000));
    this.glow.mesh.visible = gi > 0.01 && !sim.destroyed && this.mode === 'flight';
    if (this.glow.mesh.visible) {
      const b = V.bounds();
      const size = Math.max(b.maxY - b.minY, b.radius * 2);
      const vd = vAir.clone().normalize();
      const w = b.radius * 1.35 + 0.3;
      this.glow.mesh.position.copy(vd).multiplyScalar(size * 0.35);
      this.glow.mesh.quaternion.setFromUnitVectors(UP, vd);
      this.glow.mesh.scale.set(w, Math.max(w, size * 0.6), w);
      this.glow.set(gi * 1.6, this.time);
      if (Math.random() < gi * 0.8) {
        const p = V.r.clone().addScaledVector(vAir.clone().normalize(), -size * 0.3).add(new THREE.Vector3((Math.random() - 0.5) * size * 0.4, (Math.random() - 0.5) * size * 0.4, (Math.random() - 0.5) * size * 0.4));
        this.particles.emit({ pos: p, vel: V.v.clone().addScaledVector(vAir, -0.02), life: 0.8, size0: size * 0.4, size1: size * 0.1, color: new THREE.Color(6, 2.2, 0.8), alpha: 0.9, drag: 3, glow: true, cool: true });
      }
    }

    // 粒子
    const windBody = body;
    const windTmp = new THREE.Vector3();
    this.particles.update(
      fxDt,
      origin,
      (x, y, z, out) => {
        windTmp.set(x, y, z);
        surfaceVelocity(windBody, t, windTmp, out);
      },
      this.smokeLight,
    );

    this.updateLights(dtReal);
    this.updateCamera(dtReal);

    // 共享 uniform：太阳方向（从相机看）、当前启用的大气
    const camAbs = this.camera.position.clone().add(origin);
    sunDirection(camAbs, t, sharedUniforms.uSunDir.value);
    sharedUniforms.uCamPos.value.copy(this.camera.position);
    const atmo = this.activeAtmosphere(camAbs, t);
    const atmoC = atmo ? bodyPosition(atmo, t, new THREE.Vector3()).sub(origin) : bodyPosition(EARTH, t, new THREE.Vector3()).sub(origin);
    setActiveAtmosphere(atmo?.id ?? null, atmoC);
    sharedUniforms.uSunIntensity.value = 9 * (atmo ? sunlightFactor(bodyPosition(SUN, t, new THREE.Vector3()).distanceTo(camAbs)) : 1);
    // 自动降级到第 2 级时：减少大气采样、关闭阴影
    const degraded = this.engine.detail >= 2;
    sharedUniforms.uAtmoSamples.value = (this.engine.quality === 'low' ? 4 : this.engine.quality === 'medium' ? 6 : 10) - (degraded ? 2 : 0);
    const wantShadow = this.engine.quality !== 'low' && !degraded;
    if (this.sun.castShadow !== wantShadow) this.sun.castShadow = wantShadow;
    this.planets.sky.position.copy(this.camera.position);
    // 二维地图是窄视场的长焦相机：太阳周围按角度计算的光晕会糊满整个屏幕
    this.planets.skyMat.uniforms.uAureole.value = this.mode === 'map' ? 0 : 1;
    this.planets.skyMat.uniforms.uGalaxy.value = this.mode === 'map' && this.map3d ? 1 : 0;
    this.planets.stars.position.copy(this.camera.position);
    this.planets.starMat.uniforms.uPixelRatio.value = this.engine.renderer.getPixelRatio();
    // 星空可见度：在有大气的天体上白天看不见星星
    let day = 0;
    if (atmo) {
      const look = ATMO_LOOK[atmo.id]!;
      const camRel = this.camera.position.clone().sub(atmoC);
      const camAlt = camRel.length() - look.r0;
      const thick = look.r1 - look.r0;
      const muSun = camRel.normalize().dot(sharedUniforms.uSunDir.value);
      day = THREE.MathUtils.smoothstep(muSun, -0.15, 0.05) * (1 - THREE.MathUtils.smoothstep(camAlt, thick * 0.3, thick * 0.95));
      if (atmo.id === 'mars') day *= 0.75;
    }
    this.planets.starMat.uniforms.uStarVis.value = 1 - day;
    // 云层淡出（相机穿越云层时）
    const earthW = this.planets.earth.parent!.position;
    const camAltE = this.camera.position.distanceTo(earthW) - EARTH.radius;
    const dc = Math.abs(camAltE - Planets.CLOUD_ALT);
    this.planets.cloudMat.uniforms.uFade.value = THREE.MathUtils.smoothstep(dc, 300, 2500);
    this.planets.clouds.visible = camAltE < 5e8;
    // 金星：在浓密云层之下才看得到地面
    const venusW = this.planets.visuals.get('venus')!.group.position;
    const camAltV = this.camera.position.distanceTo(venusW) - VENUS.radius;
    this.planets.setVenusCloudMix(THREE.MathUtils.smoothstep(camAltV, 30_000, 42_000));
    // 太阳光晕与远处行星的光点
    const pxPerRad = this.engine.height / ((this.camera.fov * Math.PI) / 180);
    const glow = this.glowColor.copy(this.sunTint).multiplyScalar(this.sunOccl * (1 - day * 0.7));
    this.planets.updateView(this.camera.position, this.camera.near, pxPerRad, this.engine.renderer.getPixelRatio(), glow);

    // 轨迹：飞行视图与二维地图
    this.history.update(sim.prediction, this.time);
    const ghost = this.history.ghost();
    if (this.mode === 'map') this.map.update(sim, ghost, origin, this.camera, this.engine.width, this.engine.height, this.mapBasis!, dtReal);
    else this.traj.update(sim, ghost, origin, this.camera, this.engine.width, this.engine.height);
  }

  private smokeLight = new THREE.Color(1, 1, 1);
  /** 太阳被天体遮挡的程度（1 = 无遮挡）与穿过大气后的颜色 */
  private sunOccl = 1;
  private sunTint = new THREE.Color(1, 1, 1);
  private glowColor = new THREE.Color();

  /** 离相机最近的有大气的天体（按相对大气层半径的距离）。 */
  private activeAtmosphere(camAbs: THREE.Vector3, t: number): Body | null {
    let best: Body | null = null;
    let bestK = Infinity;
    const c = new THREE.Vector3();
    for (const b of BODIES) {
      const look = ATMO_LOOK[b.id];
      if (!look) continue;
      const k = camAbs.distanceTo(bodyPosition(b, t, c)) / look.r1;
      if (k < bestK) {
        bestK = k;
        best = b;
      }
    }
    return best;
  }

  private ignitionFlash(pv: { plumes: { group: THREE.Object3D; radius: number }[] }, thrust: number, vel: THREE.Vector3, body: Body): void {
    const fwd = UP.clone().applyQuaternion(this.sim.vessel.q);
    const tel = this.sim.telemetry;
    const inAir = !!body.atmosphere && tel.density > 0.01;
    const p = new THREE.Vector3();
    for (const pl of pv.plumes) {
      pl.group.getWorldPosition(p);
      p.add(this.origin);
      const r = pl.radius;
      for (let i = 0; i < 14; i++) {
        const jitter = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(r * 14);
        this.particles.emit({ pos: p.clone(), vel: vel.clone().addScaledVector(fwd, -(10 + Math.random() * 30)).add(jitter), life: 0.25 + Math.random() * 0.3, size0: r * 1.6, size1: r * 4, color: new THREE.Color(10, 7, 3.5), alpha: 1, drag: inAir ? 2 : 0, glow: true, cool: true });
      }
    }
    this.shake = Math.max(this.shake, Math.min(0.4, 0.1 + thrust / 4e6));
  }

  private emitExhaust(key: string, thrust: number, kind: string, pv: { visual: { bells: { pivot: THREE.Object3D; radius: number }[] } }, dt: number, body: Body): void {
    const sim = this.sim;
    const tel = sim.telemetry;
    if (!body.atmosphere || tel.density < 0.004 || kind === 'lander') return;
    const V = sim.vessel;
    const fwd = UP.clone().applyQuaternion(V.q);
    const rate = Math.min(60, 8 + Math.sqrt(thrust / 1000) * 1.5) * Math.min(1, tel.density / 0.2 + 0.25);
    let acc = (this.emitAcc.get(key) ?? 0) + rate * dt;
    const air = surfaceVelocity(body, sim.t, V.r, new THREE.Vector3());
    const col = kind === 'solid' ? new THREE.Color(0.92, 0.9, 0.88) : kind === 'hydrolox' ? new THREE.Color(0.95, 0.96, 1.0) : new THREE.Color(0.72, 0.68, 0.64);
    const alpha = kind === 'hydrolox' ? 0.25 : kind === 'solid' ? 0.7 : 0.45;
    const tmp = new THREE.Vector3();
    while (acc >= 1) {
      acc -= 1;
      const bell = pv.visual.bells[Math.floor(Math.random() * pv.visual.bells.length)];
      bell.pivot.getWorldPosition(tmp);
      const r = bell.radius;
      const pos = tmp.clone().add(this.origin).addScaledVector(fwd, -r * (4 + Math.random() * 10));
      const vel = air.clone().addScaledVector(fwd, -(20 + Math.random() * 30)).add(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
      const life = 10 + Math.random() * 14;
      this.particles.emit({ pos, vel, life, size0: r * 2.2, size1: r * (7 + Math.random() * 7), color: col, alpha, drag: 0.35 });
      // 发射台附近：地面烟云向四周扩散
      if (tel.radarAlt < 40 && Math.random() < 0.6) {
        const up = tel.up;
        const gp = V.r.clone().addScaledVector(up, -(tel.radarAlt + (V.com.y - V.bounds().minY)) + 2);
        const a = Math.random() * Math.PI * 2;
        const side = tel.north.clone().multiplyScalar(Math.cos(a)).addScaledVector(tel.east, Math.sin(a));
        const v2 = air.clone().addScaledVector(side, 25 + Math.random() * 35).addScaledVector(up, 2 + Math.random() * 6);
        this.particles.emit({ pos: gp.addScaledVector(side, r * 2), vel: v2, life: 10 + Math.random() * 8, size0: r * 3, size1: r * (10 + Math.random() * 10), color: col, alpha: alpha * 0.8, drag: 0.3 });
      }
    }
    this.emitAcc.set(key, acc);
  }

  private updateLights(dt: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    const sunDir = sunDirection(V.r, sim.t, new THREE.Vector3());
    // 太阳是否被天体遮挡
    let occl = 1;
    for (const b of BODIES) {
      if (b.kind === 'star') continue;
      const c = bodyPosition(b, sim.t, new THREE.Vector3());
      const rel = c.sub(V.r);
      const along = rel.dot(sunDir);
      if (along <= 0) continue;
      const perp = Math.sqrt(Math.max(0, rel.lengthSq() - along * along));
      const soft = b.radius * 0.004 + 200;
      occl *= THREE.MathUtils.smoothstep(perp, b.radius - soft, b.radius + soft);
    }
    // 大气对太阳光的染色（只考虑飞船所在天体的大气）
    const look = ATMO_LOOK[tel.body.id];
    const upB = V.r.clone().sub(bodyPosition(tel.body, sim.t, new THREE.Vector3())).normalize();
    const mu = upB.dot(sunDir);
    let tr = [1, 1, 1];
    if (look) {
      const am = 1 / (Math.max(mu, 0) + 0.025 * Math.exp(-11 * Math.max(mu, -0.2)));
      const dens = Math.exp(-Math.max(0, tel.alt) / look.hr);
      tr = [0, 1, 2].map((i) => Math.exp(-(look.br[i] * look.hr + look.bm[i] * 1.1 * look.hm) * Math.min(am, 40) * dens));
    }
    const sunCol = new THREE.Color(tr[0], tr[1], tr[2]);
    const flux = sunlightFactor(V.r.distanceTo(bodyPosition(SUN, sim.t, new THREE.Vector3())));
    this.sun.color.copy(sunCol);
    this.sun.intensity = SUN_INTENSITY * occl * flux;
    this.sunOccl = occl;
    this.sunTint.copy(sunCol).multiplyScalar(Math.min(1.3, flux)).multiply(GLOW_BASE);
    // 阴影相机跟随飞船
    const b = V.bounds();
    const size = Math.max(25, (b.maxY - b.minY) * 1.2, b.radius * 4);
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    const ext = this.mode === 'flight' && tel.radarAlt < 300 ? size * 1.8 : size;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = size * 20 + 400;
    cam.updateProjectionMatrix();
    const focus = V.r.clone().sub(this.origin);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(sunDir, size * 8 + 150);
    // 半球光：天空与地面反照
    const atm = tel.body.atmosphere;
    const dayF = THREE.MathUtils.smoothstep(mu, -0.1, 0.15);
    const airF = atm && tel.alt < atm.height ? 1 - THREE.MathUtils.smoothstep(tel.alt, atm.height * 0.07, atm.height * 0.85) : 0;
    const look2 = HEMI_LOOK[tel.body.id] ?? HEMI_LOOK.moon!;
    const sky = look2.sky.clone().multiplyScalar(0.55 * dayF * airF * flux + 0.02);
    // 天体占据的立体角越大，地面反照越强
    const rB = V.r.distanceTo(bodyPosition(tel.body, sim.t, new THREE.Vector3()));
    const solid = 1 - Math.sqrt(Math.max(0, 1 - (tel.body.radius / Math.max(rB, tel.body.radius)) ** 2));
    const ground = look2.ground.clone().multiplyScalar((look2.k + 0.4 * airF) * dayF * (0.3 + solid) * occl * flux);
    // 夜面补光：与星球着色器的夜面亮度一致（半球光的辐照度 × 反照率 / π），夜里的地面和火箭也看得清
    const fill = NIGHT_TINT.clone().multiplyScalar(Math.PI * NIGHT_LIGHT * Math.min(1.2, flux) * (1 - 0.8 * dayF * occl));
    this.hemi.color.copy(sky).add(fill);
    this.hemi.groundColor.copy(ground).add(fill);
    this.hemi.intensity = 1.0;
    this.hemi.position.copy(tel.up);
    this.smokeLight.setRGB(0.25 + 0.75 * dayF * tr[0], 0.25 + 0.75 * dayF * tr[1], 0.27 + 0.75 * dayF * tr[2]);

    // 环境贴图：只在天空/地面/阳光明显变化时重新生成（PMREM 生成一次代价不小）
    this.envTimer += dt;
    const sig = [sky.r, sky.g, sky.b, ground.r, ground.g, ground.b, sunCol.r * occl, sunCol.g * occl, sunCol.b * occl, tel.up.x, tel.up.y, tel.up.z];
    const changed = !this.envSig || sig.some((v, i) => Math.abs(v - this.envSig![i]) > 0.02 + Math.abs(v) * 0.08);
    if (this.envTimer > 2.5 && changed) {
      this.envTimer = 0;
      this.envSig = sig;
      this.envMat.uniforms.uSky.value.copy(sky).multiplyScalar(1.6).addScalar(0.01);
      this.envMat.uniforms.uGround.value.copy(ground).multiplyScalar(1.4).addScalar(0.005);
      this.envMat.uniforms.uSunDir.value.copy(sunDir);
      this.envMat.uniforms.uSunCol.value.copy(sunCol).multiplyScalar(occl);
      this.envMat.uniforms.uUp.value.copy(tel.up);
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
  }

  private updateCamera(dt: number): void {
    const sim = this.sim;
    const tel = sim.telemetry;
    const cam = this.camera;
    if (this.mode === 'map' && this.map3d) {
      // 三维游览：相机围绕焦点（浮动原点）旋转，普通视场角，背景是三维星空
      this.orbDist *= Math.pow(this.orbDistTarget / this.orbDist, 1 - Math.exp(-dt * 10));
      const d = this.orbDist;
      const fov = 40;
      const cp = Math.cos(this.orbPitch);
      cam.position.set(cp * Math.cos(this.orbYaw), Math.sin(this.orbPitch), cp * Math.sin(this.orbYaw)).multiplyScalar(d);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, 0);
      cam.fov = fov;
      const f = this.mapFocusBody();
      const R = f === 'vessel' ? 0 : BODY_BY_ID[f].radius;
      cam.near = Math.max(0.3, (d - R) * 0.02);
      cam.updateMatrixWorld();
      this.mapBasis = {
        right: new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion),
        up: new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion),
        normal: new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion),
        extent: d * Math.tan(((fov / 2) * Math.PI) / 180),
      };
      this.map.setFocusButton(f);
    } else if (this.mode === 'map') {
      // 远处的长焦相机沿视平面法向俯视：平面内的轨迹没有透视变形，相当于二维地图
      const b = (this.mapBasis = this.updateMapBasis(dt));
      const ext = this.mapExtent;
      const d = Math.max(ext / Math.tan(MAP_FOV / 2), 2.5e6);
      const target = b.right.clone().multiplyScalar(this.mapPan.x).addScaledVector(b.up, this.mapPan.y);
      cam.position.copy(target).addScaledVector(b.normal, d);
      cam.up.copy(b.up);
      cam.lookAt(target);
      cam.fov = (2 * Math.atan(ext / d) * 180) / Math.PI;
      cam.near = Math.max(1, d * 0.001);
    } else {
      cam.fov = 55;
      let up: THREE.Vector3;
      let a: THREE.Vector3;
      let b: THREE.Vector3;
      if (this.camMode === 'chase') {
        const q = sim.vessel.q;
        up = UP.clone().applyQuaternion(q);
        a = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        b = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      } else if (this.camMode === 'free') {
        up = new THREE.Vector3(0, 1, 0);
        a = new THREE.Vector3(1, 0, 0);
        b = new THREE.Vector3(0, 0, 1);
      } else {
        up = tel.up.clone();
        a = tel.north.clone();
        b = tel.east.clone();
      }
      const off = a
        .clone()
        .multiplyScalar(Math.cos(this.camPitch) * Math.cos(this.camYaw))
        .addScaledVector(b, Math.cos(this.camPitch) * Math.sin(this.camYaw))
        .addScaledVector(up, Math.sin(this.camPitch))
        .multiplyScalar(this.camDist);
      // 不让相机钻到地下
      const bodyC = bodyPosition(tel.body, sim.t, new THREE.Vector3()).sub(sim.vessel.r);
      const camFromC = off.clone().sub(bodyC);
      const minR = tel.body.radius + tel.terrainH + 1.5;
      if (camFromC.length() < minR && tel.radarAlt < this.camDist * 2) {
        camFromC.setLength(minR);
        off.copy(camFromC).add(bodyC);
      }
      cam.position.copy(off);
      if (this.shake > 0.001) {
        const s = this.shake * Math.min(1, this.camDist / 40) * 0.25;
        cam.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      }
      cam.up.copy(up);
      cam.lookAt(0, 0, 0);
      cam.near = 0.3;
      // 发动机工作时的轻微震动
      const thr = tel.thrust > 0 && tel.density > 0.05 ? Math.min(0.35, tel.thrust / 4e6) : 0;
      this.shake = Math.max(thr, this.shake * Math.exp(-dt * 3));
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  render(): void {
    this.engine.render(this.scene, this.camera);
  }

  dispose(): void {
    this.patch.dispose();
    this.vesselView.dispose();
    this.particles.clear();
    if (this.envRT) this.envRT.dispose();
    this.pmrem.dispose();
    this.map.setVisible(false);
    this.map.dispose();
    this.traj.dispose();
    this.trajOverlay.remove();
  }
}
