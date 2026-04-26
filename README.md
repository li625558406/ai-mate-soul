# AI Mate Soul

> 多模型情感引擎驱动的沉浸式 AI 伴侣系统

AI Mate Soul 是一个高度可定制的 AI 伴侣后端，通过情感引擎、记忆系统、日程模拟、语音通话和图片生成等多维度能力，打造具备真实性格与成长轨迹的虚拟角色。

## 核心特性

### 情感系统
- **情感分析引擎** — 关键词 + LLM 混合分析，情感权重 W ∈ [-2, 2]，驱动好感度与心情双轨变化
- **情绪状态机** — 6 种情绪状态（开心/愉悦/平静/不悦/愤怒/冷战），支持雷区触发、道歉恢复、时间衰减
- **冷战机制** — 心情值跌破阈值后自动进入冷战，返回预设短语，支持持续时间控制与自动解除
- **离线衰减** — 长时间不对话会导致好感度、心情、经验值向基线回归

### 角色成长
- **XP 经验系统** — 每轮对话积累经验值，达到阈值自动升级（10 级）
- **性格进化** — 4 个阶段（警惕陌生人 → 普通认识 → 在意的朋友 → 无可替代的人），好感度驱动性格描述变化
- **镜像学习** — 统计用户常用词，AI 逐渐融入对方的语言习惯
- **动态知识** — 每 10 轮对话自动提取口头禅、性格变化、用户生活事件、关系里程碑等长期记忆

### 时间与生活模拟
- **日程规划** — 每日凌晨通过 LLM 生成全天日程，包含 1-2 个随机事件，支持天气/周末/跨天连续性
- **离线叙事** — 用户离开期间构建时间线叙事，重新上线时注入 prompt
- **忙碌状态** — 角色进入睡觉/开会/上课等状态，多次打扰会"被吵醒"导致心情下降
- **环境感知** — 实时天气获取（wttr.in）、节假日识别、时间/天气对心情的影响

### 记忆与事实
- **长期记忆** — 基于 Orama 全文搜索引擎，每轮对话摘要入库，支持语义检索注入 prompt
- **用户画像** — LLM 自动提取用户信息（姓名、喜好、工作等），持久化存储并随对话更新
- **内心独白** — AI 回复前先进行内心思考（`<thought>` + `<reply>` 分离），独白单独存储可回顾

### 多模态
- **语音通话** — 基于阿里云 DashScope Qwen-Omni-Realtime，WebSocket 实时 ASR + LLM + TTS，支持回声抑制
- **语音合成** — DashScope Qwen3-TTS-Instruct-Flash，每角色独立音色，情绪状态驱动语调变化
- **AI 绘图** — DashScope Wanx 2.7 Image Pro，支持自拍/空镜/拼图/她拍，模板 + LLM 动态生成 prompt，支持角色参考图保持外貌一致性

### 主动交互
- **回归消息** — 用户离线 >12 小时且好感度 >60 时，重连推送角色回归消息
- **定时推送** — 每 30 分钟检查在线空闲用户，基于当前活动推送主动消息
- **主动发图** — 好感度 >80 时有概率主动发送自拍/空镜照片

### 其他功能
- **秘密日记** — 每天凌晨根据聊天记录自动生成日记，好感度达到阈值才可解锁
- **数据备份** — AES-256-GCM 加密导出为 `.soul` 文件，支持导入恢复
- **纪念日系统** — 自动记录首次相遇/生日等纪念日，推送提醒
- **PWA 支持** — 前端可安装为移动应用
- **HTTPS 自签证书** — 自动生成，支持手机麦克风权限

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js + Express + Socket.IO |
| 数据库 | SQLite (better-sqlite3) + Orama 全文搜索 |
| 对话 | OpenAI 兼容 API（支持任意 LLM 提供商） |
| 语音 | 阿里云 DashScope Qwen3-TTS / Qwen-Omni-Realtime |
| 绘图 | 阿里云 DashScope Wanx 2.7 Image Pro |
| 天气 | wttr.in（免费无需 API Key） |
| 前端 | 原生 HTML/CSS/JS + PWA |

## 项目结构

```
ai-mate-soul/
├── src/
│   ├── index.js                    # 入口：Express/Socket.IO/定时任务
│   ├── core/
│   │   ├── ChatService.js          # 聊天核心编排（完整管线）
│   │   ├── CharacterManager.js     # 角色档案加载与管理（热加载）
│   │   └── DynamicPromptBuilder.js # 动态 System Prompt 拼接器
│   ├── database/
│   │   └── DatabaseManager.js      # SQLite 数据库管理 + 迁移
│   └── services/
│       ├── EmotionEngine.js        # 情感分析引擎
│       ├── EmotionStateMachine.js  # 情绪状态机
│       ├── GrowthService.js        # XP/等级/性格进化/镜像学习
│       ├── MemoryService.js        # Orama 长期记忆系统
│       ├── FactExtractor.js        # 用户画像提取
│       ├── TimeService.js          # 时间感知与离线生活模拟
│       ├── DailyPlanner.js         # AI 角色日程规划
│       ├── PlanExtractor.js        # 对话中的约定提取
│       ├── EnvironmentService.js   # 天气/节假日环境感知
│       ├── ProactiveService.js     # 主动交互引擎
│       ├── MultimodalService.js    # TTS 语音合成
│       ├── VoiceCallService.js     # 实时语音通话
│       ├── ImageService.js         # AI 绘图引擎
│       ├── DiaryService.js         # 秘密日记系统
│       ├── LifecycleService.js     # 生命周期/纪念日
│       ├── SecurityService.js      # AES 加密与备份导出
│       ├── SettingsManager.js      # 运行时配置管理
│       └── LLMProvider.js          # 多 LLM 提供商管理
├── data/
│   ├── ai_mate.db                  # SQLite 主数据库
│   ├── characters/                 # 角色档案（JSON + 参考图）
│   │   ├── reina_001/              # 沈熙桐（傲娇美术生）
│   │   ├── miku_002/               # 林悠然（元气少女）
│   │   ├── yuki_003/               # 顾雪晴（知性御姐）
│   │   └── lin_004/                # 林语柔（温柔邻家姐姐）
│   ├── memory/                     # Orama 长期记忆文件
│   └── photo_templates.json        # 绘图模板库
├── public/
│   ├── index.html                  # 前端界面（PWA）
│   ├── sw.js                       # Service Worker
│   ├── manifest.json               # PWA 清单
│   └── photos/                     # 生成的角色照片
├── .env                            # 环境变量配置
└── package.json
```

## 快速开始

### 环境要求

- Node.js >= 18
- npm

### 安装

```bash
npm install
```

### 配置

复制或编辑 `.env` 文件：

```env
# 对话 LLM（必填，支持 OpenAI 兼容 API）
CHAT_API_KEY=your_api_key
CHAT_BASE_URL=https://api.openai.com/v1
CHAT_MODEL=gpt-4o

# 阿里云 DashScope（语音 + 绘图，选填）
DASHSCOPE_API_KEY=your_dashscope_key

# 服务端口
PORT=3000
HTTPS_PORT=3443
```

> 也可在启动后通过 Web 界面的设置页面配置。

### 启动

```bash
# 开发模式（自动重启）
npm run dev

# 生产模式
npm start
```

启动后访问：
- HTTP: `http://localhost:3000`
- HTTPS: `https://localhost:3443`（手机访问需要 HTTPS 才能使用麦克风）

### 预设角色

项目内置 4 个精心设计的角色，每个角色拥有完整的背景故事、性格设定、生活信息和外貌描述：

| 角色 | 昵称 | 原型 | 身份 |
|------|------|------|------|
| 沈熙桐 | 桐桐 | 傲娇 | 中国美术学院大二学生 |
| 林悠然 | 悠然 | 元气 | 活泼可爱的少女 |
| 顾雪晴 | 雪晴 | 御姐 | 成熟知性的大姐姐 |
| 林语柔 | 语柔 | 邻家 | 温柔体贴的邻家姐姐 |

## 自定义角色

在 `data/characters/` 下创建新目录，包含角色 JSON 和参考图：

```json
{
  "id": "my_character",
  "full_name": "角色全名",
  "nickname": "昵称",
  "gender": "女",
  "birthday": "03-15",
  "age": 19,
  "archetype": "tsundere",
  "base_personality": "性格描述...",
  "education": "学校·专业·年级",
  "background": "详细背景故事...",
  "hobbies": ["爱好1", "爱好2"],
  "speaking_style": "说话风格描述",
  "visual_features": {
    "hair": "发色发型",
    "eyes": "眼睛特征",
    "style": "穿搭风格"
  },
  "minefields": [
    { "trigger": "触发词|正则", "annoyance": 15, "description": "雷区描述" }
  ],
  "living_info": {
    "address": "住址",
    "school": "学校",
    "frequent_places": ["常去的地方"],
    "weekend_routine": "周末日常"
  }
}
```

角色支持热加载，调用 `POST /api/characters/reload` 即可。

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | 聊天（SSE 流式响应） |
| GET | `/api/state/:userId/:characterId` | 获取角色状态 |
| POST | `/api/tts` | 语音合成 |
| POST | `/api/photo` | AI 生成照片 |
| GET | `/api/chat-history/:userId/:characterId` | 聊天记录 |
| GET | `/api/diaries/:userId/:characterId` | 日记列表 |
| POST | `/api/diaries/generate/:userId/:characterId` | 生成日记 |
| GET | `/api/characters` | 角色列表 |
| GET | `/api/export/:userId/:characterId` | 导出备份 |
| POST | `/api/import` | 导入备份 |
| GET/PUT | `/api/settings` | 配置管理 |

## 许可

MIT
