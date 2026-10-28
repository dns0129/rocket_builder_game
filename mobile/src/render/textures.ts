import * as THREE from 'three';

/** 画布生成的程序化纹理（可平铺）。 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 可平铺的值噪声场。 */
function tileNoise(size: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = g[(y0 % cells) * cells + (x0 % cells)];
      const b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = g[((y0 + 1) % cells) * cells + (x0 % cells)];
      const d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
  }
  return out;
}

function fbmTile(size: number, seed: number, octaves: number, base = 4): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(size, base << o, seed + o * 17);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function heightToNormal(h: Float32Array, size: number, strength: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      px[i] = (nx * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * 0.5 + 0.5) * 255;
      px[i + 2] = (nz * 0.5 + 0.5) * 255;
      px[i + 3] = 255;
    }
  }
  return px;
}

function toTexture(px: Uint8ClampedArray, size: number, srgb: boolean, repeat = true): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const cache = new Map<string, THREE.Texture>();
function cached(key: string, f: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = f();
    cache.set(key, t);
  }
  return t;
}

/** 地面细节：灰度调制（以 0.5 为中性）。 */
export function groundDetail(kind: 'grass' | 'regolith'): { albedo: THREE.Texture; normal: THREE.Texture } {
  return {
    albedo: cached(`gd-a-${kind}`, () => {
      const size = 512;
      const n = fbmTile(size, kind === 'grass' ? 11 : 23, 6, 4);
      const px = new Uint8ClampedArray(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const v = kind === 'grass' ? 0.72 + (n[i] - 0.5) * 0.9 : 0.8 + (n[i] - 0.5) * 0.7;
        px[i * 4] = v * 180;
        px[i * 4 + 1] = v * 180;
        px[i * 4 + 2] = v * 180;
        px[i * 4 + 3] = 255;
      }
      return toTexture(px, size, false);
    }),
    normal: cached(`gd-n-${kind}`, () => {
      const size = 512;
      const h = fbmTile(size, kind === 'grass' ? 31 : 41, 7, 8);
      if (kind === 'regolith') {
        // 小撞击坑
        const r = rng(77);
        for (let k = 0; k < 140; k++) {
          const cx = r() * size;
          const cy = r() * size;
          const rad = 3 + Math.pow(r(), 3) * 40;
          for (let y = -rad * 1.5; y < rad * 1.5; y++) {
            for (let x = -rad * 1.5; x < rad * 1.5; x++) {
              const d = Math.hypot(x, y) / rad;
              if (d > 1.5) continue;
              const px = ((Math.floor(cx + x) % size) + size) % size;
              const py = ((Math.floor(cy + y) % size) + size) % size;
              const v = d < 1 ? (d * d - 1) * 0.35 : 0.08 * (1 - (d - 1) / 0.5);
              h[py * size + px] += v * (rad / 40);
            }
          }
        }
      }
      return toTexture(heightToNormal(h, size, kind === 'grass' ? 6 : 10), size, false);
    }),
  };
}

/** 发射台混凝土。 */
export function concreteTexture(): THREE.Texture {
  return cached('concrete', () => {
    const size = 1024;
    const n = fbmTile(size, 91, 7, 4);
    const px = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        let v = 0.62 + (n[i] - 0.5) * 0.25;
        // 分隔缝
        if (x % 128 < 2 || y % 128 < 2) v *= 0.55;
        // 中心烧蚀痕迹
        const dx = (x - size / 2) / size;
        const dy = (y - size / 2) / size;
        const d = Math.hypot(dx, dy);
        v *= 1 - 0.6 * Math.exp(-d * d * 40) * (0.7 + 0.3 * n[i]);
        px[i * 4] = v * 200;
        px[i * 4 + 1] = v * 197;
        px[i * 4 + 2] = v * 190;
        px[i * 4 + 3] = 255;
      }
    }
    const t = toTexture(px, size, true, false);
    return t;
  });
}

/** 燃料箱涂装：面板缝 + 轻微污渍。pattern 控制黑白涂装。 */
export function tankTexture(pattern: 'white' | 'roll' | 'band' | 'foam' | 'srb'): { map: THREE.Texture; normal: THREE.Texture } {
  return {
    map: cached(`tank-${pattern}`, () => {
      const W = 512;
      const H = 512;
      const n = fbmTile(W, 5 + pattern.length, 5, 8);
      const px = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          let r: number;
          let g: number;
          let b: number;
          if (pattern === 'foam') {
            const v = 0.85 + (n[i] - 0.5) * 0.35;
            r = 214 * v;
            g = 112 * v;
            b = 42 * v;
          } else {
            let white = true;
            if (pattern === 'roll') white = ((Math.floor(x / (W / 4)) + Math.floor(y / (H / 2))) & 1) === 0 || y < H * 0.5;
            if (pattern === 'band') white = !(y > H * 0.78 && y < H * 0.9);
            if (pattern === 'srb') white = !(y % (H / 4) < 10);
            const v = 0.93 + (n[i] - 0.5) * 0.08;
            if (white) {
              r = 240 * v;
              g = 240 * v;
              b = 236 * v;
            } else {
              r = 28 * v;
              g = 28 * v;
              b = 30 * v;
            }
          }
          // 面板缝
          if (pattern !== 'foam' && (x % (W / 8) < 2 || y % (H / 4) < 2)) {
            r *= 0.8;
            g *= 0.8;
            b *= 0.8;
          }
          px[i * 4] = r;
          px[i * 4 + 1] = g;
          px[i * 4 + 2] = b;
          px[i * 4 + 3] = 255;
        }
      }
      return toTexture(px, W, true);
    }),
    normal: cached(`tankn-${pattern}`, () => {
      const W = 512;
      const h = fbmTile(W, 51, 4, 16);
      for (let i = 0; i < h.length; i++) h[i] *= pattern === 'foam' ? 0.6 : 0.05;
      for (let y = 0; y < W; y++)
        for (let x = 0; x < W; x++) {
          if (pattern !== 'foam' && (x % (W / 8) < 2 || y % (W / 4) < 2)) h[y * W + x] -= 0.15;
        }
      return toTexture(heightToNormal(h, W, 8), W, false);
    }),
  };
}

/** 喷管：从喉部到出口的高温变色。 */
export function nozzleTexture(): THREE.Texture {
  return cached('nozzle', () => {
    const W = 64;
    const H = 256;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3a2a22');
    g.addColorStop(0.25, '#5a3b2a');
    g.addColorStop(0.5, '#6b6f78');
    g.addColorStop(0.8, '#8a8f99');
    g.addColorStop(1, '#a4a8b0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.25;
    for (let y = 0; y < H; y += 6) {
      ctx.fillStyle = y % 12 === 0 ? '#000' : '#fff';
      ctx.fillRect(0, y, W, 1);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** 分离器的黄黑警示条。 */
export function hazardTexture(): THREE.Texture {
  return cached('hazard', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e8b21a';
    ctx.fillRect(0, 0, 256, 32);
    ctx.fillStyle = '#161616';
    for (let x = -32; x < 256; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 32);
      ctx.lineTo(x + 16, 32);
      ctx.lineTo(x + 48, 0);
      ctx.lineTo(x + 32, 0);
      ctx.fill();
    }
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** 降落伞伞衣（橙白相间）。 */
export function canopyTexture(): THREE.Texture {
  return cached('canopy', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 ? '#f2f2ee' : '#e0561b';
      ctx.fillRect(i * 32, 0, 32, 64);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** 多层隔热金箔的褶皱法线。 */
export function foilNormal(): THREE.Texture {
  return cached('foil', () => {
    const size = 256;
    const h = fbmTile(size, 3, 6, 8);
    return toTexture(heightToNormal(h, size, 25), size, false);
  });
}

/** 烟雾粒子贴图（柔和的团块）。 */
export function smokeSprite(): THREE.Texture {
  return cached('smoke', () => {
    const size = 128;
    const n = fbmTile(size, 7, 5, 4);
    const px = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - size / 2) / (size / 2);
        const dy = (y - size / 2) / (size / 2);
        const d = Math.hypot(dx, dy);
        const i = y * size + x;
        const a = Math.max(0, 1 - d) ** 1.5 * (0.55 + 0.9 * (n[i] - 0.3));
        px[i * 4] = 255;
        px[i * 4 + 1] = 255;
        px[i * 4 + 2] = 255;
        px[i * 4 + 3] = Math.max(0, Math.min(255, a * 255));
      }
    }
    return toTexture(px, size, false, false);
  });
}
