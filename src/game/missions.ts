import type { Body } from '../physics/bodies';
import type { FlightSim } from './flight';

export interface MissionDef {
  id: string;
  title: string;
  desc: string;
}

export const MISSIONS: MissionDef[] = [
  { id: 'liftoff', title: '点火升空', desc: '离开发射台' },
  { id: 'space', title: '触摸太空', desc: '飞越 70 km 的大气层边界' },
  { id: 'orbit', title: '环绕地球', desc: '进入近地点高于 70 km 的地球轨道' },
  { id: 'moonSoi', title: '奔向月球', desc: '进入月球引力影响球' },
  { id: 'moonOrbit', title: '环月飞行', desc: '进入稳定的环月轨道' },
  { id: 'moonLand', title: '月面着陆', desc: '载人舱安全着陆在月球表面' },
  { id: 'moonLiftoff', title: '月面起飞', desc: '从月球表面重新起飞' },
  { id: 'return', title: '凯旋', desc: '登月后安全返回地球表面' },
];

/** 行星任务：抵达各行星的影响球，以及登陆火星。 */
export const PLANET_MISSIONS: MissionDef[] = [
  { id: 'mercurySoi', title: '水', desc: '抵达水星（进入影响球）' },
  { id: 'venusSoi', title: '金', desc: '抵达金星（进入影响球）' },
  { id: 'marsSoi', title: '火', desc: '抵达火星（进入影响球）' },
  { id: 'jupiterSoi', title: '木', desc: '抵达木星（进入影响球）' },
  { id: 'saturnSoi', title: '土', desc: '抵达土星（进入影响球）' },
  { id: 'marsLand', title: '登火', desc: '载人舱安全着陆在火星表面' },
  { id: 'marsReturn', title: '归', desc: '登陆火星后安全返回地球表面' },
];

const ALL_MISSIONS = [...MISSIONS, ...PLANET_MISSIONS];

const STORAGE_KEY = 'rocket-game-achievements';

export function loadAchievements(): Set<string> {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return new Set(s ? (JSON.parse(s) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveAchievements(s: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
  } catch {
    /* 存储不可用时忽略 */
  }
}

export class MissionTracker {
  done = new Set<string>();
  private sim: FlightSim;
  private moonLandedFlight = false;
  private marsLandedFlight = false;

  constructor(sim: FlightSim) {
    this.sim = sim;
  }

  complete(id: string): void {
    if (this.done.has(id)) return;
    this.done.add(id);
    const m = ALL_MISSIONS.find((x) => x.id === id);
    if (!m) return;
    const label = PLANET_MISSIONS.includes(m) ? m.desc : m.title;
    const all = loadAchievements();
    const first = !all.has(id);
    all.add(id);
    saveAchievements(all);
    this.sim.emit({ type: 'mission', msg: `任务达成：${label}${first ? '（首次！）' : ''}`, level: 'good', id });
  }

  update(): void {
    const sim = this.sim;
    if (sim.destroyed) return;
    const tel = sim.telemetry;
    if (sim.launched && sim.scenario === 'pad') this.complete('liftoff');
    if (tel.body.id === 'earth' && tel.alt > 70_000) this.complete('space');
    if (tel.body.id === 'earth' && !tel.orbit.hyperbolic && tel.orbit.peAlt > 70_000) this.complete('orbit');
    if (tel.body.id === 'moon') this.complete('moonSoi');
    if (tel.body.id === 'moon' && !tel.orbit.hyperbolic && tel.orbit.peAlt > 8_000 && tel.orbit.ap < tel.body.soi * 0.9) this.complete('moonOrbit');
    if (this.moonLandedFlight && tel.body.id === 'moon' && !sim.landed && tel.radarAlt > 500) this.complete('moonLiftoff');
    if (tel.body.id !== 'earth' && tel.body.id !== 'moon' && tel.body.id !== 'sun') this.complete(`${tel.body.id}Soi`);
  }

  onTouchdown(body: Body, upright: boolean): void {
    const sim = this.sim;
    if (body.id === 'mars' && upright && sim.vessel.hasPod()) {
      this.marsLandedFlight = true;
      this.complete('marsLand');
    }
    if (body.id === 'moon' && upright && sim.vessel.hasPod()) {
      this.moonLandedFlight = true;
      this.complete('moonLand');
    }
    if (body.id === 'earth' && this.marsLandedFlight && sim.vessel.crew > 0) {
      this.complete('marsReturn');
      sim.emit({ type: 'victory', msg: '恭喜！你完成了一次火星往返任务！', level: 'good' });
    } else if (body.id === 'earth' && this.moonLandedFlight && sim.vessel.crew > 0) {
      this.complete('return');
      sim.emit({ type: 'victory', msg: '恭喜！你完成了一次完整的登月往返任务！', level: 'good' });
    }
  }
}
