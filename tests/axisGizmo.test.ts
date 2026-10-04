import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { projectGizmo, type GizmoAxis } from '../src/ui/axisGizmo';

const axes: GizmoAxis[] = [
  { dir: new Vector3(1, 0, 0), label: 'X', color: 'red' },
  { dir: new Vector3(0, 1, 0), label: 'Y', color: 'green' },
  { dir: new Vector3(0, 0, 1), label: 'Z', color: 'blue' },
];

describe('axis gizmo', () => {
  it('projects axes into screen space with the camera orientation', () => {
    // 相机朝向为单位四元数：+X 在屏幕右，+Y 在屏幕上，+Z 指向观察者
    const ends = projectGizmo(axes, new Quaternion(), 100, 30);
    const end = (axis: number, sign: 1 | -1) => ends.find((e) => e.axis === axis && e.sign === sign)!;
    expect(end(0, 1).x).toBeCloseTo(80, 9);
    expect(end(0, 1).y).toBeCloseTo(50, 9);
    expect(end(1, 1).y).toBeCloseTo(20, 9);
    expect(end(0, -1).x).toBeCloseTo(20, 9);
    expect(end(2, 1).depth).toBeCloseTo(1, 9);
    // 从远到近排序：最后一个是朝向观察者的 +Z
    expect(ends[ends.length - 1]).toBe(end(2, 1));
    expect(ends[0]).toBe(end(2, -1));
  });

  it('follows the camera when it turns', () => {
    // 相机绕竖直轴转 90°（从 +X 一侧看过去）：+X 指向观察者，+Z 到屏幕左边
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const ends = projectGizmo(axes, q, 100, 30);
    const end = (axis: number) => ends.find((e) => e.axis === axis && e.sign === 1)!;
    expect(end(0).depth).toBeCloseTo(1, 9);
    expect(end(2).x).toBeCloseTo(20, 9);
    expect(end(1).y).toBeCloseTo(20, 9);
  });
});
