# 桌面端 + Live2D 实时形象 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ai-mate-soul 增加 Electron 桌面端（托盘/通知/自启/置顶形象小窗），并在网页与桌面端接入 Live2D 形象——嘴型随 TTS/通话语音起伏、表情随情绪切换，网页模式零回归。

**Architecture:** Electron 主进程 spawn 系统 Node 子进程运行现有 `src/index.js`（后端零结构性改动），渲染进程加载 `http://127.0.0.1:3000`。Live2D 用 PixiJS + pixi-live2d-display 渲染，主窗口与透明小窗共用 `avatar.js`；音频振幅与情绪通过同源 `BroadcastChannel` 从主窗口广播给小窗。

**Tech Stack:** Electron、PixiJS 7、pixi-live2d-display 0.4（Cubism 4）、BroadcastChannel、现有 Express/Socket.IO。

**设计文档:** `docs/superpowers/specs/2026-09-10-desktop-live2d-design.md`

**TDD 偏差说明:** 本项目无测试框架（项目 CLAUDE.md 明确验证方式为启动服务手动调用 API），每个任务以"启动验证步骤 + 手动检查点"代替自动化测试，对抗性用例集中在 Task 10。

**给执行者的注意事项:**
- Windows 环境，bash shell；涉及外网下载的命令必须带 `export http_proxy=socks5://127.0.0.1:10808 https_proxy=socks5://127.0.0.1:10808`
- 所有新文件用 UTF-8 编码，注释用中文
- 项目纯 ESM，import 带 `.js` 扩展名
- 改文件前先重新读取该文件（内容可能已变化）
- 提交信息用中文 conventional commits 风格（参考 `git log --oneline -5`）

---

## 文件结构总览

```
新增:
  src/desktop/main.js           Electron 主进程入口：单实例锁、权限、生命周期、启动编排
  src/desktop/serviceManager.js spawn/守护 node 子进程：健康检查、指数退避重启、日志尾部
  src/desktop/windows.js        主窗口（关窗驻留托盘）+ 透明置顶形象小窗
  src/desktop/tray.js           托盘菜单：显示主窗/小窗显隐/开机自启/退出
  public/live2d/avatar.js       Live2D 渲染封装：加载/idle/视线/嘴型/表情，两窗口共用
  public/live2d/overlay.html    小窗页面（同源加载，保证 BroadcastChannel 可用）
  public/live2d/vendor/         pixi.min.js、cubism4.min.js（MIT，入库）
  public/live2d/models/haru/    官方示例模型（gitignore，不入库）
  public/live2d/live2dcubismcore.min.js  Cubism Core（gitignore，不入库）

修改:
  package.json                  main→src/desktop/main.js，新增 desktop 脚本与 devDeps
  .gitignore                    追加 live2d Core 与 models
  src/index.js                  聊天路由完成后新增 io.emit('avatar:emotion', …)（唯一后端改动）
  public/index.html             形象区域/三个音频播放点接入振幅/通话 analyser/情绪监听/重连遮罩/系统通知
  CHANGE.md / CLAUDE.md         迭代记录与引用同步
```

---

### Task 1: 桌面壳骨架——Electron 启动并包住现有服务

**Files:**
- Create: `src/desktop/serviceManager.js`
- Create: `src/desktop/windows.js`
- Create: `src/desktop/main.js`
- Modify: `package.json`

- [ ] **Step 1: 安装 Electron**

```bash
export http_proxy=socks5://127.0.0.1:10808 https_proxy=socks5://127.0.0.1:10808
npm install -D electron
```

预期：安装完成无报错；`npx electron --version` 输出版本号。

- [ ] **Step 2: 编写 `src/desktop/serviceManager.js`（完整文件）**

```js
// 桌面端后端守护：spawn 系统 Node 跑 src/index.js，健康检查 + 指数退避自动重启
import { spawn } from 'node:child_process';
import http from 'node:http';

const HEALTH_URL = 'http://127.0.0.1:3000/';
const MAX_CONSECUTIVE_FAILS = 5;   // 连续崩溃次数上限，超过后停止重启
const STABLE_RUN_MS = 60_000;      // 运行超过此时长视为稳定，重置崩溃计数

let child = null;
let stopping = false;
let consecutiveFails = 0;
let startedAt = 0;
const logTail = [];                 // 子进程日志尾部（崩溃弹窗展示用）
const stateListeners = [];

function emitState(state, extra = {}) {
  for (const fn of stateListeners) fn({ state, ...extra });
}

export function onState(fn) {
  stateListeners.push(fn);
}

export function getLogTail() {
  return logTail.join('\n');
}

function pushLog(stream, chunk) {
  for (const line of chunk.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    logTail.push(line);
    if (logTail.length > 50) logTail.shift();
  }
  // 转发到桌面端主进程 stdout，便于开发期排查
  stream.write(chunk);
}

export function start(rootDir) {
  stopping = false;
  _spawn(rootDir);
}

function _spawn(rootDir) {
  startedAt = Date.now();
  child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', ['src/index.js'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  emitState('starting');
  child.stdout.on('data', (c) => pushLog(process.stdout, c));
  child.stderr.on('data', (c) => pushLog(process.stderr, c));

  child.on('exit', (code) => {
    if (stopping) return;
    emitState('down', { code });
    // 稳定运行过则重置计数
    if (Date.now() - startedAt > STABLE_RUN_MS) consecutiveFails = 0;
    consecutiveFails += 1;
    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      emitState('failed', { log: getLogTail() });
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (consecutiveFails - 1));
    emitState('restarting', { delay, consecutiveFails });
    setTimeout(() => { if (!stopping) _spawn(rootDir); }, delay);
  });
}

export function stop() {
  stopping = true;
  if (!child) return;
  if (process.platform === 'win32') {
    // Windows 下杀整棵进程树，避免子进程残留占用端口
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
  child = null;
}

// 健康检查：轮询后端根路径，服务就绪返回 true，超时（timeoutMs）返回 false
export function waitHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(timer); resolve(false); return; }
      const req = http.get(HEALTH_URL, (res) => {
        res.resume();
        clearInterval(timer);
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {});
      req.setTimeout(1500, () => req.destroy());
    }, 500);
  });
}
```

- [ ] **Step 3: 编写 `src/desktop/windows.js`（完整文件）**

```js
// 窗口管理：主窗口（关窗驻留托盘）+ 透明置顶形象小窗
import { BrowserWindow } from 'electron';

const HOME = 'http://127.0.0.1:3000';

let mainWindow = null;
let overlayWindow = null;

export function getMainWindow() {
  return mainWindow;
}

export function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    autoHideMenuBar: true,
    icon: undefined, // Task 2 生成图标后填入路径
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadURL(HOME);
  // 关窗 = 隐藏到托盘（后端子进程继续跑，主动消息不断线）；真正退出走托盘菜单
  mainWindow.on('close', (e) => {
    if (BrowserWindow.getAllWindows().length && !global.__quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

export function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

export function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.show(); return overlayWindow; }
  overlayWindow = new BrowserWindow({
    width: 360,
    height: 520,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 必须从同一 HTTP 源加载（同源才能用 BroadcastChannel 收主窗口的振幅/情绪）
  overlayWindow.loadURL(`${HOME}/live2d/overlay.html`);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

export function toggleOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide();
  else createOverlayWindow();
}
```

- [ ] **Step 4: 编写 `src/desktop/main.js`（完整文件）**

```js
// Electron 主进程入口：单实例锁 → 麦克风权限 → 端口预检 → 起后端 → 等健康 → 开窗
import { app, session, dialog } from 'electron';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { start as startService, stop as stopService, onState, waitHealth } from './serviceManager.js';
import { createMainWindow, showMainWindow } from './windows.js';
import { createTray } from './tray.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3000;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(boot);
  app.on('before-quit', () => { global.__quitting = true; stopService(); });
  app.on('window-all-closed', () => { /* 关窗驻留托盘，不退出 */ });
}

function isForeignServerOnPort(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1', timeout: 800 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function boot() {
  // 麦克风/通知权限放行（Electron 内无需 HTTPS 即可用麦克风）
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(permission));
  });

  // 端口预检：被占用说明有外部进程（单实例锁已排除自家实例），明确报错而不是反复重启
  if (await isForeignServerOnPort(PORT)) {
    dialog.showErrorBox('端口被占用',
      `${PORT} 端口已被其他程序占用（可能是残留的 node 进程）。\n请结束该进程后重新启动。`);
    app.quit();
    return;
  }

  startService(ROOT);
  onState((s) => {
    if (s.state === 'failed') {
      dialog.showErrorBox('后端服务启动失败', '子进程连续崩溃，日志尾部：\n\n' + (s.log || '(无日志)'));
    }
  });

  const ok = await waitHealth();
  if (!ok) {
    dialog.showErrorBox('后端服务未就绪', '等待 30 秒后服务仍未启动，请检查端口与依赖后重试。');
    app.quit();
    return;
  }

  createMainWindow();
  createTray(ROOT);
}
```

注意：`createTray` 在 Task 2 才实现，本任务先在 `src/desktop/tray.js` 放一个空实现占位并提交，Task 2 填充：

```js
// 临时占位，Task 2 实现
import { app } from 'electron';
export function createTray() {
  void app;
}
```

- [ ] **Step 5: 修改 `package.json`**

`main` 字段改为 `"src/desktop/main.js"`，scripts 增加：

```json
"desktop": "electron .",
"desktop:dev": "electron ."
```

（保留原 `start`/`dev` 不动；`node` CLI 不读 `main` 字段，网页模式不受影响。）

- [ ] **Step 6: 验证桌面模式启动**

```bash
npm run desktop
```

预期：数秒后弹出主窗口，显示现有聊天界面；任务栏有关闭按钮；关闭窗口后进程仍在（任务管理器可见 electron/node）；`npm start`（网页模式）照常可用。

- [ ] **Step 7: 验证单实例锁与退出**

再跑一次 `npm run desktop`，预期聚焦已有窗口而非新开实例。用托盘尚未实现，直接在第一个终端 Ctrl+C 退出并确认 node 子进程结束（`tasklist | grep node`）。

- [ ] **Step 8: 提交**

```bash
git add src/desktop package.json package-lock.json
git commit -m "feat(desktop): Electron 壳骨架——子进程守护后端、单实例锁、关窗驻留"
```

---

### Task 2: 托盘、开机自启、应用图标

**Files:**
- Create: `public/icons/icon.png`（由现有 icon.svg 生成，一次性脚本）
- Modify: `src/desktop/tray.js`（填充实现）
- Modify: `src/desktop/windows.js`（主窗口 icon 路径）
- Modify: `src/desktop/main.js`（接自启开关状态）

- [ ] **Step 1: 用 playwright 把 icon.svg 渲染成 64×64 png**

写 `.scratch/make-icon.cjs`（CommonJS，放 scratch 不入库）：

```js
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  await page.goto('file:///' + path.resolve('public/icons/icon.svg').replace(/\\/g, '/'));
  await page.screenshot({ path: 'public/icons/icon.png', omitBackground: true });
  await browser.close();
  console.log('icon.png 已生成');
})();
```

运行：`node .scratch/make-icon.cjs`，预期生成 `public/icons/icon.png`。

- [ ] **Step 2: 实现 `src/desktop/tray.js`（完整文件，替换占位）**

```js
// 托盘：显示主窗 / 形象小窗显隐 / 开机自启开关 / 退出
import { app, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { showMainWindow, toggleOverlayWindow } from './windows.js';

let tray = null;
const prefsPath = () => path.join(app.getPath('userData'), 'desktop-prefs.json');

export function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch { return {}; }
}

function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
  fs.writeFileSync(prefsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function applyAutoLaunch(enabled) {
  // 开发模式下 execPath 是 electron.exe，带 args 指向应用目录；打包后天然正确
  app.setLoginItemSettings({ openAsHidden: true, path: process.execPath, args: [path.resolve('.')], enabled });
}

export function createTray(rootDir) {
  const icon = nativeImage.createFromPath(path.join(rootDir, 'public/icons/icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('AI Mate Soul');

  const rebuild = () => {
    const prefs = readPrefs();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { label: '形象小窗', click: toggleOverlayWindow },
      { type: 'separator' },
      { label: '开机自启', type: 'checkbox', checked: !!prefs.autoLaunch,
        click: (item) => { writePrefs({ autoLaunch: item.checked }); applyAutoLaunch(item.checked); } },
      { type: 'separator' },
      { label: '退出', click: () => { global.__quitting = true; app.quit(); } },
    ]));
  };
  rebuild();
  // 恢复上次的自启设置（首次无记录则默认关）
  const prefs = readPrefs();
  if (prefs.autoLaunch) applyAutoLaunch(true);
}
```

注意：删掉 `os` 相关行后本文件最终版以上方代码为准（无 `os` import）。

- [ ] **Step 3: 主窗口与崩溃托盘提示接线**

`src/desktop/windows.js` 中 `createMainWindow` 的 `icon: undefined` 改为：

```js
    icon: path.join(rootDirArg, 'public/icons/icon.png'),
```

为此给 `createMainWindow(rootDirArg)` 增加参数，`main.js` 调用处改为 `createMainWindow(ROOT)`（`windows.js` 顶部 `import path from 'node:path';`）。

`src/desktop/main.js` 的 `onState` 回调追加托盘气泡（把 `onState` 移到 `createTray` 之后执行，`tray.js` 导出 `showBalloon`）：

```js
// tray.js 追加导出
export function showBalloon(title, content) {
  if (tray) tray.displayBalloon({ iconType: 'info', title, content });
}
```

```js
// main.js 中 onState 迁移到 createTray 之后：
onState((s) => {
  if (s.state === 'failed') {
    dialog.showErrorBox('后端服务启动失败', '子进程连续崩溃，日志尾部：\n\n' + (s.log || '(无日志)'));
  } else if (s.state === 'restarting') {
    showBalloon('服务重启中', `后端进程异常退出，${Math.round(s.delay / 1000)} 秒后自动重启（第 ${s.consecutiveFails} 次）`);
  }
});
```

- [ ] **Step 4: 验证**

`npm run desktop`：托盘出现图标；右键菜单四项可用；勾选"开机自启"后重启资源管理器级验证可跳过，检查 `app.getLoginItemSettings().openAtLogin === true` 即可（临时在 boot 里 console.log）；关闭主窗口 → 托盘驻留，托盘"显示主窗口"恢复；托盘"退出" → 进程树全部结束。

- [ ] **Step 5: 提交**

```bash
git add src/desktop public/icons/icon.png
git commit -m "feat(desktop): 托盘菜单、系统气泡提示与开机自启开关"
```

---

### Task 3: 前端重连遮罩（子进程崩溃时的 UI 表现）

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 加遮罩 DOM 与样式**

`public/index.html` 的 `<body>` 末尾（现有脚本之前）加：

```html
<div id="connMask" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);
     color:#fff;align-items:center;justify-content:center;font-size:15px;">
  <div style="text-align:center;">
    <div style="font-size:28px;margin-bottom:10px;">💢</div>
    <div>连接已断开，正在重连…</div>
  </div>
</div>
```

（默认 `display:none`；显示时 JS 置为 `flex`。）

- [ ] **Step 2: 挂 socket 断连监听**

在 `const socket = io();`（约 701 行）之后加：

```js
// 桌面端后端子进程崩溃/重启时给出全屏遮罩，恢复后自动消失
const connMask = document.getElementById('connMask');
socket.on('disconnect', () => { connMask.style.display = 'flex'; });
socket.on('connect', () => { connMask.style.display = 'none'; });
```

（Socket.IO 默认自动重连，子进程恢复后 `connect` 会再次触发。）

- [ ] **Step 3: 验证（对抗：杀子进程）**

`npm run desktop` 聊天中用任务管理器 kill `node.exe` 子进程：预期主窗口出现遮罩，数秒后子进程自动重启、遮罩消失，聊天恢复。

- [ ] **Step 4: 提交**

```bash
git add public/index.html
git commit -m "feat(desktop): 后端断连全屏遮罩，恢复自动消失"
```

---

### Task 4: Live2D 资产获取（vendor 库、Cubism Core、示例模型）

**Files:**
- Create: `public/live2d/vendor/pixi.min.js`、`public/live2d/vendor/cubism4.min.js`（MIT，入库）
- Create: `public/live2d/live2dcubismcore.min.js`（专有许可，**不入库**）
- Create: `public/live2d/models/haru/`（官方示例模型，**不入库**）
- Modify: `.gitignore`

- [ ] **Step 1: 安装前端库并拷贝 vendor 文件**

```bash
export http_proxy=socks5://127.0.0.1:10808 https_proxy=socks5://127.0.0.1:10808
npm install -D pixi.js@^7.4.0 pixi-live2d-display@^0.4.0
mkdir -p public/live2d/vendor public/live2d/models
cp node_modules/pixi.js/dist/pixi.min.js public/live2d/vendor/
cp node_modules/pixi-live2d-display/dist/cubism4.min.js public/live2d/vendor/
cp node_modules/pixi-live2d-display/dist/index.min.js public/live2d/vendor/pixi-live2d-display.min.js
```

- [ ] **Step 2: 下载 Cubism Core（官方 CDN）**

```bash
export http_proxy=socks5://127.0.0.1:10808 https_proxy=socks5://127.0.0.1:10808
curl -fsSL -o public/live2d/live2dcubismcore.min.js https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
head -c 100 public/live2d/live2dcubismcore.min.js
```

预期输出 JS 文件头（非 HTML 错误页）。

- [ ] **Step 3: 获取官方示例模型（Haru，Cubism 4）**

设计文档指定 Hiyori，但其官方 zip 直链不稳定；改用 pixi-live2d-display 仓库自带的官方示例 Haru（同为 Live2D 免费素材），管线跑通后可直接换任意 `.model3.json` 模型目录：

```bash
export http_proxy=socks5://127.0.0.1:10808 https_proxy=socks5://127.0.0.1:10808
git clone --depth 1 https://github.com/guansss/pixi-live2d-display.git .scratch/pld
cp -r .scratch/pld/test/assets/haru public/live2d/models/haru
ls public/live2d/models/haru
```

预期看到 `haru_greeter_t03.model3.json`、`*.moc3`、textures 等。记下模型入口文件名（应为 `haru_greeter_t03.model3.json`，若不同以实际为准，后续任务统一用变量 `MODEL_URL = '/live2d/models/haru/<实际文件名>.model3.json'`）。

- [ ] **Step 4: 更新 `.gitignore`（追加）**

```
# Live2D 专有许可资产不入库（见设计文档第 8 节）
public/live2d/live2dcubismcore.min.js
public/live2d/models/
```

- [ ] **Step 5: 提交（vendor 与 gitignore 入库，Core/模型不入库）**

```bash
git add .gitignore public/live2d/vendor package.json package-lock.json
git commit -m "feat(live2d): 引入 PixiJS/pixi-live2d-display vendor 文件，gitignore 专有许可资产"
```

---

### Task 5: avatar.js 渲染封装 + 主窗口形象区域

**Files:**
- Create: `public/live2d/avatar.js`
- Modify: `public/index.html`

- [ ] **Step 1: 编写 `public/live2d/avatar.js`（完整文件）**

```js
// Live2D 形象渲染封装：主窗口与小窗共用。
// 职责：加载模型、idle 动作（模型自带自动播）、鼠标视线、嘴型（振幅驱动）、表情（情绪驱动）。
// 消费同源 BroadcastChannel('avatar')：主窗口广播振幅/情绪，本窗口渲染。
(() => {
  'use strict';

  const MODEL_URL = '/live2d/models/haru/haru_greeter_t03.model3.json'; // 与 Task 4 实际文件名一致
  const CHANNEL = 'avatar';

  // 情绪状态 → Cubism 参数（值域 -1..1 / 0..1，模型缺失某参数时 setParameterValueById 安全 no-op）
  const EMOTION_PARAMS = {
    joyful:     { ParamMouthForm: 1, ParamEyeLSmile: 0.7, ParamEyeRSmile: 0.7 },
    happy:      { ParamMouthForm: 0.8, ParamBrowLY: 0.3, ParamBrowRY: 0.3 },
    calm:       {},
    comfortable:{ ParamMouthForm: 0.4 },
    uneasy:     { ParamMouthForm: -0.4, ParamBrowLY: -0.3, ParamBrowRY: -0.3 },
    angry:      { ParamMouthForm: -1, ParamBrowLForm: -1, ParamBrowRForm: -1, ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8 },
    cold_war:   { ParamMouthForm: -0.8, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7 },
    neutral:    {}, normal: {},
  };

  let app = null, model = null, ready = false;
  let mouth = 0, mouthTarget = 0, lastAmpAt = 0;   // 嘴型当前值/目标值/最近振幅时间
  let emotionParams = null, emotionUntil = 0;       // 情绪参数与失效时间

  function fit() {
    if (!model || !app) return;
    const w = app.renderer.width / app.renderer.resolution;
    const h = app.renderer.height / app.renderer.resolution;
    const scale = Math.min(w / model.width, h / model.height) * 1.15; // 略放大裁边
    model.scale.set(scale);
    model.x = w / 2;
    model.y = h * 0.92; // 头顶留白，脚部出血
  }

  // 每 tick 把嘴型/情绪参数覆写到模型（LOW 优先级保证在动作更新之后执行）
  function tick() {
    if (!model) return;
    if (Date.now() - lastAmpAt > 350) mouthTarget = 0;   // 振幅流断了自然闭嘴
    mouth += (mouthTarget - mouth) * 0.35;                // 平滑插值防抖
    const core = model.internalModel.coreModel;
    core.setParameterValueById('ParamMouthOpenY', mouth);
    if (emotionParams && Date.now() < emotionUntil) {
      for (const [id, v] of Object.entries(emotionParams)) core.setParameterValueById(id, v);
    }
  }

  function handleMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'amplitude' && typeof msg.v === 'number') {
      // 限幅并忽略畸形值（对抗：NaN/负数/超大值）
      mouthTarget = Math.min(1, Math.max(0, Number.isFinite(msg.v) ? msg.v : 0));
      lastAmpAt = Date.now();
    } else if (msg.type === 'emotion' && typeof msg.state === 'string') {
      emotionParams = EMOTION_PARAMS[msg.state] || null;
      emotionUntil = Date.now() + 10 * 60_000; // 情绪持续 10 分钟后回 idle
    }
  }

  // 挂载到指定 canvas；失败返回 false 并隐藏容器（降级链，不阻塞聊天）
  async function mount(canvas) {
    try {
      const PIXI = window.PIXI;
      if (!PIXI || !PIXI.live2d) throw new Error('vendor 未加载');
      app = new PIXI.Application({ view: canvas, backgroundAlpha: 0, autoDensity: true, resolution: devicePixelRatio || 1 });
      model = await PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: true });
      app.stage.addChild(model);
      fit();
      window.addEventListener('resize', fit);
      app.ticker.add(tick, null, PIXI.UPDATE_PRIORITY.LOW);
      const ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = (e) => handleMsg(e.data);
      ready = true;
      return true;
    } catch (err) {
      console.warn('[avatar] 形象加载失败，降级为静态参考图:', err.message);
      const box = canvas.closest('.avatar-box');
      if (box) box.style.display = 'none';
      return false;
    }
  }

  window.Avatar = { mount, get ready() { return ready; } };
})();
```

- [ ] **Step 2: 主窗口加形象区域**

`public/index.html`：

1. `</body>` 前按顺序引入（Core 必须在 cubism4 之前）：

```html
<script src="/live2d/live2dcubismcore.min.js"></script>
<script src="/live2d/vendor/pixi.min.js"></script>
<script src="/live2d/vendor/cubism4.min.js"></script>
<script src="/live2d/avatar.js"></script>
```

2. 聊天主区域适当位置（侧边）加可折叠形象容器：

```html
<div class="avatar-box" id="avatarBox" style="width:300px;height:440px;flex-shrink:0;">
  <canvas id="avatarCanvas" style="width:100%;height:100%;"></canvas>
</div>
```

3. 页面初始化处（socket 初始化之后）挂载：

```js
Avatar.mount(document.getElementById('avatarCanvas'));
```

- [ ] **Step 3: 验证**

`npm run desktop`（或网页模式 `npm start`）打开页面：形象显示、有 idle 动作、鼠标移动时视线跟随；改坏 `MODEL_URL` 刷新一次验证降级（形象区隐藏、聊天可用），再改回来。

- [ ] **Step 4: 提交**

```bash
git add public/live2d/avatar.js public/index.html
git commit -m "feat(live2d): avatar.js 渲染封装与主窗口形象区域（idle/视线/降级链）"
```

---

### Task 6: 形象独立小窗（overlay.html + 窗口接线）

**Files:**
- Create: `public/live2d/overlay.html`

（`createOverlayWindow` 在 Task 1 已建好，此处补页面并手动验证。）

- [ ] **Step 1: 编写 `public/live2d/overlay.html`（完整文件）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>avatar-overlay</title>
<style>
  /* 整窗可拖动（Electron -webkit-app-region），canvas 区域交还给鼠标交互 */
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
               -webkit-app-region: drag; }
  canvas { -webkit-app-region: no-drag; }
</style>
</head>
<body>
<canvas id="avatarCanvas"></canvas>
<script src="/live2d/live2dcubismcore.min.js"></script>
<script src="/live2d/vendor/pixi.min.js"></script>
<script src="/live2d/vendor/cubism4.min.js"></script>
<script src="/live2d/avatar.js"></script>
<script>
  const canvas = document.getElementById('avatarCanvas');
  const fit = () => { canvas.width = innerWidth; canvas.height = innerHeight; };
  fit();
  Avatar.mount(canvas);
</script>
</body>
</html>
```

注意：窗口 resize 的处理放在 `avatar.js` 内部——Task 5 的 `avatar.js` 中把 `window.addEventListener('resize', fit);` 一行替换为（canvas 尺寸变化时同步 renderer 并重新布局，主窗口与小窗通用）：

```js
      new ResizeObserver(() => {
        if (canvas.width && canvas.height) { app.renderer.resize(canvas.width, canvas.height); fit(); }
      }).observe(canvas);
```

- [ ] **Step 2: 验证**

`npm run desktop` → 托盘菜单"形象小窗"：透明置顶窗口出现、形象独立渲染、可拖动；主窗口与小窗形象动作同步（当前只有 idle，嘴型同步在 Task 7 验证）。

- [ ] **Step 3: 提交**

```bash
git add public/live2d/overlay.html public/live2d/avatar.js
git commit -m "feat(live2d): 透明置顶形象小窗，双窗口共用渲染封装"
```

---

### Task 7: 嘴型联动——TTS/语音条振幅采集与广播

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 加"生产者"桥（主窗口采集振幅并广播）**

`public/index.html` 脚本区（socket 初始化附近）新增：

```js
// ===== 形象联动生产者：采集音频振幅/情绪，广播给所有 avatar 实例（含小窗） =====
let avatarCh = null, avatarAudioCtx = null, ampRaf = 0;
function getAvatarChannel() {
  if (!avatarCh) avatarCh = new BroadcastChannel('avatar');
  return avatarCh;
}
function broadcastAvatar(msg) { try { getAvatarChannel().postMessage(msg); } catch {} }

// 用 AnalyserNode 持续采集 RMS 振幅 → ParamMouthOpenY 目标值
function trackAmplitude(analyser) {
  cancelAnimationFrame(ampRaf);
  const buf = new Uint8Array(analyser.fftSize);
  const loop = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
    const rms = Math.sqrt(sum / buf.length);
    const v = Math.min(1, rms * 6); // 增益系数，让正常说话音量能达到明显开口
    broadcastAvatar({ type: 'amplitude', v });
    AvatarBridge.selfAmplitude(v);
    ampRaf = requestAnimationFrame(loop);
  };
  ampRaf = requestAnimationFrame(loop);
}

// 给 <audio> 挂分析器并返回 audio；替代裸 new Audio(url)，三处播放点统一走这里
function playWithAvatar(url) {
  const audio = new Audio(url);
  try {
    avatarAudioCtx = avatarAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (avatarAudioCtx.state === 'suspended') avatarAudioCtx.resume();
    const src = avatarAudioCtx.createMediaElementSource(audio);
    const analyser = avatarAudioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(avatarAudioCtx.destination);
    audio._analyser = analyser;
    audio.onplay = () => trackAmplitude(analyser);
    audio.onpause = audio.onended = () => { cancelAnimationFrame(ampRaf); broadcastAvatar({ type: 'amplitude', v: 0 }); };
  } catch (e) { console.warn('振幅分析不可用，仅播放音频', e); }
  return audio;
}

// 情绪广播入口（Task 9 的 socket 监听调用）
function broadcastEmotion(state) { broadcastAvatar({ type: 'emotion', state }); }
```

其中 `AvatarBridge.selfAmplitude` 让主窗口自己的形象直接吃到同一数值（避免经 BroadcastChannel 绕一圈）：在 `avatar.js` 的 `window.Avatar` 导出追加 `applyAmplitude(v) { mouthTarget = Math.min(1, Math.max(0, v || 0)); lastAmpAt = Date.now(); }`，index.html 里定义：

```js
const AvatarBridge = {
  selfAmplitude(v) { window.Avatar && window.Avatar.applyAmplitude && window.Avatar.applyAmplitude(v); },
};
```

- [ ] **Step 2: 替换三个音频播放点**

1. `playVoice`（约 1229 行）：`const audio = new Audio('/voices/' + encodeURIComponent(filename));` → `const audio = playWithAvatar('/voices/' + encodeURIComponent(filename));`
2. `playTTS`（约 1310 行）：`const audio = new Audio(url);` → `const audio = playWithAvatar(url);`
3. 语音条第二处（约 2239 行，`new Audio(URL.createObjectURL(blob))`）同样替换。

- [ ] **Step 3: 验证**

聊天后点朗读（♪ 按钮）或语音条：主窗口形象随语音开口/闭口，小窗形象同步；播放结束自然闭嘴（350ms 超时兜底）。控制台无 `createMediaElementSource` 报错（注意：同一 audio 元素只能建一次 source，`playWithAvatar` 每次用新 Audio，无冲突）。

- [ ] **Step 4: 提交**

```bash
git add public/index.html public/live2d/avatar.js
git commit -m "feat(live2d): TTS/语音条振幅驱动嘴型，BroadcastChannel 同步主窗与小窗"
```

---

### Task 8: 嘴型联动——语音通话链路

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 通话下行播放链路挂分析器**

`socket.on('voice_call:audio', …)`（约 1540 行）内，`source.connect(playbackContext.destination);` 改为：

```js
    // 通话下行音频经分析器接输出：振幅驱动形象嘴型
    if (!playbackContext._analyser) {
      const an = playbackContext.createAnalyser();
      an.fftSize = 512;
      an.connect(playbackContext.destination);
      playbackContext._analyser = an;
    }
    source.connect(playbackContext._analyser);
```

并在该 handler 的 `source.start(nextPlayTime);` 之后追加（调度型播放没有 onplay，直接持续跟踪）：

```js
    trackAmplitude(playbackContext._analyser);
```

（`trackAmplitude` 每次调用会 cancel 上一帧循环重启，避免重复循环叠加。）

- [ ] **Step 2: 通话结束停嘴型**

`socket.on('voice_call:ended', …)`（约 1601 行）回调开头追加：

```js
  cancelAnimationFrame(ampRaf);
  broadcastAvatar({ type: 'amplitude', v: 0 });
```

- [ ] **Step 3: 验证**

发起实时语音通话：说话后角色回话时形象动嘴、挂断后闭嘴；静音麦克风上行不触发角色张嘴（上行流没接分析器）。

- [ ] **Step 4: 提交**

```bash
git add public/index.html
git commit -m "feat(live2d): 实时通话下行音频驱动嘴型，挂断归零"
```

---

### Task 9: 情绪联动——后端事件 + 前端表情

**Files:**
- Modify: `src/index.js`（唯一后端改动）
- Modify: `public/index.html`

- [ ] **Step 1: 后端在聊天完成后广播情绪**

`src/index.js` 的 `/api/chat` 路由（约 490 行），`for await` 循环结束后、`res.write('event: end'...)` 之前插入：

```js
  // Live2D 形象情绪推送：聊天结算后把最新情绪状态广播给前端形象
  try {
    const st = db.ensureCharacterState(userId, characterId);
    io.emit('avatar:emotion', { characterId, emotionState: st.emotion_state || 'calm', moodLevel: st.mood_level || 0 });
  } catch (e) {
    console.warn('[avatar:emotion] 推送失败:', e.message);
  }
```

- [ ] **Step 2: 前端监听并广播给形象**

`public/index.html` socket 区追加：

```js
socket.on('avatar:emotion', (d) => {
  if (d.characterId === currentCharacterId) broadcastEmotion(d.emotionState);
});
```

同时 `refreshState()` 内已有 `s.emotionState`（约 1035 行附近），在解析处追加一行兜底（页面刷新后形象能追上当前情绪）：

```js
    broadcastEmotion(s.emotionState || 'calm');
```

- [ ] **Step 3: 验证**

发送让角色生气的话术（如角色 minefields 触发词）：回复后主窗口与小窗形象表情切换（眉/嘴参数变化）；等 10 分钟机制不便等待，临时把 `emotionUntil` 改 30s 验证回落后改回；刷新页面形象自动恢复当前情绪。

- [ ] **Step 4: 提交**

```bash
git add src/index.js public/index.html
git commit -m "feat(live2d): 聊天结算后广播 avatar:emotion，情绪驱动 Live2D 表情"
```

---

### Task 10: 系统通知 + 文档同步 + 对抗性验证清单

**Files:**
- Modify: `public/index.html`
- Modify: `CHANGE.md`、`CLAUDE.md`

- [ ] **Step 1: 主动消息系统通知（仅 Electron + 失焦时）**

在 `socket.on('proactive', …)`（约 709 行）回调末尾追加：

```js
  // 桌面端：主窗口失焦时走系统通知（Electron 内 HTML5 Notification 自动转系统通知）
  if (!document.hasFocus() && /Electron/.test(navigator.userAgent)
      && window.Notification && Notification.permission === 'granted') {
    try { new Notification(data.characterName || 'AI Mate', { body: data.message || '' }); } catch {}
  }
```

并在页面初始化处请求一次权限（仅 Electron 内请求，避免网页模式打扰）：

```js
if (/Electron/.test(navigator.userAgent) && window.Notification && Notification.permission === 'default') {
  Notification.requestPermission();
}
```

- [ ] **Step 2: 网页模式回归**

`npm start` → `http://localhost:3000`：聊天、TTS 朗读、语音条、语音通话、设置页、主动消息全部照旧；形象区域正常显示（网页模式也有形象，属预期收益）；无控制台报错。

- [ ] **Step 3: 桌面模式全量手动验证**

`npm run desktop` 逐项确认：
1. 聊天 + TTS 嘴型 + 情绪表情
2. 通话：麦克风直接授权（无 HTTPS）、形象随对方语音动嘴、挂断闭嘴
3. 小窗：置顶、透明、拖动、嘴型与主窗同步
4. 托盘：关窗驻留、气泡提示、"退出"彻底结束进程
5. 开机自启开关生效

- [ ] **Step 4: 对抗性用例验证**

| 用例 | 操作 | 预期 |
|------|------|------|
| 子进程反复崩溃 | 连续 kill 重启后的 node 子进程 ≥5 次 | 停止重启并弹日志尾部错误框 |
| 二次启动 | 桌面端运行中再执行 `npm run desktop` | 聚焦已有窗口，不开新实例 |
| 端口预占 | `npx serve -l 3000`（或任意占用）后启动桌面端 | 明确弹窗"端口被占用"，不无限重启 |
| 模型损坏 | 把 `.moc3` 换成空文件刷新 | 形象区隐藏、聊天正常、控制台告警 |
| 畸形振幅 | DevTools 里 `getAvatarChannel().postMessage({type:'amplitude', v:-5})`、`v:1e9`、`v:'x'` | 嘴型钳制在 0~1，无异常 |
| 非法情绪值 | `postMessage({type:'emotion', state:'<script>'})` | 映射表查不到 → null，无表情变化、无报错 |
| 通知权限拒绝 | Electron 内拒绝通知权限 | 静默降级，主动消息仅入聊天列表 |

- [ ] **Step 5: 更新 CHANGE.md 与 CLAUDE.md，最终提交**

`CHANGE.md` 追加本次迭代条目（改动主题/核心变更点/遗留事项）；`CLAUDE.md` 项目概述与迭代记录引用同步（补充：桌面端 `npm run desktop`、`src/desktop/` 编排说明、Live2D 渲染层说明）。

```bash
git add public/index.html CHANGE.md CLAUDE.md
git commit -m "feat(desktop): 系统通知与迭代记录同步"
```

---

## 遗留与后续（明确不在本计划内）

- electron-builder 打包安装包
- 通话中实时情绪分析
- Hiyori 等其他模型替换（替换 `public/live2d/models/` 目录 + `avatar.js` 的 `MODEL_URL` 即可）
- 形象区域 UI 精细化（折叠按钮样式、小窗尺寸记忆）
