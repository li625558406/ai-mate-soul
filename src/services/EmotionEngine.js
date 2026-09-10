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
          // 否定反转检测：positive 词前方近距有否定词 → 反转为负面；negative 词前有否定 → 降为中性偏正
          const negated = this._isNegated(lower, pattern);
          let effective = weight;
          if (negated) {
            effective = weight > 0 ? -0.8 : 0.3;
          }
          if (Math.abs(effective) > Math.abs(maxWeight)) {
            maxWeight = effective;
            matchedLabel = negated ? `${label}_negated` : label;
          }
        }
      }
    }

    // 敷衍信号：整条消息就是敷衍应答（哦/嗯/呵呵/切 等），弱负面
    if (maxWeight === 0 && this._isPerfunctory(text)) {
      return { weight: -0.5, label: 'perfunctory' };
    }

    // 限制在 [-2, 2] 范围
    const clampedWeight = Math.max(-2, Math.min(2, maxWeight));
    return { weight: clampedWeight, label: matchedLabel };
  }

  /**
   * 判断 pattern 在文本中是否被否定词修饰（前 2 个字符内出现否定词）
   */
  _isNegated(text, pattern) {
    const NEGATIONS = ['不', '没', '别', '无', '莫', '未', '才不', '毫不', '没那么'];
    let idx = text.indexOf(pattern);
    while (idx > 0) {
      const window = text.slice(Math.max(0, idx - 3), idx);
      if (NEGATIONS.some(n => window.includes(n))) return true;
      idx = text.indexOf(pattern, idx + 1);
    }
    return false;
  }

  /**
   * 敷衍应答检测：整条消息仅由单/重复语气应答字构成（≤4 字），如"哦"、"呵呵"、"切"、"嗯。"
   */
  _isPerfunctory(text) {
    const trimmed = text.trim().replace(/[。.!！?？~\s]/g, '');
    if (trimmed.length === 0 || trimmed.length > 4) return false;
    return /^(哦|噢|噢|喔|呃|呵+|嗯+|哦哦|喔哦|切|额|行|好吧|随便)$/.test(trimmed)
      || /^(.)\1+$/.test(trimmed); // 同一字重复，如"哦哦哦"
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
          '抱抱', '亲亲', '想你了', '好想你', '么么', '心疼你',
          '有你在', '和你聊天', '真乖', '真贴心', '晚安', '早安',
        ],
      },
      negative: {
        weight: -1.0,
        patterns: [
          '无聊', '算了', '随便', '不想理你', '烦', '差劲',
          '不喜欢', '走了', '闭嘴', '别说了', '无语',
          '呵呵', '烦死了', '无聊死了', '懒得理你', '不想说话',
          '又来了', '烦不烦', '跟你没关系', '少管我', '假惺惺',
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
