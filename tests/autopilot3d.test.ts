import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FlightSim } from '../src/game/flight';
import { templateDesign } from '../src/rocket/design';
import { BODY_BY_ID, EARTH, MOON } from '../src/physics/bodies';
import { solveCorrection, solveTLI, solveTransfer } from '../src/game/maneuver';
import { hyperbolicVelocity } from '../src/game/guidance';
import { computeOrbit } from '../src/physics/orbit';
import { ComputerPilot } from '../src/game/demoPilot';

const deg = Math.PI / 180;

function run(sim: FlightSim, seconds: number, until?: () => boolean): void {
  for (let i = 0; i < seconds * 30; i++) {
    sim.update(1 / 30);
    sim.drainEvents();
    if (until?.() || sim.destroyed) return;
  }
}

/** 发射前把航向轴转到 hdg（度），自动入轨进入倾斜 / 极地停泊轨道。 */
function parkingOrbit(hdg: number): { sim: FlightSim; p: ComputerPilot } {
  const sim = new FlightSim(templateDesign('lunar'));
  const p = new ComputerPilot(sim);
  sim.setRudderHeading(hdg * deg);
  p.ascent();
  return { sim, p };
}

describe('escape guidance (v-infinity targeting)', () => {
  it('reproduces the velocity on a hyperbola from the position and the excess velocity vector', () => {
    const mu = EARTH.mu;
    const rp = EARTH.radius + 100_000;
    // 倾斜的逃逸双曲线（近地点处速度沿 +Z 偏 +Y）
    const r0 = new Vector3(rp, 0, 0);
    const v0 = new Vector3(0, 1600, -4600);
    const o = computeOrbit(r0, v0, EARTH);
    const e = o.e;
    const s = Math.sqrt(e * e - 1);
    const pHat = o.eVec.clone().divideScalar(e);
    const hHat = o.h.clone().normalize();
    const qHat = new Vector3().crossVectors(hHat, pHat);
    const vInf = pHat.clone().multiplyScalar(-1).addScaledVector(qHat, s).multiplyScalar(Math.sqrt(2 * o.energy) / e);
    // 双曲线上近地点之前 30° 与之后 50° 的两个点
    const p = o.h.lengthSq() / mu;
    for (const nu of [-30 * deg, 0, 50 * deg]) {
      const R = p / (1 + e * Math.cos(nu));
      const rHat = pHat.clone().multiplyScalar(Math.cos(nu)).addScaledVector(qHat, Math.sin(nu));
      const tHat = new Vector3().crossVectors(hHat, rHat);
      const h = o.h.length();
      const vTrue = rHat.clone().multiplyScalar((mu / h) * e * Math.sin(nu)).addScaledVector(tHat, h / R);
      const v = hyperbolicVelocity(rHat.clone().multiplyScalar(R), vInf, mu, hHat)!;
      expect(v.distanceTo(vTrue)).toBeLessThan(1e-6 * vTrue.length());
    }
  });
});

describe('flight assistant with the rudder heading axis', () => {
  it('does not leave the rudder holding the pad attitude after the ascent autopilot', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    sim.setRudderHeading(0);
    expect(sim.sasMode).toBe('rudder');
    sim.autopilot.engage('ascent');
    // 方向舵是手动操纵：飞行辅助接管后改为“保持”，入轨后不会自己转成竖直朝上
    expect(sim.sasMode).toBe('stability');
  });

  it('changing the heading during the ascent autopilot only changes the ascent direction', () => {
    const sim = new FlightSim(templateDesign('lunar'));
    sim.autopilot.engage('ascent');
    run(sim, 40);
    expect(sim.autopilot.mode).toBe('ascent');
    sim.nudgeRudderHeading(-10 * deg);
    expect(sim.autopilot.mode).toBe('ascent');
    expect(sim.rudderHeading / deg).toBeCloseTo(80, 6);
  });
});

describe('maneuver planning from inclined parking orbits', () => {
  it('a small lunar mid-course correction after a polar trans-lunar injection', () => {
    const { sim, p } = parkingOrbit(180);
    p.plan(solveTLI(p.state()), '奔月转移');
    p.execNode('奔月转移入射');
    // 与电脑演示一样，滑行约 5.5 小时后做中途修正
    const tc = sim.t + 20_000;
    p.coast(8, () => sim.t > tc);
    const c = solveCorrection(p.state(), 'moon', 40_000, 60);
    // 以前沿坐标轴的模式搜索在这里要花 18.6 m/s
    const dv = c.node ? c.node.dv.length() : 0;
    expect(dv).toBeLessThan(3);
    if (c.node) {
      sim.addNode(c.node);
      sim.refreshPrediction();
      expect(Math.abs((sim.prediction!.moonMinDist - MOON.radius) / 1000 - 40)).toBeLessThan(3);
    }
  }, 120_000);

  it('the replan near the window keeps the same window and the escape burn hits Jupiter', () => {
    const { sim, p } = parkingOrbit(135);
    const JUP = BODY_BY_ID.jupiter;
    sim.targetBody = JUP.id;
    const plan = solveTransfer(p.state(), JUP);
    expect(plan.node).not.toBeNull();
    expect(plan.replanAt).not.toBeNull();
    const t0 = plan.node!.t;
    p.plan(plan, '前往木星', { at: plan.replanAt, target: plan.target });
    // 加速到窗口前：临近窗口时自动精确计算（以前会跳到 120 多天后的下一个窗口，永远等不到点火）
    p.warpTo(t0 - 120);
    p.run(5, () => sim.nodes[0]?.replanAt == null);
    const n = sim.nodes[0];
    expect(n.replanAt ?? null).toBeNull();
    expect(Math.abs(n.t - t0)).toBeLessThan(4 * 86_400);
    // 大角度转向的逃逸点火（法向 Δv 两千多 m/s）按 v∞ 制导：到木星的偏差从上百万公里降到几千公里以内
    p.execNode('木星转移入射');
    const md = sim.prediction!.minDist.jupiter!;
    expect(md.dist - JUP.radius).toBeLessThan(20_000_000);
  }, 120_000);
});
