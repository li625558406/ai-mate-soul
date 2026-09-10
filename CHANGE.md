# CHANGE.md — 项目迭代记录

## 2026-09-09 — 修复新增角色与 AI 生成的校验死锁

### 改动主题
用户指出：新增角色时「请先保存创建角色」与「角色 id 非法」两条校验互相锁死——表单根本不收集 id（中文全名也无法转成合法 id），导致永远保存不了、永远用不了 AI 生成。

### 核心变更点
`CharacterManager.createCharacter`：profile 未提供 id 时自动生成合法 id（`char_` + 时间戳 base36 + 随机段，冲突重试）；显式提供 id 时仍严格校验 `[a-z0-9_]{2,32}`。id 是内部标识（目录名/数据库键），不应要求用户手工构造。

### 遗留事项
- 无。

## 2026-09-09 — 头像一键生成（基于参考图）

### 改动主题
用户要求：头像生成必须以参考图为前提，且不走风格/要求配置，点卡片「AI 生成」直接出图；AI 面板仅保留给参考图生成。

### 核心变更点
1. **服务端** `POST /generate-image` avatar 分支：固定 AVATAR_TEMPLATE 提示词（风格/要求不参与）；未传附件时自动读取角色已保存的参考图文件作为图生图输入；无参考图返回 400「生成头像前请先上传或生成参考图」；index.js 补 `fs` 导入。
2. **前端**：头像卡片「AI 生成」改为一键直生成（`ceGenerateAvatarNow`，客户端先查参考图存在、按钮 loading、生成后预览采用不变）；生成面板移除「头像/参考图」目标 chip，标题改为「AI 生成参考图」，仅服务参考图生成。
3. sw.js soul-v7 → soul-v8。

### 遗留事项
- 验证消耗 1 次真实绘图额度（lin_004 基于参考图生成头像）。

## 2026-09-09 — AI 生成面板布局重设计

### 改动主题
用户反馈 AI 生成面板挤在图片卡右侧"太丑"：重排为全宽分步卡片面板，操作流程从"点击即生成（立刻扣额度）"改为"先配置后生成"。

### 核心变更点
1. **布局重排**：AI 生成从图片行右侧第三栏改为独立全宽面板（`.ce-gen-box`），点卡片「AI 生成」展开并定位目标，可收起。
2. **分步结构**：① 选择风格（横向卡片，滚动条细化）→ ② 补充要求 → ③ 参考附件（虚线 drop 区，已传显示缩略图、点击放大）；底部为模板提示 + 渐变「开始生成」按钮。
3. **目标切换**：面板头部「头像 / 参考图」chip 切换（渐变高亮）；头像显示内置提示词说明、隐藏模板折叠块；参考图显示固定模板说明并可展开查看完整英文模板。
4. **流程变更**：生成改为面板内「开始生成」触发（按钮 loading），避免点卡片按钮直接扣额度；附件点击行为 = 未传时选文件、已传时放大预览。
5. sw.js 缓存版本 soul-v6 → soul-v7。

### 遗留事项
- 无新增（沿袭：真实生成消耗额度、写操作无鉴权）。

## 2026-09-09 — AI 生成形象图片（头像/参考图）+ 编辑器界面重设计

### 改动主题
角色编辑弹窗内支持调用项目已配置的绘图模型（ImageService）生成头像与参考图：风格卡片库 + 固定模板提示词 + 用户补充要求 + 可选附件图生图，生成后先预览再采用；并按用户要求重设计了编辑器图片区界面（tab 切换、固定标题/底栏等本轮 UI 整改一并收录）。

### 核心变更点
1. **新 API**：`POST /api/characters/:id/generate-image`（参数 kind=avatar|reference、stylePrompt、requirement ≤500 字截断、attachment dataURL 白名单前缀校验 ≤7.5M 字符；提示词 = 固定模板 + 风格 + 要求拼接；返回 dataURL 预览图）；`POST /api/characters/:id/adopt-image`（base64 魔数校验 detectImageExt 后落盘，ext 按真实格式映射）。
2. **ImageService**：`generateImage(prompt, ref)` 支持传入 dataURL 字符串作为图生图参考（附件模式，不与现有参考图自动保持一致性）。
3. **前端风格卡片库**：`CE_STYLES` 9 款风格（不指定风格 + 2.5D 半写实/日系动漫/吉卜力/厚涂/赛博朋克/水墨/像素/3D 渲染），每款带真实预览图 `public/styles/<id>.jpg`（8 张已通过 Ark API 一次性生成，脚本 `.scratch/gen-style-previews.mjs` 支持跳过已存在避免重复扣费）。
4. **界面重设计**：头像/参考图双卡片各带「上传 + AI 生成」；AI 生成面板含风格横滑卡片区、参考图模板提示（只读展示）、补充要求输入、附件上传/缩略图/移除；生成结果先弹预览（重新生成/采用），采用后才落盘并刷新卡片；头像提示词固定不展示。
5. **编辑器 UI 整改**：表单/高级 JSON 改 tab 标签切换；标题行与取消/保存底栏固定（中间滚动）；关闭 icon 与取消均为返回上一层（角色列表）；雷区输入框样式修正；危险操作按钮底边裁切修复（滚动容器 padding 补偿）。
6. **安全与校验**：附件前端类型双重校验（MIME + 扩展名，修复 .yml 空 MIME 绕过）、服务端 dataURL 前缀正则 + adopt 魔数校验兜底；multer LIMIT_FILE_SIZE 错误中间件返回 413。
7. 9 项 API 对抗测试全过（404/400 参数分支、伪 dataURL、超长截断、合法落盘+清理）；Playwright 全 UI 链路验证（生成→预览→采用→卡片刷新、附件非法类型拒绝、未保存角色守卫提示）。

### 遗留事项
- 风格预览图生成与测试消耗了少量绘图额度；真实生成每次消耗额度。
- 生成走同步等待（无超时进度条），网络慢时按钮 loading 期间无中间反馈。
- 写操作仍无鉴权（沿袭此前遗留）。

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
4. **最终整体审查收尾**：终审发现提交树不自洽（f92424f 混入视频接线但 VideoService.js 等在制品未提交，fresh clone 无法启动），已按用户确认补交（`feat(video)` 一笔）；3 张 git 跟踪的历史测试照片以 `chore` 提交删除。功能判定为可交付。

## 2026-09-09 — 设置弹窗布局固定化 + 数据管理前置

### 改动主题
设置弹窗（`public/index.html`）调整为三段式布局，提升长表单滚动时的可用性。

### 核心变更点
1. 弹窗改为 flex 纵向布局：`⚙ API 配置` 标题与底部「取消 / 保存并生效」按钮区固定不随内容滚动，仅中间表单区（`overflow-y:auto`）滚动。
2. 「📦 数据管理」区块（导出备份 / 导入备份 / 清除聊天记录 / 角色管理）从底部移到弹窗内容首位。

### 遗留事项
- 无（纯前端静态布局调整，无逻辑改动）。

## 2026-09-09 — 设置弹窗功能增强（绘图模型配置 / 视频时长上限 / API 有效性校验）

### 改动主题
设置弹窗三项增强：绘图 API 支持配置模型、视频生成支持时长上限配置（按模型自动封顶）、四类 API 各增「校验」按钮。

### 核心变更点
1. **绘图 Model 配置**：`SettingsManager` 的 `image` 增加 `model` 字段；`ImageService` 构造/`updateConfig` 接受 model（默认 `wan2.7-image-pro`），设置弹窗新增 Model 输入框，留空走默认。
2. **视频时长上限**：`SettingsManager` 的 `video` 增加 `maxDuration` 字段（默认 5s，非法值归一回 5s）；`VideoService` 新增 `_durationCap()`：模型 ID 含 `2.5`（兼容 `2.5`/`2-5` 写法）上限 30s，其他上限 15s；`createTask` 按 `min(配置, 上限)` 计算时长写入 `--dur`，超限截断并通过 `POST /api/video` 响应返回 `truncated/cap`，前端以系统消息提示「已按模型上限截断时长」。设置弹窗新增「最长时长（秒）」输入框。
3. **API 有效性校验**：新增 `POST /api/settings/test`（body: `{kind, section}`），四种校验策略——chat：`GET {baseURL}/models`；image：真实最小绘图调用（512*512，1 张）；tts：真实最小 TTS 合成（"你好"）；video：零成本鉴权探测（查不存在任务 id，401/403 判 Key 无效）。表单中掩码 Key（`****` 开头）自动回退已存储真实 Key。前端每个 API 区标题行加「校验」按钮，结果写入该区现有状态徽标（✅/❌+原因），校验期间防重复点击。

### 对抗性验证
- VideoService 时长截断 18 项单测全过：2.5 模型三种写法截 30、普通模型截 15、配置低于/等于上限不截断、非法配置（负数/0/NaN/字符串/小数）归一、未配置默认 5、`--dur` 确认写入 prompt、`updateConfig` 运行时生效、不存在角色抛错。
- `/api/settings/test` 端到端：未知 kind 拒绝、不可达 URL 返回失败不崩溃、Key 未配置拦截、image/tts 用真实存储 Key 实测（返回 401 InvalidApiKey——当前存储的 DashScope Key 已失效，校验功能如实暴露）。
- `PUT /api/settings` 掩码 Key 跳过写入验证通过（掩码不覆盖真实值）。

### 遗留事项
- 存储 `data/settings.json` 中的 DashScope Key 已被服务端判定 401 无效，需要用户更换有效 Key。
- image/tts 校验会产生一次极小规模真实调用（用户已确认接受该费用）。
- chat 校验依赖 `GET /models` 端点，个别 OpenAI 兼容网关未实现该端点时会误报失败。

## 2026-09-09 — 修复：绘图/TTS 校验在 Base URL 只填主机时报 404

### 改动主题
`/api/settings/test` 的 image/tts 校验，当 Base URL 只填主机（如 `https://dashscope.aliyuncs.com`）时直接 POST 到根路径导致 404。

### 核心变更点
- 增加 `dashscopeUrl()` 归一：Base URL 已含 `/api/` 路径则原样使用，只填主机则自动补 `/api/v1/services/aigc/multimodal-generation/generation`，留空走默认完整地址。

### 遗留事项
- 无（实测三种 URL 形式均正确到达 DashScope，返回 401 为存储 Key 本身失效所致）。

## 2026-09-09 — 设置弹窗 API 卡片化 + 绘图/TTS 配置彻底分离

### 改动主题
设置弹窗四个 API 区块改为独立卡片（配色区分）；绘图与 TTS 不再共用写死的 DashScope 地址，各自拥有独立的 Base URL 配置并真正生效。

### 核心变更点
1. **卡片化**：新增 `.api-card` 样式，对话/绘图/TTS/视频四区各包一张卡片，左侧彩色边条区分（对话蓝/绘图紫/TTS 绿/视频橙），标题加图标。
2. **绘图 baseURL 生效**：`ImageService` 此前完全忽略 `image.baseURL`（写死 DashScope 地址），现构造/`updateConfig` 接受 baseURL 并用于生成请求。
3. **TTS baseURL 生效**：`MultimodalService` 同样接受 baseURL；`PUT /api/settings` 保存后两者各自热更新。
4. **地址归一**：两服务及校验端点统一逻辑——留空走默认完整地址；只填主机自动补 `/api/v1/services/aigc/multimodal-generation/generation`；含 `/api/` 的完整地址原样使用。

### 遗留事项
- 用户将绘图 Model 配置为 `doubao-seedream-5-0-pro-260628`（火山方舟 Seedream 图像模型），其 API 协议与 DashScope Wanx（`input.messages` 格式）不同，`ImageService` 当前仅支持 DashScope 协议，用 Seedream 模型实际生成绘图会失败；如需支持火山 Seedream 需另行适配（待确认需求）。

## 2026-09-09 — 绘图适配火山方舟 Ark（双协议自动识别）+ chat 校验兼容 Ark

### 改动主题
按用户要求：对话/绘图/视频三 API 全部适配火山方舟（视频此前已支持，对话走 OpenAI 兼容协议原生兼容），TTS 保持 DashScope 待后续指示。

### 核心变更点
1. **ImageService 双协议**：新增协议自动识别（`volces.com` 域名或 `doubao-*` 模型 → Ark，否则 DashScope）。Ark 走 `POST {base}/api/v3/images/generations`（Seedream 格式：`prompt/size/response_format/watermark`，参考图用 `image: [dataURL]` 数组），支持 `b64_json` 响应回退为 data URL 下载；DashScope 保持原 `multimodal-generation` 格式。baseURL 归一按协议分别处理（Ark 补 `/api/v3`，DashScope 补完整路径）。
2. **校验端点 image 分支**改走 `ImageService.probe()`（按协议发真实最小生成请求）；**chat 分支**在 `/models` 返回 404/405 时（火山方舟未实现该端点）回退用 `max_tokens:1` 的最小对话请求验证。
3. **前端提示**更新：对话 Base URL 说明支持火山方舟等 OpenAI 兼容地址；绘图卡片说明 doubao-* 自动走火山方舟。

### 验证
- 双协议路由 11 项单测全过（空URL/主机/完整端点 × 两协议、参考图数组、401 抛错、b64 回退、模型优先于 URL 的冲突场景）+ 视频时长 18 项回归全过。
- 端到端真实校验（用户存储的 Ark Key）：image Seedream 生成成功 ✅、chat 回退验证成功 ✅。

### 遗留事项
- TTS 仍为 DashScope 专用（含校验端点 tts 分支），待用户后续指示适配火山方舟。
- 冲突配置（dashscope 域名 + doubao 模型）按模型优先走 Ark 协议，会因主机不匹配报错，错误信息可定位。

## 2026-09-09 — 移除首页角色管理入口 + 修复 SW 缓存导致页面代码过期

### 改动主题
角色管理入口收敛到设置弹窗（去除首页重复按钮）；定位并修复"点击角色管理列表加载报错"的根因——Service Worker cache-first 导致浏览器长期运行过期页面代码。

### 核心变更点
1. **首页去入口**：删除主页功能区的「角色管理」按钮，入口仅保留设置→数据管理（与切换角色弹层职责不同，非重复功能，不做合并）。
2. **SW 修复**（`public/sw.js`）：缓存版本 `soul-v5` → `soul-v6`；页面主文档（navigate / `/` / `/index.html`）从 cache-first 改为 **network-first**（离线才回退缓存），静态资源（图标等）维持 cache-first。此前任何前端改动用户都要手动强刷才能生效，且旧页面 JS + 新接口组合极易产生疑难报错。

### 验证
- Playwright 实测复现：受控 SW 下 DOM 中设置弹窗缺「数据管理」区块、无 api-card（陈旧页面），证实根因。
- 修复后刷新两次：首页无角色管理按钮、4 张 API 卡片齐全；设置→角色管理 → 4 个角色全部加载，控制台 0 报错。

### 遗留事项
- 已访问过旧版本的用户会自动被 v6 缓存淘汰 + 页面 network-first 拉新，无需手动清缓存。

## 2026-09-09 — 修复 node --watch 启动竞态崩溃 + 编辑页角色图片点击放大

### 改动主题
修复"编辑角色保存后 `Failed running 'src/index.js'` 进程挂起"问题（根因是 `node --watch` 快速重启下的端口占用竞态，与保存逻辑无关）；编辑角色弹窗中的角色图片支持点击放大查看。

### 核心变更点
1. **启动重试**（`src/index.js`）：HTTP 监听改为 `listenHttp(attempt)` 带重试——`EADDRINUSE` 时告警并延迟 500ms 重试，最多 10 次；重试前移除上一轮 `once('listening')` 回调（对抗性测试发现的重复回调导致 HTTPS 二次 listen 崩溃，已修复）；最终仍占用则保活进程等待 `--watch` 下次变更，其他监听错误才退出。
2. **图片放大**（`public/index.html`）：新增全局 lightbox 遮罩层（点击关闭），编辑角色弹窗的角色图片绑定 `openLightbox`，`cursor:zoom-in` + title 提示。

### 验证
- 占位端口对抗测试：目标端口被占时 2 次重试后接管，banner 仅 1 次、0 报错，接口正常响应。
- Playwright 实测：点击编辑页角色图片 → lightbox 弹出显示放大图，点击关闭正常。

### 遗留事项
- 无。用户需重启自身 dev server 加载后端改动。

## 2026-09-09 — 角色头像与参考图拆分（展示与生成链路分离）

### 改动主题
此前"头像即参考图"（单图存为 avatar.* 且上传时删除目录内其他图片，getReferenceImagePath 取任意首图），换头像会覆盖生成用立绘。本次拆分为两个独立文件、两条独立链路。

### 核心变更点
1. **CharacterManager**：新增 `saveImage(id, kind, ...)`（kind = avatar/reference，只清理同类旧文件，原子写）；`getReferenceImagePath` 严格匹配 `reference.*`（供 ImageService 自拍 / VideoService 视频参考），新增 `getAvatarPath` 严格匹配 `avatar.*`；`_loadAll` 内置旧数据迁移（无 reference.* 时把旧图重命名为 reference.*，对存量 no-op——现有角色本就是 reference.* 命名）。
2. **路由**（src/index.js）：新增 `GET /avatar`（无头像回退参考图防空白）与 `POST /reference`；魔数校验抽为 `detectImageExt` 复用；multer 超限错误映射 413（原先落 500）。
3. **前端**：编辑器拆为"头像（圆）+ 参考图（方）"双上传位，均支持点击放大（lightbox）；首页/聊天页/角色详情/角色管理列表展示端点全部切到 `/avatar`。

### 验证（对抗性，13 项）
- 正向：双图上传共存、换参考图只清旧参考图、GET 读取、无头像回退参考图、浏览器真实上传闭环（avatar.jpg 与 reference.jpeg 共存）。
- 对抗：文本伪装图 400、不存在角色 404、缺文件 400、超 5MB 413、上传中断孤儿 .tmp 清理。
- 测试用临时角色已彻底删除，真实角色数据已还原。

### 遗留事项
- 仅魔数校验，构造的"假 png"（合法魔数+乱数据）可入库（预期内策略，展示会裂图但不影响生成链路）。

## 2026-09-09 — 界面英文残留全面中文化（天气/情绪/事实标签）

### 改动主题
用户反馈首页出现 "comfortable +0"、"☁ Patchy rain nearby" 等英文。根因：① wttr.in 天气英文描述仅在命中 17 条映射时才翻译，未命中原样透传；② 库中遗留旧版情绪状态值（comfortable）不在前端标签映射内；③ 用户画像 fact_key 旧版 prompt 刻意要求英文类别并原样展示。

### 核心变更点
1. **EnvironmentService**：天气映射扩至 wttr.in/worldweatheronline 全部约 50 种描述（mood 中文短标签 + effect 心情旁白）；未命中统一兜底"天气多变"，绝不透出英文；空描述 'Unknown' → '未知'。
2. **前端情绪标签**：moodLabels/statusBadge/消息胶囊三处补 comfortable/neutral/normal 别名，未知状态兜底"情绪波动"；"LEVEL UP!" → "升级啦！"。
3. **FactExtractor**：prompt 改为要求中文类别（新数据直接中文）；前端新增 factKeyZh 翻译层覆盖存量英文 key（hometown→家乡 等约 25 项）。

### 验证
- 8 项映射测试全过：原始用例 Patchy rain nearby→"有零星雨"、常见天气、未知/空/大小写变体描述兜底、映射表全中文、prompt 不透英文。

### 遗留事项
- 存量英文 fact_key 若不在翻译表内的冷门类别仍原样显示（可按需扩充 FACT_KEY_ZH 表）；新提取数据已是中文。

## 2026-09-09 — 修复 lin_004 角色 full_name 乱码

### 改动主题
UI 中"小林"角色全名显示为乱码：`lin_004.json` 的 `full_name` 已损坏为 6 个 U+FFFD 替换符（原始字节丢失，损坏发生在本次修复前的某次写入）。经当日 Playwright 页面快照确证原名为"林语柔"，已写回并全量扫描 4 个角色档案 + 记忆文件，无其他损坏。

## 2026-09-09 — 角色编辑弹窗布局固定 + 关闭/返回交互统一

### 改动主题
角色编辑/新建弹窗复用设置弹窗的固定布局模式：标题行（"编辑角色 · X"/"新建角色"）与底部按钮固定，中间内容区独立滚动；关闭图标与底部返回按钮均"返回上一层"（重开角色管理列表并刷新，可即时看到保存后的名字等变化）。Playwright 实测：滚动时标题/保存按钮位置不变、返回后列表正常加载 4 个角色。

## 2026-09-09 — 角色编辑页签改 Tab 标签样式 + 雷区输入框样式修复

### 改动主题
"表单编辑 / 高级 JSON"由普通按钮改为标准 Tab 标签切换（底部高亮下划线指示激活页）；顺带修复雷区（触发词为正则）行内输入框无样式问题（未包 .field 容器导致裸样式），补齐与表单一致的边框/圆角/背景/聚焦色。Playwright 截图实测确认。

## 2026-09-09 — 修复角色编辑弹窗危险操作按钮底边被裁切

### 改动主题
"危险操作"区（重置状态/删除角色）位于滚动区末尾，按钮底边因亚像素舍入被滚动容器裁掉约 0.33px，视觉上底边缺一条。滚动区补 `padding-bottom:8px` 修复，实测按钮底边完整（余量 7.7px）。

## 2026-09-09 — 参考图固定模板升级为完整角色设定图 + archetype 中文化

### 核心变更点
1. **参考图固定模板**（`src/index.js` REFERENCE_TEMPLATE + 前端 `public/index.html` 模板展示/提示文案）：由原英文"白底三视图+4表情"升级为完整角色设定图模板——白底图解式排版，含正/侧/背三视图、3~5 个表情（平静/警觉/愤怒/微笑/受伤/沉思）、服装装备拆解区（细线标注 + 局部放大图）、右下角 5~7 色配色板（主色/辅助色/金属色/皮肤色/发色/强调色）、页底世界观说明；风格段与负面避免清单齐备。
2. **archetype 全链路简体中文**：ImageService 穿着库键名 tsundere/loli/oneesan/neighbor → 傲娇/萝莉/御姐/邻家；4 个角色档案存量值同步迁移（char_mtu8dfjjamin 为空不动）；编辑弹窗输入框 placeholder 改为中文示例。

## 2026-09-09 — 头像/列表缩略图点击放大查看

### 核心变更点
复用页面既有 Lightbox（`imgLightbox`，等比缩放 `object-fit:contain`，点击遮罩关闭）：聊天头部头像（setAvatar）与角色管理弹窗列表缩略图均支持点击放大，缩略图加 `cursor:zoom-in` 提示；点击列表缩略图 `stopPropagation` 不触发卡片选中。

## 2026-09-09 — 角色管理列表支持直接删除角色

### 核心变更点
角色管理弹窗列表每行新增红色"删除"按钮（编辑旁），点击后弹确认框输入角色全名校验（与编辑器危险区同机制），通过后调 `DELETE /api/characters/:id?confirm=全名`；成功后刷新管理列表并同步主页角色列表/聊天选中状态，无需先进编辑页。

## 2026-09-09 — 角色编辑弹窗危险操作按钮移至底部按钮行

### 核心变更点
"重置状态/删除角色"从滚动区末尾的危险操作区块移入底部按钮行，与"返回/保存"同一行（space-between 布局：返回居左、危险操作居中、保存居右）；滚动区相应缩短。`ceDanger` 显隐逻辑保留（新建未保存时隐藏，编辑/首次保存后显示，显示值由 block 改为 inline-flex 以使 gap 生效），按钮文案精简为"重置状态"（原括号说明改为 hover 提示）。

### 整改（同日）
底部按钮行布局调整：重置状态/删除角色靠左（`margin-right:auto`），返回/保存靠右；危险操作隐藏时返回/保存仍保持右对齐。

## 2026-09-10 — 修复偶现「加载角色列表失败：Failed to fetch」

### 根因
`Failed to fetch` 为网络层失败（非 HTTP 错误），请求发出时后端进程不可达：`src/index.js` 存在多条会让 Node 进程直接 crash 的未处理 rejection 路径（Node ≥15 默认 crash），dev 模式 `node --watch` 自动拉起进程，重启窗口期（含 EADDRINUSE 500ms×N 重试）内所有请求报 Failed to fetch，随后自动恢复——与"偶现"吻合。

### 核心变更点（均在 `src/index.js`）
1. **定时任务就地 catch**：凌晨 1:30 日程生成、2:00 日记生成的 `setTimeout` 回调补 try/catch；日记回调的 `scheduleOvernightTasks()` 递归改至 finally 位置语义（catch 后仍执行），修复"一次失败定时任务永久停摆"的连带缺陷。
2. **30 分钟情绪事件 interval** 补 try/catch（同步抛错即 uncaughtException）。
3. **`POST /api/diaries/generate` 路由**补 try/catch（Express 4 不捕获 async 错误，此前 rejection 直接击穿进程）。
4. **全局兜底**：新增 `process.on('unhandledRejection')` 告警降级（最后一道防线，未来任何遗漏不再击穿进程）。

### 验证
`node --check src/index.js` 语法通过；Service Worker 对 `/api/characters` 已是 network-first + 缓存兜底，服务端止血后无需前端改动。
