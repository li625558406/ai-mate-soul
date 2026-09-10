/**
 * TimeService - 时间感知与离线生活模拟
 *
 * 核心能力：
 * 1. 始终返回当前精确时间供 prompt 注入
 * 2. 通过 LLM 动态生成角色当前时段的活动（不再依赖固定日程表）
 * 3. 离线时生成时间线叙事
 * 4. 同一小时内缓存，避免重复调用 LLM
 */
export class TimeService {
  /**
   * @param {import('./LLMProvider.js').LLMProvider} llmProvider
   * @param {string} provider
   */
  constructor(llmProvider, provider) {
    this.llmProvider = llmProvider;
    this.provider = provider;
    /** @type {Map<string, { hour: number, date: string, activity: string }>} 缓存 */
    this._cache = new Map();
    /** @type {import('./DailyPlanner.js').DailyPlanner | null} */
    this.dailyPlanner = null;
  }

  /**
   * 获取当前时间的自然语言描述（每次对话都应注入）
   */
  getCurrentTimeDescription() {
    const now = new Date();
    const h = now.getHours();
    const m = String(now.getMinutes()).padStart(2, '0');
    const dateStr = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    const period = this._getPeriodDesc(h);
    return `${dateStr}，${period} ${h}:${m}`;
  }

  /**
   * 获取角色当前正在做的事情
   * 优先从 DailyPlanner 日程读取，读不到才 fallback 到 LLM 生成
   */
  async getCurrentActivity(character, userId) {
    // 优先：从每日日程读取
    if (this.dailyPlanner && userId) {
      const segment = this.dailyPlanner.getCurrentSegment(userId, character.id);
      if (segment) return segment.activity;
    }

    // Fallback：按小时 LLM 生成
    const now = new Date();
    const h = now.getHours();
    const date = now.toISOString().slice(0, 10);
    const cacheKey = `${character.id}_${date}_${h}`;

    const cached = this._cache.get(cacheKey);
    if (cached) return cached.activity;

    try {
      const activity = await this._generateActivityViaLLM(character, h, now);
      this._cache.set(cacheKey, { hour: h, date, activity });
      this._pruneCache(date);
      return activity;
    } catch {
      return null;
    }
  }

  /** 缓存超限时清理非当天的旧条目，防止跨天累积 */
  _pruneCache(today) {
    if (this._cache.size <= 200) return;
    for (const [key, val] of this._cache) {
      if (val.date !== today) this._cache.delete(key);
    }
  }

  /**
   * 生成离线时间线叙事
   */
  async generateOfflineNarrative({ characterId, lastSeenAt, character }) {
    const now = new Date();
    const lastSeen = new Date(lastSeenAt);
    const hoursAway = (now - lastSeen) / (1000 * 60 * 60);

    if (hoursAway < 1) {
      return { hasOfflineEvent: false, narrative: '', timeline: '', hoursAway };
    }

    const timeline = await this._buildTimeline(character, lastSeen, now, hoursAway);

    return {
      hasOfflineEvent: true,
      narrative: timeline.narrative,
      timeline: timeline.text,
      hoursAway,
    };
  }

  /**
   * LLM 生成单个时段的活动
   */
  async _generateActivityViaLLM(character, hour, now) {
    const period = this._getPeriodDesc(hour);
    const dateStr = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    const dk = character.dynamic_knowledge || {};

    // 拼接动态知识上下文
    let contextExtra = '';
    if (dk.personality_shifts?.length > 0) {
      const latest = dk.personality_shifts[dk.personality_shifts.length - 1];
      contextExtra += `\n最近性格变化：从${latest.from}变为${latest.to}（${latest.trigger}）`;
    }
    if (dk.user_life_events?.length > 0) {
      const recent = dk.user_life_events.slice(-2);
      contextExtra += `\n最近关于对方的事：${recent.map(e => e.event).join('、')}`;
    }

    const systemPrompt = `你是一个角色行为模拟器。根据角色档案，描述她在指定时段正在做什么。

要求：
- 只返回一句话，15-30字，描述具体正在做的活动
- 要符合角色的身份、爱好、性格
- 如果是深夜（0-6点），应该是睡觉或睡前活动
- 不要包含"我"字，直接描述活动本身
- 要有生活气息，具体而自然${contextExtra}

只返回活动描述，不要其他文字。`;

    // 拼接 living_info 上下文
    const li = character.living_info || {};
    let livingContext = '';
    if (li.frequent_places?.length > 0) {
      livingContext += `\n常去的地方：${li.frequent_places.slice(0, 4).join('、')}`;
    }
    if (li.weekend_routine) {
      const dayOfWeek = now.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        livingContext += `\n周末日常：${li.weekend_routine}`;
      }
    }
    if (li.school) {
      livingContext += `\n学校/工作：${li.school}`;
    }
    if (li.address) {
      livingContext += `\n住址：${li.address}`;
    }

    const content = `角色：${character.full_name || character.name}（${character.nickname || character.name}）
身份：${character.education}
性格：${character.base_personality}
爱好：${character.hobbies.join('、')}
当前时间：${dateStr} ${period}${livingContext}
${character.background ? '背景：' + character.background : ''}`;

    const response = await this.llmProvider.chat(this.provider, {
      systemPrompt,
      messages: [{ role: 'user', content }],
      temperature: 0.8,
    });

    return response.replace(/```/g, '').trim().slice(0, 80);
  }

  /**
   * 构建离线时间线
   */
  async _buildTimeline(character, startTime, endTime, hoursAway) {
    const segments = [];
    let prevActivity = null;
    const cursor = { t: new Date(startTime) };

    const maxSteps = Math.min(48, Math.ceil(hoursAway));
    for (let i = 0; i < maxSteps; i++) {
      const h = cursor.t.getHours();
      const date = cursor.t.toISOString().slice(0, 10);
      const cacheKey = `${character.id}_${date}_${h}`;

      let activity;
      const cached = this._cache.get(cacheKey);
      if (cached) {
        activity = cached.activity;
      } else {
        try {
          activity = await this._generateActivityViaLLM(character, h, cursor.t);
          this._cache.set(cacheKey, { hour: h, date, activity });
        } catch {
          activity = this._getFallbackActivity(h);
        }
      }

      if (activity !== prevActivity) {
        segments.push({ hour: h, activity });
        prevActivity = activity;
      }

      cursor.t = new Date(cursor.t.getTime() + 60 * 60 * 1000);
      if (cursor.t >= endTime) break;
    }

    this._pruneCache(new Date().toISOString().slice(0, 10));

    if (segments.length === 0) return { narrative: '', text: '' };

    // 去重连续相同活动
    const unique = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].activity !== unique[unique.length - 1].activity) {
        unique.push(segments[i]);
      } else {
        unique[unique.length - 1] = segments[i];
      }
    }

    const lines = unique.map(seg => `${this._getPeriodDesc(seg.hour)}：${seg.activity}`);
    const text = lines.join(' → ');
    const timeDesc = this._getTimeDesc(hoursAway);

    let narrative;
    const currentActivity = unique[unique.length - 1];
    const currentPeriod = this._getPeriodDesc(currentActivity.hour);
    narrative = `对方离开了${timeDesc}，现在回来了。我现在${currentActivity.activity}（${currentPeriod}）。`;
    if (unique.length > 1 && hoursAway > 3) {
      const earlier = unique.slice(0, -1).map(s => s.activity);
      const lastBefore = earlier[earlier.length - 1];
      narrative += `之前${lastBefore}。`;
    }

    return { narrative, text };
  }

  _getFallbackActivity(hour) {
    if (hour >= 0 && hour < 7) return '在睡觉';
    if (hour >= 7 && hour < 9) return '刚起床准备出门';
    if (hour >= 9 && hour < 12) return '在忙自己的事';
    if (hour >= 12 && hour < 14) return '在吃午饭';
    if (hour >= 14 && hour < 18) return '在忙下午的事';
    if (hour >= 18 && hour < 21) return '在吃晚饭休息';
    return '准备睡觉了';
  }

  _getTimeDesc(hoursAway) {
    const days = Math.floor(hoursAway / 24);
    const hours = Math.floor(hoursAway % 24);
    if (days > 0) return `${days}天${hours > 0 ? hours + '小时' : ''}`;
    if (hours > 0) return `${hours}小时`;
    return `${Math.round(hoursAway * 60)}分钟`;
  }

  _getPeriodDesc(hour) {
    if (hour >= 5 && hour < 8) return '清晨';
    if (hour >= 8 && hour < 12) return '上午';
    if (hour >= 12 && hour < 14) return '中午';
    if (hour >= 14 && hour < 18) return '下午';
    if (hour >= 18 && hour < 21) return '傍晚';
    return '深夜';
  }
}
