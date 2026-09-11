// Live2D 形象渲染封装：主窗口与小窗共用。
// 职责：加载模型、idle 动作（模型自带自动播）、鼠标视线、嘴型（振幅驱动）、表情（情绪驱动）。
// 消费同源 BroadcastChannel('avatar')：主窗口广播振幅/情绪，本窗口渲染。
(() => {
  'use strict';

  const DEFAULT_MODEL_URL = '/live2d/models/haru/haru_greeter_t03.model3.json';
  const CHANNEL = 'avatar';
  // 小窗页面（overlay.html）：握手 model-request 时只有主窗应答，防止双窗互答干扰
  const IS_OVERLAY = /\/live2d\/overlay\.html$/.test(location.pathname);

  // 情绪状态 → Cubism 参数（值域 -1..1 / 0..1，模型缺失某参数时 setParameterValueById 安全 no-op）
  const EMOTION_PARAMS = {
    joyful:     { ParamMouthForm: 1, ParamEyeLSmile: 0.7, ParamEyeRSmile: 0.7 },
    happy:      { ParamMouthForm: 0.8, ParamBrowLY: 0.3, ParamBrowRY: 0.3 },
    calm:       {},
    comfortable:{ ParamMouthForm: 0.4 },
    uneasy:     { ParamMouthForm: -0.4, ParamBrowLY: -0.3, ParamBrowRY: -0.3 },
    angry:      { ParamMouthForm: -1, ParamBrowLForm: -1, ParamBrowRForm: -1, ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8 },
    cold_war:   { ParamMouthForm: -0.8, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7 },
    neutral:    {}, normal: {},
  };

  let app = null, model = null, ready = false, canvas = null;
  let currentUrl = null, pendingUrl = null, channel = null;   // 当前模型 url / mount 前暂存 / 频道引用（握手回发用）
  let loadSeq = 0;                                   // 模型切换单调序号：防并发加载乱序完成时旧请求覆盖新请求
  let baseW = 0, baseH = 0;                          // 模型未缩放时的自然尺寸（fit 基准，防止重复缩放复利）
  let mouth = 0, mouthTarget = 0, lastAmpAt = 0;     // 嘴型当前值/目标值/最近振幅时间
  let emotionParams = null, emotionUntil = 0;        // 情绪参数与失效时间
  let paused = false;                                // 隐藏/降级时置 true：tick 空转短路（渲染循环保留，shared ticker 不能全局 stop）

  function fit() {
    if (!model || !app || !baseW || !baseH) return;
    const w = app.renderer.width / app.renderer.resolution;
    const h = app.renderer.height / app.renderer.resolution;
    const scale = Math.min(w / baseW, h / baseH) * 1.15; // 略放大裁边
    model.scale.set(scale);
    // 模型原点为左上角（anchor 默认 0,0）：水平居中，头顶留 3% 白，
    // overscan 放大的多余高度从底部出血（脚部裁边）
    model.x = (w - baseW * scale) / 2;
    model.y = h * 0.03;
  }

  // 切换模型：成功后旧模型销毁、新模型应用当前情绪参数；失败保留当前形象（不触发降级隐藏）
  async function loadModel(url) {
    // 对抗：畸形 url（非字符串/扩展名不符/协议注入——只接受站内绝对路径）
    if (typeof url !== 'string' || !url.startsWith('/') || !url.endsWith('.model3.json')) return false;
    if (!ready) { pendingUrl = url; return false; }   // 未 mount（小窗时序）：暂存，mount 后加载
    if (url === currentUrl) return true;              // 去重：同 url 不重复重载
    const PIXI = window.PIXI;
    if (!PIXI || !PIXI.live2d || !app) return false;
    const seq = ++loadSeq;                            // 取号：后续只有最新取号者才允许提交
    try {
      const next = await PIXI.live2d.Live2DModel.from(url);
      if (seq !== loadSeq) {   // 已有更新的切换请求在途/完成：本次作废，销毁刚加载的模型防纹理泄漏
        try { next.destroy({ texture: true, baseTexture: true, children: true }); } catch {}
        return false;
      }
      app.stage.addChild(next);            // 先上屏，成功后再切模块引用
      const old = model;
      model = next;
      baseW = next.width; baseH = next.height;
      if (old) { app.stage.removeChild(old); try { old.destroy({ texture: true, baseTexture: true, children: true }); } catch {} }
      currentUrl = url;                    // currentUrl 最后写：只有完整提交才记录成功
      fit();                               // 新模型自然尺寸变了，按固定基准重新布局
      return true;
    } catch (err) {
      console.warn('[avatar] 模型切换失败，保留当前形象:', err.message);
      return false;                        // model 未被改动的路径上旧形象原样保留
    }
  }

  // 每 tick 把嘴型/情绪参数覆写到模型（LOW 优先级保证在动作更新之后执行）
  function tick() {
    if (paused || !model) return;
    if (Date.now() - lastAmpAt > 350) mouthTarget = 0;   // 振幅流断了自然闭嘴
    mouth += (mouthTarget - mouth) * 0.35;                // 平滑插值防抖
    const core = model.internalModel.coreModel;
    core.setParameterValueById('ParamMouthOpenY', mouth);
    if (emotionParams && Date.now() < emotionUntil) {
      for (const [id, v] of Object.entries(emotionParams)) core.setParameterValueById(id, v);
    }
  }

  function postToChannel(msg) { try { channel && channel.postMessage(msg); } catch {} }

  function handleMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'amplitude' && typeof msg.v === 'number') {
      // 限幅并忽略畸形值（对抗：NaN/负数/超大值）
      mouthTarget = Math.min(1, Math.max(0, Number.isFinite(msg.v) ? msg.v : 0));
      lastAmpAt = Date.now();
    } else if (msg.type === 'emotion' && typeof msg.state === 'string') {
      // 用 hasOwn 防原型链污染（对抗：msg.state='constructor'/'__proto__' 等取到 Object.prototype）
      emotionParams = Object.hasOwn(EMOTION_PARAMS, msg.state) ? EMOTION_PARAMS[msg.state] : null;
      emotionUntil = Date.now() + 10 * 60_000; // 情绪持续 10 分钟后回 idle
    } else if (msg.type === 'model' && typeof msg.url === 'string') {
      loadModel(msg.url);
    } else if (msg.type === 'model-request') {
      // 小窗 mount 后索取当前模型；只有主窗应答（IS_OVERLAY 方向过滤，防双窗互答干扰）
      if (!IS_OVERLAY && currentUrl) postToChannel({ type: 'model', url: currentUrl });
    }
  }

  // pixi7 无 InteractionManager，autoInteract 失效：窗口级 mousemove 手动换算焦点
  // 监听在 window 上，pointer-events:none 的 canvas 也能收到；事件坐标减 canvas 偏移即模型局部坐标
  // 定义在模块级：降级清理时需要稳定的具名引用 removeEventListener
  function onMove(e) {
    if (!model) return;
    const rect = canvas.getBoundingClientRect();
    model.focus(e.clientX - rect.left, e.clientY - rect.top);
  }

  // 挂载到指定 canvas；失败返回 false 并隐藏容器（降级链，不阻塞聊天）
  async function mount(canvasEl) {
    // 重入保护：已就绪直接成功；上次 mount 留下半成品 app 时拒绝叠加创建
    if (ready) return true;
    if (app) return false;
    canvas = canvasEl;
    try {
      const PIXI = window.PIXI;
      if (!PIXI || !PIXI.live2d) throw new Error('vendor 未加载');
      // 显式传宽高：不传时 PIXI 用默认 800x600 且 autoDensity 会把 canvas 内联样式覆写成 800px/600px，撑破容器
      const w = canvasEl.clientWidth || 300;
      const h = canvasEl.clientHeight || 440;
      app = new PIXI.Application({ view: canvas, width: w, height: h, backgroundAlpha: 0, autoDensity: true, resolution: devicePixelRatio || 1 });
      // pixi 7.4.3 主 bundle 不含 InteractionManager，autoInteract 依赖的 plugins.interaction 不存在会静默失效，故不传
      model = await PIXI.live2d.Live2DModel.from(DEFAULT_MODEL_URL);
      app.stage.addChild(model);
      currentUrl = DEFAULT_MODEL_URL;   // 记录当前模型（后续握手回发/去重判断依赖）
      // 记录自然尺寸（此刻 scale=1），后续 fit 用固定基准，避免 ResizeObserver 反复缩放复利
      baseW = model.width;
      baseH = model.height;
      fit();
      // canvas 尺寸变化时同步 renderer 并重新布局（主窗口与小窗通用）
      // 读 clientWidth/clientHeight（CSS 像素）：autoDensity 下 canvas.width 是物理像素，直接用会越调越大
      // 尺寸为 0（容器隐藏/降级）时置 paused，tick 空转短路，避免空转渲染浪费 GPU
      new ResizeObserver(() => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        paused = (w === 0 || h === 0);
        if (!paused) { app.renderer.resize(w, h); fit(); }
      }).observe(canvas);
      // 窗口级 mousemove 视线追踪（onMove 见模块级定义）
      window.addEventListener('mousemove', onMove);
      const ch = new BroadcastChannel(CHANNEL);
      channel = ch;   // 存模块级引用：握手 model-request 回发用
      ch.onmessage = (e) => handleMsg(e.data);
      // 关键：必须与 pixi-live2d-display 的动作更新同一 ticker（Ticker.shared），
      // LOW 优先级保证在 motionManager.update 之后执行，否则参数会被动作同帧冲掉
      PIXI.Ticker.shared.add(tick, null, PIXI.UPDATE_PRIORITY.LOW);
      ready = true;
      // mount 前暂存的模型（小窗时序）立即加载；否则广播握手向主窗索取当前模型
      if (pendingUrl) { const u = pendingUrl; pendingUrl = null; loadModel(u); }
      else postToChannel({ type: 'model-request' });
      return true;
    } catch (err) {
      console.warn('[avatar] 形象加载失败，降级为静态参考图:', err.message);
      // 清理已注册的窗口级监听，防降级后 mousemove 空转（handleMsg 有 model 判空，BroadcastChannel 无需清）
      window.removeEventListener('mousemove', onMove);
      // 先取容器引用再销毁（destroy 后 canvas 若脱离 DOM，closest 拿不到容器）
      const box = canvas.closest('.avatar-box');
      // removeView=false：渲染循环照停（彻底停渲染），但 canvas 节点保留给隐藏的容器
      if (app) { try { app.destroy(false, { children: true, texture: true }); } catch {} app = null; }
      model = null;   // 同步清引用：防降级后 onMove 残留窗口对已销毁模型调 focus
      paused = true;
      if (box) box.style.display = 'none';
      return false;
    }
  }

  window.Avatar = {
    mount,
    loadModel,
    get ready() { return ready; },
    // 主窗口本页直用的振幅入口（Task 7 接线；与 BroadcastChannel 收到的消息同效）
    applyAmplitude(v) {
      mouthTarget = Math.min(1, Math.max(0, (typeof v === 'number' && Number.isFinite(v)) ? v : 0));
      lastAmpAt = Date.now();
    },
  };
})();
