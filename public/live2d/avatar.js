// Live2D 形象渲染封装：主窗口与小窗共用。
// 职责：加载模型、idle 动作（模型自带自动播）、鼠标视线、嘴型（振幅驱动）、表情（情绪驱动）。
// 消费同源 BroadcastChannel('avatar')：主窗口广播振幅/情绪，本窗口渲染。
(() => {
  'use strict';

  const MODEL_URL = '/live2d/models/haru/haru_greeter_t03.model3.json';
  const CHANNEL = 'avatar';

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
  let baseW = 0, baseH = 0;                          // 模型未缩放时的自然尺寸（fit 基准，防止重复缩放复利）
  let mouth = 0, mouthTarget = 0, lastAmpAt = 0;     // 嘴型当前值/目标值/最近振幅时间
  let emotionParams = null, emotionUntil = 0;        // 情绪参数与失效时间

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

  // 每 tick 把嘴型/情绪参数覆写到模型（LOW 优先级保证在动作更新之后执行）
  function tick() {
    if (!model) return;
    if (Date.now() - lastAmpAt > 350) mouthTarget = 0;   // 振幅流断了自然闭嘴
    mouth += (mouthTarget - mouth) * 0.35;                // 平滑插值防抖
    const core = model.internalModel.coreModel;
    core.setParameterValueById('ParamMouthOpenY', mouth);
    if (emotionParams && Date.now() < emotionUntil) {
      for (const [id, v] of Object.entries(emotionParams)) core.setParameterValueById(id, v);
    }
  }

  function handleMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'amplitude' && typeof msg.v === 'number') {
      // 限幅并忽略畸形值（对抗：NaN/负数/超大值）
      mouthTarget = Math.min(1, Math.max(0, Number.isFinite(msg.v) ? msg.v : 0));
      lastAmpAt = Date.now();
    } else if (msg.type === 'emotion' && typeof msg.state === 'string') {
      emotionParams = EMOTION_PARAMS[msg.state] || null;
      emotionUntil = Date.now() + 10 * 60_000; // 情绪持续 10 分钟后回 idle
    }
  }

  // 挂载到指定 canvas；失败返回 false 并隐藏容器（降级链，不阻塞聊天）
  async function mount(canvasEl) {
    canvas = canvasEl;
    try {
      const PIXI = window.PIXI;
      if (!PIXI || !PIXI.live2d) throw new Error('vendor 未加载');
      // 显式传宽高：不传时 PIXI 用默认 800x600 且 autoDensity 会把 canvas 内联样式覆写成 800px/600px，撑破容器
      const w = canvasEl.clientWidth || 300;
      const h = canvasEl.clientHeight || 440;
      app = new PIXI.Application({ view: canvas, width: w, height: h, backgroundAlpha: 0, autoDensity: true, resolution: devicePixelRatio || 1 });
      model = await PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: true });
      app.stage.addChild(model);
      // 记录自然尺寸（此刻 scale=1），后续 fit 用固定基准，避免 ResizeObserver 反复缩放复利
      baseW = model.width;
      baseH = model.height;
      fit();
      // canvas 尺寸变化时同步 renderer 并重新布局（主窗口与小窗通用）
      // 读 clientWidth/clientHeight（CSS 像素）：autoDensity 下 canvas.width 是物理像素，直接用会越调越大
      new ResizeObserver(() => {
        const cw = canvas.clientWidth, chh = canvas.clientHeight;
        if (cw && chh) { app.renderer.resize(cw, chh); fit(); }
      }).observe(canvas);
      app.ticker.add(tick, null, PIXI.UPDATE_PRIORITY.LOW);
      const ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = (e) => handleMsg(e.data);
      ready = true;
      return true;
    } catch (err) {
      console.warn('[avatar] 形象加载失败，降级为静态参考图:', err.message);
      const box = canvas.closest('.avatar-box');
      if (box) box.style.display = 'none';
      return false;
    }
  }

  window.Avatar = {
    mount,
    get ready() { return ready; },
    // 主窗口本页直用的振幅入口（Task 7 接线；与 BroadcastChannel 收到的消息同效）
    applyAmplitude(v) {
      mouthTarget = Math.min(1, Math.max(0, (typeof v === 'number' && Number.isFinite(v)) ? v : 0));
      lastAmpAt = Date.now();
    },
  };
})();
