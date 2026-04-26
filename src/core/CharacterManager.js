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
