## 下载哪个？

| 我的设备 | 下载 | 怎么装 |
| --- | --- | --- |
| **Windows 10 / 11 电脑** | `RocketWorkshop-Setup-…-Windows-x64.exe` | 双击，按提示安装。装好后桌面和开始菜单里有“火箭工坊” |
| **Mac（Apple 芯片：M1 / M2 / M3 / M4…）** | `RocketWorkshop-…-macOS-AppleSilicon.zip` | 双击解压，把“火箭工坊.app”拖进“应用程序”文件夹 |
| **Mac（Intel 芯片）** | `RocketWorkshop-…-macOS-Intel.zip` | 同上 |
| Linux 电脑 | `RocketWorkshop-…-Linux-x86_64.AppImage` | `chmod +x` 后双击运行 |
| 安卓手机 / 平板 | `RocketWorkshop-Offline-Mobile.zip` | 解压，用 Chrome 打开里面的 `.html`（触屏版，单文件、离线） |
| 不想安装、用浏览器玩 | `RocketWorkshop-Offline-Desktop.zip` | 解压，双击 `火箭工坊.html` |

不知道 Mac 是哪种芯片：点左上角 → “关于本机”，“芯片”一栏写着 Apple M… 就是 Apple 芯片，写着 Intel 就是 Intel。

电脑客户端在**独立窗口**中运行，不需要浏览器、也不需要联网。窗口默认最大化，**F11** 全屏，**F12** 开发者工具（报告问题时用）。飞行中关闭窗口会先确认。

## 第一次打开时的安全提示

安装包没有付费的代码签名，系统会提醒一次：

- **Windows**：出现“Windows 已保护你的电脑”时，点 **“更多信息”** → **“仍要运行”**。
- **macOS**：提示无法验证开发者时先点“完成”，然后打开 **系统设置 → 隐私与安全性**，在页面底部点 **“仍要打开”**，再确认一次。之后就能正常打开了。

## 存档

电脑客户端的存档保存在 `%APPDATA%\RocketWorkshop`（Windows）或 `~/Library/Application Support/RocketWorkshop`（macOS），卸载、升级都会保留；和浏览器版的存档不互通。

需要：Windows 10 / 11（64 位）、macOS 13 及以上，显卡支持 WebGL2（近几年的电脑都可以）。
