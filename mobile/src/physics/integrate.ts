import { Vector3 } from 'three';
import { EARTH, MOON, gravityAccel, moonPosition } from './bodies';

const _k1v = new Vector3();
const _k2v = new Vector3();
const _k3v = new Vector3();
const _k4v = new Vector3();
const _k1r = new Vector3();
const _k2r = new Vector3();
const _k3r = new Vector3();
const _k4r = new Vector3();
const _tr = new Vector3();
const _mp = new Vector3();

/** 只受引力的四阶龙格-库塔积分，原地更新 r, v。 */
export function rk4Step(r: Vector3, v: Vector3, t: number, h: number): void {
  // k1
  _k1r.copy(v);
  gravityAccel(r, t, _k1v);
  // k2
  _tr.copy(r).addScaledVector(_k1r, h / 2);
  _k2r.copy(v).addScaledVector(_k1v, h / 2);
  gravityAccel(_tr, t + h / 2, _k2v);
  // k3
  _tr.copy(r).addScaledVector(_k2r, h / 2);
  _k3r.copy(v).addScaledVector(_k2v, h / 2);
  gravityAccel(_tr, t + h / 2, _k3v);
  // k4
  _tr.copy(r).addScaledVector(_k3r, h);
  _k4r.copy(v).addScaledVector(_k3v, h);
  gravityAccel(_tr, t + h, _k4v);

  r.addScaledVector(_k1r, h / 6).addScaledVector(_k2r, h / 3).addScaledVector(_k3r, h / 3).addScaledVector(_k4r, h / 6);
  v.addScaledVector(_k1v, h / 6).addScaledVector(_k2v, h / 3).addScaledVector(_k3v, h / 3).addScaledVector(_k4v, h / 6);
}

/** 自适应步长：取各天体的动力学时间尺度 sqrt(r³/μ) 的 eta 倍。 */
export function adaptiveStep(r: Vector3, t: number, eta: number): number {
  const rE = r.length();
  const tE = Math.sqrt((rE * rE * rE) / EARTH.mu);
  moonPosition(t, _mp);
  const rM = r.distanceTo(_mp);
  const tM = Math.sqrt((rM * rM * rM) / MOON.mu);
  return eta * Math.min(tE, tM);
}
