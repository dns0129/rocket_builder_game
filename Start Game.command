#!/bin/bash
# 火箭工坊：macOS 一键启动。在访达（Finder）里双击运行即可。
# 这个文件必须是 LF 换行并带有可执行权限（见 .gitattributes）。

cd "$(dirname "$0")" || exit 1
printf '\033]0;火箭工坊 · 启动游戏\007'

# PATH 里找不到 node 时，再到 Homebrew（Apple 芯片 / Intel）与 Volta 的常见位置找（放在最后，不覆盖用户自己选的版本）
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin"

pause_exit() {
  echo
  read -n 1 -s -r -p "按任意键关闭……"
  echo
  exit "${1:-1}"
}

echo
echo "  ======================================"
echo "     火箭工坊 · 登月与行星际飞行"
echo "  ======================================"
echo

# ---------------------------------------------------------------- 1. Node.js
# 用 nvm 安装的 Node.js 不在 PATH 里时，尝试加载 nvm
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

# Vite 需要 Node.js 20.19 以上或 22.12 以上
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=23?0:1)"
}

if ! node_ok; then
  if command -v node >/dev/null 2>&1; then
    echo "Node.js 版本太旧（当前 v$(node -p 'process.versions.node')），需要 22.12 或更新的 LTS 版本。"
  else
    echo "没有找到 Node.js。运行游戏需要它，只需安装一次。"
  fi
  echo
  installed=0
  if command -v brew >/dev/null 2>&1; then
    read -r -p "是否现在用 Homebrew 自动安装 Node.js？[Y/n] " answer
    case "$answer" in
      [Nn]*) ;;
      *)
        # 已用 Homebrew 装过但版本旧时，brew install 会直接升级
        brew install node
        hash -r
        node_ok && installed=1
        ;;
    esac
  fi
  if [ "$installed" != 1 ]; then
    echo "请在打开的网页中下载并安装 Node.js（LTS 版，macOS 安装包），装好后再双击“Start Game.command”。"
    open "https://nodejs.org/"
    pause_exit 1
  fi
  echo
fi
echo "[1/3] Node.js v$(node -p 'process.versions.node')"

# ---------------------------------------------------------------- 2. 依赖
# 第一次运行，或 package-lock.json 有变化（例如拉取了新版本）时才安装。
# 标记文件按平台区分：Vite 的打包器带有原生模块，从别的电脑拷来的 node_modules 不能直接用。
lock_mark="node_modules/.rocket-lock-$(node -p 'process.platform+"-"+process.arch')"
if [ -f "node_modules/vite/package.json" ] && cmp -s "package-lock.json" "$lock_mark"; then
  echo "[2/3] 依赖已安装"
else
  echo "[2/3] 正在安装依赖（需要联网，第一次约需 1 分钟）……"
  if ! npm install --no-audit --no-fund; then
    echo
    echo "依赖安装失败。请检查网络连接后重新双击“Start Game.command”。"
    echo "如果在中国大陆网络较慢，可以先在终端执行：npm config set registry https://registry.npmmirror.com"
    pause_exit 1
  fi
  cp "package-lock.json" "$lock_mark"
fi

# ---------------------------------------------------------------- 3. 构建并启动
echo "[3/3] 正在构建游戏……"
if ! npx vite build --logLevel warn; then
  echo
  echo "构建失败，请把上面的错误信息发给开发者。"
  pause_exit 1
fi

echo
echo "  游戏已启动，浏览器会自动打开。"
echo "  如果没有自动打开，请在浏览器中访问下面显示的地址（通常是 http://localhost:4173/）。"
echo "  推荐使用 Chrome、Edge 或 Safari。玩完后按 Control+C 或直接关闭这个窗口即可退出。"
echo
# 用系统默认浏览器打开（不设置的话，Vite 会尝试用 AppleScript 控制已打开的 Chrome，触发“自动化”权限弹窗）
export BROWSER="${BROWSER:-open}"
npx vite preview --host 127.0.0.1 --port 4173 --open
