import fs from 'fs';
import path from 'path';

const CHARACTERS_DIR = path.resolve(process.cwd(), 'data', 'characters');

// 图片扩展名（含点前缀变体用于匹配文件名）
const IMG_EXT_RE = /\.(jpe?g|png|webp|bmp)$/i;

/**
 * 旧版迁移：历史版本"头像即参考图"（单图存为 avatar.* 且删除目录内其他图片）。
 * 该图实际是生成用立绘，迁移为 reference.*；已存在 reference.* 则不动。
 */
function _migrateLegacyReference(dir) {
  const images = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => IMG_EXT_RE.test(f))
    : [];
  if (images.length === 0) return;
  if (images.some(f => /^reference\./i.test(f))) return;
  // 取第一张非 reference 图片（通常是旧 avatar.*，也可能是更早的任意命名）
  const legacy = images.find(f => !/^reference\./i.test(f));
  if (!legacy) return;
  const ext = path.extname(legacy);
  try {
    fs.renameSync(path.join(dir, legacy), path.join(dir, `reference${ext}`));
    console.log(`[CharacterManager] 迁移旧参考图: ${legacy} -> reference${ext}`);
  } catch (err) {
    console.warn(`[CharacterManager] 旧参考图迁移失败: ${legacy}`, err.message);
  }
}

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
        _migrateLegacyReference(path.join(CHARACTERS_DIR, dir));
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
      live2d_model: c.live2d_model || '',
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

  /** id 合法性：小写字母/数字/下划线，2-32 位；下划线不能连续或出现在首尾（避免与记忆文件名 `__` 分隔符、媒体文件名 `_` 分隔符产生歧义） */
  _isValidId(id) {
    return typeof id === 'string'
      && id.length >= 2 && id.length <= 32
      && /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id);
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
    // id 是内部标识：前端表单新增时不收集 id（中文全名也无法 slug 化），缺失时自动生成；显式提供时仍严格校验
    let id = profile?.id;
    if (id === undefined || id === null || id === '') {
      do {
        id = 'char_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      } while (this._characters.has(id));
    } else if (!this._isValidId(id)) {
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
      for (const k of Object.keys(patch)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        next[k] = patch[k];
      }
      next.id = characterId; // 防御：无论 patch 带什么，id 不可变
    }
    if (!next.full_name) return { ok: false, error: 'full_name（角色全名）不能为空' };
    this._writeProfileFile(characterId, next);
    this._characters.set(characterId, next);
    return { ok: true, profile: next };
  }

  /**
   * 保存角色图片（头像/参考图通用）：只清理同类旧文件，先写临时文件成功后再替换
   * @param {'avatar'|'reference'} kind
   */
  saveImage(characterId, kind, buffer, ext) {
    if (!this._isValidId(characterId)) return { ok: false, error: '角色 id 非法' };
    if (kind !== 'avatar' && kind !== 'reference') return { ok: false, error: '图片类型非法' };
    const dir = path.join(CHARACTERS_DIR, characterId);
    if (!fs.existsSync(dir)) return { ok: false, error: '角色目录不存在' };
    const tmpPath = path.join(dir, `${kind}.${ext}.tmp`);
    fs.writeFileSync(tmpPath, buffer);
    for (const f of fs.readdirSync(dir)) {
      if (new RegExp(`^${kind}\\.${ext}$`, 'i').test(f)) continue; // 同名旧文件等 rename 原子替换
      if (new RegExp(`^${kind}\\.(jpe?g|png|webp|bmp)$`, 'i').test(f)) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
    fs.renameSync(tmpPath, path.join(dir, `${kind}.${ext}`));
    return { ok: true };
  }

  /** 兼容旧调用名：保存头像（仅 UI 展示，不参与生成） */
  saveAvatar(characterId, buffer, ext) {
    return this.saveImage(characterId, 'avatar', buffer, ext);
  }

  /** 保存参考图（生成自拍图/视频时引入） */
  saveReference(characterId, buffer, ext) {
    return this.saveImage(characterId, 'reference', buffer, ext);
  }

  /** 彻底删除角色目录（JSON + 图片）并从内存移除 */
  deleteCharacter(characterId) {
    if (!this._isValidId(characterId)) return { ok: false, error: '角色 id 非法' };
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

  /** 按类型取角色图片路径（reference.* / avatar.* 严格匹配） */
  _getImagePath(characterId, kind) {
    const dir = path.join(CHARACTERS_DIR, characterId);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

    const images = fs.readdirSync(dir).filter(f =>
      new RegExp(`^${kind}\\.(jpe?g|png|webp|bmp)$`, 'i').test(f)
    );
    return images.length > 0 ? path.join(dir, images[0]) : null;
  }

  /** 获取角色参考图（立绘，供生成链路使用）路径 */
  getReferenceImagePath(characterId) {
    return this._getImagePath(characterId, 'reference');
  }

  /** 获取角色头像（仅 UI 展示）路径，不存在返回 null */
  getAvatarPath(characterId) {
    return this._getImagePath(characterId, 'avatar');
  }

  /** 获取视频专用参考图（生活化构图，供 VideoService 使用）路径 */
  getVideoRefPath(characterId) {
    return this._getImagePath(characterId, 'video_ref');
  }
}
