## 2026-09-11 — 新增 Live2D 模型 character（PSD2Live 流水线从设定表生成）

### 改动主题
用 .scratch/psd2live 流水线把角色设定图转成 Live2D 模型并接入网页预览。初版走"Seedream 重绘分层"路线（AI 重绘各部件，质量不稳），最终版改为"能动才生成"：单张 12 格设定表直接切割原始像素部件，仅嘴部用 Seedream 生成，部件间天然风格一致。

### 核心变更点
1. **切割**（`work/tools/slice-sheet.cjs`）：12 格设定表按行列窗口 + INSET 防白边框线污染，5×5 邻域密度过滤细线/文字，眼白近白特判 + 连通域去噪 → 12 个部件 PNG
2. **嘴部生成**（`gen-mouth.cjs` + `extract-mouth.cjs`）：Seedream `<bbox>` 局部编辑生成最大开嘴（唇+齿+舌），肤色键控提取，符合 PSD_LAYER_SPEC"闭嘴由 ParamMouthOpenY=0 压缩"契约
3. **配准组装**（`assemble.cjs` + `build-psd2.cjs`）：全身图为风格参照非配准目标（部件间自洽、与全身图比例不一致 1.77×）；脸部锚定 + 衣物非等比缩放（sx≠sy），眼睛三件套按连通域逐元素放置；13 层 PSD（08 拆眉/睫两层）按 PSD_LAYER_SPEC 语义命名，K=3 → 960×2340 画布
4. **导出部署**：PSD2Live CLI 出全量文件族 → `public/live2d/models/character/`（gitignore 不入库）；`/api/live2d/models` 已列出 id=character，可在角色档案 live2d_model 中选用
5. **边缘清理**（`clean-edges.cjs`）：切割窗口边缘残留的表格边框线列/行自动清除（曾造成渲染时身体右侧 1px 灰色竖线伪影）
6. **临时预览页**：public/live2d/preview-test.html（加载指定模型的独立预览页，验证用，可按需删除）

### 验证
Playwright 实测：模型渲染完整（蝴蝶结/发型/五官/露肩卫衣/长裤），眨眼、idle 摇摆正常，`applyAmplitude(1)` 嘴型正确张开（口腔/唇线符合契约）；清 SW 缓存后无伪影。

### 遗留事项
- 眉/睫 ArtMesh 默认姿态与 PSD 有 ~5px 网格收紧偏差（流水线警告，视觉无明显影响）
- 头部放大特写分辨率受部件原尺寸限制，可后续用 Cubism Editor 修
- PWA SW 缓存（soul-v9）更新模型文件后需清缓存才能看到新版


# CHANGE.md — 项目迭代记录

## 2026-09-10 — 忙碌系统人性化改造：一心二用聊天 + 好感分档惩罚/回复速度

### 改动主题
用户反馈上一条"打断忙碌"修复惩罚过狠、且忙碌期间不知道什么时候能正常聊天。重新设计忙碌系统：除睡觉外都可一心二用聊天，惩罚与回复速度按好感度分档。

### 核心变更点
1. **非睡觉活动可边忙边聊**（ChatService）：忙碌中收到消息时，非"睡觉"活动（开会/上课/洗澡等）不再回预设短语挡人，直接走完整聊天管线；prompt 注入 `[特殊状态]` 忙碌上下文（DynamicPromptBuilder 新增 `busyMultitaskContext`）——回复简短、带分心痕迹、偶尔提手头的事；正常结算好感/经验；meta 带上 `busyRemaining`/`busyActivity`
2. **睡觉保持独占**：预设梦话 + 连发 5 条吵醒逻辑不变；但心情惩罚从固定 -15 改为按好感分档（≥60 → -6，30-60 → -10，<30 → -15，"感情越好越舍不得气你"）；上一条的好感打扰惩罚同步分档（≥60 → -0.1，30-60 → -0.2，<30 → -0.3），经验仍归零
3. **忙碌聊天回复速度按好感分档**（`_calcReplyDelay` 新增 busyMultitask/affection 参数）：好感 ≥60 → 2-5s（舍得抽身秒回），30-60 → 5-9s，<30 → 8-14s（爱答不理）
4. **"不知道什么时候能聊"缓解**：非睡觉活动随时可聊；睡觉保持倒计时（busy-bar 显示剩余分钟）

### 遗留事项
- 活动类型由合并判断 LLM 产出（"睡觉"字样匹配），若 LLM 产出同义活动名（如"午睡"）会落入一心二用分支——当前可接受
- 各分档阈值为初始经验值，可按体验调参

## 2026-09-10 — 修复：打断忙碌被吵醒时好感度反而上涨、经验照发

### 改动主题
用户反馈：角色正忙（编制预算报表、明显烦躁）时连续发消息把角色吵醒，回复"别发了，吵到我了"，但结算却显示 好感 +0.2、+9xp——被打扰的负面交互反而得分。

### 核心变更点
（ChatService）被迫从忙碌中醒来（`justWokenUp`）的这轮交互按负面交互结算：
1. **取消基础正增长**：`baseGrowth` 归零（正常聊天的 +0.05 缓慢积累不适用于打扰场景）
2. **消息正情绪不缓解打扰**：结算权重取 `min(weight, 0) + 打扰惩罚`——即使消息本身友善（如关心、道歉），也至少负结算（对应被吵醒的烦躁），负面消息照常负结算
3. **经验归零**：`growth.xpGained` 强制 0（气头上不给成长奖励）
注：本条后已被下一条"忙碌系统人性化改造"细化为按好感分档惩罚；非睡觉活动的打扰不再惩罚（本就可一心二用）。

## 2026-09-10 — 角色背景视频：聊天页角色形象视频背景 + 右上角开关

### 改动主题
聊天页新增角色背景视频层：每个角色可配置一条宣传视频（由用户在外部视频生成平台用角色参考图生成），切换角色后作为对话框背景循环播放，chat-header 右上角提供开关按钮，按角色记忆开关状态。

### 核心变更点
1. **背景视频层**（public/index.html）：`#chatPane` 内新增绝对定位 `.bg-video-layer`，视频（muted+loop+playsinline 自动播放策略兼容），上层叠浅色渐变"白玻璃"遮罩（rgba(253,248,245) .22→.45，偏透保持视频可见度）保证气泡可读性；`#chatPane` 直接子元素统一 z-index 抬升避免被视频覆盖；聊天气泡文字加深为 #3a2e2a 提升醒目度；时间戳改白色药丸底+深色加粗字（user 侧 margin-left:auto 保持右对齐）；内心独白（.thought）底色改近实白 rgba(253,248,245,.88) + 文字加深为 #8a5a52
2. **开关按钮**（chat-header 🎬 图标）：点击切换显示/隐藏，状态按角色存 localStorage（`bgVideo:<charId>`，默认开启），按钮半透明表示关闭态
3. **降级与性能**：HEAD 探测视频不存在时按钮与图层一起隐藏（静默降级）；视频 src 按角色缓存避免重复加载；手机端返回主页自动暂停播放省电；HEAD 响应过期（已切角色）自动忽略
4. **视频来源约定（双比例，命名以用户格式为准）**：桌面端用 16:9 `public/videos/bg_<charId>_16.9.mp4`，手机端用 9:16 `public/videos/bg_<charId>_9.16.mp4`，走现有 express.static，无需新路由/后端改动；某比例缺失时 HEAD 探测自动回退另一个，视口跨越 900px 断点自动重新选比例；生成时使用角色参考图（`data/characters/<id>/reference.png`）+ 性格化提示词在外部视频平台生成
5. **构图修正**：背景视频 `object-position: center 35%` 上偏取景（人脸通常在画面上部），缓解"人物偏下"的裁切观感
6. **修复历史消息气泡无白底**（浅遮罩后暴露的存量问题）：历史加载的 AI 消息 class 为 `assistant`，但气泡白底/左对齐规则只覆盖了 `ai`，导致历史 AI 气泡一直透明底；已补齐 `.msg.assistant` 选择器

### 遗留事项
- 角色管理弹窗暂未集成"生成/上传背景视频"入口（当前手动放文件到 `public/videos/`）

## 2026-09-10 — 拟人化三期：链路断点修复、敷衍消息拟真反应、语音条消息

### 改动主题
修复二期引入的合并意图判断参数错位断点；新增两项拟真增强：超短敷衍消息低概率只回极简短句（跳过 LLM）、心情好且关系亲近时低概率把一条回复转成真实 TTS 语音条。

### 核心变更点
1. **P0 修复**（ChatService）：`_judgePhotoAndBusy` 内部调用 `_buildJudgmentContext` 少传 2 个参数，导致照片/忙碌合并 LLM 判断自二期上线以来**从未生效过**（绑定对象抛错被 try/catch 静默吞掉）。修复后已验证 AI 忙碌判断实际产出（日志出现"AI忙碌判断"并正确进入忙碌状态）
2. **敷衍消息拟真反应**（ChatService 新增 `_shouldReplyPerfunctory` + 4.5 分支）：超短应答消息（≤6 字、情感权重 ≤-0.3，复用 EmotionEngine 敷衍检测）低概率不再走 LLM 长回复，只回「嗯」「？」「...」级短句——心情差概率 0.4 / 平静 0.25，心情好（≥20）永不敷衍；雷区/道歉/刚和解/上一条已敷衍过 均不触发；好感度照常结算但不给经验。已端到端验证（"哦" → "..." mood=-80）
3. **语音条消息**（ChatService + MultimodalService + 前端）：心情 ≥20 且好感 ≥40 时 15% 概率把一条 2-25 字回复经火山 TTS 合成语音条（角色 voice_preset 音色 + 情绪语气/语速注入），SSE 新事件 `voice_message`，前端语音气泡点击播放；TTS 失败自动降级为文字补发；语音文本单独以 `role='voice'` 入库（JSON `{f,d}`），assistant 文本记录不再含该句避免历史重复展示，LLM 上下文查询（user/assistant）不受影响。DB 迁移：`chat_history.role` CHECK 约束重建加入 `'voice'`（新表补齐存量 `is_proactive`/`read_at` 列，存量 37 行数据完整迁移）；`getFullChatHistory` 查询加入 voice role；`public/voices/` 落盘并加入 .gitignore。已端到端验证（两轮各触发 1 条真实 mp3，51KB/37KB，人设与上下文连贯）
4. **前端**（index.html + sw.js）：`voice_message` SSE 事件处理、历史记录 voice 气泡渲染、`playVoice` 播放/暂停函数、语音气泡 CSS、SW 缓存 soul-v8 → soul-v9

### 遗留事项
- 存量（非本次引入）：doubao-seed 思考模型偶发思考时间 >60s，表现为"正在输入"长时间停留；偶发把内部推理文本泄漏进 reply（本次冒烟观察到 1 次）；建议后续评估关闭思考或换模型
- 语音条与敷衍反应的触发概率（15%/25-40%）为初始经验值，需实际体验后调参
- 验证消耗：真实 TTS 配额 2 次小请求；冒烟测试脚本在 `.scratch/`（test-humanization.mjs 18 项断言全过、test-chat-e2e.mjs）

## 2026-09-10 — 拟人化二期：情绪惯性、离线未读消息、链路提速与状态一致性

### 改动主题
在一期拟人化基础上落地 9 项增强：情绪惯性（吵架连击 + 和解敏感期）、离线主动消息未读补投机制、照片/忙碌双判断合并为单次 LLM 调用（每轮省一次往返）、情感分析否定反转与敷衍检测、meta 心情指标统一为状态机结果、记忆检索时间衰减、内心独白反哺对话、主动消息情绪注入与频率人格化、说话风格随关系阶段漂移。

### 核心变更点
1. **情绪惯性**（EmotionStateMachine + DB 新列 `neg_streak`/`sensitive_until`）：连续负面消息惩罚递增（每多连击一次额外 -2 封顶 -10，正面消息/道歉重置）；和解（真诚道歉或冷战自然到期）后进入 24h 敏感期——雷区惩罚 ×1.5、道歉恢复减半、负面情绪放大 ×1.5；心情 ≥50 时对轻微冒犯更宽容（×0.7）
2. **离线主动消息**（ProactiveService + chat_history 新列 `is_proactive`/`read_at` + characters_state 新列 `last_proactive_at`）：30 分钟定时器新增离线对扫描（排除在线/冷战/忙碌/低好感，随机抽样 ≤5 个防 LLM 突发），生成消息入库为未读；用户上线 register 时按 2-4 秒间隔补投并标记已读，前端显示原始发送时间；频控时间戳持久化，重启不丢
3. **链路提速**（ChatService）：原照片意图判断与忙碌状态判断两次串行 LLM 调用合并为 `_judgePhotoAndBusy` 单次调用（显式标记仍优先，无标记才走 AI 判断）
4. **情感分析增强**（EmotionEngine）：否定反转（"不喜欢你"→负、"不烦"→正，前 3 字符窗口检测）；敷衍检测（整条消息 ≤4 字且仅由 哦/嗯/呵/切 等应答字构成 → -0.5）；词表扩充（抱抱/想你了/晚安、呵呵/烦死了/少管我 等）
5. **心情指标统一**（ChatService meta）：`mood`/`moodDescription` 改由状态机 moodLevel 派生（`getMoodDescription` 带图标），消除好感度映射与状态机心情可能矛盾的展示
6. **记忆时间衰减**（MemoryService）：检索结果按 命中次数 × exp(-Δdays/14) 重排，近事更容易被想起；超短消息（嗯/哦）检索为空时用最近 3 条用户消息扩展查询重试一次
7. **内心独白反哺**（ChatService + DynamicPromptBuilder）：上一条独白（3 天内）以"[心声余波]"注入 prompt，话题相关时可让角色自然流露当时心结，禁止复述原文
8. **主动消息人格化**（ProactiveService）：推送频率按好感度分档（>80 亲昵 30min / >50 朋友 1h / 其余 2h）；prompt 注入当前心情值与敏感期试探指令，心情差时主动开口带情绪
9. **说话风格漂移**（DynamicPromptBuilder）：行为约束按关系阶段附加微指令（警惕阶段克制语气词 → 亲密阶段允许撒娇黏人）
10. **其他**：忙碌短语支持角色档案 `busy_responses` 覆盖（默认池兜底）；生气时 30% 概率"已读不回"延迟 10-16s；雷区正则预编译缓存；TimeService 活动缓存超限自动清理非当天条目

### 遗留事项
- 撤回重发拟真细节（发错字→撤回→重发）需前端事件协议支持，本轮未做
- 情感分析仍为纯本地规则（未加 LLM 复核兜底），反讽语调识别有限
- 离线主动消息已在启动冒烟中实际生成验证；补投展示建议浏览器人工体验确认

## 2026-09-10 — 拟人化整改：链路断点修复 + 6 项拟真增强

### 改动主题
修复审查发现的 5 处功能链路断点，并落地 6 项拟人化增强：情绪加权心情、道歉提前和解、冷战到期主动和解、主动消息入库与多样化、回复拟真延迟、服务端分条推送、中文长期记忆修复、TTS 语速情绪调制、记忆自然回忆规则。设计文档：`docs/superpowers/specs/2026-09-10-humanization-design.md`；实施计划：`docs/superpowers/plans/2026-09-10-humanization-implementation.md`。

### 核心变更点
1. **P1 链路修复**：`chatStream` 心情更新统一收敛到 EmotionStateMachine 单一入口（删除 EmotionEngine.updateMood 死代码，心情波动加入情感权重 `weight` 加成）；LLM 回复中的 `[发照片:xx]`/`[去忙:xx:x]` 标签在推送前清洗；`chatStream` 支持 `maxTokens`（心情 < -20 限 200、< -50 限 120，心情差话变少）
2. **P2 冷战和解三件套**：DB 新增 `cold_war_reason`/`cold_war_phrases` 列；真诚道歉（长度 ≥8 或情感权重 ≥0.3 且非敷衍词）触发提前和解（心情 +30 但不超过 0，进入 uneasy）；敷衍冷战回复改为 LLM 生成 5 条角色专属嘴硬短语按序消耗，用完回退档案 `cold_war_responses`；`ProactiveService` 新增每分钟冷战到期检查，主动生成和解消息入库并推送
3. **P3 主动消息**：回归消息与定时主动消息全部入库（`saveChatMessage` role=assistant），保证后续对话上下文连贯；消息源按优先级多样化（约定提醒 > 情绪事件 > 日记分享（禁止说"我写了日记"）> 当前活动）
4. **P4 分条拟真推送**：服务端把 LLM 回复按换行拆条，首条前按情绪加拟真延迟（joyful 0.8-2s ~ angry 3.5-6s，刚睡醒 4-8s），条间发 `message_end` + `typing` + 0.6-1.5s 停顿；前端按 `message_end` 分条渲染气泡、`typing` 控制输入指示器；历史记录 assistant 消息按换行拆分渲染
5. **P5 中文记忆修复（关键存量 bug）**：Orama english tokenizer 丢弃全部中文 token → 自定义 CJK 2-gram tokenizer（新增 `grams` 字段建索引，建/查共用同一分词器）；修复 `load()` 单参调用导致**重启后长期记忆全量丢失**的严重 bug（Orama 3.x 需两参 load）；旧格式索引文件自动用旧文档重建、损坏文件降级空库
6. **P5 其他增强**：TTS 情绪语速调制（angry 1.15 / joyful+happy 1.05 / uneasy 0.95，资源不支持时自动去语速重试一次）；长期记忆注入 prompt 增加"自然回忆"使用规则（话题相关顺带提、禁复述原文、禁批量罗列、禁"我记得"式生硬展示）

### 遗留事项
- 设计偏差说明：设计文档提到"伤心 0.9"语速，但状态机无 sad 状态，映射为 uneasy→0.95
- 拟真延迟与分条推送已冒烟验证（SSE 事件序列正确）；情绪分条 + 冷战全流程建议在真实浏览器端人工体验验证
- TTS 语速调制经单测映射验证 + 降级兜底，未用真实 anger 状态打火山接口（避免烧配额）

## 2026-09-10 — 语音体系切换火山豆包（TTS + 实时通话 + 每角色音色）

### 改动主题
集成火山引擎豆包语音，文本转语音与实时对话语音全部替换阿里云 DashScope（不留双供应商），每个角色可在角色编辑器选择自己的音色，TTS 与实时通话两通道按角色配置统一发声。

### 核心变更点
1. **MultimodalService**：DashScope Qwen3-TTS → 火山单向流式 TTS（`POST /api/v3/tts/unidirectional`，seed-tts-2.0）；情绪/说话风格经 `context_texts` 指令遵循注入；chunked 多段 JSON 解析（括号配平，容忍半包/粘包/坏段）；错误码翻译（401/资源未开通 45000030/InvalidSpeaker）；火山成功结束帧 `code=20000000` 特判放行（实测发现，否则每次成功合成都被误判为错误）
2. **VoiceCallService**：DashScope Qwen-Omni-Realtime → 火山 Seeduplex 全双工 S2S（`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`）；鉴权须同时带 `X-Api-Key` 与 `X-Api-Resource-Id: seeduplex_realtime_dialogue`（实测得出，文档未写明）；20ms/640B 节奏转发器（协议强制，48KB 有界队列丢最旧）；AI 说话时静音声明（`input_audio_mute/unmute.commit`）；`session.close` 优雅挂断 + 2s 强断兜底；握手竞态守卫（open 晚于挂断时 terminate，防定时器泄漏与孤儿会话）；Socket.IO 事件协议不变，前端零改动
3. **音色体系**：从代码硬编码（CHARACTER_VOICE_CONFIG）改为角色档案 `voice_preset` 字段（火山音色 ID，TTS 与实时通话通用，无配置回退 Vivi 2.0）；新增 `VoiceCatalog.js` 精选 20 个伴侣向音色，`GET /api/voices` 下发；内置 4 角色迁移：芊悦→傲娇女友、千雪→可爱女生、四月→成熟姐姐、苏瑶→温柔小雅（实测旧值含 Sunny/Katerina 一并迁移）
4. **角色编辑器**：音色下拉 + 自定义音色 ID（声音复刻）+ 试听按钮；`POST /api/tts` 支持可选 `speaker` 覆盖（校验：非空字符串 ≤128）
5. **设置页**：TTS 段改为火山 `apiKey` + `resourceId`（TTS 与通话共用 Key，留空 resourceId 回退默认）；`/api/settings/test` tts 校验改为火山探测（区分 401/资源未开通/可用）
6. **验证状态**：TTS 真实合成已验证（HTTP 200 合法 mp3，581ms，音色读档案生效）；Seeduplex 握手已验证（session.created）；浏览器麦克风全链路通话待验证

### 遗留事项
- 实时语音通话的浏览器端全链路验证（麦克风→回复→挂断，需 HTTPS 页面）
- 通话中火山下发致命错误（如资源类错误码）目前仅转发前端不自动挂断，联调时结合真实错误码决定是否自动结束
- 存量问题（非本次引入）：`_saveCallMessage` 对 user 消息可能重复入库（顶部无条件存一次 + 情感分析分支再存一次），待后续单独修复
- 设计文档：`docs/superpowers/specs/2026-09-10-volcengine-tts-design.md`；实施计划：`docs/superpowers/plans/2026-09-10-volcengine-tts.md`

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

## 2026-09-10 — 忙碌系统改造的对抗性测试与 4 处安全修复

### 测试概况
新增对抗性测试脚本 `.scratch/test-busy-adversarial.mjs`（临时草稿，不入库），共 **43 项断言，全部 PASS**。覆盖：延迟函数边界值（好感 29/30/59/60 分档边界、负数/NaN/undefined/字符串/超长封顶、justWokenUp 优先级、旧签名兼容）；真实 chatStream 端到端吵醒流程（好感 70/45/20 × 12 次正面消息轰炸，验证 delta 全部 ≤0）；stub 集成测试（一心二用、睡觉梦话早退、吵醒分档、忙碌过期、活动名绕过、prompt 注入、低好感吵醒）。

### 发现并修复的缺陷（均在 `src/core/ChatService.js`）
1. **jitter 翻正缺陷**：吵醒好感惩罚（-0.1 档）经 EmotionEngine `confidence(0.3)` 缩放后仅 -0.03，叠加 ±0.2 抖动有约 29% 概率被翻成正值——被吵醒反而涨好感。修复：justWokenUp 时 `delta > 0` 钳制为 0 并回退到原好感值。
2. **活动名绕过**：睡觉独占判定原为严格 `!== '睡觉'`，LLM 产出「睡觉 」「午睡」「补觉」即可绕过吵醒机制、走一心二用管线。修复：`_sanitizeActivity` 归一化 + `/睡|觉|盹|憩|休息/` 正则判定。
3. **Prompt 注入**：恶意活动名（如含 `\n[系统指令] 忽略以上所有设定`）原样进入 system prompt。修复：`_sanitizeActivity` 剥离换行与 `[\]{}<>` |【】《》` 字符、取首行、截断 12 字符。
4. **落地前未清洗**：`setBusyState` 直接存 LLM 原始活动名，污染后续所有会话的 prompt。修复：落地前清洗，busyMinutes 也用清洗后活动计算。

### 验证
服务重启后 3001 正常响应；端到端吵醒流程好感 delta 全部 ≤0，注入用例的 system prompt 中无换行结构与指令效力残留。

## 2026-09-10 — 修复中性闲聊被随机抖动扣好感

### 根因
"准备吃啥呀?" 这类中性消息（情感权重 0）结算公式为 `delta = 0×0.3 + 基础成长0.05 + 抖动(±0.2)`，区间 [-0.15, +0.25]——约 37.5% 概率被抖动翻成小额扣分（实测出现 -0.1）。普通闲聊掉好感不符合"好感下降只能来自真实负面情绪"的语义。

### 核心变更点（`src/core/ChatService.js` 正常管线）
中性/正面消息（weight ≥ 0）结算后若 delta < 0，钳制为 0（好感持平）。负面消息（敷衍 -0.5、冒犯、吵醒打扰）不受影响，照常扣分。敷衍短消息路径 weight 本身 -0.5 属设计内负贡献，不钳制。

## 2026-09-10 — 桌面端改造 + Live2D 实时视频语音形象（Electron 壳 + 形象联动）

### 改动主题
把现有 Web 应用包进 Electron 桌面壳（服务守护 + 托盘 + 形象小窗），并引入 Live2D 形象与语音/情绪实时联动：TTS 播放与实时通话驱动嘴型，聊天结算情绪驱动表情，失焦时主动消息走系统通知。网页模式 `npm start` 完全保留不受影响。

### 核心变更点
1. **Electron 桌面壳**（`src/desktop/`：主进程 / 服务守护 / 窗口 / 托盘）：spawn 系统 Node 子进程跑现有后端（零后端侵入），`npm run desktop` 启动；端口读 `.env`（`config.js`，dotenv）；托盘、开机自启、单实例锁、端口预占检测；主窗口加载 `http://127.0.0.1:<port>`
2. **Live2D 形象**（`public/live2d/`）：PixiJS + pixi-live2d-display + Cubism Core（专有许可不入库，.gitignore）；示例模型 Haru（替代原计划的 Hiyori，官方链接不稳定；免费素材许可，模型目录 gitignore 不入库）；主窗口聊天页形象区 + 模型损坏时 catch 降级隐藏
3. **嘴型联动**：聊天 TTS / 语音条（`playWithAvatar` + AnalyserNode RMS）与实时通话下行链路统一采集振幅，经 `BroadcastChannel('avatar')` 同步主窗与小窗；`ampOwner` 归属校验防跨音频误关嘴型
4. **情绪联动**（后端唯一改动）：`/api/chat` 结算后 emit `avatar:emotion`（含 userId 防多用户串扰），前端校验 characterId+userId 后映射 9 种情绪状态到 Live2D 参数
5. **形象独立小窗**：透明置顶无边框窗，整窗可拖动（小窗牺牲视线追踪换取拖动，主窗视线正常）
6. **系统通知**（public/index.html）：主动消息在 Electron 内且主窗失焦时走 HTML5 Notification（自动转系统通知）；权限仅在 Electron 内一次性请求，网页模式不打扰
7. **断线重连修复**：socket `connect` 时补发 `register`（后端子进程重启后服务端注册丢失，主动消息不再静默丢）
8. **桌面端断线遮罩**：后端子进程崩溃/重启时全屏遮罩提示，重连成功自动消失

### 迭代期发现的库级缺陷与规避（评审确认）
- pixi-live2d-display 嘴型/情绪参数必须挂在 `PIXI.Ticker.shared`（`app.ticker` 跨 ticker 优先级无效，参数会被动作同帧冲掉）
- pixi 7 无 InteractionManager，视线追踪改 `window mousemove` + `model.focus`
- `autoDensity` 会冻结 canvas 内联样式，CSS 覆盖需 `!important`
- AudioContext 需在用户手势栈内预热（Safari 静音风险）
- 振幅循环需 `ampOwner` 归属校验，防止前一段音频的 `onended` 误关新音频的嘴型

### 遗留事项
- electron-builder 打包、通话实时情绪分析、模型替换 UI、小窗尺寸记忆、开始菜单快捷方式
- 对抗性用例中托盘行为/开机自启/二次启动单实例锁/端口预占对话框/子进程崩溃重启需用户在桌面模式下手动验证

### 验证
网页模式回归：页面 0 新增报错（仅预存在 favicon 404）、Live2D 形象正常挂载渲染、聊天 UI 与角色列表完整；对抗性用例（畸形振幅 -5/1e9/'x'/NaN/null、非法情绪 `<script>`/`constructor`/`__proto__`/缺字段、`applyAmplitude` 直连畸形值、通知守卫 permission='default' 求值）全部通过——振幅钳制 [0,1]、`Object.hasOwn` 防原型污染、无异常无崩溃；模型损坏降级路径经代码审查确认（catch → 销毁 app → 隐藏容器）。

## 2026-09-11 — Live2D 多模型按角色配置（模型清单 API + 运行时切换 + 小窗握手联动）

### 改动主题
Live2D 形象从单一 Haru 升级为按角色配置多模型：目录即清单的模型 API、角色档案 `live2d_model` 字段、avatar.js 运行时安全切换（防并发乱序/纹理泄漏）、主窗/小窗经 `model-request` 握手与 `model` 广播联动跟随，角色编辑器提供形象下拉框。设计文档：`docs/superpowers/specs/2026-09-11-live2d-multi-model-design.md`；实施计划：`docs/superpowers/plans/2026-09-11-live2d-multi-model.md`。

### 核心变更点
1. **模型清单 API** `GET /api/live2d/models`：目录即清单——扫描 `public/live2d/models/` 下含 `*.model3.json` 的子目录，无配置文件；目录异常时返回空清单，前端回退默认
2. **角色档案新增 `live2d_model` 字段**：`listCharacters` 白名单透传；编辑器 patch 保存零侵入
3. **avatar.js 运行时模型切换 `loadModel`**：单调序号（loadSeq）防并发乱序覆盖（最后意图获胜）；作废请求只销毁子节点不碰共享缓存纹理；旧模型 `destroy({texture:true,...})` 释放 GPU 纹理防长驻泄漏；失败保留当前形象（不触发降级隐藏）
4. **小窗握手**：小窗 mount 后广播 `model-request`，主窗应答当前模型（IS_OVERLAY 方向过滤防双窗互答）；主窗切角色广播 `model` 消息，小窗跟随切换
5. **角色编辑器**：新增"Live2D 形象"下拉框（默认（Haru）/hiyori/natori），保存即生效
6. **模型资产**：Hiyori + Natori（与 Haru 同为官方 CubismWebSamples 免费素材，gitignore 不入库；三个目录均通过引用完整性校验）

### 对抗验证与端到端联动验证
- 对抗用例：畸形/注入 url（非字符串/非站内路径/扩展名不符）拒绝；同 URL 并发加载不腐蚀共享纹理；A→B→A 快速切换竞态最后意图获胜；档案指向已删模型回退 haru；连续 6 次切换无叠加、纹理正常释放
- 双页面模拟（Playwright，SW 屏蔽，BroadcastChannel 协议探针 + moc3 资源加载观测 + 小窗 canvas 截图像素比对）：
  1. **后开小窗握手**：主窗切 hiyori 后打开 overlay.html → 小窗先 mount haru、`model-request` 得主窗应答 hiyori 并完成渲染（小窗资源含 hiyori moc3；与 haru 基线截图像素差 10.3%）
  2. **切角色跟随**：主窗走 `applyCharacterModel('natori')` → 广播 `model`、小窗收到并加载 natori（截图与 hiyori 差 10.4%）
  3. **零切换回退**：主窗就绪后新开小窗、全程无切换 → 握手应答 haru、小窗去重不重复加载，无崩溃
  - 全程两页 0 console error（仅预存在 favicon 404）
  - 已知边界（设计内）：小窗先于主窗挂载完成发出握手时，主窗 `currentUrl` 尚空不应答，小窗保持默认 haru，待下次 `model` 广播跟随

### 遗留事项
- 模型预览缩略图、按角色上传自定义模型、AI 生成分层立绘（独立课题）
- 编辑器下拉 option 未 escapeHtml（本地威胁模型下不可达）
- 模型清单拉取失败本次会话内不自愈（刷新即恢复）
- 多主窗 tab 模型趋同（既有镜像语义）

### 另注
桌面端迭代（2026-09-10）的手动验证清单中托盘/开机自启/单实例锁等项仍待用户在桌面模式真机验证（承接上条遗留）。

## 2026-09-11 — Live2D character 模型 v2 重制（等比组装修复拉伸/错位/直线裁切）

### 改动主题
针对 v1 四点反馈（衣服遮不住 body、衣裤直线裁切、整体拉长、裁切方式）重制 character 模型：Seedream img2img 重出"完整不裁切"12 格设定表，真网格矩形切割，全部件等比（sx=sy）组装 + 解剖锚点摆放。工具链在 `.scratch/psd2live/work/tools/`。

### 核心变更点
1. **重生成设定表**：Seedream img2img 输出 12 部件完整不裁切版本，部件间比例自洽
2. **真网格切割**（`slice-sheet2.cjs`）：实测网格线非均匀（x≈28/324/620/917/1214/1510，行高 1120/478/653），按行带内缩 3px 白色泛洪 + 形态学开运算断网格线 + 连通域过滤 → 12 部件干净矩形 PNG（含此前被误滤的眼白）
3. **等比组装**（`build-psd3.cjs`）：放弃模板匹配（Seedream 重绘部件致 RGB-SSD/NCC 失效），改剪影测量 + 解剖锚点链（头顶 y4/下巴 y172 推脸比例 0.656，眼距 50px 推眼部四层缩放）；每部件独立 sx=sy 消除拉伸
4. **嘴部生成**（`gen-mouth.cjs`）：Seedream bbox 局部编辑 + 透明背景直接出最大开嘴，内容 bbox 裁切缩放贴回脸部坐标；修复 sharp 管线 composite 晚于 resize 执行导致的预览错位
5. **导出部署**：13 层 PSD（新增 mouth 层，位于睫毛与前发之间）→ PSD2Live CLI → `public/live2d/models/character/`（gitignore 不入库）

### 验证
组装预览目检：衣服遮住 body、蝴蝶结右上、眼从刘海缝可见、嘴位置正确、无拉伸。Playwright + moc3 顶点级验证：模型加载渲染正常；`ParamMouthOpenY` 0→1 嘴部网格高度 0.006→0.053（9 倍） rig 绑定有效；眨眼 idle 动作含 ParamEyeLOpen/ROpen 轨道正常。注意：直接 setParameterValueById 会被 pixi-live2d-display 参数快照恢复覆写，须在模型 update 后同帧写入（avatar.js tick 已是正确时序）。

### 遗留事项
- 角色档案未配置 live2d_model，页面默认回退 haru，需在角色编辑器选"character"才会展示本模型
- moc3 中性姿态与 PSD 有非致命偏差警告（流水线 RigIntegrityValidator 非闸门级，视觉无影响）
- PSD2Live headless 截图验证受限（无 GPU 合成器空白），渲染验证走 readPixels 顶点级替代
   - 追补（同日）：v2 首次部署后模型渲染成雪花噪声。根因是 `build-psd3.cjs` 写 PSD 时把 **PNG 压缩字节**直接塞进 ag-psd 的 `imageData.data`（该字段要求原始 RGBA 像素），导致图集纹理就是乱码；v1 的 build-psd2 是先 `.raw().toBuffer()` 再写入所以没踩坑。已修复为写入前重采样转 raw RGBA，重导出后经离屏渲染 PNG 目检通过。另将 SW 缓存版本 soul-v9 → **soul-v10**，强制所有客户端丢弃缓存的旧模型/旧纹理（静态资源是 cache-first，不 bump 的话旧雪花纹理会一直留在用户浏览器里）。
