import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FlightSim } from '../src/game/flight';
import { FlightTrail } from '../src/game/trail';
import { nextStep, suggestedTilt } from '../src/game/guide';
import { templateDesign } from '../src/rocket/design';
import { EARTH, surfaceVelocity } from '../src/physics/bodies';
import { PredictionHistory } from '../src/render/trajectoryView';
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

describe('flight trail', () => {
  it('records the flown path from liftoff, marking powered flight', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    run(sim, 3);
    expect(sim.trail.count).toBe(0); // 发射台上不记录
    sim.autopilot.engage('ascent');
    run(sim, 60);
    const seg = sim.trail.last!;
    expect(seg.body.id).toBe('earth');
    expect(sim.trail.count).toBeGreaterThan(50);
    expect(seg.powered.some((p) => p === 1)).toBe(true);
    // 最后一个点离飞船很近，整条航迹从地面升到当前高度
    const n = seg.times.length - 1;
    const last = new Vector3(seg.pts[n * 3], seg.pts[n * 3 + 1], seg.pts[n * 3 + 2]);
    expect(last.distanceTo(sim.vessel.r)).toBeLessThan(2_000);
    const first = new Vector3(seg.pts[0], seg.pts[1], seg.pts[2]);
    expect(first.length() - EARTH.radius).toBeLessThan(100);
    expect(last.length() - EARTH.radius).toBeGreaterThan(10_000);
  });

  it('thins old points but keeps the newest ones when it grows too long', () => {
    const tr = new FlightTrail();
    const r = new Vector3();
    for (let i = 0; i < FlightTrail.MAX_POINTS * 2; i++) {
      const a = i * 0.01;
      r.set(Math.cos(a) * (EARTH.radius + 200_000), 0, Math.sin(a) * (EARTH.radius + 200_000));
      tr.record(EARTH, r, i * 10, i % 500 < 250);
    }
    expect(tr.count).toBeLessThanOrEqual(FlightTrail.MAX_POINTS);
    const seg = tr.last!;
    expect(seg.times[seg.times.length - 1]).toBe((FlightTrail.MAX_POINTS * 2 - 1) * 10);
    expect(seg.times.length).toBe(tr.count);
  });
});

describe('easier flying', () => {
  it('stages automatically when the burning stage runs dry', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    sim.stage(); // 点火
    sim.setRudder((10 * Math.PI) / 180);
    const first = sim.vessel.stageIndex;
    run(sim, 400, 1 / 30, () => sim.vessel.stageIndex > first);
    expect(sim.destroyed).toBe(false);
    expect(sim.vessel.stageIndex).toBeGreaterThan(first);
  });

  it('does not stage on its own while sitting on the pad', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    sim.vessel.throttle = 0;
    run(sim, 3);
    expect(sim.vessel.stageIndex).toBe(0);
  });

  it('arms the parachute when falling through the atmosphere', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    const V = sim.vessel;
    const up = V.r.clone().normalize();
    V.r.copy(up).multiplyScalar(EARTH.radius + 9_000);
    V.v.copy(surfaceVelocity(EARTH, sim.t, V.r)).addScaledVector(up, -150);
    V.throttle = 0;
    sim.landed = false;
    sim.launched = true;
    run(sim, 0.5);
    expect(V.chuteState).not.toBe('stowed');
  });
});

describe('guide', () => {
  it('walks the player through launch and orbit', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    expect(nextStep(sim)?.text).toContain('空格');
    sim.autopilot.engage('ascent');
    run(sim, 900, 1 / 30, () => sim.autopilot.mode === 'off');
    expect(sim.telemetry.orbit.peAlt).toBeGreaterThan(70_000);
    expect(nextStep(sim)?.text).toContain('奔月');
  });

  it('suggests a gravity turn that ends nearly horizontal', () => {
    expect(suggestedTilt(500)).toBe(0);
    expect(suggestedTilt(10_000)).toBeGreaterThan(25);
    expect(suggestedTilt(10_000)).toBeLessThan(55);
    expect(suggestedTilt(60_000)).toBeCloseTo(88, 5);
  });
});

describe('prediction history', () => {
  it('returns the trajectory from about a second ago as the ghost', () => {
    const h = new PredictionHistory();
    const mk = () => ({ segments: [], events: [] }) as unknown as Prediction;
    const p0 = mk();
    const p1 = mk();
    const p2 = mk();
    h.update(p0, 0);
    expect(h.ghost()).toBeNull();
    h.update(p1, 0.5);
    expect(h.ghost()).toBe(p0);
    h.update(p2, 2.0);
    // p1 (0.5 s) 已经超过 1.2 s，p0 被丢弃
    expect(h.ghost()).toBe(p1);
    h.update(null, 2.5);
    expect(h.ghost()).toBeNull();
  });
});
