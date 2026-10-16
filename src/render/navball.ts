import * as THREE from 'three';

/**
 * 导航球：用片元着色器绘制——每个像素对应一个方向（相对飞船机头），
 * 再换算为当地地平坐标下的航向/俯仰，从而查表得到天空/地面与刻度。
 */

const VERT = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform mat3 uBodyToLocal; // 船体系 -> (东, 上, 北)
varying vec2 vP;
void main() {
  float r2 = dot(vP, vP);
  if (r2 > 1.0) discard;
  float z = sqrt(1.0 - r2);
  // 屏幕：右 = 船体 +X，上 = 船体 +Z（顶部），朝向观察者 = 机头 +Y
  vec3 vb = vec3(vP.x, z, vP.y);
  vec3 l = uBodyToLocal * vb; // (东, 上, 北)
  float el = asin(clamp(l.y, -1.0, 1.0));
  float hd = atan(l.x, l.z); // 航向，北 = 0，东 = +90°
  vec2 uv = vec2(fract(hd / 6.2831853 + 1.0), el / 3.14159265 + 0.5);
  vec3 c = texture2D(uTex, uv).rgb;
  // 球面光照
  float shade = 0.55 + 0.45 * z;
  float rim = smoothstep(0.93, 1.0, sqrt(r2));
  c = c * shade;
  c = mix(c, vec3(0.08), rim * 0.8);
  gl_FragColor = vec4(c, 1.0);
}
`;

function buildTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#0e3f7a');
  sky.addColorStop(1, '#3d8fd4');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H / 2);
  const gnd = ctx.createLinearGradient(0, H / 2, 0, H);
  gnd.addColorStop(0, '#9a6433');
  gnd.addColorStop(1, '#4a2c14');
  ctx.fillStyle = gnd;
  ctx.fillRect(0, H / 2, W, H / 2);
  // 坐标：u = 航向/360，v 自下而上为俯仰 -90..90；画布 y 向下，因此 y = H - v*H
  const yOf = (el: number) => H / 2 - (el / 180) * H;
  const xOf = (hd: number) => (((hd % 360) + 360) % 360) / 360 * W;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let el = -80; el <= 80; el += 10) {
    if (el === 0) continue;
    ctx.lineWidth = el % 30 === 0 ? 4 : 2;
    const y = yOf(el);
    for (let hd = 0; hd < 360; hd += 90) {
      const x = xOf(hd);
      ctx.beginPath();
      ctx.moveTo(x - 60, y);
      ctx.lineTo(x + 60, y);
      ctx.stroke();
      if (el % 30 === 0) {
        ctx.fillText(String(Math.abs(el)), x - 95, y);
        ctx.fillText(String(Math.abs(el)), x + 95, y);
      }
    }
  }
  // 经线
  for (let hd = 0; hd < 360; hd += 30) {
    const x = xOf(hd);
    ctx.lineWidth = hd % 90 === 0 ? 4 : 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(x, yOf(80));
    ctx.lineTo(x, yOf(-80));
    ctx.stroke();
  }
  ctx.font = 'bold 44px sans-serif';
  const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let hd = 0; hd < 360; hd += 30) {
    const x = xOf(hd);
    const label = names[hd] ?? String(hd).padStart(3, '0');
    ctx.fillStyle = names[hd] ? '#ffd24a' : 'rgba(255,255,255,0.95)';
    ctx.fillText(label, x, H / 2 - 34);
    ctx.fillText(label, x, H / 2 + 34);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** 导航球上标记图标的边长（px），与 CSS 中 .navball-marker 一致 */
const MARKER = 20;

export type NavMarker = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radialOut' | 'radialIn' | 'maneuver';

export class Navball {
  canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private markerEls = new Map<NavMarker, HTMLDivElement>();
  private size = 200;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'navball-canvas';
    container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTex: { value: buildTexture() }, uBodyToLocal: { value: new THREE.Matrix3() } },
      transparent: true,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    q.frustumCulled = false;
    this.scene.add(q);
    const icons: Record<NavMarker, string> = {
      prograde: '<svg viewBox="-12 -12 24 24"><circle r="5" fill="none" stroke="#e6ff3a" stroke-width="2"/><line x1="0" y1="-5" x2="0" y2="-10" stroke="#e6ff3a" stroke-width="2"/><line x1="-5" y1="0" x2="-10" y2="0" stroke="#e6ff3a" stroke-width="2"/><line x1="5" y1="0" x2="10" y2="0" stroke="#e6ff3a" stroke-width="2"/></svg>',
      retrograde: '<svg viewBox="-12 -12 24 24"><circle r="5" fill="none" stroke="#e6ff3a" stroke-width="2"/><line x1="-3.5" y1="-3.5" x2="3.5" y2="3.5" stroke="#e6ff3a" stroke-width="2"/><line x1="3.5" y1="-3.5" x2="-3.5" y2="3.5" stroke="#e6ff3a" stroke-width="2"/><line x1="0" y1="5" x2="0" y2="10" stroke="#e6ff3a" stroke-width="2"/><line x1="-7" y1="-4" x2="-10" y2="-7" stroke="#e6ff3a" stroke-width="2"/><line x1="7" y1="-4" x2="10" y2="-7" stroke="#e6ff3a" stroke-width="2"/></svg>',
      normal: '<svg viewBox="-12 -12 24 24"><polygon points="0,-7 6,5 -6,5" fill="none" stroke="#e05ae8" stroke-width="2"/><circle r="1.5" fill="#e05ae8"/></svg>',
      antinormal: '<svg viewBox="-12 -12 24 24"><polygon points="0,-7 6,5 -6,5" fill="none" stroke="#e05ae8" stroke-width="2"/><line x1="0" y1="-7" x2="0" y2="-11" stroke="#e05ae8" stroke-width="2"/><line x1="6" y1="5" x2="9" y2="8" stroke="#e05ae8" stroke-width="2"/><line x1="-6" y1="5" x2="-9" y2="8" stroke="#e05ae8" stroke-width="2"/></svg>',
      radialOut: '<svg viewBox="-12 -12 24 24"><circle r="5.5" fill="none" stroke="#4ad8ff" stroke-width="2"/><line x1="0" y1="-5.5" x2="0" y2="-10" stroke="#4ad8ff" stroke-width="2"/><line x1="0" y1="5.5" x2="0" y2="10" stroke="#4ad8ff" stroke-width="2"/><line x1="-5.5" y1="0" x2="-10" y2="0" stroke="#4ad8ff" stroke-width="2"/><line x1="5.5" y1="0" x2="10" y2="0" stroke="#4ad8ff" stroke-width="2"/></svg>',
      radialIn: '<svg viewBox="-12 -12 24 24"><circle r="6" fill="none" stroke="#4ad8ff" stroke-width="2"/><line x1="-4" y1="-4" x2="4" y2="4" stroke="#4ad8ff" stroke-width="2"/><line x1="4" y1="-4" x2="-4" y2="4" stroke="#4ad8ff" stroke-width="2"/></svg>',
      maneuver: '<svg viewBox="-12 -12 24 24"><path d="M0,-9 L3,-3 L9,0 L3,3 L0,9 L-3,3 L-9,0 L-3,-3 Z" fill="none" stroke="#3a8cff" stroke-width="2"/><circle r="2" fill="#3a8cff"/></svg>',
    };
    for (const k of Object.keys(icons) as NavMarker[]) {
      const el = document.createElement('div');
      el.className = 'navball-marker';
      el.innerHTML = icons[k];
      container.appendChild(el);
      this.markerEls.set(k, el);
    }
    const center = document.createElement('div');
    center.className = 'navball-center';
    center.innerHTML = '<svg viewBox="-50 -20 100 40"><path d="M-40,0 L-12,0 L0,10 L12,0 L40,0" fill="none" stroke="#ffb020" stroke-width="5" stroke-linejoin="round"/><circle r="3" fill="#ffb020"/></svg>';
    container.appendChild(center);
  }

  resize(size: number): void {
    this.size = size;
    this.renderer.setSize(size, size, false);
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
  }

  /**
   * q：船体 -> 惯性系；east/up/north：当地地平基向量（惯性系）。
   * markers：各标记的惯性系方向。
   */
  update(q: THREE.Quaternion, east: THREE.Vector3, up: THREE.Vector3, north: THREE.Vector3, markers: Partial<Record<NavMarker, THREE.Vector3 | null>>): void {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const bx = new THREE.Vector3();
    const by = new THREE.Vector3();
    const bz = new THREE.Vector3();
    m.extractBasis(bx, by, bz);
    // (东, 上, 北) 行 × 船体列
    const e = [east, up, north];
    const b = [bx, by, bz];
    const mat = new THREE.Matrix3();
    const el: number[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) el.push(e[r].dot(b[c]));
    mat.set(el[0], el[1], el[2], el[3], el[4], el[5], el[6], el[7], el[8]);
    this.mat.uniforms.uBodyToLocal.value = mat;
    this.renderer.render(this.scene, this.cam);
    const inv = q.clone().invert();
    const R = this.size / 2;
    for (const [k, elm] of this.markerEls) {
      const d = markers[k];
      if (!d) {
        elm.style.display = 'none';
        continue;
      }
      const v = d.clone().normalize().applyQuaternion(inv); // 船体系
      if (v.y < 0.02) {
        elm.style.display = 'none';
        continue;
      }
      elm.style.display = 'block';
      elm.style.transform = `translate(${R + v.x * R * 0.96 - MARKER / 2}px, ${R - v.z * R * 0.96 - MARKER / 2}px)`;
    }
  }
}
