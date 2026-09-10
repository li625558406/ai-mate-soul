# 拟人化整改实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 5 个链路断点 + 落地 6 项拟人化增强，让角色记得自己说的话、有真人回复节奏、冷战有和解剧情、中文记忆检索生效。

**Architecture:** 管线内聚改造。节奏/分段逻辑放 ChatService，和解与主动消息扩展 ProactiveService，DB 加列。无新服务文件。设计文档：`docs/superpowers/specs/2026-09-10-humanization-design.md`。

**Tech Stack:** Node.js ESM + Express + Socket.IO + better-sqlite3 + Orama。无测试框架，验证方式：`node --check` 语法校验 + 启动服务 curl 冒烟 + `.scratch/` 下的临时验证脚本。

**注意：** 本项目纯 ESM，import 带 `.js` 扩展名。多个任务修改 `ChatService.js`，**必须按任务顺序执行**，每次编辑前重新读文件。

---

### Task 1: DatabaseManager 迁移与新方法

**Files:**
- Modify: `src/database/DatabaseManager.js`（迁移段约 221-237 行区域；方法加在 `addMood` 附近约 559 行后）

- [ ] **Step 1: 加迁移列**（在 busy 字段迁移 try/catch 之后追加同样风格的三段）

```js
    // Migration: 冷战和解机制字段
    try { this.db.prepare(`ALTER TABLE characters_state ADD COLUMN cold_war_reason TEXT DEFAULT NULL`).run(); } catch { /* exists */ }
    try { this.db.prepare(`ALTER TABLE characters_state ADD COLUMN cold_war_phrases TEXT DEFAULT NULL`).run(); } catch { /* exists */ }
```

- [ ] **Step 2: 加新方法**（放在 `addMood` 方法之后）

```js
  // ==================== 冷战和解 ====================

  /** 记录冷战原因与动态短语（phraseJson 为 null 表示清除短语，reason 为 null 表示清除原因） */
  updateColdWarMeta(userId, characterId, reason, phrasesJson) {
    this.db.prepare(
      `UPDATE characters_state SET cold_war_reason = ?, cold_war_phrases = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(reason, phrasesJson, userId, characterId);
  }

  /** 读取冷战短语池（JSON 数组），无则返回空数组 */
  getColdWarPhrases(userId, characterId) {
    const row = this.db.prepare(
      `SELECT cold_war_phrases FROM characters_state WHERE user_id = ? AND character_id = ?`
    ).get(userId, characterId);
    if (!row?.cold_war_phrases) return [];
    try { return JSON.parse(row.cold_war_phrases); } catch { return []; }
  }

  /** 消耗一条冷战短语（队首 shift），用尽自动清空字段 */
  consumeColdWarPhrase(userId, characterId) {
    const phrases = this.getColdWarPhrases(userId, characterId);
    phrases.shift();
    this.db.prepare(
      `UPDATE characters_state SET cold_war_phrases = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(phrases.length ? JSON.stringify(phrases) : null, userId, characterId);
  }

  /** 查找所有冷战已到期但未清理的状态（供主动和解检查器使用） */
  getExpiredColdWars(nowIso) {
    return this.db.prepare(
      `SELECT user_id, character_id, cold_war_reason, mood_level FROM characters_state
       WHERE cold_war_until IS NOT NULL AND cold_war_until <= ?`
    ).all(nowIso);
  }

  /** 和解：清冷战字段、心情部分恢复、情绪状态重算 */
  reconcileColdWar(userId, characterId, newMood, newState) {
    this.db.prepare(
      `UPDATE characters_state SET cold_war_until = NULL, cold_war_reason = NULL, cold_war_phrases = NULL,
       mood_level = ?, emotion_state = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(newMood, newState, userId, characterId);
  }

  /** 最近一篇日记（date 之前，含更早），无则 null */
  getLatestDiaryBefore(userId, characterId, date) {
    return this.db.prepare(
      `SELECT diary_date, content FROM diaries
       WHERE user_id = ? AND character_id = ? AND diary_date < ?
       ORDER BY diary_date DESC LIMIT 1`
    ).get(userId, characterId, date) || null;
  }
```

- [ ] **Step 3: 验证**

Run: `node --check src/database/DatabaseManager.js`
Expected: 无输出（语法通过）

- [ ] **Step 4: Commit**

```bash
git add src/database/DatabaseManager.js
git commit -m "feat(db): 冷战和解字段迁移与和解/短语/日记查询方法"
```

---

### Task 2: A5 心情单一写入点

**Files:**
- Modify: `src/services/EmotionStateMachine.js:46-133`
- Modify: `src/core/ChatService.js:144-213`（重排：analyze 前移，删除独立 updateMood）

- [ ] **Step 1: EmotionStateMachine.process 接收 emotionWeight 并统一计算心情**

`process` 签名改为（`EmotionStateMachine.js:46`）：

```js
  process({ state, userMessage, characterMinefields = [], config = {}, emotionWeight = 0 }) {
```

在"2. 检查时间衰减"块之后、"3. 检查道歉"块之前插入：

```js
    // 2.5 会话本身对心情的影响（原 EmotionEngine.updateMood 逻辑迁入，心情唯一写入点）
    const baseBoost = 0.3; // 普通聊天就是开心的
    const jitter = (Math.random() - 0.5) * 0.3;
    mood += baseBoost + emotionWeight * 1.5 + jitter;
    mood = Math.max(-100, Math.min(100, mood));
```

在 return 对象中增加 `isApology` 字段（供 ChatService 提前和解判定）：

```js
    return {
      emotionState,
      moodLevel: mood,
      triggeredMinefield,
      isColdWar: emotionState === 'cold_war',
      coldWarEndAt: coldWarUntil,
      isApology,
    };
```

新增公共方法（放在 `getColdWarResponse` 之前）：

```js
  /** 道歉词命中判定（提前和解与心情恢复共用） */
  isApologyMessage(text) {
    const patterns = ['对不起', '抱歉', '我错了', '是我的错', '不好意思', '原谅我', '对不住'];
    return patterns.some(p => text.includes(p));
  }
```

同时把 process 内第 3 步的局部 `apologyPatterns` 数组替换为 `this.isApologyMessage(userMessage)`：

```js
    // 3. 检查道歉（大幅恢复心情）
    const isApology = this.isApologyMessage(userMessage);
```

- [ ] **Step 2: ChatService 重排**

`ChatService.js` 中原"3. 情绪状态机处理"（约 144 行）改为——analyze 前移并传入 weight：

```js
    // 3. 情感分析 + 情绪状态机（心情唯一写入点：weight 传入状态机统一计算）
    const { weight, label } = this.emotionEngine.analyze(message);
    const emotionResult = this.emotionStateMachine.process({
      state,
      userMessage: message,
      characterMinefields: character.minefields || [],
      config: character.annoyance_config,
      emotionWeight: weight,
    });
```

删除原"5. 正常模式"开头的重复 analyze 行（约 192 行 `const { weight, label } = this.emotionEngine.analyze(message);`）。

删除心情双重更新块（约 200-211 行）：

```js
    // 【删除】以下整块
    const currentMood = emotionResult.moodLevel || 0;
    const { newMood, delta: moodDelta } = this.emotionEngine.updateMood(currentMood, weight);
    this.db.addMood(userId, characterId, moodDelta);
    emotionResult.moodLevel = newMood;
    const newState = this.emotionStateMachine._getStateForMood(newMood);
    if (newState !== emotionResult.emotionState) {
      emotionResult.emotionState = newState;
      this.db.updateEmotionState(userId, characterId, newState, newMood, emotionResult.coldWarEndAt);
    }
```

meta 中的 `moodDelta` 字段一并删除。

- [ ] **Step 3: 删除 EmotionEngine.updateMood（已迁入状态机，避免死代码）**

删除 `src/services/EmotionEngine.js:135-142` 的整个 `updateMood` 方法及其 JSDoc 注释。全库无其他调用方（仅 ChatService 曾调用）。

- [ ] **Step 4: 验证**

Run: `node --check src/services/EmotionStateMachine.js src/core/ChatService.js src/services/EmotionEngine.js`
冒烟：`npm run dev` 后发一条正面消息（如"你好厉害"），`/api/state` 返回 moodLevel 上升；发"无聊" moodLevel 下降。

- [ ] **Step 4: Commit**

```bash
git add src/services/EmotionStateMachine.js src/core/ChatService.js
git commit -m "refactor(emotion): 心情统一由状态机计算，消除双重更新"
```

---

### Task 3: A2 标记先清洗再流式输出

**Files:**
- Modify: `src/core/ChatService.js`（解析后、流式前，约 334-391 行区域）

- [ ] **Step 1: 在"12. 解析 thought 和 reply"清洗 reply 之后、流式输出之前插入标记剥离**

```js
    // 12.5 剥离控制标记（必须在流式输出之前，避免标记原文推给前端）
    let photoTag = null;
    const photoMatch = replyText.match(/\[发照片:(自拍|空镜|拼图|她拍)\]/);
    if (photoMatch) {
      photoTag = photoMatch[1];
      replyText = replyText.replace(/\[发照片:[^\]]+\]/g, '').trim();
    }
    let busyTag = null;
    const busyMatch = replyText.match(/\[去忙:([^:]+):(\d+)\]/);
    if (busyMatch) {
      busyTag = { activity: busyMatch[1], minutes: parseInt(busyMatch[2], 10) };
      replyText = replyText.replace(/\[去忙:[^\]]+\]/g, '').trim();
    }
```

- [ ] **Step 2: 改写原 15/18 步使用已剥离的标记**

原 `const photoMatch = replyText.match(...)` 判断块改为：

```js
    // 15. 检测是否需要发照片（标记已在流式前剥离）
    let photoType = null;
    if (photoTag && this.imageService) {
      photoType = { '空镜': 'activity', '拼图': 'selfie_grid', '她拍': 'portrait' }[photoTag] || 'selfie';
      console.log(`[ChatService] 检测到发照片标记: "${photoTag}" → photoType=${photoType}`);
    } else if (photoTag && !this.imageService) {
      console.log(`[ChatService] 检测到发照片标记但 imageService 未初始化，跳过`);
    } else if (this.imageService) {
      // AI 语义判断（原逻辑保留不变）
```

原 18 步 `const busyMatch = replyText.match(...)` 改为：

```js
    // 18. 忙碌标记（已在流式前剥离）
    if (busyTag) {
      const busyMinutes = this._calcBusyDuration(busyTag.activity);
      this.db.setBusyState(userId, characterId, busyTag.activity, busyMinutes);
      console.log(`[ChatService] 角色进入忙碌状态(标记): ${busyTag.activity}, ${busyMinutes}分钟`);
    } else {
      // AI 语义判断（原逻辑保留不变）
```

- [ ] **Step 3: 验证** — 冒烟：让角色回复带 `[发照片:自拍]` 的场景（发"给我看看你"），前端气泡不出现标记原文，照片正常生成。

- [ ] **Step 4: Commit**

```bash
git add src/core/ChatService.js
git commit -m "fix(chat): 发照片/去忙标记在流式输出前剥离，不再闪现原文"
```

---

### Task 4: B5 负情绪硬压回复长度

**Files:**
- Modify: `src/services/LLMProvider.js:50-72`
- Modify: `src/core/ChatService.js`（step 11 LLM 调用处）

- [ ] **Step 1: LLMProvider.chatStream 支持 maxTokens**

```js
  async *chatStream(providerName, { systemPrompt, messages, maxTokens }) {
    const { client, model } = this._getProvider(providerName);

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const stream = await client.chat.completions.create({
      model,
      messages: apiMessages,
      stream: true,
      temperature: 0.85,
      max_tokens: maxTokens || 1024,
    });
```

- [ ] **Step 2: ChatService 计算 maxTokens 并传入**

step 11 调用处改为：

```js
    // 11. 调用 LLM（负情绪时硬压回复长度：生气话少才真实）
    const replyMaxTokens = emotionResult.moodLevel < -50 ? 120
      : emotionResult.moodLevel < -20 ? 200
      : 1024;
    let rawFull = '';
    try {
      for await (const chunk of this.llmProvider.chatStream(usedProvider, {
        systemPrompt,
        messages: recentMessages,
        maxTokens: replyMaxTokens,
      })) {
```

- [ ] **Step 3: 验证** — `node --check src/services/LLMProvider.js src/core/ChatService.js`

- [ ] **Step 4: Commit**

```bash
git add src/services/LLMProvider.js src/core/ChatService.js
git commit -m "feat(chat): 负情绪动态压缩 max_tokens，生气回复更短"
```

---

### Task 5: A3a 冷战提前和解

**Files:**
- Modify: `src/core/ChatService.js`（step 4 冷战分支）
- Modify: `src/core/DynamicPromptBuilder.js`（build 参数 + 刚和好段落）

- [ ] **Step 1: ChatService 冷战分支加入真诚道歉检测**

在 `if (emotionResult.isColdWar) {`（约 160 行）开头插入：

```js
    if (emotionResult.isColdWar) {
      // A3a: 真诚道歉可提前和解（敷衍道歉不触发）
      const PERFUNCTORY = /(行了吧|行了没|够了吗|随便你|烦不烦)/;
      const sincereApology = emotionResult.isApology
        && (message.length >= 8 || weight >= 0.3)
        && !PERFUNCTORY.test(message);
      if (sincereApology) {
        const reconciledMood = Math.min(0, emotionResult.moodLevel + 30);
        this.db.reconcileColdWar(userId, characterId, reconciledMood, 'uneasy');
        this.db.updateColdWarMeta(userId, characterId, null, null);
        emotionResult.isColdWar = false;
        emotionResult.emotionState = 'uneasy';
        emotionResult.moodLevel = reconciledMood;
        emotionResult.justReconciled = true;
        console.log(`[ChatService] 真诚道歉，提前和解，心情恢复至 ${reconciledMood}`);
      }
```

冷战短路块的条件改为 `if (emotionResult.isColdWar) { ...原短路逻辑... }` 包裹在未和解时才执行——实现方式：上面 `sincereApology` 分支把 isColdWar 置 false，原短路代码需要移入 `else`：

```js
      if (!emotionResult.justReconciled) {
        // 原有冷战短路逻辑整体缩进到此 if 内（meta/chunk/done/保存/return）
      }
    }
```

- [ ] **Step 2: prompt 注入刚和好状态**

`ChatService` step 9 `promptBuilder.build({...})` 增加参数：

```js
      justReconciled: emotionResult.justReconciled
        ? (state.cold_war_reason || '一些矛盾') : null,
```

注意：`state` 在 2.1 步重新加载过，`cold_war_reason` 列随 SELECT * 带出。若 Task 2 重排后 state 未刷新，直接用 `this.db.getCharacterState(userId, characterId).cold_war_reason`。

`DynamicPromptBuilder.build` 参数加 `justReconciled`，在 `wokenUpContext` 段后追加：

```js
    if (justReconciled) {
      sections.push(`[特殊状态] 你们刚刚和好——之前因为「${justReconciled}」在冷战，对方真诚道歉了。你心里还有点委屈，但已经软化了。语气带点别扭的温柔：不要立刻热情如初，但也不再冰冷。`);
    }
```

- [ ] **Step 3: 对抗性验证**（curl）

1. 触雷进入冷战（发角色雷区词），随后发"对不起行了吧" → 应回预设冷淡短语（敷衍不和解）
2. 冷战中发"对不起，我昨天真的不该说那样的话，我后悔了" → 应触发 LLM 生成和解回复（非预设短语），状态 API 显示冷战解除
3. 冷战中发不含道歉词的消息 → 维持冷战

- [ ] **Step 4: Commit**

```bash
git add src/core/ChatService.js src/core/DynamicPromptBuilder.js
git commit -m "feat(cold-war): 真诚道歉提前和解，注入刚和好语气状态"
```

---

### Task 6: B6 冷战短语动态生成缓存

**Files:**
- Modify: `src/core/ChatService.js`（冷战短路分支 + 新私有方法）

- [ ] **Step 1: 进入冷战时记录原因并异步生成短语**

在 Task 5 改后的冷战分支中，短路逻辑（未和解路径）开头插入：

```js
      // B6: 记录触雷原因 + 异步生成本次冷战专属短语（不阻塞回复）
      const cwReason = emotionResult.triggeredMinefield?.description || '一些矛盾';
      this.db.updateColdWarMeta(userId, characterId, cwReason, this.db.getColdWarPhrases(userId, characterId).length ? undefined : null);
      this._ensureColdWarPhrases(userId, characterId, character, cwReason);
```

注意：`updateColdWarMeta` 会覆盖短语，改为只在为空时清/写——简化为：reason 每次覆盖，phrases 保留现有值：

```js
      const cwReason = emotionResult.triggeredMinefield?.description || '一些矛盾';
      const existingPhrases = this.db.getColdWarPhrases(userId, characterId);
      this.db.updateColdWarMeta(userId, characterId, cwReason, existingPhrases.length ? JSON.stringify(existingPhrases) : null);
      this._ensureColdWarPhrases(userId, characterId, character, cwReason);
```

- [ ] **Step 2: 短语消费——替换原 getColdWarResponse 调用**

```js
      // 优先消费动态生成的冷战短语，用尽回退角色预设池
      let presetResponse = null;
      const cwPhrases = this.db.getColdWarPhrases(userId, characterId);
      if (cwPhrases.length > 0) {
        presetResponse = cwPhrases[0];
        this.db.consumeColdWarPhrase(userId, characterId);
      }
      if (!presetResponse) {
        presetResponse = this.emotionStateMachine.getColdWarResponse(character.cold_war_responses);
      }
```

- [ ] **Step 3: 新私有方法（类尾部添加）**

```js
  /**
   * 异步生成冷战专属短语（不阻塞回复，失败静默回退预设池）
   */
  _ensureColdWarPhrases(userId, characterId, character, reason) {
    Promise.resolve().then(async () => {
      try {
        if (this.db.getColdWarPhrases(userId, characterId).length > 0) return;
        const resp = await this.llmProvider.chat(this.defaultProvider, {
          systemPrompt: `你是「${character.name}」，${character.base_personality}。你因为「${reason}」在和对方冷战。生成5条你冷战期间可能发的冷淡短语，每条一行，不要编号，不要引号。要符合你的性格，语气从敷衍到带刺不等。`,
          messages: [{ role: 'user', content: '生成冷战短语' }],
          temperature: 0.9,
          maxTokens: 200,
        });
        const phrases = resp.split('\n')
          .map(s => s.trim().replace(/^[-\d.、\s]+/, ''))
          .filter(s => s && s.length > 0 && s.length <= 50)
          .slice(0, 5);
        if (phrases.length > 0) {
          this.db.updateColdWarMeta(userId, characterId, reason, JSON.stringify(phrases));
          console.log(`[ChatService] 冷战短语已生成 ${phrases.length} 条`);
        }
      } catch (err) {
        console.warn(`[ChatService] 冷战短语生成失败（回退预设池）: ${err.message}`);
      }
    });
  }
```

注意 `LLMProvider.chat` 需支持 `maxTokens` 选项（同 Task 4 在 chat 方法中加 `max_tokens: maxTokens || 512`，若 chat 原本无 max_tokens 参数则加上）。

- [ ] **Step 4: 验证** — 触雷进入冷战：第一条回复用预设池；等数秒后第二条开始消费 LLM 生成的短语；短语用尽后回退预设池。

- [ ] **Step 5: Commit**

```bash
git add src/core/ChatService.js src/services/LLMProvider.js
git commit -m "feat(cold-war): LLM 动态生成冷战短语并逐条消费，回退预设池"
```

---

### Task 7: A3b 冷战到期主动和解

**Files:**
- Modify: `src/services/ProactiveService.js`（constructor + 新方法组）
- Modify: `src/index.js:83-85, 176-177, 943`（注入 + 启停）

- [ ] **Step 1: ProactiveService 构造函数注入 emotionStateMachine，增加定时器句柄**

constructor 参数加 `emotionStateMachine`，体内加：

```js
    this.emotionStateMachine = emotionStateMachine || null;
    this._reconcileTimer = null;
```

- [ ] **Step 2: 新增到期和解方法组（放在"定时主动消息"区之前）**

```js
  // ==================== 冷战到期主动和解 ====================

  /** 启动冷战到期检查器（每分钟） */
  startReconcileTimer() {
    this._checkExpiredColdWars();
    this._reconcileTimer = setInterval(() => this._checkExpiredColdWars(), 60 * 1000);
  }

  stopReconcileTimer() {
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
  }

  async _checkExpiredColdWars() {
    if (!this.emotionStateMachine) return;
    try {
      const expired = this.db.getExpiredColdWars(new Date().toISOString());
      for (const row of expired) {
        try {
          const character = this.characterManager.getCharacter(row.character_id);
          if (!character) continue;

          const message = await this._generateReconcileMessage({ character, reason: row.cold_war_reason });

          const newMood = Math.min(0, (row.mood_level || 0) + 20);
          const newState = this.emotionStateMachine._getStateForMood(newMood);
          this.db.reconcileColdWar(row.user_id, row.character_id, newMood, newState);

          // 无论在线与否都入库；在线则推送
          this.db.saveChatMessage({
            userId: row.user_id, characterId: row.character_id,
            role: 'assistant', content: message,
          });
          this.pushNotification(row.user_id, row.character_id, 'proactive', {
            characterId: row.character_id,
            characterName: character.nickname || character.name,
            message,
          });
          console.log(`[ProactiveService] 冷战到期和解推送 (${character.nickname || character.name}): ${message.slice(0, 40)}...`);
        } catch (err) {
          console.warn('[ProactiveService] 单个和解失败:', err.message);
        }
      }
    } catch (err) {
      console.warn('[ProactiveService] 和解检查失败:', err.message);
    }
  }

  async _generateReconcileMessage({ character, reason }) {
    const name = character.nickname || character.name;
    const systemPrompt = `你是「${name}」，${character.base_personality}。
你们刚才因为「${reason || '一些矛盾'}」冷战，现在冷战时间到了，你其实不想真的闹僵。
请生成一条主动和解的消息（1-2句话），要符合你的性格：可以带点别扭、嘴硬，但要传达出想和好的意思。
直接输出消息内容，不要加引号。`;
    try {
      const msg = await this.llmProvider.chat(this.provider, {
        systemPrompt,
        messages: [{ role: 'user', content: '生成和解消息' }],
        temperature: 0.9,
      });
      return msg || '...还生气吗？我不想跟你冷战。';
    } catch {
      return '...还生气吗？我不想跟你冷战。';
    }
  }
```

竞态说明：若用户恰在此刻发消息，ChatService 的 `process()` 会先清掉 `cold_war_until`，`getExpiredColdWars` 便查不到，天然幂等。

- [ ] **Step 3: index.js 接线**

constructor 注入（约 83 行）：

```js
const proactiveService = new ProactiveService({
  llmProvider, db, timeService, characterManager,
  provider: defaultProvider, emotionStateMachine,
});
```

启动（约 177 行 `proactiveService.startProactiveTimer();` 后）：

```js
proactiveService.startReconcileTimer();
```

关闭（约 943 行 `proactiveService.stopProactiveTimer();` 后）：

```js
proactiveService.stopReconcileTimer();
```

- [ ] **Step 4: 验证** — 触雷进冷战，把该行 `cold_war_until` 手动改为过去时间（sqlite3 或临时脚本），等 1 分钟观察控制台出现和解日志、聊天记录（`/api/chat-history`）含和解消息、`cold_war_until` 清空。

- [ ] **Step 5: Commit**

```bash
git add src/services/ProactiveService.js src/index.js
git commit -m "feat(cold-war): 到期主动和解——LLM 生成和解消息，推送并入库"
```

---

### Task 8: A1 主动消息持久化

**Files:**
- Modify: `src/services/ProactiveService.js:92-102, 222-234`

- [ ] **Step 1: 回归消息入库**（`_checkAndPushProactive` emit 之后）

```js
      if (message) {
        socket.emit('proactive', {
          characterId,
          characterName: character.nickname || character.name,
          message,
          hoursAway: Math.round(hoursAway),
        });
        this._lastProactiveSent.set(key, Date.now());
        // A1: 入库，保证后续对话上下文连贯
        this.db.saveChatMessage({ userId, characterId, role: 'assistant', content: message });
      }
```

- [ ] **Step 2: 定时主动消息入库**（`_checkTimeBasedProactive` emit 之后，`_lastProactiveSent.set(key, now);` 后）

```js
      // A1: 入库，保证后续对话上下文连贯
      this.db.saveChatMessage({ userId, characterId, role: 'assistant', content: message });
```

- [ ] **Step 3: 验证** — 触发一次主动消息后，`GET /api/chat-history/{uid}/{cid}` 中出现该消息。

- [ ] **Step 4: Commit**

```bash
git add src/services/ProactiveService.js
git commit -m "fix(proactive): 主动消息持久化到聊天记录，消除角色失忆"
```

---

### Task 9: B3 主动消息多样化

**Files:**
- Modify: `src/services/ProactiveService.js`（`_checkTimeBasedProactive` 与消息生成方法）
- Modify: `src/database/DatabaseManager.js`（`getLatestDiaryBefore` 已在 Task 1 添加，无需改动）

- [ ] **Step 1: `_checkTimeBasedProactive` 中替换消息生成调用**

原：

```js
    const message = await this._generateTimeBasedProactiveMessage({
      character, state, activity, timeDescription,
    });
```

改为：

```js
    // B3: 按优先级选消息源（约定提醒 > 情绪事件 > 日记分享 > 当前活动）
    const today = new Date().toISOString().slice(0, 10);
    const pendingPlans = this.db.getPendingPlans(userId, characterId, today);
    const latestDiary = this.db.getLatestDiaryBefore(userId, characterId, today);
    const emotionEvent = this.timeService.dailyPlanner?.getActiveEmotionEvent(userId, characterId) || null;

    const message = await this._generateDiverseProactiveMessage({
      character, state, activity, timeDescription, pendingPlans, latestDiary, emotionEvent,
    });
```

- [ ] **Step 2: 新生成方法（替换或并存 `_generateTimeBasedProactiveMessage`，保留原方法做 fallback 结构）**

```js
  /**
   * 基于多样化消息源生成主动消息
   */
  async _generateDiverseProactiveMessage({ character, state, activity, timeDescription, pendingPlans, latestDiary, emotionEvent }) {
    const name = character.nickname || character.name;

    // 消息源选择（优先级递减）
    let sourceLine;
    if (pendingPlans && pendingPlans.length > 0) {
      sourceLine = `你们之前有个约定：「${pendingPlans[0].description}」。你现在正在${activity}。可以自然地提起这个约定或提醒对方。`;
    } else if (emotionEvent) {
      sourceLine = `今天发生了这件事：${emotionEvent.description}。你现在正在${activity}。你想跟对方说说这件事给你的感受。`;
    } else if (latestDiary && latestDiary.content) {
      sourceLine = `你最近写了篇日记，里面有这段话：「${String(latestDiary.content).slice(0, 120)}」。你现在正在${activity}。可以自然地分享日记里的心情，但绝不要说"我写了日记"或引用原文。`;
    } else {
      sourceLine = `你现在正在${activity}。`;
    }

    const systemPrompt = `你是「${name}」，${character.base_personality}。
现在是${timeDescription}。${sourceLine}
你们的好感度是 ${Math.round(state.affection)}/100。

请生成一条简短的消息（1-2句话），像是你突然想到了对方，想跟 ta 说点什么。
语气要符合你的性格，要自然，不要太刻意。直接输出消息内容，不要加引号。`;

    try {
      return await this.llmProvider.chat(this.provider, {
        systemPrompt,
        messages: [{ role: 'user', content: '你想对 ta 说点什么？' }],
        temperature: 0.9,
      });
    } catch {
      return null;
    }
  }
```

原 `_generateTimeBasedProactiveMessage` 若无其他调用方则整体删除。

- [ ] **Step 3: 验证** — 造一条 pending plan（或依赖现有数据）后等定时推送，观察消息主题命中消息源；无数据源时回退活动话题。

- [ ] **Step 4: Commit**

```bash
git add src/services/ProactiveService.js
git commit -m "feat(proactive): 主动消息源多样化（约定/情绪事件/日记/活动）"
```

---

### Task 10: B1 服务端分条推送 + 拟真延迟

**Files:**
- Modify: `src/core/ChatService.js`（step 13 流式输出块）
- Modify: `src/core/DynamicPromptBuilder.js`（`_buildConstraint` 加分条指令）

- [ ] **Step 1: 替换流式输出块**

原（约 359-365 行）：

```js
    // 13. 模拟流式输出 reply（每 2-3 个字符一个 chunk）
    if (replyText) {
      const chunkSize = 2;
      for (let i = 0; i < replyText.length; i += chunkSize) {
        yield { type: 'chunk', data: replyText.slice(i, i + chunkSize) };
      }
    }
```

改为：

```js
    // 13. 分条拟真推送（微信式连发：按情绪延迟 + 条间停顿）
    const segments = replyText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const msgSegments = segments.length > 0 ? segments : (replyText.trim() ? [replyText.trim()] : []);
    if (msgSegments.length > 0) {
      await this._sleep(this._calcReplyDelay(emotionResult.emotionState, justWokenUp, msgSegments[0].length));
      for (let s = 0; s < msgSegments.length; s++) {
        const seg = msgSegments[s];
        for (let i = 0; i < seg.length; i += 2) {
          yield { type: 'chunk', data: seg.slice(i, i + 2) };
        }
        if (s < msgSegments.length - 1) {
          yield { type: 'message_end' };
          yield { type: 'typing', data: { show: true } };
          await this._sleep(600 + Math.floor(Math.random() * 900));
        }
      }
    }
```

注意：DB 保存与照片判断用的 `replyText` 保持换行分隔原文不变。

- [ ] **Step 2: 新增辅助方法（类内）**

```js
  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** 按情绪 + 长度计算首条回复延迟（"正在输入..."期间），范围上限 8s */
  _calcReplyDelay(emotionState, justWokenUp, length) {
    if (justWokenUp) return 4000 + Math.floor(Math.random() * 4000);
    const RANGES = {
      joyful: [800, 2000],
      happy: [1000, 2000],
      calm: [1000, 2500],
      uneasy: [2500, 4000],
      angry: [3500, 6000],
    };
    const [min, max] = RANGES[emotionState] || RANGES.calm;
    let delay = min + Math.random() * (max - min);
    if (length > 20) delay += Math.ceil((length - 20) / 10) * 100;
    return Math.min(8000, Math.round(delay));
  }
```

- [ ] **Step 3: prompt 分条指令**（`_buildConstraint` 返回串末尾追加规则）

```js
11. [分条消息] 如果回复有多句话，用换行把每句话分成独立的一行，像发微信一样一条一条发，每条尽量不超过30个字。心情好可以发2-4条，心情差只发1条。`;
```

（追加到现有返回模板的第 10 条之后，注意模板字符串结尾。）

- [ ] **Step 4: 验证** — `node --check src/core/ChatService.js`；curl 一轮对话观察 SSE 事件序列：`meta → (延迟) → chunk* → message_end → typing → chunk* → thought → done`。

- [ ] **Step 5: Commit**

```bash
git add src/core/ChatService.js src/core/DynamicPromptBuilder.js
git commit -m "feat(chat): 分条拟真推送——情绪加权延迟+微信式连发+SSE message_end/typing"
```

---

### Task 11: B1 前端配套（多气泡渲染）

**Files:**
- Modify: `public/index.html`（SSE 处理约 960-1048 行；历史加载约 803-845 行）

- [ ] **Step 1: SSE 处理支持多气泡**

`sendMessage` 中（约 965 行起）变量区改为：

```js
  const uid = document.getElementById('userId').value;
  const aiMsgEl = appendMsg('ai', ''); // 第一条气泡（thought/胶囊挂载点）
  let currentBubble = aiMsgEl;         // 当前流式气泡
  let segText = '';                    // 当前气泡文本
  let fullText = '';                   // 完整回复（跨气泡）
  let lastMeta = null;
```

`chunk` 分支改为：

```js
          } else if (currentEvent === 'chunk') {
            const piece = JSON.parse(data);
            segText += piece;
            fullText += piece;
            currentBubble.querySelector('.bubble').textContent = segText;
            lastAiReply = fullText;
            typing.classList.remove('show');
            scrollBottom();
          } else if (currentEvent === 'message_end') {
            segText = '';
            currentBubble = appendMsg('ai', '');
            scrollBottom();
          } else if (currentEvent === 'typing') {
            typing.textContent = '对方正在输入...';
            typing.classList.add('show');
          } else if (currentEvent === 'error') {
```

（原 `fullText += JSON.parse(data)` 行删除，error/thought/photo 分支保持不变；thought 仍挂 `aiMsgEl`。）

- [ ] **Step 2: 历史消息按换行拆分气泡**（`loadChatHistory` 的 else 分支约 820 行）

```js
      } else {
        // assistant 多条消息按换行拆成独立气泡
        const lines = String(msg.content || '').split('\n').map(s => s.trim()).filter(Boolean);
        div = null;
        for (let li = 0; li < lines.length; li++) {
          const el = appendMsg(msg.role, lines[li], null, li === 0 ? msgTime : null);
          if (li === 0) div = el;
        }
        if (!div) div = appendMsg(msg.role, msg.content, null, msgTime);
      }
```

`lastAiReply` 逻辑不变（读整段 content，TTS 可读全部）。

- [ ] **Step 3: 验证** — 浏览器实测：多段回复渲染为多个连续 AI 气泡、条间出现"对方正在输入..."；刷新页面后历史同样多气泡；单段回复无回归。

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(web): 多气泡渲染支持分条连发与条间正在输入"
```

---

### Task 12: A4 中文记忆 2-gram 检索

**Files:**
- Modify: `src/services/MemoryService.js:24-95, 102-128`

- [ ] **Step 1: schema 加 grams 字段**

```js
  async _createDb() {
    return await create({
      schema: {
        id: 'string',
        userMessage: 'string',
        aiResponse: 'string',
        summary: 'string',
        emotionLabel: 'string',
        timestamp: 'string',
        grams: 'string',
      },
      language: 'english',
    });
  }
```

- [ ] **Step 2: _getOrInit 旧库重建**

原 load try/catch 改为：

```js
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        db = await load(raw);
      } catch {
        // schema 不匹配（旧库无 grams 字段）或文件损坏：用旧文档重建索引
        let raw = null;
        try { raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* 损坏则放弃 */ }
        db = await this._rebuildDb(raw);
      }
    } else {
      db = await this._createDb();
    }
```

- [ ] **Step 3: 新增 _rebuildDb 与 grams 生成**

```js
  /**
   * 用旧 dump 的文档重建索引（补算 grams）
   */
  async _rebuildDb(rawDump) {
    const db = await this._createDb();
    const docs = rawDump?.documents?.store ? Object.values(rawDump.documents.store) : [];
    for (const doc of docs) {
      try {
        await insert(db, {
          id: doc.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          userMessage: doc.userMessage || '',
          aiResponse: doc.aiResponse || '',
          summary: doc.summary || '',
          emotionLabel: doc.emotionLabel || 'neutral',
          timestamp: doc.timestamp || new Date().toISOString(),
          grams: this._gramsFor(doc.userMessage || '', doc.summary || ''),
        });
      } catch { /* 单条坏数据跳过 */ }
    }
    if (docs.length > 0) console.log(`[MemoryService] 旧记忆索引重建完成: ${docs.length} 条`);
    return db;
  }

  _gramsFor(userMessage, summary) {
    return this._extractTerms(`${userMessage} ${summary}`).join(' ');
  }
```

- [ ] **Step 4: storeMemory 写 grams，searchMemory 搜 grams**

storeMemory 的 insert 改为：

```js
    await insert(db, {
      id,
      userMessage,
      aiResponse,
      summary: summary || '',
      emotionLabel: emotionLabel || 'neutral',
      timestamp: new Date().toISOString(),
      grams: this._gramsFor(userMessage, summary || ''),
    });
```

searchMemory 的 search 调用属性改为 `properties: ['grams']`：

```js
        const res = await search(db, {
          term,
          properties: ['grams'],
          limit: 5,
        });
```

- [ ] **Step 5: 对抗性验证**（`.scratch/verify-memory.mjs`）

```js
// .scratch/verify-memory.mjs — node .scratch/verify-memory.mjs
import { MemoryService } from '../src/services/MemoryService.js';
const svc = new MemoryService();
await svc.storeMemory({ userId: 't1', characterId: 'c1', userMessage: '我今天去吃了一家很好吃的川菜馆', aiResponse: '听起来不错', summary: '用户吃了川菜' });
const hits = await svc.searchMemory({ userId: 't1', characterId: 'c1', query: '川菜馆', limit: 3 });
console.log('hits:', hits.length, hits[0]?.userMessage);
if (hits.length === 0) { console.error('FAIL: 中文检索未命中'); process.exit(1); }
console.log('PASS');
```

Run: `node .scratch/verify-memory.mjs` → 期望 `PASS`。再跑一次含旧格式文件的场景：手工构造无 grams 字段的 dump 文件放置后调用 searchMemory，确认重建不丢数据。

- [ ] **Step 6: Commit**

```bash
git add src/services/MemoryService.js
git commit -m "fix(memory): 2-gram grams 字段修复中文长期记忆检索，旧库自动重建"
```

---

### Task 13: B2 TTS 情绪语速联动

> 设计偏差说明：设计文档写"伤心 0.9"，但情绪状态机无 sad 状态，实际映射为 uneasy → 0.95（不悦时略放缓）。

**Files:**
- Modify: `src/services/MultimodalService.js:56-93`

- [ ] **Step 1: synthesizeSpeech 加 speedRatio + 失败回退重试**

```js
  /** 情绪 → 语速映射（null 表示不传） */
  _speedRatioFor(emotionState) {
    if (emotionState === 'angry') return 1.15;
    if (emotionState === 'joyful' || emotionState === 'happy') return 1.05;
    if (emotionState === 'uneasy') return 0.95;
    return null;
  }

  async synthesizeSpeech({ text, characterId, emotionState = 'calm', speaker }) {
    const voice = (speaker && speaker.trim()) || this._resolveSpeaker(characterId);
    const context_texts = this._buildContexts(characterId, emotionState);
    const speedRatio = this._speedRatioFor(emotionState);

    const buildBody = (ratio) => JSON.stringify({
      req_params: {
        text,
        speaker: voice,
        audio_params: { format: 'mp3', sample_rate: 24000, ...(ratio ? { speed_ratio: ratio } : {}) },
        ...(context_texts.length ? { context_texts } : {}),
      },
    });

    const t0 = Date.now();
    let buffer;
    try {
      buffer = await this._requestAudio(buildBody(speedRatio));
    } catch (err) {
      if (!speedRatio) throw err;
      // speed_ratio 不被当前资源支持时回退重试
      console.warn(`[MultimodalService] speed_ratio 合成失败，回退默认语速重试: ${err.message}`);
      buffer = await this._requestAudio(buildBody(null));
    }
    console.log(`[MultimodalService] TTS 完成: voice=${voice}, emotion=${emotionState}, ${text.length}字, ${Date.now() - t0}ms, ${buffer.length}B`);
    return buffer;
  }

  async _requestAudio(body) {
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Api-Key': this._apiKey,
        'X-Api-Resource-Id': this._resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
      },
      body,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(this._explainError(response.status, errText));
    }
    return await this._collectAudio(response);
  }
```

- [ ] **Step 2: 验证** — `node --check src/services/MultimodalService.js`；设置页配置 TTS 后前端点朗读按钮，anger 状态（moodLevel 低）下语速感知略快、无报错。

- [ ] **Step 3: Commit**

```bash
git add src/services/MultimodalService.js
git commit -m "feat(tts): 情绪语速联动（angry 加速/uneasy 放缓），失败自动回退默认语速"
```

---

### Task 14: B4 记忆自然想起规则

**Files:**
- Modify: `src/core/DynamicPromptBuilder.js:299-308`

- [ ] **Step 1: 修改 _buildLongTermMemory**

```js
  _buildLongTermMemory(memories) {
    const memoryLines = memories.map((m, i) => {
      const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleDateString('zh-CN') : '';
      const summary = m.summary || `${m.userMessage} → ${m.aiResponse?.slice(0, 50)}`;
      return `${i + 1}. [${timeStr}] ${summary}`;
    });
    return `[相关往事记忆]
以下是你们过去相关的对话记忆：
${memoryLines.join('\n')}

使用规则：只有在当前话题自然相关时，才顺带提起其中一条（比如用"对了，你上次说…"的方式）。禁止复述原文，禁止一次提起多条，禁止生硬地展示你"记得"。`;
  }
```

- [ ] **Step 2: 验证 + Commit**

`node --check src/core/DynamicPromptBuilder.js`

```bash
git add src/core/DynamicPromptBuilder.js
git commit -m "feat(prompt): 长期记忆自然想起规则，禁止机械复述"
```

---

### Task 15: 收尾——文档与全量验证

**Files:**
- Modify: `CHANGE.md`（增量追加）
- Modify: `CLAUDE.md`（更新迭代状态一句话）
- Create: `.scratch/verify-*.mjs`（已存在，不入库）

- [ ] **Step 1: 全量语法校验**

```bash
node --check src/core/ChatService.js && node --check src/core/DynamicPromptBuilder.js && node --check src/services/ProactiveService.js && node --check src/services/EmotionStateMachine.js && node --check src/services/MemoryService.js && node --check src/services/MultimodalService.js && node --check src/services/LLMProvider.js && node --check src/database/DatabaseManager.js && node --check src/index.js && echo ALL-OK
```

Expected: `ALL-OK`

- [ ] **Step 2: 冒烟测试**（`npm run dev` 后 curl）

1. 正常对话：SSE 序列 meta→chunk→message_end→typing→chunk→thought→done，气泡分条
2. 触雷→冷战→预设短语→道歉提前和解 / 手动过期→1 分钟内主动和解入库
3. 记忆检索中文命中（Task 12 脚本）
4. 主动消息（等待或临时把 2h 阈值改小验证后改回——若改临时值，必须还原）
5. TTS 朗读

- [ ] **Step 3: 更新 CHANGE.md**（追加条目：日期 2026-09-10、主题"拟人化整改"、核心变更点列表、遗留事项）

- [ ] **Step 4: 更新项目 CLAUDE.md** 中 CHANGE.md 引用的迭代状态括号说明。

- [ ] **Step 5: 确认 git status 干净（.scratch/ 已被 gitignore）并最终提交**

```bash
git add CHANGE.md CLAUDE.md
git commit -m "docs: 拟人化整改迭代记录同步"
```
