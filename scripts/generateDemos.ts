/**
 * 生成内置的三份电脑演示 demo（默认火箭“登月者 L-1”飞向月球、火星、木星的全航程模拟）。
 *
 *   npm run demos                 # 全部重新生成
 *   DEMOS=mars npm run demos      # 只生成其中一部分（逗号分隔：moon,mars,jupiter）
 *
 * 输出到 public/demos/*.json，游戏里“🎬 Demo 回放”直接读取。
 * 物理或自动驾驶改动之后重新生成即可；旧的 demo 记录的是当时的飞行状态，不会因代码改动而失效。
 */
import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeDemo } from '../src/game/demo';
import { flyDemo, type DemoTarget } from '../src/game/demoPilot';

const ALL: DemoTarget[] = ['moon', 'mars', 'jupiter'];
const pick = (process.env.DEMOS ?? '').split(',').filter(Boolean) as DemoTarget[];
const targets = pick.length ? pick : ALL;

for (const target of targets) {
  it(`generates the ${target} demo`, () => {
    const t0 = performance.now();
    const d = flyDemo(target, (...a) => console.log(...a));
    const json = JSON.stringify(encodeDemo(d));
    mkdirSync('public/demos', { recursive: true });
    writeFileSync(`public/demos/${target}.json`, json);
    console.log(
      `${target}: ${d.meta.outcome} (${d.meta.outcomeText}), ${d.meta.frames} frames, ${d.events.length} events,`,
      `${(json.length / 1024).toFixed(0)} KB, sim ${(d.meta.duration / 86400).toFixed(1)} days, cpu ${((performance.now() - t0) / 1000).toFixed(0)} s`,
      'missions', d.meta.missions.join(','),
    );
  }, 1_800_000);
}
