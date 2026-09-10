# 火山豆包语音集成设计（TTS + 实时语音通话 + 每角色音色）

日期：2026-09-10
状态：待用户评审

## 1. 背景与问题本质

**现状**：
- 文本转语音：`MultimodalService` → 阿里云 DashScope Qwen3-TTS（`qwen3-tts-instruct-flash`），返回音频 URL → 下载 Buffer
- 实时语音通话：`VoiceCallService` → DashScope Qwen-Omni-Realtime WebSocket（`qwen3-omni-flash-realtime`）
- 音色**硬编码**在两个服务的 `CHARACTER_VOICE_CONFIG` 常量里（4 个内置角色各绑死一个音色），既不在角色档案里，也不受设置页管理

**问题本质约束**：
1. 语音是角色人格的一部分 → 音色必须**跟随角色档案**（导出/复制/重置都自然携带），而不是散落在代码常量里
2. 情绪状态机（开心/生气/冷战）驱动语音语气变化是核心体验 → TTS 通道必须支持**指令遵循**（情绪→语气指令）
3. 文本聊天回复与实时通话是两个独立通道，但用户听到的是"同一个角色" → **两通道必须共用同一套音色体系**
4. 配置唯一源是 `data/settings.json`（Web 设置页管理），鉴权信息不能进代码、不能进 git

**决策**：完全替换 DashScope 语音（TTS + 实时通话），不留双供应商切换（用户已确认）。

## 2. 火山豆包语音调研结论（2026-09-10 官方文档 + 实测）

### 2.1 鉴权
- 新版控制台单头鉴权：`X-Api-Key` 请求头（用户已有 Key，实测有效）
- 无需 AK/SK 签名，与现有 fetch/WebSocket 调用方式兼容

### 2.2 文本转语音（选定通道）
`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- 请求头：`X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0` + `X-Api-Request-Id`（UUID）
- 请求体：`{ req_params: { text, speaker: <音色ID>, audio_params: { format, sample_rate }, context_texts: [<语音指令>] } }`
- 响应：HTTP Chunked，多段 JSON，`data` 字段为 base64 音频分片（需拼接）
- **2.0 音色支持 `context_texts` 指令遵循**（如"用特别痛心的语气说话"），指令文字不计费 → 用于迁移现有情绪指令映射
- 实测状态：**未开通**（`45000030 requested resource not granted`），需控制台开通

### 2.3 备用通道（不采用，仅记录）
`POST /api/v3/tts/create`（音频生成HTTP，`seed-audio-1.0`）：一次性 JSON 返回 base64，单次 ≤120s。实测**已开通可用**。但其情绪控制是配音创作式的 prompt 描述，无 `context_texts` 指令遵循，且定位是音频创作而非对话 TTS → 不作为主通道。

### 2.4 实时语音通话
豆包实时语音 3.0（Seeduplex，全双工 S2S），WebSocket 纯 JSON 帧：
- 事件语义与 DashScope Realtime **几乎同构**：上行 `session.create` / `input_audio_buffer.append` / `conversation.item.create` / `response.cancel` / `session.close`；下行 `session.created` / `response.output_audio.delta` / `conversation.item.input_audio_transcription.*`
- 音色：`extension.tts` 内指定 speaker，错误码 `InvalidSpeaker` 表明按音色名校验
- 输入音频：PCM 16k 单声道 int16，**须按 20ms 实时节奏分包**（640 字节/包）；麦克风静音须发 `input_audio_mute.commit`
- 输出音频：默认 OGG-Opus，可通过 `extension.tts.audio_config` 配置为 PCM 24k（前端现有播放链路按 PCM 处理 → 配 PCM）
- 关闭：必须先 `session.close` 并等回复，直接断开报 `ContextCanceled`
- Function Calling 支持（本设计不使用，通话走端到端 S2S，不经 ChatService 管线）

### 2.5 音色体系（关键结论）
**TTS 2.0 与 Seeduplex S2S 共用同一套音色列表** → 一个 speaker ID 两通道通用，天然满足"同一角色声音统一"。

从官方列表精选伴侣/角色扮演向音色（内置到前端，火山无"列出音色"API）：

| 音色 | speaker ID | 气质 |
|---|---|---|
| Vivi 2.0（默认） | `zh_female_vv_uranus_bigtts` | 通用，支持多方言 |
| 知性灿灿 2.0 | `zh_female_cancan_uranus_bigtts` | 角色扮演/知性 |
| 撒娇学妹 2.0 | `zh_female_sajiaoxuemei_uranus_bigtts` | 角色扮演/撒娇 |
| 甜美小源 2.0 | `zh_female_tianmeixiaoyuan_uranus_bigtts` | 甜美 |
| 甜美桃子 2.0 | `zh_female_tianmeitaozi_uranus_bigtts` | 甜美 |
| 爽快思思 2.0 | `zh_female_shuangkuaisisi_uranus_bigtts` | 爽朗 |
| 邻家女孩 2.0 | `zh_female_linjianvhai_uranus_bigtts` | 邻家 |
| 高冷御姐 2.0 | `zh_female_gaolengyujie_uranus_bigtts` | 御姐 |
| 温柔小雅 2.0 | `zh_female_wenrouxiaoya_uranus_bigtts` | 温柔 |
| 柔美女友 2.0 | `zh_female_roumeinvyou_uranus_bigtts` | 女友感 |
| 性感魅惑 2.0 | `ICL_uranus_zh_female_xingganmeihuo_tob` | 魅惑 |
| 清冷高雅 2.0 | `ICL_uranus_zh_female_qinglenggaoya_tob` | 清冷 |
| 傲娇女友 2.0 | `ICL_uranus_zh_female_aojiaonvyou_tob` | 傲娇（S2S 支持） |
| 病娇姐姐 2.0 | `ICL_uranus_zh_female_bingjiaojiejie_tob` | 病娇（S2S 支持） |
| 成熟姐姐 2.0 | `ICL_uranus_zh_female_chengshujiejie_tob` | 成熟（S2S 支持） |
| 可爱女生 2.0 | `ICL_uranus_zh_female_keainvsheng_tob` | 可爱（S2S 支持） |
| 暖心学姐 2.0 | `ICL_uranus_zh_female_nuanxinxuejie_tob` | 暖心（S2S 支持） |
| 活泼女孩 2.0 | `ICL_uranus_zh_female_huoponvhai_tob` | 活泼 |
| 娇弱萝莉 2.0 | `ICL_uranus_zh_female_jiaoruoluoli_tob` | 萝莉 |
| 妩媚可人 2.0 | `ICL_uranus_zh_female_wumeikeren_tob` | 妩媚 |

## 3. 设计

### 3.1 配置（settings.json + 设置页）

`data/settings.json` 的 `tts` 段改为：

```json
{
  "tts": {
    "apiKey": "<火山新版控制台 X-Api-Key>",
    "resourceId": "seed-tts-2.0"
  }
}
```

- TTS 与实时通话**共用同一个 apiKey**（都是豆包语音体系）；resourceId 可改（留调试口子，默认 `seed-tts-2.0`）
- 设置弹窗对应字段改名（原 DashScope baseURL 字段删除，新增 resourceId 可选字段）
- `PUT /api/settings` 保存后 `updateConfig()` 即时生效（沿用现有机制）
- `.env` 不涉及

### 3.2 角色档案 voice 字段

`data/characters/<id>/character.json` 新增：

```json
{
  "voice": {
    "speaker": "zh_female_cancan_uranus_bigtts",
    "instructions": "角色专属语气描述，可选"
  }
}
```

- 无 `voice` 字段或 speaker 为空 → 回退默认 `zh_female_vv_uranus_bigtts`
- 现有 4 个内置角色迁移：reina_001→傲娇女友、miku_002→可爱女生、yuki_003→成熟姐姐、lin_004→温柔小雅（贴近原 DashScope 音色人设）
- `CharacterManager` 已支持 JSON 热加载，无需新增机制
- 角色导出/复制/备份天然携带音色

### 3.3 MultimodalService 改造（TTS）

对外接口**签名不变**：`synthesizeSpeech({ text, characterId, emotionState }) → Buffer`。

改动点：
1. 删除 `_characterVoices` 硬编码，构造函数注入 `characterManager`，运行时 `getCharacter(characterId)?.voice?.speaker` 取音色
2. 删除 `_normalizeBaseURL`（不再需要 DashScope URL 拼接），改用固定 `openspeech.bytedance.com` 端点
3. `updateConfig({ apiKey, resourceId })` 适配新字段
4. `_emotionInstructions` 映射保留内容、改为拼入 `context_texts`（如 calm→无指令；angry→"你现在用特别生气、压着火的语气说话"）
5. 角色档案的 `voice.instructions`（若有）拼在情绪指令前
6. 响应处理：读取 chunked 流，按行/边界解析多段 JSON，拼接 `data` base64 分片 → Buffer
7. 删除 `getVoicePresets()` 中按 characterId 的旧语义（音色清单改由前端内置静态表 + `/api/characters` 返回各角色当前音色）

### 3.4 VoiceCallService 改造（Seeduplex）

Socket.IO 事件协议**不变**（`voice_call:start/audio/end/error/session_created/...`），前端零改动。

改动点：
1. WebSocket 端点换为 Seeduplex（具体 URL 从接入指南"网络连接"小节取，实施时确认）
2. 握手：`session.create`，`extension.tts` 内配置 `speaker`（角色音色）+ `audio_config`（PCM 24k 输出），`instructions` = 现有 `_buildSystemPrompt()` 产出（逻辑保留）
3. 音色来源：删除 `CHARACTER_VOICE_CONFIG` 硬编码，改读角色档案 `voice.speaker`（注入 `characterManager`，已注入）
4. 音频输入转发：保持现有"AI 说话时静默丢弃麦克风音频"的回声抑制；按 20ms 节奏转发（前端现有采集节奏已接近，实施时校验）
5. 挂断：先发 `session.close`，收到 `session.closed` 后再 `ws.close()`（避免 ContextCanceled）
6. 下行事件映射（名称基本一致，直接对接现有 switch）：
   - `response.output_audio.delta` → `voice_call:audio`
   - `conversation.item.input_audio_transcription.completed` → `voice_call:user_transcript`
   - `response.output_text.delta` → `voice_call:ai_transcript_delta`
   - `error` → `voice_call:error`
7. 静音处理：前端暂停采集时后端补发 `input_audio_mute.commit`，恢复时 `input_audio_unmute.commit`

### 3.5 前端（public/index.html）

1. **设置弹窗**：TTS 区改为「火山 API Key」+「Resource ID（高级，默认 seed-tts-2.0）」，注明"到火山新版控制台 → API Key 管理获取"
2. **角色编辑器**新增「语音音色」区：
   - 下拉选择（内置上述 20 个精选音色，显示中文名 + 气质标签）
   - 「自定义」选项展开 free-text 输入框（支持声音复刻音色 ID）
   - **试听按钮**：调 `POST /api/tts` 合成固定短句（"嗨，这是我用这个声音和你说话哦～"）就地播放
3. `GET /api/characters` 返回体带上 `voice` 字段（CharacterManager 序列化已含，确认透传即可）

### 3.6 错误处理与可观测性

- `45000030 resource not granted` → 错误消息明确提示"请在火山控制台开通〈豆包语音合成大模型 2.0〉/〈端到端实时语音大模型〉"
- `InvalidSpeaker` → 提示"音色 ID 无效，请检查角色音色配置"
- 401/Key 失效 → 提示检查设置页 API Key
- TTS 失败不影响文字回复（现有 `/api/tts` 是独立请求，前端已有失败提示）
- 日志：合成耗时、音色、字数（usage.text_words）

### 3.7 测试（对抗性用例）

| 类别 | 用例 |
|---|---|
| 边界 | 空文本、单字、3000+ 字长文本、纯 emoji/标点文本 |
| 非法输入 | 不存在的音色 ID、含 SSML/控制字符的文本、超长 voice.instructions |
| 网络故障 | Key 失效 401、资源未开通 403、chunked 流中途断开、响应非 JSON |
| 状态耦合 | 同一角色并发多次 TTS、通话中切换角色音色、重复 startCall、挂断时 WebSocket 已死 |
| 实时通话 | 20ms 节奏偏差触发服务端错误、静音超时（10 分钟无交互）、直接断开的 ContextCanceled |

### 3.8 不做的事（YAGNI）

- 不做双供应商切换
- 不做声音复刻（克隆）流程本身，仅支持填复刻音色 ID
- 不做通话 Function Calling / 联网搜索
- 不做长音频/唱歌（seed-audio-1.0 场景）

## 4. 交付前用户需做

1. 火山控制台开通：**豆包语音合成大模型 2.0**（TTS 主通道）+ **端到端实时语音大模型 Seeduplex**（实时通话）；均通常有免费试用额度
2. API Key 已提供，实施时由我写入 `data/settings.json`（该文件已被 gitignore）

## 5. 实施顺序概要（详见实施计划）

1. MultimodalService 换火山 TTS（不依赖资源开通即可写完，开通后联调）
2. 角色档案 voice 字段 + 内置角色迁移
3. 角色编辑器音色选择 UI + 试听
4. VoiceCallService 换 Seeduplex
5. 设置页字段调整 + CHANGE.md 记录
