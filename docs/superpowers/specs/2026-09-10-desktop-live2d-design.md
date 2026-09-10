# 桌面端改造 + Live2D 实时视频语音形象 · 设计文档

日期：2026-09-10
状态：已与用户逐节确认

## 1. 背景与目标

当前项目是纯 Web 架构（Node.js Express + Socket.IO 后端，`public/` 下原生 HTML PWA 前端），角色形象只有静态参考图和生成的照片/视频。用户目标：

1. **桌面端为主**：提供 Windows 桌面应用形态，保留网页端作为第二模式
2. **实时视频语音体验**：聊天界面 + Live2D 动态形象混合呈现，形象嘴型随 TTS/通话语音实时起伏，表情随情绪状态切换
3. **桌面特性**：系统托盘 + 系统通知、形象独立置顶透明小窗、开机自启

### 已确认的关键决策

| 决策点 | 结论 |
|--------|------|
| 桌面壳技术 | Electron（方案 A：壳与后端进程隔离） |
| 后端托管方式 | Electron 主进程 spawn 系统 Node 子进程跑现有 `src/index.js`，后端零结构性改动（仅新增一个 Socket.IO 事件，见第 3 节） |
| 交互形态 | 聊天 + 形象混合（现有聊天界面 + Live2D 形象区域） |
| Live2D 模型来源 | 先用官方示例模型（Hiyori）跑通管线，模型资产后置替换 |
| 语音联动范围 | 聊天 TTS 回复动嘴 + 实时语音通话（Seeduplex）形象联动，两者都要 |
| 桌面特性范围 | 托盘+通知、形象独立小窗、开机自启 |
| 打包 | MVP 不做 electron-builder 安装包，`npm run desktop` 开发模式跑通；打包另起迭代 |

### 备选方案与否决理由

- **方案 B（服务直接嵌入 Electron 主进程）**：`better-sqlite3` 原生模块必须按 Electron ABI 重编译，之后普通 `npm start`（网页模式）因 ABI 不匹配无法运行，两种模式互相打架。否决。
- **方案 C（Tauri 2 + Node sidecar）**：包体积小（~10MB vs ~100MB），但 Node 后端要打成 sidecar 二进制，原生模块打包复杂度极高。收益只有体积，否决。

### 第一性原理约束

本质约束：**后端是 Node 生态 + 原生模块 + 要求网页/桌面双模式共存**。最小阻力路径是让桌面壳与后端进程隔离——Electron 只负责窗口/托盘/生命周期，后端保持纯 Node，两个模式共享同一份零改动的服务端代码。

## 2. 进程模型与双模式入口

### 目录结构（新增为主，现有代码几乎不动）

```
ai-mate-soul/
├─ src/index.js                  # 不动：纯 Node 后端（网页模式入口）
├─ src/desktop/
│  ├─ main.js                    # Electron 主进程入口：生命周期、单实例锁、权限
│  ├─ serviceManager.js          # spawn/守护 node 子进程（自动重启+指数退避）
│  ├─ windows.js                 # 主窗口 + 透明置顶形象小窗
│  └─ tray.js                    # 托盘菜单、开机自启开关
├─ public/live2d/
│  ├─ avatar.js                  # Live2D 渲染封装（主窗口和小窗共用）
│  ├─ overlay.html               # 小窗页面（透明背景 + 形象，可拖动）
│  └─ models/hiyori/             # 官方示例模型（.moc3 / model3.json / motion3 等）
└─ package.json                  # main 字段改指 src/desktop/main.js
```

### 双模式脚本

- `npm start` / `npm run dev` — 网页模式，现状完全不变
- `npm run desktop` — Electron 启动：主进程 spawn 系统 Node 跑 `src/index.js` → 轮询 `http://localhost:3000` 健康检查通过 → 创建主窗口

### 关键决策说明

- `package.json` 的 `main` 字段改指桌面入口是安全的：`node src/index.js` CLI 不读 main，只有 Electron 读
- 后端零改动 = `better-sqlite3` 不碰 ABI 问题，网页模式天然保留
- 桌面模式配置 `session.setPermissionRequestHandler` 放行麦克风权限（Electron 内无需 HTTPS）；网页模式继续走现有自签 HTTPS 路径，互不影响
- `app.requestSingleInstanceLock()` 防多开（两个实例会抢 3000 端口）；二次启动时聚焦已有窗口

## 3. Live2D 渲染与嘴型/情绪联动

### 渲染栈

- `PixiJS` + `pixi-live2d-display`（支持 Cubism 4 `.moc3`）：两者均为 MIT 许可，走 npm 安装后拷贝产物到 `public/live2d/vendor/` 入库，不依赖 CDN
- Cubism Core（`live2dcubismcore.min.js`）：Live2D 专有许可，不入库——优先官方 CDN 加载，`public/live2d/` 留本地副本兜底（副本同样被 gitignore），获取步骤见第 8 节
- `public/live2d/avatar.js` 统一封装：模型加载、idle 动作自动播放（示例模型自带 `idle.motion3.json`）、鼠标视线追踪、嘴型/表情控制接口。主窗口和 `overlay.html` 共用

### 两处呈现，一份逻辑

- 主窗口：`index.html` 聊天界面新增可折叠的形象区域（侧边 canvas）
- 小窗：透明 BrowserWindow（`transparent + alwaysOnTop + frame: false`），可拖动，托盘菜单控制显隐

### 嘴型驱动（两条音频链路，同一套振幅→参数逻辑）

1. **聊天 TTS**：现有 `new Audio('/voices/…')` 播放点（index.html:1229）封装为 `playWithAvatar(url)`——内部 `MediaElementSource` → `AnalyserNode` → 每帧 RMS 振幅 → 映射 `ParamMouthOpenY`（0~1，平滑插值防抖）
2. **语音通话**：现有 `voice_call:audio` base64 → 24kHz `AudioContext` 播放链路（index.html:1540-1551）在输出前挂 `AnalyserNode`，同样振幅→嘴型。上行麦克风流不驱动嘴型，天然区分

### 小窗音频信号（关键设计点）

小窗自身不播放音频。主窗口计算振幅后通过 **`BroadcastChannel('avatar')`** 广播 `{ type: 'amplitude', value }`——两窗口同源（localhost:3000），零 Electron 主进程介入，主窗口代码在网页模式下原样可运行。情绪事件同样走该通道。

### 情绪→表情联动

- 后端新增 Socket.IO 事件 `avatar:emotion`（`{ emotionState, moodLevel }`），聊天完成时 emit，落点在 `index.js` 聊天路由完成处（唯一后端改动）
- 前端映射表：6 情绪状态 → Live2D 表情/参数组合（示例模型实际参数优先，如 `angry` → 眉/嘴参数组合）
- 通话场景 MVP：情绪沿用最近一次聊天状态，不做通话内容实时情绪分析

### 降级链

Cubism Core 或模型加载失败 → 形象区域自动隐藏，回退现有静态参考图，聊天功能完全不受影响，控制台告警。

## 4. 桌面特性

- **托盘**：`Tray` + 菜单（显示主窗口 / 形象小窗显隐 / 开机自启开关 / 退出）。关闭主窗口默认最小化到托盘不退出（后端子进程继续跑，主动消息/日程不断线）；托盘"退出"才真正结束——先杀子进程再退出 app
- **系统通知**：零改动方案——主动消息现走 Socket.IO 推送，Electron renderer 的 HTML5 `Notification` API 自动走系统通知；仅主窗口失焦时发系统通知（避免双重打扰），页面标题闪烁等现有逻辑保留
- **开机自启**：`app.setLoginItemSettings({ openAsHidden: true })`；开关状态存 Electron `userData` 下 JSON（纯桌面概念，不污染 `data/settings.json` 唯一配置源）

## 5. 错误处理

| 故障 | 处理 |
|------|------|
| 后端子进程崩溃 | serviceManager 指数退避自动重启（1s/2s/4s…上限 30s），托盘气泡提示；窗口显示重连遮罩，健康检查恢复后自动消失 |
| 连续崩溃 ≥5 次 | 停止重启，弹错误对话框展示子进程日志尾部 |
| 端口 3000 被外部占用 | 桌面启动时预检端口，非自家进程占用则弹窗明确提示（后端自身端口重试逻辑保留，网页模式照旧） |
| Live2D 模型损坏/缺失 | 走第 3 节降级链：隐藏形象回退静态图 |
| 通知权限拒绝 | 静默降级为托盘气泡，不重复请求权限 |

## 6. 验证清单（手动验证，项目无测试框架）

1. **网页模式回归**：聊天、TTS 播放、语音通话、设置页全部照旧
2. **桌面模式**：`npm run desktop` → 聊天 + 形象嘴型随 TTS 起伏 + 情绪表情切换
3. **通话**：麦克风在 Electron 内直接授权（无 HTTPS），形象随对方语音动嘴
4. **小窗**：置顶透明、可拖动、嘴型与主窗口同步
5. **托盘**：关窗驻留、系统通知弹出、自启开关生效（重启验证）
6. **对抗用例**：
   - 手动 kill 后端子进程 → 自动重启恢复，UI 重连
   - 二次启动桌面端 → 单实例锁拦截并聚焦已有窗口
   - 删除模型文件 → 形象降级隐藏，聊天不崩
   - 预占 3000 端口后启动桌面端 → 弹明确报错提示

## 7. 明确不做（YAGNI）

- electron-builder 安装包（跑通后另起迭代）
- 通话中实时情绪分析
- 形象多模型切换 UI（先内置 Hiyori 单模型；`public/live2d/models/` 目录化设计留好替换口）
- 后端大规模重构（保持零改动是本设计的核心约束）

## 8. 许可注意事项

- Cubism Core / Live2D SDK 为 Live2D Inc. 专有许可：个人及小规模发布免费，**不得将 SDK 二进制文件提交进 git 仓库**——`public/live2d/live2dcubismcore.min.js` 与模型文件加入 `.gitignore`，README 写明一次性获取步骤
- 官方示例模型（Hiyori）遵 Live2D 免费素材许可条款使用，同样不入库
