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

const TAB_ORDER: Tab[] = ['pod', 'tank', 'engine', 'booster', 'structure', 'utility', 'accessory', 'radial'];

export class BuilderUI {
  root: HTMLDivElement;
  design: RocketDesign;
  selected: number | null = null;
  tab: Tab = 'pod';
  scenario: Scenario = 'pad';
  /** 无限燃料模式（由 App 保存设置；设置菜单中也能切换，切换后调用 setInfiniteFuel 同步） */
  infiniteFuel = false;
  stats!: DesignStats;
  onLaunch: (d: RocketDesign, s: Scenario) => void = () => {};
  onInfiniteFuel: (on: boolean) => void = () => {};
  onHelp: () => void = () => {};
  onDemos: () => void = () => {};
  onSettings: () => void = () => {};
  private scene: BuilderScene;
  private left!: HTMLDivElement;
  private right!: HTMLDivElement;
  private top!: HTMLDivElement;

  constructor(parent: HTMLElement, scene: BuilderScene) {
    this.scene = scene;
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
    };
    this.build();
    this.refresh(false);
  }

  show(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    this.scene.active = v;
  }

  private build(): void {
    clear(this.root);
    this.top = h('div', { class: 'b-top panel' });
    this.left = h('div', { class: 'b-left panel' });
    this.right = h('div', { class: 'b-right' });
    this.root.append(this.top, this.left, this.right);
  }

  select(uid: number | null): void {
    this.selected = uid;
    this.scene.select(uid === null ? null : `${uid}`);
    this.renderRight();
  }

  private findNode(uid: number): { list: PartNode[]; index: number; node: PartNode } | null {
    const i = this.design.stack.findIndex((n) => n.uid === uid);
    if (i >= 0) return { list: this.design.stack, index: i, node: this.design.stack[i] };
    return null;
  }

  private changed(): void {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(this.design));
    } catch {
      /* 忽略 */
    }
    this.refresh(true);
  }

  refresh(keepCamera: boolean): void {
    const layout = layoutDesign(this.design);
    this.stats = analyzeDesign(layout);
    this.scene.setLayout(layout, keepCamera);
    this.scene.select(this.selected === null ? null : `${this.selected}`);
    this.renderTop();
    this.renderLeft();
    this.renderRight();
  }

  // ---------------------------------------------------------------- 顶栏

  private renderTop(): void {
    clear(this.top);
    const sel = h(
      'select',
      {
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          if (!v) return;
          if (v.startsWith('tpl:')) {
            this.design = templateDesign(v.slice(4));
          } else if (v.startsWith('save:')) {
            const all = loadSaves();
            const d = all[v.slice(5)];
            if (d) this.design = cloneDesign(d);
          } else if (v === 'new') {
            this.design = { name: '新火箭', stack: [{ uid: 1, part: 'pod_s' }] };
          }
          this.selected = null;
          this.changed();
          this.refresh(false);
        },
      },
      h('option', { value: '' }, '载入设计…'),
      h('option', { value: 'new' }, '＋ 新建空白火箭'),
      h('optgroup', { label: '预设模板' }, ...TEMPLATES.map((t) => h('option', { value: `tpl:${t.id}` }, t.design.name))),
      h('optgroup', { label: '我的存档' }, ...Object.keys(loadSaves()).map((k) => h('option', { value: `save:${k}` }, k))),
    );
    const name = h('input', {
      type: 'text',
      value: this.design.name,
      style: { width: '150px' },
      oninput: (e: Event) => {
        this.design.name = (e.target as HTMLInputElement).value;
        try {
          localStorage.setItem(LAST_KEY, JSON.stringify(this.design));
        } catch {
          /* 忽略 */
        }
      },
    });
    this.top.append(
      h('div', { class: 'b-title' }, '火箭工坊 ', h('span', null, '总装车间')),
      name,
      sel,
      h(
        'button',
        {
          onclick: () => {
            const all = loadSaves();
            all[this.design.name || '未命名'] = cloneDesign(this.design);
            try {
              localStorage.setItem(SAVE_KEY, JSON.stringify(all));
            } catch {
              /* 忽略 */
            }
            this.renderTop();
          },
        },
        '💾 保存',
      ),
      h('button', { onclick: () => this.onDemos(), title: '回放保存的飞行，或观看电脑飞往月球、火星、木星' }, '🎬 Demo 回放'),
      h('button', { onclick: () => this.onHelp() }, '❔ 操作说明'),
      h('button', { onclick: () => this.onSettings() }, '⚙ 设置'),
    );
  }

  // ---------------------------------------------------------------- 零件库

  private renderLeft(): void {
    clear(this.left);
    const tabs = h('div', { class: 'b-tabs' });
    for (const t of TAB_ORDER) {
      tabs.appendChild(
        h(
          'button',
          {
            class: this.tab === t ? 'on' : '',
            onclick: () => {
              this.tab = t;
              this.renderLeft();
            },
          },
          t === 'radial' ? '捆绑助推' : CATEGORY_NAMES[t],
        ),
      );
    }
    const list = h('div', { class: 'b-parts' });
    const hint = (s: string) => h('div', { class: 'msg hint', style: { marginBottom: '8px' } }, s);
    if (this.tab === 'radial') {
      list.appendChild(hint('先在右侧选中一个燃料箱（通常是第一级），再点击下方预设，把助推器捆绑在它的侧面。助推器会在单独的一级中抛离。'));
      for (const p of RADIAL_PRESETS) {
        list.appendChild(
          h(
            'div',
            { class: 'part-item', onclick: () => this.applyRadial(p.count, p.stack) },
            radialIcon(p.count),
            h('div', null, h('div', { class: 'part-name' }, p.name), h('div', { class: 'part-stats' }, p.desc)),
          ),
        );
      }
    } else {
      if (this.tab === 'accessory') list.appendChild(hint('环绕附件会安装在当前选中的零件上（着陆腿通常装在着陆级燃料箱上，尾翼装在第一级底部）。'));
      else list.appendChild(hint('点击零件，将其添加到选中零件的下方（未选中时加到最底部）。'));
      for (const p of PARTS.filter((x) => x.category === this.tab)) {
        list.appendChild(
          h(
            'div',
            { class: 'part-item', onclick: () => this.addPart(p), title: p.desc },
            partIcon(p),
            h('div', null, h('div', { class: 'part-name' }, p.name), h('div', { class: 'part-stats', html: partStats(p) })),
          ),
        );
      }
    }
    this.left.append(tabs, list);
  }

  private addPart(p: PartDef): void {
    if (p.category === 'accessory') {
      if (this.selected === null) {
        alertMsg('请先在右侧的结构列表中选中一个零件。');
        return;
      }
      const f = this.findNode(this.selected);
      if (!f) return;
      f.node.acc = { part: p.id, count: 4 };
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
    this.changed();
  }

  private applyRadial(count: number, stack: string[]): void {
    if (this.selected === null) {
      alertMsg('请先选中一个零件（通常是第一级燃料箱）。');
      return;
    }
    const f = this.findNode(this.selected);
    if (!f) return;
    let uid = maxUid(this.design) + 1;
    f.node.radial = { count, stack: stack.map((part) => ({ uid: uid++, part })) };
    this.changed();
  }

  // ---------------------------------------------------------------- 右侧：结构、详情、统计

  private renderRight(): void {
    clear(this.right);
    const layout = layoutDesign(this.design);
    // 结构列表
    const stackBox = h('div', { class: 'panel b-section b-stack' }, h('h3', null, '箭体结构（自上而下）'));
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
          { class: `stack-row ${this.selected === n.uid ? 'sel' : ''}`, onclick: () => this.select(this.selected === n.uid ? null : n.uid) },
          h('span', { class: 'sec' }, p.section === layout.sections - 1 && layout.sections > 1 ? '顶' : `${p.section + 1}级`),
          h('span', { class: 'nm' }, def.name),
          ...tags,
        ),
      );
    }
    if (!this.design.stack.length) stackBox.appendChild(h('div', { class: 'msg hint' }, '空。先从左侧添加一个指令舱。'));

    // 选中零件详情
    const detail = h('div', { class: 'panel b-section' });
    if (this.selected !== null) {
      const f = this.findNode(this.selected);
      if (f) {
        const n = f.node;
        const def = getPart(n.part);
        detail.appendChild(h('h3', null, '选中零件'));
        detail.appendChild(h('div', { class: 'part-name' }, def.name));
        detail.appendChild(h('div', { class: 'part-stats', html: `${def.desc}<br>${partStats(def, n.prop)}` }));
        const acts = h('div', { class: 'detail-actions' });
        acts.append(
          h('button', { onclick: () => this.move(-1) }, '↑ 上移'),
          h('button', { onclick: () => this.move(1) }, '↓ 下移'),
          h('button', { onclick: () => this.remove() }, '✕ 删除'),
        );
        if (def.tankVolume) {
          acts.append(
            h(
              'button',
              {
                class: n.prop === 'hydrolox' ? 'on' : '',
                onclick: () => {
                  n.prop = n.prop === 'hydrolox' ? 'kerolox' : 'hydrolox';
                  this.changed();
                },
              },
              n.prop === 'hydrolox' ? '推进剂：液氢液氧' : '推进剂：液氧煤油',
            ),
          );
        }
        if (n.acc) {
          const ad = getPart(n.acc.part);
          acts.append(
            h(
              'button',
              {
                onclick: () => {
                  n.acc!.count = n.acc!.count === 4 ? 3 : 4;
                  this.changed();
                },
              },
              `${ad.name} ×${n.acc.count}`,
            ),
            h(
              'button',
              {
                onclick: () => {
                  delete n.acc;
                  this.changed();
                },
              },
              '移除附件',
            ),
          );
        }
        if (n.radial) {
          acts.append(
            h(
              'button',
              {
                onclick: () => {
                  const c = [2, 3, 4, 6];
                  n.radial!.count = c[(c.indexOf(n.radial!.count) + 1) % c.length];
                  this.changed();
                },
              },
              `捆绑数量 ×${n.radial.count}`,
            ),
            h(
              'button',
              {
                onclick: () => {
                  delete n.radial;
                  this.changed();
                },
              },
              '移除捆绑',
            ),
          );
        }
        detail.appendChild(acts);
      }
    } else {
      detail.appendChild(h('div', { class: 'msg hint' }, '在 3D 视图或结构列表中点击零件以选中；新零件会添加在选中零件的下方。'));
    }

    // 统计
    const s = this.stats;
    const statBox = h('div', { class: 'panel b-section' });
    statBox.appendChild(h('h3', null, '性能分析'));
    statBox.appendChild(
      h(
        'div',
        { class: 'stats-grid' },
        stat('总质量', fmtMass(s.mass)),
        stat('高度', `${s.height.toFixed(1)} m`),
        stat('总 Δv', `${s.totalDv.toFixed(0)}`),
      ),
    );
    const tbl = h('table', { class: 'stages' }, h('tr', null, h('th', null, '级'), h('th', null, 'Δv m/s'), h('th', null, '推重比'), h('th', null, '月面'), h('th', null, '时间')));
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
    statBox.appendChild(tbl);
    statBox.appendChild(
      h('div', { class: 'part-stats', style: { marginTop: '6px' } }, '参考 Δv：入轨≈3400 · 奔月≈950 · 月球捕获+着陆≈1000 · 月面起飞≈750 · 返回≈300（地球再入靠大气减速）'),
    );
    for (const e of s.errors) statBox.appendChild(h('div', { class: 'msg err' }, e));
    for (const e of s.warnings) statBox.appendChild(h('div', { class: 'msg warn' }, e));
    for (const e of s.hints.slice(0, 3)) statBox.appendChild(h('div', { class: 'msg hint' }, e));
    if (this.infiniteFuel)
      statBox.appendChild(h('div', { class: 'msg hint' }, '无限燃料已开启：液体燃料不会消耗，带液体发动机的级 Δv 不受限；固体助推器照常烧完并自动分离。'));

    // 发射
    const launch = h('div', { class: 'panel b-section' });
    const scSel = h(
      'select',
      {
        onchange: (e: Event) => {
          this.scenario = (e.target as HTMLSelectElement).value as Scenario;
        },
      },
      h('option', { value: 'pad', selected: this.scenario === 'pad' }, '发射台（地球）'),
      h('option', { value: 'leo', selected: this.scenario === 'leo' }, '练习：100 km 地球轨道'),
      h('option', { value: 'llo', selected: this.scenario === 'llo' }, '练习：22 km 环月轨道'),
      h('option', { value: 'lmo', selected: this.scenario === 'lmo' }, '练习：80 km 火星轨道'),
    );
    launch.appendChild(
      h(
        'div',
        { class: 'launch-row' },
        scSel,
        h(
          'button',
          {
            class: 'primary',
            disabled: s.errors.length > 0 && this.scenario === 'pad',
            onclick: () => this.onLaunch(cloneDesign(this.design), this.scenario),
          },
          '发射',
        ),
      ),
    );
    launch.appendChild(
      h(
        'label',
        { class: `launch-opt${this.infiniteFuel ? ' on' : ''}`, title: '液体燃料箱始终是满的，液体发动机不会熄火（固体助推器照常烧完）。飞行中也可以在“设置”里开关。' },
        h('input', {
          type: 'checkbox',
          checked: this.infiniteFuel,
          onchange: (e: Event) => this.onInfiniteFuel((e.target as HTMLInputElement).checked),
        }),
        '∞ 无限燃料模式',
      ),
    );
    this.right.append(stackBox, detail, statBox, launch);
  }

  /** 同步无限燃料设置并刷新右侧面板 */
  setInfiniteFuel(on: boolean): void {
    if (on === this.infiniteFuel) return;
    this.infiniteFuel = on;
    this.renderRight();
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

function alertMsg(s: string): void {
  const el = h('div', { class: 'toast warn', style: { position: 'fixed', top: '70px', left: '50%', transform: 'translateX(-50%)', zIndex: '30' } }, s);
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 500);
  }, 2200);
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
    const br = Math.min(28, p.engine!.bellRadius * scale * (n > 1 ? 1 : 1));
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
