import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FlightSim } from '../src/game/flight';
import { templateDesign } from '../src/rocket/design';
import { BODIES, EARTH, MARS, MOON, SUN, bodyPosition, dirFromLatLon, dominantBody, gravityAccel, helioPosition } from '../src/physics/bodies';
import { computeOrbit } from '../src/physics/orbit';
import { lambert, solveCaptureAt, solvePlanetCorrection, solveTransfer } from '../src/game/maneuver';
import { TERRAIN, rockyHeight, terrainHeight } from '../src/physics/terrain';
import { bodyChain, encounterAnchor, placeSegments } from '../src/render/trajectoryView';
import type { Prediction } from '../src/game/predictor';

function run(sim: FlightSim, seconds: number, dt = 1 / 30, until?: () => boolean): void {
  const n = Math.ceil(seconds / dt);
  for (let i = 0; i < n; i++) {
    sim.update(dt);
    sim.drainEvents();
    if (until && until()) return;
    if (sim.destroyed) return;
  }
}

function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(...a);
}

describe('solar system', () => {
  it('has the planets in order with nested spheres of influence', () => {
    const helioA = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn'].map((id) => helioPosition(BODIES.find((b) => b.id === id)!, 0).length());
    for (let i = 1; i < helioA.length; i++) expect(helioA[i]).toBeGreaterThan(helioA[i - 1]);
    expect(EARTH.soi).toBeGreaterThan(38_440_000 + MOON.soi);
    // 地球附近仍由地球主导，远处由太阳主导，火星附近由火星主导
    expect(dominantBody(new Vector3(EARTH.radius + 100_000, 0, 0), 0)).toBe(EARTH);
    expect(dominantBody(new Vector3(0, 2e9, 0), 0)).toBe(SUN);
    const mp = bodyPosition(MARS, 0);
    expect(dominantBody(mp.clone().add(new Vector3(MARS.radius * 3, 0, 0)), 0)).toBe(MARS);
    // 太阳引力在近地轨道几乎被间接项抵消（潮汐力很小）
    const r = new Vector3(EARTH.radius + 100_000, 0, 0);
    const g = gravityAccel(r, 0);
    expect(Math.abs(g.length() - EARTH.mu / r.lengthSq())).toBeLessThan(1e-4);
  });

  it('solves Lambert problems consistently with two-body motion', () => {
    const mu = SUN.mu;
    const r1 = new Vector3(1.5e10, 0, 0);
    const r2 = new Vector3(0, 0, -2.2e10);
    const L = lambert(r1, r2, 6e6, mu)!;
    expect(L).not.toBeNull();
    const o1 = computeOrbit(r1, L.v1, SUN);
    const o2 = computeOrbit(r2, L.v2, SUN);
    expect(Math.abs(o1.a - o2.a) / o1.a).toBeLessThan(1e-6);
    expect(L.v1.clone().cross(r1).y).toBeLessThan(0); // 顺行（角动量 +Y）
  });

  it('has terrain on Mars, Mercury and Venus but no surface on gas giants', () => {
    const d = new Vector3(0.3, 0.5, 0.8).normalize();
    for (const id of ['mars', 'mercury', 'venus']) {
      const b = BODIES.find((x) => x.id === id)!;
      const h = terrainHeight(b, d);
      expect(Math.abs(h)).toBeLessThan(b.maxTerrain);
    }
    expect(terrainHeight(BODIES.find((x) => x.id === 'jupiter')!, d)).toBe(0);
  });

  it('has the Tharsis volcanoes and Valles Marineris on Mars', () => {
    const DEG = Math.PI / 180;
    const T = TERRAIN.mars!;
    const bare = { ...T, volcanoes: [], canyons: [] };
    // 特征本身的高度贡献（去掉丘陵、撞击坑等背景起伏）
    const feature = (lat: number, lon: number) => {
      const d = dirFromLatLon(lat * DEG, lon * DEG);
      return rockyHeight(T, MARS.radius, d.x, d.y, d.z) - rockyHeight(bare, MARS.radius, d.x, d.y, d.z);
    };
    for (const [lat, lon] of [[18.65, -133.8], [-8.26, -120.09], [1.48, -112.96], [11.92, -104.08]]) expect(feature(lat + 0.4, lon)).toBeGreaterThan(900);
    // 峡谷中段：沿两端点之间的大圆取中点
    const a = dirFromLatLon(-7 * DEG, -96 * DEG);
    const b = dirFromLatLon(-12 * DEG, -42 * DEG);
    const m = a.clone().add(b).normalize();
    const lat = Math.asin(m.y) / DEG;
    const lon = Math.atan2(-m.z, m.x) / DEG;
    expect(feature(lat, lon)).toBeLessThan(-500);
    expect(Math.abs(feature(lat + 6, lon))).toBeLessThan(1);
  });

  it('flies from low Earth orbit to Mars orbit', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'leo');
    const t0 = performance.now();
    const plan = solveTransfer({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t }, MARS);
    log(plan.msg, `solve ${(performance.now() - t0).toFixed(0)}ms`, 'replanAt', plan.replanAt);
    expect(plan.node).not.toBeNull();
    sim.addNode(plan.node!, plan.replanAt != null ? { at: plan.replanAt, target: 'mars' } : null);
    sim.warpToTime(plan.node!.t - 120);
    run(sim, 3000, 1 / 30, () => sim.autoWarpTo === null);
    const n = sim.nodes[0];
    log('arrived at node, replan pending', n?.replanAt, 't to node', n ? (n.t - sim.t).toFixed(0) : '-');
    sim.warpToTime(sim.nodes[0].t - 60);
    run(sim, 3000, 1 / 30, () => sim.autoWarpTo === null);
    sim.autopilot.engage('node');
    run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
    sim.refreshPrediction();
    const md = sim.prediction!.minDist.mars;
    log('after ejection: mars closest', md ? ((md.dist - MARS.radius) / 1000).toFixed(0) : '-', 'km in', md ? ((md.t - sim.t) / 86400).toFixed(1) : '-', 'days; stage dv', sim.telemetry.stageDv.toFixed(0));
    expect(sim.destroyed).toBe(false);
    expect(md && md.dist).toBeLessThan(MARS.soi);
    // 巡航几天后做一次中途修正
    const tc = sim.t + 5 * 86_400;
    for (let i = 0; i < 4000 && sim.t < tc; i++) {
      sim.setWarp(10);
      sim.update(1 / 30);
      sim.drainEvents();
    }
    sim.warpIndex = 0;
    const mcc = solvePlanetCorrection({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t }, MARS);
    log(mcc.msg);
    if (mcc.node) {
      sim.addNode(mcc.node);
      sim.autopilot.engage('node');
      run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
      sim.refreshPrediction();
    }
    const md2 = sim.prediction!.minDist.mars!;
    log('after MCC: mars closest', ((md2.dist - MARS.radius) / 1000).toFixed(0), 'km');
    // 抵达前几天再修正一次（离得越近，执行误差的影响越小）
    const tc2 = md2.t - 4 * 86_400;
    for (let i = 0; i < 4000 && sim.t < tc2; i++) {
      sim.setWarp(10);
      sim.update(1 / 30);
      sim.drainEvents();
    }
    sim.warpIndex = 0;
    const mcc2 = solvePlanetCorrection({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t }, MARS);
    log(mcc2.msg);
    if (mcc2.node) {
      sim.addNode(mcc2.node);
      sim.autopilot.engage('node');
      run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
      sim.refreshPrediction();
    }
    // 巡航到火星影响球
    for (let i = 0; i < 4000 && sim.telemetry.body.id !== 'mars'; i++) {
      sim.setWarp(10);
      sim.update(1 / 30);
      sim.drainEvents();
    }
    log('body', sim.telemetry.body.id, 'pe alt', (sim.telemetry.orbit.peAlt / 1000).toFixed(0), 'km');
    expect(sim.telemetry.body.id).toBe('mars');
    sim.warpIndex = 0;
    const cap = solveCaptureAt({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t }, MARS);
    log(cap.msg);
    expect(cap.node).not.toBeNull();
    sim.addNode(cap.node!);
    sim.warpToTime(cap.node!.t - 90);
    run(sim, 4000, 1 / 30, () => sim.autoWarpTo === null);
    sim.autopilot.engage('node');
    run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
    const o = sim.telemetry.orbit;
    log('mars orbit: ap', (o.apAlt / 1000).toFixed(0), 'pe', (o.peAlt / 1000).toFixed(0), 'dv left', sim.telemetry.stageDv.toFixed(0), 'stage', sim.vessel.stageIndex);
    expect(sim.telemetry.body.id).toBe('mars');
    expect(o.hyperbolic).toBe(false);
    expect(o.peAlt).toBeGreaterThan(MARS.atmosphere!.height);
    expect(o.peAlt).toBeLessThan(1_000_000);
    expect(sim.missions.done.has('marsSoi')).toBe(true);
  }, 240_000);
});

describe('map placement of multi-body trajectories', () => {
  const seg = (body: typeof EARTH, t0: number, t1: number) => ({ body, pts: [0, 0, 0, 1, 0, 0], times: [t0, t1], afterNode: false });
  const pred = (segments: ReturnType<typeof seg>[]) => ({ segments, events: [], nodeState: null, moonClosest: null, moonMinDist: Infinity, minDist: {}, earthPeAfterMoon: null, impact: null, endT: 0 }) as unknown as Prediction;

  it('anchors a future planet encounter where the planet will be, relative to the Sun', () => {
    const p = pred([seg(EARTH, 0, 100), seg(SUN, 100, 5e6), seg(MARS, 5e6, 5.1e6)]);
    const pl = placeSegments(p);
    expect(pl[0]).toMatchObject({ host: 'earth', anchor: null });
    expect(pl[1]).toMatchObject({ host: 'sun', anchor: null });
    expect(pl[2].host).toBe('sun');
    expect(pl[2].anchor).toBe(5e6);
    expect(pl[2].off.distanceTo(helioPosition(MARS, 5e6))).toBeLessThan(1);
    expect(encounterAnchor(p, p.segments[2])).toBe(5e6);
    expect(encounterAnchor(p, p.segments[1])).toBeNull();
  });

  it('chains nested encounters (back to Earth, then the Moon)', () => {
    const p = pred([seg(SUN, 0, 100), seg(EARTH, 100, 200), seg(MOON, 200, 300)]);
    const pl = placeSegments(p);
    expect(pl[1].host).toBe('sun');
    expect(pl[1].off.distanceTo(helioPosition(EARTH, 100))).toBeLessThan(1);
    expect(pl[2].host).toBe('sun');
    // 月球 = 进入地球影响球时地球的日心位置 + 进入月球影响球时月球相对地球的位置
    const want = helioPosition(EARTH, 100).add(bodyPosition(MOON, 200));
    expect(pl[2].off.distanceTo(want)).toBeLessThan(1);
  });

  it('follows bodies the vessel is already in', () => {
    const p = pred([seg(MOON, 0, 100), seg(EARTH, 100, 200)]);
    const pl = placeSegments(p);
    expect(pl.map((x) => x.host)).toEqual(['moon', 'earth']);
    expect(pl.every((x) => x.anchor === null)).toBe(true);
    expect([...bodyChain(MOON)]).toEqual(['moon', 'earth', 'sun']);
  });
});
