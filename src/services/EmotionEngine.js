/**
 * EmotionEngine - 情感分析引擎
 *
 * 设计：先使用本地关键词快速分析，可选通过 LLM 做深度分析
 * 情感权重 W ∈ [-2, 2]
 *   -2.0 : 极度辱骂/攻击
 *   -1.0 : 不满/批评
 *    0.0 : 中性
 *    1.0 : 赞美/感谢
 *    2.0 : 极度赞赏/表白
 *
 * 好感度更新：Affection_new = Affection_old + W × Confidence
 * Confidence 默认 2.0（可调），表示情感对好感度的影响倍率
 */
export class EmotionEngine {
  constructor(options = {}) {
    this.confidence = options.confidence || 0.3;
    this._keywords = this._buildKeywordMap();
  }

  /**
   * 分析用户输入的情绪权重
   * @param {string} text - 用户消息
   * @returns {{ weight: number, label: string }}
   */
  analyze(text) {
    const lower = text.toLowerCase();

    let maxWeight = 0;
    let matchedLabel = 'neutral';

    for (const [label, { weight, patterns }] of Object.entries(this._keywords)) {
      for (const pattern of patterns) {
        if (lower.includes(pattern)) {
          if (Math.abs(weight) > Math.abs(maxWeight)) {
            maxWeight = weight;
            matchedLabel = label;
          }
        }
      }
    }

    // 限制在 [-2, 2] 范围
    const clampedWeight = Math.max(-2, Math.min(2, maxWeight));
    return { weight: clampedWeight, label: matchedLabel };
  }

  /**
   * 基于情感权重更新好感度
   * @param {number} currentAffection - 当前好感度 (0-100)
   * @param {number} emotionWeight - 情感权重 [-2, 2]
   * @returns {{ newAffection: number, delta: number }}
   */
  updateAffection(currentAffection, emotionWeight) {
    const jitter = (Math.random() - 0.5) * 0.4; // -0.2 ~ +0.2 微波动
    const delta = emotionWeight * this.confidence + jitter;
    let newAffection = currentAffection + delta;
    // 限制在 [0, 100]
    newAffection = Math.max(0, Math.min(100, Math.round(newAffection * 10) / 10));
    return { newAffection, delta: Math.round(delta * 10) / 10 };
  }

  /**
   * 将好感度映射为心情状态
   * @param {number} affection - 好感度 0-100
   * @returns {{ mood: string, description: string, level: string }}
   */
  mapMood(affection) {
    if (affection <= 20) {
      return { mood: 'cold', description: '冷淡/警惕', level: '疏远' };
    } else if (affection <= 60) {
      return { mood: 'normal', description: '平常/客气', level: '普通' };
    } else {
      return { mood: 'intimate', description: '亲密/依赖', level: '亲近' };
    }
  }

  /**
   * 基于角色成长逻辑，检查是否触发额外好感增长
   * @param {number} chatCount - 当前对话次数
   * @param {object} growthLogic - 角色的 growth_logic 配置
   * @returns {number} 额外好感度增量
   */
  checkGrowth(chatCount, growthLogic) {
    if (!growthLogic) return 0;
    const { interval, affection_range } = growthLogic;
    if (interval && chatCount > 0 && chatCount % interval === 0) {
      const [min, max] = affection_range || [0.5, 1.0];
      return Math.round((min + Math.random() * (max - min)) * 10) / 10;
    }
    return 0;
  }

  /**
   * 基于离线时长计算衰减
   * @param {{ affection: number, mood: number, experience: number, lastSeenAt: string }} state
   * @returns {{ affectionDecay: number, moodDecay: number, xpDecay: number, hoursOffline: number }}
   */
  calcOfflineDecay({ affection, mood, experience, lastSeenAt }) {
    if (!lastSeenAt) return { affectionDecay: 0, moodDecay: 0, xpDecay: 0, hoursOffline: 0 };

    const now = new Date();
    const last = new Date(lastSeenAt);
    const hoursOffline = (now - last) / 3600000;

    // 不足 1 小时不衰减
    if (hoursOffline < 1) return { affectionDecay: 0, moodDecay: 0, xpDecay: 0, hoursOffline };

    // 好感度：每 24h 衰减 1 点，最低降到 20
    const affectionDecay = Math.min(
      Math.max(0, affection - 20),
      Math.floor(hoursOffline / 24)
    );

    // 心情值：向 0 回归，每小时 ±3 点
    let moodDecay = 0;
    if (mood > 0) {
      moodDecay = Math.min(mood, Math.floor(hoursOffline) * 3);
    } else if (mood < 0) {
      moodDecay = Math.max(mood, -(Math.floor(hoursOffline) * 3));
    }

    // 经验值：每 24h 衰减 2 点，最低 0
    const xpDecay = Math.min(experience, Math.floor(hoursOffline / 24) * 2);

    return { affectionDecay, moodDecay, xpDecay, hoursOffline };
  }

  /**
   * 基于聊天情感权重更新心情值
   * @param {number} currentMood - 当前心情值 (-100 ~ +100)
   * @param {number} emotionWeight - 情感权重 [-2, 2]
   * @returns {{ newMood: number, delta: number }}
   */
  updateMood(currentMood, emotionWeight) {
    const baseBoost = 0.3; // 普通聊天就是开心的
    const jitter = (Math.random() - 0.5) * 0.3;
    const delta = baseBoost + emotionWeight * 1.5 + jitter;
    let newMood = currentMood + delta;
    newMood = Math.max(-100, Math.min(100, Math.round(newMood * 10) / 10));
    return { newMood, delta: Math.round(delta * 10) / 10 };
  }

  _buildKeywordMap() {
    return {
      extreme_positive: {
        weight: 2.0,
        patterns: [
          '我爱你', '最喜欢你了', '你是最好的', '离不开你', '太棒了吧',
          '完美', '永远喜欢你', '好爱你', '最棒了', '超级喜欢你',
        ],
      },
      positive: {
        weight: 1.0,
        patterns: [
          '谢谢', '谢谢你', '感谢', '辛苦了', '好厉害', '真好',
          '不错', '可爱', '喜欢你', '开心', '哈哈', '有趣',
          '厉害', '佩服', '好看', '漂亮', '好棒',
        ],
      },
      negative: {
        weight: -1.0,
        patterns: [
          '无聊', '算了', '随便', '不想理你', '烦', '差劲',
          '不喜欢', '走了', '闭嘴', '别说了', '无语',
        ],
      },
      extreme_negative: {
        weight: -2.0,
        patterns: [
          '滚', '废物', '垃圾', '恶心', '去死', '混蛋',
          '蠢', '白痴', '傻逼', '贱', '渣',
        ],
      },
    };
  }
}
