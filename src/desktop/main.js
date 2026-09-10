// Electron 主进程入口：单实例锁 → 麦克风权限 → 端口预检 → 起后端 → 等健康 → 开窗
import { app, session, dialog } from 'electron';
import net from 'node:net';
import { PORT, ROOT_DIR as ROOT } from './config.js';
import { start as startService, stop as stopService, waitHealth, getLogTail } from './serviceManager.js';
import { createMainWindow, showMainWindow } from './windows.js';
import { createTray } from './tray.js';

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
  const ok = await waitHealth();
  if (!ok) {
    dialog.showErrorBox('后端服务未就绪',
      '等待 30 秒后服务仍未启动。子进程日志尾部：\n\n' + getLogTail());
    app.quit();
    return;
  }

  createMainWindow(ROOT);
  createTray(ROOT);
}
