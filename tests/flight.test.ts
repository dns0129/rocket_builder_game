import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FlightSim } from '../src/game/flight';
import { templateDesign } from '../src/rocket/design';
import { EARTH, MOON } from '../src/physics/bodies';
import { computeOrbit } from '../src/physics/orbit';
import { solveCapture, solveTLI, solveReturn, solveCorrection } from '../src/game/maneuver';
import type { FlightSim as FS } from '../src/game/flight';

function execCorrection(sim: FS, target: 'moon' | 'earth', alt: number) {
  const c = solveCorrection({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t }, target, alt, 60);
  log(c.msg);
  if (!c.node) return;
  sim.addNode(c.node);
  sim.autopilot.engage('node');
  run(sim, 600, 1 / 30, () => sim.autopilot.mode === 'off');
  sim.refreshPrediction();
}

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

describe('orbital mechanics', () => {
  it('circular orbit elements', () => {
    const r = new Vector3(EARTH.radius + 100_000, 0, 0);
    const vc = Math.sqrt(EARTH.mu / r.x);
    const v = new Vector3(0, 0, -vc);
    const o = computeOrbit(r, v, EARTH);
    expect(o.e).toBeLessThan(1e-6);
    expect(Math.abs(o.peAlt - 100_000)).toBeLessThan(1);
    expect(o.inc).toBeLessThan(1e-6);
  });

  it('rocket sits on the pad without drifting', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    run(sim, 5);
    expect(sim.destroyed).toBe(false);
    expect(sim.landed).toBe(true);
    expect(Math.abs(sim.telemetry.radarAlt)).toBeLessThan(0.5);
  });
});

describe('ascent', () => {
  for (const id of ['orbiter', 'lunar']) {
    it(`${id} reaches orbit with the ascent autopilot`, () => {
      const sim = new FlightSim(templateDesign(id));
      sim.autopilot.engage('ascent');
      let maxQ = 0;
      const t0 = performance.now();
      run(sim, 900, 1 / 30, () => {
        maxQ = Math.max(maxQ, sim.telemetry.dynPressure);
        return sim.autopilot.mode === 'off';
      });
      const tel = sim.telemetry;
      log(
        id,
        `destroyed=${sim.destroyed} ${sim.destroyReason} ap=${(tel.orbit.apAlt / 1000).toFixed(1)}km pe=${(tel.orbit.peAlt / 1000).toFixed(1)}km`,
        `stage=${sim.vessel.stageIndex} stageDv=${tel.stageDv.toFixed(0)} maxQ=${(maxQ / 1000).toFixed(1)}kPa maxG=${sim.maxG.toFixed(1)} t=${sim.t.toFixed(0)} cpu=${(performance.now() - t0).toFixed(0)}ms`,
      );
      expect(sim.destroyed).toBe(false);
      expect(tel.orbit.peAlt).toBeGreaterThan(70_000);
    });
  }
});

describe('full lunar mission', () => {
  it('flies to the moon, lands, and returns', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    sim.autopilot.engage('ascent');
    run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
    expect(sim.telemetry.orbit.peAlt).toBeGreaterThan(70_000);
    const dvAfterOrbit = sim.telemetry.stageDv;
    log('in orbit, stage', sim.vessel.stageIndex, 'stage dv', dvAfterOrbit.toFixed(0));

    // 奔月
    const t0 = performance.now();
    const tli = solveTLI({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    log(tli.msg, `solve ${(performance.now() - t0).toFixed(0)}ms`);
    expect(tli.node).not.toBeNull();
    sim.addNode(tli.node!);
    sim.warpToTime(tli.node!.t - 60);
    run(sim, 4000, 1 / 30, () => sim.autoWarpTo === null);
    sim.autopilot.engage('node');
    run(sim, 600, 1 / 30, () => sim.autopilot.mode === 'off');
    log('TLI exec:', sim.destroyed, sim.destroyReason, sim.landed, sim.telemetry.alt, sim.autopilot.mode, sim.t);
    sim.refreshPrediction();
    log('after TLI: moonMin', ((sim.prediction!.moonMinDist - MOON.radius) / 1000).toFixed(0), 'km', 'stage', sim.vessel.stageIndex);
    // 中途修正
    sim.setWarp(8);
    run(sim, 100, 1 / 30);
    sim.warpIndex = 0;
    execCorrection(sim, 'moon', 40_000);
    log('after MCC: moonMin', ((sim.prediction!.moonMinDist - MOON.radius) / 1000).toFixed(1), 'km');

    // 滑行至月球影响球
    sim.setWarp(9);
    run(sim, 3000, 1 / 30, () => sim.telemetry.body.id === 'moon');
    expect(sim.telemetry.body.id).toBe('moon');
    log('in moon SOI: pe alt', (sim.telemetry.orbit.peAlt / 1000).toFixed(1), 'km');
    sim.warpIndex = 0;

    // 捕获
    const cap = solveCapture({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    log(cap.msg);
    expect(cap.node).not.toBeNull();
    sim.addNode(cap.node!);
    sim.warpToTime(cap.node!.t - 90);
    run(sim, 4000, 1 / 30, () => sim.autoWarpTo === null);
    sim.autopilot.engage('node');
    run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
    const o = sim.telemetry.orbit;
    log('lunar orbit: ap', (o.apAlt / 1000).toFixed(1), 'pe', (o.peAlt / 1000).toFixed(1), 'stage', sim.vessel.stageIndex, 'dv', sim.telemetry.stageDv.toFixed(0));
    expect(o.hyperbolic).toBe(false);

    // 着陆（先把转移级丢掉：如果还剩下，就分离）
    while (sim.vessel.parts.some((p) => p.p.def.id === 'eng_s_hydro')) sim.stage();
    sim.autopilot.engage('land');
    const tl = performance.now();
    run(sim, 1500, 1 / 30, () => sim.landed || sim.autopilot.mode === 'off');
    run(sim, 3, 1 / 30);
    log('landing:', sim.landed, sim.destroyed, sim.destroyReason, 'dv left', sim.telemetry.stageDv.toFixed(0), `cpu ${(performance.now() - tl).toFixed(0)}ms`);
    expect(sim.destroyed).toBe(false);
    expect(sim.landed).toBe(true);
    expect(sim.missions.done.has('moonLand')).toBe(true);

    // 起飞回到环月轨道
    sim.autopilot.ascentAlt = 20_000;
    sim.autopilot.engage('ascent');
    run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
    log('moon ascent: pe', (sim.telemetry.orbit.peAlt / 1000).toFixed(1), 'dv left', sim.telemetry.stageDv.toFixed(0), sim.destroyReason);
    expect(sim.telemetry.orbit.peAlt).toBeGreaterThan(5_000);

    // 返回地球
    const tr = performance.now();
    const ret = solveReturn({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    log(ret.msg, `solve ${(performance.now() - tr).toFixed(0)}ms`);
    expect(ret.node).not.toBeNull();
    sim.addNode(ret.node!);
    sim.warpToTime(ret.node!.t - 60);
    run(sim, 4000, 1 / 30, () => sim.autoWarpTo === null);
    sim.autopilot.engage('node');
    run(sim, 600, 1 / 30, () => sim.autopilot.mode === 'off');
    sim.refreshPrediction();
    log('return: earth pe', sim.prediction?.earthPeAfterMoon, 'dv left', sim.telemetry.stageDv.toFixed(0));
    sim.setWarp(8);
    run(sim, 100, 1 / 30, () => sim.telemetry.body.id === 'earth');
    sim.warpIndex = 0;
    execCorrection(sim, 'earth', 35_000);
    log('after return MCC: earth pe', sim.prediction?.earthPeAfterMoon);

    // 滑行回地球，分离着陆级，逆行再入
    sim.setWarp(9);
    run(sim, 5000, 1 / 30, () => sim.telemetry.body.id === 'earth' && sim.telemetry.alt < 200_000);
    sim.warpIndex = 0;
    while (sim.vessel.stageIndex < sim.vessel.stages.length) sim.stage();
    sim.setSas('retrograde');
    run(sim, 2500, 1 / 30, () => sim.landed || sim.destroyed);
    log('reentry:', sim.landed, sim.destroyed, sim.destroyReason, 'maxG', sim.maxG.toFixed(1), 'missions', [...sim.missions.done]);
    expect(sim.destroyed).toBe(false);
    expect(sim.missions.done.has('return')).toBe(true);
  }, 240_000);
});
