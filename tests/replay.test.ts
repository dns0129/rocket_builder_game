import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FlightSim } from '../src/game/flight';
import { FlightRecorder } from '../src/game/recorder';
import { DemoTrack, ReplayPlayer, keplerUniversal, newTrackState } from '../src/game/replay';
import { decodeDemo, encodeDemo, type DemoData } from '../src/game/demo';
import { templateDesign } from '../src/rocket/design';
import { EARTH, MOON } from '../src/physics/bodies';
import { keplerPropagate } from '../src/physics/orbit';
import moonDemo from '../public/demos/moon.json';
import marsDemo from '../public/demos/mars.json';
import jupiterDemo from '../public/demos/jupiter.json';

function log(...a: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(...a);
}

describe('universal Kepler propagation', () => {
  it('matches the elliptical propagator forwards and backwards', () => {
    const r0 = new Vector3(EARTH.radius + 200_000, 0, 0);
    const v0 = new Vector3(0, 300, -2600);
    for (const dt of [10, 1000, 5000, -3000]) {
      const a = r0.clone();
      const b = v0.clone();
      keplerPropagate(a, b, EARTH.mu, dt);
      const r = new Vector3();
      const v = new Vector3();
      expect(keplerUniversal(r0, v0, EARTH.mu, dt, r, v)).toBe(true);
      expect(r.distanceTo(a)).toBeLessThan(0.5);
      expect(v.distanceTo(b)).toBeLessThan(1e-3);
    }
  });

  it('handles hyperbolic trajectories', () => {
    const r0 = new Vector3(MOON.radius + 50_000, 0, 0);
    const v0 = new Vector3(0, 0, -2200); // 远超月球逃逸速度
    const r = new Vector3();
    const v = new Vector3();
    expect(keplerUniversal(r0, v0, MOON.mu, 4000, r, v)).toBe(true);
    // 数值积分对照（只受月球引力）
    const rn = r0.clone();
    const vn = v0.clone();
    const h = 0.5;
    for (let t = 0; t < 4000; t += h) {
      const acc = (p: Vector3) => p.clone().multiplyScalar(-MOON.mu / p.lengthSq() ** 1.5);
      const k1v = acc(rn);
      const k1r = vn.clone();
      const k2v = acc(rn.clone().addScaledVector(k1r, h / 2));
      const k2r = vn.clone().addScaledVector(k1v, h / 2);
      const k3v = acc(rn.clone().addScaledVector(k2r, h / 2));
      const k3r = vn.clone().addScaledVector(k2v, h / 2);
      const k4v = acc(rn.clone().addScaledVector(k3r, h));
      const k4r = vn.clone().addScaledVector(k3v, h);
      rn.addScaledVector(k1r.add(k2r.multiplyScalar(2)).add(k3r.multiplyScalar(2)).add(k4r), h / 6);
      vn.addScaledVector(k1v.add(k2v.multiplyScalar(2)).add(k3v.multiplyScalar(2)).add(k4v), h / 6);
    }
    expect(r.distanceTo(rn)).toBeLessThan(5);
    expect(v.distanceTo(vn)).toBeLessThan(0.01);
  });
});

describe('flight recorder and replay', () => {
  it('reproduces an ascent and orbital coast from sparse keyframes', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    const rec = new FlightRecorder(sim);
    sim.recorder = rec;
    const truth: { t: number; r: Vector3; landed: boolean }[] = [];
    const step = (n: number, until?: () => boolean) => {
      for (let i = 0; i < n; i++) {
        sim.update(1 / 30);
        sim.drainEvents();
        truth.push({ t: sim.t, r: sim.vessel.r.clone().sub(sim.vessel.com.clone().applyQuaternion(sim.vessel.q)), landed: sim.landed });
        if (until?.()) return;
      }
    };
    step(60);
    sim.autopilot.engage('ascent');
    step(40_000, () => sim.autopilot.mode === 'off');
    expect(sim.telemetry.orbit.peAlt).toBeGreaterThan(70_000);
    // 高倍时间加速滑行几圈
    sim.setWarp(8);
    step(1500);
    sim.setWarp(0);
    step(300);
    const data = rec.finish('test');
    log('frames', data.meta.frames, 'events', data.events.length, 'fuel snaps', data.fuel.t.length, 'bytes', data.meta.bytes, 'truth', truth.length, 'span', data.meta.duration.toFixed(0));
    expect(data.meta.frames).toBeLessThan(truth.length / 3);
    const track = new DemoTrack(data);
    const st = newTrackState();
    let worst = 0;
    let worstT = 0;
    const errs: { t: number; err: number; alt: number }[] = [];
    for (const p of truth) {
      track.stateAt(p.t, st);
      // 比较箭体几何原点
      const r = st.origin;
      const alt = r.length() - EARTH.radius;
      const err = r.distanceTo(p.r);
      const rel = err / Math.max(50, Math.min(alt, 1e5));
      if (err > worst) {
        worst = err;
        worstT = p.t;
      }
      errs.push({ t: p.t, err: rel, alt });
    }
    errs.sort((a, b) => b.err - a.err);
    log('worst relative errors', errs.slice(0, 5).map((e) => `t=${e.t.toFixed(1)} rel=${e.err.toFixed(4)} alt=${e.alt.toFixed(0)}`).join(' | '));
    expect(errs[0].err).toBeLessThan(0.02);
    log('worst position error', worst.toFixed(1), 'm at t', worstT.toFixed(1));
    expect(worst).toBeLessThan(2000);

    // 序列化往返
    const back = decodeDemo(JSON.parse(JSON.stringify(encodeDemo(data))));
    expect(back.frames.t.length).toBe(data.frames.t.length);
    expect(back.frames.pos[5]).toBe(data.frames.pos[5]);
    expect(back.events.length).toBe(data.events.length);

    // 回放驱动：从头播到尾，分级与任务都能重现
    const player = new ReplayPlayer(back);
    const rsim = ReplayPlayer.createSim(back);
    player.attach(rsim);
    player.speed = 50;
    let guard = 0;
    while (!player.ended && guard++ < 100_000) {
      player.advance(1 / 30);
      rsim.drainEvents();
    }
    expect(player.ended).toBe(true);
    expect(rsim.vessel.stageIndex).toBe(sim.vessel.stageIndex);
    expect(rsim.vessel.parts.length).toBe(sim.vessel.parts.length);
    expect(rsim.missions.done.has('orbit')).toBe(true);
    expect(rsim.vessel.r.distanceTo(sim.vessel.r)).toBeLessThan(5);
    expect(rsim.trail.count).toBeGreaterThan(50);
    // 倒退：重置后跳到中途
    const mid = (player.t0 + player.t1) / 2;
    expect(player.seek(mid)).toBe(false);
    player.resetSim();
    expect(player.seek(mid)).toBe(true);
    expect(Math.abs(player.t - mid)).toBeLessThan(1e-6);
  }, 120_000);
});

describe('built-in computer demos', () => {
  const files: Record<string, unknown> = { moon: moonDemo, mars: marsDemo, jupiter: jupiterDemo };
  const load = (id: string): DemoData => decodeDemo(files[id]);
  const cases: { id: string; outcome: string; missions: string[]; body: string }[] = [
    { id: 'moon', outcome: 'victory', missions: ['orbit', 'moonSoi', 'moonLand', 'moonLiftoff', 'return'], body: 'earth' },
    { id: 'mars', outcome: 'landed', missions: ['orbit', 'marsSoi', 'marsLand'], body: 'mars' },
    { id: 'jupiter', outcome: 'orbit', missions: ['orbit', 'jupiterSoi'], body: 'jupiter' },
  ];
  for (const c of cases) {
    it(`${c.id}: flown by the computer with the default rocket and replays to the end`, () => {
      const d = load(c.id);
      expect(d.meta.builtin).toBe(c.id);
      expect(d.design.name).toBe(templateDesign('lunar').name);
      expect(d.meta.outcome).toBe(c.outcome);
      for (const m of c.missions) expect(d.meta.missions).toContain(m);
      // 有电脑解说
      expect(d.events.filter((e) => e.k === 'cap').length).toBeGreaterThan(8);
      const player = new ReplayPlayer(d);
      const sim = ReplayPlayer.createSim(d);
      player.attach(sim);
      player.speed = 100;
      let guard = 0;
      while (!player.ended && guard++ < 50_000) {
        player.advance(0.1);
        sim.drainEvents();
      }
      expect(player.ended).toBe(true);
      expect(sim.destroyed).toBe(false);
      expect(sim.telemetry.body.id).toBe(c.body);
      for (const m of c.missions) expect(sim.missions.done.has(m)).toBe(true);
      if (c.outcome !== 'orbit') expect(sim.landed).toBe(true);
      expect(player.log.length).toBeGreaterThan(10);
    });
  }
});
