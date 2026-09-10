# 火山豆包语音集成实施计划（TTS + 实时通话 + 每角色音色）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完全替换 DashScope 语音为火山豆包语音：TTS 走 unidirectional HTTP、实时通话走 Seeduplex WebSocket，音色从角色档案 `voice_preset` 读取，角色编辑器可视化选音色+试听。

**Architecture:** `MultimodalService` 对外签名不变只换实现；`VoiceCallService` 保持 Socket.IO 事件协议只换上游协议；新增 `VoiceCatalog.js` 作为音色清单唯一源（`/api/voices` 下发）；`voice_preset` 字段复用角色档案既有字段（设计文档中的 `voice` 对象简化为既有 `voice_preset` 字符串 + 既有 `speaking_style` 字段做语气指令，语义等价且改动更小）。

**Tech Stack:** Node.js 18+ ESM（原生 fetch / WebSocket via `ws`）、Express、Socket.IO、原生 HTML/CSS/JS 前端。

**设计文档:** `docs/superpowers/specs/2026-09-10-volcengine-tts-design.md`

**关键协议事实（已从官方文档核实）:**
- TTS: `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`，头 `X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0` + `X-Api-Request-Id`（UUID）；体 `{req_params:{text, speaker, audio_params:{format,sample_rate}, context_texts?}}`；响应 HTTP Chunked 多段 JSON，`data` 为 base64 分片
- 实时通话: `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`，纯 JSON 帧；`session.create` 载荷 `voice` 在 `session.audio.output.voice`，`session.model` 固定 `"1.2.6.1"`；输入 PCM 16k 须按 20ms/640B 节奏转发；静音须发 `input_audio_mute.commit` / 恢复发 `input_audio_unmute.commit`；挂断先 `session.close` 等确认再断（否则 ContextCanceled 55000001）
- 下行事件: `session.created` / `response.output_audio.delta`（base64）/ `response.output_audio.done` / `response.output_text.delta` / `response.output_text.done` / `conversation.item.input_audio_transcription.completed` / `error`

**验证方式说明:** 本项目无测试框架（见项目 CLAUDE.md）。每任务用 `node --check` 做语法验证、`.scratch/` 下临时脚本或 curl 做接口验证、启动服务做手动验证。**注意：火山「豆包语音合成大模型 2.0」与「端到端实时语音大模型」资源尚未开通（实测 403 code=45000030），涉及真实调用的验证以"错误信息正确指向资源未开通"为通过标准，真实合成联调见 Task 11。**

**凭据:** 火山 API Key `***REDACTED***`（用户提供，Task 9 后写入 `data/settings.json`，该文件已被 gitignore，严禁写入任何被 git 跟踪的文件）。

---

### Task 1: VoiceCatalog 音色清单模块 + `/api/voices` 改造

**Files:**
- Create: `src/services/VoiceCatalog.js`
- Modify: `src/index.js:519-521`（`/api/voices` 路由）、`src/index.js:23` 附近（import 区）

- [ ] **Step 1: 创建 `src/services/VoiceCatalog.js`**

```js
/**
 * VoiceCatalog - 火山豆包语音音色清单（唯一源）
 *
 * 音色 ID 与 TTS 2.0（seed-tts-2.0）、实时语音（Seeduplex S2S）两通道通用。
 * 通过 GET /api/voices 下发给前端角色编辑器。火山官方无"列出音色"API，
 * 清单从官方音色列表文档精选维护（2026-09-10 版本）。
 * 支持声音复刻：用户可在角色编辑器选"自定义"直接填复刻音色 ID。
 */
export const DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts'; // Vivi 2.0

export const VOICE_CATALOG = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', tag: '通用，多方言' },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0', tag: '知性' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 2.0', tag: '撒娇' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 2.0', tag: '甜美' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 2.0', tag: '甜美' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0', tag: '爽朗' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0', tag: '邻家' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐 2.0', tag: '御姐' },
  { id: 'zh_female_wenrouxiaoya_uranus_bigtts', name: '温柔小雅 2.0', tag: '温柔' },
  { id: 'zh_female_roumeinvyou_uranus_bigtts', name: '柔美女友 2.0', tag: '女友感' },
  { id: 'ICL_uranus_zh_female_xingganmeihuo_tob', name: '性感魅惑 2.0', tag: '魅惑' },
  { id: 'ICL_uranus_zh_female_qinglenggaoya_tob', name: '清冷高雅 2.0', tag: '清冷' },
  { id: 'ICL_uranus_zh_female_aojiaonvyou_tob', name: '傲娇女友 2.0', tag: '傲娇' },
  { id: 'ICL_uranus_zh_female_bingjiaojiejie_tob', name: '病娇姐姐 2.0', tag: '病娇' },
  { id: 'ICL_uranus_zh_female_chengshujiejie_tob', name: '成熟姐姐 2.0', tag: '成熟' },
  { id: 'ICL_uranus_zh_female_keainvsheng_tob', name: '可爱女生 2.0', tag: '可爱' },
  { id: 'ICL_uranus_zh_female_nuanxinxuejie_tob', name: '暖心学姐 2.0', tag: '暖心' },
  { id: 'ICL_uranus_zh_female_huoponvhai_tob', name: '活泼女孩 2.0', tag: '活泼' },
  { id: 'ICL_uranus_zh_female_jiaoruoluoli_tob', name: '娇弱萝莉 2.0', tag: '萝莉' },
  { id: 'ICL_uranus_zh_female_wumeikeren_tob', name: '妩媚可人 2.0', tag: '妩媚' },
];
```

- [ ] **Step 2: `src/index.js` 顶部 import 区（line 24 附近）加一行**

```js
import { VOICE_CATALOG } from './services/VoiceCatalog.js';
```

- [ ] **Step 3: 替换 `/api/voices` 路由（原 line 519-521）**

旧代码：
```js
app.get('/api/voices', (_req, res) => {
  res.json({ voices: multimodalService.getVoicePresets() });
});
```

新代码：
```js
app.get('/api/voices', (_req, res) => {
  res.json({ voices: VOICE_CATALOG });
});
```

- [ ] **Step 4: 语法验证**

Run: `node --check src/index.js && node --check src/services/VoiceCatalog.js`
Expected: 无输出（通过）

- [ ] **Step 5: 启动验证**

Run: `npm start`（后台），然后 `curl -s http://localhost:3000/api/voices | head -c 300`
Expected: `{"voices":[{"id":"zh_female_vv_uranus_bigtts","name":"Vivi 2.0",...`。验证完停掉服务。

注意：此时 `MultimodalService` 还没改，`getVoicePresets()` 已无人调用（Task 3 删除它），服务可正常启动。

- [ ] **Step 6: Commit**

```bash
git add src/services/VoiceCatalog.js src/index.js
git commit -m "feat(voice): 新增火山音色清单模块，/api/voices 下发精选音色目录"
```

---

### Task 2: SettingsManager tts 段改为火山字段

**Files:**
- Modify: `src/services/SettingsManager.js:9`（DEFAULT_SETTINGS）、`_migrateOldFormat()` 附近

- [ ] **Step 1: 修改 DEFAULT_SETTINGS（line 9）**

旧：
```js
  tts: { baseURL: '', apiKey: '' },
```
新：
```js
  tts: { apiKey: '', resourceId: 'seed-tts-2.0' },
```

- [ ] **Step 2: `_migrateOldFormat()` 末尾追加迁移（清理 DashScope 遗留字段）**

```js
    // Migrate: TTS 从 DashScope 切到火山豆包，baseURL 字段已废弃
    if (this._data.tts?.baseURL !== undefined) delete this._data.tts.baseURL;
```

- [ ] **Step 3: 语法验证**

Run: `node --check src/services/SettingsManager.js`
Expected: 通过

- [ ] **Step 4: 行为验证（一次性脚本，写 `.scratch/verify-settings.cjs`）**

```js
process.chdir(require('path').resolve(__dirname, '..'));
const { execSync } = require('child_process');
// 直接跑一段 ESM 内联验证较繁琐，改用服务级验证：node --input-type=module
```
简化：直接启动 `npm start`，确认日志无异常、`data/settings.json` 中 `tts` 段变成 `{"apiKey":"...","resourceId":"seed-tts-2.0"}` 且无 `baseURL` 键。验证完停服务。

- [ ] **Step 5: Commit**

```bash
git add src/services/SettingsManager.js
git commit -m "chore(settings): tts 段从 DashScope baseURL 切换为火山 resourceId"
```

---

### Task 3: MultimodalService 换火山 unidirectional TTS

**Files:**
- Modify: `src/services/MultimodalService.js`（整文件重写，137 行 → 约 150 行）
- Modify: `src/index.js:67`（实例化）、`src/index.js:761`（设置热更新）

- [ ] **Step 1: 整文件重写 `src/services/MultimodalService.js`**

```js
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
    this._resourceId = resourceId;
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
      } else if (seg.code !== undefined && seg.code !== 0) {
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
```

注意：删除了旧版的 `_characterVoices`、`_normalizeBaseURL`、`getCharacterVoice()`、`getVoicePresets()`（`/api/voices` 已在 Task 1 改用 VoiceCatalog；全库无其他调用方，已核实 `src/index.js` 中 `multimodalService` 仅出现在 67/510/520/761 行）。

- [ ] **Step 2: `src/index.js:67` 实例化改造**

旧：
```js
const multimodalService = new MultimodalService({ apiKey: settings.tts.apiKey, baseURL: settings.tts.baseURL });
```
新：
```js
const multimodalService = new MultimodalService({ apiKey: settings.tts.apiKey, resourceId: settings.tts.resourceId, characterManager });
```
（`characterManager` 在 line 58 声明，顺序安全。）

- [ ] **Step 3: `src/index.js:761` 设置热更新改造**

旧：
```js
  multimodalService.updateConfig({ apiKey: raw.tts.apiKey, baseURL: raw.tts.baseURL });
```
新：
```js
  multimodalService.updateConfig({ apiKey: raw.tts.apiKey, resourceId: raw.tts.resourceId });
```

- [ ] **Step 4: 语法验证**

Run: `node --check src/index.js && node --check src/services/MultimodalService.js`
Expected: 通过

- [ ] **Step 5: 接口验证（资源未开通，以错误翻译正确为通过标准）**

启动 `npm start`，然后：
```bash
curl -s -X POST http://localhost:3000/api/tts -H "Content-Type: application/json" -d '{"text":"你好","characterId":"reina_001"}'
```
Expected: `{"error":"TTS 失败: 资源未开通(45000030)：请在火山控制台开通「豆包语音合成大模型 2.0」"}`（Key 有效、资源未开通时的正确路径）。验证完停服务。

- [ ] **Step 6: 对抗性验证脚本（`.scratch/test-unidirectional-parse.cjs`）**

针对 `_splitJsonObjects` 的纯函数级对抗测试（不依赖网络）：

```js
// 从服务源码中取出解析函数做单测（复制粘贴同源实现，避免 ESM import 障碍）
const src = require('fs').readFileSync('src/services/MultimodalService.js', 'utf-8');
const fnSrc = src.match(/_splitJsonObjects\(raw\) \{[\s\S]*?\n  \}/)[0];
const fn = new Function('raw', fnSrc.replace('_splitJsonObjects(raw) {', '').replace(/\n  \}$/, '') + '; return objects;').call(null);

const cases = [
  ['单对象', '{"data":"aGk="}', 1],
  ['两对象粘包', '{"data":"aGk="}{"data":"aGk="}', 2],
  ['字符串内花括号', '{"data":"eyJhIjoieyJ9", "sentence":{"text":"{怪字符}"}}', 1],
  ['字符串内转义引号', '{"data":"aGk=","sentence":{"text":"他说\\"你好\\""}}', 1],
  ['坏段混入', '{"data":"aGk="} NOT_JSON {"data":"aGk="}', 2],
  ['空输入', '', 0],
  ['半包(不完整)', '{"data":"aGk="},{"data":', 1],
];
let fail = 0;
for (const [name, input, expect] of cases) {
  const out = fn(input);
  const ok = out.length === expect;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${out.length}, want ${expect}`);
}
process.exit(fail ? 1 : 0);
```

Run: `node .scratch/test-unidirectional-parse.cjs`
Expected: 全部 PASS。验证完删除该脚本（或留在 .scratch，已被 gitignore）。

- [ ] **Step 7: Commit**

```bash
git add src/services/MultimodalService.js src/index.js
git commit -m "feat(tts): MultimodalService 切换火山豆包 unidirectional TTS，音色读角色档案 voice_preset"
```

---

### Task 4: `/api/tts` 支持 speaker 试听覆盖

**Files:**
- Modify: `src/index.js:500-517`（`/api/tts` 路由）

- [ ] **Step 1: 路由增加可选 `speaker` 参数（角色编辑器试听未保存音色用）**

旧：
```js
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
```

新：
```js
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
```

- [ ] **Step 2: 语法验证 + 边界验证**

Run: `node --check src/index.js`
Expected: 通过

启动服务后：
```bash
curl -s -X POST http://localhost:3000/api/tts -H "Content-Type: application/json" -d '{"text":"你好","characterId":"__preview__","speaker":""}'
```
Expected: `{"error":"speaker 非法"}`（空 speaker 被拒）

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat(tts): /api/tts 支持可选 speaker 覆盖，供角色编辑器试听未保存音色"
```

---

### Task 5: 设置校验 tts 分支改火山探测 + 启动日志

**Files:**
- Modify: `src/index.js:817-831`（`/api/settings/test` 的 tts 分支）、`src/index.js:964-966`（启动日志）、`src/index.js` import 区（新增 crypto）

- [ ] **Step 0: import 区新增（`crypto` 当前未被 index.js 导入，已核实）**

```js
import crypto from 'crypto';
```

- [ ] **Step 1: 替换 tts 校验分支**

旧（line 817-831）：
```js
    if (kind === 'tts') {
      const r = await fetch(dashscopeUrl(baseURL, TTS_URL), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3-tts-instruct-flash',
          input: { text: '你好', voice: 'Cherry', language_type: 'Chinese' },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.json({ ok: false, message: `HTTP ${r.status}: ${JSON.stringify(data).slice(0, 120)}` });
      return data?.output?.audio?.url
        ? res.json({ ok: true, message: 'Key 有效，测试语音合成成功' })
        : res.json({ ok: false, message: `响应异常: ${JSON.stringify(data).slice(0, 120)}` });
    }
```

新：
```js
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
        let j = {}; try { j = JSON.parse(body); } catch { /* ok */ }
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
```

同时删除该路由中已无人使用的 DashScope 辅助（仅当确认 `dashscopeUrl` 与 `TTS_URL` 不再被其他分支引用时）：检查 line 784-789，`dashscopeUrl`/`TTS_URL` 只被旧 tts 分支使用 → 一并删除这两段。

- [ ] **Step 2: 更新启动日志（line 964、966）**

旧：
```js
  console.log(`  TTS: DashScope Qwen3-TTS${settingsManager.getRaw().tts.apiKey ? '' : ' (未配置API Key)'}`);
```
```js
  console.log(`  Voice Call: DashScope Qwen-Omni-Realtime${settingsManager.getRaw().tts.apiKey ? '' : ' (未配置API Key)'}`);
```
新：
```js
  console.log(`  TTS: 火山豆包语音 seed-tts-2.0${settingsManager.getRaw().tts.apiKey ? '' : ' (未配置API Key)'}`);
```
```js
  console.log(`  Voice Call: 火山豆包实时语音 Seeduplex${settingsManager.getRaw().tts.apiKey ? '' : ' (未配置API Key)'}`);
```

- [ ] **Step 3: 语法验证**

Run: `node --check src/index.js`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat(settings): TTS 校验与启动日志切换为火山豆包语音"
```

---

### Task 6: 前端设置弹窗 TTS 字段改造

**Files:**
- Modify: `public/index.html:508-512`（TTS api-card）、`:1804`（loadSettings）、`:1832`（testSettings sectionByKind）、`:2394-2397`（saveSettings body）

- [ ] **Step 1: 替换 TTS 卡片 HTML（line 508-512）**

旧：
```html
      <div class="api-card" style="border-left:4px solid #3cb878">
        <div class="api-title">&#128266; TTS / 语音 API <span id="stTtsStatus"></span><button class="btn-cancel" style="margin-left:auto;padding:3px 10px;font-size:11px" onclick="testSettings('tts')">校验</button></div>
        <div class="field"><label>Base URL</label><input type="text" id="stTtsUrl" placeholder="https://dashscope.aliyuncs.com" autocomplete="off"><div class="hint">语音专用地址，留空使用默认 DashScope；只填主机自动补路径</div></div>
        <div class="field"><label>API Key</label><input type="password" id="stTtsKey" placeholder="sk-..." autocomplete="off"></div>
      </div>
```

新：
```html
      <div class="api-card" style="border-left:4px solid #3cb878">
        <div class="api-title">&#128266; TTS / 语音 API（火山豆包）<span id="stTtsStatus"></span><button class="btn-cancel" style="margin-left:auto;padding:3px 10px;font-size:11px" onclick="testSettings('tts')">校验</button></div>
        <div class="field"><label>API Key</label><input type="password" id="stTtsKey" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off"><div class="hint">火山新版控制台（console.volcengine.com/speech/new）→ API Key 管理获取；TTS 与语音通话共用</div></div>
        <div class="field"><label>Resource ID（高级）</label><input type="text" id="stTtsResourceId" placeholder="seed-tts-2.0" autocomplete="off"><div class="hint">留空使用默认 seed-tts-2.0</div></div>
      </div>
```

- [ ] **Step 2: loadSettings（line 1804-1805）**

旧：
```js
    document.getElementById('stTtsUrl').value = s.tts?.baseURL || '';
    document.getElementById('stTtsKey').value = s.tts?.apiKey || '';
```
新：
```js
    document.getElementById('stTtsKey').value = s.tts?.apiKey || '';
    document.getElementById('stTtsResourceId').value = s.tts?.resourceId || '';
```

- [ ] **Step 3: testSettings sectionByKind（line 1832）**

旧：
```js
    tts:   { baseURL: sec('stTtsUrl'),   apiKey: sec('stTtsKey') },
```
新：
```js
    tts:   { apiKey: sec('stTtsKey'), resourceId: sec('stTtsResourceId') },
```

- [ ] **Step 4: saveSettings body（line 2394-2397）**

旧：
```js
    tts: {
      baseURL: document.getElementById('stTtsUrl').value.trim(),
      apiKey: document.getElementById('stTtsKey').value.trim(),
    },
```
新：
```js
    tts: {
      apiKey: document.getElementById('stTtsKey').value.trim(),
      resourceId: document.getElementById('stTtsResourceId').value.trim(),
    },
```

- [ ] **Step 5: 手动验证**

启动服务，浏览器打开 `http://localhost:3000`，打开设置弹窗：确认 TTS 卡片显示新字段、加载 `data/settings.json` 已有值、保存后 `data/settings.json` 的 tts 段正确。注意页面有 Service Worker 缓存（soul-v8），强刷（Ctrl+Shift+R）确保加载最新 HTML。

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 设置弹窗 TTS 区切换为火山 API Key + Resource ID"
```

---

### Task 7: 角色编辑器音色下拉 + 自定义 + 试听

**Files:**
- Modify: `public/index.html:634`（声音 preset 输入框）、`:1984`（openCharEditor 填值）、`:2004`（gatherCeProfile 取值）、JS 区新增辅助函数

- [ ] **Step 1: 替换音色输入框 HTML（line 634）**

旧：
```html
      <div class="field"><label>声音 preset（TTS）</label><input type="text" id="ceVoice" placeholder="Jennifer" autocomplete="off"></div>
```

新：
```html
      <div class="field"><label>语音音色（TTS 与语音通话通用）</label>
        <div style="display:flex;gap:8px">
          <select id="ceVoiceSelect" style="flex:1"></select>
          <button class="btn-cancel" onclick="previewCeVoice()" title="试听当前选择">&#9654; 试听</button>
        </div>
        <input type="text" id="ceVoice" placeholder="自定义火山音色 ID（如声音复刻音色）" autocomplete="off" style="display:none;margin-top:6px">
      </div>
```

- [ ] **Step 2: JS 辅助函数（放在角色编辑器函数区，`gatherCeProfile` 附近）**

```js
// ==================== 音色选择 ====================

let voiceCatalogCache = null;
async function loadVoiceCatalog() {
  if (voiceCatalogCache) return voiceCatalogCache;
  try {
    const res = await fetch(API + '/api/voices');
    const data = await res.json();
    voiceCatalogCache = data.voices || [];
  } catch { voiceCatalogCache = []; }
  return voiceCatalogCache;
}

// 填充音色下拉；current 为角色已存音色 ID，不在清单中时切自定义输入框
async function populateCeVoiceSelect(current) {
  const select = document.getElementById('ceVoiceSelect');
  const custom = document.getElementById('ceVoice');
  const catalog = await loadVoiceCatalog();
  select.innerHTML = '';
  for (const v of catalog) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.name}（${v.tag}）`;
    select.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '自定义音色 ID…';
  select.appendChild(customOpt);

  const isKnown = catalog.some(v => v.id === current);
  if (current && !isKnown) {
    select.value = '__custom__';
    custom.style.display = '';
    custom.value = current;
  } else {
    custom.style.display = 'none';
    custom.value = '';
    if (current) select.value = current;
  }
}

function resolveCeVoice() {
  const v = document.getElementById('ceVoiceSelect').value;
  if (v === '__custom__') return document.getElementById('ceVoice').value.trim();
  return v;
}

async function previewCeVoice() {
  const speaker = resolveCeVoice();
  if (!speaker) {
    const resultEl = document.getElementById('ceResult');
    resultEl.className = 'result error';
    resultEl.textContent = '请先选择或填写音色 ID';
    return;
  }
  try {
    // 未保存的新角色用 __preview__ 占位（后端 speaker 覆盖优先于角色档案）
    const res = await fetch(API + '/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '嗨，这是我用这个声音和你说话哦～', characterId: ceState.profile.id || '__preview__', userId: uid, speaker }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const blob = await res.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    audio.onended = () => URL.revokeObjectURL(audio.src);
    audio.play();
  } catch (e) {
    const resultEl = document.getElementById('ceResult');
    resultEl.className = 'result error';
    resultEl.textContent = '试听失败: ' + e.message;
  }
}

// 自定义选项切换输入框显隐
document.getElementById('ceVoiceSelect')?.addEventListener('change', (e) => {
  document.getElementById('ceVoice').style.display = e.target.value === '__custom__' ? '' : 'none';
});
```

（`uid`、`ceState`、`ceResult`、`API` 均为该文件既有全局量，已核实存在。）

- [ ] **Step 3: openCharEditor（line 1984）**

旧：
```js
  document.getElementById('ceVoice').value = p.voice_preset || '';
```
新：
```js
  populateCeVoiceSelect(p.voice_preset || '');
```

- [ ] **Step 4: gatherCeProfile（line 2004）**

旧：
```js
  p.voice_preset = document.getElementById('ceVoice').value.trim();
```
新：
```js
  p.voice_preset = resolveCeVoice();
```

- [ ] **Step 5: 手动验证**

启动服务，打开角色管理 → 编辑任一角色：
1. 音色下拉出现 20 个音色 + 自定义选项
2. 切到「自定义音色 ID…」出现输入框，切回消失
3. 点试听：资源已开通则播放语音；未开通则 ceResult 显示"资源未开通"提示（当前阶段的通过标准）
4. 选音色保存后重新打开编辑器，选中态保持；`data/characters/<id>/<id>.json` 的 `voice_preset` 已更新

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 角色编辑器音色下拉选择 + 自定义音色 ID + 试听"
```

---

### Task 8: VoiceCallService 换火山 Seeduplex

**Files:**
- Modify: `src/services/VoiceCallService.js`（多处修改，见下）

- [ ] **Step 1: 文件头注释与常量（line 1-11）**

旧：
```js
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
```

新：
```js
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
const SEEDUPLEX_MODEL = '1.2.6.1';
const PACER_INTERVAL_MS = 20;   // 协议要求的 20ms 转发节奏
const PACER_CHUNK_BYTES = 640;  // 16k/int16 下 20ms 对应字节数
const PACER_MAX_QUEUE = 48000;  // 队列积压上限（3 秒音频），超出丢最旧防延迟滚雪球
```

- [ ] **Step 2: 删除 CHARACTER_VOICE_CONFIG（line 13-31），替换为取音色辅助**

删除整个 `const CHARACTER_VOICE_CONFIG = {...};`，在原位置加：
```js
// 角色音色：读角色档案 voice_preset，缺省回退默认音色（与 TTS 通道同一来源）
function resolveSpeaker(characterManager, characterId) {
  const c = characterManager.getCharacter(characterId);
  return (c?.voice_preset && String(c.voice_preset).trim()) || DEFAULT_SPEAKER;
}
```

- [ ] **Step 3: startCall 中音色与连接部分（line 84-133）**

旧：
```js
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
```

新：
```js
    const speaker = resolveSpeaker(this._characterManager, characterId);

    // 构建系统提示词
    const systemPrompt = this._buildSystemPrompt({ userId, characterId, character });

    // 建立火山 Seeduplex WebSocket 连接（X-Api-Key 单头鉴权，同 TTS）
    const ws = new WebSocket(VOLCANO_REALTIME_URL, {
      headers: {
        'X-Api-Key': this._apiKey,
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
```

- [ ] **Step 4: stopCall 改为 session.close 优雅关闭（line 162-171）**

旧：
```js
  stopCall(socketId) {
    const call = this._calls.get(socketId);
    if (!call) return;

    if (call.ws && call.ws.readyState === WebSocket.OPEN) {
      call.ws.close(1000, '用户挂断');
    }

    this._cleanupCall(socketId);
  }
```

新：
```js
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
```

- [ ] **Step 5: sendAudio 改为入队 + 静音声明（line 186-197）**

旧：
```js
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
```

新：
```js
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
```

- [ ] **Step 6: `_buildSystemPrompt` 去掉 voiceConfig 参数（line 209）**

签名与调用保持一致即可：方法定义改为

```js
  _buildSystemPrompt({ userId, characterId, character }) {
```

方法体其余不动（`speaking_style` 等人设已由 `DynamicPromptBuilder` 从角色档案注入，无需旧版手工拼接的 voiceConfig.instructions）。

- [ ] **Step 7: `_handleDashScopeEvent` 重命名为 `_handleVolcanoEvent` 并适配事件（line 257-335）**

完整替换为：

```js
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
```

- [ ] **Step 8: `_cleanupCall` 防重复发 ended（line 411-421）**

旧：
```js
    if (call.socket) {
      call.socket.emit('voice_call:ended', { duration: Math.round((Date.now() - call.startTime) / 1000) });
    }
```
新：
```js
    this._stopPacer(call);
    if (call.socket && !call.endEmitted) {
      call.endEmitted = true;
      call.socket.emit('voice_call:ended', { duration: Math.round((Date.now() - call.startTime) / 1000) });
    }
```

- [ ] **Step 9: 语法验证**

Run: `node --check src/services/VoiceCallService.js`
Expected: 通过

- [ ] **Step 10: 握手验证脚本（`.scratch/test-duplex-handshake.cjs`，资源未开通时验证鉴权路径）**

```js
// 验证 Seeduplex WebSocket 鉴权与握手（资源未开通时应收到明确的 error 事件而非 401 拒绝升级）
import WebSocket from 'ws';
const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', {
  headers: { 'X-Api-Key': '***REDACTED***' },
});
const timer = setTimeout(() => { console.log('TIMEOUT: 10s 无响应'); process.exit(2); }, 10000);
ws.on('open', () => {
  console.log('WS 已连接（鉴权通过）');
  ws.send(JSON.stringify({
    type: 'session.create',
    session: {
      model: '1.2.6.1',
      instructions: '你是测试助手',
      audio: {
        input: { format: { type: 'pcm', rate: 16000 } },
        output: { format: { type: 'pcm', rate: 24000 }, speed: 0, loudness: 0, voice: 'zh_female_vv_uranus_bigtts' },
      },
    },
    extension: { asr: {}, tts: {}, dialog: {} },
  }));
});
ws.on('message', (d) => {
  console.log('下行:', d.toString().slice(0, 300));
  clearTimeout(timer); ws.close(); process.exit(0);
});
ws.on('unexpected-response', (_req, res) => {
  console.log('升级被拒 HTTP', res.statusCode, '（若 401/403 说明鉴权头格式不对，需对照官方 demo 核对请求头）');
  clearTimeout(timer); process.exit(1);
});
ws.on('error', (e) => { console.log('error:', e.message); clearTimeout(timer); process.exit(1); });
```

Run: `node .scratch/test-duplex-handshake.cjs`
判定：
- 输出「下行: {"type":"session.created"...」→ 资源已开通且协议正确（最优）
- 输出含 `error` 事件且 code 为资源类错误（如 45000030）→ 鉴权与协议正确，仅资源未开通（当前阶段通过标准）
- `升级被拒 HTTP 401` → X-Api-Key 鉴权头不被接受，须下载官方 `web_duplex_demo.zip` 核对请求头后修正（记录到 CHANGE.md 遗留项）

- [ ] **Step 11: Commit**

```bash
git add src/services/VoiceCallService.js
git commit -m "feat(voice-call): 实时通话切换火山 Seeduplex，音色读角色档案，20ms 节奏转发+静音声明+优雅关闭"
```

---

### Task 9: 内置角色音色迁移 + 写入 API Key

**Files:**
- Modify（运行时数据，不入 git）: `data/characters/*/` 下 JSON、`data/settings.json`
- Create（临时脚本，不提交）: `.scratch/migrate-voices.cjs`

- [ ] **Step 1: 写迁移脚本 `.scratch/migrate-voices.cjs`**

```js
// 内置角色音色迁移：DashScope 音色 → 火山音色（仅更新旧值，不覆盖用户已改的新值）
const fs = require('fs');
const path = require('path');

const MAP = {
  reina_001: 'ICL_uranus_zh_female_aojiaonvyou_tob',    // 芊悦(傲娇) → 傲娇女友 2.0
  miku_002: 'ICL_uranus_zh_female_keainvsheng_tob',     // 千雪(元气) → 可爱女生 2.0
  yuki_003: 'ICL_uranus_zh_female_chengshujiejie_tob',  // 四月(御姐) → 成熟姐姐 2.0
  lin_004: 'zh_female_wenrouxiaoya_uranus_bigtts',      // 苏瑶(温柔) → 温柔小雅 2.0
};
const DASHSCOPE_VOICES = new Set(['', 'Cherry', 'Chelsie', 'Maia', 'Serena', 'Jennifer']);

const dir = path.resolve(process.cwd(), 'data', 'characters');
if (!fs.existsSync(dir)) { console.log('无角色目录'); process.exit(0); }

for (const sub of fs.readdirSync(dir)) {
  const file = path.join(dir, sub, `${sub}.json`);
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const target = MAP[data.id];
  if (!target) { console.log(`跳过 ${data.id}（非内置角色或无映射）`); continue; }
  if (data.voice_preset && !DASHSCOPE_VOICES.has(data.voice_preset)) {
    console.log(`跳过 ${data.id}（voice_preset 已是自定义值: ${data.voice_preset}）`);
    continue;
  }
  data.voice_preset = target;
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`已迁移 ${data.id}: ${data.voice_preset || '(空)'} → ${target}`);
}
```

Run: `node .scratch/migrate-voices.cjs`
Expected: 4 个内置角色各输出一行"已迁移"（若角色已被用户删除则相应跳过，正常）。

- [ ] **Step 2: 写入 API Key 到 `data/settings.json`**

用一次性脚本更新（不手改，避免破坏 JSON 结构）：

```js
// .scratch/set-tts-key.cjs
const fs = require('fs');
const p = require('path').resolve(process.cwd(), 'data', 'settings.json');
const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
data.tts = data.tts || {};
data.tts.apiKey = '***REDACTED***';
data.tts.resourceId = data.tts.resourceId || 'seed-tts-2.0';
delete data.tts.baseURL;
fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
console.log('tts 段:', JSON.stringify(data.tts));
```

Run: `node .scratch/set-tts-key.cjs`

- [ ] **Step 3: 验证 git 不受影响**

Run: `git status --short data/`
Expected: 无任何输出（data/ 已被 gitignore）。

- [ ] **Step 4: Commit（无代码改动，跳过；确认 git 干净即可）**

```bash
git status --short
```
Expected: 只剩 CHANGE.md 等既有未提交项，无 data/ 相关条目。

---

### Task 10: CHANGE.md 与项目 CLAUDE.md 更新

**Files:**
- Modify: `CHANGE.md`（追加条目）
- Modify: `CLAUDE.md`（外部集成描述）

- [ ] **Step 1: CHANGE.md 追加条目**

```markdown
## 2026-09-10 — 语音体系切换火山豆包（TTS + 实时通话 + 每角色音色）

**需求**：集成火山引擎豆包语音，文本转语音与实时对话语音全部适配，每个角色可选择自己的音色，两通道按角色配置统一发声。

**核心变更**：
- `MultimodalService`：DashScope Qwen3-TTS → 火山单向流式 TTS（`/api/v3/tts/unidirectional`，seed-tts-2.0）；情绪/说话风格经 `context_texts` 指令遵循注入；chunked 多段 JSON 解析（括号配平，容忍半包/坏段）；错误码翻译（资源未开通/Key 无效/音色无效）
- `VoiceCallService`：DashScope Qwen-Omni-Realtime → 火山 Seeduplex 全双工 S2S（`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`）；20ms 节奏转发器（协议强制）；AI 说话时静音声明（`input_audio_mute.commit`）；`session.close` 优雅挂断；Socket.IO 事件协议不变
- 音色从代码硬编码改为角色档案 `voice_preset` 字段（火山音色 ID，TTS 与实时通话通用）；无配置回退 Vivi 2.0
- 新增 `VoiceCatalog.js` 精选 20 个伴侣向音色，`/api/voices` 下发
- 角色编辑器：音色下拉 + 自定义音色 ID + 试听按钮（`/api/tts` 支持可选 `speaker` 覆盖）
- 设置页：TTS 段改为火山 `apiKey` + `resourceId`（TTS 与通话共用 Key）
- 内置 4 角色音色迁移：芊悦→傲娇女友、千雪→可爱女生、四月→成熟姐姐、苏瑶→温柔小雅

**遗留**：
- 火山「豆包语音合成大模型 2.0」「端到端实时语音大模型（Seeduplex）」资源开通后的真实合成/通话联调（开通前接口验证均以错误提示正确为通过标准）
- Seeduplex WebSocket 鉴权头（X-Api-Key）如升级被拒 401，需对照官方 web_duplex_demo 核对
- 设计文档：`docs/superpowers/specs/2026-09-10-volcengine-tts-design.md`
```

- [ ] **Step 2: 项目 CLAUDE.md 更新（外部集成段）**

旧：
```
- 外部集成：阿里云 DashScope（TTS Qwen3-TTS、实时语音通话 Qwen-Omni-Realtime WebSocket、绘图 Wanx）、火山方舟 Ark（视频生成 Seedance，`VideoService` 异步任务制：创建任务 → 后台轮询 → mp4 存 `public/videos/`，复用 photos 表 `type='video'`），天气用 wttr.in（免费无 key）
```
新：
```
- 外部集成：火山豆包语音（TTS 走 `MultimodalService` 单向流式 HTTP seed-tts-2.0、实时语音通话走 `VoiceCallService` Seeduplex WebSocket，音色存角色档案 `voice_preset` 字段、两通道通用、`VoiceCatalog.js` 为精选清单唯一源）、阿里云 DashScope（绘图 Wanx）、火山方舟 Ark（视频生成 Seedance，`VideoService` 异步任务制：创建任务 → 后台轮询 → mp4 存 `public/videos/`，复用 photos 表 `type='video'`），天气用 wttr.in（免费无 key）
```

同时在 CLAUDE.md「项目迭代记录」一节的 CHANGE.md 介绍句尾确认仍指向同一文件（本次无结构性变化，仅在原句后补一句当前迭代要点）：

```markdown
（当前迭代：语音体系已切换火山豆包——TTS+实时通话+每角色可选音色）
```

- [ ] **Step 3: Commit**

```bash
git add CHANGE.md CLAUDE.md
git commit -m "docs: 语音体系切换火山豆包的迭代记录与架构说明同步"
```

---

### Task 11: 资源开通后联调清单（需用户操作完成后执行）

前置：用户已在火山控制台开通「豆包语音合成大模型 2.0」与「端到端实时语音大模型（Seeduplex）」。

- [ ] **TTS 真实合成**：启动服务 → `curl -s -X POST http://localhost:3000/api/tts -H "Content-Type: application/json" -d '{"text":"你好呀","characterId":"reina_001"}' -o .scratch/tts-test.mp3` → 检查文件为合法 mp3（`ID3` 文件头）
- [ ] **试听按钮**：角色编辑器选音色 → 试听出声
- [ ] **对话朗读**：聊天页 ♬ 按钮朗读最后一条回复
- [ ] **情绪语音**：给角色发激怒消息触发 angry 情绪后再朗读，语气应有明显变化（context_texts 生效）
- [ ] **实时通话**：HTTPS 页面（`https://localhost:3443`）发起语音通话 → 说话有回应、字幕正常、挂断无报错、通话记录入库
- [ ] **对抗复验**：错误音色 ID（角色档案临时填 `bad_speaker` → 保存 → 朗读 → 应报"音色 ID 无效"）、断网状态点试听（应提示请求失败）、通话中直接关闭页面（服务端 2 秒后清理，无进程崩溃）
- [ ] **全部通过后**：CHANGE.md 遗留项勾销
