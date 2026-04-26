/**
 * VoiceCallService - 实时语音通话服务
 *
 * 使用阿里云 DashScope Qwen-Omni-Realtime (qwen3.5-omni-plus-realtime)
 * 在单个 WebSocket 连接中集成 ASR + LLM + TTS
 *
 * 架构：浏览器 ←Socket.IO→ Node.js 后端 ←WebSocket→ DashScope
 */
import WebSocket from 'ws';

const DASHSCOPE_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-omni-flash-realtime';

// 角色 → 音色 + 语气指令（语音通话用 qwen3-omni-flash-realtime，音色与 TTS 一致）
const CHARACTER_VOICE_CONFIG = {
  reina_001: {
    voice: 'Cherry',
    instructions: '你是傲娇女生，说话带小脾气，偶尔毒舌但内心柔软。语速偏快，语调有起伏，带点小傲娇的尾音。开心时语调上扬，不高兴时说话变短变冷。',
  },
  miku_002: {
    voice: 'Chelsie',
    instructions: '你是活泼可爱的元气少女，说话充满活力，语速较快，语调上扬，经常带撒娇语气。开心时声音更甜更活泼，不高兴时声音变小嘟囔。',
  },
  yuki_003: {
    voice: 'Maia',
    instructions: '你是成熟知性的御姐，说话沉稳有磁性，语速适中，语调温柔但有力。偶尔带慵懒感。开心时语气更柔和，生气时语调压低变冷。',
  },
  lin_004: {
    voice: 'Serena',
    instructions: '你是温柔体贴的邻家姐姐，说话轻柔细腻，语速偏慢，语调温暖甜美。开心时声音更柔更甜，委屈时带点哽咽。',
  },
};

// 通话附加系统提示
const CALL_SYSTEM_APPENDIX = `

[语音通话模式 - 极其重要]
你现在正在通过语音和用户实时通话，你说的每一个字都会被直接朗读出来。
- 绝对禁止输出 <thought> 或 <reply> 标签！绝对禁止输出任何内心独白！
- 直接开口说话，像真人打电话一样自然，不要加任何标签
- 回复控制在2-3句话，保持对话节奏
- 不要用 markdown 格式、不要用表情符号
- 如果用户沉默，可以主动找话题`;

export class VoiceCallService {
  /**
   * @param {{ apiKey: string, multimodalService: object, characterManager: object, chatService: object, db: object, emotionEngine: object, promptBuilder: object, growthService: object, timeService: object, environmentService: object, memoryService: object, lifecycleService: object }} config
   */
  constructor({ apiKey, multimodalService, characterManager, chatService, db, emotionEngine, promptBuilder, growthService, timeService, environmentService, memoryService, lifecycleService, factExtractor }) {
    this._apiKey = apiKey;
    this._multimodalService = multimodalService;
    this._characterManager = characterManager;
    this._chatService = chatService;
    this._db = db;
    this._emotionEngine = emotionEngine;
    this._promptBuilder = promptBuilder;
    this._growthService = growthService;
    this._timeService = timeService;
    this._environmentService = environmentService;
    this._memoryService = memoryService;
    this._lifecycleService = lifecycleService;
    this._factExtractor = factExtractor;

    // socketId → { ws, userId, characterId, state, ... }
    this._calls = new Map();
  }

  /**
   * 开始通话
   * @param {string} socketId
   * @param {{ userId: string, characterId: string }} params
   * @returns {{ success: boolean, error?: string }}
   */
  startCall(socketId, { userId, characterId }) {
    // 防止重复通话
    if (this._calls.has(socketId)) {
      return { success: false, error: '已有进行中的通话' };
    }

    const character = this._characterManager.getCharacter(characterId);
    if (!character) {
      return { success: false, error: `角色 ${characterId} 不存在` };
    }

    const voiceConfig = CHARACTER_VOICE_CONFIG[characterId] || CHARACTER_VOICE_CONFIG.reina_001;

    // 构建系统提示词
    const systemPrompt = this._buildSystemPrompt({ userId, characterId, character, voiceConfig });

    // 建立 DashScope WebSocket 连接
    const ws = new WebSocket(DASHSCOPE_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
      },
    });

    const callState = {
      ws,
      userId,
      characterId,
      character,
      voiceConfig,
      systemPrompt,
      startTime: Date.now(),
      currentUserTranscript: '',   // 当前用户语音转文字
      currentAiTranscript: '',     // 当前 AI 回复文本
      chatCount: 0,               // 通话中的对话轮数
      aiSpeaking: false,           // AI 正在说话（用于回声抑制）
      socket: null,                // Socket.IO socket 引用（外部设置）
    };

    this._calls.set(socketId, callState);

    ws.on('open', () => {
      console.log(`[VoiceCall] DashScope 连接已建立 (socketId: ${socketId}, 角色: ${character.full_name || character.nickname})`);
      // 发送 session.update 配置
      ws.send(JSON.stringify({
        event_id: `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: voiceConfig.voice,
          instructions: systemPrompt,
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          input_audio_transcription: { model: 'gummy-realtime-v1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: 800,
          },
        },
      }));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        this._handleDashScopeEvent(socketId, event);
      } catch (err) {
        console.error(`[VoiceCall] 解析 DashScope 事件失败:`, err.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[VoiceCall] DashScope 连接关闭 (code: ${code}, reason: ${reason || '无'})`);
      this._cleanupCall(socketId);
    });

    ws.on('error', (err) => {
      console.error(`[VoiceCall] DashScope WebSocket 错误:`, err.message);
      if (callState.socket) {
        callState.socket.emit('voice_call:error', { error: err.message });
      }
    });

    return { success: true };
  }

  /**
   * 停止通话
   */
  stopCall(socketId) {
    const call = this._calls.get(socketId);
    if (!call) return;

    if (call.ws && call.ws.readyState === WebSocket.OPEN) {
      call.ws.close(1000, '用户挂断');
    }

    this._cleanupCall(socketId);
  }

  /**
   * 设置 Socket.IO socket 引用
   */
  setSocket(socketId, socket) {
    const call = this._calls.get(socketId);
    if (call) {
      call.socket = socket;
    }
  }

  /**
   * 发送音频到 DashScope
   */
  sendAudio(socketId, base64Chunk) {
    const call = this._calls.get(socketId);
    if (!call || !call.ws || call.ws.readyState !== WebSocket.OPEN) return;
    // 回声抑制：AI 说话时不发送麦克风音频，防止扬声器声音被麦克风拾取后触发新回复
    if (call.aiSpeaking) return;

    call.ws.send(JSON.stringify({
      event_id: `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'input_audio_buffer.append',
      audio: base64Chunk,
    }));
  }

  /**
   * 查询是否在通话中
   */
  isInCall(socketId) {
    return this._calls.has(socketId);
  }

  /**
   * 构建 DashScope 系统提示词
   */
  _buildSystemPrompt({ userId, characterId, character, voiceConfig }) {
    // 复用 DynamicPromptBuilder 构建与文字聊天相同的系统提示词
    this._db.ensureUser(userId);
    const state = this._db.ensureCharacterState(userId, characterId);
    const userProfile = this._db.getUserProfile(userId);
    const userFacts = this._db.getUserFacts(userId, characterId);
    const recentSummary = this._db.getRecentSummary(userId, characterId, 5);
    const personalityStage = this._growthService.getPersonalityStage(state.affection);
    const { mood, description: moodDescription } = this._emotionEngine.mapMood(state.affection);
    const mirrorWords = JSON.parse(state.mirror_words || '[]');
    const currentTimeDescription = this._timeService.getCurrentTimeDescription();
    const lifeStagePrompt = this._lifecycleService.getLifeStagePrompt(state.interaction_days || 1);

    let environmentPrompt = null;
    try {
      const environment = this._environmentService.getEnvironmentSync
        ? this._environmentService.getEnvironmentSync({ location: userProfile?.location || '' })
        : null;
      environmentPrompt = environment?.environmentPrompt || null;
    } catch { /* ok */ }

    let systemPrompt = this._promptBuilder.build({
      character,
      state,
      userName: userProfile?.name || '',
      moodDescription,
      recentSummary,
      userFacts,
      personalityStage,
      mirrorWords,
      environmentPrompt,
      emotionState: state.emotion_state || 'calm',
      triggeredMinefield: null,
      currentTimeDescription,
      lifeStagePrompt,
    });

    // 语音通话模式：移除 [内心独白] 段落（含 thought/reply 格式指令），
    // 防止模型把内心独白也朗读出来
    systemPrompt = systemPrompt.replace(/\[内心独白\][\s\S]*?(?=\n\[|$)/, '');

    // 附加语音通话特有指令
    return systemPrompt + CALL_SYSTEM_APPENDIX;
  }

  /**
   * 处理 DashScope WebSocket 事件
   */
  _handleDashScopeEvent(socketId, event) {
    const call = this._calls.get(socketId);
    if (!call || !call.socket) return;

    const socket = call.socket;
    const type = event.type;

    // 调试日志：记录所有 DashScope 事件类型
    if (type !== 'response.audio.delta' && type !== 'response.audio_transcript.delta') {
      console.log(`[VoiceCall] DashScope 事件: ${type}`, type === 'error' ? event : '');
    }

    switch (type) {
      case 'session.created':
        console.log(`[VoiceCall] 会话已创建 (sessionId: ${event.session?.id})`);
        socket.emit('voice_call:session_created', { sessionId: event.session?.id });
        break;

      case 'session.updated':
        console.log(`[VoiceCall] 会话配置已生效`);
        break;

      case 'response.audio.delta':
        // AI 音频流片段 → 转发给前端
        if (event.delta) {
          call.aiSpeaking = true;
          socket.emit('voice_call:audio', event.delta);
        }
        break;

      case 'response.audio.done':
        // AI 一段音频结束，延迟解除回声抑制（给扬声器余音时间消散）
        setTimeout(() => { call.aiSpeaking = false; }, 500);
        break;

      case 'response.audio_transcript.delta':
        // AI 文本实时字幕
        if (event.delta) {
          call.currentAiTranscript += event.delta;
          socket.emit('voice_call:ai_transcript_delta', event.delta);
        }
        break;

      case 'response.audio_transcript.done':
        // AI 完整回复文本 → 保存聊天记录并通知前端
        {
          const aiText = call.currentAiTranscript.trim();
          if (aiText) {
            console.log(`[VoiceCall] AI 回复文本: ${aiText}`);
            this._saveCallMessage(call, 'assistant', aiText);
            socket.emit('voice_call:ai_transcript_done', aiText);
          }
          call.currentAiTranscript = '';
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // 用户语音转文字
        {
          const userText = event.transcript?.trim();
          if (userText) {
            console.log(`[VoiceCall] 用户语音: ${userText}`);
            call.currentUserTranscript = userText;
            socket.emit('voice_call:user_transcript', userText);
            this._saveCallMessage(call, 'user', userText);
          }
        }
        break;

      case 'error':
        console.error(`[VoiceCall] DashScope 错误:`, event.error?.message || event);
        socket.emit('voice_call:error', { error: event.error?.message || '未知错误' });
        break;

      default:
        // 忽略其他事件
        break;
    }
  }

  /**
   * 保存通话中的聊天记录（简化版后处理）
   */
  _saveCallMessage(call, role, content) {
    const { userId, characterId } = call;

    // 保存消息
    this._db.saveChatMessage({ userId, characterId, role, content, affectionAfter: 0 });

    // 更新互动天数和对话次数
    this._db.incrementChatCount(userId, characterId);
    this._db.updateLastSeenAt(userId, characterId);

    // 简单情感分析 + 好感度更新
    if (role === 'user') {
      try {
        const { weight } = this._emotionEngine.analyze(content);
        const state = this._db.getCharacterState(userId, characterId);
        const { newAffection } = this._emotionEngine.updateAffection(state.affection, weight);
        const finalAffection = Math.min(100, Math.round(newAffection * 10) / 10);
        this._db.updateAffection(userId, characterId, finalAffection);
        this._db.saveChatMessage({ userId, characterId, role: 'user', content, emotionWeight: weight, affectionAfter: finalAffection });

        // 更新经验值
        const growth = this._growthService.processGrowth({ state, emotionWeight: weight, userMessage: content });
        this._db.addExperience(userId, characterId, growth.xpGained);
        if (growth.leveledUp) this._db.updateLevel(userId, characterId, growth.newLevel);
      } catch { /* ok */ }
    }

    // 异步后置任务（记忆存储 + 事实提取）
    if (role === 'assistant' && call.currentUserTranscript) {
      const userMessage = call.currentUserTranscript;
      const aiResponse = content;
      this._postCallAsync(call, userMessage, aiResponse);
    }

    call.chatCount++;
  }

  /**
   * 通话后的异步任务（记忆存储、事实提取）
   */
  _postCallAsync(call, userMessage, aiResponse) {
    const { userId, characterId } = call;

    Promise.resolve().then(async () => {
      // 1. 记忆存储
      try {
        await this._memoryService.storeMemory({
          userId, characterId, userMessage, aiResponse,
          summary: `${userMessage.slice(0, 40)} → ${aiResponse.slice(0, 60)}`,
          emotionLabel: 'voice_call',
        });
      } catch { /* ok */ }

      // 2. 事实提取（与文字聊天一致）
      try {
        await this._factExtractor.extractAsync({ userId, characterId, userMessage, aiResponse });
      } catch { /* ok */ }

      // 3. 动态知识提取：每 10 次对话提取一次
      try {
        const state = this._db.getCharacterState(userId, characterId);
        if (state && state.chat_count > 0 && state.chat_count % 10 === 0) {
          await this._chatService._extractDynamicKnowledge({ userId, characterId, userMessage, aiResponse });
        }
      } catch { /* ok */ }
    });
  }

  /**
   * 清理通话资源
   */
  _cleanupCall(socketId) {
    const call = this._calls.get(socketId);
    if (!call) return;

    if (call.socket) {
      call.socket.emit('voice_call:ended', { duration: Math.round((Date.now() - call.startTime) / 1000) });
    }

    console.log(`[VoiceCall] 通话结束 (角色: ${call.character?.full_name || call.character?.nickname}, 轮数: ${call.chatCount}, 时长: ${Math.round((Date.now() - call.startTime) / 1000)}s)`);
    this._calls.delete(socketId);
  }
}
