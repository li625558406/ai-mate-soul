# Live2D 多模型按角色配置 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个角色可配置自己的 Live2D 模型（下拉框选择），切换角色时主窗与小窗形象跟随切换。

**Architecture:** 后端新增目录扫描清单 API（目录即清单，无配置文件）；角色档案加 `live2d_model` 字段（patch 保存零侵入）；avatar.js 加 `loadModel` 能力 + BroadcastChannel 握手同步小窗；前端切角色时应用模型并广播。

**Tech Stack:** Node.js fs 扫描（Express 路由）、PixiJS + pixi-live2d-display（已有）、BroadcastChannel（已有）、原生 HTML 下拉框。

**设计文档:** `docs/superpowers/specs/2026-09-11-live2d-multi-model-design.md`

---

## 关键现状（实施者必读）

- `public/live2d/avatar.js`：IIFE，`MODEL_URL` 常量（第 7 行）指向 haru；`mount()` 在第 88 行 `Live2DModel.from(MODEL_URL)`；BroadcastChannel 消费 `handleMsg`（第 52 行）处理 `amplitude`/`emotion`；`window.Avatar` 导出 `mount/ready/applyAmplitude`。
- `public/index.html`：`selectCharacter(c, el)` 在第 885 行（`c` 来自 `GET /api/characters` 列表）；生产者桥 `broadcastAvatar` 第 766 行附近；角色编辑器 `openCharEditor`（2198，`fillCeForm(profile)` 填表单）、`saveCharEditor`（2603）走 `PUT /api/characters/:id` 的 `{patch}`。
- `src/core/CharacterManager.js`：`listCharacters()`（第 105 行）是**白名单字段**返回，`live2d_model` 不在其中——需加一行。
- `src/index.js`：API 路由区集中在此；`PUT /api/characters/:characterId`（第 241 行）支持 `{patch}` 合并保存。
- 模型文件在 `public/live2d/models/`（已 gitignore，不入库）；Haru 目录名 `haru`，文件名不规则 `haru_greeter_t03.model3.json`。
- 本项目**无测试框架**，验证方式 = 启动服务（`node src/index.js`，PORT=3001）+ playwright（需 `serviceWorkers: 'block'`，用 `http://127.0.0.1:3001`）。
- 对外下载需走代理：`export http_proxy=socks5://127.0.0.1:10808 https_proxy=socks5://127.0.0.1:10808`。
- 每任务提交到 master；`git add` 只加本任务明确列出的文件（工作树可能有其他未提交改动）。

---

### Task 1: 下载 Hiyori + Natori 官方示例模型

**Files:**
- Create: `public/live2d/models/hiyori/`（自包含目录）
- Create: `public/live2d/models/natori/`（自包含目录）

- [ ] **Step 1: 获取模型资产（走代理）**

来源优先级：
1. Live2D 官方样本数据页（`live2d.com/zh-CHS/learn/sample-data/` 或 `live2d.com/en/learn/sample-data/`）对应的 GitHub 仓库 `Live2D/CubismWebSamples` 的 `Samples/Resources/` 目录含 **Hiyori**（`hiyori_free_t08`，Cubism 4）。
2. **Natori**（升星乃/命猶ノトリ，Cubism 5 免费素材）不在 CubismWebSamples 里，可从官方样本数据页下载 zip；若官方 zip 链接不稳定（Haru 当年就如此），备选：GitHub 上 mirror 仓库（搜索 `natori live2d model3.json` 的 mirror，需人工确认目录自包含性），或 **放弃 Natori 改用 CubismWebSamples 里同样免费的 Mark/Simple范例**——此时在报告里明确说明替换决策及理由。

下载命令示例（先 `export http_proxy=socks5://127.0.0.1:10808 https_proxy=socks5://127.0.0.1:10808`）：

```bash
# 浅克隆官方示例仓库拿 Hiyori
git clone --depth 1 https://github.com/Live2D/CubismWebSamples.git /tmp/cubism-samples
cp -r /tmp/cubism-samples/Samples/Resources/Hiyori public/live2d/models/hiyori
```

- [ ] **Step 2: 校验目录自包含**

对每个模型目录：
1. `*.model3.json` 恰好存在 1 个；`node -e` 或 `.cjs` 脚本 JSON.parse 校验合法。
2. 读 model3.json，检查 `FileReferences` 下引用的所有相对路径文件存在（Moc、Textures[]、Physics、Motions 各组 File）——缺失文件会在运行时触发降级链，必须在落盘时就补齐或换源。
3. 目录总大小合理（< 50MB/个）。

- [ ] **Step 3: 提交**

模型文件被 gitignore，**没有可提交的资产**——本任务无 git 提交（除非后续任务一起改了别的东西）。报告里说明两个目录的最终文件清单即可。

---

### Task 2: 后端模型清单 API + 角色字段透传

**Files:**
- Modify: `src/index.js`（新增一个路由）
- Modify: `src/core/CharacterManager.js:105`（listCharacters 白名单加一行）

- [ ] **Step 1: 新增 GET /api/live2d/models**

在 `src/index.js` 角色路由区（`GET /api/characters` 附近）新增：

```js
// Live2D 可用模型清单：扫描 public/live2d/models/ 下含 *.model3.json 的子目录（目录即清单，无配置文件）
app.get('/api/live2d/models', (_req, res) => {
  try {
    const dir = path.resolve(process.cwd(), 'public', 'live2d', 'models');
    const models = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      const m3 = fs.readdirSync(sub).find(f => f.endsWith('.model3.json'));
      if (m3) models.push({ id: entry.name, url: `/live2d/models/${entry.name}/${m3}` });
    }
    res.json({ models });
  } catch (e) {
    console.warn('[live2d] 模型清单扫描失败:', e.message);
    res.json({ models: [] });   // 目录缺失/异常返回空清单，前端走默认模型降级
  }
});
```

确认 `fs`/`path` 已在 index.js 顶部 import（现有代码已用，核实即可）。

- [ ] **Step 2: listCharacters 白名单透传 live2d_model**

`src/core/CharacterManager.js` `listCharacters()` 返回对象中（`voice_preset` 行后）加：

```js
      live2d_model: c.live2d_model || '',
```

（空字符串 = 未配置，前端回退默认；不在这里写死 'haru'，保持档案层无默认值、默认语义由前端承担。）

- [ ] **Step 3: 验证**

启动 `node src/index.js`（3001），playwright `http://127.0.0.1:3001/api/live2d/models`：返回 `{models:[{id:'haru',...},{id:'hiyori',...},{id:'natori',...}]}`（依赖 Task 1 产物）；`/api/characters` 各角色含 `live2d_model` 字段。对抗：把 models 目录临时改名再请求 → 返回 `models: []` 且服务不崩（验证后改回）。

- [ ] **Step 4: 提交**

```bash
git add src/index.js src/core/CharacterManager.js
git commit -m "feat(live2d): 模型清单扫描 API 与角色档案 live2d_model 透传"
```

---

### Task 3: avatar.js 模型切换能力 + 小窗握手

**Files:**
- Modify: `public/live2d/avatar.js`

- [ ] **Step 1: 状态与 loadModel**

第 7 行 `const MODEL_URL = ...` 改为：

```js
  const DEFAULT_MODEL_URL = '/live2d/models/haru/haru_greeter_t03.model3.json';
  const IS_OVERLAY = /\/live2d\/overlay\.html$/.test(location.pathname);
```

第 22 行状态区追加：

```js
  let currentUrl = null, pendingUrl = null, channel = null;   // 当前模型 url / mount 前暂存 / 频道引用（握手回发用）
```

新增函数（放在 `fit()` 之后）：

```js
  // 切换模型：成功后旧模型销毁、新模型应用当前情绪参数；失败保留当前形象（不触发降级隐藏）
  async function loadModel(url) {
    // 对抗：畸形 url（非字符串/扩展名不符/协议注入——只接受站内绝对路径）
    if (typeof url !== 'string' || !url.startsWith('/') || !url.endsWith('.model3.json')) return false;
    if (!ready) { pendingUrl = url; return false; }   // 未 mount（小窗时序）：暂存，mount 后加载
    if (url === currentUrl) return true;              // 去重：同 url 不重复重载
    const PIXI = window.PIXI;
    if (!PIXI || !PIXI.live2d || !app) return false;
    try {
      const next = await PIXI.live2d.Live2DModel.from(url);
      const old = model;
      model = next;
      baseW = next.width; baseH = next.height;
      app.stage.addChild(next);            // 先加新再删旧，避免闪烁
      if (old) { app.stage.removeChild(old); try { old.destroy(); } catch {} }
      currentUrl = url;
      fit();                               // 新模型自然尺寸变了，按固定基准重新布局
      return true;
    } catch (err) {
      console.warn('[avatar] 模型切换失败，保留当前形象:', err.message);
      return false;                        // model 未被改动的路径上旧形象原样保留
    }
  }
```

注意：`model`/`baseW`/`baseH` 赋值放在 `await` 成功之后，加载失败时旧模型完全不受影响。

- [ ] **Step 2: 频道消息与握手**

`handleMsg` 追加两个 case（`emotion` case 之后）：

```js
    } else if (msg.type === 'model' && typeof msg.url === 'string') {
      loadModel(msg.url);
    } else if (msg.type === 'model-request') {
      // 小窗 mount 后索取当前模型；只有主窗应答（IS_OVERLAY 方向过滤，防双窗互答干扰）
      if (!IS_OVERLAY && currentUrl) postToChannel({ type: 'model', url: currentUrl });
    }
```

新增频道发送助手（`handleMsg` 之前）：

```js
  function postToChannel(msg) { try { channel && channel.postMessage(msg); } catch {} }
```

`mount()` 成功路径里 `ready = true;` 之前，把局部 `ch` 改存模块级并补两行：

```js
      const ch = new BroadcastChannel(CHANNEL);
      channel = ch;
      ch.onmessage = (e) => handleMsg(e.data);
```

`ready = true;` 之后、`return true;` 之前追加：

```js
      // mount 前暂存的模型（小窗时序）立即加载；并广播握手向主窗索取当前模型
      if (pendingUrl) { const u = pendingUrl; pendingUrl = null; loadModel(u); }
      else postToChannel({ type: 'model-request' });
```

（注意：mount 的 catch 降级路径无需清 channel——BroadcastChannel 无需清，与现有注释一致；`currentUrl` 初始为 null，降级后 model-request 无 url 可答，天然安全。）

- [ ] **Step 3: 导出**

`window.Avatar` 追加：

```js
    loadModel,
```

- [ ] **Step 4: 验证**

启动后端，playwright 打开主窗页面：0 新增报错；`window.Avatar.loadModel` 为 function。在页面 console 依次执行对抗用例（BroadcastChannel 方式直接调 `Avatar.loadModel`）：
1. `Avatar.loadModel('/live2d/models/hiyori/<实际文件名>.model3.json')` → 返回 true，画面模型变化（用 `PIXI.Ticker.shared` 探针或截图字节对比确认渲染更新）
2. `Avatar.loadModel('/live2d/models/haru/haru_greeter_t03.model3.json')` → 能切回
3. `Avatar.loadModel('http://evil.com/x.model3.json')`、`Avatar.loadModel('<script>')`、`Avatar.loadModel(123)`、`Avatar.loadModel('/live2d/models/不存在/xx.model3.json')` → 全部 false，当前形象不变、无崩溃
4. 连续快速调用 5 个不同 url → 最终停在最后一个有效的，无重复 stage 子节点（`app.stage.children.length === 1`）

- [ ] **Step 5: 提交**

```bash
git add public/live2d/avatar.js
git commit -m "feat(live2d): avatar 支持运行时模型切换与小窗 model-request 握手"
```

---

### Task 4: 前端联动——切角色应用模型 + 编辑器下拉框

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 模型清单缓存与应用助手**

生产者桥（`broadcastAvatar` 定义）之后新增：

```js
// ===== Live2D 模型清单：目录即清单，切角色时按档案 live2d_model 应用 =====
let live2dModels = [];
async function initLive2dModels() {
  try { const r = await fetch('/api/live2d/models'); const d = await r.json(); live2dModels = d.models || []; }
  catch { live2dModels = []; }
}
function applyCharacterModel(modelId) {
  const id = modelId || 'haru';
  const m = live2dModels.find(x => x.id === id) || live2dModels.find(x => x.id === 'haru');
  if (!m) return;   // 清单里连 haru 都没有：不动形象（现有降级链已处理无模型场景）
  broadcastAvatar({ type: 'model', url: m.url });
  window.Avatar && window.Avatar.loadModel && window.Avatar.loadModel(m.url);
}
```

页面初始化区（`initLive2dModels()` 与其他 init 调用一起）加一次调用。

- [ ] **Step 2: selectCharacter 联动**

`selectCharacter`（885 行）内 `socket.emit('register', ...)` 附近加一行：

```js
  applyCharacterModel(c.live2d_model);
```

（`c` 来自角色列表接口，Task 2 已透传 `live2d_model`；未配置 = `''` → applyCharacterModel 内回退 haru。）

- [ ] **Step 3: 角色编辑器下拉框**

1. `charEditorModal` 的表单区 HTML（现有 `ceName`/`ceGender` 等字段附近）加：

```html
            <div class="field">
              <label>Live2D 形象</label>
              <select id="ceLive2dModel"></select>
            </div>
```

（沿用该弹窗既有 field 的 class/结构——实施前先读现有表单 HTML 对齐写法。）

2. `fillCeForm(p)` 内追加：

```js
  const ceL2d = document.getElementById('ceLive2dModel');
  ceL2d.innerHTML = '<option value="">默认（Haru）</option>' +
    live2dModels.map(m => `<option value="${m.id}">${m.id}</option>`).join('');
  ceL2d.value = p.live2d_model || '';
  if (ceL2d.value !== (p.live2d_model || '')) ceL2d.value = '';   // 档案指向的模型已不在清单：回默认
```

3. `saveCharEditor()` 构造 patch 处把该字段并入（读现有 patch 组装代码，加一行）：

```js
  patch.live2d_model = document.getElementById('ceLive2dModel').value || '';
```

- [ ] **Step 4: 验证**

启动后端，playwright：
1. 页面加载 0 新增报错；`live2dModels.length >= 3`
2. 点不同角色卡片 → 模型切换（截图/渲染探针验证），无报错
3. 打开角色编辑器 → 下拉框列出"默认（Haru）/hiyori/natori"；选中 hiyori 保存 → `GET /api/characters/:id` 确认 `live2d_model: 'hiyori'` 持久化；刷新页面重新选该角色 → 应用 hiyori
4. 对抗：把档案里 live2d_model 手改为不存在值（`POST/PUT` 或直接 DB/JSON 改）→ 选该角色回退 haru；下拉框打开时该值不出现错位

- [ ] **Step 5: 提交**

```bash
git add public/index.html
git commit -m "feat(live2d): 切角色应用形象模型，角色编辑器新增形象下拉框"
```

---

### Task 5: 小窗联动验证 + 文档同步

**Files:**
- Modify: `CHANGE.md`、`CLAUDE.md`

- [ ] **Step 1: 桌面模式小窗握手验证（playwright + Electron 可自动化部分）**

Electron 场景无法完全自动化托盘，但主窗↔小窗握手可用双页面模拟：playwright 两个 page（A=主窗 index.html，B=直接开 `http://127.0.0.1:3001/live2d/overlay.html`，B 的 `location.pathname` 以 overlay.html 结尾即走 IS_OVERLAY 分支）：
1. A 先 `Avatar.loadModel(hiyori)` → B 打开（后 mount）→ B 自动握手 → B 渲染 hiyori（B 页 `app.stage.children[0]` 的纹理/尺寸变化，或 `Avatar` 内部 currentUrl 无法直接读——用渲染结果截图字节对比 B 前后差异验证）
2. A 切模型 → B 跟随
3. B 后于 A 打开但 A 从未切过模型 → B 停在默认 haru

- [ ] **Step 2: CHANGE.md / CLAUDE.md**

- `CHANGE.md` 末尾追加条目（2026-09-11，Live2D 多模型按角色配置）：核心变更（清单 API/档案字段/avatar loadModel+握手/编辑器下拉框/Hiyori+Natori 资产）、对抗用例结果、遗留（Natori 若换源需注明；模型预览缩略图等 YAGNI 项）。
- `CLAUDE.md`：更新 CHANGE.md 引用行的"当前迭代"描述为本次迭代；架构区"桌面壳与形象渲染"小节补一句模型按角色配置。

- [ ] **Step 3: 提交**

```bash
git add CHANGE.md CLAUDE.md
git commit -m "docs: Live2D 多模型按角色配置迭代记录同步"
```

---

## 遗留与后续（明确不在本计划内）

- 模型预览缩略图、按角色上传自定义模型、模型参数定制 UI
- AI 生成分层立绘实验（独立课题）
- electron-builder 打包（上迭代遗留）
