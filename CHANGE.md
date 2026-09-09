# CHANGE.md — 项目迭代记录

## 2026-09-09 — 前端界面重设计（角色主页中心 + 暖调陪伴风）

### 改动主题
`public/index.html` 整体重写布局：弃用"侧边栏大杂烩"结构，改为角色主页中心（方案 C）。

### 核心变更点
1. **信息架构**：主页（hero 角色卡 + 进度条化状态总览 + 开始聊天 + 功能宫格 + facts 展示）+ 聊天页（纯聊天）双视图；手机端 `body.view-home/view-chat` 互斥切换，桌面端 ≥900px 主页压缩为左栏常驻。
2. **视觉系统**：暖调陪伴风（奶油底 #fdf8f5 + 珊瑚粉 #ff6a88 渐变主色 + 柔投影），气泡/弹层/按钮全面换肤。
3. **状态重组**：心情双卡合并为 hero 心情徽章 + 双向心情条；好感度/等级经验进度条化；天气入角色卡；每条 AI 回复的数值反馈改为消息下方胶囊（LEVEL UP/雷区醒目样式）。
4. **入口收敛**：朗读/日记/导出重复入口删除；设置弹层新增数据管理区（导出/导入/清除记录）；User ID/名字移入「我的信息」弹层；角色选择移入「切换角色」弹层。
5. **JS 逻辑零改动**：API 调用、Socket.IO、SSE、语音通话音频管线原样保留，仅 DOM 挂载点适配。
6. **对抗性验证与收尾修复**（Task 5）：四处头像内联 onerror 改为 DOM 绑定（顺带修复原写法 `this.remove()` 后 `parentNode` 为 null 导致回退文字从未生效的隐藏 bug）；`generateDiary` 失败提示兼容后端 `reason` 字段；数值胶囊 `xpGained`/`emotionState` 补 `escapeHtml`；对抗性验证中新发现并修复：导入弹层被设置弹层遮挡（`#importModal` 提 z-index 210）、SSE error 事件 data 为纯字符串时前端显示 `[Error] undefined`（兼容字符串/对象两种格式）。桌面/手机双端 10 组用例验证通过。

### 遗留事项
- 照片相册页需新增照片列表接口，属后续迭代。
- 手机 PWA 实机（iOS Safari / Android Chrome）需用户自行验证麦克风与 safe-area。
- `sw.js` 对 index.html 为 cache-first（缓存名 soul-v3），前端改动后需强刷或升版本号才能在已访问过的浏览器生效，开发调试时易踩坑。

## 2026-09-09 — 火山方舟（Ark）视频生成对接

### 改动主题
新增 AI 短视频生成能力，对接火山方舟 `content_generation/tasks` 异步接口（Seedance 模型），配置走 Web 设置页，与现有绘图能力并列。

### 核心变更点
1. **SettingsManager**：DEFAULT_SETTINGS 新增 `video: { baseURL, apiKey, model }` 分区，`data/settings.json` 自动合并持久化。
2. **新增 `src/services/VideoService.js`**：
   - 创建任务 `POST {baseURL}/content_generation/tasks`，prompt 携带 `--wm false --dur 5` 参数；
   - 角色参考图以 `image_url + role: first_frame` 作为首帧，保持外貌一致性；
   - 后台每 10s 轮询任务状态（最长 10 分钟），succeeded 后下载 mp4 到 `public/videos/`，复用 photos 表入库（`type='video'`）；
   - 内存 Map 维护任务状态，单次轮询失败自动重试，超时/失败有明确错误信息。
3. **src/index.js**：实例化 videoService；新增 `POST /api/video`（返回 taskId）与 `GET /api/video/status/:taskId`；`PUT /api/settings` 保存后热更新视频配置；启动横幅新增 Video Gen 状态行。
4. **public/index.html**：
   - 设置弹窗新增"视频生成 API（火山方舟）"分区（Base URL / API Key / Model）+ 配置状态徽标；
   - 功能面板新增"生成视频"按钮，选中角色后可用；
   - 前端每 5s 轮询任务状态，成功后以 `video` 消息类型内嵌 `<video controls>` 播放，失败/超时系统消息提示。

### 遗留事项
- 视频消息仅在生成当时展示于聊天流，未写入 chat_history，刷新页面后聊天窗口不回放（照片数据仍在 photos 表）。
- 未做前端主动队列控制：重复点击"生成视频"会复用同一个轮询器但会创建多个 Ark 任务（按次计费），后续可加并发限制。
- ImageService.js:336 参考图 mime 拼写为 `'image\png'`（实际得到 `imagepng`），属历史问题，本次未改动。

## 2026-09-09 — 模型配置改为纯 Web UI 配置，取消启动 env 校验

### 改动主题
对话 / 绘图 / TTS 模型的 API 配置完全由前端设置界面管理，独立存储于 `data/settings.json`，启动不再依赖也不校验 `.env`。

### 核心变更点
1. **取消启动强校验**（`src/index.js`）：删除对话 API 未配置时 `process.exit(1)` 的 FATAL 逻辑，改为 console.warn 提示后正常启动。
2. **移除 .env 迁移**（`src/services/SettingsManager.js`）：删除 `_migrateFromEnv()`，配置不再从 `.env` 首次导入，`data/settings.json` 为唯一配置源（保留旧多 provider 格式迁移 `_migrateOldFormat`）。
3. **启动横幅状态修正**（`src/index.js`）：TTS / Voice Call / Image Gen 的"未配置"提示改从 `settingsManager.getRaw()` 读取，不再读 `process.env.DASHSCOPE_API_KEY`。
4. **前端配置状态可视化**（`public/index.html`）：
   - 设置弹窗三个分区（对话/绘图/TTS）标题旁显示 ✓ 已配置 / ✗ 未配置 徽标；
   - 主界面顶部新增提示横幅：对话 API 未配置时显示"⚠ 对话 API 未配置"并提供"去配置"按钮，保存配置成功后自动刷新消失；
   - 页面加载与打开设置时均会拉取 `/api/settings` 刷新状态。

### 遗留事项
- `.env` 中残留的 LLM 相关变量（QWEN_* / DASHSCOPE_API_KEY 等）已不生效，仅 `PORT` / `HTTPS_PORT` 仍被读取；可择机清理。
- 服务端已有多个历史端口占用（3001 上另有无关进程 one-api），与本改动无关。
