# 角色管理界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI Mate Soul 增加角色可视化管理——编辑档案、更换角色图、新增（空白/复制）、重置运行时状态、彻底删除。

**Architecture:** 扩展 CharacterManager 为角色档案的唯一写入方（建/存/删/换图）；运行时数据清理由 DatabaseManager（SQLite 10 表 + 媒体文件）和 MemoryService（Orama 索引文件）承担；index.js 只加薄路由。前端为 public/index.html 内新增两个弹窗（管理列表 + 编辑器），与现有设置弹窗同风格。

**Tech Stack:** Node.js ESM + Express + better-sqlite3 + multer（已有）+ Orama；前端原生 HTML/JS。

**测试说明（覆盖技能 TDD 默认要求）：** 本项目 CLAUDE.md 明确"无测试框架，验证方式为启动服务后手动调用 API"，故每个任务以 curl / 启动验证替代自动化测试（用户指令优先于技能默认）。临时验证文件一律写入 `.scratch/`。

**规格文档:** `docs/superpowers/specs/2026-09-09-character-management-design.md`

**关键既定事实（勿再探索）：**
- 角色档案：`data/characters/<id>/<id>.json` + 同目录一张图片；id 即目录名，全库外键
- MemoryService 记忆文件名：`data/memory/<userId>__<characterId>.json`（双下划线分隔）
- 媒体文件名格式：`<userId>_<characterId>_<timestamp>.jpg`，位于 `public/photos/`、`public/videos/`
- SQLite 所有表的外键列名均为 `character_id`；DatabaseManager 当前**未** import fs
- index.js 中 multer 实例 `upload` 在 179 行附近；角色路由在 183-202 行
- 前端已有工具函数：`escapeHtml()`（914 行）、`loadCharacters()`、`refreshState()`、`closeSettings()`；`.modal-close` 样式与"点遮罩关闭"模式已存在
- public/sw.js 缓存版本当前为 `soul-v4`，前端改动后需升到 `soul-v5`

---

### Task 1: CharacterManager 写方法

**Files:**
- Modify: `src/core/CharacterManager.js`

- [ ] **Step 1: 添加原子写 helper 与 getRawProfile**

在 `saveDynamicKnowledge` 方法之后、`getCharactersDir()` 之前插入：

```js
  /** 原子写角色 JSON（临时文件 + rename，防崩溃半写） */
  _writeProfileFile(characterId, profile) {
    const dir = path.join(CHARACTERS_DIR, characterId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${characterId}.json`);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(profile, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }
```

- [ ] **Step 2: 添加 createCharacter**

紧接其后插入：

```js
  /** 空白角色模板 */
  _emptyProfile() {
    return {
      id: '',
      full_name: '',
      nickname: '',
      gender: '女',
      birthday: '',
      age: 20,
      archetype: '',
      base_personality: '',
      education: '',
      background: '',
      hobbies: [],
      speaking_style: '',
      voice_preset: '',
      visual_features: {},
      growth_logic: { interval: 10, affection_range: [0.6, 1.2] },
      mood_rules: {},
      minefields: [],
      annoyance_config: { decay_per_hour: 6, apology_recovery: 28, cold_war_duration_min: 15 },
      cold_war_responses: [],
      living_info: {},
      dynamic_knowledge: {
        learned_catchphrases: [],
        personality_shifts: [],
        user_life_events: [],
        acquired_knowledge: [],
        relationship_milestones: [],
      },
    };
  }

  /**
   * 创建角色
   * @param {object} profile - 至少含 id、full_name
   * @param {{ copyFrom?: string }} opts - copyFrom: 深拷贝现有角色档案为底
   * @returns {{ ok: boolean, error?: string, profile?: object }}
   */
  createCharacter(profile, { copyFrom } = {}) {
    const id = profile?.id;
    if (!id || typeof id !== 'string' || !/^[a-z0-9_]{2,32}$/.test(id)) {
      return { ok: false, error: '角色 id 非法：仅允许小写字母/数字/下划线，2-32 位' };
    }
    if (this._characters.has(id)) {
      return { ok: false, error: `角色 id 已存在: ${id}` };
    }
    let base;
    if (copyFrom) {
      const src = this._characters.get(copyFrom);
      if (!src) return { ok: false, error: `要复制的角色不存在: ${copyFrom}` };
      base = JSON.parse(JSON.stringify(src));
    } else {
      base = this._emptyProfile();
    }
    const merged = { ...base, ...profile, id };
    if (!merged.full_name) return { ok: false, error: 'full_name（角色全名）不能为空' };
    if (!merged.dynamic_knowledge) merged.dynamic_knowledge = this._emptyProfile().dynamic_knowledge;
    this._writeProfileFile(id, merged);
    this._characters.set(id, merged);
    return { ok: true, profile: merged };
  }

  /**
   * 保存角色档案
   * @param {{ patch?: object, full?: object }} - patch: 浅合并核心字段；full: 整份覆盖
   */
  saveProfile(characterId, { patch, full } = {}) {
    const current = this._characters.get(characterId);
    if (!current) return { ok: false, error: '角色不存在' };
    let next;
    if (full !== undefined) {
      if (typeof full !== 'object' || full === null || Array.isArray(full)) {
        return { ok: false, error: 'full 必须为档案对象' };
      }
      if (full.id !== characterId) return { ok: false, error: '不允许修改角色 id' };
      next = JSON.parse(JSON.stringify(full));
    } else {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return { ok: false, error: 'patch 必须为对象' };
      }
      if ('id' in patch && patch.id !== characterId) {
        return { ok: false, error: '不允许修改角色 id' };
      }
      next = JSON.parse(JSON.stringify(current));
      Object.assign(next, patch);
      next.id = characterId; // 防御：无论 patch 带什么，id 不可变
    }
    if (!next.full_name) return { ok: false, error: 'full_name（角色全名）不能为空' };
    this._writeProfileFile(characterId, next);
    this._characters.set(characterId, next);
    return { ok: true, profile: next };
  }

  /** 更换角色参考图：删除目录内旧图，写入新图 */
  saveAvatar(characterId, buffer, ext) {
    const dir = path.join(CHARACTERS_DIR, characterId);
    if (!fs.existsSync(dir)) return { ok: false, error: '角色目录不存在' };
    for (const f of fs.readdirSync(dir)) {
      if (/\.(jpe?g|png|webp|bmp)$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }
    fs.writeFileSync(path.join(dir, `avatar.${ext}`), buffer);
    return { ok: true };
  }

  /** 彻底删除角色目录（JSON + 图片）并从内存移除 */
  deleteCharacter(characterId) {
    const dir = path.join(CHARACTERS_DIR, characterId);
    if (!fs.existsSync(dir)) return { ok: false, error: '角色目录不存在' };
    fs.rmSync(dir, { recursive: true, force: true });
    this._characters.delete(characterId);
    return { ok: true };
  }
```

- [ ] **Step 3: 语法验证**

Run: `node --check src/core/CharacterManager.js`
Expected: 无输出（语法通过）

- [ ] **Step 4: 功能验证**

启动 `npm start`（后台），另开终端：

```bash
curl -s http://localhost:3000/api/characters | head -c 100
```

Expected: 返回现有角色 JSON（确认未破坏加载）。

- [ ] **Step 5: Commit**

```bash
git add src/core/CharacterManager.js
git commit -m "feat(char): CharacterManager 新增创建/保存/换图/删除写方法"
```

---

### Task 2: DatabaseManager.deleteCharacterData

**Files:**
- Modify: `src/database/DatabaseManager.js`

- [ ] **Step 1: 补 fs import**

文件顶部 import 区（第 1-3 行）加一行：

```js
import fs from 'fs';
```

- [ ] **Step 2: 添加 deleteCharacterData 方法**

在类末尾（`_initSchema` 之后任意方法区末尾）添加：

```js
  /**
   * 删除某角色的全部运行时数据（单事务）+ 磁盘媒体文件
   * 涉及表：characters_state / chat_history / user_facts / diaries / daily_schedules /
   *        future_plans / photos / anniversaries / applied_event_emotions / inner_monologue
   * @returns {{ files: number }} 删除的媒体文件数
   */
  deleteCharacterData(characterId) {
    const tables = [
      'characters_state', 'chat_history', 'user_facts', 'diaries', 'daily_schedules',
      'future_plans', 'photos', 'anniversaries', 'applied_event_emotions', 'inner_monologue',
    ];
    const del = this.db.transaction((cid) => {
      for (const t of tables) {
        this.db.prepare(`DELETE FROM ${t} WHERE character_id = ?`).run(cid);
      }
    });
    del(characterId);

    let files = 0;
    const mediaDirs = [
      path.resolve(process.cwd(), 'public', 'photos'),
      path.resolve(process.cwd(), 'public', 'videos'),
    ];
    for (const d of mediaDirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        // 文件名格式 <userId>_<characterId>_<timestamp>.ext
        if (f.includes(`_${characterId}_`)) {
          fs.rmSync(path.join(d, f), { force: true });
          files++;
        }
      }
    }
    return { files };
  }
```

- [ ] **Step 3: 语法验证**

Run: `node --check src/database/DatabaseManager.js`
Expected: 无输出

- [ ] **Step 4: 功能验证**

服务保持运行，用 sqlite3 或直接观察：先 `curl -s -X DELETE 'http://localhost:3000/api/characters/__none__?confirm=x'` 应 404（路由 Task 4 才有，可跳过）；本任务以启动不报错为准（`npm start` 无异常即通过）。

- [ ] **Step 5: Commit**

```bash
git add src/database/DatabaseManager.js
git commit -m "feat(db): deleteCharacterData 单事务清理角色运行时数据与媒体文件"
```

---

### Task 3: MemoryService.removeCharacter

**Files:**
- Modify: `src/services/MemoryService.js`

- [ ] **Step 1: 添加 removeCharacter 方法**

在 `importMemoryFile` 方法之后添加：

```js
  /**
   * 删除某角色全部记忆（所有用户维度）：删磁盘文件 + 驱逐内存实例
   * 文件名格式 <userId>__<characterId>.json（双下划线分隔，characterId 可含单下划线，endsWith 匹配安全）
   * @returns {number} 删除的文件数
   */
  removeCharacter(characterId) {
    const dir = path.resolve(process.cwd(), 'data', 'memory');
    let removed = 0;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(`__${characterId}.json`)) {
          fs.rmSync(path.join(dir, f), { force: true });
          removed++;
        }
      }
    }
    for (const key of [...this._instances.keys()]) {
      if (key.endsWith(`__${characterId}`)) this._instances.delete(key);
    }
    return removed;
  }
```

- [ ] **Step 2: 语法验证**

Run: `node --check src/services/MemoryService.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add src/services/MemoryService.js
git commit -m "feat(memory): removeCharacter 清理角色全部记忆文件与内存实例"
```

---

### Task 4: 后端路由（新增/编辑/换图/重置/删除）

**Files:**
- Modify: `src/index.js:179-202`（multer 定义区 + 角色路由区）

- [ ] **Step 1: 新增 avatar 专用 multer 实例**

在 `const upload = multer(...)` 行（179 行附近）之后添加：

```js
// 角色头像上传：限 5MB（文件类型由路由内魔数校验，不信任扩展名）
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
```

- [ ] **Step 2: 添加 5 个路由**

在 `GET /api/characters/:characterId/reference` 路由之后（202 行 `});` 后）插入：

```js
// ==================== 角色管理（写操作） ====================

// 新增角色（可复制现有）
app.post('/api/characters', (req, res) => {
  const { profile, copyFrom } = req.body || {};
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return res.status(400).json({ error: 'profile 必须为对象' });
  }
  const result = characterManager.createCharacter(profile, { copyFrom });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true, id: result.profile.id });
});

// 保存编辑（patch 浅合并 / full 整份覆盖）
app.put('/api/characters/:characterId', (req, res) => {
  const { patch, full } = req.body || {};
  if (patch === undefined && full === undefined) {
    return res.status(400).json({ error: '缺少 patch 或 full' });
  }
  const result = characterManager.saveProfile(req.params.characterId, { patch, full });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

// 更换角色参考图（魔数校验类型：jpg/png/webp）
app.post('/api/characters/:characterId/avatar', avatarUpload.single('avatar'), (req, res) => {
  const { characterId } = req.params;
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: '角色不存在' });
  if (!req.file) return res.status(400).json({ error: '未收到图片文件' });
  const buf = req.file.buffer;
  let ext = null;
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ext = 'jpg';
  else if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ext = 'png';
  else if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
  if (!ext) return res.status(400).json({ error: '仅支持 jpg / png / webp 图片' });
  const result = characterManager.saveAvatar(characterId, buf, ext);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

// 重置运行时状态（档案 JSON 不动）
app.post('/api/characters/:characterId/reset', (req, res) => {
  const { characterId } = req.params;
  if (!characterManager.hasCharacter(characterId)) return res.status(404).json({ error: '角色不存在' });
  db.deleteCharacterData(characterId);
  const removed = memoryService.removeCharacter(characterId);
  console.log(`[CharMgr] 重置 ${characterId}：运行时数据已清空，删除记忆文件 ${removed} 个`);
  res.json({ success: true });
});

// 彻底删除角色（目录 + SQLite + 记忆 + 媒体文件），需 confirm=角色全名
app.delete('/api/characters/:characterId', (req, res) => {
  const { characterId } = req.params;
  const c = characterManager.getCharacterProfile(characterId);
  if (!c) return res.status(404).json({ error: '角色不存在' });
  if (req.query.confirm !== c.full_name) {
    return res.status(400).json({ error: '确认名与角色全名不匹配，未执行删除' });
  }
  characterManager.deleteCharacter(characterId);
  db.deleteCharacterData(characterId);
  memoryService.removeCharacter(characterId);
  console.log(`[CharMgr] 已彻底删除角色: ${characterId}`);
  res.json({ success: true });
});
```

- [ ] **Step 3: 语法验证**

Run: `node --check src/index.js`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat(api): 角色管理写路由（新增/编辑/换图/重置/删除）"
```

---

### Task 5: 前端弹窗 HTML + 入口按钮 + 缓存版本

**Files:**
- Modify: `public/index.html`（feature-grid 区 264-268 行、设置弹窗数据管理区 434-440 行附近、settingsModal 结束后、script 内样式区）
- Modify: `public/sw.js:1`

- [ ] **Step 1: 主页功能宫格加"角色管理"按钮**

在 `feature-grid` 内（`videoFeatBtn` 按钮之后）加：

```html
      <button class="feat-btn" onclick="openCharMgr()"><span class="feat-icon">&#127917;</span>角色管理</button>
```

- [ ] **Step 2: 设置弹窗数据管理区加入口**

在设置弹窗"数据管理"按钮行（`导出备份`/`导入备份`/`清除聊天记录` 所在 div）内追加：

```html
      <button class="btn-cancel" onclick="closeSettings(); openCharMgr()">&#127917; 角色管理</button>
```

- [ ] **Step 3: 添加两个弹窗 HTML**

在 `settingsModal` 的结束 `</div>` 之后、`<!-- Image Lightbox -->` 注释之前插入：

```html
<!-- 角色管理弹窗 -->
<div class="modal-overlay" id="charMgrModal" onclick="if(event.target===this)closeCharMgr()">
  <div class="modal" style="width:640px">
    <button class="modal-close" onclick="closeCharMgr()" title="关闭">&#215;</button>
    <h3>&#127917; 角色管理</h3>
    <div style="display:flex;gap:8px;margin-bottom:4px">
      <button class="btn-primary" onclick="openCharEditorNew()">+ 新建角色</button>
    </div>
    <div id="charMgrList" style="margin-top:10px;display:flex;flex-direction:column;gap:8px"></div>
  </div>
</div>

<!-- 角色编辑弹窗 -->
<div class="modal-overlay" id="charEditorModal" style="z-index:210" onclick="if(event.target===this)closeCharEditor()">
  <div class="modal" style="width:640px">
    <button class="modal-close" onclick="closeCharEditor()" title="关闭">&#215;</button>
    <h3 id="ceTitle">编辑角色</h3>

    <div id="ceNewBar" class="field" style="display:none">
      <label>复制自现有角色（可选）</label>
      <select id="ceCopyFrom"><option value="">不复制，从空白开始</option></select>
    </div>

    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <img id="ceAvatarImg" alt="" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:1px solid var(--border);background:var(--bg)">
      <div>
        <button class="btn-cancel" onclick="document.getElementById('ceAvatarInput').click()">更换图片</button>
        <div class="hint">支持 jpg / png / webp，不超过 5MB，保存时上传</div>
      </div>
      <input type="file" id="ceAvatarInput" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="ceAvatarSelected(this)">
    </div>

    <div style="display:flex;gap:6px;margin-bottom:12px">
      <button class="btn-cancel" id="ceTabFormBtn" onclick="switchCeTab('form')">表单编辑</button>
      <button class="btn-cancel" id="ceTabJsonBtn" onclick="switchCeTab('json')">高级 JSON</button>
    </div>

    <div id="ceFormPane">
      <h4 class="section-title">基本信息</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>全名 *</label><input type="text" id="ceName" autocomplete="off"></div>
        <div class="field"><label>昵称</label><input type="text" id="ceNickname" autocomplete="off"></div>
        <div class="field"><label>性别</label>
          <select id="ceGender"><option>女</option><option>男</option><option>其他</option></select>
        </div>
        <div class="field"><label>生日（MM-DD）</label><input type="text" id="ceBirthday" placeholder="03-15" autocomplete="off"></div>
        <div class="field"><label>年龄</label><input type="number" id="ceAge" min="1" max="120"></div>
        <div class="field"><label>原型 archetype</label><input type="text" id="ceArchetype" placeholder="neighbor" autocomplete="off"></div>
      </div>
      <div class="field"><label>教育 / 职业</label><input type="text" id="ceEducation" autocomplete="off"></div>

      <h4 class="section-title">人设</h4>
      <div class="field"><label>性格</label><textarea id="cePersonality" rows="2"></textarea></div>
      <div class="field"><label>背景故事</label><textarea id="ceBackground" rows="4"></textarea></div>
      <div class="field"><label>说话风格</label><textarea id="ceSpeaking" rows="2"></textarea></div>
      <div class="field"><label>声音 preset（TTS）</label><input type="text" id="ceVoice" placeholder="Jennifer" autocomplete="off"></div>
      <div class="field"><label>爱好（每行一条）</label><textarea id="ceHobbies" rows="4"></textarea></div>

      <h4 class="section-title">雷区（触发词为正则）</h4>
      <div id="ceMinefields"></div>
      <button class="btn-cancel" onclick="addCeMineRow('','','')">+ 添加雷区</button>
    </div>

    <div id="ceJsonPane" style="display:none">
      <div class="hint">直接编辑整份角色档案 JSON，保存前会做语法校验。角色 id 不可修改。</div>
      <textarea id="ceJson" spellcheck="false" style="width:100%;height:380px;font-family:monospace;font-size:12px;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);margin-top:6px"></textarea>
    </div>

    <div id="ceDanger" style="display:none;margin-top:14px;padding-top:10px;border-top:1px dashed var(--border)">
      <div style="font-size:12px;color:var(--red);font-weight:700">危险操作</div>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
        <button class="btn-cancel" onclick="resetCharState()">重置状态（清空好感/聊天/记忆）</button>
        <button class="btn-cancel" style="color:var(--red);border-color:rgba(224,85,85,.4)" onclick="deleteChar()">删除角色</button>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn-cancel" onclick="closeCharEditor()">取消</button>
      <button class="btn-primary" onclick="saveCharEditor()">保存</button>
    </div>
    <div class="result" id="ceResult"></div>
  </div>
</div>
```

同时确认 CSS 已覆盖 textarea（若 `.modal .field input, .modal select` 未含 textarea，把该选择器改为 `.modal .field input, .modal select, .modal textarea`），textarea 需继承 `font-family` 和颜色。

- [ ] **Step 4: 升级 SW 缓存版本**

`public/sw.js` 第 1 行 `soul-v4` 改为 `soul-v5`。

- [ ] **Step 5: 验证**

重启服务，浏览器打开 `http://localhost:3000`：主页宫格出现"角色管理"，点击能弹出空列表管理弹窗（列表逻辑 Task 6 才有，此时显示为空即可），设置弹窗内有入口按钮。

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/sw.js
git commit -m "feat(ui): 角色管理/编辑弹窗结构与主页、设置入口"
```

---

### Task 6: 前端 JS——列表渲染与编辑器（打开/表单/雷区/换图）

**Files:**
- Modify: `public/index.html`（script 区末尾、`closeSettings` 函数之后附近）

- [ ] **Step 1: 添加状态与工具、管理列表、编辑器打开逻辑**

在 script 区（`closeSettings` 函数定义之后）添加：

```js
// ==================== 角色管理 ====================
let ceState = null; // { mode:'edit'|'new', id, profile, avatarFile, tab }

function ceMsg(ok, text) {
  const el = document.getElementById('ceResult');
  el.className = 'result ' + (ok ? 'success' : 'error');
  el.textContent = text;
}

async function openCharMgr() {
  closeSettings();
  document.getElementById('charMgrModal').classList.add('open');
  await renderCharMgrList();
}
function closeCharMgr() { document.getElementById('charMgrModal').classList.remove('open'); }

async function renderCharMgrList() {
  const res = await fetch(API + '/api/characters');
  const { characters } = await res.json();
  const box = document.getElementById('charMgrList');
  box.innerHTML = '';
  if (!characters || characters.length === 0) {
    box.innerHTML = '<div style="font-size:12px;color:var(--text2);text-align:center;padding:16px">暂无角色，点击上方"新建角色"创建</div>';
    return;
  }
  characters.forEach(c => {
    const row = document.createElement('div');
    row.className = 'char-card';
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:40px;height:40px;border-radius:50%;overflow:hidden;background:var(--grad);flex-shrink:0;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px"><img src="/api/characters/${c.id}/reference" alt=""></div>
        <div style="flex:1;min-width:0">
          <div class="cname">${escapeHtml(c.full_name)} <span style="font-size:12px;color:var(--text2);font-weight:400">${escapeHtml(c.gender || '')} ${c.age || '?'}岁</span></div>
          <div class="cdesc">${escapeHtml(c.nickname || '')} · 动态知识 ${c.dynamicKnowledgeCount || 0} 条</div>
        </div>
        <button class="btn-cancel" style="padding:4px 10px;font-size:11px">编辑</button>
      </div>`;
    // 头像加载失败回退首字符（DOM 绑定，与主页头像同模式）
    const img = row.querySelector('img');
    img.onerror = function() { const p = this.parentNode; this.remove(); if (p) p.textContent = (c.full_name || '?')[0]; };
    row.querySelector('button').onclick = () => openCharEditor(c.id);
    box.appendChild(row);
  });
}

function closeCharEditor() { document.getElementById('charEditorModal').classList.remove('open'); }

async function openCharEditor(id) {
  const res = await fetch(API + '/api/characters/' + id);
  if (!res.ok) { alert('加载角色档案失败'); return; }
  const profile = await res.json();
  ceState = { mode: 'edit', id, profile, avatarFile: null, tab: 'form' };
  document.getElementById('ceTitle').textContent = '编辑角色 · ' + profile.full_name;
  document.getElementById('ceNewBar').style.display = 'none';
  document.getElementById('ceDanger').style.display = 'block';
  document.getElementById('ceAvatarImg').src = '/api/characters/' + id + '/reference?t=' + Date.now();
  fillCeForm(profile);
  document.getElementById('ceJson').value = JSON.stringify(profile, null, 2);
  document.getElementById('ceResult').className = 'result';
  setCeTab('form');
  closeCharMgr();
  document.getElementById('charEditorModal').classList.add('open');
}

async function openCharEditorNew() {
  const res = await fetch(API + '/api/characters');
  const { characters } = await res.json();
  const sel = document.getElementById('ceCopyFrom');
  sel.innerHTML = '<option value="">不复制，从空白开始</option>' +
    characters.map(c => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join('');
  ceState = { mode: 'new', id: null, profile: { gender: '女', hobbies: [], minefields: [] }, avatarFile: null, tab: 'form' };
  document.getElementById('ceTitle').textContent = '新建角色';
  document.getElementById('ceNewBar').style.display = 'block';
  document.getElementById('ceDanger').style.display = 'none';
  document.getElementById('ceAvatarImg').removeAttribute('src');
  fillCeForm(ceState.profile);
  document.getElementById('ceJson').value = JSON.stringify(ceState.profile, null, 2);
  document.getElementById('ceResult').className = 'result';
  setCeTab('form');
  closeCharMgr();
  document.getElementById('charEditorModal').classList.add('open');
}
```

- [ ] **Step 2: 添加表单填充/收集/雷区行/页签切换/头像选择**

紧接其后添加：

```js
function fillCeForm(p) {
  document.getElementById('ceName').value = p.full_name || '';
  document.getElementById('ceNickname').value = p.nickname || '';
  document.getElementById('ceGender').value = p.gender || '女';
  document.getElementById('ceBirthday').value = p.birthday || '';
  document.getElementById('ceAge').value = p.age || '';
  document.getElementById('ceArchetype').value = p.archetype || '';
  document.getElementById('ceEducation').value = p.education || '';
  document.getElementById('cePersonality').value = p.base_personality || '';
  document.getElementById('ceBackground').value = p.background || '';
  document.getElementById('ceSpeaking').value = p.speaking_style || '';
  document.getElementById('ceVoice').value = p.voice_preset || '';
  document.getElementById('ceHobbies').value = (p.hobbies || []).join('\n');
  const mf = document.getElementById('ceMinefields');
  mf.innerHTML = '';
  (p.minefields || []).forEach(m => addCeMineRow(m.trigger || '', m.annoyance ?? 10, m.description || ''));
}

// 收集表单值，合并进 ceState.profile 并返回（不改 id）
function gatherCeProfile() {
  const p = ceState.profile;
  p.full_name = document.getElementById('ceName').value.trim();
  p.nickname = document.getElementById('ceNickname').value.trim();
  p.gender = document.getElementById('ceGender').value;
  p.birthday = document.getElementById('ceBirthday').value.trim();
  p.age = parseInt(document.getElementById('ceAge').value, 10) || 0;
  p.archetype = document.getElementById('ceArchetype').value.trim();
  p.education = document.getElementById('ceEducation').value.trim();
  p.base_personality = document.getElementById('cePersonality').value.trim();
  p.background = document.getElementById('ceBackground').value.trim();
  p.speaking_style = document.getElementById('ceSpeaking').value.trim();
  p.voice_preset = document.getElementById('ceVoice').value.trim();
  p.hobbies = document.getElementById('ceHobbies').value.split('\n').map(s => s.trim()).filter(Boolean);
  p.minefields = [...document.querySelectorAll('#ceMinefields .ce-mine-row')].map(row => {
    const inputs = row.querySelectorAll('input');
    return {
      trigger: inputs[0].value.trim(),
      annoyance: parseFloat(inputs[1].value) || 0,
      description: inputs[2].value.trim(),
    };
  }).filter(m => m.trigger);
  return p;
}

function addCeMineRow(trigger, annoyance, description) {
  const row = document.createElement('div');
  row.className = 'ce-mine-row';
  row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
  row.innerHTML = `
    <input type="text" placeholder="触发词(正则)" style="flex:2" autocomplete="off">
    <input type="number" placeholder="烦闷值" style="width:80px">
    <input type="text" placeholder="说明" style="flex:2" autocomplete="off">
    <button class="btn-cancel" style="padding:4px 8px" title="删除此行">&#10005;</button>`;
  const inputs = row.querySelectorAll('input');
  inputs[0].value = trigger; inputs[1].value = annoyance; inputs[2].value = description;
  row.querySelector('button').onclick = () => row.remove();
  document.getElementById('ceMinefields').appendChild(row);
}

// 页签切换（不走 confirm 的内部版本 setCeTab + 带确认的对外版本 switchCeTab）
function setCeTab(tab) {
  document.getElementById('ceFormPane').style.display = tab === 'form' ? 'block' : 'none';
  document.getElementById('ceJsonPane').style.display = tab === 'json' ? 'block' : 'none';
  document.getElementById('ceTabFormBtn').style.borderColor = tab === 'form' ? 'var(--accent)' : '';
  document.getElementById('ceTabJsonBtn').style.borderColor = tab === 'json' ? 'var(--accent)' : '';
  ceState.tab = tab;
}

function switchCeTab(tab) {
  if (tab === 'json') {
    // 表单值先合并进 profile 再序列化，避免表单未保存的修改丢失
    ceState.profile = gatherCeProfile();
    document.getElementById('ceJson').value = JSON.stringify(ceState.profile, null, 2);
    setCeTab('json');
    return;
  }
  // 切回表单：JSON 若有未保存修改需确认放弃
  let dirty = false;
  try {
    dirty = JSON.stringify(JSON.parse(document.getElementById('ceJson').value)) !== JSON.stringify(ceState.profile);
  } catch { dirty = true; }
  if (dirty && !confirm('高级 JSON 中的修改未保存，切回表单将丢失这些修改，继续？')) return;
  setCeTab('form');
}

function ceAvatarSelected(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { ceMsg(false, '图片不能超过 5MB'); input.value = ''; return; }
  ceState.avatarFile = f;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('ceAvatarImg').src = e.target.result; };
  reader.readAsDataURL(f);
}
```

- [ ] **Step 3: 验证**

浏览器：主页 → 角色管理 → 列表渲染出现 4 个现有角色卡片（含头像）；点"编辑"→ 表单填满字段、雷区行与 lin_004.json 一致、危险区显示；点"新建角色"→ 复制下拉含全部角色、危险区隐藏；页签切换正常。

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 角色管理列表与编辑器交互（表单/雷区/JSON页签/换图预览）"
```

---

### Task 7: 前端 JS——保存/重置/删除与主页联动

**Files:**
- Modify: `public/index.html`（script 区，接 Task 6 代码之后）

- [ ] **Step 1: 添加保存/上传/重置/删除/联动函数**

```js
async function saveCharEditor() {
  let body;
  if (ceState.tab === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(document.getElementById('ceJson').value);
    } catch (e) {
      ceMsg(false, 'JSON 语法错误：' + e.message);
      return;
    }
    if (ceState.mode === 'edit' && parsed.id !== ceState.id) {
      ceMsg(false, '不允许修改角色 id');
      return;
    }
    body = { full: parsed };
  } else {
    const patch = gatherCeProfile();
    delete patch.id; // id 不可经 patch 修改
    body = { patch };
  }

  try {
    if (ceState.mode === 'new') {
      const copyFrom = document.getElementById('ceCopyFrom').value;
      const profile = body.full || body.patch;
      const res = await fetch(API + '/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, copyFrom: copyFrom || undefined }),
      });
      if (!res.ok) { ceMsg(false, (await res.json()).error || '创建失败'); return; }
      const { id } = await res.json();
      ceState.id = id; ceState.mode = 'edit';
      document.getElementById('ceDanger').style.display = 'block';
      if (ceState.avatarFile) await uploadCeAvatar(id);
      ceMsg(true, '创建成功，可继续编辑');
    } else {
      const res = await fetch(API + '/api/characters/' + ceState.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { ceMsg(false, (await res.json()).error || '保存失败'); return; }
      if (ceState.avatarFile) await uploadCeAvatar(ceState.id);
      ceMsg(true, '已保存并生效');
    }
    await syncCharToHome();
  } catch (e) {
    ceMsg(false, '请求失败：' + e.message);
  }
}

async function uploadCeAvatar(id) {
  const fd = new FormData();
  fd.append('avatar', ceState.avatarFile);
  ceState.avatarFile = null;
  document.getElementById('ceAvatarInput').value = '';
  const res = await fetch(API + '/api/characters/' + id + '/avatar', { method: 'POST', body: fd });
  if (!res.ok) ceMsg(false, (await res.json()).error || '头像上传失败');
}

// 角色数据变更后同步主页：loadCharacters() 内部会自动 selectCharacter 第一个角色，
// 进而触发 refreshState() + loadChatHistory()，无需额外调用
async function syncCharToHome() {
  await loadCharacters();
}

async function resetCharState() {
  const p = ceState.profile;
  if (!confirm(`确定重置「${p.full_name}」的运行时状态？\n\n好感度、等级、聊天记录、照片、日记、长期记忆将全部清空，不可恢复。\n角色人设档案不受影响。`)) return;
  try {
    const res = await fetch(API + '/api/characters/' + ceState.id + '/reset', { method: 'POST' });
    if (!res.ok) { ceMsg(false, (await res.json()).error || '重置失败'); return; }
    ceMsg(true, '已重置运行时状态');
    await syncCharToHome();
  } catch (e) { ceMsg(false, '请求失败：' + e.message); }
}

async function deleteChar() {
  const p = ceState.profile;
  const input = prompt(`此操作将彻底删除角色「${p.full_name}」\n及其全部数据（档案、聊天、照片、日记、记忆），不可恢复。\n\n请输入角色全名以确认：`);
  if (input === null) return;
  if (input.trim() !== p.full_name) { ceMsg(false, '输入与角色全名不匹配，未删除'); return; }
  try {
    const res = await fetch(API + '/api/characters/' + ceState.id + '?confirm=' + encodeURIComponent(p.full_name), { method: 'DELETE' });
    if (!res.ok) { ceMsg(false, (await res.json()).error || '删除失败'); return; }
    closeCharEditor();
    closeCharMgr();
    await loadCharacters(); // 自动选中列表第一个角色（或显示"还没有角色"）
    await refreshState();
  } catch (e) { ceMsg(false, '请求失败：' + e.message); }
}
```

- [ ] **Step 2: 手动主流程验证**

浏览器完整过一遍：
1. 新建空白角色（填全名，保存）→ 提示创建成功，主页列表出现
2. 给新角色换一张本地图片 → 保存后头像更新
3. 编辑现有角色改昵称 → 保存 → 主页昵称更新，聊天功能不受影响
4. 复制现有角色新建 → 新角色档案与源一致但 id 不同
5. 重置某角色状态 → 好感度回到初始、聊天记录清空
6. 删除测试角色（输入全名确认）→ 列表移除

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 角色保存/重置/删除交互与主页状态联动"
```

---

### Task 8: 端到端 API 对抗性验证

**Files:**
- Create: `.scratch/` 下验证用临时文件（已 gitignore）

- [ ] **Step 1: 准备测试素材**

启动服务（`npm start` 后台）。写 `.scratch/char-new.json`：

```json
{ "profile": { "id": "test_001", "full_name": "测试角色", "nickname": "测测", "gender": "女", "age": 21 } }
```

写 `.scratch/char-patch.json`：

```json
{ "patch": { "nickname": "改过的昵称" } }
```

生成假图片（文本伪装 jpg）：`.scratch/fake.jpg` 写入任意非图片文本；再找一张真实 jpg 复制为 `.scratch/real.jpg`。

- [ ] **Step 2: happy path 验证**

```bash
curl -s -X POST localhost:3000/api/characters -H 'Content-Type: application/json' -d @.scratch/char-new.json
# Expected: {"success":true,"id":"test_001"}
ls data/characters/test_001/
# Expected: test_001.json
curl -s -X PUT localhost:3000/api/characters/test_001 -H 'Content-Type: application/json' -d @.scratch/char-patch.json
# Expected: {"success":true}
curl -s -X POST localhost:3000/api/characters/test_001/avatar -F avatar=@.scratch/real.jpg
# Expected: {"success":true}
curl -s -X POST localhost:3000/api/characters/test_001/reset
# Expected: {"success":true}
curl -s -X DELETE 'localhost:3000/api/characters/test_001?confirm=%E6%B5%8B%E8%AF%95%E8%A7%92%E8%89%B2'
# Expected: {"success":true}（confirm 为 URL 编码的"测试角色"）
ls data/characters/ | grep test_001 || echo "目录已删除"
# Expected: 目录已删除
```

- [ ] **Step 3: 对抗用例验证**

```bash
# 1. 非法 id → 400
curl -s -X POST localhost:3000/api/characters -H 'Content-Type: application/json' -d '{"profile":{"id":"BAD ID!","full_name":"x"}}'
# Expected: {"error":"角色 id 非法..."}
# 2. 重复 id → 400
curl -s -X POST localhost:3000/api/characters -H 'Content-Type: application/json' -d '{"profile":{"id":"lin_004","full_name":"重复"}}'
# Expected: {"error":"角色 id 已存在: lin_004"}
# 3. patch 改 id → 400
curl -s -X PUT localhost:3000/api/characters/lin_004 -H 'Content-Type: application/json' -d '{"patch":{"id":"hacked"}}'
# Expected: {"error":"不允许修改角色 id"}
# 4. full 改 id → 400
curl -s -X PUT localhost:3000/api/characters/lin_004 -H 'Content-Type: application/json' -d '{"full":{"id":"other","full_name":"x"}}'
# Expected: {"error":"不允许修改角色 id"}
# 5. 坏 JSON body → 400/语法错误（Express JSON 中间件抛 400）
curl -s -X PUT localhost:3000/api/characters/lin_004 -H 'Content-Type: application/json' -d '{bad json'
# Expected: 400（HTML 错误页或 Illegal JSON）
# 6. 删除 confirm 不匹配 → 400 且角色仍在
curl -s -X DELETE 'localhost:3000/api/characters/lin_004?confirm=%E9%94%99%E5%90%8D'
# Expected: {"error":"确认名与角色全名不匹配..."}；ls data/characters/lin_004 仍存在
# 7. 删除/重置不存在的角色 → 404
curl -s -X DELETE 'localhost:3000/api/characters/no_such?confirm=x'
curl -s -X POST localhost:3000/api/characters/no_such/reset
# Expected: {"error":"角色不存在"}
# 8. 假图片上传 → 400
curl -s -X POST localhost:3000/api/characters/lin_004/avatar -F avatar=@.scratch/fake.jpg
# Expected: {"error":"仅支持 jpg / png / webp 图片"}；lin_004 原图未被删
# 9. 空 full_name → 400
curl -s -X POST localhost:3000/api/characters -H 'Content-Type: application/json' -d '{"profile":{"id":"test_002"}}'
# Expected: {"error":"full_name（角色全名）不能为空"}
```

- [ ] **Step 4: 数据完整性抽查**

创建 `.scratch/check.cjs`（验证重置后无残留）：

```js
const Database = require('D:/AI/ai-mate-soul/node_modules/better-sqlite3');
const db = new Database('D:/AI/ai-mate-soul/data/ai_mate.db', { readonly: true });
const cid = process.argv[2];
if (!cid) { console.error('用法: node check.cjs <characterId>'); process.exit(1); }
const tables = ['characters_state','chat_history','user_facts','diaries','daily_schedules','future_plans','photos','anniversaries','applied_event_emotions','inner_monologue'];
let total = 0;
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE character_id = ?`).get(cid).n;
  if (n > 0) console.log(`残留 ${t}: ${n} 行`);
  total += n;
}
console.log(total === 0 ? `OK: 角色 ${cid} 运行时数据已全部清空` : `FAIL: 共残留 ${total} 行`);
```

执行（先对某现有角色调 reset API，再）：

```bash
node .scratch/check.cjs lin_004
# Expected: OK: 角色 lin_004 运行时数据已全部清空
```

验证完成后 `.scratch/` 内测试文件随 gitignore 留存即可，不需清理提交。

- [ ] **Step 5: Commit（如有修复）**

```bash
git add -A
git commit -m "test: 角色管理 API 对抗性验证通过（或 fix: 修复验证发现的问题）"
```

---

### Task 9: 收尾——CHANGE.md 与项目 CLAUDE.md

**Files:**
- Modify: `CHANGE.md`（顶部追加条目）
- Modify: `CLAUDE.md`（如有需要更新架构说明）

- [ ] **Step 1: CHANGE.md 追加迭代条目**

按现有格式在顶部（标题之后、最新条目之前）追加：日期 2026-09-09、主题"角色可视化管理"、核心变更点（CharacterManager 写方法、5 个新 API、前端双弹窗、重置=清运行时状态、删除=彻底删除需输入全名确认）、遗留事项。

- [ ] **Step 2: 项目 CLAUDE.md 同步**

在"角色与数据"小节补一句：角色支持 Web 端可视化管理（增删改/换图/重置），写操作 API 走 CharacterManager。

- [ ] **Step 3: 最终验证 + Commit**

重启服务确认一切正常，`git status` 确认无遗漏文件，提交：

```bash
git add CHANGE.md CLAUDE.md
git commit -m "docs: 角色管理功能迭代记录"
```
