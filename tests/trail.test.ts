import { describe, expect, it } from 'vitest';
import { FlightSim } from '../src/game/flight';
import { trailGap } from '../src/game/trail';
import { templateDesign } from '../src/rocket/design';

describe('flight trail', () => {
  it('trailGap breaks the line only when neighbouring points are far apart', () => {
    const at = (deg: number): [number, number, number] => [Math.cos((deg * Math.PI) / 180) * 7e5, 0, Math.sin((deg * Math.PI) / 180) * 7e5];
    expect(trailGap(...at(0), ...at(0.3))).toBe(false);
    expect(trailGap(...at(0), ...at(9))).toBe(false);
    expect(trailGap(...at(0), ...at(11))).toBe(true);
    expect(trailGap(...at(0), ...at(170))).toBe(true);
    // 纯径向（垂直起飞、径向逃逸）不算断开
    expect(trailGap(7e5, 0, 0, 9e6, 0, 0)).toBe(false);
  });

  it('after a long time warp in orbit, no drawn trail chord cuts through the planet', () => {
    const sim = new FlightSim(templateDesign('lunar'), 'leo');
    sim.setWarp(9);
    for (let i = 0; i < 200; i++) {
      sim.update(1 / 30);
      sim.drainEvents();
    }
    // 绕了上百圈，早期航迹被反复抽稀
    expect(sim.t).toBeGreaterThan(5 * 86_400);
    let gaps = 0;
    let through = 0;
    for (const s of sim.trail.segments) {
      const p = s.pts;
      for (let i = 1; i < s.times.length; i++) {
        const k = i * 3;
        if (trailGap(p[k - 3], p[k - 2], p[k - 1], p[k], p[k + 1], p[k + 2])) {
          gaps++;
          continue;
        }
        const mid = Math.hypot((p[k - 3] + p[k]) / 2, (p[k - 2] + p[k + 1]) / 2, (p[k - 1] + p[k + 2]) / 2);
        if (mid < s.body.radius) through++;
      }
    }
    expect(gaps).toBeGreaterThan(0);
    expect(through).toBe(0);
  });
});
