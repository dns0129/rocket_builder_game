import * as THREE from 'three';
import { EARTH, LAUNCH_SITE, bodyRotation, dirFromLatLon, fromBodyFixed } from '../physics/bodies';
import { concreteTexture } from './textures';

/** 发射场：混凝土发射台、发射塔（桁架）、储罐、照明塔，以及远处的总装厂房。 */
export class LaunchPad {
  group = new THREE.Group();
  private bfQuat = new THREE.Quaternion();
  private bfPos = new THREE.Vector3();

  constructor(rocketHeight: number, rocketRadius: number) {
    // 局部坐标：+Y 向上，+Z 向北，+X 向西（均为发射场处的天体固连方向）
    const up = dirFromLatLon(LAUNCH_SITE.lat, LAUNCH_SITE.lon);
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const west = new THREE.Vector3().crossVectors(up, north).normalize();
    this.bfPos.copy(up).multiplyScalar(EARTH.radius);
    const m = new THREE.Matrix4().makeBasis(west, up, north);
    this.bfQuat.setFromRotationMatrix(m);
    const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
    const concrete = std({ map: concreteTexture(), roughness: 0.92, metalness: 0 });
    const steel = std({ color: 0xa8432a, roughness: 0.55, metalness: 0.6 });
    const grey = std({ color: 0x8c9096, roughness: 0.5, metalness: 0.7 });
    const white = std({ color: 0xe8e8e4, roughness: 0.45, metalness: 0.1 });
    const dark = std({ color: 0x2a2c30, roughness: 0.7, metalness: 0.3 });
    const lamp = std({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 2 });
    const asphalt = std({ color: 0x2b2b2d, roughness: 0.95 });

    const add = (g: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
      const me = new THREE.Mesh(g, mat);
      me.position.set(x, y, z);
      me.castShadow = shadow;
      me.receiveShadow = true;
      this.group.add(me);
      return me;
    };

    // 发射台
    const padSize = Math.max(70, rocketRadius * 14);
    add(new THREE.BoxGeometry(padSize, 1.2, padSize), concrete, 0, -0.57, 0, false);
    // 导流槽盖板与夹持臂
    const clampR = rocketRadius + 0.9;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const c = add(new THREE.BoxGeometry(0.6, 2.2, 0.6), grey, Math.cos(a) * clampR, 1.1, Math.sin(a) * clampR);
      c.rotation.y = -a;
    }
    add(new THREE.BoxGeometry(padSize * 0.25, 0.1, 8), dark, padSize * 0.3, 0.06, 0, false);

    // 发射塔（桁架）
    const towerH = Math.max(30, rocketHeight + 12);
    const tw = 4.5;
    const tz = -(rocketRadius + 7);
    const beamGeo = new THREE.BoxGeometry(1, 1, 1);
    const beams: THREE.Matrix4[] = [];
    const beam = (a: THREE.Vector3, b: THREE.Vector3, t: number) => {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      beams.push(new THREE.Matrix4().compose(mid, q, new THREE.Vector3(t, len, t)));
    };
    const corners = [
      [-tw / 2, -tw / 2],
      [tw / 2, -tw / 2],
      [tw / 2, tw / 2],
      [-tw / 2, tw / 2],
    ];
    for (const [x, z] of corners) beam(new THREE.Vector3(x, 0, tz + z), new THREE.Vector3(x, towerH, tz + z), 0.45);
    const step = 4;
    for (let y = step; y <= towerH; y += step) {
      for (let i = 0; i < 4; i++) {
        const [x0, z0] = corners[i];
        const [x1, z1] = corners[(i + 1) % 4];
        beam(new THREE.Vector3(x0, y, tz + z0), new THREE.Vector3(x1, y, tz + z1), 0.25);
        beam(new THREE.Vector3(x0, y - step, tz + z0), new THREE.Vector3(x1, y, tz + z1), 0.14);
        beam(new THREE.Vector3(x1, y - step, tz + z1), new THREE.Vector3(x0, y, tz + z0), 0.14);
      }
    }
    // 摆杆（伸向火箭）
    const arms = Math.max(2, Math.floor(rocketHeight / 8));
    for (let k = 1; k <= arms; k++) {
      const y = (rocketHeight * k) / (arms + 0.6);
      const len = -tz - tw / 2 - rocketRadius - 0.3;
      beam(new THREE.Vector3(0, y, tz + tw / 2), new THREE.Vector3(0, y, tz + tw / 2 + len), 0.7);
      beam(new THREE.Vector3(-0.5, y + 1.2, tz + tw / 2), new THREE.Vector3(-0.5, y + 1.2, tz + tw / 2 + len), 0.12);
      beam(new THREE.Vector3(0.5, y + 1.2, tz + tw / 2), new THREE.Vector3(0.5, y + 1.2, tz + tw / 2 + len), 0.12);
    }
    const im = new THREE.InstancedMesh(beamGeo, steel, beams.length);
    beams.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.castShadow = true;
    im.receiveShadow = true;
    this.group.add(im);
    add(new THREE.BoxGeometry(tw + 1, 0.3, tw + 1), grey, 0, towerH, tz);
    add(new THREE.CylinderGeometry(0.12, 0.2, 14, 8), grey, 0, towerH + 7, tz);
    add(new THREE.BoxGeometry(1.8, towerH, 1.8), dark, tw / 2 + 1, towerH / 2, tz + tw / 2);

    // 储罐
    const lox = add(new THREE.SphereGeometry(8, 32, 16), white, -60, 11, -40);
    lox.castShadow = true;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(new THREE.CylinderGeometry(0.3, 0.3, 11, 8), grey, -60 + Math.cos(a) * 6.5, 5.5, -40 + Math.sin(a) * 6.5);
    }
    const rp1 = add(new THREE.CylinderGeometry(4, 4, 22, 32), white, 55, 4.2, -45);
    rp1.rotation.z = Math.PI / 2;
    add(new THREE.CylinderGeometry(5, 5, 26, 24), white, 50, 13, 55);
    add(new THREE.SphereGeometry(5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), white, 50, 26, 55);

    // 照明塔
    for (const [x, z] of [
      [-45, -45],
      [45, -45],
      [45, 45],
      [-45, 45],
    ]) {
      add(new THREE.CylinderGeometry(0.35, 0.5, 40, 8), grey, x, 20, z);
      const l = add(new THREE.BoxGeometry(4, 2, 1), lamp, x, 40, z, false);
      l.lookAt(new THREE.Vector3(0, 0, 0).add(this.group.position));
    }

    // 道路与总装厂房
    const road = add(new THREE.BoxGeometry(14, 0.1, 1600), asphalt, 0, 0.05, 820, false);
    road.receiveShadow = true;
    add(new THREE.BoxGeometry(160, 140, 120), std({ color: 0xd9dcdf, roughness: 0.7, metalness: 0.1 }), 0, 70, 1700);
    add(new THREE.BoxGeometry(40, 120, 2), std({ color: 0x5a6068, roughness: 0.6, metalness: 0.4 }), 0, 60, 1639);
    add(new THREE.BoxGeometry(30, 18, 2), std({ color: 0x1c3f8f, roughness: 0.6 }), 55, 110, 1639);
    add(new THREE.BoxGeometry(30, 18, 2), std({ color: 0xb8262b, roughness: 0.6 }), -55, 110, 1639);
  }

  update(t: number, origin: THREE.Vector3): void {
    const wp = fromBodyFixed(EARTH, t, this.bfPos, new THREE.Vector3());
    this.group.position.copy(wp.sub(origin));
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bodyRotation(EARTH, t));
    this.group.quaternion.copy(rot).multiply(this.bfQuat);
  }
}
