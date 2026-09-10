import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(process.cwd(), 'data', 'ai_mate.db');

export class DatabaseManager {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_profile (
        user_id TEXT PRIMARY KEY,
        name TEXT DEFAULT '',
        location TEXT DEFAULT '',
        preferences TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS characters_state (
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        affection REAL DEFAULT 50.0,
        mood TEXT DEFAULT '平常',
        level INTEGER DEFAULT 1,
        experience INTEGER DEFAULT 0,
        chat_count INTEGER DEFAULT 0,
        personality_override TEXT DEFAULT '',
        mirror_words TEXT DEFAULT '[]',
        mood_level REAL DEFAULT 0.0,
        cold_war_until TEXT DEFAULT NULL,
        emotion_state TEXT DEFAULT 'calm',
        last_seen_at TEXT DEFAULT (datetime('now', 'localtime')),
        first_met_at TEXT DEFAULT (datetime('now', 'localtime')),
        current_activity TEXT DEFAULT '',
        interaction_days INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (user_id, character_id)
      );

      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'photo')),
        content TEXT NOT NULL,
        emotion_weight REAL DEFAULT 0,
        affection_after REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_history_lookup
        ON chat_history(user_id, character_id, created_at);

      CREATE TABLE IF NOT EXISTS user_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        fact_value TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        source TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, character_id, fact_value)
      );

      CREATE INDEX IF NOT EXISTS idx_facts_lookup
        ON user_facts(user_id, character_id);

      CREATE TABLE IF NOT EXISTS diaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        diary_date TEXT NOT NULL,
        content TEXT NOT NULL,
        mood TEXT DEFAULT '',
        unlock_required INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, character_id, diary_date)
      );

      CREATE INDEX IF NOT EXISTS idx_diaries_lookup
        ON diaries(user_id, character_id, diary_date);

      CREATE TABLE IF NOT EXISTS daily_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        schedule_date TEXT NOT NULL,
        segments TEXT NOT NULL,
        summary TEXT DEFAULT '',
        weather TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, character_id, schedule_date)
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_lookup
        ON daily_schedules(user_id, character_id, schedule_date);

      CREATE TABLE IF NOT EXISTS future_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        plan_date TEXT NOT NULL,
        description TEXT NOT NULL,
        source TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        completed_at TEXT DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plans_lookup
        ON future_plans(user_id, character_id, plan_date, status);

      CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        type TEXT DEFAULT 'selfie',
        caption TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_photos_lookup
        ON photos(user_id, character_id, created_at);

      CREATE TABLE IF NOT EXISTS anniversaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        description TEXT DEFAULT '',
        is_notified INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, character_id, type)
      );

      CREATE TABLE IF NOT EXISTS applied_event_emotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        schedule_date TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        emotion_type TEXT NOT NULL DEFAULT 'annoyance',
        emotion_delta REAL NOT NULL DEFAULT 0,
        applied_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, character_id, schedule_date, segment_index)
      );

      CREATE INDEX IF NOT EXISTS idx_applied_emotions_lookup
        ON applied_event_emotions(user_id, character_id, schedule_date);

      CREATE TABLE IF NOT EXISTS inner_monologue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        thought TEXT NOT NULL,
        emotion_state TEXT DEFAULT 'calm',
        mood_after REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_monologue_lookup
        ON inner_monologue(user_id, character_id, created_at);
    `);

    // Migrations: fix column name if old schema exists
    try {
      this.db.prepare(`ALTER TABLE diaries RENAME COLUMN unlock_required_affection TO unlock_required`).run();
    } catch { /* column already renamed or doesn't exist */ }

    // Migration: add current_activity column for time-aware activity tracking
    try {
      this.db.prepare(`ALTER TABLE characters_state ADD COLUMN current_activity TEXT DEFAULT ''`).run();
    } catch { /* column already exists */ }

    // Migration: rebuild chat_history to add 'photo' to role CHECK constraint
    try {
      const tableInfo = this.db.prepare(`PRAGMA table_info(chat_history)`).all();
      if (tableInfo.length > 0) {
        // Check if old constraint exists (no 'photo' in sql)
        const sql = this.db.prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_history'`
        ).get();
        if (sql && !sql.sql.includes("'photo'")) {
          this.db.exec(
            "CREATE TABLE IF NOT EXISTS chat_history_new (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "user_id TEXT NOT NULL," +
            "character_id TEXT NOT NULL," +
            "role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'photo'))," +
            "content TEXT NOT NULL," +
            "emotion_weight REAL DEFAULT 0," +
            "affection_after REAL DEFAULT 0," +
            "created_at TEXT DEFAULT (datetime('now', 'localtime'))" +
            ");" +
            "INSERT OR IGNORE INTO chat_history_new SELECT * FROM chat_history;" +
            "DROP TABLE chat_history;" +
            "ALTER TABLE chat_history_new RENAME TO chat_history;" +
            "CREATE INDEX IF NOT EXISTS idx_chat_history_lookup ON chat_history(user_id, character_id, created_at);"
          );
          console.log('[DatabaseManager] 迁移完成: chat_history role 约束已加入 photo');
        }
      }
    } catch (e) {
      console.log('[DatabaseManager] chat_history 迁移跳过:', e.message);
    }

    // Migration: add busy state fields to characters_state
    try { this.db.prepare(`ALTER TABLE characters_state ADD COLUMN busy_until TEXT DEFAULT NULL`).run(); } catch { /* exists */ }
    try { this.db.prepare(`ALTER TABLE characters_state ADD COLUMN busy_activity TEXT DEFAULT ''`).run(); } catch { /* exists */ }
    try { this.db.prepare(`ALTER TABLE characters_state ADD COLUMN busy_message_count INTEGER DEFAULT 0`).run(); } catch { /* exists */ }

    // Migration: 冷战和解机制字段
    try { this.db.prepare(`ALTER TABLE characters_state ADD COLUMN cold_war_reason TEXT DEFAULT NULL`).run(); } catch { /* exists */ }
    try { this.db.prepare(`ALTER TABLE characters_state ADD COLUMN cold_war_phrases TEXT DEFAULT NULL`).run(); } catch { /* exists */ }

    // Migration: annoyance_level → mood_level
    try {
      this.db.prepare(`ALTER TABLE characters_state RENAME COLUMN annoyance_level TO mood_level`).run();
      this.db.prepare(`UPDATE characters_state SET mood_level = -mood_level`).run();
      console.log('[DatabaseManager] 迁移完成: annoyance_level → mood_level (值已反转)');
    } catch { /* already migrated or column doesn't exist */ }

    // Migration: annoyance_after → mood_after
    try {
      this.db.prepare(`ALTER TABLE inner_monologue RENAME COLUMN annoyance_after TO mood_after`).run();
      this.db.prepare(`UPDATE inner_monologue SET mood_after = -mood_after`).run();
      console.log('[DatabaseManager] 迁移完成: annoyance_after → mood_after (值已反转)');
    } catch { /* already migrated */ }
  }

  // ==================== User Profile ====================

  ensureUser(userId) {
    this.db.prepare(`INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)`).run(userId);
  }

  getUserProfile(userId) {
    return this.db.prepare(`SELECT * FROM user_profile WHERE user_id = ?`).get(userId);
  }

  updateUserName(userId, name) {
    this.db.prepare(`UPDATE user_profile SET name = ?, updated_at = datetime('now', 'localtime') WHERE user_id = ?`).run(name, userId);
  }

  // ==================== Character State ====================

  ensureCharacterState(userId, characterId) {
    this.db.prepare(
      `INSERT OR IGNORE INTO characters_state (user_id, character_id, first_met_at) VALUES (?, ?, datetime('now', 'localtime'))`
    ).run(userId, characterId);
    return this.getCharacterState(userId, characterId);
  }

  getCharacterState(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM characters_state WHERE user_id = ? AND character_id = ?`
    ).get(userId, characterId);
  }

  updateAffection(userId, characterId, affection, mood) {
    this.db.prepare(
      `UPDATE characters_state SET affection = ?, mood = ?, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(affection, mood, userId, characterId);
  }

  applyOfflineDecay(userId, characterId, { affectionDelta, moodDelta, xpDelta }) {
    if (affectionDelta === 0 && moodDelta === 0 && xpDelta === 0) return;
    // moodDelta > 0 means mood should decrease (move toward 0 from positive side)
    // moodDelta < 0 means mood should increase (move toward 0 from negative side)
    this.db.prepare(
      `UPDATE characters_state SET
         affection = MAX(0, affection - ?),
         mood_level = CASE
           WHEN mood_level > 0 THEN MAX(0, mood_level - ?)
           WHEN mood_level < 0 THEN MIN(0, mood_level + ?)
           ELSE mood_level
         END,
         experience = MAX(0, experience - ?),
         updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(affectionDelta, moodDelta, moodDelta, xpDelta, userId, characterId);
  }

  incrementChatCount(userId, characterId) {
    this.db.prepare(
      `UPDATE characters_state SET chat_count = chat_count + 1, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(userId, characterId);
  }

  updateLevel(userId, characterId, level) {
    this.db.prepare(
      `UPDATE characters_state SET level = ?, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(level, userId, characterId);
  }

  addExperience(userId, characterId, xp) {
    this.db.prepare(
      `UPDATE characters_state SET experience = experience + ?, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(xp, userId, characterId);
  }

  updateMirrorWords(userId, characterId, mirrorWords) {
    this.db.prepare(
      `UPDATE characters_state SET mirror_words = ?, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(JSON.stringify(mirrorWords), userId, characterId);
  }

  updateEmotionState(userId, characterId, emotionState, moodLevel, coldWarEndAt) {
    this.db.prepare(
      `UPDATE characters_state SET emotion_state = ?, mood_level = ?, cold_war_until = ?, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(emotionState, moodLevel, coldWarEndAt, userId, characterId);
  }

  // ==================== Busy State ====================

  setBusyState(userId, characterId, activity, durationMinutes) {
    const endTime = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
    this.db.prepare(
      `UPDATE characters_state SET busy_until = ?, busy_activity = ?, busy_message_count = 0, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(endTime, activity, userId, characterId);
  }

  clearBusyState(userId, characterId) {
    this.db.prepare(
      `UPDATE characters_state SET busy_until = NULL, busy_activity = '', busy_message_count = 0, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(userId, characterId);
  }

  incrementBusyCount(userId, characterId) {
    this.db.prepare(
      `UPDATE characters_state SET busy_message_count = busy_message_count + 1 WHERE user_id = ? AND character_id = ?`
    ).run(userId, characterId);
  }

  updateLastSeenAt(userId, characterId) {
    this.db.prepare(
      `UPDATE characters_state SET last_seen_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(userId, characterId);
  }

  updateCurrentActivity(userId, characterId, activity) {
    this.db.prepare(
      `UPDATE characters_state SET current_activity = ?, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(activity, userId, characterId);
  }

  updateInteractionDays(userId, characterId) {
    this.db.prepare(
      `UPDATE characters_state SET interaction_days = interaction_days + 1, updated_at = datetime('now', 'localtime') WHERE user_id = ? AND character_id = ?`
    ).run(userId, characterId);
  }

  // ==================== Chat History ====================

  saveChatMessage({ userId, characterId, role, content, emotionWeight = 0, affectionAfter = 0 }) {
    this.db.prepare(
      `INSERT INTO chat_history (user_id, character_id, role, content, emotion_weight, affection_after)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, characterId, role, content, emotionWeight, affectionAfter);
  }

  // ==================== Photos ====================

  savePhoto({ userId, characterId, filename, prompt, type, caption }) {
    this.db.prepare(
      `INSERT INTO photos (user_id, character_id, filename, prompt, type, caption)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, characterId, filename, prompt, type || 'selfie', caption || '');
  }

  getPhotos(userId, characterId, limit = 20) {
    return this.db.prepare(
      `SELECT * FROM photos WHERE user_id = ? AND character_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(userId, characterId, limit);
  }

  // ==================== History Queries ====================

  getRecentChatHistory(userId, characterId, limit = 5) {
    return this.db.prepare(
      `SELECT role, content FROM chat_history
       WHERE user_id = ? AND character_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at DESC LIMIT ?`
    ).all(userId, characterId, limit).reverse();
  }

  clearChatHistory(userId, characterId) {
    this.db.prepare(
      `DELETE FROM chat_history WHERE user_id = ? AND character_id = ?`
    ).run(userId, characterId);
    this.db.prepare(
      `DELETE FROM inner_monologue WHERE user_id = ? AND character_id = ?`
    ).run(userId, characterId);
  }

  /** 前端加载聊天记录用，包含照片消息 */
  getFullChatHistory(userId, characterId, limit = 50) {
    return this.db.prepare(
      `SELECT role, content, created_at FROM chat_history
       WHERE user_id = ? AND character_id = ? AND role IN ('user', 'assistant', 'photo')
       ORDER BY created_at DESC LIMIT ?`
    ).all(userId, characterId, limit).reverse();
  }

  getRecentSummary(userId, characterId, limit = 5) {
    const rows = this.db.prepare(
      `SELECT role, content, created_at FROM chat_history
       WHERE user_id = ? AND character_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at DESC LIMIT ?`
    ).all(userId, characterId, limit * 2).reverse();

    if (rows.length === 0) return '';

    const lines = [];
    for (const row of rows) {
      const label = row.role === 'user' ? '对方' : '你';
      const content = row.content.length > 60 ? row.content.slice(0, 60) + '...' : row.content;
      lines.push(`${label}: ${content}`);
    }
    return lines.join('\n');
  }

  getUserMessageHistory(userId, characterId, limit = 30) {
    return this.db.prepare(
      `SELECT content FROM chat_history
       WHERE user_id = ? AND character_id = ? AND role = 'user'
       ORDER BY created_at DESC LIMIT ?`
    ).all(userId, characterId, limit).map(r => r.content);
  }

  // ==================== User Facts ====================

  upsertFact(userId, characterId, factKey, factValue, confidence = 0.5, sourceMessage = '') {
    this.db.prepare(
      `INSERT INTO user_facts (user_id, character_id, fact_key, fact_value, confidence, source_message)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, character_id, fact_key) DO UPDATE SET
         fact_value = excluded.fact_value,
         confidence = MAX(confidence, excluded.confidence),
         source_message = CASE WHEN excluded.source_message != '' THEN excluded.source_message ELSE source_message END`
    ).run(userId, characterId, factKey, factValue, confidence, sourceMessage);
  }

  getUserFacts(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM user_facts WHERE user_id = ? AND character_id = ? ORDER BY confidence DESC`
    ).all(userId, characterId);
  }

  // ==================== Diaries ====================

  saveDiary({ userId, characterId, date, content, mood, unlockRequired = 0 }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO diaries (user_id, character_id, diary_date, content, mood, unlock_required)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, characterId, date, content, mood, unlockRequired);
  }

  getDiary(userId, characterId, date) {
    return this.db.prepare(
      `SELECT * FROM diaries WHERE user_id = ? AND character_id = ? AND diary_date = ?`
    ).get(userId, characterId, date);
  }

  getDiaries(userId, characterId, limitOrOpts = 30) {
    const limit = typeof limitOrOpts === 'object' ? (limitOrOpts.limit || 30) : limitOrOpts;
    return this.db.prepare(
      `SELECT * FROM diaries WHERE user_id = ? AND character_id = ?
       ORDER BY diary_date DESC LIMIT ?`
    ).all(userId, characterId, limit);
  }

  getLatestDiaryDate(userId, characterId) {
    const row = this.db.prepare(
      `SELECT diary_date FROM diaries WHERE user_id = ? AND character_id = ? ORDER BY diary_date DESC LIMIT 1`
    ).get(userId, characterId);
    return row ? row.diary_date : null;
  }

  autoUnlockDiaries(userId, characterId, affection) {
    this.db.prepare(
      `UPDATE diaries SET unlock_required = 0
       WHERE user_id = ? AND character_id = ? AND unlock_required > 0 AND unlock_required <= ?`
    ).run(userId, characterId, affection);
  }

  // ==================== Daily Schedules ====================

  // (table creation is in _initSchema above)

  saveDailySchedule({ userId, characterId, date, segments, summary = '', weather = '' }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO daily_schedules (user_id, character_id, schedule_date, segments, summary, weather)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, characterId, date, JSON.stringify(segments), summary, weather);
  }

  getDailySchedule(userId, characterId, date) {
    return this.db.prepare(
      `SELECT * FROM daily_schedules WHERE user_id = ? AND character_id = ? AND schedule_date = ?`
    ).get(userId, characterId, date);
  }

  getRecentSchedules(userId, characterId, limit = 3) {
    return this.db.prepare(
      `SELECT * FROM daily_schedules WHERE user_id = ? AND character_id = ? ORDER BY schedule_date DESC LIMIT ?`
    ).all(userId, characterId, limit);
  }

  // ==================== Future Plans ====================

  saveFuturePlan({ userId, characterId, planDate, description, source = '' }) {
    this.db.prepare(
      `INSERT INTO future_plans (user_id, character_id, plan_date, description, source)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, characterId, planDate, description, source);
  }

  getPendingPlans(userId, characterId, date) {
    return this.db.prepare(
      `SELECT * FROM future_plans
       WHERE user_id = ? AND character_id = ? AND plan_date <= ? AND status = 'pending'
       ORDER BY plan_date ASC`
    ).all(userId, characterId, date);
  }

  completePlan(planId) {
    this.db.prepare(
      `UPDATE future_plans SET status = 'done', completed_at = datetime('now', 'localtime') WHERE id = ?`
    ).run(planId);
  }

  // ==================== Event Emotions ====================

  markEventEmotionApplied(userId, characterId, scheduleDate, segmentIndex, emotionType, emotionDelta) {
    this.db.prepare(
      `INSERT OR IGNORE INTO applied_event_emotions (user_id, character_id, schedule_date, segment_index, emotion_type, emotion_delta)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, characterId, scheduleDate, segmentIndex, emotionType, emotionDelta);
  }

  getAppliedEventSegments(userId, characterId, scheduleDate) {
    return this.db.prepare(
      `SELECT segment_index FROM applied_event_emotions
       WHERE user_id = ? AND character_id = ? AND schedule_date = ?`
    ).all(userId, characterId, scheduleDate).map(r => r.segment_index);
  }

  addMood(userId, characterId, amount) {
    this.db.prepare(
      `UPDATE characters_state SET mood_level = MAX(-100, MIN(100, mood_level + ?)), updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(amount, userId, characterId);
  }

  // ==================== 冷战和解 ====================

  /** 记录冷战原因与动态短语（phraseJson 为 null 表示清除短语，reason 为 null 表示清除原因） */
  updateColdWarMeta(userId, characterId, reason, phrasesJson) {
    this.db.prepare(
      `UPDATE characters_state SET cold_war_reason = ?, cold_war_phrases = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(reason, phrasesJson, userId, characterId);
  }

  /** 读取冷战短语池（JSON 数组），无则返回空数组 */
  getColdWarPhrases(userId, characterId) {
    const row = this.db.prepare(
      `SELECT cold_war_phrases FROM characters_state WHERE user_id = ? AND character_id = ?`
    ).get(userId, characterId);
    if (!row?.cold_war_phrases) return [];
    try { return JSON.parse(row.cold_war_phrases); } catch { return []; }
  }

  /** 消耗一条冷战短语（队首 shift），用尽自动清空字段 */
  consumeColdWarPhrase(userId, characterId) {
    const phrases = this.getColdWarPhrases(userId, characterId);
    phrases.shift();
    this.db.prepare(
      `UPDATE characters_state SET cold_war_phrases = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(phrases.length ? JSON.stringify(phrases) : null, userId, characterId);
  }

  /** 查找所有冷战已到期但未清理的状态（供主动和解检查器使用） */
  getExpiredColdWars(nowIso) {
    return this.db.prepare(
      `SELECT user_id, character_id, cold_war_reason, mood_level FROM characters_state
       WHERE cold_war_until IS NOT NULL AND cold_war_until <= ?`
    ).all(nowIso);
  }

  /** 和解：清冷战字段、心情部分恢复、情绪状态重算 */
  reconcileColdWar(userId, characterId, newMood, newState) {
    this.db.prepare(
      `UPDATE characters_state SET cold_war_until = NULL, cold_war_reason = NULL, cold_war_phrases = NULL,
       mood_level = ?, emotion_state = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND character_id = ?`
    ).run(newMood, newState, userId, characterId);
  }

  /** 最近一篇日记（date 之前，含更早），无则 null */
  getLatestDiaryBefore(userId, characterId, date) {
    return this.db.prepare(
      `SELECT diary_date, content FROM diaries
       WHERE user_id = ? AND character_id = ? AND diary_date < ?
       ORDER BY diary_date DESC LIMIT 1`
    ).get(userId, characterId, date) || null;
  }

  // ==================== Anniversaries ====================

  saveAnniversary({ userId, characterId, type, date, description }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO anniversaries (user_id, character_id, type, date, description)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, characterId, type, date, description);
  }

  getAnniversaries(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM anniversaries WHERE user_id = ? AND character_id = ? ORDER BY date`
    ).all(userId, characterId);
  }

  markAnniversaryNotified(userId, characterId, type) {
    this.db.prepare(
      `UPDATE anniversaries SET is_notified = 1 WHERE user_id = ? AND character_id = ? AND type = ?`
    ).run(userId, characterId, type);
  }

  // ==================== Inner Monologue ====================

  saveMonologue({ userId, characterId, userMessage, thought, emotionState, moodAfter }) {
    this.db.prepare(
      `INSERT INTO inner_monologue (user_id, character_id, user_message, thought, emotion_state, mood_after)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, characterId, userMessage, thought, emotionState, moodAfter);
  }

  getRecentMonologues(userId, characterId, limit = 50) {
    return this.db.prepare(
      `SELECT * FROM inner_monologue WHERE user_id = ? AND character_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(userId, characterId, limit);
  }

  // ==================== Export / Import ====================

  exportAllChatHistory(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM chat_history WHERE user_id = ? AND character_id = ? ORDER BY created_at`
    ).all(userId, characterId);
  }

  exportAllUserFacts(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM user_facts WHERE user_id = ? AND character_id = ?`
    ).all(userId, characterId);
  }

  exportAllDiaries(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM diaries WHERE user_id = ? AND character_id = ?`
    ).all(userId, characterId);
  }

  exportAllAnniversaries(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM anniversaries WHERE user_id = ? AND character_id = ?`
    ).all(userId, characterId);
  }

  exportAllMonologues(userId, characterId) {
    return this.db.prepare(
      `SELECT * FROM inner_monologue WHERE user_id = ? AND character_id = ?`
    ).all(userId, characterId);
  }

  importUserProfile(data, userId) {
    this.ensureUser(userId);
    if (data.name) this.updateUserName(userId, data.name);
  }

  importCharacterState(data, userId, characterId) {
    this.ensureCharacterState(userId, characterId);
    const fields = [];
    const values = [];
    const skip = new Set(['user_id', 'character_id']);
    for (const [key, val] of Object.entries(data)) {
      if (skip.has(key) || val === undefined || val === null) continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return;
    values.push(userId, characterId);
    this.db.prepare(
      `UPDATE characters_state SET ${fields.join(', ')} WHERE user_id = ? AND character_id = ?`
    ).run(...values);
  }

  importChatHistory(rows, userId, characterId) {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO chat_history (user_id, character_id, role, content, emotion_weight, affection_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.user_id || userId, row.character_id || characterId,
        row.role, row.content, row.emotion_weight || 0, row.affection_after || 0, row.created_at);
    }
  }

  importUserFacts(rows, userId, characterId) {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO user_facts (user_id, character_id, fact_key, fact_value, confidence, source_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.user_id || userId, row.character_id || characterId,
        row.fact_key || '', row.fact_value, row.confidence || 0.5, row.source_message || '', row.created_at);
    }
  }

  importDiaries(rows, userId, characterId) {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO diaries (user_id, character_id, diary_date, content, mood, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.user_id || userId, row.character_id || characterId,
        row.diary_date, row.content, row.mood || '', row.created_at);
    }
  }

  importAnniversaries(rows, userId, characterId) {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO anniversaries (user_id, character_id, type, date, description, is_notified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.user_id || userId, row.character_id || characterId,
        row.type, row.date, row.description || '', row.is_notified || 0, row.created_at);
    }
  }

  importMonologues(rows, userId, characterId) {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO inner_monologue (user_id, character_id, user_message, thought, emotion_state, mood_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.user_id || userId, row.character_id || characterId,
        row.user_message, row.thought, row.emotion_state || 'calm', row.mood_after || 0, row.created_at);
    }
  }

  deduplicateChatHistory(userId, characterId) {
    this.db.prepare(
      `DELETE FROM chat_history WHERE user_id = ? AND character_id = ? AND rowid NOT IN (
        SELECT MIN(rowid) FROM chat_history
        WHERE user_id = ? AND character_id = ?
        GROUP BY role, content, created_at
      )`
    ).run(userId, characterId, userId, characterId);
  }

  // ==================== Lifecycle ====================

  close() {
    this.db.close();
  }

  /**
   * 删除某角色的全部运行时数据（单事务）+ 磁盘媒体文件
   * 涉及表：characters_state / chat_history / user_facts / diaries / daily_schedules /
   *        future_plans / photos / anniversaries / applied_event_emotions / inner_monologue
   * 媒体文件改为删行前查 photos 表拿精确文件清单，不再按文件名子串反推（避免误删 id 含目标 id 子串的其他角色文件）
   * @param {string} characterId
   * @returns {{ files: number }} 删除的媒体文件数
   */
  deleteCharacterData(characterId) {
    const tables = [
      'characters_state', 'chat_history', 'user_facts', 'diaries', 'daily_schedules',
      'future_plans', 'photos', 'anniversaries', 'applied_event_emotions', 'inner_monologue',
    ];
    // 删行前先取精确媒体文件清单（photos 表同时登记照片与视频），避免按文件名子串反推误删
    const mediaRows = this.db.prepare('SELECT filename FROM photos WHERE character_id = ?').all(characterId);
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
    for (const row of mediaRows) {
      const filename = path.basename(String(row.filename || '')); // basename 防路径拼接意外
      if (!filename) continue;
      for (const d of mediaDirs) {
        const p = path.join(d, filename);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true });
          files++;
        }
      }
    }
    return { files };
  }
}
