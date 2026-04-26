import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.resolve(process.cwd(), 'public', 'photos');
const TEMPLATES_PATH = path.resolve(process.cwd(), 'data', 'photo_templates.json');
const DASHSCOPE_IMAGE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/**
 * ImageService - AI 伴侣绘图引擎
 *
 * 核心逻辑：当前状态 + 模板 = 绘图提示词
 *
 * 流程：
 * 1. 状态抓取 — 从 DB/TimeService 读取角色当前活动、心情、好感度
 * 2. 模板选取 — 从 photo_templates.json 随机选取自拍/空镜模板
 * 3. 模板填充 — 用角色外貌 + 当前状态 + 时间场景 填充占位符
 * 4. 绘图调用 — DashScope Wanx 2.7 Image Pro
 * 5. 存储与反馈 — 保存图片 + 记录数据库
 */
export class ImageService {
  constructor({ apiKey, db, characterManager, timeService, llmProvider, provider }) {
    this._apiKey = apiKey;
    this._db = db;
    this._characterManager = characterManager;
    this._timeService = timeService;
    this._llmProvider = llmProvider;
    this._provider = provider;

    // 加载模板
    this._templates = this._loadTemplates();

    // 确保照片目录存在
    if (!fs.existsSync(PHOTOS_DIR)) {
      fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    }
  }

  _loadTemplates() {
    try {
      const raw = fs.readFileSync(TEMPLATES_PATH, 'utf-8');
      const data = JSON.parse(raw);
      console.log(`[ImageService] 模板加载完成: 自拍 ${data.selfie?.length || 0} 个, 空镜 ${data.activity?.length || 0} 个`);
      return data;
    } catch (err) {
      console.warn('[ImageService] 模板加载失败，使用内置模板:', err.message);
      return { selfie: [], activity: [] };
    }
  }

  /**
   * 完整流程：请求照片
   * @returns {{ filename: string, caption: string }}
   */
  async handlePhotoRequest(userId, characterId, type = 'selfie', replyContext = '', environment = null, chatContext = '') {
    console.log(`[ImageService] handlePhotoRequest 开始: userId=${userId}, characterId=${characterId}, type=${type}`);

    const character = this._characterManager.getCharacter(characterId);
    if (!character) throw new Error(`角色 ${characterId} 不存在`);

    const state = this._db.getCharacterState(userId, characterId);
    if (!state) throw new Error('用户状态不存在');

    // 1. 抓取当前状态
    const activity = state.current_activity || await this._timeService.getCurrentActivity(character) || '休息';
    const timeDescription = this._timeService.getCurrentTimeDescription();
    const affection = state.affection;
    const moodKey = state.mood || '平常';

    // 2. 构建天气描述（用于绘图 prompt）
    const weatherInfo = this._buildWeatherHint(environment);

    // 3. 检查参考图（提前获取，决定 prompt 中是否包含外貌描述）
    const refImagePath = this._characterManager.getReferenceImagePath(characterId);
    const hasRefImage = refImagePath && fs.existsSync(refImagePath);
    console.log(`[ImageService] 参考图: ${hasRefImage ? path.basename(refImagePath) : '无'}`);

    // 4. 生成提示词（有对话上下文时用 LLM 动态生成，否则用模板）
    const prompt = await this.generatePromptFromTemplate(character, {
      type,
      activity,
      mood: moodKey,
      affection,
      timeDescription,
      replyContext,
      chatContext,
      weatherInfo,
      hasRefImage,
    });
    console.log(`[ImageService] 生成提示词 (前200字): ${prompt.slice(0, 200)}...`);

    // 5. 调用绘图 API（带角色参考图）
    const imageUrl = await this.generateImage(prompt, refImagePath);
    console.log(`[ImageService] DashScope 返回图片 URL: ${imageUrl.slice(0, 80)}...`);

    // 4. 下载并保存
    const filename = await this.downloadAndSave(imageUrl, userId, characterId);
    console.log(`[ImageService] 图片已保存: ${filename}`);

    // 5. 生成配文
    const caption = this._generateCaption(character, type, activity);

    // 6. 记录数据库
    this._db.savePhoto({ userId, characterId, filename, prompt, type, caption });

    console.log(`[ImageService] handlePhotoRequest 完成: filename=${filename}, caption=${caption}`);
    return { filename, caption };
  }

  /**
   * 从模板库随机选取并填充，生成完整的英文 prompt
   */
  async generatePromptFromTemplate(character, { type, activity, mood, affection, timeDescription, replyContext, chatContext, weatherInfo, hasRefImage }) {
    const visual = character.visual_features || {};

    // 构建外貌描述（有参考图时不传，让参考图决定外貌）
    let appearance = '';
    if (!hasRefImage) {
      const appearanceParts = [];
      if (visual.hair) appearanceParts.push(visual.hair);
      if (visual.eyes) appearanceParts.push(visual.eyes);
      appearance = appearanceParts.length > 0 ? appearanceParts.join(', ') : 'natural East Asian features';
    }

    // 根据好感度生成表情（二次元风格）
    let expression;
    if (affection < 30) {
      expression = 'looking away slightly, polite but distant anime expression, closed mouth, slight blush';
    } else if (affection < 60) {
      expression = 'natural relaxed anime smile, gentle eye contact, soft expression';
    } else {
      expression = 'bright genuine anime smile, warm intimate gaze, playful expression, sparkly eyes';
    }

    const clothing = this._generateClothing(character, type, activity);

    // 如果有对话上下文，用 LLM 动态生成精准的场景 prompt
    if (chatContext || replyContext) {
      try {
        const llmPrompt = this._buildContextPrompt({
          character, type, appearance, expression, clothing,
          activity, timeDescription, replyContext, chatContext, weatherInfo, hasRefImage,
        });
        const result = await this._llmProvider.chat(this._provider, {
          systemPrompt: 'You are an anime art prompt generator. Generate ONLY the image prompt in English, nothing else. No explanations, no markdown, no quotes.',
          messages: [{ role: 'user', content: llmPrompt }],
          temperature: 0.6,
        });
        const prompt = result.replace(/```/g, '').trim();
        console.log(`[ImageService] LLM 动态生成 prompt (前200字): ${prompt.slice(0, 200)}...`);
        return prompt;
      } catch (err) {
        console.warn(`[ImageService] LLM 生成 prompt 失败，降级到模板: ${err.message}`);
      }
    }

    // 无对话上下文时，用模板（兜底）
    return this._templatePrompt(character, { type, activity, mood, affection, timeDescription, appearance, expression, clothing, weatherInfo });
  }

  /**
   * 用 LLM 根据对话上下文动态生成绘图 prompt
   */
  _buildContextPrompt({ character, type, appearance, expression, clothing, activity, timeDescription, replyContext, chatContext, weatherInfo, hasRefImage }) {
    const typeDesc = type === 'selfie' ? 'a selfie (character facing camera)' : type === 'selfie_grid' ? 'a photo grid/collage' : type === 'portrait' ? 'a portrait (someone else took the photo)' : 'an activity/scene photo (showing what the character is doing or the environment)';

    // 有参考图时不描述外貌，只描述场景/服装/动作
    const appearanceLine = hasRefImage
      ? 'Character appearance: Use the reference image exactly. Do NOT describe or change hair color, eye color, or face.'
      : `Character appearance: ${appearance}`;

    return `Generate an anime image prompt based on these requirements:

Style: Japanese anime art style, modern anime illustration, cel shading, clean line art, vibrant colors.
${appearanceLine}
Character expression: ${expression}
Character clothing: ${character.nickname || character.name} is wearing ${clothing}
Photo type: ${typeDesc}
Current time: ${timeDescription || 'unknown'}
Current activity: ${activity}
Weather: ${weatherInfo || 'not specified'}

${chatContext ? `Recent conversation context:\n${chatContext}\n` : ''}${replyContext ? `The character's latest reply: "${replyContext}"\n` : ''}
CRITICAL RULES:
- The scene MUST match what the character is doing in the conversation (e.g., if she said she is painting, show her painting; if cooking, show cooking)
- The lighting MUST match the current time (e.g., if it's noon, use bright daylight, NOT sunset/night)
- The weather MUST match (e.g., if it's sunny, show clear sky; if rainy, show rain)
- The background MUST reflect the place mentioned in the conversation
- Do NOT use hardcoded time descriptions like "evening" or "sunset" unless the current time actually is evening
${hasRefImage ? '- Do NOT specify hair color, eye color, or facial features — the reference image defines these\n' : ''}
- Keep the prompt concise, 3-5 sentences, focusing on visual elements only`;
  }

  /**
   * 模板生成 prompt（无对话上下文时的兜底）
   */
  _templatePrompt(character, { type, activity, affection, timeDescription, appearance, expression, clothing, weatherInfo }) {
    const categoryMap = {
      selfie: 'selfie', selfie_grid: 'selfie_grid', portrait: 'portrait', activity: 'activity',
    };
    const category = categoryMap[type] || 'activity';
    const pool = this._templates[category];
    const template = pool?.[Math.floor(Math.random() * pool.length)];

    if (!template) {
      return this._fallbackPrompt(character, { type, activity, affection, replyContext: '', timeDescription, chatContext: '', weatherInfo });
    }

    console.log(`[ImageService] 选用模板: ${template.name} (${template.description})`);

    let prompt = template.prompt
      .replace(/{appearance}/g, appearance)
      .replace(/{expression}/g, expression)
      .replace(/{clothing}/g, clothing);

    if (weatherInfo) {
      prompt += ` [Weather constraint] ${weatherInfo}`;
    }

    return prompt;
  }

  /**
   * 根据角色风格 + 活动 + 时间生成穿着描述
   */
  _generateClothing(character, type, activity) {
    const visual = character.visual_features || {};
    const baseStyle = visual.style || 'casual everyday clothing';
    const hour = new Date().getHours();
    const archetype = character.archetype;

    // 基础穿着库（按原型，二次元风格）
    const wardrobe = {
      tsundere: [
        'an oversized black hoodie and ripped jeans, anime casual style',
        'a loose dark t-shirt and denim shorts, anime street fashion',
        'a black knit sweater and leggings, cozy anime style',
        'a cream-white loose sweater and wide-leg pants, anime aesthetic',
      ],
      loli: [
        'a pink pastel cardigan and white pleated skirt, cute anime outfit',
        'a cute oversized hoodie and shorts, kawaii anime style',
        'a JK uniform with a cardigan, anime schoolgirl look',
        'a white cotton dress with floral print, sweet anime style',
      ],
      oneesan: [
        'a silk blouse and tailored trousers, elegant anime style',
        'a cashmere sweater and wide-leg pants, mature anime fashion',
        'a fitted turtleneck and midi skirt, sophisticated anime look',
        'a casual blazer over a simple t-shirt, cool anime aesthetic',
      ],
      neighbor: [
        'a soft linen shirt and cotton midi skirt, gentle anime style',
        'a light blue denim jacket and white dress, fresh anime look',
        'a cozy knit sweater and jeans, warm anime casual',
        'a cotton sundress with a light cardigan, soft anime aesthetic',
      ],
    };

    const options = wardrobe[archetype] || [
      'casual everyday clothing',
      'a simple t-shirt and jeans',
      'a comfortable sweater and pants',
    ];

    // 根据时间微调
    let clothing = options[Math.floor(Math.random() * options.length)];
    if (hour >= 22 || hour < 6) {
      clothing = clothing.replace(/^(an|a)\s/i, '$1 oversized sleep shirt and cotton shorts, cozy nightwear');
    }

    return clothing;
  }

  /**
   * 内置兜底 prompt（模板加载失败时使用）
   */
  _fallbackPrompt(character, { type, activity, affection, replyContext, timeDescription, chatContext, weatherInfo }) {
    const visual = character.visual_features || {};
    const appearance = [
      visual.hair, visual.eyes,
    ].filter(Boolean).join(', ') || 'anime girl features';

    let expression;
    if (affection < 30) {
      expression = 'polite distant expression, looking away';
    } else if (affection < 60) {
      expression = 'gentle natural smile';
    } else {
      expression = 'bright warm smile, intimate gaze';
    }

    let prompt;
    if (type === 'selfie') {
      prompt = `Japanese anime art style, modern anime illustration, cel shading, clean line art, vibrant colors. A casual selfie of a cute anime girl. ${appearance}. ${expression}. She is currently: ${activity}. Warm lighting, slice-of-life anime atmosphere.`;
    } else {
      prompt = `Japanese anime art style, modern anime illustration, cel shading, clean line art, vibrant colors. An anime scene showing: ${activity}. Warm lighting, detailed anime background, slice-of-life atmosphere.`;
    }

    if (chatContext || replyContext) {
      const timeHint = timeDescription ? ` Current time: ${timeDescription}.` : '';
      let contextText = '';
      if (chatContext) {
        contextText = `Recent conversation: ${chatContext}.`;
      }
      if (replyContext) {
        contextText += ` Latest reply: "${replyContext}".`;
      }
      prompt += ` [Scene context]${contextText}${timeHint} The scene MUST match what she is doing in the conversation.`;
    }

    if (weatherInfo) {
      prompt += ` [Weather constraint] ${weatherInfo}`;
    }

    return prompt;
  }

  /**
   * 调用 DashScope Wanx 2.7 Image Pro 生成图片
   * @param {string} prompt - 文本提示词
   * @param {string|null} refImagePath - 角色参考图本地路径
   * @returns {string} 图片 URL
   */
  async generateImage(prompt, refImagePath = null) {
    console.log(`[ImageService] generateImage 开始, refImagePath=${refImagePath || '无'}, apiKey=${this._apiKey ? '已配置' : '未配置'}`);

    // 构建内容数组：有参考图时先放图片再放文字
    const content = [];

    if (refImagePath && fs.existsSync(refImagePath)) {
      const imageBuffer = fs.readFileSync(refImagePath);
      const base64 = imageBuffer.toString('base64');
      const ext = path.extname(refImagePath).toLowerCase().replace('.', '');
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      content.push({ image: `data:${mime};base64,${base64}` });
      console.log(`[ImageService] 已加载参考图: ${path.basename(refImagePath)} (${(imageBuffer.length / 1024).toFixed(0)}KB, mime=${mime})`);
    } else if (refImagePath) {
      console.warn(`[ImageService] 参考图路径存在但文件不存在: ${refImagePath}`);
    }

    // 文字提示词：有参考图时强化角色一致性约束
    const textPrompt = refImagePath
      ? `Reference image (图1) is the character's official appearance. You MUST strictly follow the reference image for: hair color, hair style, eye color, face shape, and overall character design. Do NOT change these features. Generate the following scene with this exact character: ${prompt}`
      : prompt;
    content.push({ text: textPrompt });

    const requestBody = {
      model: 'wan2.7-image-pro',
      input: {
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      },
      parameters: {
        size: '768*1024',
        n: 1,
        watermark: false,
      },
    };
    console.log(`[ImageService] 发送请求到 DashScope, content items=${content.length} (图片x${content.filter(c => c.image).length}, 文字x${content.filter(c => c.text).length})`);
    console.log(`[ImageService] 文字提示词 (前300字): ${textPrompt.slice(0, 300)}...`);

    const response = await fetch(DASHSCOPE_IMAGE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    console.log(`[ImageService] DashScope 响应状态: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const err = await response.text();
      console.error(`[ImageService] DashScope 错误响应: ${err.slice(0, 500)}`);
      throw new Error(`DashScope 图片生成失败 (${response.status}): ${err}`);
    }

    const result = await response.json();
    console.log(`[ImageService] DashScope 响应结构: output=${!!result.output}, choices=${result.output?.choices?.length}, content=${result.output?.choices?.[0]?.message?.content?.length}`);

    const imageUrl = result?.output?.choices?.[0]?.message?.content?.[0]?.image;
    if (!imageUrl) {
      console.error(`[ImageService] DashScope 响应中无图片 URL, 完整响应: ${JSON.stringify(result).slice(0, 500)}`);
      throw new Error('DashScope 响应中未找到图片 URL');
    }

    console.log(`[ImageService] 图片生成成功, URL: ${imageUrl.slice(0, 100)}...`);
    return imageUrl;
  }

  /**
   * 下载图片并保存到本地
   * @returns {string} 本地文件名
   */
  async downloadAndSave(imageUrl, userId, characterId) {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`下载图片失败 (${resp.status})`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const timestamp = Date.now();
    const filename = `${userId}_${characterId}_${timestamp}.jpg`;
    const filepath = path.join(PHOTOS_DIR, filename);

    fs.writeFileSync(filepath, buffer);
    console.log(`[ImageService] 图片已保存: ${filename}`);
    return filename;
  }

  /**
   * 生成拟人化配文
   */
  _generateCaption(character, type, activity) {
    const selfieCaptions = [
      `等下哈，我找下角度...`,
      `刚拍的，还没修图呢`,
      `你觉得这张怎么样？`,
      `给你看看~`,
      `刚刚随手拍的`,
      `嗯...这张还行吧`,
    ];

    const activityCaptions = [
      `给你看看我现在在做什么`,
      `拍了一张给你看看`,
      `我现在的视角就是这样的`,
      `这是我眼前看到的`,
      `随手拍了一张`,
    ];

    const gridCaptions = [
      `给你发一组今天的照片~`,
      `今天拍了好多张，发给你看看`,
      `选了几张还不错的`,
      `今天的照片合集嘿嘿`,
      `整理了一下今天的照片`,
    ];

    const portraitCaptions = [
      `这张是别人帮我拍的`,
      `今天出去玩被偷拍了哈哈`,
      `朋友给拍的，你觉得好看吗`,
      `有人帮我拍的，发你看看`,
    ];

    const pools = {
      selfie: selfieCaptions,
      activity: activityCaptions,
      selfie_grid: gridCaptions,
      portrait: portraitCaptions,
    };
    const pool = pools[type] || activityCaptions;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 将天气数据转为英文绘图约束
   */
  _buildWeatherHint(environment) {
    if (!environment?.weather) return null;
    const desc = environment.weather.description;
    const temp = environment.weather.tempC;
    const weatherMap = {
      'Sunny': 'It is a sunny day. Bright natural sunlight, clear blue sky, no rain.',
      'Clear': 'It is a clear day. Bright natural sunlight, clear sky, no rain.',
      'Partly cloudy': 'It is partly cloudy. Some clouds in the sky but still bright, no rain.',
      'Cloudy': 'It is a cloudy day. Overcast sky, soft diffused lighting, no rain.',
      'Overcast': 'It is heavily overcast. Gray sky, dim lighting, no rain.',
      'Mist': 'It is misty. Light fog in the air, hazy atmosphere, no rain.',
      'Fog': 'It is foggy. Dense fog, very low visibility, hazy, no rain.',
      'Light rain': 'It is raining lightly. Light rain, wet surfaces, rainy atmosphere.',
      'Moderate rain': 'It is raining. Moderate rain, wet surfaces, puddles, gloomy atmosphere.',
      'Heavy rain': 'It is raining heavily. Heavy rain, very wet, dark gloomy atmosphere.',
      'Light snow': 'It is snowing lightly. Light snowfall, white particles in the air.',
      'Heavy snow': 'It is snowing heavily. Heavy snowfall, white snowy atmosphere.',
      'Thunderstorm': 'It is thunderstorming. Dark sky, lightning, heavy rain.',
    };
    let hint = weatherMap[desc];
    if (!hint) {
      // 未在映射中的天气，用通用描述
      hint = `The weather is ${desc}. Match the visual atmosphere to this weather condition.`;
    }
    if (temp) {
      hint += ` Temperature is around ${temp}°C.`;
    }
    hint += ' The background and lighting MUST accurately reflect this weather. Do NOT show weather conditions that contradict the real weather.';
    return hint;
  }
}
