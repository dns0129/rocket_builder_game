import * as THREE from 'three';

/** 标记的大小：机头到尾部约这么多像素（侧面看时） */
const SIZE_PX = 20;
/** 三角锥的尺寸（单位长度 = 机头到尾部）：尖端在 +Y，底面三角形外接圆半径 */
const TIP = 0.6;
const BASE_Y = -0.4;
const BASE_R = 0.42;
/** 面着色用的“头灯”方向（相机坐标系，从左上方照过来） */
const LIGHT = new THREE.Vector3(-0.45, 0.65, 0.6).normalize();

interface Face {
  v: THREE.Vector3[];
  n: THREE.Vector3;
  color: THREE.Color;
}

/**
 * 三角锥：尖端指向箭体 +Y（机头），底面的三个顶点均匀分布。
 * 朝向箭体 +Z 的侧面（发射时朝西，向东重力转弯时朝天）为橙红色，另外两个侧面一金一米白，
 * 看到哪一面就知道箭体滚转到了哪里；底面（尾部）为深琥珀色。
 */
const FACES: Face[] = (() => {
  const apex = new THREE.Vector3(0, TIP, 0);
  const base = [60, 180, 300].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(a) * BASE_R, BASE_Y, Math.cos(a) * BASE_R);
  });
  const face = (v: THREE.Vector3[], hex: string): Face => {
    const n = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0])).normalize();
    return { v, n, color: new THREE.Color(hex) };
  };
  // 顶点从外侧看为逆时针，法向朝外
  return [face([apex, base[2], base[0]], '#ff6a3d'), face([apex, base[0], base[1]], '#ffc93a'), face([apex, base[1], base[2]], '#fff0c4'), face([base[0], base[2], base[1]], '#8a5a14')];
})();

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _w = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * 地图上的飞船标记：随箭体姿态（四元数 q）实时转动的三维三角锥，画成 SVG。
 * 把各顶点按相机的朝向投影到屏幕上（含透视修正：标记不在画面中央时，看它的方向与相机正前方不同），
 * 只画朝向相机的面；凸多面体剔除背面后各面互不遮挡，不需要排序。
 * 交给浏览器画 SVG：边缘有抗锯齿，棱用各面自身颜色的深色调细线，比在三维场景里画（没有多重采样，边缘一圈锯齿）好看得多。
 * pos 为飞船位置（浮动原点系）；飞船在相机背后时返回空串。
 */
export function vesselMarkerSvg(q: THREE.Quaternion, pos: THREE.Vector3, camera: THREE.Camera): string {
  const P = _p.copy(pos).applyMatrix4(camera.matrixWorldInverse);
  if (P.z > -1e-9) return '';
  // 小物体的透视投影：偏移 (dX, dY, dZ) 在屏幕上移动 (dX − dZ·X/Z, dY − dZ·Y/Z)（再整体乘一个常数）
  const kx = P.x / P.z;
  const ky = P.y / P.z;
  const qv = _q.copy(camera.quaternion).invert().multiply(q);
  _eye.copy(P).negate().normalize();
  let polys = '';
  for (const f of FACES) {
    _n.copy(f.n).applyQuaternion(qv);
    if (_n.dot(_eye) <= 1e-4) continue;
    const pts = f.v
      .map((v) => {
        _w.copy(v).applyQuaternion(qv);
        const x = (_w.x - _w.z * kx) * SIZE_PX;
        const y = -(_w.y - _w.z * ky) * SIZE_PX;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
    const k = 0.58 + 0.42 * Math.max(0, _n.dot(LIGHT));
    const fill = _c.copy(f.color).multiplyScalar(k).getHexString();
    const edge = _c.copy(f.color).multiplyScalar(k * 0.45).getHexString();
    polys += `<polygon points="${pts}" fill="#${fill}" stroke="#${edge}"/>`;
  }
  return `<svg viewBox="-16 -16 32 32">${polys}</svg>`;
}
