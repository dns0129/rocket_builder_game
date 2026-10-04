// 生成可以离线运行的游戏下载包（用法：npm run package）。
// 电脑版和手机版各打成一个单文件网页：脚本、样式、地形 Worker、贴图、演示录像全部内嵌，
// 双击就能用浏览器打开，不需要 Node.js、本地服务器，也不需要联网。
//
// 为什么要内嵌：以 file:// 打开的页面不能加载模块脚本文件和 Worker 文件，不能 fetch 本地 JSON，
// 本地图片也不能上传成 WebGL 贴图（跨源）。内嵌成 data: / blob: 地址后这些限制都不存在了。
//
// 输出到 release/（vite build 会清空 dist/，所以不放在那里）：
//   火箭工坊-电脑版.zip / 火箭工坊-手机版.zip  —— 下载包（单文件网页 + 使用说明.txt）
//   火箭工坊-电脑版.html / 火箭工坊-手机版.html —— 同样的网页，方便直接传到手机上
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'vite';

const OUT = resolve('release');
const TMP = resolve('release/.build');

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const VARIANTS = [
  {
    root: '.',
    html: '火箭工坊.html',
    zip: '火箭工坊-电脑版.zip',
    single: '火箭工坊-电脑版.html',
    readme: (html, mb) => `火箭工坊 · 登月计划（电脑版 · 离线下载包）

【怎么玩】
1. 先把压缩包解压（Windows：右键 → 全部解压缩；macOS：双击压缩包）。
2. 双击“${html}”，游戏会在默认浏览器中打开。
   不需要联网，也不需要安装 Node.js 或其他任何软件。
3. 文件约 ${mb} MB（游戏程序、地球与行星贴图、演示录像都在里面），打开后稍等几秒。

【浏览器】
推荐最新版 Chrome 或 Edge；Safari、Firefox 也可以。需要支持 WebGL2。
如果双击后用了别的程序打开：右键文件 → 打开方式 → 选 Chrome / Edge / Safari。
有独立显卡的电脑可以在游戏“设置”里选“高”画质。

【操作】
  空格            分级：点火 / 分离 / 抛离助推器 / 开伞
  Shift / Ctrl    加大 / 减小油门（Z 全开，X 关闭）
  W/S  A/D  Q/E   俯仰 / 偏航 / 滚转
  ← / →           方向舵：直接设定火箭倾角
  T SAS   G 着陆腿   P 降落伞   M 地图   N 机动规划   V 相机
  , / . / /       时间加速 减 / 加 / 实时
  Esc             暂停菜单
鼠标拖动旋转视角，滚轮缩放。完整说明见项目 README 的“操作”一节。

【存档】
火箭设计、任务进度和录制的演示保存在浏览器里，不在这个文件中。
换浏览器、清除浏览器数据后看不到原来的存档；演示录像可以先在游戏里“导出”成文件保存。

【分享】
整个游戏就是“${html}”这一个文件，可以拷到 U 盘或直接发给朋友，对方双击即可游玩。
`,
  },
  {
    root: 'mobile',
    html: '火箭工坊-手机版.html',
    zip: '火箭工坊-手机版.zip',
    single: '火箭工坊-手机版.html',
    readme: (html, mb) => `火箭工坊 · 登月计划（手机版 · 离线下载包）

触屏操作，支持横屏和竖屏（飞行时横屏更好用）。整个游戏就是“${html}”这一个文件（约 ${mb} MB），
不需要联网，也不需要安装任何 App。手机浏览器需要支持 WebGL2。

【安卓手机 / 平板】
1. 用手机自带的“文件管理”或 Files by Google 打开下载的压缩包，解压。
   （也可以直接下载不压缩的“${html}”，省掉这一步。）
2. 点“${html}”，选择用 Chrome 打开（Edge、Firefox 也可以）。
   如果被别的程序打开、只显示文字或代码：长按文件 → 打开方式 → Chrome。
3. 等加载画面结束就可以开始造火箭了。

【iPhone / iPad】
iOS 自带的“文件”App 只能预览网页，不会运行网页里的程序，Safari 也不能打开手机里的本地文件，
所以这个离线包在 iPhone / iPad 上无法直接运行。可以在电脑上玩电脑版的下载包。

【平板外接键盘】
电脑版的快捷键（空格、Shift / Ctrl、W/A/S/D、Q/E、T、G、P、M、Esc 等）依然可用。

【存档】
火箭设计和任务进度保存在浏览器里，不在这个文件中。换浏览器、清除浏览器数据后会看不到原来的存档；
有的手机浏览器以本地文件方式打开网页时不允许保存，这时关掉页面后存档不会保留。

【在电脑上试玩】
手机版也可以用电脑浏览器打开（双击即可），用鼠标代替手指操作。
`,
  },
];

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

function dataUri(file) {
  const type = MIME[extname(file).toLowerCase()];
  if (!type) throw new Error(`不知道怎样内嵌 ${file}`);
  return `data:${type};base64,${readFileSync(file).toString('base64')}`;
}

const WORKER_RE = /new Worker\(\s*new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)\s*(?:,\s*\{[^}]*\})?\s*\)/g;
const LITERAL_RE = /(['"`])(?:\.\/)?([\w./-]+\.\w+)\1/g;

/**
 * 构建时把源码里的外部文件引用换成内嵌数据：
 * - new Worker(new URL('./x.ts', import.meta.url)) → Vite 的内嵌 Worker（运行时从 blob: 地址启动）；
 * - 指向 public/ 里贴图、演示录像的字符串（如 'textures/earth/day.jpg'）→ data: 地址。
 */
function inlineReferences(publicDir) {
  const publicFiles = new Set(listFiles(publicDir).filter((f) => MIME[extname(f).toLowerCase()]));
  let workers = 0;
  return {
    name: 'rocket-offline-inline',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!/\.[cm]?[jt]s$/.test(file) || file.includes('/node_modules/')) return null;
      const imports = [];
      const out = code
        .replace(WORKER_RE, (_, _q, spec) => {
          const name = `__offlineWorker${workers++}`;
          imports.push(`import ${name} from ${JSON.stringify(`${spec}?worker&inline`)};`);
          return `new ${name}()`;
        })
        .replace(LITERAL_RE, (m, _q, p) => (publicFiles.has(p) ? JSON.stringify(dataUri(join(publicDir, p))) : m));
      if (out === code) return null;
      return { code: `${imports.join('\n')}\n${out}`, map: null };
    },
  };
}

/** 把 vite build 的输出（index.html + assets/）合成一个不引用任何外部文件的网页。 */
function assemble(outDir, publicDir) {
  const used = new Set(['index.html']);
  const readOut = (ref) => {
    const rel = ref.replace(/^\.\//, '');
    used.add(rel);
    return readFileSync(join(outDir, rel), 'utf8');
  };
  let html = readFileSync(join(outDir, 'index.html'), 'utf8');

  const scripts = [];
  html = html
    // PWA 清单在本地文件里没有用
    .replace(/\s*<link rel="manifest"[^>]*>/g, () => '')
    .replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>\n${readOut(href).replace(/<\/style/gi, '<\\/style')}</style>`)
    // 模块脚本挪到 <body> 末尾：先把加载画面显示出来，再解析几十 MB 的脚本
    .replace(/\s*<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
      scripts.push(readOut(src));
      return '';
    })
    // 其余引用的本地文件（图标等）
    .replace(/(href|src)="\.\/([^"]+)"/g, (_, attr, rel) => `${attr}="${dataUri(join(publicDir, rel))}"`);
  if (scripts.length !== 1) throw new Error(`index.html 里应该正好有一个模块脚本，实际有 ${scripts.length} 个`);

  const js = scripts[0].replace(/<\/script/gi, '<\\/script');
  // 内联脚本里的 "<!--" 可能让 HTML 解析器提前结束脚本，出现时需要改写源码
  if (js.includes('<!--')) throw new Error('脚本里含有 "<!--"，不能直接内联到 <script> 中');
  html = html.replace('</body>', () => `<script type="module">\n${js}</script>\n</body>`);

  // 没能内嵌的 Worker、资源会作为单独的文件留在输出目录里
  const leftover = listFiles(outDir).filter((f) => !used.has(f));
  if (leftover.length) throw new Error(`这些构建产物没有被内嵌：${leftover.join(', ')}`);
  for (const f of listFiles(publicDir)) {
    if (MIME[extname(f).toLowerCase()] && ['"', "'", '`'].some((q) => html.includes(`${f}${q}`))) {
      throw new Error(`网页里仍然引用了外部文件 ${f}`);
    }
  }
  return html;
}

/** 最小的 ZIP 写入器（deflate，文件名按 UTF-8 存储并设置对应标志位，Windows / macOS 都能正确显示中文名）。 */
function zip(entries) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    parts.push(head, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const v of VARIANTS) {
  const root = resolve(v.root);
  const publicDir = join(root, 'public');
  const outDir = join(TMP, v.root === '.' ? 'desktop' : v.root);
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    // 源码里可以用 import.meta.env.MODE === 'offline' 区分离线包（例如手机版不注册 Service Worker）
    mode: 'offline',
    logLevel: 'warn',
    plugins: [inlineReferences(publicDir)],
    // file:// 页面的源是不透明的（null），浏览器不允许从它的 blob: 地址启动模块 Worker，只能用经典 Worker
    worker: { format: 'iife' },
    build: {
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      modulePreload: false,
      assetsInlineLimit: () => true,
    },
  });
  const html = Buffer.from(assemble(outDir, publicDir));
  const readme = Buffer.from(`﻿${v.readme(v.html, Math.ceil(html.length / 1024 / 1024))}`.replace(/\n/g, '\r\n'));
  const pkg = zip([
    { name: v.html, data: html },
    { name: '使用说明.txt', data: readme },
  ]);
  writeFileSync(join(OUT, v.single), html);
  writeFileSync(join(OUT, v.zip), pkg);
  console.log(`${v.zip}  ${mb(pkg.length)} MB（网页 ${mb(html.length)} MB）`);
}
rmSync(TMP, { recursive: true, force: true });
console.log(`下载包已生成：${relative('.', OUT)}/`);
