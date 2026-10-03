import * as THREE from 'three';

/** 标记在屏幕上的高度（像素） */
const MARKER_PX = 40;

/**
 * 面着色：固定在相机上的“头灯”（从左上方照过来），朝向不同的面明暗不同，转动时一眼就能看出立体的朝向；
 * 与太阳方向无关，在星球的夜面上也一样清楚。
 * 棱线：每个面的三个顶点带重心坐标，离边越近越暗（屏幕上约 1.5 像素宽）；背面已剔除，只画看得见的棱。
 */
const SHADE_VERT = /* glsl */ `
attribute vec3 color;
attribute vec3 bary;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  vColor = color;
  vBary = bary;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const SHADE_FRAG = /* glsl */ `
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  vec3 L = normalize(vec3(-0.45, 0.65, 0.6));
  float k = 0.4 + 0.6 * max(dot(normalize(vNormal), L), 0.0);
  float e = min(min(vBary.x, vBary.y), vBary.z);
  float w = fwidth(e);
  float edge = 1.0 - smoothstep(w * 0.6, w * 1.8, e);
  gl_FragColor = vec4(mix(vColor * k, vec3(0.05, 0.04, 0.0), edge * 0.85), 1.0);
}
`;
/** 三角锥的尺寸（单位长度 = 标记高度）：尖端在 +Y，底面三角形外接圆半径 */
const TIP = 0.6;
const BASE_Y = -0.4;
const BASE_R = 0.42;

/**
 * 三角锥的顶点与面颜色。尖端指向箭体 +Y（机头），底面的三个顶点均匀分布，
 * 其中朝向箭体 +Z 的那一面（发射时朝西，向东重力转弯时朝天）涂成红色，用来看出滚转；
 * 另外两个侧面一黄一浅白、底面（尾部）深色，再加上随相机的面光照与棱线，从任何方向看都能分清各个面。
 */
function pyramidGeometry(scale = 1): THREE.BufferGeometry {
  const apex = new THREE.Vector3(0, TIP * scale, 0);
  // 底面顶点：+Z 面的两个顶点在 ±60°，第三个顶点在 -Z 方向
  const base = [60, 180, 300].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(a) * BASE_R * scale, BASE_Y * scale, Math.cos(a) * BASE_R * scale);
  });
  // 底面顶点按 60° → 180° → 300° 的顺序，从外侧看侧面为逆时针
  // 三个侧面颜色分明（红 / 黄 / 浅白），看到哪一面就知道箭体朝哪边；颜色略偏饱和，整幅画面最后要经过 ACES 色调映射
  const top = new THREE.Color('#ff3a1e');
  const sideA = new THREE.Color('#ffd21a');
  const sideB = new THREE.Color('#fff3c0');
  const tail = new THREE.Color('#5a4006');
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Color][] = [
    [apex, base[2], base[0], top], // +Z 面（300° 与 60° 之间）
    [apex, base[0], base[1], sideA],
    [apex, base[1], base[2], sideB],
    [base[0], base[2], base[1], tail], // 底面朝 -Y
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const bary: number[] = [];
  for (const [a, b, c, k] of faces) {
    for (const p of [a, b, c]) {
      pos.push(p.x, p.y, p.z);
      col.push(k.r, k.g, k.b);
    }
    bary.push(1, 0, 0, 0, 1, 0, 0, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('bary', new THREE.Float32BufferAttribute(bary, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * 地图上的飞船标记：三维三角锥，尖端指向机头，随箭体姿态（四元数）实时转动，
 * 俯仰、偏航、滚转都看得出来（以前的二维箭头只能在屏幕平面内转，机头指向屏幕里外时看不出来）。
 * 大小按屏幕像素固定；放在透明物体队列里画在天空和轨迹线之后（不写深度的不透明物体会被最后绘制的天空盖掉），
 * 不参与深度测试（凸多面体剔除背面即可正确显示），外面套一层略大的深色背面作为描边，
 * 在明亮的星球上也看得清。被星球挡住时由调用方隐藏。
 */
export class VesselMarker {
  readonly group = new THREE.Group();

  constructor() {
    const body = new THREE.Mesh(
      pyramidGeometry(),
      new THREE.ShaderMaterial({ vertexShader: SHADE_VERT, fragmentShader: SHADE_FRAG, depthTest: false, depthWrite: false, transparent: true, side: THREE.FrontSide }),
    );
    // 描边：放大一点、只画背面的深色外壳，先于本体绘制
    const outline = new THREE.Mesh(
      pyramidGeometry(1.16),
      new THREE.MeshBasicMaterial({ color: 0x1a1400, depthTest: false, depthWrite: false, transparent: true, side: THREE.BackSide }),
    );
    outline.renderOrder = 70;
    body.renderOrder = 71;
    for (const m of [outline, body]) m.frustumCulled = false;
    this.group.add(outline, body);
  }

  /** 每帧：放到飞船位置（浮动原点系），按箭体姿态转动，按相机距离缩放到固定的屏幕大小。 */
  update(pos: THREE.Vector3, q: THREE.Quaternion, camera: THREE.PerspectiveCamera, viewportH: number, visible: boolean): void {
    this.group.visible = visible;
    if (!visible) return;
    this.group.position.copy(pos);
    this.group.quaternion.copy(q);
    const dist = camera.position.distanceTo(pos);
    const mpp = (2 * dist * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / Math.max(1, viewportH);
    this.group.scale.setScalar(MARKER_PX * mpp);
  }

  dispose(): void {
    for (const o of this.group.children) {
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
