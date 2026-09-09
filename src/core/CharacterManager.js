import fs from 'fs';
import path from 'path';

const CHARACTERS_DIR = path.resolve(process.cwd(), 'data', 'characters');

/**
 * CharacterManager - 角色档案加载与管理
 *
 * 职责：
 * 1. 从 data/characters/ 加载角色 JSON
 * 2. 支持热加载（无需重启）
 * 3. 读写动态知识（dynamic_knowledge）
 */
export class CharacterManager {
  constructor() {
    /** @type {Map<string, object>} characterId -> profile */
    this._characters = new Map();
    this._loadAll();
  }

  /** 启动时扫描 data/characters/ 子目录加载所有 JSON */
  _loadAll() {
    if (!fs.existsSync(CHARACTERS_DIR)) {
      fs.mkdirSync(CHARACTERS_DIR, { recursive: true });
      console.log('[CharacterManager] 已创建角色目录:', CHARACTERS_DIR);
      return;
    }

    // 扫描子目录，每个子目录对应一个角色
    const dirs = fs.readdirSync(CHARACTERS_DIR).filter(f =>
      fs.statSync(path.join(CHARACTERS_DIR, f)).isDirectory()
    );
    this._characters.clear();

    for (const dir of dirs) {
      const jsonFile = path.join(CHARACTERS_DIR, dir, `${dir}.json`);
      if (!fs.existsSync(jsonFile)) continue;

      try {
        const raw = fs.readFileSync(jsonFile, 'utf-8');
        const profile = JSON.parse(raw);
        // 确保 dynamic_knowledge 字段存在
        if (!profile.dynamic_knowledge) {
          profile.dynamic_knowledge = {
            learned_catchphrases: [],
            personality_shifts: [],
            user_life_events: [],
            acquired_knowledge: [],
            relationship_milestones: [],
          };
        }
        this._characters.set(profile.id, profile);
      } catch (err) {
        console.warn(`[CharacterManager] 加载角色文件失败: ${dir}`, err.message);
      }
    }
    console.log(`[CharacterManager] 已加载 ${this._characters.size} 个角色档案`);
  }

  /** 热加载：重新扫描目录 */
  reload() {
    this._loadAll();
    return this._characters.size;
  }

  /** 获取角色档案（含动态知识） */
  getCharacter(characterId) {
    return this._characters.get(characterId) || null;
  }

  /** 获取角色完整档案（用于 API） */
  getCharacterProfile(characterId) {
    const c = this._characters.get(characterId);
    if (!c) return null;
    return { ...c };
  }

  /** 获取所有角色列表 */
  listCharacters() {
    return [...this._characters.values()].map(c => ({
      id: c.id,
      full_name: c.full_name || c.name,
      name: c.nickname || c.name,
      nickname: c.nickname || '',
      gender: c.gender || '',
      age: c.age || 0,
      birthday: c.birthday || '',
      archetype: c.archetype || '',
      education: c.education || '',
      background: c.background || '',
      hobbies: c.hobbies || [],
      personality: c.base_personality || '',
      voice_preset: c.voice_preset || '',
      dynamicKnowledgeCount: this._countDynamicKnowledge(c),
    }));
  }

  /** 统计动态知识条目数 */
  _countDynamicKnowledge(c) {
    const dk = c.dynamic_knowledge;
    if (!dk) return 0;
    return (dk.learned_catchphrases?.length || 0)
      + (dk.personality_shifts?.length || 0)
      + (dk.user_life_events?.length || 0)
      + (dk.acquired_knowledge?.length || 0)
      + (dk.relationship_milestones?.length || 0);
  }

  /** 角色是否存在 */
  hasCharacter(characterId) {
    return this._characters.has(characterId);
  }

  /**
   * 保存动态知识到角色 JSON 文件
   * @param {string} characterId
   * @param {object} knowledge - dynamic_knowledge 对象
   */
  saveDynamicKnowledge(characterId, knowledge) {
    const profile = this._characters.get(characterId);
    if (!profile) return false;

    // 更新内存中的数据
    profile.dynamic_knowledge = knowledge;

    // 写回文件（子目录结构）
    const filePath = path.join(CHARACTERS_DIR, characterId, `${characterId}.json`);
    if (!fs.existsSync(filePath)) return false;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      data.dynamic_knowledge = knowledge;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.warn(`[CharacterManager] 保存动态知识失败: ${characterId}`, err.message);
      return false;
    }
  }

  /** 原子写角色 JSON（临时文件 + rename，防崩溃半写） */
  _writeProfileFile(characterId, profile) {
    const dir = path.join(CHARACTERS_DIR, characterId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${characterId}.json`);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(profile, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

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
   * @param {string} characterId
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

  /** 获取角色目录路径 */
  getCharactersDir() {
    return CHARACTERS_DIR;
  }

  /** 获取角色参考图（立绘）路径 */
  getReferenceImagePath(characterId) {
    const dir = path.join(CHARACTERS_DIR, characterId);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

    const images = fs.readdirSync(dir).filter(f =>
      /\.(jpe?g|png|webp|bmp)$/i.test(f)
    );
    return images.length > 0 ? path.join(dir, images[0]) : null;
  }
}
