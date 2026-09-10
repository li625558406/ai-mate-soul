// 桌面端后端守护：spawn 系统 Node 跑 src/index.js，健康检查 + 指数退避自动重启
import { spawn } from 'node:child_process';
import http from 'node:http';
import { PORT } from './config.js';

const HEALTH_URL = `http://127.0.0.1:${PORT}/`;
const MAX_CONSECUTIVE_FAILS = 5;   // 连续崩溃次数上限，超过后停止重启
const STABLE_RUN_MS = 60_000;      // 运行超过此时长视为稳定，重置崩溃计数

let child = null;
let stopping = false;
let consecutiveFails = 0;
let startedAt = 0;
let spawnBroken = false;            // spawn 本身失败（如 node 可执行文件不存在），禁止再重启
let restartTimer = null;            // 重启延迟定时器，stop/start 时需清掉避免竞态
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
  clearTimeout(restartTimer);
  stopping = false;
  spawnBroken = false;
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
    if (stopping || spawnBroken) return;
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
    restartTimer = setTimeout(() => { if (!stopping && !spawnBroken) _spawn(rootDir); }, delay);
  });

  // node 可执行文件不存在等 spawn 失败：'error' 事件无监听会以未捕获异常击穿主进程
  child.on('error', (err) => {
    if (spawnBroken || stopping) return;
    spawnBroken = true;
    // 压入日志尾部，让 main.js 兜底超时弹窗里 getLogTail() 能看到 spawn 失败原因
    logTail.push(`spawn 失败: ${err.message}`);
    if (logTail.length > 50) logTail.shift();
    emitState('failed', { log: getLogTail() });
  });
}

export function stop() {
  clearTimeout(restartTimer);
  stopping = true;
  if (!child) return;
  if (process.platform === 'win32') {
    // Windows 下杀整棵进程树，避免子进程残留占用端口；spawn 失败时 pid 为空直接跳过
    if (child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
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
