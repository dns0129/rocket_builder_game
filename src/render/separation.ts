import * as THREE from 'three';
import type { FlightSim } from '../game/flight';
import type { Debris, RuntimePart } from '../game/vessel';
import { atmoDensity, bodyPosition, dominantBody } from '../physics/bodies';
import { EnginePlume, type Particles } from './effects';
import type { VesselView } from './vesselView';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** 一台小型固体火箭（分离火箭 / 反推火箭 / 沉底发动机）：壳体 + 尾焰 + 烟迹。 */
interface Motor {
  holder: THREE.Group;
  plume: EnginePlume;
  radius: number;
  emitAcc: number;
}

interface DebrisFx {
  id: number;
  kind: 'stage' | 'booster';
  motors: Motor[];
  /** 下面级顶部开口（贮箱排气）位置，残骸局部坐标 */
  vent: THREE.Vector3 | null;
  ventR: number;
  age: number;
}

const casingMat = new THREE.MeshStandardMaterial({ color: 0x2b2c30, roughness: 0.6, metalness: 0.5 });
const casingGeo = new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0);

/**
 * 分离动画：
 * 1. 火工品起爆：分离面闪光、一圈高速喷出的燃气、飞溅的碎屑火花；
 * 2. 下面级顶部的反推火箭点火，使其减速后退并缓慢翻滚，同时贮箱开口排出推进剂蒸汽；
 *    捆绑助推器头尾的分离火箭把它向外推开，机头先向外偏转；
 * 3. 上面级的沉底发动机工作约 1 秒，随后主发动机点火（点火闪光）。
 */
export class SeparationFx {
  private fx = new Map<number, DebrisFx>();
  private ullage: Motor[] = [];
  private ullageOff = 0;
  private flash = new THREE.PointLight(0xfff0dc, 0, 250, 2);
  private flashT = 0;
  private flashPeak = 0;
  private flashPos = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private particles: Particles,
    private sim: FlightSim,
  ) {
    scene.add(this.flash);
  }

  private makeMotor(parent: THREE.Object3D, pos: THREE.Vector3, exhaustDir: THREE.Vector3, radius: number): Motor {
    const holder = new THREE.Group();
    holder.position.copy(pos);
    holder.quaternion.setFromUnitVectors(DOWN, exhaustDir.clone().normalize());
    const casing = new THREE.Mesh(casingGeo, casingMat);
    casing.scale.set(radius * 1.25, radius * 7, radius * 1.25);
    casing.castShadow = true;
    holder.add(casing);
    const plume = new EnginePlume('solid', radius);
    holder.add(plume.group);
    parent.add(holder);
    return { holder, plume, radius, emitAcc: 0 };
  }

  private inAir(pos: THREE.Vector3): { dens: number } {
    const sim = this.sim;
    const body = dominantBody(pos, sim.t);
    const alt = pos.distanceTo(bodyPosition(body, sim.t, this.tmp2)) - body.radius;
    return { dens: atmoDensity(body, alt) };
  }

  /** 残骸局部坐标 → 惯性系位置。 */
  private debrisToWorld(d: Debris, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(local).sub(d.com).applyQuaternion(d.q).add(d.r);
  }

  onDecouple(d: Debris, g: THREE.Group, vesselView: VesselView): void {
    const sim = this.sim;
    const parts = d.parts;
    const main = parts.filter((rp) => !rp.p.radial);
    const top = Math.max(...parts.map((rp) => rp.p.yTop));
    const bottom = Math.min(...parts.map((rp) => rp.p.yBottom));
    const fx: DebrisFx = { id: d.id, kind: d.kind, motors: [], vent: null, ventR: 0, age: 0 };
    const joints: { pos: THREE.Vector3; r: number; axis: THREE.Vector3 }[] = [];
    const { dens } = this.inAir(d.r);

    if (d.kind === 'stage' && main.length) {
      const topPart = main.reduce((a, b) => (b.p.yTop > a.p.yTop ? b : a));
      const rTop = Math.max(0.3, topPart.p.def.diameter / 2);
      const mr = 0.08 + 0.05 * rTop;
      // 顶部四台反推火箭：向前并略向外喷，推动下面级后退（在地面上分离时没有）
      for (let k = 0; k < (d.motorT > 0 ? 4 : 0); k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const pos = out.clone().multiplyScalar(rTop + mr * 1.3).setY(top - mr * 9);
        const dir = UP.clone().multiplyScalar(Math.cos(0.45)).addScaledVector(out, Math.sin(0.45));
        fx.motors.push(this.makeMotor(g, pos, dir, mr));
      }
      if (!d.rest) {
        fx.vent = new THREE.Vector3(0, top, 0);
        fx.ventR = rTop;
      }
      joints.push({ pos: new THREE.Vector3(0, top, 0), r: rTop, axis: UP.clone() });
      // 上面级：沉底发动机
      this.addUllage(vesselView, mr * 0.9);
    } else if (d.kind === 'booster') {
      const p0 = parts[0].p;
      const outL = new THREE.Vector3(p0.x, 0, p0.z).normalize();
      const inward = outL.clone().negate();
      const r = Math.max(0.25, Math.max(...parts.map((rp) => rp.p.radius)));
      const mr = 0.07 + 0.04 * r;
      const base = new THREE.Vector3(p0.x, 0, p0.z).addScaledVector(inward, r + mr);
      // 头部与尾部各一台分离火箭：朝芯级方向（略偏前 / 偏后）喷射，把助推器推开
      const nose = base.clone().setY(top - Math.min(1.2, (top - bottom) * 0.12));
      const tail = base.clone().setY(bottom + Math.min(1.2, (top - bottom) * 0.12));
      fx.motors.push(this.makeMotor(g, nose, inward.clone().multiplyScalar(Math.cos(0.6)).addScaledVector(UP, Math.sin(0.6)), mr));
      fx.motors.push(this.makeMotor(g, tail, inward.clone().multiplyScalar(Math.cos(0.6)).addScaledVector(UP, -Math.sin(0.6)), mr));
      joints.push({ pos: nose, r: r * 0.5, axis: outL.clone() });
      joints.push({ pos: tail, r: r * 0.5, axis: outL.clone() });
    }
    this.fx.set(d.id, fx);

    // ---- 火工品起爆
    const vBase = sim.vessel.v;
    const q = d.q;
    const air01 = Math.min(1, dens / 0.4);
    for (const j of joints) {
      const J = this.debrisToWorld(d, j.pos, new THREE.Vector3());
      const axisW = j.axis.clone().applyQuaternion(q).normalize();
      const e1 = new THREE.Vector3().crossVectors(axisW, Math.abs(axisW.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
      const e2 = new THREE.Vector3().crossVectors(axisW, e1);
      // 白热闪光
      for (let i = 0; i < 5; i++) {
        this.particles.emit({ pos: J.clone(), vel: vBase.clone(), life: 0.16 + Math.random() * 0.12, size0: j.r * 2.2, size1: j.r * 4.5, color: new THREE.Color(14, 12, 10), alpha: 1, drag: 0, glow: true, cool: true });
      }
      // 一圈燃气：大气中是白烟，真空中迅速膨胀消散
      const n = d.kind === 'stage' ? 30 : 12;
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        const dir = e1.clone().multiplyScalar(Math.cos(th)).addScaledVector(e2, Math.sin(th));
        const pos = J.clone().addScaledVector(dir, j.r);
        const sp = dens > 0.01 ? 7 + Math.random() * 7 : 16 + Math.random() * 12;
        const vel = vBase.clone().addScaledVector(dir, sp).addScaledVector(axisW, (Math.random() - 0.5) * 3);
        if (dens > 0.01) {
          this.particles.emit({ pos, vel, life: 2.5 + Math.random() * 2.5, size0: j.r * 0.6, size1: j.r * (2.8 + Math.random() * 1.2), color: new THREE.Color(0.9, 0.9, 0.92), alpha: 0.35 + 0.4 * air01, drag: 1.1 });
        } else {
          this.particles.emit({ pos, vel, life: 0.7 + Math.random() * 0.5, size0: j.r * 0.4, size1: j.r * 3.2, color: new THREE.Color(0.85, 0.9, 1.0), alpha: 0.3, drag: 0 });
        }
      }
      // 碎屑火花
      for (let i = 0; i < 18; i++) {
        const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        this.particles.emit({ pos: J.clone(), vel: vBase.clone().addScaledVector(dir, 12 + Math.random() * 22), life: 0.4 + Math.random() * 0.7, size0: 0.09, size1: 0.04, color: new THREE.Color(12, 7, 3), alpha: 1, drag: dens > 0.01 ? 0.5 : 0, glow: true, cool: true });
      }
      // 闪光灯跟随箭体（相对当前箭体位置）
      this.flashPos.copy(J).sub(sim.vessel.r);
    }
    this.flashPeak = d.kind === 'stage' ? 1800 : 900;
    this.flashT = 0.22;
  }

  /** 在上面级最下方的贮箱侧面装四台沉底发动机（朝后喷）。 */
  private addUllage(vesselView: VesselView, mr: number): void {
    this.clearUllage();
    const V = this.sim.vessel;
    if (this.sim.ullageT <= 0) return;
    const cands = V.parts.filter((rp: RuntimePart) => !rp.p.radial && rp.p.def.category !== 'engine');
    if (!cands.length) return;
    const low = cands.reduce((a, b) => (b.p.yBottom < a.p.yBottom ? b : a));
    const r = Math.max(0.3, Math.max(low.p.def.diameter, low.p.def.bottomDiameter) / 2);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const pos = out.clone().multiplyScalar(r + mr * 1.3).setY(low.p.yBottom + mr * 9 + 0.15);
      const dir = DOWN.clone().multiplyScalar(Math.cos(0.2)).addScaledVector(out, Math.sin(0.2));
      this.ullage.push(this.makeMotor(vesselView.group, pos, dir, mr));
    }
    this.ullageOff = 0;
  }

  private clearUllage(): void {
    for (const m of this.ullage) {
      m.holder.parent?.remove(m.holder);
      m.plume.dispose();
    }
    this.ullage = [];
  }

  /** 清掉所有分离特效（回放向后跳转、重建箭体模型时）。 */
  reset(): void {
    this.clearUllage();
    for (const fx of this.fx.values()) for (const m of fx.motors) m.plume.dispose();
    this.fx.clear();
    this.flashT = 0;
    this.flash.intensity = 0;
  }

  onDebrisGone(id: number): void {
    const fx = this.fx.get(id);
    if (!fx) return;
    for (const m of fx.motors) m.plume.dispose();
    this.fx.delete(id);
  }

  /** 每帧：尾焰、烟迹、排气与闪光。dt 为粒子时间步长。 */
  update(dt: number, time: number, origin: THREE.Vector3): void {
    const sim = this.sim;
    // 闪光灯
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt);
      const k = this.flashT / 0.22;
      this.flash.intensity = this.flashPeak * k * k;
      this.flash.position.copy(this.flashPos).add(sim.vessel.r).sub(origin);
    } else this.flash.intensity = 0;

    for (const fx of this.fx.values()) {
      const d = sim.debris.find((x) => x.id === fx.id);
      if (!d) continue;
      fx.age += dt;
      const { dens } = this.inAir(d.r);
      const pr = Math.min(1, dens / 1.225);
      const on = d.motorT > 0 ? Math.min(1, d.motorT / 0.12) : 0;
      for (const m of fx.motors) {
        m.plume.update(on, pr, time + m.radius * 100);
        if (on > 0) this.motorSmoke(m, d.v, dens, dt, origin);
      }
      // 贮箱开口排出的推进剂蒸汽
      if (fx.vent && fx.age < 3) {
        const rate = (dens > 0.01 ? 22 : 14) * (1 - fx.age / 3);
        const n = Math.floor(rate * dt + Math.random());
        const upW = UP.clone().applyQuaternion(d.q);
        for (let i = 0; i < n; i++) {
          const pos = this.debrisToWorld(d, fx.vent, new THREE.Vector3());
          const side = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4);
          const vel = d.v.clone().addScaledVector(upW, 5 + Math.random() * 5).add(side);
          if (dens > 0.01) this.particles.emit({ pos, vel, life: 2 + Math.random(), size0: fx.ventR * 0.4, size1: fx.ventR * 2.2, color: new THREE.Color(0.92, 0.94, 0.97), alpha: 0.4, drag: 0.8 });
          else this.particles.emit({ pos, vel, life: 1.1 + Math.random() * 0.5, size0: fx.ventR * 0.3, size1: fx.ventR * 3, color: new THREE.Color(0.88, 0.92, 1.0), alpha: 0.22, drag: 0 });
        }
      }
    }

    // 沉底发动机
    if (this.ullage.length) {
      const on = sim.ullageT > 0 ? Math.min(1, sim.ullageT / 0.12) : 0;
      const { dens } = this.inAir(sim.vessel.r);
      const pr = Math.min(1, dens / 1.225);
      for (const m of this.ullage) {
        m.plume.update(on, pr, time + m.radius * 50);
        if (on > 0) this.motorSmoke(m, sim.vessel.v, dens, dt, origin);
      }
      if (on <= 0) {
        this.ullageOff += dt;
        if (this.ullageOff > 1.5) this.clearUllage();
      }
    }
  }

  /** 大气中固体火箭的白色烟迹。 */
  private motorSmoke(m: Motor, vBody: THREE.Vector3, dens: number, dt: number, origin: THREE.Vector3): void {
    if (dens < 0.003) return;
    m.emitAcc += dt * 45 * Math.min(1, dens / 0.3 + 0.3);
    if (m.emitAcc < 1) return;
    m.holder.getWorldPosition(this.tmp);
    const exhaust = DOWN.clone().applyQuaternion(m.holder.getWorldQuaternion(new THREE.Quaternion()));
    while (m.emitAcc >= 1) {
      m.emitAcc -= 1;
      const pos = this.tmp.clone().add(origin).addScaledVector(exhaust, m.radius * (3 + Math.random() * 8));
      const jitter = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4);
      const vel = vBody.clone().addScaledVector(exhaust, 25 + Math.random() * 20).add(jitter);
      this.particles.emit({ pos, vel, life: 3 + Math.random() * 3, size0: m.radius * 3, size1: m.radius * (14 + Math.random() * 10), color: new THREE.Color(0.9, 0.88, 0.86), alpha: 0.55, drag: 0.9 });
    }
  }
}
