// 生成电脑客户端安装包（用法：npm run app；指定平台：npm run app -- --win --mac --linux）。
// 客户端在 desktop/（Electron），游戏在独立窗口中运行，不需要浏览器和网络。
//   1. vite build 生成游戏（dist/），打包时复制进客户端；
//   2. desktop/ 还没装依赖时先 npm ci（Electron 和 electron-builder 只在打包时需要，不影响玩家用的 Start Game）；
//   3. electron-builder 打包，输出到 release/app/：
//        Windows：火箭工坊-安装程序-<版本>-Windows.exe（NSIS 安装程序）
//        macOS：  火箭工坊-<版本>-macOS-AppleSilicon.zip / -Intel.zip（解压得到 火箭工坊.app）
//        Linux：  火箭工坊-<版本>-Linux-x86_64.AppImage
//   4. macOS 版：electron-builder 只能在 Mac 上签名，Apple 芯片的 Mac 又拒绝运行签名无效的程序，
//      所以在 Linux / Windows 上用 rcodesign 做 ad-hoc 签名，再压缩成 zip（保留框架里的符号链接）。
// 不指定平台时只打当前系统的包。在 Linux / macOS 上打 Windows 包需要 Wine（含 32 位支持），
// 在 Linux / Windows 上打 macOS 包需要 rcodesign（https://github.com/indygreg/apple-platform-rs/releases 的 apple-codesign）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const DESKTOP = join(ROOT, 'desktop');
const OUT = join(ROOT, 'release', 'app');
const MAC_ARCH_NAMES = { 'mac-arm64': 'AppleSilicon', mac: 'Intel', 'mac-universal': 'Universal' };

const args = process.argv.slice(2);
const want = (flag, platform) => args.includes(flag) || (!args.some((a) => ['--win', '--mac', '--linux'].includes(a)) && process.platform === platform);
const targets = { win: want('--win', 'win32'), mac: want('--mac', 'darwin'), linux: want('--linux', 'linux') };

function run(cmd, cmdArgs, opts = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} 失败（退出码 ${r.status}）`);
}

function has(cmd, cmdArgs = ['--version']) {
  return spawnSync(cmd, cmdArgs, { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
}

if (targets.win && process.platform !== 'win32' && !has('wine')) {
  throw new Error('在 Linux / macOS 上打包 Windows 安装程序需要 Wine（含 32 位支持），或者在 Windows 上运行 npm run app');
}
const rcodesign = process.env.RCODESIGN || 'rcodesign';
if (targets.mac && process.platform !== 'darwin' && !has(rcodesign)) {
  throw new Error('在 Linux / Windows 上打包 macOS 版需要 rcodesign：下载 https://github.com/indygreg/apple-platform-rs/releases 中的 apple-codesign，放进 PATH 或设置环境变量 RCODESIGN');
}

run('npx', ['vite', 'build', '--logLevel', 'warn']);
if (!existsSync(join(DESKTOP, 'node_modules', 'electron-builder'))) run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: DESKTOP });

const platformFlags = Object.entries(targets)
  .filter(([, on]) => on)
  .map(([p]) => `--${p}`);
if (!platformFlags.length) throw new Error('没有要打包的平台');
run(process.execPath, [join(DESKTOP, 'node_modules', 'electron-builder', 'cli.js'), ...platformFlags, '--publish', 'never'], { cwd: DESKTOP, shell: false });

if (targets.mac) {
  const { version } = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
  for (const dir of readdirSync(OUT).filter((d) => d in MAC_ARCH_NAMES)) {
    const appDir = join(OUT, dir);
    const app = readdirSync(appDir).find((f) => f.endsWith('.app'));
    if (!app) continue;
    // 在 Mac 上 electron-builder 已经按 mac.identity = "-" 做了 ad-hoc 签名
    if (process.platform !== 'darwin') run(rcodesign, ['sign', join(appDir, app)], { stdio: ['ignore', 'ignore', 'inherit'] });
    const zip = join(OUT, `火箭工坊-${version}-macOS-${MAC_ARCH_NAMES[dir]}.zip`);
    rmSync(zip, { force: true });
    if (process.platform === 'darwin') run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], { cwd: appDir });
    else run('zip', ['-qry', zip, app], { cwd: appDir });
  }
}

console.log(`\n安装包已生成：${OUT}`);
for (const f of readdirSync(OUT).filter((f) => /\.(exe|zip|AppImage)$/.test(f))) console.log(`  ${f}`);
