import { describe, expect, it } from 'vitest';
import { layoutDesign, TEMPLATES } from '../src/rocket/design';
import { analyzeDesign } from '../src/rocket/analysis';

describe('rocket templates', () => {
  for (const t of TEMPLATES) {
    it(`${t.design.name} is valid`, () => {
      const layout = layoutDesign(t.design);
      const stats = analyzeDesign(layout);
      // eslint-disable-next-line no-console
      console.log(
        t.design.name,
        `mass=${(stats.mass / 1000).toFixed(1)}t h=${stats.height.toFixed(1)}m dv=${stats.totalDv.toFixed(0)}`,
        stats.stages.map((s) => `[${s.label} dv=${s.dv.toFixed(0)} twr=${s.twrSL.toFixed(2)} moon=${s.twrMoon.toFixed(2)} t=${s.burnTime.toFixed(0)}s]`).join(' '),
        stats.warnings,
      );
      expect(stats.errors).toEqual([]);
      if (t.id !== 'lander') expect(stats.stages[0].twrSL).toBeGreaterThan(1.2);
    });
  }

  it('lunar template has enough delta-v for a full mission', () => {
    const stats = analyzeDesign(layoutDesign(TEMPLATES.find((t) => t.id === 'lunar')!.design));
    expect(stats.totalDv).toBeGreaterThan(6300);
  });
});
