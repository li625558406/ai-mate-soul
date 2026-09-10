/**
 * FactExtractor - 用户画像事实提取
 *
 * 职责：每轮对话后异步提取用户个人信息，存入 user_facts 表
 * 设计：非阻塞，通过 LLM 分析对话内容
 */
export class FactExtractor {
  /**
   * @param {object} deps
   * @param {import('./LLMProvider.js').LLMProvider} deps.llmProvider
   * @param {import('../database/DatabaseManager.js').DatabaseManager} deps.db
   * @param {string} deps.provider
   */
  constructor({ llmProvider, db, provider }) {
    this.llmProvider = llmProvider;
    this.db = db;
    this.provider = provider;
  }

  /**
   * 异步提取事实（fire-and-forget）
   * 在对话结束后调用，不阻塞响应
   */
  async extractAsync({ userId, characterId, userMessage, aiResponse }) {
    try {
      const facts = await this._callLLM(userMessage, aiResponse);
      if (!facts || facts.length === 0) return;

      for (const f of facts) {
        this.db.upsertFact(userId, characterId, f.key, f.value, f.confidence || 0.8, userMessage);
      }

      if (facts.length > 0) {
        console.log(`[FactExtractor] 提取了 ${facts.length} 条事实:`, facts.map(f => `${f.key}=${f.value}`));
      }
    } catch (err) {
      // 事实提取失败不应影响主流程
      console.warn(`[FactExtractor] 提取失败:`, err.message);
    }
  }

  async _callLLM(userMessage, aiResponse) {
    const systemPrompt = `你是一个信息提取助手。分析以下对话，提取关于"用户"的个人事实信息。

只提取明确提及的信息，不要推测。返回 JSON 数组格式，每个元素包含：
- key: 事实类别（用简体中文，如 家乡、生日、宠物昵称、工作、喜欢的食物、讨厌的食物、爱好、心情、感情状态、梦想 等，禁止输出英文类别）
- value: 事实内容的纯净值（不要包含"我叫"、"我老家是"、"我最讨厌"等主语前缀。例如："小明"、"成都"、"香菜"）
- confidence: 确信度 0-1

如果对话中没有关于用户的个人信息，返回空数组 []。

只返回 JSON，不要其他文字。`;

    const content = `用户说：${userMessage}\nAI回复：${aiResponse}`;

    const response = await this.llmProvider.chat(this.provider, {
      systemPrompt,
      messages: [{ role: 'user', content }],
      temperature: 0.1,
    });

    try {
      // 尝试从回复中解析 JSON
      const jsonStr = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
