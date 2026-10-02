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

const QUALITY_KEY = 'rocket-game-quality';
const VOLUME_KEY = 'rocket-game-volume';
const AUTOSCALE_KEY = 'rocket-game-autoscale';

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
  private lastSepSound = -1;
  /** 调试与自动化测试用 */
  readonly __THREE = THREE;

  constructor() {
    const canvas = document.getElementById('view') as HTMLCanvasElement;
    const stored = lsGet(QUALITY_KEY) as Quality | null;
    const touch = matchMedia('(pointer: coarse)').matches;
    this.quality = stored ?? (touch ? 'low' : 'medium');
    this.engine = new RenderEngine(canvas, this.quality);
    this.engine.setAutoScale(lsGet(AUTOSCALE_KEY) !== '0');
    const vol = parseFloat(lsGet(VOLUME_KEY) ?? '0.7');
    this.sound.volume = isFinite(vol) ? vol : 0.7;
  }

  async init(): Promise<void> {
    const fill = document.getElementById('loading-fill') as HTMLDivElement;
    this.maps = await bakePlanets(this.engine.renderer, this.quality, (f) => (fill.style.width = `${Math.round(f * 100)}%`));
    (document.getElementById('loading-text') as HTMLDivElement).textContent = '准备总装车间……';
    this.builderScene = new BuilderScene(this.engine);
    this.builderUI = new BuilderUI(this.ui, this.builderScene);
    this.builderUI.onLaunch = (d, s) => this.startFlight(d, s);
    this.builderUI.onHelp = () => this.showHelp();
    this.builderUI.onSettings = () => this.showSettings();
    this.bindInput();
    document.getElementById('loading')!.classList.add('hide');
    requestAnimationFrame(() => this.frame());
    (window as unknown as { __game: App }).__game = this;
  }

  // ---------------------------------------------------------------- 飞行开始/结束

  startFlight(design: RocketDesign, scenario: Scenario): void {
    this.sound.start();
    this.closeModal();
    if (this.flight) this.endFlight(false);
    this.builderUI.show(false);
    this.builderScene.controls.enabled = false;
    const sim = new FlightSim(design, scenario);
    // 轨迹预测由主循环逐帧推进（见 FlightSim.pumpPrediction）
    sim.livePrediction = true;
    sim.isWater = (_b, dir) => sampleWater(this.maps, dir);
    const scene = new FlightScene(this.engine, this.maps, sim, this.mapOverlay);
    const hud = new FlightHUD(this.ui, sim, scene, {
      pause: () => this.showPause(),
      toggleMap: () => this.toggleMap(),
      cycleCamera: () => this.cycleCamera(),
      click: () => this.sound.click(),
    });
    this.flight = { sim, scene, hud, design, scenario, maxAlt: 0, maxSpeed: 0, destroyedAt: null, victoryShown: false };
    if (scenario === 'pad') {
      hud.toast('按 空格键 点火升空！（或使用右下角“自动入轨”）', 'info');
      hud.toast('← / → 方向舵（直接设定倾角）· Shift/↓ 油门 · 上方“下一步”会提示每一步该做什么', 'info');
    } else {
      hud.toast(scenario === 'llo' ? '环月轨道：先降低近月点，再用“自动着陆”或手动着陆' : '地球轨道练习：打开“机动规划”尝试奔月', 'info');
    }
  }

  endFlight(showBuilder = true): void {
    const f = this.flight;
    if (!f) return;
    f.scene.dispose();
    f.hud.dispose();
    this.flight = null;
    this.mapOverlay.style.display = 'none';
    this.sound.update(0, 0, 0, true);
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
    f.hud.togglePlanner(m === 'map' ? true : undefined);
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

  // ---------------------------------------------------------------- 输入

  bindInput(): void {
    // 防止飞行中误触 Ctrl+W 等快捷键关闭页面
    window.addEventListener('beforeunload', (e) => {
      if (this.flight && !this.flight.sim.destroyed) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.sound.start();
      const f = this.flight;
      if (e.code === 'Escape') {
        if (this.modal) this.closeModal();
        else if (f) this.showPause();
        e.preventDefault();
        return;
      }
      if (!f || this.modal) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) {
        this.keys.add(e.code);
        return;
      }
      this.keys.add(e.code);
      const sim = f.sim;
      switch (e.code) {
        case 'Space':
          sim.stage();
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
        case 'F1':
          e.preventDefault();
          f.hud.root.style.display = f.hud.root.style.display === 'none' ? '' : 'none';
          break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    const canvas = this.engine.renderer.domElement;
    let drag = false;
    let lx = 0;
    let ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      this.sound.start();
      if (!this.flight) return;
      drag = true;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || !this.flight) return;
      this.flight.scene.orbitCamera(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    canvas.addEventListener('pointerup', () => (drag = false));
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.flight) return;
        this.flight.scene.zoom(e.deltaY, e.clientX, e.clientY);
        e.preventDefault();
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private applyKeys(dt: number): void {
    const f = this.flight;
    if (!f) return;
    const sim = f.sim;
    const k = this.keys;
    const ax = (a: string, b: string) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
    sim.input.pitch = ax('KeyS', 'KeyW');
    sim.input.yaw = ax('KeyD', 'KeyA');
    sim.input.roll = ax('KeyE', 'KeyQ');
    // ← / →：方向舵，每秒转 35°
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
    const dtRaw = (now - this.last) / 1000;
    const dt = Math.min(0.1, dtRaw);
    this.last = now;
    this.realTime += dt;
    const f = this.flight;
    if (!f) {
      this.builderScene.update();
      const cpu = performance.now() - now;
      this.builderScene.render();
      this.engine.adapt(dtRaw, cpu);
      return;
    }
    const sim = f.sim;
    this.applyKeys(dt);
    sim.paused = !!this.modal;
    sim.update(dt);
    // 实时轨迹预测：每帧最多花几毫秒，算完立即开始下一次；帧率偏低时少花一些
    sim.pumpPrediction(this.engine.fps < 45 ? 1.5 : 3);
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
    f.hud.setPerf(this.engine.fps, this.engine.pixelRatio);
    f.hud.update(dt);
    const air = tel.body.atmosphere ? tel.density / tel.body.atmosphere.rho0 : 0;
    this.sound.update(sim.paused ? 0 : tel.thrust, air, tel.dynPressure, sim.paused);
    // 脚本耗时（不含渲染）：用来判断瓶颈在显卡还是 CPU
    const cpu = performance.now() - now;
    f.scene.render();
    this.engine.adapt(dtRaw, cpu);
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
        }
        break;
      case 'ignite':
        this.sound.ignite();
        break;
      case 'explosion':
        this.sound.explosion((size ?? 0) > 6);
        break;
      case 'chuteOpen':
        this.sound.chute();
        break;
      case 'mission':
      case 'landed':
        this.sound.chime(level !== 'bad');
        break;
      case 'destroyed':
        f.destroyedAt = this.realTime;
        f.hud.toast(msg ?? '飞行器损毁', 'bad');
        break;
      case 'victory':
        if (!f.victoryShown) {
          f.victoryShown = true;
          const mars = msg?.includes('火星') ?? false;
          setTimeout(() => this.showVictory(mars), 2500);
        }
        break;
    }
  }

  // ---------------------------------------------------------------- 模态框

  openModal(content: HTMLElement): void {
    this.closeModal();
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
          { class: 'actions' },
          h('button', { class: 'primary', onclick: () => this.closeModal() }, '继续飞行'),
          h('button', { onclick: () => this.restart() }, '重新发射'),
          h(
            'button',
            {
              onclick: () => {
                this.closeModal();
                this.endFlight(true);
              },
            },
            '返回总装车间',
          ),
          h('button', { onclick: () => this.showHelp() }, '操作说明'),
          h('button', { onclick: () => this.showSettings() }, '设置'),
        ),
      ),
    );
  }

  showFailure(): void {
    const f = this.flight;
    if (!f) return;
    this.openModal(
      h(
        'div',
        { class: 'modal panel fail' },
        h('h2', null, '任务失败'),
        h('p', null, f.sim.destroyReason),
        h('p', null, `任务时间 ${fmtMET(f.sim.met)} · 最高海拔 ${fmtDist(f.maxAlt)} · 最大过载 ${f.sim.maxG.toFixed(1)} g`),
        h('p', { style: { color: '#8a97a8' } }, failureHint(f.sim.destroyReason)),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', onclick: () => this.restart() }, '重新发射'),
          h(
            'button',
            {
              onclick: () => {
                this.closeModal();
                this.endFlight(true);
              },
            },
            '返回总装车间',
          ),
        ),
      ),
    );
  }

  showVictory(mars = false): void {
    const f = this.flight;
    if (!f) return;
    this.openModal(
      h(
        'div',
        { class: 'modal panel victory' },
        h('h2', null, mars ? '🔴 任务完成！' : '🌕 任务完成！'),
        h('p', null, mars ? '你的航天员踏上了火星，并跨越行星际空间安全返回了地球！' : '你的航天员登上了月球，并安全返回了地球。这是一次完美的登月任务！'),
        h('p', null, `任务总时长 ${fmtMET(f.sim.met)} · 最大过载 ${f.sim.maxG.toFixed(1)} g`),
        h('ul', null, ...MISSIONS.map((m) => h('li', null, `${f.sim.missions.done.has(m.id) ? '✔' : '○'} ${m.title} — ${m.desc}`))),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', onclick: () => this.closeModal() }, '继续'),
          h(
            'button',
            {
              onclick: () => {
                this.closeModal();
                this.endFlight(true);
              },
            },
            '返回总装车间',
          ),
        ),
      ),
    );
  }

  showHelp(): void {
    const k = (keys: string, desc: string) => [h('div', null, ...keys.split(' ').map((x) => h('kbd', null, x))), h('div', null, desc)];
    this.openModal(
      h(
        'div',
        { class: 'modal panel' },
        h('h2', null, '操作说明'),
        h(
          'div',
          { class: 'keys' },
          ...k('空格', '分级：点火 / 分离下面级 / 抛离助推器 / 启用降落伞'),
          ...k('Shift ↑', '增加油门'),
          ...k('↓ Ctrl', '减小油门'),
          ...k('Z X', '油门全开 / 关闭'),
          ...k('← →', '方向舵：逆时针（向西）/ 顺时针（向东）转动，可以转满一圈；火箭自动转到设定角度并保持（也可拖动导航球右侧的圆形刻度盘）'),
          ...k('W S', '俯仰（W 低头，S 抬头）'),
          ...k('A D', '偏航'),
          ...k('Q E', '滚转'),
          ...k('T', '开关 SAS 姿态稳定'),
          ...k('G', '收放着陆腿'),
          ...k('P', '启用降落伞'),
          ...k('M', '二维地图：拖动平移、滚轮缩放，“自动”视图始终框住整条预测轨迹'),
          ...k('N', '机动规划面板'),
          ...k(', . /', '时间加速：减 / 加 / 恢复实时'),
          ...k('V', '切换相机模式'),
          ...k('Tab', '地图中切换焦点（地球 / 月球 / 飞船）'),
          ...k('鼠标拖动 滚轮', '飞行视图：旋转视角 / 缩放；地图：平移 / 缩放'),
          ...k('Esc', '暂停菜单'),
          ...k('F1', '隐藏 / 显示界面'),
        ),
        h('h2', { style: { marginTop: '18px', fontSize: '17px' } }, '看懂轨迹'),
        h(
          'p',
          { style: { fontSize: '12.5px' } },
          '橙色 = 已飞过的动力段，淡蓝 = 滑行段，青色亮线 = 从火箭出发的预测轨迹（末段变红表示会撞地），白色淡线 = 约 1 秒前的预测轨迹。转向或点火时白线与青线分开，差距就是你的操作带来的变化。左下角“弹道剖面”画出高度随航程的变化，远/近拱点旁的 ▲▼ 表示正在升高或降低。',
        ),
        h('h2', { style: { marginTop: '18px', fontSize: '17px' } }, '登月攻略（也可以跟着屏幕上方的“下一步”提示做）'),
        h(
          'ol',
          null,
          h('li', null, '从海南文昌（北纬 19.6°）起飞，竖直爬升到约 1 km 后，按 → 或拖动导航球右侧的“方向舵”刻度盘，让火箭慢慢向东倾斜（约 10 km 时 30°，约 45 km 时接近 80°）；火箭会自动转到设定角度并保持。也可以用 W 手动倾斜，沿“顺行”标记做重力转弯。'),
          h('li', null, '远地点到达约 100 km 时关闭发动机，滑行到大气层外，在远地点附近点火“圆化”进入轨道（近地点 > 70 km）。'),
          h('li', null, '打开地图（M）→ 机动规划 →“奔月转移”。停泊轨道有约 19.6° 倾角，要等月球转到合适位置（发射窗口），可以放心用时间加速，然后“执行机动”。途中用“修正近月点”微调。'),
          h('li', null, '进入月球影响球后用“月球捕获”在近月点减速；再“降低近月点”，并在低空按逆行方向减速着陆。'),
          h('li', null, '着陆前放下着陆腿（G），触地速度控制在 3 m/s 以内。“建议点火”倒计时会提示你何时开始减速。'),
          h('li', null, '返回：从月面起飞入轨 →“返回地球”（环月轨道有倾角时可能要等一两天的返回窗口）→“修正再入角”。再入前分离着陆级，保持逆行（隔热罩朝前），降落伞会自动张开。'),
        ),
        h(
          'p',
          { style: { fontSize: '12px' } },
          '物理：牛顿引力（含月球的受限三体问题）、齐奥尔科夫斯基火箭方程、指数大气与跨音速阻力、比冲随气压变化、气动力矩与再入加热。地月系统按 1:10 缩小（表面重力保持真实），因此入轨约需 3.4 km/s。',
        ),
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
    this.openModal(
      h(
        'div',
        { class: 'modal panel' },
        h('h2', null, '设置'),
        h('p', null, '画质（切换后会重新载入页面）'),
        h('div', { class: 'actions', style: { marginTop: '4px' } }, q('low', '低（集显/手机）'), q('medium', '中'), q('high', '高（独显）')),
        h('p', { style: { marginTop: '16px' } }, '自动分辨率：帧率低于 48 时自动降低渲染分辨率，保持流畅'),
        h(
          'div',
          { class: 'actions', style: { marginTop: '4px' } },
          h(
            'button',
            {
              class: this.engine.autoScale ? 'on' : '',
              onclick: () => {
                this.engine.setAutoScale(true);
                lsSet(AUTOSCALE_KEY, '1');
                this.showSettings();
              },
            },
            '开（推荐）',
          ),
          h(
            'button',
            {
              class: this.engine.autoScale ? '' : 'on',
              onclick: () => {
                this.engine.setAutoScale(false);
                lsSet(AUTOSCALE_KEY, '0');
                this.showSettings();
              },
            },
            '关',
          ),
        ),
        h('p', { style: { color: '#8a97a8', fontSize: '12px' } }, `当前 ${this.engine.fps.toFixed(0)} 帧/秒 · 渲染分辨率 ${Math.round((this.engine.pixelRatio / (window.devicePixelRatio || 1)) * 100)}%`),
        h('p', { style: { marginTop: '16px' } }, '音量'),
        vol,
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (this.flight ? this.showPause() : this.closeModal()) }, '完成')),
      ),
    );
  }
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

if (!webglOk()) {
  (document.getElementById('loading-text') as HTMLDivElement).textContent = '你的浏览器不支持 WebGL2，无法运行本游戏。请使用最新版 Chrome / Edge / Firefox / Safari。';
} else {
  const app = new App();
  app.init().catch((e) => {
    console.error(e);
    (document.getElementById('loading-text') as HTMLDivElement).textContent = `初始化失败：${e?.message ?? e}`;
  });
}
