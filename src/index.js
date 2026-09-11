import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import selfsigned from 'selfsigned';
import os from 'os';
import crypto from 'crypto';
import { Server as SocketIOServer } from 'socket.io';

import { DatabaseManager } from './database/DatabaseManager.js';
import { LLMProvider } from './services/LLMProvider.js';
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
import { VOICE_CATALOG } from './services/VoiceCatalog.js';
import { ImageService } from './services/ImageService.js';
import { VideoService } from './services/VideoService.js';
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
  console.warn('[WARN] 对话 API 未配置，服务正常启动，请在 Web 设置页面配置 URL + API Key + Model');
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
const multimodalService = new MultimodalService({ apiKey: settings.tts.apiKey, resourceId: settings.tts.resourceId, characterManager });

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
  provider: defaultProvider, emotionStateMachine,
});

const chatService = new ChatService({
  characterManager, emotionEngine, promptBuilder, llmProvider, db,
  memoryService, factExtractor, timeService, growthService,
  emotionStateMachine, environmentService, lifecycleService,
  defaultProvider, planExtractor, multimodalService,
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
  baseURL: settings.image.baseURL,
  model: settings.image.model,
  db,
  characterManager,
  timeService,
  llmProvider,
  provider: defaultProvider,
});

proactiveService.imageService = imageService;
chatService.imageService = imageService;

const videoService = new VideoService({
  apiKey: settings.video.apiKey,
  baseURL: settings.video.baseURL,
  model: settings.video.model,
  maxDuration: settings.video.maxDuration,
  db,
  characterManager,
});

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
proactiveService.startReconcileTimer();

// ==================== 中间件 ====================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 角色头像上传：限 5MB（文件类型由路由内魔数校验，不信任扩展名）
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ==================== API Routes ====================

// Live2D 可用模型清单：扫描 public/live2d/models/ 下含 *.model3.json 的子目录（目录即清单，无配置文件）
app.get('/api/live2d/models', (_req, res) => {
  try {
    const dir = path.resolve(process.cwd(), 'public', 'live2d', 'models');
    const models = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      const m3 = fs.readdirSync(sub).find(f => f.endsWith('.model3.json'));
      if (m3) models.push({ id: entry.name, url: `/live2d/models/${entry.name}/${m3}` });
    }
    res.json({ models });
  } catch (e) {
    console.warn('[live2d] 模型清单扫描失败:', e.message);
    res.json({ models: [] });   // 目录缺失/异常返回空清单，前端走默认模型降级
  }
});

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

// 头像（仅展示用）：优先 avatar.*，未上传时回退参考图，避免界面空白
app.get('/api/characters/:characterId/avatar', (req, res) => {
  const imgPath = characterManager.getAvatarPath(req.params.characterId)
    || characterManager.getReferenceImagePath(req.params.characterId);
  if (!imgPath) return res.status(404).json({ error: '角色头像不存在' });
  res.sendFile(path.resolve(imgPath));
});

// ==================== 角色管理（写操作） ====================

// 新增角色（可复制现有）
app.post('/api/characters', (req, res) => {
  const { profile, copyFrom } = req.body || {};
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return res.status(400).json({ error: 'profile 必须为对象' });
  }
  try {
    const result = characterManager.createCharacter(profile, { copyFrom });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true, id: result.profile.id });
  } catch (err) {
    console.warn('[CharMgr] 创建角色失败:', err.message);
    res.status(500).json({ error: '创建失败: ' + err.message });
  }
});

// 保存编辑（patch 浅合并 / full 整份覆盖）
app.put('/api/characters/:characterId', (req, res) => {
  const { patch, full } = req.body || {};
  if (patch === undefined && full === undefined) {
    return res.status(400).json({ error: '缺少 patch 或 full' });
  }
  try {
    const result = characterManager.saveProfile(req.params.characterId, { patch, full });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    console.warn('[CharMgr] 保存失败:', err.message);
    res.status(500).json({ error: '保存失败: ' + err.message });
  }
});

// 魔数校验图片类型（不信任扩展名）：返回 'jpg' | 'png' | 'webp' | null
function detectImageExt(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// 角色图片上传（kind: avatar 头像 / reference 参考图）
const KIND_LABEL = { avatar: '头像', reference: '参考图' };
function handleCharacterImageUpload(kind) {
  return (req, res) => {
    const { characterId } = req.params;
    if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: '角色不存在' });
    if (!req.file) return res.status(400).json({ error: '未收到图片文件' });
    const ext = detectImageExt(req.file.buffer);
    if (!ext) return res.status(400).json({ error: '仅支持 jpg / png / webp 图片' });
    try {
      const result = kind === 'avatar'
        ? characterManager.saveAvatar(characterId, req.file.buffer, ext)
        : characterManager.saveReference(characterId, req.file.buffer, ext);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json({ success: true });
    } catch (err) {
      console.warn(`[CharMgr] ${kind} 保存失败:`, err.message);
      res.status(500).json({ error: `${KIND_LABEL[kind]}保存失败: ` + err.message });
    }
  };
}

// 头像上传（仅 UI 展示：首页/聊天页/编辑页，不参与生成）
app.post('/api/characters/:characterId/avatar', avatarUpload.single('avatar'), handleCharacterImageUpload('avatar'));
// 参考图上传（生成自拍图/视频时作为一致性参考引入）
app.post('/api/characters/:characterId/reference', avatarUpload.single('reference'), handleCharacterImageUpload('reference'));

// ==================== AI 生成形象图片 ====================

// 参考图固定模板（三视图 + 表情表）
const REFERENCE_TEMPLATE = '整体是一张干净白色背景上的角色设定图，采用清晰的图解式排版，像官方设定指南页面。画面中包含角色的正面、侧面、背面三视图，比例准确，姿态自然，服装结构统一。旁边加入3到5个表情变化，包括平静、警觉、愤怒、微笑、受伤或沉思等状态。加入服装与装备拆解区：展示角色的外套、腰带、武器、鞋靴、背包、饰品、特殊道具或机械部件，并用细线标注结构细节。加入局部放大图，例如衣料纹理、徽章图案、武器机关、手套细节、护甲接口等。右下角加入角色配色板，包含5到7个色块，并标注主色、辅助色、金属色、皮肤色、发色、强调色。页面下方加入一小段世界观说明，像官方设定集中的角色档案文字，简短但有叙事感。整体视觉风格：高分辨率概念艺术，专业角色设计稿，干净白底，信息排版清晰，细节丰富但不杂乱，线稿精致，色彩统一，官方设定集质感，游戏美术设定页，动画制作设定稿，角色三视图，装备拆解图，表情设定，世界观注释。避免：杂乱背景、低清晰度、比例错误、三视图不一致、多余人物、过度装饰、文字乱码、廉价卡通感、AI拼贴感。';
// 头像固定模板（不向前端展示）
const AVATAR_TEMPLATE = 'Character portrait avatar, head and shoulders front view, centered composition, clean simple background, friendly expression, high quality official profile picture. No accessories, no props.';

// AI 生成形象图片（预览，不落盘；采用走 adopt-image）
app.post('/api/characters/:characterId/generate-image', async (req, res) => {
  const { characterId } = req.params;
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: '角色不存在' });
  const { kind, stylePrompt, requirement, attachment } = req.body || {};
  if (kind !== 'avatar' && kind !== 'reference') return res.status(400).json({ error: 'kind 必须为 avatar 或 reference' });
  if (attachment !== undefined && attachment !== null && !(typeof attachment === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(attachment))) {
    return res.status(400).json({ error: '附件仅支持 jpg / png / webp 图片' });
  }
  // base64 后体积膨胀约 1.37 倍，7.5MB 约对应原图 5MB
  if (typeof attachment === 'string' && attachment.length > 7_500_000) {
    return res.status(400).json({ error: '附件图片不能超过 5MB' });
  }
  const reqText = typeof requirement === 'string' ? requirement.trim().slice(0, 500) : '';
  const style = typeof stylePrompt === 'string' ? stylePrompt.trim().slice(0, 1500) : '';
  const parts = [kind === 'avatar' ? AVATAR_TEMPLATE : REFERENCE_TEMPLATE];
  // 头像生成：固定提示词 + 必须以参考图为输入（风格/要求不参与）；未传附件时自动取角色已保存的参考图
  let refInput = attachment || null;
  if (kind === 'avatar') {
    const refPath = characterManager.getReferenceImagePath(characterId);
    if (!refPath && !refInput) return res.status(400).json({ error: '生成头像前请先上传或生成参考图' });
    if (!refInput) {
      const buf = fs.readFileSync(refPath);
      const ext = detectImageExt(buf);
      if (!ext) return res.status(400).json({ error: '参考图文件无效，请重新上传' });
      refInput = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
    }
  } else {
    if (style) parts.push(style);
    if (reqText) parts.push(reqText);
  }
  try {
    let image = await imageService.generateImage(parts.join('. '), refInput);
    if (!image) return res.status(500).json({ error: '生成失败：绘图服务未返回图片，请检查绘图 API 配置' });
    // 生成结果是远程 URL 时下载为 dataURL，方便前端预览与采用
    if (/^https?:\/\//.test(image)) {
      const r = await fetch(image, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`下载生成结果失败 (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      const ext = detectImageExt(buf);
      if (!ext) throw new Error('生成结果不是有效图片');
      image = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
    }
    res.json({ success: true, image });
  } catch (err) {
    console.warn('[CharMgr] AI 生成形象失败:', err.message);
    res.status(500).json({ error: '生成失败: ' + err.message });
  }
});

// 采用生成的图片落盘（覆盖对应图片）
app.post('/api/characters/:characterId/adopt-image', (req, res) => {
  const { characterId } = req.params;
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: '角色不存在' });
  const { kind, image } = req.body || {};
  if (kind !== 'avatar' && kind !== 'reference') return res.status(400).json({ error: 'kind 必须为 avatar 或 reference' });
  const m = typeof image === 'string' ? /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(image) : null;
  if (!m || !m[2]) return res.status(400).json({ error: '图片数据无效' });
  const buf = Buffer.from(m[2], 'base64');
  if (!detectImageExt(buf)) return res.status(400).json({ error: '图片数据无效' });
  try {
    const result = kind === 'avatar'
      ? characterManager.saveAvatar(characterId, buf, m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg')
      : characterManager.saveReference(characterId, buf, m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg');
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    console.warn('[CharMgr] 采用形象图片失败:', err.message);
    res.status(500).json({ error: '保存失败: ' + err.message });
  }
});
// multer 超限默认落 500，这里映射为 413
app.use((err, _req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '图片不能超过 5MB' });
  next(err);
});

// 重置运行时状态（档案 JSON 不动）
app.post('/api/characters/:characterId/reset', (req, res) => {
  const { characterId } = req.params;
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: '角色不存在' });
  try {
    db.deleteCharacterData(characterId);
    const removed = memoryService.removeCharacter(characterId);
    console.log(`[CharMgr] 重置 ${characterId}：运行时数据已清空，删除记忆文件 ${removed} 个`);
    res.json({ success: true });
  } catch (err) {
    console.warn('[CharMgr] 重置失败:', err.message);
    res.status(500).json({ error: '重置失败: ' + err.message });
  }
});

// 彻底删除角色（目录 + SQLite + 记忆 + 媒体文件），需 confirm=角色全名
app.delete('/api/characters/:characterId', (req, res) => {
  const { characterId } = req.params;
  const c = characterManager.getCharacterProfile(characterId);
  if (!c) return res.status(404).json({ error: '角色不存在' });
  if (typeof req.query.confirm !== 'string' || req.query.confirm.length === 0 || req.query.confirm !== c.full_name) {
    return res.status(400).json({ error: '确认名与角色全名不匹配，未执行删除' });
  }
  try {
    // 可逆清理在前（失败可重试），删目录不可逆操作放最后
    db.deleteCharacterData(characterId);
    memoryService.removeCharacter(characterId);
    const result = characterManager.deleteCharacter(characterId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    console.log(`[CharMgr] 已彻底删除角色: ${characterId}`);
    res.json({ success: true });
  } catch (err) {
    console.warn('[CharMgr] 删除失败:', err.message);
    res.status(500).json({ error: '删除失败: ' + err.message });
  }
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

  // Live2D 形象情绪推送：聊天结算后把最新情绪状态广播给前端形象
  try {
    const st = db.ensureCharacterState(userId, characterId);
    io.emit('avatar:emotion', { userId, characterId, emotionState: st.emotion_state || 'calm', moodLevel: st.mood_level || 0 });
  } catch (e) {
    console.warn('[avatar:emotion] 推送失败:', e.message);
  }

  res.write('event: end\ndata: {}\n\n');
  res.end();
});

// --- TTS ---
app.post('/api/tts', async (req, res) => {
  const { text, characterId, speaker } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text' });
  if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
  if (speaker !== undefined && (typeof speaker !== 'string' || !speaker.trim() || speaker.length > 128)) {
    return res.status(400).json({ error: 'speaker 非法' });
  }

  try {
    // 从数据库获取当前情绪状态
    const uid = req.body.userId || 'test_user';
    const state = db.getCharacterState(uid, characterId);
    const emotionState = state?.emotion_state || 'calm';
    const audio = await multimodalService.synthesizeSpeech({ text, characterId, emotionState, speaker: speaker?.trim() });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audio.length);
    res.send(audio);
  } catch (err) {
    res.status(500).json({ error: `TTS 失败: ${err.message}` });
  }
});

app.get('/api/voices', (_req, res) => {
  res.json({ voices: VOICE_CATALOG });
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

// --- Video（火山方舟，异步任务制） ---
app.post('/api/video', (req, res) => {
  const { userId, characterId, prompt } = req.body;
  if (!userId || !characterId) return res.status(400).json({ error: '缺少 userId 或 characterId' });
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: `角色 ${characterId} 不存在` });

  try {
    const { taskId, duration, truncated, cap } = videoService.createTask(userId, characterId, { prompt });
    res.json({ success: true, taskId, duration, truncated, cap });
  } catch (err) {
    res.status(500).json({ error: `视频任务创建失败: ${err.message}` });
  }
});

app.get('/api/video/status/:taskId', (req, res) => {
  res.json(videoService.getTaskStatus(req.params.taskId));
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
  try {
    const result = await diaryService.generateDailyDiary({ userId, characterId });
    res.json(result);
  } catch (err) {
    console.warn(`[DiaryService] 手动生成日记失败: ${err.message}`);
    res.status(500).json({ success: false, error: `日记生成失败: ${err.message}` });
  }
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
  imageService.updateConfig({ apiKey: raw.image.apiKey, baseURL: raw.image.baseURL, model: raw.image.model });
  videoService.updateConfig({ apiKey: raw.video.apiKey, baseURL: raw.video.baseURL, model: raw.video.model, maxDuration: raw.video.maxDuration });
  multimodalService.updateConfig({ apiKey: raw.tts.apiKey, resourceId: raw.tts.resourceId });
  if (raw.tts.apiKey) {
    voiceCallService._apiKey = raw.tts.apiKey;
  }

  console.log(`[Settings] 配置已更新: chat=${raw.chat.baseURL} model=${raw.chat.model}`);
  res.json({ success: true, settings: updated });
});

// 校验某一类 API 配置有效性（前端设置弹窗「校验」按钮）
// body: { kind: 'chat'|'image'|'tts'|'video', section: { baseURL?, apiKey?, model? } }
// section.apiKey 若为掩码（****开头）则回退用已存储的真实 Key
app.post('/api/settings/test', async (req, res) => {
  const { kind, section = {} } = req.body || {};
  const raw = settingsManager.getRaw();
  const stored = raw[kind];
  if (!stored) return res.status(400).json({ ok: false, message: `未知配置类型: ${kind}` });

  const apiKey = (section.apiKey && !section.apiKey.startsWith('****')) ? section.apiKey.trim() : (stored.apiKey || '');
  const baseURL = (section.baseURL || stored.baseURL || '').trim().replace(/\/+$/, '');
  const model = (section.model || stored.model || '').trim();
  if (!apiKey) return res.json({ ok: false, message: 'API Key 未配置' });

  try {
    if (kind === 'chat') {
      if (!baseURL) return res.json({ ok: false, message: 'Base URL 未配置' });
      const r = await fetch(`${baseURL}/models`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (r.ok) return res.json({ ok: true, message: '连接成功，Key 有效' });
      if (r.status === 401 || r.status === 403) {
        return res.json({ ok: false, message: `鉴权失败 HTTP ${r.status}，Key 无效` });
      }
      if (r.status === 404 || r.status === 405) {
        // 网关未实现 /models（如火山方舟）：回退用最小对话请求验证
        const r2 = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model || undefined, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        });
        if (r2.ok) return res.json({ ok: true, message: '连接成功，Key 有效' });
        const body = await r2.text().catch(() => '');
        return res.json({ ok: false, message: `HTTP ${r2.status}: ${body.slice(0, 120)}` });
      }
      return res.json({ ok: false, message: `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}` });
    }

    if (kind === 'image') {
      // 双协议（火山方舟 Ark / DashScope）自动识别与真实校验都封装在 ImageService
      return res.json(await imageService.probe({ apiKey, baseURL, model }));
    }

    if (kind === 'tts') {
      // 火山单向流式 TTS 探测：发一条最短合成请求（'你好' 两个字，成本可忽略）
      const resourceId = (section.resourceId || stored.resourceId || 'seed-tts-2.0').trim();
      const r = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
        method: 'POST',
        headers: {
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          req_params: { text: '你好', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000 } },
        }),
      });
      if (r.status === 401) return res.json({ ok: false, message: '鉴权失败(401)，Key 无效' });
      if (r.status === 403) {
        const body = await r.text().catch(() => '');
        let j = {}; try { j = JSON.parse(body); } catch { /* 非 JSON 响应，忽略 */ }
        const code = j?.header?.code, msg = j?.header?.message || '';
        if (code === 45000030 || /not granted/i.test(msg)) {
          return res.json({ ok: false, message: 'Key 有效但资源未开通：请在火山控制台开通「豆包语音合成大模型 2.0」' });
        }
        return res.json({ ok: false, message: `HTTP 403: ${msg || body.slice(0, 120)}` });
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.json({ ok: false, message: `HTTP ${r.status}: ${body.slice(0, 120)}` });
      }
      return res.json({ ok: true, message: 'Key 有效，火山 TTS 可用' });
    }

    if (kind === 'video') {
      if (!baseURL) return res.json({ ok: false, message: 'Base URL 未配置' });
      // 零成本探测：用不存在的任务 id 查询，鉴权失败返回 401/403，Key 有效返回 404
      const r = await fetch(`${baseURL}/content_generation/tasks/settings-validate-nonexistent`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (r.status === 401 || r.status === 403) {
        return res.json({ ok: false, message: `鉴权失败 HTTP ${r.status}，Key 无效` });
      }
      return res.json({ ok: true, message: 'Key 有效（鉴权通过）' });
    }

    return res.json({ ok: false, message: `未知配置类型: ${kind}` });
  } catch (err) {
    return res.json({ ok: false, message: `请求失败: ${err.message}` });
  }
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
    try {
      await dailyPlanner.generateForAllActivePairs();
    } catch (err) {
      console.warn(`[DailyPlanner] 定时日程生成失败: ${err.message}`);
    }
  }, scheduleDelay);

  // 日记生成：2:00
  const nextDiary = new Date(now);
  nextDiary.setHours(DIARY_CRON_HOUR, DIARY_CRON_MINUTE, 0, 0);
  if (nextDiary <= now) nextDiary.setDate(nextDiary.getDate() + 1);

  const diaryDelay = nextDiary - now;
  console.log(`[DiaryService] 下次日记生成: ${nextDiary.toLocaleString('zh-CN')} (${Math.round(diaryDelay / 60000)}min 后)`);

  setTimeout(async () => {
    try {
      await diaryService.checkAndGenerateAll();
    } catch (err) {
      console.warn(`[DiaryService] 定时日记生成失败: ${err.message}`);
    }
    // 递归调度下一天（即使本次失败也必须重新挂载，否则定时任务永久停摆）
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
  try {
    dailyPlanner.processEventEmotions();
  } catch (err) {
    console.warn(`[DailyPlanner] 情绪事件处理失败: ${err.message}`);
  }
}, 30 * 60 * 1000);

// 启动时立即处理一次（防止重启后遗漏事件）
setTimeout(() => dailyPlanner.processEventEmotions(), 5000);

// ==================== 优雅退出 ====================

// 全局兜底：未处理的 Promise rejection 不允许击穿进程。
// （Node >= 15 默认直接 crash；dev 模式 node --watch 会拉起进程，重启窗口期内
//   所有前端请求表现为 "Failed to fetch"，即「偶现加载角色列表失败」的根因。
//   此处仅告警降级，各后台任务自身已就地 catch，这里是最后一道防线。）
process.on('unhandledRejection', (reason) => {
  console.warn(`[WARN] 未处理的 Promise rejection: ${reason?.stack || reason}`);
});

process.on('SIGINT', async () => {
  console.log('\n[Shutdown] 正在保存数据...');
  proactiveService.stopProactiveTimer();
  proactiveService.stopReconcileTimer();
  await memoryService.closeAll();
  db.close();
  process.exit(0);
});

// ==================== 启动 ====================

const PORT = process.env.PORT || 3000;

const onHttpListening = () => {
  console.log(`\n========================================`);
  console.log(`  AI Mate Soul v4 - 终极沉浸版`);
  console.log(`  http://localhost:${PORT}`);
  if (httpsServer) {
    // HTTPS 是可选增强（手机麦克风），端口被占时仅告警降级为 HTTP，不拖垮主服务
    httpsServer.on('error', (err) => {
      console.warn(`[WARN] HTTPS ${HTTPS_PORT} 端口监听失败，已降级为仅 HTTP: ${err.message}`);
    });
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
  console.log(`  LLM: ${llmProvider.getProviderNames().join(', ') || '未配置 (请在 Web 设置页配置)'}`);
  console.log(`  角色: ${characterManager.listCharacters().map(c => c.name).join(', ')}`);
  console.log(`  TTS: 火山豆包语音 seed-tts-2.0${settingsManager.getRaw().tts.apiKey ? '' : ' (未配置API Key)'}`);
  console.log(`  Socket.IO: 已启用`);
  console.log(`  Voice Call: 火山豆包实时语音 Seeduplex${settingsManager.getRaw().tts.apiKey ? '' : ' (未配置API Key)'}`);
  console.log(`  Image Gen: Wanx 2.7 Image Pro${settingsManager.getRaw().image.apiKey ? '' : ' (未配置API Key)'}`);
  console.log(`  Video Gen: Ark Seedance${settingsManager.getRaw().video.apiKey ? '' : ' (未配置API Key)'}`);
  console.log(`  日程规划: 每日 ${SCHEDULE_CRON_HOUR}:${String(SCHEDULE_CRON_MINUTE).padStart(2, '0')}`);
  console.log(`  日记定时: 每日 ${DIARY_CRON_HOUR}:${String(DIARY_CRON_MINUTE).padStart(2, '0')}`);
  console.log(`========================================\n`);
};

const listenHttp = (attempt = 0) => {
  httpServer.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      // node --watch 快速重启时旧进程可能尚未释放端口，重试而不是崩溃退出
      console.warn(`[WARN] HTTP ${PORT} 端口暂被占用，500ms 后重试 (${attempt + 1}/10)...`);
      httpServer.removeListener('listening', onHttpListening); // 移除本 attempt 挂起的成功回调，防止成功后重复执行
      setTimeout(() => listenHttp(attempt + 1), 500);
      return;
    }
    console.error(`[ERROR] HTTP ${PORT} 端口监听失败: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.warn('[WARN] 进程保持运行，等待下次文件变更重启（node --watch）');
    } else {
      process.exit(1);
    }
  });
  httpServer.once('listening', onHttpListening);
  httpServer.listen(PORT);
};

listenHttp();
