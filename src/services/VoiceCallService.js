/**
 * VoiceCallService - 实时语音通话服务
 *
 * 使用火山豆包实时语音 3.0（Seeduplex，全双工端到端 S2S）
 * 在单个 WebSocket 连接中集成 ASR + LLM + TTS
 *
 * 架构：浏览器 ←Socket.IO→ Node.js 后端 ←WebSocket→ 火山 openspeech
 * 协议要点（官方接入必读）：
 * - 纯 JSON 文本帧，session.model 固定 1.2.6.1
 * - 输入 PCM 16k/int16 须按 20ms（640 字节）实时节奏转发，否则服务端报错
 * - 停止发送音频须发 input_audio_mute.commit，恢复发 input_audio_unmute.commit
 * - 挂断须先 session.close 并等确认，直接断开触发 ContextCanceled(55000001)
 */
import WebSocket from 'ws';
import { DEFAULT_SPEAKER } from './VoiceCatalog.js';

const VOLCANO_REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const VOLCANO_REALTIME_RESOURCE_ID = 'seeduplex_realtime_dialogue'; // 升级握手必须携带，缺失会被 403 拒绝
const SEEDUPLEX_MODEL = '1.2.6.1';
const PACER_INTERVAL_MS = 20;   // 协议要求的 20ms 转发节奏
const PACER_CHUNK_BYTES = 640;  // 16k/int16 下 20ms 对应字节数
const PACER_MAX_QUEUE = 48000;  // 队列积压上限（3 秒音频），超出丢最旧防延迟滚雪球

// 角色音色：读角色档案 voice_preset，缺省回退默认音色（与 TTS 通道同一来源）
function resolveSpeaker(characterManager, characterId) {
  const c = characterManager.getCharacter(characterId);
  return (c?.voice_preset && String(c.voice_preset).trim()) || DEFAULT_SPEAKER;
}

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

    const speaker = resolveSpeaker(this._characterManager, characterId);

    // 构建系统提示词
    const systemPrompt = this._buildSystemPrompt({ userId, characterId, character });

    // 建立火山 Seeduplex WebSocket 连接（X-Api-Key 鉴权同 TTS，另须带 X-Api-Resource-Id）
    const ws = new WebSocket(VOLCANO_REALTIME_URL, {
      headers: {
        'X-Api-Key': this._apiKey,
        'X-Api-Resource-Id': VOLCANO_REALTIME_RESOURCE_ID,
      },
    });

    const callState = {
      ws,
      userId,
      characterId,
      character,
      speaker,
      systemPrompt,
      startTime: Date.now(),
      currentUserTranscript: '',   // 当前用户语音转文字
      currentAiTranscript: '',     // 当前 AI 回复文本
      chatCount: 0,               // 通话中的对话轮数
      aiSpeaking: false,           // AI 正在说话（用于回声抑制）
      sessionReady: false,         // 已收到 session.created，之后才转发音频
      muted: false,                // 已向上游声明静音
      pacerQueue: [],              // 待按 20ms 节奏转发的音频缓冲
      pacerBytes: 0,               // 队列总字节数
      pacerTimer: null,            // 节奏转发定时器
      endEmitted: false,           // voice_call:ended 是否已发（防重复）
      socket: null,                // Socket.IO socket 引用（外部设置）
    };

    this._calls.set(socketId, callState);

    ws.on('open', () => {
      console.log(`[VoiceCall] 火山 Seeduplex 连接已建立 (socketId: ${socketId}, 角色: ${character.full_name || character.nickname}, 音色: ${speaker})`);
      ws.send(JSON.stringify({
        type: 'session.create',
        session: {
          model: SEEDUPLEX_MODEL,
          instructions: systemPrompt,
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm', rate: 24000 }, speed: 0, loudness: 0, voice: speaker },
          },
        },
        extension: { asr: {}, tts: {}, dialog: {} },
      }));
      // 启动 20ms 节奏转发器（协议强制要求）
      callState.pacerTimer = setInterval(() => this._pacerTick(socketId), PACER_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        this._handleVolcanoEvent(socketId, event);
      } catch (err) {
        console.error(`[VoiceCall] 解析火山事件失败:`, err.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[VoiceCall] 火山连接关闭 (code: ${code}, reason: ${reason || '无'})`);
      this._cleanupCall(socketId);
    });

    ws.on('error', (err) => {
      console.error(`[VoiceCall] 火山 WebSocket 错误:`, err.message);
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

    this._stopPacer(call);
    // 先通知前端并标记结束（防止 _cleanupCall 重复发送）
    if (call.socket && !call.endEmitted) {
      call.endEmitted = true;
      call.socket.emit('voice_call:ended', { duration: Math.round((Date.now() - call.startTime) / 1000) });
    }
    // 协议要求：先发 session.close 并等服务端确认，直接断开会触发 ContextCanceled
    if (call.ws && call.ws.readyState === WebSocket.OPEN) {
      try { call.ws.send(JSON.stringify({ type: 'session.close' })); } catch { /* ok */ }
    }
    // 最多等 2 秒让 session.closed 下行/关闭事件触发 _cleanupCall，超时强制断开
    setTimeout(() => {
      try { if (call.ws && call.ws.readyState === WebSocket.OPEN) call.ws.close(1000, '用户挂断'); } catch { /* ok */ }
      this._cleanupCall(socketId);
    }, 2000);
  }

  /** 停止 20ms 节奏转发器并清空队列 */
  _stopPacer(call) {
    if (call.pacerTimer) { clearInterval(call.pacerTimer); call.pacerTimer = null; }
    call.pacerQueue = [];
    call.pacerBytes = 0;
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
   * 发送音频到火山 Seeduplex
   */
  sendAudio(socketId, base64Chunk) {
    const call = this._calls.get(socketId);
    if (!call || !call.ws || call.ws.readyState !== WebSocket.OPEN) return;
    if (!call.sessionReady) return; // 会话建立前不转发

    if (call.aiSpeaking) {
      // 回声抑制：AI 说话时丢弃麦克风音频，但须向上游声明静音保持流存活
      this._setMute(call, true);
      return;
    }
    this._setMute(call, false);

    // 入队，由 20ms 定时器按协议节奏匀速转发（前端分包节奏不受控）
    const buf = Buffer.from(base64Chunk, 'base64');
    if (!buf.length) return;
    call.pacerQueue.push(buf);
    call.pacerBytes += buf.length;
    while (call.pacerBytes > PACER_MAX_QUEUE && call.pacerQueue.length > 1) {
      call.pacerBytes -= call.pacerQueue.shift().length;
    }
  }

  /** 每 20ms 取一帧（≤640 字节）按协议节奏转发 */
  _pacerTick(socketId) {
    const call = this._calls.get(socketId);
    if (!call || !call.ws || call.ws.readyState !== WebSocket.OPEN) return;
    if (call.muted) { call.pacerQueue = []; call.pacerBytes = 0; return; }
    if (call.pacerBytes === 0) return;
    const head = call.pacerQueue[0];
    const piece = head.subarray(0, Math.min(PACER_CHUNK_BYTES, head.length));
    call.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: piece.toString('base64') }));
    call.pacerBytes -= piece.length;
    const rest = head.subarray(piece.length);
    if (rest.length === 0) call.pacerQueue.shift();
    else call.pacerQueue[0] = rest;
  }

  /** 静音状态变化时向上游声明（协议要求：停发音频必须 mute.commit） */
  _setMute(call, mute) {
    if (mute === call.muted) return;
    call.muted = mute;
    if (call.ws && call.ws.readyState === WebSocket.OPEN) {
      try { call.ws.send(JSON.stringify({ type: mute ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' })); } catch { /* ok */ }
    }
  }

  /**
   * 查询是否在通话中
   */
  isInCall(socketId) {
    return this._calls.has(socketId);
  }

  /**
   * 构建火山 Seeduplex 系统提示词
   */
  _buildSystemPrompt({ userId, characterId, character }) {
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
   * 处理火山 Seeduplex WebSocket 事件
   */
  _handleVolcanoEvent(socketId, event) {
    const call = this._calls.get(socketId);
    if (!call || !call.socket) return;

    const socket = call.socket;
    const type = event.type;

    // 调试日志：高频事件不打印
    if (type !== 'response.output_audio.delta' && type !== 'conversation.item.input_audio_transcription.delta') {
      console.log(`[VoiceCall] 火山事件: ${type}`, type === 'error' ? JSON.stringify(event).slice(0, 300) : '');
    }

    switch (type) {
      case 'session.created':
        call.sessionReady = true;
        console.log(`[VoiceCall] 会话已创建 (sessionId: ${event.session?.id})`);
        socket.emit('voice_call:session_created', { sessionId: event.session?.id });
        break;

      case 'response.output_audio.delta':
        // AI 音频流片段（base64 PCM 24k）→ 转发给前端
        if (event.delta) {
          call.aiSpeaking = true;
          socket.emit('voice_call:audio', event.delta);
        }
        break;

      case 'response.output_audio.done':
        // AI 一段音频结束，延迟解除回声抑制（给扬声器余音时间消散）
        setTimeout(() => { call.aiSpeaking = false; }, 500);
        break;

      case 'response.output_text.delta':
        // AI 文本实时字幕
        if (event.delta) {
          call.currentAiTranscript += event.delta;
          socket.emit('voice_call:ai_transcript_delta', event.delta);
        }
        break;

      case 'response.output_text.done':
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

      case 'response.done':
        // 一轮结束的用量统计（仅日志）
        console.log(`[VoiceCall] 一轮结束 usage: ${JSON.stringify(event.usage || {}).slice(0, 200)}`);
        break;

      case 'error':
        console.error(`[VoiceCall] 火山错误:`, event.error?.message || event.message || JSON.stringify(event).slice(0, 200));
        socket.emit('voice_call:error', { error: event.error?.message || event.message || '未知错误' });
        break;

      default:
        // 忽略其他事件（session.updated / input_audio_buffer.committed / conversation.item.* 等）
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

    this._stopPacer(call);
    if (call.socket && !call.endEmitted) {
      call.endEmitted = true;
      call.socket.emit('voice_call:ended', { duration: Math.round((Date.now() - call.startTime) / 1000) });
    }

    console.log(`[VoiceCall] 通话结束 (角色: ${call.character?.full_name || call.character?.nickname}, 轮数: ${call.chatCount}, 时长: ${Math.round((Date.now() - call.startTime) / 1000)}s)`);
    this._calls.delete(socketId);
  }
}
