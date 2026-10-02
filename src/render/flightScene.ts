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
/** 三维地图相机的视场角（度） */
const MAP3D_FOV = 40;
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
  /** 三维地图：围绕焦点旋转观察（拖动旋转、右键拖动平移、滚轮缩放）。默认开启，工具栏的“3D”按钮可切回二维俯视 */
  map3d = true;
  /** 玩家选择的地图维度（打开地图、切换焦点时沿用） */
  map3dPref = true;
  /**
   * 三维地图相机：围绕目标点（焦点 + orbPan）转动的“转盘”。orbBasis.up 为转轴（通常是北极方向），
   * yaw = 0、pitch = 0 时从 orbBasis.normal 一侧看过去，屏幕右方为 orbBasis.right。
   */
  private orbYaw = 0;
  private orbPitch = 0.4;
  private orbDist = 1;
  private orbDistTarget = 1;
  private orbPan = new THREE.Vector3();
  private orbBasis = { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(0, 0, 1) };
  /** 三维自动视图的目标：框住预测轨迹的球（中心相对焦点）与相机距离 */
  private fitCenter = new THREE.Vector3();
  private fitDist = 0;
  /** 地图浮动原点所在的焦点（自动视图跟着飞船换天体时，用来平移视图使画面不跳） */
  private mapOriginId: MapFocus | null = null;
  /** 点击方向轴后相机转过去的动画 */
  private viewTween: { t: number; yaw0: number; pitch0: number; yaw1: number; pitch1: number; map: boolean } | null = null;
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

  /** 回放向后跳转时：飞船换成了新的 Vessel，按它重建箭体模型，清掉残骸。 */
  resetVessel(): void {
    for (const [id, g] of this.debrisViews) {
      this.scene.remove(g);
      this.sepFx.onDebrisGone(id);
    }
    this.debrisViews.clear();
    this.sepFx.reset();
    this.scene.remove(this.vesselView.group);
    this.vesselView.dispose();
    this.vesselView = new VesselView(this.sim.vessel.layout);
    this.scene.add(this.vesselView.group);
    this.vesselHidden = false;
    this.firing.clear();
    this.emitAcc.clear();
  }

  // ---------------------------------------------------------------- 输入

  /** 拖动：飞行视图与三维地图旋转视角（pan = true 时三维地图平移），二维地图平移。 */
  orbitCamera(dx: number, dy: number, pan = false): void {
    if (dx || dy) this.viewTween = null;
    if (this.mode === 'map' && this.map3d && pan) {
      // 三维地图：右键拖动平移目标点
      const cam = this.camera;
      const mpp = (2 * this.orbDist * Math.tan(((cam.fov / 2) * Math.PI) / 180)) / Math.max(1, this.engine.height);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      this.orbPan.addScaledVector(right, -dx * mpp).addScaledVector(up, dy * mpp);
      if (dx || dy) this.mapAutoFit = false;
    } else if (this.mode === 'map' && this.map3d) {
      // 三维地图：拖动旋转视角（自动视图仍然自动框住轨迹）
      this.orbYaw -= dx * 0.006;
      this.orbPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.orbPitch + dy * 0.006));
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
      this.mapAutoFit = false;
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

  /**
   * 三维地图相机离目标点的最近距离：目标点在星球内部（例如以星球为焦点）时，相机从任何方向看都不钻进星球里。
   * 目标点在星球外（跟随贴地飞行的飞船）时不限制，由 updateCamera 把相机推到地面以上。
   */
  private orbMinDist(): number {
    const sim = this.sim;
    const target = this.orbPan.clone().add(this.origin);
    let d = this.mapFocusBody() === 'vessel' ? 20 : 200;
    const c = new THREE.Vector3();
    for (const b of BODIES) {
      const k = bodyPosition(b, sim.t, c).distanceTo(target);
      if (k < b.radius) d = Math.max(d, b.radius * 1.12 + k);
    }
    return d;
  }

  /** 二维地图 ↔ 三维地图（保持当前焦点；自动视图仍是自动视图）。 */
  toggleMap3d(): void {
    this.map3dPref = !this.map3d;
    this.setMapFocus(this.mapAutoFit ? 'auto' : this.mapFocusBody(), this.map3dPref);
  }

  /**
   * 进入三维地图：
   * - 自动视图的上升段：转盘以当地竖直方向为轴、从轨道面的法向斜着看，弹道仍从地平线向上升起；
   * - 其余：以北极方向为转轴，从太阳一侧偏开约 60° 斜着看过去（大半个星球是亮的，一侧露出晨昏线）。
   */
  private initOrbit(auto: boolean): void {
    const sim = this.sim;
    const f = this.mapFocusBody();
    const B = this.orbBasis;
    this.orbPan.set(0, 0, 0);
    this.viewTween = null;
    if (auto && this.mapUpRef) {
      this.mapSnap = true;
      const b = this.updateMapBasis(0);
      B.right.copy(b.right);
      B.up.copy(b.up);
      B.normal.copy(b.normal);
      this.orbYaw = 0.5;
      this.orbPitch = 0.22;
    } else {
      B.right.set(1, 0, 0);
      B.up.set(0, 1, 0);
      B.normal.set(0, 0, 1);
      const center = f === 'vessel' ? sim.vessel.r.clone() : bodyPosition(BODY_BY_ID[f], sim.t, new THREE.Vector3());
      const sd = f === 'sun' ? new THREE.Vector3(1, 0, 0) : sunDirection(center, sim.t, new THREE.Vector3());
      this.orbYaw = Math.atan2(sd.x, sd.z) - 1.05;
      this.orbPitch = auto ? 0.62 : 0.38;
    }
    if (auto) {
      this.computeFit();
      this.orbPan.copy(this.fitCenter);
      this.orbDist = this.orbDistTarget = this.fitDist;
      return;
    }
    // 星球约占画面高度的 60%，四周留出星空背景；土星要把光环也框进来
    const k = f === 'saturn' ? 7.5 : f === 'sun' ? 5 : 4.6;
    const d = f === 'vessel' ? Math.max(200, this.defaultMapExtent('vessel') * 2.2) : BODY_BY_ID[f].radius * k;
    this.orbDist = this.orbDistTarget = d;
  }

  /**
   * 方向轴：从 dir（世界方向）一侧看过去。
   * 飞行视图转动跟随相机；地图转动三维相机（二维地图先切换到三维）。
   */
  viewFrom(dir: THREE.Vector3): void {
    const d = dir.clone().normalize();
    if (this.mode === 'map') {
      if (!this.map3d) {
        this.map3dPref = true;
        this.setMapFocus(this.mapAutoFit ? 'auto' : this.mapFocusBody(), true);
      }
      const B = this.orbBasis;
      const y = d.dot(B.up);
      const pitch = Math.asin(Math.max(-1, Math.min(1, y)));
      const yaw = Math.abs(y) > 0.999 ? this.orbYaw : Math.atan2(d.dot(B.right), d.dot(B.normal));
      this.startTween(this.orbYaw, this.orbPitch, yaw, pitch, true);
    } else {
      const { a, b, up } = this.flightCamFrame();
      const y = d.dot(up);
      const pitch = Math.max(-1.45, Math.min(1.45, Math.asin(Math.max(-1, Math.min(1, y)))));
      const yaw = Math.abs(y) > 0.999 ? this.camYaw : Math.atan2(d.dot(b), d.dot(a));
      this.startTween(this.camYaw, this.camPitch, yaw, pitch, false);
    }
  }

  private startTween(yaw0: number, pitch0: number, yaw1: number, pitch1: number, map: boolean): void {
    // 沿较短的方向转过去
    let dy = (yaw1 - yaw0) % (2 * Math.PI);
    if (dy > Math.PI) dy -= 2 * Math.PI;
    if (dy < -Math.PI) dy += 2 * Math.PI;
    this.viewTween = { t: 0, yaw0, pitch0, yaw1: yaw0 + dy, pitch1, map };
  }

  /** 飞行视图相机所在的参考系：a、b 为水平面内的两个方向，up 为转轴（随相机模式而定）。 */
  private flightCamFrame(): { a: THREE.Vector3; b: THREE.Vector3; up: THREE.Vector3 } {
    const tel = this.sim.telemetry;
    if (this.camMode === 'chase') {
      const q = this.sim.vessel.q;
      return { up: UP.clone().applyQuaternion(q), a: new THREE.Vector3(0, 0, 1).applyQuaternion(q), b: new THREE.Vector3(1, 0, 0).applyQuaternion(q) };
    }
    if (this.camMode === 'free') return { up: new THREE.Vector3(0, 1, 0), a: new THREE.Vector3(1, 0, 0), b: new THREE.Vector3(0, 0, 1) };
    return { up: tel.up.clone(), a: tel.north.clone(), b: tel.east.clone() };
  }

  /** 切换地图焦点；'auto' 为自动视图：始终框住整条预测轨迹。view3d 不给时沿用玩家选择的维度（默认三维）。 */
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
    this.mapOriginId = this.mapFocusBody();
    const was3d = this.map3d;
    this.map3d = view3d ?? this.map3dPref;
    // 从三维切回二维：视平面直接对准当前轨道面
    if (was3d && !this.map3d) this.mapSnap = true;
    if (this.map3d) this.initOrbit(f === 'auto');
    this.map.set3d(this.map3d);
  }

  /**
   * 自动视图的目标：框住飞船、预测轨迹（上升段还包括已飞过的航迹）。
   * 二维地图得到视平面内的矩形（fitPan、fitExtent），三维地图得到包住这些点的球（fitCenter、fitDist）。
   */
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
    const pts: number[] = [];
    const add = (x: number, y: number, z: number) => {
      const dx = x - center.x;
      const dy = y - center.y;
      const dz = z - center.z;
      pts.push(dx, dy, dz);
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

    // 三维：包围盒中心 + 最远点的距离，相机后退到整个球都落在视场内
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = new THREE.Vector3();
    for (let i = 0; i < pts.length; i += 3) {
      p.fromArray(pts, i);
      lo.min(p);
      hi.max(p);
    }
    const c = lo.clone().add(hi).multiplyScalar(0.5);
    let r = 0;
    for (let i = 0; i < pts.length; i += 3) r = Math.max(r, p.fromArray(pts, i).distanceTo(c));
    r = Math.max(min * 0.7, Math.min(MAP_MAX_EXTENT, r));
    const half = (MAP3D_FOV * Math.PI) / 360;
    const halfMin = Math.min(half, Math.atan(Math.tan(half) * aspect));
    this.fitCenter.copy(c);
    this.fitDist = (r / Math.sin(halfMin)) * 1.15;
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
    } else this.viewTween = null;
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
      // 自动视图跟着飞船换了天体（例如进入月球影响球）：平移视图抵消原点的跳变，再平滑地移到新的目标
      if (f !== this.mapOriginId) {
        if (this.mapOriginId !== null) {
          const prevAbs = this.mapOriginId === 'vessel' ? V.r.clone() : bodyPosition(BODY_BY_ID[this.mapOriginId], t, new THREE.Vector3());
          const shift = prevAbs.sub(this.origin);
          this.orbPan.add(shift);
          this.mapPan.x += shift.dot(this.mapRight);
          this.mapPan.y += shift.dot(this.mapUp);
        }
        this.mapOriginId = f;
        this.fitPred = undefined;
      }
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
    this.stepTween(dt);
    if (this.mode === 'map' && this.map3d) {
      // 三维地图：相机围绕目标点（焦点 + 平移量）转动，普通视场角，背景是三维星空
      const f = this.mapFocusBody();
      if (this.mapAutoFit) {
        // 自动视图：预测轨迹更新时重新计算包围球，平滑地移过去（旋转视角不影响）
        const pred = this.sim.prediction;
        if (pred !== this.fitPred) {
          this.fitPred = pred;
          this.computeFit();
        }
        const kf = 1 - Math.exp(-dt * 2.5);
        this.orbPan.lerp(this.fitCenter, kf);
        this.orbDistTarget = this.fitDist;
        this.map.setFocusButton('auto');
      } else this.map.setFocusButton(f);
      this.orbDistTarget = Math.max(this.orbDistTarget, this.orbMinDist());
      this.orbDist *= Math.pow(this.orbDistTarget / this.orbDist, 1 - Math.exp(-dt * (this.mapAutoFit ? 2.5 : 10)));
      const d = this.orbDist;
      const fov = MAP3D_FOV;
      const B = this.orbBasis;
      const cp = Math.cos(this.orbPitch);
      const sp = Math.sin(this.orbPitch);
      const sy = Math.sin(this.orbYaw);
      const cy = Math.cos(this.orbYaw);
      const dir = B.right.clone().multiplyScalar(cp * sy).addScaledVector(B.up, sp).addScaledVector(B.normal, cp * cy);
      // 相机的“上”方向取俯仰角的切向：正对两极（pitch = ±90°）时也不会翻转
      const camUp = B.right.clone().multiplyScalar(-sp * sy).addScaledVector(B.up, cp).addScaledVector(B.normal, -sp * cy);
      const target = this.orbPan;
      cam.position.copy(target).addScaledVector(dir, d);
      // 不钻进星球里（贴近地面跟随飞船时只留几十米）
      const c = new THREE.Vector3();
      let surf = Infinity;
      for (const b of BODIES) {
        bodyPosition(b, sim.t, c).sub(this.origin);
        const rel = cam.position.clone().sub(c);
        const k = rel.length();
        const m = Math.max(30, Math.min(b.radius * 0.02, d * 0.05));
        if (k < b.radius + m) cam.position.copy(c).addScaledVector(rel.normalize(), b.radius + m);
        surf = Math.min(surf, Math.max(0, k - b.radius));
      }
      cam.up.copy(camUp);
      cam.lookAt(target);
      cam.fov = fov;
      cam.near = Math.max(0.3, Math.min(surf, d) * 0.02);
      cam.updateMatrixWorld();
      this.mapBasis = {
        right: new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion),
        up: new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion),
        normal: new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion),
        extent: d * Math.tan(((fov / 2) * Math.PI) / 180),
      };
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
      const { up, a, b } = this.flightCamFrame();
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

  /** 点击方向轴后的转动动画（约 0.4 秒，先快后慢） */
  private stepTween(dt: number): void {
    const tw = this.viewTween;
    if (!tw) return;
    if (tw.map !== (this.mode === 'map')) {
      this.viewTween = null;
      return;
    }
    tw.t = Math.min(1, tw.t + dt / 0.4);
    const k = 1 - Math.pow(1 - tw.t, 3);
    const yaw = tw.yaw0 + (tw.yaw1 - tw.yaw0) * k;
    const pitch = tw.pitch0 + (tw.pitch1 - tw.pitch0) * k;
    if (tw.map) {
      this.orbYaw = yaw;
      this.orbPitch = pitch;
    } else {
      this.camYaw = yaw;
      this.camPitch = pitch;
    }
    if (tw.t >= 1) this.viewTween = null;
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
