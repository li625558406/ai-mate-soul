/**
 * GrowthService - 角色成长与性格进化
 *
 * 职责：
 * 1. XP 经验值系统：每轮高质量对话增加经验
 * 2. 等级进化：XP 达到阈值时升级
 * 3. 性格进化：好感度跨越阈值时修改性格描述
 * 4. 镜像学习：统计用户常用词，融入 AI 说话风格
 */
export class GrowthService {
  constructor() {
    // 等级阈值表
    this._levelThresholds = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5500];

    // 好感度 -> 性格进化描述
    this._personalityStages = {
      cold: {
        minAffection: 0,
        maxAffection: 20,
        label: '警惕的陌生人',
        description: '对对方保持高度警惕，回复简短敷衍，不愿分享私人感受',
      },
      acquaintance: {
        minAffection: 21,
        maxAffection: 50,
        label: '普通认识的人',
        description: '开始愿意正常交流，但仍保持距离，偶尔会吐槽对方',
      },
      friend: {
        minAffection: 51,
        maxAffection: 80,
        label: '在意的朋友',
        description: '会主动关心对方，偶尔展露脆弱的一面，愿意分享日常',
      },
      intimate: {
        minAffection: 81,
        maxAffection: 100,
        label: '无可替代的人',
        description: '完全信任对方，会撒娇、会吃醋、会主动表达关心，偶尔黏人',
      },
    };
  }

  /**
   * 处理一轮对话的成长逻辑
   * @returns {{ xpGained: number, newLevel: number, leveledUp: boolean, personalityEvolved: boolean, newStage: object|null }}
   */
  processGrowth({ state, emotionWeight, userMessage }) {
    const results = { xpGained: 0, newLevel: state.level, leveledUp: false, personalityEvolved: false, newStage: null };

    // 1. 计算 XP：基础 10 + 情感投入加成 + 随机微波动
    const emotionBonus = Math.abs(emotionWeight) > 0 ? 5 : 0;
    const lengthBonus = userMessage.length > 20 ? 5 : 0;
    const randomBonus = Math.round((Math.random() * 6 - 3)); // -3 ~ +3
    results.xpGained = Math.max(5, 10 + emotionBonus + lengthBonus + randomBonus);

    // 2. 检查等级提升
    const totalXp = (state.experience || 0) + results.xpGained;
    let newLevel = state.level;
    for (let i = this._levelThresholds.length - 1; i >= 0; i--) {
      if (totalXp >= this._levelThresholds[i]) {
        newLevel = i + 1;
        break;
      }
    }
    if (newLevel > state.level) {
      results.leveledUp = true;
      results.newLevel = newLevel;
    }

    // 3. 检查性格阶段进化
    const stage = this.getPersonalityStage(state.affection);
    if (stage && stage.label !== (state.personality_stage || '')) {
      results.personalityEvolved = true;
      results.newStage = stage;
    }

    return { ...results, totalXp };
  }

  /**
   * 获取当前性格阶段
   */
  getPersonalityStage(affection) {
    for (const stage of Object.values(this._personalityStages)) {
      if (affection >= stage.minAffection && affection <= stage.maxAffection) {
        return stage;
      }
    }
    return this._personalityStages.cold;
  }

  /**
   * 镜像学习：统计用户消息中的高频词
   * @param {string[]} messages - 用户的最近消息列表
   * @param {string[]} currentMirrorWords - 当前已有的镜像词
   * @returns {string[]} 更新后的镜像词（最多 5 个）
   */
  learnMirrorWords(messages, currentMirrorWords = []) {
    if (messages.length < 5) return currentMirrorWords;

    // 简易中文高频词提取：去掉常见停用词后统计 2-3 字词频
    const stopWords = new Set([
      '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
      '这', '那', '有', '和', '就', '不', '也', '都', '而', '及',
      '与', '或', '一个', '没有', '什么', '怎么', '可以', '因为',
      '所以', '但是', '然后', '如果', '虽然', '已经', '还是', '就是',
      '啊', '吧', '呢', '哦', '嗯', '哈', '嘛', '呀', '嘛',
    ]);

    const freq = {};
    for (const msg of messages) {
      // 提取 2-3 字中文词
      const segments = msg.replace(/[^\u4e00-\u9fff]/g, ' ').split(/\s+/);
      for (const seg of segments) {
        if (seg.length >= 2 && seg.length <= 4 && !stopWords.has(seg)) {
          freq[seg] = (freq[seg] || 0) + 1;
        }
      }
    }

    // 取频率最高的词，排除已有的
    const sorted = Object.entries(freq)
      .filter(([w]) => !currentMirrorWords.includes(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);

    // 保留部分旧词 + 新词，最多 5 个
    const kept = currentMirrorWords.slice(0, Math.max(0, 3 - sorted.length));
    return [...kept, ...sorted].slice(0, 5);
  }
}
