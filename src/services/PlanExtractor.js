/**
 * PlanExtractor - 对话中的未来计划提取器
 *
 * 从对话中提取用户和角色约定的未来计划：
 * - "明天去游乐园" → plan_date: 明天, description: 一起去游乐园
 * - "周末一起吃火锅" → plan_date: 这个周末, description: 一起吃火锅
 * - "下周去爬山" → plan_date: 下周, description: 一起去爬山
 *
 * 异步执行，不阻塞主流程。提取结果存入 future_plans 表，
 * DailyPlanner 和 PromptBuilder 在生成日程时读取。
 */
export class PlanExtractor {
  constructor({ llmProvider, db, provider }) {
    this.llmProvider = llmProvider;
    this.db = db;
    this.provider = provider;
  }

  async extractAsync({ userId, characterId, userMessage, aiResponse }) {
    try {
      const plans = await this._callLLM(userMessage, aiResponse);
      if (!plans || plans.length === 0) return;

      const today = new Date();
      for (const plan of plans) {
        const planDate = this._resolveDate(plan.date_hint, today);
        if (!planDate) continue;

        this.db.saveFuturePlan({
          userId, characterId,
          planDate,
          description: plan.description,
          source: userMessage,
        });
      }

      console.log(`[PlanExtractor] 提取了 ${plans.length} 个未来计划:`, plans.map(p => `${p.date_hint}: ${p.description}`));
    } catch (err) {
      console.warn(`[PlanExtractor] 提取失败:`, err.message);
    }
  }

  async _callLLM(userMessage, aiResponse) {
    const systemPrompt = `分析以下对话，提取双方约定的未来计划/约定/承诺。

只提取有明确时间指向的计划（明天、后天、周末、下周、某月某日等）。
不要提取：过去的回忆、当前正在做的事、模糊的意向（"以后有机会"等）。

返回 JSON 数组，每项包含：
- "date_hint": 时间描述（如"明天"、"这周六"、"下周一"）
- "description": 计划内容（简洁描述，如"一起去游乐园"、"一起吃火锅"）

如果没有未来计划，返回空数组 []。只返回 JSON，不要其他文字。`;

    const content = `用户说：${userMessage}\nAI回复：${aiResponse}`;

    const response = await this.llmProvider.chat(this.provider, {
      systemPrompt,
      messages: [{ role: 'user', content }],
      temperature: 0.0,
    });

    try {
      const jsonStr = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * 将中文时间描述解析为具体日期 (YYYY-MM-DD)
   */
  _resolveDate(hint, baseDate) {
    const d = new Date(baseDate);
    const lower = hint.toLowerCase();

    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'];

    if (lower.includes('今天') || lower.includes('今晚')) {
      return this._fmt(d);
    }
    if (lower.includes('明天')) {
      d.setDate(d.getDate() + 1);
      return this._fmt(d);
    }
    if (lower.includes('后天')) {
      d.setDate(d.getDate() + 2);
      return this._fmt(d);
    }
    if (lower.includes('大后天')) {
      d.setDate(d.getDate() + 3);
      return this._fmt(d);
    }

    // 周X / 星期X
    const weekMatch = lower.match(/(?:周|星期|礼拜)([一二三四五六日天])/);
    if (weekMatch) {
      const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
      const target = dayMap[weekMatch[1]];
      if (target !== undefined) {
        let diff = target - d.getDay();
        if (diff <= 0) diff += 7; // 下周
        // 如果说"这周"且已经过了，也算下周
        if (lower.includes('下')) diff += 7;
        d.setDate(d.getDate() + diff);
        return this._fmt(d);
      }
    }

    // 周末
    if (lower.includes('周末')) {
      const day = d.getDay();
      let diff = 6 - day; // 周六
      if (diff <= 0) diff += 7;
      if (lower.includes('下')) diff += 7;
      d.setDate(d.getDate() + diff);
      return this._fmt(d);
    }

    // 下周X
    const nextWeekMatch = lower.match(/下周([一二三四五六日天])/);
    if (nextWeekMatch) {
      const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
      const target = dayMap[nextWeekMatch[1]];
      if (target !== undefined) {
        let diff = target - d.getDay() + 7;
        if (diff <= 0) diff += 7;
        d.setDate(d.getDate() + diff);
        return this._fmt(d);
      }
    }

    // X月X日
    const dateMatch = lower.match(/(\d{1,2})月(\d{1,2})[日号]/);
    if (dateMatch) {
      const month = parseInt(dateMatch[1]) - 1;
      const day = parseInt(dateMatch[2]);
      const year = d.getFullYear();
      const target = new Date(year, month, day);
      if (target < baseDate) target.setFullYear(year + 1);
      return this._fmt(target);
    }

    return null;
  }

  _fmt(d) {
    return d.toISOString().slice(0, 10);
  }
}
