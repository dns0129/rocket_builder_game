# 火箭工坊 · 电脑客户端

把游戏装成普通的电脑程序：在自己的窗口里运行（没有浏览器的地址栏和标签页），有桌面图标和开始菜单 / 启动台入口，不需要浏览器、Node.js，也不需要联网。用 [Electron](https://www.electronjs.org/) 实现，内容就是仓库根目录 `vite build` 生成的电脑版游戏。

## 生成安装包

在仓库根目录：

```bash
npm install
npm run app                          # 只打当前系统的包
npm run app -- --win --mac --linux   # 三个平台一起打
```

脚本（`scripts/build-app.mjs`）会先 `vite build`，第一次运行时在 `desktop/` 里 `npm ci`（Electron 只在打包时需要，不影响玩家用的 `Start Game`），然后用 electron-builder 打包，输出到 `release/app/`：

| 文件 | 平台 | 用法 |
| --- | --- | --- |
| `火箭工坊-安装程序-<版本>-Windows.exe` | Windows 10 / 11（64 位） | 安装程序（中文界面，可选安装位置，创建桌面和开始菜单快捷方式） |
| `火箭工坊-<版本>-macOS-AppleSilicon.zip` | macOS 13+，Apple 芯片 | 解压得到 `火箭工坊.app`，拖进“应用程序” |
| `火箭工坊-<版本>-macOS-Intel.zip` | macOS 13+，Intel 芯片 | 同上 |
| `火箭工坊-<版本>-Linux-x86_64.AppImage` | Linux（64 位） | `chmod +x` 后直接运行 |

跨平台打包需要的工具：

- **在 Linux / macOS 上打 Windows 包**：需要 Wine，并且要有 32 位支持（安装程序本身是 32 位的，electron-builder 要运行它来生成卸载程序）。Ubuntu：`sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine64 wine32:i386`。
- **在 Linux / Windows 上打 macOS 包**：electron-builder 只能在 Mac 上签名，而 Apple 芯片的 Mac 拒绝运行签名无效的程序，所以脚本用 [rcodesign](https://github.com/indygreg/apple-platform-rs/releases)（发布页里的 `apple-codesign`）做 ad-hoc 签名，再用 `zip -y` 压缩（保留框架里的符号链接）。把 `rcodesign` 放进 `PATH`，或者设置环境变量 `RCODESIGN`。在 Mac 上打包时 electron-builder 自己做 ad-hoc 签名（`mac.identity: "-"`）。

安装包都**没有正式的代码签名**（需要付费的开发者证书），所以第一次运行时系统会提醒：

- Windows：“Windows 已保护你的电脑” → 点“更多信息” → “仍要运行”。
- macOS：提示无法验证开发者 → 打开 **系统设置 → 隐私与安全性**，在页面底部点 **“仍要打开”**。

## 开发时运行

```bash
npm run build          # 在仓库根目录生成 dist/
cd desktop
npm install
npm start              # 用 dist/ 里的游戏打开客户端窗口
```

## 实现要点（`main.cjs`）

- **游戏文件**：打包时把 `dist/` 复制到 `resources/game`（`extraResources`），通过自定义协议 `rocket://game/` 提供。和 http 一样能加载模块脚本、模块 Worker、贴图和演示录像，存档也按这个固定的源保存。
- **存档位置**：`<应用数据目录>/RocketWorkshop`（Windows `%APPDATA%\RocketWorkshop`，macOS `~/Library/Application Support/RocketWorkshop`，Linux `~/.config/RocketWorkshop`），卸载时保留。必须显式设置：Electron 会把非 ASCII 的应用名“火箭工坊”处理成空目录名，数据就直接散落在应用数据目录的根下。和浏览器版的存档不互通。
- **没有菜单栏**（Windows / Linux）：默认菜单的 Ctrl+W（关闭）、Ctrl+R（刷新）会和游戏操作冲突（按住 Ctrl 减油门时再按 W 俯仰）。另外提供 F11 全屏、F12 开发者工具。macOS 的菜单快捷键用 Command，不冲突，保留常用菜单。
- **飞行中关闭窗口**：游戏在飞行中拦下 `beforeunload`。浏览器会弹出“确定离开”提示，Electron 却会直接取消关闭、什么都不显示，所以在 `will-prevent-unload` 里弹出“正在飞行中，确定要退出吗？”。
- **其他**：窗口默认最大化，加载画面画出来后再显示（最多等 3 秒）；只允许运行一个实例，再次打开时切到已有窗口；外部链接用系统浏览器打开；有独立显卡的笔记本优先用独立显卡。
- **名字**：显示名称是“火箭工坊”（窗口标题、快捷方式、开始菜单、程序和功能、macOS 的 `火箭工坊.app`），可执行文件用 ASCII 名（Windows `RocketWorkshop.exe`，Linux `rocket-workshop`），安装目录是 `%LOCALAPPDATA%\Programs\RocketWorkshop`。
- **图标**：`build/icon.png`（macOS 规格，留边的圆角方块）和 `build/icon-win.png`（Windows / Linux），1024×1024，由 `mobile/public/icons/icon.svg` 渲染。
