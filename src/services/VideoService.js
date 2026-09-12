import fs from 'fs';
import path from 'path';

const VIDEOS_DIR = path.resolve(process.cwd(), 'public', 'videos');
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';
const POLL_INTERVAL_MS = 10 * 1000;
const POLL_MAX_MS = 10 * 60 * 1000;

/**
 * VideoService - 火山方舟（Ark）视频生成引擎
 *
 * 流程（异步任务制，视频生成耗时数分钟）：
 * 1. 创建任务 — POST /contents/generations/tasks（场景化 prompt + 角色参考图保外貌一致）
 * 2. 后台轮询 — GET /contents/generations/tasks/{id}（queued/running → succeeded/failed）
 * 3. 下载保存 — mp4 存入 public/videos/
 * 4. 记录数据库 — 复用 photos 表（type = 'video'）
 *
 * 状态查询走 GET /api/video/status/:taskId，前端轮询展示进度。
 */
export class VideoService {
  constructor({ apiKey, baseURL, model, maxDuration, db, characterManager, llmProvider, provider }) {
    this._apiKey = apiKey || '';
    this._baseURL = baseURL || DEFAULT_BASE_URL;
    this._model = model || DEFAULT_MODEL;
    this._maxDuration = this._normalizeDuration(maxDuration);
    this._db = db;
    this._characterManager = characterManager;
    this._llmProvider = llmProvider;
    this._provider = provider;

    // 确保视频目录存在
    if (!fs.existsSync(VIDEOS_DIR)) {
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    }

    // taskId → { status, filename, caption, prompt, error, createdAt }
    this._tasks = new Map();
  }

  /** 运行时刷新配置（设置保存后立即生效） */
  updateConfig({ apiKey, baseURL, model, maxDuration }) {
    if (apiKey) this._apiKey = apiKey;
    if (baseURL) this._baseURL = baseURL;
    if (model) this._model = model;
    if (maxDuration !== undefined) this._maxDuration = this._normalizeDuration(maxDuration);
  }

  isConfigured() {
    return !!this._apiKey;
  }

  /** 时长配置合法性归一：非数字/负数回退 5 秒 */
  _normalizeDuration(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 5;
    return Math.floor(n);
  }

  /** 当前模型的时长上限（秒）：2.5 系列模型 30s，其他 15s */
  _durationCap() {
    return /2[-.]5/.test(this._model) ? 30 : 15;
  }

  /**
   * 创建视频生成任务（立即返回 taskId，后台轮询）
   * @param {string} userId
   * @param {string} characterId
   * @param {object} opts - { prompt?: string, type?: string, caption?: string }
   * @returns {Promise<{ taskId: string, duration: number, truncated: boolean, cap: number }>}
   */
  async createTask(userId, characterId, opts = {}) {
    if (!this.isConfigured()) {
      throw new Error('视频 API 未配置，请在设置页面配置火山方舟 API Key');
    }

    const character = this._characterManager.getCharacter(characterId);
    if (!character) throw new Error(`角色 ${characterId} 不存在`);

    // prompt/caption：外部指定优先，否则结合最近对话上下文生成专属当下场景的镜头描述与配文
    let prompt = opts.prompt;
    let caption = opts.caption;
    if (!prompt || !caption) {
      const scene = await this._buildSceneContent(userId, character);
      prompt = prompt || scene.prompt;
      caption = caption || scene.caption;
    }

    // 时长：配置值超出当前模型上限时按上限截断
    const cap = this._durationCap();
    const duration = Math.min(this._maxDuration, cap);
    const truncated = this._maxDuration > cap;

    // 角色参考图：多模态参考模式（reference_image），仅约束外貌一致性，
    // 不作为首帧——首帧模式会让视频从静态照片"复活"，镜头不自然
    const content = [];
    const refImagePath = this._characterManager.getReferenceImagePath(characterId);
    if (refImagePath && fs.existsSync(refImagePath)) {
      const base64 = fs.readFileSync(refImagePath).toString('base64');
      const ext = path.extname(refImagePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}`, role: 'reference_image' },
      });
      console.log(`[VideoService] 使用角色参考图（多模态参考）: ${path.basename(refImagePath)}`);
    }
    content.push({ type: 'text', text: `${prompt} --wm false --dur ${duration}` });

    const taskId = await this._createArkTask(content);
    this._tasks.set(taskId, {
      status: 'generating',
      filename: null,
      caption,
      prompt,
      error: null,
      userId,
      characterId,
      createdAt: Date.now(),
    });

    // 后台轮询（不阻塞请求）
    this._pollTask(taskId).catch(err => {
      console.error(`[VideoService] 任务 ${taskId} 轮询异常:`, err.message);
    });

    console.log(`[VideoService] 任务已创建: taskId=${taskId}, character=${character.full_name}, duration=${duration}s${truncated ? `（配置 ${this._maxDuration}s 超出模型上限 ${cap}s，已截断）` : ''}`);
    return { taskId, duration, truncated, cap };
  }

  /** 查询任务状态 */
  getTaskStatus(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return { status: 'not_found' };
    const { status, filename, caption, error, prompt } = task;
    return { status, filename, caption, error, prompt };
  }

  /** 创建 Ark 任务 */
  async _createArkTask(content) {
    const url = `${this._baseURL}/contents/generations/tasks`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({ model: this._model, content }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`创建视频任务失败 HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    if (!data.id) throw new Error(`创建视频任务响应缺少 id: ${JSON.stringify(data).slice(0, 300)}`);
    return data.id;
  }

  /** 轮询任务直到成功/失败/超时 */
  async _pollTask(taskId) {
    const task = this._tasks.get(taskId);
    const deadline = Date.now() + POLL_MAX_MS;
    const url = `${this._baseURL}/contents/generations/tasks/${taskId}`;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      let data;
      try {
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${this._apiKey}` },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`查询任务失败 HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
        data = await res.json();
      } catch (err) {
        // 单次查询失败不终止，继续重试直到超时
        console.warn(`[VideoService] 任务 ${taskId} 查询失败，继续重试: ${err.message}`);
        continue;
      }

      console.log(`[VideoService] 任务 ${taskId} 状态: ${data.status}`);

      if (data.status === 'succeeded') {
        const videoUrl = data.content?.video_url;
        if (!videoUrl) {
          task.status = 'failed';
          task.error = '任务成功但响应缺少 video_url';
          return;
        }
        try {
          task.filename = await this._downloadAndSave(videoUrl, task.userId, task.characterId);
          task.status = 'succeeded';
          this._db.savePhoto({
            userId: task.userId,
            characterId: task.characterId,
            filename: task.filename,
            prompt: task.prompt,
            type: 'video',
            caption: task.caption,
          });
          console.log(`[VideoService] 任务 ${taskId} 完成: ${task.filename}`);
        } catch (err) {
          task.status = 'failed';
          task.error = `视频下载失败: ${err.message}`;
        }
        return;
      }

      if (data.status === 'failed') {
        task.status = 'failed';
        task.error = data.error?.message || '视频生成失败';
        console.error(`[VideoService] 任务 ${taskId} 失败: ${task.error}`);
        return;
      }
      // queued / running → 继续轮询
    }

    task.status = 'failed';
    task.error = '视频生成超时（超过 10 分钟）';
  }

  /** 下载 mp4 到 public/videos/ */
  async _downloadAndSave(videoUrl, userId, characterId) {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = `${userId}_${characterId}_${Date.now()}.mp4`;
    fs.writeFileSync(path.join(VIDEOS_DIR, filename), buffer);
    return filename;
  }

  /** 默认视频 prompt：角色档案 + 生活化动态镜头 */
  _buildDefaultPrompt(character) {
    const visual = character.visual_features || {};
    const parts = [];
    if (visual.hair) parts.push(visual.hair);
    if (visual.style) parts.push(visual.style);
    const appearance = parts.join(', ') || character.full_name;

    return `Live-action selfie video, handheld camera, ${appearance}, the girl looks at the camera, smiles and waves, natural daily indoor lighting, gentle body movement, realistic skin texture, warm atmosphere, smooth motion`;
  }

  /**
   * 场景化内容：解析最近对话上下文，一次性生成贴合当下聊天场景的
   * 视频镜头描述（prompt）+ 角色口吻配文（caption）。
   * 无历史 / LLM 失败 / 解析失败时逐项回退默认值（不阻塞视频生成）。
   */
  async _buildSceneContent(userId, character) {
    let history = [];
    try {
      history = this._db.getRecentChatHistory(userId, character.id, 10) || [];
    } catch {
      // 历史读取失败不影响生成
    }
    if (!history.length || !this._llmProvider) {
      return { prompt: this._buildDefaultPrompt(character), caption: this._generateCaption(character) };
    }

    const dialogue = history
      .map(m => `${m.role === 'user' ? '用户' : character.nickname}: ${this._stripTags(m.content).slice(0, 200)}`)
      .join('\n');

    try {
      const response = await this._llmProvider.chat(this._provider, {
        systemPrompt: `你是一个视频内容生成器。根据下面角色与用户的最近聊天内容，生成两样东西：\n1. PROMPT：贴合当前对话场景的实拍自拍视频镜头描述（英文，一行，不超过 80 词）。主角是该女生本人（外貌以参考图为准，不要详细描述外貌）；场景、动作、表情、情绪要自然延续最近的对话内容（比如刚聊到做饭就拍厨房场景，用户难过就给安慰的镜头）；生活化真实感，手持镜头，自然光。\n2. CAPTION：随视频发给用户的中文配文，用角色的口吻说话，口语化、贴合对话内容，不超过 20 字，不要引号。\n\n严格按以下格式输出（共两行，不要多余内容）：\nPROMPT: <镜头描述>\nCAPTION: <中文配文>`,
        messages: [{ role: 'user', content: `角色：${character.full_name}（${character.personality || ''}）\n\n最近对话：\n${dialogue}` }],
        temperature: 0.7,
        maxTokens: 250,
      });
      const text = this._stripTags(response);
      const prompt = text.match(/PROMPT:\s*(.+)/i)?.[1]?.replace(/^["'`]|["'`]$/g, '').trim();
      const caption = text.match(/CAPTION:\s*(.+)/i)?.[1]?.replace(/^["'`]|["'`]$/g, '').trim();
      if (!prompt) throw new Error(`响应缺少 PROMPT 行: ${text.slice(0, 100)}`);
      console.log(`[VideoService] 场景化内容（基于最近 ${history.length} 条对话）: prompt="${prompt.slice(0, 60)}..." caption="${caption || ''}"`);
      return {
        prompt,
        caption: caption || this._generateCaption(character),
      };
    } catch (err) {
      console.warn(`[VideoService] 场景化内容生成失败，回退默认: ${err.message}`);
      return { prompt: this._buildDefaultPrompt(character), caption: this._generateCaption(character) };
    }
  }

  /** 清洗 LLM 输出中可能残留的思维链标签 */
  _stripTags(text) {
    return String(text || '')
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .replace(/<reply>/gi, '')
      .replace(/<\/reply>/gi, '')
      .trim();
  }

  /** 随机视频配文（简体中文） */
  _generateCaption(character) {
    const captions = [
      `录了个小视频给你看~`,
      `猜猜我在干嘛？`,
      `拍了一段给你，不许笑我`,
      `今天的样子，还行吧`,
      `随手录的，别嫌弃`,
      `${character.nickname}的日常碎片`,
    ];
    return captions[Math.floor(Math.random() * captions.length)];
  }
}
