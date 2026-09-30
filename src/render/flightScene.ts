import * as THREE from 'three';
import { EARTH, MOON, SUN_DIR, atmoDensity, bodyPosition, bodyRotation, dominantBody, surfaceVelocity, toBodyFixed } from '../physics/bodies';
import type { FlightSim, FlightEvent } from '../game/flight';
import { Planets, SUN_INTENSITY, sharedUniforms } from './planets';
import type { PlanetMaps } from './planetBake';
import { TerrainPatch } from './terrainPatch';
import { LaunchPad } from './launchpad';
import { VesselView } from './vesselView';
import { Particles, ReentryGlow } from './effects';
import { SeparationFx } from './separation';
import { MapView } from './mapView';
import type { RenderEngine } from './engine';

export type CamMode = 'orbit' | 'chase' | 'free';

const UP = new THREE.Vector3(0, 1, 0);

/** 飞行场景：浮动原点、相机、光照、特效与地图视图。 */
export class FlightScene {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 0.3, 1e11);
  planets: Planets;
  patch: TerrainPatch;
  pad: LaunchPad | null = null;
  vesselView: VesselView;
  debrisViews = new Map<number, THREE.Group>();
  particles = new Particles();
  glow = new ReentryGlow();
  sepFx: SeparationFx;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  engineLight: THREE.PointLight;
  map: MapView;
  mode: 'flight' | 'map' = 'flight';
  camMode: CamMode = 'orbit';
  origin = new THREE.Vector3();
  camYaw = 2.4;
  camPitch = 0.12;
  camDist = 30;
  mapYaw = 0.5;
  mapPitch = 0.6;
  mapDist = 3e6;
  mapFocus: 'auto' | 'earth' | 'moon' | 'vessel' = 'auto';
  time = 0;
  private sim: FlightSim;
  private engine: RenderEngine;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envMat: THREE.ShaderMaterial;
  private envTimer = 99;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private emitAcc = new Map<string, number>();
  /** 上一帧正在工作的发动机（用于点火闪光） */
  private firing = new Set<string>();
  private vesselHidden = false;
  shake = 0;

  constructor(engine: RenderEngine, maps: PlanetMaps, sim: FlightSim, mapOverlay: HTMLDivElement) {
    this.engine = engine;
    this.sim = sim;
    this.planets = new Planets(maps);
    this.planets.addTo(this.scene);
    this.patch = new TerrainPatch(maps);
    this.scene.add(this.patch.mesh);
    const b = sim.vessel.bounds();
    const height = b.maxY - b.minY;
    if (sim.scenario === 'pad') {
      this.pad = new LaunchPad(height, b.radius);
      this.scene.add(this.pad.group);
    }
    this.vesselView = new VesselView(sim.vessel.layout);
    this.scene.add(this.vesselView.group);
    this.particles.addTo(this.scene);
    this.sepFx = new SeparationFx(this.scene, this.particles, sim);
    this.scene.add(this.glow.mesh);
    this.camDist = Math.max(12, height * 1.6);

    this.sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
    this.sun.castShadow = engine.quality !== 'low';
    this.sun.shadow.mapSize.set(engine.quality === 'high' ? 4096 : 2048, engine.quality === 'high' ? 4096 : 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x8fb4ff, 0x4a4036, 0.4);
    this.scene.add(this.hemi);
    this.engineLight = new THREE.PointLight(0xffa050, 0, 400, 2);
    this.scene.add(this.engineLight);

    this.map = new MapView(mapOverlay);
    this.scene.add(this.map.group);
    engine.onResize((w, h) => {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.map.setResolution(w, h);
    });

    // 环境反射：天空/地面渐变
    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uSky: { value: new THREE.Color() }, uGround: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() }, uUp: { value: new THREE.Vector3(0, 1, 0) } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 uSky; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uUp; varying vec3 vD; void main(){ float h = dot(normalize(vD), uUp); vec3 c = mix(uGround, uSky, smoothstep(-0.08, 0.12, h)); c += uSunCol * pow(max(dot(normalize(vD), uSunDir), 0.0), 600.0) * 40.0; gl_FragColor = vec4(c, 1.0); }',
    });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.envMat));
  }

  // ---------------------------------------------------------------- 事件

  handleEvents(events: FlightEvent[]): void {
    const sim = this.sim;
    for (const e of events) {
      if (e.type === 'decouple' && e.debrisId !== undefined) {
        const d = sim.debris.find((x) => x.id === e.debrisId);
        if (d) {
          const g = this.vesselView.detach(d.parts.map((p) => p.key));
          this.scene.add(g);
          this.debrisViews.set(d.id, g);
          this.sepFx.onDecouple(d, g, this.vesselView);
        }
        this.shake = Math.max(this.shake, 0.45);
      } else if (e.type === 'debrisGone' && e.debrisId !== undefined) {
        const g = this.debrisViews.get(e.debrisId);
        if (g) {
          this.scene.remove(g);
          this.debrisViews.delete(e.debrisId);
        }
        this.sepFx.onDebrisGone(e.debrisId);
      } else if (e.type === 'explosion' && e.pos) {
        const body = dominantBody(e.pos, sim.t);
        const alt = e.pos.distanceTo(bodyPosition(body, sim.t, new THREE.Vector3())) - body.radius;
        const vel = surfaceVelocity(body, sim.t, e.pos, new THREE.Vector3());
        const d = e.debrisId !== undefined ? sim.debris.find((x) => x.id === e.debrisId) : null;
        this.particles.explode(e.pos, vel, e.size ?? 4, atmoDensity(body, alt) > 0.001);
        if (e.debrisId !== undefined) {
          const g = this.debrisViews.get(e.debrisId);
          if (g) g.visible = false;
        }
        if (!d && e.debrisId === undefined) {
          this.vesselView.group.visible = false;
          this.vesselHidden = true;
        }
        this.shake = Math.max(this.shake, 1.2);
      }
    }
  }

  // ---------------------------------------------------------------- 输入

  orbitCamera(dx: number, dy: number): void {
    if (this.mode === 'map') {
      this.mapYaw -= dx * 0.005;
      this.mapPitch = Math.max(-1.5, Math.min(1.5, this.mapPitch + dy * 0.005));
    } else {
      this.camYaw -= dx * 0.005;
      this.camPitch = Math.max(-1.45, Math.min(1.45, this.camPitch + dy * 0.005));
    }
  }

  zoom(delta: number): void {
    const f = Math.exp(delta * 0.0012);
    if (this.mode === 'map') this.mapDist = Math.max(this.mapMinDist(), Math.min(4e8, this.mapDist * f));
    else {
      const b = this.sim.vessel.bounds();
      const size = Math.max(b.maxY - b.minY, b.radius * 2);
      this.camDist = Math.max(size * 0.6, Math.min(20_000, this.camDist * f));
    }
  }

  private mapFocusBody(): 'earth' | 'moon' | 'vessel' {
    if (this.mapFocus !== 'auto') return this.mapFocus;
    return this.sim.telemetry.body.id;
  }

  private mapMinDist(): number {
    const f = this.mapFocusBody();
    if (f === 'earth') return EARTH.radius * 1.3;
    if (f === 'moon') return MOON.radius * 1.4;
    return 200;
  }

  cycleMapFocus(): void {
    const order: ('earth' | 'moon' | 'vessel')[] = ['earth', 'moon', 'vessel'];
    const cur = this.mapFocusBody();
    this.mapFocus = order[(order.indexOf(cur) + 1) % 3];
    this.mapDist = this.mapFocus === 'earth' ? EARTH.radius * 5 : this.mapFocus === 'moon' ? MOON.radius * 6 : 50_000;
  }

  setMode(m: 'flight' | 'map'): void {
    this.mode = m;
    this.map.setVisible(m === 'map');
    if (m === 'map') {
      this.mapFocus = 'auto';
      const tel = this.sim.telemetry;
      const r = tel.alt + tel.body.radius;
      this.mapDist = Math.max(this.mapMinDist(), Math.min(4e8, r * 3.2));
      if (tel.body.id === 'earth' && tel.orbit.ap > MOON_ORBIT_A * 0.3) this.mapDist = 1.1e8;
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(dtReal: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    const t = sim.t;
    this.time += dtReal;
    // 粒子与模拟使用同一时间步长（低帧率时模拟会限制步长，否则烟雾会跑到火箭前面）
    const fxDt = Math.min(sim.lastSimDt, 0.25);

    // 浮动原点
    const earthPos = new THREE.Vector3();
    const moonPos = bodyPosition(MOON, t, new THREE.Vector3());
    if (this.mode === 'map') {
      const f = this.mapFocusBody();
      this.origin.copy(f === 'earth' ? earthPos : f === 'moon' ? moonPos : V.r);
    } else {
      this.origin.copy(V.r);
    }
    const origin = this.origin;

    // 天体
    const eRot = bodyRotation(EARTH, t);
    const mRot = bodyRotation(MOON, t);
    this.planets.earth.position.copy(earthPos).sub(origin);
    this.planets.earth.rotation.set(0, eRot, 0);
    this.planets.clouds.position.copy(this.planets.earth.position);
    this.planets.clouds.rotation.set(0, eRot, 0);
    this.planets.moon.position.copy(moonPos).sub(origin);
    this.planets.moon.rotation.set(0, mRot, 0);
    const rotE = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(eRot));
    const rotM = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(mRot));
    this.planets.earthMat.uniforms.uModelRot.value = rotE;
    this.planets.cloudMat.uniforms.uModelRot.value = rotE;
    this.planets.moonMat.uniforms.uModelRot.value = rotM;
    const cloudOff = (t * 2e-6) % 1;
    this.planets.earthMat.uniforms.uCloudOffset.value = cloudOff;
    this.planets.cloudMat.uniforms.uCloudOffset.value = cloudOff;

    // 地形补丁
    const body = tel.body;
    if (this.mode === 'flight') {
      const shipBf = toBodyFixed(body, t, V.r);
      this.patch.update(body, t, shipBf, Math.max(0, tel.radarAlt), origin);
    } else {
      this.patch.mesh.visible = false;
      this.patch.active = false;
    }
    const pdir = new THREE.Vector3();
    if (this.patch.active && this.patch.body) {
      pdir.copy(this.patch.centerDir).applyAxisAngle(UP, bodyRotation(this.patch.body, t));
      const c = Math.cos(this.patch.angularRadius * 0.97);
      const isE = this.patch.body.id === 'earth';
      this.planets.earthMat.uniforms.uPatchDir.value.copy(pdir);
      this.planets.earthMat.uniforms.uPatchCos.value = isE ? c : 2;
      this.planets.moonMat.uniforms.uPatchDir.value.copy(pdir);
      this.planets.moonMat.uniforms.uPatchCos.value = isE ? 2 : c;
    } else {
      this.planets.earthMat.uniforms.uPatchCos.value = 2;
      this.planets.moonMat.uniforms.uPatchCos.value = 2;
    }
    if (this.pad) {
      this.pad.update(t, origin);
      const padDist = this.pad.group.position.length();
      this.pad.group.visible = padDist < 400_000 && this.mode === 'flight';
    }

    // 飞船
    const vOrigin = V.r.clone().sub(V.com.clone().applyQuaternion(V.q));
    this.vesselView.group.position.copy(vOrigin).sub(origin);
    this.vesselView.group.quaternion.copy(V.q);
    this.vesselView.group.visible = !this.vesselHidden && !sim.destroyed;
    this.vesselView.group.updateMatrixWorld(true);
    this.vesselView.setLegs(V.legDeploy);
    const vAir = V.v.clone().sub(surfaceVelocity(body, t, V.r, new THREE.Vector3()));
    this.vesselView.setChute(V.chuteState, V.chuteDeploy, sim.landed ? null : vAir, V.q);
    if (sim.landed) {
      for (const pv of this.vesselView.parts.values()) if (pv.visual.canopy) pv.visual.canopy.visible = false;
    }
    for (const d of sim.debris) {
      const g = this.debrisViews.get(d.id);
      if (!g) continue;
      const o = d.r.clone().sub(d.com.clone().applyQuaternion(d.q));
      g.position.copy(o).sub(origin);
      g.quaternion.copy(d.q);
    }
    this.sepFx.update(fxDt, this.time, origin);

    // 尾焰、灯光、烟
    const pAlt = tel.alt;
    const pRatio = body.atmosphere ? Math.exp(-pAlt / body.atmosphere.scaleHeight) * (pAlt < body.atmosphere.height ? 1 : 0) : 0;
    let totalThrust = 0;
    const lightPos = new THREE.Vector3();
    let lightW = 0;
    const tmp = new THREE.Vector3();
    const cmd = sim.controlCmd;
    for (const [key, pv] of this.vesselView.parts) {
      const rp = V.byKey.get(key);
      if (!rp) continue;
      const eng = rp.p.def.engine;
      const thr = rp.thrustNow > 0 ? rp.throttleEff : 0;
      // 尾翼方向舵随控制指令偏转（最大 20°）
      if (pv.visual.flaps.length) {
        const off = pv.placed.radial ? pv.placed.angle : 0;
        const k = Math.min(1, dtReal * 12);
        for (const f of pv.visual.flaps) {
          const a = f.angle + off;
          const target = 0.35 * Math.max(-1, Math.min(1, -(cmd.x * Math.cos(a) + cmd.z * Math.sin(a)) - 0.5 * cmd.y));
          f.rot.rotation.x += (target - f.rot.rotation.x) * k;
        }
      }
      // 点火瞬间的闪光
      if (thr > 0 && !this.firing.has(key)) this.ignitionFlash(pv, rp.thrustNow, V.v, body);
      if (thr > 0) this.firing.add(key);
      else this.firing.delete(key);
      for (let i = 0; i < pv.plumes.length; i++) {
        pv.plumes[i].update(thr, pRatio, this.time + i * 1.7);
        const bell = pv.visual.bells[i];
        if (eng && eng.gimbal > 0) {
          const g = (eng.gimbal * Math.PI) / 180;
          bell.pivot.rotation.set(-cmd.x * g * 0.8, 0, cmd.z * g * 0.8);
        }
        if (thr > 0) {
          bell.pivot.getWorldPosition(tmp);
          lightPos.addScaledVector(tmp, rp.thrustNow);
          lightW += rp.thrustNow;
        }
      }
      totalThrust += rp.thrustNow;
      if (thr > 0 && eng) this.emitExhaust(key, rp.thrustNow, eng.plume, pv, fxDt, body);
    }
    if (lightW > 0) {
      lightPos.divideScalar(lightW);
      const down = UP.clone().applyQuaternion(V.q).multiplyScalar(-4);
      this.engineLight.position.copy(lightPos).add(down);
      this.engineLight.intensity = 900 * Math.sqrt(totalThrust / 1e6) * (0.9 + 0.2 * Math.random());
    } else this.engineLight.intensity = 0;

    // 再入等离子体
    const heat = sim.telemetry.heatFlux;
    const gi = Math.max(0, Math.min(2.5, (heat - 25_000) / 120_000));
    this.glow.mesh.visible = gi > 0.01 && !sim.destroyed && this.mode === 'flight';
    if (this.glow.mesh.visible) {
      const b = V.bounds();
      const size = Math.max(b.maxY - b.minY, b.radius * 2);
      const vd = vAir.clone().normalize();
      const w = b.radius * 1.35 + 0.3;
      this.glow.mesh.position.copy(vd).multiplyScalar(size * 0.35);
      this.glow.mesh.quaternion.setFromUnitVectors(UP, vd);
      this.glow.mesh.scale.set(w, Math.max(w, size * 0.6), w);
      this.glow.set(gi * 1.6, this.time);
      if (Math.random() < gi * 0.8) {
        const p = V.r.clone().addScaledVector(vAir.clone().normalize(), -size * 0.3).add(new THREE.Vector3((Math.random() - 0.5) * size * 0.4, (Math.random() - 0.5) * size * 0.4, (Math.random() - 0.5) * size * 0.4));
        this.particles.emit({ pos: p, vel: V.v.clone().addScaledVector(vAir, -0.02), life: 0.8, size0: size * 0.4, size1: size * 0.1, color: new THREE.Color(6, 2.2, 0.8), alpha: 0.9, drag: 3, glow: true, cool: true });
      }
    }

    // 粒子
    const windBody = body;
    const windTmp = new THREE.Vector3();
    this.particles.update(
      fxDt,
      origin,
      (x, y, z, out) => {
        windTmp.set(x, y, z);
        surfaceVelocity(windBody, t, windTmp, out);
      },
      this.smokeLight,
    );

    this.updateLights(dtReal);
    this.updateCamera(dtReal);

    // 共享 uniform
    sharedUniforms.uSunDir.value.copy(SUN_DIR);
    sharedUniforms.uCamPos.value.copy(this.camera.position);
    sharedUniforms.uEarthCenter.value.copy(earthPos).sub(origin);
    sharedUniforms.uAtmoSamples.value = this.engine.quality === 'low' ? 6 : this.engine.quality === 'medium' ? 9 : 12;
    this.planets.sky.position.copy(this.camera.position);
    this.planets.stars.position.copy(this.camera.position);
    this.planets.starMat.uniforms.uPixelRatio.value = this.engine.renderer.getPixelRatio();
    // 星空可见度
    const camRel = this.camera.position.clone().sub(sharedUniforms.uEarthCenter.value);
    const camAltE = camRel.length() - EARTH.radius;
    const muSun = camRel.clone().normalize().dot(SUN_DIR);
    const day = THREE.MathUtils.smoothstep(muSun, -0.15, 0.05) * (1 - THREE.MathUtils.smoothstep(camAltE, 25_000, 75_000));
    this.planets.starMat.uniforms.uStarVis.value = 1 - day;
    // 云层淡出（相机穿越云层时）
    const dc = Math.abs(camAltE - Planets.CLOUD_ALT);
    this.planets.cloudMat.uniforms.uFade.value = THREE.MathUtils.smoothstep(dc, 300, 2500);
    this.planets.clouds.visible = true;

    // 地图
    this.map.update(sim.prediction, t, origin, V.r.clone().sub(origin), this.camera, this.engine.width, this.engine.height);
  }

  private smokeLight = new THREE.Color(1, 1, 1);

  private ignitionFlash(pv: { plumes: { group: THREE.Object3D; radius: number }[] }, thrust: number, vel: THREE.Vector3, body: typeof EARTH): void {
    const fwd = UP.clone().applyQuaternion(this.sim.vessel.q);
    const tel = this.sim.telemetry;
    const inAir = !!body.atmosphere && tel.density > 0.01;
    const p = new THREE.Vector3();
    for (const pl of pv.plumes) {
      pl.group.getWorldPosition(p);
      p.add(this.origin);
      const r = pl.radius;
      for (let i = 0; i < 14; i++) {
        const jitter = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(r * 14);
        this.particles.emit({ pos: p.clone(), vel: vel.clone().addScaledVector(fwd, -(10 + Math.random() * 30)).add(jitter), life: 0.25 + Math.random() * 0.3, size0: r * 1.6, size1: r * 4, color: new THREE.Color(10, 7, 3.5), alpha: 1, drag: inAir ? 2 : 0, glow: true, cool: true });
      }
    }
    this.shake = Math.max(this.shake, Math.min(0.4, 0.1 + thrust / 4e6));
  }

  private emitExhaust(key: string, thrust: number, kind: string, pv: { visual: { bells: { pivot: THREE.Object3D; radius: number }[] } }, dt: number, body: typeof EARTH): void {
    const sim = this.sim;
    const tel = sim.telemetry;
    if (!body.atmosphere || tel.density < 0.004 || kind === 'lander') return;
    const V = sim.vessel;
    const fwd = UP.clone().applyQuaternion(V.q);
    const rate = Math.min(60, 8 + Math.sqrt(thrust / 1000) * 1.5) * Math.min(1, tel.density / 0.2 + 0.25);
    let acc = (this.emitAcc.get(key) ?? 0) + rate * dt;
    const air = surfaceVelocity(body, sim.t, V.r, new THREE.Vector3());
    const col = kind === 'solid' ? new THREE.Color(0.92, 0.9, 0.88) : kind === 'hydrolox' ? new THREE.Color(0.95, 0.96, 1.0) : new THREE.Color(0.72, 0.68, 0.64);
    const alpha = kind === 'hydrolox' ? 0.25 : kind === 'solid' ? 0.7 : 0.45;
    const tmp = new THREE.Vector3();
    while (acc >= 1) {
      acc -= 1;
      const bell = pv.visual.bells[Math.floor(Math.random() * pv.visual.bells.length)];
      bell.pivot.getWorldPosition(tmp);
      const r = bell.radius;
      const pos = tmp.clone().add(this.origin).addScaledVector(fwd, -r * (4 + Math.random() * 10));
      const vel = air.clone().addScaledVector(fwd, -(20 + Math.random() * 30)).add(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
      const life = 10 + Math.random() * 14;
      this.particles.emit({ pos, vel, life, size0: r * 2.2, size1: r * (7 + Math.random() * 7), color: col, alpha, drag: 0.35 });
      // 发射台附近：地面烟云向四周扩散
      if (tel.radarAlt < 40 && Math.random() < 0.6) {
        const up = tel.up;
        const gp = V.r.clone().addScaledVector(up, -(tel.radarAlt + (V.com.y - V.bounds().minY)) + 2);
        const a = Math.random() * Math.PI * 2;
        const side = tel.north.clone().multiplyScalar(Math.cos(a)).addScaledVector(tel.east, Math.sin(a));
        const v2 = air.clone().addScaledVector(side, 25 + Math.random() * 35).addScaledVector(up, 2 + Math.random() * 6);
        this.particles.emit({ pos: gp.addScaledVector(side, r * 2), vel: v2, life: 10 + Math.random() * 8, size0: r * 3, size1: r * (10 + Math.random() * 10), color: col, alpha: alpha * 0.8, drag: 0.3 });
      }
    }
    this.emitAcc.set(key, acc);
  }

  private updateLights(dt: number): void {
    const sim = this.sim;
    const V = sim.vessel;
    const tel = sim.telemetry;
    // 太阳是否被天体遮挡
    let occl = 1;
    for (const b of [EARTH, MOON]) {
      const c = bodyPosition(b, sim.t, new THREE.Vector3());
      const rel = c.sub(V.r);
      const along = rel.dot(SUN_DIR);
      if (along <= 0) continue;
      const perp = Math.sqrt(Math.max(0, rel.lengthSq() - along * along));
      const soft = b.radius * 0.004 + 200;
      occl *= THREE.MathUtils.smoothstep(perp, b.radius - soft, b.radius + soft);
    }
    // 大气对太阳光的染色
    const alt = tel.body.id === 'earth' ? tel.alt : Math.max(0, V.r.length() - EARTH.radius);
    const upE = V.r.clone().normalize();
    const mu = upE.dot(SUN_DIR);
    const am = 1 / (Math.max(mu, 0) + 0.025 * Math.exp(-11 * Math.max(mu, -0.2)));
    const dens = Math.exp(-Math.max(0, alt) / 7000);
    const tr = [5.8e-6, 13.5e-6, 33.1e-6].map((b) => Math.exp(-(b * 7000 + 6e-6 * 1.1 * 1300) * Math.min(am, 40) * dens));
    const sunCol = new THREE.Color(tr[0], tr[1], tr[2]);
    this.sun.color.copy(sunCol);
    this.sun.intensity = SUN_INTENSITY * occl;
    // 阴影相机跟随飞船
    const b = V.bounds();
    const size = Math.max(25, (b.maxY - b.minY) * 1.2, b.radius * 4);
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    const ext = this.mode === 'flight' && tel.radarAlt < 300 ? size * 1.8 : size;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = size * 20 + 400;
    cam.updateProjectionMatrix();
    const focus = V.r.clone().sub(this.origin);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, size * 8 + 150);
    // 半球光：天空与地面反照
    const inAtmo = tel.body.id === 'earth' && tel.alt < 70_000;
    const dayF = THREE.MathUtils.smoothstep(mu, -0.1, 0.15);
    const airF = inAtmo ? 1 - THREE.MathUtils.smoothstep(tel.alt, 5_000, 60_000) : 0;
    const sky = new THREE.Color(0.35, 0.5, 0.85).multiplyScalar(0.55 * dayF * airF + 0.02);
    let ground: THREE.Color;
    if (tel.body.id === 'moon') ground = new THREE.Color(0.35, 0.35, 0.34).multiplyScalar(0.25 * occl);
    else {
      const r = V.r.length();
      const solid = 1 - Math.sqrt(Math.max(0, 1 - (EARTH.radius / r) ** 2));
      ground = new THREE.Color(0.25, 0.3, 0.38).multiplyScalar((0.15 + 0.4 * airF) * dayF * (0.3 + solid));
    }
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(ground);
    this.hemi.intensity = 1.0;
    this.hemi.position.copy(tel.up);
    this.smokeLight.setRGB(0.25 + 0.75 * dayF * tr[0], 0.25 + 0.75 * dayF * tr[1], 0.27 + 0.75 * dayF * tr[2]);

    // 环境贴图
    this.envTimer += dt;
    if (this.envTimer > 2.5) {
      this.envTimer = 0;
      this.envMat.uniforms.uSky.value.copy(sky).multiplyScalar(1.6).addScalar(0.01);
      this.envMat.uniforms.uGround.value.copy(ground).multiplyScalar(1.4).addScalar(0.005);
      this.envMat.uniforms.uSunDir.value.copy(SUN_DIR);
      this.envMat.uniforms.uSunCol.value.copy(sunCol).multiplyScalar(occl);
      this.envMat.uniforms.uUp.value.copy(tel.up);
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
  }

  private updateCamera(dt: number): void {
    const sim = this.sim;
    const tel = sim.telemetry;
    const cam = this.camera;
    if (this.mode === 'map') {
      const d = this.mapDist;
      const p = new THREE.Vector3(Math.cos(this.mapPitch) * Math.cos(this.mapYaw), Math.sin(this.mapPitch), Math.cos(this.mapPitch) * Math.sin(this.mapYaw)).multiplyScalar(d);
      cam.position.copy(p);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, 0);
      cam.near = Math.max(1, d * 0.001);
    } else {
      let up: THREE.Vector3;
      let a: THREE.Vector3;
      let b: THREE.Vector3;
      if (this.camMode === 'chase') {
        const q = sim.vessel.q;
        up = UP.clone().applyQuaternion(q);
        a = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        b = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      } else if (this.camMode === 'free') {
        up = new THREE.Vector3(0, 1, 0);
        a = new THREE.Vector3(1, 0, 0);
        b = new THREE.Vector3(0, 0, 1);
      } else {
        up = tel.up.clone();
        a = tel.north.clone();
        b = tel.east.clone();
      }
      const off = a
        .clone()
        .multiplyScalar(Math.cos(this.camPitch) * Math.cos(this.camYaw))
        .addScaledVector(b, Math.cos(this.camPitch) * Math.sin(this.camYaw))
        .addScaledVector(up, Math.sin(this.camPitch))
        .multiplyScalar(this.camDist);
      // 不让相机钻到地下
      const bodyC = bodyPosition(tel.body, sim.t, new THREE.Vector3()).sub(sim.vessel.r);
      const camFromC = off.clone().sub(bodyC);
      const minR = tel.body.radius + tel.terrainH + 1.5;
      if (camFromC.length() < minR && tel.radarAlt < this.camDist * 2) {
        camFromC.setLength(minR);
        off.copy(camFromC).add(bodyC);
      }
      cam.position.copy(off);
      if (this.shake > 0.001) {
        const s = this.shake * Math.min(1, this.camDist / 40) * 0.25;
        cam.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      }
      cam.up.copy(up);
      cam.lookAt(0, 0, 0);
      cam.near = 0.3;
      // 发动机工作时的轻微震动
      const thr = tel.thrust > 0 && tel.density > 0.05 ? Math.min(0.35, tel.thrust / 4e6) : 0;
      this.shake = Math.max(thr, this.shake * Math.exp(-dt * 3));
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  render(): void {
    this.engine.render(this.scene, this.camera);
  }

  dispose(): void {
    this.patch.dispose();
    this.vesselView.dispose();
    this.particles.clear();
    if (this.envRT) this.envRT.dispose();
    this.pmrem.dispose();
    this.map.setVisible(false);
  }
}

const MOON_ORBIT_A = 38_440_000;
