import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import selfsigned from 'selfsigned';
import os from 'os';
import { Server as SocketIOServer } from 'socket.io';

import { DatabaseManager } from './database/DatabaseManager.js';
import { LLMProvider, registerProvidersFromEnv } from './services/LLMProvider.js';
import { EmotionEngine } from './services/EmotionEngine.js';
import { MemoryService } from './services/MemoryService.js';
import { FactExtractor } from './services/FactExtractor.js';
import { TimeService } from './services/TimeService.js';
import { GrowthService } from './services/GrowthService.js';
import { EmotionStateMachine } from './services/EmotionStateMachine.js';
import { EnvironmentService } from './services/EnvironmentService.js';
import { ProactiveService } from './services/ProactiveService.js';
import { MultimodalService } from './services/MultimodalService.js';
import { VoiceCallService } from './services/VoiceCallService.js';
import { ImageService } from './services/ImageService.js';
import { DiaryService } from './services/DiaryService.js';
import { LifecycleService } from './services/LifecycleService.js';
import { SecurityService } from './services/SecurityService.js';
import { CharacterManager } from './core/CharacterManager.js';
import { DynamicPromptBuilder } from './core/DynamicPromptBuilder.js';
import { ChatService } from './core/ChatService.js';
import { SettingsManager } from './services/SettingsManager.js';
import { DailyPlanner } from './services/DailyPlanner.js';
import { PlanExtractor } from './services/PlanExtractor.js';

// ==================== 初始化 ====================

const db = new DatabaseManager();
const settingsManager = new SettingsManager();
const settings = settingsManager.getRaw();

const llmProvider = new LLMProvider();
if (settings.chat.apiKey && settings.chat.baseURL && settings.chat.model) {
  llmProvider.registerProvider('default', {
    apiKey: settings.chat.apiKey,
    baseURL: settings.chat.baseURL,
    model: settings.chat.model,
  });
}

if (llmProvider.getProviderNames().length === 0) {
  console.error('[FATAL] 未配置对话 API，请在设置页面配置 URL + API Key + Model');
  process.exit(1);
}

const defaultProvider = 'default';

const characterManager = new CharacterManager();
const emotionEngine = new EmotionEngine();
const promptBuilder = new DynamicPromptBuilder();
const memoryService = new MemoryService();
const factExtractor = new FactExtractor({ llmProvider, db, provider: defaultProvider });
const timeService = new TimeService(llmProvider, defaultProvider);
const growthService = new GrowthService();
const emotionStateMachine = new EmotionStateMachine();
const environmentService = new EnvironmentService();
const multimodalService = new MultimodalService({ apiKey: settings.tts.apiKey });

const diaryService = new DiaryService({ llmProvider, db, characterManager, provider: defaultProvider });
const lifecycleService = new LifecycleService();
const securityService = new SecurityService();

const dailyPlanner = new DailyPlanner({
  db, llmProvider, characterManager, timeService, environmentService,
  provider: defaultProvider,
});
timeService.dailyPlanner = dailyPlanner;

const planExtractor = new PlanExtractor({ llmProvider, db, provider: defaultProvider });

const proactiveService = new ProactiveService({
  llmProvider, db, timeService, characterManager,
  provider: defaultProvider,
});

const chatService = new ChatService({
  characterManager, emotionEngine, promptBuilder, llmProvider, db,
  memoryService, factExtractor, timeService, growthService,
  emotionStateMachine, environmentService, lifecycleService,
  defaultProvider, planExtractor,
});

const voiceCallService = new VoiceCallService({
  apiKey: settings.tts.apiKey,
  multimodalService,
  characterManager,
  chatService,
  db,
  emotionEngine,
  promptBuilder,
  growthService,
  timeService,
  environmentService,
  memoryService,
  lifecycleService,
  factExtractor,
});

const imageService = new ImageService({
  apiKey: settings.image.apiKey,
  db,
  characterManager,
  timeService,
  llmProvider,
  provider: defaultProvider,
});

proactiveService.imageService = imageService;
chatService.imageService = imageService;

// ==================== Express + Socket.IO ====================

const app = express();
const httpServer = createHttpServer(app);

// HTTPS server with auto-generated self-signed cert (required for mobile microphone access)
let httpsServer = null;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
try {
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'AI Mate Soul' }], { days: 365, keySize: 2048 });
  httpsServer = createHttpsServer({ key: cert.private, cert: cert.cert }, app);
  console.log('[HTTPS] 自签证书生成成功');
} catch (e) {
  console.log(`[HTTPS] 自签证书生成失败: ${e.message}`);
}

// Shared Socket.IO event handlers
function registerSocketEvents(ioInstance) {
  ioInstance.on('connection', (socket) => {
    socket.on('voice_call:start', ({ userId, characterId }) => {
      if (!userId || !characterId) { socket.emit('voice_call:error', { error: '缺少 userId 或 characterId' }); return; }
      if (!characterManager.hasCharacter(characterId)) { socket.emit('voice_call:error', { error: `角色 ${characterId} 不存在` }); return; }
      const result = voiceCallService.startCall(socket.id, { userId, characterId });
      if (result.success) { voiceCallService.setSocket(socket.id, socket); socket.emit('voice_call:started', { characterId }); console.log(`[VoiceCall] 通话开始 (socket: ${socket.id})`); }
      else { socket.emit('voice_call:error', { error: result.error }); }
    });
    socket.on('voice_call:audio', (base64Chunk) => { voiceCallService.sendAudio(socket.id, base64Chunk); });
    socket.on('voice_call:end', () => { voiceCallService.stopCall(socket.id); console.log(`[VoiceCall] 用户挂断 (socket: ${socket.id})`); });
    socket.on('disconnect', () => { if (voiceCallService.isInCall(socket.id)) { voiceCallService.stopCall(socket.id); console.log(`[VoiceCall] 连接断开 (socket: ${socket.id})`); } });
  });
}

const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
registerSocketEvents(io);
proactiveService.registerSocketIO(io);

if (httpsServer) {
  const httpsIo = new SocketIOServer(httpsServer, { cors: { origin: '*' } });
  registerSocketEvents(httpsIo);
  proactiveService.registerSocketIO(httpsIo);
}

proactiveService.registerSocketIO(io);
proactiveService.startProactiveTimer();

// ==================== 中间件 ====================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ==================== API Routes ====================

app.get('/api/characters', (_req, res) => {
  res.json({ characters: characterManager.listCharacters() });
});

app.post('/api/characters/reload', (_req, res) => {
  const count = characterManager.reload();
  res.json({ success: true, count });
});

app.get('/api/characters/:characterId', (req, res) => {
  const c = characterManager.getCharacterProfile(req.params.characterId);
  if (!c) return res.status(404).json({ error: '角色不存在' });
  res.json(c);
});

app.get('/api/characters/:characterId/reference', (req, res) => {
  const imgPath = characterManager.getReferenceImagePath(req.params.characterId);
  if (!imgPath) return res.status(404).json({ error: '角色立绘不存在' });
  res.sendFile(path.resolve(imgPath));
});

app.get('/api/state/:userId/:characterId', async (req, res) => {
  const { userId, characterId } = req.params;
  db.ensureUser(userId);
  const state = db.ensureCharacterState(userId, characterId);
  const character = characterManager.getCharacter(characterId);
  if (!character) return res.status(404).json({ error: '角色不存在' });

  const { mood, description } = emotionEngine.mapMood(state.affection);
  const personalityStage = growthService.getPersonalityStage(state.affection);
  const userFacts = db.getUserFacts(userId, characterId);

  let coldWarRemaining = 0;
  if (state.cold_war_until) {
    coldWarRemaining = emotionStateMachine.getColdWarRemainingMinutes(state.cold_war_until);
    if (coldWarRemaining <= 0) {
      db.updateEmotionState(userId, characterId, 'calm', 0, null);
    }
  }

  const lifeStage = lifecycleService.getLifeStage(state.interaction_days || 1);

  // 获取天气信息（用于前端展示）
  let weatherMood = null;
  try {
    const env = await environmentService.getEnvironment({ location: db.getUserProfile(userId)?.location || '' });
    weatherMood = env.weather?.mood || null;
  } catch { /* ok */ }

  res.json({
    userName: db.getUserProfile(userId)?.name || '',
    characterName: character.name,
    affection: state.affection,
    mood: coldWarRemaining > 0 ? 'cold_war' : mood,
    moodDescription: coldWarRemaining > 0 ? '冷战/拒绝沟通' : description,
    level: personalityStage?.label || '',
    experience: state.experience,
    chatCount: state.chat_count,
    interactionDays: state.interaction_days || 1,
    personalityStage: personalityStage?.label || null,
    lifeStage: lifeStage.stage,
    mirrorWords: JSON.parse(state.mirror_words || '[]'),
    facts: userFacts,
    emotionState: state.emotion_state || 'calm',
    emotionStateLabel: emotionStateMachine.getStateLabel(state.emotion_state || 'calm'),
    moodLevel: state.mood_level || 0,
    coldWarRemaining,
    weatherMood,
    // Busy state
    busyActivity: state.busy_activity || '',
    busyRemaining: (state.busy_until && new Date(state.busy_until) > new Date())
      ? Math.ceil((new Date(state.busy_until) - new Date()) / 60000) : 0,
    busyUntil: state.busy_until || '',
  });
});

app.post('/api/user/:userId/name', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '缺少 name 字段' });
  db.ensureUser(req.params.userId);
  db.updateUserName(req.params.userId, name);
  res.json({ success: true });
});

// --- Chat ---
app.post('/api/chat', async (req, res) => {
  const { userId, characterId, message, provider } = req.body;
  if (!userId || !characterId || !message) return res.status(400).json({ error: '缺少必要参数' });
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: `角色 ${characterId} 不存在` });
  if (provider && !llmProvider.hasProvider(provider)) return res.status(400).json({ error: `Provider "${provider}" 未注册` });

  // 记录用户活跃，避免主动消息打断正在进行的对话
  proactiveService.recordUserActivity(userId, characterId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    for await (const event of chatService.chatStream({ userId, characterId, message, provider })) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.write('event: end\ndata: {}\n\n');
  res.end();
});

// --- TTS ---
app.post('/api/tts', async (req, res) => {
  const { text, characterId } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text' });
  if (!characterId) return res.status(400).json({ error: '缺少 characterId' });

  try {
    // 从数据库获取当前情绪状态
    const uid = req.body.userId || 'test_user';
    const state = db.getCharacterState(uid, characterId);
    const emotionState = state?.emotion_state || 'calm';
    const audio = await multimodalService.synthesizeSpeech({ text, characterId, emotionState });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audio.length);
    res.send(audio);
  } catch (err) {
    res.status(500).json({ error: `TTS 失败: ${err.message}` });
  }
});

app.get('/api/voices', (_req, res) => {
  res.json({ voices: multimodalService.getVoicePresets() });
});

// --- Photo ---
app.post('/api/photo', async (req, res) => {
  const { userId, characterId, type } = req.body;
  if (!userId || !characterId) return res.status(400).json({ error: '缺少 userId 或 characterId' });
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: `角色 ${characterId} 不存在` });

  try {
    const result = await imageService.handlePhotoRequest(userId, characterId, type || 'selfie');
    res.json({ success: true, filename: result.filename, caption: result.caption });
  } catch (err) {
    res.status(500).json({ error: `图片生成失败: ${err.message}` });
  }
});

app.get('/api/photos/:userId/:characterId', (req, res) => {
  const { userId, characterId } = req.params;
  const photos = db.getPhotos(userId, characterId);
  res.json({ photos });
});

// --- Chat History ---
app.delete('/api/chat-history/:userId/:characterId', (req, res) => {
  const { userId, characterId } = req.params;
  db.clearChatHistory(userId, characterId);
  res.json({ success: true });
});

app.get('/api/chat-history/:userId/:characterId', (req, res) => {
  const { userId, characterId } = req.params;
  const messages = db.getFullChatHistory(userId, characterId, 50);
  // 获取每条 assistant 消息对应的内心独白
  const monologues = db.getRecentMonologues(userId, characterId, 50);
  const monologueMap = {};
  monologues.forEach(m => { monologueMap[m.user_message] = m.thought; });
  res.json({ messages, monologueMap });
});

// --- Diary ---
app.get('/api/diaries/:userId/:characterId', (req, res) => {
  const { userId, characterId } = req.params;
  const state = db.getCharacterState(userId, characterId);
  const diaries = diaryService.getDiariesForUser(userId, characterId, state?.affection || 0);
  res.json({ diaries });
});

app.post('/api/diaries/generate/:userId/:characterId', async (req, res) => {
  const { userId, characterId } = req.params;
  const result = await diaryService.generateDailyDiary({ userId, characterId });
  res.json(result);
});

// --- Anniversaries ---
app.get('/api/anniversaries/:userId/:characterId', (req, res) => {
  const upcoming = lifecycleService.getUpcomingAnniversaries(db, req.params.userId, req.params.characterId);
  const all = db.getAnniversaries(req.params.userId, req.params.characterId);
  res.json({ upcoming, all });
});

app.post('/api/anniversaries/:userId/:characterId', (req, res) => {
  const { type, date, description } = req.body;
  if (!type || !date) return res.status(400).json({ error: '缺少 type 或 date' });
  lifecycleService.saveAnniversary(db, { userId: req.params.userId, characterId: req.params.characterId, type, date, description });
  res.json({ success: true });
});

// --- Export / Import ---
app.get('/api/export/:userId/:characterId', async (req, res) => {
  const { userId, characterId } = req.params;
  const character = characterManager.getCharacter(characterId);
  if (!character) return res.status(404).json({ error: '角色不存在' });

  const exportKey = SecurityService.generateKey();

  try {
    // 提取该用户-角色对的全部数据
    const userProfile = db.getUserProfile(userId);
    const characterState = db.getCharacterState(userId, characterId);
    const memoryFileBuffer = memoryService.getMemoryFileBuffer(userId, characterId);

    const exportData = {
      user_profile: userProfile,
      characters_state: characterState,
      chat_history: db.exportAllChatHistory(userId, characterId),
      user_facts: db.exportAllUserFacts(userId, characterId),
      diaries: db.exportAllDiaries(userId, characterId),
      anniversaries: db.exportAllAnniversaries(userId, characterId),
      inner_monologue: db.exportAllMonologues(userId, characterId),
    };

    const zip = await securityService.exportSoul({
      userId, characterId,
      characterName: character.name,
      exportKey, data: exportData, memoryFileBuffer,
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(character.name)}_${userId}.soul"`);
    res.setHeader('X-Export-Key', exportKey);
    res.send(zip);
  } catch (err) {
    res.status(500).json({ error: `导出失败: ${err.message}` });
  }
});

app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传 .soul 备份文件' });
  }

  const importKey = req.body.importKey || '';
  if (!importKey) {
    return res.status(400).json({ error: '请输入导入密钥' });
  }

  try {
    // 1. 解压 ZIP + 解密元信息
    const result = await securityService.importSoul({
      zipBuffer: req.file.buffer,
      importKey,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error || '导入失败' });
    }

    const meta = result.meta;
    const userId = meta?.userId;
    const characterId = meta?.characterId;

    if (!userId || !characterId) {
      return res.status(400).json({
        success: false,
        error: '无法确定导入目标: 备份元信息缺少 userId 或 characterId',
      });
    }

    // 2. 用事务合并数据到数据库
    const { data, memoryFile } = result;
    const importTx = db.db.transaction(() => {
      if (data.user_profile) db.importUserProfile(data.user_profile, userId);
      if (data.characters_state) db.importCharacterState(data.characters_state, userId, characterId);
      if (Array.isArray(data.chat_history) && data.chat_history.length > 0) {
        db.importChatHistory(data.chat_history, userId, characterId);
      }
      if (Array.isArray(data.user_facts) && data.user_facts.length > 0) {
        db.importUserFacts(data.user_facts, userId, characterId);
      }
      if (Array.isArray(data.diaries) && data.diaries.length > 0) {
        db.importDiaries(data.diaries, userId, characterId);
      }
      if (Array.isArray(data.anniversaries) && data.anniversaries.length > 0) {
        db.importAnniversaries(data.anniversaries, userId, characterId);
      }
      if (Array.isArray(data.inner_monologue) && data.inner_monologue.length > 0) {
        db.importMonologues(data.inner_monologue, userId, characterId);
      }
    });
    importTx();

    // 去重聊天记录
    if (Array.isArray(data.chat_history) && data.chat_history.length > 0) {
      db.deduplicateChatHistory(userId, characterId);
    }

    // 3. 恢复记忆文件
    if (memoryFile) {
      await memoryService.importMemoryFile(userId, characterId, memoryFile.buffer);
    }

    // 4. 汇总
    const restored = Object.keys(data).filter(k => {
      const v = data[k];
      return (Array.isArray(v) && v.length > 0) || (v && !Array.isArray(v));
    });
    if (memoryFile) restored.push(memoryFile.filename);

    res.json({
      success: true,
      message: `导入成功，已恢复 ${restored.length} 项数据`,
      meta: result.meta,
      files: restored,
    });
  } catch (err) {
    res.status(500).json({ error: `导入失败: ${err.message}` });
  }
});

app.get('/api/providers', (_req, res) => {
  res.json({ providers: llmProvider.getProviderNames() });
});

// ==================== Settings API ====================

app.get('/api/settings', (_req, res) => {
  res.json(settingsManager.getMasked());
});

app.put('/api/settings', (req, res) => {
  const newSettings = req.body;
  if (!newSettings || typeof newSettings !== 'object') {
    return res.status(400).json({ error: 'Invalid settings' });
  }

  const updated = settingsManager.update(newSettings);
  const raw = settingsManager.getRaw();

  // Reload LLM provider
  llmProvider._providers.clear();
  if (raw.chat.apiKey && raw.chat.baseURL && raw.chat.model) {
    llmProvider.registerProvider('default', { apiKey: raw.chat.apiKey, baseURL: raw.chat.baseURL, model: raw.chat.model });
  }

  // Reload service API keys
  if (raw.image.apiKey) imageService._apiKey = raw.image.apiKey;
  if (raw.tts.apiKey) {
    multimodalService._apiKey = raw.tts.apiKey;
    voiceCallService._apiKey = raw.tts.apiKey;
  }

  console.log(`[Settings] 配置已更新: chat=${raw.chat.baseURL} model=${raw.chat.model}`);
  res.json({ success: true, settings: updated });
});

// ==================== 定时任务 ====================

// 每天凌晨 1:30 生成日程，2:00 生成日记
const SCHEDULE_CRON_HOUR = 1;
const SCHEDULE_CRON_MINUTE = 30;
const DIARY_CRON_HOUR = 2;
const DIARY_CRON_MINUTE = 0;

function scheduleOvernightTasks() {
  const now = new Date();

  // 日程生成：1:30
  const nextSchedule = new Date(now);
  nextSchedule.setHours(SCHEDULE_CRON_HOUR, SCHEDULE_CRON_MINUTE, 0, 0);
  if (nextSchedule <= now) nextSchedule.setDate(nextSchedule.getDate() + 1);

  const scheduleDelay = nextSchedule - now;
  console.log(`[DailyPlanner] 下次日程生成: ${nextSchedule.toLocaleString('zh-CN')} (${Math.round(scheduleDelay / 60000)}min 后)`);

  setTimeout(async () => {
    await dailyPlanner.generateForAllActivePairs();
  }, scheduleDelay);

  // 日记生成：2:00
  const nextDiary = new Date(now);
  nextDiary.setHours(DIARY_CRON_HOUR, DIARY_CRON_MINUTE, 0, 0);
  if (nextDiary <= now) nextDiary.setDate(nextDiary.getDate() + 1);

  const diaryDelay = nextDiary - now;
  console.log(`[DiaryService] 下次日记生成: ${nextDiary.toLocaleString('zh-CN')} (${Math.round(diaryDelay / 60000)}min 后)`);

  setTimeout(async () => {
    await diaryService.checkAndGenerateAll();
    // 递归调度下一天
    scheduleOvernightTasks();
  }, diaryDelay);
}

scheduleOvernightTasks();

// 启动时确保今天的日程存在
dailyPlanner.generateForAllActivePairs().catch(err =>
  console.warn(`[DailyPlanner] 启动时日程生成失败: ${err.message}`)
);

// 每 30 分钟处理一次情绪事件（烦躁值随日程事件变化）
setInterval(() => {
  dailyPlanner.processEventEmotions();
}, 30 * 60 * 1000);

// 启动时立即处理一次（防止重启后遗漏事件）
setTimeout(() => dailyPlanner.processEventEmotions(), 5000);

// ==================== 优雅退出 ====================

process.on('SIGINT', async () => {
  console.log('\n[Shutdown] 正在保存数据...');
  proactiveService.stopProactiveTimer();
  await memoryService.closeAll();
  db.close();
  process.exit(0);
});

// ==================== 启动 ====================

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  AI Mate Soul v4 - 终极沉浸版`);
  console.log(`  http://localhost:${PORT}`);
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
      console.log(`  https://localhost:${HTTPS_PORT}`);
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            console.log(`  手机访问: https://${net.address}:${HTTPS_PORT}`);
            break;
          }
        }
      }
    });
  } else {
    console.log(`  HTTPS: 未启用（手机麦克风需要 HTTPS）`);
  }
  console.log(`  LLM: ${llmProvider.getProviderNames().join(', ')}`);
  console.log(`  角色: ${characterManager.listCharacters().map(c => c.name).join(', ')}`);
  console.log(`  TTS: DashScope Qwen3-TTS${process.env.DASHSCOPE_API_KEY ? '' : ' (未配置API Key)'}`);
  console.log(`  Socket.IO: 已启用`);
  console.log(`  Voice Call: DashScope Qwen-Omni-Realtime${process.env.DASHSCOPE_API_KEY ? '' : ' (未配置API Key)'}`);
  console.log(`  Image Gen: Wanx 2.7 Image Pro${process.env.DASHSCOPE_API_KEY ? '' : ' (未配置API Key)'}`);
  console.log(`  日程规划: 每日 ${SCHEDULE_CRON_HOUR}:${String(SCHEDULE_CRON_MINUTE).padStart(2, '0')}`);
  console.log(`  日记定时: 每日 ${DIARY_CRON_HOUR}:${String(DIARY_CRON_MINUTE).padStart(2, '0')}`);
  console.log(`========================================\n`);
});
