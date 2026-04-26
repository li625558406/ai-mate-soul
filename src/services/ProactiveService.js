/**
 * ProactiveService - 主动交互引擎
 *
 * 职责：
 * 1. 管理用户 Socket.io 连接
 * 2. 当用户重连时，检查离线时长，推送回归消息
 * 3. 定时检查在线空闲用户，基于角色当前活动推送主动消息
 */
export class ProactiveService {
  /**
   * @param {object} deps
   * @param {import('./LLMProvider.js').LLMProvider} deps.llmProvider
   * @param {import('../database/DatabaseManager.js').DatabaseManager} deps.db
   * @param {import('./TimeService.js').TimeService} deps.timeService
   * @param {import('./CharacterManager.js').CharacterManager} deps.characterManager
   * @param {string} deps.provider
   */
  constructor({ llmProvider, db, timeService, characterManager, provider, imageService }) {
    this.llmProvider = llmProvider;
    this.db = db;
    this.timeService = timeService;
    this.characterManager = characterManager;
    this.provider = provider;
    this.imageService = imageService || null;

    /** @type {Map<string, { socket: object, userId: string, characterId: string }>} */
    this._connections = new Map();

    // 定时主动消息相关
    this._lastProactiveSent = new Map();    // "userId_characterId" → timestamp
    this._lastUserActivity = new Map();     // "userId_characterId" → timestamp
    this._proactiveTimer = null;

    // 主动事件池（回归消息模板）
    this._eventTemplates = [
      '刚才路过一家店，里面在放{hobby}相关的音乐，突然想到你了。',
      '你不在的时候我{activity}了，还挺有意思的。',
      '好久没说话了...你最近还好吗？',
      '我发现了一个{hobby}相关的新东西，想跟你分享。',
      '外面{weather}，你记得带伞/穿暖和点。',
    ];
  }

  /**
   * 注册 Socket.io 事件
   */
  registerSocketIO(io) {
    io.on('connection', (socket) => {
      socket.on('register', async ({ userId, characterId }) => {
        if (!userId || !characterId) return;

        this._connections.set(socket.id, { socket, userId, characterId });
        this.db.ensureUser(userId);

        // 检查是否需要推送回归消息
        await this._checkAndPushProactive(socket, userId, characterId);
      });

      socket.on('disconnect', () => {
        this._connections.delete(socket.id);
      });
    });
  }

  // ==================== 回归消息（用户重连时） ====================

  /**
   * 检查离线时长并推送回归消息
   */
  async _checkAndPushProactive(socket, userId, characterId) {
    try {
      const key = `${userId}_${characterId}`;

      // 防重复：同一对 10 分钟内只推一次回归消息
      const lastSent = this._lastProactiveSent.get(key) || 0;
      if (Date.now() - lastSent < 10 * 60 * 1000) return;

      const state = this.db.getCharacterState(userId, characterId);
      if (!state) return;

      const hoursAway = (Date.now() - new Date(state.last_seen_at).getTime()) / (1000 * 60 * 60);

      // 条件：离线 > 12 小时 且 好感度 > 60
      if (hoursAway < 12 || state.affection < 60) return;

      // 冷战中不推送
      if (state.cold_war_until && new Date(state.cold_war_until) > new Date()) return;

      const character = this.characterManager.getCharacter(characterId);
      if (!character) return;

      const message = await this._generateProactiveMessage({ character, state, hoursAway });

      if (message) {
        socket.emit('proactive', {
          characterId,
          characterName: character.nickname || character.name,
          message,
          hoursAway: Math.round(hoursAway),
        });
        this._lastProactiveSent.set(key, Date.now());
      }
    } catch (err) {
      console.warn('[ProactiveService] 推送失败:', err.message);
    }
  }

  /**
   * 生成回归消息
   */
  async _generateProactiveMessage({ character, state, hoursAway }) {
    const name = character.nickname || character.name;
    const systemPrompt = `你是「${name}」，${character.base_personality}。
对方已经 ${Math.round(hoursAway)} 小时没有出现了。你们的好感度是 ${Math.round(state.affection)}/100。
请生成一条简短的主动消息（1-2句话），表达你对对方回来的反应。
语气要符合你的性格，不要太刻意。直接输出消息内容，不要加引号。`;

    try {
      return await this.llmProvider.chat(this.provider, {
        systemPrompt,
        messages: [{ role: 'user', content: '对方上线了，你想对 ta 说什么？' }],
        temperature: 0.9,
      });
    } catch {
      return null;
    }
  }

  // ==================== 定时主动消息（基于活动） ====================

  /**
   * 启动定时主动消息检查（每30分钟）
   */
  startProactiveTimer() {
    console.log('[ProactiveService] 定时主动消息已启动（间隔30分钟）');
    this._checkAllConnections();
    this._proactiveTimer = setInterval(() => this._checkAllConnections(), 30 * 60 * 1000);
  }

  /**
   * 停止定时器
   */
  stopProactiveTimer() {
    if (this._proactiveTimer) {
      clearInterval(this._proactiveTimer);
      this._proactiveTimer = null;
    }
  }

  /**
   * 记录用户活跃（每次用户发消息时调用）
   */
  recordUserActivity(userId, characterId) {
    this._lastUserActivity.set(`${userId}_${characterId}`, Date.now());
  }

  /**
   * 遍历所有连接，检查是否需要推送基于活动的主动消息
   */
  async _checkAllConnections() {
    const now = Date.now();
    const hour = new Date().getHours();

    // 只在 7:00-23:00 推送（不打扰睡眠）
    if (hour < 7 || hour >= 23) return;

    // 去重：同一用户-角色对只检查一次（防止多标签页/多设备重复推送）
    const checked = new Set();

    for (const [socketId, conn] of this._connections) {
      try {
        const key = `${conn.userId}_${conn.characterId}`;
        if (checked.has(key)) continue;
        checked.add(key);
        await this._checkTimeBasedProactive(conn, now);
      } catch (err) {
        console.warn('[ProactiveService] 定时推送失败:', err.message);
      }
    }
  }

  /**
   * 检查单个连接是否需要推送
   */
  async _checkTimeBasedProactive(conn, now) {
    const { socket, userId, characterId } = conn;
    const key = `${userId}_${characterId}`;

    // 空闲检测：用户最近10分钟有活跃则跳过
    const lastActivity = this._lastUserActivity.get(key) || 0;
    if (now - lastActivity < 10 * 60 * 1000) return;

    // 频率限制：同一用户-角色对2小时内只推一次
    const lastSent = this._lastProactiveSent.get(key) || 0;
    if (now - lastSent < 2 * 60 * 60 * 1000) return;

    // 获取角色状态
    const state = this.db.getCharacterState(userId, characterId);
    if (!state) return;

    // 冷战中不推送
    if (state.cold_war_until && new Date(state.cold_war_until) > new Date()) return;

    // 好感度 >= 30 才推送
    if (state.affection < 30) return;

    const character = this.characterManager.getCharacter(characterId);
    if (!character) return;

    // 获取当前活动（优先从 DB 读，缓存未命中则调 TimeService）
    let activity = state.current_activity;
    if (!activity) {
      activity = await this.timeService.getCurrentActivity(character);
      if (activity) {
        this.db.updateCurrentActivity(userId, characterId, activity);
      }
    }
    if (!activity) return;

    const timeDescription = this.timeService.getCurrentTimeDescription();

    // 生成并推送消息
    const message = await this._generateTimeBasedProactiveMessage({
      character, state, activity, timeDescription,
    });

    if (message) {
      socket.emit('proactive', {
        characterId,
        characterName: character.nickname || character.name,
        message,
      });
      this._lastProactiveSent.set(key, now);
      console.log(`[ProactiveService] 已推送主动消息 (${character.nickname || character.name}): ${message.slice(0, 40)}...`);

      // 好感度 > 80 时 5% 概率主动发图
      if (this.imageService && state.affection > 80 && Math.random() < 0.05) {
        this._tryProactivePhoto(socket, userId, characterId, character);
      }
    }
  }

  /**
   * 基于当前活动生成主动消息
   */
  async _generateTimeBasedProactiveMessage({ character, state, activity, timeDescription }) {
    const name = character.nickname || character.name;
    const systemPrompt = `你是「${name}」，${character.base_personality}。
现在是${timeDescription}，你正在${activity}。
你们的好感度是 ${Math.round(state.affection)}/100。

请生成一条简短的消息（1-2句话），像是你正在做这件事的时候突然想到了对方，想跟 ta 说点什么。
语气要符合你的性格，要自然，不要太刻意。直接输出消息内容，不要加引号。`;

    try {
      return await this.llmProvider.chat(this.provider, {
        systemPrompt,
        messages: [{ role: 'user', content: '你在做这件事的时候想到了对方，想说什么？' }],
        temperature: 0.9,
      });
    } catch {
      return null;
    }
  }

  // ==================== 主动发图 ====================

  /**
   * 好感度 > 80 时，有概率主动发一张自拍给用户
   */
  async _tryProactivePhoto(socket, userId, characterId, character) {
    try {
      const photoType = Math.random() < 0.7 ? 'selfie' : 'activity';
      const result = await this.imageService.handlePhotoRequest(userId, characterId, photoType);

      // 生成随口说的配文
      const name = character.nickname || character.name;
      const captions = [
        `给你看看~`,
        `刚拍的，觉得不错就发你了`,
        `你在干嘛？给你看看我现在在做什么`,
        `随手拍的，别嫌弃哈`,
      ];
      const caption = captions[Math.floor(Math.random() * captions.length)];

      socket.emit('proactive_photo', {
        characterId,
        characterName: name,
        filename: result.filename,
        caption,
      });
      // 持久化到聊天记录
      this.db.saveChatMessage({
        userId, characterId,
        role: 'photo',
        content: JSON.stringify({ f: result.filename, c: caption, t: photoType }),
      });
      console.log(`[ProactiveService] 主动发图 (${name}): ${result.filename}`);
    } catch (err) {
      console.warn('[ProactiveService] 主动发图失败:', err.message);
    }
  }

  // ==================== 通用推送 ====================

  /**
   * 向指定用户推送系统通知（可用于冷战结束通知等）
   */
  pushNotification(userId, characterId, event, data) {
    for (const conn of this._connections.values()) {
      if (conn.userId === userId && conn.characterId === characterId) {
        conn.socket.emit(event, data);
      }
    }
  }
}
