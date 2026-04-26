/**
 * DailyPlanner - AI 角色日程规划系统
 *
 * 每天凌晨一次性用 LLM 规划角色全天日程，包含：
 * 1. 按时间段的活动安排（符合角色身份和生活习惯）
 * 2. 1-2 个动态/突发事件（引导聊天互动）
 * 3. 跨天连续性（参考昨天日程和日记）
 * 4. 天气、周末/工作日等环境因素
 *
 * 日程持久化到 daily_schedules 表，TimeService 直接读取。
 */
export class DailyPlanner {
  constructor({ db, llmProvider, characterManager, timeService, environmentService, provider }) {
    this.db = db;
    this.llmProvider = llmProvider;
    this.characterManager = characterManager;
    this.timeService = timeService;
    this.environmentService = environmentService;
    this.provider = provider;
  }

  /**
   * 为指定用户-角色对生成今日日程（幂等）
   */
  async generateDailySchedule({ userId, characterId }) {
    const today = new Date().toISOString().slice(0, 10);

    // 幂等：已存在则跳过
    const existing = this.db.getDailySchedule(userId, characterId, today);
    if (existing) return { success: true, date: today, cached: true };

    const character = this.characterManager.getCharacter(characterId);
    if (!character) return { success: false, reason: '角色不存在' };

    // 收集上下文
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yesterdaySchedule = this.db.getDailySchedule(userId, characterId, yesterday);
    const yesterdayDiary = this.db.getDiary(userId, characterId, yesterday);

    let weather = '';
    try {
      const env = await this.environmentService.getEnvironment({});
      weather = env.weather?.description || '';
    } catch { /* ok */ }

    const recentSummary = this.db.getRecentSummary(userId, characterId, 5);
    const userFacts = this.db.getUserFacts(userId, characterId);
    const pendingPlans = this.db.getPendingPlans(userId, characterId, today);

    // 生成
    try {
      const result = await this._callLLM({ character, today, yesterdaySchedule, yesterdayDiary, weather, recentSummary, userFacts, pendingPlans });
      if (!result || !result.segments || result.segments.length === 0) {
        return { success: false, reason: 'LLM 返回空日程' };
      }

      this.db.saveDailySchedule({
        userId, characterId, date: today,
        segments: result.segments,
        summary: result.summary || '',
        weather,
      });

      console.log(`[DailyPlanner] 生成日程: ${userId}/${characterId} ${today}, ${result.segments.length}个时段, ${result.segments.filter(s => s.is_event).length}个事件`);
      return { success: true, date: today, segmentCount: result.segments.length };
    } catch (err) {
      console.warn(`[DailyPlanner] 生成失败 (${userId}/${characterId}):`, err.message);
      return { success: false, reason: err.message };
    }
  }

  /**
   * 获取当前时段的活动（同步，无 LLM 调用）
   */
  getCurrentSegment(userId, characterId) {
    const today = new Date().toISOString().slice(0, 10);
    const schedule = this.db.getDailySchedule(userId, characterId, today);
    if (!schedule) return null;

    const segments = JSON.parse(schedule.segments);
    const hour = new Date().getHours();

    for (const seg of segments) {
      if (hour >= seg.start_hour && hour < seg.end_hour) {
        return seg;
      }
    }
    // 深夜兜底：返回最后一段
    return segments[segments.length - 1] || null;
  }

  /**
   * 获取今日完整日程
   */
  getTodaySchedule(userId, characterId) {
    const today = new Date().toISOString().slice(0, 10);
    const schedule = this.db.getDailySchedule(userId, characterId, today);
    if (!schedule) return null;
    return { ...schedule, segments: JSON.parse(schedule.segments) };
  }

  /**
   * 为所有活跃对批量生成日程
   */
  async generateForAllActivePairs() {
    const pairs = this.db.db.prepare(
      `SELECT user_id, character_id FROM characters_state WHERE chat_count > 0`
    ).all();

    let generated = 0;
    for (const { user_id, character_id } of pairs) {
      const result = await this.generateDailySchedule({ userId: user_id, characterId: character_id });
      if (result.success && !result.cached) generated++;
    }
    console.log(`[DailyPlanner] 日程生成完成: ${generated}/${pairs.length} 个活跃对`);
  }

  /**
   * 处理所有活跃对的情绪事件（由 cron 每 30 分钟调用）
   * 检查当前时段的日程事件，如果有 emotion_impact 且未应用，则应用烦躁值变化
   */
  processEventEmotions() {
    const pairs = this.db.db.prepare(
      `SELECT user_id, character_id FROM characters_state WHERE chat_count > 0`
    ).all();

    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    let applied = 0;

    for (const { user_id, character_id } of pairs) {
      const schedule = this.db.getDailySchedule(user_id, character_id, today);
      if (!schedule) continue;

      const segments = JSON.parse(schedule.segments);
      const appliedIndices = this.db.getAppliedEventSegments(user_id, character_id, today);

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.emotion_impact || appliedIndices.includes(i)) continue;

        // 只处理当前时段或已经过去但未处理的时段
        if (hour < seg.start_hour) continue;

        const { mood: moodDelta } = seg.emotion_impact;
        if (moodDelta && moodDelta !== 0) {
          this.db.addMood(user_id, character_id, moodDelta);
          this.db.markEventEmotionApplied(user_id, character_id, today, i, 'mood', moodDelta);

          const sign = moodDelta > 0 ? '+' : '';
          const charName = this.characterManager.getCharacter(character_id)?.nickname || character_id;
          console.log(`[DailyPlanner] 情绪事件: ${charName} 心情 ${sign}${moodDelta}（${seg.event_description || seg.activity}）`);
          applied++;
        }
      }
    }

    if (applied > 0) {
      console.log(`[DailyPlanner] 情绪事件处理完成: ${applied} 个事件已应用`);
    }
  }

  /**
   * 获取当前活跃的情绪事件信息（用于注入 prompt）
   * @returns {{ description: string, mood: number, activity: string } | null}
   */
  getActiveEmotionEvent(userId, characterId) {
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    const schedule = this.db.getDailySchedule(userId, characterId, today);
    if (!schedule) return null;

    const segments = JSON.parse(schedule.segments);
    const appliedIndices = this.db.getAppliedEventSegments(userId, characterId, today);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg.emotion_impact || appliedIndices.includes(i)) continue;

      // 当前时段匹配
      if (hour >= seg.start_hour && hour < seg.end_hour) {
        return {
          description: seg.event_description || seg.activity,
          mood: seg.emotion_impact.mood,
          activity: seg.activity,
        };
      }
    }

    return null;
  }

  // ==================== LLM 调用 ====================

  async _callLLM({ character, today, yesterdaySchedule, yesterdayDiary, weather, recentSummary, userFacts, pendingPlans }) {
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const dateStr = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

    const li = character.living_info || {};

    // 昨日回顾
    let yesterdayContext = '';
    if (yesterdaySchedule) {
      const segs = JSON.parse(yesterdaySchedule.segments);
      const events = segs.filter(s => s.is_event).map(s => s.event_description);
      yesterdayContext += `\n昨天日程摘要：${yesterdaySchedule.summary || '普通的一天'}`;
      if (events.length > 0) yesterdayContext += `\n昨天发生的事：${events.join('；')}`;
    }
    if (yesterdayDiary) {
      yesterdayContext += `\n昨天日记片段：${(yesterdayDiary.content || '').slice(0, 120)}`;
    }

    const systemPrompt = `你是一个角色日程规划器。为角色设计一个真实、丰富、有故事性的一天日程。

输出严格的 JSON 格式：
{
  "segments": [
    {"start_hour": 7, "end_hour": 8, "activity": "活动描述（15-30字）", "is_event": false, "event_description": null, "emotion_impact": null},
    {"start_hour": 15, "end_hour": 16, "activity": "在做某事", "is_event": true, "event_description": "详细描述这个意外事件", "emotion_impact": {"mood": -5}}
  ],
  "summary": "一句话总结今天特别的地方"
}

规则：
1. 从起床到睡觉安排完整时段，每段 1-3 小时
2. 活动要符合角色身份、性格、爱好和生活习惯
3. 不要连续超过 3 小时做同一件事
4. 深夜（0-7点）安排睡觉
5. 活动之间要有自然过渡
6. 每天安排 1-2 个 is_event=true 的意外事件
7. 事件要有趣、值得和聊天对象分享
8. 事件类型参考：偶遇（流浪猫、老朋友）、收到东西（快递、礼物）、天气变化（突然下雨）、学业相关（成绩、通知）、意外发现（新店、新歌）、情绪变化（突然想吃某个东西、做了个奇怪的梦）
9. 如果有昨天的日程/日记参考，保持连续性（昨天提到的事今天可以有后续）
10. 考虑天气：下雨不安排户外，晴天可以出门
11. 周末和工作日安排应有明显区别
12. 如果有"今日待执行的计划"，必须将其安排进对应时段，不能遗漏
13. 参考用户画像来选择活动（用户喜欢的东西可以自然地出现在日程中）
14. [情绪影响] 部分事件可以带有 emotion_impact 字段，表示这个事件对角色心情的影响：
    - 正面事件（收到礼物、遇到开心的事、吃到好吃的）：emotion_impact: {"mood": 3} 到 {"mood": 5}
    - 负面事件（跟同学吵架、被老师批评、东西丢了、被家长骂、身体不舒服）：emotion_impact: {"mood": -3} 到 {"mood": -8}
    - 普通事件（偶遇流浪猫、发现新店、天气变化等）：emotion_impact 设为 null
    - 每天至少安排 1 个负面情绪事件（mood < 0），安排 1 个正面情绪事件（mood > 0）
    - mood 值范围 -8 到 +5，负面事件的绝对值比正面事件大（坏心情比好心情更持久）
    - 根据事件严重程度调整：吵架=-5~-8，被批评=-4~-6，东西丢了=-3~-5，身体不舒服=-4~-6，收到礼物=+3~+5，吃到好吃的=+2~+4`;

    const userMessage = `## 角色档案
姓名：${character.full_name || character.name}（${character.nickname || character.name}）
身份：${character.education || ''}
性格：${character.base_personality || ''}
爱好：${(character.hobbies || []).join('、')}

## 生活信息
${li.address ? '住址：' + li.address : ''}
${li.school ? '学校：' + li.school : ''}
${li.frequent_places ? '常去：' + li.frequent_places.slice(0, 5).join('；') : ''}
${isWeekend && li.weekend_routine ? '周末日常：' + li.weekend_routine : ''}
${li.diet ? '饮食：' + li.diet : ''}
${li.financial ? '经济：' + li.financial : ''}

## 今日信息
日期：${dateStr}，${isWeekend ? '周末' : '工作日'}
天气：${weather || '未知'}
${yesterdayContext}
${recentSummary ? '\n近期对话摘要：' + recentSummary : ''}
${userFacts && userFacts.length > 0 ? '\n用户画像：' + userFacts.slice(0, 8).map(f => f.fact_value).join('、') : ''}
${pendingPlans && pendingPlans.length > 0 ? '\n今日待执行的计划/约定（必须安排进日程）：\n' + pendingPlans.map(p => `- ${p.description}`).join('\n') : ''}

请为 ${character.nickname || character.name} 安排今天（${today}）的日程。`;

    const response = await this.llmProvider.chat(this.provider, {
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.85,
      maxTokens: 2048,
    });

    return this._parseResponse(response);
  }

  _parseResponse(raw) {
    try {
      const jsonStr = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr);

      if (!parsed.segments || !Array.isArray(parsed.segments)) return null;

      // 校验并修复
      const validSegments = parsed.segments
        .filter(s => typeof s.start_hour === 'number' && typeof s.end_hour === 'number' && s.activity)
        .map(s => {
          // 解析 emotion_impact
          let emotionImpact = null;
          if (s.emotion_impact && typeof s.emotion_impact === 'object') {
            const moodDelta = Number(s.emotion_impact.mood) || 0;
            if (moodDelta !== 0) {
              emotionImpact = { mood: Math.max(-8, Math.min(8, moodDelta)) };
            }
          }

          return {
            start_hour: Math.max(0, Math.min(23, s.start_hour)),
            end_hour: Math.max(1, Math.min(24, s.end_hour)),
            activity: String(s.activity).slice(0, 80),
            is_event: !!s.is_event,
            event_description: s.is_event ? String(s.event_description || '').slice(0, 100) : null,
            emotion_impact: emotionImpact,
          };
        });

      if (validSegments.length < 3) return null;

      return {
        segments: validSegments,
        summary: String(parsed.summary || '').slice(0, 100),
      };
    } catch {
      console.warn('[DailyPlanner] JSON 解析失败:', raw.slice(0, 200));
      return null;
    }
  }
}
