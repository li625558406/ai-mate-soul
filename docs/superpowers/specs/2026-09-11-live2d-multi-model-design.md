# Live2D 多模型按角色配置 · 设计文档

日期：2026-09-11
状态：已与用户确认（分配方式=角色管理弹窗下拉框；首批模型=Hiyori + Natori）

## 1. 背景与目标

上一迭代（2026-09-10 桌面端 + Live2D）中所有角色共用内置示例模型 Haru，`avatar.js` 的 `MODEL_URL` 写死。目标：每个角色可配置自己的 Live2D 模型，切换角色时主窗与小窗形象跟随切换。

**明确限制**：参考图无法自动生成 Live2D 模型（需拆件 PSD + 手工绑定），本迭代只做"多个官方免费示例模型按角色分配"。

## 2. 本质约束与设计原则

- 模型资产不入 git（Live2D 免费素材许可，`public/live2d/models/` 已在 .gitignore）→ **目录即清单**：扫描 models 下每个子目录中的 `*.model3.json`，不维护配置文件。Haru 现状文件名不规则（`haru_greeter_t03.model3.json`），扫描逻辑必须按"目录内任一 .model3.json"而非固定文件名。
- avatar.js 是通用渲染器，唯一变量是加载 URL。模型切换 = 换 URL 重载，不引入新渲染路径。
- 角色档案是全字段 JSON 且 `saveProfile` 支持 patch 合并（src/index.js:247）→ `live2d_model` 字段零侵入加入，`GET /api/characters/:characterId` 自动带给前端，后端无需其他改动。

## 3. 数据流

```
data/characters/<id>/<id>.json  加 "live2d_model": "hiyori"（缺省 'haru'）
        ↓
GET /api/live2d/models（新增）
  → fs 扫描 public/live2d/models/*/  → [{ id:'haru', url:'/live2d/models/haru/haru_greeter_t03.model3.json' }, …]
        ↓
角色管理弹窗下拉框"Live2D 形象"（选项 = 该 API；当前值 = 角色.live2d_model）
  → 保存走现有 PUT /api/characters/:id（{ patch: { live2d_model } }）
        ↓
前端切换角色：live2d_model → url → Avatar.loadModel(url)   （主窗重载）
                          └→ broadcastAvatar({ type:'model', url })  （小窗跟随）
```

## 4. 改动清单

### 4.1 后端（src/index.js，一处路由）

- 新增 `GET /api/live2d/models`：同步 fs 扫描 `public/live2d/models/`，每个含 `*.model3.json` 的子目录返回 `{ id: <目录名>, url: <相对路径> }`；目录不存在或为空返回 `[]`。异常时返回 `[]` + console.warn（前端走默认模型降级）。

### 4.2 模型资产（public/live2d/models/，gitignore，不入库）

- 下载官方免费示例模型 Hiyori、Natori（与 Haru 同许可），各自放独立子目录，目录内自包含（textures/motions/expressions 相对路径齐全）。
- 获取方式：Live2D 官方 sample 数据（需 10808 代理下载）；下载后校验 `*.model3.json` 引用的文件全部存在（缺失会触发运行时降级链）。

### 4.3 avatar.js（模型切换能力）

- `MODEL_URL` 常量改为可变状态；新增 `loadModel(url)`：
  1. 与当前已加载 url 相同 → no-op（防重复重载）
  2. `Live2DModel.from(url)` 成功后：移除并 destroy 旧模型 → 添加新模型 → 应用当前情绪参数 + 启动 idle
  3. 失败 → 保留旧模型，console.warn，**不触发降级隐藏**（切模型失败不该影响当前形象）
- BroadcastChannel 消费端新增 case：`{type:'model', url}` → `loadModel(url)`（小窗场景由主窗广播驱动）。
- 情绪参数兼容：Hiyori/Natori 均为标准 Cubism 4 参数（ParamMouthOpenY 等同名），嘴型直接可用；EMOTION_PARAMS 中个别参数在部分模型不存在时写入是安全 no-op（cubism core 对未知参数 ID 静默忽略），无需特判。

### 4.4 前端 index.html（切换联动 + 管理 UI）

- 切换角色处（现有 selectCharacter 逻辑）：读角色档案 `live2d_model`（undefined → 'haru'），查模型清单得 url，调 `Avatar.loadModel(url)` 并 `broadcastAvatar({type:'model', url})`。模型清单在页面初始化时请求一次缓存。
- 角色管理弹窗：新增"Live2D 形象"下拉框（选项 = `GET /api/live2d/models`，含"默认（Haru）"项），保存时并入现有 patch。

## 5. 错误处理

| 故障 | 处理 |
|------|------|
| 模型目录缺失/为空 | API 返回 `[]`，下拉框空，形象走现有降级链（无 Core/模型时隐藏形象区） |
| 角色档案 live2d_model 值无效（模型已删） | 清单中查不到 → 回退默认 haru；haru 也没有 → 形象区现有降级链 |
| loadModel 加载失败（文件损坏） | 保留旧模型 + console.warn，聊天不受影响 |
| 小窗收到 model 消息时尚未 mount | loadModel 内部有就绪守卫，未 mount 时记为 pendingUrl，mount 完成后立即加载 |
| 小窗晚于主窗打开（错过历史 model 广播） | 握手：avatar.js mount 完成后广播 `{type:'model-request'}`；另一窗口的 avatar.js 收到后回发自己当前模型 url（BroadcastChannel 不回显给发送方，主窗响应即可收敛，无循环） |

## 6. 验证清单

1. 网页模式：切角色 → 主窗形象切换对应模型、小窗同步切换
2. 角色管理弹窗：下拉框列出 3 个模型（haru/hiyori/natori），保存后刷新页面配置保留
3. 嘴型/情绪在新模型上正常（TTS 起嘴型、聊天后表情切换）
4. 对抗用例：删除某模型目录后刷新 → 清单不含该项；角色指向已删模型 → 回退 haru；loadModel 传畸形 url → 保留旧模型无崩溃；快速连续切角色 → 最终模型与最后角色一致（no-op 去重 + 顺序执行）
5. 桌面模式：`npm run desktop` 下同 1-3

## 7. 明确不做（YAGNI）

- 模型预览缩略图
- 按角色上传自定义模型
- 模型参数/动作定制 UI
- AI 生成分层立绘（独立课题，另起迭代）
