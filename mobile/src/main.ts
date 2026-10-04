import './ui/styles.css';
import * as THREE from 'three';
import { RenderEngine, type Quality } from './render/engine';
import { bakePlanets, sampleWater, type PlanetMaps } from './render/planetBake';
import { BuilderScene } from './render/builderScene';
import { FlightScene } from './render/flightScene';
import { BuilderUI } from './ui/builderUI';
import { FlightHUD } from './ui/hud';
import { FlightSim, type Scenario } from './game/flight';
import { SoundEngine } from './audio/sound';
import type { RocketDesign } from './rocket/design';
import { h } from './ui/dom';
import { fmtDist, fmtMET } from './ui/format';
import { MISSIONS } from './game/missions';
import { bindCanvasGestures, haptic } from './ui/touch';

// 手机版的设置与电脑版分开保存（同一域名下两版共用火箭存档）
const QUALITY_KEY = 'rocket-mobile-quality';
const VOLUME_KEY = 'rocket-mobile-volume';
const HAPTIC_KEY = 'rocket-mobile-haptic';
const INFINITE_FUEL_KEY = 'rocket-mobile-infinite-fuel';

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 存储不可用时忽略 */
  }
}

interface Flight {
  sim: FlightSim;
  scene: FlightScene;
  hud: FlightHUD;
  design: RocketDesign;
  scenario: Scenario;
  maxAlt: number;
  maxSpeed: number;
  destroyedAt: number | null;
  victoryShown: boolean;
}

interface WakeLockLike {
  release(): Promise<void>;
}

class App {
  engine: RenderEngine;
  maps!: PlanetMaps;
  builderScene!: BuilderScene;
  builderUI!: BuilderUI;
  flight: Flight | null = null;
  sound = new SoundEngine();
  ui = document.getElementById('ui') as HTMLDivElement;
  mapOverlay = document.getElementById('map-overlay') as HTMLDivElement;
  keys = new Set<string>();
  modal: HTMLDivElement | null = null;
  last = performance.now();
  quality: Quality;
  realTime = 0;
  hapticsOn: boolean;
  /** 无限燃料模式（保存在本地，下次打开仍然有效） */
  infiniteFuel: boolean;
  private lastSepSound = -1;
  private wakeLock: WakeLockLike | null = null;
  /** 调试与自动化测试用 */
  readonly __THREE = THREE;

  constructor() {
    const canvas = document.getElementById('view') as HTMLCanvasElement;
    const stored = lsGet(QUALITY_KEY) as Quality | null;
    this.quality = stored === 'low' || stored === 'medium' || stored === 'high' ? stored : defaultQuality();
    this.engine = new RenderEngine(canvas, this.quality);
    const vol = parseFloat(lsGet(VOLUME_KEY) ?? '0.7');
    this.sound.volume = isFinite(vol) ? vol : 0.7;
    this.hapticsOn = lsGet(HAPTIC_KEY) !== '0';
    this.infiniteFuel = lsGet(INFINITE_FUEL_KEY) === '1';
  }

  async init(): Promise<void> {
    const fill = document.getElementById('loading-fill') as HTMLDivElement;
    this.maps = await bakePlanets(this.engine.renderer, this.quality, (f) => (fill.style.width = `${Math.round(f * 100)}%`));
    (document.getElementById('loading-text') as HTMLDivElement).textContent = '准备总装车间……';
    this.builderScene = new BuilderScene(this.engine);
    this.builderUI = new BuilderUI(this.ui, this.builderScene, {
      openModal: (el) => this.openModal(el),
      closeModal: () => this.closeModal(),
      click: () => this.click(),
    });
    this.builderUI.onLaunch = (d, s) => this.startFlight(d, s);
    this.builderUI.setInfiniteFuel(this.infiniteFuel);
    this.builderUI.onInfiniteFuel = (on) => this.setInfiniteFuel(on);
    this.builderUI.onHelp = () => this.showHelp();
    this.builderUI.onSettings = () => this.showSettings();
    this.bindInput();
    document.getElementById('loading')!.classList.add('hide');
    requestAnimationFrame(() => this.frame());
    (window as unknown as { __game: App }).__game = this;
  }

  click(): void {
    this.sound.click();
  }

  vibrate(ms: number): void {
    if (this.hapticsOn) haptic(ms);
  }

  // ---------------------------------------------------------------- 飞行开始/结束

  startFlight(design: RocketDesign, scenario: Scenario): void {
    this.sound.start();
    this.closeModal();
    if (this.flight) this.endFlight(false);
    this.builderUI.show(false);
    this.builderScene.controls.enabled = false;
    const sim = new FlightSim(design, scenario, { infiniteFuel: this.infiniteFuel });
    // 轨迹预测由主循环逐帧推进（见 FlightSim.pumpPrediction）
    sim.livePrediction = true;
    sim.isWater = (_b, dir) => sampleWater(this.maps, dir);
    const scene = new FlightScene(this.engine, this.maps, sim, this.mapOverlay);
    const hud = new FlightHUD(this.ui, sim, scene, {
      pause: () => this.showPause(),
      toggleMap: () => this.toggleMap(),
      cycleCamera: () => this.cycleCamera(),
      click: () => this.click(),
      haptic: (ms) => this.vibrate(ms),
    });
    this.flight = { sim, scene, hud, design, scenario, maxAlt: 0, maxSpeed: 0, destroyedAt: null, victoryShown: false };
    this.requestWakeLock();
    // 安卓返回键 / 返回手势：飞行中改为打开暂停菜单，而不是直接离开页面
    if (!(history.state as { flight?: boolean } | null)?.flight) history.pushState({ flight: true }, '');
    if (scenario === 'pad') {
      hud.toast('点左下角橙色“分级”按钮点火升空！（或用右侧“辅助 → 自动入轨”）', 'info');
      hud.toast('约 1 km 后拖动导航球旁的“方向舵”向东倾斜，做重力转弯', 'info');
    } else {
      hud.toast(scenario === 'llo' ? '环月轨道：先“规划 → 降低近月点”，再用“辅助 → 自动着陆”或手动着陆' : '地球轨道练习：点“规划”尝试奔月转移', 'info');
    }
    if (this.infiniteFuel) hud.toast('∞ 无限燃料：液体燃料不会消耗，固体助推器照常烧完（可在“设置”中关闭）', 'info');
    if (window.innerHeight > window.innerWidth) hud.toast('把手机横过来，视野更开阔', 'info');
  }

  /** 开关无限燃料：保存设置，同步总装车间，并立即作用于当前飞行。 */
  setInfiniteFuel(on: boolean): void {
    this.infiniteFuel = on;
    lsSet(INFINITE_FUEL_KEY, on ? '1' : '0');
    this.builderUI.setInfiniteFuel(on);
    this.flight?.sim.setInfiniteFuel(on);
  }

  endFlight(showBuilder = true): void {
    const f = this.flight;
    if (!f) return;
    f.scene.dispose();
    f.hud.dispose();
    this.flight = null;
    this.mapOverlay.style.display = 'none';
    this.sound.update(0, 0, 0, true);
    this.releaseWakeLock();
    if (showBuilder && (history.state as { flight?: boolean } | null)?.flight) history.back();
    if (showBuilder) {
      this.builderUI.show(true);
      this.builderScene.controls.enabled = true;
    }
  }

  toggleMap(): void {
    const f = this.flight;
    if (!f) return;
    const m = f.scene.mode === 'map' ? 'flight' : 'map';
    f.scene.setMode(m);
    // 横屏时打开地图顺便打开机动规划（竖屏时规划面板会挡住地图，由玩家自己打开）
    if (m === 'map' && window.innerWidth > window.innerHeight) f.hud.togglePlanner(true);
    if (m === 'flight') f.hud.togglePlanner(false);
  }

  cycleCamera(): void {
    const f = this.flight;
    if (!f) return;
    const modes = ['orbit', 'chase', 'free'] as const;
    const i = (modes.indexOf(f.scene.camMode) + 1) % modes.length;
    f.scene.camMode = modes[i];
    f.hud.toast(`相机：${['跟随（地平）', '跟随（船体）', '自由（惯性）'][i]}`);
  }

  // ---------------------------------------------------------------- 屏幕常亮

  private async requestWakeLock(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } };
    if (!nav.wakeLock || this.wakeLock || document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await nav.wakeLock.request('screen');
      (this.wakeLock as unknown as EventTarget).addEventListener?.('release', () => (this.wakeLock = null));
    } catch {
      this.wakeLock = null;
    }
  }

  private releaseWakeLock(): void {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  // ---------------------------------------------------------------- 输入

  bindInput(): void {
    // iOS 的音频必须在“松手”这类用户手势里启动/恢复
    const unlock = () => this.sound.start();
    window.addEventListener('pointerup', unlock, true);
    window.addEventListener('touchend', unlock, true);
    window.addEventListener('keydown', unlock, true);
    // 阻止 iOS Safari 的双指缩放整个页面
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    // 切到后台：自动暂停并静音；回来后重新申请屏幕常亮
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.keys.clear();
        this.flight?.hud.releaseControls();
        if (this.flight && !this.modal && !this.flight.sim.destroyed) this.showPause();
        this.sound.suspend();
      } else if (this.flight) this.requestWakeLock();
    });
    window.addEventListener('popstate', () => {
      if (!this.flight) return;
      history.pushState({ flight: true }, '');
      if (this.modal) this.closeModal();
      else this.showPause();
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.flight && !this.flight.sim.destroyed) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // 外接键盘（平板）时仍可使用电脑版的快捷键
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const f = this.flight;
      if (e.code === 'Escape') {
        if (this.modal) this.closeModal();
        else if (f) this.showPause();
        e.preventDefault();
        return;
      }
      if (!f || this.modal) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.repeat) return;
      const sim = f.sim;
      switch (e.code) {
        case 'Space':
          f.hud.doStage();
          break;
        case 'KeyT':
          sim.toggleSas();
          break;
        case 'KeyG':
          sim.toggleLegs();
          break;
        case 'KeyP':
          sim.armChute();
          break;
        case 'KeyM':
          this.toggleMap();
          break;
        case 'KeyN':
          f.hud.togglePlanner();
          break;
        case 'KeyV':
          this.cycleCamera();
          break;
        case 'Comma':
          sim.autoWarpTo = null;
          sim.setWarp(sim.warpIndex - 1);
          break;
        case 'Period':
          sim.autoWarpTo = null;
          sim.setWarp(sim.warpIndex + 1);
          break;
        case 'Slash':
          sim.autoWarpTo = null;
          sim.setWarp(0);
          break;
        case 'KeyZ':
          sim.vessel.throttle = 1;
          sim.autopilot.disengage();
          break;
        case 'KeyX':
          sim.vessel.throttle = 0;
          sim.autopilot.disengage();
          break;
        case 'Tab':
          if (f.scene.mode === 'map') f.scene.cycleMapFocus();
          break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.flight?.hud.releaseControls();
    });
    // 飞行画面：单指拖动旋转视角、双指捏合缩放（总装车间由 OrbitControls 处理）
    bindCanvasGestures(this.engine.renderer.domElement, {
      enabled: () => !!this.flight,
      rotate: (dx, dy) => this.flight?.scene.orbitCamera(dx * 1.2, dy * 1.2),
      zoom: (f) => this.flight?.scene.zoomBy(f),
    });
  }

  /** 合并键盘与触屏摇杆的输入。 */
  private applyControls(dt: number): void {
    const f = this.flight;
    if (!f) return;
    const sim = f.sim;
    const k = this.keys;
    const hud = f.hud;
    const ax = (a: string, b: string) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    sim.input.pitch = clamp1(ax('KeyS', 'KeyW') + hud.stick.y);
    sim.input.yaw = clamp1(ax('KeyD', 'KeyA') + hud.stick.x);
    sim.input.roll = clamp1(ax('KeyE', 'KeyQ') + (hud.rollR.down ? 1 : 0) - (hud.rollL.down ? 1 : 0));
    const steer = ax('ArrowRight', 'ArrowLeft');
    if (steer !== 0) sim.nudgeRudder(((steer * 35 * Math.PI) / 180) * dt);
    const thr = (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') || k.has('ControlLeft') ? 1 : 0);
    if (thr !== 0) {
      sim.vessel.throttle = Math.max(0, Math.min(1, sim.vessel.throttle + thr * dt * 0.8));
      if (sim.autopilot.mode !== 'off') sim.autopilot.disengage('手动接管油门，飞行辅助已关闭');
    }
  }

  // ---------------------------------------------------------------- 主循环

  frame(): void {
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(0.1, rawDt);
    this.last = now;
    this.realTime += dt;
    this.engine.adapt(rawDt);
    const f = this.flight;
    if (!f) {
      this.builderScene.update();
      this.builderScene.render();
      return;
    }
    const sim = f.sim;
    this.applyControls(dt);
    sim.paused = !!this.modal;
    sim.update(dt);
    // 实时轨迹预测：每帧最多花几毫秒，算完立即开始下一次；帧率偏低（低于约 45 帧）时少花一些
    sim.pumpPrediction(rawDt > 1 / 45 ? 1.2 : 2.5);
    const events = sim.drainEvents();
    for (const e of events) this.onEvent(e.type, e.msg, e.level, e.size);
    // 分离、爆炸等事件也要交给三维场景（生成残骸模型与特效）
    f.scene.handleEvents(events);
    const tel = sim.telemetry;
    if (!sim.destroyed) {
      f.maxAlt = Math.max(f.maxAlt, tel.body.id === 'earth' ? tel.alt : f.maxAlt);
      f.maxSpeed = Math.max(f.maxSpeed, tel.orbSpeed);
    }
    f.scene.update(dt);
    f.hud.update(dt);
    const air = tel.body.atmosphere ? tel.density / tel.body.atmosphere.rho0 : 0;
    this.sound.update(sim.paused ? 0 : tel.thrust, air, tel.dynPressure, sim.paused);
    f.scene.render();
    if (sim.destroyed && f.destroyedAt !== null && this.realTime - f.destroyedAt > 2.5 && !this.modal) this.showFailure();
  }

  onEvent(type: string, msg?: string, level?: string, size?: number): void {
    const f = this.flight!;
    if (msg && type !== 'destroyed') f.hud.toast(msg, level);
    switch (type) {
      case 'stage':
        this.sound.stage();
        break;
      case 'decouple':
        // 同一次分级可能同时抛离多个助推器，只播放一次
        if (this.realTime - this.lastSepSound > 0.2) {
          this.lastSepSound = this.realTime;
          this.sound.separation();
          this.vibrate(40);
        }
        break;
      case 'ignite':
        this.sound.ignite();
        this.vibrate(60);
        break;
      case 'explosion':
        this.sound.explosion((size ?? 0) > 6);
        this.vibrate((size ?? 0) > 6 ? 300 : 120);
        break;
      case 'chuteOpen':
        this.sound.chute();
        this.vibrate(50);
        break;
      case 'mission':
      case 'landed':
        this.sound.chime(level !== 'bad');
        this.vibrate(30);
        break;
      case 'destroyed':
        f.destroyedAt = this.realTime;
        f.hud.toast(msg ?? '飞行器损毁', 'bad');
        break;
      case 'victory':
        if (!f.victoryShown) {
          f.victoryShown = true;
          setTimeout(() => this.showVictory(), 2500);
        }
        break;
    }
  }

  // ---------------------------------------------------------------- 模态框

  openModal(content: HTMLElement): void {
    this.closeModal();
    this.flight?.hud.releaseControls();
    this.modal = h('div', { class: 'modal-bg' }, content);
    this.ui.appendChild(this.modal);
  }

  closeModal(): void {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }

  private restart(): void {
    const f = this.flight;
    if (!f) return;
    this.startFlight(f.design, f.scenario);
  }

  private backToBuilder(): void {
    this.closeModal();
    this.endFlight(true);
  }

  showPause(): void {
    const f = this.flight;
    if (!f) return;
    this.openModal(
      h(
        'div',
        { class: 'modal panel' },
        h('h2', null, '暂停'),
        h('p', null, `任务时间 ${fmtMET(f.sim.met)} · 最高海拔 ${fmtDist(f.maxAlt)}`),
        h(
          'div',
          { class: 'actions stack' },
          h('button', { class: 'primary', onclick: () => this.closeModal() }, '▶ 继续飞行'),
          h('button', { onclick: () => this.restart() }, '↻ 重新发射'),
          h('button', { onclick: () => this.backToBuilder() }, '🔧 返回总装车间'),
          h('button', { onclick: () => this.showHelp() }, '❔ 操作说明'),
          h('button', { onclick: () => this.showSettings() }, '⚙ 设置'),
        ),
      ),
    );
  }

  showFailure(): void {
    const f = this.flight;
    if (!f) return;
    this.vibrate(200);
    this.openModal(
      h(
        'div',
        { class: 'modal panel fail' },
        h('h2', null, '任务失败'),
        h('p', null, f.sim.destroyReason),
        h('p', null, `任务时间 ${fmtMET(f.sim.met)} · 最高海拔 ${fmtDist(f.maxAlt)} · 最大过载 ${f.sim.maxG.toFixed(1)} g`),
        h('p', { class: 'muted' }, failureHint(f.sim.destroyReason)),
        h('div', { class: 'actions stack' }, h('button', { class: 'primary', onclick: () => this.restart() }, '↻ 重新发射'), h('button', { onclick: () => this.backToBuilder() }, '🔧 返回总装车间')),
      ),
    );
  }

  showVictory(): void {
    const f = this.flight;
    if (!f) return;
    this.vibrate(80);
    this.openModal(
      h(
        'div',
        { class: 'modal panel victory' },
        h('h2', null, '🌕 任务完成！'),
        h('p', null, '你的航天员登上了月球，并安全返回了地球。这是一次完美的登月任务！'),
        h('p', null, `任务总时长 ${fmtMET(f.sim.met)} · 最大过载 ${f.sim.maxG.toFixed(1)} g`),
        f.sim.infiniteFuelUsed ? h('p', { style: { color: '#ffd75a' } }, '∞ 本次飞行开启过无限燃料模式') : null,
        h('ul', null, ...MISSIONS.map((m) => h('li', null, `${f.sim.missions.done.has(m.id) ? '✔' : '○'} ${m.title} — ${m.desc}`))),
        h('div', { class: 'actions stack' }, h('button', { class: 'primary', onclick: () => this.closeModal() }, '继续'), h('button', { onclick: () => this.backToBuilder() }, '🔧 返回总装车间')),
      ),
    );
  }

  showHelp(): void {
    const k = (keys: string, desc: string) => [h('div', { class: 'ctl' }, keys), h('div', null, desc)];
    this.openModal(
      h(
        'div',
        { class: 'modal panel' },
        h('h2', null, '操作说明'),
        h('h3', { class: 'modal-sub' }, '总装车间'),
        h(
          'div',
          { class: 'keys' },
          ...k('零件', '选分类后点击零件，添加到选中零件下方'),
          ...k('结构', '点选零件后可上移、下移、删除、换推进剂；也可直接在 3D 画面中点选'),
          ...k('性能', '各级 Δv、推重比与设计问题'),
          ...k('手势', '单指拖动旋转，双指捏合缩放、拖动平移'),
          ...k('名称 ▾', '保存设计、载入模板或存档'),
        ),
        h('h3', { class: 'modal-sub' }, '飞行'),
        h(
          'div',
          { class: 'keys' },
          ...k('分级', '左下角橙色按钮：点火 / 分离下面级 / 抛离助推器 / 启用降落伞（上方卡片显示下一级的动作，点卡片查看全部分级）'),
          ...k('油门', '左侧滑杆上下拖动；“满”“关”一键全开 / 关闭'),
          ...k('方向舵', '拖动导航球旁圆形刻度盘上的旋钮，直接设定火箭倾角（0° 竖直，右边向东，180° 竖直向下，可以转满一圈）；火箭自动转过去并保持'),
          ...k('摇杆', '右下角：上下 = 俯仰（上推低头），左右 = 偏航；⟲ ⟳ 按住滚转'),
          ...k('SAS', '姿态稳定：保持 / 顺行 / 逆行 / 法向 / 径向 / 机动方向'),
          ...k('辅助', '飞行辅助：自动入轨 / 执行机动 / 自动着陆'),
          ...k('规划', '机动规划：奔月转移、月球捕获、返回地球等一键计算'),
          ...k('腿 / 伞', '收放着陆腿、启用降落伞'),
          ...k('◀ ▶', '顶部：时间加速；中间读数点按恢复实时'),
          ...k('🗺 🎥 ❚❚', '地图视图 / 切换相机 / 暂停'),
          ...k('手势', '单指拖动画面旋转视角，双指捏合缩放'),
          ...k('面板', '点按左上遥测、右上轨道面板可展开更多数据'),
        ),
        h('h3', { class: 'modal-sub' }, '登月攻略'),
        h(
          'ol',
          null,
          h('li', null, '从海南文昌起飞，竖直爬升到约 1 km 后，拖动“方向舵”让火箭慢慢向东倾斜（约 10 km 时 30°，约 45 km 时接近 80°）。'),
          h('li', null, '远地点到达约 100 km 时把油门拉到“关”，滑行到大气层外，在远地点附近点火“圆化”进入轨道（近地点 > 70 km）。'),
          h('li', null, '打开“规划”→“奔月转移”。停泊轨道有约 19.6° 倾角，要等月球转到合适位置（发射窗口），可以放心用时间加速，然后“执行机动”。途中用“修正近月点”微调。'),
          h('li', null, '进入月球影响球后用“月球捕获”在近月点减速；再“降低近月点”，并在低空按逆行方向减速着陆。'),
          h('li', null, '着陆前放下着陆腿，触地速度控制在 3 m/s 以内。“建议点火”倒计时会提示你何时开始减速。'),
          h('li', null, '返回：从月面起飞入轨 →“返回地球”→“修正再入角”。再入前分离着陆级，SAS 选“逆行”（隔热罩朝前），降落伞会自动张开。'),
        ),
        h('p', { class: 'muted small' }, '新手可以全程使用“辅助”：自动入轨 → 规划奔月转移 → 执行机动 → … → 自动着陆。'),
        h('p', { class: 'muted small' }, standaloneHint()),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (this.flight ? this.showPause() : this.closeModal()) }, '明白了')),
      ),
    );
  }

  showSettings(): void {
    const q = (v: Quality, label: string) =>
      h(
        'button',
        {
          class: this.quality === v ? 'on' : '',
          onclick: () => {
            if (v === this.quality) return;
            if (this.flight && !confirm('切换画质需要重新载入页面，当前飞行进度会丢失。继续吗？')) return;
            lsSet(QUALITY_KEY, v);
            location.reload();
          },
        },
        label,
      );
    const vol = h('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(this.sound.volume),
      oninput: (e: Event) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        this.sound.setVolume(v);
        lsSet(VOLUME_KEY, String(v));
      },
    });
    const hapticBtn = h(
      'button',
      {
        class: this.hapticsOn ? 'on' : '',
        onclick: () => {
          this.hapticsOn = !this.hapticsOn;
          lsSet(HAPTIC_KEY, this.hapticsOn ? '1' : '0');
          hapticBtn.classList.toggle('on', this.hapticsOn);
          hapticBtn.textContent = this.hapticsOn ? '震动反馈：开' : '震动反馈：关';
          if (this.hapticsOn) haptic(30);
        },
      },
      this.hapticsOn ? '震动反馈：开' : '震动反馈：关',
    );
    const fsOk = !!document.documentElement.requestFullscreen;
    const fsBtn = fsOk
      ? h(
          'button',
          {
            onclick: () => {
              if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
              else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
              this.closeModal();
            },
          },
          document.fullscreenElement ? '退出全屏' : '⛶ 全屏',
        )
      : null;
    this.openModal(
      h(
        'div',
        { class: 'modal panel' },
        h('h2', null, '设置'),
        h('p', null, '画质（切换后会重新载入页面）'),
        h('div', { class: 'actions seg' }, q('low', '流畅'), q('medium', '均衡'), q('high', '精细')),
        h('p', { class: 'muted small' }, `当前渲染分辨率 ${Math.round(this.engine.pixelRatio * 100)}%（帧率不足时自动降低）。手机发烫或掉帧时请选“流畅”。`),
        h('p', { style: { marginTop: '14px' } }, '音量'),
        vol,
        h('p', { style: { marginTop: '14px' } }, '∞ 无限燃料'),
        h(
          'div',
          { class: 'actions seg' },
          h(
            'button',
            {
              class: this.infiniteFuel ? 'on' : '',
              onclick: () => {
                this.setInfiniteFuel(true);
                this.showSettings();
              },
            },
            '开',
          ),
          h(
            'button',
            {
              class: this.infiniteFuel ? '' : 'on',
              onclick: () => {
                this.setInfiniteFuel(false);
                this.showSettings();
              },
            },
            '关（正常）',
          ),
        ),
        h('p', { class: 'muted small' }, '液体燃料箱始终是满的，液体发动机不会熄火；固体助推器无法关机，照常烧完。飞行中切换立即生效。'),
        h('div', { class: 'actions' }, hapticBtn, fsBtn),
        h('p', { class: 'muted small' }, standaloneHint()),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (this.flight ? this.showPause() : this.closeModal()) }, '完成')),
      ),
    );
  }
}

/** 默认画质：高端机用“均衡”，其余用“流畅”。 */
function defaultQuality(): Quality {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (!coarse) return 'medium';
  return mem >= 8 && cores >= 8 ? 'medium' : 'low';
}

function standaloneHint(): string {
  const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (standalone) return '已作为应用运行。';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios ? '提示：在 Safari 中点“分享 → 添加到主屏幕”，即可像 App 一样全屏运行（并可离线游玩）。' : '提示：在浏览器菜单中选择“添加到主屏幕 / 安装应用”，即可全屏运行（并可离线游玩）。';
}

function failureHint(reason: string): string {
  if (reason.includes('过热')) return '提示：从月球返回时速度约 3 km/s，必须有隔热罩并保持逆行姿态（隔热罩朝前）。也可以把再入近地点抬高一些，让减速更平缓。';
  if (reason.includes('撞击')) return '提示：着陆时注意“建议点火”倒计时，放下着陆腿，最后阶段把速度降到 2~3 m/s。地球返回请确认降落伞已启用。';
  return '提示：检查推重比与各级的 Δv，打开“操作说明”查看登月攻略。';
}

function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

// 离线缓存（PWA）：只在正式构建中注册，开发时不缓存；单文件离线包（npm run package）本身就不需要网络
if (import.meta.env.PROD && import.meta.env.MODE !== 'offline' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // 首次打开时已下载的资源也交给离线缓存
        const urls = performance.getEntriesByType('resource').map((e) => e.name);
        reg.active?.postMessage({ type: 'precache', urls });
      })
      .catch(() => {});
  });
}

if (!webglOk()) {
  (document.getElementById('loading-text') as HTMLDivElement).textContent = '你的浏览器不支持 WebGL2，无法运行本游戏。请升级系统或使用最新版 Chrome / Safari。';
} else {
  const app = new App();
  app.init().catch((e) => {
    console.error(e);
    (document.getElementById('loading-text') as HTMLDivElement).textContent = `初始化失败：${e?.message ?? e}`;
  });
}
