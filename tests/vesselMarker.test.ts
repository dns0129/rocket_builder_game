import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { vesselMarkerSvg } from '../src/render/vesselMarker';

/** 解析出各个多边形的顶点（SVG 坐标，y 向下）与填充色 */
function polygons(svg: string): { pts: number[][]; fill: string }[] {
  return [...svg.matchAll(/<polygon points="([^"]+)" fill="(#[0-9a-f]{6})"/g)].map((m) => ({
    pts: m[1].split(' ').map((p) => p.split(',').map(Number)),
    fill: m[2],
  }));
}

describe('vessel marker (3D pyramid drawn as SVG)', () => {
  const camera = new PerspectiveCamera(40, 1, 0.1, 1e9);
  camera.updateMatrixWorld();
  const pos = new Vector3(0, 0, -1000);

  it('points the apex along the nose', () => {
    // 机头（箭体 +Y）朝上：尖端在屏幕上方（SVG 的 y 为负）
    const up = polygons(vesselMarkerSvg(new Quaternion(), pos, camera));
    const minY = Math.min(...up.flatMap((p) => p.pts.map((q) => q[1])));
    expect(minY).toBeLessThan(-10);
    // 机头转向屏幕右方
    const right = polygons(vesselMarkerSvg(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2), pos, camera));
    const maxX = Math.max(...right.flatMap((p) => p.pts.map((q) => q[0])));
    expect(maxX).toBeGreaterThan(10);
  });

  it('draws only the faces turned toward the camera, so roll and nose-on views differ', () => {
    // 侧面看（机头朝上）：能看到 1~2 个侧面，看不到底面
    const side = polygons(vesselMarkerSvg(new Quaternion(), pos, camera));
    expect(side.length).toBeGreaterThanOrEqual(1);
    expect(side.length).toBeLessThanOrEqual(2);
    // 机头正对相机：三个侧面都看得见；尾部正对相机：只看得见底面
    const noseOn = polygons(vesselMarkerSvg(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2), pos, camera));
    expect(noseOn.length).toBe(3);
    const tailOn = polygons(vesselMarkerSvg(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2), pos, camera));
    expect(tailOn.length).toBe(1);
    // 滚转半圈：看到的侧面换成另外的颜色
    const rolled = polygons(vesselMarkerSvg(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI), pos, camera));
    expect(rolled.map((p) => p.fill).sort()).not.toEqual(side.map((p) => p.fill).sort());
  });

  it('is empty when the vessel is behind the camera', () => {
    expect(vesselMarkerSvg(new Quaternion(), new Vector3(0, 0, 100), camera)).toBe('');
  });
});
