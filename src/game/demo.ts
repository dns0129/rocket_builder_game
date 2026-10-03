import type { BodyId } from '../physics/bodies';
import type { RocketDesign } from '../rocket/design';
import type { Scenario } from './flight';

/**
 * Demo（飞行回放）的数据格式。
 *
 * 关键帧按“结构数组”存放在定型数组里，便于直接存进 IndexedDB（结构化克隆）；
 * 导出 / 内置的 demo 文件把这些数组编码成 base64 写进 JSON。
 *
 * 每个关键帧：
 * - pos：箭体几何原点（不是质心，分级时质心会跳变而几何不动）。自由飞行时为惯性系坐标，
 *   着陆时为天体固连坐标（随天体自转）。
 * - q：自由飞行时为惯性系姿态，着陆时为天体固连姿态。
 * - info[2i]：标志位（FRAME_*），info[2i+1]：主导天体序号 << 4 | 时间加速档位。
 */
export const DEMO_VERSION = 1;

export const FRAME_LANDED = 1;
export const FRAME_WATER = 2;
export const FRAME_DEAD = 4;
export const FRAME_THRUST = 8;

export type DemoOutcome = 'crashed' | 'victory' | 'landed' | 'orbit' | 'flying';

export interface DemoMeta {
  id: string;
  name: string;
  /** 保存时间（毫秒时间戳） */
  createdAt: number;
  /** 内置的电脑演示：'moon' | 'mars' | 'jupiter' */
  builtin?: string;
  designName: string;
  scenario: Scenario;
  /** 回放覆盖的模拟时间 s */
  duration: number;
  /** 结束时的任务时间 s */
  metEnd: number;
  outcome: DemoOutcome;
  outcomeText: string;
  /** 最高海拔（相对地球）m */
  maxAlt: number;
  /** 依次到访过的主导天体 */
  bodies: BodyId[];
  missions: string[];
  frames: number;
  bytes: number;
}

/** 关键帧（结构数组）。 */
export interface DemoFrames {
  t: Float64Array;
  /** 记录时累计的真实时间 s（回放 1× 时按它控制节奏，与当时的时间加速一致） */
  real: Float64Array;
  pos: Float64Array; // 3n
  vel: Float32Array; // 3n
  q: Float32Array; // 4n
  thr: Float32Array;
  heat: Float32Array;
  temp: Float32Array;
  info: Uint8Array; // 2n
  cmd: Int8Array; // 3n
}

/**
 * 离散事件。k：
 * - ev：当时弹出的提示 / 音效事件（type, msg, level, size, pos, id）
 * - stage：分级（i = 分级后的级序号）
 * - legs / chute / sas / ap / node / burn / target / met / flame / dead / spd / inf：状态变化
 * - cap：电脑演示的解说字幕
 */
export interface DemoEvent {
  t: number;
  k: string;
  [key: string]: unknown;
}

export interface DemoData {
  v: number;
  meta: DemoMeta;
  design: RocketDesign;
  /** 开始记录时已经激活到第几级（非发射台场景会预先点燃第一级） */
  stage0: number;
  /** 有燃料的零件 key（燃料快照按此顺序存放） */
  fuelKeys: string[];
  frames: DemoFrames;
  fuel: { t: Float64Array; f: Float32Array };
  events: DemoEvent[];
}

export function frameCount(d: DemoData): number {
  return d.frames.t.length;
}

export function demoBytes(d: DemoData): number {
  const F = d.frames;
  let n = 0;
  for (const a of [F.t, F.real, F.pos, F.vel, F.q, F.thr, F.heat, F.temp, F.info, F.cmd, d.fuel.t, d.fuel.f]) n += a.byteLength;
  return n + JSON.stringify(d.events).length;
}

// ------------------------------------------------------------------ 序列化（导出 / 内置文件）

type Typed = Float64Array | Float32Array | Uint8Array | Int8Array;

function toB64(a: Typed): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

const F64 = (s: string) => new Float64Array(fromB64(s).buffer);
const F32 = (s: string) => new Float32Array(fromB64(s).buffer);
const I8 = (s: string) => new Int8Array(fromB64(s).buffer);

/** DemoData → 可 JSON 化的对象（定型数组编码为 base64，小端字节序）。 */
export function encodeDemo(d: DemoData): Record<string, unknown> {
  const F = d.frames;
  return {
    format: 'rocket-game-demo',
    v: d.v,
    meta: d.meta,
    design: d.design,
    stage0: d.stage0,
    fuelKeys: d.fuelKeys,
    frames: {
      t: toB64(F.t),
      real: toB64(F.real),
      pos: toB64(F.pos),
      vel: toB64(F.vel),
      q: toB64(F.q),
      thr: toB64(F.thr),
      heat: toB64(F.heat),
      temp: toB64(F.temp),
      info: toB64(F.info),
      cmd: toB64(F.cmd),
    },
    fuel: { t: toB64(d.fuel.t), f: toB64(d.fuel.f) },
    events: d.events,
  };
}

export function decodeDemo(o: unknown): DemoData {
  const x = o as Record<string, any>;
  if (!x || x.format !== 'rocket-game-demo' || typeof x.v !== 'number') throw new Error('不是有效的 demo 文件');
  if (x.v > DEMO_VERSION) throw new Error('demo 文件版本过新，请更新游戏');
  const f = x.frames;
  const d: DemoData = {
    v: x.v,
    meta: x.meta,
    design: x.design,
    stage0: x.stage0 ?? 0,
    fuelKeys: x.fuelKeys ?? [],
    frames: {
      t: F64(f.t),
      real: F64(f.real),
      pos: F64(f.pos),
      vel: F32(f.vel),
      q: F32(f.q),
      thr: F32(f.thr),
      heat: F32(f.heat),
      temp: F32(f.temp),
      info: fromB64(f.info),
      cmd: I8(f.cmd),
    },
    fuel: { t: F64(x.fuel.t), f: F32(x.fuel.f) },
    events: x.events ?? [],
  };
  const n = d.frames.t.length;
  if (!n || d.frames.real.length !== n || d.frames.pos.length !== 3 * n || d.frames.q.length !== 4 * n || d.frames.info.length !== 2 * n) throw new Error('demo 文件已损坏');
  return d;
}

export const OUTCOME_LABEL: Record<DemoOutcome, string> = {
  crashed: '坠毁',
  victory: '任务完成',
  landed: '着陆',
  orbit: '在轨',
  flying: '飞行中',
};
