import { create, insert, search, save, load } from '@orama/orama';
import fs from 'fs';
import path from 'path';

/**
 * MemoryService - 基于 Orama 的长期记忆系统
 *
 * 职责：
 * 1. 存储每轮对话摘要到本地向量库
 * 2. 根据用户当前输入检索相关历史记忆
 * 3. 将检索结果提供给 DynamicPromptBuilder 注入 prompt
 *
 * 存储：data/memory/<userId>_<characterId>.json
 */
export class MemoryService {
  constructor() {
    /** @type {Map<string, { db: object, filePath: string }>} */
    this._instances = new Map();
  }

  /**
   * 获取或创建某个用户-角色对的记忆库
   */
  async _getOrInit(userId, characterId) {
    const key = `${userId}__${characterId}`;
    if (this._instances.has(key)) return this._instances.get(key);

    const dir = path.resolve(process.cwd(), 'data', 'memory');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${key}.json`);
    let db;

    if (fs.existsSync(filePath)) {
      let raw = null;
      try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // 旧格式检测：索引属性中无 grams（english tokenizer 时代无法索引中文）→ 重建
        if (!raw?.index?.indexes || !('grams' in raw.index.indexes)) {
          throw new Error('legacy-schema');
        }
        const freshDb = await this._createDb();
        load(freshDb, raw);
        db = freshDb;
      } catch {
        // 旧格式 / 损坏文件：用旧文档重建索引
        db = await this._rebuildDb(raw);
      }
    } else {
      db = await this._createDb();
    }

    const instance = { db, filePath };
    this._instances.set(key, instance);
    return instance;
  }

  async _createDb() {
    // 自定义 tokenizer：CJK 2-gram + 拉丁词。默认 english tokenizer 会丢弃全部中文 token
    return await create({
      schema: {
        id: 'string',
        userMessage: 'string',
        aiResponse: 'string',
        summary: 'string',
        emotionLabel: 'string',
        timestamp: 'string',
        grams: 'string',
      },
      components: { tokenizer: this._makeTokenizer() },
    });
  }

  /** 中文 2-gram + 拉丁词切分（建索引与查询共用） */
  _tokenizeTerms(text) {
    const segments = String(text)
      .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9]/g, ' ')
      .split(/\s+/)
      .filter(s => s.length > 0);

    const terms = [];
    for (const seg of segments) {
      if (/[\u4e00-\u9fff]/.test(seg)) {
        if (seg.length <= 2) {
          terms.push(seg);
        } else {
          for (let i = 0; i <= seg.length - 2; i++) {
            terms.push(seg.slice(i, i + 2));
          }
        }
      } else {
        terms.push(seg.toLowerCase());
      }
    }
    return [...new Set(terms)];
  }

  /** Orama 自定义 tokenizer（接口要求 language / normalizationCache / tokenize） */
  _makeTokenizer() {
    const self = this;
    return {
      language: 'english',
      normalizationCache: new Map(),
      tokenize(raw) {
        return self._tokenizeTerms(raw);
      },
    };
  }

  /**
   * 用旧 dump 的文档重建索引（补算 grams，处理 schema 不匹配/损坏场景）
   */
  async _rebuildDb(rawDump) {
    const db = await this._createDb();
    // Orama 3.x: rawDump.docs.docs；兼容更早的 documents.store 形态
    const store = rawDump?.docs?.docs || rawDump?.documents?.store || {};
    const docs = Object.values(store);
    for (const doc of docs) {
      try {
        await insert(db, {
          id: doc.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          userMessage: doc.userMessage || '',
          aiResponse: doc.aiResponse || '',
          summary: doc.summary || '',
          emotionLabel: doc.emotionLabel || 'neutral',
          timestamp: doc.timestamp || new Date().toISOString(),
          grams: this._gramsFor(doc.userMessage || '', doc.summary || ''),
        });
      } catch { /* 单条坏数据跳过 */ }
    }
    if (docs.length > 0) console.log(`[MemoryService] 旧记忆索引重建完成: ${docs.length} 条`);
    return db;
  }

  _gramsFor(userMessage, summary) {
    return this._tokenizeTerms(`${userMessage} ${summary}`).join(' ');
  }

  /** 持久化到磁盘 */
  async _persist(key) {
    const instance = this._instances.get(key);
    if (!instance) return;
    try {
      const data = await save(instance.db);
      fs.writeFileSync(instance.filePath, JSON.stringify(data));
    } catch (err) {
      console.warn(`[MemoryService] 持久化失败 ${key}:`, err.message);
    }
  }

  /**
   * 存储一轮对话到记忆库
   * @param {{ userId, characterId, userMessage, aiResponse, summary, emotionLabel }} params
   */
  async storeMemory({ userId, characterId, userMessage, aiResponse, summary, emotionLabel }) {
    const key = `${userId}__${characterId}`;
    const { db } = await this._getOrInit(userId, characterId);

    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await insert(db, {
      id,
      userMessage,
      aiResponse,
      summary: summary || '',
      emotionLabel: emotionLabel || 'neutral',
      timestamp: new Date().toISOString(),
      grams: this._gramsFor(userMessage, summary || ''),
    });

    await this._persist(key);
  }

  /**
   * 根据用户输入检索相关历史记忆
   * @param {{ userId, characterId, query, limit }} params
   * @returns {Array<{summary, userMessage, aiResponse, emotionLabel, timestamp}>}
   */
  async searchMemory({ userId, characterId, query, limit = 3 }) {
    const { db } = await this._getOrInit(userId, characterId);

    // 对用户输入分词后搜索（Orama 中文全文搜索）
    const terms = this._tokenizeTerms(query);
    const results = [];

    for (const term of terms) {
      if (term.length < 2) continue;
      try {
        const res = await search(db, {
          term,
          properties: ['grams'],
          limit: 5,
        });
        for (const hit of res.hits) {
          if (!results.find(r => r.id === hit.id)) {
            results.push(hit);
          }
        }
      } catch {
        // 单个 term 搜索失败不影响整体
      }
    }

    return results.slice(0, limit).map(r => r.document);
  }

  /** 关闭时持久化所有实例 */
  async closeAll() {
    for (const key of this._instances.keys()) {
      await this._persist(key);
    }
  }

  /**
   * 读取原始记忆文件内容（用于导出）
   * @returns {Buffer|null}
   */
  getMemoryFileBuffer(userId, characterId) {
    const key = `${userId}__${characterId}`;
    const dir = path.resolve(process.cwd(), 'data', 'memory');
    const filePath = path.join(dir, `${key}.json`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  }

  /**
   * 导入记忆文件（用于导入）
   * 写入文件并刷新内存实例
   */
  async importMemoryFile(userId, characterId, buffer) {
    const key = `${userId}__${characterId}`;
    const dir = path.resolve(process.cwd(), 'data', 'memory');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${key}.json`);
    fs.writeFileSync(filePath, buffer);

    // 刷新内存实例
    if (this._instances.has(key)) {
      this._instances.delete(key);
      await this._getOrInit(userId, characterId);
    }
  }

  /**
   * 删除某角色全部记忆（所有用户维度）：删磁盘文件 + 驱逐内存实例
   * 文件名格式 <userId>__<characterId>.json（双下划线分隔，characterId 可含单下划线，endsWith 匹配安全）
   * @param {string} characterId
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
}
