# CHANGE.md — 项目迭代记录

## 2026-09-09 — 角色可视化管理（编辑/换图/新增/重置/删除）

### 改动主题
新增角色全生命周期可视化管理：无需手动改 JSON 文件，即可在 Web 端编辑角色档案、更换头像、以复制方式新增角色、重置运行时状态、彻底删除角色（含数据与媒体清理）。

### 核心变更点
1. **CharacterManager 写方法**：`createCharacter`（支持 `copyFrom` 从现有角色复制档案）、`saveProfile`（patch/full 双模式，仅传变更字段或整体覆盖）、`saveAvatar`（原子换图）、`deleteCharacter`；id 正则校验下沉到服务层，禁止通过写 API 修改 id；档案落盘统一采用临时文件 + rename 原子写，避免写一半损坏。
2. **运行时数据清理**：`DatabaseManager.deleteCharacterData` 以单事务清除该角色相关的 10 张表，并按 photos 表精确清单清理 `public/photos`、`public/videos` 媒体文件（不误删 character_id 含相同子串的其他角色文件）；`MemoryService.removeCharacter` 同步清理 `data/memory/` 记忆文件与内存索引实例。
3. **5 个新 API**：`POST /api/characters`（可复制创建）、`PUT /api/characters/:id`（patch/full）、`POST /api/characters/:id/avatar`（魔数校验 + 5MB 限制）、`POST /api/characters/:id/reset`（只清运行时状态，保留档案）、`DELETE /api/characters/:id?confirm=全名`（彻底删除，要求输入角色全名确认的可逆性前置）。
4. **前端双弹窗**（`public/index.html`）：角色管理列表弹窗 + 角色编辑器弹窗（分组表单 / 雷区动态行 / 高级 JSON 页签 / 头像预览上传 / 危险区），入口在主页功能宫格与设置弹窗；保存防重、JSON 保存后状态同步、保存后恢复当前选中角色。
5. **sw.js 缓存版本** soul-v4 → soul-v5，保证新前端在已访问浏览器生效。
6. 22 项端到端对抗验证全部通过（详见下一条目）。

### 遗留事项
- 写操作无鉴权（局域网可增删角色，公网部署前需认证）。
- 6MB 超限上传返回 500 非 413（multer LIMIT_FILE_SIZE 未映射状态码）。
- 删除最后一个角色后主页 header/hero 残留旧显示（刷新恢复，属 loadCharacters 空列表早退的既有边界）。
- 表单编辑不覆盖冷门深层字段（living_info 等需用高级 JSON 页签）。

## 2026-09-09 — 设置弹窗交互优化

### 改动主题
`public/index.html` 设置弹窗易用性改进：宽度加大 + 两种快捷关闭方式。

### 核心变更点
1. 设置弹窗宽度 440px → 560px（`max-width:92vw` 保留，手机端不受影响）。
2. 点击遮罩空白处关闭弹窗（`event.target===this` 判断，点击弹窗内部不触发）。
3. 右上角新增关闭按钮（`.modal-close`，hover 反馈）；`.modal` 补 `position:relative` 定位锚点。
4. `sw.js` 缓存版本 soul-v3 → soul-v4，避免旧 index.html 缓存导致改动不生效。

### 遗留事项
- 无（仅设置弹窗应用此交互，其他弹窗未动）。

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
7. **最终整体审查修复**：新增 `#cfgBannerHome`——手机停在主页时也能看到"对话 API 未配置"横幅（原横幅在聊天页内被视图互斥隐藏）；`#videoFeatBtn` 补 `.feat-desc` span 修复视频生成"生成中..."文案失效的死引用；手机端选角后 `msgInput.focus()` 移到视图切换之后修复静默失败；`setAvatar` 增加归属校验（快速切角色时旧头像迟到的 onerror 不再污染新头像）；SSE error 解析加 try/catch 兜底（非 JSON 错误原文展示，不再误报"连接失败"）。

### 遗留事项
- 照片相册页需新增照片列表接口，属后续迭代。
- 手机 PWA 实机（iOS Safari / Android Chrome）需用户自行验证麦克风与 safe-area。
- `sw.js` 对 index.html 为 cache-first（缓存名 soul-v3），前端改动后需强刷或升版本号才能在已访问过的浏览器生效，开发调试时易踩坑。
- 视频任务轮询回调无角色归属守卫：任务生成中切换角色，视频会插入新角色聊天流（建议回调时比对 `currentCharacterId`，与视频功能后端一并处理）。
- 三个已接受的 Minor：日记失败提示的 `reason` 机器码未映射中文、角色卡片头像未复用 `setAvatar`、胶囊 `xpGained` 为 undefined 时显示 "+undefinedxp"（均为旧版同款既有行为）。

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

## 2026-09-09 — 角色管理 API 端到端对抗性验证 + HTTPS 端口降级修复

### 改动主题
对角色管理写操作 API（创建/编辑/头像/reset/删除）做 22 项端到端对抗验证，全部通过；期间发现并修复 HTTPS 端口被占导致整个进程崩溃的问题。

### 核心变更点
1. **对抗验证结论**：Happy Path 5 项（创建/patch 编辑/头像魔数校验上传/reset/confirm 删除）+ 对抗 17 项（非法 id、连续下划线、过短 id、重复 id、缺 full_name、profile 数组、copyFrom 不存在、patch/full 改 id 防御、坏 JSON、不存在角色 PUT/DELETE/reset、confirm 错名/空名、假图片、6MB 超限上传）全部符合预期。
2. **数据完整性**：lin_004 reset 后 10 张表行数全 0、`data/memory/test_user__lin_004.json` 删除、3 张照片文件清除；媒体误删专项（删除 test_004 时 `u1_lin_004_123.jpg` 按 character_id 精确保留、`u1_test_004_456.jpg` 正确删除）通过。
3. **修复**（`src/index.js`，commit b353e42）：`httpsServer.listen` 增加 `error` 处理，HTTPS 端口（默认 3443）被占时告警降级为仅 HTTP，不再未捕获崩溃拖垮主服务；已用占位监听器实测降级路径生效。

### 遗留事项
- 角色编辑写操作均无鉴权（局域网任意客户端可增删角色），当前单机自用可接受，公网部署前需加认证层。
- 6MB 超限头像上传返回 500（multer LIMIT_FILE_SIZE 未映射为 413），非 2xx 拦截有效，体验可优化。
- `public/photos/` 下 lin_004 的 3 张 git 跟踪测试照片已随授权 reset 清除（git status 显示 D），如需保留历史可 `git checkout` 恢复。
