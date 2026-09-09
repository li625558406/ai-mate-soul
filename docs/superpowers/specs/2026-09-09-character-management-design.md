# 角色管理界面 — 设计文档

- 日期：2026-09-09
- 状态：已与用户确认通过
- 范围：AI Mate Soul 角色的可视化管理——编辑档案、更换角色图、修改介绍、新增（空白/复制）、重置运行时状态、彻底删除

## 背景与现状

- 角色档案 = `data/characters/<id>/<id>.json`（20+ 字段，含嵌套 `living_info`/`mood_rules`/`minefields`/`dynamic_knowledge`）+ 同目录一张参考图。
- `CharacterManager`（src/core/CharacterManager.js）启动加载到内存 Map，支持 `reload()` 热加载，已有 `saveDynamicKnowledge` 文件写回先例；**目前没有任何角色写 API**。
- 角色关联运行时数据：
  - SQLite（better-sqlite3）10 张含 characterId 的表：`characters_state`、`chat_history`、`user_facts`、`diaries`、`daily_schedules`、`future_plans`、`photos`、`anniversaries`、`applied_event_emotions`、`inner_monologue`
  - Orama 长期记忆：`data/memory/<userId>_<characterId>.json`，MemoryService `_instances` Map 持有实例
  - 媒体文件：`public/photos/`、`public/videos/`，文件名格式 `<userId>_<characterId>_<timestamp>.jpg`（视频复用同规则），可用 `_characterId_` 模式定位删除

## 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| 重置初始化 | 只重置**运行时状态**（好感度/心情/等级/聊天记录/照片/日记/记忆），档案 JSON 不动 |
| 删除范围 | **彻底删除**：角色目录 + SQLite 所有关联数据 + 记忆索引 + 媒体文件，需二次确认 |
| 编辑深度 | 核心字段分组表单 + 冷门字段"高级 JSON"编辑页签 |
| 新增方式 | 空白新建 / 复制现有角色 二选一 |
| 前端形态 | 主页弹窗入口（与设置弹窗同风格），不做独立页面 |
| id 修改 | **不允许**。id 是目录名、JSON 主键、所有关联数据外键，改 id 断链 |

## 架构方案

方案 A（已确认）：扩展 CharacterManager + 薄路由。CharacterManager 是角色档案唯一 owner，写方法归属它；数据清理归属 DatabaseManager / MemoryService；index.js 只做路由薄层。

### 1. CharacterManager 扩展

- `createCharacter(profile, { copyFrom })`：校验 id（`^[a-z0-9_]{2,32}$`，不与现有重复）；copyFrom 时深拷贝源档案并覆盖 id；建子目录写 `<id>.json`；临时文件 + rename 防半写损坏
- `saveProfile(characterId, { patch, full })`：`full:true` 整份 JSON 校验后覆盖（高级编辑）；否则浅合并核心字段（表单）；写回文件 + 内存 Map 同步
- `deleteCharacter(characterId)`：删角色子目录（JSON + 图片）
- `getRawProfile(characterId)`：返回完整原始档案（现有 `listCharacters` 为裁剪视图，编辑需要全量）

### 2. 数据清理

- `DatabaseManager.deleteCharacterData(characterId)`：单事务 DELETE 上述 10 张表；扫描 `public/photos/`、`public/videos/` 删除文件名含 `_${characterId}_` 的文件
- `MemoryService.removeCharacter(characterId)`：删除 `data/memory/` 下匹配该 characterId 的记忆文件 + 从 `_instances` Map 驱逐实例

### 3. 新路由（src/index.js）

| 路由 | 行为 |
|---|---|
| `POST /api/characters` | body `{ profile, copyFrom? }` → createCharacter |
| `PUT /api/characters/:id` | body `{ patch }` 或 `{ full }` → saveProfile |
| `POST /api/characters/:id/avatar` | multer 单图上传（jpg/png/webp，≤5MB，校验魔数），删旧图存新图 |
| `POST /api/characters/:id/reset` | deleteCharacterData + removeCharacter |
| `DELETE /api/characters/:id?confirm=<全名>` | confirm 与角色 full_name 匹配才执行；删目录 + 数据库 + 记忆 + 媒体文件 |

所有写操作成功后内部调 `reload()` 热加载。错误统一 400 + 中文原因。

### 4. 前端（public/index.html）

- 入口：主页功能宫格 + 设置弹窗各加"角色管理"按钮
- 管理弹窗（宽 640px，设置弹窗同风格）：角色卡片列表（头像 + 全名/昵称 + 性别/年龄 + 动态知识条数 + 编辑按钮）；顶部"+ 新建角色"（空白 / 复制现有）
- 编辑弹窗：
  - 头像区：当前参考图 + 更换图片（file input，即时预览）
  - 分组表单：基本信息（full_name/nickname/gender/birthday/age/archetype/education）、人设（base_personality/background/speaking_style/voice_preset）、爱好（一行一条文本域）、雷区（trigger/annoyance/description 三列行，可增删）
  - "高级"页签：整份 JSON textarea，保存前前端 `JSON.parse` 预检
  - 底部：保存/取消；危险区（仅编辑已有角色）：重置状态（confirm 确认）、删除角色（输入角色全名匹配才可执行）
- 操作成功后关闭弹窗、`loadCharacters()` + `refreshState()`；删除当前选中角色时自动切回列表第一个角色

### 5. 错误处理与对抗性要点

- 非法/重复 id、坏 JSON、图片类型/大小不符 → 400 中文原因
- 写 JSON 用临时文件 + rename，防崩溃半写
- 图片上传校验文件魔数（后端）+ accept 限制（前端）双重防线
- 删除正在对话中的角色：前端先断开 SSE 流；后端删除后 chatStream 取不到角色自然终止（本地单用户，不加锁）
- 对抗验证用例：非法 id、重复 id、坏 JSON、超大图、删除不存在角色、confirm 传错名、重置后 state 残留检查、avatar 上传非图片文件改后缀

### 6. 验证方式

无测试框架，沿用项目惯例：curl 打全部 API happy path + 对抗用例；前端手动过主流程（新建/复制/编辑/换图/重置/删除）。

## 遗留 / 明确不做

- 不做角色导出/导入（已有 .soul 备份体系覆盖用户数据，角色包导入属后续迭代）
- 不做多用户权限控制（本地单人应用）
- 不支持修改角色 id
