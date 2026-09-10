// 托盘：显示主窗 / 形象小窗显隐 / 开机自启开关 / 退出
import { app, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT_DIR } from './config.js';
import { showMainWindow, toggleOverlayWindow } from './windows.js';

let tray = null;
const prefsPath = () => path.join(app.getPath('userData'), 'desktop-prefs.json');

export function readPrefs() {
  // 损坏/缺失一律降级为空对象，不让托盘初始化崩掉
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch { return {}; }
}

function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  try {
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
    fs.writeFileSync(prefsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    // 磁盘满/权限/杀软锁文件：降级为仅本次内存生效，不击穿主进程
    console.warn('[tray] prefs 写入失败:', err.message);
  }
  return next;
}

export function applyAutoLaunch(enabled) {
  // args 必须用 cwd 无关的绝对路径，否则从任务计划/Run 启动时注册错目录；打包后该参数多余但无害
  app.setLoginItemSettings({ openAsHidden: true, path: process.execPath, args: [ROOT_DIR], enabled });
}

export function showBalloon(title, content) {
  if (process.platform !== 'win32') return;
  if (tray) tray.displayBalloon({ iconType: 'info', title, content });
}

export function createTray(rootDir) {
  const icon = nativeImage.createFromPath(path.join(rootDir, 'public/icons/icon.png'));
  if (icon.isEmpty()) console.warn('[tray] 托盘图标加载失败:', path.join(rootDir, 'public/icons/icon.png'));
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
