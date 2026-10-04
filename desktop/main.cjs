// 火箭工坊电脑客户端：用 Electron 在独立窗口中运行游戏，不需要浏览器，也不需要联网。
// 游戏文件是仓库根目录 vite build 的输出（dist/），打包时复制到 resources/game，
// 通过自定义协议 rocket://game/ 提供：和 http 一样能加载模块脚本、Worker、贴图和演示录像，
// 存档（localStorage / IndexedDB）也按这个固定的源保存在用户数据目录里。
const { app, BrowserWindow, Menu, dialog, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 与 package.json 里 build.appId 一致（打包后的 package.json 不保留 build 字段，所以写在这里）
const APP_ID = 'io.github.dns0129.rocket-builder-game';
const SCHEME = 'rocket';
const ORIGIN = `${SCHEME}://game`;
const GAME_DIR = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// 存档、缓存放在 <应用数据目录>/RocketWorkshop（Windows 是 %APPDATA%\RocketWorkshop）。
// 不能用默认值：Electron 会把非 ASCII 的应用名“火箭工坊”处理成空目录名，数据就直接散落在应用数据目录的根下。
// 必须在 requestSingleInstanceLock 之前设置，单实例锁文件也放在这里
app.setPath('userData', path.join(app.getPath('appData'), 'RocketWorkshop'));

// 笔记本同时有集成显卡和独立显卡时，用独立显卡渲染
app.commandLine.appendSwitch('force_high_performance_gpu');

/** @type {BrowserWindow | null} */
let win = null;

function serveGame(request) {
  const { host, pathname } = new URL(request.url);
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.join(GAME_DIR, rel);
  if (host !== 'game' || !file.startsWith(GAME_DIR + path.sep)) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

function isExternal(url) {
  return /^(https?|mailto):/i.test(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#05070b',
    title: '火箭工坊 · 登月计划',
    // Windows / macOS 用安装包里的图标；Linux 的窗口图标要单独指定
    icon: process.platform === 'linux' ? path.join(__dirname, 'build', 'icon.png') : undefined,
    webPreferences: {
      // 游戏音效不必等第一次点击才能播放
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });
  // 页面画出第一帧（加载画面）再显示，避免白屏闪一下；万一迟迟没有画出来，3 秒后也显示窗口
  const reveal = () => {
    if (!win || win.isVisible()) return;
    win.maximize();
    win.show();
  };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 3000);
  win.on('closed', () => {
    win = null;
  });

  // 飞行中游戏会拦下 beforeunload（防止误关页面）。浏览器会弹出“确定离开”提示，
  // Electron 却会直接取消关闭、什么也不显示——窗口就关不掉了，所以这里自己问一次
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: '火箭工坊',
      message: '正在飞行中，确定要退出吗？',
      detail: '这次飞行的进度不会保存。',
      buttons: ['退出', '继续飞行'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) e.preventDefault();
  });

  // 游戏里的外部链接用系统浏览器打开，窗口本身只显示游戏
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    e.preventDefault();
    if (isExternal(url)) shell.openExternal(url);
  });

  // 没有菜单栏，所以手动提供两个快捷键：F11 全屏，F12 开发者工具（报告问题时用）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.alt || input.control || input.meta || input.shift) return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.loadURL(`${ORIGIN}/index.html`);
}

function setMenu() {
  if (process.platform !== 'darwin') {
    // Windows / Linux 不要菜单：默认菜单的 Ctrl+W（关闭）、Ctrl+R（刷新）等快捷键会和游戏操作冲突——
    // 飞行时按住 Ctrl 减油门再按 W 俯仰，就会把窗口关掉
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS 的快捷键用 Command，不会和游戏的 Ctrl / 字母键冲突，保留常用菜单
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: '显示', submenu: [{ role: 'togglefullscreen', label: '进入 / 退出全屏' }, { role: 'toggleDevTools', label: '开发者工具' }] },
      { role: 'windowMenu' },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  // 游戏已经开着：把已有的窗口调到前面（见 second-instance），这里直接退出
  app.quit();
} else {
  // 与安装包里快捷方式的 AppUserModelID 一致，任务栏上固定的图标和运行中的窗口才会合并
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    protocol.handle(SCHEME, serveGame);
    setMenu();
    createWindow();
  });
}
