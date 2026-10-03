import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FlightSim, WARP_LEVELS, wrapAngle } from '../src/game/flight';
import { templateDesign } from '../src/rocket/design';
import { EARTH, MOON, MOON_ORBIT, dominantBody } from '../src/physics/bodies';
import { burnLead, burnTime, lambert, solveReturn, solveTLI } from '../src/game/maneuver';
import { makeBurnTarget, velocityToGain } from '../src/game/guidance';
import { nodeDvWorld, predict, predictSteps, type NodeSpec } from '../src/game/predictor';
import { adaptiveStep, rk4Step } from '../src/physics/integrate';

function run(sim: FlightSim, seconds: number, dt = 1 / 30, until?: () => boolean): void {
  const n = Math.ceil(seconds / dt);
  for (let i = 0; i < n; i++) {
    sim.update(dt);
    sim.drainEvents();
    if (until && until()) return;
    if (sim.destroyed) return;
  }
}

/** 高精度数值外推（只有引力） */
function propagate(r: Vector3, v: Vector3, t: number, t1: number) {
  r = r.clone();
  v = v.clone();
  while (Math.abs(t1 - t) > 1e-9) {
    const h = Math.sign(t1 - t) * Math.min(Math.abs(t1 - t), adaptiveStep(r, t, 0.004));
    rk4Step(r, v, t, h);
    t += h;
  }
  return { r, v };
}

/** 瞬时执行节点后的“真实”轨迹（精细积分） */
function idealAfter(s: { r: Vector3; v: Vector3; t: number }, n: NodeSpec, maxTime: number) {
  const a = propagate(s.r, s.v, s.t, n.t);
  const dv = nodeDvWorld(a.r, a.v, n.t, n.dv, dominantBody(a.r, n.t));
  return predict(a.r, a.v.clone().add(dv), n.t, [], { maxSteps: 100_000, eta: 0.004, maxTime });
}

describe('lambert solver', () => {
  it('solves retrograde and fast hyperbolic arcs when given the orbit normal', () => {
    const mu = EARTH.mu;
    // 逆行（角动量沿 -Y）的圆轨道上转过 90°
    const R = EARTH.radius + 100_000;
    const vc = Math.sqrt(mu / R);
    const n = Math.sqrt(mu / (R * R * R));
    const r1 = new Vector3(R, 0, 0);
    const r2 = new Vector3(0, 0, R); // 逆行：从 +X 转向 +Z
    const L = lambert(r1, r2, Math.PI / 2 / n, mu, new Vector3(0, -1, 0))!;
    expect(L).not.toBeNull();
    expect(Math.abs(L.v1.length() - vc)).toBeLessThan(1e-3 * vc);
    expect(L.v1.clone().cross(r1).y).toBeGreaterThan(0); // r × v 沿 -Y
    // 很快的双曲线弧（逃逸点火之后）
    const v0 = new Vector3(0, 0, -1.6 * vc);
    const s = predict(r1, v0, 0, [], { maxSteps: 100, eta: 0.01, maxTime: 400 });
    const seg = s.segments[0];
    const k = seg.times.length - 1;
    const rEnd = new Vector3(seg.pts[k * 3], seg.pts[k * 3 + 1], seg.pts[k * 3 + 2]);
    const H = lambert(r1, rEnd, seg.times[k], mu, new Vector3(0, 1, 0))!;
    expect(H).not.toBeNull();
    // 只有地球附近的引力与月球/太阳摄动的差别
    expect(H.v1.distanceTo(v0)).toBeLessThan(0.5);
  });

  it('guidance asks for exactly the planned Δv at the node', () => {
    const r = new Vector3(EARTH.radius + 100_000, 0, 0);
    const v = new Vector3(0, 0, -Math.sqrt(EARTH.mu / r.x));
    const dv = new Vector3(0.1, 0.02, -1).normalize().multiplyScalar(-900); // 主要沿顺行（-Z）
    const tgt = makeBurnTarget(r, v, 0, dv, EARTH)!;
    expect(tgt).not.toBeNull();
    const vg = velocityToGain(tgt, r, v, 0)!;
    expect(vg.distanceTo(dv)).toBeLessThan(1e-3);
  });

  it('starts the burn so that the Δv centroid falls on the node', () => {
    const thrust = 110_000;
    const mdot = thrust / (455 * 9.80665);
    const bt = burnTime(900, 14_000, thrust, mdot);
    const lead = burnLead(900, 14_000, thrust, mdot);
    // 越烧越轻：Δv 的重心比燃烧时间的一半晚
    expect(lead).toBeGreaterThan(bt / 2);
    expect(lead).toBeLessThan(bt * 0.56);
    expect(burnLead(0.001, 14_000, thrust, mdot)).toBeCloseTo(burnTime(0.001, 14_000, thrust, mdot) / 2, 6);
  });
});

describe('maneuver execution', () => {
  for (const warp of [0, 3]) {
    it(`executes trans-lunar injection precisely at physics warp ×${WARP_LEVELS[warp]}`, () => {
      const sim = new FlightSim(templateDesign('lunar'), 'leo');
      const s = { r: sim.vessel.r.clone(), v: sim.vessel.v.clone(), t: sim.t };
      const tli = solveTLI(s);
      expect(tli.node).not.toBeNull();
      const planned = idealAfter(s, tli.node!, 4e5).moonMinDist - MOON.radius;
      sim.addNode(tli.node!);
      sim.autopilot.engage('node');
      let warped = false;
      run(sim, 3000, 1 / 30, () => {
        if (!warped && sim.vessel.throttle > 0) {
          sim.warpIndex = warp;
          warped = true;
        }
        return sim.autopilot.mode === 'off';
      });
      expect(sim.nodes.length).toBe(0);
      const p = predict(sim.vessel.r, sim.vessel.v, sim.t, [], { maxSteps: 100_000, eta: 0.004, maxTime: 4e5 });
      const actual = p.moonMinDist - MOON.radius;
      // 奔月时 0.1 m/s 的误差就让近月点偏差上百公里；以前 ×1 时撞月、×4 时偏到 850 km
      expect(Math.abs(actual - planned)).toBeLessThan(15_000);
    });
  }

  it('never warps past the burn while the autopilot waits for it', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'leo');
    const tli = solveTLI({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    // 把节点推到几圈之后
    const node = { t: tli.node!.t + 4 * 2000, dv: tli.node!.dv };
    sim.addNode(node);
    sim.autopilot.engage('node');
    sim.autoWarpTo = null;
    let ignitedAt = NaN;
    run(sim, 3000, 1 / 30, () => {
      // 玩家一直按着“加速”
      if (sim.vessel.throttle <= 0) sim.setWarp(WARP_LEVELS.length - 1);
      else if (isNaN(ignitedAt)) ignitedAt = sim.t;
      return sim.autopilot.mode === 'off';
    });
    expect(sim.destroyed).toBe(false);
    expect(ignitedAt).toBeLessThan(node.t);
    // 点火时离节点的时间应接近燃烧时间的一半（而不是因为时间加速跳过了节点）
    expect(node.t - ignitedAt).toBeGreaterThan(5);
    expect(node.t - ignitedAt).toBeLessThan(60);
  });

  it('plans a cheap and accurate return even right after a window', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'llo');
    // 以前这个时刻会多花约 80 m/s
    const t1 = (5 * MOON_ORBIT.period) / 20;
    const a = propagate(sim.vessel.r, sim.vessel.v, 0, t1);
    const s = { r: a.r, v: a.v, t: t1 };
    const ret = solveReturn(s);
    expect(ret.node).not.toBeNull();
    expect(ret.node!.dv.length()).toBeLessThan(275);
    const p = idealAfter(s, ret.node!, 6e5);
    expect(p.earthPeAfterMoon).not.toBeNull();
    expect(Math.abs(p.earthPeAfterMoon!.alt - 35_000)).toBeLessThan(5_000);
  });
});

describe('trajectory prediction', () => {
  it('gives the same result when computed in slices', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'leo');
    const tli = solveTLI({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    const opts = { maxSteps: 4000, eta: 0.02, maxTime: 9e7 };
    const whole = predict(sim.vessel.r, sim.vessel.v, sim.t, [tli.node!], opts);
    const it = predictSteps(sim.vessel.r.clone(), sim.vessel.v.clone(), sim.t, [tli.node!], opts);
    let slices = 0;
    let res = it.next();
    while (!res.done) {
      slices++;
      res = it.next();
    }
    expect(slices).toBeGreaterThan(5);
    expect(res.value.endT).toBe(whole.endT);
    expect(res.value.moonMinDist).toBe(whole.moonMinDist);
  });

  it('refreshes continuously in live mode and drops results computed for an old node', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'leo');
    sim.livePrediction = true;
    sim.refreshPrediction();
    const first = sim.prediction;
    // 每帧 0.2 ms 的预算：要分好几帧才能算完
    let frames = 0;
    sim.predictionAge = 999;
    while (sim.prediction === first && frames < 500) {
      sim.update(1 / 60);
      sim.pumpPrediction(0.2);
      frames++;
    }
    expect(sim.prediction).not.toBe(first);
    expect(frames).toBeGreaterThan(1);
    // 计算途中加了节点：旧的分片结果作废，新预测包含节点
    sim.predictionAge = 999;
    sim.update(1 / 60);
    sim.pumpPrediction(0.05);
    const tli = solveTLI({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    sim.addNode(tli.node!);
    for (let i = 0; i < 400; i++) {
      sim.update(1 / 60);
      sim.pumpPrediction(0.5);
    }
    expect(sim.prediction?.nodeState).not.toBeNull();
    expect(Math.abs(sim.prediction!.nodeState!.t - tli.node!.t)).toBeLessThan(1e-6);
  });

  it('predicts far-future nodes with the full multi-body coast, not a two-body jump', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'llo');
    // 把返回窗口推后 25 圈（约 17 小时）：期间地球潮汐会让开普勒外推差出几十公里
    const ret = solveReturn({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t });
    const node = { t: ret.node!.t + 25 * 2457.0, dv: ret.node!.dv };
    sim.addNode(node);
    const shown = sim.prediction!.earthPeAfterMoon;
    const truth = idealAfter({ r: sim.vessel.r, v: sim.vessel.v, t: sim.t }, node, 6e5).earthPeAfterMoon;
    expect(shown).not.toBeNull();
    expect(truth).not.toBeNull();
    expect(Math.abs(shown!.alt - truth!.alt)).toBeLessThan(3_000);
  });
});

describe('rudder', () => {
  it('turns all the way round', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'leo');
    const deg = Math.PI / 180;
    // 满载的登月火箭在真空中只靠姿控转动，转 225° 需要半分钟以上
    sim.setRudder(135 * deg);
    run(sim, 60);
    expect(Math.abs(wrapAngle(sim.tiltAngle() - 135 * deg)) / deg).toBeLessThan(2);
    // 越过 180°（竖直向下）继续转：设定值连续地绕到 -175°
    sim.setRudder(175 * deg);
    sim.nudgeRudder(10 * deg);
    expect(sim.rudderAngle / deg).toBeCloseTo(-175, 6);
    run(sim, 30);
    expect(Math.abs(wrapAngle(sim.tiltAngle() + 175 * deg)) / deg).toBeLessThan(2);
    expect(sim.rudderActive).toBe(true);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
  });
});
