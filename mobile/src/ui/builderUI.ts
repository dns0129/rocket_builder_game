import { CATEGORY_NAMES, PARTS, PROPELLANTS, getPart, tankMasses, type PartCategory, type PartDef } from '../rocket/parts';
import { TEMPLATES, cloneDesign, layoutDesign, maxUid, templateDesign, type PartNode, type RocketDesign } from '../rocket/design';
import { analyzeDesign, type DesignStats } from '../rocket/analysis';
import type { Scenario } from '../game/flight';
import { h, clear } from './dom';
import { fmtForce, fmtMass } from './format';
import type { BuilderScene } from '../render/builderScene';

const SAVE_KEY = 'rocket-game-designs';
const LAST_KEY = 'rocket-game-last-design';

const RADIAL_PRESETS: { id: string; name: string; desc: string; count: number; stack: string[] }[] = [
  { id: 'srbs2', name: '2× 烈焰 SRB-S', desc: '两枚小型固体助推器（带鼻锥）', count: 2, stack: ['nose_s', 'srb_s'] },
  { id: 'srbs4', name: '4× 烈焰 SRB-S', desc: '四枚小型固体助推器（带鼻锥）', count: 4, stack: ['nose_s', 'srb_s'] },
  { id: 'srbm2', name: '2× 怒火 SRB-M', desc: '两枚大型固体助推器', count: 2, stack: ['nose_m', 'srb_m'] },
  { id: 'srbm4', name: '4× 怒火 SRB-M', desc: '四枚大型固体助推器', count: 4, stack: ['nose_m', 'srb_m'] },
  { id: 'liq2', name: '2× 液体助推器', desc: 'S 型长箱 + 雷霆 K-240，各自独立供油', count: 2, stack: ['nose_s', 'tank_s4', 'eng_s_boost'] },
  { id: 'liq4', name: '4× 液体助推器', desc: '类似“联盟号”的四枚捆绑液体助推器', count: 4, stack: ['nose_s', 'tank_s4', 'eng_s_boost'] },
];

type Tab = PartCategory | 'radial';
type Panel = 'parts' | 'stack' | 'stats';

const TAB_ORDER: Tab[] = ['pod', 'tank', 'engine', 'booster', 'structure', 'utility', 'accessory', 'radial'];

/** 由 App 提供的弹窗与提示功能。 */
export interface UIHost {
  openModal(content: HTMLElement): void;
  closeModal(): void;
  click(): void;
}

/**
 * 手机版总装车间：顶部是设计名称与菜单，底部（横屏时在右侧）是可收起的面板，
 * 分为“零件 / 结构 / 性能”三页；发射按钮始终可见。
 */
export class BuilderUI {
  root: HTMLDivElement;
  design: RocketDesign;
  selected: number | null = null;
  tab: Tab = 'pod';
  panel: Panel = 'parts';
  expanded = true;
  scenario: Scenario = 'pad';
  stats!: DesignStats;
  onLaunch: (d: RocketDesign, s: Scenario) => void = () => {};
  onHelp: () => void = () => {};
  onSettings: () => void = () => {};
  private scene: BuilderScene;
  private host: UIHost;
  private top!: HTMLDivElement;
  private summary!: HTMLDivElement;
  private sheet!: HTMLDivElement;
  private sheetHead!: HTMLDivElement;
  private body!: HTMLDivElement;
  private scrollMemo: Partial<Record<Panel, number>> = {};
  private ro: ResizeObserver | null = null;

  constructor(parent: HTMLElement, scene: BuilderScene, host: UIHost) {
    this.scene = scene;
    this.host = host;
    this.root = h('div', { class: 'builder' });
    parent.appendChild(this.root);
    let d: RocketDesign | null = null;
    try {
      const s = localStorage.getItem(LAST_KEY);
      if (s) d = JSON.parse(s);
    } catch {
      d = null;
    }
    this.design = d && d.stack?.length ? d : templateDesign('lunar');
    scene.onPick = (key) => {
      if (!key) {
        this.select(null);
        return;
      }
      const uid = parseInt(key.split('_')[0], 10);
      // 捆绑组零件：选中其所属的主堆叠零件
      const p = layoutDesign(this.design).byKey.get(key);
      this.select(p ? p.parentUid : uid);
      // 在 3D 视图里点中零件时切到“结构”页，方便直接操作
      this.panel = 'stack';
      this.expanded = true;
      this.renderSheet();
    };
    this.build();
    this.refresh(false);
    window.addEventListener('resize', () => this.updateInsets());
  }

  show(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    this.scene.active = v;
    if (v) requestAnimationFrame(() => this.updateInsets());
  }

  private build(): void {
    clear(this.root);
    this.top = h('div', { class: 'mb-top' });
    this.summary = h('div', { class: 'mb-summary panel', onclick: () => this.openPanel('stats') });
    this.sheetHead = h('div', { class: 'mb-sheet-head' });
    this.body = h('div', { class: 'mb-sheet-body' });
    this.sheet = h('div', { class: 'mb-sheet panel' }, this.sheetHead, this.body);
    this.root.append(this.top, this.summary, this.sheet);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.updateInsets());
      this.ro.observe(this.sheet);
      this.ro.observe(this.top);
    }
  }

  /** 告诉 3D 场景哪些区域被面板挡住，让火箭显示在剩余区域的中央。 */
  private updateInsets(): void {
    if (this.root.style.display === 'none') return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const s = this.sheet.getBoundingClientRect();
    const t = this.summary.getBoundingClientRect();
    const top = Math.max(0, t.bottom);
    if (s.width < W * 0.7) {
      // 横屏：面板在右侧
      this.scene.setInset(0, this.expanded ? Math.max(0, W - s.left) : 0, top, 0);
    } else {
      this.scene.setInset(0, 0, top, Math.max(0, H - s.top));
    }
  }

  select(uid: number | null): void {
    this.selected = uid;
    this.scene.select(uid === null ? null : `${uid}`);
    this.renderSheet();
  }

  private openPanel(p: Panel): void {
    this.host.click();
    if (this.panel === p && this.expanded) this.expanded = false;
    else {
      this.panel = p;
      this.expanded = true;
    }
    this.renderSheet();
  }

  private findNode(uid: number): { list: PartNode[]; index: number; node: PartNode } | null {
    const i = this.design.stack.findIndex((n) => n.uid === uid);
    if (i >= 0) return { list: this.design.stack, index: i, node: this.design.stack[i] };
    return null;
  }

  private saveLast(): void {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(this.design));
    } catch {
      /* 忽略 */
    }
  }

  private changed(): void {
    this.saveLast();
    this.refresh(true);
  }

  refresh(keepCamera: boolean): void {
    const layout = layoutDesign(this.design);
    this.stats = analyzeDesign(layout);
    this.scene.setLayout(layout, keepCamera);
    this.scene.select(this.selected === null ? null : `${this.selected}`);
    this.renderTop();
    this.renderSummary();
    this.renderSheet();
  }

  // ---------------------------------------------------------------- 顶栏与概要

  private renderTop(): void {
    clear(this.top);
    this.top.append(
      h('div', { class: 'mb-title' }, '火箭工坊'),
      h(
        'button',
        { class: 'mb-name', onclick: () => this.showDesignMenu() },
        h('span', { class: 'nm' }, this.design.name || '未命名'),
        h('span', { class: 'caret' }, '▾'),
      ),
      h('div', { class: 'mb-top-spacer' }),
      h('button', { class: 'icon-btn', 'aria-label': '操作说明', onclick: () => this.onHelp() }, '?'),
      h('button', { class: 'icon-btn', 'aria-label': '设置', onclick: () => this.onSettings() }, '⚙'),
    );
  }

  private renderSummary(): void {
    const s = this.stats;
    const first = s.stages.find((st) => st.engines > 0);
    const status =
      s.errors.length > 0
        ? h('span', { class: 'st bad' }, `✕ ${s.errors.length} 个错误`)
        : s.warnings.length > 0
          ? h('span', { class: 'st warn' }, `⚠ ${s.warnings.length} 个提醒`)
          : h('span', { class: 'st good' }, '✓ 可以发射');
    clear(this.summary);
    this.summary.append(h('span', null, h('b', null, fmtMass(s.mass))), h('span', null, 'Δv ', h('b', null, s.totalDv.toFixed(0))));
    if (first) this.summary.append(h('span', null, '推重比 ', h('b', null, first.twrSL.toFixed(2))));
    this.summary.append(status);
  }

  // ---------------------------------------------------------------- 面板

  private renderSheet(): void {
    // 记住滚动位置，避免每次改动后列表跳回顶部
    const prevPanel = this.body.dataset.panel as Panel | undefined;
    if (prevPanel) this.scrollMemo[prevPanel] = this.body.scrollTop;
    clear(this.sheetHead);
    const tab = (p: Panel, label: string, badge?: string) =>
      h('button', { class: `mb-tab ${this.panel === p && this.expanded ? 'on' : ''}`, onclick: () => this.openPanel(p) }, label, badge ? h('span', { class: 'badge' }, badge) : null);
    const s = this.stats;
    this.sheetHead.append(
      tab('parts', '零件'),
      tab('stack', '结构'),
      tab('stats', '性能', s.errors.length ? String(s.errors.length) : undefined),
      h('button', { class: 'mb-collapse', 'aria-label': '收起', onclick: () => this.toggleExpanded() }, this.expanded ? '▾' : '▴'),
      h('button', { class: 'primary mb-launch', onclick: () => this.showLaunch() }, '🚀 发射'),
    );
    this.sheet.classList.toggle('collapsed', !this.expanded);
    clear(this.body);
    this.body.dataset.panel = this.panel;
    if (this.expanded) {
      if (this.panel === 'parts') this.renderParts();
      else if (this.panel === 'stack') this.renderStack();
      else this.renderStats();
      this.body.scrollTop = this.scrollMemo[this.panel] ?? 0;
    }
    requestAnimationFrame(() => this.updateInsets());
  }

  private toggleExpanded(): void {
    this.host.click();
    this.expanded = !this.expanded;
    this.renderSheet();
  }

  private selectedName(): string | null {
    if (this.selected === null) return null;
    const f = this.findNode(this.selected);
    return f ? getPart(f.node.part).name : null;
  }

  // ---------------------------------------------------------------- 零件库

  private renderParts(): void {
    const chips = h('div', { class: 'mb-chips' });
    for (const t of TAB_ORDER) {
      chips.appendChild(
        h(
          'button',
          {
            class: this.tab === t ? 'on' : '',
            onclick: () => {
              this.tab = t;
              this.scrollMemo.parts = 0;
              this.renderSheet();
            },
          },
          t === 'radial' ? '捆绑助推' : CATEGORY_NAMES[t],
        ),
      );
    }
    this.body.appendChild(chips);
    const sel = this.selectedName();
    const target =
      this.tab === 'radial'
        ? sel
          ? `点击预设，把助推器捆绑在「${sel}」侧面（单独一级抛离）`
          : '先在“结构”页选中一个燃料箱（通常是第一级），再选择捆绑方式'
        : this.tab === 'accessory'
          ? sel
            ? `附件将安装在「${sel}」上（着陆腿装在着陆级燃料箱，尾翼装在第一级底部）`
            : '先在“结构”页或 3D 视图中选中一个零件，再选择附件'
          : sel
            ? `点击零件，添加到「${sel}」下方`
            : '点击零件，添加到箭体最底部（先选中零件可插入到它下方）';
    this.body.appendChild(h('div', { class: 'msg hint' }, target));
    const list = h('div', { class: 'mb-parts' });
    if (this.tab === 'radial') {
      for (const p of RADIAL_PRESETS) {
        list.appendChild(
          h(
            'div',
            { class: 'part-item', onclick: () => this.tapFeedback(() => this.applyRadial(p.count, p.stack)) },
            radialIcon(p.count),
            h('div', { class: 'part-info' }, h('div', { class: 'part-name' }, p.name), h('div', { class: 'part-stats' }, p.desc)),
          ),
        );
      }
    } else {
      for (const p of PARTS.filter((x) => x.category === this.tab)) {
        list.appendChild(
          h(
            'div',
            { class: 'part-item', onclick: () => this.tapFeedback(() => this.addPart(p)) },
            partIcon(p),
            h('div', { class: 'part-info' }, h('div', { class: 'part-name' }, p.name), h('div', { class: 'part-stats', html: partStats(p) })),
          ),
        );
      }
    }
    this.body.appendChild(list);
  }

  private tapFeedback(f: () => void): void {
    this.host.click();
    f();
  }

  private addPart(p: PartDef): void {
    if (p.category === 'accessory') {
      if (this.selected === null) {
        toastMsg('请先选中一个零件（在“结构”页或 3D 视图中点选）');
        return;
      }
      const f = this.findNode(this.selected);
      if (!f) return;
      f.node.acc = { part: p.id, count: 4 };
      toastMsg(`已在「${getPart(f.node.part).name}」上安装 ${p.name} ×4`);
      this.changed();
      return;
    }
    const uid = maxUid(this.design) + 1;
    const node: PartNode = { uid, part: p.id };
    if (this.selected !== null) {
      const f = this.findNode(this.selected);
      if (f) f.list.splice(f.index + 1, 0, node);
      else this.design.stack.push(node);
    } else this.design.stack.push(node);
    this.selected = uid;
    toastMsg(`已添加 ${p.name}`);
    this.changed();
  }

  private applyRadial(count: number, stack: string[]): void {
    if (this.selected === null) {
      toastMsg('请先选中一个零件（通常是第一级燃料箱）');
      return;
    }
    const f = this.findNode(this.selected);
    if (!f) return;
    let uid = maxUid(this.design) + 1;
    f.node.radial = { count, stack: stack.map((part) => ({ uid: uid++, part })) };
    toastMsg(`已捆绑 ${count} 枚助推器`);
    this.changed();
  }

  // ---------------------------------------------------------------- 结构

  private renderStack(): void {
    const layout = layoutDesign(this.design);
    // 选中零件详情与操作
    const detail = h('div', { class: 'mb-detail' });
    const f = this.selected !== null ? this.findNode(this.selected) : null;
    if (f) {
      const n = f.node;
      const def = getPart(n.part);
      detail.appendChild(h('div', { class: 'part-name' }, def.name));
      detail.appendChild(h('div', { class: 'part-stats', html: `${def.desc}<br>${partStats(def, n.prop)}` }));
      const acts = h('div', { class: 'detail-actions' });
      const act = (label: string, fn: () => void, cls = '') =>
        h(
          'button',
          {
            class: cls,
            onclick: () => {
              this.host.click();
              fn();
            },
          },
          label,
        );
      acts.append(act('↑ 上移', () => this.move(-1)), act('↓ 下移', () => this.move(1)), act('✕ 删除', () => this.remove(), 'danger'));
      if (def.tankVolume) {
        acts.append(
          act(
            n.prop === 'hydrolox' ? '推进剂：液氢液氧' : '推进剂：液氧煤油',
            () => {
              n.prop = n.prop === 'hydrolox' ? 'kerolox' : 'hydrolox';
              this.changed();
            },
            n.prop === 'hydrolox' ? 'on' : '',
          ),
        );
      }
      if (n.acc) {
        const ad = getPart(n.acc.part);
        acts.append(
          act(`${ad.name} ×${n.acc.count}`, () => {
            n.acc!.count = n.acc!.count === 4 ? 3 : 4;
            this.changed();
          }),
          act('移除附件', () => {
            delete n.acc;
            this.changed();
          }),
        );
      }
      if (n.radial) {
        acts.append(
          act(`捆绑数量 ×${n.radial.count}`, () => {
            const c = [2, 3, 4, 6];
            n.radial!.count = c[(c.indexOf(n.radial!.count) + 1) % c.length];
            this.changed();
          }),
          act('移除捆绑', () => {
            delete n.radial;
            this.changed();
          }),
        );
      }
      detail.appendChild(acts);
    } else {
      detail.appendChild(h('div', { class: 'msg hint' }, '点选下方列表或 3D 视图中的零件，即可上移、下移、删除或更换推进剂。'));
    }
    this.body.appendChild(detail);

    const stackBox = h('div', { class: 'mb-stack' }, h('h3', null, '箭体结构（自上而下）'));
    let lastSec = -1;
    for (const n of this.design.stack) {
      const p = layout.byKey.get(`${n.uid}`);
      if (!p) continue;
      if (p.section !== lastSec && lastSec !== -1) stackBox.appendChild(h('div', { class: 'stack-sep' }, '— 分离面 —'));
      lastSec = p.section;
      const def = getPart(n.part);
      const tags: HTMLElement[] = [];
      if (n.prop === 'hydrolox' && def.tankVolume) tags.push(h('span', { class: 'tag' }, '氢氧'));
      if (n.acc) tags.push(h('span', { class: 'tag' }, `${getPart(n.acc.part).accessory?.kind === 'legs' ? '腿' : '翼'}×${n.acc.count}`));
      if (n.radial) tags.push(h('span', { class: 'tag' }, `捆绑×${n.radial.count}`));
      stackBox.appendChild(
        h(
          'div',
          {
            class: `stack-row ${this.selected === n.uid ? 'sel' : ''}`,
            onclick: () => {
              this.host.click();
              this.select(this.selected === n.uid ? null : n.uid);
            },
          },
          h('span', { class: 'sec' }, p.section === layout.sections - 1 && layout.sections > 1 ? '顶' : `${p.section + 1}级`),
          h('span', { class: 'nm' }, def.name),
          ...tags,
        ),
      );
    }
    if (!this.design.stack.length) stackBox.appendChild(h('div', { class: 'msg hint' }, '空。先到“零件”页添加一个指令舱。'));
    this.body.appendChild(stackBox);
  }

  private move(dir: number): void {
    if (this.selected === null) return;
    const f = this.findNode(this.selected);
    if (!f) return;
    const j = f.index + dir;
    if (j < 0 || j >= f.list.length) return;
    const [n] = f.list.splice(f.index, 1);
    f.list.splice(j, 0, n);
    this.changed();
  }

  private remove(): void {
    if (this.selected === null) return;
    const f = this.findNode(this.selected);
    if (!f) return;
    f.list.splice(f.index, 1);
    const nb = f.list[Math.min(f.index, f.list.length - 1)];
    this.selected = nb ? nb.uid : null;
    this.changed();
  }

  // ---------------------------------------------------------------- 性能

  private renderStats(): void {
    const s = this.stats;
    this.body.appendChild(
      h('div', { class: 'stats-grid' }, stat('总质量', fmtMass(s.mass)), stat('高度', `${s.height.toFixed(1)} m`), stat('总 Δv', `${s.totalDv.toFixed(0)}`)),
    );
    for (const e of s.errors) this.body.appendChild(h('div', { class: 'msg err' }, e));
    for (const e of s.warnings) this.body.appendChild(h('div', { class: 'msg warn' }, e));
    const tbl = h('table', { class: 'stages' }, h('tr', null, h('th', null, '级'), h('th', null, 'Δv'), h('th', null, '推重比'), h('th', null, '月面'), h('th', null, '时间')));
    s.stages.forEach((st, i) => {
      if (st.engines === 0 && st.dv === 0) return;
      tbl.appendChild(
        h(
          'tr',
          null,
          h('td', null, `${i + 1}. ${st.label}`),
          h('td', null, st.dv.toFixed(0)),
          h('td', null, (i === 0 ? st.twrSL : st.twrVac).toFixed(2)),
          h('td', null, st.twrMoon.toFixed(1)),
          h('td', null, `${st.burnTime.toFixed(0)}s`),
        ),
      );
    });
    this.body.appendChild(tbl);
    this.body.appendChild(
      h('div', { class: 'part-stats', style: { marginTop: '8px' } }, '参考 Δv（m/s）：入轨≈3400 · 奔月≈950 · 月球捕获+着陆≈1000 · 月面起飞≈750 · 返回≈300（地球再入靠大气减速）'),
    );
    for (const e of s.hints.slice(0, 3)) this.body.appendChild(h('div', { class: 'msg hint' }, e));
  }

  // ---------------------------------------------------------------- 弹窗：设计菜单与发射

  private showDesignMenu(): void {
    this.host.click();
    const saves = loadSaves();
    const name = h('input', {
      type: 'text',
      value: this.design.name,
      maxlength: '24',
      enterkeyhint: 'done',
      oninput: (e: Event) => {
        this.design.name = (e.target as HTMLInputElement).value;
        this.saveLast();
        this.renderTop();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      },
    });
    const load = (d: RocketDesign) => {
      this.design = cloneDesign(d);
      this.selected = null;
      this.saveLast();
      this.refresh(false);
      this.host.closeModal();
    };
    const saveList = h('div', { class: 'mb-list' });
    const keys = Object.keys(saves);
    if (!keys.length) saveList.appendChild(h('div', { class: 'part-stats' }, '还没有存档。点“保存当前设计”把它存起来。'));
    for (const k of keys) {
      saveList.appendChild(
        h(
          'div',
          { class: 'mb-list-row' },
          h('span', { class: 'nm' }, k),
          h('button', { onclick: () => load(saves[k]) }, '载入'),
          h(
            'button',
            {
              class: 'danger',
              onclick: () => {
                if (!confirm(`删除存档「${k}」？`)) return;
                const all = loadSaves();
                delete all[k];
                writeSaves(all);
                this.showDesignMenu();
              },
            },
            '删除',
          ),
        ),
      );
    }
    this.host.openModal(
      h(
        'div',
        { class: 'modal panel' },
        h('h2', null, '我的火箭'),
        h('label', { class: 'field' }, h('span', null, '名称'), name),
        h(
          'div',
          { class: 'actions', style: { marginTop: '10px' } },
          h(
            'button',
            {
              class: 'primary',
              onclick: () => {
                const all = loadSaves();
                all[this.design.name || '未命名'] = cloneDesign(this.design);
                writeSaves(all);
                toastMsg(`已保存「${this.design.name || '未命名'}」`);
                this.host.closeModal();
              },
            },
            '💾 保存当前设计',
          ),
          h('button', { onclick: () => load({ name: '新火箭', stack: [{ uid: 1, part: 'pod_s' }] }) }, '＋ 新建空白火箭'),
        ),
        h('h3', { class: 'modal-sub' }, '预设模板'),
        h(
          'div',
          { class: 'mb-list' },
          ...TEMPLATES.map((t) =>
            h('div', { class: 'mb-tpl', onclick: () => load(t.design) }, h('div', { class: 'part-name' }, t.design.name), h('div', { class: 'part-stats' }, t.desc)),
          ),
        ),
        h('h3', { class: 'modal-sub' }, '我的存档'),
        saveList,
        h('div', { class: 'actions' }, h('button', { onclick: () => this.host.closeModal() }, '关闭')),
      ),
    );
  }

  private showLaunch(): void {
    this.host.click();
    const s = this.stats;
    const card = (sc: Scenario, icon: string, title: string, desc: string, disabled = false) =>
      h(
        'button',
        {
          class: `mb-scn ${sc === 'pad' ? 'main' : ''}`,
          disabled,
          onclick: () => {
            this.scenario = sc;
            this.host.closeModal();
            this.onLaunch(cloneDesign(this.design), sc);
          },
        },
        h('span', { class: 'ic' }, icon),
        h('span', null, h('span', { class: 't' }, title), h('span', { class: 'd' }, desc)),
      );
    const portrait = window.innerHeight > window.innerWidth;
    this.host.openModal(
      h(
        'div',
        { class: 'modal panel' },
        h('h2', null, `发射「${this.design.name || '未命名'}」`),
        ...s.errors.map((e) => h('div', { class: 'msg err' }, e)),
        ...s.warnings.slice(0, 2).map((e) => h('div', { class: 'msg warn' }, e)),
        h(
          'div',
          { class: 'mb-scns' },
          card('pad', '🚀', '发射台（地球）', '从海南文昌发射场起飞，完成完整的登月任务', s.errors.length > 0),
          card('leo', '🌍', '练习：100 km 地球轨道', '直接从近地轨道开始，练习奔月转移'),
          card('llo', '🌙', '练习：22 km 环月轨道', '直接从环月轨道开始，练习月面着陆'),
        ),
        portrait ? h('div', { class: 'msg hint' }, '提示：把手机横过来飞行，视野更开阔、操作更顺手。') : null,
        h('div', { class: 'actions' }, h('button', { onclick: () => this.host.closeModal() }, '取消')),
      ),
    );
  }
}

function stat(k: string, v: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
}

function loadSaves(): Record<string, RocketDesign> {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeSaves(all: Record<string, RocketDesign>): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(all));
  } catch {
    /* 忽略 */
  }
}

let toastEl: HTMLDivElement | null = null;
let toastTimer = 0;

/** 总装车间的轻提示（同一时间只显示一条）。 */
export function toastMsg(s: string): void {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast info mb-toast' });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = s;
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (toastEl) toastEl.style.opacity = '0';
  }, 1800);
}

export function partStats(p: PartDef, prop?: 'kerolox' | 'hydrolox'): string {
  const out: string[] = [];
  if (p.tankVolume) {
    const k = tankMasses(p, prop ?? 'kerolox');
    const hy = tankMasses(p, 'hydrolox');
    if (prop) out.push(`${PROPELLANTS[prop].name}：推进剂 ${fmtMass(k.fuel)}，干重 ${fmtMass(k.dry)}`);
    else out.push(`煤油 ${fmtMass(k.fuel)} / 氢氧 ${fmtMass(hy.fuel)}（干重 ${fmtMass(k.dry)}）`);
  } else if (p.category !== 'accessory') out.push(`质量 ${fmtMass(p.dryMass + (p.solidFuel ?? 0))}`);
  else out.push(`每件 ${fmtMass(p.dryMass)}`);
  if (p.engine) {
    const e = p.engine;
    out.push(`推力 ${fmtForce(e.thrustVac * (e.ispSL / e.ispVac))}（海平面）/ ${fmtForce(e.thrustVac)}（真空）`);
    out.push(`比冲 ${e.ispSL} / ${e.ispVac} s · ${e.propellant === 'hydrolox' ? '液氢液氧' : e.propellant === 'solid' ? '固体' : '液氧煤油'}`);
  }
  if (p.crew) out.push(`乘员 ${p.crew} 人`);
  if (p.parachute) out.push(`伞径 ${p.parachute.canopyDiameter} m`);
  if (p.heatShield) out.push('耐热 3400 K');
  return out.join('<br>');
}

function partIcon(p: PartDef): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 84;
  c.height = 104;
  c.className = 'part-icon';
  const ctx = c.getContext('2d')!;
  const cx = 42;
  const scale = 26;
  const top = 18;
  const bot = 90;
  const wT = (p.diameter || 0.05) * scale;
  const wB = (p.bottomDiameter || 0.05) * scale;
  const grad = (a: string, b: string) => {
    const g = ctx.createLinearGradient(cx - 30, 0, cx + 30, 0);
    g.addColorStop(0, b);
    g.addColorStop(0.45, a);
    g.addColorStop(1, b);
    return g;
  };
  ctx.lineJoin = 'round';
  if (p.category === 'engine' || p.category === 'booster') {
    if (p.category === 'booster') {
      ctx.fillStyle = grad('#f2f2ee', '#9a9a96');
      ctx.fillRect(cx - wT / 2, top - 8, wT, bot - top - 4);
      ctx.fillStyle = '#3a3c40';
      ctx.fillRect(cx - wT / 2, top + 14, wT, 3);
      ctx.fillRect(cx - wT / 2, top + 34, wT, 3);
    } else {
      ctx.fillStyle = '#3a3c40';
      ctx.fillRect(cx - wT / 2, top, wT, 10);
    }
    const n = p.engine?.cluster ?? 1;
    const br = Math.min(28, p.engine!.bellRadius * scale);
    for (let i = 0; i < n; i++) {
      const ox = n > 1 ? (i - (n - 1) / 2) * br * 0.9 : 0;
      ctx.fillStyle = grad('#a4a8b0', '#4a3a30');
      ctx.beginPath();
      ctx.moveTo(cx + ox - br * 0.3, top + 12);
      ctx.lineTo(cx + ox + br * 0.3, top + 12);
      ctx.quadraticCurveTo(cx + ox + br * 0.35, bot - 20, cx + ox + br, bot);
      ctx.lineTo(cx + ox - br, bot);
      ctx.quadraticCurveTo(cx + ox - br * 0.35, bot - 20, cx + ox - br * 0.3, top + 12);
      ctx.fill();
    }
    return c;
  }
  let colA = '#f0f0ec';
  let colB = '#8d8d8a';
  if (p.category === 'pod') {
    colA = '#d8dade';
    colB = '#6d7076';
  }
  if (p.heatShield) {
    colA = '#8a5a34';
    colB = '#3a2412';
  }
  if (p.decoupler) {
    colA = '#e8b21a';
    colB = '#6b520c';
  }
  if (p.accessory) {
    ctx.strokeStyle = '#b8c2cc';
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (p.accessory.kind === 'legs') {
      ctx.moveTo(cx - 8, top + 10);
      ctx.lineTo(cx - 28, bot);
      ctx.moveTo(cx + 8, top + 10);
      ctx.lineTo(cx + 28, bot);
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.fillRect(cx - 36, bot - 2, 16, 5);
      ctx.fillRect(cx + 20, bot - 2, 16, 5);
    } else {
      ctx.fillStyle = grad('#dfe1e3', '#777');
      ctx.beginPath();
      ctx.moveTo(cx - 6, top + 10);
      ctx.lineTo(cx + 26, bot - 20);
      ctx.lineTo(cx + 26, bot);
      ctx.lineTo(cx - 6, bot);
      ctx.fill();
    }
    return c;
  }
  const hPx = Math.min(bot - top, Math.max(10, p.height * 16));
  const y0 = (top + bot) / 2 - hPx / 2;
  ctx.fillStyle = grad(colA, colB);
  ctx.beginPath();
  ctx.moveTo(cx - wT / 2, y0);
  ctx.lineTo(cx + wT / 2, y0);
  ctx.lineTo(cx + wB / 2, y0 + hPx);
  ctx.lineTo(cx - wB / 2, y0 + hPx);
  ctx.closePath();
  ctx.fill();
  if (p.tankVolume) {
    ctx.fillStyle = '#26282c';
    ctx.fillRect(cx - wT / 2, y0, wT, 3);
    ctx.fillRect(cx - wT / 2, y0 + hPx - 3, wT, 3);
  }
  if (p.parachute) {
    ctx.fillStyle = '#e0561b';
    ctx.beginPath();
    ctx.arc(cx, y0, wB / 2, Math.PI, 0);
    ctx.fill();
  }
  return c;
}

function radialIcon(n: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 84;
  c.height = 104;
  c.className = 'part-icon';
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d9d9d4';
  ctx.fillRect(34, 10, 16, 84);
  ctx.fillStyle = '#b8b8b2';
  const xs = n === 2 ? [18, 66] : [12, 24, 60, 72];
  for (const x of xs) {
    ctx.fillRect(x - 5, 34, 10, 60);
    ctx.beginPath();
    ctx.moveTo(x - 5, 34);
    ctx.lineTo(x, 22);
    ctx.lineTo(x + 5, 34);
    ctx.fill();
  }
  return c;
}
