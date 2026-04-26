import OpenAI from 'openai';

/**
 * LLMProvider - 多模型统一适配器
 *
 * 设计原则：
 * 1. 所有兼容 OpenAI API 格式的 provider 共用同一套逻辑
 * 2. 通过 ProviderConfig 注册新 provider，无需改动核心代码
 * 3. 支持 streaming / non-streaming 两种模式
 */
export class LLMProvider {
  constructor() {
    /** @type {Map<string, {client: OpenAI, model: string}>} */
    this._providers = new Map();
  }

  /**
   * 注册一个 LLM provider
   * @param {string} name - provider 名称 (e.g. 'deepseek', 'openai')
   * @param {{ apiKey: string, baseURL: string, model: string }} config
   */
  registerProvider(name, { apiKey, baseURL, model }) {
    const client = new OpenAI({
      apiKey,
      baseURL,
    });
    this._providers.set(name, { client, model });
  }

  /**
   * 获取已注册 provider 列表
   */
  getProviderNames() {
    return [...this._providers.keys()];
  }

  /**
   * 验证 provider 是否可用
   */
  hasProvider(name) {
    return this._providers.has(name);
  }

  /**
   * 流式对话
   * @param {string} providerName
   * @param {{ systemPrompt: string, messages: Array<{role:string, content:string}> }} params
   * @returns {AsyncGenerator<string>}
   */
  async *chatStream(providerName, { systemPrompt, messages }) {
    const { client, model } = this._getProvider(providerName);

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const stream = await client.chat.completions.create({
      model,
      messages: apiMessages,
      stream: true,
      temperature: 0.85,
      max_tokens: 1024,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  /**
   * 非流式对话（用于情感分析等轻量调用）
   * @param {string} providerName
   * @param {{ systemPrompt: string, messages: Array<{role:string, content:string}>, temperature?: number }} params
   * @returns {Promise<string>}
   */
  async chat(providerName, { systemPrompt, messages, temperature = 0.3, maxTokens = 256 }) {
    const { client, model } = this._getProvider(providerName);

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const response = await client.chat.completions.create({
      model,
      messages: apiMessages,
      temperature,
      max_tokens: maxTokens,
    });

    return response.choices[0]?.message?.content?.trim() || '';
  }

  _getProvider(name) {
    const provider = this._providers.get(name);
    if (!provider) throw new Error(`LLM provider "${name}" not registered`);
    return provider;
  }
}

/**
 * 从环境变量自动注册所有已配置的 provider
 */
export function registerProvidersFromEnv(llmProvider) {
  const providerEnvMap = {
    qwen: {
      apiKey: process.env.QWEN_API_KEY,
      baseURL: process.env.QWEN_BASE_URL,
      model: process.env.QWEN_MODEL,
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL,
      model: process.env.DEEPSEEK_MODEL,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
    },
    claude: {
      apiKey: process.env.CLAUDE_API_KEY,
      baseURL: process.env.CLAUDE_BASE_URL,
      model: process.env.CLAUDE_MODEL,
    },
  };

  for (const [name, config] of Object.entries(providerEnvMap)) {
    if (config.apiKey && config.baseURL && config.model) {
      llmProvider.registerProvider(name, config);
    }
  }
}
