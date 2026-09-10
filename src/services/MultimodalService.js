/**
 * MultimodalService - TTS 语音合成（火山豆包语音）
 *
 * API: 单向流式语音合成 HTTP（seed-tts-2.0）
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   鉴权: X-Api-Key（火山新版控制台）
 *   响应: HTTP Chunked，多段 JSON，data 字段为 base64 音频分片
 * 音色: 运行时读角色档案 voice_preset（火山音色 ID，与实时通话通用）
 * 情绪/语气: 角色 speaking_style + 情绪指令经 context_texts 指令遵循注入（指令文字不计费）
 */
import crypto from 'crypto';
import { DEFAULT_SPEAKER } from './VoiceCatalog.js';

const TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

// 情绪 → 语音指令映射（沿用原 DashScope 版情绪语义）
const EMOTION_CONTEXT = {
  joyful: '你现在心情很好，用欢快上扬、带着笑意的语气说话',
  happy: '你现在心情不错，用温暖轻快、带着微笑的语气说话',
  uneasy: '你现在很不高兴，用冷淡、不耐烦的语气说话，句子变短',
  angry: '你现在特别生气，用压着火、每个字都带怒气的语气说话',
  cold_war: '你现在极度冷淡，用平直、敷衍、惜字如金、不想搭理人的语气说话',
};

export class MultimodalService {
  /** @param {{ apiKey: string, resourceId?: string, characterManager: object }} config */
  constructor({ apiKey, resourceId = 'seed-tts-2.0', characterManager }) {
    this._apiKey = apiKey;
    this._resourceId = resourceId || 'seed-tts-2.0';
    this._characterManager = characterManager;
  }

  /** 运行时刷新配置（设置保存后立即生效） */
  updateConfig({ apiKey, resourceId }) {
    if (apiKey) this._apiKey = apiKey;
    if (resourceId) this._resourceId = resourceId;
  }

  /** 角色音色：voice_preset 优先，缺省回退默认音色 */
  _resolveSpeaker(characterId) {
    const c = this._characterManager?.getCharacter(characterId);
    return (c?.voice_preset && String(c.voice_preset).trim()) || DEFAULT_SPEAKER;
  }

  /** 组装 context_texts：角色说话风格 + 当前情绪指令 */
  _buildContexts(characterId, emotionState) {
    const c = this._characterManager?.getCharacter(characterId);
    const contexts = [];
    const style = c?.speaking_style && String(c.speaking_style).trim();
    if (style) contexts.push(`你的说话风格：${style}。请始终用这种风格说话`);
    const emotionHint = EMOTION_CONTEXT[emotionState];
    if (emotionHint) contexts.push(emotionHint);
    return contexts;
  }

  /**
   * 语音合成
   * @param {{ text: string, characterId: string, emotionState?: string, speaker?: string }} params
   * @returns {Promise<Buffer>} mp3 audio buffer
   */
  async synthesizeSpeech({ text, characterId, emotionState = 'calm', speaker }) {
    const voice = (speaker && speaker.trim()) || this._resolveSpeaker(characterId);
    const context_texts = this._buildContexts(characterId, emotionState);

    const t0 = Date.now();
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Api-Key': this._apiKey,
        'X-Api-Resource-Id': this._resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
      },
      body: JSON.stringify({
        req_params: {
          text,
          speaker: voice,
          audio_params: { format: 'mp3', sample_rate: 24000 },
          ...(context_texts.length ? { context_texts } : {}),
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(this._explainError(response.status, errText));
    }

    const buffer = await this._collectAudio(response);
    console.log(`[MultimodalService] TTS 完成: voice=${voice}, emotion=${emotionState}, ${text.length}字, ${Date.now() - t0}ms, ${buffer.length}B`);
    return buffer;
  }

  /** 读取 chunked 响应体，解析多段 JSON，拼接 base64 音频分片 */
  async _collectAudio(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();

    const chunks = [];
    for (const seg of this._splitJsonObjects(raw)) {
      if (seg.data) {
        chunks.push(Buffer.from(seg.data, 'base64'));
      // 20000000 为火山成功结束帧（OK，data 为 null），不算错误
      } else if (seg.code !== undefined && seg.code !== 0 && seg.code !== 20000000) {
        throw new Error(`火山 TTS 分片错误 code=${seg.code}: ${seg.message || ''}`);
      }
    }
    if (!chunks.length) {
      throw new Error(`火山 TTS 响应中无音频数据: ${raw.slice(0, 200)}`);
    }
    return Buffer.concat(chunks);
  }

  /** 按括号配平从流式文本中切出完整 JSON 对象（容忍半包/粘包/字符串内花括号） */
  _splitJsonObjects(raw) {
    const objects = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try { objects.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* 跳过坏段 */ }
          start = -1;
        }
      }
    }
    return objects;
  }

  /** 错误信息翻译：把火山错误码转成用户可操作的提示 */
  _explainError(status, body) {
    let code, msg = '';
    try { const j = JSON.parse(body); code = j?.header?.code ?? j?.code; msg = j?.header?.message ?? j?.message ?? ''; } catch { /* 保留原文 */ }
    if (status === 401) return '火山 TTS 鉴权失败(401)：请检查设置页的火山 API Key';
    if (code === 45000030 || /not granted/i.test(msg)) return '资源未开通(45000030)：请在火山控制台开通「豆包语音合成大模型 2.0」';
    if (/InvalidSpeaker/i.test(msg)) return `音色 ID 无效：请检查角色档案的 voice_preset`;
    return `火山 TTS 失败 (HTTP ${status})${code ? ` code=${code}` : ''}: ${msg || String(body).slice(0, 160)}`;
  }
}
