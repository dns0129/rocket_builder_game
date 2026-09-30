import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Layout } from '../rocket/design';
import { VesselView } from './vesselView';
import type { RenderEngine } from './engine';

/** 总装车间：展示火箭、点选零件。 */
export class BuilderScene {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  controls: OrbitControls;
  view: VesselView | null = null;
  private engine: RenderEngine;
  private raycaster = new THREE.Raycaster();
  private selected: string | null = null;
  private lastHeight = 0;
  onPick: (key: string | null) => void = () => {};

  constructor(engine: RenderEngine) {
    this.engine = engine;
    const pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new THREE.Color(0x0b0e13);
    this.scene.fog = new THREE.Fog(0x0b0e13, 120, 420);

    // 地面与平台
    const floorTex = gridTexture();
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(40, 40);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(400, 96),
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, map: floorTex, roughness: 0.55, metalness: 0.3 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const plat = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 7.4, 0.5, 64),
      new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.4, metalness: 0.8 }),
    );
    plat.position.y = 0.25;
    plat.receiveShadow = true;
    plat.castShadow = true;
    this.scene.add(plat);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x3aa0ff, emissive: 0x2a8cff, emissiveIntensity: 2.5 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(7.2, 0.05, 8, 128), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.5;
    this.scene.add(ring);

    // 厂房立柱与桁架（远景）
    const colMat = new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.7, metalness: 0.5 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const c = new THREE.Mesh(new THREE.BoxGeometry(2.5, 140, 2.5), colMat);
      c.position.set(Math.cos(a) * 80, 70, Math.sin(a) * 80);
      this.scene.add(c);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 1.2), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3dd, emissiveIntensity: 3 }));
      lamp.position.set(Math.cos(a) * 78, 60, Math.sin(a) * 78);
      lamp.lookAt(0, 0, 0);
      this.scene.add(lamp);
    }

    const key = new THREE.DirectionalLight(0xfff1e0, 2.6);
    key.position.set(30, 60, 40);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera as THREE.OrthographicCamera;
    sc.left = -40;
    sc.right = 40;
    sc.top = 60;
    sc.bottom = -10;
    sc.far = 200;
    key.shadow.bias = -0.0003;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fb0ff, 1.4);
    rim.position.set(-40, 30, -50);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0x9fb8d8, 0x20242a, 0.5));

    this.controls = new OrbitControls(this.camera, engine.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.53;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 250;
    this.camera.position.set(18, 10, 26);
    engine.onResize((w, h) => {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    });

    // 点选
    let down = { x: 0, y: 0 };
    engine.renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    engine.renderer.domElement.addEventListener('pointerup', (e) => {
      if (!this.view || !this.active) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = engine.renderer.domElement.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(p, this.camera);
      const hits = this.raycaster.intersectObject(this.view.group, true);
      let key: string | null = null;
      if (hits.length) {
        for (const [k, pv] of this.view.parts) {
          let o: THREE.Object3D | null = hits[0].object;
          while (o) {
            if (o === pv.visual.group) {
              key = k;
              break;
            }
            o = o.parent;
          }
          if (key) break;
        }
      }
      this.onPick(key);
    });
  }

  active = true;

  setLayout(layout: Layout, keepCamera = true): void {
    if (this.view) {
      this.scene.remove(this.view.group);
      this.view.dispose();
    }
    this.view = new VesselView(layout, false);
    this.view.group.position.y = 0.5;
    this.view.setLegs(1);
    this.scene.add(this.view.group);
    const h = Math.max(2, layout.height);
    this.controls.target.set(0, 0.5 + h * 0.5, 0);
    if (!keepCamera || Math.abs(h - this.lastHeight) > h * 0.35) {
      const d = h * 1.5 + 8;
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      if (dir.lengthSq() < 0.5) dir.set(0.5, 0.25, 0.8).normalize();
      this.camera.position.copy(this.controls.target).addScaledVector(dir, d);
    }
    this.lastHeight = h;
    this.view.setHighlight(this.selected);
  }

  select(key: string | null): void {
    this.selected = key;
    this.view?.setHighlight(key);
  }

  update(): void {
    this.controls.update();
  }

  render(): void {
    this.engine.render(this.scene, this.camera);
  }
}

function gridTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#5d646c';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(20,24,30,0.9)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(128, 0);
  ctx.lineTo(128, 256);
  ctx.moveTo(0, 128);
  ctx.lineTo(256, 128);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
