import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type Quality = 'low' | 'medium' | 'high';

/** 自动分辨率的下限（相对 CSS 像素） */
const MIN_PIXEL_RATIO = 0.55;
/** 低于这个帧率就降低渲染分辨率 */
const FPS_LOW = 48;
/** 高于这个帧率（且持续数秒）才尝试恢复分辨率 */
const FPS_HIGH = 57;

/**
 * 自动分辨率的调节策略（与 WebGL 无关，便于测试）：每秒左右调用一次 step()。
 * 帧率偏低且瓶颈在显卡（脚本耗时远小于帧时间）时降低渲染分辨率；
 * 连续几秒帧率富余时再逐步恢复。刚降过就等一会儿再恢复，避免来回抖动。
 */
export class ResolutionGovernor {
  scale = 1;
  /** 分辨率已降到下限仍不够时，再逐级关闭特效：1 = 关闭泛光，2 = 再关闭阴影、降低大气采样 */
  detail = 0;
  private goodSeconds = 0;
  private holdOff = 0;
  /** 刚升上去就掉帧的分辨率：一段时间内不再尝试 */
  private ceiling = Infinity;
  private ceilingTimer = 0;
  private sinceUp = Infinity;
  constructor(public minScale: number) {}

  step(fps: number, cpuMs: number): number {
    this.holdOff = Math.max(0, this.holdOff - 1);
    this.sinceUp++;
    if (--this.ceilingTimer <= 0) this.ceiling = Infinity;
    const frameMs = 1000 / fps;
    const gpuBound = cpuMs < frameMs * 0.6;
    if (fps < 42 && gpuBound && this.scale <= this.minScale + 1e-3 && this.detail < 2 && this.holdOff <= 3) {
      this.detail++;
      this.goodSeconds = 0;
      this.holdOff = 6;
    } else if (fps < FPS_LOW && gpuBound && this.scale > this.minScale + 1e-3) {
      if (this.sinceUp <= 3) {
        this.ceiling = this.scale;
        this.ceilingTimer = 30;
      }
      // 像素数与 scale² 成正比：帧率越低降得越多
      const k = fps < 32 ? 0.72 : fps < 42 ? 0.82 : 0.9;
      this.scale = Math.max(this.minScale, this.scale * k);
      this.goodSeconds = 0;
      this.holdOff = 6;
    } else if (fps > FPS_HIGH && this.detail > 0) {
      // 先恢复特效，再恢复分辨率
      if (++this.goodSeconds >= 5 && this.holdOff === 0) {
        this.detail--;
        this.goodSeconds = 0;
        this.sinceUp = 0;
      }
    } else if (fps > FPS_HIGH && this.scale < 1) {
      const next = Math.min(1, this.scale * 1.1);
      if (++this.goodSeconds >= 3 && this.holdOff === 0 && next < this.ceiling * 0.99) {
        this.scale = next;
        this.goodSeconds = 0;
        this.sinceUp = 0;
      }
    } else this.goodSeconds = 0;
    return this.scale;
  }
}

/** WebGL 渲染器 + 后期（泛光 + ACES 色调映射）+ 自动分辨率。 */
export class RenderEngine {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  renderPass: RenderPass;
  bloom: UnrealBloomPass;
  width = 1;
  height = 1;
  quality: Quality;
  /** 画质决定的最高像素比 */
  basePixelRatio: number;
  autoScale = true;
  /** 最近一秒的平均帧率 */
  fps = 60;
  /** 自动分辨率：实际像素比 = basePixelRatio × governor.scale */
  governor: ResolutionGovernor;
  private listeners: ((w: number, h: number) => void)[] = [];
  private stat = { t: 0, n: 0, cpu: 0 };
  private longFrames = 0;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // 场景先画到后期处理的离屏目标上，默认帧缓冲只画最后一张全屏图，开 MSAA 纯属浪费
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const dpr = window.devicePixelRatio || 1;
    this.basePixelRatio = Math.min(dpr, quality === 'high' ? 2 : quality === 'medium' ? 1.25 : 1);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.governor = new ResolutionGovernor(Math.min(1, MIN_PIXEL_RATIO / this.basePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const dummyScene = new THREE.Scene();
    const dummyCam = new THREE.PerspectiveCamera();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality === 'high' ? 4 : 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(dummyScene, dummyCam);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.6, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** 特效降级等级（见 ResolutionGovernor.detail） */
  get detail(): number {
    return this.governor.detail;
  }

  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
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
    this.composer.setSize(w, h);
    for (const f of this.listeners) f(w, h);
  }

  private applyPixelRatio(): void {
    const pr = Math.max(Math.min(MIN_PIXEL_RATIO, this.basePixelRatio), this.basePixelRatio * this.governor.scale);
    if (Math.abs(pr - this.renderer.getPixelRatio()) < 0.01) return;
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.resize();
  }

  setAutoScale(on: boolean): void {
    this.autoScale = on;
    if (!on) {
      this.governor.scale = 1;
      this.governor.detail = 0;
      this.bloom.enabled = true;
      this.applyPixelRatio();
    }
  }

  /** 每帧调用：dt 为帧间隔（秒），cpuMs 为本帧脚本耗时（不含渲染）。 */
  adapt(dt: number, cpuMs: number): void {
    // 偶发的长帧（切换标签页、编译着色器）不计入；连续出现说明机器确实很慢，照常统计
    if (dt <= 0 || dt > 1.5) return;
    if (dt > 0.25) {
      if (++this.longFrames < 3) return;
    } else this.longFrames = 0;
    const s = this.stat;
    s.t += dt;
    s.n++;
    s.cpu += cpuMs;
    if (s.t < 0.75) return;
    this.fps = s.n / s.t;
    const cpu = s.cpu / s.n;
    s.t = 0;
    s.n = 0;
    s.cpu = 0;
    if (!this.autoScale) return;
    const before = this.governor.scale;
    if (this.governor.step(this.fps, cpu) !== before) this.applyPixelRatio();
    this.bloom.enabled = this.governor.detail < 1;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.composer.render();
  }
}
