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
  }

  /**
   * 处理一轮对话的情绪状态转换
   * @param {{ state: object, userMessage: string, characterMinefields: Array, config: object }} params
   * @returns {{ emotionState: string, moodLevel: number, triggeredMinefield: object|null, isColdWar: boolean, coldWarEndAt: string|null }}
   */
  process({ state, userMessage, characterMinefields = [], config = {} }) {
    const cfg = { ...this.defaultConfig, ...config };
    let mood = state.mood_level || 0;
    let coldWarUntil = state.cold_war_until;

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
        };
      }
      // 冷战结束，恢复心情
      coldWarUntil = null;
      mood = Math.min(0, mood + 30);
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

    // 3. 检查道歉（大幅恢复心情）
    const apologyPatterns = ['对不起', '抱歉', '我错了', '是我的错', '不好意思', '原谅我', '抱歉了', '对不住'];
    const isApology = apologyPatterns.some(p => userMessage.includes(p));
    if (isApology) {
      mood = Math.min(0, mood + cfg.apologyRecovery);
    }

    // 4. 检查雷区触发（降低心情）
    let triggeredMinefield = null;
    if (!isApology) {
      for (const mf of characterMinefields) {
        const triggers = Array.isArray(mf.trigger) ? mf.trigger : [mf.trigger];
        for (const trigger of triggers) {
          try {
            const regex = new RegExp(trigger, 'i');
            if (regex.test(userMessage)) {
              mood -= (mf.mood_penalty || 15) * cfg.minefieldMultiplier;
              triggeredMinefield = mf;
              break;
            }
          } catch {
            if (userMessage.includes(trigger)) {
              mood -= (mf.mood_penalty || mf.annoyance || 15) * cfg.minefieldMultiplier;
              triggeredMinefield = mf;
              break;
            }
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

    return {
      emotionState,
      moodLevel: mood,
      triggeredMinefield,
      isColdWar: emotionState === 'cold_war',
      coldWarEndAt: coldWarUntil,
    };
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

  _getStateForMood(mood) {
    if (mood >= 50) return 'joyful';
    if (mood >= 20) return 'happy';
    if (mood >= -20) return 'calm';
    if (mood >= -50) return 'uneasy';
    if (mood >= -80) return 'angry';
    return 'cold_war';
  }
}
