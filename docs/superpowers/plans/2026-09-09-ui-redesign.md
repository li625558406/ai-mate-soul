# 前端界面重设计（方案 C · 暖调陪伴风）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec（`docs/superpowers/specs/2026-09-09-ui-redesign-design.md`）将 `public/index.html` 重写为"角色主页中心"布局：主页（状态总览+功能宫格）+ 聊天页 + 桌面左栏常驻，暖调陪伴风视觉系统。

**Architecture:** 单文件原生 HTML/CSS/JS 重写。同一套 DOM 双端复用：手机端 `body.view-home`/`body.view-chat` 类切换主页与聊天页互斥全屏；桌面端（≥900px）media query 让主页左栏与聊天区并排。所有后端 API 调用、Socket.IO、SSE 解析、语音通话音频管线等 JS 逻辑原样保留，只改 DOM 挂载点与 id 映射。

**Tech Stack:** 原生 HTML/CSS/JS（无框架无构建）、Socket.IO client、PWA（sw.js 不动）。

**测试说明:** 本项目无测试框架、无 lint，spec 规定手动验证。每个 Task 的验证步骤用 Playwright MCP 工具驱动真实浏览器完成（dev server: `npm run dev`，地址 `http://localhost:3000`）。TDD 不适用于本次纯 UI 重写（无测试基建，逻辑层不变），验证以"界面行为正确"为准。

**前置准备（每个 Task 开始前执行）:**

```bash
cd "D:/AI/ai-mate-soul" && npm run dev   # run_in_background: true
```

Playwright 打开 `http://localhost:3000`。注意：`data/` 下的角色与 settings.json 是运行时数据（本机已有）。若无任何角色，验证以"空态引导正确"为准。

---

### Task 1: 布局骨架重写 + 视觉系统 + 视图切换 + 数值胶囊

**Files:**
- Modify: `public/index.html`（整文件重写，旧 JS 逻辑段原样迁移）

这是唯一一次整文件重写。旧 `<script>` 内容从现文件迁移，按下述"JS 迁移适配清单"修改。**所有旧元素 id 除明确标注删除外全部保留**（旧 JS 依赖它们）。

- [ ] **Step 1: 写入新 `<style>` 设计系统**

用以下内容完整替换 `public/index.html` 第 18-287 行的 `<style>` 块：

```css
:root {
  --bg: #fdf8f5; --surface: #ffffff; --border: #eadfd8;
  --text: #5a4a42; --text2: #b08a80;
  --accent: #ff6a88; --accent2: #ff9a8b;
  --grad: linear-gradient(135deg, #ff9a8b, #ff6a88);
  --shadow: 0 2px 10px rgba(255, 138, 128, 0.10);
  --red: #e05555; --green: #3dba78; --yellow: #d4a843; --orange: #e08a3a; --blue: #4a90d9;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Segoe UI', system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--text); height:100vh; height:100dvh; display:flex; overflow:hidden; }
#app { display:flex; width:100%; height:100%; }

/* ===== 主页 #homePane（手机=全屏主页，桌面=左栏，Task 4 处理桌面） ===== */
#homePane { width:100%; flex-shrink:0; overflow-y:auto; display:flex; flex-direction:column; gap:12px; padding:16px 16px calc(16px + env(safe-area-inset-bottom)); }
.hero-card { background:linear-gradient(135deg,#ffe3e8,#ffd8c8); border-radius:16px; padding:20px 16px; text-align:center; box-shadow:var(--shadow); }
.hero-avatar { width:64px; height:64px; border-radius:50%; background:var(--grad); margin:0 auto 8px; display:flex; align-items:center; justify-content:center; color:#fff; font-size:24px; overflow:hidden; }
.hero-avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.hero-name { font-size:18px; font-weight:700; }
.hero-sub { font-size:12px; color:#8a7468; margin-top:2px; }
.hero-badges { display:flex; gap:6px; justify-content:center; margin-top:8px; flex-wrap:wrap; }
.mood-badge, .weather-tag { display:inline-flex; align-items:center; gap:4px; background:rgba(255,255,255,.65); border-radius:12px; padding:3px 12px; font-size:12px; color:#7a5a50; }
.mood-badge.positive { color:#2a9960; } .mood-badge.negative { color:var(--red); }
.mood-badge.cold_war { color:var(--red); animation:pulse-red 2s infinite; }
@keyframes pulse-red { 0%,100%{opacity:1} 50%{opacity:.6} }

.stats-overview { background:var(--surface); border-radius:14px; padding:14px; box-shadow:var(--shadow); display:flex; flex-direction:column; gap:10px; }
.stat-row { display:flex; align-items:center; gap:8px; }
.stat-lbl { font-size:11px; color:var(--text2); white-space:nowrap; width:38px; }
.stat-row b { font-size:12px; min-width:44px; text-align:right; font-variant-numeric:tabular-nums; }
.bar { flex:1; height:8px; background:var(--bg); border-radius:4px; position:relative; overflow:hidden; }
.bar > div { height:100%; border-radius:4px; transition:width .5s, left .5s, background .5s; position:absolute; top:0; }
.bar.mood .mood-center { position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--text2); opacity:.35; z-index:2; }
.stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:2px; }
.stat-cell { background:var(--bg); border-radius:10px; padding:8px 10px; }
.stat-cell b { display:block; font-size:14px; }
.stat-cell span { font-size:10px; color:var(--text2); }

.btn-grad { width:100%; padding:14px; background:var(--grad); color:#fff; border:none; border-radius:14px; font-size:16px; font-weight:600; cursor:pointer; box-shadow:0 4px 14px rgba(255,106,136,.35); }
.btn-grad:active { transform:scale(.98); }

.feature-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.feat-btn { display:flex; flex-direction:column; align-items:center; gap:4px; padding:12px 6px; background:var(--surface); border:1px solid var(--border); border-radius:12px; color:var(--text); font-size:12px; cursor:pointer; box-shadow:var(--shadow); }
.feat-btn .feat-icon { font-size:20px; }
.feat-btn:disabled { opacity:.4; cursor:not-allowed; }
.feat-btn:hover:not(:disabled) { border-color:var(--accent); }

.facts-card { background:var(--surface); border-radius:14px; padding:14px; box-shadow:var(--shadow); }
.facts-title { font-size:13px; font-weight:700; color:var(--accent); margin-bottom:8px; }
.facts-list { max-height:140px; overflow-y:auto; }
.fact-tag { display:inline-block; background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:3px 9px; font-size:11px; color:var(--text2); margin:2px 4px 2px 0; }
.fact-tag b { color:var(--text); font-weight:500; }

.home-actions { display:flex; gap:8px; margin-top:auto; }
.home-actions button { flex:1; padding:10px 0; background:var(--surface); border:1px solid var(--border); border-radius:12px; color:var(--text2); font-size:13px; cursor:pointer; }
.home-actions button:hover { border-color:var(--accent); color:var(--accent); }

/* ===== 聊天页 #chatPane ===== */
#chatPane { width:100%; flex:1; min-width:0; display:flex; flex-direction:column; background:var(--bg); }
#cfgBanner { display:none; padding:8px 16px; font-size:12px; background:rgba(255,170,60,.12); color:#ffb43c; align-items:center; gap:10px; border-bottom:1px solid rgba(255,170,60,.25); flex-shrink:0; }
.chat-header { padding:12px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; background:var(--surface); flex-shrink:0; }
.chat-header .avatar { width:36px; height:36px; border-radius:50%; background:var(--grad); display:flex; align-items:center; justify-content:center; font-size:16px; color:#fff; overflow:hidden; flex-shrink:0; }
.chat-header .avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.chat-header .info { flex:1; min-width:0; }
.chat-header .name { font-weight:600; font-size:15px; }
.btn-back { display:flex; width:32px; height:32px; border:none; background:none; font-size:20px; color:var(--text2); cursor:pointer; align-items:center; justify-content:center; }
.status-badge { font-size:11px; padding:3px 10px; border-radius:12px; font-weight:600; flex-shrink:0; }
.status-cold_war { background:rgba(224,85,85,.1); color:var(--red); }
.status-angry { background:rgba(224,138,58,.1); color:var(--orange); }
.status-uneasy { background:rgba(212,168,67,.1); color:#b08930; }
.status-joyful { background:rgba(61,186,120,.1); color:#2a9960; }
.status-happy { background:rgba(61,186,120,.1); color:#2a9960; }

.busy-bar { display:none; padding:6px 16px; background:rgba(108,140,255,.06); border-bottom:1px solid var(--border); font-size:13px; color:var(--accent); align-items:center; gap:8px; flex-shrink:0; }
.busy-bar.show { display:flex; }
.busy-bar .busy-label { flex:1; }
.busy-bar .busy-countdown { font-variant-numeric:tabular-nums; font-weight:600; color:var(--orange); }
.cold-war-hint { font-size:12px; color:var(--red); padding:0 16px; display:none; flex-shrink:0; }
.cold-war-hint.show { display:block; padding:6px 16px; }

.messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
.msg { max-width:78%; display:flex; flex-direction:column; }
.msg.user { align-self:flex-end; }
.msg.ai, .msg.proactive, .msg.photo, .msg.video { align-self:flex-start; }
.msg .bubble { padding:10px 14px; border-radius:16px; font-size:14px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
.msg.user .bubble { background:var(--grad); color:#fff; border-bottom-right-radius:4px; box-shadow:var(--shadow); }
.msg.ai .bubble { background:var(--surface); border-bottom-left-radius:4px; box-shadow:var(--shadow); }
.msg.proactive .bubble { background:var(--surface); border:1px solid rgba(255,106,136,.35); border-bottom-left-radius:4px; }
.msg.photo .bubble, .msg.video .bubble { background:var(--surface); padding:6px; max-width:360px; box-shadow:var(--shadow); }
.msg.photo img { width:100%; border-radius:10px; cursor:pointer; display:block; }
.msg.video video { width:100%; border-radius:10px; display:block; }
.photo-caption { font-size:12px; color:var(--text2); padding:4px 6px; }
.msg .time { font-size:10px; color:var(--text2); margin-top:4px; }
.msg.user .time { text-align:right; }
.msg .thought { font-size:12px; color:var(--text2); font-style:italic; padding:4px 8px; background:rgba(255,106,136,.06); border-radius:6px; margin-bottom:4px; display:none; border-left:2px solid var(--accent); }
.msg .thought.show { display:block; }
.msg .tts-btn { margin-left:8px; cursor:pointer; opacity:.6; }

/* 数值反馈胶囊：贴在 AI 消息下方 */
.msg-capsule { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
.msg-capsule span { font-size:10px; padding:2px 8px; border-radius:9px; background:rgba(255,106,136,.08); color:var(--text2); }
.msg-capsule span.up { background:rgba(61,186,120,.12); color:#2a9960; }
.msg-capsule span.down { background:rgba(224,85,85,.1); color:var(--red); }
.msg-capsule span.mine { background:rgba(224,138,58,.12); color:var(--orange); }
.msg-capsule span.levelup { background:var(--grad); color:#fff; font-weight:700; padding:3px 10px; }

.typing { align-self:flex-start; color:var(--text2); font-size:13px; padding:4px 0; display:none; }
.typing.show { display:block; }
.typing-thinking { color:var(--accent); }
.msg.system { align-self:center; max-width:90%; }
.msg.system .bubble { background:var(--surface); color:var(--text2); font-size:12px; box-shadow:none; border:1px dashed var(--border); }

.input-area { padding:10px 12px calc(10px + env(safe-area-inset-bottom)); border-top:1px solid var(--border); display:flex; gap:8px; background:var(--surface); flex-shrink:0; }
.input-area input { flex:1; padding:12px 16px; background:var(--bg); border:1px solid var(--border); border-radius:14px; color:var(--text); font-size:16px; outline:none; min-width:0; }
.input-area input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(255,106,136,.1); }
.input-area input:disabled { opacity:.5; }
.input-area button { padding:12px 20px; background:var(--grad); color:#fff; border:none; border-radius:14px; font-size:14px; cursor:pointer; white-space:nowrap; }
.input-area button:disabled { opacity:.5; cursor:not-allowed; }
.btn-icon { width:40px; height:40px; padding:0; display:flex; align-items:center; justify-content:center; border-radius:12px; cursor:pointer; border:1px solid var(--border); background:var(--surface); color:var(--text2); font-size:16px; flex-shrink:0; align-self:center; }
.btn-icon:hover { border-color:var(--accent); color:var(--accent); }
.btn-icon:disabled { opacity:.4; cursor:not-allowed; }

/* ===== 手机视图切换：主页/聊天互斥 ===== */
body.view-home #chatPane { display:none; }
body.view-chat #homePane { display:none; }

/* ===== 弹层（modal / panel / overlay） ===== */
.modal-overlay { position:fixed; inset:0; background:rgba(90,74,66,.35); backdrop-filter:blur(4px); z-index:200; display:none; align-items:center; justify-content:center; }
.modal-overlay.open { display:flex; }
.modal { background:var(--surface); border-radius:16px; padding:22px; width:440px; max-width:92vw; max-height:88vh; overflow-y:auto; box-shadow:0 8px 40px rgba(90,74,66,.2); }
.modal h3 { font-size:16px; margin-bottom:14px; }
.modal .field { margin-bottom:12px; }
.modal .field label { display:block; font-size:12px; color:var(--text2); margin-bottom:5px; }
.modal .field input, .modal select { width:100%; padding:9px 11px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; }
.modal .field .hint { font-size:11px; color:var(--text2); margin-top:4px; line-height:1.5; }
.modal .btn-row { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }
.btn-primary { padding:9px 20px; background:var(--grad); color:#fff; border:none; border-radius:10px; font-size:13px; cursor:pointer; }
.btn-primary:disabled { opacity:.5; cursor:not-allowed; }
.btn-cancel { padding:9px 20px; background:transparent; color:var(--text2); border:1px solid var(--border); border-radius:10px; font-size:13px; cursor:pointer; }
.modal .result { font-size:13px; margin-top:12px; padding:10px; border-radius:8px; display:none; white-space:pre-wrap; }
.modal .result.success { display:block; background:rgba(61,186,120,.08); border:1px solid rgba(61,186,120,.3); color:#2a9960; }
.modal .result.error { display:block; background:rgba(224,85,85,.08); border:1px solid rgba(224,85,85,.3); color:var(--red); }
.modal h4.section-title { font-size:13px; font-weight:700; color:var(--accent); margin:18px 0 8px; }

.char-card { background:var(--bg); border:1px solid var(--border); border-radius:12px; padding:10px 12px; cursor:pointer; transition:all .2s; }
.char-card:hover { border-color:var(--accent); }
.char-card.active { border-color:var(--accent); background:rgba(255,106,136,.06); }
.char-card .cname { font-size:14px; font-weight:600; }
.char-card .cdesc { font-size:12px; color:var(--text2); margin-top:2px; }

.panel-overlay { display:none; position:fixed; inset:0; z-index:99; }
.panel-overlay.active { display:block; }
.diary-panel, .anniv-panel { position:fixed; right:-420px; top:0; bottom:0; width:400px; max-width:100vw; background:var(--surface); border-left:1px solid var(--border); z-index:100; transition:right .3s; display:flex; flex-direction:column; box-shadow:-4px 0 24px rgba(90,74,66,.12); }
.diary-panel.open, .anniv-panel.open { right:0; }
.panel-header { padding:14px 18px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
.panel-header h3 { font-size:15px; }
.panel-close { background:none; border:none; color:var(--text2); font-size:20px; cursor:pointer; }
.diary-list, .anniv-list { flex:1; overflow-y:auto; padding:12px 18px; }
.diary-entry, .anniv-entry { background:var(--bg); border:1px solid var(--border); border-radius:12px; padding:12px; margin-bottom:10px; }
.diary-entry.locked { opacity:.5; }
.diary-date, .anniv-type { font-size:12px; color:var(--accent); font-weight:600; }
.diary-content { font-size:13px; line-height:1.7; margin-top:6px; white-space:pre-wrap; }
.anniv-date { font-size:12px; color:var(--text2); margin-top:4px; }
.anniv-desc { font-size:13px; line-height:1.6; margin-top:6px; }
.anniv-upcoming { border-color:var(--orange); }
.diary-empty, .anniv-empty { color:var(--text2); font-size:13px; text-align:center; padding:40px 20px; }

.call-overlay { position:fixed; inset:0; background:linear-gradient(160deg,#ff9a8b 0%,#c86dd7 100%); z-index:300; display:none; flex-direction:column; align-items:center; justify-content:center; gap:18px; }
.call-overlay.active { display:flex; }
.call-avatar { width:96px; height:96px; border-radius:50%; background:rgba(255,255,255,.2); backdrop-filter:blur(10px); display:flex; align-items:center; justify-content:center; font-size:38px; color:#fff; animation:call-pulse 2s ease-in-out infinite; }
@keyframes call-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.3)} 50%{box-shadow:0 0 0 20px rgba(255,255,255,0)} }
.call-name { font-size:22px; font-weight:600; color:#fff; }
.call-status { font-size:14px; color:rgba(255,255,255,.75); }
.call-timer { font-size:28px; color:rgba(255,255,255,.9); font-variant-numeric:tabular-nums; }
.call-subtitle { max-width:400px; text-align:center; font-size:14px; color:rgba(255,255,255,.65); min-height:20px; line-height:1.5; }
.call-controls { display:flex; gap:16px; margin-top:16px; }
.call-btn { width:60px; height:60px; border-radius:50%; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:24px; color:#fff; }
.call-btn-end { background:var(--red); }
.call-btn-mute { background:rgba(255,255,255,.2); border:1px solid rgba(255,255,255,.3); }
.call-btn-mute.muted { background:var(--yellow); color:#000; }

.lightbox { position:fixed; inset:0; z-index:400; background:rgba(0,0,0,.85); display:none; align-items:center; justify-content:center; cursor:zoom-out; }
.lightbox.open { display:flex; }
.lightbox img { max-width:95vw; max-height:90vh; border-radius:10px; object-fit:contain; }

::-webkit-scrollbar { width:6px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
```

- [ ] **Step 2: 写入新 `<body>` HTML 结构**

用以下内容完整替换 `<body>` 内的全部静态 HTML（`<script>` 前的部分）。**注意保留的旧 id**：`cfgBanner`、`headerAvatar`、`headerName`、`headerDesc`、`statusBadge`、`callBtn`、`busyBar/busyIcon/busyLabel/busyCountdown`、`coldWarHint`、`messages`、`typingIndicator`、`msgInput`、`sendBtn`、`ttsBtn`、`factsList`、`videoFeatBtn`、`characterList`（移入角色弹层）、`affBar/xpBar/moodBar`（暂保留原类名行为，Task 2 重构）、`stAffection/stMood/stStage/stChats/stDays/stLifeStage/stLevel/stEmotion/metaInfo`（暂以隐藏 div 保留避免旧 JS 报错，Task 2 删除）、`callOverlay` 全组、`diaryPanel/diaryOverlay/diaryList`、`annivPanel/annivOverlay/annivList`、`importModal` 全组、`charDetailModal` 全组、`settingsModal` 全组、`lightbox/lightboxImg`。

```html
<div id="app">
  <!-- ===== 主页（手机全屏 / 桌面左栏） ===== -->
  <aside id="homePane">
    <div class="hero-card" id="heroCard">
      <div class="hero-avatar" id="heroAvatar">?</div>
      <div class="hero-name" id="heroName">未选择角色</div>
      <div class="hero-sub" id="heroSub">添加角色后开始你的故事</div>
      <div class="hero-badges">
        <span class="mood-badge" id="heroMoodBadge" style="display:none">--</span>
        <span class="weather-tag" id="heroWeather" style="display:none"></span>
      </div>
    </div>

    <div class="stats-overview" id="statsOverview">
      <!-- Task 2 将重构此区；先保留旧状态元素（隐藏）避免旧 JS 报错 -->
      <div style="display:none">
        <div id="stAffection">--</div><div id="stMood">--</div><div id="stStage">--</div>
        <div id="stChats">--</div><div id="stDays">--</div><div id="stLifeStage">--</div>
        <div id="stLevel">--</div><div id="stEmotion">--</div>
      </div>
      <div class="stat-row"><span class="stat-lbl">好感度</span><div class="bar"><div id="affBar" style="width:0%"></div></div><b id="affVal">--</b></div>
      <div class="stat-row"><span class="stat-lbl">心情</span><div class="bar mood"><div class="mood-center"></div><div id="moodBar" style="left:50%;width:0%;background:var(--text2)"></div></div></div>
      <div class="stat-row"><span class="stat-lbl">经验</span><div class="bar"><div id="xpBar" style="width:0%;background:var(--accent)"></div></div><b id="xpVal">--</b></div>
      <div id="metaInfo" style="display:none"></div>
    </div>

    <button class="btn-grad" id="startChatBtn" onclick="openChatView()">💬 开始聊天</button>

    <div class="feature-grid">
      <button class="feat-btn" onclick="openDiary()"><span class="feat-icon">&#128221;</span>秘密日记</button>
      <button class="feat-btn" onclick="openAnniv()"><span class="feat-icon">&#128197;</span>纪念日</button>
      <button class="feat-btn" id="videoFeatBtn" onclick="generateVideo()" disabled><span class="feat-icon">&#127916;</span>生成视频</button>
    </div>

    <div class="facts-card">
      <div class="facts-title">&#9829; 她记住你的事</div>
      <div class="facts-list" id="factsList"><span style="font-size:11px;color:var(--text2)">暂无</span></div>
    </div>

    <div class="home-actions">
      <button onclick="openCharModal()">&#128101; 切换角色</button>
      <button onclick="openSettings()">&#9881; 设置</button>
      <button onclick="openProfileModal()">&#128100; 我的信息</button>
    </div>
  </aside>

  <!-- ===== 聊天页 ===== -->
  <main id="chatPane">
    <div id="cfgBanner">
      <span style="flex:1">&#9888; 对话 API 未配置，聊天功能不可用</span>
      <button class="btn-cancel" style="padding:5px 14px" onclick="openSettings()">去配置</button>
    </div>
    <div class="chat-header">
      <button class="btn-back" id="btnBackHome" onclick="openHomeView()">&#8592;</button>
      <div class="avatar" id="headerAvatar">?</div>
      <div class="info">
        <div class="name" id="headerName">未选择角色</div>
        <div class="hero-sub" id="headerDesc">--</div>
      </div>
      <span class="status-badge status-comfortable" id="statusBadge" style="display:none">舒适</span>
      <button class="btn-icon" title="语音通话" id="callBtn" onclick="startVoiceCall()" disabled style="color:var(--green)">&#128222;</button>
    </div>
    <div class="busy-bar" id="busyBar">
      <span class="busy-icon" id="busyIcon">&#128564;</span>
      <span class="busy-label" id="busyLabel">正在睡觉...</span>
      <span class="busy-countdown" id="busyCountdown">--:--</span>
    </div>
    <div class="cold-war-hint" id="coldWarHint">AI 正在冷战，请等待或尝试道歉</div>
    <div class="messages" id="messages">
      <div class="typing" id="typingIndicator">对方正在输入...</div>
    </div>
    <div class="input-area">
      <input id="msgInput" placeholder="输入消息..." disabled>
      <button id="sendBtn" disabled onclick="sendMessage()">发送</button>
      <button class="btn-icon" title="朗读最后一条回复" id="ttsBtn" onclick="playTTS()" disabled>&#9835;</button>
    </div>
  </main>
</div>

<!-- 角色切换弹层（characterList 移到这里） -->
<div class="modal-overlay" id="charModal">
  <div class="modal">
    <h3>&#128101; 选择角色</h3>
    <div id="characterList" style="display:flex; flex-direction:column; gap:8px;"></div>
    <div class="btn-row"><button class="btn-cancel" onclick="closeModal('charModal')">关闭</button></div>
  </div>
</div>

<!-- 我的信息弹层 -->
<div class="modal-overlay" id="profileModal">
  <div class="modal">
    <h3>&#128100; 我的信息</h3>
    <div class="field"><label>User ID（用于区分本地数据）</label><input id="userId" value="test_user" onchange="onUserIdChange()"></div>
    <div class="field"><label>你的名字</label><input id="userName" placeholder="告诉 AI 你的名字"></div>
    <div class="btn-row">
      <button class="btn-cancel" onclick="closeModal('profileModal')">关闭</button>
      <button class="btn-primary" onclick="setUserName()">保存名字</button>
    </div>
  </div>
</div>

<!-- 以下弹层从旧文件原样迁移（id 与内部结构完全不变，仅 class 使用新体系）： -->
<!-- callOverlay / diaryPanel+diaryOverlay / annivPanel+annivOverlay / importModal / charDetailModal / settingsModal / lightbox -->
```

**迁移弹层的具体规则**：从旧文件复制这七组弹层 HTML，id 与内部结构保持不变，仅三处调整——
1. `.modal` 容器删除内联 `style="width:...;max-height:..."`（新 class 已含尺寸）。
2. 弹层内 `btn-primary`/`btn-cancel`/`result` 等 class 名与新 CSS 一致（旧名相同，无需改）。
3. **彻底删除** `sidebar`、`sidebarOverlay`、`sidebarToggle` 三组 DOM（JS 同步删引用，见 Step 3a）。

- [ ] **Step 3: JS 迁移适配**

`<script>` 内容从旧文件整体迁移，做且仅做以下修改：

**3a. 删除 sidebar 相关**：删掉 `toggleSidebar()`、`closeSidebar()` 两个函数；删掉 `onUserIdChange()` 中的 `closeSidebar();` 一行；删除 body 里的 `sidebarToggle`/`sidebarOverlay` DOM（Step 2 已无）。

**3b. 删除 ttsFeatBtn 引用**（输入栏 `ttsBtn` 已在相同位置处理，功能重复）：删除以下行——
- `selectCharacter()` 中：`document.getElementById('ttsFeatBtn').disabled = true;` 与 `document.getElementById('ttsFeatBtn').disabled = false;`（两处）
- `loadChatHistory()` 中：`document.getElementById('ttsFeatBtn').disabled = false;`
- `sendMessage()` 中：`document.getElementById('ttsFeatBtn').disabled = !lastAiReply;`
- `playTTS()` 中：三处 `document.getElementById('ttsFeatBtn').disabled = ...`
- `clearAllChat()` 中：`document.getElementById('ttsFeatBtn').disabled = true;`

**3c. `sendMessage()` 中 meta 渲染改为胶囊**：把从 `// Update meta` 注释开始、到 `info.innerHTML = html;` 结束的整段（约 30 行，引用 `metaInfo` 的代码）替换为：

```js
    // Update meta：数值反馈胶囊贴在 AI 消息下方
    if (lastMeta) appendCapsule(aiMsgEl, lastMeta);
```

并在 `appendMsg` 函数后面新增：

```js
// 数值反馈胶囊：好感±/成长/xp/心情±/情绪/雷区/升级，无变化时不渲染
function appendCapsule(aiMsgEl, m) {
  const parts = [];
  if (m.affectionDelta) {
    const cls = m.affectionDelta > 0 ? 'up' : 'down';
    parts.push(`<span class="${cls}">&#9829; 好感 ${m.affectionDelta > 0 ? '+' : ''}${m.affectionDelta}</span>`);
  }
  if (m.growthBonus > 0) parts.push(`<span class="up">成长 +${m.growthBonus}</span>`);
  parts.push(`<span>+${m.xpGained}xp</span>`);
  if (m.moodDelta !== undefined && m.moodDelta !== 0) {
    const cls = m.moodDelta > 0 ? 'up' : 'down';
    parts.push(`<span class="${cls}">心情 ${m.moodDelta > 0 ? '+' : ''}${Math.round(m.moodDelta * 10) / 10}</span>`);
  }
  const moodLabelMap = { joyful:'开心', happy:'愉悦', uneasy:'不悦', angry:'愤怒', cold_war:'冷战' };
  if (m.emotionState && m.emotionState !== 'calm' && m.emotionState !== 'comfortable') {
    parts.push(`<span>${moodLabelMap[m.emotionState] || m.emotionState}</span>`);
  }
  if (m.triggeredMinefield) parts.push(`<span class="mine">&#9888; 雷区：${escapeHtml(m.triggeredMinefield)}</span>`);
  if (m.leveledUp) parts.push(`<span class="levelup">&#10024; LEVEL UP!</span>`);
  if (parts.length <= 1) return; // 只有 xp 一项且无其他变化时不显示
  const cap = document.createElement('div');
  cap.className = 'msg-capsule';
  cap.innerHTML = parts.join('');
  aiMsgEl.appendChild(cap);
}
```

**3d. 新增视图切换函数**（放在 PWA 注册前）：

```js
// ==================== 手机端视图切换 ====================
function openChatView() {
  document.body.classList.remove('view-home');
  document.body.classList.add('view-chat');
  scrollBottom();
}
function openHomeView() {
  document.body.classList.add('view-home');
  document.body.classList.remove('view-chat');
  refreshState();
}
// 通用弹层开关
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }
function openCharModal() { openModal('charModal'); }
function openProfileModal() { openModal('profileModal'); }
```

**3e. Escape 关闭所有弹层**：替换文件末尾的 keydown 监听为：

```js
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeLightbox(); closeSettings(); closeImportModal();
    closeModal('charModal'); closeModal('profileModal'); closeCharDetail();
    closeDiary(); closeAnniv();
  }
});
```

**3f. `selectCharacter()` 收尾跳转**：函数末尾（`loadChatHistory(uid, c.id);` 之后）追加一行，切换角色后手机端进入聊天页：

```js
  if (document.body.classList.contains('view-home') && window.innerWidth < 900) openChatView();
```

其余所有 JS（Socket.IO 事件、SSE 解析、语音通话、busy 倒计时、diary/anniv/import/settings/lightbox 函数）**原样保留，一字不改**。

- [ ] **Step 4: 启动验证（Playwright）**

1. `npm run dev`（后台），浏览器打开 `http://localhost:3000`。
2. 快照断言：`#homePane` 可见且含「开始聊天」「秘密日记/纪念日/生成视频」宫格、「她记住你的事」、「切换角色/设置/我的信息」；`#chatPane` 隐藏（`body.view-home`）。
3. 点「开始聊天」→ `#chatPane` 可见、顶栏有 ← 与 📞、输入栏只有 输入/发送/♪；点 ← 返回主页。
4. 点「切换角色」→ 角色列表弹层出现且卡片含头像/名字/详情按钮；选第一个角色 → 弹层关闭、自动进入聊天页、头部显示角色名与参考图头像。
5. 发送一条消息 → 用户气泡粉色渐变；若 API 已配置，AI 回复出现且（若有数值变化）消息下方出现胶囊；若未配置，显示 `[Error]` 气泡（cfgBanner 也应可见）。
6. 主页点「设置」/「我的信息」→ 弹层可开可关（Esc 也关）。
7. 窗口 resize 到 500px 宽再回 1200px：手机模式下主页/聊天互斥仍正确（桌面并排是 Task 4，此时 1200px 宽下两栏会挤在一起——可接受，不视为失败）。

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 重写布局骨架——主页/聊天页双视图 + 暖调视觉系统 + 数值胶囊"
```

---

### Task 2: 状态总览重组（hero 卡渲染 + refreshState 重写 + 删除冗余状态元素）

**Files:**
- Modify: `public/index.html`（`refreshState()` 重写、`#statsOverview` 区重构）

- [ ] **Step 1: 重构 `#statsOverview` HTML**

将 Task 1 中临时保留的隐藏 div（`stAffection/stMood/stStage/stChats/stDays/stLifeStage/stLevel/stEmotion/metaInfo`）**全部删除**，`#statsOverview` 最终内容为：

```html
    <div class="stats-overview" id="statsOverview">
      <div class="stat-row"><span class="stat-lbl">好感度</span><div class="bar"><div id="affBar" style="width:0%"></div></div><b id="affVal">--</b></div>
      <div class="stat-row"><span class="stat-lbl">心情</span><div class="bar mood"><div class="mood-center"></div><div id="moodBar" style="left:50%;width:0%;background:var(--text2)"></div></div></div>
      <div class="stat-row"><span class="stat-lbl">经验</span><div class="bar"><div id="xpBar" style="width:0%;background:var(--accent)"></div></div><b id="xpVal">--</b></div>
      <div class="stat-grid">
        <div class="stat-cell"><b id="stStage">--</b><span>关系阶段</span></div>
        <div class="stat-cell"><b id="stLifeStage">--</b><span>人生阶段</span></div>
        <div class="stat-cell"><b id="stDays">--</b><span>互动天数</span></div>
        <div class="stat-cell"><b id="stChats">--</b><span>对话次数</span></div>
      </div>
    </div>
```

- [ ] **Step 2: 重写 `refreshState()`**

整函数替换为（保留防串角色守卫；心情双卡合并为 hero 徽章；天气写入 hero；等级经验写入进度条与 `xpVal`；好感写入 `affBar`+`affVal`）：

```js
async function refreshState() {
  if (!currentCharacterId) return;
  const uid = document.getElementById('userId').value;
  const targetCharId = currentCharacterId;
  try {
    const res = await fetch(API + `/api/state/${uid}/${targetCharId}`);
    const s = await res.json();
    if (targetCharId !== currentCharacterId) return; // 防止切换角色后旧请求覆盖

    if (s.userName) document.getElementById('userName').value = s.userName;

    // Hero 卡
    const moodLabels = { joyful:'开心', happy:'愉悦', calm:'平静', uneasy:'不悦', angry:'愤怒', cold_war:'冷战' };
    const badge = document.getElementById('heroMoodBadge');
    const moodLevel = s.moodLevel ?? 0;
    const moodCls = moodLevel >= 20 ? 'positive' : moodLevel <= -20 ? (s.emotionState === 'cold_war' ? 'negative cold_war' : 'negative') : '';
    badge.style.display = 'inline-flex';
    badge.className = 'mood-badge ' + moodCls;
    badge.textContent = `${moodLabels[s.emotionState] || s.emotionState || '平静'} ${moodLevel >= 0 ? '+' : ''}${Math.round(moodLevel)}`;
    const weatherEl = document.getElementById('heroWeather');
    if (s.weatherMood) { weatherEl.style.display = 'inline-flex'; weatherEl.textContent = '☁ ' + s.weatherMood; }
    else weatherEl.style.display = 'none';

    // 好感度
    const aff = Number(s.affection);
    document.getElementById('affVal').textContent = aff.toFixed(1);
    const affBar = document.getElementById('affBar');
    affBar.style.width = Math.max(0, Math.min(100, aff)) + '%';
    affBar.style.background = aff <= 20 ? 'var(--red)' : aff <= 60 ? 'var(--yellow)' : 'var(--green)';

    // 心情双向条（-100 ~ +100，中点为 0）
    const clamped = Math.max(-100, Math.min(100, moodLevel));
    const pct = (clamped + 100) / 2;
    const moodBar = document.getElementById('moodBar');
    if (clamped >= 0) {
      moodBar.style.left = '50%'; moodBar.style.width = (pct - 50) + '%';
      moodBar.style.background = clamped >= 50 ? 'var(--green)' : clamped >= 20 ? '#6bc77a' : 'var(--text2)';
    } else {
      moodBar.style.left = pct + '%'; moodBar.style.width = (50 - pct) + '%';
      moodBar.style.background = clamped <= -80 ? 'var(--red)' : clamped <= -50 ? '#e07050' : clamped <= -20 ? 'var(--orange)' : 'var(--text2)';
    }

    // 等级经验
    const lvl = s.level || 1; const xp = s.experience || 0;
    const curT = XP_THRESHOLDS[lvl - 1] || 0; const nextT = XP_THRESHOLDS[lvl] || curT + 1000;
    document.getElementById('xpVal').textContent = `Lv.${lvl}`;
    document.getElementById('xpBar').style.width = Math.min(100, ((xp - curT) / (nextT - curT)) * 100) + '%';

    // 互动数据
    document.getElementById('stStage').textContent = s.personalityStage || '--';
    document.getElementById('stDays').textContent = s.interactionDays ?? '--';
    document.getElementById('stChats').textContent = s.chatCount ?? '--';
    document.getElementById('stLifeStage').textContent = s.lifeStage || '--';

    // facts
    const factsDiv = document.getElementById('factsList');
    if (s.facts && s.facts.length > 0) {
      factsDiv.innerHTML = s.facts.map(f => `<span class="fact-tag"><b>${escapeHtml(f.fact_key)}</b>: ${escapeHtml(f.fact_value)}</span>`).join('');
    } else {
      factsDiv.innerHTML = '<span style="font-size:11px;color:var(--text2)">暂无</span>';
    }

    // 聊天头部状态徽章
    const sb = document.getElementById('statusBadge');
    if (s.emotionState && !['calm', 'comfortable'].includes(s.emotionState)) {
      sb.style.display = 'inline-block';
      sb.className = `status-badge status-${s.emotionState}`;
      sb.textContent = moodLabels[s.emotionState] || s.emotionState;
      if (s.emotionState === 'cold_war') sb.textContent += ` (${s.coldWarRemaining}min)`;
    } else sb.style.display = 'none';

    document.getElementById('coldWarHint').classList.toggle('show', s.coldWarRemaining > 0);
    updateBusyBar(s.busyActivity, s.busyRemaining, s.busyUntil);
  } catch(e) {}
}
```

- [ ] **Step 3: 确认无残留引用**

运行：

```bash
grep -n "stAffection\|stMood\b\|stLevel\|stEmotion\|metaInfo\|ttsFeatBtn\|sidebarToggle\|toggleSidebar\|closeSidebar" public/index.html
```

预期：无任何输出。若有输出，逐行删除对应 JS 引用（这些元素在 Task 1/2 的 DOM 中已不存在）。注意 `selectCharacter()` 本身不引用这些元素，无需改动；旧 `refreshState` 对它们的赋值已随 Step 2 整体替换。

- [ ] **Step 3b: `selectCharacter()` 增加 hero 卡渲染**

在 `selectCharacter()` 中现有 `document.getElementById('headerDesc').textContent = ...` 一行之后追加（hero 卡与聊天头部各自渲染，互不替代）：

```js
  // Hero 卡（主页）
  document.getElementById('heroName').textContent = c.full_name;
  document.getElementById('heroSub').textContent = `${c.nickname} · ${genderIcon} · ${c.age}岁 · ${c.birthday}`;
  document.getElementById('heroAvatar').innerHTML = `<img src="${refUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.remove();document.getElementById('heroAvatar').textContent='${c.full_name[0]}'">`;
```

（`refUrl`、`genderIcon` 变量该函数中已存在，直接复用。）

- [ ] **Step 4: 空角色引导态**

`loadCharacters()` 中，`characters` 为空时（在 `characters.forEach` 前加分支）：

```js
  if (characters.length === 0) {
    list.innerHTML = '<div style="font-size:13px;color:var(--text2);padding:12px;text-align:center">还没有角色<br><span style="font-size:11px">请在 data/characters/ 目录添加角色档案后重启</span></div>';
    return;
  }
```

- [ ] **Step 5: 验证（Playwright）**

1. 选角色后主页 hero 卡显示：头像参考图、名字、副标题（昵称·性别·年龄·生日）、心情徽章（含 ±数值）、天气（若后端返回）。
2. 三条进度条有值：好感度颜色随数值（<20 红 / <60 黄 / ≥60 绿）、经验条、心情双向条（负值向左红橙、正值向右绿）。
3. 四格互动数据（关系阶段/人生阶段/互动天数/对话次数）与 `/api/state` 返回一致。
4. facts 标签流渲染正确；无 facts 显示「暂无」。
5. 全文件 `grep -n "stAffection\|stMood\|stLevel\|stEmotion\|metaInfo" public/index.html` 无结果。
6. 聊天页状态徽章、冷战提示、忙碌倒计时行为与旧版一致。
7. 对抗性：将 `/api/state` 临时停服（或断网刷新）→ 页面无 JS 报错崩溃，聊天仍可打开。

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 状态总览重组——hero 角色卡 + 进度条化指标 + 心情双卡合并"
```

---

### Task 3: 弹层重组（设置内数据管理 + 角色弹层交互完善）

**Files:**
- Modify: `public/index.html`（settingsModal 增数据管理区、角色卡片迁移适配）

- [ ] **Step 1: settingsModal 增加「数据管理」分区**

在 settingsModal 的 `.btn-row`（保存按钮行）**之前**插入：

```html
    <h4 class="section-title">&#128230; 数据管理</h4>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button class="btn-cancel" onclick="exportSoul()">&#128230; 导出备份</button>
      <button class="btn-cancel" onclick="openImportModal()">&#128229; 导入备份</button>
      <button class="btn-cancel" style="color:var(--red); border-color:rgba(224,85,85,.4)" onclick="clearAllChat()">&#128465; 清除聊天记录</button>
    </div>
    <div class="hint" style="font-size:11px;color:var(--text2);margin-top:6px">备份导出为加密 .soul 文件，导入需提供导出时的密钥</div>
```

- [ ] **Step 2: 角色卡片适配弹层**

`loadCharacters()` 生成的卡片 HTML 更新为（保留原 onclick 行为，删除「详情」小按钮改为整卡点击选中、卡片右上角 ⓘ 详情）：

```js
    div.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
      <div style="width:36px;height:36px;border-radius:50%;background:var(--grad);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;flex-shrink:0;overflow:hidden">
        <img src="/api/characters/${c.id}/reference" style="width:100%;height:100%;object-fit:cover" onerror="this.remove();this.parentNode.textContent='${c.full_name[0]}'">
      </div>
      <div style="flex:1;min-width:0">
        <div class="cname">${c.full_name} <span style="font-size:12px;color:var(--text2);font-weight:400">${genderIcon} ${c.age}岁</span></div>
        <div class="cdesc">${c.nickname || ''}</div>
      </div>
      <button class="btn-cancel" onclick="event.stopPropagation();showCharDetail('${c.id}')" style="padding:4px 10px;font-size:11px">详情</button>
    </div>`;
```

`selectCharacter()` 末尾追加关闭弹层（在 Step 1 Task 1 的 3f 追加行之前）：

```js
  closeModal('charModal');
```

- [ ] **Step 3: `setUserName()` / `clearAllChat()` 反馈优化**

- `setUserName()` 成功后追加 `closeModal('profileModal');`（替换原 `appendMsg('system', ...)` 行——主页看不到消息流，改用弹层关闭即成功反馈；失败仍 alert）：

```js
async function setUserName() {
  const uid = document.getElementById('userId').value;
  const name = document.getElementById('userName').value.trim();
  if (!name) return;
  await fetch(API + `/api/user/${uid}/name`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name}) });
  closeModal('profileModal');
  refreshState();
}
```

- `clearAllChat()` 从设置弹层触发后，若在聊天页需清空消息流（原逻辑已调 `clearChat()`，无需改）；仅追加成功后关闭设置弹层：在 `clearChat();` 后加 `closeSettings();`。

- [ ] **Step 4: 验证（Playwright）**

1. 设置弹层出现「数据管理」三按钮；「导出备份」触发下载；「导入备份」打开导入弹层且 Esc/取消可关；「清除聊天记录」弹 confirm，取消无副作用，确认后消息流清空且设置弹层关闭。
2. 切换角色弹层：卡片完整、点卡片选中并关闭弹层并进入聊天；点「详情」打开角色详情且不触发选中（`event.stopPropagation()`）。
3. 我的信息：保存名字后弹层关闭、hero 无报错。
4. 对抗性：清除记录弹 confirm 期间连按 Esc → 不应误清；导入弹层空文件直接点导入 → 显示「请选择备份文件」红色提示。

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 弹层重组——设置内数据管理、角色切换弹层、信息保存反馈"
```

---

### Task 4: 桌面端适配（≥900px 左栏常驻 + 聊天右区）

**Files:**
- Modify: `public/index.html`（仅 CSS media query + 两处按钮隐藏）

- [ ] **Step 1: 追加桌面 media query**

在 `<style>` 末尾（`::-webkit-scrollbar` 规则后）追加：

```css
/* ===== 桌面端 ≥900px：主页左栏常驻 + 聊天右区 ===== */
@media (min-width: 900px) {
  #homePane { width: 340px; border-right: 1px solid var(--border); background: var(--surface); }
  #chatPane { flex: 1; }
  #startChatBtn, #btnBackHome { display: none !important; }
  body.view-home #chatPane { display: flex; }   /* 桌面端忽略手机互斥类 */
  body.view-chat #homePane { display: flex; }
  .hero-card { padding: 16px 14px; }
  .hero-avatar { width: 52px; height: 52px; font-size: 20px; }
  .messages { padding: 20px 28px; }
  .msg { max-width: 66%; }
  .input-area { padding: 14px 24px; }
  .diary-panel, .anniv-panel { width: 400px; }
}
```

- [ ] **Step 2: 验证（Playwright）**

1. 1200px 宽：左栏 340px（hero/进度条/宫格/facts/操作行齐全），右侧聊天区可直接输入，无需点开始聊天；`#startChatBtn` 与 `#btnBackHome` 不可见。
2. resize 到 800px：回到手机模式，主页/聊天互斥切换正常。
3. resize 到 1400px 再回 800px 再回 1200px：布局每次都正确（无残留 `view-*` 类影响桌面布局）。
4. 聊天中途从 1200px resize 到 800px：消息流不丢、输入框可用。
5. 对抗性：900px 整数边界（899px / 900px / 901px）三种宽度各看一眼，无双滚动条、无横向溢出。

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): 桌面端适配——≥900px 主页左栏常驻与聊天区并排"
```

---

### Task 5: 对抗性全量验证 + 文档收尾

**Files:**
- Modify: `CHANGE.md`（追加迭代条目）

- [ ] **Step 1: 全量核心流验证（Playwright + 手机宽度模拟）**

桌面 1200px 与手机 390px 各过一遍：
1. 选角色 → 聊天（SSE 流式回复、`<thought>` 独白显示）→ 照片消息点击放大 → lightbox 关闭。
2. TTS 朗读（♪ 按钮）、语音通话开与挂断（需 HTTPS + 麦克风，桌面 Chrome 允许模拟）。
3. 日记面板、纪念日面板开/关（手机端全宽滑入）。
4. 生成视频按钮状态流转（未配置视频 API 时应报「任务创建失败」系统消息而非静默）。
5. 设置保存后 cfgBanner 状态刷新。
6. 导出 .soul（下载 + 密钥 system 提示）→ 刷新页面数据不丢。

- [ ] **Step 2: 对抗性用例清单（逐条执行并记录）**

| 用例 | 操作 | 预期 |
|---|---|---|
| 超长文本 | 发送 2000 字符无空格英文 + emoji 连发 | 气泡正常换行，不撑破 `max-width:78%` |
| 空角色列表 | 临时把 `data/characters` 改名重启 | 主页显示引导文案，所有按钮不抛错 |
| 切角色中断流 | AI 回复中途点切换角色 | 旧消息移除、新角色历史正确、无串角色 |
| Esc 连按 | 开满所有弹层后连按 Esc | 全部关闭、无残留遮罩挡点击 |
| 边界 resize | 899/900/901px | 无横向滚动条、无双滚动条 |
| 断网发送 | DevTools offline 后发消息 | `[连接失败]` 气泡，恢复网络后可继续聊 |
| 弹层叠加 | 设置弹层里点导入 → 两层弹层 | 各自独立关闭，z-index 正确 |

- [ ] **Step 3: CHANGE.md 追加条目**

在 `CHANGE.md` 顶部标题后追加（增量，不覆盖已有记录）：

```markdown
## 2026-09-09 — 前端界面重设计（角色主页中心 + 暖调陪伴风）

### 改动主题
`public/index.html` 整体重写布局：弃用"侧边栏大杂烩"结构，改为角色主页中心（方案 C）。

### 核心变更点
1. **信息架构**：主页（hero 角色卡 + 进度条化状态总览 + 开始聊天 + 功能宫格 + facts 展示）+ 聊天页（纯聊天）双视图；手机端 `body.view-home/view-chat` 互斥切换，桌面端 ≥900px 主页压缩为左栏常驻。
2. **视觉系统**：暖调陪伴风（奶油底 #fdf8f5 + 珊瑚粉 #ff6a88 渐变主色 + 柔投影），气泡/弹层/按钮全面换肤。
3. **状态重组**：心情双卡合并为 hero 心情徽章 + 双向心情条；好感度/等级经验进度条化；天气入角色卡；每条 AI 回复的数值反馈改为消息下方胶囊（LEVEL UP/雷区醒目样式）。
4. **入口收敛**：朗读/日记/导出重复入口删除；设置弹层新增数据管理区（导出/导入/清除记录）；User ID/名字移入「我的信息」弹层；角色选择移入「切换角色」弹层。
5. **JS 逻辑零改动**：API 调用、Socket.IO、SSE、语音通话音频管线原样保留，仅 DOM 挂载点适配。

### 遗留事项
- 照片相册页需新增照片列表接口，属后续迭代。
- 手机 PWA 实机（iOS Safari / Android Chrome）需用户自行验证麦克风与 safe-area。
```

- [ ] **Step 4: 最终提交**

```bash
git add CHANGE.md public/index.html
git commit -m "docs: 界面重设计迭代记录 + 对抗性验证收尾"
```

- [ ] **Step 5: 让用户实机验收**

请用户在手机（`https://<局域网IP>:3443`）和桌面各体验一遍，确认后结束。
