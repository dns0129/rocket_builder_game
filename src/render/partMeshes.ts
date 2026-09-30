import * as THREE from 'three';
import { getPart, type PartDef } from '../rocket/parts';
import type { PartNode } from '../rocket/design';
import { canopyTexture, foilNormal, hazardTexture, nozzleTexture, tankTexture } from './textures';

/** 程序化零件模型。每个零件的局部原点位于零件底面中心，+Y 向上。 */

let M: ReturnType<typeof createMaterials> | null = null;

function createMaterials() {
  const white = tankTexture('white');
  const band = tankTexture('band');
  const roll = tankTexture('roll');
  const foam = tankTexture('foam');
  const srb = tankTexture('srb');
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  return {
    tankWhite: std({ map: white.map, normalMap: white.normal, roughness: 0.42, metalness: 0.05 }),
    tankBand: std({ map: band.map, normalMap: band.normal, roughness: 0.42, metalness: 0.05 }),
    tankRoll: std({ map: roll.map, normalMap: roll.normal, roughness: 0.42, metalness: 0.05 }),
    tankFoam: std({ map: foam.map, normalMap: foam.normal, roughness: 0.85, metalness: 0.0 }),
    srb: std({ map: srb.map, normalMap: srb.normal, roughness: 0.5, metalness: 0.05 }),
    paint: std({ color: 0xeeeeea, roughness: 0.4, metalness: 0.05 }),
    darkPaint: std({ color: 0x1d1e21, roughness: 0.55, metalness: 0.2 }),
    metal: std({ color: 0x9da2a8, roughness: 0.28, metalness: 0.95 }),
    darkMetal: std({ color: 0x3a3c40, roughness: 0.45, metalness: 0.85 }),
    nozzle: std({ map: nozzleTexture(), roughness: 0.35, metalness: 0.9, side: THREE.DoubleSide }),
    nozzleInner: std({ color: 0x1a1512, roughness: 0.8, metalness: 0.4, side: THREE.BackSide }),
    pod: std({ color: 0xc9ccd0, roughness: 0.3, metalness: 0.75 }),
    window: std({ color: 0x0b1622, roughness: 0.05, metalness: 0.3 }),
    foil: std({ color: 0xd8a93a, roughness: 0.28, metalness: 1.0, normalMap: foilNormal(), normalScale: new THREE.Vector2(0.6, 0.6) }),
    shield: std({ color: 0x5a3a22, roughness: 0.92, metalness: 0.0 }),
    hazard: std({ map: hazardTexture(), roughness: 0.5, metalness: 0.2 }),
    canopy: std({ map: canopyTexture(), roughness: 0.8, metalness: 0, side: THREE.DoubleSide }),
    line: new THREE.LineBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.6 }),
    fin: std({ color: 0xdfe1e3, roughness: 0.45, metalness: 0.3 }),
    rcs: std({ color: 0x2c2d31, roughness: 0.5, metalness: 0.6 }),
  };
}

export function materials() {
  if (!M) M = createMaterials();
  return M;
}

export interface PartVisual {
  group: THREE.Group;
  bells: { pivot: THREE.Object3D; exitY: number; radius: number; x: number; z: number }[];
  legs: { pivot: THREE.Object3D; deployed: number; stowed: number }[];
  canopy: THREE.Object3D | null;
  meshes: THREE.Mesh[];
}

function lathe(profile: [number, number][], segs = 48): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y)),
    segs,
  );
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, v: PartVisual, parent: THREE.Object3D = v.group): THREE.Mesh {
  const me = new THREE.Mesh(g, m);
  me.castShadow = true;
  me.receiveShadow = true;
  parent.add(me);
  v.meshes.push(me);
  return me;
}

function cylinder(rTop: number, rBot: number, h: number, segs = 48, open = false): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, segs, 1, open);
}

function scaleUv(g: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

function ring(v: PartVisual, r: number, y: number, h = 0.06, mat = materials().darkMetal): void {
  const m = mesh(cylinder(r, r, h, 48), mat, v);
  m.position.y = y;
}

// ---------------------------------------------------------------- 各类零件

function buildTank(v: PartVisual, def: PartDef, node: PartNode): void {
  const r = def.diameter / 2;
  const h = def.height;
  const mats = materials();
  const hydro = node.prop === 'hydrolox';
  const mat = hydro ? mats.tankFoam : def.size === 'S' ? (h >= 4 ? mats.tankRoll : mats.tankWhite) : mats.tankBand;
  const g = cylinder(r, r, h - 0.08, 64, true);
  scaleUv(g, def.size === 'S' ? 1 : 2, Math.max(1, Math.round(h / 2)));
  const m = mesh(g, mat, v);
  m.position.y = h / 2;
  ring(v, r + 0.012, 0.04, 0.08);
  ring(v, r + 0.012, h - 0.04, 0.08);
  // 顶/底盖
  const cap = mesh(new THREE.CircleGeometry(r, 48), mats.darkMetal, v);
  cap.rotation.x = -Math.PI / 2;
  cap.position.y = h;
  const cap2 = mesh(new THREE.CircleGeometry(r, 48), mats.darkMetal, v);
  cap2.rotation.x = Math.PI / 2;
  // 外部管线
  const pipe = mesh(cylinder(0.035 * (r / 0.625), 0.035 * (r / 0.625), h - 0.2, 8), mats.metal, v);
  pipe.position.set(r + 0.03, h / 2, 0);
}

function bellProfile(rt: number, re: number, L: number): [number, number][] {
  const pts: [number, number][] = [];
  const N = 20;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const r = rt + (re - rt) * Math.pow(s, 0.62);
    pts.push([r, L * (1 - s)]);
  }
  return pts; // 自上（喉部）向下（出口）
}

function buildBell(v: PartVisual, x: number, z: number, re: number, L: number, yTop: number): void {
  const mats = materials();
  const pivot = new THREE.Group();
  pivot.position.set(x, yTop, z);
  v.group.add(pivot);
  const rt = re * 0.32;
  // 燃烧室
  const ch = mesh(cylinder(rt * 1.25, rt * 1.1, L * 0.28, 24), mats.metal, v, pivot);
  ch.position.y = L * 0.14 - 0.02;
  // 喷管（外表面 + 内表面）
  const prof = bellProfile(rt, re, L);
  const outer = mesh(lathe(prof.slice().reverse(), 48), mats.nozzle, v, pivot);
  outer.position.y = -L;
  outer.castShadow = true;
  const inner = mesh(lathe(prof.slice().reverse().map(([r, y]) => [r * 0.985, y] as [number, number]), 48), mats.nozzleInner, v, pivot);
  inner.position.y = -L;
  // 冷却管束环
  const rim = mesh(new THREE.TorusGeometry(re, re * 0.025, 6, 48), mats.darkMetal, v, pivot);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = -L;
  v.bells.push({ pivot, exitY: yTop - L, radius: re, x, z });
}

function buildEngine(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const e = def.engine!;
  const h = def.height;
  const rTop = def.diameter / 2;
  const cluster = e.cluster ?? 1;
  const mountH = Math.min(0.5, h * 0.22);
  // 推力结构
  const mount = mesh(cylinder(rTop, rTop * 0.72, mountH, 48), mats.darkMetal, v);
  mount.position.y = h - mountH / 2;
  ring(v, rTop + 0.01, h - 0.03, 0.06, mats.metal);
  // 涡轮泵等细节
  const pumpR = rTop * 0.18;
  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI + 0.6;
    const p = mesh(cylinder(pumpR, pumpR, h * 0.25, 16), mats.metal, v);
    p.position.set(Math.cos(a) * rTop * 0.45, h - mountH - h * 0.12, Math.sin(a) * rTop * 0.45);
  }
  const bellL = (h - mountH) * 0.92;
  const yTop = h - mountH * 0.6;
  if (cluster > 1) {
    const rr = rTop * 0.5;
    for (let i = 0; i < cluster; i++) {
      const a = (i / cluster) * Math.PI * 2 + Math.PI / 4;
      buildBell(v, Math.cos(a) * rr, Math.sin(a) * rr, e.bellRadius, bellL * 0.9, yTop);
    }
  } else {
    buildBell(v, 0, 0, e.bellRadius, bellL, yTop);
  }
  if (e.plume === 'lander') {
    // 着陆发动机：金箔包覆的框架
    const foil = mesh(cylinder(rTop * 0.95, rTop * 0.95, mountH * 0.6, 8), mats.foil, v);
    foil.position.y = h - mountH * 0.7;
  }
}

function buildSrb(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const r = def.diameter / 2;
  const h = def.height;
  const nozL = Math.min(1.2, h * 0.12);
  const bodyH = h - nozL;
  const g = cylinder(r, r, bodyH, 48, true);
  scaleUv(g, 1, Math.round(bodyH / 2.5));
  const body = mesh(g, mats.srb, v);
  body.position.y = nozL + bodyH / 2;
  const top = mesh(new THREE.CircleGeometry(r, 48), mats.darkMetal, v);
  top.rotation.x = -Math.PI / 2;
  top.position.y = h;
  const skirt = mesh(cylinder(r, r * 1.12, nozL * 0.6, 48, true), mats.paint, v);
  skirt.position.y = nozL - nozL * 0.3;
  buildBell(v, 0, 0, def.engine!.bellRadius, nozL, nozL);
  for (let i = 1; i < 4; i++) ring(v, r + 0.01, nozL + (bodyH * i) / 4, 0.05);
}

function buildPod(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const rb = def.bottomDiameter / 2;
  const rt = def.diameter / 2;
  const h = def.height;
  const prof: [number, number][] = [
    [0.001, 0],
    [rb * 0.98, 0],
    [rb, 0.06],
    [rt + (rb - rt) * 0.1, h * 0.92],
    [rt, h * 0.95],
    [rt * 0.92, h],
    [0.001, h],
  ];
  mesh(lathe(prof, 64), mats.pod, v);
  // 窗户
  const slope = Math.atan2(rb - rt, h);
  for (let i = 0; i < 2; i++) {
    const a = (i - 0.5) * 0.55 + Math.PI / 2;
    const y = h * 0.55;
    const rr = rb + (rt - rb) * (y / h);
    const w = mesh(new THREE.CircleGeometry(0.09 * (rb / 0.625), 20), mats.window, v);
    w.position.set(Math.cos(a) * (rr + 0.005), y, Math.sin(a) * (rr + 0.005));
    w.lookAt(new THREE.Vector3(Math.cos(a) * 10, y + 10 * Math.tan(slope), Math.sin(a) * 10));
  }
  // 舱门
  const hatchY = h * 0.45;
  const hr = rb + (rt - rb) * (hatchY / h);
  const hatch = mesh(new THREE.BoxGeometry(0.34 * (rb / 0.625), 0.42 * (rb / 0.625), 0.03), mats.darkMetal, v);
  hatch.position.set(0, hatchY, -hr - 0.005);
  hatch.rotation.x = -slope;
  // RCS 喷口组
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const y = h * 0.78;
    const rr = rb + (rt - rb) * (y / h);
    const q = mesh(new THREE.BoxGeometry(0.08, 0.1, 0.08), mats.rcs, v);
    q.position.set(Math.cos(a) * (rr + 0.02), y, Math.sin(a) * (rr + 0.02));
  }
  ring(v, rt * 0.9, h - 0.02, 0.04, mats.metal);
}

function buildProbe(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const r = def.diameter / 2;
  const h = def.height;
  const b = mesh(cylinder(r * 0.98, r * 0.98, h * 0.8, 8), mats.foil, v);
  b.position.y = h * 0.45;
  ring(v, r, 0.03, 0.06, mats.darkMetal);
  ring(v, r, h - 0.03, 0.06, mats.darkMetal);
  const mast = mesh(cylinder(0.02, 0.02, 0.5, 8), mats.metal, v);
  mast.position.set(r * 0.4, h + 0.25, 0);
  const dish = mesh(new THREE.SphereGeometry(0.18, 20, 8, 0, Math.PI * 2, 0, 0.9), mats.paint, v);
  dish.position.set(r * 0.4, h + 0.55, 0);
  dish.rotation.x = Math.PI;
}

function buildDecoupler(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const r = def.diameter / 2;
  const h = def.height;
  const g = cylinder(r * 1.005, r * 1.005, h * 0.5, 48, true);
  scaleUv(g, 6 * (r / 0.625), 1);
  const band = mesh(g, mats.hazard, v);
  band.position.y = h / 2;
  const a = mesh(cylinder(r, r, h * 0.25, 48), mats.darkMetal, v);
  a.position.y = h * 0.125;
  const b = mesh(cylinder(r, r, h * 0.25, 48), mats.darkMetal, v);
  b.position.y = h * 0.875;
}

function buildAdapter(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const rt = def.diameter / 2;
  const rb = def.bottomDiameter / 2;
  const g = cylinder(rt, rb, def.height, 64, true);
  scaleUv(g, 2, 1);
  const m = mesh(g, mats.tankWhite, v);
  m.position.y = def.height / 2;
  ring(v, rb + 0.01, 0.03, 0.06);
  ring(v, rt + 0.01, def.height - 0.03, 0.06);
}

function buildNose(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const r = def.bottomDiameter / 2;
  const h = def.height;
  const pts: [number, number][] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    pts.push([r * Math.pow(1 - Math.pow(s, 1.9), 0.55), h * s]);
  }
  pts.unshift([0.001, 0]);
  mesh(lathe(pts, 64), mats.paint, v);
  ring(v, r + 0.01, 0.03, 0.06);
}

function buildShield(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const r = def.diameter / 2;
  const h = def.height;
  const prof: [number, number][] = [
    [0.001, -0.04],
    [r * 0.6, -0.02],
    [r * 1.0, 0.03],
    [r * 1.02, h * 0.5],
    [r, h],
    [0.001, h],
  ];
  mesh(lathe(prof, 64), mats.shield, v);
  ring(v, r * 1.01, h * 0.75, h * 0.3, mats.metal);
}

function buildChute(v: PartVisual, def: PartDef): void {
  const mats = materials();
  const rb = def.bottomDiameter / 2;
  const rt = def.diameter / 2;
  const h = def.height;
  const body = mesh(cylinder(rt, rb, h * 0.8, 32), mats.paint, v);
  body.position.y = h * 0.4;
  const cap = mesh(new THREE.SphereGeometry(rt, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), materials().canopy, v);
  cap.position.y = h * 0.8;
  cap.scale.y = 0.5;
  // 伞衣
  const D = def.parachute!.canopyDiameter;
  const canopy = new THREE.Group();
  canopy.position.y = h;
  const shellGeo = new THREE.SphereGeometry(D / 2, 32, 12, 0, Math.PI * 2, 0, 1.15);
  const shell = mesh(shellGeo, mats.canopy, v, canopy);
  const lineLen = D * 1.1;
  shell.position.y = lineLen - (D / 2) * Math.cos(1.15);
  shell.castShadow = true;
  const lp: number[] = [];
  const rimR = (D / 2) * Math.sin(1.15);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    lp.push(0, 0, 0, Math.cos(a) * rimR, lineLen, Math.sin(a) * rimR);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  canopy.add(new THREE.LineSegments(lg, mats.line));
  canopy.visible = false;
  v.group.add(canopy);
  v.canopy = canopy;
}

function buildLegs(v: PartVisual, parentDef: PartDef, count: number, accDef: PartDef): void {
  const mats = materials();
  const acc = accDef.accessory!;
  const pr = Math.max(parentDef.diameter, parentDef.bottomDiameter) / 2;
  const hingeY = parentDef.height * 0.18;
  const dx = acc.reach;
  const dy = -(hingeY + acc.drop);
  const L = Math.hypot(dx, dy);
  const deployed = Math.atan2(dx, -dy);
  const scale = accDef.size === 'M' ? 1.5 : 1;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI / 4;
    const holder = new THREE.Group();
    holder.position.set(Math.cos(a) * pr, hingeY, Math.sin(a) * pr);
    holder.rotation.y = -a;
    v.group.add(holder);
    const pivot = new THREE.Group();
    holder.add(pivot);
    const strut = mesh(cylinder(0.05 * scale, 0.04 * scale, L, 10), mats.metal, v, pivot);
    strut.position.y = -L / 2;
    const sleeve = mesh(cylinder(0.075 * scale, 0.075 * scale, L * 0.45, 10), mats.foil, v, pivot);
    sleeve.position.y = -L * 0.25;
    const foot = mesh(cylinder(0.22 * scale, 0.26 * scale, 0.06, 20), mats.darkMetal, v, pivot);
    foot.position.y = -L;
    // 足垫保持水平：在展开状态下反向旋转
    foot.rotation.z = -deployed;
    const brace = mesh(cylinder(0.025 * scale, 0.025 * scale, L * 0.55, 8), mats.metal, v, pivot);
    brace.position.set(-0.12, -L * 0.55, 0);
    brace.rotation.z = 0.25;
    // pivot 绕局部 Z 旋转：正角度使腿向外（+X）张开
    v.legs.push({ pivot, deployed: deployed, stowed: Math.PI - 0.12 });
  }
}

function buildFins(v: PartVisual, parentDef: PartDef, count: number, accDef: PartDef): void {
  const mats = materials();
  const acc = accDef.accessory!;
  const pr = Math.max(parentDef.diameter, parentDef.bottomDiameter) / 2;
  const root = accDef.height;
  const span = acc.reach;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(span, -root * 0.08);
  shape.lineTo(span, root * 0.35);
  shape.lineTo(0, root);
  shape.lineTo(0, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.05 * (accDef.size === 'M' ? 1.6 : 1), bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 1 });
  g.translate(0, 0, -0.025);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI / 4;
    const holder = new THREE.Group();
    holder.position.set(Math.cos(a) * (pr - 0.02), 0.05, Math.sin(a) * (pr - 0.02));
    holder.rotation.y = -a;
    v.group.add(holder);
    mesh(g, mats.fin, v, holder);
  }
}

export function buildPartVisual(node: PartNode, def: PartDef): PartVisual {
  const v: PartVisual = { group: new THREE.Group(), bells: [], legs: [], canopy: null, meshes: [] };
  switch (def.category) {
    case 'pod':
      if (def.id === 'probe_s') buildProbe(v, def);
      else buildPod(v, def);
      break;
    case 'tank':
      buildTank(v, def, node);
      break;
    case 'engine':
      buildEngine(v, def);
      break;
    case 'booster':
      buildSrb(v, def);
      break;
    case 'structure':
      if (def.decoupler) buildDecoupler(v, def);
      else if (def.adapter) buildAdapter(v, def);
      else if (def.noseCone) buildNose(v, def);
      break;
    case 'utility':
      if (def.heatShield) buildShield(v, def);
      else if (def.parachute) buildChute(v, def);
      break;
  }
  if (node.acc) {
    const ad = getPart(node.acc.part);
    if (ad.accessory?.kind === 'legs') buildLegs(v, def, node.acc.count, ad);
    else if (ad.accessory?.kind === 'fins') buildFins(v, def, node.acc.count, ad);
  }
  v.group.userData.partKind = def.category;
  return v;
}

/** 零件库图标（用于 UI 缩略图）的简单 2D 轮廓颜色。 */
export const CATEGORY_COLOR: Record<string, string> = {
  pod: '#c9ccd0',
  tank: '#eeeeea',
  engine: '#8f9399',
  booster: '#e9e9e4',
  structure: '#e8b21a',
  utility: '#b06b3a',
  accessory: '#9aa7b5',
};
