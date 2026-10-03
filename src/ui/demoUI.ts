import { BODY_BY_ID, type BodyId } from '../physics/bodies';
import { OUTCOME_LABEL, type DemoMeta } from '../game/demo';
import { BUILTIN_DEMOS, deleteDemo, exportDemo, importDemo, listDemos, loadDemo, renameDemo } from '../game/demoStore';
import type { ReplayPlayer } from '../game/replay';
import { WARP_LEVELS, PHYS_WARP_MAX } from '../game/flight';
import { h, clear, setText } from './dom';
import { fmtDist, fmtMET, fmtTime } from './format';

/** 回放速度档位（相对记录时的节奏）。 */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 10, 30, 100];

function fmtClock(s: number): string {
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (x: number) => String(x).padStart(2, '0');
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p2 = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function bodiesText(ids: BodyId[]): string {
  return ids
    .filter((b) => b !== 'sun')
    .map((b) => BODY_BY_ID[b]?.name ?? b)
    .join(' → ');
}

/** 默认的 demo 名称：火箭名 · 结果 · 日期。 */
export function defaultDemoName(designName: string, outcome: string): string {
  return `${designName || '未命名火箭'} · ${outcome} · ${fmtDate(Date.now())}`;
}

// ------------------------------------------------------------------ Demo 库

export interface LibraryCallbacks {
  playBuiltin(id: string): void;
  play(id: string): void;
  close(): void;
  toast(msg: string, level?: string): void;
}

/** “🎬 Demo 回放”：电脑演示 + 我的飞行记录（本机数据库）。 */
export function demoLibrary(cb: LibraryCallbacks): HTMLElement {
  const list = h('div', { class: 'demo-list' }, h('div', { class: 'demo-empty' }, '正在读取本机数据库……'));
  const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } }) as HTMLInputElement;
  const refresh = () => {
    listDemos()
      .then((all) => renderList(all))
      .catch((e) => {
        clear(list);
        list.appendChild(h('div', { class: 'demo-empty bad' }, `无法读取本机数据库：${e?.message ?? e}`));
      });
  };
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    importDemo(f)
      .then((d) => {
        cb.toast(`已导入：${d.meta.name}`, 'good');
        refresh();
      })
      .catch((e) => cb.toast(`导入失败：${e?.message ?? e}`, 'bad'));
  });

  const renderList = (all: DemoMeta[]) => {
    clear(list);
    if (!all.length) {
      list.appendChild(h('div', { class: 'demo-empty' }, '还没有保存的飞行。每次发射都会自动记录，坠毁、重新发射或返回总装车间时会询问是否保存为 Demo。'));
      return;
    }
    for (const m of all) {
      let confirmDel = false;
      const name = h('div', { class: 'demo-name' }, m.name);
      const del = h(
        'button',
        {
          title: '删除这个 Demo',
          onclick: () => {
            if (!confirmDel) {
              confirmDel = true;
              del.textContent = '确认删除？';
              del.classList.add('danger');
              setTimeout(() => {
                confirmDel = false;
                del.textContent = '🗑';
                del.classList.remove('danger');
              }, 3000);
              return;
            }
            deleteDemo(m.id)
              .then(refresh)
              .catch((e) => cb.toast(`删除失败：${e?.message ?? e}`, 'bad'));
          },
        },
        '🗑',
      );
      list.appendChild(
        h(
          'div',
          { class: 'demo-row' },
          h(
            'div',
            { class: 'demo-info', onclick: () => cb.play(m.id), title: '播放' },
            name,
            h(
              'div',
              { class: 'demo-sub' },
              h('span', { class: `badge ${m.outcome}` }, OUTCOME_LABEL[m.outcome] ?? m.outcome),
              ` ${m.designName} · ${fmtDate(m.createdAt)} · 任务时间 ${fmtMET(m.metEnd)} · 最高 ${fmtDist(m.maxAlt)}`,
              m.bodies.length > 1 ? ` · ${bodiesText(m.bodies)}` : '',
            ),
            m.outcome === 'crashed' ? h('div', { class: 'demo-sub bad' }, m.outcomeText) : null,
          ),
          h(
            'div',
            { class: 'demo-btns' },
            h('button', { class: 'primary', onclick: () => cb.play(m.id), title: '播放' }, '▶'),
            h(
              'button',
              {
                title: '重命名',
                onclick: () => {
                  const v = prompt('Demo 名称', m.name);
                  if (v && v.trim() && v !== m.name)
                    renameDemo(m.id, v.trim())
                      .then(refresh)
                      .catch((e) => cb.toast(`重命名失败：${e?.message ?? e}`, 'bad'));
                },
              },
              '✎',
            ),
            h(
              'button',
              {
                title: '导出为文件（可以发给别人导入）',
                onclick: () =>
                  loadDemo(m.id)
                    .then((d) => d && exportDemo(d))
                    .catch((e) => cb.toast(`导出失败：${e?.message ?? e}`, 'bad')),
              },
              '⬇',
            ),
            del,
          ),
        ),
      );
    }
  };

  refresh();
  return h(
    'div',
    { class: 'modal panel demo-lib' },
    h('h2', null, '🎬 Demo 回放'),
    h('p', { class: 'demo-intro' }, '每次发射都会自动记录完整的飞行路径、姿态、分级和每一步操作。坠毁或开始新的飞行时会询问是否保存为 Demo，保存在本机浏览器的数据库里，随时可以回放。'),
    h('h3', null, '电脑演示 · 默认火箭“登月者 L-1”'),
    h(
      'div',
      { class: 'demo-cards' },
      ...BUILTIN_DEMOS.map((b) =>
        h(
          'button',
          { class: 'demo-card', onclick: () => cb.playBuiltin(b.id), title: '观看电脑的完整操作' },
          h('div', { class: 'icon' }, b.icon),
          h('div', { class: 't' }, b.title),
          h('div', { class: 'd' }, b.desc),
          h('div', { class: 'go' }, '▶ 观看'),
        ),
      ),
    ),
    h('div', { class: 'demo-h3row' }, h('h3', null, '我的飞行记录'), h('button', { onclick: () => file.click(), title: '导入别人分享的 Demo 文件' }, '⬆ 导入'), file),
    list,
    h('div', { class: 'actions' }, h('button', { onclick: () => cb.close() }, '关闭')),
  );
}

// ------------------------------------------------------------------ 回放控制

export interface ReplayCallbacks {
  seek(t: number): void;
  exit(): void;
  toggleMap(): void;
  cycleCamera(): void;
  click(): void;
  /** 进入截图模式 */
  shot(): void;
}

/** 回放控制面板（右下角）+ 操作记录面板（右侧）。 */
export class ReplayControls {
  root: HTMLDivElement;
  logPanel: HTMLDivElement;
  private player: ReplayPlayer;
  private cb: ReplayCallbacks;
  private els: Record<string, HTMLElement> = {};
  private fill: HTMLDivElement;
  private knob: HTMLDivElement;
  private track: HTMLDivElement;
  private rows: HTMLDivElement[] = [];
  private cur = -1;
  private pendingSeek: number | null = null;
  private dragging = false;
  private hoverLog = false;
  private textTimer = 0;
  private real0: number;
  private realSpan: number;

  constructor(parent: HTMLElement, player: ReplayPlayer, cb: ReplayCallbacks, builtin: boolean) {
    this.player = player;
    this.cb = cb;
    const tr = player.track;
    this.real0 = tr.realAt(tr.t0);
    this.realSpan = Math.max(1e-6, tr.realAt(tr.t1) - this.real0);
    const E = this.els;
    const btn = (label: string, title: string, fn: () => void, cls = '') =>
      h(
        'button',
        {
          class: cls,
          title,
          onclick: () => {
            cb.click();
            fn();
          },
        },
        label,
      );

    // 时间轴：横轴是记录时的真实时间（与当时的游玩节奏一致），刻度是操作记录
    this.fill = h('div', { class: 'tl-fill' });
    this.knob = h('div', { class: 'tl-knob' });
    const marks = h('div', { class: 'tl-marks' });
    for (const e of player.log) {
      if (e.kind === 'info' || e.kind === 'warn') continue;
      const x = this.frac(e.t) * 100;
      marks.appendChild(h('div', { class: `tl-mark ${e.kind}`, style: { left: `${x.toFixed(2)}%` }, title: `${fmtTime(e.t - tr.t0)} ${e.text}` }));
    }
    this.track = h('div', { class: 'tl', title: '拖动跳转' }, h('div', { class: 'tl-bg' }), this.fill, marks, this.knob);
    const seekAt = (ev: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this.pendingSeek = tr.timeAtReal(this.real0 + f * this.realSpan, 0);
      this.setKnob(f);
    };
    this.track.addEventListener('pointerdown', (ev) => {
      this.dragging = true;
      this.track.setPointerCapture(ev.pointerId);
      seekAt(ev);
    });
    this.track.addEventListener('pointermove', (ev) => {
      if (this.dragging) seekAt(ev);
    });
    const end = () => (this.dragging = false);
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);

    this.root = h(
      'div',
      { class: 'replay-panel panel' },
      h(
        'div',
        { class: 'rp-head' },
        h('span', { class: 'rp-badge' }, builtin ? '电脑演示' : '回放'),
        h('span', { class: 'rp-title', title: player.data.meta.name }, player.data.meta.name),
        btn('✕', '退出回放', () => cb.exit(), 'rp-x'),
      ),
      this.track,
      h('div', { class: 'rp-time' }, (E.clock = h('span', { class: 'num' })), (E.simt = h('span', { class: 'num muted' }))),
      h(
        'div',
        { class: 'rp-row' },
        btn('⏮', '从头播放 (Home)', () => this.restart()),
        btn('⏪', '上一步 (←)', () => this.step(-1)),
        (E.play = btn('❚❚', '播放 / 暂停 (空格)', () => this.togglePlay(), 'rp-play')),
        btn('⏩', '下一步 (→)', () => this.step(1)),
        h(
          'div',
          { class: 'rp-speed' },
          btn('−', '减速 ( , )', () => this.changeSpeed(-1)),
          (E.speed = h('span', { class: 'num', title: '回放速度（相对当时的节奏，含当时的时间加速）' })),
          btn('＋', '加速 ( . )', () => this.changeSpeed(1)),
        ),
      ),
      h(
        'div',
        { class: 'rp-row' },
        btn('地图 M', '地图', () => cb.toggleMap()),
        btn('相机 V', '切换相机', () => cb.cycleCamera()),
        btn('📷', '截图模式 (F2)：隐藏所有面板，Esc 退出', () => cb.shot()),
        (E.logBtn = btn('📋 操作记录 L', '显示 / 隐藏操作记录', () => this.toggleLog(), 'on')),
      ),
      (E.status = h('div', { class: 'rp-status' })),
    );
    parent.appendChild(this.root);

    // 操作记录
    const list = h('div', { class: 'rl-list' });
    for (const e of player.log) {
      const row = h(
        'div',
        {
          class: `rl-row ${e.kind}`,
          onclick: () => {
            cb.click();
            cb.seek(Math.max(tr.t0, e.t - 0.05));
            this.player.playing = true;
          },
          title: '跳到这里',
        },
        h('span', { class: 'rl-t num' }, fmtTime(e.t - tr.t0)),
        h('span', { class: 'rl-x' }, e.text),
      );
      this.rows.push(row);
      list.appendChild(row);
    }
    if (!player.log.length) list.appendChild(h('div', { class: 'demo-empty' }, '这次飞行没有记录到操作'));
    this.logPanel = h('div', { class: 'replay-log panel' }, h('h3', null, builtin ? '电脑的每一步操作' : '操作记录'), list);
    this.logPanel.addEventListener('pointerenter', () => (this.hoverLog = true));
    this.logPanel.addEventListener('pointerleave', () => (this.hoverLog = false));
    parent.appendChild(this.logPanel);
    this.update(1);
  }

  private frac(t: number): number {
    return Math.max(0, Math.min(1, (this.player.track.realAt(t) - this.real0) / this.realSpan));
  }

  private setKnob(f: number): void {
    const p = `${(f * 100).toFixed(3)}%`;
    this.fill.style.width = p;
    this.knob.style.left = p;
  }

  togglePlay(): void {
    const p = this.player;
    if (p.ended) {
      this.restart();
      return;
    }
    p.playing = !p.playing;
    this.update(1);
  }

  restart(): void {
    this.cb.seek(this.player.t0);
    this.player.playing = true;
    this.update(1);
  }

  step(dir: 1 | -1): void {
    const t = this.player.nextLogTime(dir);
    if (t === null) return;
    this.cb.seek(Math.max(this.player.t0, t - 0.05));
    this.update(1);
  }

  changeSpeed(d: number): void {
    const p = this.player;
    let i = REPLAY_SPEEDS.findIndex((s) => s >= p.speed - 1e-9);
    if (i < 0) i = REPLAY_SPEEDS.length - 1;
    i = Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, i + d));
    p.speed = REPLAY_SPEEDS[i];
    this.update(1);
  }

  toggleLog(v?: boolean): void {
    const show = v ?? this.logPanel.style.display === 'none';
    this.logPanel.style.display = show ? '' : 'none';
    this.els.logBtn.classList.toggle('on', show);
  }

  /** 每帧调用：执行拖动中的跳转、刷新时间轴与文字。 */
  update(dt: number): void {
    if (this.pendingSeek !== null) {
      const t = this.pendingSeek;
      this.pendingSeek = null;
      this.cb.seek(t);
    }
    const p = this.player;
    if (!this.dragging) this.setKnob(this.frac(p.t));
    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 0.15;
    const E = this.els;
    const tr = p.track;
    setText(E.clock, `${fmtClock(tr.realAt(p.t) - this.real0)} / ${fmtClock(this.realSpan)}`);
    const w = p.sim.warpIndex;
    setText(E.simt, `飞行 ${fmtTime(p.t - tr.t0)} · 当时 ${WARP_LEVELS[w]}×${w > 0 && w <= PHYS_WARP_MAX ? ' 物理' : ''}`);
    setText(E.play, p.ended ? '↻' : p.playing ? '❚❚' : '▶');
    E.play.title = p.ended ? '重播' : '播放 / 暂停 (空格)';
    setText(E.speed, `${p.speed < 1 ? (p.speed === 0.25 ? '¼' : '½') : p.speed}×`);
    setText(E.status, p.ended ? '回放结束 —— 点 ↻ 重播，或 ✕ 退出' : !p.playing ? '已暂停' : '');
    // 当前的操作记录
    let cur = -1;
    for (let i = 0; i < p.log.length && p.log[i].t <= p.t + 1e-6; i++) cur = i;
    if (cur !== this.cur) {
      if (this.cur >= 0) this.rows[this.cur]?.classList.remove('cur');
      this.cur = cur;
      const row = cur >= 0 ? this.rows[cur] : null;
      if (row) {
        row.classList.add('cur');
        if (!this.hoverLog && this.logPanel.style.display !== 'none') {
          const list = row.parentElement!;
          list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight * 0.4);
        }
      }
      for (let i = 0; i < this.rows.length; i++) this.rows[i].classList.toggle('past', i < cur);
    }
  }

  dispose(): void {
    this.root.remove();
    this.logPanel.remove();
  }
}
