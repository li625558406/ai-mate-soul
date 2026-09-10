/**
 * ChatService - 聊天核心业务编排（阶段三）
 *
 * 管线：
 * 1. 加载角色和状态
 * 2. 情绪状态机检测（冷战/雷区）
 * 3. 冷战模式：直接返回预设短语
 * 4. 正常模式：
 *    a. 情感分析 → 好感度更新
 *    b. 时间感知 → 记忆检索 → 事实注入 → 环境感知
 *    c. 成长系统 → 镜像学习
 *    d. 动态 Prompt 构建（含内心独白指令）
 *    e. LLM 流式调用 → 解析 thought/reply → 只流式输出 reply
 *    f. 保存对话 + 异步后置任务
 */
import fs from 'fs';
import path from 'path';

export class ChatService {
  constructor({ characterManager, emotionEngine, promptBuilder, llmProvider, db, memoryService, factExtractor, timeService, growthService, emotionStateMachine, environmentService, lifecycleService, defaultProvider, imageService, planExtractor, multimodalService }) {
    this.characterManager = characterManager;
    this.emotionEngine = emotionEngine;
    this.promptBuilder = promptBuilder;
    this.llmProvider = llmProvider;
    this.db = db;
    this.memoryService = memoryService;
    this.factExtractor = factExtractor;
    this.timeService = timeService;
    this.growthService = growthService;
    this.emotionStateMachine = emotionStateMachine;
    this.environmentService = environmentService;
    this.lifecycleService = lifecycleService;
    this.defaultProvider = defaultProvider;
    this.imageService = imageService || null;
    this.planExtractor = planExtractor || null;
    this.multimodalService = multimodalService || null;
  }

  async *chatStream({ userId, characterId, message, provider }) {
    const usedProvider = provider || this.defaultProvider;

    // 1. 加载角色档案
    const character = this.characterManager.getCharacter(characterId);
    if (!character) {
      yield { type: 'error', data: `角色 ${characterId} 不存在` };
      return;
    }

    // 2. 确保用户和角色状态存在
    this.db.ensureUser(userId);
    let state = this.db.ensureCharacterState(userId, characterId);

    // 2.1 离线衰减：长时间不聊天，好感度/经验下降，心情向平静回归
    const oldMood = state.mood_level || 0;
    const decay = this.emotionEngine.calcOfflineDecay({
      affection: state.affection,
      mood: oldMood,
      experience: state.experience || 0,
      lastSeenAt: state.last_seen_at,
    });
    if (decay.affectionDecay > 0 || decay.moodDecay !== 0 || decay.xpDecay > 0) {
      this.db.applyOfflineDecay(userId, characterId, {
        affectionDelta: decay.affectionDecay,
        moodDelta: Math.abs(decay.moodDecay),
        xpDelta: decay.xpDecay,
      });
      state = this.db.getCharacterState(userId, characterId);
      const newMood = state.mood_level || 0;
      const parts = [];
      if (decay.affectionDecay > 0) parts.push(`好感度-${decay.affectionDecay}`);
      if (decay.moodDecay !== 0) parts.push(`心情 ${oldMood} → ${newMood}`);
      if (decay.xpDecay > 0) parts.push(`经验-${decay.xpDecay}`);
      console.log(`[ChatService] 离线${decay.hoursOffline.toFixed(1)}h 衰减: ${parts.join(' | ')}`);
    }

    // 生日纪念日检查（幂等，每次聊天时调用）
    this.lifecycleService.ensureBirthdayAnniversary(this.db, userId, characterId, character);
    const currentAge = this.lifecycleService.getCurrentAge(character, state.first_met_at);

    // 2.5 忙碌状态检查（睡觉/开会/上课等；忙碌短语支持角色档案 busy_responses 个性化覆盖）
    // 睡觉是独占型活动（不能一心二用）；其他活动（开会/上课/洗澡等）可以边忙边聊，走正常聊天管线
    let justWokenUp = null; // { activity } 被吵醒时记录活动（仅睡觉）
    let busyMultitask = null; // { activity, remainingMin } 非睡觉活动的"一心二用"聊天上下文
    const BUSY_WAKE_THRESHOLD = 5;
    const DEFAULT_BUSY_RESPONSES = {
      '睡觉': ['zzZ...', '别吵...我在睡觉...', '嗯...再让我睡一会儿...', '...（翻身）', '明天再说...'],
      '开会': ['在开会呢...', '等一下，现在不方便...', '会上呢，稍后回你', '...'],
      '上课': ['上课中，下课再聊...', '老师在讲课...', '现在不方便看手机...', '...'],
      '洗澡': ['在洗澡呢，等一下...', '...（水声）', '马上出来...', '...'],
    };
    const busyResponses = (character.busy_responses && typeof character.busy_responses === 'object')
      ? character.busy_responses : {};
    const busyPools = { ...DEFAULT_BUSY_RESPONSES, ...busyResponses };
    const defaultBusyResponses = busyResponses.default || ['现在有点忙...', '等一下...', '稍后回你...', '...'];

    if (state.busy_until) {
      const busyEnd = new Date(state.busy_until);
      const now = new Date();

      if (now < busyEnd) {
        // 活动名来自 LLM 判断，不可信：trim + 清洗（对抗性修复——"睡觉 "带空格/"午睡"可绕过独占，换行可注入 prompt）
        const activity = this._sanitizeActivity(state.busy_activity);
        const remainingMin = Math.ceil((busyEnd - now) / 60000);
        // 含 睡/觉/盹/憩/休息 的一律视为独占型活动（"补觉"无"睡"字，故不能只匹配"睡"）
        const isSleepActivity = /睡|觉|盹|憩|休息/.test(activity);

        if (!isSleepActivity) {
          // 非睡觉活动：一心二用，正常走完整聊天管线（后续在 prompt 注入忙碌上下文、按好感度放慢回复）
          busyMultitask = { activity, remainingMin };
          console.log(`[ChatService] 忙碌中一心二用聊天: ${activity}（还剩${remainingMin}分钟）`);
        } else {
          // 睡觉：不能一心二用，连发消息达到阈值会被吵醒
          this.db.incrementBusyCount(userId, characterId);
          state.busy_message_count = (state.busy_message_count || 0) + 1;

          if (state.busy_message_count < BUSY_WAKE_THRESHOLD) {
            // 未达到唤醒阈值，返回梦话预设短语
            const pool = busyPools[activity] || defaultBusyResponses;
            const response = pool[Math.floor(Math.random() * pool.length)];
            const activityIcons = { '睡觉': '💤', '开会': '💼', '上课': '📚', '洗澡': '🚿' };
            const icon = activityIcons[activity] || '⏳';

            yield {
              type: 'meta',
              data: {
                characterName: character.name,
                affection: state.affection,
                mood: 'busy',
                moodDescription: `${icon} ${activity}中（还剩${remainingMin}分钟）`,
                emotionLabel: 'busy',
                emotionState: state.emotion_state,
                xpGained: 0,
                busyRemaining: remainingMin,
                busyActivity: activity,
              },
            };

            yield { type: 'chunk', data: response };
            yield { type: 'done', data: null };

            this.db.saveChatMessage({ userId, characterId, role: 'user', content: message, affectionAfter: state.affection });
            this.db.saveChatMessage({ userId, characterId, role: 'assistant', content: response, affectionAfter: state.affection });
            return;
          } else {
            // 达到阈值，被迫醒来；心情惩罚按好感分档——感情越好越宽容（舍不得气你）
            const wakeAffection = state.affection || 0;
            const moodPenalty = wakeAffection >= 60 ? -6 : wakeAffection >= 30 ? -10 : -15;
            const oldMood = state.mood_level || 0;
            const newMood = Math.max(-100, oldMood + moodPenalty);
            this.db.clearBusyState(userId, characterId);
            this.db.updateEmotionState(userId, characterId, 'uneasy', newMood, state.cold_war_until);
            state.mood_level = newMood;
            state.emotion_state = 'uneasy';
            justWokenUp = { activity: activity || '睡觉' };
            console.log(`[ChatService] 角色睡觉被吵醒（好感${wakeAffection}）：心情 ${oldMood} ${moodPenalty} → ${newMood}`);
          }
        }
      } else {
        // 忙碌时间已过，自动清除
        this.db.clearBusyState(userId, characterId);
        state.busy_until = null;
      }
    }

    // 3. 情感分析 + 情绪状态机（心情唯一写入点：weight 传入状态机统一计算）
    const { weight, label } = this.emotionEngine.analyze(message);
    const emotionResult = this.emotionStateMachine.process({
      state,
      userMessage: message,
      characterMinefields: character.minefields || [],
      config: character.annoyance_config,
      emotionWeight: weight,
    });

    // 持久化状态机结果
    this.db.updateEmotionState(userId, characterId,
      emotionResult.emotionState,
      emotionResult.moodLevel,
      emotionResult.coldWarEndAt,
    );
    // 持久化情绪惯性（负面连击 + 敏感期）
    this.db.updateEmotionInertia(userId, characterId, {
      negStreak: emotionResult.negStreak,
      sensitiveUntil: emotionResult.sensitiveUntil,
    });

    // 4. 冷战模式：真诚道歉可提前和解；否则返回预设短语，不调用 LLM
    if (emotionResult.isColdWar) {
      // A3a: 真诚道歉判定（道歉词 + 消息有诚意长度/正面情绪 + 非敷衍句式）
      const PERFUNCTORY = /(行了吧|行了没|够了吗|随便你|烦不烦)/;
      const sincereApology = this.emotionStateMachine.isApologyMessage(message)
        && (message.length >= 8 || weight >= 0.3)
        && !PERFUNCTORY.test(message);

      if (sincereApology) {
        const cwReason = state.cold_war_reason || '一些矛盾';
        const reconciledMood = Math.min(0, emotionResult.moodLevel + 30);
        this.db.reconcileColdWar(userId, characterId, reconciledMood, 'uneasy');
        emotionResult.isColdWar = false;
        emotionResult.emotionState = 'uneasy';
        emotionResult.moodLevel = reconciledMood;
        emotionResult.justReconciled = true;
        emotionResult.reconcileReason = cwReason;
        // 和解后进入 24h 敏感期（心结未完全过去），随情绪惯性持久化
        emotionResult.sensitiveUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        emotionResult.negStreak = 0;
        this.db.updateEmotionInertia(userId, characterId, {
          negStreak: 0,
          sensitiveUntil: emotionResult.sensitiveUntil,
        });
        console.log(`[ChatService] 真诚道歉，提前和解，心情恢复至 ${reconciledMood}，进入 24h 敏感期`);
        // 落入正常管线，由 LLM 生成带"刚和好"语气的回复
      } else {
        // B6: 记录/刷新触雷原因 + 异步生成本次冷战专属短语（不阻塞回复）
        const cwReason = emotionResult.triggeredMinefield?.description
          || state.cold_war_reason || '一些矛盾';
        const existingPhrases = this.db.getColdWarPhrases(userId, characterId);
        this.db.updateColdWarMeta(userId, characterId, cwReason,
          existingPhrases.length ? JSON.stringify(existingPhrases) : null);
        this._ensureColdWarPhrases(userId, characterId, character, cwReason);

        // 优先消费动态短语，用尽回退角色预设池
        let presetResponse = null;
        const cwPhrases = this.db.getColdWarPhrases(userId, characterId);
        if (cwPhrases.length > 0) {
          presetResponse = cwPhrases[0];
          this.db.consumeColdWarPhrase(userId, characterId);
        }
        if (!presetResponse) {
          presetResponse = this.emotionStateMachine.getColdWarResponse(character.cold_war_responses);
        }
        const remainingMin = this.emotionStateMachine.getColdWarRemainingMinutes(emotionResult.coldWarEndAt);

        yield {
          type: 'meta',
          data: {
            characterName: character.name,
            affection: state.affection,
            mood: 'cold_war',
            moodDescription: '冷战/拒绝沟通',
            emotionLabel: 'cold_war',
            emotionState: 'cold_war',
            moodLevel: emotionResult.moodLevel,
            coldWarRemaining: remainingMin,
            triggeredMinefield: emotionResult.triggeredMinefield?.description || null,
            xpGained: 0,
          },
        };

        yield { type: 'chunk', data: presetResponse };
        yield { type: 'done', data: null };

        // 保存用户消息和预设回复
        this.db.saveChatMessage({ userId, characterId, role: 'user', content: message, affectionAfter: state.affection });
        this.db.saveChatMessage({ userId, characterId, role: 'assistant', content: presetResponse, affectionAfter: state.affection });
        this.db.incrementChatCount(userId, characterId);
        this.db.updateLastSeenAt(userId, characterId);
        return;
      }
    }

    // 4.5 敷衍消息拟真反应：对超短敷衍消息（哦/嗯/呵）低概率不再长篇大论，只回一个极简短句（跳过 LLM）
    if (this._shouldReplyPerfunctory({ message, weight, emotionResult, userId, characterId })) {
      const moodLevel = emotionResult.moodLevel;
      const pool = moodLevel < -50 ? ['...', '嗯', '？']
        : moodLevel < -20 ? ['嗯。', '哦', '...']
        : ['嗯嗯', '哦哦', '？', '哈'];
      const response = pool[Math.floor(Math.random() * pool.length)];

      // 好感度照常结算（敷衍消息本身是负贡献），但不给经验
      const baseGrowth = state.affection < 80 ? 0.05 : 0.02;
      const { newAffection, delta } = this.emotionEngine.updateAffection(state.affection, weight + baseGrowth);
      const finalAffection = Math.min(100, Math.round(newAffection * 10) / 10);
      const { mood: moodKey } = this.emotionEngine.mapMood(finalAffection);
      this.db.updateAffection(userId, characterId, finalAffection, moodKey);
      this.db.incrementChatCount(userId, characterId);
      this.db.saveChatMessage({ userId, characterId, role: 'user', content: message, emotionWeight: weight, affectionAfter: finalAffection });
      this.db.saveChatMessage({ userId, characterId, role: 'assistant', content: response, affectionAfter: finalAffection });
      this.db.updateLastSeenAt(userId, characterId);

      yield {
        type: 'meta',
        data: {
          characterName: character.name,
          affection: finalAffection,
          mood: emotionResult.emotionState,
          moodDescription: this.emotionStateMachine.getMoodDescription(moodLevel),
          moodLevel,
          emotionLabel: label,
          affectionDelta: delta,
          xpGained: 0,
          emotionState: emotionResult.emotionState,
          triggeredMinefield: null,
        },
      };

      // 敷衍回复来得快（懒得理才会敷衍）
      await this._sleep(600 + Math.floor(Math.random() * 1200));
      yield { type: 'chunk', data: response };
      yield { type: 'done', data: null };
      console.log(`[ChatService] 敷衍消息拟真反应: "${message}" → "${response}" (mood=${moodLevel})`);
      return;
    }

    // 5. 正常模式：完整处理管线（weight/label 已在步骤 3 计算）
    // 基础好感增长：缓慢积累，模拟真实关系发展
    // 睡觉被吵醒（justWokenUp）属负面交互：不享受基础正增长，消息正情绪不缓解打扰
    // （weight 取 min(weight,0)），打扰惩罚按好感分档——感情越好越宽容
    const wakePenalty = (state.affection || 0) >= 60 ? -0.1 : (state.affection || 0) >= 30 ? -0.2 : -0.3;
    const baseGrowth = justWokenUp ? 0 : (state.affection < 80 ? 0.05 : 0.02);
    const settledWeight = justWokenUp ? Math.min(weight, 0) + wakePenalty : weight;
    let { newAffection, delta } = this.emotionEngine.updateAffection(state.affection, settledWeight + baseGrowth);
    // 对抗性修复：updateAffection 的 ±0.2 随机抖动会把小额惩罚翻成正值（实测 -0.1 档 29% 概率），
    // 被吵醒的结算语义是"至多不减"，delta 必须钳制为非正
    if (justWokenUp && delta > 0) { delta = 0; newAffection = state.affection; }
    // 中性/正面消息（weight ≥ 0）不允许被随机抖动翻成扣分：好感下降只能来自真实负面情绪
    // （敷衍 -0.5 / 冒犯 / 吵醒等），普通闲聊最差持平
    if (!justWokenUp && weight >= 0 && delta < 0) { delta = 0; newAffection = state.affection; }
    const growthBonus = this.emotionEngine.checkGrowth(state.chat_count, character.growth_logic);
    const finalAffection = Math.min(100, Math.round((newAffection + growthBonus) * 10) / 10);
    const { mood: moodKey, description: moodDescription } = this.emotionEngine.mapMood(finalAffection);

    // 更新心情值 — 已迁入 EmotionStateMachine.process 统一计算（心情唯一写入点）
    this.db.updateAffection(userId, characterId, finalAffection, moodKey);
    this.db.incrementChatCount(userId, characterId);
    this.db.saveChatMessage({ userId, characterId, role: 'user', content: message, emotionWeight: weight, affectionAfter: finalAffection });

    // 6. 上下文收集
    const recentMessages = this.db.getRecentChatHistory(userId, characterId, 10);
    const userProfile = this.db.getUserProfile(userId);
    const recentSummary = this.db.getRecentSummary(userId, characterId, 5);

    const offlineResult = await this.timeService.generateOfflineNarrative({ characterId, lastSeenAt: state.last_seen_at, character });
    const currentActivity = await this.timeService.getCurrentActivity(character, userId);
    const scheduleSegment = this.timeService.dailyPlanner?.getCurrentSegment(userId, characterId) || null;
    const activeEmotionEvent = this.timeService.dailyPlanner?.getActiveEmotionEvent(userId, characterId) || null;
    const pendingPlans = this.db.getPendingPlans(userId, characterId, new Date().toISOString().slice(0, 10));
    const currentTimeDescription = this.timeService.getCurrentTimeDescription();

    // 持久化当前活动到数据库，供主动消息服务使用
    if (currentActivity) {
      this.db.updateCurrentActivity(userId, characterId, currentActivity);
    }

    let longTermMemory = [];
    try {
      longTermMemory = await this.memoryService.searchMemory({ userId, characterId, query: message, limit: 3 });
    } catch { /* ok */ }

    // 超短消息（嗯/哦等）分词后检索不到记忆 → 用最近几条用户消息扩展查询词重试一次
    if (longTermMemory.length === 0) {
      try {
        const recentUserMsgs = this.db.getUserMessageHistory(userId, characterId, 3);
        const expandedQuery = [...recentUserMsgs.slice().reverse(), message].join(' ').trim();
        if (expandedQuery.length > message.length) {
          longTermMemory = await this.memoryService.searchMemory({ userId, characterId, query: expandedQuery, limit: 2 });
        }
      } catch { /* ok */ }
    }

    // 上一条内心独白（3 天内有效，用于心声余波反哺）
    let lastMonologue = null;
    try {
      const monologues = this.db.getRecentMonologues(userId, characterId, 1);
      if (monologues[0]?.created_at) {
        const ageDays = (Date.now() - new Date(String(monologues[0].created_at).replace(' ', 'T')).getTime()) / 86400000;
        if (ageDays <= 3) lastMonologue = monologues[0];
      }
    } catch { /* ok */ }

    const userFacts = this.db.getUserFacts(userId, characterId);

    // 7. 环境感知
    let environment = null;
    try {
      environment = await this.environmentService.getEnvironment({ location: userProfile?.location || '' });
    } catch { /* ok */ }

    // 8. 成长系统 + 互动天数
    const growth = this.growthService.processGrowth({ state, emotionWeight: weight, userMessage: message });
    if (justWokenUp) growth.xpGained = 0; // 被打扰吵醒属负面交互，不给经验奖励（气头上）
    this.db.addExperience(userId, characterId, growth.xpGained);
    if (growth.leveledUp) this.db.updateLevel(userId, characterId, growth.newLevel);
    this.db.updateInteractionDays(userId, characterId);

    const mirrorWords = JSON.parse(state.mirror_words || '[]');
    let updatedMirrorWords = mirrorWords;
    if (state.chat_count % 5 === 0 && state.chat_count > 0) {
      const userMessages = this.db.getUserMessageHistory(userId, characterId, 30);
      updatedMirrorWords = this.growthService.learnMirrorWords(userMessages, mirrorWords);
      if (JSON.stringify(updatedMirrorWords) !== JSON.stringify(mirrorWords)) {
        this.db.updateMirrorWords(userId, characterId, updatedMirrorWords);
      }
    }

    const personalityStage = this.growthService.getPersonalityStage(finalAffection);
    this.db.updateLastSeenAt(userId, characterId);

    // 9. 构建动态 prompt
    state = { ...state, affection: finalAffection };
    const systemPrompt = this.promptBuilder.build({
      character,
      state,
      userName: userProfile?.name || '',
      moodDescription,
      recentSummary,
      longTermMemory,
      userFacts,
      offlineNarrative: offlineResult.hasOfflineEvent ? offlineResult.narrative : null,
      offlineTimeline: offlineResult.timeline || null,
      currentActivity,
      scheduleSegment,
      activeEmotionEvent,
      pendingPlans,
      personalityStage,
      mirrorWords: updatedMirrorWords,
      environmentPrompt: environment?.environmentPrompt || null,
      emotionState: emotionResult.emotionState,
      moodLevel: emotionResult.moodLevel,
      triggeredMinefield: emotionResult.triggeredMinefield,
      currentTimeDescription,
      lifeStagePrompt: this.lifecycleService.getLifeStagePrompt(state.interaction_days || 1),
      currentAge,
      wokenUpContext: justWokenUp ? `你刚才正在${justWokenUp.activity}，被对方连续发消息吵醒了。你现在很不开心，语气应该明显变冷、变短。表现出被吵醒的烦躁。` : null,
      busyMultitaskContext: busyMultitask ? `你现在正在${busyMultitask.activity}（还剩约${busyMultitask.remainingMin}分钟），同时抽空和对方聊天。一心二用：回复要简短，带一点分心或忙碌的痕迹，可以偶尔提到手头的事，但不要赶对方走。` : null,
      justReconciled: emotionResult.justReconciled ? (emotionResult.reconcileReason || '一些矛盾') : null,
      lastMonologue,
    });

    // 10. 发送 meta（心情指标统一以状态机 moodLevel 为准，避免与好感度映射矛盾）
    yield {
      type: 'meta',
      data: {
        characterName: character.name,
        affection: finalAffection,
        mood: emotionResult.emotionState,
        moodDescription: this.emotionStateMachine.getMoodDescription(emotionResult.moodLevel),
        moodLevel: emotionResult.moodLevel,
        emotionLabel: label,
        affectionDelta: delta,
        growthBonus,
        xpGained: growth.xpGained,
        level: growth.newLevel,
        leveledUp: growth.leveledUp,
        personalityStage: personalityStage?.label || null,
        offlineNarrative: offlineResult.hasOfflineEvent ? offlineResult.narrative : null,
        memoryCount: longTermMemory.length,
        factCount: userFacts.length,
        emotionState: emotionResult.emotionState,
        triggeredMinefield: emotionResult.triggeredMinefield?.description || null,
        weather: environment?.weather?.mood || null,
        busyRemaining: busyMultitask ? busyMultitask.remainingMin : undefined,
        busyActivity: busyMultitask ? busyMultitask.activity : undefined,
      },
    };

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
        rawFull += chunk;
      }
    } catch (err) {
      yield { type: 'error', data: `LLM 调用失败: ${err.message}` };
      return;
    }

    // 12. 解析 thought 和 reply
    let thought = '';
    let replyText = '';

    const replyMatch = rawFull.match(/<reply>([\s\S]*?)<\/reply>/);
    const thoughtMatch = rawFull.match(/<thought>([\s\S]*?)<\/thought>/);

    if (replyMatch) {
      replyText = replyMatch[1].trim();
      thought = thoughtMatch ? thoughtMatch[1].trim() : '';
    } else if (thoughtMatch) {
      // 有 thought 标签但没有 reply 标签：thought 后面的内容作为 reply
      thought = thoughtMatch[1].trim();
      replyText = rawFull.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
    } else {
      // 模型没有使用标签格式，整个输出作为 reply
      replyText = rawFull.replace(/<\/?thought>|<\/?reply>/g, '').trim();
      thought = '';
    }

    // 清洗 reply
    replyText = replyText
      .replace(/^[\s]*[""""'「『]+/, '')
      .replace(/[""""'」』]+[\s]*$/, '');

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

    // 13. 分条拟真推送（微信式连发：按情绪延迟 + 条间停顿）
    const segments = replyText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const msgSegments = segments.length > 0 ? segments : (replyText.trim() ? [replyText.trim()] : []);

    // 13.1 语音条判定：心情好 + 关系亲近 → 低概率把一条短句变成语音条
    let voiceInfo = null;
    if (msgSegments.length > 0 && this._shouldSendVoice({ emotionResult, state, segments: msgSegments })) {
      const voiceText = this._pickVoiceSegment(msgSegments);
      if (voiceText) voiceInfo = { text: voiceText };
    }
    const textSegments = voiceInfo ? msgSegments.filter(s => s !== voiceInfo.text) : msgSegments;

    if (textSegments.length > 0) {
      await this._sleep(this._calcReplyDelay(emotionResult.emotionState, justWokenUp, textSegments[0].length, busyMultitask, state.affection));
      for (let s = 0; s < textSegments.length; s++) {
        const seg = textSegments[s];
        for (let i = 0; i < seg.length; i += 2) {
          yield { type: 'chunk', data: seg.slice(i, i + 2) };
        }
        if (s < textSegments.length - 1) {
          yield { type: 'message_end' };
          yield { type: 'typing', data: { show: true } };
          await this._sleep(600 + Math.floor(Math.random() * 900));
        }
      }
    }

    // 13.2 语音条合成与推送（失败降级为文字补发，不影响主流程）
    let voiceFailed = false;
    if (voiceInfo) {
      if (textSegments.length === 0) {
        await this._sleep(this._calcReplyDelay(emotionResult.emotionState, justWokenUp, 5, busyMultitask, state.affection));
      } else {
        yield { type: 'message_end' };
        yield { type: 'typing', data: { show: true } };
        await this._sleep(500 + Math.floor(Math.random() * 800));
      }
      try {
        voiceInfo.filename = await this._synthesizeVoiceMessage({ characterId, text: voiceInfo.text, emotionState: emotionResult.emotionState });
        voiceInfo.duration = Math.max(1, Math.round(voiceInfo.text.length / 3.5));
        yield { type: 'voice_message', data: { filename: voiceInfo.filename, duration: voiceInfo.duration } };
        this.db.saveChatMessage({
          userId, characterId, role: 'voice',
          content: JSON.stringify({ f: voiceInfo.filename, d: voiceInfo.duration }),
        });
        console.log(`[ChatService] 语音条已推送: "${voiceInfo.text.slice(0, 20)}" (${voiceInfo.duration}s)`);
      } catch (err) {
        voiceFailed = true;
        console.warn(`[ChatService] 语音条合成失败，降级为文字: ${err.message}`);
        for (let i = 0; i < voiceInfo.text.length; i += 2) {
          yield { type: 'chunk', data: voiceInfo.text.slice(i, i + 2) };
        }
      }
    }

    // 14. 发送内心独白
    if (thought) {
      yield { type: 'thought', data: thought };
    }

    // 保存 AI 回复（语音条文本单独以 voice 记录入库，这里只存文字部分，避免历史重复展示；TTS 失败降级时存全文）
    const textOnlyReply = voiceFailed ? replyText : textSegments.join('\n');
    if (textOnlyReply) {
      this.db.saveChatMessage({ userId, characterId, role: 'assistant', content: textOnlyReply, affectionAfter: finalAffection });
    }

    // 保存内心独白
    if (thought) {
      this.db.saveMonologue({
        userId, characterId, userMessage: message, thought,
        emotionState: emotionResult.emotionState,
        moodAfter: emotionResult.moodLevel,
      });
    }

    // 15. 发照片/忙碌意图判定（显式标记优先；两者都无标记时走一次合并 LLM 判断，减少每轮延迟）
    let photoType = null;
    if (photoTag && this.imageService) {
      photoType = { '空镜': 'activity', '拼图': 'selfie_grid', '她拍': 'portrait' }[photoTag] || 'selfie';
      console.log(`[ChatService] 检测到发照片标记: "${photoTag}" → photoType=${photoType}`);
    } else if (photoTag && !this.imageService) {
      console.log(`[ChatService] 检测到发照片标记但 imageService 未初始化，跳过`);
    }

    let busyInfo = busyTag; // { activity } 或 null
    if (!photoTag && !busyTag) {
      const judgment = await this._judgePhotoAndBusy(usedProvider, userId, characterId, character, replyText, environment);
      if (judgment.photoType) {
        if (this.imageService) {
          photoType = judgment.photoType;
          console.log(`[ChatService] AI照片判断: photoType=${photoType}, 原因: ${judgment.reason || '无'}`);
        }
      }
      if (judgment.activity) {
        busyInfo = { activity: judgment.activity };
        console.log(`[ChatService] AI忙碌判断: ${judgment.activity}, 原因: ${judgment.reason || '无'}`);
      }
    }

    // 16. 异步后置任务
    this._postChatAsync({ userId, characterId, userMessage: message, aiResponse: replyText, emotionLabel: label });

    // 17. 如果需要发照片，生成图片并通过 SSE 推送
    if (photoType) {
      try {
        console.log(`[ChatService] 开始生成照片: type=${photoType}, characterId=${characterId}`);
        yield { type: 'photo_status', data: { status: 'generating' } };
        // 取最近几轮对话作为绘图上下文，确保场景准确
        const recentForPhoto = this.db.getRecentChatHistory(userId, characterId, 6);
        const photoContext = recentForPhoto.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join(' | ');
        const photoResult = await this.imageService.handlePhotoRequest(userId, characterId, photoType, replyText, environment, photoContext);
        console.log(`[ChatService] 照片生成成功: filename=${photoResult.filename}`);
        yield { type: 'photo', data: { filename: photoResult.filename, caption: photoResult.caption, type: photoType } };
        // 持久化照片到聊天记录，刷新后可恢复
        this.db.saveChatMessage({
          userId, characterId,
          role: 'photo',
          content: JSON.stringify({ f: photoResult.filename, c: photoResult.caption, t: photoType }),
        });
      } catch (err) {
        console.error(`[ChatService] 照片生成失败: ${err.message}`, err.stack);
        yield { type: 'photo_status', data: { status: 'failed', error: err.message } };
      }
    }

    // 18. 忙碌状态落地（显式标记或合并 AI 判断的结果）
    if (busyInfo) {
      const safeActivity = this._sanitizeActivity(busyInfo.activity);
      const busyMinutes = this._calcBusyDuration(safeActivity);
      this.db.setBusyState(userId, characterId, safeActivity, busyMinutes);
      console.log(`[ChatService] 角色进入忙碌状态: ${safeActivity}, ${busyMinutes}分钟`);
    }

    yield { type: 'done', data: null };
  }

  /**
   * 合并判断：角色是否要发照片 + 是否要进入忙碌状态（一次 LLM 调用替代原先两次串行调用）
   * @returns {{ photoType: string|null, activity: string|null, reason: string }}
   */
  async _judgePhotoAndBusy(provider, userId, characterId, character, replyText, environment) {
    const result = { photoType: null, activity: null, reason: '' };
    try {
      const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
      const weatherStr = environment?.weather?.mood || environment?.weather?.description || '未知';

      const response = await this.llmProvider.chat(provider, {
        systemPrompt: `你是「${character.name}」的行为判断助手。根据最近对话上下文，完成两个独立判断（都是否需要）。

【判断一：发照片】角色是否在对话中暗示要发照片给对方。
- 角色表示要拍照/发自拍/给对方看自己的样子 → photo_type = "selfie"（自拍）
- 角色表示要给对方看自己正在做的事/场景/周围环境 → photo_type = "activity"（空镜）
- 角色表示要发一组照片/今天的照片合集 → photo_type = "selfie_grid"（拼图）
- 注意区分：对方要求发照片 和 角色主动要发照片（两种都要触发）
- 注意区分：只是聊拍照话题（如讨论摄影技巧）≠ 真的要发照片
- 考虑时间天气：深夜可能发"睡前自拍"，晴天可能发"在户外空镜"

【判断二：进入忙碌】角色是否「现在就要去做某事，之后一段时间完全无法回复消息」。
必须同时满足才算 busy：
1. 角色明确表示现在就要去做某事（如"我先睡了"、"我去洗澡了"、"我得去上课了"）
2. 该活动会导致接下来一段时间完全无法回复消息
绝对不要 busy 的情况：只是有点困/累但还在聊、提议改天再聊、提到某事但不是现在做、还在等对方回复、是对方要忙而不是自己忙。

用严格 JSON 回复，不要任何其他文字：
{"send_photo": true/false, "photo_type": "selfie|activity|selfie_grid", "busy": true/false, "activity": "睡觉|开会|上课|洗澡|吃饭|出门|运动|其他", "reason": "简短原因"}`,
        messages: [{ role: 'user', content: this._buildJudgmentContext(userId, characterId, character, replyText, timeStr, weatherStr) }],
        temperature: 0.0,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.send_photo && ['selfie', 'activity', 'selfie_grid'].includes(parsed.photo_type)) {
          result.photoType = parsed.photo_type;
        }
        if (parsed.busy && parsed.activity) {
          result.activity = parsed.activity;
        }
        result.reason = parsed.reason || '';
      }
    } catch (err) {
      console.warn(`[ChatService] 合并意图判断失败，跳过: ${err.message}`);
    }
    return result;
  }

  /** 拼接意图判断用的上下文（最近 5 条对话 + 当前时间天气） */
  _buildJudgmentContext(userId, characterId, character, replyText, timeStr, weatherStr) {
    const recent5 = this.db.getRecentChatHistory(userId, characterId, 5);
    const contextLines = recent5.map(m => `${m.role === 'user' ? '对方' : character.name}: ${m.content.slice(0, 100)}`);
    contextLines.push(`${character.name}: ${replyText.slice(0, 200)}`);
    return `当前时间：${timeStr}\n当前天气：${weatherStr}\n\n最近对话：\n${contextLines.join('\n')}`;
  }

  /**
   * 清洗活动名（来自 LLM 判断/回复标记，不可信）：
   * 去换行（防 prompt 注入换行逃逸）、剔除括号类符号（防伪造指令段）、截断 12 字符（防爆破）
   */
  _sanitizeActivity(name) {
    return String(name || '')
      .split('\n')[0].split('\r')[0]
      .replace(/[\[\]{}<>`|【】《》]/g, '')
      .trim()
      .slice(0, 12);
  }

  /**
   * 根据活动类型 + 当前时间 + 星期几 动态计算忙碌时长（分钟）
   */
  _calcBusyDuration(activity) {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0=周日, 6=周六
    const isWeekend = day === 0 || day === 6;

    switch (activity) {
      case '睡觉': {
        // 晚间睡觉（21点以后）或凌晨
        if (hour >= 21 || hour < 5) {
          const wakeHour = isWeekend ? 10 : 7.5;
          let duration;
          if (hour >= 21) {
            duration = (24 - hour + wakeHour) * 60;
          } else {
            duration = (wakeHour - hour) * 60;
          }
          duration += Math.floor((Math.random() - 0.5) * 30);
          return Math.max(60, Math.round(duration));
        }
        // 白天午睡
        return 30 + Math.floor(Math.random() * 30); // 30-60分钟
      }

      case '开会': {
        // 根据当前时间估算剩余会议时间
        if (hour < 12) {
          return 30 + Math.floor(Math.random() * 60); // 上午会议 30-90分钟
        }
        return 20 + Math.floor(Math.random() * 40); // 下午会议偏短 20-60分钟
      }

      case '上课': {
        if (hour >= 8 && hour < 12) {
          return 45 + Math.floor(Math.random() * 45); // 上午课 45-90分钟
        }
        if (hour >= 14 && hour < 17) {
          return 45 + Math.floor(Math.random() * 45); // 下午课
        }
        return 30 + Math.floor(Math.random() * 30); // 其他时段
      }

      case '洗澡':
        return 15 + Math.floor(Math.random() * 15); // 15-30分钟

      default:
        return 30 + Math.floor(Math.random() * 30); // 默认30-60分钟
    }
  }

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

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 语音条触发判定：心情好 + 关系亲近 + 存在合适短句时，低概率发语音（模拟熟人之间的语音习惯）
   */
  _shouldSendVoice({ emotionResult, state, segments }) {
    if (!this.multimodalService) return false;
    if (emotionResult.moodLevel < 20) return false;      // 心情好才想发语音
    if ((state.affection || 0) < 40) return false;       // 不够熟不发语音
    if (!segments.some(s => s.length >= 2 && s.length <= 25)) return false;
    return Math.random() < 0.15;
  }

  /** 从分条中挑一条适合转语音的短句 */
  _pickVoiceSegment(segments) {
    const eligible = segments.filter(s => s.length >= 2 && s.length <= 25);
    if (eligible.length === 0) return null;
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  /** 合成语音条并落盘 public/voices/，返回文件名（音色/情绪语气由 MultimodalService 按角色档案处理） */
  async _synthesizeVoiceMessage({ characterId, text, emotionState }) {
    const audio = await this.multimodalService.synthesizeSpeech({ text, characterId, emotionState });
    const dir = path.join('public', 'voices');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
    fs.writeFileSync(path.join(dir, filename), audio);
    return filename;
  }

  /**
   * 敷衍消息拟真判定：超短应答字消息（哦/嗯/呵，情感分析已给出负权重）低概率只回敷衍短句，跳过 LLM
   * 心情越差概率越高；心情好时永不触发（心情好的人不计较这些）；不连续敷衍（会像程序坏掉）
   */
  _shouldReplyPerfunctory({ message, weight, emotionResult, userId, characterId }) {
    if (message.length > 6) return false;                 // 只针对超短消息
    if (weight > -0.3) return false;                      // 只针对负面/敷衍消息
    if (emotionResult.triggeredMinefield) return false;   // 雷区走完整愤怒管线
    if (emotionResult.isApology) return false;            // 道歉认真对待
    if (emotionResult.justReconciled) return false;       // 刚和好要认真回应
    if (emotionResult.moodLevel >= 20) return false;      // 心情好时不敷衍

    // 上一条 AI 回复已经是敷衍短句 → 本轮正常回复
    const recent = this.db.getRecentChatHistory(userId, characterId, 2);
    const lastAi = recent.find(m => m.role === 'assistant');
    if (lastAi && lastAi.content.length <= 3) return false;

    const probability = emotionResult.moodLevel < -20 ? 0.4 : 0.25;
    return Math.random() < probability;
  }

  /** 按情绪 + 长度计算首条回复延迟（"正在输入..."期间），范围上限 8s；忙碌一心二用时按好感分档放慢 */
  _calcReplyDelay(emotionState, justWokenUp, length, busyMultitask = null, affection = 50) {
    if (justWokenUp) return 4000 + Math.floor(Math.random() * 4000);
    // 忙碌一心二用：手头有事回复天然变慢，但好感越高越舍得抽身秒回
    if (busyMultitask) {
      const [min, max] = affection >= 60 ? [2000, 5000] : affection >= 30 ? [5000, 9000] : [8000, 14000];
      let delay = min + Math.floor(Math.random() * (max - min));
      if (length > 20) delay += Math.ceil((length - 20) / 10) * 100;
      return Math.min(15000, delay);
    }
    // 生气"已读不回"：30% 概率晾对方 10-16 秒才回，模拟憋着气不想理
    if (emotionState === 'angry' && Math.random() < 0.3) {
      return 10000 + Math.floor(Math.random() * 6000);
    }
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

  _postChatAsync({ userId, characterId, userMessage, aiResponse, emotionLabel }) {
    Promise.resolve().then(async () => {
      try {
        await this.memoryService.storeMemory({
          userId, characterId, userMessage, aiResponse,
          summary: `${userMessage.slice(0, 40)} → ${aiResponse.slice(0, 60)}`,
          emotionLabel,
        });
      } catch { /* ok */ }

      try {
        await this.factExtractor.extractAsync({ userId, characterId, userMessage, aiResponse });
      } catch { /* ok */ }

      try {
        if (this.planExtractor) await this.planExtractor.extractAsync({ userId, characterId, userMessage, aiResponse });
      } catch { /* ok */ }

      // 动态知识提取：每 10 次对话提取一次，减少 LLM 调用
      try {
        const state = this.db.getCharacterState(userId, characterId);
        if (state && state.chat_count > 0 && state.chat_count % 10 === 0) {
          await this._extractDynamicKnowledge({ userId, characterId, userMessage, aiResponse });
        }
      } catch { /* ok */ }
    });
  }

  /**
   * 通过 LLM 提取动态知识（口头禅、性格变化、用户生活事件、学到的知识、关系里程碑）
   */
  async _extractDynamicKnowledge({ userId, characterId, userMessage, aiResponse }) {
    const character = this.characterManager.getCharacter(characterId);
    if (!character) return;

    const systemPrompt = `你是一个角色成长分析助手。分析以下对话，提取角色应该记住的动态知识。

返回 JSON 对象，包含以下可选字段（没有则不包含该字段）：

1. learned_catchphrases: 字符串数组 — 对方或对话中学到的新口头禅/流行语
   例：["对方最近常说'绝绝子'","学会了说'摆烂'"]

2. personality_shifts: 对象数组 — 角色性格的微妙变化
   每项: { from: "原来", to: "现在", trigger: "原因", date: "今天日期" }
   例：[{"from":"傲娇","to":"偶尔主动关心","trigger":"对方生病时很温柔","date":"2026-04-18"}]

3. user_life_events: 对象数组 — 对方生活中发生的重要事件
   每项: { event: "事件描述", context: "上下文" }
   例：[{"event":"爸妈离婚了","context":"聊天时伤心地说出来的"}]

4. acquired_knowledge: 对象数组 — 角色从对话中学到的新知识
   每项: { knowledge: "学到了什么", source: "来源" }
   例：[{"knowledge":"《挪威的森林》是村上春树写的","source":"对方推荐的"}]

5. relationship_milestones: 对象数组 — 关系中的重要里程碑
   每项: { milestone: "里程碑描述" }
   例：[{"milestone":"第一次主动说了晚安"}]

只提取有意义的、值得长期记住的内容。如果对话中没有值得记录的动态知识，返回空对象 {}。
只返回 JSON，不要其他文字。`;

    const content = `角色「${character.name}」的对话记录（最近几轮）：
用户说：${userMessage}
角色回复：${aiResponse}`;

    try {
      const response = await this.llmProvider.chat(this.defaultProvider, {
        systemPrompt,
        messages: [{ role: 'user', content }],
        temperature: 0.1,
      });

      const jsonStr = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const extracted = JSON.parse(jsonStr);

      // 合并到角色的 dynamic_knowledge
      const dk = character.dynamic_knowledge || {
        learned_catchphrases: [],
        personality_shifts: [],
        user_life_events: [],
        acquired_knowledge: [],
        relationship_milestones: [],
      };

      let changed = false;
      const today = new Date().toISOString().slice(0, 10);

      if (extracted.learned_catchphrases?.length > 0) {
        dk.learned_catchphrases.push(...extracted.learned_catchphrases.map(c => ({ text: c, date: today })));
        // 保留最近 50 条
        dk.learned_catchphrases = dk.learned_catchphrases.slice(-50);
        changed = true;
      }
      if (extracted.personality_shifts?.length > 0) {
        dk.personality_shifts.push(...extracted.personality_shifts);
        dk.personality_shifts = dk.personality_shifts.slice(-30);
        changed = true;
      }
      if (extracted.user_life_events?.length > 0) {
        dk.user_life_events.push(...extracted.user_life_events);
        dk.user_life_events = dk.user_life_events.slice(-50);
        changed = true;
      }
      if (extracted.acquired_knowledge?.length > 0) {
        dk.acquired_knowledge.push(...extracted.acquired_knowledge);
        dk.acquired_knowledge = dk.acquired_knowledge.slice(-50);
        changed = true;
      }
      if (extracted.relationship_milestones?.length > 0) {
        dk.relationship_milestones.push(...extracted.relationship_milestones);
        dk.relationship_milestones = dk.relationship_milestones.slice(-30);
        changed = true;
      }

      if (changed) {
        this.characterManager.saveDynamicKnowledge(characterId, dk);
        const count = Object.values(extracted).filter(v => Array.isArray(v) && v.length > 0).length;
        console.log(`[DynamicKnowledge] 角色 ${character.name} 新增 ${count} 类知识`);
      }
    } catch { /* ok */ }
  }
}
