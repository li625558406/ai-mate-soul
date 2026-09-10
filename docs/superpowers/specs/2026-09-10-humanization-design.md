# AI Mate Soul 拟人化整改设计

日期：2026-09-10
状态：已获用户批准

## 背景与目标

对项目功能链路完整审读后，发现 5 个链路断点和 6 个拟人化增强机会。本次整改目标：修复断点，让角色"记得自己说过的话、有真人的回复节奏、冷战有和解剧情、记忆检索对中文真正生效"。

实现路线（已选定）：管线内聚改造——节奏/分段逻辑放 ChatService，和解与主动消息扩展 ProactiveService，DB 加列。不新建服务。

## A. 链路断点修复

### A1 主动消息持久化

问题：`ProactiveService` 回归消息与定时活动消息只 `socket.emit` 不入库，用户回复时 `getRecentChatHistory` 无此消息，角色失忆。

方案：两条推送路径（`_checkAndPushProactive`、`_checkTimeBasedProactive`）生成消息后调用 `db.saveChatMessage({ userId, characterId, role: 'assistant', content: message })`。与 `role: 'photo'` 持久化先例一致。

### A2 标记先清洗再流式输出

问题：`[发照片:xxx]`、`[去忙:xxx:xxx]` 标记在 chunk 已流式推给用户之后才被 replace，原文会在前端闪现。

方案：标记解析与剥离整体前移到流式输出之前（reply 解析完成后立即执行），之后再逐 chunk 输出净化文本。

### A3 冷战和解剧情

**提前和解**：冷战分支中检测真诚道歉（道歉词命中 且 `EmotionEngine.analyze(message).weight >= 0.3`）。命中则：清空 `cold_war_until`、心情恢复 `min(0, mood + 30)`、向 prompt 注入"刚和好"状态指令（委屈但软化的语气），由 LLM 生成和解回复。

**到期主动和解**：ProactiveService 新增 1 分钟级检查器。DB 新增查询找出 `cold_war_until <= now` 的所有状态 → LLM 基于 `cold_war_reason`（触雷原因）生成和解消息 → 在线则 socket 推送，无论在线与否均入库 → 心情恢复 `min(0, mood + 20)`、清空冷战字段。

**触雷原因记录**：进入冷战时将雷区描述写入新列 `cold_war_reason`。

### A4 中文记忆 2-gram 检索

问题：Orama 建库 `language: 'english'` 但内容为中文，整句无标点输入切不出有效 term，长期记忆检索基本失效。

方案：新增 `_toBigrams(text)`：CJK 连续段生成重叠二元组、空格连接，拉丁/数字词保留原样。入库时文档加 `grams` 字段（space 连接的 bigram 串），检索时对 query 做同样变换后搜 `grams`。

**旧库兼容**：schema 加字段后旧索引 `load()` 会抛错 → 捕获后新建库，用 dump 中已有文档重新插入（grams 现算），不丢数据。

### A5 心情单一写入点

问题：`EmotionStateMachine.process()` 算一遍 mood（雷区/道歉/衰减），ChatService 又调 `emotionEngine.updateMood` 再算一遍，两套规则叠加不可预测。

方案：`process()` 增加 `emotionWeight` 参数，内部统一计算 `mood = clamp(mood + weight映射delta + 雷区惩罚 + 道歉恢复 + 时间衰减)`。`weight→delta` 映射逻辑从 EmotionEngine 迁入状态机。ChatService 删除独立 `updateMood/addMood` 调用，只持久化状态机结果一次。

## B. 拟人化增强

### B1 回复节奏拟真 + 分条连发

- Prompt 增加指令：多句话用换行拆成独立短消息（每条 ≤30 字左右），像发微信。
- ChatService 按 `\n` 分段，过滤空段，逐条推送：
  - 首条前按情绪计算延迟（"正在输入..."期间）：joyful 0.8-2s / happy 1-2s / calm 1-2.5s / uneasy 2.5-4s / angry 3.5-6s / 被吵醒 4-8s，另加长度因子（超 20 字部分每 10 字 +100ms）。
  - 每条结束后发 `message_end` 事件（前端收束当前气泡），再发 `typing` 事件唤起指示器，间隔 0.6-1.5s 随机。
- 前端配套：处理 `message_end` / `typing` SSE 事件；历史消息加载时按换行拆分成多个气泡。
- DB 存储保持换行分隔完整文本。

### B2 TTS 情绪联动

MultimodalService `synthesizeSpeech` 已支持 `emotionState`。增强：`moodLevel → 情感 context + speed_ratio` 映射（生气 1.15 / 伤心 0.9 / 开心 1.05），`/api/tts` 路由读取角色当前心情传入。

### B3 主动消息多样化

`_checkTimeBasedProactive` 按优先级选消息源：

1. `pendingPlans` 当日约定未完成 → 提醒类消息
2. 昨日 DiaryService 日记 → "想起日记内容"式分享
3. DailyPlanner `emotion_event` → 想倾诉
4. fallback 当前活动（现状）

全部经 A1 入库。

### B4 记忆自然想起

`DynamicPromptBuilder._buildLongTermMemory` 注入使用规则：仅话题自然相关时顺带提起（"对了，你上次说…"）、禁止复述原文、禁止批量提及。

### B5 负情绪硬压回复长度

`LLMProvider.chatStream` 支持 `maxTokens` 选项。ChatService 按 `moodLevel` 计算：`< -50 → 120`，`< -20 → 200`，其余 1024。被吵醒的愤怒状态同样压缩。

### B6 冷战短语动态生成

触发冷战瞬间异步（不阻塞回复）用 LLM 基于角色 + 雷区原因生成 5 条短语，存新列 `cold_war_phrases`（JSON 数组）。消费时逐条 shift，用尽回退角色预设池并触发重新生成。首轮若未生成完，预设池兜底。

## DB 变更

`characters_state` 新增 2 列：`cold_war_reason TEXT`、`cold_war_phrases TEXT`。MemoryService 索引 schema 加 `grams` 字段（含旧库重建逻辑）。

## 涉及文件

- `src/core/ChatService.js` — A2/A5/B1/B5/B6 触发
- `src/services/ProactiveService.js` — A1/A3 到期检查/B3
- `src/services/EmotionStateMachine.js` — A3 提前和解/A5 统一 mood
- `src/services/EmotionEngine.js` — A5 weight→delta 迁出
- `src/services/MemoryService.js` — A4
- `src/services/MultimodalService.js` — B2
- `src/core/DynamicPromptBuilder.js` — B1 分条指令/B4 记忆规则/刚和好状态
- `src/services/LLMProvider.js` — B5 maxTokens
- `src/database/DatabaseManager.js` — 新列 + 冷战过期查询
- `src/index.js` — 注入调整、/api/tts 路由、和解定时器启动
- `public/index.html` — message_end/typing 事件、历史气泡拆分

## 错误处理原则

- 和解消息/冷战短语生成失败：回退预设池/模板，不阻塞主流程
- 旧记忆索引重建失败：降级为空库重新开始，打 warn 日志
- 分段后空数组：整段原文作为单条消息输出
- 定时器异常：单次失败 log 后继续，不中断循环

## 验证方式（对抗性）

无测试框架，启动服务后 curl SSE 接口手动验证：

- 分段容错：空回复、无换行长回复、连续换行、纯标记消息
- 冷战路径：到期时用户离线（入库不推送）、提前和解敷衍道歉拒绝（"对不起行了吧" weight 低不触发）、重复触发幂等
- 记忆重建：旧格式索引文件加载、损坏 JSON、空库首写
- 心情收敛：各情绪档位 mood 演算（雷区+道歉同轮互斥、衰减与新增叠加）
- 标记清洗：标记缺失参数、多余换行、标记在 thought 中
- LLM 输出兜底：JSON 畸形、超长、编造字段的 fallback 路径
