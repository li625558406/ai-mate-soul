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
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        db = await load(JSON.parse(raw));
      } catch {
        db = await this._createDb();
      }
    } else {
      db = await this._createDb();
    }

    const instance = { db, filePath };
    this._instances.set(key, instance);
    return instance;
  }

  async _createDb() {
    return await create({
      schema: {
        id: 'string',
        userMessage: 'string',
        aiResponse: 'string',
        summary: 'string',
        emotionLabel: 'string',
        timestamp: 'string',
      },
      language: 'english',
    });
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
    const terms = this._extractTerms(query);
    const results = [];

    for (const term of terms) {
      if (term.length < 2) continue;
      try {
        const res = await search(db, {
          term,
          properties: ['userMessage', 'summary'],
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

  /**
   * 简易中文分词：按标点和空格切分，过滤短词
   */
  _extractTerms(text) {
    // 保留中文、英文、数字，按标点分割
    const segments = text
      .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9]/g, ' ')
      .split(/\s+/)
      .filter(s => s.length > 0);

    const terms = [];
    for (const seg of segments) {
      if (/[\u4e00-\u9fff]/.test(seg)) {
        // 中文：2-gram 滑动窗口
        if (seg.length <= 4) {
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
}
