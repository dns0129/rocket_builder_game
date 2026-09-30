import * as THREE from 'three';
import type { FlightSim, SasMode } from '../game/flight';
import { WARP_LEVELS, PHYS_WARP_MAX, RUDDER_MAX } from '../game/flight';
import { MISSIONS } from '../game/missions';
import { solveCapture, solveChangeApsis, solveCircularize, solveCorrection, solveReturn, solveTLI, type SolveResult } from '../game/maneuver';
import type { FlightScene } from '../render/flightScene';
import { Navball } from '../render/navball';
import { h, setText } from './dom';
import { fmtDist, fmtMET, fmtSpeed, fmtTime, fmtMass } from './format';

export interface HudCallbacks {
  pause: () => void;
  toggleMap: () => void;
  cycleCamera: () => void;
  click: () => void;
}

const UP = new THREE.Vector3(0, 1, 0);

export class FlightHUD {
  root: HTMLDivElement;
  navball: Navball;
  private sim: FlightSim;
  private cb: HudCallbacks;
  private els: Record<string, HTMLElement> = {};
  private toasts: HTMLDivElement;
  private stageList: HTMLDivElement;
  private lastStageKey = '';
  private missionBox: HTMLDivElement;
  private planner: HTMLDivElement;
  private plannerOpen = false;
  private plannerKey = '';
  private plannerMsg = '';
  private textTimer = 0;
  private sasButtons = new Map<string, HTMLButtonElement>();
  private apButtons = new Map<string, HTMLButtonElement>();
  private pips: HTMLDivElement[] = [];
  private rud!: {
    svg: SVGSVGElement;
    fill: SVGPathElement;
    knob: SVGCircleElement;
    link: SVGLineElement;
    rocket: SVGGElement;
    ap: SVGPathElement;
    label: HTMLElement;
  };

  constructor(parent: HTMLElement, sim: FlightSim, scene: FlightScene, cb: HudCallbacks) {
    this.sim = sim;
    void scene;
    this.cb = cb;
    this.root = h('div', { class: 'hud' });
    parent.appendChild(this.root);
    const E = this.els;
    const row = (k: string, key: string) => h('div', { class: 'hud-row' }, h('span', { class: 'k' }, k), (E[key] = h('span', { class: 'v' })));

    // 左上：高度与速度
    this.root.appendChild(
      h(
        'div',
        { class: 'hud-tl panel' },
        h('div', { class: 'hud-row' }, (E.met = h('span', { class: 'hud-met' })), (E.situ = h('span', { class: 'k' }))),
        h('div', { class: 'hud-row' }, h('span', { class: 'k' }, '海拔'), (E.alt = h('span', { class: 'hud-big' }))),
        row('离地高度', 'radar'),
        row('垂直速度', 'vv'),
        row('水平速度', 'hv'),
        row('马赫 / 动压', 'mach'),
        row('过载', 'g'),
        row('大气压', 'pres'),
      ),
    );

    // 顶部中间：时间加速
    const warp = h('div', { class: 'hud-tc panel' });
    warp.appendChild(h('button', { onclick: () => this.sim.setWarp(this.sim.warpIndex - 1), title: '减速 ( , )' }, '◀'));
    const pipBox = h('div', { class: 'warp-pips' });
    for (let i = 0; i < WARP_LEVELS.length; i++) {
      const p = h('div', { class: `warp-pip ${i <= PHYS_WARP_MAX ? 'phys' : ''}` });
      p.addEventListener('click', () => this.sim.setWarp(i));
      pipBox.appendChild(p);
      this.pips.push(p);
    }
    warp.append(pipBox, (E.warp = h('span', { class: 'warp-label' })));
    warp.appendChild(h('button', { onclick: () => this.sim.setWarp(this.sim.warpIndex + 1), title: '加速 ( . )' }, '▶'));
    warp.appendChild(h('button', { onclick: () => this.sim.setWarp(0), title: '恢复实时 ( / )' }, '1×'));
    warp.appendChild(h('button', { onclick: () => this.cb.pause(), title: '暂停菜单 (Esc)' }, '❚❚'));
    this.root.appendChild(warp);

    // 右上：轨道
    this.missionBox = h('div', { class: 'missions' });
    this.root.appendChild(
      h(
        'div',
        { class: 'hud-tr panel' },
        h('h3', null, (E.orbTitle = h('span'))),
        row('远拱点', 'ap'),
        row('近拱点', 'pe'),
        row('距远拱点', 'tap'),
        row('距近拱点', 'tpe'),
        row('轨道周期', 'per'),
        row('倾角', 'inc'),
        this.missionBox,
      ),
    );

    this.toasts = h('div', { class: 'toasts' });
    this.root.appendChild(this.toasts);

    // 底部：仪表 + 导航球 + SAS
    const thrGauge = h('div', { class: 'gauge thr', title: '油门：Shift 增加 / Ctrl 减小 / Z 满 / X 关' }, (E.thrFill = h('div', { class: 'fill' })));
    const setThr = (e: PointerEvent) => {
      const r = thrGauge.getBoundingClientRect();
      const v = 1 - (e.clientY - r.top) / r.height;
      this.sim.vessel.throttle = Math.max(0, Math.min(1, v));
      if (this.sim.autopilot.mode !== 'off') this.sim.autopilot.disengage();
    };
    thrGauge.addEventListener('pointerdown', (e) => {
      thrGauge.setPointerCapture(e.pointerId);
      setThr(e);
    });
    thrGauge.addEventListener('pointermove', (e) => {
      if (e.buttons) setThr(e);
    });
    const gauges = h(
      'div',
      { class: 'gauges panel' },
      h('div', { class: 'gauge-col' }, thrGauge, (E.thrLbl = h('div', { class: 'gauge-label num' }))),
      h('div', { class: 'gauge-col' }, h('div', { class: 'gauge fuel', title: '当前级燃料' }, (E.fuelFill = h('div', { class: 'fill' }))), h('div', { class: 'gauge-label' }, '燃料')),
      h('div', { class: 'gauge-col' }, h('div', { class: 'gauge heat', title: '蒙皮温度（相对极限）' }, (E.heatFill = h('div', { class: 'fill' }))), h('div', { class: 'gauge-label' }, '温度')),
    );
    const nbWrap = h('div', { class: 'navball-wrap' });
    this.navball = new Navball(nbWrap);
    this.navball.resize(200);
    const nav = h(
      'div',
      { class: 'nav-panel panel' },
      (E.spdMode = h('div', {
        class: 'speed-mode',
        title: '点击切换速度参考系',
        onclick: () => {
          const m = this.sim.speedMode;
          this.sim.speedMode = m === 'auto' ? 'orbit' : m === 'orbit' ? 'surface' : 'auto';
        },
      })),
      (E.spd = h('div', { class: 'speed-val' })),
      nbWrap,
      (E.hdg = h('div', { class: 'hdg' })),
      this.buildRudder(),
    );
    const sas = h('div', { class: 'sas-grid panel' });
    const sasBtn = (mode: SasMode | 'toggle', label: string, full = false) => {
      const b = h(
        'button',
        {
          class: full ? 'full' : '',
          onclick: () => {
            this.cb.click();
            if (mode === 'toggle') this.sim.toggleSas();
            else this.sim.setSas(mode);
          },
        },
        label,
      );
      this.sasButtons.set(mode, b);
      sas.appendChild(b);
    };
    sasBtn('toggle', 'SAS 姿态稳定 (T)', true);
    sasBtn('stability', '保持');
    sasBtn('maneuver', '机动方向');
    sasBtn('prograde', '顺行');
    sasBtn('retrograde', '逆行');
    sasBtn('normal', '法向');
    sasBtn('antinormal', '反法向');
    sasBtn('radialOut', '径向外');
    sasBtn('radialIn', '径向内');
    this.root.appendChild(h('div', { class: 'hud-bottom' }, gauges, nav, sas));

    // 左下：分级
    this.stageList = h('div', { class: 'stage-list' });
    this.root.appendChild(
      h(
        'div',
        { class: 'hud-bl panel' },
        h('h3', null, '分级序列（空格键）'),
        this.stageList,
        h('div', { style: { marginTop: '8px' } }, row('本级 Δv', 'sdv'), row('推重比', 'twr'), row('质量', 'mass')),
      ),
    );

    // 右下：操作
    const act = (label: string, fn: () => void, title = '') =>
      h(
        'button',
        {
          title,
          onclick: () => {
            this.cb.click();
            fn();
          },
        },
        label,
      );
    const apBtn = (mode: 'ascent' | 'node' | 'land', label: string) => {
      const b = h(
        'button',
        {
          onclick: () => {
            this.cb.click();
            if (this.sim.autopilot.mode === mode) this.sim.autopilot.disengage('飞行辅助已关闭');
            else this.sim.autopilot.engage(mode);
          },
        },
        label,
      );
      this.apButtons.set(mode, b);
      return b;
    };
    this.root.appendChild(
      h(
        'div',
        { class: 'hud-br panel' },
        h('button', { class: 'primary', onclick: () => this.sim.stage(), title: '空格键' }, '分级 / 点火'),
        h('div', { class: 'row' }, act('地图 M', () => this.cb.toggleMap()), act('相机 V', () => this.cb.cycleCamera())),
        h('div', { class: 'row' }, act('着陆腿 G', () => this.sim.toggleLegs()), act('降落伞 P', () => this.sim.armChute())),
        h('div', { class: 'row' }, act('机动规划 N', () => this.togglePlanner())),
        h('h3', { style: { margin: '6px 0 0' } }, '飞行辅助'),
        h('div', { class: 'row' }, apBtn('ascent', '自动入轨'), apBtn('node', '执行机动')),
        h('div', { class: 'row' }, apBtn('land', '自动着陆')),
        (E.apStatus = h('div', { class: 'ap-status' })),
      ),
    );

    // 着陆辅助
    E.land = h(
      'div',
      { class: 'land-panel panel' },
      h('div', null, h('div', { class: 'k' }, '离地'), (E.lAlt = h('div', { class: 'v' }))),
      h('div', null, h('div', { class: 'k' }, '垂直速度'), (E.lVv = h('div', { class: 'v' }))),
      h('div', null, h('div', { class: 'k' }, '水平速度'), (E.lHv = h('div', { class: 'v' }))),
      h('div', null, h('div', { class: 'k' }, '建议点火'), (E.lBurn = h('div', { class: 'v burn' }))),
    );
    this.root.appendChild(E.land);

    this.planner = h('div', { class: 'planner panel' });
    this.planner.style.display = 'none';
    this.root.appendChild(this.planner);
  }

  /**
   * 方向舵：半圆刻度盘，0° 竖直向上，右侧向东、左侧向西。
   * 拖动橙色旋钮（或按 ← / →）直接设定火箭倾角，中间的小火箭显示实际姿态。
   */
  private buildRudder(): HTMLElement {
    const NS = 'http://www.w3.org/2000/svg';
    const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      parent?.appendChild(e);
      return e;
    };
    const svg = el('svg', { viewBox: '0 0 200 100', class: 'rudder-dial' });
    el('path', { d: arcPath(-90, 90), class: 'rud-track' }, svg);
    for (let a = -90; a <= 90; a += 15) {
      const major = a % 45 === 0;
      const [x1, y1] = dialPt(a, major ? 58 : 62);
      const [x2, y2] = dialPt(a, 68);
      el('line', { x1, y1, x2, y2, class: major ? 'rud-tick major' : 'rud-tick' }, svg);
    }
    for (const a of [-90, -45, 0, 45, 90]) {
      const [x, y] = dialPt(a, 47);
      const t = el('text', { x, y: y + 3.5, class: 'rud-num' }, svg);
      t.textContent = String(Math.abs(a));
    }
    const w = el('text', { x: 12, y: 97, class: 'rud-dir' }, svg);
    w.textContent = '西';
    const e = el('text', { x: 188, y: 97, class: 'rud-dir' }, svg);
    e.textContent = '东';
    const fill = el('path', { d: '', class: 'rud-fill' }, svg);
    const link = el('line', { x1: DIAL.cx, y1: DIAL.cy, x2: DIAL.cx, y2: DIAL.cy - DIAL.r, class: 'rud-link' }, svg);
    const rocket = el('g', { class: 'rud-rocket' }, svg);
    el('path', { d: 'M0 -30 L5 -21 L5 -6 L9 0 L-9 0 L-5 -6 L-5 -21 Z' }, rocket);
    const ap = el('path', { d: 'M0 0 L-5 -9 L5 -9 Z', class: 'rud-ap' }, svg);
    const knob = el('circle', { cx: DIAL.cx, cy: DIAL.cy - DIAL.r, r: 8.5, class: 'rud-knob' }, svg);
    el('circle', { cx: DIAL.cx, cy: DIAL.cy, r: 3, class: 'rud-hub' }, svg);

    const setFromPointer = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * 200;
      const y = ((ev.clientY - r.top) / r.height) * 100;
      let a = Math.atan2(x - DIAL.cx, DIAL.cy - y);
      a = Math.max(-RUDDER_MAX, Math.min(RUDDER_MAX, a));
      // 取整到 1°，竖直附近吸附
      let deg = Math.round((a * 180) / Math.PI);
      if (Math.abs(deg) <= 2) deg = 0;
      this.sim.setRudder((deg * Math.PI) / 180);
    };
    svg.addEventListener('pointerdown', (ev) => {
      svg.setPointerCapture(ev.pointerId);
      this.cb.click();
      setFromPointer(ev);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (ev.buttons) setFromPointer(ev);
    });
    const step = (deg: number) => () => {
      this.cb.click();
      this.sim.nudgeRudder((deg * Math.PI) / 180);
    };
    const label = h('div', {
      class: 'rudder-lbl',
      title: '点击开关方向舵（开启时从当前姿态开始）',
      onclick: () => {
        this.cb.click();
        if (this.sim.rudderActive) this.sim.setSas('stability');
        else this.sim.setRudder(this.sim.tiltAngle());
      },
    });
    this.rud = { svg, fill, knob, link, rocket, ap, label };
    return h(
      'div',
      { class: 'rudder', title: '方向舵：拖动旋钮或按 ← / → 直接设定火箭倾角' },
      svg,
      h('div', { class: 'rudder-row' }, h('button', { onclick: step(-5), title: '向西 5°' }, '◀'), label, h('button', { onclick: step(5), title: '向东 5°' }, '▶')),
    );
  }

  private updateRudder(): void {
    const sim = this.sim;
    const R = this.rud;
    const deg = (x: number) => (x * 180) / Math.PI;
    const actual = Math.max(-100, Math.min(100, deg(sim.tiltAngle())));
    R.rocket.setAttribute('transform', `translate(${DIAL.cx} ${DIAL.cy}) rotate(${actual.toFixed(1)})`);
    const active = sim.rudderActive;
    const cmd = deg(sim.rudderAngle);
    R.svg.classList.toggle('on', active);
    if (active) {
      const [kx, ky] = dialPt(cmd, DIAL.r);
      R.knob.setAttribute('cx', kx.toFixed(1));
      R.knob.setAttribute('cy', ky.toFixed(1));
      R.link.setAttribute('x2', kx.toFixed(1));
      R.link.setAttribute('y2', ky.toFixed(1));
      R.fill.setAttribute('d', Math.abs(cmd) > 0.5 ? arcPath(0, cmd) : '');
    } else {
      // 未启用时旋钮停在实际姿态处，拖动即可接管
      const [kx, ky] = dialPt(Math.max(-90, Math.min(90, actual)), DIAL.r);
      R.knob.setAttribute('cx', kx.toFixed(1));
      R.knob.setAttribute('cy', ky.toFixed(1));
      R.fill.setAttribute('d', '');
    }
    // 飞行辅助的目标倾角（蓝色三角）
    const ap = sim.autopilot.mode !== 'off' ? sim.autopilot.targetDir : null;
    if (ap) {
      const tel = sim.telemetry;
      const a = Math.max(-90, Math.min(90, deg(Math.atan2(ap.dot(tel.east), ap.dot(tel.up)))));
      const [x, y] = dialPt(a, DIAL.r + 12);
      R.ap.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(1)})`);
      R.ap.style.display = '';
    } else R.ap.style.display = 'none';
    const dirTxt = (d: number) => (Math.abs(d) < 0.5 ? '竖直 0°' : `${d > 0 ? '东' : '西'} ${Math.abs(d).toFixed(0)}°`);
    setText(R.label, active ? `方向舵 ${dirTxt(cmd)}` : `方向舵 关 · ${dirTxt(actual)}`);
    R.label.classList.toggle('on', active);
  }

  togglePlanner(v?: boolean): void {
    this.plannerOpen = v ?? !this.plannerOpen;
    this.planner.style.display = this.plannerOpen ? '' : 'none';
    this.missionBox.style.display = this.plannerOpen ? 'none' : '';
    this.plannerKey = '';
  }

  toast(msg: string, level: string = 'info'): void {
    const el = h('div', { class: `toast ${level}` }, msg);
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 5) this.toasts.firstChild?.remove();
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    }, level === 'bad' || level === 'good' ? 5000 : 3200);
  }

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
    (E.thrFill as HTMLElement).style.height = `${V.throttle * 100}%`;
    (E.fuelFill as HTMLElement).style.height = `${V.stageFuelFraction() * 100}%`;
    this.updateRudder();
    (E.heatFill as HTMLElement).style.height = `${Math.min(100, Math.max(0, ((tel.temp - 250) / Math.max(1, tel.tempMax - 250)) * 100))}%`;

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
    const mx = sim.maxWarpIndex();
    this.pips.forEach((p, i) => {
      p.classList.toggle('on', i <= sim.warpIndex);
      p.style.opacity = i <= mx ? '1' : '0.3';
    });
    setText(E.warp, sim.paused ? '暂停' : `${WARP_LEVELS[sim.warpIndex]}×${sim.warpIndex > 0 && sim.warpIndex <= PHYS_WARP_MAX ? ' 物理' : ''}`);

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
      this.missionBox.innerHTML = '';
      this.missionBox.appendChild(h('h3', null, '任务'));
      for (const m of MISSIONS) {
        const done = sim.missions.done.has(m.id);
        this.missionBox.appendChild(h('div', { class: `mission ${done ? 'done' : ''}`, title: m.desc }, `${done ? '✔' : '○'} ${m.title}`));
      }
    }

    // 速度与航向
    const mode = tel.speedModeUsed;
    setText(E.spdMode, `${sim.speedMode === 'auto' ? '自动 · ' : ''}${mode === 'surface' ? '地表速度' : '轨道速度'}`);
    setText(E.spd, fmtSpeed(mode === 'surface' ? tel.surfSpeed : tel.orbSpeed));
    const fwd = UP.clone().applyQuaternion(V.q);
    const pitch = (Math.asin(Math.max(-1, Math.min(1, fwd.dot(tel.up)))) * 180) / Math.PI;
    let hdg = (Math.atan2(fwd.dot(tel.east), fwd.dot(tel.north)) * 180) / Math.PI;
    if (hdg < 0) hdg += 360;
    setText(E.hdg, `航向 ${hdg.toFixed(0).padStart(3, '0')}° · 俯仰 ${pitch.toFixed(1)}°`);
    setText(E.thrLbl, `${Math.round(V.throttle * 100)}%`);

    // SAS 按钮状态
    for (const [k, b] of this.sasButtons) {
      if (k === 'toggle') b.classList.toggle('on', sim.sasOn);
      else b.classList.toggle('on', sim.sasOn && sim.sasMode === k);
    }
    for (const [k, b] of this.apButtons) b.classList.toggle('on', sim.autopilot.mode === k);
    setText(E.apStatus, sim.autopilot.mode !== 'off' ? sim.autopilot.status : '');

    // 分级
    setText(E.sdv, `${tel.stageDv.toFixed(0)} m/s`);
    setText(E.twr, tel.thrust > 0 ? tel.twr.toFixed(2) : `(${(V.maxThrustVac().thrust / (V.mass * tel.gLocal)).toFixed(2)})`);
    setText(E.mass, fmtMass(V.mass));
    const sk = `${V.stageIndex}|${V.parts.length}|${V.chuteState}`;
    if (sk !== this.lastStageKey) {
      this.lastStageKey = sk;
      this.renderStages();
    }

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

    if (this.plannerOpen) this.updatePlanner();
  }

  private renderStages(): void {
    const V = this.sim.vessel;
    this.stageList.innerHTML = '';
    V.stages.forEach((st, i) => {
      if (i < V.stageIndex - 1) return;
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
      const cls = i < V.stageIndex ? 'done' : i === V.stageIndex ? 'next' : '';
      this.stageList.appendChild(
        h('div', { class: `stage-card ${cls}` }, h('div', { class: 't' }, `第 ${i + 1} 级 · ${st.label}`), h('div', { class: 'd' }, parts.join('　') || '—')),
      );
    });
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

  private updatePlanner(): void {
    const sim = this.sim;
    const n = sim.nodes[0];
    const key = n ? `n|${n.dv.x.toFixed(2)}|${n.dv.y.toFixed(2)}|${n.dv.z.toFixed(2)}|${n.t.toFixed(0)}|${Math.floor(sim.t)}|${sim.prediction?.endT}` : `e|${this.plannerMsg}`;
    if (key === this.plannerKey) return;
    this.plannerKey = key;
    const P = this.planner;
    P.innerHTML = '';
    const state = () => ({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    P.appendChild(h('h3', null, '机动规划'));
    if (!n) {
      const b = (label: string, f: () => SolveResult, title = '') => h('button', { title, onclick: () => this.solve(f) }, label);
      P.appendChild(
        h(
          'div',
          { class: 'grid' },
          b('远拱点圆化', () => solveCircularize(state(), 'ap')),
          b('近拱点圆化', () => solveCircularize(state(), 'pe')),
          b('🌙 奔月转移', () => solveTLI(state()), '自动计算地月转移入射（霍曼转移 + 三体修正）'),
          b('修正近月点', () => solveCorrection(state(), 'moon', 40_000, 90), '奔月途中做小修正，使近月点约 40 km'),
          b('月球捕获', () => solveCapture(state(), sim.prediction ?? undefined), '在近月点减速进入环月轨道'),
          b('降低近月点', () => solveChangeApsis(state(), 'ap', 6_000), '在远月点减速，把近月点降到 6 km，准备着陆'),
          b('🌍 返回地球', () => solveReturn(state()), '从环月轨道返回，再入近地点约 35 km'),
          b('修正再入角', () => solveCorrection(state(), 'earth', 35_000, 90), '返回途中修正近地点到 35 km 再入走廊'),
          b('＋ 手动节点', () => ({ node: { t: sim.t + 300, dv: new THREE.Vector3() }, msg: '已在 5 分钟后创建空白节点' })),
        ),
      );
      if (this.plannerMsg) P.appendChild(h('div', { class: 'note' }, this.plannerMsg));
      P.appendChild(
        h(
          'div',
          { class: 'note', style: { color: '#8a97a8' } },
          '提示：规划完成后可点“执行机动”让飞行辅助自动完成点火，或将 SAS 设为“机动方向”手动点火。打开地图（M）查看预测轨迹。',
        ),
      );
      return;
    }
    const dvTot = n.remaining ? n.remaining.length() : n.dv.length();
    const bt = sim.nodeBurnTime();
    P.appendChild(
      h(
        'div',
        { class: 'info' },
        h('div', { class: 'hud-row' }, h('span', { class: 'k' }, '距离节点'), h('span', { class: 'v' }, fmtTime(n.t - sim.t))),
        h('div', { class: 'hud-row' }, h('span', { class: 'k' }, n.remaining ? '剩余 Δv' : '总 Δv'), h('span', { class: 'v' }, fmtSpeed(dvTot))),
        h('div', { class: 'hud-row' }, h('span', { class: 'k' }, '预计燃烧'), h('span', { class: 'v' }, isFinite(bt) ? fmtTime(bt) : '无推力')),
        h('div', { class: 'hud-row' }, h('span', { class: 'k' }, '建议点火'), h('span', { class: 'v' }, fmtTime(n.t - bt / 2 - sim.t))),
      ),
    );
    const adj = (label: string, get: () => number, set: (v: number) => void, steps: number[], fmt: (v: number) => string) => {
      const r = h('div', { class: 'adj-row' }, h('span', { class: 'lbl' }, label));
      for (const s of steps.filter((x) => x < 0)) r.appendChild(h('button', { onclick: () => this.editNode(() => set(get() + s)) }, String(s)));
      r.appendChild(h('span', { class: 'val' }, fmt(get())));
      for (const s of steps.filter((x) => x > 0)) r.appendChild(h('button', { onclick: () => this.editNode(() => set(get() + s)) }, `+${s}`));
      return r;
    };
    const f1 = (v: number) => v.toFixed(1);
    P.appendChild(adj('顺行', () => n.dv.x, (v) => (n.dv.x = v), [-10, -1, -0.1, 0.1, 1, 10], f1));
    P.appendChild(adj('法向', () => n.dv.y, (v) => (n.dv.y = v), [-10, -1, -0.1, 0.1, 1, 10], f1));
    P.appendChild(adj('径向', () => n.dv.z, (v) => (n.dv.z = v), [-10, -1, -0.1, 0.1, 1, 10], f1));
    P.appendChild(adj('时间', () => n.t - sim.t, (v) => (n.t = sim.t + Math.max(5, v)), [-600, -60, -10, 10, 60, 600], (v) => fmtTime(v)));
    // 结果
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
    if (res.length) P.appendChild(h('div', { class: 'note' }, '机动后：' + res.join('，')));
    P.appendChild(
      h(
        'div',
        { class: 'grid', style: { marginTop: '8px' } },
        h(
          'button',
          {
            class: sim.autopilot.mode === 'node' ? 'on' : '',
            onclick: () => {
              if (sim.autopilot.mode === 'node') sim.autopilot.disengage('已取消自动执行');
              else sim.autopilot.engage('node');
              this.plannerKey = '';
            },
          },
          '执行机动（自动）',
        ),
        h(
          'button',
          {
            onclick: () => {
              sim.warpToTime(n.t - bt / 2 - 30);
              sim.setSas('maneuver');
            },
          },
          '⏩ 加速到节点前',
        ),
        h(
          'button',
          {
            onclick: () => {
              sim.removeNode();
              this.plannerMsg = '';
              this.plannerKey = '';
            },
          },
          '✕ 删除节点',
        ),
      ),
    );
  }

  private editNode(f: () => void): void {
    const n = this.sim.nodes[0];
    if (!n) return;
    f();
    n.fixedDv = null;
    n.remaining = null;
    this.sim.predictionAge = 999;
    this.sim.refreshPrediction();
    this.plannerKey = '';
  }

  dispose(): void {
    this.root.remove();
  }
}

/** 方向舵刻度盘几何：圆心在底部中央，0° 指向正上方，正角度向右（东）。 */
const DIAL = { cx: 100, cy: 86, r: 70 };

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
