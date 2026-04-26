import fs from 'fs';

/**
 * DiaryService - 秘密日记系统
 *
 * 职责：
 * 1. 每天深夜根据当天聊天记录生成日记
 * 2. 日记包含 AI 对用户的真实想法（不会当面说的）
 * 3. 权限控制：好感度达到阈值才可解锁
 */
export class DiaryService {
  /**
   * @param {object} deps
   * @param {import('../database/DatabaseManager.js').DatabaseManager} deps.db
   * @param {import('./LLMProvider.js').LLMProvider} deps.llmProvider
   * @param {import('./CharacterManager.js').CharacterManager} deps.characterManager
   * @param {string} deps.provider
   */
  constructor({ db, llmProvider, characterManager, provider }) {
    this.db = db;
    this.llmProvider = llmProvider;
    this.characterManager = characterManager;
    this.provider = provider;
  }

  /**
   * 为指定用户-角色对生成今日日记
   */
  async generateDailyDiary({ userId, characterId }) {
    const today = new Date().toISOString().slice(0, 10);

    const existing = this.db.getLatestDiaryDate(userId, characterId);
    if (existing === today) {
      return { success: false, diary: null, date: today, reason: 'already_generated' };
    }

    const rows = this.db.db.prepare(
      `SELECT role, content FROM chat_history
       WHERE user_id = ? AND character_id = ? AND date(created_at) = date('now', 'localtime')
       ORDER BY created_at ASC`
    ).all(userId, characterId);

    if (rows.length === 0) {
      return { success: false, diary: null, date: today, reason: 'no_conversations' };
    }

    const character = this.characterManager.getCharacter(characterId);
    if (!character) {
      return { success: false, diary: null, date: today, reason: 'character_not_found' };
    }

    const state = this.db.getCharacterState(userId, characterId);
    const affection = state?.affection || 50;

    const conversationSummary = rows
      .filter(r => r.role !== 'system')
      .map(r => `${r.role === 'user' ? '对方' : '我'}: ${r.content.slice(0, 80)}`)
      .join('\n');

    const systemPrompt = `你是「${character.name}」，正在写今天的日记。
性格：${character.base_personality}。

请根据今天的对话记录，写一段日记（150-250字）。
要求：
1. 用第一人称写，像是真正的私密日记
2. 可以写出当面不会说出口的真实感受（比如嘴上说不在意但其实很开心，或者嘴上说讨厌但其实在意）
3. 提到具体发生的事情
4. 语气要符合你的性格
5. 不要用引号包裹全文
6. 用自然的日记口吻，可以以"今天"开头`;

    try {
      const diary = await this.llmProvider.chat(this.provider, {
        systemPrompt,
        messages: [{ role: 'user', content: `今天的对话记录：\n${conversationSummary}` }],
        temperature: 0.9,
      });

      if (diary) {
        this.db.saveDiary({
          userId, characterId, date: today, content: diary,
          mood: state?.mood || 'normal',
          affectionAtTime: affection,
          unlockRequired: affection >= 60 ? 0 : 60,
        });
        console.log(`[DiaryService] 生成日记: ${userId}/${characterId} ${today} (${diary.length}字)`);
      }

      return { success: !!diary, diary, date: today };
    } catch (err) {
      console.warn('[DiaryService] 生成失败:', err.message);
      return { success: false, diary: null, date: today, reason: 'llm_error' };
    }
  }

  /**
   * 获取日记列表（带权限控制）
   */
  getDiariesForUser(userId, characterId, affection, { includeLocked = false } = {}) {
    this.db.autoUnlockDiaries(userId, characterId, affection);
    return this.db.getDiaries(userId, characterId, { limit: 50, includeLocked });
  }

  /**
   * 定时检查所有活跃用户对，生成缺失的日记
   */
  async checkAndGenerateAll() {
    const activePairs = this.db.db.prepare(
      `SELECT user_id, character_id FROM characters_state WHERE chat_count > 0`
    ).all();

    for (const { user_id, character_id } of activePairs) {
      await this.generateDailyDiary({ userId: user_id, characterId: character_id });
    }
  }
}
