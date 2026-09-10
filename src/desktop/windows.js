// 窗口管理：主窗口（关窗驻留托盘）+ 透明置顶形象小窗
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { PORT } from './config.js';

const HOME = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let overlayWindow = null;
let _rootDir = null;                // 记住根目录，供 showMainWindow 重建窗口时复用

export function getMainWindow() {
  return mainWindow;
}

export function createMainWindow(rootDirArg) {
  if (rootDirArg) _rootDir = rootDirArg;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    autoHideMenuBar: true,
    icon: _rootDir ? path.join(_rootDir, 'public/icons/icon.png') : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadURL(HOME);
  // 关窗 = 隐藏到托盘（后端子进程继续跑，主动消息不断线）；真正退出走托盘菜单
  mainWindow.on('close', (e) => {
    if (!global.__quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

export function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(_rootDir);
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
