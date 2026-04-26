/**
 * LifecycleService - 生命周期演变与纪念日系统
 */
export class LifecycleService {
  constructor() {
    this._lifeStages = [
      { minDays: 0,   maxDays: 7,   stage: '初识',    desc: '刚开始认识对方，充满好奇和戒备', tone: '探索好奇' },
      { minDays: 8,   maxDays: 30,  stage: '熟悉',    desc: '开始习惯对方的存在，偶尔会主动找话题', tone: '逐渐自然' },
      { minDays: 31,  maxDays: 90,  stage: '朋友',    desc: '已经把对方当朋友了，会分享日常', tone: '轻松自在' },
      { minDays: 91,  maxDays: 200, stage: '亲密',    desc: '非常在意对方，开始产生依赖', tone: '深厚默契' },
      { minDays: 201, maxDays: 365, stage: '挚友',    desc: '无法想象没有对方的日子', tone: '不可或缺' },
      { minDays: 366, maxDays: 99999, stage: '灵魂伴侣', desc: '对方已经是生命中最重要的人之一', tone: '深深羁绊' },
    ];
  }

  getLifeStage(interactionDays) {
    for (const stage of this._lifeStages) {
      if (interactionDays >= stage.minDays && interactionDays <= stage.maxDays) return stage;
    }
    return this._lifeStages[this._lifeStages.length - 1];
  }

  checkFirstMeet(db, userId, characterId) {
    const state = db.getCharacterState(userId, characterId);
    return state?.first_met_at || null;
  }

  saveAnniversary(db, { userId, characterId, type, date, description }) {
    db.saveAnniversary({ userId, characterId, type, date, description });
  }

  getUpcomingAnniversaries(db, userId, characterId, daysAhead = 7) {
    const anniversaries = db.getAnniversaries(userId, characterId);
    const now = new Date();
    const upcoming = [];

    for (const a of anniversaries) {
      const annDate = new Date(a.date);
      const thisYear = new Date(now.getFullYear(), annDate.getMonth(), annDate.getDate());
      if (thisYear < now) thisYear.setFullYear(thisYear.getFullYear() + 1);
      const diff = Math.ceil((thisYear - now) / (1000 * 60 * 60 * 24));
      if (diff >= 0 && diff <= daysAhead) {
        upcoming.push({ ...a, nextDate: thisYear.toISOString().slice(0, 10), daysAway: diff });
      }
    }
    return upcoming.sort((a, b) => a.daysAway - b.daysAway);
  }

  getLifeStagePrompt(interactionDays) {
    const stage = this.getLifeStage(interactionDays);
    return `[人生阶段] 你们已经认识了 ${interactionDays} 天。
当前关系阶段：${stage.stage} —— ${stage.desc}
你的语气应该体现${stage.tone}的感觉。认识越久，你们之间的默契越深。`;
  }

  /**
   * 确保生日和相识纪念日已写入 anniversaries 表
   * 每次聊天时调用，幂等
   */
  ensureBirthdayAnniversary(db, userId, characterId, character) {
    if (!character.birthday) return;

    const existing = db.getAnniversaries(userId, characterId);
    const now = new Date();

    // 生日纪念日
    const hasBirthday = existing.some(a => a.type === 'birthday');
    if (hasBirthday) {
      // 检查已过期的，更新到下一年
      const bday = existing.find(a => a.type === 'birthday');
      if (bday && new Date(bday.date) <= now) {
        const [m, d] = character.birthday.split('-').map(Number);
        let next = new Date(now.getFullYear(), m - 1, d);
        if (next <= now) next.setFullYear(next.getFullYear() + 1);
        db.saveAnniversary({
          userId, characterId,
          type: 'birthday',
          date: next.toISOString().slice(0, 10),
          description: `${character.full_name || character.nickname || character.name}的生日`,
        });
      }
    } else {
      const [m, d] = character.birthday.split('-').map(Number);
      let next = new Date(now.getFullYear(), m - 1, d);
      if (next <= now) next.setFullYear(next.getFullYear() + 1);
      db.saveAnniversary({
        userId, characterId,
        type: 'birthday',
        date: next.toISOString().slice(0, 10),
        description: `${character.full_name || character.nickname || character.name}的生日`,
      });
    }

    // 相识纪念日
    const hasFirstMeet = existing.some(a => a.type === 'first_meet');
    if (!hasFirstMeet) {
      const state = db.getCharacterState(userId, characterId);
      if (state?.first_met_at) {
        const meetDate = new Date(state.first_met_at);
        let nextAnniv = new Date(now.getFullYear(), meetDate.getMonth(), meetDate.getDate());
        if (nextAnniv <= now) nextAnniv.setFullYear(nextAnniv.getFullYear() + 1);
        db.saveAnniversary({
          userId, characterId,
          type: 'first_meet',
          date: nextAnniv.toISOString().slice(0, 10),
          description: `认识${character.full_name || character.nickname || character.name}的纪念日`,
        });
      }
    } else {
      const fm = existing.find(a => a.type === 'first_meet');
      if (fm && new Date(fm.date) <= now) {
        const state = db.getCharacterState(userId, characterId);
        if (state?.first_met_at) {
          const meetDate = new Date(state.first_met_at);
          let nextAnniv = new Date(now.getFullYear(), meetDate.getMonth(), meetDate.getDate());
          if (nextAnniv <= now) nextAnniv.setFullYear(nextAnniv.getFullYear() + 1);
          db.saveAnniversary({
            userId, characterId,
            type: 'first_meet',
            date: nextAnniv.toISOString().slice(0, 10),
            description: `认识${character.full_name || character.nickname || character.name}的纪念日`,
          });
        }
      }
    }
  }

  /**
   * 根据初次见面时间计算角色当前年龄
   * character.age 是初次见面时的年龄
   */
  getCurrentAge(character, firstMetAt) {
    const baseAge = character.age || 0;
    if (!firstMetAt) return baseAge;
    const yearsPassed = (Date.now() - new Date(firstMetAt).getTime()) / (365.25 * 24 * 3600 * 1000);
    return baseAge + Math.floor(yearsPassed);
  }
}
