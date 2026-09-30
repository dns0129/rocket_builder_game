import * as THREE from 'three';
import type { Layout, PlacedPart } from '../rocket/design';
import { buildPartVisual, materials, type PartVisual } from './partMeshes';
import { EnginePlume } from './effects';

export interface PartView {
  placed: PlacedPart;
  visual: PartVisual;
  plumes: EnginePlume[];
}

/** 由布局生成火箭的三维模型（船体坐标系，原点在主堆叠底部中心）。 */
export class VesselView {
  group = new THREE.Group();
  parts = new Map<string, PartView>();

  constructor(layout: Layout, withPlumes = true) {
    for (const p of layout.parts) {
      const visual = buildPartVisual(p.node, p.def);
      visual.group.position.set(p.x, p.yBottom, p.z);
      if (p.radial) visual.group.rotation.y = -p.angle;
      this.group.add(visual.group);
      const plumes: EnginePlume[] = [];
      if (withPlumes && p.def.engine) {
        for (const b of visual.bells) {
          const pl = new EnginePlume(p.def.engine.plume, b.radius);
          pl.group.position.set(0, -0, 0);
          b.pivot.add(pl.group);
          // 尾焰起点在喷口出口
          pl.group.position.y = b.exitY - b.pivot.position.y;
          plumes.push(pl);
        }
      }
      this.parts.set(p.key, { placed: p, visual, plumes });
    }
    // 捆绑助推器连接支架
    const mats = materials();
    for (const p of layout.parts) {
      if (!p.radial) continue;
      const isTop = !layout.parts.some((q) => q.radial && q.parentUid === p.parentUid && q.radialIndex === p.radialIndex && q.yBottom > p.yBottom);
      const isBottom = !layout.parts.some((q) => q.radial && q.parentUid === p.parentUid && q.radialIndex === p.radialIndex && q.yBottom < p.yBottom);
      if (!isTop && !isBottom) continue;
      const dist = Math.hypot(p.x, p.z);
      const view = this.parts.get(p.key)!;
      for (const y of [isTop ? p.def.height * 0.75 : null, isBottom ? p.def.height * 0.18 : null]) {
        if (y === null) continue;
        const len = dist - p.radius;
        const strut = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.12), mats.darkMetal);
        strut.position.set(-(p.radius + len / 2), y, 0);
        strut.castShadow = true;
        view.visual.group.add(strut);
        view.visual.meshes.push(strut);
      }
    }
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }

  /** 把一组零件从本模型中取出（用于分离后的残骸），返回新的组（保持相同的船体局部坐标）。 */
  detach(keys: string[]): THREE.Group {
    const g = new THREE.Group();
    for (const k of keys) {
      const pv = this.parts.get(k);
      if (!pv) continue;
      for (const pl of pv.plumes) pl.group.visible = false;
      g.add(pv.visual.group);
      this.parts.delete(k);
    }
    return g;
  }

  setLegs(deploy: number): void {
    for (const pv of this.parts.values()) {
      for (const l of pv.visual.legs) l.pivot.rotation.z = l.stowed + (l.deployed - l.stowed) * smooth(deploy);
    }
  }

  setChute(state: string, deploy: number, airDir: THREE.Vector3 | null, vesselQ: THREE.Quaternion): void {
    for (const pv of this.parts.values()) {
      const c = pv.visual.canopy;
      if (!c) continue;
      const open = state === 'deploying' || state === 'deployed';
      c.visible = open && deploy >= 0;
      if (!open) continue;
      const s = state === 'deploying' ? 0.2 : 0.2 + 0.8 * smooth(deploy);
      c.scale.set(s, 0.5 + 0.5 * s, s);
      // 伞衣指向气流反方向（即上方）
      if (airDir && airDir.lengthSq() > 1e-6) {
        const inv = vesselQ.clone().invert();
        const local = airDir.clone().negate().applyQuaternion(inv).normalize();
        c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), local);
      }
    }
  }

  setHighlight(key: string | null): void {
    for (const [k, pv] of this.parts) {
      for (const m of pv.visual.meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        if (k === key) {
          if (!m.userData.origMat) {
            m.userData.origMat = mat;
            const hm = mat.clone();
            hm.emissive = new THREE.Color(0x2a6cff);
            hm.emissiveIntensity = 0.55;
            m.material = hm;
          }
        } else if (m.userData.origMat) {
          (m.material as THREE.Material).dispose();
          m.material = m.userData.origMat;
          m.userData.origMat = undefined;
        }
      }
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
  }
}

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
