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
 * 1. 创建任务 — POST /content_generation/tasks（文本 prompt + 角色参考图首帧）
 * 2. 后台轮询 — GET /content_generation/tasks/{id}（queued/running → succeeded/failed）
 * 3. 下载保存 — mp4 存入 public/videos/
 * 4. 记录数据库 — 复用 photos 表（type = 'video'）
 *
 * 状态查询走 GET /api/video/status/:taskId，前端轮询展示进度。
 */
export class VideoService {
  constructor({ apiKey, baseURL, model, db, characterManager }) {
    this._apiKey = apiKey || '';
    this._baseURL = baseURL || DEFAULT_BASE_URL;
    this._model = model || DEFAULT_MODEL;
    this._db = db;
    this._characterManager = characterManager;

    // 确保视频目录存在
    if (!fs.existsSync(VIDEOS_DIR)) {
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    }

    // taskId → { status, filename, caption, prompt, error, createdAt }
    this._tasks = new Map();
  }

  /** 运行时刷新配置（设置保存后立即生效） */
  updateConfig({ apiKey, baseURL, model }) {
    if (apiKey) this._apiKey = apiKey;
    if (baseURL) this._baseURL = baseURL;
    if (model) this._model = model;
  }

  isConfigured() {
    return !!this._apiKey;
  }

  /**
   * 创建视频生成任务（立即返回 taskId，后台轮询）
   * @param {string} userId
   * @param {string} characterId
   * @param {object} opts - { prompt?: string, type?: string, caption?: string }
   * @returns {{ taskId: string }}
   */
  createTask(userId, characterId, opts = {}) {
    if (!this.isConfigured()) {
      throw new Error('视频 API 未配置，请在设置页面配置火山方舟 API Key');
    }

    const character = this._characterManager.getCharacter(characterId);
    if (!character) throw new Error(`角色 ${characterId} 不存在`);

    // prompt：外部指定优先，否则基于角色档案 + 视频镜头描述生成
    const prompt = opts.prompt || this._buildDefaultPrompt(character);
    const caption = opts.caption || this._generateCaption(character);

    // 首帧参考图：保证角色外貌一致性
    const content = [];
    const refImagePath = this._characterManager.getReferenceImagePath(characterId);
    if (refImagePath && fs.existsSync(refImagePath)) {
      const base64 = fs.readFileSync(refImagePath).toString('base64');
      const ext = path.extname(refImagePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}`, role: 'first_frame' },
      });
      console.log(`[VideoService] 使用角色参考图作为首帧: ${path.basename(refImagePath)}`);
    }
    content.push({ type: 'text', text: `${prompt} --wm false --dur 5` });

    const taskId = this._createArkTask(content);
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

    console.log(`[VideoService] 任务已创建: taskId=${taskId}, character=${character.full_name}`);
    return { taskId };
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
    const url = `${this._baseURL}/content_generation/tasks`;
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
    const url = `${this._baseURL}/content_generation/tasks/${taskId}`;

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
