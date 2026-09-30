/** 全部由 WebAudio 实时合成的音效：发动机轰鸣、风声、分离、爆炸、提示音。 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private crackleGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  volume = 0.7;
  private started = false;

  /** 必须在用户交互之后调用。 */
  start(): void {
    if (this.started) {
      this.ctx?.resume();
      return;
    }
    this.started = true;
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null;
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // 棕噪声缓冲
    const len = ctx.sampleRate * 4;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    // 发动机：棕噪声 -> 低通
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 300;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    src.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    src.start();
    // 爆裂声：白噪声 -> 带通，随机调制
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < len; i++) wd[i] = (Math.random() * 2 - 1) * (Math.random() < 0.02 ? 1 : 0.25);
    const src2 = ctx.createBufferSource();
    src2.buffer = white;
    src2.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.7;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    src2.connect(bp).connect(this.crackleGain).connect(this.master);
    src2.start();
    // 风声
    const src3 = ctx.createBufferSource();
    src3.buffer = white;
    src3.loop = true;
    src3.playbackRate.value = 0.5;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 1.2;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src3.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src3.start();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** thrust：总推力 N；air：0..1 大气密度比；q：动压 Pa；inside：相机是否贴近。 */
  update(thrust: number, air: number, q: number, paused: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, Math.sqrt(thrust / 2e6));
    const on = thrust > 0 && !paused;
    // 真空中只能通过结构传声：更闷、更小
    const air01 = Math.min(1, air * 2 + 0.15);
    this.engineGain.gain.setTargetAtTime(on ? (0.25 + 0.75 * k) * (0.45 + 0.55 * air01) : 0, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(on ? 180 + 900 * k * air01 : 200, t, 0.1);
    this.crackleGain.gain.setTargetAtTime(on ? 0.12 * k * air01 : 0, t, 0.08);
    const w = Math.min(1, q / 30000);
    this.windGain.gain.setTargetAtTime(paused ? 0 : w * 0.35, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(300 + w * 1200, t, 0.2);
  }

  private burst(dur: number, freq: number, gain: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  stage(): void {
    this.burst(0.35, 900, 0.9);
    this.tone(70, 0.3, 0.5, 'sine');
  }

  ignite(): void {
    this.burst(1.2, 400, 1.1);
  }

  explosion(big: boolean): void {
    this.burst(big ? 3.5 : 1.8, big ? 260 : 400, big ? 2.2 : 1.2);
    this.tone(45, big ? 1.5 : 0.8, big ? 1.0 : 0.5, 'sine');
  }

  chute(): void {
    this.burst(0.6, 2500, 0.5, 'highpass');
  }

  click(): void {
    this.tone(1400, 0.05, 0.08, 'triangle');
  }

  chime(good: boolean): void {
    if (good) {
      this.tone(660, 0.25, 0.12);
      this.tone(990, 0.35, 0.1, 'sine', 0.12);
    } else {
      this.tone(330, 0.35, 0.14, 'square');
      this.tone(247, 0.45, 0.12, 'square', 0.18);
    }
  }
}
