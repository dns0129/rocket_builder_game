import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type Quality = 'low' | 'medium' | 'high';

/** 各画质的渲染分辨率范围（相对 CSS 像素）。手机屏幕像素密度高，满分辨率渲染会严重掉帧。 */
const PIXEL_RATIO: Record<Quality, { min: number; max: number }> = {
  low: { min: 0.55, max: 1 },
  medium: { min: 0.75, max: 1.5 },
  high: { min: 1, max: 2 },
};

/**
 * WebGL 渲染器 + 后期（泛光 + ACES 色调映射）。
 * 手机版额外做了动态分辨率：帧率不足时自动降低渲染分辨率，富余时再慢慢提高。
 */
export class RenderEngine {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  renderPass: RenderPass;
  bloom: UnrealBloomPass;
  width = 1;
  height = 1;
  quality: Quality;
  /** 是否启用动态分辨率 */
  adaptive = true;
  pixelRatio: number;
  private prMin: number;
  private prMax: number;
  private frameAcc = 0;
  private frameCount = 0;
  private goodWindows = 0;
  private listeners: ((w: number, h: number) => void)[] = [];

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality === 'high',
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const dpr = window.devicePixelRatio || 1;
    this.prMax = Math.min(dpr, PIXEL_RATIO[quality].max);
    this.prMin = Math.min(this.prMax, PIXEL_RATIO[quality].min);
    this.pixelRatio = this.prMax;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const dummyScene = new THREE.Scene();
    const dummyCam = new THREE.PerspectiveCamera();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(dummyScene, dummyCam);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.6, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    // iOS 旋转屏幕后有时要等一会儿才能拿到正确的尺寸
    window.addEventListener('orientationchange', () => {
      setTimeout(onResize, 150);
      setTimeout(onResize, 600);
    });
    this.resize();
  }

  onResize(f: (w: number, h: number) => void): void {
    this.listeners.push(f);
    f(this.width, this.height);
  }

  resize(): void {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    for (const f of this.listeners) f(w, h);
  }

  private setPixelRatio(pr: number): void {
    pr = Math.max(this.prMin, Math.min(this.prMax, pr));
    if (Math.abs(pr - this.pixelRatio) < 0.02) return;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.width, this.height);
  }

  /** 每帧调用，dt 为真实帧间隔（秒）。按 1 秒窗口统计平均帧时间来调整分辨率。 */
  adapt(dt: number): void {
    if (!this.adaptive || dt <= 0 || dt > 0.25) return;
    this.frameAcc += dt;
    this.frameCount++;
    if (this.frameAcc < 1) return;
    const avg = this.frameAcc / this.frameCount;
    this.frameAcc = 0;
    this.frameCount = 0;
    if (avg > 1 / 38) {
      // 帧率低于约 38：立即降低分辨率
      this.goodWindows = 0;
      this.setPixelRatio(this.pixelRatio * (avg > 1 / 24 ? 0.8 : 0.9));
    } else if (avg < 1 / 55) {
      // 连续 3 秒流畅才提高，避免来回抖动
      if (++this.goodWindows >= 3) {
        this.goodWindows = 0;
        this.setPixelRatio(this.pixelRatio * 1.08);
      }
    } else this.goodWindows = 0;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.composer.render();
  }
}
