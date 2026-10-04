import * as THREE from 'three';
import type { FlightSim, SasMode } from '../game/flight';
import { WARP_LEVELS, PHYS_WARP_MAX } from '../game/flight';
import { MISSIONS } from '../game/missions';
import { solveCapture, solveChangeApsis, solveCircularize, solveCorrection, solveReturn, solveTLI, type SolveResult } from '../game/maneuver';
import type { FlightScene } from '../render/flightScene';
import { Navball } from '../render/navball';
import { h, clear, setText } from './dom';
import { fmtDist, fmtMET, fmtSpeed, fmtTime, fmtMass } from './format';
import { HoldButton, Joystick, ThrottleSlider } from './touch';

export interface HudCallbacks {
  pause: () => void;
  toggleMap: () => void;
  cycleCamera: () => void;
  click: () => void;
  haptic: (ms: number) => void;
}

const UP = new THREE.Vector3(0, 1, 0);

const SAS_LABELS: Record<string, string> = {
  stability: '保持',
  maneuver: '机动方向',
  prograde: '顺行',
  retrograde: '逆行',
  normal: '法向',
  antinormal: '反法向',
  radialOut: '径向外',
  radialIn: '径向内',
  rudder: '方向舵',
};

const AP_LABELS: Record<string, string> = { ascent: '自动入轨', node: '执行机动', land: '自动着陆' };

type Pop = 'sas' | 'ap' | 'stages' | null;

/**
 * 手机版飞行界面：
 * 左下油门 + 分级按钮，中下导航球 + 方向舵，右下姿态摇杆，右侧工具栏（SAS / 飞行辅助 / 机动规划 / 着陆腿 / 降落伞），
 * 顶部为遥测、时间加速与轨道信息（点按可展开更多）。竖屏时自动重新排布。
 */
export class FlightHUD {
  root: HTMLDivElement;
  navball: Navball;
  stick: Joystick;
  rollL: HoldButton;
  rollR: HoldButton;
  throttle: ThrottleSlider;
  private sim: FlightSim;
  private scene: FlightScene;
  private cb: HudCallbacks;
  private els: Record<string, HTMLElement> = {};
  private toasts: HTMLDivElement;
  private missionBox: HTMLDivElement;
  private planner: HTMLDivElement;
  private plannerBody: HTMLDivElement;
  private plannerOpen = false;
  private plannerKey = '';
  private plannerMsg = '';
  private pop: HTMLDivElement;
  private popMode: Pop = null;
  private popKey = '';
  private textTimer = 0;
  private lastStageT = -10;
  private lastStageKey = '';
  private tools: Record<string, HTMLButtonElement> = {};
  private rud!: {
    svg: SVGSVGElement;
    fill: SVGPathElement;
    knob: SVGCircleElement;
    link: SVGLineElement;
    rocket: SVGGElement;
    ap: SVGPathElement;
    label: HTMLElement;
  };
  private onResize = () => this.layout();
  private onDocDown = (e: PointerEvent) => {
    if (!this.popMode) return;
    const t = e.target as Node;
    if (this.pop.contains(t)) return;
    if (Object.values(this.tools).some((b) => b.contains(t)) || this.els.stageCard?.contains(t)) return;
    this.closePop();
  };

  constructor(parent: HTMLElement, sim: FlightSim, scene: FlightScene, cb: HudCallbacks) {
    this.sim = sim;
    this.scene = scene;
    this.cb = cb;
    this.root = h('div', { class: 'hud' });
    parent.appendChild(this.root);
    const E = this.els;
    const row = (k: string, key: string, cls = '') => h('div', { class: `hud-row ${cls}` }, h('span', { class: 'k' }, k), (E[key] = h('span', { class: 'v' })));

    // ---- 左上：遥测（点按展开）
    const tele = h(
      'div',
      { class: 'f-tele panel', onclick: () => tele.classList.toggle('expanded') },
      h('div', { class: 'hud-row' }, (E.met = h('span', { class: 'hud-met' })), (E.situ = h('span', { class: 'k situ' }))),
      h('div', { class: 'hud-row' }, h('span', { class: 'k' }, '海拔'), (E.alt = h('span', { class: 'hud-big' }))),
      row('垂直速度', 'vv'),
      row('水平速度', 'hv'),
      row('离地高度', 'radar', 'more'),
      row('马赫 / 动压', 'mach', 'more'),
      row('过载', 'g', 'more'),
      row('大气压', 'pres', 'more'),
      row('总质量', 'mass', 'more'),
      h('div', { class: 'expand-hint' }, '▾'),
    );
    this.root.appendChild(tele);

    // ---- 顶部中间：时间加速、地图、相机、暂停
    const bb = (label: string, fn: () => void, cls = '', aria = '') =>
      h(
        'button',
        {
          class: cls,
          'aria-label': aria || label,
          onclick: () => {
            this.cb.click();
            fn();
          },
        },
        label,
      );
    E.warp = bb('1×', () => this.setWarp(0), 'warp-label', '恢复实时');
    E.mapBtn = bb('🗺', () => this.cb.toggleMap(), '', '地图');
    E.focusBtn = bb('焦点', () => this.scene.cycleMapFocus(), 'focus-btn', '切换地图焦点');
    this.root.appendChild(
      h(
        'div',
        { class: 'f-bar panel' },
        bb('◀', () => this.setWarp(this.sim.warpIndex - 1), '', '减速'),
        E.warp,
        bb('▶', () => this.setWarp(this.sim.warpIndex + 1), '', '加速'),
        h('span', { class: 'sep' }),
        E.mapBtn,
        E.focusBtn,
        bb('🎥', () => this.cb.cycleCamera(), '', '相机'),
        bb('❚❚', () => this.cb.pause(), '', '暂停'),
      ),
    );

    // ---- 右上：轨道（点按展开）
    this.missionBox = h('div', { class: 'missions more' });
    const orbit = h(
      'div',
      { class: 'f-orbit panel', onclick: () => orbit.classList.toggle('expanded') },
      h('h3', null, (E.orbTitle = h('span'))),
      row('远拱点', 'ap'),
      row('近拱点', 'pe'),
      row('距远拱点', 'tap', 'more'),
      row('距近拱点', 'tpe', 'more'),
      row('轨道周期', 'per', 'more'),
      row('倾角', 'inc', 'more'),
      this.missionBox,
      h('div', { class: 'expand-hint' }, '▾'),
    );
    this.root.appendChild(orbit);

    // ---- 中上：飞行辅助状态、着陆辅助、提示
    E.apBanner = h(
      'div',
      { class: 'f-ap' },
      (E.apText = h('span')),
      h(
        'button',
        {
          onclick: () => {
            this.cb.click();
            this.sim.autopilot.disengage('飞行辅助已关闭');
          },
        },
        '关闭',
      ),
    );
    E.land = h(
      'div',
      { class: 'land-panel panel' },
      h('div', null, h('div', { class: 'k' }, '离地'), (E.lAlt = h('div', { class: 'v' }))),
      h('div', null, h('div', { class: 'k' }, '垂直'), (E.lVv = h('div', { class: 'v' }))),
      h('div', null, h('div', { class: 'k' }, '水平'), (E.lHv = h('div', { class: 'v' }))),
      h('div', null, h('div', { class: 'k' }, '建议点火'), (E.lBurn = h('div', { class: 'v burn' }))),
    );
    this.toasts = h('div', { class: 'toasts' });
    this.root.appendChild(h('div', { class: 'f-center' }, E.apBanner, E.land, this.toasts));

    // ---- 左下：油门与燃料 / 温度
    this.throttle = new ThrottleSlider();
    this.throttle.get = () => this.sim.vessel.throttle;
    this.throttle.onInput = (v) => this.setThrottle(v);
    const mini = (label: string, v: number) =>
      h(
        'button',
        {
          class: 'thr-mini',
          onclick: () => {
            this.cb.click();
            this.setThrottle(v);
          },
        },
        label,
      );
    const bar = (cls: string, key: string, label: string) =>
      h('div', { class: 'mini-gauge-col' }, (E[`${key}Gauge`] = h('div', { class: `mini-gauge ${cls}` }, (E[key] = h('div', { class: 'fill' })))), (E[`${key}Lbl`] = h('div', { class: 'gl' }, label)));
    // 油门两侧：燃料（油）与蒙皮温度（温）
    const bottom = h('div', { class: 'f-bottom' });
    this.root.appendChild(bottom);
    bottom.appendChild(
      h(
        'div',
        { class: 'f-left' },
        h('div', { class: 'thr-row' }, bar('fuel', 'fuelFill', '油'), this.throttle.el, bar('heat', 'heatFill', '温')),
        h('div', { class: 'thr-btns' }, mini('关', 0), mini('满', 1)),
      ),
    );

    // ---- 分级：下一级信息 + 大按钮
    E.stageCard = h(
      'div',
      { class: 'stage-card-mini panel', onclick: () => this.togglePop('stages') },
      (E.stTitle = h('div', { class: 't' })),
      (E.stDesc = h('div', { class: 'd' })),
      (E.stInfo = h('div', { class: 'i' })),
    );
    E.stageBtn = h(
      'button',
      {
        class: 'stage-btn',
        'aria-label': '分级',
        onclick: () => this.doStage(),
      },
      h('span', { class: 'big' }, '分级'),
      (E.stageSub = h('span', { class: 'sub' })),
    );
    bottom.appendChild(h('div', { class: 'f-stage' }, E.stageCard, E.stageBtn));

    // ---- 中下：速度、导航球、方向舵
    const nbWrap = h('div', { class: 'navball-wrap' });
    this.navball = new Navball(nbWrap);
    bottom.appendChild(
      h(
        'div',
        { class: 'f-nav panel' },
        h(
          'div',
          { class: 'nav-col' },
          (E.spdMode = h('div', {
            class: 'speed-mode',
            onclick: () => {
              this.cb.click();
              const m = this.sim.speedMode;
              this.sim.speedMode = m === 'auto' ? 'orbit' : m === 'orbit' ? 'surface' : 'auto';
            },
          })),
          (E.spd = h('div', { class: 'speed-val' })),
          nbWrap,
          (E.hdg = h('div', { class: 'hdg' })),
        ),
        this.buildRudder(),
      ),
    );

    // ---- 右侧：工具栏
    const tool = (key: string, icon: string, label: string, fn: () => void) => {
      const b = h(
        'button',
        {
          class: 'tool',
          onclick: () => {
            this.cb.click();
            fn();
          },
        },
        h('span', { class: 'ti' }, icon),
        (E[`tl_${key}`] = h('span', { class: 'tl' }, label)),
      );
      this.tools[key] = b;
      return b;
    };
    bottom.appendChild(
      h(
        'div',
        { class: 'f-tools' },
        tool('sas', '◎', 'SAS', () => this.togglePop('sas')),
        tool('ap', '🤖', '辅助', () => this.togglePop('ap')),
        tool('plan', '🧭', '规划', () => this.togglePlanner()),
        tool('legs', '⟂', '着陆腿', () => this.sim.toggleLegs()),
        tool('chute', '☂', '降落伞', () => this.sim.armChute()),
      ),
    );

    // ---- 右下：姿态摇杆 + 滚转
    this.stick = new Joystick('俯仰 / 偏航');
    this.rollL = new HoldButton('⟲', 'roll');
    this.rollR = new HoldButton('⟳', 'roll');
    bottom.appendChild(h('div', { class: 'f-stick' }, h('div', { class: 'roll-row' }, this.rollL.el, h('span', { class: 'roll-lbl' }, '滚转'), this.rollR.el), this.stick.el));
    // 竖屏时用来把底部控件折成两行
    bottom.appendChild(h('div', { class: 'f-break' }));

    // ---- 弹出菜单与机动规划
    this.pop = h('div', { class: 'f-pop panel' });
    this.pop.style.display = 'none';
    this.root.appendChild(this.pop);
    this.plannerBody = h('div', { class: 'planner-body' });
    this.planner = h(
      'div',
      { class: 'planner panel' },
      h(
        'div',
        { class: 'planner-head' },
        h('h3', null, '机动规划'),
        h(
          'button',
          {
            class: 'icon-btn',
            'aria-label': '关闭',
            onclick: () => {
              this.cb.click();
              this.togglePlanner(false);
            },
          },
          '✕',
        ),
      ),
      this.plannerBody,
    );
    this.planner.style.display = 'none';
    this.root.appendChild(this.planner);

    document.addEventListener('pointerdown', this.onDocDown, true);
    window.addEventListener('resize', this.onResize);
    this.layout();
  }

  // ---------------------------------------------------------------- 布局

  /** 根据屏幕方向与尺寸调整导航球大小，并记录底部控件高度供 CSS 排布。 */
  layout(): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const portrait = H > W;
    const size = Math.round(portrait ? clamp(W * 0.3, 96, 150) : clamp(H * 0.3, 92, 176));
    this.navball.resize(size);
    this.root.style.setProperty('--nb', `${size}px`);
    this.root.classList.toggle('portrait', portrait);
    this.root.classList.toggle('tiny', !portrait && H < 400);
    requestAnimationFrame(() => {
      const nav = this.root.querySelector('.f-nav') as HTMLElement | null;
      const left = this.root.querySelector('.f-left') as HTMLElement | null;
      const stick = this.root.querySelector('.f-stick') as HTMLElement | null;
      const hgt = Math.max(nav?.offsetHeight ?? 0, left?.offsetHeight ?? 0, stick?.offsetHeight ?? 0);
      this.root.style.setProperty('--rowb', `${hgt}px`);
    });
  }

  // ---------------------------------------------------------------- 操作

  private setWarp(i: number): void {
    this.sim.autoWarpTo = null;
    this.sim.setWarp(i);
  }

  private setThrottle(v: number): void {
    this.sim.vessel.throttle = v;
    if (this.sim.autopilot.mode !== 'off') this.sim.autopilot.disengage('手动接管油门，飞行辅助已关闭');
  }

  /** 分级：0.8 秒内的重复点按被忽略，防止手指连点一次分离两级。 */
  doStage(): void {
    const now = performance.now() / 1000;
    if (now - this.lastStageT < 0.8) return;
    this.lastStageT = now;
    this.cb.haptic(25);
    this.sim.stage();
  }

  private togglePop(m: Exclude<Pop, null>): void {
    if (this.popMode === m) this.closePop();
    else {
      this.popMode = m;
      this.popKey = '';
      this.pop.style.display = '';
      this.pop.dataset.mode = m;
      this.renderPop();
    }
  }

  private closePop(): void {
    this.popMode = null;
    this.pop.style.display = 'none';
  }

  private renderPop(): void {
    const sim = this.sim;
    const m = this.popMode;
    if (!m) return;
    const key =
      m === 'sas'
        ? `${sim.sasOn}|${sim.sasMode}|${sim.nodes.length}`
        : m === 'ap'
          ? `${sim.autopilot.mode}`
          : `${sim.vessel.stageIndex}|${sim.vessel.parts.length}|${sim.vessel.chuteState}`;
    if (key === this.popKey) return;
    this.popKey = key;
    const P = this.pop;
    clear(P);
    if (m === 'sas') {
      P.appendChild(h('h3', null, '姿态控制 SAS'));
      const g = h('div', { class: 'pop-grid' });
      const b = (mode: SasMode | 'toggle', label: string, full = false) => {
        const on = mode === 'toggle' ? sim.sasOn : sim.sasOn && sim.sasMode === mode;
        g.appendChild(
          h(
            'button',
            {
              class: `${full ? 'full' : ''} ${on ? 'on' : ''}`,
              onclick: () => {
                this.cb.click();
                if (mode === 'toggle') sim.toggleSas();
                else {
                  sim.setSas(mode);
                  this.closePop();
                }
                this.popKey = '';
              },
            },
            label,
          ),
        );
      };
      b('toggle', sim.sasOn ? 'SAS 已开启（点按关闭）' : 'SAS 已关闭（点按开启）', true);
      b('stability', '保持当前姿态');
      b('maneuver', '机动方向');
      b('prograde', '顺行');
      b('retrograde', '逆行');
      b('normal', '法向');
      b('antinormal', '反法向');
      b('radialOut', '径向外');
      b('radialIn', '径向内');
      P.appendChild(g);
      P.appendChild(h('div', { class: 'note' }, '着陆时选“逆行”，把速度方向对准发动机；地球再入同样用“逆行”让隔热罩朝前。'));
    } else if (m === 'ap') {
      P.appendChild(h('h3', null, '飞行辅助'));
      const g = h('div', { class: 'pop-grid one' });
      const desc: Record<string, string> = {
        ascent: '从发射台自动爬升、重力转弯并圆化到约 100 km 轨道',
        node: '自动转向并在合适时机执行已规划的机动',
        land: '自动减速并在月面（或地面）软着陆',
      };
      for (const mode of ['ascent', 'node', 'land'] as const) {
        const on = sim.autopilot.mode === mode;
        g.appendChild(
          h(
            'button',
            {
              class: `ap-opt ${on ? 'on' : ''}`,
              onclick: () => {
                this.cb.click();
                if (on) sim.autopilot.disengage('飞行辅助已关闭');
                else sim.autopilot.engage(mode);
                this.closePop();
              },
            },
            h('span', { class: 't' }, `${on ? '■ 停止 ' : ''}${AP_LABELS[mode]}`),
            h('span', { class: 'd' }, desc[mode]),
          ),
        );
      }
      P.appendChild(g);
      P.appendChild(h('div', { class: 'note' }, '手动推油门或拨动方向舵会自动关闭飞行辅助。'));
    } else {
      P.appendChild(h('h3', null, '分级序列'));
      const V = sim.vessel;
      const list = h('div', { class: 'stage-list' });
      V.stages.forEach((st, i) => {
        if (i < V.stageIndex - 1) return;
        const cls = i < V.stageIndex ? 'done' : i === V.stageIndex ? 'next' : '';
        list.appendChild(h('div', { class: `stage-card ${cls}` }, h('div', { class: 't' }, `第 ${i + 1} 级 · ${st.label}`), h('div', { class: 'd' }, this.stageActions(i) || '—')));
      });
      P.appendChild(list);
    }
  }

  private stageActions(i: number): string {
    const V = this.sim.vessel;
    const st = V.stages[i];
    if (!st) return '';
    const parts: string[] = [];
    const eng = new Map<string, number>();
    for (const k of st.ignite) {
      const rp = V.byKey.get(k) ?? null;
      const nm = rp ? rp.p.def.name : null;
      if (nm) eng.set(nm, (eng.get(nm) ?? 0) + 1);
    }
    for (const [n, c] of eng) parts.push(`🔥 ${n}${c > 1 ? ` ×${c}` : ''}`);
    if (st.decoupleSection !== null) parts.push('⇣ 分离下面级');
    if (st.jettisonRadial.length) parts.push('⇹ 抛离助推器');
    if (st.chutes.length) parts.push('☂ 启用降落伞');
    return parts.join('　');
  }

  /** 下一次分级会做什么（显示在分级按钮上）。 */
  private stageShort(i: number): string {
    const V = this.sim.vessel;
    const st = V.stages[i];
    if (!st) return '无';
    if (st.decoupleSection !== null && st.ignite.length) return '分离 + 点火';
    if (st.decoupleSection !== null) return '分离';
    if (st.jettisonRadial.length) return '抛助推器';
    if (st.ignite.length) return '点火';
    if (st.chutes.length) return '降落伞';
    return st.label;
  }

  // ---------------------------------------------------------------- 方向舵

  /**
   * 方向舵：一整圈的圆形刻度盘，0° 竖直向上，右侧向东、左侧向西，180° 竖直向下。
   * 拖动橙色旋钮直接设定火箭倾角，可以转满一圈；中间的小火箭显示实际姿态。
   */
  private buildRudder(): HTMLElement {
    const NS = 'http://www.w3.org/2000/svg';
    const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      parent?.appendChild(e);
      return e;
    };
    const svg = el('svg', { viewBox: '0 0 200 200', class: 'rudder-dial' });
    el('circle', { cx: DIAL.cx, cy: DIAL.cy, r: DIAL.r, class: 'rud-track' }, svg);
    for (let a = -165; a <= 180; a += 15) {
      const major = a % 45 === 0;
      const [x1, y1] = dialPt(a, DIAL.r - (major ? 13 : 9));
      const [x2, y2] = dialPt(a, DIAL.r - 2);
      el('line', { x1, y1, x2, y2, class: major ? 'rud-tick major' : 'rud-tick' }, svg);
    }
    for (const a of [0, 90, 180, -90]) {
      const [x, y] = dialPt(a, 50);
      const t = el('text', { x, y: y + 6, class: 'rud-num' }, svg);
      t.textContent = String(Math.abs(a));
    }
    const w = el('text', { x: 9, y: 128, class: 'rud-dir' }, svg);
    w.textContent = '西';
    const e = el('text', { x: 191, y: 128, class: 'rud-dir' }, svg);
    e.textContent = '东';
    const fill = el('path', { d: '', class: 'rud-fill' }, svg);
    const link = el('line', { x1: DIAL.cx, y1: DIAL.cy, x2: DIAL.cx, y2: DIAL.cy - DIAL.r, class: 'rud-link' }, svg);
    const rocket = el('g', { class: 'rud-rocket' }, svg);
    el('path', { d: 'M0 -32 L5.5 -22 L5.5 -6 L10 1 L-10 1 L-5.5 -6 L-5.5 -22 Z' }, rocket);
    const ap = el('path', { d: 'M0 0 L-6 -10 L6 -10 Z', class: 'rud-ap' }, svg);
    const knob = el('circle', { cx: DIAL.cx, cy: DIAL.cy - DIAL.r, r: 13, class: 'rud-knob' }, svg);
    el('circle', { cx: DIAL.cx, cy: DIAL.cy, r: 3.5, class: 'rud-hub' }, svg);

    const setFromPointer = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * 200;
      const y = ((ev.clientY - r.top) / r.height) * 200;
      // 取整到 1°，竖直、水平与倒立附近吸附（手指不如鼠标精确，吸附范围大一些）
      let deg = Math.round((Math.atan2(x - DIAL.cx, DIAL.cy - y) * 180) / Math.PI);
      for (const snap of [0, 90, -90, 180, -180]) if (Math.abs(deg - snap) <= 3) deg = snap;
      this.sim.setRudder((deg * Math.PI) / 180);
    };
    let pid: number | null = null;
    svg.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      pid = ev.pointerId;
      svg.setPointerCapture(ev.pointerId);
      this.cb.click();
      setFromPointer(ev);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (ev.pointerId === pid) setFromPointer(ev);
    });
    const end = (ev: PointerEvent) => {
      if (ev.pointerId === pid) pid = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    const step = (deg: number) => () => {
      this.cb.click();
      this.sim.nudgeRudder((deg * Math.PI) / 180);
    };
    const label = h('div', {
      class: 'rudder-lbl',
      onclick: () => {
        this.cb.click();
        if (this.sim.rudderActive) this.sim.setSas('stability');
        else this.sim.setRudder(this.sim.tiltAngle());
      },
    });
    this.rud = { svg, fill, knob, link, rocket, ap, label };
    return h(
      'div',
      { class: 'rudder' },
      svg,
      h('div', { class: 'rudder-row' }, h('button', { onclick: step(-5), 'aria-label': '逆时针 5°（向西）' }, '↺'), label, h('button', { onclick: step(5), 'aria-label': '顺时针 5°（向东）' }, '↻')),
    );
  }

  private updateRudder(): void {
    const sim = this.sim;
    const R = this.rud;
    const deg = (x: number) => (x * 180) / Math.PI;
    const actual = deg(sim.tiltAngle());
    R.rocket.setAttribute('transform', `translate(${DIAL.cx} ${DIAL.cy}) rotate(${actual.toFixed(1)})`);
    const active = sim.rudderActive;
    const cmd = deg(sim.rudderAngle);
    R.svg.classList.toggle('on', active);
    // 未启用时旋钮停在实际姿态处，拖动即可接管
    const [kx, ky] = dialPt(active ? cmd : actual, DIAL.r);
    R.knob.setAttribute('cx', kx.toFixed(1));
    R.knob.setAttribute('cy', ky.toFixed(1));
    R.link.setAttribute('x2', kx.toFixed(1));
    R.link.setAttribute('y2', ky.toFixed(1));
    R.fill.setAttribute('d', active && Math.abs(cmd) > 0.5 ? arcPath(0, cmd) : '');
    // 飞行辅助的目标倾角（蓝色三角）
    const ap = sim.autopilot.mode !== 'off' ? sim.autopilot.targetDir : null;
    if (ap) {
      const tel = sim.telemetry;
      const a = deg(Math.atan2(ap.dot(tel.east), ap.dot(tel.up)));
      const [x, y] = dialPt(a, DIAL.r + 14);
      R.ap.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(1)})`);
      R.ap.style.display = '';
    } else R.ap.style.display = 'none';
    const dirTxt = (d: number) => (Math.abs(d) < 0.5 ? '竖直' : Math.abs(d) > 179.5 ? '倒立' : `${d > 0 ? '东' : '西'}${Math.abs(d).toFixed(0)}°`);
    setText(R.label, active ? `舵 ${dirTxt(cmd)}` : `舵关 ${dirTxt(actual)}`);
    R.label.classList.toggle('on', active);
  }

  // ---------------------------------------------------------------- 机动规划

  togglePlanner(v?: boolean): void {
    this.plannerOpen = v ?? !this.plannerOpen;
    this.planner.style.display = this.plannerOpen ? '' : 'none';
    this.root.classList.toggle('planning', this.plannerOpen);
    this.plannerKey = '';
    if (this.plannerOpen) this.closePop();
  }

  toast(msg: string, level: string = 'info'): void {
    const el = h('div', { class: `toast ${level}` }, msg);
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    setTimeout(
      () => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500);
      },
      level === 'bad' || level === 'good' ? 5000 : 3200,
    );
  }

  // ---------------------------------------------------------------- 每帧

  update(dt: number): void {
    const sim = this.sim;
    const tel = sim.telemetry;
    const V = sim.vessel;
    // 导航球（每帧）
    const vel = tel.speedModeUsed === 'surface' ? tel.vSurfVec : tel.vOrbVec;
    const bp = tel.up.clone().multiplyScalar(tel.alt + tel.body.radius);
    const nrm = new THREE.Vector3().crossVectors(bp, tel.vOrbVec).normalize();
    const radOut = nrm.clone().cross(tel.vOrbVec).normalize();
    const hasVel = vel.length() > 0.5;
    const nodeVec = sim.nodeBurnVector();
    this.navball.update(V.q, tel.east, tel.up, tel.north, {
      prograde: hasVel ? vel.clone() : null,
      retrograde: hasVel ? vel.clone().negate() : null,
      normal: tel.vOrbVec.length() > 1 ? nrm : null,
      antinormal: tel.vOrbVec.length() > 1 ? nrm.clone().negate() : null,
      radialOut: tel.vOrbVec.length() > 1 ? radOut : null,
      radialIn: tel.vOrbVec.length() > 1 ? radOut.clone().negate() : null,
      maneuver: nodeVec && nodeVec.lengthSq() > 1e-4 ? nodeVec : null,
    });
    const E = this.els;
    this.throttle.update(V.throttle);
    E.fuelFill.style.height = `${V.stageFuelFraction() * 100}%`;
    // 无限燃料：燃料条换成金色，标签显示 ∞
    if (E.fuelFillGauge.classList.contains('inf') !== V.infiniteFuel) {
      E.fuelFillGauge.classList.toggle('inf', V.infiniteFuel);
      E.fuelFillLbl.textContent = V.infiniteFuel ? '∞' : '油';
    }
    E.heatFill.style.height = `${Math.min(100, Math.max(0, ((tel.temp - 250) / Math.max(1, tel.tempMax - 250)) * 100))}%`;
    this.updateRudder();

    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 0.1;

    setText(E.met, fmtMET(sim.met));
    const situ = sim.destroyed
      ? '已损毁'
      : sim.landed
        ? `${tel.body.name} · ${sim.touchingWater ? '溅落' : '着陆'}`
        : tel.inAtmosphere
          ? `${tel.body.name} · 大气层内`
          : tel.orbit.hyperbolic
            ? `${tel.body.name} · 逃逸轨道`
            : tel.orbit.peAlt > (tel.body.atmosphere?.height ?? 5000)
              ? `${tel.body.name} · 稳定轨道`
              : `${tel.body.name} · 亚轨道`;
    setText(E.situ, situ);
    setText(E.alt, fmtDist(tel.alt));
    setText(E.radar, fmtDist(Math.max(0, tel.radarAlt)));
    setText(E.vv, fmtSpeed(tel.vVert));
    setText(E.hv, fmtSpeed(tel.vHoriz));
    setText(E.mach, tel.density > 0 ? `${tel.mach.toFixed(2)} / ${(tel.dynPressure / 1000).toFixed(1)} kPa` : '—');
    setText(E.g, `${tel.gforce.toFixed(2)} g`);
    setText(E.pres, tel.pressure > 0 ? `${(tel.pressure / 1000).toFixed(2)} kPa` : '真空');

    // 时间加速
    setText(E.warp, sim.paused ? '暂停' : `${WARP_LEVELS[sim.warpIndex]}×${sim.warpIndex > 0 && sim.warpIndex <= PHYS_WARP_MAX ? '物理' : ''}`);
    E.warp.classList.toggle('on', sim.warpIndex > 0);
    E.mapBtn.classList.toggle('on', this.scene.mode === 'map');
    E.focusBtn.style.display = this.scene.mode === 'map' ? '' : 'none';

    // 轨道
    const o = tel.orbit;
    setText(E.orbTitle, `${tel.body.name}轨道`);
    const ground = sim.landed;
    setText(E.ap, ground ? '—' : o.hyperbolic ? '逃逸' : fmtDist(o.apAlt));
    setText(E.pe, ground ? '—' : fmtDist(o.peAlt));
    setText(E.tap, ground || o.hyperbolic ? '—' : fmtTime(o.timeToAp));
    setText(E.tpe, !ground && isFinite(o.timeToPe) && o.timeToPe > 0 ? fmtTime(o.timeToPe) : '—');
    setText(E.per, !ground && isFinite(o.period) ? fmtTime(o.period) : '—');
    setText(E.inc, `${((o.inc * 180) / Math.PI).toFixed(1)}°`);
    const mk = [...sim.missions.done].join(',');
    if (this.missionBox.dataset.k !== mk) {
      this.missionBox.dataset.k = mk;
      clear(this.missionBox);
      this.missionBox.appendChild(h('h3', null, `任务 ${sim.missions.done.size}/${MISSIONS.length}`));
      for (const m of MISSIONS) {
        const done = sim.missions.done.has(m.id);
        this.missionBox.appendChild(h('div', { class: `mission ${done ? 'done' : ''}` }, `${done ? '✔' : '○'} ${m.title}`));
      }
    }

    // 速度与航向
    const mode = tel.speedModeUsed;
    setText(E.spdMode, `${sim.speedMode === 'auto' ? '自动·' : ''}${mode === 'surface' ? '地表速度' : '轨道速度'}`);
    setText(E.spd, fmtSpeed(mode === 'surface' ? tel.surfSpeed : tel.orbSpeed));
    const fwd = UP.clone().applyQuaternion(V.q);
    const pitch = (Math.asin(Math.max(-1, Math.min(1, fwd.dot(tel.up)))) * 180) / Math.PI;
    let hdg = (Math.atan2(fwd.dot(tel.east), fwd.dot(tel.north)) * 180) / Math.PI;
    if (hdg < 0) hdg += 360;
    setText(E.hdg, `航向${hdg.toFixed(0).padStart(3, '0')}° 俯仰${pitch.toFixed(1)}°`);

    // 工具栏状态
    const T = this.tools;
    T.sas.classList.toggle('on', sim.sasOn);
    setText(E.tl_sas, sim.sasOn ? SAS_LABELS[sim.sasMode] ?? 'SAS' : 'SAS 关');
    T.ap.classList.toggle('on', sim.autopilot.mode !== 'off');
    setText(E.tl_ap, sim.autopilot.mode !== 'off' ? AP_LABELS[sim.autopilot.mode] ?? '辅助' : '辅助');
    T.plan.classList.toggle('on', this.plannerOpen);
    T.plan.classList.toggle('dot', sim.nodes.length > 0);
    T.legs.classList.toggle('on', V.legsDeployed);
    T.legs.classList.toggle('dim', !V.hasLegs());
    T.chute.classList.toggle('on', V.chuteState !== 'stowed');
    T.chute.classList.toggle('dim', !V.chutePart());
    const apOn = sim.autopilot.mode !== 'off';
    E.apBanner.style.display = apOn ? '' : 'none';
    if (apOn) setText(E.apText, `🤖 ${AP_LABELS[sim.autopilot.mode] ?? ''}${sim.autopilot.status ? ` · ${sim.autopilot.status}` : ''}`);

    // 分级
    const sk = `${V.stageIndex}|${V.parts.length}|${V.chuteState}`;
    if (sk !== this.lastStageKey) {
      this.lastStageKey = sk;
      const i = V.stageIndex;
      const st = V.stages[i];
      setText(E.stTitle, st ? `下一级：第 ${i + 1} 级` : '没有更多分级');
      setText(E.stDesc, st ? this.stageActions(i) || st.label : '');
      setText(E.stageSub, this.stageShort(i));
      E.stageBtn.classList.toggle('empty', !st);
    }
    setText(E.stInfo, `Δv ${isFinite(tel.stageDv) ? tel.stageDv.toFixed(0) : '∞'} · TWR ${tel.thrust > 0 ? tel.twr.toFixed(2) : (V.maxThrustVac().thrust / (V.mass * tel.gLocal)).toFixed(2)}`);
    setText(E.mass, fmtMass(V.mass));

    // 着陆辅助
    const showLand = !sim.landed && !sim.destroyed && tel.radarAlt < 6000 && (tel.vVert < -0.5 || tel.radarAlt < 200) && !(tel.body.atmosphere && V.chuteState !== 'stowed');
    E.land.style.display = showLand ? '' : 'none';
    if (showLand) {
      setText(E.lAlt, fmtDist(Math.max(0, tel.radarAlt)));
      setText(E.lVv, fmtSpeed(tel.vVert));
      setText(E.lHv, fmtSpeed(tel.vHoriz));
      const s = tel.suicideIn;
      E.lBurn.classList.toggle('now', isFinite(s) && s < 1.5);
      setText(E.lBurn, !isFinite(s) ? '—' : s < 1.5 ? '立即减速!' : fmtTime(s));
    }

    if (this.popMode) this.renderPop();
    if (this.plannerOpen) this.updatePlanner();
  }

  // ---------------------------------------------------------------- 机动规划

  private solve(f: () => SolveResult): void {
    const sim = this.sim;
    const r = f();
    this.plannerMsg = r.msg;
    if (r.node) {
      sim.addNode(r.node);
      this.toast(r.msg, 'info');
    } else this.toast(r.msg, 'warn');
    this.plannerKey = '';
  }

  /** 规划面板里随时间变化的数字：原地更新，不重建按钮（重建会吞掉正在进行的点按） */
  private plannerLive: (() => void) | null = null;

  private updatePlanner(): void {
    const sim = this.sim;
    const n = sim.nodes[0];
    const key = n ? `n|${n.dv.x.toFixed(2)}|${n.dv.y.toFixed(2)}|${n.dv.z.toFixed(2)}|${n.t.toFixed(1)}|${sim.autopilot.mode}` : `e|${this.plannerMsg}`;
    if (key === this.plannerKey) {
      this.plannerLive?.();
      return;
    }
    this.plannerKey = key;
    this.plannerLive = null;
    const P = this.plannerBody;
    const scroll = P.scrollTop;
    clear(P);
    const state = () => ({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    const btn = (label: string, fn: () => void, cls = '') =>
      h(
        'button',
        {
          class: cls,
          onclick: () => {
            this.cb.click();
            fn();
          },
        },
        label,
      );
    if (!n) {
      const b = (label: string, f: () => SolveResult) => btn(label, () => this.solve(f));
      P.appendChild(
        h(
          'div',
          { class: 'grid' },
          b('远拱点圆化', () => solveCircularize(state(), 'ap')),
          b('近拱点圆化', () => solveCircularize(state(), 'pe')),
          b('🌙 奔月转移', () => solveTLI(state())),
          b('修正近月点', () => solveCorrection(state(), 'moon', 40_000, 90)),
          b('月球捕获', () => solveCapture(state(), sim.prediction ?? undefined)),
          b('降低近月点', () => solveChangeApsis(state(), 'ap', 6_000)),
          b('🌍 返回地球', () => solveReturn(state())),
          b('修正再入角', () => solveCorrection(state(), 'earth', 35_000, 90)),
          b('＋ 手动节点', () => ({ node: { t: sim.t + 300, dv: new THREE.Vector3() }, msg: '已在 5 分钟后创建空白节点' })),
        ),
      );
      if (this.plannerMsg) P.appendChild(h('div', { class: 'note' }, this.plannerMsg));
      P.appendChild(
        h(
          'div',
          { class: 'note muted' },
          '奔月：在近地轨道点“奔月转移”（会自动等待发射窗口）→ 执行机动 → 途中“修正近月点”→“月球捕获”→“降低近月点”。返回：月面起飞入轨 →“返回地球”→“修正再入角”。点 🗺 查看预测轨迹。',
        ),
      );
      P.scrollTop = scroll;
      return;
    }
    const row = (k: string) => {
      const kEl = h('span', { class: 'k' }, k);
      const vEl = h('span', { class: 'v' });
      return { el: h('div', { class: 'hud-row' }, kEl, vEl), k: kEl, v: vEl };
    };
    const rTime = row('距离节点');
    const rDv = row('总 Δv');
    const rBurn = row('预计燃烧');
    const rIgn = row('建议点火');
    P.appendChild(h('div', { class: 'info' }, rTime.el, rDv.el, rBurn.el, rIgn.el));
    // 机动后的结果（随预测更新）
    const resNote = h('div', { class: 'note' });
    P.appendChild(resNote);
    P.appendChild(
      h(
        'div',
        { class: 'grid', style: { margin: '8px 0' } },
        btn(
          sim.autopilot.mode === 'node' ? '■ 取消自动执行' : '▶ 执行机动（自动）',
          () => {
            if (sim.autopilot.mode === 'node') sim.autopilot.disengage('已取消自动执行');
            else sim.autopilot.engage('node');
            this.plannerKey = '';
          },
          sim.autopilot.mode === 'node' ? 'on wide' : 'primary wide',
        ),
        btn('⏩ 加速到节点前', () => {
          sim.warpToTime(n.t - sim.nodeBurnLead() - 30);
          sim.setSas('maneuver');
        }),
        btn('✕ 删除节点', () => {
          sim.removeNode();
          this.plannerMsg = '';
          this.plannerKey = '';
        }),
      ),
    );
    const adj = (label: string, get: () => number, set: (v: number) => void, steps: number[], fmt: (v: number) => string) => {
      const val = h('span', { class: 'val' }, fmt(get()));
      const r = h('div', { class: 'adj-row' }, h('span', { class: 'lbl' }, label));
      for (const s of steps.filter((x) => x < 0)) r.appendChild(h('button', { onclick: () => this.editNode(() => set(get() + s)) }, String(s)));
      r.appendChild(val);
      for (const s of steps.filter((x) => x > 0)) r.appendChild(h('button', { onclick: () => this.editNode(() => set(get() + s)) }, `+${s}`));
      P.appendChild(r);
      return val;
    };
    const f1 = (v: number) => v.toFixed(1);
    P.appendChild(h('div', { class: 'note muted' }, '微调节点（m/s，时间单位秒）：'));
    adj('顺行', () => n.dv.x, (v) => (n.dv.x = v), [-10, -1, -0.1, 0.1, 1, 10], f1);
    adj('法向', () => n.dv.y, (v) => (n.dv.y = v), [-10, -1, -0.1, 0.1, 1, 10], f1);
    adj('径向', () => n.dv.z, (v) => (n.dv.z = v), [-10, -1, -0.1, 0.1, 1, 10], f1);
    const tVal = adj('时间', () => n.t - sim.t, (v) => (n.t = sim.t + Math.max(5, v)), [-600, -60, -10, 10, 60, 600], (v) => fmtTime(v));
    this.plannerLive = () => {
      const bt = sim.nodeBurnTime();
      setText(rTime.v, fmtTime(n.t - sim.t));
      setText(rDv.k, n.remaining ? '剩余 Δv' : '总 Δv');
      setText(rDv.v, fmtSpeed(n.remaining ? n.remaining.length() : n.dv.length()));
      setText(rBurn.v, isFinite(bt) ? fmtTime(bt) : '无推力');
      setText(rIgn.v, fmtTime(n.t - sim.nodeBurnLead() - sim.t));
      setText(tVal, fmtTime(n.t - sim.t));
      const pred = sim.prediction;
      const res: string[] = [];
      if (pred) {
        const pe = pred.events.find((e) => e.afterNode && e.type === 'pe');
        const ap = pred.events.find((e) => e.afterNode && e.type === 'ap');
        if (ap) res.push(`${ap.body.id === 'moon' ? '远月点' : '远地点'} ${fmtDist(ap.alt)}`);
        if (pe) res.push(`${pe.body.id === 'moon' ? '近月点' : '近地点'} ${fmtDist(pe.alt)}`);
        if (pred.events.some((e) => e.afterNode && e.type === 'soiEnter')) res.push('将进入月球影响球');
        if (pred.impact && pred.impact.afterNode) res.push(`⚠ 将撞击${pred.impact.body.name}`);
      }
      setText(resNote, res.length ? '机动后：' + res.join('，') : '');
      resNote.style.display = res.length ? '' : 'none';
    };
    this.plannerLive();
    P.scrollTop = scroll;
  }

  private editNode(f: () => void): void {
    const n = this.sim.nodes[0];
    if (!n) return;
    this.cb.click();
    f();
    this.sim.nodeEdited();
    this.plannerKey = '';
  }

  /** 松开所有按住的控件（例如弹出暂停菜单时）。 */
  releaseControls(): void {
    this.stick.reset();
    this.rollL.reset();
    this.rollR.reset();
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onDocDown, true);
    window.removeEventListener('resize', this.onResize);
    this.navball.dispose();
    this.root.remove();
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

/** 方向舵刻度盘几何：圆心在底部中央，0° 指向正上方，正角度向右（东）。 */
const DIAL = { cx: 100, cy: 100, r: 72 };

function dialPt(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [DIAL.cx + r * Math.sin(a), DIAL.cy - r * Math.cos(a)];
}

function arcPath(from: number, to: number): string {
  const [x1, y1] = dialPt(from, DIAL.r);
  const [x2, y2] = dialPt(to, DIAL.r);
  const sweep = to > from ? 1 : 0;
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${DIAL.r} ${DIAL.r} 0 ${large} ${sweep} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}
