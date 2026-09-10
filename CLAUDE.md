# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

AI Mate Soul 是一个 AI 伴侣后端：多模型情感引擎驱动的沉浸式虚拟角色系统。Node.js (ESM) + Express + Socket.IO，前端为 `public/` 下的原生 HTML/CSS/JS PWA（非框架项目）。

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（node --watch 自动重启）
npm start            # 生产模式
```

- 无测试框架、无 lint 配置，验证方式为启动服务后手动调用 API。
- 启动后访问 `http://localhost:3000`；HTTPS `https://localhost:3443`（自签证书自动生成，手机麦克风权限需要 HTTPS）。
- 对话/绘图/TTS/视频的 API 配置通过 **Web 设置页**（`public/index.html` 设置弹窗 → `PUT /api/settings`）管理，持久化在 `data/settings.json`（唯一配置源，与 `.env` 无关，启动不做 env 校验，未配置仅告警不退出）。
- `.env` 仅 `PORT` / `HTTPS_PORT` 仍生效。
- 项目迭代记录见 [CHANGE.md](./CHANGE.md)（按日期追加需求与整改条目）（当前迭代：拟人化整改——情绪加权心情、冷战和解三件套、分条拟真推送、中文长期记忆 2-gram 修复、TTS 情绪语速）。

## 架构

### 依赖注入单一入口（src/index.js）

所有服务在 `src/index.js` 顶层手动实例化并通过构造函数互相注入（无 DI 框架、无全局单例导出）。改服务构造参数时必须同步修改这里的组装代码。注意部分依赖是事后挂载的（如 `proactiveService.imageService = imageService`），存在隐式初始化顺序。

### 聊天核心管线（src/core/ChatService.js）

`chatStream()`（async generator，SSE 流式输出）是整个系统的编排中枢，一轮对话依次经过：

1. **时间感知**（TimeService：离线叙事、忙碌状态、日程）
2. **情感分析**（EmotionEngine：关键词+LLM 混合，情感权重 W ∈ [-2,2]）
3. **情绪状态机**（EmotionStateMachine：6 状态 + 雷区触发 + 冷战机制）
4. **动态 Prompt 拼接**（DynamicPromptBuilder：角色档案 + 情绪 + 记忆检索 + 用户画像 + 环境等全部注入 system prompt）
5. **LLM 流式调用**（LLMProvider，OpenAI 兼容；输出为 `<thought>内心独白</thought><reply>回复</reply>` 分离格式）
6. **后处理**（异步：XP 成长、长期记忆入库、动态知识提取、约定提取）

改对话行为时先读 `chatStream()` 全流程，不要只看单个 service。

### 分层职责

- `src/core/` — 编排层：ChatService（管线）、CharacterManager（角色档案热加载，`data/characters/*/` 下 JSON，`POST /api/characters/reload` 触发）、DynamicPromptBuilder（system prompt 组装）
- `src/services/` — 领域服务，每个文件一个独立能力（情感、记忆、日程、语音、绘图、日记、备份等），相互之间不直接引用，全部靠 index.js 注入协作
- `src/database/DatabaseManager.js` — SQLite（better-sqlite3，同步 API）建表 + 迁移。核心表：`characters_state`（好感度/心情/等级等状态，按 userId+characterId 复合键）、`chat_history`、`user_profile`、`user_facts`、`diaries`、`daily_schedules`、`inner_monologue` 等
- 长期记忆不走 SQLite，走 Orama 全文搜索（MemoryService），索引文件持久化在 `data/memory/`

### 角色与数据

- 角色档案在 `data/characters/<id>/`（JSON + 参考图），含 `minefields`（雷区正则）、`living_info`、`visual_features` 等，支持热加载
- 角色支持 Web 端可视化管理（`public/index.html` 角色管理弹窗：编辑/换图/新增复制/重置运行时状态/彻底删除），写 API 走 `CharacterManager`，运行时数据清理由 `DatabaseManager`/`MemoryService` 承担
- `data/` 整体被 gitignore（数据库、角色数据、生成照片均为运行时数据）
- 备份导出为 AES-256-GCM 加密的 `.soul` 文件（SecurityService）
- 外部集成：火山豆包语音（TTS 走 `MultimodalService` 单向流式 HTTP seed-tts-2.0、实时语音通话走 `VoiceCallService` Seeduplex WebSocket，音色存角色档案 `voice_preset` 字段、两通道通用、`VoiceCatalog.js` 为精选清单唯一源）、阿里云 DashScope（绘图 Wanx）、火山方舟 Ark（视频生成 Seedance，`VideoService` 异步任务制：创建任务 → 后台轮询 → mp4 存 `public/videos/`，复用 photos 表 `type='video'`），天气用 wttr.in（免费无 key）

## 约定

- 纯 ESM（`"type": "module"`），import 必须带 `.js` 扩展名
- 运行时为 Node.js >= 18，`better-sqlite3` 是原生模块，换 Node 大版本后需重新 `npm install`
- 用户可见文案为简体中文；代码注释也是中文
