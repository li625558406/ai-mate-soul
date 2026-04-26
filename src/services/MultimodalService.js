/**
 * MultimodalService - 多模态感官集成
 *
 * TTS: 阿里云 DashScope Qwen3-TTS-Instruct-Flash API
 * 每个角色绑定固定音色，音色匹配角色性格
 * 支持 instructions 参数控制情感、语速、语调
 * 非流式模式：API 返回音频 URL → 下载音频 → 返回 Buffer
 */
export class MultimodalService {
  constructor({ apiKey }) {
    this._apiKey = apiKey;
    this._baseUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
    this._model = 'qwen3-tts-instruct-flash';

    // 角色 → 音色 + 基础情感指令
    this._characterVoices = {
      reina_001: {
        voice: 'Cherry',
        label: '芊悦（阳光积极、亲切自然小姐姐）',
        baseInstruction: '傲娇女生，说话带着小脾气，偶尔毒舌但内心温柔，语速偏快，语调有起伏，带点小傲娇的尾音',
      },
      miku_002: {
        voice: 'Chelsie',
        label: '千雪（二次元虚拟女友）',
        baseInstruction: '活泼可爱的元气少女，说话充满活力，语速较快，语调上扬，偶尔带点撒娇的语气',
      },
      yuki_003: {
        voice: 'Maia',
        label: '四月（知性与温柔的碰撞）',
        baseInstruction: '成熟知性的御姐，说话沉稳有磁性，语速适中，语调温柔但有力，偶尔带点慵懒',
      },
      lin_004: {
        voice: 'Serena',
        label: '苏瑶（温柔小姐姐）',
        baseInstruction: '温柔体贴的邻家姐姐，说话轻柔细腻，语速偏慢，语调温暖甜美，像贴心朋友般关怀',
      },
    };

    // 情绪 → 情感指令映射
    this._emotionInstructions = {
      calm: '',
      joyful: '语气欢快，语调上扬，带着笑意，说话轻快活泼',
      happy: '语气温暖，语调轻快，带着微笑',
      uneasy: '语气明显冷淡，语调下沉，说话变短，带着不满和不耐烦',
      angry: '语气带刺，语调压低，语速变慢但每个字都带着怒气，像在压着火说话',
      cold_war: '极度冷淡，惜字如金，语调平直没有感情，像在敷衍不想搭理的人',
    };
  }

  /**
   * 语音合成
   * @param {{ text: string, characterId: string, emotionState?: string }} params
   * @returns {Promise<Buffer>} audio buffer
   */
  async synthesizeSpeech({ text, characterId, emotionState = 'calm' }) {
    const voiceConfig = this._characterVoices[characterId] || this._characterVoices.reina_001;

    // 构建情感指令：基础性格 + 当前情绪
    let instructions = voiceConfig.baseInstruction;
    const emotionHint = this._emotionInstructions[emotionState];
    if (emotionHint) {
      instructions += '。' + emotionHint;
    }

    const requestBody = {
      model: this._model,
      input: {
        text,
        voice: voiceConfig.voice,
        language_type: 'Chinese',
      },
      parameters: {
        instructions,
        optimize_instructions: true,
      },
    };

    console.log(`[MultimodalService] TTS 请求: voice=${voiceConfig.voice}, emotion=${emotionState}, instructions="${instructions.slice(0, 80)}..."`);

    const response = await fetch(this._baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DashScope TTS 失败 (${response.status}): ${errText}`);
    }

    const result = await response.json();

    const audioUrl = result?.output?.audio?.url;
    if (!audioUrl) {
      throw new Error(`DashScope TTS 响应中未找到音频 URL: ${JSON.stringify(result).slice(0, 200)}`);
    }

    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      throw new Error(`下载音频失败 (${audioResp.status}): ${audioUrl}`);
    }

    const arrayBuffer = await audioResp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  getCharacterVoice(characterId) {
    const config = this._characterVoices[characterId];
    if (!config) return null;
    return { characterId, voice: config.voice, label: config.label };
  }

  getVoicePresets() {
    return Object.entries(this._characterVoices).map(([characterId, config]) => ({
      characterId,
      voice: config.voice,
      label: config.label,
    }));
  }
}
