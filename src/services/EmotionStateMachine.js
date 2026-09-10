/**
 * EmotionStateMachine - 情绪状态机
 *
 * 心情值范围：-100 ~ +100（0 = 平静，负 = 不开心，正 = 开心）
 *
 * 状态映射：
 *   +50 ~ +100  开心 (joyful)
 *   +20 ~ +49   愉悦 (happy)
 *   -19 ~ +19   平静 (calm)
 *   -49 ~ -20   不悦 (uneasy)
 *   -79 ~ -50   愤怒 (angry)
 *   -100 ~ -80  冷战 (cold_war)
 *
 * 驱动因素：
 * - 雷区触发（minefield）降低心情
 * - 时间衰减让心情向 0 回归
 * - 用户道歉大幅恢复心情
 * - cold_war 持续时间由 cold_war_until 控制
 */
export class EmotionStateMachine {
  constructor() {
    // 状态定义
    this.STATES = {
      joyful:    { minMood: 50,  maxMood: 100,  label: '开心' },
      happy:     { minMood: 20,  maxMood: 49,   label: '愉悦' },
      calm:      { minMood: -19, maxMood: 19,   label: '平静' },
      uneasy:    { minMood: -49, maxMood: -20,  label: '不悦' },
      angry:     { minMood: -79, maxMood: -50,  label: '愤怒' },
      cold_war:  { minMood: -100, maxMood: -80, label: '冷战' },
    };

    // 默认衰减和恢复配置
    this.defaultConfig = {
      decayPerHour: 3,         // 每小时向 0 回归
      apologyRecovery: 25,     // 道歉恢复量
      coldWarDurationMin: 30,  // 冷战最短持续分钟
      minefieldMultiplier: 1,  // 雷区触发倍率
    };

    /** @type {Map<string, RegExp>} 雷区正则预编译缓存 */
    this._regexCache = new Map();
  }

  /** 获取预编译的雷区正则（无效 pattern 返回 null） */
  _getMinefieldRegex(trigger) {
    if (this._regexCache.has(trigger)) return this._regexCache.get(trigger);
    let regex = null;
    try {
      regex = new RegExp(trigger, 'i');
    } catch {
      regex = null;
    }
    this._regexCache.set(trigger, regex);
    return regex;
  }

  /**
   * 处理一轮对话的情绪状态转换
   * @param {{ state: object, userMessage: string, characterMinefields: Array, config: object }} params
   * @returns {{ emotionState: string, moodLevel: number, triggeredMinefield: object|null, isColdWar: boolean, coldWarEndAt: string|null }}
   */
  process({ state, userMessage, characterMinefields = [], config = {}, emotionWeight = 0 }) {
    const cfg = { ...this.defaultConfig, ...config };
    let mood = state.mood_level || 0;
    let coldWarUntil = state.cold_war_until;
    let negStreak = state.neg_streak || 0;
    let sensitiveUntil = state.sensitive_until || null;
    let justExitedColdWar = false;

    // 1. 检查是否仍在冷战中
    if (coldWarUntil) {
      const now = new Date();
      const endTime = new Date(coldWarUntil);
      if (now < endTime) {
        return {
          emotionState: 'cold_war',
          moodLevel: mood,
          triggeredMinefield: null,
          isColdWar: true,
          coldWarEndAt: coldWarUntil,
          isApology: false,
          negStreak,
          sensitiveUntil,
        };
      }
      // 冷战结束，恢复心情，并进入 24h 敏感期（心结还没完全过去）
      coldWarUntil = null;
      mood = Math.min(0, mood + 30);
      justExitedColdWar = true;
    }

    // 2. 检查时间衰减（向 0 回归）
    if (state.last_seen_at) {
      const hoursAway = (Date.now() - new Date(state.last_seen_at).getTime()) / (1000 * 60 * 60);
      if (hoursAway > 1) {
        const decay = Math.floor(hoursAway * cfg.decayPerHour);
        if (mood > 0) {
          mood = Math.max(0, mood - decay);
        } else if (mood < 0) {
          mood = Math.min(0, mood + decay);
        }
      }
    }

    // 2.5 会话本身对心情的影响（原 EmotionEngine.updateMood 逻辑迁入，心情唯一写入点）
    const baseBoost = 0.3; // 普通聊天就是开心的
    const jitter = (Math.random() - 0.5) * 0.3;
    let sessionMoodDelta = baseBoost + emotionWeight * 1.5;

    // 2.6 情绪惯性：
    //   a) 连续负面消息 → 越吵越凶，惩罚递增（每多连击一次额外 -2，封顶 -10）
    //   b) 敏感期（和解后 24h）→ 负面消息影响放大 1.5 倍
    //   c) 心情极好时对轻微冒犯更宽容（负面影响 ×0.7）
    if (emotionWeight < -0.5) {
      negStreak += 1;
    } else if (emotionWeight > 0.5) {
      negStreak = 0;
    }
    const inSensitivePeriod = sensitiveUntil && new Date(sensitiveUntil) > new Date();
    if (sessionMoodDelta < 0) {
      if (negStreak >= 2) sessionMoodDelta -= Math.min(10, 2 * (negStreak - 1));
      if (inSensitivePeriod) sessionMoodDelta *= 1.5;
      else if (mood >= 50) sessionMoodDelta *= 0.7;
    }

    mood += sessionMoodDelta + jitter;
    mood = Math.max(-100, Math.min(100, mood));

    // 3. 检查道歉（大幅恢复心情；敏感期中心次没完全过去，恢复减半）
    const isApology = this.isApologyMessage(userMessage);
    if (isApology) {
      const recovery = inSensitivePeriod ? cfg.apologyRecovery * 0.5 : cfg.apologyRecovery;
      mood = Math.min(0, mood + recovery);
      negStreak = 0;
    }

    // 4. 检查雷区触发（降低心情；敏感期内雷区更痛 ×1.5）
    let triggeredMinefield = null;
    if (!isApology) {
      for (const mf of characterMinefields) {
        const triggers = Array.isArray(mf.trigger) ? mf.trigger : [mf.trigger];
        for (const trigger of triggers) {
          const regex = this._getMinefieldRegex(trigger);
          if (regex ? regex.test(userMessage) : userMessage.includes(trigger)) {
            let penalty = (mf.mood_penalty || mf.annoyance || 15) * cfg.minefieldMultiplier;
            if (inSensitivePeriod) penalty *= 1.5;
            mood -= penalty;
            triggeredMinefield = mf;
            break;
          }
        }
        if (triggeredMinefield) break;
      }
    }

    // 5. 限制心情范围
    mood = Math.max(-100, Math.min(100, Math.round(mood)));

    // 6. 确定新状态
    const emotionState = this._getStateForMood(mood);

    // 7. 进入冷战？设置持续时间
    if (emotionState === 'cold_war' && !coldWarUntil) {
      const endTime = new Date(Date.now() + cfg.coldWarDurationMin * 60 * 1000);
      coldWarUntil = endTime.toISOString();
    }

    // 8. 冷战自然结束 → 开启 24h 敏感期
    if (justExitedColdWar) {
      sensitiveUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }

    return {
      emotionState,
      moodLevel: mood,
      triggeredMinefield,
      isColdWar: emotionState === 'cold_war',
      coldWarEndAt: coldWarUntil,
      isApology,
      negStreak,
      sensitiveUntil,
      justExitedColdWar,
    };
  }

  /** 道歉词命中判定（提前和解与心情恢复共用） */
  isApologyMessage(text) {
    const patterns = ['对不起', '抱歉', '我错了', '是我的错', '不好意思', '原谅我', '对不住'];
    return patterns.some(p => text.includes(p));
  }

  getColdWarResponse(coldWarResponses = []) {
    const defaults = [
      '...',
      '我现在不想说话。',
      '你自己反省一下。',
      '哼。',
      '别跟我说话。',
      '...等你什么时候想清楚了再说吧。',
    ];
    const pool = coldWarResponses.length > 0 ? coldWarResponses : defaults;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  getColdWarRemainingMinutes(coldWarUntil) {
    if (!coldWarUntil) return 0;
    const remaining = (new Date(coldWarUntil).getTime() - Date.now()) / (1000 * 60);
    return Math.max(0, Math.round(remaining));
  }

  getStateLabel(emotionState) {
    return this.STATES[emotionState]?.label || emotionState;
  }

  /** 由心情值派生统一的对外描述（meta 展示唯一来源） */
  getMoodDescription(moodLevel) {
    const ICONS = {
      joyful: '😊', happy: '🙂', calm: '😐', uneasy: '😕', angry: '😠', cold_war: '🧊',
    };
    const state = this._getStateForMood(moodLevel);
    return `${ICONS[state] || '😐'} ${this.STATES[state].label}`;
  }

  _getStateForMood(mood) {
    if (mood >= 50) return 'joyful';
    if (mood >= 20) return 'happy';
    if (mood >= -20) return 'calm';
    if (mood >= -50) return 'uneasy';
    if (mood >= -80) return 'angry';
    return 'cold_war';
  }
}
